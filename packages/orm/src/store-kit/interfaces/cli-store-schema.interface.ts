import type { MigrationSqlOptions } from "./migration-sql-options.interface";
import type { SqlExecutor, SqlTransaction } from "./sql-executor.interface";

/**
 * What `runStoreCli()` takes of a store's schema: a dialect's `StoreSchema` is one.
 */
export interface CliStoreSchema {
  readonly dialect: SqlExecutor["dialect"];
  readonly packageName: string;
  readonly storeName: string;
  readonly command: string;
  readonly defaultSchema: string;
  readonly latest: number;
  sql(options?: MigrationSqlOptions): string;
  version(db: SqlTransaction, schema: string): Promise<number>;
  migrate(executor: SqlExecutor, schema: string): Promise<number[]>;
}
