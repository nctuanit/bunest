import type { Socket, TCPSocketListener } from "bun";
import { ClientProxy } from "../client-proxy";
import { TcpContext } from "../ctx-host";
import { TcpStatus } from "../enums";
import { RpcException, RpcTimeoutException } from "../exceptions";
import { FrameDecoder, encodeFrame } from "../framing";
import type {
  RpcResponseEnvelope,
  TcpTransportOptions,
  WireFormat,
} from "../interfaces";
import {
  toPacketMetadata,
  type Deserializer,
  type Serializer,
} from "../packets";
import {
  decodeInboundMessage,
  decodeInboundResponse,
  encodeOutboundEvent,
  encodeOutboundRequest,
  encodeOutboundResponse,
  isBunestEnvelope,
  type DecodedInboundResponse,
} from "../serializers/wire-codec";
import { MicroserviceTransportServer } from "../server";
import { Transport } from "../tokens";

const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_PACKET_ID_LENGTH = 256;

interface SocketWriteState {
  readonly decoder: FrameDecoder;
  readonly writeQueue: Uint8Array[];
  queuedBytes: number;
  inFlight: number;
  readonly pendingEnvelopes: unknown[];
  readonly activeStreams: Set<AsyncIterator<unknown>>;
  incompleteTimer?: ReturnType<typeof setTimeout>;
  receiveTimer?: ReturnType<typeof setTimeout>;
  hadPendingBytes: boolean;
  peerEnded: boolean;
  closed: boolean;
  endAfterWriteDrain: boolean;
  onDrained?: () => void;
}

function createSocketState(maxFrameBytes?: number): SocketWriteState {
  return {
    decoder: new FrameDecoder(maxFrameBytes),
    writeQueue: [],
    queuedBytes: 0,
    inFlight: 0,
    pendingEnvelopes: [],
    activeStreams: new Set(),
    hadPendingBytes: false,
    peerEnded: false,
    closed: false,
    endAfterWriteDrain: false,
  };
}

function clearSocketTimers(state: SocketWriteState): void {
  if (state.incompleteTimer !== undefined) {
    clearTimeout(state.incompleteTimer);
    state.incompleteTimer = undefined;
  }
  if (state.receiveTimer !== undefined) {
    clearTimeout(state.receiveTimer);
    state.receiveTimer = undefined;
  }
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as { unref: () => void }).unref();
  }
}

function flushWriteQueue(
  socket: Socket<SocketWriteState>,
  state: SocketWriteState,
): void {
  while (state.writeQueue.length > 0) {
    const head = state.writeQueue[0]!;
    const written = socket.write(head);
    if (written === head.byteLength) {
      state.writeQueue.shift();
      state.queuedBytes = Math.max(0, state.queuedBytes - written);
    } else if (written > 0) {
      state.writeQueue[0] = head.subarray(written);
      state.queuedBytes = Math.max(0, state.queuedBytes - written);
      break;
    } else {
      break;
    }
  }

  if (state.writeQueue.length === 0 && state.endAfterWriteDrain) {
    state.endAfterWriteDrain = false;
    try {
      socket.end();
    } catch {
      // Ignore already-closed socket
    }
    state.onDrained?.();
  }
}

function enqueueSocketWrite(
  socket: Socket<SocketWriteState>,
  state: SocketWriteState,
  frame: Uint8Array,
  maxSendBufferSize?: number,
): boolean {
  state.writeQueue.push(frame);
  state.queuedBytes += frame.byteLength;
  flushWriteQueue(socket, state);

  if (
    maxSendBufferSize !== undefined &&
    maxSendBufferSize > 0 &&
    state.queuedBytes > maxSendBufferSize
  ) {
    state.closed = true;
    clearSocketTimers(state);
    try {
      socket.terminate();
    } catch {
      try {
        socket.end();
      } catch {
        // ignore
      }
    }
    return false;
  }
  return true;
}

function isValidPacketId(id: unknown): id is string | number {
  if (typeof id === "number") {
    return Number.isFinite(id);
  }
  if (typeof id === "string") {
    return id.length <= MAX_PACKET_ID_LENGTH;
  }
  return false;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function"
  );
}

