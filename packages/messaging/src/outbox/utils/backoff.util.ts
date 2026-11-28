import {
  computeBackoffDelay,
  describeValue,
  isOneOf,
  isTypeof,
  ternaryFor,
} from "@bunest/core/common";
import type { OutboxMessage } from "../interfaces/outbox-message.interface";
import type {
  OutboxModuleOptions,
  OutboxRetryOptions,
} from "../interfaces/outbox-module-options.interface";
import { type Duration, toMs } from "./duration.util";

type BackoffFn = (
  attempt: number,
  error: unknown,
  message: OutboxMessage,
) => Duration;

/** Backoff with every value resolved to milliseconds, or the user's function. */
type ResolvedBackoff =
  | {
      delay: number;
      factor: number;
      maxDelay: number;
      jitter: "full" | "equal" | "none";
    }
  | BackoffFn;

export interface ResolvedRetry {
  attempts: number;
  backoff: ResolvedBackoff;
  retryIf?: OutboxRetryOptions["retryIf"];
}

const DEFAULT_ATTEMPTS = 20;
const DEFAULT_BACKOFF = {
  delay: 1_000,
  factor: 2,
  maxDelay: 5 * 60_000,
  jitter: "equal" as const,
};
const JITTERS: readonly string[] = ["full", "equal", "none"];

/** Resolves the `retry` option once, at startup: bad values fail naming the option. */
export function resolveRetry(
  retry: OutboxModuleOptions["retry"],
): ResolvedRetry {
  const options: OutboxRetryOptions = ternaryFor(retry)
    .when((v): v is false => v === false, { attempts: 1 })
    .when(isTypeof("number"), (attempts) => ({ attempts }))
    .elseEval((v) => v ?? {});

  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new TypeError(
      `OutboxModule: retry.attempts must be a whole number of at least 1 (got ${attempts}). ` +
        "Use `retry: false` for a single attempt.",
    );
  }

  const { backoff, retryIf } = options;
  if (retryIf !== undefined && typeof retryIf !== "function") {
    throw new TypeError(
      `OutboxModule: retry.retryIf must be a function (got ${typeof retryIf})`,
    );
  }

  if (typeof backoff === "function") {
    return { attempts, backoff, retryIf };
  }

  if (
    backoff !== undefined &&
    (backoff === null || typeof backoff !== "object")
  ) {
    throw new TypeError(
      "OutboxModule: retry.backoff must be { delay, factor, maxDelay, jitter } or a function " +
        `(got ${backoff === null ? "null" : typeof backoff}). For a fixed wait, use { delay: ${String(backoff)}, factor: 1 }.`,
    );
  }

  const factor = backoff?.factor ?? DEFAULT_BACKOFF.factor;
  if (!(factor >= 1)) {
    throw new TypeError(
      `OutboxModule: retry.backoff.factor must be at least 1 (got ${factor})`,
    );
  }

  const jitter = backoff?.jitter ?? DEFAULT_BACKOFF.jitter;
  if (!isOneOf(JITTERS, jitter)) {
    throw new TypeError(
      `OutboxModule: retry.backoff.jitter must be "full", "equal" or "none" (got ${JSON.stringify(jitter)})`,
    );
  }

  return {
    attempts,
    retryIf,
    backoff: {
      delay: optionMs(
        backoff?.delay ?? DEFAULT_BACKOFF.delay,
        "retry.backoff.delay",
      ),
      factor,
      maxDelay: optionMs(
        backoff?.maxDelay ?? DEFAULT_BACKOFF.maxDelay,
        "retry.backoff.maxDelay",
      ),
      jitter,
    },
  };
}

export { describeValue };

/** `toMs()` for a module option: the error names the option. */
export function optionMs(value: Duration, option: string): number {
  try {
    return toMs(value);
  } catch (error) {
    throw new TypeError(`OutboxModule: ${option}: ${(error as Error).message}`);
  }
}

/**
 * Delay before the next attempt, after attempt number `attempt` (1-based) failed.
 * `equal` jitter keeps a floor of half the computed delay.
 */
export function computeBackoff(
  backoff: ResolvedBackoff,
  attempt: number,
  error: unknown,
  message: OutboxMessage,
  random: () => number = Math.random,
): number {
  if (typeof backoff === "function") {
    return Math.floor(toMs(backoff(attempt, error, message)));
  }
  return computeBackoffDelay(backoff, attempt, random);
}
