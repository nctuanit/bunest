import { not } from "./predicate.util";
import { isFiniteNumber, isString, isTypeof } from "./type-guards.util";

export type DurationUnit = "ms" | "s" | "m" | "h" | "d" | "w";

/**
 * Milliseconds, or a string such as `"250ms"`, `"30s"`, `"15m"`, `"6h"`, `"3d"`, `"1w"`.
 */
export type Duration = number | `${number}${DurationUnit}`;

const DURATION_UNITS: Readonly<Record<DurationUnit, number>> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

const DURATION_PATTERN = /^(\d+(?:\.\d+)?)(ms|s|m|h|d|w)$/;

/**
 * Type guard checking whether an unknown value is a valid non-negative `Duration`.
 */
export function isDuration(value: unknown): value is Duration {
  if (isFiniteNumber(value)) {
    return value >= 0;
  }
  if (isString(value)) {
    return DURATION_PATTERN.test(value);
  }
  return false;
}

/**
 * Parses a `Duration` (number of milliseconds or shorthand string like `"15m"`)
 * into a whole non-negative number of milliseconds.
 * Throws a `TypeError` for negative, non-finite, or unparseable values.
 */
export function parseDuration(duration: Duration): number {
  if (isTypeof(duration, "number")) {
    if (not(isFiniteNumber(duration)) || duration < 0) {
      throw new TypeError(
        `Invalid duration ${duration}. Use a non-negative number of milliseconds.`,
      );
    }
    return duration;
  }
  const matched = isString(duration) ? DURATION_PATTERN.exec(duration) : null;
  if (not(Boolean(matched))) {
    throw new TypeError(
      `Invalid duration "${String(duration)}". Use milliseconds or a string such as "15m" or "3d".`,
    );
  }
  const amount = Number(matched![1]);
  const unit = matched![2] as DurationUnit;
  return Math.round(amount * DURATION_UNITS[unit]);
}

const EXACT_UNITS: ReadonlyArray<readonly [DurationUnit, number]> = [
  ["w", 604_800_000],
  ["d", 86_400_000],
  ["h", 3_600_000],
  ["m", 60_000],
  ["s", 1_000],
];

/**
 * Formats a non-negative number of milliseconds into a readable duration string
 * (e.g. `250` -> `"250ms"`, `1500` -> `"1.5s"`, `30_000` -> `"30s"`, `90_000` -> `"90s"`).
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    throw new TypeError(
      `Invalid duration ${ms}. Use a non-negative finite number of milliseconds.`,
    );
  }
  if (ms < 1_000) {
    return `${ms}ms`;
  }
  for (const [unit, factor] of EXACT_UNITS) {
    if (ms >= factor && ms % factor === 0) {
      return `${ms / factor}${unit}`;
    }
  }
  for (const [unit, factor] of EXACT_UNITS) {
    if (ms >= factor) {
      const value = Number((ms / factor).toFixed(2));
      return `${value}${unit}`;
    }
  }
  return `${ms}ms`;
}
