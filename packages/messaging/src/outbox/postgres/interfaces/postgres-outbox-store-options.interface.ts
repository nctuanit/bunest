import type { SqlExecutor } from "@bunest/orm/postgres";

/**
 * What `new PostgresOutboxStore(options, storage)` takes.
 */
export interface PostgresOutboxStoreOptions {
  /**
   * How the store reaches the database: `fromPg(pool)`, `fromDrizzle(db)`, `fromTypeOrm(dataSource)`,
   * `fromPrisma(prisma)`, `fromKysely(db)` or `fromBunSql(sql)`.
   */
  executor: SqlExecutor<"postgres">;
  /**
   * The schema that holds the store's tables (`messages`, `dead_letters`, `inbox`).
   * Default: `'nest_outbox'`.
   */
  schema?: string;
  /**
   * Apply the store's pending migrations at startup. Default: `true`, except when `NODE_ENV` is `production`.
   */
  migrate?: boolean;
}
