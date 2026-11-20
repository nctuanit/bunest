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
  isMysql2Client,
  isolationSql,
} from "../../utils/executor.util";
import { runTransactionWork, transactionEnded } from "./transaction-work";

/**
 * The part of a node-postgres `Client` (or `PoolClient`) the executor uses.
 */
export interface PgClientLike {
  query(
    text: string,
    values?: any[],
  ): Promise<{
    rows: any[];
    rowCount?: number | null;
    command?: string;
  }>;
  connect(): Promise<unknown>;
  on?(event: "error", listener: (error: Error) => void): unknown;
  removeListener?(event: "error", listener: (error: Error) => void): unknown;
  getTransactionStatus?(): string | null;
}

/** A connection a node-postgres `Pool` hands out. */
type PgPoolClientLike = PgClientLike & {
  release(error?: Error | boolean): void;
};

/** The part of a node-postgres `Pool` the executor uses. */
export interface PgPoolLike {
  query(
    text: string,
    values?: any[],
  ): Promise<{
    rows: any[];
    rowCount?: number | null;
  }>;
  connect(): Promise<PgPoolClientLike>;
  connect(
    callback: (
      error: Error | undefined,
      client: PgPoolClientLike | undefined,
    ) => void,
  ): void;
  readonly totalCount: number;
}

type QueryablePgClient = Pick<PgClientLike, "query" | "getTransactionStatus">;

/**
 * A `SqlExecutor` on node-postgres (`pg`): a `Pool` or a connected `Client`.
 */
export function fromPg(
  pool: PgPoolLike | PgClientLike,
): SqlExecutor<"postgres"> {
  if (isMysql2Client(pool)) {
    throw new TypeError(
      "fromPg() takes a node-postgres Pool (or a connected Client), not a mysql2 pool or connection: a MySQL store takes that, through fromMysql2() from its package's /mysql subpath.",
    );
  }
  if (!hasMethod(pool, "query")) {
    throw new TypeError(
      `fromPg() takes a node-postgres Pool (or a connected Client), got ${describeValue(pool)}.`,
    );
  }
  return isPool(pool)
    ? new PgPoolExecutor(pool)
    : new PgClientExecutor(pool);
}

class PgPoolExecutor implements SqlExecutor<"postgres"> {
  readonly dialect = "postgres" as const;

  constructor(private readonly pool: PgPoolLike) {}

