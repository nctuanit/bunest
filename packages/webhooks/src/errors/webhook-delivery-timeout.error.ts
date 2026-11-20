import { WebhooksError } from "./webhooks.error";

/** The attempt outlived `delivery.timeout` (connecting, sending, or reading the response). */
export class WebhookDeliveryTimeoutError extends WebhooksError {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`No response within ${timeoutMs}ms`);
    this.timeoutMs = timeoutMs;
  }
}
