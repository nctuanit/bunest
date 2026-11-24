import { KafkaHeaders } from "./enums";

// ---------------------------------------------------------------------------
// gRPC Package Definition Helper
// ---------------------------------------------------------------------------

export interface GrpcPackageDefinitionOptions {
  protoPath?: string | string[];
  packageDefinition?: unknown;
  loader?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Loads a gRPC package definition from `options.packageDefinition` or
 * `options.protoPath` using the provided `grpcProtoLoaderPackage`.
 */
export function getGrpcPackageDefinition(
  options: GrpcPackageDefinitionOptions | undefined,
  grpcProtoLoaderPackage: {
    loadSync(path: string | string[], loader?: Record<string, unknown>): unknown;
  },
): unknown {
  const file = options?.protoPath;
  const packageDefinition = options?.packageDefinition;
  if (file && packageDefinition) {
    throw new Error(
      'Invalid gRPC configuration: both "protoPath" and "packageDefinition" cannot be specified simultaneously.',
    );
  }
  if (!file && !packageDefinition) {
    throw new Error(
      'Invalid gRPC configuration: either "protoPath" or "packageDefinition" must be specified.',
    );
  }
  return (
    packageDefinition ||
    grpcProtoLoaderPackage.loadSync(file!, options?.loader)
  );
}

// ---------------------------------------------------------------------------
// Kafka Logger Factory (Zero external deps; uses Bun.inspect fallback)
// ---------------------------------------------------------------------------

const KAFKA_LOG_LEVEL_NOTHING = 0;
const KAFKA_LOG_LEVEL_ERROR = 1;
const KAFKA_LOG_LEVEL_WARN = 2;
const KAFKA_LOG_LEVEL_INFO = 4;

function stringifyLogEntry(entry: unknown): string {
  try {
    return JSON.stringify(entry);
  } catch {
    try {
      return typeof Bun !== "undefined" && typeof Bun.inspect === "function"
        ? Bun.inspect(entry)
        : String(entry);
    } catch {
      return "[unserializable log entry]";
    }
  }
}

/**
 * Bridges Kafka client log entries to a Bunest/NestJS `LoggerService`.
 */
export const KafkaLogger =
  (logger: Record<string, ((msg: string) => void) | undefined>) =>
  ({
    namespace,
    level,
    label,
    log,
  }: {
    namespace: unknown;
    level: unknown;
    label: unknown;
    log: unknown;
  }): void => {
    let loggerMethod: "error" | "warn" | "log" | "debug";
    switch (level) {
      case KAFKA_LOG_LEVEL_ERROR:
      case KAFKA_LOG_LEVEL_NOTHING:
        loggerMethod = "error";
        break;
      case KAFKA_LOG_LEVEL_WARN:
        loggerMethod = "warn";
        break;
      case KAFKA_LOG_LEVEL_INFO:
        loggerMethod = "log";
        break;
      default:
        loggerMethod = "debug";
        break;
    }

    const { message, ...others } = (log ?? {}) as Record<string, unknown>;
    const fn = logger?.[loggerMethod];
    if (typeof fn === "function") {
      fn.call(
        logger,
        `${label} [${namespace}] ${message ?? ""} ${stringifyLogEntry(others)}`,
      );
    }
  };

// ---------------------------------------------------------------------------
// Kafka Message Parser
// ---------------------------------------------------------------------------

const DEFAULT_KAFKA_MAX_MESSAGE_SIZE = 16 * 1024 * 1024; // 16 MiB
const TRANSPORT_HEADERS: readonly string[] = [
  KafkaHeaders.CORRELATION_ID,
  KafkaHeaders.REPLY_TOPIC,
  KafkaHeaders.REPLY_PARTITION,
];

export interface KafkaParserConfig {
  keepBinary?: boolean;
  maxMessageSize?: number;
}

/**
 * Parses Kafka messages (key, value, headers) with binary-preservation support,
 * schema-registry leading-zero-byte detection, and `maxMessageSize` DoS protection.
 */
export class KafkaParser {
  protected keepBinary: boolean;
  protected maxMessageSize: number;

