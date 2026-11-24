import { type Duration, parseDuration } from "./duration.util";
import { isDate } from "./type-guards.util";

export type DateInput = Date | number;

function toTimestamp(input: DateInput): number {
  return isDate(input) ? input.getTime() : input;
}

/**
 * Abstract clock interface allowing services to depend on injectable time.
 */
export interface Clock {
  now(): number;
  date(): Date;
}

/**
 * Controllable clock for deterministic unit tests.
 */
export interface FakeClock extends Clock {
  advance(duration: Duration): number;
  set(timestamp: DateInput): void;
}

/**
 * Default production clock backed by `Date.now()`.
 */
export const systemClock: Clock = {
  now: () => Date.now(),
  date: () => new Date(),
};

/**
 * Creates a controllable `FakeClock` starting at `initialTime` (defaults to `Date.now()`).
 */
export function createFakeClock(initialTime: DateInput = Date.now()): FakeClock {
  let current = toTimestamp(initialTime);
  return {
    now: () => current,
    date: () => new Date(current),
    advance(duration: Duration): number {
      current += parseDuration(duration);
      return current;
    },
    set(timestamp: DateInput): void {
      current = toTimestamp(timestamp);
    },
  };
}

/**
 * Returns a new `Date` shifted forward by `duration`.
 */
export function addDuration(date: DateInput, duration: Duration): Date {
  return new Date(toTimestamp(date) + parseDuration(duration));
}

/**
 * Returns a new `Date` shifted backward by `duration`.
 */
export function subDuration(date: DateInput, duration: Duration): Date {
  return new Date(toTimestamp(date) - parseDuration(duration));
}

/**
 * Checks whether `expiresAt` is at or before `now` (defaults to `Date.now()`).
 */
export function isExpired(
  expiresAt: DateInput,
  now: DateInput = Date.now(),
): boolean {
  return toTimestamp(expiresAt) <= toTimestamp(now);
}

/**
 * Checks whether two dates fall on the same UTC calendar day (or local day when `utc = false`).
 */
export function isSameDay(a: DateInput, b: DateInput, utc = true): boolean {
  const da = new Date(toTimestamp(a));
  const db = new Date(toTimestamp(b));
  if (utc) {
    return (
      da.getUTCFullYear() === db.getUTCFullYear() &&
      da.getUTCMonth() === db.getUTCMonth() &&
      da.getUTCDate() === db.getUTCDate()
    );
  }
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

/**
 * Returns a new `Date` set to `00:00:00.000` of the day (UTC by default).
 */
export function startOfDay(date: DateInput, utc = true): Date {
  const d = new Date(toTimestamp(date));
  if (utc) {
    d.setUTCHours(0, 0, 0, 0);
  } else {
    d.setHours(0, 0, 0, 0);
  }
  return d;
}

/**
 * Returns a new `Date` set to `23:59:59.999` of the day (UTC by default).
 */
export function endOfDay(date: DateInput, utc = true): Date {
  const d = new Date(toTimestamp(date));
  if (utc) {
    d.setUTCHours(23, 59, 59, 999);
  } else {
    d.setHours(23, 59, 59, 999);
  }
  return d;
}

/**
 * Converts a `Date` or millisecond timestamp into whole Unix epoch seconds.
 */
export function toUnixSeconds(date: DateInput = Date.now()): number {
  return Math.floor(toTimestamp(date) / 1_000);
}

/**
 * Converts Unix epoch seconds into a `Date`.
 */
export function fromUnixSeconds(seconds: number): Date {
  return new Date(seconds * 1_000);
}

/**
 * Returns the signed millisecond difference `toTimestamp(a) - toTimestamp(b)`.
 */
export function diffMs(a: DateInput, b: DateInput): number {
  return toTimestamp(a) - toTimestamp(b);
}
