import type { Socket, TCPSocketListener } from "bun";
import { ClientProxy } from "../client-proxy";
import { TcpContext } from "../ctx-host";
import { TcpStatus } from "../enums";
import { RpcException, RpcTimeoutException } from "../exceptions";
import { FrameDecoder, encodeFrame } from "../framing";
import type {
  RpcEnvelope,
  RpcEventEnvelope,
  RpcRequestEnvelope,
  RpcResponseEnvelope,
  TcpTransportOptions,
} from "../interfaces";
import { MicroserviceTransportServer } from "../server";
import { Transport } from "../tokens";

interface SocketWriteState {
  readonly decoder: FrameDecoder;
  readonly writeQueue: Uint8Array[];
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
    } else if (written > 0) {
      state.writeQueue[0] = head.subarray(written);
      break;
    } else {
      break;
    }
  }
}

function enqueueSocketWrite(
  socket: Socket<SocketWriteState>,
  state: SocketWriteState,
  frame: Uint8Array,
): void {
  state.writeQueue.push(frame);
  flushWriteQueue(socket, state);
}

/**
 * Native Bun TCP microservice server (`Bun.listen()`) using 4-byte length-prefixed
 * JSON framing, concurrent multiplexed request correlation IDs, `port: 0` ephemeral
 * binding, and leak-free socket shutdown.
 */
export class TcpServer extends MicroserviceTransportServer {
  public readonly transport = Transport.TCP;

  private readonly host: string;
  private readonly requestedPort: number;
  private readonly maxFrameBytes?: number;

  private listener: TCPSocketListener<SocketWriteState> | undefined;
  private readonly clients = new Set<Socket<SocketWriteState>>();

