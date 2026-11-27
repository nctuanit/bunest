import { ContextStorage } from "@bunest/core";
import { OrmError, TransactionPropagationError } from "./errors";
import type {
  OrmIsolationLevel,
  OrmTransactionPropagation,
} from "./types";

export type TransactionLifecycleHook = () => void | Promise<void>;

export interface TransactionHookCollector {
  readonly commitCallbacks: TransactionLifecycleHook[];
  readonly rollbackCallbacks: TransactionLifecycleHook[];
  readonly parent?: TransactionHookCollector;
  readonly isNested: boolean;
}

const TX_HOOKS_ALS_SYMBOL = Symbol.for("bunest:orm:tx_hooks_als:v1");

function getTxHooksStorage(): ContextStorage<TransactionHookCollector> {
  const g = globalThis as Record<PropertyKey, unknown>;
  let storage = g[TX_HOOKS_ALS_SYMBOL] as
    | ContextStorage<TransactionHookCollector>
    | undefined;
  if (!storage) {
    storage = new ContextStorage<TransactionHookCollector>();
    g[TX_HOOKS_ALS_SYMBOL] = storage;
  }
  return storage;
}

const VALID_ISOLATION_LEVELS = new Set<OrmIsolationLevel>([
  "READ UNCOMMITTED",
  "READ COMMITTED",
  "REPEATABLE READ",
  "SERIALIZABLE",
]);

const VALID_PROPAGATIONS = new Set<OrmTransactionPropagation>([
  "REQUIRED",
  "REQUIRES_NEW",
  "MANDATORY",
  "NEVER",
]);

/**
 * Strictly validates an isolation level against the SQL standard whitelist.
 */
export function validateIsolationLevel(
  level: OrmIsolationLevel,
): OrmIsolationLevel {
  const normalized = String(level).toUpperCase() as OrmIsolationLevel;
  if (!VALID_ISOLATION_LEVELS.has(normalized)) {
    throw new OrmError(
      `Invalid transaction isolationLevel "${String(level)}". Allowed values: READ UNCOMMITTED, READ COMMITTED, REPEATABLE READ, SERIALIZABLE.`,
    );
  }
  return normalized;
}

/**
 * Strictly validates a transaction propagation mode.
 */
export function validateTransactionPropagation(
  propagation: OrmTransactionPropagation,
): OrmTransactionPropagation {
  if (!VALID_PROPAGATIONS.has(propagation)) {
    throw new OrmError(
      `Invalid transaction propagation "${String(propagation)}". Allowed values: REQUIRED, REQUIRES_NEW, MANDATORY, NEVER.`,
    );
  }
  return propagation;
}

/**
 * Registers a callback to run ONLY after the outermost active transaction
 * commits durably. Callbacks execute outside the DB transaction scope in
 * FIFO registration order, safely isolated from DB state.
 *
 * When registered inside a nested `SAVEPOINT` transaction, the callback is
 * promoted to the parent transaction upon savepoint release and discarded
 * if the savepoint rolls back.
 */
export function onTransactionCommit(fn: TransactionLifecycleHook): void {
  if (typeof fn !== "function") {
    throw new TypeError("onTransactionCommit() requires a callback function.");
  }
  const collector = getTxHooksStorage().getStore();
  if (!collector) {
    throw new OrmError(
      "onTransactionCommit() can only be called inside an active transaction.",
    );
  }
  collector.commitCallbacks.push(fn);
}

/**
 * Registers a callback to run ONLY after the active transaction rolls back.
 * Callbacks execute outside the DB transaction scope in FIFO registration order,
 * safely isolated from DB state.
 */
export function onTransactionRollback(fn: TransactionLifecycleHook): void {
  if (typeof fn !== "function") {
    throw new TypeError("onTransactionRollback() requires a callback function.");
  }
  const collector = getTxHooksStorage().getStore();
  if (!collector) {
    throw new OrmError(
      "onTransactionRollback() can only be called inside an active transaction.",
    );
  }
  collector.rollbackCallbacks.push(fn);
}

/**
 * Returns `true` if the current async execution context has an active ORM
 * transaction hook scope.
 */
export function hasActiveTransactionHookScope(): boolean {
  return getTxHooksStorage().getStore() !== undefined;
}

/**
 * Creates a fresh hook collector for either a root/independent transaction
 * or a nested savepoint transaction.
 */
export function createTransactionHookCollector(
  isNested: boolean,
): TransactionHookCollector {
  const storage = getTxHooksStorage();
  const parent = isNested ? storage.getStore() : undefined;
  return {
    commitCallbacks: [],
    rollbackCallbacks: [],
    ...(parent !== undefined ? { parent } : {}),
    isNested: isNested && parent !== undefined,
  };
}

/**
 * Executes `fn` within the given `collector`'s AsyncLocalStorage scope.
 */
export function runInTransactionHookScope<T>(
  collector: TransactionHookCollector,
  fn: () => Promise<T> | T,
): Promise<T> | T {
  return getTxHooksStorage().run(collector, fn);
}

/**
 * Executes `fn` outside any active transaction hook scope (used for `NEVER`,
 * suspended contexts, and post-commit/post-rollback callback execution).
 */
export function exitTransactionHookScope<T>(fn: () => Promise<T> | T): Promise<T> | T {
  return getTxHooksStorage().exit(fn);
}

/**
 * Handles post-commit lifecycle hooks:
 * - For nested savepoints: merges hooks upward into the parent scope (never fires early!).
 * - For outermost / independent transactions: runs all commit hooks sequentially OUTSIDE the tx scope.
 */
