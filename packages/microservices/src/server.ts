import {
  HttpException,
  Logger,
  type LoggerService,
  type PreRequestHook,
} from "@bunest/common";
import type { BaseRpcContext } from "./ctx-host";
import { RpcException, type SerializedRpcError } from "./exceptions";
import {
  normalizePattern,
  type CustomTransportStrategy,
  type MessageHandler,
  type PatternInput,
  type RpcContext,
  type TransportId,
} from "./interfaces";
import type { ReadPacket, WritePacket } from "./packets";
import type { Transport } from "./tokens";

export type { CustomTransportStrategy } from "./interfaces";

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    Symbol.asyncIterator in (value as Record<PropertyKey, unknown>)
  );
}

/**
 * Base class for Bunest microservice transport servers (TCP, InMemory, Redis,
 * NATS, RabbitMQ, gRPC, Kafka, MQTT). Also exported under the NestJS alias `Server`.
 */
export abstract class MicroserviceTransportServer {
  abstract readonly transport: Transport;

  /**
   * Unique transport identifier (defaults to `this.transport` unless overridden
   * via `setTransportId()`).
   */
  public transportId?: TransportId;

  /**
   * Whether event handler errors should bubble back to the transport library
   * (`true` on `KafkaServer`).
   */
  public readonly propagatesEventHandlerErrors: boolean = false;

  protected readonly logger: LoggerService = new Logger("Server");
  protected readonly messageHandlers = new Map<string, MessageHandler>();
  protected readonly eventHandlers = new Map<string, MessageHandler[]>();
  protected listening = false;
  protected currentStatus = "disconnected";
  private readonly statusListeners = new Set<(status: string) => void>();
  private readonly eventListeners = new Map<PropertyKey, Set<Function>>();
  protected preRequestHook?: PreRequestHook<{
    pattern: string;
    data: unknown;
    ctx: RpcContext;
  }>;
  protected onProcessingStartHook?: (
    transportId: TransportId,
    context: unknown,
    done: () => Promise<any>,
  ) => void | Promise<any>;
  protected onProcessingEndHook?: (
    transportId: TransportId,
    context: unknown,
  ) => void;

  get isListening(): boolean {
    return this.listening;
  }

  /**
   * Current server lifecycle status string (`"connected" | "disconnected" | ...`).
   */
  get status(): string {
    return this.currentStatus;
  }

  /**
   * Subscribes to server status changes. Returns an unsubscribe function.
   */
  onStatus(listener: (status: string) => void): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  protected emitStatus(status: string): void {
    if (this.currentStatus === status) return;
    this.currentStatus = status;
    for (const listener of [...this.statusListeners]) {
      listener(status);
    }
  }

  /**
   * Registers an event listener for a server lifecycle/transport event.
   */
  on<
    EventKey extends string | number | symbol = string,
    EventCallback extends Function = Function,
  >(event: EventKey, callback: EventCallback): this {
    let set = this.eventListeners.get(event);
    if (!set) {
      set = new Set();
      this.eventListeners.set(event, set);
    }
    set.add(callback);
    return this;
  }

  protected emitServerEvent(event: PropertyKey, ...args: unknown[]): void {
    for (const cb of [...(this.eventListeners.get(event) ?? [])]) {
      cb(...args);
    }
  }

  /**
   * Sets the unique transport identifier reported to processing hooks.
   */
  setTransportId(transportId: TransportId): void {
    this.transportId = transportId;
  }

  /**
   * Registers a NestJS v12 hook invoked when message/event processing starts.
   * The hook receives `(transportId, context, done)` and must invoke `done()`
   * to continue handler execution (allowing tracing spans / ALS wrapping).
   */
  setOnProcessingStartHook(
    hook:
      | ((
          transportId: TransportId,
          context: unknown,
          done: () => Promise<any>,
        ) => void | Promise<any>)
      | undefined,
  ): void {
    this.onProcessingStartHook = hook;
  }

  /**
   * Registers a NestJS v12 hook invoked once when message/event processing ends.
   */
  setOnProcessingEndHook(
    hook: ((transportId: TransportId, context: unknown) => void) | undefined,
  ): void {
    this.onProcessingEndHook = hook;
  }

  setPreRequestHook(
    hook:
      | PreRequestHook<{ pattern: string; data: unknown; ctx: RpcContext }>
      | undefined,
  ): this {
    this.preRequestHook = hook;
    return this;
  }

  unwrap<T = unknown>(): T {
    return this as unknown as T;
  }

  /**
   * NestJS-compatible handler registration accepting message or event handlers
   * with optional `extras` metadata.
   */
  addHandler(
    pattern: PatternInput,
    callback: MessageHandler,
    isEventHandler = false,
    extras: Record<string, any> = {},
  ): void {
    const key = normalizePattern(pattern);
    callback.isEventHandler = isEventHandler;
    callback.extras = extras;

    if (isEventHandler) {
      const existing = this.eventHandlers.get(key) ?? [];
      if (existing.length > 0) {
        const last = existing[existing.length - 1]!;
        last.next = callback;
      }
      existing.push(callback);
      this.eventHandlers.set(key, existing);
    } else {
      this.messageHandlers.set(key, callback);
    }
  }

