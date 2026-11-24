import type {
  OutboxAttempt,
  OutboxDeadLetter,
  OutboxDeadLetterReason,
} from "../interfaces/outbox-dead-letter.interface";
import type {
  OutboxHeaders,
  OutboxMessage,
} from "../interfaces/outbox-message.interface";

/** A row as a SQL store reads it: every column as text (`NULL` as `null`), so no driver's type parsing applies. */
export type Row = Record<string, string | null>;

/** The columns an `OutboxMessage` is made of. */
export const MESSAGE_COLUMNS = [
  "id",
  "topic",
  "payload",
  "headers",
  "key",
  "created_at",
  "available_at",
  "attempts",
  "last_error",
];

/** The columns an `OutboxDeadLetter` is made of. */
export const DEAD_LETTER_COLUMNS = [
  "id",
  "topic",
  "payload",
  "headers",
  "key",
  "created_at",
  "attempts",
  "last_error",
  "history",
  "reason",
  "failed_at",
];

export function toMessage(row: Row): OutboxMessage {
  return {
    id: row.id!,
    topic: row.topic!,
    payload: json(row.payload ?? null),
    headers: json(row.headers ?? null) as OutboxHeaders,
    key: row.key ?? null,
    createdAt: Number(row.created_at),
    availableAt: Number(row.available_at),
    attempts: Number(row.attempts),
    lastError: row.last_error ?? null,
  };
}

export function toDeadLetter(row: Row): OutboxDeadLetter {
  return {
    id: row.id!,
    topic: row.topic!,
    payload: json(row.payload ?? null),
    headers: json(row.headers ?? null) as OutboxHeaders,
    key: row.key ?? null,
    createdAt: Number(row.created_at),
    attempts: Number(row.attempts),
    lastError: row.last_error ?? null,
    history: json(row.history ?? null) as OutboxAttempt[],
    reason: row.reason as OutboxDeadLetterReason,
    failedAt: Number(row.failed_at),
  };
}

function json(value: string | null): unknown {
  return value === null ? null : JSON.parse(value);
}
