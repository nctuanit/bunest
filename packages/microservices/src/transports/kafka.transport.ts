import { ClientProxy } from "../client-proxy";
import { BaseRpcContext } from "../ctx-host";
import { KafkaHeaders, KafkaStatus } from "../enums";
import {
  KafkaRetriableException,
  RpcException,
  RpcTimeoutException,
} from "../exceptions";
import {
  normalizePattern,
  type KafkaClientLike,
  type KafkaConsumerLike,
  type KafkaEachMessagePayload,
  type KafkaHeaderMap,
  type KafkaHeaderValue,
  type KafkaMessageLike,
  type KafkaProducerLike,
  type KafkaTransportOptions,
  type MessageHandler,
  type PatternInput,
  type RpcContext,
  type RpcResponseEnvelope,
  type SendOptions,
} from "../interfaces";
import { toPacketMetadata, type PacketMetadata } from "../packets";
import { MicroserviceTransportServer } from "../server";
import { Transport } from "../tokens";

export const KAFKA_CORRELATION_ID_HEADER = KafkaHeaders.CORRELATION_ID;
export const KAFKA_REPLY_TOPIC_HEADER = KafkaHeaders.REPLY_TOPIC;
export const KAFKA_REPLY_PARTITION_HEADER = KafkaHeaders.REPLY_PARTITION;

function toUtf8String(
  value: string | Buffer | Uint8Array | null | undefined,
): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    return value;
  }
  return Buffer.from(value).toString("utf8");
}

function normalizeKafkaHeaderValue(
  value: KafkaHeaderValue,
): string | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    const first = value[0];
    return first !== undefined ? (toUtf8String(first) ?? undefined) : undefined;
  }
  return toUtf8String(value as string | Buffer | Uint8Array) ?? undefined;
}

function normalizeKafkaHeaders(
  headers?: KafkaHeaderMap,
): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  for (const [k, v] of Object.entries(headers)) {
    const normalized = normalizeKafkaHeaderValue(v);
    if (normalized !== undefined) {
      out[k] = normalized;
    }
  }
  return out;
}

function serializeKafkaJson(value: unknown): string {
  return JSON.stringify(value === undefined ? null : value);
}

function decodeKafkaValue(
  raw: string | Buffer | Uint8Array | null | undefined,
): unknown {
  const str = toUtf8String(raw);
  if (str === null) {
    return null;
  }
  try {
    return JSON.parse(str);
  } catch {
    return str;
  }
}

function throwFromResponseError(
  error: NonNullable<RpcResponseEnvelope["error"]>,
): never {
  if (error.isRpcException) {
    throw RpcException.fromSerialized(error);
  }
  const err = new Error(error.message || "Remote Kafka RPC error");
  if (error.name) err.name = error.name;
  throw err;
}

export type KafkaContextArgs = [
  KafkaMessageLike,
  number,
  string,
  KafkaConsumerLike | undefined,
  (() => Promise<void>) | undefined,
  KafkaProducerLike | undefined,
  PacketMetadata?,
];

export interface KafkaContextParams {
  readonly pattern: string;
  readonly topic: string;
  readonly partition: number;
  readonly offset: string;
  readonly key: string | null;
  readonly headers: Readonly<Record<string, string>>;
  readonly rawHeaders: Readonly<KafkaHeaderMap>;
  readonly rawMessage: KafkaMessageLike;
  readonly heartbeat?: () => Promise<void>;
  readonly commitOffset: () => Promise<void>;
  readonly consumer?: KafkaConsumerLike;
  readonly producer?: KafkaProducerLike;
  readonly packetMetadata?: PacketMetadata;
}

/**
 * Execution context passed to `@Ctx()` in Kafka microservice handlers.
 * Supports both Bunest structured params and NestJS tuple `args` construction.
 */
