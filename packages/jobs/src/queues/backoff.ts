import { clamp } from "@bunest/core/common";
import type { BackoffOptions } from "./interfaces";

/**
 * Computes retry backoff delay in milliseconds for a 1-based failed attempt count.
 * - `"fixed"`: constant `delayMs`
 * - `"exponential"`: `delayMs * 2^(attempt - 1)`
 * Applies optional `maxDelayMs` cap and optional `jitter`.
 */
export function calculateBackoffDelay(
  backoff: BackoffOptions | undefined,
  failedAttemptNumber: number,
  randomFn: () => number = Math.random,
): number {
  if (!backoff || backoff.delayMs <= 0) {
    return 0;
  }

  const attempt = Math.max(1, Math.floor(failedAttemptNumber));
  let delay =
    backoff.type === "exponential"
      ? backoff.delayMs * 2 ** (attempt - 1)
      : backoff.delayMs;

  if (backoff.maxDelayMs !== undefined && backoff.maxDelayMs >= 0) {
    delay = Math.min(delay, backoff.maxDelayMs);
  }

  if (backoff.jitter) {
    const ratio =
      typeof backoff.jitter === "number"
        ? clamp(backoff.jitter, 0, 1)
        : 0.25;
    const spread = delay * ratio;
    delay = delay - spread + randomFn() * spread * 2;
  }

  return Math.max(0, Math.round(delay));
}
