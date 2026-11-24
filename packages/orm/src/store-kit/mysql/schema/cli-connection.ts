import {
  type BunSqlMySqlLike,
  fromBunSql,
} from "../executors/bun-sql.executor";
import type { SqlExecutor } from "../interfaces/mysql-executor.interface";

/**
 * A pool of one connection on `url`, for the command line's `migrate` and `status`.
 * Powered natively by Bun's built-in `Bun.SQL` driver with zero external dependencies.
 */
export async function openMysql(
  url: string,
): Promise<{ executor: SqlExecutor; close(): Promise<void> } | null> {
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
