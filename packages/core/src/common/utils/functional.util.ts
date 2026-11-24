import { include, not } from "./predicate.util";
import { LruCache } from "./structures.util";
import {
  isError,
  isFunction,
  isInteger,
  isNotUndefined,
  isNullish,
  isString,
} from "./type-guards.util";

/**
 * Returns the input value unchanged.
 */
export function identity<T>(value: T): T {
  return value;
}

/**
 * A no-operation function.
 */
export function noop(): void {
  // intentionally empty
}

/**
 * Invokes a side-effect `fn` on a value and returns the original value unchanged.
 * Ideal for logging or inspection inside `pipe(...)` pipelines.
 */
export function tap<T>(fn: (value: T) => void): (value: T) => T {
  return (value: T): T => {
    fn(value);
    return value;
  };
}

/**
 * Wraps `fn` so it is invoked at most once; subsequent calls return the cached result.
 * If the first call throws, the function can be retried on subsequent calls.
 */
export function once<Args extends readonly unknown[], R>(
  fn: (...args: Args) => R,
): (...args: Args) => R {
  let called = false;
  let cached: R;
  return (...args: Args): R => {
    if (!called) {
      cached = fn(...args);
      called = true;
    }
    return cached;
  };
}

export interface MemoizeOptions<K> {
  /** Maximum number of cached entries (FIFO eviction when exceeded). */
  readonly maxSize?: number;
  /** Custom cache key extractor (defaults to the argument itself). */
  readonly keyFn?: (arg: K) => unknown;
}

export interface MemoizedFn<K, R> {
  (arg: K): R;
  clear(): void;
  delete(arg: K): boolean;
  readonly size: number;
}

/**
 * Memoizes a single-argument function with optional bounded cache size and custom key selector.
 */
export function memoize<K, R>(
  fn: (arg: K) => R,
  options: MemoizeOptions<K> = {},
): MemoizedFn<K, R> {
  const { maxSize, keyFn } = options;

  if (isNotUndefined(maxSize) && (not(isInteger(maxSize)) || maxSize < 1)) {
    throw new RangeError(
      `memoize: maxSize must be a positive integer (got ${maxSize})`,
    );
  }

  const bounded = isNotUndefined(maxSize)
    ? new LruCache<unknown, { value: R }>({ maxSize })
    : undefined;
  const unbounded = bounded ? undefined : new Map<unknown, R>();

  const resolveKey = (arg: K): unknown => (keyFn ? keyFn(arg) : arg);

  const memoized = ((arg: K): R => {
    const key = resolveKey(arg);
    if (bounded) {
      const hit = bounded.get(key);
      if (isNotUndefined(hit)) {
        return hit.value;
      }
      const result = fn(arg);
      bounded.set(key, { value: result });
      return result;
    }
    if (include(unbounded!, key)) {
      return unbounded!.get(key) as R;
    }
    const result = fn(arg);
    unbounded!.set(key, result);
    return result;
  }) as MemoizedFn<K, R>;

  memoized.clear = () => (bounded ? bounded.clear() : unbounded!.clear());
  memoized.delete = (arg: K) => {
    const key = resolveKey(arg);
    return bounded ? bounded.delete(key) : unbounded!.delete(key);
  };
  Object.defineProperty(memoized, "size", {
    get: () => (bounded ? bounded.size : unbounded!.size),
    enumerable: true,
  });

  return memoized;
}

// ─── Pipe & Flow ─────────────────────────────────────────────────────────────

/**
 * Pipes a value left-to-right through a sequence of unary transformation functions.
 */
