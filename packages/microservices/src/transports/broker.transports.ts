import { ClientProxy } from "../client-proxy";
import { NatsContext, RedisContext, RmqContext } from "../ctx-host";
import { NatsStatus, RedisStatus, RmqStatus } from "../enums";
import { RpcException, RpcTimeoutException } from "../exceptions";
import type {
  NatsMessageLike,
  NatsSubscriptionLike,
  NatsTransportClientLike,
  NatsTransportOptions,
  RabbitMqChannelLike,
  RabbitMqMessageLike,
  RabbitMqTransportOptions,
  RedisTransportClientLike,
  RedisTransportOptions,
  RpcEnvelope,
  RpcEventEnvelope,
  RpcRequestEnvelope,
  RpcResponseEnvelope,
  WireFormat,
} from "../interfaces";
import {
  toPacketMetadata,
  type Deserializer,
  type Serializer,
} from "../packets";
import { NatsRecord, RedisRecord, RmqRecord } from "../records";
import {
  decodeInboundMessage,
  decodeInboundResponse,
  encodeOutboundEvent,
  encodeOutboundRequest,
  encodeOutboundResponse,
  stringifyWirePayload,
} from "../serializers/wire-codec";
import { MicroserviceTransportServer } from "../server";
import { Transport } from "../tokens";

function formatRedisChannel(prefix: string, name: string): string {
  return prefix.length > 0 ? `${prefix}:${name}` : name;
}

function extractHeadersRecord(
  headers: unknown,
): Record<string, unknown> | undefined {
  if (!headers || typeof headers !== "object") {
    return undefined;
  }
  const iterHeaders = headers as {
    keys?: () => Iterable<string>;
    values?: (key: string) => Iterable<unknown>;
  };
  if (
    typeof iterHeaders.keys === "function" &&
    typeof iterHeaders.values === "function"
  ) {
    const out: Record<string, unknown> = {};
    for (const key of iterHeaders.keys()) {
      const vals = Array.from(iterHeaders.values(key));
      out[key] = vals.length === 1 ? vals[0] : vals;
    }
    return out;
  }
  return headers as Record<string, unknown>;
}

const MAX_TIMEOUT_MS = 2_147_483_647;

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as { unref: () => void }).unref();
  }
}

async function waitForInFlightDrain(
  getInFlight: () => number,
  waiters: Array<() => void>,
  gracePeriod: number,
): Promise<void> {
  if (getInFlight() <= 0) {
    return;
  }
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

    waiters.push(() => {
      if (getInFlight() <= 0) {
        finish();
      }
    });

    if (
      Number.isFinite(gracePeriod) &&
      gracePeriod >= 0 &&
      gracePeriod <= MAX_TIMEOUT_MS
    ) {
      graceTimer = setTimeout(finish, gracePeriod);
      unrefTimer(graceTimer);
    }
  });
}

function notifyDrainWaiters(
  getInFlight: () => number,
  waiters: Array<() => void>,
): void {
  if (waiters.length === 0 || getInFlight() > 0) return;
  const pending = waiters.splice(0);
  for (const fn of pending) {
    fn();
  }
}

function prepareBuffersForJson(value: unknown): unknown {
  if (value instanceof Uint8Array && !Buffer.isBuffer(value)) {
    return Buffer.from(value);
  }
  if (Array.isArray(value)) {
    return value.map(prepareBuffersForJson);
  }
  if (value !== null && typeof value === "object" && !Buffer.isBuffer(value)) {
    const obj = value as Record<string, unknown>;
    let mutated = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      const next = prepareBuffersForJson(v);
      if (next !== v) mutated = true;
      out[k] = next;
    }
    return mutated ? out : value;
  }
  return value;
}

function reviveBuffers(value: unknown): unknown {
  if (value === null || value === undefined || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(reviveBuffers);
  }
  const rec = value as Record<string, unknown>;
  if (
    rec.type === "Buffer" &&
    Array.isArray(rec.data) &&
    Object.keys(rec).length === 2
  ) {
    return Buffer.from(rec.data as number[]);
  }
  let mutated = false;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) {
    const next = reviveBuffers(v);
    if (next !== v) mutated = true;
    out[k] = next;
  }
  return mutated ? out : value;
}

function matchAmqpPattern(pattern: string, routingKey: string): boolean {
  if (pattern === routingKey) return true;
  if (!pattern.includes("*") && !pattern.includes("#")) return false;
  const pParts = pattern.split(".");
  const kParts = routingKey.split(".");

  const memo = new Map<number, boolean>();
  const match = (pi: number, ki: number): boolean => {
    const key = pi * (kParts.length + 1) + ki;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;

    let res = false;
    if (pi === pParts.length && ki === kParts.length) {
      res = true;
    } else if (pi < pParts.length) {
      const token = pParts[pi];
      if (token === "#") {
        // '#' matches zero or more words
        res =
          match(pi + 1, ki) || (ki < kParts.length && match(pi, ki + 1));
      } else if (ki < kParts.length && (token === "*" || token === kParts[ki])) {
        res = match(pi + 1, ki + 1);
      }
    }
    memo.set(key, res);
    return res;
  };
  return match(0, 0);
}

function tryDecodePayload(raw: string | Uint8Array): RpcEnvelope | null {
  try {
    const text =
      typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8");
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && "type" in parsed) {
      return parsed as RpcEnvelope;
    }
    return null;
  } catch {
    return null;
  }
}

function throwFromResponseError(
  error: NonNullable<RpcResponseEnvelope["error"]>,
): never {
  if (error.isRpcException) {
    throw RpcException.fromSerialized(error);
  }
  const err = new Error(error.message || "Remote RPC error");
  if (error.name) err.name = error.name;
  throw err;
}

// ---------------------------------------------------------------------------
// Redis Pub/Sub Transport Adapter (supports native Bun.RedisClient via url)
// ---------------------------------------------------------------------------

function createBunRedisPubSubClient(
  url?: string,
  returnBuffers = false,
): RedisTransportClientLike {
  const native = url ? new Bun.RedisClient(url) : Bun.redis;
  const listeners = new Map<
    string,
    (msg: string | Uint8Array, channel: string) => void
  >();
  return {
    publish: async (channel, message) => {
      await native.publish(channel, message);
    },
    subscribe: async (channel, handler) => {
      const listener = (msg: string | Uint8Array, ch: string) => {
        if (returnBuffers && msg instanceof Uint8Array) {
          handler(msg, ch || channel);
          return;
        }
        handler(typeof msg === "string" ? msg : String(msg), ch || channel);
      };
      listeners.set(channel, listener);
      await native.subscribe(
        channel,
        listener as (msg: string, ch: string) => void,
      );
    },
    unsubscribe: async (channel) => {
      const listener = listeners.get(channel);
      listeners.delete(channel);
      if (listener) {
        await native.unsubscribe(
          channel,
          listener as (msg: string, ch: string) => void,
        );
      } else {
        await native.send("UNSUBSCRIBE", [channel]);
      }
    },
    close: () => native.close(),
  };
}

