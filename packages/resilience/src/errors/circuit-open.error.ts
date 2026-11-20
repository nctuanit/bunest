import { RejectionError } from "./rejection.error";

export class CircuitOpenError extends RejectionError {
  override readonly code = "CIRCUIT_OPEN";
  declare readonly retryAfterMs: number;

  constructor(breaker: string, retryAfterMs: number) {
    super(`Circuit breaker "${breaker}" is open`, breaker, retryAfterMs);
  }
}
