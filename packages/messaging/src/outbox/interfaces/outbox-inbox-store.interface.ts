import type { Awaitable } from "./awaitable.interface";

/**
 * Consumer-side deduplication: which consumer processed which message. What `OutboxInbox`
 * and the `@OnOutboxMessage()` handlers use.
 */
export interface OutboxInboxStore<Tx = unknown> {
  recordInbox(
    tx: Tx | undefined,
    consumer: string,
    messageId: string,
    now: number,
  ): Awaitable<boolean>;
  hasInbox(consumer: string, messageId: string): Awaitable<boolean>;
  /** Deletes records processed before `before` (epoch ms). Returns how many. */
  pruneInbox(before: number): Awaitable<number>;
}
