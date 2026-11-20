import type {
  SqlExecutor as AnySqlExecutor,
  SqlTransaction as AnySqlTransaction,
  SqlExecuteResult,
  SqlTransactionOptions,
} from "../../interfaces/sql-executor.interface";

/**
 * Runs SQL on one transaction's connection on MySQL: `?` placeholders, bound in order;
 * `execute()` counts the rows a write touched, as MySQL has no `RETURNING`.
 */
export interface SqlTransaction extends AnySqlTransaction {
  /**
   * Runs one statement that writes (INSERT, UPDATE, DELETE), with its `?` placeholders bound to `params` in order,
   * and resolves to the rows it inserted, deleted, or matched.
   */
  execute(
    text: string,
    params?: readonly unknown[],
  ): Promise<SqlExecuteResult>;
}

/**
 * How a MySQL store reaches its database through the client the application already has.
 * It's the root's `SqlExecutor<'mysql'>` with `execute()` required.
 */
export interface SqlExecutor<D extends "mysql" = "mysql">
  extends AnySqlExecutor<D> {
  readonly dialect: D;
  /** Runs one statement that writes, outside any transaction, as `SqlTransaction.execute()`. */
  execute(
    text: string,
    params?: readonly unknown[],
  ): Promise<SqlExecuteResult>;
  transaction<T>(
    work: (transaction: SqlTransaction) => Promise<T>,
    options?: SqlTransactionOptions,
  ): Promise<T>;
  wrapTransaction(transaction: unknown): SqlTransaction;
}
