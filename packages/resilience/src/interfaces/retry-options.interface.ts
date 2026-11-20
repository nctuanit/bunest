import type { BackoffOptions } from "./backoff-options.interface";
import type { Duration } from "./duration.interface";

export interface RetryOptions {
  /**
   * Total attempts, including the first: a whole number, or `Infinity` to
   * retry until the signal aborts. Default 3.
   */
  attempts?: number;
  /**
   * How long to wait before each retry: backoff settings (default: from
   * `200ms`, doubling, capped at `30s`, full jitter), or a function of the
   * attempt that just failed (1-based) and its error. A negative number from
   * the function means no wait.
   */
  backoff?: BackoffOptions | ((attempt: number, error: unknown) => Duration);
  /**
   * Which errors are retried. Default: every error except client errors
   * (`isClientError()`). Rejections (`CircuitOpenError`, `BulkheadFullError`,
   * `OutboundRateLimitError`) and caller aborts are never retried.
   */
  retryIf?: (error: unknown, attempt: number) => boolean;
  /**
   * Retries a call that *succeeded* with this result (a 503 returned without
   * throwing, say). For `execute()`; entrypoints don't retry results.
   */
  retryOnResult?: (result: unknown, attempt: number) => boolean;
}
