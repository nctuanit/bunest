import type { ReservedSQL, TransactionSQL } from "bun";
import type {
  Abstract,
  FactoryDependency,
  InjectionToken,
  ModuleImport,
  Provider,
  Type,
} from "@bunest/common";
import type { MigrationDefinition, TransactionContext } from "./contracts";
import type { SqlDialect } from "./identifiers";

export type { SqlDialect } from "./identifiers";

export interface SqlTagFunction {
  <T = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Bun.SQL.Query<T[]>;
  <T = Record<string, unknown>>(identifier: string): Bun.SQL.Query<T>;
  <T extends Record<PropertyKey, unknown>>(
    obj: T | T[] | readonly T[],
  ): Bun.SQL.Helper<T>;
  <
    T extends Record<PropertyKey, unknown>,
    Keys extends keyof T = keyof T,
  >(
    obj: T | T[] | readonly T[],
    ...columns: readonly Keys[]
  ): Bun.SQL.Helper<Pick<T, Keys>>;
  <T>(value: T & {}): Bun.SQL.Helper<T>;
}

export interface SqlQueryEvent {
  readonly sql: string;
  readonly durationMs: number;
  readonly inTransaction: boolean;
  readonly connectionName: string;
}

export interface SqlTransactionOptions {
  /**
   * Optional SQL transaction options passed to `Bun.SQL.begin(options, fn)`
   * (e.g. `"read write"`, `"isolation level serializable"` on PostgreSQL).
   * Ignored for nested SAVEPOINT calls.
   */
  readonly options?: string;

  /**
   * Optional custom savepoint label for nested transactions.
   */
  readonly savepointName?: string;
}

export type SqlTransactionalAdapter = "sql" | "drizzle" | "prisma";

export interface SqlTransactionalOptions extends SqlTransactionOptions {
  /**
   * Named connection to run the transaction on.
   * @default "default"
   */
  readonly connectionName?: string;

  /**
   * Which transaction service manages the transaction boundary:
   * - `"sql"` (default): `SqlService.transaction(...)`
   * - `"drizzle"`: `DrizzleService.transaction(...)` (or `transactionSync` when `sync: true`)
   * - `"prisma"`: `PrismaServiceBase.transaction(...)`
   * @default "sql"
   */
  readonly adapter?: SqlTransactionalAdapter;

  /**
   * Optional transaction configuration passed to `DrizzleService.transaction(fn, config)`
   * or `PrismaServiceBase.transaction(fn, config)`.
   */
  readonly config?: Record<string, unknown>;

  /**
   * For synchronous Drizzle drivers (e.g. `drizzle-orm/bun-sqlite`), runs inside
   * `DrizzleService.transactionSync(...)`.
   * @default false
   */
  readonly sync?: boolean;
}

export interface SqlEntityMetadata {
  readonly tableName: string;
  readonly idColumn: string;
}

export type SqlQueryReturnMode =
  | "auto"
  | "many"
  | "one"
  | "scalar"
  | "count"
  | "exists"
  | "changes"
  | "runResult"
  | "void";

export interface SqlQueryOptions {
  /**
   * Explicitly controls how the query result is shaped.
   * Defaults to `"auto"` (inferred from `@Modifying()` and method naming convention).
   */
  readonly mode?: SqlQueryReturnMode;

  /**
   * Shorthand for `mode: "one"` (`true`) vs `mode: "many"` (`false`).
   */
  readonly single?: boolean;

  /**
   * Whether to run the repository row mapper over returned rows.
   * Defaults to `true` for `"one"` / `"many"` modes.
   */
  readonly mapRows?: boolean;
}

export interface SqlQueryMetadata {
  readonly sql: string;
  readonly options?: SqlQueryOptions;
}

export interface SqlModifyingOptions {
  /**
   * Return shape for a `@Modifying()` query:
   * - `"changes"` (default): affected row count (`number`)
   * - `"void"`: `undefined`
   * - `"runResult"`: full normalized `QueryResult`
   * @default "changes"
   */
  readonly returnType?: "changes" | "void" | "runResult";
}

export type SqlParamMetadataMap = Record<number, string>;

export interface SqlRepositoryOptions<TEntity = any> {
  /**
   * Target entity class. Table name is inferred from `@SqlEntity` or pluralized `snake_case` class name unless `table` is set.
   */
  readonly entity?: Type<TEntity> | Abstract<TEntity>;

  /**
   * Explicit SQL table name.
   */
  readonly table?: string;

  /**
   * Primary key column name. Defaults to `@SqlEntity` metadata or `"id"`.
   */
  readonly idColumn?: string;

  /**
   * Entity property name corresponding to `idColumn`. Defaults to `camelCase` of `idColumn`.
   */
  readonly idProperty?: string;

  /**
   * Explicit entity property -> SQL column name mapping.
   */
  readonly columns?: Readonly<Record<string, string>>;

  /**
   * Optional default connection name when not overridden in `SqlModule.forFeature(repos, connectionName)`.
   */
  readonly connectionName?: string;

  /**
   * Optional explicit SQL dialect override (auto-detected from `SqlService.adapter` by default).
   */
  readonly dialect?: SqlDialect;