function resolveRedisTransportClients(options: RedisTransportOptions): {
  pubClient: RedisTransportClientLike;
  subClient: RedisTransportClientLike;
} {
  if (options.pubClient) {
    return {
      pubClient: options.pubClient,
      subClient: options.subClient ?? options.pubClient,
    };
  }
  const url =
    options.url ??
    (options.host
      ? `redis://${options.host}:${options.port ?? 6379}`
      : undefined);
  const returnBuffers = options.returnBuffers ?? false;
  const pubClient = createBunRedisPubSubClient(url, returnBuffers);
  const subClient =
    options.subClient ?? createBunRedisPubSubClient(url, returnBuffers);
  return { pubClient, subClient };
}

export class RedisTransportServer extends MicroserviceTransportServer {
  public readonly transport = Transport.REDIS;

  private readonly pubClient: RedisTransportClientLike;
  private readonly subClient: RedisTransportClientLike;
  private readonly prefix: string;
  private readonly returnBuffers: boolean;
  private readonly gracefulShutdown: boolean;
  private readonly gracePeriod: number;
  private readonly wireFormat: WireFormat;
  private readonly serializer?: Serializer;
  private readonly deserializer?: Deserializer;
  private readonly subscribedChannels: string[] = [];
  private closing = false;
  private inFlight = 0;
  private drainWaiters: Array<() => void> = [];

  constructor(options: RedisTransportOptions) {
    super();
    this.configureServerOptions(options);
    const resolved = resolveRedisTransportClients(options);
    this.pubClient = resolved.pubClient;
    this.subClient = resolved.subClient;
    this.prefix = options.channelPrefix ?? "bunest:rpc";
    this.returnBuffers = options.returnBuffers ?? false;
    this.gracefulShutdown = options.gracefulShutdown ?? false;
    this.gracePeriod = options.gracePeriod ?? 5000;
    this.wireFormat = options.wireFormat ?? "bunest";
    this.serializer = options.serializer;
    this.deserializer = options.deserializer;
  }

  override get server(): RedisTransportClientLike {
    return this.subClient;
  }

  async listen(
    callback?: (...optionalParams: unknown[]) => any,
  ): Promise<void> {
    if (this.listening) {
      callback?.();
      return;
    }

    this.closing = false;
    const patterns = new Set<string>([
      ...this.messageHandlers.keys(),
      ...this.eventHandlers.keys(),
    ]);

    for (const pattern of patterns) {
      const channel = formatRedisChannel(this.prefix, pattern);
      await this.subClient.subscribe(channel, (rawMessage) => {
        void this.onMessage(pattern, channel, rawMessage);
      });
      if (!this.subscribedChannels.includes(channel)) {
        this.subscribedChannels.push(channel);
      }
    }

    this.listening = true;
    this.emitStatus(RedisStatus.CONNECTED);
    callback?.();
  }

  async close(): Promise<void> {
    this.listening = false;
    this.closing = true;
    this.emitStatus(RedisStatus.DISCONNECTED);
    for (const channel of this.subscribedChannels.splice(0)) {
      await this.subClient.unsubscribe?.(channel);
    }

    if (this.gracefulShutdown) {
      await waitForInFlightDrain(
        () => this.inFlight,
        this.drainWaiters,
        this.gracePeriod,
      );
      this.drainWaiters = [];
      if (typeof this.subClient.quit === "function") {
        await this.subClient.quit();
      } else if (typeof this.subClient.close === "function") {
        await this.subClient.close();
      }
      if (this.pubClient !== this.subClient) {
        if (typeof this.pubClient.quit === "function") {
          await this.pubClient.quit();
        } else if (typeof this.pubClient.close === "function") {
          await this.pubClient.close();
        }
      }
    }
  }

  private async onMessage(
    pattern: string,
    channel: string,
    rawMessage: string | Uint8Array,
  ): Promise<void> {
    if (this.closing) return;
    this.inFlight++;
    try {
      if (
        this.wireFormat === "bunest" &&
        !this.deserializer &&
        this.returnBuffers &&
        rawMessage instanceof Uint8Array
      ) {
        const envelope = tryDecodePayload(rawMessage);
        if (!envelope) {
          const ctx = new RedisContext([channel], pattern, { channel });
          if (this.eventHandlers.has(pattern)) {
            await this.dispatchEvent(pattern, rawMessage, ctx);
          } else if (this.messageHandlers.has(pattern)) {
            await this.dispatchMessage(pattern, rawMessage, ctx);
          }
          return;
        }
      }

      const decoded = await decodeInboundMessage({
        raw: rawMessage,
        wireFormat: this.wireFormat,
        deserializer: this.deserializer,
        channel: pattern,
        hasMessageHandler: (p) => this.messageHandlers.has(p),
        hasEventHandler: (p) => (this.eventHandlers.get(p)?.length ?? 0) > 0,
      });
      if (!decoded || decoded.kind === "response") {
        return;
      }

      const packetMeta = decoded.metadata
        ? toPacketMetadata(Object.entries(decoded.metadata))
        : undefined;
      const ctxMeta: Record<string, unknown> = {
        channel,
        ...(decoded.metadata ?? {}),
      };
      const ctx = new RedisContext(
        packetMeta ? [channel, packetMeta] : [channel],
        decoded.pattern,
        ctxMeta,
      );

      if (decoded.kind === "event") {
        const data = this.returnBuffers
          ? reviveBuffers(decoded.data)
          : decoded.data;
        await this.dispatchEvent(decoded.pattern, data, ctx);
        return;
      }

      const data = this.returnBuffers
        ? reviveBuffers(decoded.data)
        : decoded.data;
      const outcome = await this.dispatchMessage(decoded.pattern, data, ctx);
      const replyChannel =
        decoded.replyTo ??
        formatRedisChannel(this.prefix, `${decoded.pattern}.reply`);
      const unwrappedResponse =
        outcome.response instanceof RedisRecord
          ? outcome.response.data
          : outcome.response;
      const preparedResponse = this.returnBuffers
        ? prepareBuffersForJson(unwrappedResponse)
        : unwrappedResponse;
      const encodedReply = await encodeOutboundResponse({
        id: decoded.id,
        pattern: decoded.pattern,
        response: preparedResponse,
        error: outcome.error,
        isDisposed: true,
        wireFormat: this.wireFormat,
        responseWireStyle: decoded.responseWireStyle,
        serializer: this.serializer,
      });
      await this.pubClient.publish(
        replyChannel,
        stringifyWirePayload(encodedReply),
      );
    } finally {
      this.inFlight = Math.max(0, this.inFlight - 1);
      notifyDrainWaiters(() => this.inFlight, this.drainWaiters);
    }
  }
}

