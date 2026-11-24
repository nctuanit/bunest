import type {
  SqlExecuteResult,
  SqlExecutor,
  SqlTransaction,
  SqlTransactionOptions,
} from "../../interfaces/sql-executor.interface";
import { notATransaction } from "../../sql/not-a-transaction";
import {
  describeValue,
  hasMethod,
  isolationSql,
} from "../../utils/executor.util";
import { runTransactionWork } from "./transaction-work";

/** The part of a `Bun.SQL` transaction (`TransactionSQL`) the executor uses. */
export interface BunSqlTransactionLike {
  unsafe(query: string, values?: any[]): PromiseLike<unknown>;
  savepoint?(...args: any[]): Promise<unknown>;
}

/** The part of a `Bun.SQL` client (or `@bunest/orm` `BunSqlOrmDriver`) the executor uses. */
export interface BunSqlLike extends BunSqlTransactionLike {
  begin<T>(work: (tx: any) => Promise<T>): Promise<T>;
  begin<T>(options: string, work: (tx: any) => Promise<T>): Promise<T>;
  readonly options?: { readonly adapter?: string };
}

/** Structural wrapper holding a native `Bun.SQL` client on `.raw`. */
export interface BunSqlServiceLike {
  readonly raw: BunSqlLike;
}

/**
 * A Bun-native `SqlExecutor<'postgres'>` on `Bun.SQL` (or an `@bunest/orm` `BunSqlOrmDriver` wrapper) connected to PostgreSQL.
 * Zero external driver dependencies.
 */
export function fromBunSql(
  client: BunSqlLike | BunSqlServiceLike,
): SqlExecutor<"postgres"> {
  const sql = unwrapBunSql(client);
  if (!isBunSqlRoot(sql)) {
    throw new TypeError(
      isBunSqlTransaction(client)
        ? "fromBunSql() takes a Bun.SQL instance, not a transaction: pass the tx to a store method that takes your transaction ({ transaction: tx })."
        : `fromBunSql() takes a Bun.SQL instance (or SqlService), got ${describeValue(client)}.`,
    );
  }
  const adapter = sql.options?.adapter;
  if (
    adapter !== undefined &&
    adapter !== "postgres" &&
    adapter !== "postgresql"
  ) {
    throw new TypeError(
      `fromBunSql() takes a Bun.SQL instance connected to PostgreSQL, not '${adapter}'.`,
    );
  }
  return new BunSqlPostgresExecutor(sql);
}

class BunSqlPostgresExecutor implements SqlExecutor<"postgres"> {
  readonly dialect = "postgres" as const;

  constructor(private readonly sql: BunSqlLike) {}

  query<R extends object = Record<string, unknown>>(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<R[]> {
    return run<R>(this.sql, text, params);
  }

  execute(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<SqlExecuteResult> {
    return write(this.sql, text, params);
  }

  async transaction<T>(
    work: (transaction: SqlTransaction) => Promise<T>,
    options: SqlTransactionOptions = {},
  ): Promise<T> {
    const inTransaction = (tx: BunSqlTransactionLike) =>
      runTransactionWork(work, bunSqlTransaction(tx, tx));
    if (!options.isolationLevel) {
      return this.sql.begin(inTransaction);
    }
    return this.sql.begin(
      `ISOLATION LEVEL ${isolationSql(options.isolationLevel)}`,
      inTransaction,
    );
  }

  wrapTransaction(transaction: unknown): SqlTransaction {
    const tx = unwrapBunSqlTransaction(transaction);
    if (!tx) {
      throw notATransaction(
        isBunSqlRoot(unwrapBunSql(transaction))
          ? "Pass the tx your sql.begin() callback receives, not the Bun.SQL instance: it runs each statement outside your transaction."
          : `Pass the tx your Bun.SQL begin() callback receives, got ${describeValue(transaction)}.`,
      );
    }
    return bunSqlTransaction(tx, transaction);
  }
}

function bunSqlTransaction(
  tx: BunSqlTransactionLike,
  native: unknown,
): SqlTransaction {
  return {
    query: <R extends object = Record<string, unknown>>(
      text: string,
      params: readonly unknown[] = [],
    ) => run<R>(tx, text, params),
    execute: (text: string, params: readonly unknown[] = []) =>
      write(tx, text, params),
    native,
  };
}

async function run<R extends object>(
  db: BunSqlTransactionLike,
  text: string,
  params: readonly unknown[],
): Promise<R[]> {
  const result = await db.unsafe(text, [...params]);
  return (Array.isArray(result) ? [...result] : []) as R[];
}

async function write(
  db: BunSqlTransactionLike,
  text: string,
  params: readonly unknown[],
): Promise<SqlExecuteResult> {
  const result = (await db.unsafe(text, [...params])) as
    | { count?: unknown; affectedRows?: unknown }
    | undefined;
  const affectedRows =
    typeof result?.count === "number"
      ? result.count
      : typeof result?.affectedRows === "number"
        ? result.affectedRows
        : 0;
  return { affectedRows };
}

function unwrapBunSql(value: unknown): unknown {
  if (
    typeof value === "object" &&
    value !== null &&
    "raw" in value &&
    hasMethod((value as { raw?: unknown }).raw, "begin")
  ) {
    return (value as { raw: unknown }).raw;
  }
  return value;
}

function isBunSqlRoot(value: unknown): value is BunSqlLike {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { unsafe?: unknown }).unsafe === "function" &&
    typeof (value as { begin?: unknown }).begin === "function"
  );
}

function isBunSqlTransaction(value: unknown): value is BunSqlTransactionLike {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { unsafe?: unknown }).unsafe === "function" &&
    typeof (value as { savepoint?: unknown }).savepoint === "function" &&
    typeof (value as { begin?: unknown }).begin !== "function"
  );
}

function unwrapBunSqlTransaction(
  value: unknown,
): BunSqlTransactionLike | undefined {
  if (isBunSqlTransaction(value)) {
    return value;
  }
  if (
    typeof value === "object" &&
    value !== null &&
    "client" in value &&
    isBunSqlTransaction((value as { client?: unknown }).client)
  ) {
    return (value as { client: BunSqlTransactionLike }).client;
  }
  return undefined;
}
