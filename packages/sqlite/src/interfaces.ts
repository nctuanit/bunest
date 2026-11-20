import type { Database } from "bun:sqlite";
import type {
  Abstract,
  FactoryDependency,
  InjectionToken,
  ModuleImport,
  Provider,
  Type,
} from "@bunest/common";

export type SqliteParamValue =
  | string
  | number
  | bigint
  | boolean
  | null
  | Uint8Array
  | ArrayBufferLike;

export type SqliteNamedParams = Record<string, SqliteParamValue>;

export type SqliteQueryParams = readonly SqliteParamValue[] | SqliteNamedParams;

export interface SqliteRunResult {
  readonly changes: number;
  readonly lastInsertRowid: number | bigint;
}

export type SqliteTransactionMode = "DEFERRED" | "IMMEDIATE" | "EXCLUSIVE";

export interface SqliteTransactionOptions {
  /**
   * Transaction lock mode used for top-level transactions.
   * Ignored for nested SAVEPOINT transactions.
   * @default "DEFERRED"
   */
  readonly mode?: SqliteTransactionMode;

  /**
   * Optional custom savepoint label for nested transactions.
   * Must match `[A-Za-z_][A-Za-z0-9_]*`.
   */
  readonly savepointName?: string;
}

export interface SqliteTransactionalOptions extends SqliteTransactionOptions {
  /**
   * Named SQLite connection to open the transaction on.
   * @default "default"
   */
  readonly connectionName?: string;

  /**
   * When `true`, executes inside `SqliteService.transactionSync(...)` instead of
   * async `SqliteService.transaction(...)`, keeping synchronous methods synchronous.
   * @default false
   */
  readonly sync?: boolean;
}

export interface SqliteTransactionContext {
  readonly id: string;
  readonly connectionName: string;
  readonly depth: number;
  readonly savepointName?: string;
  readonly isNested: boolean;
  readonly database: Database;
}

export interface SqliteQueryEvent {
  readonly sql: string;
  readonly durationMs: number;
  readonly inTransaction: boolean;
  readonly connectionName: string;
}

export interface SqliteQueryExecutor {
  readonly connectionName: string;
  readonly isClosed: boolean;
  query<T = Record<string, unknown>>(
    sql: string,
    params?: SqliteQueryParams,
  ): T[];
  queryOne<T = Record<string, unknown>>(
    sql: string,
    params?: SqliteQueryParams,
  ): T | null;
  run(sql: string, params?: SqliteQueryParams): SqliteRunResult;
  exec(sql: string): void;
  iterate?<T = Record<string, unknown>>(
    sql: string,
    params?: SqliteQueryParams,
  ): IterableIterator<T>;
  clearStatementCache?(): void;
  transaction<T>(
    fn: (tx: SqliteTransactionContext) => Promise<T> | T,
    options?: SqliteTransactionOptions,
  ): Promise<T>;
  transactionSync?<T>(
    fn: (tx: SqliteTransactionContext) => T,
    options?: SqliteTransactionOptions,
  ): T;
  getCurrentTransaction(): SqliteTransactionContext | undefined;
  isInTransaction(): boolean;
}

/**
 * Structural bridge matching `@bunest/sql`'s `DatabaseAdapter` contract.
 */
export interface SqliteDatabaseAdapter {
  readonly connectionName: string;
  readonly isClosed: boolean;
  query<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[] | Record<string, unknown>,
  ): {
    readonly rows: readonly T[];
    readonly rowCount: number;
    readonly affectedRows?: number;
    readonly lastInsertRowid?: number | bigint | string | null;
    readonly command?: string | null;
  };
  transaction<T>(
    fn: (tx: {
      readonly id: string;
      readonly connectionName: string;
      readonly depth: number;
      readonly savepointName?: string;
      readonly isNested: boolean;
      readonly client: Database;
    }) => Promise<T> | T,
  ): Promise<T>;
  getCurrentTransaction():
    | {
        readonly id: string;
        readonly connectionName: string;
        readonly depth: number;
        readonly savepointName?: string;
        readonly isNested: boolean;
        readonly client: Database;
      }
    | undefined;
  healthCheck(): boolean;
  close(): void;
}

export interface SqliteEntityMetadata {
  readonly tableName: string;
  readonly idColumn: string;
}

export interface SqliteFeatureRepositoryConfig {
  readonly table: string;
  readonly idColumn?: string;
  readonly entity?: Type<any>;
  readonly token?: InjectionToken;
}