export class RedisClientProxy extends ClientProxy {
  public readonly transport = Transport.REDIS;
  public readonly clientId: string;
  public readonly replyChannel: string;

  private readonly pubClient: RedisTransportClientLike;
  private readonly subClient: RedisTransportClientLike;
  private readonly prefix: string;
  private readonly returnBuffers: boolean;
  private readonly wireFormat: WireFormat;
  private readonly serializer?: Serializer;
  private readonly deserializer?: Deserializer;
  private replySubscribed = false;
  private replySubscribePromise: Promise<void> | undefined;
  private readonly rawReplyChannels = new Set<string>();
  private readonly rawReplySubPromises = new Map<string, Promise<void>>();
  private readonly rawPendingByChannel = new Map<string, string[]>();
  private closeGeneration = 0;
  private readonly pending = new Map<
    string,
    {
      resolve: (v: unknown) => void;
      reject: (e: unknown) => void;
      timer: ReturnType<typeof setTimeout>;
      replyChannel?: string;
    }
  >();
  private seq = 0;

  constructor(options: RedisTransportOptions) {
    super(options.requestTimeout ?? options.defaultTimeoutMs ?? 5000, {
      requestTimeout: options.requestTimeout,
      maxPendingRequests: options.maxPendingRequests,
      retry: options.retry,
      circuitBreaker: options.circuitBreaker,
      clsPropagation: options.clsPropagation,
      cls: options.cls,
    });
    const resolved = resolveRedisTransportClients(options);
    this.pubClient = resolved.pubClient;
    this.subClient = resolved.subClient;
    this.prefix = options.channelPrefix ?? "bunest:rpc";
    this.returnBuffers = options.returnBuffers ?? false;
    this.wireFormat = options.wireFormat ?? "bunest";
    this.serializer = options.serializer;
    this.deserializer = options.deserializer;
    this.clientId = options.clientId ?? crypto.randomUUID();
    this.replyChannel = formatRedisChannel(this.prefix, `reply:${this.clientId}`);
  }

  async connect(): Promise<void> {
    await this.ensureReplyInbox();
    this.emitStatus("connected");
  }

  async close(): Promise<void> {
    this.closeGeneration++;
    this.replySubscribePromise = undefined;
    this.rawReplySubPromises.clear();
    this.rawPendingByChannel.clear();
    const closeErr = new Error("RedisClientProxy closed.");
    for (const [id, p] of this.pending.entries()) {
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(closeErr);
    }
    this.cancelActiveRequests(closeErr);
    this.emitStatus("disconnected");
    if (this.replySubscribed) {
      this.replySubscribed = false;
      await this.subClient.unsubscribe?.(this.replyChannel);
    }
    for (const ch of [...this.rawReplyChannels]) {
      this.rawReplyChannels.delete(ch);
      await this.subClient.unsubscribe?.(ch);
    }
  }