  /**
   * Returns a map of registered handlers (message handlers plus event handlers).
   */
  getHandlers(): Map<string, MessageHandler> {
    if (this.eventHandlers.size === 0) {
      return this.messageHandlers;
    }
    const combined = new Map<string, MessageHandler>(this.messageHandlers);
    for (const [pattern, list] of this.eventHandlers.entries()) {
      if (!combined.has(pattern) && list[0]) {
        combined.set(pattern, list[0]);
      }
    }
    return combined;
  }

  /**
   * Looks up a registered handler by exact or normalized pattern string.
   */
  getHandlerByPattern(pattern: string): MessageHandler | null {
    const exactMsg = this.messageHandlers.get(pattern);
    if (exactMsg) {
      return exactMsg;
    }
    const exactEvt = this.eventHandlers.get(pattern)?.[0];
    if (exactEvt) {
      return exactEvt;
    }
    const normalized = this.normalizePatternSafe(pattern);
    return (
      this.messageHandlers.get(normalized) ??
      this.eventHandlers.get(normalized)?.[0] ??
      null
    );
  }

  private normalizePatternSafe(pattern: string): string {
    try {
      const parsed = JSON.parse(pattern) as PatternInput;
      if (parsed && typeof parsed === "object") {
        return normalizePattern(parsed);
      }
    } catch {
      // Plain string pattern
    }
    return pattern;
  }

  addMessageHandler(pattern: PatternInput, handler: MessageHandler): void {
    const key = normalizePattern(pattern);
    if (this.messageHandlers.has(key)) {
      throw new Error(
        `Duplicate @MessagePattern(${key}) handler registered on ${this.transport} server.`,
      );
    }
    handler.isEventHandler = false;
    this.messageHandlers.set(key, handler);
  }

  addEventHandler(pattern: PatternInput, handler: MessageHandler): void {
    const key = normalizePattern(pattern);
    handler.isEventHandler = true;
    const list = this.eventHandlers.get(key) ?? [];
    list.push(handler);
    this.eventHandlers.set(key, list);
  }

  getMessageHandler(pattern: PatternInput): MessageHandler | undefined {
    return this.messageHandlers.get(normalizePattern(pattern));
  }

  getEventHandlers(pattern: PatternInput): readonly MessageHandler[] {
    return this.eventHandlers.get(normalizePattern(pattern)) ?? [];
  }

  getRegisteredPatterns(): {
    readonly messagePatterns: readonly string[];
    readonly eventPatterns: readonly string[];
  } {
    return {
      messagePatterns: [...this.messageHandlers.keys()],
      eventPatterns: [...this.eventHandlers.keys()],
    };
  }

  /**
   * Promise/AsyncIterable equivalent of NestJS `Server.send(stream$, respond)`.
   */
  async send(
    streamOrResult: unknown,
    respond: (data: WritePacket) => Promise<unknown> | void,
  ): Promise<void> {
    try {
      const resolved = await streamOrResult;
      if (isAsyncIterable(resolved)) {
        for await (const value of resolved) {
          await respond({ response: value });
        }
        await respond({ isDisposed: true });
      } else {
        await respond({ response: resolved, isDisposed: true });
      }
    } catch (err) {
      await respond({ err, isDisposed: true });
    }
  }

  /**
   * Handles an incoming event packet via registered event handlers and runs
   * NestJS v12 processing start/end hooks.
   */
  async handleEvent(
    pattern: string,
    packet: ReadPacket | unknown,
    context?: RpcContext | BaseRpcContext,
    handler?: MessageHandler | null,
  ): Promise<any> {
    const data =
      packet && typeof packet === "object" && "data" in packet
        ? (packet as ReadPacket).data
        : packet;
    const ctx: RpcContext =
      context && "transport" in context
        ? context
        : {
            transport: this.transport,
            pattern,
          };

    if (handler) {
      await this.runWithProcessingHooks(context ?? ctx, async () => {
        await handler(data, ctx);
      });
      return;
    }

    await this.dispatchEvent(pattern, data, ctx);
  }

  /**
   * Promise-only ADR-008 counterpart to NestJS `Server.transformToObservable`.
   */
  async transformToObservable<T>(
    resultOrDeferred: T | Promise<T>,
  ): Promise<T> {
    return await resultOrDeferred;
  }