export function pipe<A>(a: A): A;
export function pipe<A, B>(a: A, ab: (a: A) => B): B;
export function pipe<A, B, C>(a: A, ab: (a: A) => B, bc: (b: B) => C): C;
export function pipe<A, B, C, D>(
  a: A,
  ab: (a: A) => B,
  bc: (b: B) => C,
  cd: (c: C) => D,
): D;
export function pipe<A, B, C, D, E>(
  a: A,
  ab: (a: A) => B,
  bc: (b: B) => C,
  cd: (c: C) => D,
  de: (d: D) => E,
): E;
export function pipe<A, B, C, D, E, F>(
  a: A,
  ab: (a: A) => B,
  bc: (b: B) => C,
  cd: (c: C) => D,
  de: (d: D) => E,
  ef: (e: E) => F,
): F;
export function pipe<A, B, C, D, E, F, G>(
  a: A,
  ab: (a: A) => B,
  bc: (b: B) => C,
  cd: (c: C) => D,
  de: (d: D) => E,
  ef: (e: E) => F,
  fg: (f: F) => G,
): G;
export function pipe<A, B, C, D, E, F, G, H>(
  a: A,
  ab: (a: A) => B,
  bc: (b: B) => C,
  cd: (c: C) => D,
  de: (d: D) => E,
  ef: (e: E) => F,
  fg: (f: F) => G,
  gh: (g: G) => H,
): H;
export function pipe<A, B, C, D, E, F, G, H, I>(
  a: A,
  ab: (a: A) => B,
  bc: (b: B) => C,
  cd: (c: C) => D,
  de: (d: D) => E,
  ef: (e: E) => F,
  fg: (f: F) => G,
  gh: (g: G) => H,
  hi: (h: H) => I,
): I;
export function pipe(
  value: unknown,
  ...fns: readonly ((arg: unknown) => unknown)[]
): unknown {
  let acc = value;
  for (const fn of fns) {
    acc = fn(acc);
  }
  return acc;
}

/**
 * Composes functions left-to-right into a reusable pipeline function.
 */
export function flow<Args extends readonly unknown[], B>(
  ab: (...args: Args) => B,
): (...args: Args) => B;
export function flow<Args extends readonly unknown[], B, C>(
  ab: (...args: Args) => B,
  bc: (b: B) => C,
): (...args: Args) => C;
export function flow<Args extends readonly unknown[], B, C, D>(
  ab: (...args: Args) => B,
  bc: (b: B) => C,
  cd: (c: C) => D,
): (...args: Args) => D;
export function flow<Args extends readonly unknown[], B, C, D, E>(
  ab: (...args: Args) => B,
  bc: (b: B) => C,
  cd: (c: C) => D,
  de: (d: D) => E,
): (...args: Args) => E;
export function flow<Args extends readonly unknown[], B, C, D, E, F>(
  ab: (...args: Args) => B,
  bc: (b: B) => C,
  cd: (c: C) => D,
  de: (d: D) => E,
  ef: (e: E) => F,
): (...args: Args) => F;
export function flow<Args extends readonly unknown[], B, C, D, E, F, G>(
  ab: (...args: Args) => B,
  bc: (b: B) => C,
  cd: (c: C) => D,
  de: (d: D) => E,
  ef: (e: E) => F,
  fg: (f: F) => G,
): (...args: Args) => G;
export function flow<Args extends readonly unknown[], B, C, D, E, F, G, H>(
  ab: (...args: Args) => B,
  bc: (b: B) => C,
  cd: (c: C) => D,
  de: (d: D) => E,
  ef: (e: E) => F,
  fg: (f: F) => G,
  gh: (g: G) => H,
): (...args: Args) => H;
export function flow(
  first: (...args: readonly unknown[]) => unknown,
  ...rest: readonly ((arg: unknown) => unknown)[]
): (...args: readonly unknown[]) => unknown {
  return (...args: readonly unknown[]): unknown => {
    let acc = first(...args);
    for (const fn of rest) {
      acc = fn(acc);
    }
    return acc;
  };
}

// ─── Result<T, E> ────────────────────────────────────────────────────────────

export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}

export type Result<T, E = Error> = Ok<T> | Err<E>;

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok;
}

export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return !result.ok;
}

/**
 * Extracts the `Ok` value or throws the contained error if `Err`.
 */
export function unwrapResult<T, E>(result: Result<T, E>): T {
  if (result.ok) {
    return result.value;
  }
  throw result.error;
}

/**
 * Extracts the `Ok` value or returns `fallback` (or calls `fallback(error)` if a function).
 */
export function unwrapResultOr<T, E, D>(
  result: Result<T, E>,
  fallback: D | ((error: E) => D),
): T | D {
  if (result.ok) {
    return result.value;
  }
  return isFunction(fallback)
    ? (fallback as (error: E) => D)(result.error)
    : fallback;
}

/**
 * Maps the `Ok` value of a `Result`, passing `Err` through unchanged.
 */
export function mapResult<T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => U,
): Result<U, E> {
  return result.ok ? ok(fn(result.value)) : result;
}

/**
 * Chains a fallible operation on an `Ok` result.
 */