  constructor(config?: KafkaParserConfig) {
    this.keepBinary = Boolean(config?.keepBinary);
    const maxMessageSize = config?.maxMessageSize;
    this.maxMessageSize =
      maxMessageSize === null ||
      maxMessageSize === undefined ||
      Number.isNaN(maxMessageSize)
        ? DEFAULT_KAFKA_MAX_MESSAGE_SIZE
        : maxMessageSize;
  }

  public parse<T = any>(data: unknown): T {
    const record =
      data !== null && typeof data === "object"
        ? (data as {
            key?: unknown;
            value?: unknown;
            headers?: Record<string, unknown> | null;
            [key: string]: unknown;
          })
        : undefined;
    const messageSize = this.getMessageSize(record);
    if (messageSize > this.maxMessageSize) {
      throw new Error(
        `Kafka message size (${messageSize} bytes) exceeds maximum allowed size (${this.maxMessageSize} bytes).`,
      );
    }

    const decodedHeaders: Record<string, unknown> = {
      ...(record?.headers ?? {}),
    };
    const result: Record<string, unknown> = {
      ...(record ?? {}),
      headers: decodedHeaders,
    };

    if (!this.keepBinary) {
      result.value = this.decode(record?.value);
    }
    if (record?.key !== null && record?.key !== undefined) {
      result.key = this.decode(record.key);
    }
    if (record?.headers !== null && record?.headers !== undefined) {
      for (const key of Object.keys(record.headers)) {
        decodedHeaders[key] = TRANSPORT_HEADERS.includes(key)
          ? this.decodeAsString(record.headers[key])
          : this.decodeHeader(record.headers[key]);
      }
    } else {
      result.headers = {};
    }

    return result as T;
  }

  public decode(value: unknown): unknown {
    if (value === null || value === undefined) {
      return null;
    }
    if (
      Buffer.isBuffer(value) &&
      value.length > 0 &&
      value.readUInt8(0) === 0
    ) {
      return value;
    }
    let result: unknown = String(value);
    const startChar = (result as string).charAt(0);
    if (startChar === "{" || startChar === "[") {
      try {
        result = JSON.parse(result as string);
      } catch {
        // Keep raw string when payload is not valid JSON
      }
    }
    return result;
  }

  public decodeAsString(value: unknown): string | null {
    return value === null || value === undefined ? null : String(value);
  }

  public decodeHeader(value: unknown): unknown {
    return Array.isArray(value)
      ? value.map((item) => this.decode(item))
      : this.decode(value);
  }

  protected getMessageSize(data: unknown): number {
    const record =
      data !== null && typeof data === "object"
        ? (data as {
            key?: { length?: number } | null;
            value?: { length?: number } | null;
            headers?: Record<string, unknown> | null;
          })
        : undefined;
    let size =
      (record?.key?.length ?? 0) +
      (this.keepBinary ? 0 : (record?.value?.length ?? 0));
    for (const [name, value] of Object.entries(record?.headers ?? {})) {
      const values = Array.isArray(value) ? value : [value];
      size += name.length;
      for (const headerValue of values) {
        size +=
          (headerValue as { length?: number } | null | undefined)?.length ?? 0;
      }
    }
    return size;
  }
}

// ---------------------------------------------------------------------------
// Kafka Reply Partition Assigner (Zero kafkajs runtime dependency)
// ---------------------------------------------------------------------------

export interface KafkaReplyPartitionAssignerCluster {
  findTopicPartitionMetadata(
    topic: string,
  ): ReadonlyArray<{ readonly partitionId: number }>;
}

export interface KafkaReplyPartitionAssignerClientLike {
  getConsumerAssignments(): Record<string, number>;
}

interface AssignerProtocolCodec {
  MemberMetadata: {
    encode(input: {
      version: number;
      topics: string[];
      userData: Buffer;
    }): Buffer;
    decode(buf: Buffer): { userData?: Buffer };
  };
  MemberAssignment: {
    encode(input: {
      version: number;
      assignment: Record<string, number[]>;
    }): Buffer;
  };
}

const defaultAssignerProtocol: AssignerProtocolCodec = {
  MemberMetadata: {
    encode: (input) =>
      Buffer.from(
        JSON.stringify({
          version: input.version,
          topics: input.topics,
          userData: input.userData.toString("utf8"),
        }),
      ),
    decode: (buf) => {
      const parsed = JSON.parse(buf.toString("utf8")) as {
        userData?: string;
      };
      return {
        userData: parsed.userData ? Buffer.from(parsed.userData) : undefined,
      };
    },
  },
  MemberAssignment: {
    encode: (input) => Buffer.from(JSON.stringify(input)),
  },
};

/**
 * Sticky reply-partition assigner preserving each consumer's minimum assigned
 * reply partition across rebalances (matches NestJS `KafkaReplyPartitionAssigner`,
 * zero external `kafkajs` runtime dependency).
 */
export class KafkaReplyPartitionAssigner {
  public readonly name = "NestReplyPartitionAssigner";
  public readonly version = 1;

