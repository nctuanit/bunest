import type {
  ClsContextPropagator,
  ClsContextPropagatorOptions,
  ClsServiceLike,
  OnModuleDestroy,
  PreRequestHook,
} from "@bunest/core";
import { computeBackoffDelay } from "@bunest/core/common";
import {
  CircuitOpenError,
  RpcException,
  RpcTimeoutException,
} from "./exceptions";
import {
  normalizePattern,
  type CircuitBreakerOptions,
  type CircuitBreakerState,
  type ClientRetryOptions,
  type PatternInput,
  type SendOptions,
} from "./interfaces";
import {
  isEventContract,
  isMessageContract,
  type EventContract,
  type MessageContract,
} from "./contracts";
import type { ReadPacket } from "./packets";
import type {
  BunestEventPatternRegistry,
  BunestMessagePatternRegistry,
  MessagePatternRequest,
  MessagePatternResponse,
} from "./pattern-registry.interface";
import {
  buildOutboundRpcMetadata,
  resolveClsPropagator,
  rpcClientChannel,
  type RpcDiagnosticEvent,
} from "./rpc-diagnostics";
import type { Transport } from "./tokens";

export type ClientStatus = "connected" | "disconnected" | "reconnecting";
export type ClientStatusListener = (status: ClientStatus) => void;

export interface ClientProxyConstructorOptions {
  readonly requestTimeout?: number;
  readonly maxPendingRequests?: number;
  readonly retry?: ClientRetryOptions;
  readonly circuitBreaker?: CircuitBreakerOptions;
  readonly clsPropagation?:
    | boolean
    | readonly string[]
    | ClsContextPropagatorOptions;
  readonly cls?: ClsServiceLike;
}

export interface EmitOptions {
  readonly metadata?: Record<string, unknown>;
}

function sleepUnref(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }
  });
}

function isDefaultTransientError(err: unknown): boolean {
  if (err instanceof CircuitOpenError) {
    return false;
  }
  if (
    err instanceof RpcException &&
    (err as { readonly isRetryable?: boolean }).isRetryable !== true
  ) {
    return false;
  }
  return true;
}

function computeExponentialBackoffDelay(
  retry: ClientRetryOptions,
  failedAttempt1Based: number,
): number {
  const backoffMs = Math.max(0, Math.floor(retry.backoffMs ?? 50));
  if (backoffMs === 0) {
    return 0;
  }
  const maxBackoffMs = Math.max(
    backoffMs,
    Math.floor(retry.maxBackoffMs ?? 10_000),
  );
  return computeBackoffDelay(
    {
      delay: backoffMs,
      factor: 2,
      maxDelay: maxBackoffMs,
      jitter: (retry.jitter ?? true) ? "equal" : "none",
    },
    failedAttempt1Based,
  );
}

/**
 * Self-contained closed -> open -> half-open circuit breaker state machine for `ClientProxy`.
 */
export class ClientCircuitBreaker {
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly halfOpenMaxCalls: number;
  private readonly isFailureFn: (err: unknown) => boolean;
  private readonly onStateChange?: (
    from: CircuitBreakerState,
    to: CircuitBreakerState,
  ) => void;

  private _state: CircuitBreakerState = "closed";
  private consecutiveFailures = 0;
  private openedAt = 0;
  private halfOpenInFlight = 0;
  private halfOpenSuccesses = 0;

  constructor(options: CircuitBreakerOptions) {
    this.failureThreshold = Math.max(1, Math.floor(options.failureThreshold));
    this.resetTimeoutMs = Math.max(0, Math.floor(options.resetTimeoutMs));
    this.halfOpenMaxCalls = Math.max(
      1,
      Math.floor(options.halfOpenMaxCalls ?? 1),
    );
    this.isFailureFn = options.isFailure ?? isDefaultTransientError;
    this.onStateChange = options.onStateChange;
  }

  get state(): CircuitBreakerState {
    if (
      this._state === "open" &&
      Date.now() - this.openedAt >= this.resetTimeoutMs
    ) {
      return "half-open";
    }
    return this._state;
  }

  reset(): void {
    const prev = this._state;
    this._state = "closed";
    this.consecutiveFailures = 0;
    this.openedAt = 0;
    this.halfOpenInFlight = 0;
    this.halfOpenSuccesses = 0;
    if (prev !== "closed") {
      this.onStateChange?.(prev, "closed");
    }
  }