  private resolvePendingReply(
    id: string | undefined,
    replyChannel: string | undefined,
    response: unknown,
    error: RpcResponseEnvelope["error"],
  ): void {
    let targetId = id;
    if ((!targetId || !this.pending.has(targetId)) && replyChannel) {
      const queue = this.rawPendingByChannel.get(replyChannel);
      while (queue && queue.length > 0) {
        const candidate = queue.shift()!;
        if (this.pending.has(candidate)) {
          targetId = candidate;
          break;
        }
      }
    }
    if (!targetId) return;
    const entry = this.pending.get(targetId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(targetId);
    if (error) {
      try {
        throwFromResponseError(error);
      } catch (err) {
        entry.reject(err);
      }
    } else {
      const responseVal = this.returnBuffers
        ? reviveBuffers(response)
        : response;
      entry.resolve(responseVal);
    }
  }

  private async handleReplyRaw(
    raw: string | Uint8Array,
    replyChannel?: string,
  ): Promise<void> {
    if (this.wireFormat === "bunest" && !this.deserializer) {
      const envelope = tryDecodePayload(raw);
      if (!envelope || envelope.type !== "response") return;
      this.resolvePendingReply(
        envelope.id,
        replyChannel,
        envelope.response,
        envelope.error,
      );
      return;
    }

    const decoded = await decodeInboundResponse({
      raw,
      wireFormat: this.wireFormat,
      deserializer: this.deserializer,
    });
    if (!decoded) return;
    this.resolvePendingReply(
      decoded.id,
      replyChannel,
      decoded.response,
      decoded.error,
    );
  }

  private async ensureReplyInbox(): Promise<void> {
    if (this.replySubscribed) {
      return;
    }
    if (this.replySubscribePromise) {
      await this.replySubscribePromise;
      return;
    }
    const gen = this.closeGeneration;
    const promise = Promise.resolve(
      this.subClient.subscribe(this.replyChannel, (raw) => {
        void this.handleReplyRaw(raw, this.replyChannel);
      }),
    )
      .then(async () => {
        if (this.closeGeneration !== gen) {
          await this.subClient.unsubscribe?.(this.replyChannel);
          throw new Error("RedisClientProxy closed.");
        }
        this.replySubscribed = true;
      })
      .catch((err) => {
        if (this.replySubscribePromise === promise) {
          this.replySubscribePromise = undefined;
        }
        throw err;
      });
    this.replySubscribePromise = promise;

    await promise;
  }

  private async ensureRawPatternReplyChannel(channel: string): Promise<void> {
    if (this.rawReplyChannels.has(channel)) {
      return;
    }
    const existing = this.rawReplySubPromises.get(channel);
    if (existing) {
      await existing;
      return;
    }
    const gen = this.closeGeneration;
    const promise = Promise.resolve(
      this.subClient.subscribe(channel, (raw) => {
        void this.handleReplyRaw(raw, channel);
      }),
    )
      .then(async () => {
        if (this.closeGeneration !== gen) {
          await this.subClient.unsubscribe?.(channel);
          throw new Error("RedisClientProxy closed.");
        }
        this.rawReplyChannels.add(channel);
      })
      .finally(() => {
        this.rawReplySubPromises.delete(channel);
      });
    this.rawReplySubPromises.set(channel, promise);
    await promise;
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
    const gen = this.closeGeneration;
    const usePatternReplyChannel =
      this.wireFormat === "raw-json" && !this.serializer;
    const targetReplyChannel = usePatternReplyChannel
      ? formatRedisChannel(this.prefix, `${pattern}.reply`)
      : this.replyChannel;

    if (usePatternReplyChannel) {
      await this.ensureRawPatternReplyChannel(targetReplyChannel);
    } else {
      await this.ensureReplyInbox();
    }
    if (this.closeGeneration !== gen) {
      throw new Error("RedisClientProxy closed.");
    }
    if (signal?.aborted) {
      throw new RpcTimeoutException(pattern, timeoutMs);
    }

    const unwrappedData = data instanceof RedisRecord ? data.data : data;
    const headers =
      data instanceof RedisRecord ? data.options?.headers : undefined;

    const id = `redis_${++this.seq}_${crypto.randomUUID().slice(0, 8)}`;
    const preparedData = this.returnBuffers
      ? prepareBuffersForJson(unwrappedData)
      : unwrappedData;
    const encodedReq = await encodeOutboundRequest({
      id,
      pattern,
      data: preparedData,
      replyTo: targetReplyChannel,
      metadata,
      headers,
      includeHeadersInEnvelope: true,
      wireFormat: this.wireFormat,
      serializer: this.serializer,
    });
    const payloadStr = stringifyWirePayload(encodedReq);

    return await new Promise<TRes>((resolve, reject) => {
      const removeFromRawQueue = () => {
        if (!usePatternReplyChannel) return;
        const q = this.rawPendingByChannel.get(targetReplyChannel);
        if (q) {
          const idx = q.indexOf(id);
          if (idx !== -1) q.splice(idx, 1);
        }
      };
      const onAbort = () => {
        if (this.pending.delete(id)) {
          clearTimeout(timer);
          removeFromRawQueue();
          reject(new RpcTimeoutException(pattern, timeoutMs));
        }
      };
      const cleanup = () => {
        signal?.removeEventListener("abort", onAbort);
        removeFromRawQueue();
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
        resolve: (v: unknown) => {
          cleanup();
          resolve(v as TRes);
        },
        reject: (e: unknown) => {
          cleanup();
          reject(e);
        },
        timer,
        replyChannel: targetReplyChannel,
      });

      if (usePatternReplyChannel) {
        let q = this.rawPendingByChannel.get(targetReplyChannel);
        if (!q) {
          q = [];
          this.rawPendingByChannel.set(targetReplyChannel, q);
        }
        q.push(id);
      }

      signal?.addEventListener("abort", onAbort, { once: true });

      Promise.resolve(
        this.pubClient.publish(
          formatRedisChannel(this.prefix, pattern),
          payloadStr,
        ),
      ).catch((err) => {
        clearTimeout(timer);
        cleanup();
        this.pending.delete(id);
        reject(err);
      });
    });
  }

  protected override async dispatchEvent<TReq = any>(
    pattern: string,
    data: TReq,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const unwrappedData = data instanceof RedisRecord ? data.data : data;
    const headers =
      data instanceof RedisRecord ? data.options?.headers : undefined;
    const preparedData = this.returnBuffers
      ? prepareBuffersForJson(unwrappedData)
      : unwrappedData;
    const encoded = await encodeOutboundEvent({
      pattern,
      data: preparedData,
      metadata,
      headers,
      includeHeadersInEnvelope: true,
      wireFormat: this.wireFormat,
      serializer: this.serializer,
    });
    await this.pubClient.publish(
      formatRedisChannel(this.prefix, pattern),
      stringifyWirePayload(encoded),
    );
  }
}

export const RedisTransportAdapter = {
  Server: RedisTransportServer,
  Client: RedisClientProxy,
};

// ---------------------------------------------------------------------------
// NATS Transport Adapter
// ---------------------------------------------------------------------------

export class NatsTransportServer extends MicroserviceTransportServer {
  public readonly transport = Transport.NATS;

  private readonly client: NatsTransportClientLike;
  private readonly prefix: string;
  private readonly gracefulShutdown: boolean;
  private readonly gracePeriod: number;
  private readonly wireFormat: WireFormat;
  private readonly serializer?: Serializer;
  private readonly deserializer?: Deserializer;
  private readonly subscriptions: NatsSubscriptionLike[] = [];
  private closing = false;
  private inFlight = 0;
  private drainWaiters: Array<() => void> = [];

  constructor(options: NatsTransportOptions) {
    super();
    this.configureServerOptions(options);
    this.client = options.client;
    this.prefix = options.subjectPrefix ? `${options.subjectPrefix}.` : "";
    this.gracefulShutdown = options.gracefulShutdown ?? false;
    this.gracePeriod = options.gracePeriod ?? 5000;
    this.wireFormat = options.wireFormat ?? "bunest";
    this.serializer = options.serializer;
    this.deserializer = options.deserializer;
  }

  override get server(): NatsTransportClientLike {
    return this.client;
  }

  async listen(
    callback?: (...optionalParams: unknown[]) => any,
  ): Promise<void> {
    if (this.listening) {
      callback?.();
      return;
    }

    this.closing = false;
    const patterns = new Set<string>([
      ...this.messageHandlers.keys(),
      ...this.eventHandlers.keys(),
    ]);

    for (const pattern of patterns) {
      const subject = `${this.prefix}${pattern}`;
      const sub = await this.client.subscribe(subject, async (msg) => {
        await this.onMessage(pattern, msg);
      });
      if (sub) {
        this.subscriptions.push(sub);
      }
    }

    this.listening = true;
    this.emitStatus(NatsStatus.CONNECTED);
    callback?.();
  }

  async close(): Promise<void> {
    this.listening = false;
    this.closing = true;
    this.emitStatus(NatsStatus.DISCONNECTED);
    for (const sub of this.subscriptions.splice(0)) {
      await sub.unsubscribe?.();
    }

    if (this.gracefulShutdown) {
      await waitForInFlightDrain(
        () => this.inFlight,
        this.drainWaiters,
        this.gracePeriod,
      );
      this.drainWaiters = [];
      if (typeof this.client.drain === "function") {
        await this.client.drain();
      } else if (typeof this.client.close === "function") {
        await this.client.close();
      }
    }
  }

