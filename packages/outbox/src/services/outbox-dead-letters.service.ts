import { Injectable } from "@bunest/common";
import type {
  OutboxDeadLetter,
  OutboxDeadLetterFilter,
  OutboxDeadLetterQuery,
  OutboxDeadLetterTarget,
} from "../interfaces/outbox-dead-letter.interface";
import type { OutboxStore } from "../interfaces/outbox-store.interface";
import { OutboxStorage } from "../storage/outbox.storage";
import { OutboxRelay } from "./outbox-relay.service";

/**
 * Operations on messages that ran out of retries (or were rejected).
 */
@Injectable()
export class OutboxDeadLetters {
  constructor(
    private readonly storage: OutboxStorage,
    private readonly relay: OutboxRelay,
  ) {}

  private get store(): OutboxStore<any> {
    return this.storage.messages;
  }

  /** Newest first. */
  async list(query: OutboxDeadLetterQuery = {}): Promise<OutboxDeadLetter[]> {
    return this.store.listDeadLetters(query);
  }

  async get(id: string): Promise<OutboxDeadLetter | undefined> {
    return this.store.getDeadLetter(id);
  }

  /**
   * Moves dead letters back to the outbox with a fresh retry budget and the same id.
   */
  async requeue(target: OutboxDeadLetterTarget): Promise<number> {
    const count = await this.store.requeueDeadLetters(
      toFilter(target),
      Date.now(),
    );
    if (count > 0) {
      this.relay.notify();
    }
    return count;
  }

  /** Permanently deletes dead letters. */
  async purge(target: OutboxDeadLetterTarget): Promise<number> {
    return this.store.purgeDeadLetters(toFilter(target));
  }
}

function toFilter(target: OutboxDeadLetterTarget): OutboxDeadLetterFilter {
  if (typeof target === "string") {
    return { ids: [target] };
  }
  if (Array.isArray(target)) {
    return { ids: target };
  }
  const { ids, topic, key, failedBefore, all } = target;
  if (
    !all &&
    ids === undefined &&
    topic === undefined &&
    key === undefined &&
    failedBefore === undefined
  ) {
    throw new Error(
      "Refusing an empty dead-letter filter; pass { all: true } to target every dead letter",
    );
  }
  return target;
}
