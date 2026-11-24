import type {
  SqlExecutor,
  SqlTransaction,
} from "../interfaces/mysql-executor.interface";
import { tableName } from "./identifiers";
import { retryOnDeadlock } from "./retry-on-deadlock";

/** The rows `ensureLockRows()` reads or creates per statement. */
const ROWS_PER_STATEMENT = 1_000;

/**
 * Locks `keys` until the transaction ends: MySQL's counterpart of PostgreSQL's `advisoryLock()`,
 * on rows of the kit's `<schema>_locks` table.
 */
export async function lockKeys(
  transaction: SqlTransaction,
  schema: string,
  keys: string | readonly string[],
  options: { shared?: boolean } = {},
): Promise<void> {
  const table = tableName(schema, "locks", "lockKeys()");
  const ids = idsOf(keys);
  if (ids.length === 0) {
    return;
  }
  const exclusive = async (locked: readonly string[]) => {
    await transaction.execute(
      `INSERT INTO ${table} (id) VALUES ${locked.map(() => "(?)").join(", ")} ON DUPLICATE KEY UPDATE id = id`,
      locked,
    );
    await transaction.query(
      `SELECT id FROM ${table} WHERE id IN (${locked.map(() => "?").join(", ")}) ORDER BY id FOR UPDATE`,
      locked,
    );
  };
  if (!options.shared) {
    await exclusive(ids);
    return;
  }
  for (const id of ids) {
    const held = await transaction.query(
      `SELECT id FROM ${table} WHERE id = ? LOCK IN SHARE MODE`,
      [id],
    );
    if (held.length === 0) {
      await exclusive([id]);
    }
  }
}

/**
 * Creates the rows of `keys` in the kit's `<schema>_locks` table ahead of time so that no transaction
 * that takes them with `lockKeys()` creates one.
 */
export async function ensureLockRows(
  executor: SqlExecutor,
  schema: string,
  keys: string | readonly string[],
): Promise<void> {
  const table = tableName(schema, "locks", "ensureLockRows()");
  if (typeof executor?.transaction !== "function") {
    throw new TypeError(
      "ensureLockRows() takes the store's executor, not a transaction: it creates the rows in transactions of its own, which commit at once.",
    );
  }
  const missing: string[] = [];
  for (const chunk of chunked(idsOf(keys))) {
    const found = await executor.query<{ id: string }>(
      `SELECT CAST(id AS CHAR) AS id FROM ${table} WHERE id IN (${chunk.map(() => "?").join(", ")})`,
      chunk,
    );
    const existing = new Set(found.map((row) => row.id));
    missing.push(...chunk.filter((id) => !existing.has(id)));
  }
  for (const chunk of chunked(missing)) {
    await retryOnDeadlock(executor, (tx) =>
      tx.execute(
        `INSERT INTO ${table} (id) VALUES ${chunk.map(() => "(?)").join(", ")} ON DUPLICATE KEY UPDATE id = id`,
        chunk,
      ),
    );
  }
}

/**
 * The id of `key`'s row in the kit's `<schema>_locks` table: the key's SHA-256, 64 hex characters.
 */
export function lockRowId(key: string): string {
  return new Bun.CryptoHasher("sha256").update(key).digest("hex");
}

function idsOf(keys: string | readonly string[]): string[] {
  return [
    ...new Set((typeof keys === "string" ? [keys] : keys).map(lockRowId)),
  ].sort();
}

function chunked(ids: readonly string[]): string[][] {
  const chunks: string[][] = [];
  for (let start = 0; start < ids.length; start += ROWS_PER_STATEMENT) {
    chunks.push(ids.slice(start, start + ROWS_PER_STATEMENT));
  }
  return chunks;
}