  private async onMessage(
    pattern: string,
    msg: NatsMessageLike,
  ): Promise<void> {
    if (this.closing) return;
    this.inFlight++;
    try {
      const decoded = await decodeInboundMessage({
        raw: msg.data,
        wireFormat: this.wireFormat,
        deserializer: this.deserializer,
        channel: pattern,
        replyTo: msg.reply,
        headers: extractHeadersRecord(msg.headers),
        hasMessageHandler: (p) => this.messageHandlers.has(p),
        hasEventHandler: (p) => (this.eventHandlers.get(p)?.length ?? 0) > 0,
      });
      if (!decoded || decoded.kind === "response") return;

      // If this subscription is a NATS wildcard (* or >) and an exact handler is
      // registered for the concrete incoming subject, defer to the exact handler
      // to avoid duplicate execution/replies.
      if (pattern.includes("*") || pattern.includes(">")) {
        const concretePattern =
          this.prefix && msg.subject.startsWith(this.prefix)
            ? msg.subject.slice(this.prefix.length)
            : msg.subject;
        if (
          concretePattern !== pattern &&
          ((decoded.kind === "request" &&
            this.messageHandlers.has(concretePattern)) ||
            (decoded.kind === "event" &&
              this.eventHandlers.has(concretePattern)))
        ) {
          return;
        }
      }

      const packetMeta = decoded.metadata
        ? toPacketMetadata(Object.entries(decoded.metadata))
        : undefined;
      const effectiveHeaders =
        msg.headers !== undefined ? msg.headers : packetMeta;
      const ctx = new NatsContext(
        [msg.subject, effectiveHeaders],
        decoded.pattern,
        {
          subject: msg.subject,
          reply: msg.reply,
          ...(decoded.metadata ?? {}),
        },
      );

      if (decoded.kind === "event") {
        await this.dispatchEvent(decoded.pattern, decoded.data, ctx);
        return;
      }

      const outcome = await this.dispatchMessage(
        decoded.pattern,
        decoded.data,
        ctx,
      );
      const replyTarget = msg.reply ?? decoded.replyTo;
      if (!replyTarget) {
        return;
      }
      const isNatsRecord = outcome.response instanceof NatsRecord;
      const unwrappedResponse = isNatsRecord
        ? (outcome.response as NatsRecord).data
        : outcome.response;
      const responseHeaders = isNatsRecord
        ? (outcome.response as NatsRecord).headers
        : undefined;
      const encodedReply = await encodeOutboundResponse({
        id: decoded.id,
        pattern: decoded.pattern,
        response: unwrappedResponse,
        error: outcome.error,
        isDisposed: true,
        wireFormat: this.wireFormat,
        responseWireStyle: decoded.responseWireStyle,
        serializer: this.serializer,
      });
      const replyPayload = stringifyWirePayload(encodedReply);

      if (typeof msg.respond === "function" && msg.reply) {
        if (responseHeaders !== undefined) {
          await msg.respond(replyPayload, { headers: responseHeaders });
        } else {
          await msg.respond(replyPayload);
        }
      } else {
        if (responseHeaders !== undefined) {
          await this.client.publish(replyTarget, replyPayload, {
            headers: responseHeaders,
          });
        } else {
          await this.client.publish(replyTarget, replyPayload);
        }
      }
    } finally {
      this.inFlight = Math.max(0, this.inFlight - 1);
      notifyDrainWaiters(() => this.inFlight, this.drainWaiters);
    }
  }
}

export class NatsClientProxy extends ClientProxy {
  public readonly transport = Transport.NATS;

  private readonly client: NatsTransportClientLike;
  private readonly prefix: string;
  private readonly wireFormat: WireFormat;
  private readonly serializer?: Serializer;
  private readonly deserializer?: Deserializer;
  private seq = 0;
  private readonly activeFallbackCancels = new Set<(err: Error) => void>();

  constructor(options: NatsTransportOptions) {
    super(options.requestTimeout ?? options.defaultTimeoutMs ?? 5000, {
      requestTimeout: options.requestTimeout,
      maxPendingRequests: options.maxPendingRequests,
      retry: options.retry,
      circuitBreaker: options.circuitBreaker,
      clsPropagation: options.clsPropagation,
      cls: options.cls,
    });
    this.client = options.client;
    this.prefix = options.subjectPrefix ? `${options.subjectPrefix}.` : "";
    this.wireFormat = options.wireFormat ?? "bunest";
    this.serializer = options.serializer;
    this.deserializer = options.deserializer;
  }

  async connect(): Promise<void> {
    this.emitStatus("connected");
  }

