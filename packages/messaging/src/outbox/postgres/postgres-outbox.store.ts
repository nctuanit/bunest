import { Logger, type OnModuleInit } from "@bunest/core";
import {
  advisoryLock,
  columns,
  isNotATransactionError,
  type MigrationSqlOptions,
  quoteSchema,
  type SqlExecutor,
  SqlParams,
  type SqlTransaction,
  type SqlTransactionOptions,
  type StoreReadiness,
} from "@bunest/orm/postgres";
import { OutboxTransactionRequiredError } from "../errors/outbox-transaction-required.error";
import type {
  OutboxDeadLetter,
  OutboxDeadLetterFilter,
  OutboxDeadLetterQuery,
} from "../interfaces/outbox-dead-letter.interface";
import type { OutboxInboxStore } from "../interfaces/outbox-inbox-store.interface";
import type { OutboxMessage } from "../interfaces/outbox-message.interface";
import type {
  OutboxClaimRequest,
  OutboxDeadLetterUpdate,
  OutboxRescheduleUpdate,
  OutboxStore,
  OutboxStoreStats,
} from "../interfaces/outbox-store.interface";
import {
  type DeadLetterConditions,
  deadLetterConditions,
  deadLetterPage,
  epochMs,
} from "../sql/outbox-inputs.util";
import {
  DEAD_LETTER_COLUMNS,
  MESSAGE_COLUMNS,
  type Row,
  toDeadLetter,
  toMessage,
} from "../sql/outbox-rows.util";
import type { OutboxStorage } from "../storage/outbox.storage";
import type { PostgresOutboxStoreOptions } from "./interfaces/postgres-outbox-store-options.interface";
import { postgresOutboxSchema } from "./migrations/index";

const READ_COMMITTED: SqlTransactionOptions = {
  isolationLevel: "read committed",
};

/**
 * The first-party `OutboxStore` and `OutboxInboxStore` on PostgreSQL, built on `@bunest/orm/postgres`.
 */
