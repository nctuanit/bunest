import { parseDuration } from "@bunest/core";
import type { Duration } from "../interfaces/duration.interface";

const MAX_DURATION = 100 * 365.25 * 86_400_000;

export function toMs(duration: Duration): number {
  const ms = parseDuration(duration);
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
