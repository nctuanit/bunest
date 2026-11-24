import type { Duration } from "../interfaces/duration.interface";

const UNITS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

const MAX_DURATION = 100 * 365.25 * 86_400_000;

export function toMs(duration: Duration): number {
  let ms: number;
  if (typeof duration === "number") {
    if (!Number.isFinite(duration) || duration < 0) {
      throw new TypeError(
        `Invalid duration ${duration}. Use a non-negative number of milliseconds.`,
      );
    }
    ms = duration;
  } else {
    const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d|w)$/.exec(duration);
    if (!match) {
      throw new TypeError(
        `Invalid duration "${duration}". Use milliseconds or a string such as "15m" or "3d".`,
      );
    }
    ms = Math.round(Number(match[1]) * UNITS[match[2]!]!);
  }
  if (ms > MAX_DURATION) {
    throw new TypeError(
      `Invalid duration ${typeof duration === "string" ? `"${duration}"` : duration}: longer than 100 years.`,
    );
  }
  return ms;
}

export function durationOr(
  value: Duration | undefined,
  fallback: Duration,
): number {
  return toMs(value ?? fallback);
}

/**
 * Whether `expiresAt` has passed at `now` (epoch milliseconds). Fails closed
 * for Invalid Date (`NaN`).
 */
export function hasExpired(expiresAt: Date, now: number): boolean {
  return !(now < expiresAt.getTime());
}
