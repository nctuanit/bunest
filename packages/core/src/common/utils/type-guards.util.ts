/**
 * Primitive JavaScript value types.
 */
export type Primitive =
  string | number | boolean | bigint | symbol | null | undefined;

/**
 * JSON-serializable primitive value.
 */
export type JsonPrimitive = string | number | boolean | null;

/**
 * JSON-serializable array value.
 */
export type JsonArray = JsonValue[];

/**
 * JSON-serializable plain object value.
 */
export type JsonObject = { [key: string]: JsonValue | undefined };

/**
 * Any valid JSON-serializable value.
 */
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;

/**
 * Class constructor signature accepted by `isInstanceof()`.
 */
export type Constructor<T = unknown> = abstract new (...args: never[]) => T;

/**
 * Mapping from JavaScript `typeof` string tags to their corresponding TypeScript types.
 */
export interface TypeofMap {
  readonly string: string;
  readonly number: number;
  readonly bigint: bigint;
  readonly boolean: boolean;
  readonly symbol: symbol;
  readonly undefined: undefined;
  readonly object: object | null;
  readonly function: (...args: never[]) => unknown;
}

/**
 * Valid JavaScript `typeof` result tags.
 */
export type TypeofTag = keyof TypeofMap;

// ─── Core `typeof` & `instanceof` Guards (Direct & Curried) ──────────────────

/**
 * Checks whether a value's `typeof` matches a tag (or any tag in an array).
 *
 * Supports both direct and curried usage:
 * - Direct: `isTypeof(value, "string")` or `isTypeof(value, ["string", "number"])`
 * - Curried: `isTypeof("string")` -> `(value: unknown) => value is string`
 */
export function isTypeof<K extends TypeofTag>(
  type: K,
): (value: unknown) => value is TypeofMap[K];
export function isTypeof<const Ks extends readonly TypeofTag[]>(
  types: Ks,
): (value: unknown) => value is TypeofMap[Ks[number]];
export function isTypeof<K extends TypeofTag>(
  value: unknown,
  type: K,
): value is TypeofMap[K];
export function isTypeof<const Ks extends readonly TypeofTag[]>(
  value: unknown,
  types: Ks,
): value is TypeofMap[Ks[number]];
export function isTypeof(
  first: unknown,
  second?: TypeofTag | readonly TypeofTag[],
): boolean | ((value: unknown) => boolean) {
  if (arguments.length === 1) {
    const target = first as TypeofTag | readonly TypeofTag[];
    if (Array.isArray(target)) {
      return (value: unknown): boolean =>
        (target as readonly string[]).includes(typeof value);
    }
    return (value: unknown): boolean => typeof value === target;
  }
  if (Array.isArray(second)) {
    return (second as readonly string[]).includes(typeof first);
  }
  return typeof first === second;
}

/** Alias for `isTypeof`. */
export const isTypeOf = isTypeof;

/**
 * Checks whether a value is an instance of `ctor` (`value instanceof ctor`).
 *
 * Supports both direct and curried usage:
 * - Direct: `isInstanceof(value, Date)` -> narrows `value is Date`
 * - Curried: `isInstanceof(Date)` -> `(value: unknown) => value is Date`
 */
export function isInstanceof<C extends Constructor>(
  ctor: C,
): (value: unknown) => value is InstanceType<C>;
export function isInstanceof<C extends Constructor>(
  value: unknown,
  ctor: C,
): value is InstanceType<C>;
export function isInstanceof<C extends Constructor>(
  first: unknown,
  second?: C,
): boolean | ((value: unknown) => value is InstanceType<C>) {
  if (arguments.length === 1) {
    const ctor = first as C;
    return (value: unknown): value is InstanceType<C> => value instanceof ctor;
  }
  return first instanceof (second as C);
}

/** Alias for `isInstanceof`. */
export const isInstanceOf = isInstanceof;

// ─── Null / Undefined / Nullish Guards ───────────────────────────────────────

/**
 * Checks whether a value is strictly `undefined`.
 */
export function isUndefined(value: unknown): value is undefined {
  return value === undefined;
}

/**
 * Checks whether a value is strictly `null`.
 */
export function isNull(value: unknown): value is null {
  return value === null;
}

/**
 * Checks whether a value is strictly not `null`.
 */
export function isNotNull<T>(value: T | null): value is T {
  return value !== null;
}

/**
 * Checks whether a value is strictly not `undefined`.
 */
export function isNotUndefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

/**
 * Checks whether a value is `null` or `undefined`.
 */
export function isNullish(value: unknown): value is null | undefined {
  return isNull(value) || isUndefined(value);
}

/**
 * Checks whether a value is neither `null` nor `undefined`.
 * Useful with `Array.prototype.filter(isDefined)`.
 */
export function isDefined<T>(value: T | null | undefined): value is T {
  return !isNullish(value);
}

/**
 * Checks whether ANY argument is `null` or `undefined`.
 * Directly replaces `a === null || b === null || a === undefined || b === undefined`.
 */
export function isAnyNullish(...values: readonly unknown[]): boolean {
  return values.some(isNullish);
}

