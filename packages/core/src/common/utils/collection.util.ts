import { include, not } from "./predicate.util";
import {
  isArray,
  isDate,
  isDefined,
  isInteger,
  isMap,
  isNullish,
  isPlainObject,
  isSet,
  isString,
  isUndefined,
} from "./type-guards.util";

/**
 * Splits an array into consecutive chunks of length `size`.
 * Throws a `RangeError` if `size` is not a positive integer.
 */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (not(isInteger(size)) || size < 1) {
    throw new RangeError(
      `chunk: size must be a positive integer (got ${size})`,
    );
  }
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size));
  }
  return result;
}

/**
 * Groups elements of an iterable into a dictionary keyed by `keyFn`.
 */
export function groupBy<T, K extends PropertyKey>(
  items: readonly T[],
  keyFn: (item: T, index: number) => K,
): Partial<Record<K, T[]>> {
  const result = Object.create(null) as Partial<Record<K, T[]>>;
  for (let i = 0; i < items.length; i++) {
    const item = items[i] as T;
    const key = keyFn(item, i);
    const bucket = result[key];
    if (bucket) {
      bucket.push(item);
    } else {
      result[key] = [item];
    }
  }
  return { ...result };
}

/**
 * Indexes elements into a dictionary keyed by `keyFn`.
 * Later items overwrite earlier items when keys collide.
 */
export function indexBy<T, K extends PropertyKey>(
  items: readonly T[],
  keyFn: (item: T, index: number) => K,
): Partial<Record<K, T>> {
  const result = Object.create(null) as Partial<Record<K, T>>;
  for (let i = 0; i < items.length; i++) {
    const item = items[i] as T;
    result[keyFn(item, i)] = item;
  }
  return { ...result };
}

/**
 * Returns a new array containing only unique values (preserving first-seen order).
 */
export function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

/**
 * Returns a new array deduplicated by the key returned by `keyFn` (preserving first-seen order).
 */
export function uniqueBy<T, K>(
  items: readonly T[],
  keyFn: (item: T, index: number) => K,
): T[] {
  const seen = new Set<K>();
  const result: T[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i] as T;
    const key = keyFn(item, i);
    if (not(include(seen, key))) {
      seen.add(key);
      result.push(item);
    }
  }
  return result;
}

/**
 * Splits `items` into two arrays: `[matched, unmatched]`.
 * Supports TypeScript type-guard predicates for narrowed tuple types.
 */
export function partition<T, U extends T>(
  items: readonly T[],
  predicate: (item: T, index: number) => item is U,
): [U[], Exclude<T, U>[]];
export function partition<T>(
  items: readonly T[],
  predicate: (item: T, index: number) => boolean,
): [T[], T[]];
export function partition<T>(
  items: readonly T[],
  predicate: (item: T, index: number) => boolean,
): [T[], T[]] {
  const truthy: T[] = [];
  const falsy: T[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i] as T;
    if (predicate(item, i)) {
      truthy.push(item);
    } else {
      falsy.push(item);
    }
  }
  return [truthy, falsy];
}

/**
 * Returns a new array with `null` and `undefined` entries removed.
 */
export function compact<T>(items: readonly (T | null | undefined)[]): T[] {
  return items.filter(isDefined);
}

/**
 * Counts occurrences of elements grouped by `keyFn`.
 */