export class KafkaContext
  extends BaseRpcContext<KafkaContextArgs>
  implements RpcContext
{
  public readonly transport = Transport.KAFKA;
  public readonly pattern: string;
  public readonly topic: string;
  public readonly partition: number;
  public readonly offset: string;
  public readonly key: string | null;
  public readonly headers: Readonly<Record<string, string>>;
  public readonly rawHeaders: Readonly<KafkaHeaderMap>;
  public readonly rawMessage: KafkaMessageLike;
  public readonly metadata: Readonly<Record<string, unknown>>;

  private readonly consumerRef?: KafkaConsumerLike;
  private readonly producerRef?: KafkaProducerLike;
  private readonly heartbeatFn?: () => Promise<void>;
  private readonly commitOffsetFn: () => Promise<void>;
  private readonly packetMetadata?: PacketMetadata;

  constructor(paramsOrArgs: KafkaContextParams | KafkaContextArgs) {
    if (Array.isArray(paramsOrArgs)) {
      const [
        rawMessage,
        partition,
        topic,
        consumer,
        heartbeat,
        producer,
        packetMetadata,
      ] = paramsOrArgs;
      const rawHeaders = rawMessage?.headers ?? {};
      const headers = normalizeKafkaHeaders(rawHeaders);
      const key = toUtf8String(rawMessage?.key);
      const offset = rawMessage?.offset ?? "0";
      const resolvedMeta =
        packetMetadata ?? toPacketMetadata(Object.entries(headers));

      super([
        rawMessage,
        partition,
        topic,
        consumer,
        heartbeat,
        producer,
        resolvedMeta,
      ]);

      this.pattern = topic;
      this.topic = topic;
      this.partition = partition;
      this.offset = offset;
      this.key = key;
      this.headers = headers;
      this.rawHeaders = rawHeaders;
      this.rawMessage = rawMessage;
      this.consumerRef = consumer;
      this.producerRef = producer;
      this.heartbeatFn = heartbeat;
      this.packetMetadata = resolvedMeta;
      this.commitOffsetFn = async () => {
        if (typeof consumer?.commitOffsets === "function") {
          let nextOffset = offset;
          try {
            nextOffset = (BigInt(offset) + 1n).toString();
          } catch {
            nextOffset = offset;
          }
          await consumer.commitOffsets([
            { topic, partition, offset: nextOffset },
          ]);
        }
      };
      this.metadata = {
        topic,
        partition,
        offset,
        key,
        headers,
      };
      return;
    }

    const params = paramsOrArgs;
    const resolvedMeta =
      params.packetMetadata ?? toPacketMetadata(Object.entries(params.headers));
    super([
      params.rawMessage,
      params.partition,
      params.topic,
      params.consumer,
      params.heartbeat,
      params.producer,
      resolvedMeta,
    ]);

    this.pattern = params.pattern;
    this.topic = params.topic;
    this.partition = params.partition;
    this.offset = params.offset;
    this.key = params.key;
    this.headers = params.headers;
    this.rawHeaders = params.rawHeaders;
    this.rawMessage = params.rawMessage;
    this.consumerRef = params.consumer;
    this.producerRef = params.producer;
    this.heartbeatFn = params.heartbeat;
    this.commitOffsetFn = params.commitOffset;
    this.packetMetadata = resolvedMeta;
    this.metadata = {
      topic: params.topic,
      partition: params.partition,
      offset: params.offset,
      key: params.key,
      headers: params.headers,
    };
  }

  getTopic(): string {
    return this.topic;
  }

  getPartition(): number {
    return this.partition;
  }

  getOffset(): string {
    return this.offset;
  }

  getKey(): string | null {
    return this.key;
  }

  getHeaders(): Readonly<Record<string, string>> {
    return this.headers;
  }

  getMessage(): KafkaMessageLike {
    return this.rawMessage;
  }

  getConsumer(): KafkaConsumerLike | undefined {
    return this.consumerRef;
  }

  getProducer(): KafkaProducerLike | undefined {
    return this.producerRef;
  }

  getHeartbeat(): (() => Promise<void>) | undefined {
    return this.heartbeatFn;
  }

  getMetadata(): PacketMetadata | undefined {
    return this.packetMetadata;
  }

  async heartbeat(): Promise<void> {
    if (typeof this.heartbeatFn === "function") {
      await this.heartbeatFn();
    }
  }

  async commitOffset(): Promise<void> {
    await this.commitOffsetFn();
  }
}

interface RegexKafkaHandler {
  readonly regex: RegExp;
  readonly rawPattern: RegExp;
  readonly key: string;
  readonly handler: MessageHandler;
}

/**
 * First-class Kafka microservice server compatible with KafkaJS and
 * node-rdkafka-style `KafkaClientLike` adapters.
 *
 * Supports consumer groups, exact & `RegExp` topic pattern matching,
 * request-reply correlation via `kafka_replyTopic` + `kafka_correlationId`
 * headers, fire-and-forget events, `KafkaContext`, and graceful disconnect.
 */
export class KafkaServer extends MicroserviceTransportServer {
  public readonly transport = Transport.KAFKA;
  public override readonly propagatesEventHandlerErrors = true;