interface StreamPushQueue<T> extends AsyncIterable<T> {
  push(value: T): void;
  end(): void;
  fail(err: unknown): void;
}

function createStreamPushQueue<T>(): StreamPushQueue<T> {
  const values: T[] = [];
  const waiters: Array<{
    resolve: (res: IteratorResult<T>) => void;
    reject: (err: unknown) => void;
  }> = [];
  let ended = false;
  let failure: { err: unknown } | undefined;

  return {
    push(value: T) {
      if (ended || failure) return;
      const waiter = waiters.shift();
      if (waiter) {
        waiter.resolve({ value, done: false });
      } else {
        values.push(value);
      }
    },
    end() {
      if (ended || failure) return;
      ended = true;
      while (waiters.length > 0) {
        waiters.shift()!.resolve({ value: undefined as unknown as T, done: true });
      }
    },
    fail(err: unknown) {
      if (ended || failure) return;
      failure = { err };
      while (waiters.length > 0) {
        waiters.shift()!.reject(err);
      }
    },
    [Symbol.asyncIterator](): AsyncIterator<T> {
      return {
        next(): Promise<IteratorResult<T>> {
          if (values.length > 0) {
            return Promise.resolve({ value: values.shift()!, done: false });
          }
          if (failure) {
            const err = failure.err;
            return Promise.reject(err);
          }
          if (ended) {
            return Promise.resolve({
              value: undefined as unknown as T,
              done: true,
            });
          }
          return new Promise<IteratorResult<T>>((resolve, reject) => {
            waiters.push({ resolve, reject });
          });
        },
        return(): Promise<IteratorResult<T>> {
          ended = true;
          values.length = 0;
          return Promise.resolve({
            value: undefined as unknown as T,
            done: true,
          });
        },
      };
    },
  };
}

/**
 * Native Bun TCP microservice server (`Bun.listen()`) using 4-byte length-prefixed
 * JSON framing, concurrent multiplexed request correlation IDs, `port: 0` ephemeral
 * binding, bounded-memory protections, graceful draining, and leak-free socket shutdown.
 */
export class TcpServer extends MicroserviceTransportServer {
  public readonly transport = Transport.TCP;

  private readonly host: string;
  private readonly requestedPort: number;
  private readonly maxFrameBytes?: number;
  private readonly incompleteMessageTimeout?: number;
  private readonly messageReceiveTimeout?: number;
  private readonly maxSendBufferSize?: number;
  private readonly maxConcurrentMessages?: number;
  private readonly gracefulShutdown: boolean;
  private readonly gracePeriod: number;
  private readonly tlsOptions?: Record<string, unknown>;
  private readonly wireFormat: WireFormat;
  private readonly serializer?: Serializer;
  private readonly deserializer?: Deserializer;

  private listener: TCPSocketListener<SocketWriteState> | undefined;
  private readonly clients = new Set<Socket<SocketWriteState>>();
  private closing = false;
  private drainWaiters: Array<() => void> = [];

  constructor(options: TcpTransportOptions = {}) {
    super();
    this.configureServerOptions(options);
    this.host = options.host ?? "127.0.0.1";
    this.requestedPort = options.port ?? 0;
    this.maxFrameBytes = options.maxFrameBytes ?? options.maxBufferSize;
    this.incompleteMessageTimeout = options.incompleteMessageTimeout;
    this.messageReceiveTimeout = options.messageReceiveTimeout;
    this.maxSendBufferSize = options.maxSendBufferSize;
    this.maxConcurrentMessages = options.maxConcurrentMessages;
    this.gracefulShutdown = options.gracefulShutdown ?? false;
    this.gracePeriod = options.gracePeriod ?? 5000;
    this.tlsOptions = options.tlsOptions;
    this.wireFormat = options.wireFormat ?? "bunest";
    this.serializer = options.serializer;
    this.deserializer = options.deserializer;
  }

  get address(): { readonly hostname: string; readonly port: number } | null {
    if (!this.listener) {
      return null;
    }
    return {
      hostname: this.listener.hostname,
      port: this.listener.port,
    };
  }

