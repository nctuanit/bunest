/**
 * Canonical gRPC status codes (0..16) per the gRPC specification.
 */
export enum GrpcStatus {
  OK = 0,
  CANCELLED = 1,
  UNKNOWN = 2,
  INVALID_ARGUMENT = 3,
  DEADLINE_EXCEEDED = 4,
  NOT_FOUND = 5,
  ALREADY_EXISTS = 6,
  PERMISSION_DENIED = 7,
  RESOURCE_EXHAUSTED = 8,
  FAILED_PRECONDITION = 9,
  ABORTED = 10,
  OUT_OF_RANGE = 11,
  UNIMPLEMENTED = 12,
  INTERNAL = 13,
  UNAVAILABLE = 14,
  DATA_LOSS = 15,
  UNAUTHENTICATED = 16,
}

/**
 * gRPC streaming mode metadata values (matches `@nestjs/microservices`).
 */
export enum GrpcMethodStreamingType {
  NO_STREAMING = "no_stream",
  RX_STREAMING = "rx_stream",
  PT_STREAMING = "pt_stream",
}

/**
 * Standard Spring/NestJS Kafka header keys (34 canonical constants).
 */
export enum KafkaHeaders {
  ACKNOWLEDGMENT = "kafka_acknowledgment",
  BATCH_CONVERTED_HEADERS = "kafka_batchConvertedHeaders",
  CONSUMER = "kafka_consumer",
  CORRELATION_ID = "kafka_correlationId",
  DELIVERY_ATTEMPT = "kafka_deliveryAttempt",
  DLT_EXCEPTION_FQCN = "kafka_dlt-exception-fqcn",
  DLT_EXCEPTION_MESSAGE = "kafka_dlt-exception-message",
  DLT_EXCEPTION_STACKTRACE = "kafka_dlt-exception-stacktrace",
  DLT_ORIGINAL_OFFSET = "kafka_dlt-original-offset",
  DLT_ORIGINAL_PARTITION = "kafka_dlt-original-partition",
  DLT_ORIGINAL_TIMESTAMP = "kafka_dlt-original-timestamp",
  DLT_ORIGINAL_TIMESTAMP_TYPE = "kafka_dlt-original-timestamp-type",
  DLT_ORIGINAL_TOPIC = "kafka_dlt-original-topic",
  GROUP_ID = "kafka_groupId",
  MESSAGE_KEY = "kafka_messageKey",
  NATIVE_HEADERS = "kafka_nativeHeaders",
  OFFSET = "kafka_offset",
  PARTITION_ID = "kafka_partitionId",
  PREFIX = "kafka_",
  RAW_DATA = "kafka_data",
  RECEIVED = "kafka_received",
  RECEIVED_MESSAGE_KEY = "kafka_receivedMessageKey",
  RECEIVED_PARTITION_ID = "kafka_receivedPartitionId",
  RECEIVED_TIMESTAMP = "kafka_receivedTimestamp",
  RECEIVED_TOPIC = "kafka_receivedTopic",
  RECORD_METADATA = "kafka_recordMetadata",
  REPLY_PARTITION = "kafka_replyPartition",
  REPLY_TOPIC = "kafka_replyTopic",
  TIMESTAMP = "kafka_timestamp",
  TIMESTAMP_TYPE = "kafka_timestampType",
  TOPIC = "kafka_topic",
  // Framework specific headers
  NEST_ERR = "kafka_nest-err",
  NEST_IS_DISPOSED = "kafka_nest-is-disposed",
  NEST_NO_RESPONSE = "kafka_nest-no-response",
}

// ---------------------------------------------------------------------------
// Transport Status Enums
// ---------------------------------------------------------------------------

export enum TcpStatus {
  DISCONNECTED = "disconnected",
  CONNECTED = "connected",
}

export enum RedisStatus {
  DISCONNECTED = "disconnected",
  RECONNECTING = "reconnecting",
  CONNECTED = "connected",
}

export enum NatsStatus {
  DISCONNECTED = "disconnected",
  RECONNECTING = "reconnecting",
  CONNECTED = "connected",
}

export enum RmqStatus {
  DISCONNECTED = "disconnected",
  CONNECTED = "connected",
  BLOCKED = "blocked",
  UNBLOCKED = "unblocked",
}

export enum MqttStatus {
  DISCONNECTED = "disconnected",
  RECONNECTING = "reconnecting",
  CONNECTED = "connected",
  CLOSED = "closed",
}

export enum KafkaStatus {
  DISCONNECTED = "disconnected",
  CONNECTED = "connected",
  CRASHED = "crashed",
  STOPPED = "stopped",
  REBALANCING = "rebalancing",
}

// ---------------------------------------------------------------------------
// Transport Event Maps
// ---------------------------------------------------------------------------

type VoidCallback = () => void;
type OnErrorCallback = (error: Error) => void;
type OnPacketCallback = (packet: any) => void;
type OnLookupCallback = (
  err: Error,
  address: string,
  family: string,
  host: string,
) => void;
type RedisVoidCallback = (client: "pub" | "sub") => void;
type RedisOnErrorCallback = (client: "pub" | "sub", error: Error) => void;
type RedisOnWarningCallback = (client: "pub" | "sub", warning: any) => void;
type NatsDefaultCallback = (data?: string | number) => any;
type RmqOnBlockedCallback = (arg: { reason: string }) => void;

export type ServersChangedEvent = {
  added: string[];
  deleted: string[];
};

export type TcpEvents = {
  error: OnErrorCallback;
  connect: VoidCallback;
  end: VoidCallback;
  close: VoidCallback;
  timeout: VoidCallback;
  drain: VoidCallback;
  lookup: OnLookupCallback;
};

export type RedisEvents = {
  connect: RedisVoidCallback;
  ready: RedisVoidCallback;
  error: RedisOnErrorCallback;
  close: RedisVoidCallback;
  reconnecting: RedisVoidCallback;
  end: RedisVoidCallback;
  warning: RedisOnWarningCallback;
};

export type NatsEvents = {
  disconnect: NatsDefaultCallback;
  reconnect: NatsDefaultCallback;
  update: (data?: string | number | ServersChangedEvent) => any;
};

export type RmqEvents = {
  error: OnErrorCallback;
  disconnect: VoidCallback;
  connect: VoidCallback;
  blocked: RmqOnBlockedCallback;
  unblocked: VoidCallback;
};

export type MqttEvents = {
  connect: OnPacketCallback;
  reconnect: VoidCallback;
  disconnect: OnPacketCallback;
  close: VoidCallback;
  offline: VoidCallback;
  end: VoidCallback;
  error: OnErrorCallback;
  packetreceive: OnPacketCallback;
  packetsend: OnPacketCallback;
};