  async close(): Promise<void> {
    this.emitStatus("disconnected");
    const closeErr = new Error("NatsClientProxy closed.");
    for (const cancel of [...this.activeFallbackCancels]) {
      cancel(closeErr);
    }
    this.activeFallbackCancels.clear();
    this.cancelActiveRequests(closeErr);
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
    const isRecord = data instanceof NatsRecord;
    const unwrappedData = isRecord ? data.data : data;
    const recordHeaders = isRecord ? data.headers : undefined;

    const id = `nats_${++this.seq}_${crypto.randomUUID().slice(0, 8)}`;
    const subject = `${this.prefix}${pattern}`;
    const encodedReq = await encodeOutboundRequest({
      id,
      pattern,
      data: unwrappedData,
      metadata,
      headers: extractHeadersRecord(recordHeaders),
      wireFormat: this.wireFormat,
      serializer: this.serializer,
    });
    const payload = stringifyWirePayload(encodedReq);

    if (typeof this.client.request === "function") {
      const requestOpts =
        recordHeaders !== undefined
          ? { timeout: timeoutMs, headers: recordHeaders }
          : { timeout: timeoutMs };
      const replyMsg = await this.client.request(subject, payload, requestOpts);
      const response = await decodeInboundResponse({
        raw: replyMsg.data,
        wireFormat: this.wireFormat,
        deserializer: this.deserializer,
        fallbackId: id,
      });
      if (!response) {
        throw new Error("Received malformed NATS RPC response.");
      }
      if (response.error) {
        throwFromResponseError(response.error);
      }
      return response.response as TRes;
    }

    // Fallback inbox subscription if client doesn't expose request()
    const inbox = `_INBOX.${id}`;
    return await new Promise<TRes>((resolve, reject) => {
      let sub: NatsSubscriptionLike | void;
      let settled = false;
      const cancelWith = (err: Error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          cleanup();
          void sub?.unsubscribe?.();
          reject(err);
        }
      };
      const onAbort = () => {
        cancelWith(new RpcTimeoutException(pattern, timeoutMs));
      };
      const cleanup = () => {
        signal?.removeEventListener("abort", onAbort);
        this.activeFallbackCancels.delete(cancelWith);
      };
      this.activeFallbackCancels.add(cancelWith);
      const timer = setTimeout(() => {
        cancelWith(new RpcTimeoutException(pattern, timeoutMs));
      }, timeoutMs);
      if (typeof (timer as { unref?: () => void }).unref === "function") {
        (timer as { unref: () => void }).unref();
      }
      signal?.addEventListener("abort", onAbort, { once: true });

      Promise.resolve(
        this.client.subscribe(inbox, async (msg) => {
          if (settled) return;
          const response = await decodeInboundResponse({
            raw: msg.data,
            wireFormat: this.wireFormat,
            deserializer: this.deserializer,
            fallbackId: id,
          });
          if (!response || settled) {
            return;
          }
          if (
            this.wireFormat === "bunest" &&
            !this.deserializer &&
            response.id !== id
          ) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          cleanup();
          await sub?.unsubscribe?.();
          if (response.error) {
            try {
              throwFromResponseError(response.error);
            } catch (err) {
              reject(err);
            }
          } else {
            resolve(response.response as TRes);
          }
        }),
      )
        .then((createdSub) => {
          sub = createdSub;
          if (settled || signal?.aborted) {
            void sub?.unsubscribe?.();
            return;
          }
          const publishOpts =
            recordHeaders !== undefined
              ? { reply: inbox, headers: recordHeaders }
              : { reply: inbox };
          return this.client.publish(subject, payload, publishOpts);
        })
        .catch((err) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            cleanup();
            void sub?.unsubscribe?.();
            reject(err);
          }
        });
    });
  }

  protected override async dispatchEvent<TReq = any>(
    pattern: string,
    data: TReq,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const isRecord = data instanceof NatsRecord;
    const unwrappedData = isRecord ? data.data : data;
    const recordHeaders = isRecord ? data.headers : undefined;
    const subject = `${this.prefix}${pattern}`;
    const encoded = await encodeOutboundEvent({
      pattern,
      data: unwrappedData,
      metadata,
      headers: extractHeadersRecord(recordHeaders),
      wireFormat: this.wireFormat,
      serializer: this.serializer,
    });
    const payload = stringifyWirePayload(encoded);
    if (recordHeaders !== undefined) {
      await this.client.publish(subject, payload, { headers: recordHeaders });
    } else {
      await this.client.publish(subject, payload);
    }
  }
}

export const NatsTransportAdapter = {
  Server: NatsTransportServer,
  Client: NatsClientProxy,
};

// ---------------------------------------------------------------------------
// RabbitMQ (AMQP) Transport Adapter
// ---------------------------------------------------------------------------

export class RabbitMqTransportServer extends MicroserviceTransportServer {
  public readonly transport = Transport.RABBITMQ;

  private readonly channel: RabbitMqChannelLike;
  private readonly queue: string;
  private readonly noAck: boolean;
  private readonly wildcards: boolean;
  private readonly gracefulShutdown: boolean;
  private readonly gracePeriod: number;
  private readonly nackOnInternalError: boolean;
  private readonly nackRequeue: boolean;
  private readonly wireFormat: WireFormat;
  private readonly serializer?: Serializer;
  private readonly deserializer?: Deserializer;
  private consumerTag?: string;
  private listenGeneration = 0;
  private closing = false;
  private inFlight = 0;
  private drainWaiters: Array<() => void> = [];

  constructor(options: RabbitMqTransportOptions) {
    super();
    this.configureServerOptions(options);
    this.channel = options.channel;
    this.queue = options.queue;
    this.noAck = options.noAck ?? false;
    this.wildcards = options.wildcards ?? false;
    this.gracefulShutdown = options.gracefulShutdown ?? false;
    this.gracePeriod = options.gracePeriod ?? 5000;
    this.nackOnInternalError = options.nackOnInternalError ?? false;
    this.nackRequeue = options.nackRequeue ?? false;
    this.wireFormat = options.wireFormat ?? "bunest";
    this.serializer = options.serializer;
    this.deserializer = options.deserializer;
  }

  override get server(): RabbitMqChannelLike {
    return this.channel;
  }

  override unwrap<T = unknown>(): T {
    return this.channel as unknown as T;
  }

  async listen(
    callback?: (...optionalParams: unknown[]) => any,
  ): Promise<void> {
    if (this.listening) {
      callback?.();
      return;
    }

    this.closing = false;
    const gen = ++this.listenGeneration;
    await this.channel.assertQueue(this.queue);
    if (this.listenGeneration !== gen) {
      return;
    }
    const res = await this.channel.consume(
      this.queue,
      async (msg) => {
        await this.onMessage(msg);
      },
      { noAck: this.noAck },
    );
    if (this.listenGeneration !== gen) {
      if (res?.consumerTag && typeof this.channel.cancel === "function") {
        try {
          await this.channel.cancel(res.consumerTag);
        } catch {
          // ignore
        }
      }
      return;
    }
    this.consumerTag = res?.consumerTag;
    this.listening = true;
    this.emitStatus(RmqStatus.CONNECTED);
    callback?.();
  }

  async close(): Promise<void> {
    this.listenGeneration++;
    this.listening = false;
    this.closing = true;
    this.emitStatus(RmqStatus.DISCONNECTED);
    const tag = this.consumerTag;
    this.consumerTag = undefined;
    if (tag && typeof this.channel.cancel === "function") {
      try {
        await this.channel.cancel(tag);
      } catch {
        // Channel may already be closed
      }
    }

    if (this.gracefulShutdown) {
      await waitForInFlightDrain(
        () => this.inFlight,
        this.drainWaiters,
        this.gracePeriod,
      );
      this.drainWaiters = [];
      if (typeof this.channel.close === "function") {
        try {
          await this.channel.close();
        } catch {
          // Channel may already be closed
        }
      }
    }
  }

  private resolveMessagePatternKey(pattern: string): string | undefined {
    if (this.messageHandlers.has(pattern)) {
      return pattern;
    }
    if (this.wildcards) {
      for (const candidate of this.messageHandlers.keys()) {
        if (matchAmqpPattern(candidate, pattern)) {
          return candidate;
        }
      }
    }
    return undefined;
  }

