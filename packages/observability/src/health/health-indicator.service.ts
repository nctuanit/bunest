import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type LoggerService,
} from "@bunest/core";
import {
  HealthIndicatorStatus,
  TERMINUS_LOGGER,
  type HealthIndicatorResult,
} from "./health.interface";
import { TimeoutError, formatErrorMessage, toMs, type Duration } from "./units";

const MAX_DURATION_MS = 2 ** 31 - 1;
const RESERVED_ATTEMPT_KEYS = [
  "status",
  "responseTime",
  "cachedResponse",
] as const;

type Merge<A, B> = B extends object
  ? A extends object
    ? Omit<A, keyof B> & B
    : B
  : A;

type SuccessData<TStatic, TSuccess> = TSuccess extends object
  ? Merge<TStatic, TSuccess>
  : TStatic & Record<string, any>;

export type HealthCheckAttemptResult<
  TKey extends string,
  TStatic,
  TSuccess,
  TFailure,
> = Record<
  TKey,
  | ({
      status: HealthIndicatorStatus.UP | HealthIndicatorStatus.DEGRADED;
      responseTime: number;
      cachedResponse?: true;
    } & SuccessData<TStatic, TSuccess>)
  | ({
      status: HealthIndicatorStatus.DOWN | HealthIndicatorStatus.DEGRADED;
      message: string;
      responseTime: number;
      cachedResponse?: true;
    } & Merge<TStatic, TFailure>)
>;

type AdditionalData = Record<string, unknown>;

type WithoutStatus<TData> = {
  [TDataKey in keyof TData]: TDataKey extends "status"
    ? never
    : TData[TDataKey];
};

interface AttemptOutcome {
  status: HealthIndicatorStatus.UP | HealthIndicatorStatus.DOWN;
  data: Record<string, unknown>;
  responseTime: number;
}

interface CacheEntry {
  promise: Promise<AttemptOutcome>;
  expiresAt: number;
  settled: boolean;
}

/**
 * Single-flight attempt result cache keyed by indicator key.
 */
export class AttemptCache {
  private readonly entries = new Map<string, CacheEntry>();

  async getOrRun(
    key: string,
    ttlMs: number,
    run: () => Promise<AttemptOutcome>,
  ): Promise<{ value: AttemptOutcome; cached: boolean }> {
    const existing = this.entries.get(key);
    if (existing && existing.expiresAt > Date.now()) {
      const cached = existing.settled;
      return { value: await existing.promise, cached };
    }

    const entry: CacheEntry = {
      promise: run(),
      expiresAt: Date.now() + ttlMs,
      settled: false,
    };
    this.entries.set(key, entry);

    const value = await entry.promise;
    entry.expiresAt = Date.now() + ttlMs;
    entry.settled = true;
    return { value, cached: false };
  }
}

function assertDuration(ms: number, name: string): void {
  if (!Number.isInteger(ms) || ms < 0 || ms > MAX_DURATION_MS) {
    throw new Error(
      `${name} must be a whole number between 0 and ${MAX_DURATION_MS} milliseconds, got ${ms}`,
    );
  }
}

function omitUndefined<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) {
      out[k] = v;
    }
  }
  return out as T;
}

async function runAttemptWithTimeout<T>(
  timeoutMs: number | undefined,
  fn: (signal: AbortSignal) => Promise<T> | T,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;

  const abortPromise =
    timeoutMs !== undefined
      ? new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            const err = new TimeoutError(timeoutMs);
            controller.abort(err);
            reject(err);
          }, timeoutMs);
          if (
            typeof timer === "object" &&
            timer !== null &&
            "unref" in timer &&
            typeof timer.unref === "function"
          ) {
            timer.unref();
          }
        })
      : undefined;

  try {
    const work = Promise.resolve().then(() => fn(controller.signal));
    if (abortPromise) {
      return await Promise.race([work, abortPromise]);
    }
    return await work;
  } catch (err) {
    if (timedOut && !(err instanceof TimeoutError)) {
      throw new TimeoutError(timeoutMs, { cause: err });
    }
    throw err;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    if (!controller.signal.aborted) {
      controller.abort();
    }
  }
}

const warnedMessages = new Set<string>();

function warnOnce(
  logger: LoggerService | undefined,
  id: string,
  message: string,
): void {
  if (!logger || warnedMessages.has(id)) {
    return;
  }
  warnedMessages.add(id);
  logger.warn?.(message, "HealthIndicatorService");
}

function sanitizeAttemptData(
  key: string,
  value: unknown,
  logger?: LoggerService,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const data: Record<string, unknown> = {
    ...(value as Record<string, unknown>),
  };
  const ignored = RESERVED_ATTEMPT_KEYS.filter((k) => k in data);
  for (const k of ignored) {
    delete data[k];
  }
  if (ignored.length > 0) {
    warnOnce(
      logger,
      `reserved-keys:${key}`,
      `Ignoring reserved key(s) ${ignored.map((k) => `"${k}"`).join(", ")} in the data of health indicator "${key}".`,
    );
  }
  return data;
}

