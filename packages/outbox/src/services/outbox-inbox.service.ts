import { Injectable } from "@bunest/common";
import { OutboxTransactionRequiredError } from "../errors/outbox-transaction-required.error";
import type { Awaitable } from "../interfaces/awaitable.interface";
import type { OutboxInboxResult } from "../interfaces/outbox-inbox-result.interface";
import type { OutboxInboxStore } from "../interfaces/outbox-inbox-store.interface";
import { OutboxStorage } from "../storage/outbox.storage";
import { type Duration, toMs } from "../utils/duration.util";

/**
 * Consumer-side deduplication by message id, per consumer. `@OnOutboxMessage()`
 * handlers use it automatically; remote consumers call it directly.
 */
@Injectable()
export class OutboxInbox {
  /** Deliveries running in this process, by consumer and message id. */
  private readonly running = new Map<string, Promise<unknown>>();

  constructor(private readonly storage: OutboxStorage) {}

  private get store(): OutboxInboxStore<any> {
    return this.storage.inbox;
  }

  /**
   * Runs `work` unless `consumer` already processed `messageId`, then records it.
   */
  async process<T>(
    consumer: string,
    messageId: string,
    work: () => T | Promise<T>,
    { signal }: { signal?: AbortSignal } = {},
  ): Promise<OutboxInboxResult<Awaited<T>>> {
    const key = `${consumer}\u0000${messageId}`;
    for (
      let earlier = this.running.get(key);
      earlier;
      earlier = this.running.get(key)
    ) {
      await settledOrAborted(earlier, signal);
    }
    const delivery = this.checkRunRecord(consumer, messageId, work);
    this.running.set(key, delivery);
    try {
      return await delivery;
    } finally {
      if (this.running.get(key) === delivery) {
        this.running.delete(key);
      }
    }
  }

  /**
   * Records `messageId` for `consumer` through `tx`, then runs `work` only if this is
   * the first time.
   */
  processInTransaction<Tx, T>(
    tx: Tx,
    consumer: string,
    messageId: string,
    work: () => T,
  ): Awaitable<OutboxInboxResult<Awaited<T>>> {
    if (tx === undefined || tx === null) {
      throw new OutboxTransactionRequiredError(
        "processInTransaction() got no transaction handle.",
      );
    }
    const recorded = this.store.recordInbox(tx, consumer, messageId, Date.now());
    return isPromise(recorded)
      ? recorded.then((first) => runIfFirst(first, work))
      : runIfFirst(recorded, work);
  }

  /** Deletes inbox entries older than `olderThan` (`'30d'`). */
  prune(olderThan: Duration): Awaitable<number> {
    return this.store.pruneInbox(Date.now() - toMs(olderThan));
  }

  private async checkRunRecord<T>(
    consumer: string,
    messageId: string,
    work: () => T | Promise<T>,
  ): Promise<OutboxInboxResult<Awaited<T>>> {
    if (await this.store.hasInbox(consumer, messageId)) {
      return { duplicate: true };
    }
    const result = await work();
    await this.store.recordInbox(undefined, consumer, messageId, Date.now());
    return { duplicate: false, result };
  }
}

const noop = () => {};

function settledOrAborted(
  promise: Promise<unknown>,
  signal?: AbortSignal,
): Promise<void> {
  if (!signal) {
    return promise.then(noop, noop);
  }
  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }
  const waiter: { wake?: () => void } = {};
  wakeWhenSettled(promise, waiter);
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      waiter.wake = undefined;
      reject(signal.reason);
    };
    waiter.wake = () => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

function wakeWhenSettled(
  promise: Promise<unknown>,
  waiter: { wake?: () => void },
): void {
  promise.then(noop, noop).then(() => waiter.wake?.());
}

function runIfFirst<T>(
  first: unknown,
  work: () => T,
): Awaitable<OutboxInboxResult<Awaited<T>>> {
  if (typeof first !== "boolean") {
    throw new TypeError(
      "OutboxInboxStore.recordInbox() must return (or resolve to) a boolean",
    );
  }
  if (!first) {
    return { duplicate: true };
  }
  const result = work();
  return isPromise(result)
    ? result.then((value) => ({
        duplicate: false as const,
        result: value as Awaited<T>,
      }))
    : { duplicate: false as const, result: result as Awaited<T> };
}

function isPromise<T>(value: unknown): value is Promise<T> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as PromiseLike<T>).then === "function"
  );
}
