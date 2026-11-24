import type {
  Duration,
  StorageBackoffOptions,
  StorageRetryOptions,
} from "../interfaces/storage-types";
import { toMs } from "../utils/duration.util";

export interface ResolvedRetry {
  attempts: number;
  delay: (attempt: number, error: unknown) => number;
  retryIf?: (error: unknown, attempt: number) => boolean;
}

export function duration(value: Duration, option: string): number {
  try {
    return toMs(value);
  } catch (err) {
    throw new RangeError(
      `Invalid duration for "${option}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function buildBackoffDelay(
  backoff: StorageBackoffOptions | undefined,
): (attempt: number) => number {
  const baseMs = backoff?.delay !== undefined ? toMs(backoff.delay) : 100;
  const factor = backoff?.factor ?? 2;
  const maxMs =
    backoff?.maxDelay !== undefined ? toMs(backoff.maxDelay) : 20_000;
  const jitter = backoff?.jitter ?? "full";

  return (attempt: number): number => {
    const raw = Math.min(
      maxMs,
      baseMs * Math.pow(factor, Math.max(0, attempt - 1)),
    );
    if (jitter === "none") {
      return raw;
    }
    if (jitter === "equal") {
      return raw / 2 + Math.random() * (raw / 2);
    }
    return Math.random() * raw;
  };
}

export function resolveRetry(
  input: number | false | StorageRetryOptions | undefined,
  owner: string,
): ResolvedRetry {
  if (input === false) {
    return {
      attempts: 1,
      delay: () => 0,
    };
  }
  if (input === undefined) {
    return {
      attempts: 3,
      delay: buildBackoffDelay(undefined),
    };
  }
  if (typeof input === "number") {
    if (!Number.isInteger(input) || input < 1) {
      throw new RangeError(`${owner} retry attempts must be an integer >= 1`);
    }
    return {
      attempts: input,
      delay: buildBackoffDelay(undefined),
    };
  }
  const attempts = input.attempts ?? 3;
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new RangeError(`${owner} retry.attempts must be an integer >= 1`);
  }
  const delay =
    typeof input.backoff === "function"
      ? (attempt: number, error: unknown) =>
          toMs(
            (input.backoff as (a: number, e: unknown) => Duration)(
              attempt,
              error,
            ),
          )
      : buildBackoffDelay(input.backoff);
  return {
    attempts,
    delay,
    ...(input.retryIf ? { retryIf: input.retryIf } : {}),
  };
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  if (signal?.aborted) {
    return Promise.reject(
      signal.reason ?? new DOMException("Aborted", "AbortError"),
    );
  }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