  /**
   * Checks whether a call is permitted and returns whether it was admitted as a
   * half-open probe. Throws `CircuitOpenError` when the circuit rejects the call.
   */
  acquire(pattern: string): { readonly isHalfOpenProbe: boolean } {
    if (this._state === "closed") {
      return { isHalfOpenProbe: false };
    }

    if (this._state === "open") {
      const now = Date.now();
      if (now - this.openedAt < this.resetTimeoutMs) {
        throw new CircuitOpenError(
          pattern,
          "open",
          this.openedAt + this.resetTimeoutMs,
        );
      }
      this.transition("half-open");
      this.halfOpenInFlight = 1;
      this.halfOpenSuccesses = 0;
      return { isHalfOpenProbe: true };
    }

    // Half-open state: allow up to halfOpenMaxCalls concurrent probes
    if (this.halfOpenInFlight >= this.halfOpenMaxCalls) {
      throw new CircuitOpenError(pattern, "half-open", Date.now());
    }
    this.halfOpenInFlight++;
    return { isHalfOpenProbe: true };
  }

  recordSuccess(isHalfOpenProbe: boolean): void {
    if (isHalfOpenProbe) {
      this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1);
      if (this._state === "half-open") {
        this.halfOpenSuccesses++;
        if (this.halfOpenSuccesses >= this.halfOpenMaxCalls) {
          this.consecutiveFailures = 0;
          this.halfOpenInFlight = 0;
          this.halfOpenSuccesses = 0;
          this.transition("closed");
        }
      }
      return;
    }

    if (this._state === "closed") {
      this.consecutiveFailures = 0;
    }
  }

  recordFailure(err: unknown, isHalfOpenProbe: boolean): void {
    if (err instanceof CircuitOpenError) {
      return;
    }
    if (!this.isFailureFn(err)) {
      if (isHalfOpenProbe) {
        this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1);
      }
      return;
    }

    if (isHalfOpenProbe) {
      this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1);
      if (this._state === "half-open") {
        this.halfOpenSuccesses = 0;
        this.openedAt = Date.now();
        this.transition("open");
      }
      return;
    }

    if (this._state === "closed") {
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= this.failureThreshold) {
        this.openedAt = Date.now();
        this.transition("open");
      }
    }
  }

  private transition(next: CircuitBreakerState): void {
    if (this._state === next) {
      return;
    }
    const prev = this._state;
    this._state = next;
    this.onStateChange?.(prev, next);
  }
}

/**
 * Base RPC client proxy implementing request-reply `send()` (with per-attempt
 * timeouts, exponential backoff + jitter retries, and circuit breaker protection),
 * fire-and-forget `emit()`, automatic CLS + W3C `traceparent` metadata propagation,
 * `diagnosticsChannel("bunest:rpc:client")` telemetry, NestJS v12 `setOnDispatchHook()`
 * & `on()`, and `onModuleDestroy()` cleanup.
 */
export abstract class ClientProxy<
  EventsMap extends Record<string, Function> = Record<string, Function>,
  Status extends string = ClientStatus,