export type SqliteRepositoryTarget =
  | string
  | Type<any>
  | Abstract<any>
  | SqliteFeatureRepositoryConfig;

export type SqliteQueryReturnMode =
  | "auto"
  | "many"
  | "one"
  | "scalar"
  | "count"
  | "exists"
  | "changes"
  | "runResult"
  | "void";

export interface SqliteQueryOptions {
  /**
   * Explicitly controls how the query result is shaped.
   * Defaults to `"auto"` (inferred from `@Modifying()` and method naming convention).
   */
  readonly mode?: SqliteQueryReturnMode;

  /**
   * Shorthand for `mode: "one"` (`true`) vs `mode: "many"` (`false`).
   */
  readonly single?: boolean;

  /**
   * Whether to run the repository row mapper over returned rows.
   * Defaults to `true` for `"one"` / `"many"` modes.
   */
  readonly mapRows?: boolean;

  /**
   * When `true`, returns the result synchronously instead of wrapped in a `Promise`.
   * @default false
   */
  readonly sync?: boolean;
}

export interface SqliteQueryMetadata {
  readonly sql: string;
  readonly options?: SqliteQueryOptions;
}

export interface SqliteModifyingOptions {
  /**
   * Return value shape for a `@Modifying()` query:
   * - `"changes"` (default): returns number of affected rows
   * - `"void"`: returns `undefined`
   * - `"runResult"`: returns `{ changes, lastInsertRowid }`
   * @default "changes"
   */
  readonly returnType?: "changes" | "void" | "runResult";
}

export type SqliteParamMetadataMap = Record<number, string>;

export interface SqliteRepositoryOptions<TEntity = any> {
  /**
   * Target entity class. Table name is inferred from `@SqliteEntity` or pluralized `snake_case` class name unless `table` is set.
   */
  readonly entity?: Type<TEntity> | Abstract<TEntity>;

  /**
   * Explicit SQLite table name.
   */
  readonly table?: string;

  /**
   * Primary key column name. Defaults to `@SqliteEntity` metadata or `"id"`.
   */
  readonly idColumn?: string;

  /**
   * Entity property name corresponding to `idColumn`. Defaults to `camelCase` of `idColumn`.
   */
  readonly idProperty?: string;

  /**
   * Explicit entity property -> SQLite column name mapping.
   * Unmapped properties automatically convert `camelCase` -> `snake_case` when `camelCaseMapping` is enabled.
   */
  readonly columns?: Readonly<Record<string, string>>;

  /**
   * Optional default connection name when not overridden in `SqliteModule.forFeature(repos, connectionName)`.
   */
  readonly connectionName?: string;

  /**
   * Automatically map `camelCase` property names <-> `snake_case` SQL columns.
   * @default true
   */
  readonly camelCaseMapping?: boolean;

  /**
   * Pluralize inferred table names from entity class names when neither `table` nor `@SqliteEntity` is provided.
   * @default true
   */
  readonly pluralizeTableName?: boolean;

  /**
   * Optional custom row hydrator transforming a raw SQLite row into `TEntity`.
   */
  readonly mapRow?: (row: Record<string, unknown>) => TEntity;
}

export interface SqliteRepositoryMetadata<TEntity = any> {
  readonly entity?: Type<TEntity> | Abstract<TEntity>;
  readonly table: string;
  readonly idColumn: string;
  readonly idProperty: string;
  readonly columns: Readonly<Record<string, string>>;
  readonly connectionName?: string;
  readonly camelCaseMapping: boolean;
  readonly mapRow?: (row: Record<string, unknown>) => TEntity;
}

export interface SqliteMigration {
  /**
   * Unique identifier for this migration (e.g. "001_create_users").
   */
  readonly id: string;

  /**
   * Optional human-readable description/name. Defaults to `id`.
   */
  readonly name?: string;

  /**
   * Forward migration: either raw SQL (may contain multiple statements) or a callback.
   */
  readonly up: string | ((db: SqliteQueryExecutor) => Promise<void> | void);

  /**
   * Optional rollback migration: either raw SQL or a callback.
   */
  readonly down?: string | ((db: SqliteQueryExecutor) => Promise<void> | void);

  /**
   * Whether to wrap execution and migration table updates in a transaction.
   * @default true
   */
  readonly transactional?: boolean;
}