  /**
   * Reads a property from an options object with an optional fallback default.
   */
  getOptionsProp<
    Options extends Record<string, any> | undefined,
    Attribute extends keyof NonNullable<Options>,
  >(obj: Options, prop: Attribute): NonNullable<Options>[Attribute] | undefined;
  getOptionsProp<
    Options extends Record<string, any> | undefined,
    Attribute extends keyof NonNullable<Options>,
    DefaultValue extends NonNullable<Options>[Attribute] = NonNullable<Options>[Attribute],
  >(
    obj: Options,
    prop: Attribute,
    defaultValue: DefaultValue,
  ): NonNullable<Options>[Attribute];
  getOptionsProp(
    obj: Record<string, any> | undefined,
    prop: string | number | symbol,
    defaultValue?: any,
  ): any {
    return obj && prop in obj ? obj[prop as string] : defaultValue;
  }

  abstract listen(
    callback?: (...optionalParams: unknown[]) => any,
  ): Promise<void>;
  abstract close(): Promise<void>;

  protected async runWithProcessingHooks<T>(
    context: unknown,
    exec: () => Promise<T>,
  ): Promise<T> {
    const tid = this.transportId ?? this.transport;
    let endCalled = false;
    const callEndOnce = () => {
      if (endCalled) return;
      endCalled = true;
      this.onProcessingEndHook?.(tid, context);
    };

    const runCore = async (): Promise<T> => {
      try {
        return await exec();
      } finally {
        callEndOnce();
      }
    };

    if (!this.onProcessingStartHook) {
      return await runCore();
    }

    let capturedPromise: Promise<T> | undefined;
    let hookResult: void | Promise<any>;
    try {
      hookResult = this.onProcessingStartHook(tid, context, () => {
        capturedPromise = runCore();
        return capturedPromise;
      });
    } catch (err) {
      callEndOnce();
      throw err;
    }

    // Attach a no-op rejection handler immediately so hookResult can never become
    // an unhandled rejected promise while capturedPromise is awaited first.
    const hookPromise = Promise.resolve(hookResult);
    hookPromise.catch(() => {});

    if (capturedPromise) {
      let coreOutcome: { ok: true; value: T } | { ok: false; error: unknown };
      try {
        coreOutcome = { ok: true, value: await capturedPromise };
      } catch (err) {
        coreOutcome = { ok: false, error: err };
      }
      try {
        await hookPromise;
      } catch (hookErr) {
        if (coreOutcome.ok) {
          throw hookErr;
        }
      }
      if (!coreOutcome.ok) {
        throw coreOutcome.error;
      }
      return coreOutcome.value;
    }

    const awaitedHook = await hookPromise;
    if (capturedPromise) {
      return await capturedPromise;
    }
    return awaitedHook as T;
  }

  protected async dispatchMessage(
    pattern: string,
    data: unknown,
    ctx: RpcContext,
  ): Promise<{ response?: unknown; error?: SerializedRpcError }> {
    const handler = this.messageHandlers.get(pattern);
    if (!handler) {
      return {
        error: new RpcException({
          status: 404,
          message: `No @MessagePattern() handler found for pattern "${pattern}".`,
        }).toSerialized(),
      };
    }

    const hasHooks =
      this.onProcessingStartHook !== undefined ||
      this.onProcessingEndHook !== undefined;

    try {
      const response = hasHooks
        ? await this.runWithProcessingHooks(ctx, async () => {
            if (this.preRequestHook) {
              await this.preRequestHook({ pattern, data, ctx });
            }
            return await handler(data, ctx);
          })
        : await (async () => {
            if (this.preRequestHook) {
              await this.preRequestHook({ pattern, data, ctx });
            }
            return await handler(data, ctx);
          })();
      return { response };
    } catch (err) {
      return { error: this.serializeError(err) };
    }
  }

  protected async dispatchEvent(
    pattern: string,
    data: unknown,
    ctx: RpcContext,
  ): Promise<void> {
    const handlers = this.eventHandlers.get(pattern);
    if (!handlers || handlers.length === 0) {
      return;
    }
    const hasHooks =
      this.onProcessingStartHook !== undefined ||
      this.onProcessingEndHook !== undefined;
    for (const handler of [...handlers]) {
      try {
        if (hasHooks) {
          await this.runWithProcessingHooks(ctx, async () => {
            if (this.preRequestHook) {
              await this.preRequestHook({ pattern, data, ctx });
            }
            await handler(data, ctx);
          });
        } else {
          if (this.preRequestHook) {
            await this.preRequestHook({ pattern, data, ctx });
          }
          await handler(data, ctx);
        }
      } catch (err) {
        if (this.propagatesEventHandlerErrors) {
          throw err;
        }
        // Fire-and-forget event errors must not tear down the transport server
      }
    }
  }

  protected serializeError(err: unknown): SerializedRpcError {
    if (err instanceof RpcException) {
      return err.toSerialized();
    }
    if (err instanceof HttpException) {
      return {
        message: err.message,
        name: err.name,
        status: err.getStatus(),
        details: err.getResponse(),
        isRpcException: true,
      };
    }
    if (err instanceof Error) {
      return {
        message: err.message,
        name: err.name,
        isRpcException: false,
      };
    }
    return {
      message: String(err),
      isRpcException: false,
    };
  }
}

export { MicroserviceTransportServer as Server };
