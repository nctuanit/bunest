import { TimeoutError } from "./async.util";
import { type Duration, parseDuration } from "./duration.util";

export interface TapAsyncIterableOptions {
  /**
   * Invoked when the underlying `AsyncIterable` completes normally without error.
   */
  readonly onComplete?: () => void | Promise<void>;
  /**
   * Invoked if the underlying `AsyncIterable` or `sideEffect` throws an error.
   */
  readonly onError?: (error: unknown) => void | Promise<void>;
  /**
   * Always invoked when iteration ends (completion, error, or early consumer break).
   */
  readonly onFinally?: () => void | Promise<void>;
}

export interface StreamTimeoutOptions {
  /**
   * Timeout mode for `AsyncIterable` streams:
   * - `"chunk"` (default): each individual chunk must arrive within `duration`.
   * - `"total"`: the entire stream must finish within `duration`.
   * @default "chunk"
   */
  readonly mode?: "chunk" | "total";
  /**
   * Custom error message passed to `TimeoutError` when the timeout elapses.
   */
  readonly message?: string;
  /**
   * Optional factory returning a custom error (e.g., `RequestTimeoutException`) on timeout.
   */
  readonly onTimeout?: (timeoutMs: number) => Error;
}

export interface PromiseTimeoutOptions {
  /**
   * Custom error message passed to `TimeoutError` when the timeout elapses.
   */
  readonly message?: string;
  /**
   * Optional factory returning a custom error (e.g., `RequestTimeoutException`) on timeout.
   */
  readonly onTimeout?: (timeoutMs: number) => Error;
}

function isAsyncIterable<T>(value: unknown): value is AsyncIterable<T> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === "function"
  );
}

/**
 * Lazily transforms each yielded item of an `AsyncIterable` stream (sync or async mapper),
 * enabling ergonomic SSE and streaming response transformation inside Promise interceptors
 * without RxJS.
 */
export async function* mapAsyncIterable<T, R>(
  iterable: AsyncIterable<T>,
  mapper: (chunk: T, index: number) => R | Promise<R>,
): AsyncGenerator<R, void, undefined> {
  let index = 0;
  for await (const chunk of iterable) {
    yield await mapper(chunk, index++);
  }
}

/**
 * Lazily observes each yielded item of an `AsyncIterable` stream without altering
 * yielded values, with optional `onComplete`, `onError`, and `onFinally` lifecycle hooks.
 */
export async function* tapAsyncIterable<T>(
  iterable: AsyncIterable<T>,
  sideEffect: (chunk: T, index: number) => void | Promise<void>,
  options: TapAsyncIterableOptions = {},
): AsyncGenerator<T, void, undefined> {
  let index = 0;
  try {
    for await (const chunk of iterable) {
      await sideEffect(chunk, index++);
      yield chunk;
    }
    if (options.onComplete) {
      await options.onComplete();
    }
  } catch (error) {
    if (options.onError) {
      await options.onError(error);
    }
    throw error;
  } finally {
    if (options.onFinally) {
      await options.onFinally();
    }
  }
}

async function racePromiseWithTimeout<T>(
  promise: Promise<T>,
  ms: number,
  options: PromiseTimeoutOptions,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        options.onTimeout
          ? options.onTimeout(ms)
          : new TimeoutError(ms, options.message),
      );
    }, ms);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function* iterateWithTimeout<T>(
  iterable: AsyncIterable<T>,
  ms: number,
  options: StreamTimeoutOptions,
): AsyncGenerator<T, void, undefined> {
  const mode = options.mode ?? "chunk";
  const deadline = mode === "total" ? Date.now() + ms : 0;
  const iterator = iterable[Symbol.asyncIterator]();
  let timedOut = false;

  const createTimeoutError = (): Error =>
    options.onTimeout
      ? options.onTimeout(ms)
      : new TimeoutError(ms, options.message);

  try {
    while (true) {
      const remainingMs = mode === "total" ? deadline - Date.now() : ms;
      if (remainingMs <= 0) {
        timedOut = true;
        throw createTimeoutError();
      }

      let timer: ReturnType<typeof setTimeout> | undefined;
      let fired = false;
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          fired = true;
          timedOut = true;
          reject(createTimeoutError());
        }, remainingMs);
      });

      let result: IteratorResult<T>;
      try {
        result = await Promise.race([iterator.next(), timeoutPromise]);
      } finally {
        if (timer !== undefined && !fired) {
          clearTimeout(timer);
        }
      }

      if (result.done) {
        return;
      }
      yield result.value;
    }
  } finally {
    if (typeof iterator.return === "function") {
      if (timedOut) {
        // Avoid deadlocking when an async generator is suspended on a hung `next()`.
        void Promise.resolve(iterator.return()).catch(() => {});
      } else {
        await iterator.return();
      }
    }
  }
}

/**
 * Enforces a timeout on either a `Promise<T>` or an `AsyncIterable<T>` stream.
 *
 * - For `Promise<T>`: races against `duration`, always clearing its timer on settlement.
 * - For `AsyncIterable<T>`: guards each chunk (default `mode: "chunk"`) or the full
 *   stream (`mode: "total"`), rejecting with `TimeoutError` (or `onTimeout`) if exceeded.
 */
export function withTimeout<T>(
  source: Promise<T>,
  duration: Duration,
  messageOrOptions?: string | PromiseTimeoutOptions,
): Promise<T>;
export function withTimeout<T>(
  source: AsyncIterable<T>,
  duration: Duration,
  messageOrOptions?: string | StreamTimeoutOptions,
): AsyncGenerator<T, void, undefined>;
export function withTimeout<T>(
  source: Promise<T> | AsyncIterable<T>,
  duration: Duration,
  messageOrOptions?: string | StreamTimeoutOptions,
): Promise<T> | AsyncGenerator<T, void, undefined> {
  const ms = parseDuration(duration);
  const options: StreamTimeoutOptions =
    typeof messageOrOptions === "string"
      ? { message: messageOrOptions }
      : (messageOrOptions ?? {});

  if (isAsyncIterable<T>(source)) {
    return iterateWithTimeout(source, ms, options);
  }
  return racePromiseWithTimeout(source, ms, options);
}