/**
 * Checks whether ALL arguments are `null` or `undefined`.
 */
export function isAllNullish(...values: readonly unknown[]): boolean {
  return values.length > 0 && values.every(isNullish);
}

/**
 * Checks whether ALL arguments are neither `null` nor `undefined`.
 */
export function isAllDefined(...values: readonly unknown[]): boolean {
  return values.every(isDefined);
}

/**
 * Checks whether ANY argument is strictly `null`.
 */
export function isAnyNull(...values: readonly unknown[]): boolean {
  return values.some(isNull);
}

/**
 * Checks whether ANY argument is strictly `undefined`.
 */
export function isAnyUndefined(...values: readonly unknown[]): boolean {
  return values.some(isUndefined);
}

// ─── Primitive & Built-In Type Guards ────────────────────────────────────────

/**
 * Checks whether a value is a `string`.
 */
export function isString(value: unknown): value is string {
  return isTypeof(value, "string");
}

/**
 * Checks whether a value is a non-empty `string` (length > 0 after trimming by default,
 * or raw length > 0 when `trim` is `false`).
 */
export function isNonEmptyString(value: unknown, trim = true): value is string {
  if (!isString(value)) {
    return false;
  }
  return trim ? value.trim().length > 0 : value.length > 0;
}

/**
 * Checks whether a value is a `number` and not `NaN`.
 */
export function isNumber(value: unknown): value is number {
  return isTypeof(value, "number") && !Number.isNaN(value);
}

/**
 * Checks whether a value is a finite `number` (excludes `NaN`, `Infinity`, `-Infinity`).
 */
export function isFiniteNumber(value: unknown): value is number {
  return isTypeof(value, "number") && Number.isFinite(value);
}

/**
 * Checks whether a value is a safe integer.
 */
export function isInteger(value: unknown): value is number {
  return isTypeof(value, "number") && Number.isInteger(value);
}

/**
 * Checks whether a value is a `boolean`.
 */
export function isBoolean(value: unknown): value is boolean {
  return isTypeof(value, "boolean");
}

/**
 * Checks whether a value is a `bigint`.
 */
export function isBigInt(value: unknown): value is bigint {
  return isTypeof(value, "bigint");
}

/**
 * Checks whether a value is a `symbol`.
 */
export function isSymbol(value: unknown): value is symbol {
  return isTypeof(value, "symbol");
}

/**
 * Checks whether a value is a JavaScript primitive (`string | number | boolean | bigint | symbol | null | undefined`).
 */
export function isPrimitive(value: unknown): value is Primitive {
  return (
    isNull(value) ||
    (!isTypeof(value, "object") && !isTypeof(value, "function"))
  );
}

/**
 * Checks whether a value is a callable function.
 */
export function isFunction(
  value: unknown,
): value is (...args: never[]) => unknown {
  return isTypeof(value, "function");
}

/**
 * Checks whether a value is a non-null, non-array object.
 */
export function isObject(value: unknown): value is Record<string, unknown> {
  return isTypeof(value, "object") && isNotNull(value) && !Array.isArray(value);
}

/**
 * Checks whether a value is a plain object literal (`Object.prototype` or `null` prototype).
 */
export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  if (!isObject(value)) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || isNull(proto);
}

/**
 * Checks whether a value is an array.
 */
export function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/**
 * Checks whether an array has at least one element and narrows it to a non-empty tuple.
 */
export function isNonEmptyArray<T>(
  value: readonly T[],
): value is readonly [T, ...T[]] {
  return value.length > 0;
}

/**
 * Checks whether a value is a `Date` instance.
 */
export function isDate(value: unknown): value is Date {
  return isInstanceof(value, Date);
}

/**
 * Checks whether a value is a `Date` instance with a valid timestamp (not `Invalid Date`).
 */
export function isValidDate(value: unknown): value is Date {
  return isDate(value) && !Number.isNaN(value.getTime());
}

/**
 * Checks whether a value is a `RegExp` instance.
 */
export function isRegExp(value: unknown): value is RegExp {
  return isInstanceof(value, RegExp);
}

/**
 * Checks whether a value is an `Error` instance.
 */
export function isError(value: unknown): value is Error {
  return isInstanceof(value, Error);
}

/**
 * Checks whether a value is a `PromiseLike` (thenable).
 */
export function isPromiseLike<T = unknown>(
  value: unknown,
): value is PromiseLike<T> {
  return (
    isNotNull(value) &&
    isTypeof(value, ["object", "function"]) &&
    isFunction((value as { then?: unknown }).then)
  );
}

/**
 * Checks whether a value is a `Map` instance.
 */
export function isMap(value: unknown): value is Map<unknown, unknown> {
  return isInstanceof(value, Map);
}

/**
 * Checks whether a value is a `Set` instance.
 */
export function isSet(value: unknown): value is Set<unknown> {
  return isInstanceof(value, Set);
}

/**
 * Checks whether `obj` has `key` as an own property and narrows `obj` accordingly.
 */
export function hasOwn<T extends object, K extends PropertyKey>(
  obj: T,
  key: K,
): obj is T & Record<K, unknown> {
  return Object.hasOwn(obj, key);
}
