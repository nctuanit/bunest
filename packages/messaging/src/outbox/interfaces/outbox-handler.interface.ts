import type { Awaitable } from "./awaitable.interface";
import type { OutboxInboxResult } from "./outbox-inbox-result.interface";
import type { OutboxMessage } from "./outbox-message.interface";

export interface OnOutboxMessageOptions {
  /**
   * The handler's inbox identity: the inbox records which message ids this consumer
   * has processed. Keep it stable; a new name makes every past message look new.
   */
  consumer: string;
  /**
   * Skip messages this consumer already processed, and record each one after the
   * handler succeeds. Default `true`. With `false`, every delivery runs the handler.
   */
  inbox?: boolean;
}

export interface OutboxHandlerMetadata extends OnOutboxMessageOptions {
  topics: string[];
}

/** Second argument of an `@OnOutboxMessage()` handler. */
export interface OutboxHandlerContext<Tx = unknown> {
  /** The message: `id`, `topic`, `key`, `headers`, `createdAt`... (`payload` is the first argument). */
  readonly message: OutboxMessage;
  readonly consumer: string;
  /**
   * 1, plus the failed attempts recorded so far: 1 on the first delivery, 2 on the first
   * retry. A redelivery after a crash or a lost lease repeats the number.
   */
  readonly attempt: number;
  /**
   * Aborts when the relay stops waiting for this delivery (`relay.publishTimeout`) and
   * counts it as a failed attempt.
   */
  readonly signal: AbortSignal;
  /**
   * Makes the handler's effects exactly-once inside your own transaction.
   */
  processInTransaction<T>(
    tx: Tx,
    work: () => T,
  ): Awaitable<OutboxInboxResult<Awaited<T>>>;
}
