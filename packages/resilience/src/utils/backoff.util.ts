import { computeBackoffDelay } from "@bunest/core";
import type { BackoffOptions } from "../interfaces/backoff-options.interface";
import { durationOption, numberOption } from "./options.util";

/** @internal Backoff options with durations resolved. */
export interface ResolvedBackoff {
  delay: number;
  factor: number;
  maxDelay: number;
  jitter: "full" | "equal" | "none";
}

/** @internal Applies the defaults and validates, naming invalid options `backoff.<option>`. */
export function resolveBackoff(options: BackoffOptions = {}): ResolvedBackoff {
  const factor = numberOption(
    options.factor ?? 2,
    "backoff.factor",
    1,
    Infinity,
  );
  return {
    delay: durationOption(options.delay ?? 200, "backoff.delay"),
    factor,
    maxDelay: durationOption(options.maxDelay ?? 30_000, "backoff.maxDelay"),
    jitter: options.jitter ?? (factor === 1 ? "none" : "full"),
  };
}

/** @internal Wait before the retry that follows `attempt` (1-based: the attempt that just failed). */
export function computeBackoff(
  backoff: ResolvedBackoff,
  attempt: number,
  random: () => number = Math.random,
): number {
  return computeBackoffDelay(backoff, attempt, random);
}
