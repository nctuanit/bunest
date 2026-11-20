import { loadOptionalModule } from "../../utils/module.util";
import {
  type BunSqlMySqlLike,
  fromBunSql,
} from "../executors/bun-sql.executor";
import { fromMysql2, type Mysql2PoolLike } from "../executors/mysql2.executor";
import type { SqlExecutor } from "../interfaces/mysql-executor.interface";

interface Mysql2PromiseModule {
  default?: {
    createPool(options: { uri: string; connectionLimit: number }): Mysql2PoolLike & {
      end(): Promise<void>;
    };
  };
  createPool?: (options: {
    uri: string;
    connectionLimit: number;
  }) => Mysql2PoolLike & { end(): Promise<void> };
}

/**
 * A pool of one connection on `url`, for the command line's `migrate` and `status`.
 * Uses `mysql2/promise` if installed, otherwise falls back to Bun's native `Bun.SQL`.
 */
export async function openMysql(
  url: string,
): Promise<{ executor: SqlExecutor; close(): Promise<void> } | null> {
  try {
    const mod = await loadOptionalModule<Mysql2PromiseModule>("mysql2/promise");
    const createPool = mod.default?.createPool ?? mod.createPool;
    if (createPool) {
      const pool = createPool({ uri: url, connectionLimit: 1 });
      return { executor: fromMysql2(pool), close: () => pool.end() };
    }
  } catch {
    // Fall back to Bun's built-in Bun.SQL driver below.
  }
  try {
    const bunMod = await import("bun");
    const sql = new bunMod.SQL({
      url,
      max: 1,
    }) as unknown as BunSqlMySqlLike & { close(): Promise<void> };
    return {
      executor: fromBunSql(sql),
      close: () => sql.close(),
    };
  } catch {
    return null;
  }
}
