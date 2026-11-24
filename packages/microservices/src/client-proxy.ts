import type { OnModuleDestroy, PreRequestHook } from "@bunest/core";
import { RpcException, RpcTimeoutException } from "./exceptions";
import {
  normalizePattern,
  type PatternInput,
  type SendOptions,
} from "./interfaces";
import type { ReadPacket } from "./packets";
import type {
  BunestEventPatternRegistry,
  BunestMessagePatternRegistry,
  MessagePatternRequest,
  MessagePatternResponse,
} from "./pattern-registry.interface";
import type { Transport } from "./tokens";

export type ClientStatus = "connected" | "disconnected" | "reconnecting";
export type ClientStatusListener = (status: ClientStatus) => void;

function sleepUnref(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }
  });
}

/**
 * Base RPC client proxy implementing request-reply `send()` (with per-attempt
 * timeouts and automatic retries on transient transport errors), fire-and-forget
 * `emit()`, NestJS v12 `setOnDispatchHook()` & `on()`, and `onModuleDestroy()` cleanup.
 */
export abstract class ClientProxy<
  EventsMap extends Record<string, Function> = Record<string, Function>,
  Status extends string = ClientStatus,
> implements OnModuleDestroy {
  abstract readonly transport: Transport;

  protected readonly defaultTimeoutMs: number;
  protected currentStatus: ClientStatus = "disconnected";
  private readonly statusListeners = new Set<ClientStatusListener>();
  private readonly eventListeners = new Map<PropertyKey, Set<Function>>();
  protected onDispatchHook?: (packet: ReadPacket) => void;
  private preRequestHook?: PreRequestHook<{
    pattern: string;
    data: unknown;
    transport: Transport;
  }>;

  constructor(defaultTimeoutMs: number = 5000) {
    this.defaultTimeoutMs = Math.max(1, Math.floor(defaultTimeoutMs));
  }

  /**
   * Current connection status (`"connected" | "disconnected" | "reconnecting"`).
   */
  get status(): Status {
    return this.currentStatus as unknown as Status;
  }

  /**
   * Subscribes to connection status changes. Returns an unsubscribe function.
   */
  onStatus(listener: ClientStatusListener): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  /**
   * Registers an event listener for a client transport event (matches NestJS `ClientProxy.on`).
   */
  on<
    EventKey extends keyof EventsMap = keyof EventsMap,
    EventCallback extends EventsMap[EventKey] = EventsMap[EventKey],
  >(event: EventKey, callback: EventCallback): void {
    let set = this.eventListeners.get(event as PropertyKey);
    if (!set) {
      set = new Set();
      this.eventListeners.set(event as PropertyKey, set);
    }
    set.add(callback);
  }

  protected emitClientEvent(event: PropertyKey, ...args: unknown[]): void {
    for (const cb of [...(this.eventListeners.get(event) ?? [])]) {
      cb(...args);
    }
  }

  protected emitStatus(status: ClientStatus): void {
    if (this.currentStatus === status) return;
    this.currentStatus = status;
    for (const listener of this.statusListeners) {
      listener(status);
    }
  }

  /**
   * Registers a NestJS v12 dispatch hook invoked with every outgoing `ReadPacket`
   * (requests and events alike) right before transport dispatch.
   */
  setOnDispatchHook(hook: ((packet: ReadPacket) => void) | undefined): void {
    this.onDispatchHook = hook;
  }

  /**
   * Registers a `PreRequestHook` invoked before every outgoing `send()` / `emit()`.
   */
  setPreRequestHook(
    hook:
      | PreRequestHook<{
          pattern: string;
          data: unknown;
          transport: Transport;
        }>
      | undefined,
  ): this {
    this.preRequestHook = hook;
    return this;
  }

  /**
   * Returns the underlying transport client/socket instance (matching NestJS `ClientProxy.unwrap<T>()`).
   */
  unwrap<T = unknown>(): T {
    return this as unknown as T;
  }

  abstract connect(): Promise<any>;
  abstract close(): Promise<void> | void;

  protected abstract sendOnce<TRes = any, TReq = any>(
    pattern: string,
    data: TReq,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<TRes>;

  protected abstract dispatchEvent<TReq = any>(
    pattern: string,
    data: TReq,
  ): Promise<void>;

  /**
   * Sends a request-reply RPC message. Retries transient transport/timeout faults up to
   * `options.retries` times; application `RpcException` errors propagate immediately.
   */
  send<K extends keyof BunestMessagePatternRegistry & string>(
    pattern: K,
    data: MessagePatternRequest<K>,
    options?: SendOptions,
  ): Promise<MessagePatternResponse<K>>;
  send<TRes = any, TReq = any, TPattern extends PatternInput = PatternInput>(
    pattern: TPattern extends keyof BunestMessagePatternRegistry
      ? never
      : TPattern,
    data: TReq,
    options?: SendOptions,
  ): Promise<TRes>;
  async send<TRes = any, TReq = any>(
    pattern: PatternInput,
    data: TReq,
    options?: SendOptions,
  ): Promise<TRes> {
    const key = normalizePattern(pattern);
    if (this.onDispatchHook) {
      const packet: ReadPacket<TReq> = { pattern: key, data };
      this.onDispatchHook(packet);
    }
    if (this.preRequestHook) {
      await this.preRequestHook({
        pattern: key,
        data,
        transport: this.transport,
      });
    }
    const timeoutMs = Math.max(
      1,
      Math.floor(options?.timeoutMs ?? this.defaultTimeoutMs),
    );
    const retries = Math.max(0, Math.floor(options?.retries ?? 0));
    const retryDelayMs = Math.max(0, Math.floor(options?.retryDelayMs ?? 50));

    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await this.runWithTimeout(key, timeoutMs, (signal) =>
          this.sendOnce<TRes, TReq>(key, data, timeoutMs, signal),
        );
      } catch (err) {
        lastError = err;
        // Never retry non-retryable application-level RpcException business errors
        if (
          err instanceof RpcException &&
          (err as { readonly isRetryable?: boolean }).isRetryable !== true
        ) {
          throw err;
        }
        if (attempt < retries) {
          await sleepUnref(retryDelayMs);
        }
      }
    }

    throw lastError;
  }

  /**
   * Emits a fire-and-forget event without awaiting a reply.
   */
  emit<K extends keyof BunestEventPatternRegistry & string>(
    pattern: K,
    data: BunestEventPatternRegistry[K],
  ): Promise<void>;
  emit<TReq = any, TPattern extends PatternInput = PatternInput>(
    pattern: TPattern extends keyof BunestEventPatternRegistry
      ? never
      : TPattern,
    data: TReq,
  ): Promise<void>;
  async emit<TReq = any>(pattern: PatternInput, data: TReq): Promise<void> {
    const key = normalizePattern(pattern);
    if (this.onDispatchHook) {
      const packet: ReadPacket<TReq> = { pattern: key, data };
      this.onDispatchHook(packet);
    }
    if (this.preRequestHook) {
      await this.preRequestHook({
        pattern: key,
        data,
        transport: this.transport,
      });
    }
    await this.dispatchEvent(key, data);
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }

  private async runWithTimeout<T>(
    pattern: string,
    timeoutMs: number,
    exec: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    return await new Promise<T>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          const timeoutErr = new RpcTimeoutException(pattern, timeoutMs);
          controller.abort(timeoutErr);
          reject(timeoutErr);
        }
      }, timeoutMs);
      if (typeof (timer as { unref?: () => void }).unref === "function") {
        (timer as { unref: () => void }).unref();
      }

      exec(controller.signal).then(
        (value) => {
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            resolve(value);
          }
        },
        (err) => {
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            reject(err);
          }
        },
      );
    });
  }
}