export async function completeTransactionHookCommit(
  collector: TransactionHookCollector,
): Promise<void> {
  if (collector.isNested && collector.parent) {
    if (collector.commitCallbacks.length > 0) {
      collector.parent.commitCallbacks.push(...collector.commitCallbacks);
    }
    if (collector.rollbackCallbacks.length > 0) {
      collector.parent.rollbackCallbacks.push(...collector.rollbackCallbacks);
    }
    return;
  }

  if (collector.commitCallbacks.length === 0) {
    return;
  }

  const callbacks = [...collector.commitCallbacks];
  let firstError: unknown;
  let hasError = false;

  await exitTransactionHookScope(async () => {
    for (let i = 0; i < callbacks.length; i++) {
      try {
        await callbacks[i]!();
      } catch (err) {
        if (!hasError) {
          firstError = err;
          hasError = true;
        }
      }
    }
  });

  if (hasError) {
    throw firstError;
  }
}

/**
 * Handles post-rollback lifecycle hooks:
 * - Discards commit hooks from the failed scope.
 * - Executes rollback hooks sequentially OUTSIDE the tx scope without masking the original error.
 */
export async function completeTransactionHookRollback(
  collector: TransactionHookCollector,
): Promise<void> {
  collector.commitCallbacks.length = 0;
  if (collector.rollbackCallbacks.length === 0) {
    return;
  }

  const callbacks = [...collector.rollbackCallbacks];
  await exitTransactionHookScope(async () => {
    for (let i = 0; i < callbacks.length; i++) {
      try {
        await callbacks[i]!();
      } catch {
        // Never mask the original database/application error that triggered rollback
      }
    }
  });
}

/**
 * Detects transient serialization, deadlock, or SQLite lock-contention errors
 * that are safe to retry at a top-level transaction boundary.
 */
export function isRetryableTransactionError(err: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = err;

  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    if (typeof current === "object") {
      const rec = current as Record<string, unknown>;
      const code = rec.code;
      const errno = rec.errno;
      const sqlState = rec.sqlState;

      // PostgreSQL / CockroachDB SQLSTATE codes (stored on `code`, `errno`, or `sqlState`)
      if (
        code === "40001" ||
        code === "40P01" ||
        code === "55P03" ||
        errno === "40001" ||
        errno === "40P01" ||
        errno === "55P03" ||
        sqlState === "40001" ||
        sqlState === "40P01"
      ) {
        return true;
      }

      // MySQL / MariaDB deadlock & lock wait timeout
      if (
        code === "ER_LOCK_DEADLOCK" ||
        code === "ER_LOCK_WAIT_TIMEOUT" ||
        errno === 1213 ||
        errno === 1205 ||
        errno === 1020
      ) {
        return true;
      }

      // SQLite busy / locked codes (primary result codes 5 = BUSY, 6 = LOCKED)
      if (
        typeof code === "string" &&
        (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED"))
      ) {
        return true;
      }
      if (typeof errno === "number" && errno > 0) {
        const primary = errno & 0xff;
        if (primary === 5 || primary === 6) {
          return true;
        }
      }

      const message = typeof rec.message === "string" ? rec.message : "";
      if (
        message &&
        /SQLITE_BUSY|SQLITE_LOCKED|database is locked|database table is locked|deadlock|could not serialize access|serialization failure|restart transaction|lock wait timeout|40001|40P01/i.test(
          message,
        )
      ) {
        return true;
      }

      current = rec.cause;
    } else if (typeof current === "string") {
      return /SQLITE_BUSY|SQLITE_LOCKED|database is locked|deadlock|could not serialize access|serialization failure/i.test(
        current,
      );
    } else {
      break;
    }
  }

  return false;
}

/**
 * Asserts propagation preconditions for `"MANDATORY"` and `"NEVER"`.
 */
export function assertTransactionPropagation(
  propagation: OrmTransactionPropagation,
  isInTransaction: boolean,
): void {
  if (propagation === "MANDATORY" && !isInTransaction) {
    throw new TransactionPropagationError(
      'Transaction propagation "MANDATORY" requires an existing active transaction, but none is active.',
    );
  }
  if (propagation === "NEVER" && isInTransaction) {
    throw new TransactionPropagationError(
      'Transaction propagation "NEVER" forbids an active transaction, but a transaction is currently in progress.',
    );
  }
}

/**
 * Executes a top-level transaction attempt function with bounded jittered
 * exponential backoff on transient serialization/deadlock/SQLITE_BUSY errors.
 */
export async function executeWithTransactionRetries<T>(
  retries: number | undefined,
  retryDelayMs: number | undefined,
  attemptFn: (attempt: number, isFinalAttempt: boolean) => Promise<T>,
): Promise<T> {
  const maxRetries =
    typeof retries === "number" && Number.isFinite(retries) && retries > 0
      ? Math.floor(retries)
      : 0;
  const baseDelay =
    typeof retryDelayMs === "number" &&
    Number.isFinite(retryDelayMs) &&
    retryDelayMs >= 0
      ? retryDelayMs
      : 10;

  let attempt = 0;
  while (true) {
    const isFinalAttempt = attempt >= maxRetries;
    try {
      return await attemptFn(attempt, isFinalAttempt);
    } catch (err) {
      if (attempt >= maxRetries || !isRetryableTransactionError(err)) {
        throw err;
      }
      const cap = Math.min(baseDelay * 2 ** attempt, 500);
      const jittered = Math.max(1, Math.round(cap * (0.5 + Math.random() * 0.5)));
      attempt += 1;
      await new Promise<void>((resolve) => setTimeout(resolve, jittered));
    }
  }
}