  get port(): number | undefined {
    return this.listener?.port;
  }

  override get server(): TCPSocketListener<SocketWriteState> | undefined {
    return this.listener;
  }

  async listen(
    callback?: (...optionalParams: unknown[]) => any,
  ): Promise<void> {
    if (this.listening && this.listener) {
      callback?.();
      return;
    }

    this.closing = false;
    const serverRef = this;

    const listenConfig: Record<string, unknown> = {
      hostname: this.host,
      port: this.requestedPort,
      socket: {
        open(socket: Socket<SocketWriteState>) {
          socket.data = createSocketState(serverRef.maxFrameBytes);
          serverRef.clients.add(socket);
        },
        data(socket: Socket<SocketWriteState>, chunk: Buffer) {
          const state = socket.data;
          if (!state || state.closed) return;
          if (serverRef.closing) {
            return;
          }

          let envelopes: unknown[];
          try {
            envelopes = state.decoder.push<unknown>(chunk);
          } catch (err) {
            clearSocketTimers(state);
            const errorFrame = encodeFrame({
              type: "response",
              id: "",
              error: serverRef.serializeError(err),
              isDisposed: true,
            } satisfies RpcResponseEnvelope);
            enqueueSocketWrite(socket, state, errorFrame);
            socket.end();
            return;
          }

          serverRef.updateReceiveTimers(socket, state, envelopes.length > 0);

          if (envelopes.length > 0) {
            for (const envelope of envelopes) {
              state.pendingEnvelopes.push(envelope);
            }
            serverRef.drainPendingEnvelopes(socket, state);
          }
        },
        drain(socket: Socket<SocketWriteState>) {
          if (socket.data) {
            flushWriteQueue(socket, socket.data);
          }
        },
        end(socket: Socket<SocketWriteState>) {
          const state = socket.data;
          if (state) {
            state.peerEnded = true;
            clearSocketTimers(state);
            if (state.activeStreams.size > 0) {
              serverRef.cancelSocketStreams(state);
            }
            if (state.inFlight === 0 && state.pendingEnvelopes.length === 0) {
              state.closed = true;
              serverRef.clients.delete(socket);
              serverRef.notifyDrainCheck();
            }
          }
        },
        close(socket: Socket<SocketWriteState>) {
          const state = socket.data;
          if (state) {
            clearSocketTimers(state);
            serverRef.cancelSocketStreams(state);
            if (!state.peerEnded || state.pendingEnvelopes.length === 0) {
              state.closed = true;
              state.pendingEnvelopes.length = 0;
            }
          }
          serverRef.clients.delete(socket);
          serverRef.notifyDrainCheck();
        },
        error(socket: Socket<SocketWriteState>) {
          const state = socket.data;
          if (state) {
            clearSocketTimers(state);
            state.closed = true;
            state.pendingEnvelopes.length = 0;
            serverRef.cancelSocketStreams(state);
          }
          serverRef.clients.delete(socket);
          serverRef.notifyDrainCheck();
        },
      },
    };

    if (
      this.tlsOptions &&
      ("cert" in this.tlsOptions || "key" in this.tlsOptions)
    ) {
      listenConfig.tls = this.tlsOptions;
    }

    this.listener = Bun.listen<SocketWriteState>(
      listenConfig as unknown as Parameters<typeof Bun.listen<SocketWriteState>>[0],
    ) as unknown as TCPSocketListener<SocketWriteState>;

    this.listening = true;
    this.emitStatus(TcpStatus.CONNECTED);
    callback?.();
  }

