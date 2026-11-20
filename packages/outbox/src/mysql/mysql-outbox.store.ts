import { Logger, type OnModuleInit } from "@bunest/common";
import {
  columns,
  ensureLockRows,
  isNotATransactionError,
  lockKeys,
  type MigrationSqlOptions,
  type MigrationStatementsOptions,
  mysqlErrorCode,
  type MySqlStoreReadiness,
  quoteTable,
  retryOnDeadlock,
  type SqlExecutor,
  SqlParams,
  type SqlTransaction,
} from "@bunest/store-kit/mysql";
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
import type { MySqlOutboxStoreOptions } from "./interfaces/mysql-outbox-store-options.interface";
import { mysqlOutboxSchema } from "./migrations/index";
import {
  bucketLocks,
  checkLength,
  keyLocks,
} from "./mysql-outbox-keys.util";

const DUPLICATE_KEY = 1062;
const CLAIM_LOCK = "claim";
const IDS_PER_STATEMENT = 1_000;
const BATCH_JSON_LENGTH = 1 << 20;
const MARIADB_BATCH_JSON_LENGTH = 1 << 16;
const GAP_READS_PER_STATEMENT = 250;

interface DueRow extends Row {
  seq: string;
}

/**
 * The first-party `OutboxStore` and `OutboxInboxStore` on MySQL and MariaDB, built on `@bunest/store-kit/mysql`.
 */