  private readonly client?: KafkaClientLike;
  private producer?: KafkaProducerLike;
  private consumer?: KafkaConsumerLike;
  private readonly consumers = new Map<string, KafkaConsumerLike>();
  private readonly warnedGroupIds = new Set<string>();
  private readonly groupId: string;
  private readonly fromBeginning: boolean;
  private readonly autoCommit: boolean;
  private readonly topicConsumers: boolean;

  private readonly regexMessageHandlers: RegexKafkaHandler[] = [];
  private readonly regexEventHandlers: RegexKafkaHandler[] = [];

  constructor(options: KafkaTransportOptions = {}) {
    super();
    this.configureServerOptions(options);
    this.client = options.client;
    this.producer = options.producer;
    this.consumer = options.consumer;
    this.groupId = options.groupId ?? "bunest-kafka-server";
    this.fromBeginning = options.fromBeginning ?? false;
    this.autoCommit = options.autoCommit ?? true;
    this.topicConsumers = options.topicConsumers ?? false;
  }

  override get server(): KafkaConsumerLike | KafkaClientLike | undefined {
    return this.consumer ?? this.client;
  }

  override addMessageHandler(
    pattern: PatternInput,
    handler: MessageHandler,
  ): void {
    super.addMessageHandler(pattern, handler);
    if (pattern instanceof RegExp) {
      const safeRegex = new RegExp(
        pattern.source,
        pattern.flags.replace(/[gy]/g, ""),
      );
      this.regexMessageHandlers.push({
        regex: safeRegex,
        rawPattern: pattern,
        key: pattern.toString(),
        handler,
      });
    }
  }

  override addEventHandler(
    pattern: PatternInput,
    handler: MessageHandler,
  ): void {
    super.addEventHandler(pattern, handler);
    if (pattern instanceof RegExp) {
      const safeRegex = new RegExp(
        pattern.source,
        pattern.flags.replace(/[gy]/g, ""),
      );
      this.regexEventHandlers.push({
        regex: safeRegex,
        rawPattern: pattern,
        key: pattern.toString(),
        handler,
      });
    }
  }

  async listen(
    callback?: (...optionalParams: unknown[]) => any,
  ): Promise<void> {
    if (this.listening) {
      callback?.();
      return;
    }

    if (!this.producer && this.client) {
      this.producer = this.client.producer();
    }

    // Collect distinct string topics and RegExp topics to subscribe
    const stringTopics = new Set<string>();
    const regexKeySet = new Set<string>();
    const regexTopics: RegExp[] = [];

    for (const entry of [
      ...this.regexMessageHandlers,
      ...this.regexEventHandlers,
    ]) {
      if (!regexKeySet.has(entry.key)) {
        regexKeySet.add(entry.key);
        regexTopics.push(entry.regex);
      }
    }

    for (const pattern of [
      ...this.messageHandlers.keys(),
      ...this.eventHandlers.keys(),
    ]) {
      if (!regexKeySet.has(pattern)) {
        stringTopics.add(pattern);
      }
    }

    if (this.topicConsumers) {
      if (!this.client) {
        throw new Error(
          "KafkaServer with `topicConsumers: true` requires `options.client`.",
        );
      }
      if (this.producer) {
        await this.producer.connect();
      }

      const allTopics: Array<string | RegExp> = [
        ...stringTopics,
        ...regexTopics,
      ];
      for (const topic of allTopics) {
        const topicKey = String(topic);
        const composedGroupId = `${this.groupId}-${topicKey}`;
        if (
          (/\s/.test(composedGroupId) || composedGroupId.length > 255) &&
          !this.warnedGroupIds.has(composedGroupId)
        ) {
          this.warnedGroupIds.add(composedGroupId);
          this.logger.warn(
            `KafkaServer topicConsumers composed groupId "${composedGroupId}" contains whitespace or exceeds 255 characters.`,
          );
        }
        const topicConsumer = this.client.consumer({
          groupId: composedGroupId,
        });
        this.consumers.set(topicKey, topicConsumer);
        await topicConsumer.connect();
        await topicConsumer.subscribe({
          topic,
          fromBeginning: this.fromBeginning,
        });
        await topicConsumer.run({
          autoCommit: this.autoCommit,
          eachMessage: async (payload) => {
            await this.handleMessage(payload, topicConsumer);
          },
        });
      }
    } else {
      if (!this.consumer) {
        if (!this.client) {
          throw new Error(
            "KafkaServer requires either `options.consumer` or `options.client`.",
          );
        }
        this.consumer = this.client.consumer({ groupId: this.groupId });
      }

      await this.consumer.connect();
      if (this.producer) {
        await this.producer.connect();
      }

      for (const topic of stringTopics) {
        await this.consumer.subscribe({
          topic,
          fromBeginning: this.fromBeginning,
        });
      }
      for (const regex of regexTopics) {
        await this.consumer.subscribe({
          topic: regex,
          fromBeginning: this.fromBeginning,
        });
      }

      await this.consumer.run({
        autoCommit: this.autoCommit,
        eachMessage: async (payload) => {
          await this.handleMessage(payload, this.consumer);
        },
      });
    }

    this.listening = true;
    this.emitStatus(KafkaStatus.CONNECTED);
    callback?.();
  }

