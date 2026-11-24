import { type Duration, parseDuration } from "./duration.util";
import { include, not } from "./predicate.util";
import {
  isError,
  isFiniteNumber,
  isFunction,
  isInteger,
  isUndefined,
} from "./type-guards.util";

export type JitterMode = "full" | "equal" | "none";

export interface BackoffOptions {
  /** Base delay before the first retry (default `"200ms"`). */
  readonly delay?: Duration;
  /** Exponential multiplier per attempt (default `2`, must be >= 1). */
  readonly factor?: number;
  /** Maximum delay cap (default `"30s"`). */
  readonly maxDelay?: Duration;
  /** Jitter strategy (default `"equal"`). */
  readonly jitter?: JitterMode;
}

export interface ResolvedBackoff {
  readonly delay: number;
  readonly factor: number;
  readonly maxDelay: number;
  readonly jitter: JitterMode;
}

export type BackoffStrategy =
  BackoffOptions | ((attempt: number, error: unknown) => Duration);

export interface RetryOptions {
  /** Total attempts including the initial try (default `3`, must be >= 1). */
  readonly attempts?: number;
  /** Backoff configuration or dynamic delay callback. */
  readonly backoff?: BackoffStrategy;
  /** Return `false` to abort retrying immediately for a given error. */
  readonly retryIf?: (error: unknown, attempt: number) => boolean;
  /** Invoked before sleeping between failed attempts. */
  readonly onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  /** Optional `AbortSignal` to cancel sleeping/retrying. */
  readonly signal?: AbortSignal;
  /** Custom PRNG in `[0, 1)` for deterministic testing (default `Math.random`). */
  readonly random?: () => number;
}

const DEFAULT_BACKOFF: ResolvedBackoff = {
  delay: 200,
  factor: 2,
  maxDelay: 30_000,
  jitter: "equal",
};

const VALID_JITTERS: ReadonlySet<string> = new Set<JitterMode>([
  "full",
  "equal",
  "none",
]);

/**
 * Validates and resolves `BackoffOptions` into numeric millisecond defaults.
 */
export function resolveBackoff(options: BackoffOptions = {}): ResolvedBackoff {
  const delay = isUndefined(options.delay)
    ? DEFAULT_BACKOFF.delay
    : parseDuration(options.delay);
  const maxDelay = isUndefined(options.maxDelay)
    ? DEFAULT_BACKOFF.maxDelay
    : parseDuration(options.maxDelay);
  const factor = options.factor ?? DEFAULT_BACKOFF.factor;
  if (not(isFiniteNumber(factor)) || factor < 1) {
    throw new TypeError(
      `Invalid backoff factor ${factor}. Use a finite number >= 1.`,
    );
  }
  const jitter = options.jitter ?? DEFAULT_BACKOFF.jitter;
  if (not(include(VALID_JITTERS, jitter))) {
    throw new TypeError(
      `Invalid backoff jitter ${JSON.stringify(jitter)}. Use "full", "equal", or "none".`,
    );
  }
  return { delay, factor, maxDelay, jitter };
}

/**
 * Computes the retry backoff delay in milliseconds for a 1-based failed `attempt`.
 */
export function computeBackoffDelay(
  backoff: ResolvedBackoff,
  attempt: number,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(0, attempt - 1);
  const ceiling = Math.min(
    backoff.maxDelay,
    backoff.delay * backoff.factor ** exponent,
  );
  switch (backoff.jitter) {
    case "none":
      return Math.floor(ceiling);
    case "full":
      return Math.floor(random() * ceiling);
    case "equal":
      return Math.floor(ceiling / 2 + (random() * ceiling) / 2);
  }
}

/**
 * Sleeps for `duration` with clean `AbortSignal` cancellation and listener cleanup.
 */
export function sleep(duration: Duration, signal?: AbortSignal): Promise<void> {
  const ms = parseDuration(duration);
  if (signal?.aborted) {
    return Promise.reject(
      isError(signal.reason)
        ? signal.reason
        : new DOMException("The operation was aborted.", "AbortError"),
    );
  }
  if (ms === 0) {
    return Promise.resolve();
  }
  if (!signal) {
    return Bun.sleep(ms);
  }
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(
        isError(signal?.reason)
          ? signal.reason
          : new DOMException("The operation was aborted.", "AbortError"),
      );
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/**
 * Executes `fn` with configurable attempts, exponential backoff + jitter, `retryIf`,
 * and `AbortSignal` support.
 */
export async function retry<T>(
  fn: (attempt: number) => Promise<T> | T,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? 3;
  if (not(isInteger(attempts)) || attempts < 1) {
    throw new TypeError(
      `retry: attempts must be a whole number >= 1 (got ${attempts})`,
    );
  }

  const resolvedBackoff = isFunction(options.backoff)
    ? options.backoff
    : resolveBackoff(options.backoff);
  const random = options.random ?? Math.random;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (options.signal?.aborted) {
      throw isError(options.signal.reason)
        ? options.signal.reason
        : new DOMException("The operation was aborted.", "AbortError");
    }

    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) {
        break;
      }
      if (options.retryIf && not(options.retryIf(error, attempt))) {
        break;
      }
      const delayMs = isFunction(resolvedBackoff)
        ? parseDuration(resolvedBackoff(attempt, error))
        : computeBackoffDelay(resolvedBackoff, attempt, random);

      options.onRetry?.(error, attempt, delayMs);
      if (delayMs > 0) {
        await sleep(delayMs, options.signal);
      }
    }
  }

  throw lastError;
}