  private readonly protocolCodec: AssignerProtocolCodec;

  constructor(
    private readonly clientKafka: KafkaReplyPartitionAssignerClientLike,
    private readonly config: {
      cluster: KafkaReplyPartitionAssignerCluster;
      assignerProtocol?: AssignerProtocolCodec;
    },
  ) {
    this.protocolCodec = config.assignerProtocol ?? defaultAssignerProtocol;
  }

  async assign(group: {
    members: Array<{ memberId: string; memberMetadata: Buffer }>;
    topics: string[];
  }): Promise<Array<{ memberId: string; memberAssignment: Buffer }>> {
    const assignment: Record<string, Record<string, number[]>> = {};
    const previousAssignment: Record<string, Record<string, number>> = {};
    const membersCount = group.members.length;
    const decodedMembers = group.members.map((member) =>
      this.decodeMember(member),
    );
    const sortedMemberIds = decodedMembers
      .map((member) => member.memberId)
      .sort();

    for (const member of decodedMembers) {
      if (
        !previousAssignment[member.memberId] &&
        Object.keys(member.previousAssignment).length > 0
      ) {
        previousAssignment[member.memberId] = member.previousAssignment;
      }
    }

    const topicsPartitions = group.topics.flatMap((topic) => {
      const partitionMetadata =
        this.config.cluster.findTopicPartitionMetadata(topic);
      return partitionMetadata.map((m) => ({
        topic,
        partitionId: m.partitionId,
      }));
    });

    for (const assignee of sortedMemberIds) {
      const memberMap = (assignment[assignee] ??= {});
      for (const topic of group.topics) {
        const partitions = (memberMap[topic] ??= []);
        const prev = previousAssignment[assignee]?.[topic];
        if (prev !== undefined) {
          const idx = topicsPartitions.findIndex(
            (tp) => tp.topic === topic && tp.partitionId === prev,
          );
          if (idx !== -1) {
            partitions.push(prev);
            topicsPartitions.splice(idx, 1);
          }
        }
      }
    }

    for (const assignee of sortedMemberIds) {
      const memberMap = assignment[assignee]!;
      for (const topic of group.topics) {
        const partitions = memberMap[topic]!;
        if (partitions.length === 0) {
          const idx = topicsPartitions.findIndex((tp) => tp.topic === topic);
          if (idx !== -1) {
            partitions.push(topicsPartitions[idx]!.partitionId);
            topicsPartitions.splice(idx, 1);
          }
        }
      }
    }

    topicsPartitions.forEach((tp, i) => {
      const assignee = sortedMemberIds[i % membersCount];
      if (assignee) {
        assignment[assignee]![tp.topic]!.push(tp.partitionId);
      }
    });

    return Object.keys(assignment).map((memberId) => ({
      memberId,
      memberAssignment: this.protocolCodec.MemberAssignment.encode({
        version: this.version,
        assignment: assignment[memberId]!,
      }),
    }));
  }

