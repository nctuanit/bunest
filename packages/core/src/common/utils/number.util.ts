import { not } from "./predicate.util";
import {
  isFiniteNumber,
  isInteger,
  isNotUndefined,
  isNullish,
  isString,
} from "./type-guards.util";

/**
 * Clamps `value` to the inclusive range `[min, max]`.
 */
export function clamp(value: number, min: number, max: number): number {
  if (min > max) {
    throw new RangeError(`clamp: min (${min}) cannot exceed max (${max})`);
  }
  return Math.min(max, Math.max(min, value));
}

/**
 * Checks whether `value` lies within `[min, max]` (inclusive by default) or `(min, max)`.
 */
export function inRange(
  value: number,
  min: number,
  max: number,
  inclusive = true,
): boolean {
  if (not(isFiniteNumber(value))) {
    return false;
  }
  const low = Math.min(min, max);
  const high = Math.max(min, max);
  return inclusive
    ? value >= low && value <= high
    : value > low && value < high;
}

/**
 * Rounds `value` to `decimals` decimal places (default `0`).
 */
export function roundTo(value: number, decimals = 0): number {
  if (not(isInteger(decimals)) || decimals < 0) {
    throw new RangeError(
      `roundTo: decimals must be a non-negative integer (got ${decimals})`,
    );
  }
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

/**
 * Safely parses an unknown value to a finite number, returning `fallback` (or `undefined`)
 * when conversion fails or yields `NaN`/`Infinity`.
 */
export function toNumber(value: unknown, fallback: number): number;
export function toNumber(value: unknown): number | undefined;
export function toNumber(
  value: unknown,
  fallback?: number,
): number | undefined {
  if (isFiniteNumber(value)) {
    return value;
  }
  if (isNullish(value) || typeof value === "boolean") {
    return fallback;
  }
  if (isString(value) && value.trim().length === 0) {
    return fallback;
  }
  const parsed = Number(value);
  return isFiniteNumber(parsed) ? parsed : fallback;
}

/**
 * Safely parses an unknown value to a truncated integer, returning `fallback` (or `undefined`)
 * when conversion fails.
 */
export function toInt(value: unknown, fallback: number): number;
export function toInt(value: unknown): number | undefined;
export function toInt(value: unknown, fallback?: number): number | undefined {
  const num = toNumber(value);
  return isNotUndefined(num) ? Math.trunc(num) : fallback;
}

/**
 * Divides `numerator` by `denominator`, returning `fallback` (default `0`) when `denominator`
 * is `0` or non-finite.
 */
export function safeDivide(
  numerator: number,
  denominator: number,
  fallback = 0,
): number {
  if (not(isFiniteNumber(denominator)) || denominator === 0) {
    return fallback;
  }
  const quotient = numerator / denominator;
  return isFiniteNumber(quotient) ? quotient : fallback;
}

/**
 * Returns the sum of a numeric array (`0` for an empty array).
 */
export function sum(numbers: readonly number[]): number {
  let total = 0;
  for (const n of numbers) {
    total += n;
  }
  return total;
}

/**
 * Returns the arithmetic mean of a numeric array (`0` for an empty array).
 */
export function average(numbers: readonly number[]): number {
  return safeDivide(sum(numbers), numbers.length, 0);
}

/**
 * Returns the item with the smallest numeric score returned by `selector`, or `undefined` if empty.
 */
export function minBy<T>(
  items: readonly T[],
  selector: (item: T, index: number) => number,
): T | undefined {
  let bestItem: T | undefined;
  let bestScore = Infinity;
  for (let i = 0; i < items.length; i++) {
    const item = items[i] as T;
    const score = selector(item, i);
    if (i === 0 || score < bestScore) {
      bestScore = score;
      bestItem = item;
    }
  }
  return bestItem;
}

/**
 * Returns the item with the largest numeric score returned by `selector`, or `undefined` if empty.
 */
export function maxBy<T>(
  items: readonly T[],
  selector: (item: T, index: number) => number,
): T | undefined {
  let bestItem: T | undefined;
  let bestScore = -Infinity;
  for (let i = 0; i < items.length; i++) {
    const item = items[i] as T;
    const score = selector(item, i);
    if (i === 0 || score > bestScore) {
      bestScore = score;
      bestItem = item;
    }
  }
  return bestItem;
}
