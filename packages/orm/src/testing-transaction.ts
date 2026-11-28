import type { DataSource } from "./data-source";
import type { EntityManager } from "./entity-manager";
import type { OrmTransactionOptions } from "./types";

class RollbackTestSentinel {
  readonly __bunestRollbackSentinel = true;
}

/**
 * Executes `fn` inside a database transaction that **always rolls back** upon
 * completion, leaving the database completely clean for subsequent tests.
 *
 * - Compatible with nested `dataSource.transaction()` / `@Transactional()` calls
 *   (via Bunest ORM's automatic savepoint propagation).
 * - Compatible with in-process HTTP E2E tests (`app.fetch(...)`) because the
 *   transaction propagates through `AsyncLocalStorage`.
 * - Resolves with `fn`'s return value after rollback; rethrows if `fn` itself throws.
 */
export async function runInRollbackTransaction<T>(
  dataSource: DataSource,
  fn: (manager: EntityManager) => T | Promise<T>,
  options?: OrmTransactionOptions,
): Promise<T> {
  const sentinel = new RollbackTestSentinel();
  let capturedResult!: T;
  let fnCompleted = false;

  try {
    await dataSource.transaction(async (manager) => {
      capturedResult = await fn(manager);
      fnCompleted = true;
      throw sentinel;
    }, options);
  } catch (err) {
    if (err === sentinel && fnCompleted) {
      return capturedResult;
    }
    throw err;
  }

  return capturedResult;
}