  protocol(subscription: { topics: string[]; userData?: Buffer }): {
    name: string;
    metadata: Buffer;
  } {
    const stringifiedUserData = JSON.stringify({
      previousAssignment: this.getPreviousAssignment(),
    });
    subscription.userData = Buffer.from(stringifiedUserData);
    return {
      name: this.name,
      metadata: this.protocolCodec.MemberMetadata.encode({
        version: this.version,
        topics: subscription.topics,
        userData: subscription.userData,
      }),
    };
  }

  getPreviousAssignment(): Record<string, number> {
    return this.clientKafka.getConsumerAssignments();
  }

  decodeMember(member: { memberId: string; memberMetadata: Buffer }): {
    memberId: string;
    previousAssignment: Record<string, number>;
  } {
    let memberMetadata: { userData?: Buffer };
    try {
      memberMetadata = this.protocolCodec.MemberMetadata.decode(
        member.memberMetadata,
      );
    } catch {
      return { memberId: member.memberId, previousAssignment: {} };
    }
    return {
      memberId: member.memberId,
      previousAssignment: this.decodePreviousAssignment(
        memberMetadata.userData,
      ),
    };
  }

  decodePreviousAssignment(userData?: Buffer): Record<string, number> {
    const rawUserData = userData?.toString();
    if (!rawUserData) {
      return {};
    }
    try {
      const parsed = JSON.parse(rawUserData) as {
        previousAssignment?: unknown;
      };
      const prev = parsed?.previousAssignment;
      return prev && typeof prev === "object" && !Array.isArray(prev)
        ? (prev as Record<string, number>)
        : {};
    } catch {
      return {};
    }
  }
}

// ---------------------------------------------------------------------------
// Bun-Native Delimiter-Framed JsonSocket (`<length>#<json>`)
// ---------------------------------------------------------------------------

const DEFAULT_MAX_BUFFER_SIZE = 16 * 1024 * 1024;
const DEFAULT_INCOMPLETE_MESSAGE_TIMEOUT = 30_000;
const DEFAULT_MESSAGE_RECEIVE_TIMEOUT = 300_000;
const DEFAULT_MAX_SEND_BUFFER_SIZE = 128 * 1024 * 1024;
const DEFAULT_DRAIN_TIMEOUT = 30_000;

export interface JsonSocketOptions {
  maxBufferSize?: number;
  incompleteMessageTimeout?: number;
  messageReceiveTimeout?: number;
  maxSendBufferSize?: number;
  drainTimeout?: number;
  pauseOnBackpressure?: boolean;
}

export interface JsonSocketStreamLike {
  on?(event: string, listener: (...args: any[]) => void): unknown;
  connect?(port: number, host?: string): unknown;
  end?(): unknown;
  write?(
    data: string,
    encoding?: string,
    callback?: (err?: unknown) => void,
  ): unknown;
  readonly writableLength?: number;
}

/**
 * Bun-native JSON-framed socket wrapper using `<length>#<json>` framing,
 * enforcing NestJS v12 `maxBufferSize`, `incompleteMessageTimeout`,
 * `messageReceiveTimeout`, `maxSendBufferSize`, and message pause/resume
 * backpressure without requiring `node:net`.
 */
export class JsonSocket {
  public isClosed = false;

  private contentLength: number | null = null;
  private buffer = "";
  private readonly delimiter = "#";
  private readonly maxBufferSize: number;
  private readonly incompleteMessageTimeout: number;
  private readonly messageReceiveTimeout: number;
  private readonly maxSendBufferSize: number;
  private readonly drainTimeout: number;
  private readonly pauseOnBackpressure: boolean;

  private isHoldingMessages = false;
  private hasFramingError = false;
  private incompleteMessageTimer: ReturnType<typeof setTimeout> | null = null;
  private messageReceiveDeadline: number | null = null;
  private readonly listeners = new Map<string, Set<Function>>();

