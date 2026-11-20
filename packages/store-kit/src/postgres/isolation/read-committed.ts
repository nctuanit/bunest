import type { SqlTransaction } from "../../interfaces/sql-executor.interface";

/**
 * Fails unless the application's transaction runs at READ COMMITTED, PostgreSQL's default: call it before a store
 * method that relies on it does anything in that transaction, so a refused call holds nothing.
 */
export async function assertReadCommittedTransaction(
  transaction: SqlTransaction,
  words: { operation: string; reason: string },
): Promise<void> {
  const [row] = await transaction.query<{ isolation: string }>(
    "SELECT current_setting('transaction_isolation') AS isolation",
  );
  if (row?.isolation !== "read committed") {
    throw new TypeError(
      `${words.operation} needs a READ COMMITTED transaction (PostgreSQL's default); this one is ${row?.isolation}: ${words.reason}.`,
    );
  }
}

/**
 * A store's statements outside its transactions (an update, a claim, an insert-or-ignore) race each other.
 * A store's readiness checks default_transaction_isolation first.
 */
export async function assertReadCommittedDefault(
  db: SqlTransaction,
  storeName: string,
): Promise<void> {
  const [row] = await db.query<{ isolation: string }>(
    "SELECT current_setting('default_transaction_isolation') AS isolation",
  );
  if (row?.isolation !== "read committed") {
    throw new Error(
      `${storeName} needs the database's default transaction isolation to be READ COMMITTED (PostgreSQL's default), not ${row?.isolation}: ` +
        "its statements race each other, and would fail with serialization errors. Set default_transaction_isolation back for the database, " +
        "or for the store's connections (a pool of their own).",
    );
  }
}
