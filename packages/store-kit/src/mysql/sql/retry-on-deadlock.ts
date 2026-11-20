import type { SqlIsolationLevel } from "../../interfaces/sql-executor.interface";
import type {
  SqlExecutor,
  SqlTransaction,
} from "../interfaces/mysql-executor.interface";
import { mysqlErrorCode } from "./errors";

/** ER_LOCK_DEADLOCK: MySQL rolled the whole transaction back to break a deadlock. */
const DEADLOCK = 1213;

/**
 * Runs `work` in a transaction of the store's own, READ COMMITTED unless `isolationLevel` says otherwise,
 * and runs it again in a new transaction when MySQL rolled it back to break a deadlock (1213).
 */
export async function retryOnDeadlock<T>(
  executor: SqlExecutor,
  work: (transaction: SqlTransaction) => Promise<T>,
  options: { isolationLevel?: SqlIsolationLevel; attempts?: number } = {},
): Promise<T> {
  const attempts = options.attempts ?? 3;
  if (!Number.isSafeInteger(attempts) || attempts < 1) {
    throw new TypeError(
      `retryOnDeadlock() takes a whole number of attempts from 1, not ${JSON.stringify(attempts)}.`,
    );
  }
  const isolationLevel = options.isolationLevel ?? "read committed";
  for (let attempt = 1; ; attempt++) {
    try {
      return await executor.transaction(work, { isolationLevel });
    } catch (error) {
      if (attempt >= attempts || mysqlErrorCode(error) !== DEADLOCK) {
        throw error;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.random() * 20 * attempt),
      );
    }
  }
}
