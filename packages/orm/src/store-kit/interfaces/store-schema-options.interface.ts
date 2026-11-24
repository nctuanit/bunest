import type { StoreMigration } from "./store-migration.interface";

/**
 * What a store's `createError` receives besides the message: the package's schema error carries it.
 */
export interface StoreSchemaErrorDetails {
  /** The store's schema (on PostgreSQL the schema of its tables, on MySQL the start of their names). */
  schema: string;
  /** The schema's version: the last migration applied to it, `0` for none. */
  version: number;
  /** The version the store needs: its last migration. */
  requiredVersion: number;
  /** What failed, when applying the migrations did. */
  cause?: unknown;
}

/**
 * What `new StoreSchema()` takes: the store's names, which every message, the CLI and the migration lock use,
 * and its migrations.
 */
export interface StoreSchemaOptions {
  /**
   * The package the store ships in, as users install it (e.g. `'@bunest/messaging/outbox'`).
   */
  packageName: string;
  /** The store's class (e.g. `'PostgresOutboxStore'`). */
  storeName: string;
  /** The package's bin (e.g. `'nest-outbox'`), built on `runStoreCli()`. */
  command: string;
  /** The schema the store's tables live in unless the application names another. */
  defaultSchema: string;
  /** Every version of the schema, in order: 1, 2, 3... */
  migrations: readonly StoreMigration[];
  /**
   * The package's own error for a schema that can't serve.
   */
  createError(message: string, details: StoreSchemaErrorDetails): Error;
}
