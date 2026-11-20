import { RejectionError } from "./rejection.error";

export class OutboundRateLimitError extends RejectionError {
  override readonly code = "RATE_LIMITED";
  declare readonly retryAfterMs: number;

  constructor(limiter: string, retryAfterMs: number) {
    super(`Outbound rate limit "${limiter}" exceeded`, limiter, retryAfterMs);
  }
}