  constructor(
    public readonly socket: JsonSocketStreamLike | null | undefined,
    options?: JsonSocketOptions,
  ) {
    this.maxBufferSize = this.resolveLimit(
      options?.maxBufferSize,
      DEFAULT_MAX_BUFFER_SIZE,
    );
    this.incompleteMessageTimeout = this.resolveLimit(
      options?.incompleteMessageTimeout,
      DEFAULT_INCOMPLETE_MESSAGE_TIMEOUT,
    );
    this.messageReceiveTimeout = this.resolveLimit(
      options?.messageReceiveTimeout,
      DEFAULT_MESSAGE_RECEIVE_TIMEOUT,
    );
    this.maxSendBufferSize = this.resolveLimit(
      options?.maxSendBufferSize,
      DEFAULT_MAX_SEND_BUFFER_SIZE,
    );
    this.drainTimeout = this.resolveLimit(
      options?.drainTimeout,
      DEFAULT_DRAIN_TIMEOUT,
    );
    this.pauseOnBackpressure = options?.pauseOnBackpressure ?? true;

    if (socket && typeof socket.on === "function") {
      socket.on("data", (chunk: Buffer | Uint8Array | string) =>
        this.handleData(chunk),
      );
      socket.on("close", () => {
        this.isClosed = true;
        this.clearIncompleteMessageTimer();
        this.emit("close");
      });
      socket.on("error", (err: unknown) => {
        this.emit("error", err);
      });
    }
  }

  private resolveLimit(value: number | undefined, fallback: number): number {
    if (value === undefined || value === null || Number.isNaN(value)) {
      return fallback;
    }
    return value;
  }

  on(event: string, callback: Function): this {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(callback);
    return this;
  }

  once(event: string, callback: Function): this {
    const wrapper = (...args: unknown[]) => {
      this.off(event, wrapper);
      callback(...args);
    };
    return this.on(event, wrapper);
  }

  off(event: string, callback: Function): this {
    this.listeners.get(event)?.delete(callback);
    return this;
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const cb of [...(this.listeners.get(event) ?? [])]) {
      cb(...args);
    }
  }

  connect(port: number, host?: string): this {
    this.socket?.connect?.(port, host);
    return this;
  }

  end(): void {
    this.isClosed = true;
    this.clearIncompleteMessageTimer();
    this.socket?.end?.();
  }

  sendMessage(message: unknown, callback?: (err?: unknown) => void): void {
    if (this.isClosed) {
      callback?.(new Error("The socket is closed."));
      return;
    }
    this.handleSend(message, callback);
  }

  pauseMessages(): void {
    this.isHoldingMessages = true;
  }

  resumeMessages(): void {
    if (!this.isHoldingMessages) {
      return;
    }
    this.isHoldingMessages = false;
    this.processBuffer();
  }

  /**
   * Feeds a raw chunk into the `<length>#<json>` framing decoder.
   */
  public feed(dataRaw: Buffer | Uint8Array | string): void {
    this.handleData(dataRaw);
  }

  protected handleSend(
    message: unknown,
    callback?: (err?: unknown) => void,
  ): void {
    const data = this.formatMessageData(message);
    if (
      this.maxSendBufferSize > 0 &&
      typeof this.socket?.writableLength === "number" &&
      this.socket.writableLength + data.length > this.maxSendBufferSize
    ) {
      const err = new Error(
        `Send buffer limit (${this.maxSendBufferSize}) exceeded.`,
      );
      callback?.(err);
      this.emit("error", err);
      return;
    }
    try {
      if (typeof this.socket?.write === "function") {
        this.socket.write(data, "utf8", callback);
      } else {
        callback?.();
      }
    } catch (err) {
      callback?.(err);
      this.emit("error", err);
    }
  }

  protected handleData(dataRaw: Buffer | Uint8Array | string): void {
    if (this.hasFramingError) {
      return;
    }
    const text =
      typeof dataRaw === "string"
        ? dataRaw
        : Buffer.from(dataRaw).toString("utf8");
    this.buffer += text;

    if (
      this.maxBufferSize > 0 &&
      this.contentLength === null &&
      this.buffer.length > this.maxBufferSize &&
      !this.buffer.includes(this.delimiter)
    ) {
      this.failFraming(
        new Error(
          `Incoming message buffer length (${this.buffer.length}) exceeds maxBufferSize (${this.maxBufferSize}).`,
        ),
      );
      return;
    }

    if (!this.isHoldingMessages) {
      this.processBuffer();
    }
  }