/**
 * Fluent Promise-like builder describing a health check attempt with timeout,
 * caching, static/success/failure data hooks, and degraded status rules.
 */
export class HealthCheckAttempt<
  TKey extends Readonly<string> = string,
  TResult = unknown,
  TStatic extends object = {},
  TSuccess extends object | undefined = undefined,
  TFailure extends object = {},
> implements Promise<
  HealthCheckAttemptResult<TKey, TStatic, TSuccess, TFailure>
> {
  private timeoutMs?: number;
  private cacheTtlMs?: number;
  private degradedAfterMs?: number;
  private degradeFailure = false;
  private staticValues: Record<string, unknown> = {};
  private successFns?: Array<(result: unknown) => unknown>;
  private failureFns: Array<(error: unknown) => unknown> = [];

  constructor(
    private readonly key: TKey,
    private readonly fn: (options: { signal: AbortSignal }) => unknown,
    private readonly cache: AttemptCache,
    private readonly logger?: LoggerService,
  ) {}

  /**
   * Set a timeout for the health check attempt.
   */
  withTimeout(timeout: Duration): this {
    const ms = toMs(timeout, "Timeout");
    assertDuration(ms, "Timeout");
    this.timeoutMs = ms;
    return this;
  }

  /**
   * Add static data to every result (success or failure).
   */
  withData<const TData extends object>(
    data: TData,
  ): HealthCheckAttempt<
    TKey,
    TResult,
    Merge<TStatic, TData>,
    TSuccess,
    TFailure
  > {
    this.staticValues = {
      ...this.staticValues,
      ...sanitizeAttemptData(this.key, data, this.logger),
    };
    return this as unknown as HealthCheckAttempt<
      TKey,
      TResult,
      Merge<TStatic, TData>,
      TSuccess,
      TFailure
    >;
  }

  /**
   * Add data to the result when the attempt succeeds.
   */
  withSuccessData<const TData extends object>(
    fn: (result: TResult) => TData,
  ): HealthCheckAttempt<
    TKey,
    TResult,
    TStatic,
    Merge<TSuccess, Awaited<TData>>,
    TFailure
  >;
  withSuccessData<const TData extends object>(
    data: TData,
  ): HealthCheckAttempt<
    TKey,
    TResult,
    TStatic,
    Merge<TSuccess, TData>,
    TFailure
  >;
  withSuccessData(data: unknown): any {
    const fn =
      typeof data === "function"
        ? (data as (result: unknown) => unknown)
        : () => data;
    this.successFns = [...(this.successFns ?? []), fn];
    return this;
  }

  /**
   * Add data to the result when the attempt fails.
   */
  withFailureData<const TData extends object>(
    fn: (error: unknown) => TData,
  ): HealthCheckAttempt<
    TKey,
    TResult,
    TStatic,
    TSuccess,
    Merge<TFailure, Awaited<TData>>
  >;
  withFailureData<const TData extends object>(
    data: TData,
  ): HealthCheckAttempt<
    TKey,
    TResult,
    TStatic,
    TSuccess,
    Merge<TFailure, TData>
  >;
  withFailureData(data: unknown): any {
    const fn =
      typeof data === "function"
        ? (data as (error: unknown) => unknown)
        : () => data;
    this.failureFns = [...this.failureFns, fn];
    return this;
  }

  /**
   * Cache the attempt outcome for `ttl` with single-flight deduplication across
   * concurrent requests sharing the same indicator key.
   */
  cacheFor(ttl: Duration): this {
    const ttlMs = toMs(ttl, "Cache TTL");
    if (!Number.isFinite(ttlMs) || ttlMs < 0) {
      throw new Error(`Cache TTL must be 0 or more milliseconds, got ${ttlMs}`);
    }
    this.cacheTtlMs = ttlMs;
    return this;
  }

  /**
   * Mark the indicator as `degraded` instead of `up` when it succeeds in `threshold` or longer.
   */
  degradedAfter(threshold: Duration): this {
    const ms = toMs(threshold, "Degraded threshold");
    assertDuration(ms, "Degraded threshold");
    this.degradedAfterMs = ms;
    return this;
  }

  /**
   * Mark the indicator as `degraded` instead of `down` when it fails.
   */
  degradedOnFailure(): this {
    this.degradeFailure = true;
    return this;
  }

  private toStatus(outcome: AttemptOutcome): HealthIndicatorStatus {
    const failed = outcome.status === HealthIndicatorStatus.DOWN;
    if (failed && this.degradeFailure) {
      return HealthIndicatorStatus.DEGRADED;
    }
    if (failed) {
      return HealthIndicatorStatus.DOWN;
    }
    if (
      this.degradedAfterMs !== undefined &&
      outcome.responseTime >= this.degradedAfterMs
    ) {
      return HealthIndicatorStatus.DEGRADED;
    }
    return HealthIndicatorStatus.UP;
  }

  private toResult(
    outcome: AttemptOutcome,
    cachedResponse = false,
  ): HealthCheckAttemptResult<TKey, TStatic, TSuccess, TFailure> {
    const detail: Record<string, unknown> = {
      ...this.staticValues,
      ...outcome.data,
      responseTime: outcome.responseTime,
      ...(cachedResponse ? { cachedResponse: true as const } : {}),
      status: this.toStatus(outcome),
    };
    return {
      [this.key]: omitUndefined(detail),
    } as HealthCheckAttemptResult<TKey, TStatic, TSuccess, TFailure>;
  }

  private async resolveSuccessData(
    result: unknown,
  ): Promise<Record<string, unknown>> {
    if (this.successFns) {
      let data: Record<string, unknown> = {};
      for (const fn of this.successFns) {
        const value = await fn(result);
        data = {
          ...data,
          ...sanitizeAttemptData(this.key, value, this.logger),
        };
      }
      return data;
    }
    return sanitizeAttemptData(this.key, result, this.logger);
  }

  private async resolveFailureData(
    err: unknown,
    start: number,
  ): Promise<Record<string, unknown>> {
    let data: Record<string, unknown> = {};
    for (const fn of this.failureFns) {
      let remainingMs: number | undefined;
      if (this.timeoutMs !== undefined) {
        const elapsedMs = performance.now() - start;
        remainingMs = Math.max(0, Math.floor(this.timeoutMs - elapsedMs));
      }
      try {
        const value = await runAttemptWithTimeout(remainingMs, () => fn(err));
        data = {
          ...data,
          ...sanitizeAttemptData(this.key, value, this.logger),
        };
      } catch (innerErr) {
        warnOnce(
          this.logger,
          `failure-data:${this.key}`,
          `Could not add failure data to health indicator "${this.key}": ${formatErrorMessage(innerErr)}`,
        );
      }
    }
    return data;
  }

  private async run(): Promise<AttemptOutcome> {
    const start = performance.now();
    try {
      const data = await runAttemptWithTimeout(this.timeoutMs, async (signal) =>
        this.resolveSuccessData(await this.fn({ signal })),
      );
      return {
        status: HealthIndicatorStatus.UP,
        data,
        responseTime: Math.round(performance.now() - start),
      };
    } catch (err) {
      const failureData = await this.resolveFailureData(err, start);
      return {
        status: HealthIndicatorStatus.DOWN,
        data: { message: formatErrorMessage(err), ...failureData },
        responseTime: Math.round(performance.now() - start),
      };
    }
  }

  private async execute(): Promise<
    HealthCheckAttemptResult<TKey, TStatic, TSuccess, TFailure>
  > {
    if (this.cacheTtlMs === undefined) {
      return this.toResult(await this.run());
    }
    const { value, cached } = await this.cache.getOrRun(
      this.key,
      this.cacheTtlMs,
      () => this.run(),
    );
    return this.toResult(value, cached);
  }

  then: Promise<
    HealthCheckAttemptResult<TKey, TStatic, TSuccess, TFailure>
  >["then"] = (onfulfilled, onrejected) =>
    this.execute().then(onfulfilled, onrejected);

  catch: Promise<
    HealthCheckAttemptResult<TKey, TStatic, TSuccess, TFailure>
  >["catch"] = (onrejected) => this.execute().catch(onrejected);

  finally: Promise<
    HealthCheckAttemptResult<TKey, TStatic, TSuccess, TFailure>
  >["finally"] = (onfinally) => this.execute().finally(onfinally);

  readonly [Symbol.toStringTag] = "HealthCheckAttempt";
}