  constructor(options: TcpTransportOptions = {}) {
    super();
    this.host = options.host ?? "127.0.0.1";
    this.requestedPort = options.port ?? 0;
    this.maxFrameBytes = options.maxFrameBytes;
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

  async listen(
    callback?: (...optionalParams: unknown[]) => any,
  ): Promise<void> {
    if (this.listening && this.listener) {
      callback?.();
      return;
    }

    const serverRef = this;
    this.listener = Bun.listen<SocketWriteState>({
      hostname: this.host,
      port: this.requestedPort,
      socket: {
        open(socket) {
          socket.data = {
            decoder: new FrameDecoder(serverRef.maxFrameBytes),
            writeQueue: [],
          };
          serverRef.clients.add(socket);
        },
        data(socket, chunk) {
          const state = socket.data;
          if (!state) return;
          let envelopes: RpcEnvelope[];
          try {
            envelopes = state.decoder.push<RpcEnvelope>(chunk);
          } catch (err) {
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

          for (const envelope of envelopes) {
            void serverRef.handleEnvelope(socket, state, envelope);
          }
        },
        drain(socket) {
          if (socket.data) {
            flushWriteQueue(socket, socket.data);
          }
        },
        close(socket) {
          serverRef.clients.delete(socket);
        },
        error(socket) {
          serverRef.clients.delete(socket);
        },
      },
    });

    this.listening = true;
    this.emitStatus(TcpStatus.CONNECTED);
    callback?.();
  }

  async close(): Promise<void> {
    this.listening = false;
    this.emitStatus(TcpStatus.DISCONNECTED);

    // Stop accepting first so connection attempts during shutdown are refused
    // (ECONNREFUSED) instead of being accepted and immediately reset.
    const listener = this.listener;
    this.listener = undefined;
    if (listener) {
      try {
        listener.stop(false);
      } catch {
        // Ignore if already stopped
      }
    }

    for (const socket of [...this.clients]) {
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
  }

  private async handleEnvelope(
    socket: Socket<SocketWriteState>,
    state: SocketWriteState,
    envelope: RpcEnvelope,
  ): Promise<void> {
    const pattern = envelope.type === "response" ? "" : envelope.pattern;
    const ctx = new TcpContext([socket, pattern], {
      remoteAddress: socket.remoteAddress,
    });

    if (envelope.type === "event") {
      await this.dispatchEvent(envelope.pattern, envelope.data, ctx);
      return;
    }

    if (envelope.type === "request") {
      const outcome = await this.dispatchMessage(
        envelope.pattern,
        envelope.data,
        ctx,
      );
      if (!this.clients.has(socket)) {
        return;
      }
      const responseEnvelope: RpcResponseEnvelope = {
        type: "response",
        id: envelope.id,
        response: outcome.response,
        error: outcome.error,
        isDisposed: true,
      };
      try {
        enqueueSocketWrite(socket, state, encodeFrame(responseEnvelope));
      } catch {
        this.clients.delete(socket);
      }
    }
  }
}

interface PendingTcpRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (err: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * Native Bun TCP microservice client (`Bun.connect()`) with length-prefixed framing,
 * multiplexed request correlation IDs, automatic reconnect, per-request timeouts,
 * and clean socket teardown.
 */
export class TcpClientProxy extends ClientProxy {
  public readonly transport = Transport.TCP;

  private readonly host: string;
  private readonly port: number;
  private readonly maxFrameBytes?: number;
  private readonly autoReconnect: boolean;

  private socket: Socket<SocketWriteState> | undefined;
  private connectPromise: Promise<Socket<SocketWriteState>> | undefined;
  private readonly pending = new Map<string, PendingTcpRequest>();
  private reqSeq = 0;
  private closed = false;

  constructor(options: TcpTransportOptions = {}) {
    super(options.defaultTimeoutMs ?? 5000);
    this.host = options.host ?? "127.0.0.1";
    this.port = options.port ?? 0;
    this.maxFrameBytes = options.maxFrameBytes;
    this.autoReconnect = options.autoReconnect ?? true;
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
    this.rejectAllPending(new Error("TCP client proxy closed."));

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
  ): Promise<TRes> {
    if (signal?.aborted) {
      throw new RpcTimeoutException(pattern, timeoutMs);
    }
    const socket = await this.ensureConnected();
    if (signal?.aborted) {
      throw new RpcTimeoutException(pattern, timeoutMs);
    }
    const id = `tcp_${++this.reqSeq}_${crypto.randomUUID().slice(0, 8)}`;

    const requestEnvelope: RpcRequestEnvelope = {
      type: "request",
      id,
      pattern,
      data,
    };

    return await new Promise<TRes>((resolve, reject) => {
      const onAbort = () => {
        if (this.pending.delete(id)) {
          clearTimeout(timer);
          reject(new RpcTimeoutException(pattern, timeoutMs));
        }
      };

      const cleanup = () => {
        signal?.removeEventListener("abort", onAbort);
      };

      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          cleanup();
          reject(new RpcTimeoutException(pattern, timeoutMs));
        }
      }, timeoutMs);
      if (typeof (timer as { unref?: () => void }).unref === "function") {
        (timer as { unref: () => void }).unref();
      }

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
        enqueueSocketWrite(socket, socket.data, encodeFrame(requestEnvelope));
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
  ): Promise<void> {
    const socket = await this.ensureConnected();
    const envelope: RpcEventEnvelope = {
      type: "event",
      pattern,
      data,
    };
    enqueueSocketWrite(socket, socket.data, encodeFrame(envelope));
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
        const state: SocketWriteState = {
          decoder: new FrameDecoder(clientRef.maxFrameBytes),
          writeQueue: [],
        };

        Bun.connect<SocketWriteState>({
          hostname: clientRef.host,
          port: clientRef.port,
          data: state,
          socket: {
            open(socket) {
              opened = true;
              socket.data = state;
              clientRef.socket = socket;
              clientRef.connectPromise = undefined;
              clientRef.emitStatus("connected");
              clientRef.emitClientEvent("connect");
              resolve(socket);
            },
            data(socket, chunk) {
              if (socket !== clientRef.socket || !socket.data) return;
              let frames: RpcEnvelope[];
              try {
                frames = socket.data.decoder.push<RpcEnvelope>(chunk);
              } catch (err) {
                clientRef.handleDisconnect(err);
                return;
              }
              for (const frame of frames) {
                if (frame.type === "response") {
                  clientRef.handleResponse(frame);
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

  private handleResponse(envelope: RpcResponseEnvelope): void {
    const entry = this.pending.get(envelope.id);
    if (!entry) {
      return;
    }
    clearTimeout(entry.timer);
    this.pending.delete(envelope.id);

    if (envelope.error) {
      if (envelope.error.isRpcException) {
        entry.reject(RpcException.fromSerialized(envelope.error));
      } else {
        const err = new Error(envelope.error.message || "Remote RPC error");
        if (envelope.error.name) {
          err.name = envelope.error.name;
        }
        entry.reject(err);
      }
      return;
    }

    entry.resolve(envelope.response);
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
      entry.reject(err);
    }
  }
}

export { TcpServer as ServerTCP, TcpClientProxy as ClientTCP };
