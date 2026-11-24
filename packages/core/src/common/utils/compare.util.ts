import { not } from "./predicate.util";
import { isDate, isNullish, isNumber, isString } from "./type-guards.util";

export type OrderDirection = "asc" | "desc";

export type Comparator<T> = (a: T, b: T) => number;

export type ComparableValue = number | string | bigint | boolean | Date;

type WidenComparable<T> = T extends number
  ? number
  : T extends string
    ? string
    : T extends bigint
      ? bigint
      : T extends boolean
        ? boolean
        : T extends Date
          ? Date
          : T;

function toOrderScalar(value: unknown): number | string | bigint | undefined {
  if (isNullish(value)) {
    return undefined;
  }
  if (isDate(value)) {
    return value.getTime();
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  if (isNumber(value) || isString(value) || typeof value === "bigint") {
    return value;
  }
  return String(value);
}

/**
 * Ascending comparator supporting numbers, strings, bigints, booleans, Dates,
 * and nullish values (nullish sorts first).
 */
export function compareAsc(a: unknown, b: unknown): number {
  const sa = toOrderScalar(a);
  const sb = toOrderScalar(b);
  if (sa === sb) {
    return 0;
  }
  if (isNullish(sa)) {
    return -1;
  }
  if (isNullish(sb)) {
    return 1;
  }
  if (isNumber(sa) && isNumber(sb)) {
    return sa - sb;
  }
  if (typeof sa === "bigint" && typeof sb === "bigint") {
    return sa < sb ? -1 : 1;
  }
  const strA = String(sa);
  const strB = String(sb);
  return strA < strB ? -1 : strA > strB ? 1 : 0;
}

/**
 * Descending comparator (exact inverse of `compareAsc`).
 */
export function compareDesc(a: unknown, b: unknown): number {
  return compareAsc(b, a);
}

/**
 * Inverts any `Comparator<T>`.
 */
export function reverseComparator<T>(comparator: Comparator<T>): Comparator<T> {
  return (a: T, b: T): number => -comparator(a, b);
}

/**
 * Creates a `Comparator<T>` comparing elements by the value extracted from `selector`.
 */
export function compareBy<T>(
  selector: (item: T) => ComparableValue | null | undefined,
  direction: OrderDirection = "asc",
): Comparator<T> {
  const cmp = direction === "desc" ? compareDesc : compareAsc;
  return (a: T, b: T): number => cmp(selector(a), selector(b));
}

/**
 * Composes multiple comparators into a multi-key lexicographical comparator.
 * Falls through to the next comparator whenever the previous returns `0`.
 */
export function composeComparators<T>(
  ...comparators: readonly Comparator<T>[]
): Comparator<T> {
  return (a: T, b: T): number => {
    for (const cmp of comparators) {
      const result = cmp(a, b);
      if (result !== 0) {
        return result;
      }
    }
    return 0;
  };
}

// ─── Comparison Predicates (Direct & Curried) ────────────────────────────────

/**
 * Greater-than check (`a > b`). Supports direct `isGt(a, b)` and curried `isGt(threshold)`.
 */
export function isGt<T extends ComparableValue>(
  threshold: T,
): (value: WidenComparable<T>) => boolean;
export function isGt<T extends ComparableValue>(value: T, threshold: T): boolean;
export function isGt<T extends ComparableValue>(
  first: T,
  second?: T,
): boolean | ((value: WidenComparable<T>) => boolean) {
  if (arguments.length === 1) {
    return (value: WidenComparable<T>): boolean => compareAsc(value, first) > 0;
  }
  return compareAsc(first, second) > 0;
}

/**
 * Greater-than-or-equal check (`a >= b`). Supports direct and curried usage.
 */
export function isGte<T extends ComparableValue>(
  threshold: T,
): (value: WidenComparable<T>) => boolean;
export function isGte<T extends ComparableValue>(
  value: T,
  threshold: T,
): boolean;
export function isGte<T extends ComparableValue>(
  first: T,
  second?: T,
): boolean | ((value: WidenComparable<T>) => boolean) {
  if (arguments.length === 1) {
    return (value: WidenComparable<T>): boolean => compareAsc(value, first) >= 0;
  }
  return compareAsc(first, second) >= 0;
}

/**
 * Less-than check (`a < b`). Supports direct and curried usage.
 */
export function isLt<T extends ComparableValue>(
  threshold: T,
): (value: WidenComparable<T>) => boolean;
export function isLt<T extends ComparableValue>(value: T, threshold: T): boolean;
export function isLt<T extends ComparableValue>(
  first: T,
  second?: T,
): boolean | ((value: WidenComparable<T>) => boolean) {
  if (arguments.length === 1) {
    return (value: WidenComparable<T>): boolean => compareAsc(value, first) < 0;
  }
  return compareAsc(first, second) < 0;
}

/**
 * Less-than-or-equal check (`a <= b`). Supports direct and curried usage.
 */
export function isLte<T extends ComparableValue>(
  threshold: T,
): (value: WidenComparable<T>) => boolean;
export function isLte<T extends ComparableValue>(
  value: T,
  threshold: T,
): boolean;
export function isLte<T extends ComparableValue>(
  first: T,
  second?: T,
): boolean | ((value: WidenComparable<T>) => boolean) {
  if (arguments.length === 1) {
    return (value: WidenComparable<T>): boolean => compareAsc(value, first) <= 0;
  }
  return compareAsc(first, second) <= 0;
}

/**
 * Checks whether a comparable value falls within `[min, max]` (inclusive by default).
 * Supports both direct `isBetween(val, min, max)` and curried `isBetween(min, max)`.
 */
export function isBetween<T extends ComparableValue>(
  min: T,
  max: WidenComparable<T>,
): (value: WidenComparable<T>) => boolean;
export function isBetween<T extends ComparableValue>(
  value: T,
  min: WidenComparable<T>,
  max: WidenComparable<T>,
  inclusive?: boolean,
): boolean;
export function isBetween<T extends ComparableValue>(
  first: T,
  second: WidenComparable<T>,
  third?: WidenComparable<T>,
  inclusive = true,
): boolean | ((value: WidenComparable<T>) => boolean) {
  const check = (
    val: unknown,
    low: unknown,
    high: unknown,
    inc: boolean,
  ): boolean => {
    const cLow = compareAsc(val, low);
    const cHigh = compareAsc(val, high);
    return inc
      ? cLow >= 0 && cHigh <= 0
      : cLow > 0 && cHigh < 0;
  };

  if (arguments.length === 2) {
    return (value: WidenComparable<T>): boolean => check(value, first, second, true);
  }
  if (not(isNullish(third))) {
    return check(first, second, third, inclusive);
  }
  return false;
}
