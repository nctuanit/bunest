import type { Awaitable } from "./awaitable.interface";
import type {
  WebhookDelivery,
  WebhookDeliveryAttempt,
  WebhookDeliveryFailureReason,
  WebhookDeliveryFilter,
  WebhookDeliveryQuery,
  WebhookDeliveryStatus,
  WebhookDeliveryStoreStats,
} from "./webhook-delivery.interface";
import type { WebhookMessage } from "./webhook-message.interface";

export type { WebhookDeliveryStoreStats };

/** A delivery the worker leased, with its message. */
export interface WebhookClaimedDelivery {
  readonly delivery: WebhookDelivery;
  readonly message: WebhookMessage;
}

/** `WebhookDeliveryStore.claimDeliveries()` input. */
export interface WebhookClaimRequest {
  /** Fencing token for this claim: every later write for these deliveries presents it. */
  owner: string;
  /** Epoch ms, from the worker's clock. */
  now: number;
  leaseMs: number;
  limit: number;
}

/** `WebhookDeliveryStore.recordDeliveryAttempt()` input: the delivery's new state, and the log row. */
export interface WebhookDeliveryUpdate {
  status: WebhookDeliveryStatus;
  attempts: number;
  nextAttemptAt: number | null;
  failureReason: WebhookDeliveryFailureReason | null;
  completedAt: number | null;
  /** Appended to the log. Absent when the delivery failed without an attempt (endpoint disabled or deleted). */
  attempt?: WebhookDeliveryAttempt;
  /** Set as `lastError` when there is no attempt. */
  error?: string;
}

/**
 * Where messages, deliveries and their attempt logs live: what the fan-out, the worker and
 * `WebhookDeliveries` use. Registered as `deliveries`. `@bunest/webhooks/testing` exports
 * `webhookDeliveryStoreContract()`.
 */
export interface WebhookDeliveryStore {
  /**
   * The fan-out, atomically and idempotently: inserts the message unless its `id` exists,
   * and each delivery unless one for the same `(messageId, endpointId)` exists (a unique key,
   * `ON CONFLICT DO NOTHING`). Returns how many deliveries it inserted. Called again after a
   * crash, it inserts only what is missing.
   */
  createDeliveries(
    message: WebhookMessage,
    deliveries: readonly WebhookDelivery[],
  ): Awaitable<number>;
  /**
   * Leases up to `limit` deliveries to `owner` until `now + leaseMs`: `pending`,
   * `nextAttemptAt <= now`, and unleased or with an expired lease; the most overdue first.
   * Concurrent claims never return the same delivery. Returns each with its message.
   */
  claimDeliveries(
    request: WebhookClaimRequest,
  ): Awaitable<WebhookClaimedDelivery[]>;
  /**
   * If `owner` still holds the lease: sets the delivery's state from `update` (and
   * `lastAttemptAt`, `lastStatusCode`, `lastError` from `update.attempt`, or `lastError`
   * from `update.error`), clears the lease, and appends `update.attempt` to the log, in one
   * transaction. `true` if it did.
   */
  recordDeliveryAttempt(
    id: string,
    owner: string,
    update: WebhookDeliveryUpdate,
  ): Awaitable<boolean>;
  /**
   * Clears `owner`'s leases on these deliveries without counting an attempt; with
   * `nextAttemptAt`, also postpones each to no earlier than it. Returns how many it released.
   */
  releaseDeliveries(
    ids: readonly string[],
    owner: string,
    nextAttemptAt?: number,
  ): Awaitable<number>;
  getDelivery(id: string): Awaitable<WebhookDelivery | undefined>;
  getMessage(id: string): Awaitable<WebhookMessage | undefined>;
  /** Newest first (`createdAt`, then `id`, descending), filtered before pagination by the fields present; `null` matches stored null, `limit` 50 by default. */
  listDeliveries(query: WebhookDeliveryQuery): Awaitable<WebhookDelivery[]>;
  /** The delivery's log, oldest first (`at`, then `attempt`). */
  listDeliveryAttempts(deliveryId: string): Awaitable<WebhookDeliveryAttempt[]>;
  /**
   * Starts a new round for the matching deliveries that aren't under an unexpired lease:
   * `status` pending, `attempts` 0, `nextAttemptAt` = `now`, `failureReason` and
   * `completedAt` null; the log stays. Fields combine with AND; refuse a filter with none
   * of `ids`, `endpointId`, `tenant`, `status`, `since` unless `all` is set; `ids: []`
   * matches nothing. Returns how many.
   */
  retryDeliveries(filter: WebhookDeliveryFilter, now: number): Awaitable<number>;
  /** Counts for `WebhookWorker.stats()`. See `WebhookDeliveryStoreStats`. */
  deliveryStats(now: number): Awaitable<WebhookDeliveryStoreStats>;
  /**
   * Retention: deletes deliveries that succeeded or failed with `completedAt < before`, their
   * logs, and messages left without deliveries. Never a pending delivery. Returns how many
   * deliveries it deleted.
   */
  pruneDeliveries(before: number): Awaitable<number>;
}
