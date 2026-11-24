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
import { MicroserviceTransportServer } from "../server";
import { Transport } from "../tokens";

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
      this.subscribedChannels.push(channel);
      await this.subClient.subscribe(channel, (rawMessage) => {
        void this.onMessage(pattern, channel, rawMessage);
      });
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
      const response: RpcResponseEnvelope = {
        type: "response",
        id: envelope.id,
        response: outcome.response,
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
  }

  async close(): Promise<void> {
    for (const [id, p] of this.pending.entries()) {
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(new Error("RedisClientProxy closed."));
    }
    if (this.replySubscribed) {
      this.replySubscribed = false;
      this.replySubscribePromise = undefined;
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
    this.replySubscribePromise = Promise.resolve(
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
      .then(() => {
        this.replySubscribed = true;
      })
      .catch((err) => {
        this.replySubscribePromise = undefined;
        throw err;
      });

    await this.replySubscribePromise;
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
    await this.ensureReplyInbox();
    if (signal?.aborted) {
      throw new RpcTimeoutException(pattern, timeoutMs);
    }

    const id = `redis_${++this.seq}_${crypto.randomUUID().slice(0, 8)}`;
    const req: RpcRequestEnvelope = {
      type: "request",
      id,
      pattern,
      data,
      replyTo: this.replyChannel,
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
    const envelope: RpcEventEnvelope = {
      type: "event",
      pattern,
      data,
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
      const replyPayload = JSON.stringify({
        type: "response",
        id: envelope.id,
        response: outcome.response,
        error: outcome.error,
        isDisposed: true,
      } satisfies RpcResponseEnvelope);

      if (typeof msg.respond === "function") {
        await msg.respond(replyPayload);
      } else if (msg.reply) {
        await this.client.publish(msg.reply, replyPayload);
      }
    }
  }
}

export class NatsClientProxy extends ClientProxy {
  public readonly transport = Transport.NATS;

  private readonly client: NatsTransportClientLike;
  private readonly prefix: string;
  private seq = 0;

  constructor(options: NatsTransportOptions) {
    super(options.defaultTimeoutMs ?? 5000);
    this.client = options.client;
    this.prefix = options.subjectPrefix ? `${options.subjectPrefix}.` : "";
  }

  async connect(): Promise<void> {}

  async close(): Promise<void> {}

  protected override async sendOnce<TRes = any, TReq = any>(
    pattern: string,
    data: TReq,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<TRes> {
    if (signal?.aborted) {
      throw new RpcTimeoutException(pattern, timeoutMs);
    }
    const id = `nats_${++this.seq}_${crypto.randomUUID().slice(0, 8)}`;
    const subject = `${this.prefix}${pattern}`;
    const payload = JSON.stringify({
      type: "request",
      id,
      pattern,
      data,
    } satisfies RpcRequestEnvelope);

    if (typeof this.client.request === "function") {
      const replyMsg = await this.client.request(subject, payload, {
        timeout: timeoutMs,
      });
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
      const onAbort = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          void sub?.unsubscribe?.();
          reject(new RpcTimeoutException(pattern, timeoutMs));
        }
      };
      const cleanup = () => {
        signal?.removeEventListener("abort", onAbort);
      };
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          cleanup();
          void sub?.unsubscribe?.();
          reject(new RpcTimeoutException(pattern, timeoutMs));
        }
      }, timeoutMs);
      if (typeof (timer as { unref?: () => void }).unref === "function") {
        (timer as { unref: () => void }).unref();
      }
      signal?.addEventListener("abort", onAbort, { once: true });

      Promise.resolve(
        this.client.subscribe(inbox, async (msg) => {
          const response = tryDecodePayload(msg.data);
          if (!response || response.type !== "response" || settled) {
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
          return this.client.publish(subject, payload, { reply: inbox });
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
    const subject = `${this.prefix}${pattern}`;
    const payload = JSON.stringify({
      type: "event",
      pattern,
      data,
    } satisfies RpcEventEnvelope);
    await this.client.publish(subject, payload);
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
  private consumerTag?: string;

  constructor(options: RabbitMqTransportOptions) {
    super();
    this.channel = options.channel;
    this.queue = options.queue;
    this.noAck = options.noAck ?? false;
  }

  async listen(
    callback?: (...optionalParams: unknown[]) => any,
  ): Promise<void> {
    if (this.listening) {
      callback?.();
      return;
    }

    await this.channel.assertQueue(this.queue);
    const res = await this.channel.consume(
      this.queue,
      async (msg) => {
        await this.onMessage(msg);
      },
      { noAck: this.noAck },
    );
    this.consumerTag = res?.consumerTag;
    this.listening = true;
    this.emitStatus(RmqStatus.CONNECTED);
    callback?.();
  }

  async close(): Promise<void> {
    this.listening = false;
    this.emitStatus(RmqStatus.DISCONNECTED);
    if (this.consumerTag && typeof this.channel.cancel === "function") {
      await this.channel.cancel(this.consumerTag);
      this.consumerTag = undefined;
    }
  }

  private async onMessage(msg: RabbitMqMessageLike): Promise<void> {
    const envelope = tryDecodePayload(msg.content);
    if (!envelope) {
      if (!this.noAck) {
        this.channel.nack?.(msg, false, false);
      }
      return;
    }
    const pattern = envelope.type === "response" ? "" : envelope.pattern;
    const ctx = new RmqContext(
      [msg as Record<string, any>, this.channel, pattern],
      {
        queue: this.queue,
        correlationId: msg.properties?.correlationId,
        replyTo: msg.properties?.replyTo,
      },
    );

    try {
      if (envelope.type === "event") {
        await this.dispatchEvent(envelope.pattern, envelope.data, ctx);
      } else if (envelope.type === "request") {
        const outcome = await this.dispatchMessage(
          envelope.pattern,
          envelope.data,
          ctx,
        );
        const replyTo = msg.properties?.replyTo;
        if (replyTo) {
          const response: RpcResponseEnvelope = {
            type: "response",
            id: msg.properties?.correlationId ?? envelope.id,
            response: outcome.response,
            error: outcome.error,
            isDisposed: true,
          };
          await this.channel.sendToQueue(replyTo, JSON.stringify(response), {
            correlationId: response.id,
          });
        }
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
  private replyConsumerTag?: string;
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

  async connect(): Promise<void> {
    await this.ensureReplyConsumer();
  }

  async close(): Promise<void> {
    for (const [id, p] of this.pending.entries()) {
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(new Error("RabbitMqClientProxy closed."));
    }
    if (this.replyConsumerTag && typeof this.channel.cancel === "function") {
      await this.channel.cancel(this.replyConsumerTag);
      this.replyConsumerTag = undefined;
    }
    this.replyInitialized = false;
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
    await this.ensureReplyConsumer();
    if (signal?.aborted) {
      throw new RpcTimeoutException(pattern, timeoutMs);
    }

    const id = `rmq_${++this.seq}_${crypto.randomUUID().slice(0, 8)}`;
    const req: RpcRequestEnvelope = {
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
        this.channel.sendToQueue(this.queue, JSON.stringify(req), {
          correlationId: id,
          replyTo: this.replyQueue,
        }),
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
    await this.channel.assertQueue(this.queue);
    const envelope: RpcEventEnvelope = {
      type: "event",
      pattern,
      data,
    };
    await this.channel.sendToQueue(this.queue, JSON.stringify(envelope));
  }

  private async ensureReplyConsumer(): Promise<void> {
    if (this.replyInitialized) return;
    this.replyInitialized = true;
    await this.channel.assertQueue(this.queue);
    await this.channel.assertQueue(this.replyQueue, { exclusive: true });
    const res = await this.channel.consume(
      this.replyQueue,
      (msg) => {
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
    this.replyConsumerTag = res?.consumerTag;
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