export function countBy<T, K extends PropertyKey>(
  items: readonly T[],
  keyFn: (item: T, index: number) => K,
): Partial<Record<K, number>> {
  const counts = Object.create(null) as Partial<Record<K, number>>;
  for (let i = 0; i < items.length; i++) {
    const item = items[i] as T;
    const key = keyFn(item, i);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return { ...counts };
}

/**
 * Returns a new sorted copy of `items` ordered by `selector` without mutating the input.
 */
export function sortBy<T>(
  items: readonly T[],
  selector: (item: T) => number | string | Date,
  order: "asc" | "desc" = "asc",
): T[] {
  const multiplier = order === "desc" ? -1 : 1;
  return [...items].sort((a, b) => {
    const va = selector(a);
    const vb = selector(b);
    const na = isDate(va) ? va.getTime() : va;
    const nb = isDate(vb) ? vb.getTime() : vb;
    if (na === nb) {
      return 0;
    }
    return (na < nb ? -1 : 1) * multiplier;
  });
}

/**
 * Generates an array of numbers from `start` (inclusive) to `end` (exclusive) by `step`.
 * When called with a single argument `range(n)`, generates `[0, 1, ..., n - 1]`.
 */
export function range(start: number, end?: number, step?: number): number[] {
  const actualStart = isUndefined(end) ? 0 : start;
  const actualEnd = isUndefined(end) ? start : end;
  const actualStep = step ?? (actualStart <= actualEnd ? 1 : -1);

  if (actualStep === 0 || !Number.isFinite(actualStep)) {
    throw new RangeError(
      `range: step must be a non-zero finite number (got ${actualStep})`,
    );
  }

  const result: number[] = [];
  if (actualStep > 0) {
    for (let v = actualStart; v < actualEnd; v += actualStep) {
      result.push(v);
    }
  } else {
    for (let v = actualStart; v > actualEnd; v += actualStep) {
      result.push(v);
    }
  }
  return result;
}

/**
 * Pairs corresponding elements from two arrays up to the length of the shorter array.
 */
export function zip<A, B>(a: readonly A[], b: readonly B[]): Array<[A, B]> {
  const len = Math.min(a.length, b.length);
  const result: Array<[A, B]> = new Array(len);
  for (let i = 0; i < len; i++) {
    result[i] = [a[i] as A, b[i] as B];
  }
  return result;
}

/**
 * Computes the numeric sum of `selector(item)` across `items`.
 */
export function sumBy<T>(
  items: readonly T[],
  selector: (item: T, index: number) => number,
): number {
  let total = 0;
  for (let i = 0; i < items.length; i++) {
    total += selector(items[i] as T, i);
  }
  return total;
}

/**
 * Normalizes a value into an array:
 * - `null | undefined` -> `[]`
 * - `readonly T[]` -> shallow copy `T[]`
 * - single value `T` -> `[value]`
 */
export function toArray<T>(
  value: T | readonly T[] | null | undefined,
): T[] {
  if (isNullish(value)) {
    return [];
  }
  return isArray(value) ? [...(value as readonly T[])] : [value as T];
}

/**
 * Returns the first element of an array, or `undefined` if empty.
 */
export function first<T>(items: readonly T[]): T | undefined {
  return items[0];
}

/**
 * Returns the last element of an array, or `undefined` if empty.
 */
export function last<T>(items: readonly T[]): T | undefined {
  return items.length > 0 ? items[items.length - 1] : undefined;
}

/**
 * Returns elements present in `a` that are not present in `b` (preserving order).
 */
export function difference<T>(a: readonly T[], b: readonly T[]): T[] {
  const excluded = new Set(b);
  return a.filter((item) => not(include(excluded, item)));
}

/**
 * Returns unique elements present in both `a` and `b` (preserving `a`'s order).
 */
export function intersection<T>(a: readonly T[], b: readonly T[]): T[] {
  const bSet = new Set(b);
  const seen = new Set<T>();
  const result: T[] = [];
  for (const item of a) {
    if (include(bSet, item) && not(include(seen, item))) {
      seen.add(item);
      result.push(item);
    }
  }
  return result;
}

/**
 * Checks whether a value is empty (`null`, `undefined`, `""`, `[]`, empty `Map`/`Set`, or `{}`).
 */
export function isEmpty(value: unknown): boolean {
  if (isNullish(value)) {
    return true;
  }
  if (isString(value) || isArray(value)) {
    return value.length === 0;
  }
  if (isMap(value) || isSet(value)) {
    return value.size === 0;
  }
  if (isPlainObject(value)) {
    return Object.keys(value).length === 0;
  }
  return false;
}

/**
 * Checks whether a value is non-empty (negation of `isEmpty`).
 */
export function isNotEmpty(value: unknown): boolean {
  return not(isEmpty(value));
}
