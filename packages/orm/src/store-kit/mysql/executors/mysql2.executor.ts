import type {
  SqlExecuteResult,
  SqlTransactionOptions,
} from "../../interfaces/sql-executor.interface";
import { notATransaction } from "../../sql/not-a-transaction";
import {
  describeValue,
  hasMethod,
  isMysql2Client,
  isolationSql,
} from "../../utils/executor.util";
import type {
  SqlExecutor,
  SqlTransaction,
} from "../interfaces/mysql-executor.interface";
import {
  assertFoundRows,
  checkPlaceholders,
  isPgClient,
  mysql2Flags,
} from "./mysql-client.util";

/** The part of a mysql2 connection (`mysql2/promise`) the executor uses. */
export interface Mysql2ConnectionLike {
  query(sql: string, values?: any[]): Promise<[unknown, unknown]>;
  execute(sql: string, values?: any[]): Promise<[unknown, unknown]>;
}

/** The part of a mysql2 pool (`mysql2/promise`) the executor uses. */
export interface Mysql2PoolLike extends Mysql2ConnectionLike {
  getConnection(): Promise<
    Mysql2ConnectionLike & {
      release(): void;
      destroy(): void;
      connection?: unknown;
    }
  >;
}

/**
 * A `SqlExecutor` on mysql2: a pool or a connection (promise API or callback API).
 */
export function fromMysql2(
  pool: Mysql2PoolLike | Mysql2ConnectionLike,
): SqlExecutor {
  if (!isMysql2Client(pool)) {
    throw new TypeError(
      isPgClient(pool)
        ? "fromMysql2() takes a mysql2 pool or connection, not a node-postgres one: a PostgreSQL store takes that, through fromPg() from its package's /postgres subpath."
        : `fromMysql2() takes a mysql2 pool or connection (mysql2/promise), got ${describeValue(pool)}.`,
    );
  }
  assertFoundRows(mysql2Flags(pool), "fromMysql2()");
  const client = promised(pool);
  return hasMethod(client, "getConnection")
    ? new Mysql2PoolExecutor(client as Mysql2PoolLike, client !== pool)
    : new Mysql2ConnectionExecutor(client as Mysql2ConnectionLike, pool);
}

class Mysql2PoolExecutor implements SqlExecutor {
  readonly dialect = "mysql" as const;

  constructor(
    private readonly pool: Mysql2PoolLike,
    private readonly callbacks: boolean,
  ) {}