  private resolveEventPatternKeys(pattern: string): string[] {
    if (this.eventHandlers.has(pattern)) {
      return [pattern];
    }
    if (this.wildcards) {
      const matched: string[] = [];
      for (const candidate of this.eventHandlers.keys()) {
        if (matchAmqpPattern(candidate, pattern)) {
          matched.push(candidate);
        }
      }
      return matched;
    }
    return [];
  }

  private async onMessage(
    msg: RabbitMqMessageLike | null | undefined,
  ): Promise<void> {
    if (this.closing || !msg || msg.content === undefined || msg.content === null) {
      return;
    }
    this.inFlight++;
    try {
      const rawRoutingKey =
        typeof msg.fields?.routingKey === "string" &&
        msg.fields.routingKey.length > 0
          ? msg.fields.routingKey
          : undefined;
      const headerPattern =
        typeof msg.properties?.headers?.["x-pattern"] === "string" &&
        (msg.properties.headers["x-pattern"] as string).length > 0
          ? (msg.properties.headers["x-pattern"] as string)
          : typeof msg.properties?.headers?.pattern === "string" &&
              (msg.properties.headers.pattern as string).length > 0
            ? (msg.properties.headers.pattern as string)
            : undefined;
      const channelPattern = rawRoutingKey ?? headerPattern ?? this.queue;

      const decoded = await decodeInboundMessage({
        raw: msg.content,
        wireFormat: this.wireFormat,
        deserializer: this.deserializer,
        channel: channelPattern,
        replyTo: msg.properties?.replyTo,
        correlationId: msg.properties?.correlationId,
        headers: msg.properties?.headers,
        hasMessageHandler: (p) => this.resolveMessagePatternKey(p) !== undefined,
        hasEventHandler: (p) => this.resolveEventPatternKeys(p).length > 0,
      });
      if (!decoded) {
        if (!this.noAck) {
          this.channel.nack?.(msg, false, false);
        }
        return;
      }
      if (decoded.kind === "response") {
        if (!this.noAck) {
          this.channel.ack?.(msg);
        }
        return;
      }

      const pattern = decoded.pattern;
      const metadata: Record<string, unknown> = {
        queue: this.queue,
        correlationId: msg.properties?.correlationId,
        replyTo: msg.properties?.replyTo,
        ...(rawRoutingKey !== undefined ? { routingKey: rawRoutingKey } : {}),
        ...(decoded.metadata ?? {}),
      };
      if (msg.properties?.headers !== undefined) {
        metadata.headers = msg.properties.headers;
      }
      const packetMeta = decoded.metadata
        ? toPacketMetadata(Object.entries(decoded.metadata))
        : undefined;
      const msgForCtx: Record<string, any> =
        packetMeta && !msg.properties?.headers
          ? {
              ...msg,
              properties: {
                ...(msg.properties ?? {}),
                headers: packetMeta,
              },
            }
          : (msg as Record<string, any>);
      const ctx = new RmqContext([msgForCtx, this.channel, pattern], metadata);

      try {
        if (decoded.kind === "event") {
          const matchedKeys = this.resolveEventPatternKeys(pattern);
          if (matchedKeys.length === 0) {
            if (!this.noAck) {
              this.channel.nack?.(msg, false, false);
            }
            return;
          }
          for (const key of matchedKeys) {
            await this.dispatchEvent(key, decoded.data, ctx);
          }
          if (!this.noAck) {
            this.channel.ack?.(msg);
          }
          return;
        }

        const matchedKey = this.resolveMessagePatternKey(pattern);
        const dispatchKey = matchedKey ?? pattern;
        const outcome = await this.dispatchMessage(
          dispatchKey,
          decoded.data,
          ctx,
        );
        const replyTo = msg.properties?.replyTo ?? decoded.replyTo;
        if (replyTo) {
          const isRecord = outcome.response instanceof RmqRecord;
          const unwrappedResponse = isRecord
            ? (outcome.response as RmqRecord).data
            : outcome.response;
          const recordOpts = isRecord
            ? (outcome.response as RmqRecord).options
            : undefined;
          const correlationId = msg.properties?.correlationId ?? decoded.id;
          const encodedReply = await encodeOutboundResponse({
            id: correlationId,
            pattern,
            response: unwrappedResponse,
            error: outcome.error,
            isDisposed: true,
            wireFormat: this.wireFormat,
            responseWireStyle: decoded.responseWireStyle,
            serializer: this.serializer,
          });
          await this.channel.sendToQueue(
            replyTo,
            stringifyWirePayload(encodedReply),
            {
              ...(recordOpts ?? {}),
              correlationId,
            },
          );
        }
        if (!this.noAck) {
          if (!matchedKey) {
            this.channel.nack?.(msg, false, false);
          } else if (outcome.error && this.nackOnInternalError) {
            this.channel.nack?.(msg, false, this.nackRequeue);
          } else {
            this.channel.ack?.(msg);
          }
        }
        return;
      } catch {
        if (!this.noAck) {
          this.channel.nack?.(
            msg,
            false,
            this.nackOnInternalError ? this.nackRequeue : false,
          );
        }
      }
    } finally {
      this.inFlight = Math.max(0, this.inFlight - 1);
      notifyDrainWaiters(() => this.inFlight, this.drainWaiters);
    }
  }
}

export class RabbitMqClientProxy extends ClientProxy {
  public readonly transport = Transport.RABBITMQ;