  /**
   * Automatically map `camelCase` property names <-> `snake_case` SQL columns.
   * @default true
   */
  readonly camelCaseMapping?: boolean;

  /**
   * Pluralize inferred table names from entity class names when neither `table` nor `@SqlEntity` is provided.
   * @default true
   */
  readonly pluralizeTableName?: boolean;

  /**
   * Optional custom row hydrator transforming a raw DB row into `TEntity`.
   */
  readonly mapRow?: (row: Record<string, unknown>) => TEntity;
}

export interface SqlRepositoryMetadata<TEntity = any> {
  readonly entity?: Type<TEntity> | Abstract<TEntity>;
  readonly table: string;
  readonly idColumn: string;
  readonly idProperty: string;
  readonly columns: Readonly<Record<string, string>>;
  readonly connectionName?: string;
  readonly dialect?: SqlDialect;
  readonly camelCaseMapping: boolean;
  readonly mapRow?: (row: Record<string, unknown>) => TEntity;
}

export type SqlRepositoryTarget = Abstract<any> | Type<any>;

/**
 * Minimal executor interface consumed by `SqlMigrationRunner` (implemented by `SqlService`).
 */
export interface SqlMigrationExecutor {
  readonly sql: SqlTagFunction;
  readonly adapter: string | undefined;
  reserve?(): Promise<ReservedSQL>;
  unsafe<T = Record<string, unknown>>(
    query: string,
    params?: readonly unknown[] | Record<string, unknown>,
  ): Bun.SQL.Query<T[]>;
  simple<T = Record<string, unknown>>(query: string): Promise<T[]>;
  transaction<T>(
    fn: (tx: TransactionContext<TransactionSQL>) => Promise<T> | T,
    options?: SqlTransactionOptions,
  ): Promise<T>;
}

export interface SqlMigrationRunnerOptions {
  /**
   * Acquire a database-level advisory lock (`pg_advisory_lock` on PostgreSQL,
   * `GET_LOCK` on MySQL/MariaDB) around `up()` / `down()` to prevent concurrent
   * multi-instance startup races.
   * @default false
   */
  readonly advisoryLock?: boolean;

  /**
   * Custom advisory lock key/id (numeric for PostgreSQL, string for MySQL/MariaDB).
   */
  readonly advisoryLockId?: number | string;
}

export interface SqlModuleOptions {
  /**
   * Named connection identifier for multi-database applications.
   * @default "default"
   */
  readonly name?: string;

  /**
   * Connection URL string or `URL` (e.g. `postgres://...`, `mysql://...`, `sqlite://:memory:`).
   */
  readonly url?: string | URL;

  /**
   * Native `Bun.SQL.Options` object forwarded to `new Bun.SQL(...)`.
   */
  readonly options?: Bun.SQL.Options;

  /**
   * Optional pre-constructed `Bun.SQL` client instance to wrap.
   */
  readonly client?: Bun.SQL;

  /**
   * Eagerly establish a connection during `onModuleInit()`.
   * @default false
   */
  readonly connectOnInit?: boolean;

  /**
   * Graceful shutdown timeout (in seconds) passed to `sql.close({ timeout })`.
   */
  readonly closeTimeout?: number;

  /**
   * Migrations registered for this SQL connection.
   */
  readonly migrations?: readonly MigrationDefinition<any>[];

  /**
   * Table used by `SqlMigrationRunner` to track applied migrations.
   * @default "_bunest_migrations"
   */
  readonly migrationsTable?: string;

  /**
   * Automatically apply pending `migrations` during `onModuleInit()`.
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
   * Automatically discover and register all self-registered `@SqlRepository(...)`
   * classes from `DecoratorRegistry` matching this connection name (eliminating
   * `SqlModule.forFeature([...])` boilerplate).
   * @default false
   */
  readonly autoRegisterRepositories?: boolean;

  /**
   * Acquire an advisory lock during `autoMigrate` / `SqlMigrationRunner.up()`.
   * @default false
   */
  readonly advisoryLock?: boolean;

  /**
   * Custom advisory lock key/id when `advisoryLock` is enabled.
   */
  readonly advisoryLockId?: number | string;

  /**
   * Optional observability hook invoked after SQL query executions.
   */
  readonly onQuery?: (info: SqlQueryEvent) => void;

  /**
   * Register the module globally so its exports are visible across all modules.
   * @default true
   */
  readonly global?: boolean;
}

export type SqlModuleForRootInput = string | URL | SqlModuleOptions;

export interface SqlOptionsFactory {
  createSqlOptions():
    | Promise<SqlModuleForRootInput>
    | SqlModuleForRootInput;
}

export interface SqlModuleAsyncOptions {
  readonly name?: string;
  readonly global?: boolean;
  readonly entities?: ReadonlyArray<Type<unknown> | Abstract<unknown>>;
  readonly autoSync?: boolean;
  readonly autoRegisterRepositories?: boolean;
  readonly imports?: ModuleImport[];
  readonly useFactory?: (
    ...args: any[]
  ) => Promise<SqlModuleForRootInput> | SqlModuleForRootInput;
  readonly inject?: FactoryDependency[];
  readonly useClass?: Type<SqlOptionsFactory>;
  readonly useExisting?: InjectionToken<SqlOptionsFactory>;
  readonly extraProviders?: Provider[];
}
