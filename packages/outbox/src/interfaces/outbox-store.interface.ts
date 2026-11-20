import type { Awaitable } from "./awaitable.interface";
import type {
  OutboxAttempt,
  OutboxDeadLetter,
  OutboxDeadLetterFilter,
  OutboxDeadLetterQuery,
  OutboxDeadLetterReason,
} from "./outbox-dead-letter.interface";
import type { OutboxMessage } from "./outbox-message.interface";

/**
 * Where the outbox keeps its messages and dead letters: what `Outbox.add()`, the relay and
 * `OutboxDeadLetters` use.
 */
export interface OutboxStore<Tx = unknown> {
  add(tx: Tx, messages: readonly OutboxMessage[]): Awaitable<void>;
  claim(request: OutboxClaimRequest): Awaitable<OutboxMessage[]>;
  markPublished(id: string, owner: string): Awaitable<boolean>;
  reschedule(
    id: string,
    owner: string,
    update: OutboxRescheduleUpdate,
  ): Awaitable<boolean>;
  deadLetter(
    id: string,
    owner: string,
    update: OutboxDeadLetterUpdate,
  ): Awaitable<boolean>;
  release(ids: readonly string[], owner: string): Awaitable<number>;
  stats(now: number): Awaitable<OutboxStoreStats>;
  listDeadLetters(query: OutboxDeadLetterQuery): Awaitable<OutboxDeadLetter[]>;
  getDeadLetter(id: string): Awaitable<OutboxDeadLetter | undefined>;
  requeueDeadLetters(
    filter: OutboxDeadLetterFilter,
    now: number,
  ): Awaitable<number>;
  purgeDeadLetters(filter: OutboxDeadLetterFilter): Awaitable<number>;
}

/** `OutboxStore.claim()` input. */
export interface OutboxClaimRequest {
  /** Fencing token for this claim. Every later write for these messages must present it. */
  owner: string;
  /** Epoch ms, from the relay's clock. */
  now: number;
  /** How long the claim is exclusive. */
  leaseMs: number;
  limit: number;
}

/** `OutboxStore.reschedule()` input. */
export interface OutboxRescheduleUpdate {
  attempts: number;
  availableAt: number;
  error: OutboxAttempt;
}

/** `OutboxStore.deadLetter()` input. */
export interface OutboxDeadLetterUpdate {
  attempts: number;
  reason: OutboxDeadLetterReason;
  failedAt: number;
  error: OutboxAttempt;
}

export interface OutboxStoreStats {
  /** Messages not yet published (ready, delayed or leased). */
  pending: number;
  /** Claimable right now: due, unleased, and not held back by an older message with the same key. */
  ready: number;
  /** Under an unexpired lease. */
  leased: number;
  deadLetters: number;
  /** Epoch ms since which the longest-waiting message has waited, or null when none is. */
  oldestDueAt: number | null;
}
