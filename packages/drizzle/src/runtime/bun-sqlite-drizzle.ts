import { Database } from "bun:sqlite";
import type { DrizzleDatabaseLike } from "@bunest/sql";

export interface BunSqliteDrizzleOptions {
  connection?: string | { filename?: string; readonly?: boolean };
}

/**
 * Zero-dependency Drizzle-compatible SQLite database adapter powered by `bun:sqlite`.
 * Exposes `$client` for automatic `@bunest/drizzle` lifecycle cleanup, plus `execute()`,
 * `run()`, `all()`, `get()`, and savepoint-aware `transaction()` compatible with
 * `@bunest/sql`'s `DrizzleService`.
 */
export class BunSqliteDrizzleDatabase
  implements DrizzleDatabaseLike<BunSqliteDrizzleDatabase>
{
  public readonly $client: Database;
  private savepointDepth = 0;

  constructor(filename = ":memory:", readonly = false) {
    this.$client = readonly
      ? new Database(filename, { readonly: true })
      : new Database(filename);
  }

  run(sql: string, params: unknown[] = []): unknown {
    return this.$client.query(sql).run(...(params as any[]));
  }

  all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
    return this.$client.query(sql).all(...(params as any[])) as T[];
  }

  get<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): T | null {
    return (this.$client.query(sql).get(...(params as any[])) as T) ?? null;
  }

  execute(query: unknown, params: unknown[] = []): unknown {
    if (typeof query !== "string") {
      throw new Error(
        "BunSqliteDrizzleDatabase.execute() expects a SQL string.",
      );
    }
    const trimmed = query.trim().toUpperCase();
    if (
      trimmed.startsWith("SELECT") ||
      trimmed.startsWith("PRAGMA") ||
      trimmed.startsWith("WITH") ||
      trimmed.includes("RETURNING")
    ) {
      return this.all(query, params);
    }
    return this.run(query, params);
  }

  transaction<T>(fn: (tx: BunSqliteDrizzleDatabase) => T): T {
    const depth = this.savepointDepth;
    if (depth === 0) {
      this.$client.run("BEGIN TRANSACTION");
    } else {
      this.$client.run(`SAVEPOINT sp_${depth}`);
    }
    this.savepointDepth++;

    const finalizeCommit = () => {
      this.savepointDepth--;
      if (this.savepointDepth === 0) {
        this.$client.run("COMMIT");
      } else {
        this.$client.run(`RELEASE SAVEPOINT sp_${this.savepointDepth}`);
      }
    };

    const finalizeRollback = () => {
      this.savepointDepth--;
      if (this.savepointDepth === 0) {
        this.$client.run("ROLLBACK");
      } else {
        this.$client.run(`ROLLBACK TO SAVEPOINT sp_${this.savepointDepth}`);
      }
    };

    try {
      const result = fn(this);
      if (
        result &&
        typeof (result as unknown as PromiseLike<unknown>).then === "function"
      ) {
        return (result as unknown as Promise<unknown>).then(
          (resolved) => {
            finalizeCommit();
            return resolved;
          },
          (err) => {
            finalizeRollback();
            throw err;
          },
        ) as T;
      }
      finalizeCommit();
      return result;
    } catch (err) {
      finalizeRollback();
      throw err;
    }
  }
}

/**
 * Factory function matching Drizzle's `drizzle({ connection })` signature,
 * backed directly by `bun:sqlite` with zero external dependencies.
 */
export function createBunSqliteDrizzle(
  options: BunSqliteDrizzleOptions | string = ":memory:",
): BunSqliteDrizzleDatabase {
  if (typeof options === "string") {
    return new BunSqliteDrizzleDatabase(options);
  }
  const conn = options.connection;
  if (typeof conn === "string") {
    return new BunSqliteDrizzleDatabase(conn);
  }
  return new BunSqliteDrizzleDatabase(
    conn?.filename ?? ":memory:",
    conn?.readonly ?? false,
  );
}