/**
 * Session created by `HealthIndicatorService.check(key)` for emitting
 * `up()`, `down()`, `degraded()`, or fluent `attempt()` health results.
 */
export class HealthIndicatorSession<TKey extends Readonly<string> = string> {
  constructor(
    private readonly key: TKey,
    private readonly cache: AttemptCache = new AttemptCache(),
    private readonly logger?: LoggerService,
  ) {}

  private assertNotReserved(
    data: Record<string, unknown>,
    keys: string[],
  ): void {
    for (const key of keys) {
      if (key in data) {
        throw new Error(
          `"${key}" is a reserved key and cannot be used in additional data`,
        );
      }
    }
  }

  private compose<TStatus extends HealthIndicatorStatus>(
    status: TStatus,
    data?: unknown,
  ): HealthIndicatorResult<TKey, TStatus, any> {
    let additionalData: Record<string, unknown> = {};
    if (typeof data === "string") {
      additionalData = { message: data };
    } else if (typeof data === "object" && data !== null) {
      additionalData = data as Record<string, unknown>;
    }
    this.assertNotReserved(additionalData, ["status"]);
    return {
      [this.key]: { ...additionalData, status },
    } as HealthIndicatorResult<TKey, TStatus, any>;
  }

  /**
   * Mark the health indicator as `down`.
   */
  down<TData extends AdditionalData>(
    data?: TData & WithoutStatus<TData>,
  ): HealthIndicatorResult<TKey, HealthIndicatorStatus.DOWN, TData>;
  down<TMessage extends string>(
    data?: TMessage,
  ): HealthIndicatorResult<
    TKey,
    HealthIndicatorStatus.DOWN,
    { message: TMessage }
  >;
  down(
    data?: unknown,
  ): HealthIndicatorResult<TKey, HealthIndicatorStatus.DOWN> {
    return this.compose(HealthIndicatorStatus.DOWN, data);
  }

