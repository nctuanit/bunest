import { WebhooksError } from "./webhooks.error";

export type InvalidWebhookEndpointField =
  "url" | "eventTypes" | "secret" | "description" | "tenant";

/**
 * An endpoint the caller asked for can't be accepted: a URL that isn't https (unless
 * `delivery.allowHttp`), carries credentials, or points at a blocked address; an unknown
 * event type; a malformed secret. Status 400. `field` names the input.
 */
export class InvalidWebhookEndpointError extends WebhooksError {
  readonly field: InvalidWebhookEndpointField;
  readonly status = 400;

  constructor(field: InvalidWebhookEndpointField, message: string) {
    super(message);
    this.field = field;
  }
}
