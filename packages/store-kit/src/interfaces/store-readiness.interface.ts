import type { SqlDialect, SqlTransaction } from "./sql-executor.interface";
import type { ResolvedStoreOptions } from "./store-options.interface";

/**
 * What `StoreSchema.readiness()` takes: the store's resolved options, and where a migration is reported.
 */
export interface StoreReadinessOptions<D extends SqlDialect = SqlDialect>
  extends ResolvedStoreOptions<D> {
  /**
   * Told when the store applies migrations.
   */
  logger?: {
    log(message: string): void;
  };
}

/**
 * What a store awaits before its statements, made by `StoreSchema.readiness()`.
 */
export interface StoreReadiness {
  /**
   * Resolves once the schema can serve: migrated (with `migrate`) or checked.
   */
  ready(): Promise<void>;
  /**
   * The same checks through the application's transaction, for a store method that runs in one.
   * Never migrates inside the application's transaction.
   */
  readyIn(transaction: SqlTransaction): Promise<void>;
  /**
   * Applies the pending migrations now, whatever `migrate` says, and reports them to `logger`.
   */
  migrate(): Promise<number[]>;
}