  private readonly channel: RabbitMqChannelLike;
  private readonly queue: string;
  private readonly replyQueue: string;
  private readonly wireFormat: WireFormat;
  private readonly serializer?: Serializer;
  private readonly deserializer?: Deserializer;
  private replyInitialized = false;
  private replyInitPromise?: Promise<void>;
  private replyConsumerTag?: string;
  private closeGeneration = 0;
  private readonly pending = new Map<
    string,
    {
      resolve: (v: unknown) => void;
      reject: (e: unknown) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private seq = 0;

  constructor(options: RabbitMqTransportOptions) {
    super(options.requestTimeout ?? options.defaultTimeoutMs ?? 5000, {
      requestTimeout: options.requestTimeout,
      maxPendingRequests: options.maxPendingRequests,
      retry: options.retry,
      circuitBreaker: options.circuitBreaker,
      clsPropagation: options.clsPropagation,
      cls: options.cls,
    });
    this.channel = options.channel;
    this.queue = options.queue;
    this.wireFormat = options.wireFormat ?? "bunest";
    this.serializer = options.serializer;
    this.deserializer = options.deserializer;
    this.replyQueue =
      options.replyQueue ??
      `${options.queue}.reply.${crypto.randomUUID().slice(0, 8)}`;
  }

  override unwrap<T = unknown>(): T {
    return this.channel as unknown as T;
  }

  async connect(): Promise<void> {
    await this.ensureReplyConsumer();
    this.emitStatus("connected");
  }

  async close(): Promise<void> {
    this.closeGeneration++;
    this.replyInitPromise = undefined;
    const closeErr = new Error("RabbitMqClientProxy closed.");
    for (const [id, p] of this.pending.entries()) {
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(closeErr);
    }
    this.cancelActiveRequests(closeErr);
    this.emitStatus("disconnected");
    const tag = this.replyConsumerTag;
    this.replyConsumerTag = undefined;
    this.replyInitialized = false;
    if (tag && typeof this.channel.cancel === "function") {
      await this.channel.cancel(tag);
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
    const gen = this.closeGeneration;
    await this.ensureReplyConsumer();
    if (this.closeGeneration !== gen) {
      throw new Error("RabbitMqClientProxy closed.");
    }
    if (signal?.aborted) {
      throw new RpcTimeoutException(pattern, timeoutMs);
    }

    const isRecord = data instanceof RmqRecord;
    const unwrappedData = isRecord ? data.data : data;
    const recordOpts = isRecord ? data.options : undefined;

    const id = `rmq_${++this.seq}_${crypto.randomUUID().slice(0, 8)}`;
    const encodedReq = await encodeOutboundRequest({
      id,
      pattern,
      data: unwrappedData,
      replyTo: this.replyQueue,
      metadata,
      headers: recordOpts?.headers as Record<string, unknown> | undefined,
      wireFormat: this.wireFormat,
      serializer: this.serializer,
    });
    const payloadStr = stringifyWirePayload(encodedReq);

    const sendHeaders =
      this.wireFormat === "raw-json"
        ? {
            ...(recordOpts?.headers ?? {}),
            "x-pattern": pattern,
          }
        : recordOpts?.headers;

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
      const onSendError = (err: unknown) => {
        clearTimeout(timer);
        cleanup();
        this.pending.delete(id);
        reject(err);
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
        resolve: (v: unknown) => {
          cleanup();
          resolve(v as TRes);
        },
        reject: (e: unknown) => {
          cleanup();
          reject(e);
        },
        timer,
      });

      signal?.addEventListener("abort", onAbort, { once: true });

      try {
        Promise.resolve(
          this.channel.sendToQueue(this.queue, payloadStr, {
            ...(recordOpts ?? {}),
            ...(sendHeaders !== undefined ? { headers: sendHeaders } : {}),
            correlationId: id,
            replyTo: this.replyQueue,
          }),
        ).catch(onSendError);
      } catch (err) {
        onSendError(err);
      }
    });
  }

  protected override async dispatchEvent<TReq = any>(
    pattern: string,
    data: TReq,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await this.channel.assertQueue(this.queue);
    const isRecord = data instanceof RmqRecord;
    const unwrappedData = isRecord ? data.data : data;
    const recordOpts = isRecord ? data.options : undefined;
    const encoded = await encodeOutboundEvent({
      pattern,
      data: unwrappedData,
      metadata,
      headers: recordOpts?.headers as Record<string, unknown> | undefined,
      wireFormat: this.wireFormat,
      serializer: this.serializer,
    });
    const payloadStr = stringifyWirePayload(encoded);
    const sendHeaders =
      this.wireFormat === "raw-json"
        ? {
            ...(recordOpts?.headers ?? {}),
            "x-pattern": pattern,
          }
        : recordOpts?.headers;

    if (recordOpts !== undefined || sendHeaders !== undefined) {
      await this.channel.sendToQueue(this.queue, payloadStr, {
        ...(recordOpts ?? {}),
        ...(sendHeaders !== undefined ? { headers: sendHeaders } : {}),
      });
    } else {
      await this.channel.sendToQueue(this.queue, payloadStr);
    }
  }

  private async ensureReplyConsumer(): Promise<void> {
    if (this.replyInitialized) return;
    if (this.replyInitPromise) {
      await this.replyInitPromise;
      return;
    }

    const gen = this.closeGeneration;
    const setupPromise = (async () => {
      await this.channel.assertQueue(this.queue);
      if (this.closeGeneration !== gen) {
        throw new Error("RabbitMqClientProxy closed.");
      }
      await this.channel.assertQueue(this.replyQueue, { exclusive: true });
      if (this.closeGeneration !== gen) {
        throw new Error("RabbitMqClientProxy closed.");
      }
      const res = await this.channel.consume(
        this.replyQueue,
        async (msg) => {
          if (!msg || msg.content === undefined || msg.content === null) {
            return;
          }
          const decoded = await decodeInboundResponse({
            raw: msg.content,
            wireFormat: this.wireFormat,
            deserializer: this.deserializer,
            fallbackId: msg.properties?.correlationId,
          });
          if (!decoded) return;
          const id = msg.properties?.correlationId ?? decoded.id;
          if (!id) return;
          const entry = this.pending.get(id);
          if (!entry) return;
          clearTimeout(entry.timer);
          this.pending.delete(id);
          if (decoded.error) {
            try {
              throwFromResponseError(decoded.error);
            } catch (err) {
              entry.reject(err);
            }
          } else {
            entry.resolve(decoded.response);
          }
        },
        { noAck: true },
      );
      if (this.closeGeneration !== gen) {
        if (res?.consumerTag && typeof this.channel.cancel === "function") {
          try {
            await this.channel.cancel(res.consumerTag);
          } catch {
            // ignore
          }
        }
        throw new Error("RabbitMqClientProxy closed.");
      }
      this.replyConsumerTag = res?.consumerTag;
      this.replyInitialized = true;
    })().catch((err) => {
      if (this.replyInitPromise === setupPromise) {
        this.replyInitPromise = undefined;
      }
      this.replyInitialized = false;
      throw err;
    });

    this.replyInitPromise = setupPromise;
    await setupPromise;
  }
}

export const RabbitMqTransportAdapter = {
  Server: RabbitMqTransportServer,
  Client: RabbitMqClientProxy,
};

// Ergonomic server & NestJS transport aliases for hybrid app.connectMicroservice() parity
export {
  NatsClientProxy as ClientNats,
  NatsTransportServer as NatsServer,
  NatsTransportServer as ServerNats,
  RabbitMqClientProxy as ClientRMQ,
  RabbitMqTransportServer as RabbitMqServer,
  RabbitMqTransportServer as ServerRMQ,
  RedisClientProxy as ClientRedis,
  RedisTransportServer as RedisServer,
  RedisTransportServer as ServerRedis,
};
