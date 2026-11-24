import { Injectable } from "@bunest/core";
import { NonRetryableMessageError, OnOutboxMessage } from "../../outbox/index";
import type { WebhookDelivery } from "../interfaces/webhook-delivery.interface";
import type { WebhookMessage } from "../interfaces/webhook-message.interface";
import { WebhooksStorage } from "../storage/webhooks.storage";
import { prefixedId } from "../utils/uuid.util";
import { WEBHOOKS_OUTBOX_TOPIC } from "../webhooks.constants";
import { WebhookWorker } from "./webhook-worker.service";

/**
 * The outbox handler that turns a committed message into deliveries: one per enabled
 * endpoint of the message's tenant subscribed to its type, created before the message was.
 */
@Injectable()
export class WebhookFanOut {
  private readonly storage: WebhooksStorage;
  private readonly worker: WebhookWorker;

  constructor(storage: WebhooksStorage, worker: WebhookWorker) {
    this.storage = storage;
    this.worker = worker;
  }

  @OnOutboxMessage(WEBHOOKS_OUTBOX_TOPIC, {
    consumer: "nestjs-webhooks",
    inbox: false,
  })
  async fanOut(message: unknown): Promise<void> {
    if (!isMessage(message)) {
      throw new NonRetryableMessageError(
        `Not a webhook message: ${JSON.stringify(message)?.slice(0, 200)}`,
      );
    }
    const endpoints = await this.storage.endpoints.findSubscribedEndpoints(
      message.tenant,
      message.type,
    );
    const deliveries: WebhookDelivery[] = endpoints
      // An endpoint receives what was dispatched after it existed, even when the relay runs late.
      .filter(
        (endpoint) =>
          endpoint.tenant === message.tenant &&
          endpoint.createdAt <= message.createdAt,
      )
      .map((endpoint) => ({
        id: prefixedId("dlv"),
        messageId: message.id,
        endpointId: endpoint.id,
        tenant: message.tenant,
        type: message.type,
        status: "pending",
        attempts: 0,
        nextAttemptAt: message.createdAt,
        lastAttemptAt: null,
        lastStatusCode: null,
        lastError: null,
        failureReason: null,
        createdAt: message.createdAt,
        completedAt: null,
      }));
    if (deliveries.length === 0) {
      return;
    }
    const created = await this.storage.deliveries.createDeliveries(
      message,
      deliveries,
    );
    if (created > 0) {
      this.worker.notify();
    }
  }
}

function isMessage(value: unknown): value is WebhookMessage {
  const m = value as Partial<WebhookMessage> | null | undefined;
  return (
    typeof m?.id === "string" &&
    typeof m.type === "string" &&
    typeof m.body === "string" &&
    typeof m.createdAt === "number" &&
    (m.tenant === null || typeof m.tenant === "string")
  );
}
