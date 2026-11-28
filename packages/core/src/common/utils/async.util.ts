import { type Duration, parseDuration } from "./duration.util";
import { not } from "./predicate.util";
import { sleep } from "./retry.util";
import { isError, isInteger, isNotUndefined } from "./type-guards.util";

/**
 * Error thrown when an async operation exceeds its configured timeout.
 */
export class TimeoutError extends Error {
  public readonly timeoutMs: number;

  constructor(timeoutMs: number, message?: string) {
    super(message ?? `Operation timed out after ${timeoutMs}ms`);
    this.name = "TimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
}

/**
 * Creates an externally resolvable `Promise` (`resolve` / `reject` handles)
 * backed by native `Promise.withResolvers()`.
 */
export function deferred<T = void>(): Deferred<T> {
  return Promise.withResolvers<T>();
}

/**
 * Synchronously peeks an already-settled promise's value without creating a microtask,
 * delegating directly to Bun's Zig-native `Bun.peek()`.
 */
export function peekPromise<T>(value: T | Promise<T>): T | Promise<T> {
  return Bun.peek(value);
}

/**
 * Returns `true` if `promise` is already fulfilled (non-blocking via `Bun.peek.status()`).
 */
export function isPromiseFulfilled(promise: Promise<unknown>): boolean {
  return Bun.peek.status(promise) === "fulfilled";
}

/**
 * Maps `items` asynchronously with bounded concurrency while preserving input order.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R> | R,
): Promise<R[]> {
  if (not(isInteger(concurrency)) || concurrency < 1) {
    throw new RangeError(
      `mapLimit: concurrency must be a positive integer (got ${concurrency})`,
    );
  }
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const current = nextIndex++;
      results[current] = await mapper(items[current] as T, current);
    }
  };

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

export interface SettledPartition<T> {
  readonly fulfilled: T[];
  readonly rejected: unknown[];
}

/**
 * Awaits all promises with `Promise.allSettled` and partitions results into
 * `{ fulfilled, rejected }`.
 */
export async function allSettledPartition<T>(
  promises: readonly Promise<T>[],
): Promise<SettledPartition<T>> {
  const settled = await Promise.allSettled(promises);
  const fulfilled: T[] = [];
  const rejected: unknown[] = [];

  for (const outcome of settled) {
    if (outcome.status === "fulfilled") {
      fulfilled.push(outcome.value);
    } else {
      rejected.push(outcome.reason);
    }
  }
  return { fulfilled, rejected };
}

export interface DebouncedFn<Args extends readonly unknown[]> {
  (...args: Args): void;
  cancel(): void;
  flush(): void;
}

/**
 * Creates a debounced function that delays invoking `fn` until `wait` has elapsed
 * since the last call, with `.cancel()` and `.flush()` controls.
 */
export function debounce<Args extends readonly unknown[]>(
  fn: (...args: Args) => void,
  wait: Duration,
): DebouncedFn<Args> {
  const waitMs = parseDuration(wait);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pendingArgs: Args | undefined;

  const cancel = (): void => {
    if (isNotUndefined(timer)) {
      clearTimeout(timer);
      timer = undefined;
    }
    pendingArgs = undefined;
  };

  const flush = (): void => {
    if (isNotUndefined(timer) && isNotUndefined(pendingArgs)) {
      const args = pendingArgs;
      cancel();
      fn(...args);
    }
  };

  const debounced = ((...args: Args): void => {
    pendingArgs = args;
    if (isNotUndefined(timer)) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      const currentArgs = pendingArgs;
      timer = undefined;
      pendingArgs = undefined;
      if (isNotUndefined(currentArgs)) {
        fn(...currentArgs);
      }
    }, waitMs);
  }) as DebouncedFn<Args>;

  debounced.cancel = cancel;
  debounced.flush = flush;
  return debounced;
}

export interface ThrottledFn<Args extends readonly unknown[]> {
  (...args: Args): void;
  cancel(): void;
}

/**
 * Creates a throttled function that invokes `fn` at most once per `interval`
 * (leading + trailing call semantics).
 */
export function throttle<Args extends readonly unknown[]>(
  fn: (...args: Args) => void,
  interval: Duration,
): ThrottledFn<Args> {
  const intervalMs = parseDuration(interval);
  let lastRun = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let trailingArgs: Args | undefined;

  const cancel = (): void => {
    if (isNotUndefined(timer)) {
      clearTimeout(timer);
      timer = undefined;
    }
    trailingArgs = undefined;
  };

  const throttled = ((...args: Args): void => {
    const now = Date.now();
    const elapsed = now - lastRun;
    if (elapsed >= intervalMs) {
      cancel();
      lastRun = now;
      fn(...args);
      return;
    }
    trailingArgs = args;
    if (not(isNotUndefined(timer))) {
      timer = setTimeout(() => {
        const nextArgs = trailingArgs;
        timer = undefined;
        trailingArgs = undefined;
        lastRun = Date.now();
        if (isNotUndefined(nextArgs)) {
          fn(...nextArgs);
        }
      }, intervalMs - elapsed);
    }
  }) as ThrottledFn<Args>;

  throttled.cancel = cancel;
  return throttled;
}

export interface PollUntilOptions {
  /** Delay between polling attempts (default `"100ms"`). */
  readonly interval?: Duration;
  /** Maximum total wait before throwing `TimeoutError` (default `"10s"`). */
  readonly timeout?: Duration;
  /** Optional `AbortSignal` to cancel polling. */
  readonly signal?: AbortSignal;
}

/**
 * Repeatedly calls `fn` until `predicate(result)` returns `true`, or throws `TimeoutError`.
 */
export async function pollUntil<T>(
  fn: () => Promise<T> | T,
  predicate: (result: T) => boolean,
  options: PollUntilOptions = {},
): Promise<T> {
  const intervalMs = parseDuration(options.interval ?? "100ms");
  const timeoutMs = parseDuration(options.timeout ?? "10s");
  const deadline = Date.now() + timeoutMs;

  while (true) {
    if (options.signal?.aborted) {
      throw isError(options.signal.reason)
        ? options.signal.reason
        : new DOMException("The operation was aborted.", "AbortError");
    }

    const value = await fn();
    if (predicate(value)) {
      return value;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new TimeoutError(
        timeoutMs,
        `pollUntil timed out after ${timeoutMs}ms`,
      );
    }
    await sleep(Math.min(intervalMs, remaining), options.signal);
  }
}