  async close(): Promise<void> {
    this.listening = false;
    this.closing = true;
    this.emitStatus(TcpStatus.DISCONNECTED);

    // Stop accepting new connections immediately so late arrivals get ECONNREFUSED
    const listener = this.listener;
    this.listener = undefined;
    if (listener) {
      try {
        listener.stop(false);
      } catch {
        // Ignore if already stopped
      }
    }

    if (!this.gracefulShutdown) {
      for (const socket of [...this.clients]) {
        const state = socket.data;
        if (state) {
          clearSocketTimers(state);
          state.closed = true;
          state.pendingEnvelopes.length = 0;
          this.cancelSocketStreams(state);
        }
        try {
          socket.end();
        } catch {
          // Ignore already-closed sockets
        }
      }
      this.clients.clear();

      if (listener) {
        try {
          listener.stop(true);
        } catch {
          // Ignore if already stopped
        }
      }
      return;
    }

    // Graceful shutdown: drop queued (unstarted) work, close idle sockets immediately,
    // and let in-flight handlers finish & flush their replies up to gracePeriod.
    for (const socket of [...this.clients]) {
      const state = socket.data;
      if (!state) {
        try {
          socket.end();
        } catch {
          // ignore
        }
        this.clients.delete(socket);
        continue;
      }
      clearSocketTimers(state);
      state.pendingEnvelopes.length = 0;
      this.tryCloseDrainedSocket(socket, state);
    }

    if (this.hasActiveWork()) {
      await new Promise<void>((resolve) => {
        let settled = false;
        let graceTimer: ReturnType<typeof setTimeout> | undefined;

        const finish = () => {
          if (settled) return;
          settled = true;
          if (graceTimer !== undefined) {
            clearTimeout(graceTimer);
            graceTimer = undefined;
          }
          resolve();
        };

        this.drainWaiters.push(() => {
          if (!this.hasActiveWork()) {
            finish();
          }
        });

        if (
          Number.isFinite(this.gracePeriod) &&
          this.gracePeriod >= 0 &&
          this.gracePeriod <= MAX_TIMEOUT_MS
        ) {
          graceTimer = setTimeout(finish, this.gracePeriod);
          unrefTimer(graceTimer);
        }
      });
    }

    // Force-close any sockets still open after gracePeriod
    for (const socket of [...this.clients]) {
      const state = socket.data;
      if (state) {
        clearSocketTimers(state);
        state.closed = true;
        this.cancelSocketStreams(state);
      }
      try {
        socket.terminate();
      } catch {
        try {
          socket.end();
        } catch {
          // ignore
        }
      }
    }
    this.clients.clear();
    this.drainWaiters = [];

    if (listener) {
      try {
        listener.stop(true);
      } catch {
        // Ignore if already stopped
      }
    }
  }

  private hasActiveWork(): boolean {
    for (const socket of this.clients) {
      const state = socket.data;
      if (state && (state.inFlight > 0 || state.writeQueue.length > 0)) {
        return true;
      }
    }
    return false;
  }

  private notifyDrainCheck(): void {
    if (this.drainWaiters.length === 0) return;
    if (!this.hasActiveWork()) {
      const waiters = this.drainWaiters.splice(0);
      for (const fn of waiters) {
        fn();
      }
    }
  }

  private tryCloseDrainedSocket(
    socket: Socket<SocketWriteState>,
    state: SocketWriteState,
  ): void {
    if (!this.closing || state.inFlight > 0) {
      return;
    }
    if (state.writeQueue.length === 0) {
      state.closed = true;
      try {
        socket.end();
      } catch {
        // ignore
      }
      this.clients.delete(socket);
      this.notifyDrainCheck();
    } else {
      state.endAfterWriteDrain = true;
      state.onDrained = () => {
        state.closed = true;
        this.clients.delete(socket);
        this.notifyDrainCheck();
      };
      flushWriteQueue(socket, state);
    }
  }

  private cancelSocketStreams(state: SocketWriteState): void {
    for (const iter of [...state.activeStreams]) {
      state.activeStreams.delete(iter);
      try {
        void Promise.resolve(iter.return?.()).catch(() => {});
      } catch {
        // ignore
      }
    }
  }