export function flatMapResult<T, U, E1, E2>(
  result: Result<T, E1>,
  fn: (value: T) => Result<U, E2>,
): Result<U, E1 | E2> {
  return result.ok ? fn(result.value) : result;
}

/**
 * Maps the `Err` error of a `Result`, passing `Ok` through unchanged.
 */
export function mapResultErr<T, E1, E2>(
  result: Result<T, E1>,
  fn: (error: E1) => E2,
): Result<T, E2> {
  return result.ok ? result : err(fn(result.error));
}

/**
 * Folds a `Result<T, E>` by invoking either `ok` or `err`.
 */
export function matchResult<T, E, R1, R2>(
  result: Result<T, E>,
  handlers: {
    readonly ok: (value: T) => R1;
    readonly err: (error: E) => R2;
  },
): R1 | R2 {
  return result.ok ? handlers.ok(result.value) : handlers.err(result.error);
}

// ─── Option<T> ───────────────────────────────────────────────────────────────

export interface Some<T> {
  readonly some: true;
  readonly value: T;
}

export interface None {
  readonly some: false;
}

export type Option<T> = Some<T> | None;

const NONE_SINGLETON: None = Object.freeze({ some: false as const });

export function some<T>(value: T): Some<T> {
  return { some: true, value };
}

export function none(): None {
  return NONE_SINGLETON;
}

export function isSome<T>(option: Option<T>): option is Some<T> {
  return option.some;
}

export function isNone<T>(option: Option<T>): option is None {
  return not(option.some);
}

/**
 * Converts a nullable value (`T | null | undefined`) into `Some<T>` or `None`.
 */
export function fromNullable<T>(value: T | null | undefined): Option<T> {
  return isNullish(value) ? none() : some(value);
}

/**
 * Maps the contained value of a `Some<T>`, passing `None` through unchanged.
 */
export function mapOption<T, U>(
  option: Option<T>,
  fn: (value: T) => U,
): Option<U> {
  return option.some ? some(fn(option.value)) : none();
}

/**
 * Chains an option-returning operation on `Some<T>`.
 */
export function flatMapOption<T, U>(
  option: Option<T>,
  fn: (value: T) => Option<U>,
): Option<U> {
  return option.some ? fn(option.value) : none();
}

/**
 * Extracts the `Some` value or returns `fallback` (or calls `fallback()` if a function).
 */
export function unwrapOptionOr<T, D>(
  option: Option<T>,
  fallback: D | (() => D),
): T | D {
  if (option.some) {
    return option.value;
  }
  return isFunction(fallback) ? (fallback as () => D)() : fallback;
}

// ─── Error & Control-Flow Helpers ────────────────────────────────────────────

/**
 * Normalizes any thrown value into an `Error` instance.
 */
export function ensureError(value: unknown): Error {
  if (isError(value)) {
    return value;
  }
  if (isString(value)) {
    return new Error(value);
  }
  try {
    return new Error(JSON.stringify(value) ?? String(value), { cause: value });
  } catch {
    return new Error(String(value), { cause: value });
  }
}

/**
 * Executes a synchronous function and captures any thrown error into a `Result`.
 */
export function tryCatch<T, E = Error>(
  fn: () => T,
  mapError?: (error: unknown) => E,
): Result<T, E> {
  try {
    return ok(fn());
  } catch (thrown) {
    const mapped = mapError ? mapError(thrown) : (ensureError(thrown) as E);
    return err(mapped);
  }
}

/**
 * Executes an async function and captures any rejection or synchronous throw into a `Result`.
 */
export async function tryCatchAsync<T, E = Error>(
  fn: () => Promise<T>,
  mapError?: (error: unknown) => E,
): Promise<Result<T, E>> {
  try {
    return ok(await fn());
  } catch (thrown) {
    const mapped = mapError ? mapError(thrown) : (ensureError(thrown) as E);
    return err(mapped);
  }
}

/**
 * Compile-time exhaustiveness helper that throws at runtime if reached.
 */
export function assertNever(value: never, message?: string): never {
  throw new Error(
    message ?? `Unexpected value in exhaustive check: ${String(value)}`,
  );
}

/**
 * Asserts that `condition` is truthy, narrowing its type or throwing an `Error`.
 */
export function invariant(
  condition: unknown,
  message: string | (() => string),
): asserts condition {
  if (!condition) {
    const resolved = isFunction(message) ? message() : message;
    throw new Error(resolved);
  }
}
