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
} from "../interfaces";
import { NatsRecord, RedisRecord, RmqRecord } from "../records";
import { MicroserviceTransportServer } from "../server";
import { Transport } from "../tokens";

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

function createBunRedisPubSubClient(url?: string): RedisTransportClientLike {
  const native = url ? new Bun.RedisClient(url) : Bun.redis;
  const listeners = new Map<string, (msg: string, channel: string) => void>();
  return {
    publish: async (channel, message) => {
      await native.publish(channel, message);
    },
    subscribe: async (channel, handler) => {
      const listener = (msg: string, ch: string) => {
        handler(typeof msg === "string" ? msg : String(msg), ch || channel);
      };
      listeners.set(channel, listener);
      await native.subscribe(channel, listener);
    },
    unsubscribe: async (channel) => {
      const listener = listeners.get(channel);
      listeners.delete(channel);
      if (listener) {
        await native.unsubscribe(channel, listener);
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
  const pubClient = createBunRedisPubSubClient(url);
  const subClient = options.subClient ?? createBunRedisPubSubClient(url);
  return { pubClient, subClient };
}

export class RedisTransportServer extends MicroserviceTransportServer {
  public readonly transport = Transport.REDIS;

  private readonly pubClient: RedisTransportClientLike;
  private readonly subClient: RedisTransportClientLike;
  private readonly prefix: string;
  private readonly subscribedChannels: string[] = [];

  constructor(options: RedisTransportOptions) {
    super();
    const resolved = resolveRedisTransportClients(options);
    this.pubClient = resolved.pubClient;
    this.subClient = resolved.subClient;
    this.prefix = options.channelPrefix ?? "bunest:rpc";
  }

  async listen(
    callback?: (...optionalParams: unknown[]) => any,
  ): Promise<void> {
    if (this.listening) {
      callback?.();
      return;
    }

    const patterns = new Set<string>([
      ...this.messageHandlers.keys(),
      ...this.eventHandlers.keys(),
    ]);

    for (const pattern of patterns) {
      const channel = `${this.prefix}:${pattern}`;
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
    this.emitStatus(RedisStatus.DISCONNECTED);
    for (const channel of this.subscribedChannels.splice(0)) {
      await this.subClient.unsubscribe?.(channel);
    }
  }

  private async onMessage(
    pattern: string,
    channel: string,
    rawMessage: string,
  ): Promise<void> {
    const envelope = tryDecodePayload(rawMessage);
    if (!envelope) return;
    const ctx = new RedisContext([channel], pattern, { channel });

    if (envelope.type === "event") {
      await this.dispatchEvent(pattern, envelope.data, ctx);
      return;
    }

    if (envelope.type === "request") {
      const outcome = await this.dispatchMessage(pattern, envelope.data, ctx);
      const replyChannel =
        envelope.replyTo ?? `${this.prefix}:${pattern}.reply`;
      const unwrappedResponse =
        outcome.response instanceof RedisRecord
          ? outcome.response.data
          : outcome.response;
      const response: RpcResponseEnvelope = {
        type: "response",
        id: envelope.id,
        response: unwrappedResponse,
        error: outcome.error,
        isDisposed: true,
      };
      await this.pubClient.publish(replyChannel, JSON.stringify(response));
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
  private replySubscribed = false;
  private replySubscribePromise: Promise<void> | undefined;
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

  constructor(options: RedisTransportOptions) {
    super(options.defaultTimeoutMs ?? 5000);
    const resolved = resolveRedisTransportClients(options);
    this.pubClient = resolved.pubClient;
    this.subClient = resolved.subClient;
    this.prefix = options.channelPrefix ?? "bunest:rpc";
    this.clientId = options.clientId ?? crypto.randomUUID();
    this.replyChannel = `${this.prefix}:reply:${this.clientId}`;
  }

  async connect(): Promise<void> {
    await this.ensureReplyInbox();
    this.emitStatus("connected");
  }

  async close(): Promise<void> {
    this.closeGeneration++;
    this.replySubscribePromise = undefined;
    for (const [id, p] of this.pending.entries()) {
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(new Error("RedisClientProxy closed."));
    }
    this.emitStatus("disconnected");
    if (this.replySubscribed) {
      this.replySubscribed = false;
      await this.subClient.unsubscribe?.(this.replyChannel);
    }
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
        const envelope = tryDecodePayload(raw);
        if (!envelope || envelope.type !== "response") return;
        const entry = this.pending.get(envelope.id);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.pending.delete(envelope.id);
        if (envelope.error) {
          try {
            throwFromResponseError(envelope.error);
          } catch (err) {
            entry.reject(err);
          }
        } else {
          entry.resolve(envelope.response);
        }
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

  protected override async sendOnce<TRes = any, TReq = any>(
    pattern: string,
    data: TReq,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<TRes> {
    if (signal?.aborted) {
      throw new RpcTimeoutException(pattern, timeoutMs);
    }
    const gen = this.closeGeneration;
    await this.ensureReplyInbox();
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
    const req: RpcRequestEnvelope & { headers?: Record<string, string> } = {
      type: "request",
      id,
      pattern,
      data: unwrappedData,
      replyTo: this.replyChannel,
      ...(headers !== undefined ? { headers } : {}),
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

      Promise.resolve(
        this.pubClient.publish(
          `${this.prefix}:${pattern}`,
          JSON.stringify(req),
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
  ): Promise<void> {
    const unwrappedData = data instanceof RedisRecord ? data.data : data;
    const headers =
      data instanceof RedisRecord ? data.options?.headers : undefined;
    const envelope: RpcEventEnvelope & { headers?: Record<string, string> } = {
      type: "event",
      pattern,
      data: unwrappedData,
      ...(headers !== undefined ? { headers } : {}),
    };
    await this.pubClient.publish(
      `${this.prefix}:${pattern}`,
      JSON.stringify(envelope),
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
  private readonly subscriptions: NatsSubscriptionLike[] = [];

  constructor(options: NatsTransportOptions) {
    super();
    this.client = options.client;
    this.prefix = options.subjectPrefix ? `${options.subjectPrefix}.` : "";
  }

  async listen(
    callback?: (...optionalParams: unknown[]) => any,
  ): Promise<void> {
    if (this.listening) {
      callback?.();
      return;
    }

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
    this.emitStatus(NatsStatus.DISCONNECTED);
    for (const sub of this.subscriptions.splice(0)) {
      await sub.unsubscribe?.();
    }
  }

  private async onMessage(
    pattern: string,
    msg: NatsMessageLike,
  ): Promise<void> {
    const envelope = tryDecodePayload(msg.data);
    if (!envelope) return;

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
        ((envelope.type === "request" &&
          this.messageHandlers.has(concretePattern)) ||
          (envelope.type === "event" &&
            this.eventHandlers.has(concretePattern)))
      ) {
        return;
      }
    }

    const ctx = new NatsContext([msg.subject, msg.headers], pattern, {
      subject: msg.subject,
      reply: msg.reply,
    });

    if (envelope.type === "event") {
      await this.dispatchEvent(pattern, envelope.data, ctx);
      return;
    }

    if (envelope.type === "request") {
      const outcome = await this.dispatchMessage(pattern, envelope.data, ctx);
      if (!msg.reply) {
        return;
      }
      const isNatsRecord = outcome.response instanceof NatsRecord;
      const unwrappedResponse = isNatsRecord
        ? (outcome.response as NatsRecord).data
        : outcome.response;
      const responseHeaders = isNatsRecord
        ? (outcome.response as NatsRecord).headers
        : undefined;
      const replyPayload = JSON.stringify({
        type: "response",
        id: envelope.id,
        response: unwrappedResponse,
        error: outcome.error,
        isDisposed: true,
      } satisfies RpcResponseEnvelope);

      if (typeof msg.respond === "function") {
        if (responseHeaders !== undefined) {
          await msg.respond(replyPayload, { headers: responseHeaders });
        } else {
          await msg.respond(replyPayload);
        }
      } else if (msg.reply) {
        if (responseHeaders !== undefined) {
          await this.client.publish(msg.reply, replyPayload, {
            headers: responseHeaders,
          });
        } else {
          await this.client.publish(msg.reply, replyPayload);
        }
      }
    }
  }
}

export class NatsClientProxy extends ClientProxy {
  public readonly transport = Transport.NATS;

  private readonly client: NatsTransportClientLike;
  private readonly prefix: string;
  private seq = 0;
  private readonly activeFallbackCancels = new Set<(err: Error) => void>();

  constructor(options: NatsTransportOptions) {
    super(options.defaultTimeoutMs ?? 5000);
    this.client = options.client;
    this.prefix = options.subjectPrefix ? `${options.subjectPrefix}.` : "";
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
    const isRecord = data instanceof NatsRecord;
    const unwrappedData = isRecord ? data.data : data;
    const recordHeaders = isRecord ? data.headers : undefined;

    const id = `nats_${++this.seq}_${crypto.randomUUID().slice(0, 8)}`;
    const subject = `${this.prefix}${pattern}`;
    const payload = JSON.stringify({
      type: "request",
      id,
      pattern,
      data: unwrappedData,
    } satisfies RpcRequestEnvelope);

    if (typeof this.client.request === "function") {
      const requestOpts =
        recordHeaders !== undefined
          ? { timeout: timeoutMs, headers: recordHeaders }
          : { timeout: timeoutMs };
      const replyMsg = await this.client.request(subject, payload, requestOpts);
      const response = tryDecodePayload(replyMsg.data);
      if (!response || response.type !== "response") {
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
          const response = tryDecodePayload(msg.data);
          if (
            !response ||
            response.type !== "response" ||
            response.id !== id ||
            settled
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
  ): Promise<void> {
    const isRecord = data instanceof NatsRecord;
    const unwrappedData = isRecord ? data.data : data;
    const recordHeaders = isRecord ? data.headers : undefined;
    const subject = `${this.prefix}${pattern}`;
    const payload = JSON.stringify({
      type: "event",
      pattern,
      data: unwrappedData,
    } satisfies RpcEventEnvelope);
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
  private consumerTag?: string;
  private listenGeneration = 0;

  constructor(options: RabbitMqTransportOptions) {
    super();
    this.channel = options.channel;
    this.queue = options.queue;
    this.noAck = options.noAck ?? false;
    this.wildcards = options.wildcards ?? false;
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
    if (!msg || msg.content === undefined || msg.content === null) {
      return;
    }
    const envelope = tryDecodePayload(msg.content);
    if (!envelope) {
      if (!this.noAck) {
        this.channel.nack?.(msg, false, false);
      }
      return;
    }
    const pattern = envelope.type === "response" ? "" : envelope.pattern;
    const metadata: Record<string, unknown> = {
      queue: this.queue,
      correlationId: msg.properties?.correlationId,
      replyTo: msg.properties?.replyTo,
    };
    if (msg.properties?.headers !== undefined) {
      metadata.headers = msg.properties.headers;
    }
    const ctx = new RmqContext(
      [msg as Record<string, any>, this.channel, pattern],
      metadata,
    );

    try {
      if (envelope.type === "event") {
        const matchedKeys = this.resolveEventPatternKeys(envelope.pattern);
        if (matchedKeys.length === 0) {
          if (!this.noAck) {
            this.channel.nack?.(msg, false, false);
          }
          return;
        }
        for (const key of matchedKeys) {
          await this.dispatchEvent(key, envelope.data, ctx);
        }
        if (!this.noAck) {
          this.channel.ack?.(msg);
        }
        return;
      }

      if (envelope.type === "request") {
        const matchedKey = this.resolveMessagePatternKey(envelope.pattern);
        const dispatchKey = matchedKey ?? envelope.pattern;
        const outcome = await this.dispatchMessage(
          dispatchKey,
          envelope.data,
          ctx,
        );
        const replyTo = msg.properties?.replyTo;
        if (replyTo) {
          const isRecord = outcome.response instanceof RmqRecord;
          const unwrappedResponse = isRecord
            ? (outcome.response as RmqRecord).data
            : outcome.response;
          const recordOpts = isRecord
            ? (outcome.response as RmqRecord).options
            : undefined;
          const correlationId = msg.properties?.correlationId ?? envelope.id;
          const response: RpcResponseEnvelope = {
            type: "response",
            id: correlationId,
            response: unwrappedResponse,
            error: outcome.error,
            isDisposed: true,
          };
          await this.channel.sendToQueue(replyTo, JSON.stringify(response), {
            ...(recordOpts ?? {}),
            correlationId: response.id,
          });
        }
        if (!this.noAck) {
          if (!matchedKey) {
            this.channel.nack?.(msg, false, false);
          } else {
            this.channel.ack?.(msg);
          }
        }
        return;
      }

      if (!this.noAck) {
        this.channel.ack?.(msg);
      }
    } catch {
      if (!this.noAck) {
        this.channel.nack?.(msg, false, false);
      }
    }
  }
}

export class RabbitMqClientProxy extends ClientProxy {
  public readonly transport = Transport.RABBITMQ;

  private readonly channel: RabbitMqChannelLike;
  private readonly queue: string;
  private readonly replyQueue: string;
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
    super(options.defaultTimeoutMs ?? 5000);
    this.channel = options.channel;
    this.queue = options.queue;
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
    for (const [id, p] of this.pending.entries()) {
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(new Error("RabbitMqClientProxy closed."));
    }
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
    const req: RpcRequestEnvelope = {
      type: "request",
      id,
      pattern,
      data: unwrappedData,
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
          this.channel.sendToQueue(this.queue, JSON.stringify(req), {
            ...(recordOpts ?? {}),
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
  ): Promise<void> {
    await this.channel.assertQueue(this.queue);
    const isRecord = data instanceof RmqRecord;
    const unwrappedData = isRecord ? data.data : data;
    const recordOpts = isRecord ? data.options : undefined;
    const envelope: RpcEventEnvelope = {
      type: "event",
      pattern,
      data: unwrappedData,
    };
    if (recordOpts !== undefined) {
      await this.channel.sendToQueue(
        this.queue,
        JSON.stringify(envelope),
        recordOpts as Record<string, unknown>,
      );
    } else {
      await this.channel.sendToQueue(this.queue, JSON.stringify(envelope));
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
        (msg) => {
          if (!msg || msg.content === undefined || msg.content === null) {
            return;
          }
          const envelope = tryDecodePayload(msg.content);
          if (!envelope || envelope.type !== "response") return;
          const id = msg.properties?.correlationId ?? envelope.id;
          const entry = this.pending.get(id);
          if (!entry) return;
          clearTimeout(entry.timer);
          this.pending.delete(id);
          if (envelope.error) {
            try {
              throwFromResponseError(envelope.error);
            } catch (err) {
              entry.reject(err);
            }
          } else {
            entry.resolve(envelope.response);
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