  private updateReceiveTimers(
    socket: Socket<SocketWriteState>,
    state: SocketWriteState,
    completedAnyFrame: boolean,
  ): void {
    const hasPending = state.decoder.hasPendingBytes;

    // Reset incompleteMessageTimeout on every data chunk if still mid-frame
    if (state.incompleteTimer !== undefined) {
      clearTimeout(state.incompleteTimer);
      state.incompleteTimer = undefined;
    }
    if (
      hasPending &&
      this.incompleteMessageTimeout !== undefined &&
      this.incompleteMessageTimeout > 0
    ) {
      state.incompleteTimer = setTimeout(() => {
        state.closed = true;
        clearSocketTimers(state);
        try {
          socket.terminate();
        } catch {
          try {
            socket.end();
          } catch {
            // ignore
          }
        }
        this.clients.delete(socket);
      }, this.incompleteMessageTimeout);
      unrefTimer(state.incompleteTimer);
    }

    // messageReceiveTimeout bounds total wall-clock time to complete a single frame
    if (completedAnyFrame || !hasPending) {
      if (state.receiveTimer !== undefined) {
        clearTimeout(state.receiveTimer);
        state.receiveTimer = undefined;
      }
      state.hadPendingBytes = false;
    }

    if (
      hasPending &&
      !state.hadPendingBytes &&
      this.messageReceiveTimeout !== undefined &&
      this.messageReceiveTimeout > 0
    ) {
      state.hadPendingBytes = true;
      state.receiveTimer = setTimeout(() => {
        state.closed = true;
        clearSocketTimers(state);
        try {
          socket.terminate();
        } catch {
          try {
            socket.end();
          } catch {
            // ignore
          }
        }
        this.clients.delete(socket);
      }, this.messageReceiveTimeout);
      unrefTimer(state.receiveTimer);
    }
  }

  private drainPendingEnvelopes(
    socket: Socket<SocketWriteState>,
    state: SocketWriteState,
  ): void {
    const maxConc = this.maxConcurrentMessages;
    while (
      !state.closed &&
      !this.closing &&
      state.pendingEnvelopes.length > 0 &&
      (maxConc === undefined || maxConc <= 0 || state.inFlight < maxConc)
    ) {
      const envelope = state.pendingEnvelopes.shift()!;
      state.inFlight++;
      void this.handleEnvelope(socket, state, envelope).finally(() => {
        state.inFlight = Math.max(0, state.inFlight - 1);
        if (this.closing) {
          this.tryCloseDrainedSocket(socket, state);
          this.notifyDrainCheck();
        } else {
          this.drainPendingEnvelopes(socket, state);
        }
      });
    }
  }

  private async handleEnvelope(
    socket: Socket<SocketWriteState>,
    state: SocketWriteState,
    rawEnvelope: unknown,
  ): Promise<void> {
    if (
      this.wireFormat === "bunest" &&
      !this.deserializer &&
      isBunestEnvelope(rawEnvelope) &&
      rawEnvelope.type === "request" &&
      !isValidPacketId(rawEnvelope.id)
    ) {
      return;
    }

    const decoded = await decodeInboundMessage({
      raw: rawEnvelope,
      wireFormat: this.wireFormat,
      deserializer: this.deserializer,
      channel: "",
      isTcp: true,
      hasMessageHandler: (p) => this.messageHandlers.has(p),
      hasEventHandler: (p) => (this.eventHandlers.get(p)?.length ?? 0) > 0,
      registeredPatterns: [
        ...new Set([
          ...this.messageHandlers.keys(),
          ...this.eventHandlers.keys(),
        ]),
      ],
    });
    if (!decoded || decoded.kind === "response") {
      return;
    }

    const packetMeta = decoded.metadata
      ? toPacketMetadata(Object.entries(decoded.metadata))
      : undefined;
    const ctx =
      decoded.metadata !== undefined
        ? new TcpContext(
            packetMeta !== undefined
              ? [socket, decoded.pattern, packetMeta]
              : [socket, decoded.pattern],
            decoded.metadata,
          )
        : new TcpContext([socket, decoded.pattern], {
            remoteAddress: socket.remoteAddress,
          });

    if (decoded.kind === "event") {
      await this.dispatchEvent(decoded.pattern, decoded.data, ctx);
      return;
    }

    if (decoded.id && !isValidPacketId(decoded.id)) {
      return;
    }

    const outcome = await this.dispatchMessage(
      decoded.pattern,
      decoded.data,
      ctx,
    );
    if (state.closed || !this.clients.has(socket)) {
      if (isAsyncIterable(outcome.response)) {
        try {
          const iter = outcome.response[Symbol.asyncIterator]();
          void Promise.resolve(iter.return?.()).catch(() => {});
        } catch {
          // ignore
        }
      }
      return;
    }

    if (!outcome.error && isAsyncIterable(outcome.response)) {
      await this.streamResponse(socket, state, decoded.id, outcome.response);
      return;
    }

    if (!decoded.id && decoded.responseWireStyle !== "bunest") {
      return;
    }

    const encodedResp = await encodeOutboundResponse({
      id: decoded.id,
      pattern: decoded.pattern,
      response: outcome.response,
      error: outcome.error,
      isDisposed: true,
      wireFormat: this.wireFormat,
      responseWireStyle: decoded.responseWireStyle,
      serializer: this.serializer,
    });
    try {
      const ok = enqueueSocketWrite(
        socket,
        state,
        encodeFrame(encodedResp),
        this.maxSendBufferSize,
      );
      if (!ok) {
        this.clients.delete(socket);
      }
    } catch {
      this.clients.delete(socket);
    }
  }