export class MySqlOutboxStore
  implements OutboxStore, OutboxInboxStore, OnModuleInit
{
  static readonly schemaVersion: number = mysqlOutboxSchema.latest;

  static migrationSql(options: MigrationSqlOptions = {}): string {
    return mysqlOutboxSchema.sql(options);
  }

  static migrationStatements(options: MigrationStatementsOptions = {}): string[] {
    return mysqlOutboxSchema.statements(options);
  }

  private readonly logger = new Logger("OutboxModule");
  private readonly executor: SqlExecutor;
  private readonly schema: string;
  private readonly t: { messages: string; deadLetters: string; inbox: string };
  private readonly readiness: MySqlStoreReadiness;
  private lockRows?: Promise<void>;

  constructor(options: MySqlOutboxStoreOptions, storage?: OutboxStorage) {
    const resolved = mysqlOutboxSchema.resolveOptions(options);
    this.executor = resolved.executor;
    this.schema = resolved.schema;
    const table = (name: string) =>
      quoteTable(this.schema, name, mysqlOutboxSchema.storeName);
    this.t = {
      messages: table("messages"),
      deadLetters: table("dead_letters"),
      inbox: table("inbox"),
    };
    this.readiness = mysqlOutboxSchema.readiness({
      ...resolved,
      logger: this.logger,
    });
    storage?.registerSource({ messages: this, inbox: this });
  }

  async onModuleInit(): Promise<void> {
    await this.ready();
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
    const rows = messages.map((m) => {
      checkLength(m.id, "a message id", "add");
      checkLength(m.topic, "a topic", "add");
      if (m.key !== null && m.key !== undefined) {
        checkLength(m.key, "a key", "add");
      }
      return {
        id: m.id,
        topic: m.topic,
        payload: m.payload,
        headers: m.headers,
        key: m.key ?? null,
        createdAt: epochMs(m.createdAt),
        availableAt: epochMs(m.availableAt),
      };
    });
    await this.readiness.readyIn(tx);
    const locks = keyLocks(rows.map((row) => row.key));
    if (locks.length > 0) {
      await lockKeys(tx, this.schema, locks);
    }
    const mariadb = this.readiness.server === "mariadb";
    for (const batch of batches(
      rows,
      mariadb ? MARIADB_BATCH_JSON_LENGTH : BATCH_JSON_LENGTH,
    )) {
      const p = new SqlParams();
      await tx.execute(
        `INSERT INTO ${this.t.messages} (id, topic, payload, headers, \`key\`, created_at, available_at, history)
SELECT j.id, j.topic, NULLIF(j.payload, JSON_EXTRACT('null', '$')), j.headers, j.message_key, j.created_at, j.available_at, JSON_ARRAY()
FROM (SELECT n FROM JSON_TABLE(${p.json(batch.map(() => null))}, '$[*]' COLUMNS (n FOR ORDINALITY)) AS x) AS o
CROSS JOIN (SELECT ${mariadb ? p.text(JSON.stringify(batch)) : p.json(batch)} AS doc) AS d
CROSS JOIN JSON_TABLE(JSON_EXTRACT(d.doc, CONCAT('$[', o.n - 1, ']')), '$' COLUMNS (
  id varchar(255) PATH '$.id' ERROR ON ERROR,
  topic varchar(255) PATH '$.topic' ERROR ON ERROR,
  payload json PATH '$.payload' ERROR ON ERROR,
  headers json PATH '$.headers' ERROR ON ERROR,
  message_key varchar(255) PATH '$.key' ERROR ON ERROR,
  created_at bigint PATH '$.createdAt' ERROR ON ERROR,
  available_at bigint PATH '$.availableAt' ERROR ON ERROR
)) AS j
ORDER BY o.n`,
        p.values,
      );
    }
  }

  // ---------------------------------------------------------------- relay
  async claim({
    owner,
    now,
    leaseMs,
    limit,
  }: OutboxClaimRequest): Promise<OutboxMessage[]> {
    checkLength(owner, "a lease owner", "claim");
    await this.ready();
    const at = epochMs(now);
    const until = epochMs(now + leaseMs);
    return retryOnDeadlock(this.executor, async (tx) => {
      await lockKeys(tx, this.schema, CLAIM_LOCK);
      const p = new SqlParams();
      const due = await tx.query<DueRow>(
        `SELECT CAST(m.seq AS CHAR) AS seq, ${columns(MESSAGE_COLUMNS, "m")}
FROM ${this.t.messages} m FORCE INDEX (PRIMARY)
WHERE m.available_at <= ${p.bigint(at)} AND (m.lease_until IS NULL OR m.lease_until <= ${p.bigint(at)})
  AND (m.\`key\` IS NULL OR (
    SELECT o.seq FROM ${this.t.messages} o FORCE INDEX (messages_key_seq)
    WHERE o.\`key\` = m.\`key\` AND (o.seq >= m.seq OR o.available_at > ${p.bigint(at)} OR o.lease_until > ${p.bigint(at)})
    ORDER BY o.\`key\`, o.seq
    LIMIT 1
  ) = m.seq)
ORDER BY m.seq
LIMIT ${p.limit(limit)}
FOR UPDATE SKIP LOCKED`,
        p.values,
      );
      if (due.length === 0) {
        return [];
      }
      const gaps = await this.gaps(tx, due);
      const cut = new Set<string>();
      const taken = due.filter((row) => {
        const key = row.key;
        if (key === null || key === undefined) {
          return true;
        }
        if (cut.has(key) || gaps.has(row.seq)) {
          cut.add(key);
          return false;
        }
        return true;
      });
      if (taken.length > 0) {
        const u = new SqlParams();
        await tx.execute(
          `UPDATE ${this.t.messages} FORCE INDEX (PRIMARY) SET lease_owner = ${u.text(owner)}, lease_until = ${u.bigint(until)}
WHERE seq IN (${taken.map((row) => `CAST(${u.text(row.seq)} AS SIGNED)`).join(", ")})`,
          u.values,
        );
      }
      return taken.map(toMessage);
    });
  }

  async markPublished(id: string, owner: string): Promise<boolean> {
    await this.ready();
    const p = new SqlParams();
    const { affectedRows } = await this.executor.execute(
      `DELETE FROM ${this.t.messages} WHERE id = ${p.text(id)} AND lease_owner = ${p.text(owner)}`,
      p.values,
    );
    return affectedRows === 1;
  }

  async reschedule(
    id: string,
    owner: string,
    update: OutboxRescheduleUpdate,
  ): Promise<boolean> {
    await this.ready();
    const p = new SqlParams();
    const { affectedRows } = await this.executor.execute(
      `UPDATE ${this.t.messages}
SET attempts = ${p.int(update.attempts)}, available_at = ${p.bigint(epochMs(update.availableAt))}, last_error = ${p.text(update.error.error)},
  history = JSON_MERGE_PRESERVE(history, ${p.json([update.error])}), lease_owner = NULL, lease_until = NULL
WHERE id = ${p.text(id)} AND lease_owner = ${p.text(owner)}`,
      p.values,
    );
    return affectedRows === 1;
  }

  async deadLetter(
    id: string,
    owner: string,
    update: OutboxDeadLetterUpdate,
  ): Promise<boolean> {
    await this.ready();
    return retryOnDeadlock(this.executor, async (tx) => {
      const p = new SqlParams();
      const [held] = await tx.query<{ seq: string }>(
        `SELECT CAST(m.seq AS CHAR) AS seq FROM ${this.t.messages} m WHERE m.id = ${p.text(id)} AND m.lease_owner = ${p.text(owner)} FOR UPDATE`,
        p.values,
      );
      if (!held) {
        return false;
      }
      const d = new SqlParams();
      await tx.execute(
        `DELETE FROM ${this.t.deadLetters} WHERE id = ${d.text(id)}`,
        d.values,
      );
      const i = new SqlParams();
      await tx.execute(
        `INSERT INTO ${this.t.deadLetters} (id, seq, topic, payload, headers, \`key\`, created_at, attempts, last_error, history, reason, failed_at)
SELECT m.id, m.seq, m.topic, m.payload, m.headers, m.\`key\`, m.created_at, ${i.int(update.attempts)}, ${i.text(update.error.error)},
  JSON_MERGE_PRESERVE(m.history, ${i.json([update.error])}), ${i.text(update.reason)}, ${i.bigint(epochMs(update.failedAt))}
FROM ${this.t.messages} m WHERE m.seq = CAST(${i.text(held.seq)} AS SIGNED)`,
        i.values,
      );
      const x = new SqlParams();
      await tx.execute(
        `DELETE FROM ${this.t.messages} WHERE seq = CAST(${x.text(held.seq)} AS SIGNED)`,
        x.values,
      );
      return true;
    });
  }

  async release(ids: readonly string[], owner: string): Promise<number> {
    if (ids.length === 0) {
      return 0;
    }
    await this.ready();
    return retryOnDeadlock(this.executor, async (tx) => {
      let released = 0;
      for (const chunk of chunks(ids)) {
        const p = new SqlParams();
        const { affectedRows } = await tx.execute(
          `UPDATE ${this.t.messages} SET lease_owner = NULL, lease_until = NULL WHERE lease_owner = ${p.text(owner)} AND ${p.in("id", chunk)}`,
          p.values,
        );
        released += affectedRows;
      }
      return released;
    });
  }

  async stats(now: number): Promise<OutboxStoreStats> {
    await this.ready();
    const p = new SqlParams();
    const at = epochMs(now);
    const [row] = await this.executor.query<{
      pending: string;
      ready: string;
      leased: string;
      dead_letters: string;
      oldest_due_at: string | null;
    }>(
      `SELECT
  CAST((SELECT COUNT(*) FROM ${this.t.messages}) AS CHAR) AS pending,
  CAST((SELECT COUNT(*) FROM (
    SELECT w.message_key, w.free, SUM(w.blocking) OVER (PARTITION BY w.message_key ORDER BY w.seq ROWS UNBOUNDED PRECEDING) AS blocked
    FROM (
      SELECT m.\`key\` AS message_key, m.seq,
        m.available_at <= ${p.bigint(at)} AND (m.lease_until IS NULL OR m.lease_until <= ${p.bigint(at)}) AS free,
        CASE WHEN m.available_at > ${p.bigint(at)} OR m.lease_until > ${p.bigint(at)} THEN 1 ELSE 0 END AS blocking
      FROM ${this.t.messages} m
    ) w
  ) r WHERE r.free AND (r.message_key IS NULL OR r.blocked = 0)) AS CHAR) AS ready,
  CAST((SELECT COUNT(*) FROM ${this.t.messages} WHERE lease_until > ${p.bigint(at)}) AS CHAR) AS leased,
  CAST((SELECT COUNT(*) FROM ${this.t.deadLetters}) AS CHAR) AS dead_letters,
  CAST((SELECT MIN(CASE WHEN attempts > 0 THEN created_at WHEN available_at <= ${p.bigint(at)} THEN available_at END) FROM ${this.t.messages}) AS CHAR) AS oldest_due_at`,
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
    await this.ready();
    const p = new SqlParams();
    const where = [
      ...(query.topic !== undefined ? [`d.topic = ${p.text(query.topic)}`] : []),
      ...(query.key !== undefined ? [`d.\`key\` = ${p.text(query.key)}`] : []),
    ];
    const rows = await this.executor.query<Row>(
      `SELECT ${columns(DEAD_LETTER_COLUMNS, "d")} FROM ${this.t.deadLetters} d${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""}
ORDER BY d.failed_at DESC, d.id DESC LIMIT ${p.limit(limit)} OFFSET ${p.limit(offset)}`,
      p.values,
    );
    return rows.map(toDeadLetter);
  }

  async getDeadLetter(id: string): Promise<OutboxDeadLetter | undefined> {
    await this.ready();
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
    await this.ready();
    return retryOnDeadlock(this.executor, async (tx) => {
      const p = new SqlParams();
      const matched = await tx.query<{ id: string }>(
        `SELECT d.id FROM ${this.t.deadLetters} d WHERE ${this.deadLetterWhere(p, conditions)} ORDER BY d.id FOR UPDATE`,
        p.values,
      );
      const ids = matched.map((row) => row.id);
      for (const chunk of chunks(ids)) {
        await this.refuseClash(tx, chunk);
      }
      let requeued = 0;
      for (const chunk of chunks(ids)) {
        const i = new SqlParams();
        try {
          const { affectedRows } = await tx.execute(
            `INSERT INTO ${this.t.messages} (seq, id, topic, payload, headers, \`key\`, created_at, available_at, attempts, last_error, history)
SELECT d.seq, d.id, d.topic, d.payload, d.headers, d.\`key\`, d.created_at, ${i.bigint(epochMs(now))}, 0, d.last_error, d.history
FROM ${this.t.deadLetters} d WHERE ${i.in("d.id", chunk)} ORDER BY d.seq`,
            i.values,
          );
          requeued += affectedRows;
        } catch (error) {
          if (mysqlErrorCode(error) === DUPLICATE_KEY) {
            await this.refuseClash(tx, chunk);
          }
          throw error;
        }
        const x = new SqlParams();
        await tx.execute(
          `DELETE FROM ${this.t.deadLetters} WHERE ${x.in("id", chunk)}`,
          x.values,
        );
      }
      return requeued;
    });
  }

  async purgeDeadLetters(filter: OutboxDeadLetterFilter): Promise<number> {
    const conditions = deadLetterConditions(filter);
    if (!conditions) {
      return 0;
    }
    await this.ready();
    return retryOnDeadlock(this.executor, async (tx) => {
      const p = new SqlParams();
      const { affectedRows } = await tx.execute(
        `DELETE d FROM ${this.t.deadLetters} AS d WHERE ${this.deadLetterWhere(p, conditions)}`,
        p.values,
      );
      return affectedRows;
    });
  }

  // ---------------------------------------------------------------- inbox
  async recordInbox(
    transaction: unknown,
    consumer: string,
    messageId: string,
    now: number,
  ): Promise<boolean> {
    let db: SqlTransaction = this.executor;
    if (transaction !== undefined) {
      db = this.inTransaction(transaction, "recordInbox");
    }
    checkLength(consumer, "a consumer name", "recordInbox");
    checkLength(messageId, "a message id", "recordInbox");
    await (transaction === undefined
      ? this.ready()
      : this.readiness.readyIn(db));
    const p = new SqlParams();
    try {
      await db.execute(
        `INSERT INTO ${this.t.inbox} (consumer, message_id, processed_at) VALUES (${p.text(consumer)}, ${p.text(messageId)}, ${p.bigint(epochMs(now))})`,
        p.values,
      );
      return true;
    } catch (error) {
      if (mysqlErrorCode(error) === DUPLICATE_KEY) {
        return false;
      }
      throw error;
    }
  }

  async hasInbox(consumer: string, messageId: string): Promise<boolean> {
    checkLength(consumer, "a consumer name", "hasInbox");
    checkLength(messageId, "a message id", "hasInbox");
    await this.ready();
    const p = new SqlParams();
    const rows = await this.executor.query<{ found: string }>(
      `SELECT CAST(1 AS CHAR) AS found FROM ${this.t.inbox} WHERE consumer = ${p.text(consumer)} AND message_id = ${p.text(messageId)} LIMIT 1`,
      p.values,
    );
    return rows.length === 1;
  }

  async pruneInbox(before: number): Promise<number> {
    await this.ready();
    return retryOnDeadlock(this.executor, async (tx) => {
      const p = new SqlParams();
      const { affectedRows } = await tx.execute(
        `DELETE FROM ${this.t.inbox} WHERE processed_at < ${p.bigint(Math.ceil(before))}`,
        p.values,
      );
      return affectedRows;
    });
  }

  // ---------------------------------------------------------------- internals
  private async ready(): Promise<void> {
    await this.readiness.ready();
    await (this.lockRows ??= this.createLockRows());
  }

  private createLockRows(): Promise<void> {
    return ensureLockRows(this.executor, this.schema, [
      CLAIM_LOCK,
      ...bucketLocks(),
    ]).catch((error) => {
      this.lockRows = undefined;
      throw error;
    });
  }

  private inTransaction(transaction: unknown, method: string): SqlTransaction {
    const refused = (error: unknown) =>
      isNotATransactionError(error)
        ? new OutboxTransactionRequiredError(
            `MySqlOutboxStore.${method}(): ${(error as Error).message}`,
            { cause: error },
          )
        : error;
    let tx: SqlTransaction;
    try {
      tx = this.executor.wrapTransaction(transaction);
    } catch (error) {
      throw refused(error);
    }
    let first = true;
    const run = async <R>(statement: () => Promise<R>): Promise<R> => {
      if (!first) {
        return statement();
      }
      first = false;
      try {
        return await statement();
      } catch (error) {
        throw refused(error);
      }
    };
    return {
      query: <TRow extends object = Record<string, unknown>>(
        text: string,
        params?: readonly unknown[],
      ) => run(() => tx.query<TRow>(text, params)),
      execute: (text: string, params?: readonly unknown[]) =>
        run(() => tx.execute(text, params)),
    };
  }

  private async gaps(
    tx: SqlTransaction,
    due: readonly DueRow[],
  ): Promise<Set<string>> {
    const reads: Array<{ seq: string; key: string; after?: string }> = [];
    const previous = new Map<string, string>();
    for (const row of due) {
      if (row.key === null || row.key === undefined) {
        continue;
      }
      reads.push({ seq: row.seq, key: row.key, after: previous.get(row.key) });
      previous.set(row.key, row.seq);
    }
    const gaps = new Set<string>();
    for (let start = 0; start < reads.length; start += GAP_READS_PER_STATEMENT) {
      const p = new SqlParams();
      const statement = reads
        .slice(start, start + GAP_READS_PER_STATEMENT)
        .map(
          ({ seq, key, after }) =>
            `(SELECT CAST(${p.text(seq)} AS CHAR) AS seq FROM ${this.t.messages} o FORCE INDEX (messages_key_seq)
WHERE o.\`key\` = ${p.text(key)} AND o.seq < CAST(${p.text(seq)} AS SIGNED)${after === undefined ? "" : ` AND o.seq > CAST(${p.text(after)} AS SIGNED)`}
LIMIT 1)`,
        )
        .join("\nUNION ALL\n");
      for (const row of await tx.query<{ seq: string }>(statement, p.values)) {
        gaps.add(row.seq);
      }
    }
    return gaps;
  }

  private async refuseClash(
    tx: SqlTransaction,
    ids: readonly string[],
  ): Promise<void> {
    const p = new SqlParams();
    const [clash] = await tx.query<{ id: string }>(
      `SELECT m.id FROM ${this.t.messages} m WHERE ${p.in("m.id", ids)} ORDER BY m.id LIMIT 1`,
      p.values,
    );
    if (clash) {
      throw new Error(
        `MySqlOutboxStore: can't requeue dead letter "${clash.id}": a message with that id is pending.`,
      );
    }
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
        ? [`d.\`key\` = ${p.text(conditions.key)}`]
        : []),
      ...(conditions.failedBefore !== undefined
        ? [`d.failed_at < ${p.bigint(conditions.failedBefore)}`]
        : []),
    ];
    return where.length > 0 ? where.join(" AND ") : "TRUE";
  }
}

function chunks<T>(values: readonly T[]): T[][] {
  const result: T[][] = [];
  for (let start = 0; start < values.length; start += IDS_PER_STATEMENT) {
    result.push(values.slice(start, start + IDS_PER_STATEMENT));
  }
  return result;
}

function batches<T>(rows: readonly T[], maxLength: number): T[][] {
  const result: T[][] = [];
  let batch: T[] = [];
  let length = 0;
  for (const row of rows) {
    const size = JSON.stringify(row).length + 1;
    if (batch.length > 0 && length + size > maxLength) {
      result.push(batch);
      batch = [];
      length = 0;
    }
    batch.push(row);
    length += size;
  }
  if (batch.length > 0) {
    result.push(batch);
  }
  return result;
}
