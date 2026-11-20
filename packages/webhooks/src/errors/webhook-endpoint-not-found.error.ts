import { WebhooksError } from "./webhooks.error";

/** The endpoint doesn't exist (or belongs to another tenant). Status 404. */
export class WebhookEndpointNotFoundError extends WebhooksError {
  readonly endpointId: string;
  readonly status = 404;

  constructor(endpointId: string) {
    super(`Webhook endpoint ${endpointId} not found`);
    this.endpointId = endpointId;
  }
}
