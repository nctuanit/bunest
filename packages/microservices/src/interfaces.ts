import type {
  InjectionToken,
  PipeLike,
  StandardSchemaV1,
  Type,
} from "@bunest/core";
import type { SerializedRpcError } from "./exceptions";
import type { KafkaParserConfig } from "./helpers";
import type { Deserializer, Serializer } from "./packets";
import type { Transport } from "./tokens";

export type PatternInput = string | number | RegExp | Record<string, unknown>;

function canonicalizeValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalizeValue);
  }
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = canonicalizeValue((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

/**
 * Normalizes a string, number, RegExp, or structured object pattern into a deterministic lookup key.
 * Object keys are canonically sorted so `{ cmd: "sum", v: 1 }` and `{ v: 1, cmd: "sum" }` match.
 */
const PATTERN_MAX_DEPTH = 6;
const PATTERN_MAX_KEYS = 20;
const PATTERN_MAX_TOTAL_KEYS = 100;
const PATTERN_MAX_KEY_LENGTH = 256;
const PATTERN_MAX_VALUE_LENGTH = 4096;

function serializePatternValue(
  value: unknown,
  depth: number,
  state: { totalKeys: number; exceededTotalKeys: boolean },
): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value === "string") {
    if (value.length > PATTERN_MAX_VALUE_LENGTH) {
      return "[VALUE_TOO_LONG]";
    }
    return JSON.stringify(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (depth >= PATTERN_MAX_DEPTH) {
      return "[MAX_DEPTH_REACHED]";
    }
    if (value.length > PATTERN_MAX_KEYS) {
      return "[TOO_MANY_KEYS]";
    }
    const items = value.map((item) =>
      serializePatternValue(item, depth + 1, state),
    );
    return `[${items.join(",")}]`;
  }
  if (typeof value === "object") {
    if (depth >= PATTERN_MAX_DEPTH) {
      return "[MAX_DEPTH_REACHED]";
    }
    const keys = Object.keys(value as Record<string, unknown>).sort();
    if (keys.length > PATTERN_MAX_KEYS) {
      return "[TOO_MANY_KEYS]";
    }
    state.totalKeys += keys.length;
    if (state.totalKeys > PATTERN_MAX_TOTAL_KEYS) {
      state.exceededTotalKeys = true;
      return "[TOO_MANY_KEYS]";
    }
    for (let i = 0; i < keys.length; i++) {
      if (keys[i]!.length > PATTERN_MAX_KEY_LENGTH) {
        return "[KEY_TOO_LONG]";
      }
    }
    const record = value as Record<string, unknown>;
    const entries: string[] = [];
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]!;
      const serializedVal = serializePatternValue(record[key], depth + 1, state);
      if (state.exceededTotalKeys) {
        return "[TOO_MANY_KEYS]";
      }
      entries.push(`${JSON.stringify(key)}:${serializedVal}`);
    }
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

export function exceedsPatternLimits(pattern: unknown): boolean {
  if (
    pattern === null ||
    pattern === undefined ||
    typeof pattern !== "object" ||
    pattern instanceof RegExp
  ) {
    return false;
  }
  const state = { totalKeys: 0, exceededTotalKeys: false };
  const serialized = serializePatternValue(pattern, 0, state);
  return (
    state.exceededTotalKeys ||
    serialized.includes("[MAX_DEPTH_REACHED]") ||
    serialized.includes("[TOO_MANY_KEYS]") ||
    serialized.includes("[KEY_TOO_LONG]") ||
    serialized.includes("[VALUE_TOO_LONG]")
  );
}

export function normalizePattern(pattern: PatternInput): string {
  if (typeof pattern === "string") {
    return pattern;
  }
  if (typeof pattern === "number") {
    return String(pattern);
  }
  if (pattern instanceof RegExp) {
    return pattern.toString();
  }
  if (pattern === null || typeof pattern !== "object") {
    return pattern as unknown as string;
  }
  const state = { totalKeys: 0, exceededTotalKeys: false };
  const serialized = serializePatternValue(pattern, 0, state);
  return state.exceededTotalKeys ? "[TOO_MANY_KEYS]" : serialized;
}

export interface RpcRequestEnvelope {
  readonly type: "request";
  readonly id: string;
  readonly pattern: string;
  readonly data: unknown;
  readonly replyTo?: string;
}

export interface RpcResponseEnvelope {
  readonly type: "response";
  readonly id: string;
  readonly response?: unknown;
  readonly error?: SerializedRpcError;
  readonly isDisposed?: boolean;
}

export interface RpcEventEnvelope {
  readonly type: "event";
  readonly pattern: string;
  readonly data: unknown;
}

export type RpcEnvelope =
  RpcRequestEnvelope | RpcResponseEnvelope | RpcEventEnvelope;

export interface RpcContext {
  readonly transport: Transport;
  readonly pattern: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface MessageHandler<
  TInput = any,
  TContext = RpcContext,
  TResult = any,
> {
  (data: TInput, ctx: TContext): Promise<TResult> | TResult;
  next?: (data: TInput, ctx: TContext) => Promise<TResult> | TResult;
  isEventHandler?: boolean;
  extras?: Record<string, any>;
}

export interface SendOptions {
  /**
   * Per-attempt timeout in milliseconds.
   * @default 5000
   */
  readonly timeoutMs?: number;

  /**
   * Number of retry attempts after transient transport/timeout errors.
   * Application `RpcException` errors are NOT retried.
   * @default 0
   */
  readonly retries?: number;

  /**
   * Delay in milliseconds between retry attempts.
   * @default 50
   */
  readonly retryDelayMs?: number;
}

export interface PatternHandlerMetadata {
  readonly methodName: string | symbol;
  readonly pattern: PatternInput;
  readonly normalizedPattern: string;
  readonly isEventHandler: boolean;
  readonly transport?: Transport | symbol;
  readonly extras?: Readonly<Record<string, unknown>>;
}

export type RpcParamKind = "payload" | "ctx";

export interface RpcParamMetadata {
  readonly index: number;
  readonly kind: RpcParamKind;
  readonly property?: string;
  readonly pipes?: readonly PipeLike[];
  readonly schema?: StandardSchemaV1;
}

export type TransportId = Transport | symbol;

/**
 * Contract for custom microservice transport strategies (matching NestJS `CustomTransportStrategy`).
 */
export interface CustomTransportStrategy {
  readonly transportId?: TransportId | string;
  listen(callback?: (...optionalParams: unknown[]) => any): any;
  close(): any;
  unwrap?<T>(): T;
}

export interface CustomStrategy {
  strategy: CustomTransportStrategy;
  options?: Record<string, any>;
}

export interface TcpTransportOptions {
  readonly host?: string;
  readonly port?: number;
  readonly maxFrameBytes?: number;
  readonly connectTimeoutMs?: number;
  readonly defaultTimeoutMs?: number;
  readonly autoReconnect?: boolean;
  readonly retryAttempts?: number;
  readonly retryDelay?: number;
  readonly serializer?: Serializer;
  readonly deserializer?: Deserializer;
  readonly tlsOptions?: Record<string, unknown>;
  readonly socketClass?: Type<any>;
  readonly maxBufferSize?: number;
  readonly incompleteMessageTimeout?: number;
  readonly messageReceiveTimeout?: number;
  readonly maxSendBufferSize?: number;
  readonly drainTimeout?: number;
  readonly maxConcurrentMessages?: number;
  readonly gracefulShutdown?: boolean;
  readonly gracePeriod?: number;
}

export interface RedisTransportClientLike {
  publish(
    channel: string,
    message: string,
  ): Promise<number | void> | number | void;
  subscribe(
    channel: string,
    listener: (message: string, channel: string) => void,
  ): Promise<void> | void;
  unsubscribe?(channel: string): Promise<void> | void;
  quit?(): Promise<unknown>;
  close?(): Promise<void> | void;
}

export interface RedisTransportOptions {
  readonly pubClient?: RedisTransportClientLike;
  readonly subClient?: RedisTransportClientLike;
  /** Native Bun `Bun.RedisClient` URL (e.g. `"redis://localhost:6379"`). Used automatically when `pubClient` is omitted. */
  readonly url?: string;
  readonly channelPrefix?: string;
  readonly clientId?: string;
  readonly defaultTimeoutMs?: number;
  readonly host?: string;
  readonly port?: number;
  readonly retryAttempts?: number;
  readonly retryDelay?: number;
  readonly wildcards?: boolean;
  readonly maxWildcardChannelLength?: number;
  readonly gracefulShutdown?: boolean;
  readonly gracePeriod?: number;
  readonly serializer?: Serializer;
  readonly deserializer?: Deserializer;
}

export interface NatsMessageLike {
  readonly subject: string;
  readonly data: string | Uint8Array;
  readonly reply?: string;
  readonly headers?: unknown;
  respond?(data: string | Uint8Array): Promise<void> | void;
}

export interface NatsSubscriptionLike {
  unsubscribe?(): Promise<void> | void;
}

export interface NatsTransportClientLike {
  publish(
    subject: string,
    data: string | Uint8Array,
    options?: { reply?: string },
  ): Promise<void> | void;
  subscribe(
    subject: string,
    handler: (msg: NatsMessageLike) => Promise<void> | void,
  ): Promise<NatsSubscriptionLike | void> | NatsSubscriptionLike | void;
  request?(
    subject: string,
    data: string | Uint8Array,
    options?: { timeout?: number },
  ): Promise<NatsMessageLike>;
  drain?(): Promise<void>;
  close?(): Promise<void> | void;
}

export interface NatsTransportOptions {
  readonly client: NatsTransportClientLike;
  readonly subjectPrefix?: string;
  readonly defaultTimeoutMs?: number;
  readonly servers?: string[] | string;
  readonly queue?: string;
  readonly headers?: Record<string, string>;
  readonly serializer?: Serializer;
  readonly deserializer?: Deserializer;
  readonly gracefulShutdown?: boolean;
  readonly gracePeriod?: number;
}

export interface RabbitMqMessageLike {
  readonly content: Uint8Array | string;
  readonly properties?: {
    readonly correlationId?: string;
    readonly replyTo?: string;
    readonly headers?: Record<string, unknown>;
  };
  readonly fields?: Record<string, unknown>;
}

export interface RabbitMqChannelLike {
  assertQueue(
    queue: string,
    options?: Record<string, unknown>,
  ): Promise<{ queue: string }> | { queue: string };
  consume(
    queue: string,
    onMessage: (msg: RabbitMqMessageLike) => Promise<void> | void,
    options?: Record<string, unknown>,
  ): Promise<{ consumerTag?: string } | void> | { consumerTag?: string } | void;
  sendToQueue(
    queue: string,
    content: Uint8Array | string,
    options?: {
      correlationId?: string;
      replyTo?: string;
      persistent?: boolean;
      headers?: Record<string, unknown>;
    },
  ): Promise<boolean | void> | boolean | void;
  ack?(msg: RabbitMqMessageLike): void;
  nack?(msg: RabbitMqMessageLike, allUpTo?: boolean, requeue?: boolean): void;
  cancel?(consumerTag: string): Promise<void> | void;
  close?(): Promise<void> | void;
}

export interface RabbitMqTransportOptions {
  readonly channel: RabbitMqChannelLike;
  readonly queue: string;
  readonly replyQueue?: string;
  readonly noAck?: boolean;
  readonly defaultTimeoutMs?: number;
  readonly urls?: Array<string | Record<string, unknown>>;
  readonly prefetchCount?: number;
  readonly isGlobalPrefetchCount?: boolean;
  readonly queueOptions?: Record<string, unknown>;
  readonly socketOptions?: Record<string, unknown>;
  readonly consumerTag?: string;
  readonly serializer?: Serializer;
  readonly deserializer?: Deserializer;
  readonly persistent?: boolean;
  readonly headers?: Record<string, string>;
  readonly noAssert?: boolean;
  readonly exchange?: string;
  readonly exchangeType?:
    "direct" | "fanout" | "topic" | "headers" | (string & {});
  readonly exchangeArguments?: Record<string, string>;
  readonly routingKey?: string;
  readonly wildcards?: boolean;
  readonly maxMessageSize?: number;
  readonly maxConnectionAttempts?: number;
  readonly gracefulShutdown?: boolean;
  readonly gracePeriod?: number;
}

export interface InMemoryTransportOptions {
  readonly channel?: string;
  readonly broker?: unknown;
  readonly defaultTimeoutMs?: number;
}

export interface GrpcCodec {
  readonly contentType: string;
  encode(value: unknown, methodPath?: string): Uint8Array;
  decode<T = unknown>(bytes: Uint8Array, methodPath?: string): T;
}

export interface GrpcMetadataLike {
  toHeaders(): Record<string, string>;
}

export interface GrpcMethodMetadata {
  readonly methodName: string | symbol;
  readonly service: string;
  readonly method: string;
  readonly streaming: boolean;
}

export interface GrpcTransportOptions {
  readonly url?: string;
  readonly host?: string;
  readonly port?: number;
  readonly package?: string | readonly string[];
  readonly codec?: GrpcCodec;
  readonly maxMessageBytes?: number;
  readonly defaultTimeoutMs?: number;
  readonly metadata?: GrpcMetadataLike | Readonly<Record<string, string>>;
  readonly maxSendMessageLength?: number;
  readonly maxReceiveMessageLength?: number;
  readonly maxMetadataSize?: number;
  readonly keepalive?: {
    readonly keepaliveTimeMs?: number;
    readonly keepaliveTimeoutMs?: number;
    readonly keepalivePermitWithoutCalls?: number;
    readonly http2MaxPingsWithoutData?: number;
    readonly http2MinTimeBetweenPingsMs?: number;
    readonly http2MinPingIntervalWithoutDataMs?: number;
    readonly http2MaxPingStrikes?: number;
  };
  readonly channelOptions?: Record<string, unknown>;
  readonly credentials?: unknown;
  readonly protoPath?: string | string[];
  readonly protoLoader?: string;
  readonly packageDefinition?: unknown;
  readonly gracefulShutdown?: boolean;
  readonly maxPendingResponses?: number;
  readonly onLoadPackageDefinition?: (pkg: any, server: any) => void;
  readonly loader?: Record<string, unknown>;
}

export type KafkaHeaderValue =
  | string
  | Buffer
  | Uint8Array
  | ReadonlyArray<string | Buffer | Uint8Array>
  | undefined;

/**
 * Record map of Kafka message headers (renamed from `KafkaHeaders` to avoid
 * shadowing the NestJS runtime `KafkaHeaders` enum).
 */
export type KafkaHeaderMap = Record<string, KafkaHeaderValue>;
export type KafkaHeadersRecord = KafkaHeaderMap;

export interface KafkaMessageLike {
  readonly key?: string | Buffer | Uint8Array | null;
  readonly value: string | Buffer | Uint8Array | null;
  readonly headers?: KafkaHeaderMap;
  readonly offset?: string;
  readonly timestamp?: string;
}

export interface KafkaEachMessagePayload {
  readonly topic: string;
  readonly partition: number;
  readonly message: KafkaMessageLike;
  readonly heartbeat?: () => Promise<void>;
  readonly pause?: () => () => void;
}

export interface KafkaProducerRecord {
  readonly topic: string;
  readonly messages: ReadonlyArray<{
    readonly key?: string | Buffer | Uint8Array | null;
    readonly value: string | Buffer | Uint8Array | null;
    readonly partition?: number;
    readonly headers?: KafkaHeaderMap;
  }>;
}

export interface KafkaProducerLike {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(record: KafkaProducerRecord): Promise<unknown>;
}

export interface KafkaConsumerLike {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  subscribe(subscription: {
    readonly topic?: string | RegExp;
    readonly topics?: ReadonlyArray<string | RegExp>;
    readonly fromBeginning?: boolean;
  }): Promise<void>;
  run(config: {
    readonly eachMessage: (payload: KafkaEachMessagePayload) => Promise<void>;
    readonly autoCommit?: boolean;
  }): Promise<void>;
  commitOffsets?(
    topicPartitions: ReadonlyArray<{
      readonly topic: string;
      readonly partition: number;
      readonly offset: string;
      readonly metadata?: string | null;
    }>,
  ): Promise<void>;
  stop?(): Promise<void>;
}

export interface KafkaClientLike {
  producer(config?: Record<string, unknown>): KafkaProducerLike;
  consumer(config: {
    readonly groupId: string;
    readonly [key: string]: unknown;
  }): KafkaConsumerLike;
}

export interface KafkaTransportOptions {
  readonly client?: KafkaClientLike;
  readonly producer?: KafkaProducerLike;
  readonly consumer?: KafkaConsumerLike;
  readonly groupId?: string;
  readonly fromBeginning?: boolean;
  readonly autoCommit?: boolean;
  readonly replyTopicSuffix?: string;
  readonly defaultTimeoutMs?: number;
  readonly postfixId?: string;
  readonly run?: Record<string, unknown>;
  readonly subscribe?: Record<string, unknown>;
  readonly send?: Record<string, unknown>;
  readonly serializer?: Serializer;
  readonly deserializer?: Deserializer;
  readonly parser?: KafkaParserConfig;
  readonly producerOnlyMode?: boolean;
}

export type MqttQoS = 0 | 1 | 2;

export interface MqttPacketLike {
  readonly cmd?: string;
  readonly topic: string;
  readonly payload: Uint8Array | Buffer | string;
  readonly qos?: MqttQoS;
  readonly retain?: boolean;
  readonly dup?: boolean;
  readonly messageId?: number;
  readonly properties?: Readonly<Record<string, unknown>>;
}

export interface MqttPublishOptions {
  readonly qos?: MqttQoS;
  readonly retain?: boolean;
  readonly dup?: boolean;
  readonly properties?: Readonly<Record<string, unknown>>;
}

export interface MqttSubscribeOptions {
  readonly qos?: MqttQoS;
}

export type MqttMessageListener = (
  topic: string,
  payload: Uint8Array | Buffer | string,
  packet?: MqttPacketLike,
) => void;

export interface MqttClientLike {
  publish(
    topic: string,
    message: string | Uint8Array,
    options?: MqttPublishOptions,
  ): Promise<void> | void;
  subscribe(
    topic: string | readonly string[],
    options?: MqttSubscribeOptions,
  ): Promise<void> | void;
  unsubscribe?(topic: string | readonly string[]): Promise<void> | void;
  on(event: "message", listener: MqttMessageListener): unknown;
  off?(event: "message", listener: MqttMessageListener): unknown;
  removeListener?(event: "message", listener: MqttMessageListener): unknown;
  end?(force?: boolean): Promise<void> | void;
  close?(): Promise<void> | void;
}

export interface MqttTransportOptions {
  readonly client: MqttClientLike;
  readonly qos?: MqttQoS;
  readonly retain?: boolean;
  readonly clientId?: string;
  readonly defaultTimeoutMs?: number;
  readonly closeClientOnClose?: boolean;
  readonly url?: string;
  readonly serializer?: Serializer;
  readonly deserializer?: Deserializer;
  readonly subscribeOptions?: Record<string, unknown>;
  readonly userProperties?: Record<string, string | string[]>;
  readonly maxConnectionAttempts?: number;
  readonly gracefulShutdown?: boolean;
  readonly gracePeriod?: number;
}

// ---------------------------------------------------------------------------
// NestJS Microservice Configuration & Client Option Interfaces
// ---------------------------------------------------------------------------

export interface GrpcOptions {
  transport?: Transport.GRPC;
  options: GrpcTransportOptions & { [key: string]: unknown };
}

export interface TcpOptions {
  transport?: Transport.TCP;
  options?: TcpTransportOptions;
}

export interface TcpClientOptions {
  transport: Transport.TCP;
  options?: TcpTransportOptions;
}

export interface RedisOptions {
  transport?: Transport.REDIS;
  options?: Partial<RedisTransportOptions> & { [key: string]: unknown };
}

export interface NatsOptions {
  transport?: Transport.NATS;
  options?: Partial<NatsTransportOptions> & { [key: string]: unknown };
}

export interface MqttOptions {
  transport?: Transport.MQTT;
  options?: Partial<MqttTransportOptions> & { [key: string]: unknown };
}

export interface RmqOptions {
  transport?: Transport.RMQ | Transport.RABBITMQ;
  options?: Partial<RabbitMqTransportOptions> & { [key: string]: unknown };
}

export interface KafkaOptions {
  transport?: Transport.KAFKA;
  options?: Partial<KafkaTransportOptions> & { [key: string]: unknown };
}

export interface InMemoryOptions {
  transport: Transport.IN_MEMORY;
  options?: InMemoryTransportOptions;
}

export type MicroserviceOptions =
  | GrpcOptions
  | TcpOptions
  | RedisOptions
  | NatsOptions
  | MqttOptions
  | RmqOptions
  | KafkaOptions
  | CustomStrategy
  | InMemoryOptions;

export type AsyncOptions<T extends object> = {
  inject: InjectionToken[];
  useFactory: (...args: any[]) => T | Promise<T>;
};

export type AsyncMicroserviceOptions = {
  inject: InjectionToken[];
  useFactory: (
    ...args: any[]
  ) => MicroserviceOptions | Promise<MicroserviceOptions>;
};

export interface ClientGrpc {
  getService<T extends object>(name: string): T;
  getClientByServiceName<T = any>(name: string): T;
}

export type ClientOptions =
  | RedisOptions
  | NatsOptions
  | MqttOptions
  | GrpcOptions
  | KafkaOptions
  | TcpClientOptions
  | RmqOptions
  | InMemoryOptions;

export type TransportConfig =
  | {
      readonly transport: Transport.TCP;
      readonly options?: TcpTransportOptions;
    }
  | {
      readonly transport: Transport.IN_MEMORY;
      readonly options?: InMemoryTransportOptions;
    }
  | {
      readonly transport: Transport.REDIS;
      readonly options: RedisTransportOptions;
    }
  | {
      readonly transport: Transport.NATS;
      readonly options: NatsTransportOptions;
    }
  | {
      readonly transport: Transport.RABBITMQ | Transport.RMQ;
      readonly options: RabbitMqTransportOptions;
    }
  | {
      readonly transport: Transport.GRPC;
      readonly options?: GrpcTransportOptions;
    }
  | {
      readonly transport: Transport.KAFKA;
      readonly options: KafkaTransportOptions;
    }
  | {
      readonly transport: Transport.MQTT;
      readonly options: MqttTransportOptions;
    };