  /**
   * Mark the health indicator as `degraded`: still serving, but impaired (HTTP 200).
   */
  degraded<TData extends AdditionalData>(
    data?: TData & WithoutStatus<TData>,
  ): HealthIndicatorResult<TKey, HealthIndicatorStatus.DEGRADED, TData>;
  degraded<TMessage extends string>(
    data?: TMessage,
  ): HealthIndicatorResult<
    TKey,
    HealthIndicatorStatus.DEGRADED,
    { message: TMessage }
  >;
  degraded(
    data?: unknown,
  ): HealthIndicatorResult<TKey, HealthIndicatorStatus.DEGRADED> {
    return this.compose(HealthIndicatorStatus.DEGRADED, data);
  }

  /**
   * Mark the health indicator as `up`.
   */
  up<TData extends AdditionalData>(
    data?: TData & WithoutStatus<TData>,
  ): HealthIndicatorResult<TKey, HealthIndicatorStatus.UP, TData>;
  up<TMessage extends string>(
    data?: TMessage,
  ): HealthIndicatorResult<
    TKey,
    HealthIndicatorStatus.UP,
    { message: TMessage }
  >;
  up(data?: unknown): HealthIndicatorResult<TKey, HealthIndicatorStatus.UP> {
    return this.compose(HealthIndicatorStatus.UP, data);
  }

  /**
   * Execute `fn` inside a fluent `HealthCheckAttempt` builder supporting
   * `.withTimeout()`, `.withData()`, `.withSuccessData()`, `.withFailureData()`,
   * `.cacheFor()`, `.degradedAfter()`, and `.degradedOnFailure()`.
   */
  attempt<TResult>(
    fn: (options: { signal: AbortSignal }) => TResult,
  ): HealthCheckAttempt<TKey, Awaited<TResult>> {
    return new HealthCheckAttempt<TKey, Awaited<TResult>>(
      this.key,
      fn,
      this.cache,
      this.logger,
    );
  }
}

/**
 * Helper service for building Terminus v11/v12 health indicator results.
 */
@Injectable()
export class HealthIndicatorService {
  private readonly cache = new AttemptCache();
  private readonly logger: LoggerService;

  constructor(
    @Optional()
    @Inject(TERMINUS_LOGGER)
    logger?: LoggerService,
  ) {
    this.logger = logger ?? new Logger("HealthIndicatorService");
  }

  check<const TKey extends string>(key: TKey): HealthIndicatorSession<TKey> {
    return new HealthIndicatorSession(key, this.cache, this.logger);
  }
}

/**
 * A health indicator function (or direct `HealthCheckAttempt`) passed to `HealthCheckService.check()`.
 */
export type HealthIndicatorFunction =
  | (() => PromiseLike<HealthIndicatorResult> | HealthIndicatorResult)
  | (() =>
      | PromiseLike<HealthCheckAttempt<any, any, any, any, any>>
      | HealthCheckAttempt<any, any, any, any, any>)
  | HealthCheckAttempt<any, any, any, any, any>;

/**
 * Backward-compatible alias for `HealthIndicatorFunction`.
 */
export type HealthCheckFunction = HealthIndicatorFunction;

export type InferHealthIndicatorResult<
  TFn extends HealthIndicatorFunction = HealthIndicatorFunction,
> = TFn extends (...args: any) => any ? Awaited<ReturnType<TFn>> : Awaited<TFn>;

export type InferHealthIndicatorResults<
  TFns extends readonly HealthIndicatorFunction[] = HealthIndicatorFunction[],
  TResults extends readonly any[] = [],
> = TFns extends readonly [
  infer TFn extends HealthIndicatorFunction,
  ...infer TRest extends readonly HealthIndicatorFunction[],
]
  ? InferHealthIndicatorResults<TRest, [...TResults, TFn]> &
      InferHealthIndicatorResult<TFn>
  : HealthIndicatorResult;
