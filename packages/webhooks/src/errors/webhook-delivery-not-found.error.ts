import { WebhooksError } from "./webhooks.error";

/** The delivery doesn't exist (or belongs to another tenant). Status 404. */
export class WebhookDeliveryNotFoundError extends WebhooksError {
  readonly deliveryId: string;
  readonly status = 404;

  constructor(deliveryId: string) {
    super(`Webhook delivery ${deliveryId} not found`);
    this.deliveryId = deliveryId;
  }
}
