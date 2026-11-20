import type { SqlExecutor } from "@bunest/store-kit/postgres";

/**
 * What `new PostgresWebhookStore(options, storage)` takes.
 *
 * ```ts
 * const options: PostgresWebhookStoreOptions = { executor: fromDrizzle(db), schema: 'shop_webhooks', migrate: false };
 * ```
 */
export interface PostgresWebhookStoreOptions {
  /**
   * How the store reaches the database: `fromPg(pool)`, `fromDrizzle(db)`, `fromTypeOrm(dataSource)`,
   * `fromPrisma(prisma)` or `fromKysely(db)`.
   */
  executor: SqlExecutor<"postgres">;
  /**
   * The schema that holds the store's tables, created by its first migration: keep it for the store alone. Letters,
   * digits and underscores, not starting with a digit, at most 63 characters. Default: `'nest_webhooks'`.
   */
  schema?: string;
  /**
   * Apply the store's pending migrations at startup, in one transaction under an advisory lock.
   * Default: `true`, except when `NODE_ENV` is `production`.
   */
  migrate?: boolean;
}