  async close(): Promise<void> {
    this.listening = false;
    this.emitStatus(KafkaStatus.DISCONNECTED);
    try {
      if (this.consumers.size > 0) {
        const activeConsumers = [...this.consumers.values()];
        this.consumers.clear();
        await Promise.all(
          activeConsumers.map(async (c) => {
            await c.stop?.();
            await c.disconnect();
          }),
        );
      } else if (this.consumer) {
        await this.consumer.stop?.();
        await this.consumer.disconnect();
      }
    } finally {
      if (this.producer) {
        await this.producer.disconnect();
      }
    }
  }

  private findMessageHandler(
    topic: string,
  ): { pattern: string; handler: MessageHandler } | undefined {
    const exact = this.messageHandlers.get(topic);
    if (exact) {
      return { pattern: topic, handler: exact };
    }
    for (const entry of this.regexMessageHandlers) {
      entry.regex.lastIndex = 0;
      if (entry.regex.test(topic)) {
        return { pattern: entry.key, handler: entry.handler };
      }
    }
    return undefined;
  }

  private findEventHandlers(
    topic: string,
  ): Array<{ pattern: string; handler: MessageHandler }> {
    const matches: Array<{ pattern: string; handler: MessageHandler }> = [];
    const exactList = this.eventHandlers.get(topic);
    if (exactList) {
      for (const handler of exactList) {
        matches.push({ pattern: topic, handler });
      }
    }
    for (const entry of this.regexEventHandlers) {
      entry.regex.lastIndex = 0;
      if (entry.regex.test(topic)) {
        matches.push({ pattern: entry.key, handler: entry.handler });
      }
    }
    return matches;
  }