  async query<R extends object = Record<string, unknown>>(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<R[]> {
    return (await this.pool.query(text, [...params])).rows as R[];
  }

  async execute(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<SqlExecuteResult> {
    return affected(await this.pool.query(text, [...params]));
  }

  async transaction<T>(
    work: (transaction: SqlTransaction) => Promise<T>,
    options: SqlTransactionOptions = {},
  ): Promise<T> {
    const begin = beginSql(options);
    let lost: Error | undefined;
    const onError = (error: Error) => {
      lost ??= error;
    };
    const client = await new Promise<PgPoolClientLike>((resolve, reject) =>
      this.pool.connect((error, conn) => {
        if (error || !conn) {
          reject(error);
          return;
        }
        conn.on?.("error", onError);
        resolve(conn);
      }),
    );
    const connection: QueryablePgClient = {
      query: (text, values) =>
        lost ? Promise.reject(lost) : client.query(text, values),
      getTransactionStatus: () => client.getTransactionStatus?.() ?? null,
    };
    const outcome = await runTransaction(connection, work, begin, client);
    client.removeListener?.("error", onError);
    client.release(outcome.broken ?? lost);
    if ("error" in outcome) {
      throw outcome.error;
    }
    return outcome.result;
  }

  wrapTransaction(transaction: unknown): SqlTransaction {
    return pgTransaction(transaction);
  }
}

class PgClientExecutor implements SqlExecutor<"postgres"> {
  readonly dialect = "postgres" as const;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly client: PgClientLike) {}

  query<R extends object = Record<string, unknown>>(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<R[]> {
    return this.exclusive(
      async () => (await this.client.query(text, [...params])).rows as R[],
    );
  }

  execute(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<SqlExecuteResult> {
    return this.exclusive(async () =>
      affected(await this.client.query(text, [...params])),
    );
  }

  async transaction<T>(
    work: (transaction: SqlTransaction) => Promise<T>,
    options: SqlTransactionOptions = {},
  ): Promise<T> {
    const begin = beginSql(options);
    return this.exclusive(async () => {
      const outcome = await runTransaction(
        this.client,
        work,
        begin,
        this.client,
      );
      if ("error" in outcome) {
        throw outcome.error;
      }
      return outcome.result;
    });
  }

  wrapTransaction(transaction: unknown): SqlTransaction {
    return pgTransaction(transaction);
  }

  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task, task);
    this.tail = run.catch(() => undefined);
    return run;
  }
}

function beginSql(options: SqlTransactionOptions): string {
  return options.isolationLevel
    ? `BEGIN ISOLATION LEVEL ${isolationSql(options.isolationLevel)}`
    : "BEGIN";
}

async function runTransaction<T>(
  client: QueryablePgClient,
  work: (transaction: SqlTransaction) => Promise<T>,
  begin: string,
  native: unknown,
): Promise<{ result: T; broken?: Error } | { error: unknown; broken?: Error }> {
  let tagged: boolean;
  try {
    tagged = (await client.query(begin)).command === "BEGIN";
  } catch (error) {
    return { error, broken: asError(error) };
  }
  let result: T;
  try {
    result = await runTransactionWork(work, clientTransaction(client, native), {
      commitReplyTells: tagged,
    });
  } catch (error) {
    try {
      await client.query("ROLLBACK");
      return { error };
    } catch (rollbackError) {
      return { error, broken: asError(rollbackError) };
    }
  }
  try {
    const committed = await client.query("COMMIT");
    if (tagged && committed.command === "ROLLBACK") {
      return { error: transactionEnded() };
    }
    return { result };
  } catch (error) {
    const idle = await client.query("SELECT 1").then(
      () => (client.getTransactionStatus?.() ?? "I") === "I",
      () => false,
    );
    return idle ? { error } : { error, broken: asError(error) };
  }
}

function pgTransaction(transaction: unknown): SqlTransaction {
  if (isMysql2Client(transaction)) {
    throw notATransaction(
      "Pass the node-postgres client your transaction runs on, not a mysql2 connection: the store's statements run on PostgreSQL.",
    );
  }
  if (
    !hasMethod(transaction, "query") ||
    !hasMethod(transaction, "connect") ||
    isPool(transaction)
  ) {
    throw notATransaction(
      "Pass the node-postgres client your transaction runs on (const client = await pool.connect(); await client.query('BEGIN')), " +
        (isPool(transaction)
          ? "not the pool: it runs each statement on any of its connections, outside your transaction."
          : `got ${describeValue(transaction)}.`),
    );
  }
  const client = transaction as PgClientLike;
  if (typeof client.getTransactionStatus === "function") {
    const status = client.getTransactionStatus();
    if (status === "E") {
      throw notATransaction(
        "The node-postgres client is in a failed transaction: roll it back.",
      );
    }
    if (status !== "T") {
      throw notATransaction(
        "The node-postgres client isn't in a transaction: send BEGIN on it first, or each statement commits on its own.",
      );
    }
  }
  return clientTransaction(client, client);
}

function clientTransaction(
  client: QueryablePgClient,
  native: unknown,
): SqlTransaction {
  return {
    query: async <R extends object = Record<string, unknown>>(
      text: string,
      params: readonly unknown[] = [],
    ) => (await client.query(text, [...params])).rows as R[],
    execute: async (text: string, params: readonly unknown[] = []) =>
      affected(await client.query(text, [...params])),
    native,
  };
}

function affected(result: { rowCount?: number | null }): SqlExecuteResult {
  return { affectedRows: result.rowCount ?? 0 };
}

function isPool(value: unknown): value is PgPoolLike {
  return (
    hasMethod(value, "connect") &&
    typeof (value as { totalCount?: unknown }).totalCount === "number"
  );
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
