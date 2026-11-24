import { toBool, toInt, toJson } from "@bunest/orm/store";
import type {
  WebhookDelivery,
  WebhookDeliveryAttempt,
  WebhookDeliveryFailureReason,
  WebhookDeliveryStatus,
} from "../interfaces/webhook-delivery.interface";
import type {
  WebhookEndpointRecord,
  WebhookEndpointSecret,
} from "../interfaces/webhook-endpoint-store.interface";
import type { WebhookEndpointDisabledReason } from "../interfaces/webhook-endpoint.interface";
import type { WebhookMessage } from "../interfaces/webhook-message.interface";

export const ENDPOINT_COLUMNS = [
  "id",
  "tenant",
  "url",
  "event_types",
  "description",
  "enabled",
  "disabled_reason",
  "failing_since",
  "secrets",
  "created_at",
  "updated_at",
] as const;

export const MESSAGE_COLUMNS = [
  "id",
  "type",
  "tenant",
  "body",
  "created_at",
] as const;

export const DELIVERY_COLUMNS = [
  "id",
  "message_id",
  "endpoint_id",
  "tenant",
  "type",
  "status",
  "attempts",
  "next_attempt_at",
  "last_attempt_at",
  "last_status_code",
  "last_error",
  "failure_reason",
  "created_at",
  "completed_at",
] as const;

export const DELIVERY_ATTEMPT_COLUMNS = [
  "delivery_id",
  "attempt",
  "at",
  "duration_ms",
  "status_code",
  "response",
  "error",
] as const;

export function toEndpointRecord(
  row: Record<string, unknown>,
): WebhookEndpointRecord {
  return {
    id: String(row.id),
    tenant: (row.tenant as string | null) ?? null,
    url: String(row.url),
    eventTypes:
      (toJson(row.event_types as string | null) as string[] | null) ?? [],
    description: (row.description as string | null) ?? null,
    enabled: toBool(row.enabled as string | null) ?? false,
    disabledReason:
      (row.disabled_reason as WebhookEndpointDisabledReason | null) ?? null,
    failingSince: toInt(row.failing_since as string | null),
    createdAt: toInt(row.created_at as string | null) ?? 0,
    updatedAt: toInt(row.updated_at as string | null) ?? 0,
    secrets:
      (toJson(row.secrets as string | null) as
        WebhookEndpointSecret[] | null) ?? [],
  };
}

/** `prefix`: the message's columns selected under names of their own (`m_id`...), next to a delivery's. */
export function toMessage(
  row: Record<string, unknown>,
  prefix = "",
): WebhookMessage {
  return {
    id: String(row[`${prefix}id`]),
    type: String(row[`${prefix}type`]),
    tenant: (row[`${prefix}tenant`] as string | null) ?? null,
    body: String(row[`${prefix}body`]),
    createdAt: toInt(row[`${prefix}created_at`] as string | null) ?? 0,
  };
}

export function toDelivery(row: Record<string, unknown>): WebhookDelivery {
  return {
    id: String(row.id),
    messageId: String(row.message_id),
    endpointId: String(row.endpoint_id),
    tenant: (row.tenant as string | null) ?? null,
    type: String(row.type),
    status: row.status as WebhookDeliveryStatus,
    attempts: toInt(row.attempts as string | null) ?? 0,
    nextAttemptAt: toInt(row.next_attempt_at as string | null),
    lastAttemptAt: toInt(row.last_attempt_at as string | null),
    lastStatusCode: toInt(row.last_status_code as string | null),
    lastError: (row.last_error as string | null) ?? null,
    failureReason:
      (row.failure_reason as WebhookDeliveryFailureReason | null) ?? null,
    createdAt: toInt(row.created_at as string | null) ?? 0,
    completedAt: toInt(row.completed_at as string | null),
  };
}

export function toDeliveryAttempt(
  row: Record<string, unknown>,
): WebhookDeliveryAttempt {
  return {
    deliveryId: String(row.delivery_id),
    attempt: toInt(row.attempt as string | null) ?? 0,
    at: toInt(row.at as string | null) ?? 0,
    durationMs: toInt(row.duration_ms as string | null) ?? 0,
    statusCode: toInt(row.status_code as string | null),
    response: (row.response as string | null) ?? null,
    error: (row.error as string | null) ?? null,
  };
}