  query<R extends object = Record<string, unknown>>(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<R[]> {
    return rows<R>(this.pool, text, params);
  }

  execute(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<SqlExecuteResult> {
    return written(this.pool, text, params);
  }

  async transaction<T>(
    work: (transaction: SqlTransaction) => Promise<T>,
    options: SqlTransactionOptions = {},
  ): Promise<T> {
    const isolation = options.isolationLevel
      ? isolationSql(options.isolationLevel)
      : undefined;
    const connection = await this.pool.getConnection();
    const native = this.callbacks
      ? (connection.connection ?? connection)
      : connection;
    const outcome = await runTransaction(connection, work, isolation, native);
    if (outcome.broken) {
      connection.destroy();
    } else {
      connection.release();
    }
    if ("error" in outcome) {
      throw outcome.error;
    }
    return outcome.result;
  }

  wrapTransaction(transaction: unknown): SqlTransaction {
    return mysql2Transaction(transaction);
  }
}

class Mysql2ConnectionExecutor implements SqlExecutor {
  readonly dialect = "mysql" as const;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly connection: Mysql2ConnectionLike,
    private readonly native: unknown,
  ) {}

  query<R extends object = Record<string, unknown>>(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<R[]> {
    return this.exclusive(() => rows<R>(this.connection, text, params));
  }

  execute(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<SqlExecuteResult> {
    return this.exclusive(() => written(this.connection, text, params));
  }

  async transaction<T>(
    work: (transaction: SqlTransaction) => Promise<T>,
    options: SqlTransactionOptions = {},
  ): Promise<T> {
    const isolation = options.isolationLevel
      ? isolationSql(options.isolationLevel)
      : undefined;
    return this.exclusive(async () => {
      const outcome = await runTransaction(
        this.connection,
        work,
        isolation,
        this.native,
      );
      if ("error" in outcome) {
        throw outcome.error;
      }
      return outcome.result;
    });
  }

  wrapTransaction(transaction: unknown): SqlTransaction {
    return mysql2Transaction(transaction);
  }

  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task, task);
    this.tail = run.catch(() => undefined);
    return run;
  }
}

async function runTransaction<T>(
  connection: Mysql2ConnectionLike,
  work: (transaction: SqlTransaction) => Promise<T>,
  isolation: string | undefined,
  native: unknown,
): Promise<
  { result: T; broken?: boolean } | { error: unknown; broken?: boolean }
> {
  try {
    if (isolation) {
      await connection.query(`SET TRANSACTION ISOLATION LEVEL ${isolation}`);
    }
    await connection.query("START TRANSACTION");
  } catch (error) {
    return { error, broken: true };
  }
  let result: T;
  try {
    result = await work(connectionTransaction(connection, native));
  } catch (error) {
    try {
      await connection.query("ROLLBACK");
      return { error };
    } catch {
      return { error, broken: true };
    }
  }
  try {
    await connection.query("COMMIT");
    return { result };
  } catch (error) {
    return { error, broken: true };
  }
}

function mysql2Transaction(transaction: unknown): SqlTransaction {
  if (!isMysql2Client(transaction) || hasMethod(transaction, "getConnection")) {
    let reason: string;
    if (hasMethod(transaction, "getConnection")) {
      reason =
        "not the pool: it runs each statement on any of its connections, outside your transaction.";
    } else if (isPgClient(transaction)) {
      reason =
        "not a node-postgres client: the store's statements run on MySQL.";
    } else {
      reason = `got ${describeValue(transaction)}.`;
    }
    throw notATransaction(
      `Pass the mysql2 connection your transaction runs on (const connection = await pool.getConnection(); await connection.beginTransaction()), ${reason}`,
    );
  }
  const connection = promised(transaction) as Mysql2ConnectionLike;
  let checked: Promise<void> | undefined;
  const inTransaction = () => (checked ??= assertInTransaction(connection));
  return {
    query: async <R extends object = Record<string, unknown>>(
      text: string,
      params: readonly unknown[] = [],
    ) => {
      await inTransaction();
      return rows<R>(connection, text, params);
    },
    execute: async (text: string, params: readonly unknown[] = []) => {
      await inTransaction();
      return written(connection, text, params);
    },
    native: transaction,
  };
}

/** SERVER_STATUS_IN_TRANS: the connection is in a transaction. */
const IN_TRANSACTION = 1;

async function assertInTransaction(
  connection: Mysql2ConnectionLike,
): Promise<void> {
  const [header] = await connection.query("DO 0");
  const status = (header as { serverStatus?: unknown } | undefined)
    ?.serverStatus;
  if (typeof status === "number" && (status & IN_TRANSACTION) === 0) {
    throw notATransaction(
      "The mysql2 connection isn't in a transaction: call beginTransaction() on it first, or each statement commits on its own.",
    );
  }
}

function connectionTransaction(
  connection: Mysql2ConnectionLike,
  native: unknown,
): SqlTransaction {
  return {
    query: <R extends object = Record<string, unknown>>(
      text: string,
      params: readonly unknown[] = [],
    ) => rows<R>(connection, text, params),
    execute: (text: string, params: readonly unknown[] = []) =>
      written(connection, text, params),
    native,
  };
}

async function rows<R extends object>(
  client: Mysql2ConnectionLike,
  text: string,
  params: readonly unknown[],
): Promise<R[]> {
  checkPlaceholders(text, params);
  const [result] = await client.query(text, [...params]);
  return (Array.isArray(result) ? result : []) as R[];
}

async function written(
  client: Mysql2ConnectionLike,
  text: string,
  params: readonly unknown[],
): Promise<SqlExecuteResult> {
  checkPlaceholders(text, params);
  const [result] = await client.query(text, [...params]);
  return {
    affectedRows: Array.isArray(result)
      ? 0
      : Number(
          (result as { affectedRows?: unknown } | undefined)?.affectedRows ?? 0,
        ),
  };
}

function promised(client: unknown): unknown {
  const candidate = client as { promise?: () => unknown };
  return typeof candidate.promise === "function" ? candidate.promise() : client;
}