  private async streamResponse(
    socket: Socket<SocketWriteState>,
    state: SocketWriteState,
    id: string | number,
    iterable: AsyncIterable<unknown>,
  ): Promise<void> {
    const iterator = iterable[Symbol.asyncIterator]();
    state.activeStreams.add(iterator);
    try {
      while (!state.closed && this.clients.has(socket)) {
        const step = await iterator.next();
        if (state.closed || !this.clients.has(socket)) {
          break;
        }
        if (step.done) {
          const endEnvelope: RpcResponseEnvelope = {
            type: "response",
            id: String(id),
            isDisposed: true,
          };
          const ok = enqueueSocketWrite(
            socket,
            state,
            encodeFrame(endEnvelope),
            this.maxSendBufferSize,
          );
          if (!ok) {
            this.clients.delete(socket);
          }
          return;
        }

        const chunkEnvelope: RpcResponseEnvelope = {
          type: "response",
          id: String(id),
          response: step.value,
          isDisposed: false,
        };
        const ok = enqueueSocketWrite(
          socket,
          state,
          encodeFrame(chunkEnvelope),
          this.maxSendBufferSize,
        );
        if (!ok) {
          this.clients.delete(socket);
          return;
        }
      }
    } catch (err) {
      if (!state.closed && this.clients.has(socket)) {
        const errEnvelope: RpcResponseEnvelope = {
          type: "response",
          id: String(id),
          error: this.serializeError(err),
          isDisposed: true,
        };
        try {
          enqueueSocketWrite(
            socket,
            state,
            encodeFrame(errEnvelope),
            this.maxSendBufferSize,
          );
        } catch {
          this.clients.delete(socket);
        }
      }
    } finally {
      state.activeStreams.delete(iterator);
      if (state.closed) {
        try {
          await iterator.return?.();
        } catch {
          // ignore
        }
      }
    }
  }
}

interface PendingTcpRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (err: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  stream?: StreamPushQueue<unknown>;
}

/**
 * Native Bun TCP microservice client (`Bun.connect()`) with length-prefixed framing,
 * multiplexed request correlation IDs, streaming AsyncIterable responses, automatic
 * reconnect, per-request timeouts, and clean socket teardown.
 */
export class TcpClientProxy extends ClientProxy {
  public readonly transport = Transport.TCP;

  private readonly host: string;
  private readonly port: number;
  private readonly maxFrameBytes?: number;
  private readonly autoReconnect: boolean;
  private readonly wireFormat: WireFormat;
  private readonly serializer?: Serializer;
  private readonly deserializer?: Deserializer;

  private socket: Socket<SocketWriteState> | undefined;
  private connectPromise: Promise<Socket<SocketWriteState>> | undefined;
  private readonly pending = new Map<string, PendingTcpRequest>();
  private reqSeq = 0;
  private closed = false;