> implements OnModuleDestroy {
  abstract readonly transport: Transport;

  protected readonly defaultTimeoutMs: number;
  protected readonly requestTimeout?: number;
  protected readonly maxPendingRequests?: number;
  protected retryOptions?: ClientRetryOptions;
  protected circuitBreaker?: ClientCircuitBreaker;
  protected clsPropagationEnabled: boolean;
  protected clsPropagator: ClsContextPropagator;
  protected clsService?: ClsServiceLike;

  private inFlightRequests = 0;
  private readonly activeRequests = new Set<(err: Error) => void>();
  protected currentStatus: ClientStatus = "disconnected";
  private readonly statusListeners = new Set<ClientStatusListener>();
  private readonly eventListeners = new Map<PropertyKey, Set<Function>>();
  protected onDispatchHook?: (packet: ReadPacket) => void;
  protected preRequestHook?: PreRequestHook<{
    pattern: string;
    data: unknown;
    transport: Transport;
  }>;

  constructor(
    defaultTimeoutMs: number = 5000,
    options?: ClientProxyConstructorOptions,
  ) {
    const resolvedTimeout = options?.requestTimeout ?? defaultTimeoutMs;
    this.defaultTimeoutMs = Math.max(1, Math.floor(resolvedTimeout));
    this.requestTimeout =
      options?.requestTimeout !== undefined
        ? Math.max(1, Math.floor(options.requestTimeout))
        : undefined;
    this.maxPendingRequests =
      options?.maxPendingRequests !== undefined &&
      Number.isFinite(options.maxPendingRequests) &&
      options.maxPendingRequests > 0
        ? Math.floor(options.maxPendingRequests)
        : undefined;
    this.retryOptions = options?.retry;
    this.circuitBreaker = options?.circuitBreaker
      ? new ClientCircuitBreaker(options.circuitBreaker)
      : undefined;
    const clsCfg = resolveClsPropagator(options?.clsPropagation);
    this.clsPropagationEnabled = clsCfg.enabled;
    this.clsPropagator = clsCfg.propagator;
    this.clsService = options?.cls;
  }

  /**
   * Number of currently in-flight `send()` requests.
   */
  get pendingRequestCount(): number {
    return this.inFlightRequests;
  }

  /**
   * Returns the current circuit breaker state (`"closed" | "open" | "half-open"`),
   * or `undefined` when no circuit breaker is configured.
   */
  getCircuitBreakerState(): CircuitBreakerState | undefined {
    return this.circuitBreaker?.state;
  }

  /**
   * Resets the configured circuit breaker back to `"closed"`.
   */
  resetCircuitBreaker(): void {
    this.circuitBreaker?.reset();
  }

  /**
   * Configures or replaces the default exponential-backoff retry policy on this client.
   */
  setRetryOptions(retry: ClientRetryOptions | undefined): this {
    this.retryOptions = retry;
    return this;
  }

  /**
   * Configures or disables the circuit breaker on this client.
   */
  setCircuitBreaker(options: CircuitBreakerOptions | undefined): this {
    this.circuitBreaker = options ? new ClientCircuitBreaker(options) : undefined;
    return this;
  }

  /**
   * Attaches an explicit `ClsService` for outbound context capture.
   */
  setClsService(cls: ClsServiceLike | undefined): this {
    this.clsService = cls;
    return this;
  }

  protected assertMaxPendingRequests(pattern: string): void {
    if (
      this.maxPendingRequests !== undefined &&
      this.inFlightRequests >= this.maxPendingRequests
    ) {
      throw new Error(
        `Max pending requests limit (${this.maxPendingRequests}) reached for pattern "${pattern}".`,
      );
    }
  }

  protected async trackInFlightRequest<T>(
    pattern: string,
    exec: () => Promise<T>,
  ): Promise<T> {
    this.assertMaxPendingRequests(pattern);
    this.inFlightRequests++;
    try {
      return await exec();
    } finally {
      this.inFlightRequests = Math.max(0, this.inFlightRequests - 1);
    }
  }

  protected cancelActiveRequests(
    reason: Error = new Error("ClientProxy closed."),
  ): void {
    for (const cancel of [...this.activeRequests]) {
      cancel(reason);
    }
    this.activeRequests.clear();
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
    metadata?: Record<string, unknown>,
  ): Promise<TRes>;

  protected abstract dispatchEvent<TReq = any>(
    pattern: string,
    data: TReq,
    metadata?: Record<string, unknown>,
  ): Promise<void>;

  /**
   * Sends a strongly-typed RPC request using a `MessageContract` created by
   * `defineMessageContract<TReq, TRes>(pattern)`.
   */
  sendContract<TReq, TRes>(
    contract: MessageContract<PatternInput, TReq, TRes>,
    data: TReq,
    options?: SendOptions,
  ): Promise<TRes> {
    if (!isMessageContract(contract)) {
      throw new Error(
        "ClientProxy.sendContract() requires a MessageContract created with defineMessageContract().",
      );
    }
    return (
      this.send as (
        pattern: PatternInput,
        payload: TReq,
        opts?: SendOptions,
      ) => Promise<TRes>
    )(contract.pattern, data, options);
  }

  /**
   * Sends a request-reply RPC message. Retries transient transport/timeout faults
   * according to `options.retry` / `this.retryOptions` or legacy `options.retries`;
   * protects downstream services via `circuitBreaker` when configured; propagates
   * CLS context & W3C `traceparent` automatically.
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
    return await this.trackInFlightRequest(key, async () => {
      let hookMetadata: Record<string, unknown> | undefined;
      if (this.onDispatchHook) {
        const packet: ReadPacket<TReq> = { pattern: key, data };
        this.onDispatchHook(packet);
        if (packet.metadata && typeof packet.metadata === "object") {
          hookMetadata = packet.metadata as Record<string, unknown>;
        }
      }
      if (this.preRequestHook) {
        await this.preRequestHook({
          pattern: key,
          data,
          transport: this.transport,
        });
      }

      const { metadata: packetMetadata, traceparent } =
        buildOutboundRpcMetadata({
          userMetadata: options?.metadata,
          hookMetadata,
          propagator: this.clsPropagator,
          cls: this.clsService,
          enabled: this.clsPropagationEnabled,
        });

      const timeoutMs = Math.max(
        1,
        Math.floor(
          options?.timeoutMs ?? this.requestTimeout ?? this.defaultTimeoutMs,
        ),
      );

      // Resolve retry policy while keeping 100% backward compatibility with legacy `retries`/`retryDelayMs`
      const structuredRetry = options?.retry ?? this.retryOptions;
      const useLegacyRetry =
        options?.retry === undefined && options?.retries !== undefined;
      let maxAttempts = 1;
      if (useLegacyRetry) {
        maxAttempts = 1 + Math.max(0, Math.floor(options!.retries!));
      } else if (structuredRetry) {
        maxAttempts = Math.max(1, Math.floor(structuredRetry.attempts));
      }
      const legacyDelayMs = Math.max(
        0,
        Math.floor(options?.retryDelayMs ?? 50),
      );

      const hasSubscribersAtStart = rpcClientChannel.hasSubscribers;
      const startedAt = hasSubscribersAtStart ? performance.now() : 0;
      if (hasSubscribersAtStart) {
        rpcClientChannel.publish({
          phase: "start",
          kind: "request",
          pattern: key,
          transport: String(this.transport),
          ...(traceparent !== undefined ? { traceparent } : {}),
        } satisfies RpcDiagnosticEvent);
      }

      let lastError: unknown;
      let attemptsMade = 0;

      try {
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          attemptsMade = attempt;
          const probe = this.circuitBreaker?.acquire(key);
          try {
            const response = await this.runWithTimeout(key, timeoutMs, (signal) =>
              this.sendOnce<TRes, TReq>(
                key,
                data,
                timeoutMs,
                signal,
                packetMetadata,
              ),
            );
            this.circuitBreaker?.recordSuccess(probe?.isHalfOpenProbe ?? false);

            if (rpcClientChannel.hasSubscribers) {
              rpcClientChannel.publish({
                phase: "end",
                kind: "request",
                pattern: key,
                transport: String(this.transport),
                attempt,
                durationMs: hasSubscribersAtStart
                  ? performance.now() - startedAt
                  : 0,
                ...(traceparent !== undefined ? { traceparent } : {}),
              } satisfies RpcDiagnosticEvent);
            }
            return response;
          } catch (err) {
            lastError = err;
            this.circuitBreaker?.recordFailure(
              err,
              probe?.isHalfOpenProbe ?? false,
            );

            // Never retry CircuitOpenError
            if (err instanceof CircuitOpenError) {
              throw err;
            }

            const retryPredicate =
              !useLegacyRetry && structuredRetry?.retryOn
                ? structuredRetry.retryOn
                : isDefaultTransientError;
            const retryAllowed = Boolean(retryPredicate(err));

            if (!retryAllowed || attempt >= maxAttempts) {
              throw err;
            }

            const delayMs = useLegacyRetry
              ? legacyDelayMs
              : computeExponentialBackoffDelay(structuredRetry!, attempt);
            await sleepUnref(delayMs);
          }
        }

        throw lastError;
      } catch (err) {
        if (rpcClientChannel.hasSubscribers) {
          rpcClientChannel.publish({
            phase: "error",
            kind: "request",
            pattern: key,
            transport: String(this.transport),
            attempt: attemptsMade || 1,
            durationMs: hasSubscribersAtStart
              ? performance.now() - startedAt
              : 0,
            error: err,
            ...(traceparent !== undefined ? { traceparent } : {}),
          } satisfies RpcDiagnosticEvent);
        }
        throw err;
      }
    });
  }

  /**
   * Emits a strongly-typed fire-and-forget event using an `EventContract` created by
   * `defineEventContract<TPayload>(pattern)`.
   */
  emitContract<TPayload>(
    contract: EventContract<PatternInput, TPayload>,
    data: TPayload,
    options?: EmitOptions,
  ): Promise<void> {
    if (!isEventContract(contract)) {
      throw new Error(
        "ClientProxy.emitContract() requires an EventContract created with defineEventContract().",
      );
    }
    return (
      this.emit as (
        pattern: PatternInput,
        payload: TPayload,
        opts?: EmitOptions,
      ) => Promise<void>
    )(contract.pattern, data, options);
  }

  /**
   * Emits a fire-and-forget event without awaiting a reply.
   */
  emit<K extends keyof BunestEventPatternRegistry & string>(
    pattern: K,
    data: BunestEventPatternRegistry[K],
    options?: EmitOptions,
  ): Promise<void>;
  emit<TReq = any, TPattern extends PatternInput = PatternInput>(
    pattern: TPattern extends keyof BunestEventPatternRegistry
      ? never
      : TPattern,
    data: TReq,
    options?: EmitOptions,
  ): Promise<void>;
  async emit<TReq = any>(
    pattern: PatternInput,
    data: TReq,
    options?: EmitOptions,
  ): Promise<void> {
    const key = normalizePattern(pattern);
    let hookMetadata: Record<string, unknown> | undefined;
    if (this.onDispatchHook) {
      const packet: ReadPacket<TReq> = { pattern: key, data };
      this.onDispatchHook(packet);
      if (packet.metadata && typeof packet.metadata === "object") {
        hookMetadata = packet.metadata as Record<string, unknown>;
      }
    }
    if (this.preRequestHook) {
      await this.preRequestHook({
        pattern: key,
        data,
        transport: this.transport,
      });
    }

    const { metadata: packetMetadata, traceparent } = buildOutboundRpcMetadata({
      userMetadata: options?.metadata,
      hookMetadata,
      propagator: this.clsPropagator,
      cls: this.clsService,
      enabled: this.clsPropagationEnabled,
    });

    const hasSubscribersAtStart = rpcClientChannel.hasSubscribers;
    const startedAt = hasSubscribersAtStart ? performance.now() : 0;
    if (hasSubscribersAtStart) {
      rpcClientChannel.publish({
        phase: "start",
        kind: "event",
        pattern: key,
        transport: String(this.transport),
        ...(traceparent !== undefined ? { traceparent } : {}),
      } satisfies RpcDiagnosticEvent);
    }

    const probe = this.circuitBreaker?.acquire(key);
    try {
      await this.dispatchEvent(key, data, packetMetadata);
      this.circuitBreaker?.recordSuccess(probe?.isHalfOpenProbe ?? false);
      if (rpcClientChannel.hasSubscribers) {
        rpcClientChannel.publish({
          phase: "end",
          kind: "event",
          pattern: key,
          transport: String(this.transport),
          durationMs: hasSubscribersAtStart
            ? performance.now() - startedAt
            : 0,
          ...(traceparent !== undefined ? { traceparent } : {}),
        } satisfies RpcDiagnosticEvent);
      }
    } catch (err) {
      this.circuitBreaker?.recordFailure(err, probe?.isHalfOpenProbe ?? false);
      if (rpcClientChannel.hasSubscribers) {
        rpcClientChannel.publish({
          phase: "error",
          kind: "event",
          pattern: key,
          transport: String(this.transport),
          durationMs: hasSubscribersAtStart
            ? performance.now() - startedAt
            : 0,
          error: err,
          ...(traceparent !== undefined ? { traceparent } : {}),
        } satisfies RpcDiagnosticEvent);
      }
      throw err;
    }
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
      const cancel = (err: Error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          this.activeRequests.delete(cancel);
          controller.abort(err);
          reject(err);
        }
      };
      this.activeRequests.add(cancel);

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          this.activeRequests.delete(cancel);
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
          this.activeRequests.delete(cancel);
          if (!settled) {
            settled = true;
            resolve(value);
          }
        },
        (err) => {
          clearTimeout(timer);
          this.activeRequests.delete(cancel);
          if (!settled) {
            settled = true;
            reject(err);
          }
        },
      );
    });
  }
}
