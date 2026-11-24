import {
  hasOwn,
  isArray,
  isFunction,
  isInstanceof,
  isNullish,
  isString,
  isTypeof,
} from "./type-guards.util";

// ─── Logical Predicate Combinators (`not`, `and`, `or`) ──────────────────────

/**
 * Negates either a boolean value or a predicate / TypeScript type guard.
 *
 * - Boolean: `not(isReady)` -> `!isReady`
 * - Type guard: `not(isNull)` -> `<V>(v: V) => v is Exclude<V, null>`
 * - Predicate: `not((n: number) => n > 0)` -> `(n: number) => boolean`
 */
export function not<T, U extends T>(
  predicate: (value: T) => value is U,
): <V extends T>(value: V) => value is Exclude<V, U>;
export function not<Args extends readonly unknown[]>(
  predicate: (...args: Args) => boolean,
): (...args: Args) => boolean;
export function not(value: boolean): boolean;
export function not(
  valueOrPredicate: boolean | ((...args: readonly unknown[]) => boolean),
): boolean | ((...args: readonly unknown[]) => boolean) {
  if (isFunction(valueOrPredicate)) {
    return (...args: readonly unknown[]): boolean =>
      !(valueOrPredicate as (...a: readonly unknown[]) => boolean)(...args);
  }
  return !valueOrPredicate;
}

/**
 * Combines predicates with logical AND (short-circuiting).
 * Preserves TypeScript intersection narrowing when combining two type guards.
 */
export function and<T, A extends T, B extends T>(
  first: (value: T) => value is A,
  second: (value: T) => value is B,
): (value: T) => value is A & B;
export function and<T>(
  ...predicates: readonly ((value: T) => boolean)[]
): (value: T) => boolean;
export function and<T>(
  ...predicates: readonly ((value: T) => boolean)[]
): (value: T) => boolean {
  return (value: T): boolean => predicates.every((pred) => pred(value));
}

/**
 * Combines predicates with logical OR (short-circuiting).
 * Preserves TypeScript union narrowing when combining type guards (e.g. `or(isNull, isUndefined)`).
 */
export function or<T, A extends T, B extends T>(
  first: (value: T) => value is A,
  second: (value: T) => value is B,
): (value: T) => value is A | B;
export function or<T, A extends T, B extends T, C extends T>(
  first: (value: T) => value is A,
  second: (value: T) => value is B,
  third: (value: T) => value is C,
): (value: T) => value is A | B | C;
export function or<T>(
  ...predicates: readonly ((value: T) => boolean)[]
): (value: T) => boolean;
export function or<T>(
  ...predicates: readonly ((value: T) => boolean)[]
): (value: T) => boolean {
  return (value: T): boolean => predicates.some((pred) => pred(value));
}

// ─── Membership & Inclusion Helpers (`include`, `isOneOf`, `isEqual`) ────────

function checkInclude(source: unknown, target: unknown): boolean {
  if (isNullish(source)) {
    return false;
  }
  if (isString(source)) {
    return isString(target) && source.includes(target);
  }
  if (isArray(source)) {
    return source.includes(target);
  }
  if (isInstanceof(source, Set) || isInstanceof(source, Map)) {
    return source.has(target);
  }
  if (
    isTypeof(source, "object") &&
    isTypeof(target, ["string", "number", "symbol"])
  ) {
    return hasOwn(source as object, target as PropertyKey);
  }
  return false;
}

/**
 * Checks whether `source` contains `target`.
 * Supports `string` (substring), `Array` (element with type narrowing),
 * `Set` (member), `Map` (key), and plain objects (own property key).
 *
 * Also supports curried 1-argument usage: `items.filter(include("foo"))`.
 */
export function include(source: string, search: string): boolean;
export function include<T>(source: readonly T[], item: unknown): item is T;
export function include<T>(source: ReadonlySet<T>, item: unknown): item is T;
export function include<K>(
  source: ReadonlyMap<K, unknown>,
  key: unknown,
): key is K;
export function include<T extends object, K extends PropertyKey>(
  source: T,
  key: K,
): source is T & Record<K, unknown>;
export function include(target: unknown): (source: unknown) => boolean;
export function include(
  first: unknown,
  second?: unknown,
): boolean | ((source: unknown) => boolean) {
  if (arguments.length === 1) {
    return (source: unknown): boolean => checkInclude(source, first);
  }
  return checkInclude(first, second);
}

/** Alias for `include`. */
export const includes = include;

/**
 * Checks whether a value is a member of `allowed` (`readonly T[]` or `ReadonlySet<T>`)
 * and narrows its type to `T`.
 *
 * Supports both direct and curried usage:
 * - Direct: `isOneOf(["asc", "desc"] as const, value)`
 * - Curried: `ternaryFor(v).when(isOneOf(["asc", "desc"] as const), ...)`
 */
export function isOneOf<const T>(
  allowed: readonly T[] | ReadonlySet<T>,
): (value: unknown) => value is T;
export function isOneOf<const T>(
  allowed: readonly T[] | ReadonlySet<T>,
  value: unknown,
): value is T;
export function isOneOf<T>(
  allowed: readonly T[] | ReadonlySet<T>,
  value?: unknown,
): boolean | ((candidate: unknown) => candidate is T) {
  const check = (candidate: unknown): candidate is T =>
    isInstanceof(allowed, Set)
      ? allowed.has(candidate as T)
      : (allowed as readonly unknown[]).includes(candidate);

  if (arguments.length === 1) {
    return check;
  }
  return check(value);
}

/**
 * Strict equality check (`a === b`, treating `NaN === NaN`).
 * Supports both direct `isEqual(a, b)` and curried `isEqual(expected)` predicate usage.
 */
export function isEqual<const T>(expected: T): (value: unknown) => value is T;
export function isEqual<const T>(value: unknown, expected: T): value is T;
export function isEqual(
  first: unknown,
  second?: unknown,
): boolean | ((value: unknown) => boolean) {
  const eq = (a: unknown, b: unknown): boolean =>
    a === b ||
    (isTypeof(a, "number") &&
      isTypeof(b, "number") &&
      Number.isNaN(a) &&
      Number.isNaN(b));

  if (arguments.length === 1) {
    return (value: unknown): boolean => eq(value, first);
  }
  return eq(first, second);
}
