import type { SqlExecutor } from "../../interfaces/sql-executor.interface";
import { loadOptionalModule } from "../../utils/module.util";
import { type BunSqlLike, fromBunSql } from "../executors/bun-sql.executor";
import { fromPg, type PgPoolLike } from "../executors/pg.executor";

interface PgModule {
  default?: {
    Pool: new (options: {
      connectionString: string;
      max: number;
    }) => PgPoolLike & {
      on(event: "error", listener: () => void): void;
      end(): Promise<void>;
    };
  };
  Pool?: new (options: {
    connectionString: string;
    max: number;
  }) => PgPoolLike & {
    on(event: "error", listener: () => void): void;
    end(): Promise<void>;
  };
}

/**
 * A pool of one connection on `url`, for the command line's `migrate` and `status`.
 * Uses `pg` if installed, otherwise falls back to Bun's native `Bun.SQL`.
 */
export async function openPostgres(
  url: string,
): Promise<{ executor: SqlExecutor<"postgres">; close(): Promise<void> } | null> {
  try {
    const mod = await loadOptionalModule<PgModule>("pg");
    const Pool = mod.default?.Pool ?? mod.Pool;
    if (Pool) {
      const pool = new Pool({ connectionString: url, max: 1 });
      pool.on("error", () => undefined);
      return { executor: fromPg(pool), close: () => pool.end() };
    }
  } catch {
    // Fall back to Bun's built-in Bun.SQL driver below.
  }
  try {
    const bunMod = await import("bun");
    const sql = new bunMod.SQL({
      url,
      max: 1,
    }) as unknown as BunSqlLike & { close(): Promise<void> };
    return {
      executor: fromBunSql(sql),
      close: () => sql.close(),
    };
  } catch {
    return null;
  }
}
