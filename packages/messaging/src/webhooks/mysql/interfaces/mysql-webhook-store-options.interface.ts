import type { SqlExecutor } from "@bunest/orm/mysql";

/**
 * What `new MySqlWebhookStore(options, storage)` takes.
 *
 * ```ts
 * const options: MySqlWebhookStoreOptions = { executor: fromDrizzle(db), schema: 'shop_webhooks', migrate: false };
 * ```
 */
export interface MySqlWebhookStoreOptions {
  /**
   * How the store reaches the database: `fromMysql2(pool)`, `fromDrizzle(db)`, `fromTypeOrm(dataSource)`,
   * `fromPrisma(prisma)` or `fromKysely(db)` from `@bunest/messaging/webhooks/mysql`.
   */
  executor: SqlExecutor<"mysql">;
  /**
   * The name the store's tables start with, in the connection's database: `<schema>_<table>` (`nest_webhooks`:
   * `nest_webhooks_endpoints`, `nest_webhooks_deliveries`...). Default: `'nest_webhooks'`.
   */
  schema?: string;
  /**
   * Apply the store's pending migrations at startup, one statement at a time under a lock (`GET_LOCK()`).
   * Default: `true`, except when `NODE_ENV` is `production`.
   */
  migrate?: boolean;
}
