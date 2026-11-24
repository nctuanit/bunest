/**
 * A database a store can run on: what an executor's `dialect` says, and `SqlExecutor`'s type parameter.
 */
export type SqlDialect = "postgres" | "mysql";

/**
 * A transaction isolation level: the four of the SQL standard, which PostgreSQL and MySQL share.
 */
export type SqlIsolationLevel =
  "read uncommitted" | "read committed" | "repeatable read" | "serializable";

/**
 * What `SqlExecutor.transaction()` takes.
 */
export interface SqlTransactionOptions {
  /**
   * Default: the database's (PostgreSQL's `default_transaction_isolation`, `read committed` unless changed;
   * MySQL's `transaction_isolation`, `repeatable read` unless changed). Applies to this transaction alone.
   */
  isolationLevel?: SqlIsolationLevel;
}

/**
 * What `execute()` resolves to: how many rows a statement wrote.
 */
export interface SqlExecuteResult {
  /**
   * The rows the statement inserted or deleted, or, for an UPDATE, the rows its WHERE matched,
   * whether or not the update changed their values.
   */
  affectedRows: number;
}

/**
 * Runs SQL on one transaction's connection: what `SqlExecutor.transaction()` hands its callback,
 * and what `SqlExecutor.wrapTransaction()` makes of the application's own transaction object.
 */
export interface SqlTransaction {
  /**
   * Runs one statement, with its placeholders (`$1`, `$2`... on PostgreSQL, `?` on MySQL)
   * bound to `params` in order, and resolves to its rows (`[]` for a statement that returns none).
   */
  query<R extends object = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<R[]>;

  /**
   * Runs one statement that writes (INSERT, UPDATE, DELETE) as `query()` does, and resolves to
   * the rows it wrote.
   */
  execute?(
    text: string,
    params?: readonly unknown[],
  ): Promise<SqlExecuteResult>;

  /**
   * The client's own transaction object this transaction runs on: the kind the application's code
   * holds, which `SqlExecutor.wrapTransaction()` takes and gives back (`wrapTransaction(x).native === x`).
   */
  readonly native?: unknown;
}

/**
 * How a store reaches its database through the client the application already has.
 */
export interface SqlExecutor<D extends SqlDialect = SqlDialect> {
  /**
   * The database it runs on, which decides the SQL it takes.
   */
  readonly dialect: D;

  /**
   * Runs one statement outside any transaction, as `SqlTransaction.query()`.
   */
  query<R extends object = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<R[]>;

  /**
   * Runs one statement that writes, outside any transaction, as `SqlTransaction.execute()`.
   */
  execute?(
    text: string,
    params?: readonly unknown[],
  ): Promise<SqlExecuteResult>;

  /**
   * Runs `work` in a transaction of its own, on one connection: commits when `work` resolves,
   * rolls back and rethrows when it rejects.
   */
  transaction<T>(
    work: (transaction: SqlTransaction) => Promise<T>,
    options?: SqlTransactionOptions,
  ): Promise<T>;

  /**
   * Wraps the application's transaction object so statements run in it and commit or roll back
   * with the application's own writes. Throws a `TypeError` with code `'ERR_SQL_NOT_A_TRANSACTION'`
   * for anything else.
   */
  wrapTransaction(transaction: unknown): SqlTransaction;
}