  private processBuffer(): void {
    while (!this.isHoldingMessages && !this.hasFramingError) {
      if (this.contentLength === null) {
        const delimIndex = this.buffer.indexOf(this.delimiter);
        if (delimIndex === -1) {
          break;
        }
        const lengthStr = this.buffer.slice(0, delimIndex);
        const parsedLen = Number(lengthStr);
        if (
          !lengthStr ||
          !Number.isInteger(parsedLen) ||
          parsedLen < 0 ||
          !/^\d+$/.test(lengthStr)
        ) {
          this.failFraming(
            new Error(`Corrupted JsonSocket length prefix "${lengthStr}".`),
          );
          return;
        }
        if (this.maxBufferSize > 0 && parsedLen > this.maxBufferSize) {
          this.failFraming(
            new Error(
              `Declared message length (${parsedLen}) exceeds maxBufferSize (${this.maxBufferSize}).`,
            ),
          );
          return;
        }
        this.contentLength = parsedLen;
        this.buffer = this.buffer.slice(delimIndex + 1);
      }

      if (this.buffer.length < this.contentLength) {
        break;
      }

      const rawJson = this.buffer.slice(0, this.contentLength);
      this.buffer = this.buffer.slice(this.contentLength);
      this.contentLength = null;
      this.messageReceiveDeadline = null;

      let parsed: unknown;
      try {
        parsed = JSON.parse(rawJson);
      } catch (err) {
        this.failFraming(err as Error);
        return;
      }
      this.emit("message", parsed);
    }

    this.refreshIncompleteMessageTimer();
  }

  private failFraming(err: Error): void {
    this.hasFramingError = true;
    this.buffer = "";
    this.contentLength = null;
    this.clearIncompleteMessageTimer();
    this.emit("error", err);
    this.end();
  }

  private refreshIncompleteMessageTimer(): void {
    this.clearIncompleteMessageTimer();
    const hasPartial = this.buffer.length > 0 || this.contentLength !== null;
    if (!hasPartial || this.isHoldingMessages) {
      this.messageReceiveDeadline = null;
      return;
    }
    if (
      this.messageReceiveTimeout > 0 &&
      this.messageReceiveDeadline === null
    ) {
      this.messageReceiveDeadline = Date.now() + this.messageReceiveTimeout;
    }
    const idleTimeout =
      this.incompleteMessageTimeout > 0
        ? this.incompleteMessageTimeout
        : Infinity;
    const remainingTime =
      this.messageReceiveDeadline === null
        ? Infinity
        : Math.max(this.messageReceiveDeadline - Date.now(), 0);
    if (idleTimeout === Infinity && remainingTime === Infinity) {
      return;
    }
    const waitMs = Math.min(idleTimeout, remainingTime);
    const isDeadlineFirst = remainingTime <= idleTimeout;
    this.incompleteMessageTimer = setTimeout(() => {
      this.failFraming(
        new Error(
          isDeadlineFirst
            ? `Message receive timeout (${this.messageReceiveTimeout}ms) exceeded.`
            : `Incomplete message timeout (${this.incompleteMessageTimeout}ms) exceeded.`,
        ),
      );
    }, waitMs);
    if (
      typeof (this.incompleteMessageTimer as { unref?: () => void }).unref ===
      "function"
    ) {
      (this.incompleteMessageTimer as { unref: () => void }).unref();
    }
  }

  private clearIncompleteMessageTimer(): void {
    if (this.incompleteMessageTimer) {
      clearTimeout(this.incompleteMessageTimer);
      this.incompleteMessageTimer = null;
    }
  }

  protected formatMessageData(message: unknown): string {
    const messageData = JSON.stringify(message);
    return `${messageData.length}${this.delimiter}${messageData}`;
  }
}