export class PostgresOutboxStore
  implements OutboxStore, OutboxInboxStore, OnModuleInit
{
  static readonly schemaVersion: number = postgresOutboxSchema.latest;

  static migrationSql(options: MigrationSqlOptions = {}): string {
    return postgresOutboxSchema.sql(options);
  }

  private readonly logger = new Logger("OutboxModule");
  private readonly executor: SqlExecutor<"postgres">;
  private readonly schema: string;
  private readonly t: { messages: string; deadLetters: string; inbox: string };
  private readonly readiness: StoreReadiness;

  constructor(options: PostgresOutboxStoreOptions, storage?: OutboxStorage) {
    const resolved = postgresOutboxSchema.resolveOptions(options);
    this.executor = resolved.executor;
    this.schema = resolved.schema;
    const s = quoteSchema(this.schema, "PostgresOutboxStore");
    this.t = {
      messages: `${s}.messages`,
      deadLetters: `${s}.dead_letters`,
      inbox: `${s}.inbox`,
    };
    this.readiness = postgresOutboxSchema.readiness({
      ...resolved,
      logger: this.logger,
    });
    storage?.registerSource({ messages: this, inbox: this });
  }

  async onModuleInit(): Promise<void> {
    await this.readiness.ready();
  }

  migrate(): Promise<number[]> {
    return this.readiness.migrate();
  }

  // ---------------------------------------------------------------- producer
  async add(
    transaction: unknown,
    messages: readonly OutboxMessage[],
  ): Promise<void> {
    const tx = this.inTransaction(transaction, "add");
    if (messages.length === 0) {
      return;
    }
    await this.readiness.readyIn(tx);
    await this.lockKeys(tx, messages);
    const rows = messages.map((m) => ({
      id: m.id,
      topic: m.topic,
      payload: m.payload,
      headers: m.headers,
      key: m.key,
      createdAt: epochMs(m.createdAt),
      availableAt: epochMs(m.availableAt),
    }));
    const p = new SqlParams();
    await tx.query(
      `INSERT INTO ${this.t.messages} (id, topic, payload, headers, key, created_at, available_at)
SELECT m.value->>'id', m.value->>'topic', nullif(m.value->'payload', 'null'), m.value->'headers', m.value->>'key',
  (m.value->>'createdAt')::bigint, (m.value->>'availableAt')::bigint
FROM jsonb_array_elements(${p.json(rows)}) WITH ORDINALITY AS m(value, n)
ORDER BY m.n`,
      p.values,
    );
  }

  // ---------------------------------------------------------------- relay
  async claim({
    owner,
    now,
    leaseMs,
    limit,
  }: OutboxClaimRequest): Promise<OutboxMessage[]> {
    await this.readiness.ready();
    return this.executor.transaction(async (tx) => {
      await advisoryLock(tx, `@nestjs/outbox:${this.schema}:claim`);
      const p = new SqlParams();
      const at = p.bigint(epochMs(now));
      const rows = await tx.query<Row>(
        `WITH due AS MATERIALIZED (
  SELECT m.seq, m.key FROM ${this.t.messages} m
  WHERE ${this.claimable("m", at)}
  ORDER BY m.seq
  LIMIT ${p.int(limit)}
  FOR UPDATE OF m SKIP LOCKED
), checked AS (
  SELECT d.seq, d.key, (
    SELECT o.seq FROM ${this.t.messages} o WHERE o.key = d.key AND o.seq < d.seq ORDER BY o.seq DESC LIMIT 1
  ) AS previous
  FROM due d
), cut AS (
  SELECT c.key, min(c.seq) AS seq FROM checked c WHERE c.previous NOT IN (SELECT due.seq FROM due) GROUP BY c.key
), taken AS (
  SELECT c.seq FROM checked c LEFT JOIN cut ON cut.key = c.key
  WHERE c.key IS NULL OR cut.seq IS NULL OR c.seq < cut.seq
), leased AS (
  UPDATE ${this.t.messages} m SET lease_owner = ${p.text(owner)}, lease_until = ${p.bigint(epochMs(now + leaseMs))}
  FROM taken WHERE m.seq = taken.seq
  RETURNING m.*
)
SELECT ${columns(MESSAGE_COLUMNS, "l")} FROM leased l ORDER BY l.seq`,
        p.values,
      );
      return rows.map(toMessage);
    }, READ_COMMITTED);
  }

  async markPublished(id: string, owner: string): Promise<boolean> {
    await this.readiness.ready();
    const p = new SqlParams();
    const deleted = await this.executor.query<{ id: string }>(
      `DELETE FROM ${this.t.messages} WHERE id = ${p.text(id)} AND lease_owner = ${p.text(owner)} RETURNING id`,
      p.values,
    );
    return deleted.length === 1;
  }

  async reschedule(
    id: string,
    owner: string,
    update: OutboxRescheduleUpdate,
  ): Promise<boolean> {
    await this.readiness.ready();
    const p = new SqlParams();
    const updated = await this.executor.query<{ id: string }>(
      `UPDATE ${this.t.messages}
SET attempts = ${p.int(update.attempts)}, available_at = ${p.bigint(epochMs(update.availableAt))}, last_error = ${p.text(update.error.error)},
  history = history || ${p.json([update.error])}, lease_owner = NULL, lease_until = NULL
WHERE id = ${p.text(id)} AND lease_owner = ${p.text(owner)}
RETURNING id`,
      p.values,
    );
    return updated.length === 1;
  }

  async deadLetter(
    id: string,
    owner: string,
    update: OutboxDeadLetterUpdate,
  ): Promise<boolean> {
    await this.readiness.ready();
    const p = new SqlParams();
    const moved = await this.executor.query<{ id: string }>(
      `WITH moved AS (
  DELETE FROM ${this.t.messages} WHERE id = ${p.text(id)} AND lease_owner = ${p.text(owner)} RETURNING *
)
INSERT INTO ${this.t.deadLetters} (id, seq, topic, payload, headers, key, created_at, attempts, last_error, history, reason, failed_at)
SELECT id, seq, topic, payload, headers, key, created_at, ${p.int(update.attempts)}, ${p.text(update.error.error)},
  history || ${p.json([update.error])}, ${p.text(update.reason)}, ${p.bigint(epochMs(update.failedAt))}
FROM moved
ON CONFLICT (id) DO UPDATE SET seq = excluded.seq, topic = excluded.topic, payload = excluded.payload,
  headers = excluded.headers, key = excluded.key, created_at = excluded.created_at, attempts = excluded.attempts,
  last_error = excluded.last_error, history = excluded.history, reason = excluded.reason, failed_at = excluded.failed_at
RETURNING id`,
      p.values,
    );
    return moved.length === 1;
  }

  async release(ids: readonly string[], owner: string): Promise<number> {
    if (ids.length === 0) {
      return 0;
    }
    await this.readiness.ready();
    const p = new SqlParams();
    const released = await this.executor.query<{ id: string }>(
      `UPDATE ${this.t.messages} SET lease_owner = NULL, lease_until = NULL
WHERE lease_owner = ${p.text(owner)} AND ${p.in("id", [...ids])}
RETURNING id`,
      p.values,
    );
    return released.length;
  }

  async stats(now: number): Promise<OutboxStoreStats> {
    await this.readiness.ready();
    const p = new SqlParams();
    const at = p.bigint(epochMs(now));
    const [row] = await this.executor.query<{
      pending: string;
      ready: string;
      leased: string;
      dead_letters: string;
      oldest_due_at: string | null;
    }>(
      `SELECT
  (SELECT count(*) FROM ${this.t.messages})::text AS pending,
  (SELECT count(*) FROM (
    SELECT m.key, m.available_at <= ${at} AND (m.lease_until IS NULL OR m.lease_until <= ${at}) AS free,
      bool_or(m.available_at > ${at} OR m.lease_until > ${at}) OVER (PARTITION BY m.key ORDER BY m.seq ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS behind
    FROM ${this.t.messages} m
  ) w WHERE w.free AND (w.key IS NULL OR NOT coalesce(w.behind, false)))::text AS ready,
  (SELECT count(*) FROM ${this.t.messages} WHERE lease_until > ${at})::text AS leased,
  (SELECT count(*) FROM ${this.t.deadLetters})::text AS dead_letters,
  (SELECT min(CASE WHEN attempts > 0 THEN created_at WHEN available_at <= ${at} THEN available_at END) FROM ${this.t.messages})::text AS oldest_due_at`,
      p.values,
    );
    return {
      pending: Number(row!.pending),
      ready: Number(row!.ready),
      leased: Number(row!.leased),
      deadLetters: Number(row!.dead_letters),
      oldestDueAt:
        row!.oldest_due_at === null ? null : Number(row!.oldest_due_at),
    };
  }

  // ---------------------------------------------------------------- dead letters
  async listDeadLetters(
    query: OutboxDeadLetterQuery,
  ): Promise<OutboxDeadLetter[]> {
    const { limit, offset } = deadLetterPage(query);
    await this.readiness.ready();
    const p = new SqlParams();
    const where = [
      ...(query.topic !== undefined
        ? [`d.topic = ${p.text(query.topic)}`]
        : []),
      ...(query.key !== undefined ? [`d.key = ${p.text(query.key)}`] : []),
    ];
    const rows = await this.executor.query<Row>(
      `SELECT ${columns(DEAD_LETTER_COLUMNS, "d")} FROM ${this.t.deadLetters} d${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""}
ORDER BY d.failed_at DESC, d.id COLLATE "C" DESC LIMIT ${p.int(limit)} OFFSET ${p.int(offset)}`,
      p.values,
    );
    return rows.map(toDeadLetter);
  }

  async getDeadLetter(id: string): Promise<OutboxDeadLetter | undefined> {
    await this.readiness.ready();
    const p = new SqlParams();
    const [row] = await this.executor.query<Row>(
      `SELECT ${columns(DEAD_LETTER_COLUMNS, "d")} FROM ${this.t.deadLetters} d WHERE d.id = ${p.text(id)}`,
      p.values,
    );
    return row && toDeadLetter(row);
  }

  async requeueDeadLetters(
    filter: OutboxDeadLetterFilter,
    now: number,
  ): Promise<number> {
    const conditions = deadLetterConditions(filter);
    if (!conditions) {
      return 0;
    }
    await this.readiness.ready();
    return this.executor.transaction(async (tx) => {
      const check = new SqlParams();
      const [clash] = await tx.query<{ id: string }>(
        `SELECT d.id FROM ${this.t.deadLetters} d JOIN ${this.t.messages} m ON m.id = d.id
WHERE ${this.deadLetterWhere(check, conditions)} LIMIT 1`,
        check.values,
      );
      if (clash) {
        throw new Error(
          `PostgresOutboxStore: can't requeue dead letter "${clash.id}": a message with that id is pending.`,
        );
      }
      const p = new SqlParams();
      const [requeued] = await tx.query<{ n: string }>(
        `WITH moved AS (
  DELETE FROM ${this.t.deadLetters} d WHERE ${this.deadLetterWhere(p, conditions)} RETURNING d.*
), inserted AS (
  INSERT INTO ${this.t.messages} (seq, id, topic, payload, headers, key, created_at, available_at, attempts, last_error, history)
  SELECT seq, id, topic, payload, headers, key, created_at, ${p.bigint(epochMs(now))}, 0, last_error, history FROM moved
  RETURNING 1
)
SELECT count(*)::text AS n FROM inserted`,
        p.values,
      );
      return Number(requeued!.n);
    }, READ_COMMITTED);
  }

  async purgeDeadLetters(filter: OutboxDeadLetterFilter): Promise<number> {
    const conditions = deadLetterConditions(filter);
    if (!conditions) {
      return 0;
    }
    await this.readiness.ready();
    const p = new SqlParams();
    const [purged] = await this.executor.query<{ n: string }>(
      `WITH purged AS (DELETE FROM ${this.t.deadLetters} d WHERE ${this.deadLetterWhere(p, conditions)} RETURNING 1)
SELECT count(*)::text AS n FROM purged`,
      p.values,
    );
    return Number(purged!.n);
  }

  // ---------------------------------------------------------------- inbox
  async recordInbox(
    transaction: unknown,
    consumer: string,
    messageId: string,
    now: number,
  ): Promise<boolean> {
    let db: SqlTransaction = this.executor;
    if (transaction === undefined) {
      await this.readiness.ready();
    } else {
      db = this.inTransaction(transaction, "recordInbox");
      await this.readiness.readyIn(db);
    }
    const p = new SqlParams();
    const inserted = await db.query<{ consumer: string }>(
      `INSERT INTO ${this.t.inbox} (consumer, message_id, processed_at) VALUES (${p.text(consumer)}, ${p.text(messageId)}, ${p.bigint(epochMs(now))})
ON CONFLICT (consumer, message_id) DO NOTHING
RETURNING consumer`,
      p.values,
    );
    return inserted.length === 1;
  }

  async hasInbox(consumer: string, messageId: string): Promise<boolean> {
    await this.readiness.ready();
    const p = new SqlParams();
    const [row] = await this.executor.query<{ found: string }>(
      `SELECT EXISTS (SELECT 1 FROM ${this.t.inbox} WHERE consumer = ${p.text(consumer)} AND message_id = ${p.text(messageId)})::text AS found`,
      p.values,
    );
    return row?.found === "true";
  }

  async pruneInbox(before: number): Promise<number> {
    await this.readiness.ready();
    const p = new SqlParams();
    const [pruned] = await this.executor.query<{ n: string }>(
      `WITH pruned AS (DELETE FROM ${this.t.inbox} WHERE processed_at < ${p.bigint(Math.ceil(before))} RETURNING 1)
SELECT count(*)::text AS n FROM pruned`,
      p.values,
    );
    return Number(pruned!.n);
  }

  // ---------------------------------------------------------------- internals
  private inTransaction(transaction: unknown, method: string): SqlTransaction {
    try {
      return this.executor.wrapTransaction(transaction);
    } catch (error) {
      if (isNotATransactionError(error)) {
        throw new OutboxTransactionRequiredError(
          `PostgresOutboxStore.${method}(): ${(error as Error).message}`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  private async lockKeys(
    tx: SqlTransaction,
    messages: readonly OutboxMessage[],
  ): Promise<void> {
    const keys = [
      ...new Set(messages.flatMap((m) => (m.key === null ? [] : [m.key]))),
    ];
    if (keys.length === 0) {
      return;
    }
    const p = new SqlParams();
    await tx.query(
      `SELECT pg_advisory_xact_lock(hashtext(${p.text(`@nestjs/outbox:${this.schema}:key`)}), k.lock_id)::text AS locked
FROM (SELECT DISTINCT hashtext(value) AS lock_id FROM jsonb_array_elements_text(${p.json(keys)}) ORDER BY 1) AS k`,
      p.values,
    );
  }

  private claimable(alias: string, at: string): string {
    return `${alias}.available_at <= ${at} AND (${alias}.lease_until IS NULL OR ${alias}.lease_until <= ${at})
  AND (${alias}.key IS NULL OR NOT EXISTS (
    SELECT 1 FROM ${this.t.messages} older
    WHERE older.key = ${alias}.key AND older.seq < ${alias}.seq AND (older.available_at > ${at} OR older.lease_until > ${at})
  ))`;
  }

  private deadLetterWhere(
    p: SqlParams,
    conditions: DeadLetterConditions,
  ): string {
    const where = [
      ...(conditions.ids !== undefined
        ? [p.in("d.id", [...conditions.ids])]
        : []),
      ...(conditions.topic !== undefined
        ? [`d.topic = ${p.text(conditions.topic)}`]
        : []),
      ...(conditions.key !== undefined
        ? [`d.key = ${p.text(conditions.key)}`]
        : []),
      ...(conditions.failedBefore !== undefined
        ? [`d.failed_at < ${p.bigint(conditions.failedBefore)}`]
        : []),
    ];
    return where.length > 0 ? where.join(" AND ") : "TRUE";
  }
}