  private async handleMessage(
    payload: KafkaEachMessagePayload,
    activeConsumer: KafkaConsumerLike | undefined = this.consumer,
  ): Promise<void> {
    const { topic, partition, message, heartbeat } = payload;
    const rawHeaders = message.headers ?? {};
    const headers = normalizeKafkaHeaders(rawHeaders);
    const key = toUtf8String(message.key);
    const offset = message.offset ?? "0";
    const data = decodeKafkaValue(message.value);

    const correlationId = headers[KAFKA_CORRELATION_ID_HEADER];
    const replyTopic = headers[KAFKA_REPLY_TOPIC_HEADER];
    const replyPartitionRaw = headers[KAFKA_REPLY_PARTITION_HEADER];
    const replyPartition =
      replyPartitionRaw !== undefined && replyPartitionRaw !== ""
        ? Number(replyPartitionRaw)
        : undefined;

    const commitOffset = async () => {
      if (typeof activeConsumer?.commitOffsets === "function") {
        let nextOffset = offset;
        try {
          nextOffset = (BigInt(offset) + 1n).toString();
        } catch {
          nextOffset = offset;
        }
        await activeConsumer.commitOffsets([
          { topic, partition, offset: nextOffset },
        ]);
      }
    };

    if (replyTopic && correlationId) {
      const matched = this.findMessageHandler(topic);
      const ctx = new KafkaContext({
        pattern: matched?.pattern ?? topic,
        topic,
        partition,
        offset,
        key,
        headers,
        rawHeaders,
        rawMessage: message,
        heartbeat,
        commitOffset,
        consumer: activeConsumer,
        producer: this.producer,
      });

      let outcome: { response?: unknown; error?: RpcResponseEnvelope["error"] };
      if (!matched) {
        outcome = {
          error: new RpcException({
            status: 404,
            message: `No Kafka @MessagePattern() handler found for topic "${topic}".`,
          }).toSerialized(),
        };
      } else {
        try {
          const response = await this.executeWithServerContext(
            "request",
            matched.pattern,
            ctx,
            () =>
              this.runWithProcessingHooks(ctx, async () => {
                if (this.preRequestHook) {
                  await this.preRequestHook({
                    pattern: matched.pattern,
                    data,
                    ctx,
                  });
                }
                return matched.handler(data, ctx);
              }),
          );
          outcome = { response };
        } catch (err) {
          if (err instanceof KafkaRetriableException) {
            throw err;
          }
          outcome = { error: this.serializeError(err) };
        }
      }

      if (this.producer) {
        const envelope: RpcResponseEnvelope = {
          type: "response",
          id: correlationId,
          response: outcome.response,
          error: outcome.error,
          isDisposed: true,
        };
        await this.producer.send({
          topic: replyTopic,
          messages: [
            {
              key: key ?? undefined,
              partition:
                replyPartition !== undefined && !Number.isNaN(replyPartition)
                  ? replyPartition
                  : undefined,
              value: JSON.stringify(envelope),
              headers: {
                [KAFKA_CORRELATION_ID_HEADER]: correlationId,
              },
            },
          ],
        });
      }
      return;
    }

    // Ignore RPC reply envelopes (type: "response" with kafka_correlationId and no kafka_replyTopic)
    // so regex event handlers matching `<topic>.reply` are never triggered by server replies.
    if (
      correlationId &&
      !replyTopic &&
      data !== null &&
      typeof data === "object" &&
      (data as { type?: unknown }).type === "response"
    ) {
      return;
    }

    const eventMatches = this.findEventHandlers(topic);
    for (const match of eventMatches) {
      const ctx = new KafkaContext({
        pattern: match.pattern,
        topic,
        partition,
        offset,
        key,
        headers,
        rawHeaders,
        rawMessage: message,
        heartbeat,
        commitOffset,
        consumer: activeConsumer,
        producer: this.producer,
      });
      try {
        await this.executeWithServerContext("event", match.pattern, ctx, () =>
          this.runWithProcessingHooks(ctx, async () =>
            match.handler(data, ctx),
          ),
        );
      } catch (err) {
        await this.invokeDeadLetterHandlerSafe(match.pattern, data, ctx, err);
        if (err instanceof KafkaRetriableException) {
          throw err;
        }
        // Fire-and-forget event errors must not tear down the Kafka consumer
      }
    }
  }
}

export interface KafkaMessageRecord<T = unknown> {
  readonly key?: string | Buffer | Uint8Array | null;
  readonly value: T;
  readonly headers?: KafkaHeaderMap;
  readonly partition?: number;
}

/**
 * First-class Kafka RPC client proxy supporting request-reply correlation via
 * `${topic}.reply` + `kafka_correlationId` & `kafka_replyTopic` headers,
 * fire-and-forget `emit()`, batch emission (`emitBatch`), explicit key/header
 * publishing, offset commits (`commitOffsets`), and clean disconnect.
 */
export class KafkaClientProxy extends ClientProxy {
  public readonly transport = Transport.KAFKA;

  private readonly client?: KafkaClientLike;
  private _producer?: KafkaProducerLike;
  private _consumer?: KafkaConsumerLike;
  private readonly groupId: string;
  private readonly fromBeginning: boolean;
  private readonly replyTopicSuffix: string;

