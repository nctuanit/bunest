import { ResilienceError } from "./resilience.error";

/**
 * A policy refused to run the call at all (open breaker, full
 * bulkhead, outbound rate limit), so the call never started. Rejections are
 * never retried and never recorded as breaker failures, whatever `retryIf`
 * or `recordIf` return: they exist to shed load.
 */
export abstract class RejectionError extends ResilienceError {
  /** Milliseconds after which a new call may be let through, if known. */
  readonly retryAfterMs?: number;

  constructor(message: string, policy: string, retryAfterMs?: number) {
    super(message, policy);
    this.retryAfterMs = retryAfterMs;
  }
}
