import type { SqlExecutor } from "@bunest/store-kit/mysql";

/**
 * What `new MySqlOutboxStore(options, storage)` takes.
 */
export interface MySqlOutboxStoreOptions {
  /**
   * How the store reaches the database: `fromMysql2(pool)`, `fromDrizzle(db)`, `fromTypeOrm(dataSource)`,
   * `fromPrisma(prisma)`, `fromKysely(db)` or `fromBunSql(sql)`.
   */
  executor: SqlExecutor;
  /**
   * The name the store's tables start with, in the connection's database. Default: `'nest_outbox'`.
   */
  schema?: string;
  /**
   * Apply the store's pending migrations at startup. Default: `true`, except when `NODE_ENV` is `production`.
   */
  migrate?: boolean;
}
