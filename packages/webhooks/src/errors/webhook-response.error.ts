import { WebhooksError } from "./webhooks.error";

/** The endpoint answered with a status outside 2xx. Retried (410 Gone disables the endpoint). */
export class WebhookResponseError extends WebhooksError {
  readonly statusCode: number;
  /** From a `Retry-After` header, when the response had one. */
  readonly retryAfterMs?: number;

  constructor(
    statusCode: number,
    /** From a `Retry-After` header, when the response had one. */
    retryAfterMs?: number,
  ) {
    super(`Endpoint responded ${statusCode}`);
    this.statusCode = statusCode;
    this.retryAfterMs = retryAfterMs;
  }
}
