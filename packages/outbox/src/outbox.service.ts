import { Injectable } from "@bunest/common";
import { OutboxTransactionRequiredError } from "./errors/outbox-transaction-required.error";
import type { Awaitable } from "./interfaces/awaitable.interface";
import type {
  NewOutboxMessage,
  OutboxHeaders,
  OutboxMessage,
} from "./interfaces/outbox-message.interface";
import { OutboxRelay } from "./services/outbox-relay.service";
import { OutboxStorage } from "./storage/outbox.storage";
import { toMs } from "./utils/duration.util";
import { isName } from "./utils/name.util";
import {
  findUnstorableText,
  unstorableText,
} from "./utils/storable-text.util";
import { uuidv7 } from "./utils/uuid.util";

/**
 * Producer API. `Tx` is your data layer's transaction handle.
 */
@Injectable()
export class Outbox<Tx = unknown> {
  constructor(
    private readonly storage: OutboxStorage,
    private readonly relay: OutboxRelay,
  ) {}

  add<P>(tx: Tx, message: NewOutboxMessage<P>): Awaitable<OutboxMessage<P>>;
  add<P>(
    tx: Tx,
    messages: readonly NewOutboxMessage<P>[],
  ): Awaitable<OutboxMessage<P>[]>;
  add<P>(
    tx: Tx,
    input: NewOutboxMessage<P> | readonly NewOutboxMessage<P>[],
  ): Awaitable<OutboxMessage<P> | OutboxMessage<P>[]> {
    if (tx === undefined || tx === null) {
      throw new OutboxTransactionRequiredError(
        "Outbox.add() got no transaction handle.",
      );
    }
    const now = Date.now();
    const batch = isBatch(input);
    const messages = (batch ? input : [input]).map((m) => build(m, now));
    const output = batch ? messages : messages[0]!;
    const written = this.storage.messages.add(tx, messages);
    return isPromise(written) ? written.then(() => output) : output;
  }

  /** Poll now. Call after your transaction commits to skip the poll interval. */
  notify(): void {
    this.relay.notify();
  }
}

function build<P>(input: NewOutboxMessage<P>, now: number): OutboxMessage<P> {
  if (!isName(input?.topic)) {
    throw new TypeError("Outbox message needs a topic (a non-empty string)");
  }
  if (
    input.key !== undefined &&
    input.key !== null &&
    typeof input.key !== "string"
  ) {
    throw new TypeError(
      `Outbox message: \`key\` must be a string or null (got ${typeof input.key})`,
    );
  }
  if (input.delay !== undefined && input.availableAt !== undefined) {
    throw new TypeError(
      "Outbox message: pass either `delay` or `availableAt`, not both",
    );
  }
  const json = JSON.stringify(input.payload);
  if (json === undefined) {
    throw new TypeError("Outbox payload must be JSON-serializable");
  }
  const payload = JSON.parse(json) as P;
  const headers: OutboxHeaders = { ...input.headers };
  refuseUnstorableText(input, headers, payload);
  const availableAt =
    input.availableAt !== undefined
      ? +input.availableAt
      : now + toMs(input.delay ?? 0);
  if (!Number.isFinite(availableAt)) {
    throw new TypeError(
      `Outbox message: \`availableAt\` must be a valid Date or epoch milliseconds (got ${availableAt})`,
    );
  }
  return {
    id: input.id ?? uuidv7(),
    topic: input.topic,
    payload,
    headers,
    key: input.key ?? null,
    createdAt: now,
    availableAt,
    attempts: 0,
    lastError: null,
  };
}

function refuseUnstorableText(
  input: NewOutboxMessage<unknown>,
  headers: OutboxHeaders,
  payload: unknown,
): void {
  for (const field of ["topic", "key", "id"] as const) {
    const value = input[field];
    const problem =
      typeof value === "string" ? unstorableText(value) : undefined;
    if (problem) {
      throw unstorable(`\`${field}\``, problem);
    }
  }
  for (const [field, value] of Object.entries({ headers, payload })) {
    const found = findUnstorableText(value);
    if (found) {
      throw unstorable(`\`${field}\` at ${found.path}`, found.problem);
    }
  }
}

function unstorable(where: string, problem: string): TypeError {
  return new TypeError(
    `Outbox message: ${where} holds ${problem}, which a database can't store (U+0000 and lone UTF-16 surrogates are refused)`,
  );
}

function isBatch<P>(
  input: NewOutboxMessage<P> | readonly NewOutboxMessage<P>[],
): input is readonly NewOutboxMessage<P>[] {
  return Array.isArray(input);
}

function isPromise(value: unknown): value is Promise<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as PromiseLike<unknown>).then === "function"
  );
}
