import type {
  ResolvedStoreOptions as AnyResolvedStoreOptions,
  StoreOptions as AnyStoreOptions,
} from "../../interfaces/store-options.interface";
import type {
  StoreReadinessOptions as AnyStoreReadinessOptions,
  StoreReadiness,
} from "../../interfaces/store-readiness.interface";
import type { StoreSchemaOptions as AnyStoreSchemaOptions } from "../../interfaces/store-schema-options.interface";
import type { SqlExecutor } from "./mysql-executor.interface";

/**
 * The options every first-party MySQL store takes, which `StoreSchema.resolveOptions()` checks.
 */
export interface StoreOptions extends AnyStoreOptions<"mysql"> {
  executor: SqlExecutor;
  schema?: string;
}

/**
 * `StoreSchema.resolveOptions()`'s result on MySQL.
 */
export interface ResolvedStoreOptions extends AnyResolvedStoreOptions<"mysql"> {
  executor: SqlExecutor;
  schema: string;
}

/**
 * What `StoreSchema.readiness()` takes on MySQL.
 */
export interface StoreReadinessOptions extends AnyStoreReadinessOptions<"mysql"> {
  executor: SqlExecutor;
}

/**
 * One version of a MySQL store's schema: its DDL, for the table names `t()` gives.
 */
export interface StoreMigration {
  /** 1, 2, 3...: the schema's version once it's applied. */
  version: number;
  /** Recorded with the version: letters, digits and underscores. */
  name: string;
  /**
   * Its statements: DDL only (CREATE, ALTER, DROP), one per string, each applied and recorded on its own.
   */
  up(t: (table: string) => string): string[];
}

/**
 * What `new StoreSchema()` from `@bunest/orm/mysql` takes.
 */
export interface StoreSchemaOptions extends Omit<
  AnyStoreSchemaOptions,
  "migrations"
> {
  /** Every version of the schema, in order: 1, 2, 3... */
  migrations: readonly StoreMigration[];
  /**
   * Whether the store runs on MariaDB too, where `utf8mb4_0900_bin` is MySQL's NO PAD binary collation.
   * Off by default.
   */
  mariadb?: boolean;
}

/** The server a MySQL store found its connection on. */
export type MySqlServer = "mysql" | "mariadb";

/**
 * What `StoreSchema.readiness()` returns on MySQL: the readiness every store awaits, and the server its check found.
 */
export interface MySqlStoreReadiness extends StoreReadiness {
  /** The server the last successful check found: `undefined` until `ready()` or `readyIn()` resolves. */
  readonly server: MySqlServer | undefined;
}
