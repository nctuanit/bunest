import type { SqlExecutor } from "../interfaces/sql-executor.interface";

/**
 * An executor under test, with what the contract needs besides: the application's own transactions and root object
 * on the same client.
 */
export interface SqlExecutorContractTarget {
  executor: SqlExecutor;
  /**
   * Runs `work` in a transaction of the application's, the way an application does with this client,
   * and hands `work` the client's own transaction object.
   */
  transaction<T>(work: (transaction: unknown) => Promise<T>): Promise<T>;
  /** What an application might pass by mistake instead of its transaction (the pool, the database, the client). */
  root: unknown;
}

/**
 * What `sqlExecutorContract()` takes besides the targets.
 */
export interface SqlExecutorContractOptions {
  /** Called after each case with the target `createTarget` returned. */
  dispose?: (target: SqlExecutorContractTarget) => unknown;
}

/**
 * One case of the contract, for any test runner.
 */
export interface SqlExecutorContractCase {
  name: string;
  /** Throws on failure. */
  run(): Promise<void>;
}

export const CONTRACT_CASES = {
  statements:
    "query() binds its parameters in order, passes strings through as they are, and resolves to the rows ([] for none)",
  transactions:
    "transaction() commits when its work resolves, with its result, and rolls back when it rejects, with its error",
  isolation:
    "transaction() runs at the isolation level asked for, at the database's default without one, and refuses an unknown level",
  joins:
    "wrapTransaction() joins the application's transaction, and refuses its database, pool or client and anything else",
  native:
    "a transaction's native is the client's own transaction object, which wrapTransaction() joins and gives back as it was given",
  connections:
    "transactions keep to one connection while other statements and transactions run at once",
  values:
    "values keep their types through SqlParams and columns(): text, integers, bigints, booleans, JSON and nulls",
} as const;

/** A case's name, shared by the dialects. */
export type ContractCaseKey = keyof typeof CONTRACT_CASES;

/** The contract in one dialect's SQL: a scratch table's statements and each case. */
export interface DialectCases {
  createTable(table: string): string;
  dropTable(table: string): string;
  cases: Record<
    ContractCaseKey,
    (target: SqlExecutorContractTarget, table: string) => Promise<void>
  >;
}
