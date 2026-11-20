import { ResilienceError } from "./resilience.error";

/**
 * The call did not settle within its time budget. Unlike a rejection, the
 * call did start and may still be running (or may have had side effects).
 * It is also the reason of the aborted `AbortSignal` the call received.
 */
export class ResilienceTimeoutError extends ResilienceError {
  /** The budget that ran out, in milliseconds. */
  readonly timeoutMs: number;
  override readonly code = "TIMEOUT";

  constructor(timeoutMs: number, policy: string) {
    super(`Timed out after ${timeoutMs}ms`, policy);
    this.timeoutMs = timeoutMs;
  }
}