  constructor(options: TcpTransportOptions = {}) {
    super(options.requestTimeout ?? options.defaultTimeoutMs ?? 5000, {
      requestTimeout: options.requestTimeout,
      maxPendingRequests: options.maxPendingRequests,
      retry: options.retry,
      circuitBreaker: options.circuitBreaker,
      clsPropagation: options.clsPropagation,
      cls: options.cls,
    });
    this.host = options.host ?? "127.0.0.1";
    this.port = options.port ?? 0;
    this.maxFrameBytes = options.maxFrameBytes;
    this.autoReconnect = options.autoReconnect ?? true;
    this.wireFormat = options.wireFormat ?? "bunest";
    this.serializer = options.serializer;
    this.deserializer = options.deserializer;
  }

  async connect(): Promise<void> {
    if (this.closed) {
      this.closed = false;
    }
    await this.ensureConnected();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.emitStatus("disconnected");
    this.emitClientEvent("close");
    const closeErr = new Error("TCP client proxy closed.");
    this.rejectAllPending(closeErr);
    this.cancelActiveRequests(closeErr);

    const sock = this.socket;
    this.socket = undefined;
    this.connectPromise = undefined;

    if (sock) {
      try {
        sock.end();
      } catch {
        // Ignore already-closed socket
      }
    }
  }

