import type { SqlTransaction } from "../../interfaces/sql-executor.interface";

/**
 * Runs a store's `work` on the transaction an executor opened for it, and rejects rather than let the executor commit
 * a transaction PostgreSQL has ended.
 */
export async function runTransactionWork<T>(
  work: (transaction: SqlTransaction) => Promise<T>,
  transaction: SqlTransaction,
  options: { commitReplyTells?: boolean } = {},
): Promise<T> {
  let failure: { error: unknown } | undefined;
  let nativeRead = false;

  const watch = <V>(statement: Promise<V>): Promise<V> =>
    statement.then(
      (value) => {
        failure = undefined;
        return value;
      },
      (error) => {
        failure = { error };
        throw error;
      },
    );

  const execute = transaction.execute?.bind(transaction);
  const handed: SqlTransaction = {
    query: (text, params) => watch(transaction.query(text, params)),
    ...(execute
      ? { execute: (text, params) => watch(execute(text, params)) }
      : {}),
  };

  const { native } = transaction;
  if (native !== undefined) {
    Object.defineProperty(handed, "native", {
      enumerable: true,
      get: () => {
        nativeRead = true;
        return native;
      },
    });
  }

  const result = await work(handed);
  if (failure || (nativeRead && !options.commitReplyTells)) {
    const probe = await transaction
      .query("SELECT 1")
      .then(() => undefined, (error: unknown) => ({ error }));
    if (probe && failure) {
      throw transactionEnded(failure.error);
    }
    if (probe) {
      throw failedTransaction(probe.error)
        ? transactionEnded(probe.error)
        : probe.error;
    }
  }
  return result;
}

function failedTransaction(error: unknown): boolean {
  for (
    let current: unknown = error, depth = 0;
    current !== null && typeof current === "object" && depth < 5;
    current = (current as { cause?: unknown }).cause, depth++
  ) {
    const { code, message, driverError } = current as {
      code?: unknown;
      message?: unknown;
      driverError?: { code?: unknown };
    };
    if (
      code === "25P02" ||
      driverError?.code === "25P02" ||
      (typeof message === "string" &&
        message.includes("current transaction is aborted"))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * The rejection of work whose transaction PostgreSQL ended at a failed statement the work caught.
 */
export function transactionEnded(cause?: unknown): Error {
  return new Error(
    "The transaction was rolled back: one of its statements failed and its error was caught, but PostgreSQL ends a transaction at its first failed statement. Let the statement's error reject the work, or run the statement after a SAVEPOINT and ROLLBACK TO SAVEPOINT when it fails.",
    cause === undefined ? undefined : { cause },
  );
}
