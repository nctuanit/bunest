import type {
  SqlExecuteResult,
  SqlTransactionOptions,
} from "../../interfaces/sql-executor.interface";
import { notATransaction } from "../../sql/not-a-transaction";
import {
  describeValue,
  hasMethod,
  isolationSql,
} from "../../utils/executor.util";
import type {
  SqlExecutor,
  SqlTransaction,
} from "../interfaces/mysql-executor.interface";
import { checkPlaceholders } from "./mysql-client.util";

/** The part of a `Bun.SQL` transaction (`TransactionSQL`) the executor uses. */
export interface BunSqlMySqlTransactionLike {
  unsafe(query: string, values?: any[]): PromiseLike<unknown>;
  savepoint?(...args: any[]): Promise<unknown>;
}

/** The part of a reserved `Bun.SQL` connection (`ReservedSQL`) the executor uses. */
export interface BunSqlMySqlReservedLike extends BunSqlMySqlTransactionLike {
  release(): void;
}

/** The part of a `Bun.SQL` client (or `@bunest/orm` `BunSqlOrmDriver`) the executor uses. */
export interface BunSqlMySqlLike extends BunSqlMySqlTransactionLike {
  begin<T>(work: (tx: any) => Promise<T>): Promise<T>;
  begin<T>(options: string, work: (tx: any) => Promise<T>): Promise<T>;
  reserve?(): Promise<BunSqlMySqlReservedLike>;
  readonly options?: { readonly adapter?: string };
}

/** Structural wrapper holding a native `Bun.SQL` client on `.raw`. */
export interface BunSqlMySqlServiceLike {
  readonly raw: BunSqlMySqlLike;
}

/**
 * A Bun-native `SqlExecutor` on `Bun.SQL` (or an `@bunest/orm` `BunSqlOrmDriver` wrapper) connected to MySQL or MariaDB.
 * Zero external driver dependencies.
 */
export function fromBunSql(
  client: BunSqlMySqlLike | BunSqlMySqlServiceLike,
): SqlExecutor {
  const sql = unwrapBunSql(client);
  if (!isBunSqlRoot(sql)) {
    throw new TypeError(
      isBunSqlTransaction(client)
        ? "fromBunSql() takes a Bun.SQL instance, not a transaction: pass the tx to a store method that takes your transaction ({ transaction: tx })."
        : `fromBunSql() takes a Bun.SQL instance (or SqlService), got ${describeValue(client)}.`,
    );
  }
  const adapter = sql.options?.adapter;
  if (adapter !== undefined && adapter !== "mysql" && adapter !== "mariadb") {
    throw new TypeError(
      `fromBunSql() takes a Bun.SQL instance connected to MySQL or MariaDB, not '${adapter}'.`,
    );
  }
  return new BunSqlMySqlExecutor(sql);
}

class BunSqlMySqlExecutor implements SqlExecutor {
  readonly dialect = "mysql" as const;

  constructor(private readonly sql: BunSqlMySqlLike) {}

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
    if (!options.isolationLevel) {
      return this.sql.begin((tx: BunSqlMySqlTransactionLike) =>
        work(bunSqlTransaction(tx, tx)),
      );
    }
    const isolation = isolationSql(options.isolationLevel);
    if (typeof this.sql.reserve === "function") {
      const reserved = await this.sql.reserve();
      try {
        await reserved.unsafe(`SET TRANSACTION ISOLATION LEVEL ${isolation}`);
        await reserved.unsafe("START TRANSACTION");
        let result: T;
        try {
          result = await work(bunSqlTransaction(reserved, reserved));
        } catch (error) {
          await Promise.resolve(reserved.unsafe("ROLLBACK")).catch(
            () => undefined,
          );
          throw error;
        }
        await reserved.unsafe("COMMIT");
        return result;
      } finally {
        reserved.release();
      }
    }
    return this.sql.begin(isolation, (tx: BunSqlMySqlTransactionLike) =>
      work(bunSqlTransaction(tx, tx)),
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
  tx: BunSqlMySqlTransactionLike,
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
  db: BunSqlMySqlTransactionLike,
  text: string,
  params: readonly unknown[],
): Promise<R[]> {
  checkPlaceholders(text, params);
  const result = await db.unsafe(text, [...params]);
  return (Array.isArray(result) ? [...result] : []) as R[];
}

async function write(
  db: BunSqlMySqlTransactionLike,
  text: string,
  params: readonly unknown[],
): Promise<SqlExecuteResult> {
  checkPlaceholders(text, params);
  const result = (await db.unsafe(text, [...params])) as
    | { affectedRows?: unknown; count?: unknown }
    | undefined;
  let affectedRows = 0;
  if (typeof result?.affectedRows === "number") {
    affectedRows = result.affectedRows;
  } else if (typeof result?.count === "number") {
    affectedRows = result.count;
  }
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

function isBunSqlRoot(value: unknown): value is BunSqlMySqlLike {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { unsafe?: unknown }).unsafe === "function" &&
    typeof (value as { begin?: unknown }).begin === "function"
  );
}

function isBunSqlTransaction(
  value: unknown,
): value is BunSqlMySqlTransactionLike {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { unsafe?: unknown }).unsafe === "function" &&
    (typeof (value as { savepoint?: unknown }).savepoint === "function" ||
      typeof (value as { release?: unknown }).release === "function") &&
    typeof (value as { begin?: unknown }).begin !== "function"
  );
}

function unwrapBunSqlTransaction(
  value: unknown,
): BunSqlMySqlTransactionLike | undefined {
  if (isBunSqlTransaction(value)) {
    return value;
  }
  if (
    typeof value === "object" &&
    value !== null &&
    "client" in value &&
    isBunSqlTransaction((value as { client?: unknown }).client)
  ) {
    return (value as { client: BunSqlMySqlTransactionLike }).client;
  }
  return undefined;
}