export interface SqliteMigrationRecord {
  readonly id: string;
  readonly name: string;
  readonly batch: number;
  readonly appliedAt: string;
}

export interface SqliteMigrationStatus {
  readonly applied: readonly SqliteMigrationRecord[];
  readonly pending: readonly SqliteMigration[];
}

export interface SqliteModuleOptions {
  /**
   * Named connection identifier for multi-database applications.
   * @default "default"
   */
  readonly name?: string;

  /**
   * SQLite file path or `":memory:"` for an in-memory database.
   * @default ":memory:"
   */
  readonly filename?: string;

  /**
   * Open the database in read-only mode.
   * @default false
   */
  readonly readonly?: boolean;

  /**
   * Allow creating the database file if it does not exist (ignored when `readonly: true`).
   * @default true
   */
  readonly create?: boolean;

  /**
   * Open the database in read-write mode (ignored when `readonly: true`).
   * @default true
   */
  readonly readwrite?: boolean;

  /**
   * Return 64-bit SQLite integers as `bigint`.
   * @default false
   */
  readonly safeIntegers?: boolean;

  /**
   * Throw on missing named query parameters instead of binding `NULL`.
   * @default false
   */
  readonly strict?: boolean;

  /**
   * Enable WAL journal mode (`PRAGMA journal_mode = WAL`).
   * Defaults to `true` for file-backed read-write databases; skipped for `:memory:` and `readonly` connections.
   */
  readonly wal?: boolean;

  /**
   * Enable foreign key constraint enforcement (`PRAGMA foreign_keys = ON`).
   * @default true
   */
  readonly foreignKeys?: boolean;

  /**
   * Milliseconds to wait when the SQLite file is locked (`PRAGMA busy_timeout`).
   * @default 5000
   */
  readonly busyTimeout?: number;

  /**
   * Additional SQLite PRAGMA key/value pairs applied on connection open.
   */
  readonly pragmas?: Readonly<Record<string, string | number | boolean>>;

  /**
   * Maximum number of prepared statements held in the per-service LRU cache.
   * Set to `0` to disable statement caching.
   * @default 100
   */
  readonly statementCacheSize?: number;

  /**
   * Migrations registered for this connection.
   */
  readonly migrations?: readonly SqliteMigration[];

  /**
   * Table used by `SqliteMigrationRunner` to track applied migrations.
   * @default "_bunest_migrations"
   */
  readonly migrationsTable?: string;

  /**
   * Automatically run pending `migrations` during `onModuleInit()`.
   * @default false
   */
  readonly autoMigrate?: boolean;

  /**
   * Entity classes decorated with `@Entity()` managed by this connection.
   * Used by `autoSync: true` to automatically create tables and indexes on bootstrap.
   */
  readonly entities?: ReadonlyArray<Type<unknown> | Abstract<unknown>>;

  /**
   * Automatically execute `CREATE TABLE IF NOT EXISTS` and index DDL during
   * `onModuleInit()` for configured `entities` and registered repository entities.
   * @default false
   */
  readonly autoSync?: boolean;

  /**
   * Automatically discover and register all self-registered `@SqliteRepository(...)`
   * classes from `DecoratorRegistry` matching this connection name (eliminating
   * `SqliteModule.forFeature([...])` boilerplate).
   * @default false
   */
  readonly autoRegisterRepositories?: boolean;

  /**
   * Optional observability hook invoked after each query/statement execution.
   */
  readonly onQuery?: (info: SqliteQueryEvent) => void;

  /**
   * Register the module globally so its exports are visible to all modules.
   * @default false
   */
  readonly global?: boolean;
}

export interface SqliteOptionsFactory {
  createSqliteOptions(): Promise<SqliteModuleOptions> | SqliteModuleOptions;
}

export interface SqliteModuleAsyncOptions {
  readonly name?: string;
  readonly global?: boolean;
  readonly entities?: ReadonlyArray<Type<unknown> | Abstract<unknown>>;
  readonly autoSync?: boolean;
  readonly autoRegisterRepositories?: boolean;
  readonly imports?: ModuleImport[];
  readonly useFactory?: (
    ...args: any[]
  ) => Promise<SqliteModuleOptions> | SqliteModuleOptions;
  readonly inject?: FactoryDependency[];
  readonly useClass?: Type<SqliteOptionsFactory>;
  readonly useExisting?: InjectionToken<SqliteOptionsFactory>;
  readonly extraProviders?: Provider[];
}
