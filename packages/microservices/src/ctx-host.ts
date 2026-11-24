import { toPacketMetadata, type PacketMetadata } from "./packets";
import { Transport } from "./tokens";

/**
 * Base RPC context host (matches `@nestjs/microservices` `BaseRpcContext`).
 */
export class BaseRpcContext<T = unknown[]> {
  protected readonly args!: T;

  constructor(args: T) {
    Object.defineProperty(this, "args", {
      value: args,
      enumerable: false,
      writable: false,
      configurable: true,
    });
  }

  /**
   * Returns the array of arguments being passed to the handler.
   */
  getArgs(): T {
    return this.args;
  }

  /**
   * Returns a particular argument by index.
   */
  getArgByIndex<TResult = any>(index: number): TResult {
    return (this.args as unknown as unknown[])[index] as TResult;
  }
}

export type TcpContextArgs = [unknown, string, PacketMetadata?];

/**
 * RPC context host for TCP microservice handlers.
 */
export class TcpContext extends BaseRpcContext<TcpContextArgs> {
  public readonly transport = Transport.TCP;
  public readonly pattern: string;
  public readonly metadata?: Readonly<Record<string, unknown>>;

  constructor(
    args: TcpContextArgs,
    extraMetadata?: Readonly<Record<string, unknown>>,
  ) {
    super(args);
    this.pattern = args[1];
    this.metadata = extraMetadata ?? args[2];
  }

  /**
   * Returns the underlying socket reference.
   */
  getSocketRef<T = any>(): T {
    return this.args[0] as T;
  }

  /**
   * Returns the name of the pattern.
   */
  getPattern(): string {
    return this.args[1];
  }

  /**
   * Returns the metadata attached to the packet, if any.
   */
  getMetadata(): PacketMetadata | undefined {
    return this.args[2];
  }
}

export type RedisContextArgs = [string, PacketMetadata?];

/**
 * RPC context host for Redis microservice handlers.
 */
export class RedisContext extends BaseRpcContext<RedisContextArgs> {
  public readonly transport = Transport.REDIS;
  public readonly pattern: string;
  public readonly metadata?: Readonly<Record<string, unknown>>;

  constructor(
    args: RedisContextArgs,
    pattern?: string,
    extraMetadata?: Readonly<Record<string, unknown>>,
  ) {
    super(args);
    this.pattern = pattern ?? args[0];
    this.metadata = extraMetadata ?? args[1] ?? { channel: args[0] };
  }

  /**
   * Returns the name of the channel.
   */
  getChannel(): string {
    return this.args[0];
  }

  /**
   * Returns the metadata attached to the packet, if any.
   */
  getMetadata(): PacketMetadata | undefined {
    return this.args[1];
  }
}

export type NatsContextArgs = [string, unknown];

/**
 * RPC context host for NATS microservice handlers.
 */
export class NatsContext extends BaseRpcContext<NatsContextArgs> {
  public readonly transport = Transport.NATS;
  public readonly pattern: string;
  public readonly metadata?: Readonly<Record<string, unknown>>;

  constructor(
    args: NatsContextArgs,
    pattern?: string,
    extraMetadata?: Readonly<Record<string, unknown>>,
  ) {
    super(args);
    this.pattern = pattern ?? args[0];
    this.metadata = extraMetadata ?? { subject: args[0] };
  }

  /**
   * Returns the name of the subject.
   */
  getSubject(): string {
    return this.args[0];
  }

  /**
   * Returns message headers (if present).
   */
  getHeaders<T = any>(): T {
    return this.args[1] as T;
  }

  /**
   * Returns the message headers as `PacketMetadata` (single-string entries only).
   */
  getMetadata(): PacketMetadata | undefined {
    const headers = this.args[1];
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
      const keys = Array.from(iterHeaders.keys());
      return toPacketMetadata(
        keys.map((key) => {
          const values = Array.from(iterHeaders.values!(key));
          return [key, values.length === 1 ? values[0] : undefined] as const;
        }),
      );
    }
    return toPacketMetadata(Object.entries(headers as Record<string, unknown>));
  }
}

export type RmqContextArgs = [Record<string, unknown>, unknown, string];

/**
 * RPC context host for RabbitMQ (RMQ) microservice handlers.
 */
export class RmqContext extends BaseRpcContext<RmqContextArgs> {
  public readonly transport = Transport.RABBITMQ;
  public readonly pattern: string;
  public readonly metadata?: Readonly<Record<string, unknown>>;

  constructor(
    args: RmqContextArgs,
    extraMetadata?: Readonly<Record<string, unknown>>,
  ) {
    super(args);
    this.pattern = args[2];
    const props = args[0]?.properties as
      | { correlationId?: unknown; replyTo?: unknown }
      | undefined;
    this.metadata = extraMetadata ?? {
      correlationId: props?.correlationId,
      replyTo: props?.replyTo,
    };
  }

  /**
   * Returns the original message (with properties, fields, and content).
   */
  getMessage<T = Record<string, any>>(): T {
    return this.args[0] as T;
  }

  /**
   * Returns the reference to the original RMQ channel.
   */
  getChannelRef<T = any>(): T {
    return this.args[1] as T;
  }

  /**
   * Returns the name of the pattern.
   */
  getPattern(): string {
    return this.args[2];
  }

  /**
   * Returns the message's string headers as `PacketMetadata`.
   */
  getMetadata(): PacketMetadata | undefined {
    const props = this.args[0]?.properties as
      | { headers?: unknown }
      | undefined;
    const headers = props?.headers;
    if (headers && typeof headers === "object" && !Array.isArray(headers)) {
      return toPacketMetadata(
        Object.entries(headers as Record<string, unknown>),
      );
    }
    return undefined;
  }
}

/**
 * Request-scoped RPC context shape (matches `@nestjs/microservices` `RequestContext`).
 */
export interface RequestContext<
  TData = any,
  TContext extends BaseRpcContext = any,
> {
  pattern: string | Record<string, unknown>;
  data: TData;
  context?: TContext;
  getData(): TData;
  getPattern(): string | Record<string, unknown>;
  getContext(): TContext;
}
