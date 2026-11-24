import type { SqlDialect, SqlExecutor } from "./sql-executor.interface";

/**
 * The options every first-party SQL store takes (`new PostgresOutboxStore({ executor, schema, migrate })`),
 * which `StoreSchema.resolveOptions()` checks.
 */
export interface StoreOptions<D extends SqlDialect = SqlDialect> {
  /**
   * How the store reaches the database: an executor of the store's dialect.
   */
  executor: SqlExecutor<D>;
  /**
   * The schema that holds the store's tables. Default: the store's (`nest_<package>`).
   */
  schema?: string;
  /**
   * Apply the store's pending migrations at startup. Default: `true`, except when `NODE_ENV` is `production`.
   */
  migrate?: boolean;
}

/**
 * `StoreSchema.resolveOptions()`'s result: the options checked, with their defaults.
 */
export interface ResolvedStoreOptions<D extends SqlDialect = SqlDialect> {
  executor: SqlExecutor<D>;
  /** The schema's name, checked. */
  schema: string;
  migrate: boolean;
}