  private producerConnected = false;
  private producerConnectPromise?: Promise<void>;
  private consumerConnected = false;
  private consumerConnectPromise?: Promise<void>;
  private consumerRunning = false;
  private consumerRunPromise?: Promise<void>;
  private readonly preRegisteredReplyTopics = new Set<string>();
  private readonly subscribedReplyTopics = new Set<string>();
  private readonly pendingReplySubscribes = new Map<string, Promise<void>>();
  private readonly consumerAssignments: Record<string, number> = {};
  private readonly pending = new Map<
    string,
    {
      resolve: (v: unknown) => void;
      reject: (e: unknown) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private seq = 0;

  constructor(options: KafkaTransportOptions = {}) {
    super(options.requestTimeout ?? options.defaultTimeoutMs ?? 5000, {
      requestTimeout: options.requestTimeout,
      maxPendingRequests: options.maxPendingRequests,
      retry: options.retry,
      circuitBreaker: options.circuitBreaker,
      clsPropagation: options.clsPropagation,
      cls: options.cls,
    });
    this.client = options.client;
    this._producer = options.producer;
    this._consumer = options.consumer;
    this.groupId =
      options.groupId ??
      `bunest-kafka-client-${crypto.randomUUID().slice(0, 8)}`;
    this.fromBeginning = options.fromBeginning ?? false;
    this.replyTopicSuffix = options.replyTopicSuffix ?? ".reply";
  }

  get consumer(): KafkaConsumerLike | null {
    return this._consumer ?? null;
  }

  get producer(): KafkaProducerLike | null {
    return this._producer ?? null;
  }

  /**
   * Pre-registers a request topic so its reply topic (`${topic}.reply`) is
   * subscribed on `connect()` (NestJS-compatible).
   */
  subscribeToResponseOf(topic: unknown): void {
    const normalized =
      typeof topic === "string"
        ? topic
        : normalizePattern(topic as PatternInput);
    this.preRegisteredReplyTopics.add(this.getReplyTopic(normalized));
  }

  getReplyTopic(topic: string): string {
    return `${topic}${this.replyTopicSuffix}`;
  }

  getConsumerAssignments(): Record<string, number> {
    return { ...this.consumerAssignments };
  }

  async commitOffsets(
    topicPartitions: ReadonlyArray<{
      readonly topic: string;
      readonly partition: number;
      readonly offset: string;
      readonly metadata?: string | null;
    }>,
  ): Promise<void> {
    if (!this._consumer) {
      throw new Error("Kafka consumer is not initialized.");
    }
    if (typeof this._consumer.commitOffsets !== "function") {
      throw new Error(
        "Configured Kafka consumer does not support commitOffsets().",
      );
    }
    await this._consumer.commitOffsets(topicPartitions);
  }

  async emitBatch<TInput = any>(
    pattern: PatternInput,
    data: { readonly messages: readonly TInput[] },
  ): Promise<void> {
    const topic = normalizePattern(pattern);
    if (this.onDispatchHook) {
      this.onDispatchHook({ pattern: topic, data });
    }
    await this.ensureProducerConnected();
    await this._producer!.send({
      topic,
      messages: data.messages.map((msg) => {
        if (
          msg &&
          typeof msg === "object" &&
          ("value" in msg || "key" in msg)
        ) {
          const rec = msg as KafkaMessageRecord<unknown>;
          return {
            key: rec.key,
            partition: rec.partition,
            headers: rec.headers,
            value: serializeKafkaJson(rec.value),
          };
        }
        return { value: serializeKafkaJson(msg) };
      }),
    });
  }

  async connect(): Promise<void> {
    await this.ensureProducerConnected();
    if (this.preRegisteredReplyTopics.size > 0) {
      await this.ensureConsumerRunning();
    }
    this.emitStatus("connected");
  }

  async close(): Promise<void> {
    this.emitStatus("disconnected");
    const closeErr = new Error("KafkaClientProxy closed.");
    for (const [id, entry] of this.pending.entries()) {
      clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.reject(closeErr);
    }
    this.cancelActiveRequests(closeErr);
    this.pendingReplySubscribes.clear();
    this.subscribedReplyTopics.clear();
    try {
      if (this._consumer && this.consumerConnected) {
        try {
          await this._consumer.stop?.();
          await this._consumer.disconnect();
        } finally {
          this.consumerConnected = false;
          this.consumerConnectPromise = undefined;
          this.consumerRunning = false;
          this.consumerRunPromise = undefined;
        }
      }
    } finally {
      if (this._producer && this.producerConnected) {
        try {
          await this._producer.disconnect();
        } finally {
          this.producerConnected = false;
          this.producerConnectPromise = undefined;
        }
      }
    }
  }

  /**
   * Sends a request-reply RPC with explicit Kafka key, partition, and custom headers,
   * supporting `options.timeoutMs`, `options.retries`, and `options.retryDelayMs`.
   */
  async sendRecord<TRes = any, TReq = any>(
    topic: string,
    record: KafkaMessageRecord<TReq>,
    options?: SendOptions,
  ): Promise<TRes> {
    return await this.trackInFlightRequest(topic, async () => {
      if (this.preRequestHook) {
        await this.preRequestHook({
          pattern: topic,
          data: record.value,
          transport: this.transport,
        });
      }
      const timeoutMs = Math.max(
        1,
        Math.floor(
          options?.timeoutMs ?? this.requestTimeout ?? this.defaultTimeoutMs,
        ),
      );
      const retries = Math.max(0, Math.floor(options?.retries ?? 0));
      const retryDelayMs = Math.max(0, Math.floor(options?.retryDelayMs ?? 50));

      let lastError: unknown;
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          return await this.sendInternal<TRes, TReq>(
            topic,
            record.value,
            timeoutMs,
            record.key,
            record.headers,
            record.partition,
          );
        } catch (err) {
          lastError = err;
          if (
            err instanceof RpcException &&
            (err as { readonly isRetryable?: boolean }).isRetryable !== true
          ) {
            throw err;
          }
          if (attempt < retries && retryDelayMs > 0) {
            await new Promise<void>((resolve) => {
              const t = setTimeout(resolve, retryDelayMs);
              if (typeof (t as { unref?: () => void }).unref === "function") {
                (t as { unref: () => void }).unref();
              }
            });
          }
        }
      }

      throw lastError;
    });
  }

  /**
   * Emits a fire-and-forget Kafka event with explicit key, partition, and headers.
   */
  async emitRecord<TReq = any>(
    topic: string,
    record: KafkaMessageRecord<TReq>,
  ): Promise<void> {
    if (this.preRequestHook) {
      await this.preRequestHook({
        pattern: topic,
        data: record.value,
        transport: this.transport,
      });
    }
    await this.ensureProducerConnected();
    let sanitizedHeaders: KafkaHeaderMap | undefined;
    if (record.headers !== undefined) {
      sanitizedHeaders = {};
      for (const [k, v] of Object.entries(record.headers)) {
        if (
          k !== KAFKA_REPLY_TOPIC_HEADER &&
          k !== KAFKA_REPLY_PARTITION_HEADER
        ) {
          sanitizedHeaders[k] = v;
        }
      }
    }
    await this._producer!.send({
      topic,
      messages: [
        {
          key: record.key,
          partition: record.partition,
          value: serializeKafkaJson(record.value),
          headers: sanitizedHeaders,
        },
      ],
    });
  }

  protected override async sendOnce<TRes = any, TReq = any>(
    pattern: string,
    data: TReq,
    timeoutMs: number,
    signal?: AbortSignal,
    metadata?: Record<string, unknown>,
  ): Promise<TRes> {
    const kafkaHeaders = metadata
      ? (toPacketMetadata(Object.entries(metadata)) as KafkaHeaderMap | undefined)
      : undefined;
    return await this.sendInternal<TRes, TReq>(
      pattern,
      data,
      timeoutMs,
      undefined,
      kafkaHeaders,
      undefined,
      signal,
    );
  }

  protected override async dispatchEvent<TReq = any>(
    pattern: string,
    data: TReq,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await this.ensureProducerConnected();
    const kafkaHeaders = metadata
      ? (toPacketMetadata(Object.entries(metadata)) as KafkaHeaderMap | undefined)
      : undefined;
    await this._producer!.send({
      topic: pattern,
      messages: [
        {
          value: serializeKafkaJson(data),
          ...(kafkaHeaders !== undefined ? { headers: kafkaHeaders } : {}),
        },
      ],
    });
  }

  private async ensureProducerConnected(): Promise<void> {
    if (this.producerConnected && this._producer) {
      return;
    }
    if (this.producerConnectPromise) {
      await this.producerConnectPromise;
      return;
    }
    if (!this._producer) {
      if (!this.client) {
        throw new Error(
          "KafkaClientProxy requires either `options.producer` or `options.client`.",
        );
      }
      this._producer = this.client.producer();
    }
    this.producerConnectPromise = this._producer
      .connect()
      .then(() => {
        this.producerConnected = true;
      })
      .finally(() => {
        this.producerConnectPromise = undefined;
      });
    await this.producerConnectPromise;
  }

  private async ensureConsumerConnected(): Promise<void> {
    if (this.consumerConnected && this._consumer) {
      return;
    }
    if (this.consumerConnectPromise) {
      await this.consumerConnectPromise;
      return;
    }
    if (!this._consumer) {
      if (!this.client) {
        throw new Error(
          "KafkaClientProxy request-reply requires either `options.consumer` or `options.client`.",
        );
      }
      this._consumer = this.client.consumer({ groupId: this.groupId });
    }
    const consumer = this._consumer;
    this.consumerConnectPromise = consumer
      .connect()
      .then(async () => {
        this.consumerConnected = true;
        for (const topic of [...this.preRegisteredReplyTopics]) {
          if (!this.subscribedReplyTopics.has(topic)) {
            await consumer.subscribe({
              topic,
              fromBeginning: this.fromBeginning,
            });
            this.subscribedReplyTopics.add(topic);
          }
        }
      })
      .finally(() => {
        this.consumerConnectPromise = undefined;
      });
    await this.consumerConnectPromise;
  }

  private async ensureReplyTopicSubscribed(replyTopic: string): Promise<void> {
    await this.ensureConsumerConnected();

    if (!this.subscribedReplyTopics.has(replyTopic)) {
      let pendingSub = this.pendingReplySubscribes.get(replyTopic);
      if (!pendingSub) {
        pendingSub = this._consumer!.subscribe({
          topic: replyTopic,
          fromBeginning: this.fromBeginning,
        })
          .then(() => {
            this.subscribedReplyTopics.add(replyTopic);
          })
          .finally(() => {
            this.pendingReplySubscribes.delete(replyTopic);
          });
        this.pendingReplySubscribes.set(replyTopic, pendingSub);
      }
      await pendingSub;
    }

    await this.ensureConsumerRunning();
  }

  private async ensureConsumerRunning(): Promise<void> {
    if (!this._consumer && !this.client) {
      return;
    }
    await this.ensureConsumerConnected();
    if (this.consumerRunning) {
      return;
    }
    if (this.consumerRunPromise) {
      await this.consumerRunPromise;
      return;
    }
    this.consumerRunPromise = this._consumer!.run({
      autoCommit: true,
      eachMessage: async (payload) => {
        this.handleReplyMessage(payload);
      },
    })
      .then(() => {
        this.consumerRunning = true;
      })
      .finally(() => {
        this.consumerRunPromise = undefined;
      });
    await this.consumerRunPromise;
  }

  private handleReplyMessage(payload: KafkaEachMessagePayload): void {
    const headers = normalizeKafkaHeaders(payload.message.headers);
    const decoded = decodeKafkaValue(payload.message.value);
    if (!decoded || typeof decoded !== "object") {
      return;
    }

    const envelope = decoded as Partial<RpcResponseEnvelope>;
    const correlationId =
      headers[KAFKA_CORRELATION_ID_HEADER] ?? envelope.id ?? "";
    if (!correlationId) {
      return;
    }

    const entry = this.pending.get(correlationId);
    if (!entry) {
      return;
    }

    clearTimeout(entry.timer);
    this.pending.delete(correlationId);

    if (envelope.error) {
      try {
        throwFromResponseError(envelope.error);
      } catch (err) {
        entry.reject(err);
      }
    } else {
      entry.resolve(envelope.response);
    }
  }

  private async sendInternal<TRes, TReq>(
    topic: string,
    data: TReq,
    timeoutMs: number,
    key?: string | Buffer | Uint8Array | null,
    extraHeaders?: KafkaHeaderMap,
    partition?: number,
    signal?: AbortSignal,
  ): Promise<TRes> {
    if (signal?.aborted) {
      throw new RpcTimeoutException(topic, timeoutMs);
    }
    await this.ensureProducerConnected();
    const replyTopic = this.getReplyTopic(topic);
    await this.ensureReplyTopicSubscribed(replyTopic);
    if (signal?.aborted) {
      throw new RpcTimeoutException(topic, timeoutMs);
    }

    const correlationId = `kafka_${++this.seq}_${crypto.randomUUID().slice(0, 8)}`;

    return await new Promise<TRes>((resolve, reject) => {
      const onAbort = () => {
        if (this.pending.delete(correlationId)) {
          clearTimeout(timer);
          reject(new RpcTimeoutException(topic, timeoutMs));
        }
      };
      const cleanup = () => {
        signal?.removeEventListener("abort", onAbort);
      };
      const timer = setTimeout(() => {
        if (this.pending.delete(correlationId)) {
          cleanup();
          reject(new RpcTimeoutException(topic, timeoutMs));
        }
      }, timeoutMs);
      if (typeof (timer as { unref?: () => void }).unref === "function") {
        (timer as { unref: () => void }).unref();
      }

      this.pending.set(correlationId, {
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
        this._producer!.send({
          topic,
          messages: [
            {
              key,
              partition,
              value: serializeKafkaJson(data),
              headers: {
                ...(extraHeaders ?? {}),
                [KAFKA_CORRELATION_ID_HEADER]: correlationId,
                [KAFKA_REPLY_TOPIC_HEADER]: replyTopic,
              },
            },
          ],
        }),
      ).catch((err) => {
        clearTimeout(timer);
        cleanup();
        this.pending.delete(correlationId);
        reject(err);
      });
    });
  }
}

export { KafkaServer as ServerKafka, KafkaClientProxy as ClientKafka };