  protected override async sendOnce<TRes = any, TReq = any>(
    pattern: string,
    data: TReq,
    timeoutMs: number,
    signal?: AbortSignal,
    metadata?: Record<string, unknown>,
  ): Promise<TRes> {
    if (signal?.aborted) {
      throw new RpcTimeoutException(pattern, timeoutMs);
    }
    const socket = await this.ensureConnected();
    if (signal?.aborted) {
      throw new RpcTimeoutException(pattern, timeoutMs);
    }
    const id = `tcp_${++this.reqSeq}_${crypto.randomUUID().slice(0, 8)}`;

    const encodedReq = await encodeOutboundRequest({
      id,
      pattern,
      data,
      metadata,
      wireFormat: this.wireFormat,
      serializer: this.serializer,
      isTcp: true,
    });

    return await new Promise<TRes>((resolve, reject) => {
      const onAbort = () => {
        const entry = this.pending.get(id);
        if (entry && !entry.stream) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(new RpcTimeoutException(pattern, timeoutMs));
        }
      };

      const cleanup = () => {
        signal?.removeEventListener("abort", onAbort);
      };

      const timer = setTimeout(() => {
        const entry = this.pending.get(id);
        if (entry && !entry.stream) {
          this.pending.delete(id);
          cleanup();
          reject(new RpcTimeoutException(pattern, timeoutMs));
        }
      }, timeoutMs);
      unrefTimer(timer);

      this.pending.set(id, {
        resolve: (value: unknown) => {
          cleanup();
          resolve(value as TRes);
        },
        reject: (err: unknown) => {
          cleanup();
          reject(err);
        },
        timer,
      });

      signal?.addEventListener("abort", onAbort, { once: true });

      try {
        enqueueSocketWrite(socket, socket.data, encodeFrame(encodedReq));
      } catch (err) {
        clearTimeout(timer);
        cleanup();
        this.pending.delete(id);
        this.handleDisconnect(err);
        reject(err);
      }
    });
  }

  protected override async dispatchEvent<TReq = any>(
    pattern: string,
    data: TReq,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const socket = await this.ensureConnected();
    const encoded = await encodeOutboundEvent({
      pattern,
      data,
      metadata,
      wireFormat: this.wireFormat,
      serializer: this.serializer,
      isTcp: true,
    });
    enqueueSocketWrite(socket, socket.data, encodeFrame(encoded));
  }

  private async ensureConnected(): Promise<Socket<SocketWriteState>> {
    if (this.closed) {
      throw new Error("TCP client proxy is closed.");
    }
    if (this.socket) {
      return this.socket;
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }

    const clientRef = this;
    this.connectPromise = new Promise<Socket<SocketWriteState>>(
      (resolve, reject) => {
        let opened = false;
        const state = createSocketState(clientRef.maxFrameBytes);

        Bun.connect<SocketWriteState>({
          hostname: clientRef.host,
          port: clientRef.port,
          data: state,
          socket: {
            open(socket) {
              opened = true;
              socket.data = state;
              clientRef.connectPromise = undefined;
              if (clientRef.closed) {
                try {
                  socket.terminate();
                } catch {
                  try {
                    socket.end();
                  } catch {
                    // ignore
                  }
                }
                reject(new Error("TCP client proxy is closed."));
                return;
              }
              clientRef.socket = socket;
              clientRef.emitStatus("connected");
              clientRef.emitClientEvent("connect");
              resolve(socket);
            },
            data(socket, chunk) {
              if (socket !== clientRef.socket || !socket.data) return;
              let frames: unknown[];
              try {
                frames = socket.data.decoder.push<unknown>(chunk);
              } catch (err) {
                clientRef.handleDisconnect(err);
                return;
              }
              for (const frame of frames) {
                if (
                  clientRef.wireFormat === "bunest" &&
                  !clientRef.deserializer
                ) {
                  if (isBunestEnvelope(frame) && frame.type === "response") {
                    clientRef.handleResponse(frame);
                  }
                } else {
                  void decodeInboundResponse({
                    raw: frame,
                    wireFormat: clientRef.wireFormat,
                    deserializer: clientRef.deserializer,
                  }).then((decoded) => {
                    if (decoded) {
                      clientRef.handleResponse(decoded);
                    }
                  });
                }
              }
            },
            drain(socket) {
              if (socket === clientRef.socket && socket.data) {
                flushWriteQueue(socket, socket.data);
              }
            },
            close(socket) {
              if (socket !== clientRef.socket) {
                return;
              }
              clientRef.handleDisconnect(
                new Error("TCP connection closed by remote peer."),
              );
            },
            error(socket, err) {
              if (!opened) {
                clientRef.connectPromise = undefined;
                reject(err);
              } else if (socket === clientRef.socket) {
                clientRef.handleDisconnect(err);
              }
            },
            connectError(_socket, err) {
              clientRef.connectPromise = undefined;
              reject(err);
            },
          },
        }).catch((err) => {
          clientRef.connectPromise = undefined;
          reject(err);
        });
      },
    );

    return this.connectPromise;
  }

  private handleResponse(envelope: DecodedInboundResponse): void {
    const id = envelope.id;
    if (!id) {
      return;
    }
    const entry = this.pending.get(id);
    if (!entry) {
      return;
    }

    if (envelope.isDisposed === false) {
      if (!entry.stream) {
        clearTimeout(entry.timer);
        entry.stream = createStreamPushQueue<unknown>();
        entry.resolve(entry.stream);
      }
      entry.stream.push(envelope.response);
      return;
    }

    clearTimeout(entry.timer);
    this.pending.delete(id);

    if (entry.stream) {
      if (envelope.error) {
        entry.stream.fail(this.deserializeEnvelopeError(envelope.error));
      } else {
        if (envelope.response !== undefined) {
          entry.stream.push(envelope.response);
        }
        entry.stream.end();
      }
      return;
    }

    if (envelope.error) {
      entry.reject(this.deserializeEnvelopeError(envelope.error));
      return;
    }

    entry.resolve(envelope.response);
  }

  private deserializeEnvelopeError(
    error: NonNullable<RpcResponseEnvelope["error"]>,
  ): Error {
    if (error.isRpcException) {
      return RpcException.fromSerialized(error);
    }
    const err = new Error(error.message || "Remote RPC error");
    if (error.name) {
      err.name = error.name;
    }
    return err;
  }

  private handleDisconnect(err: unknown): void {
    this.socket = undefined;
    this.connectPromise = undefined;
    this.emitStatus("disconnected");
    const reason =
      err instanceof Error
        ? err
        : new Error(String(err ?? "TCP connection lost"));
    this.emitClientEvent("error", reason);
    this.emitClientEvent("close");
    this.rejectAllPending(reason);
    if (!this.autoReconnect) {
      this.closed = true;
    }
  }

  private rejectAllPending(err: Error): void {
    for (const [id, entry] of this.pending.entries()) {
      clearTimeout(entry.timer);
      this.pending.delete(id);
      if (entry.stream) {
        entry.stream.fail(err);
      } else {
        entry.reject(err);
      }
    }
  }
}

export { TcpServer as ServerTCP, TcpClientProxy as ClientTCP };
