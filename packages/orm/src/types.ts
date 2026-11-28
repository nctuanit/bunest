/**
 * Constructor type matching concrete or abstract entity/embedded classes.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ObjectType<T = any> =
  | (new (...args: never[]) => T)
  | (abstract new (...args: never[]) => T)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  | (new (...args: any[]) => T)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  | (abstract new (...args: any[]) => T);

/**
 * Typed lazy token identifying an entity or embeddable class by name without
 * introducing a runtime circular import.
 */
export interface EntityRef<T = unknown> {
  readonly __ormEntityRef: true;
  readonly name: string;
  readonly __type?: T;
}

/**
 * Any supported reference to a target entity or embeddable class:
 * - Direct constructor (`User`)
 * - Lazy thunk (`() => User`)
 * - String entity class name or table name (`"User"` / `"users"`)
 * - Typed `EntityRef<User>` (`entityRef<User>("User")`)
 */
export type EntityTarget<T = unknown> =
  | ObjectType<T>
  | (() => ObjectType<T>)
  | EntityRef<T>
  | string;

/**
 * Canonical normalized database dialects supported by `@bunest/orm`.
 */
export type OrmDialect =
  | "sqlite"
  | "libsql"
  | "d1"
  | "postgres"
  | "cockroachdb"
  | "mysql"
  | "mariadb"
  | "mssql"
  | "oracle"
  | "sap"
  | "spanner"
  | "mongodb";

/**
 * Every TypeORM-compatible `DataSourceOptions.type` value (plus Bun/edge native aliases),
 * all mapped onto Bun native APIs (`bun:sqlite`, `Bun.SQL`, `fetch`, `Bun.connect`) or
 * custom drivers via `OrmDriverRegistry`.
 */
export type OrmDatabaseType =
  | OrmDialect
  | "postgresql"
  | "pg"
  | "aurora-postgres"
  | "aurora-mysql"
  | "mysql2"
  | "bun-sqlite"
  | "better-sqlite3"
  | "sqljs"
  | "cordova"
  | "nativescript"
  | "react-native"
  | "expo"
  | "capacitor"
  | "turso"
  | "sqlserver"
  | (string & {});

/**
 * Supported column data types.
 */
export type OrmColumnType =
  | "integer"
  | "bigint"
  | "real"
  | "float"
  | "decimal"
  | "text"
  | "varchar"
  | "boolean"
  | "json"
  | "jsonb"
  | "datetime"
  | "timestamp"
  | "date"
  | "blob"
  | "uuid"
  | "objectid";

export type PrimaryGeneratedStrategy = "increment" | "uuid" | "objectid";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface OrmColumnTransformer<TApp = any, TDb = any> {
  readonly to: (value: TApp) => TDb;
  readonly from: (value: TDb) => TApp;
}

export interface OrmEntityOptions {
  readonly name?: string;
  readonly tableName?: string;
  readonly schema?: string;
  readonly description?: string;
  readonly camelCaseMapping?: boolean;
  readonly pluralizeTableName?: boolean;
  readonly comment?: string;
}

export type BaseEntityColumnOption =
  | boolean
  | string
  | (OrmColumnOptions & { readonly property?: string });

export interface BaseEntityOptions extends OrmEntityOptions {
  /**
   * Primary key generation strategy (`"increment"`, `"uuid"`, `"objectid"`, or `false` for manual PK).
   * Defaults to `"increment"`.
   */
  readonly idStrategy?: PrimaryGeneratedStrategy | false;
  /** Primary key property name (defaults to `"id"`). */
  readonly idProperty?: string;
  /** Primary key column name or column options. */
  readonly idColumn?: string | OrmColumnOptions;
  /** Creation timestamp column (`true` = `"createdAt"`, `false` = omit, string = custom property name, or options). Defaults to `true`. */
  readonly createdAt?: BaseEntityColumnOption;
  /** Modification timestamp column (`true` = `"updatedAt"`, `false` = omit, string = custom property name, or options). Defaults to `true`. */
  readonly updatedAt?: BaseEntityColumnOption;
  /** Soft-delete timestamp column (`true` = `"deletedAt"`, `false` = omit, string = custom property name, or options). Defaults to `true`. */
  readonly deletedAt?: BaseEntityColumnOption;
}

export interface OrmColumnOptions {
  readonly name?: string;
  readonly type?: OrmColumnType;
  readonly length?: number;
  readonly precision?: number;
  readonly scale?: number;
  readonly nullable?: boolean;
  readonly unique?: boolean;
  readonly default?: unknown;
  readonly primary?: boolean;
  readonly generated?: boolean | PrimaryGeneratedStrategy;
  readonly select?: boolean;
  readonly insert?: boolean;
  readonly update?: boolean;
  readonly enum?: readonly (string | number)[];
  readonly transformer?: OrmColumnTransformer;
  readonly createdAt?: boolean;
  readonly updatedAt?: boolean;
  readonly deletedAt?: boolean;
  readonly version?: boolean;
  readonly comment?: string;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly min?: number;
  readonly max?: number;
  readonly pattern?: RegExp | string;
  readonly description?: string;
  readonly example?: unknown;
}

export interface OrmIndexOptions {
  readonly name?: string;
  readonly columns?: readonly string[];
  readonly unique?: boolean;
  readonly where?: string;
}

export interface OrmUniqueOptions {
  readonly name?: string;
  readonly columns?: readonly string[];
  readonly where?: string;
}

export type RelationKind =
  | "one-to-one"
  | "many-to-one"
  | "one-to-many"
  | "many-to-many"
  | "morph-to"
  | "morph-many";

export type OrmMorphTargets =
  | Readonly<Record<string, EntityTarget>>
  | readonly EntityTarget[];

export interface OrmMorphToOptions {
  /**
   * SQL column name (or property name) storing the polymorphic target type discriminator.
   * Defaults to `${camelToSnake(propertyName)}_type` (e.g. `commentable_type`).
   */
  readonly typeColumn?: string;
  /**
   * SQL column name (or property name) storing the polymorphic target primary key.
   * Defaults to `${camelToSnake(propertyName)}_id` (e.g. `commentable_id`).
   */
  readonly idColumn?: string;
  /**
   * SQL column type for the auto-synthesized polymorphic ID column (inferred from target PKs when omitted).
   */
  readonly idColumnType?: OrmColumnType;
  readonly nullable?: boolean;
  readonly eager?: boolean;
  readonly persistence?: boolean;
}

export interface OrmMorphManyOptions {
  /**
   * Explicit discriminator string matching this parent entity in the child's type column.
   * Automatically inferred from the child `@MorphTo()` target map when omitted.
   */
  readonly morphType?: string;
  /**
   * Override the child's SQL type column name (defaults to child `@MorphTo()` metadata).
   */
  readonly typeColumn?: string;
  /**
   * Override the child's SQL ID column name (defaults to child `@MorphTo()` metadata).
   */
  readonly idColumn?: string;
  readonly cascade?: CascadeOption;
  readonly eager?: boolean;
  readonly persistence?: boolean;
}

export type OrmIsolationLevel =
  | "READ UNCOMMITTED"
  | "READ COMMITTED"
  | "REPEATABLE READ"
  | "SERIALIZABLE";

export type OrmTransactionPropagation =
  | "REQUIRED"
  | "REQUIRES_NEW"
  | "MANDATORY"
  | "NEVER";

export interface OrmTransactionOptions {
  /**
   * SQL transaction isolation level applied to top-level / `REQUIRES_NEW` transactions.
   */
  readonly isolationLevel?: OrmIsolationLevel;
  /**
   * Transaction propagation behavior (default: `"REQUIRED"`).
   * - `"REQUIRED"`: join active tx via nested `SAVEPOINT`, or open a new tx.
   * - `"REQUIRES_NEW"`: suspend outer ALS tx and open an independent tx.
   * - `"MANDATORY"`: require an active tx; throws `TransactionPropagationError` if none.
   * - `"NEVER"`: forbid an active tx; throws `TransactionPropagationError` if one exists.
   */
  readonly propagation?: OrmTransactionPropagation;
  /**
   * Dialect-aware read-only transaction hint (`SET TRANSACTION READ ONLY` on PG/MySQL,
   * `BEGIN DEFERRED` + `PRAGMA query_only = ON` on SQLite).
   */
  readonly readOnly?: boolean;
  /**
   * Automatic retries with jittered exponential backoff on transient serialization,
   * deadlock, or `SQLITE_BUSY` errors at top-level transactions.
   */
  readonly retries?: number;
  /**
   * Base backoff delay in milliseconds between retries (default: `10`).
   */
  readonly retryDelayMs?: number;
  /**
   * Optional logical DataSource name used for diagnostics channel telemetry.
   */
  readonly dataSource?: string;
}

export type CascadeOption =
  | boolean
  | readonly ("insert" | "update" | "remove" | "soft-remove" | "recover")[];

export type ReferentialAction =
  | "CASCADE"
  | "SET NULL"
  | "RESTRICT"
  | "NO ACTION"
  | "SET DEFAULT";

export type InverseSideSelector<T = unknown> =
  | string
  | ((object: T) => unknown);

export interface OrmRelationOptions {
  readonly nullable?: boolean;
  readonly cascade?: CascadeOption;
  readonly eager?: boolean;
  readonly onDelete?: ReferentialAction;
  readonly onUpdate?: ReferentialAction;
  readonly orphanedRowAction?: "nullify" | "delete" | "soft-delete";
  readonly persistence?: boolean;
  readonly createForeignKeyConstraints?: boolean;
  readonly joinColumn?: boolean | OrmJoinColumnOptions;
  readonly joinTable?: boolean | OrmJoinTableOptions;
  readonly inverseSide?: InverseSideSelector;
}

export interface OrmJoinColumnOptions {
  readonly name?: string;
  readonly referencedColumnName?: string;
  readonly foreignKeyConstraintName?: string;
}

export interface OrmJoinTableOptions {
  readonly name?: string;
  readonly joinColumn?: OrmJoinColumnOptions;
  readonly inverseJoinColumn?: OrmJoinColumnOptions;
}

export type EmbeddedStorageMode = "flat" | "json" | "auto";

export interface OrmEmbeddedOptions {
  readonly mode?: EmbeddedStorageMode;
  readonly prefix?: string | boolean;
  readonly array?: boolean;
  readonly nullable?: boolean;
  readonly columnName?: string;
  readonly maxDepth?: number;
}

export type LifecycleEventKind =
  | "before-insert"
  | "after-insert"
  | "before-update"
  | "after-update"
  | "before-remove"
  | "after-remove"
  | "after-load";

export type CircularJsonStrategy = "omit" | "id" | "ref";

export type FindOrderDirection = "ASC" | "DESC" | "asc" | "desc" | 1 | -1;

export type FindOptionsOrder<Entity> = {
  [K in keyof Entity]?: Entity[K] extends object
    ? FindOrderDirection | FindOptionsOrder<Entity[K]>
    : FindOrderDirection;
} & Record<string, unknown>;

export type FindOptionsRelations<Entity> =
  | readonly string[]
  | ({
      [K in keyof Entity]?: boolean | Record<string, unknown>;
    } & Record<string, unknown>);

export type FindOptionsSelect<Entity> =
  | ReadonlyArray<keyof Entity & string>
  | ({
      [K in keyof Entity]?: boolean | Record<string, unknown>;
    } & Record<string, unknown>);

export interface FindOperatorLike<T = unknown> {
  readonly __ormFindOperator: true;
  readonly type: FindOperatorType;
  readonly value: T;
  readonly extra?: unknown;
  readonly negated?: boolean;
}

export type FindOperatorType =
  | "equal"
  | "not"
  | "lessThan"
  | "lessThanOrEqual"
  | "moreThan"
  | "moreThanOrEqual"
  | "like"
  | "ilike"
  | "between"
  | "in"
  | "isNull"
  | "raw"
  | "and"
  | "or";

export type FindOptionsWhereProperty<Property> =
  | Property
  | FindOperatorLike<unknown>
  | (Property extends Array<infer U>
      ? FindOptionsWhere<U>
      : Property extends Date
        ? Date | string | FindOperatorLike<unknown>
        : Property extends object
          ? FindOptionsWhere<Property>
          : never);

export type FindOptionsWhere<Entity> = {
  [K in keyof Entity]?: FindOptionsWhereProperty<NonNullable<Entity[K]>> | null;
} & Record<string, unknown>;

export interface FindOneOptions<Entity = Record<string, unknown>> {
  readonly where?:
    | FindOptionsWhere<Entity>
    | ReadonlyArray<FindOptionsWhere<Entity>>;
  readonly relations?: FindOptionsRelations<Entity>;
  readonly order?: FindOptionsOrder<Entity>;
  readonly select?: FindOptionsSelect<Entity>;
  readonly withDeleted?: boolean;
  readonly loadEagerRelations?: boolean;
  readonly maxEagerDepth?: number;
}

export interface FindManyOptions<Entity = Record<string, unknown>>
  extends FindOneOptions<Entity> {
  readonly skip?: number;
  readonly take?: number;
}

export type DeepPartial<T> =
  | T
  | (T extends Date
      ? T
      : T extends Array<infer U>
        ? Array<DeepPartial<U>>
        : T extends object
          ? { [K in keyof T]?: DeepPartial<T[K]> }
          : T);

export interface SaveOptions {
  readonly reload?: boolean;
  readonly transaction?: boolean;
  readonly listeners?: boolean;
  readonly chunk?: number;
}

export interface RemoveOptions {
  readonly transaction?: boolean;
  readonly listeners?: boolean;
}

export interface InsertResult {
  readonly identifiers: Array<Record<string, unknown>>;
  readonly generatedMaps: Array<Record<string, unknown>>;
  readonly raw: unknown;
}

export interface UpdateResult {
  readonly affected: number;
  readonly generatedMaps: Array<Record<string, unknown>>;
  readonly raw: unknown;
}

export interface DeleteResult {
  readonly affected: number;
  readonly raw: unknown;
}

export interface OrmMigration {
  readonly id: string;
  readonly name?: string;
  readonly up: string | ((runner: OrmQueryExecutor) => Promise<void> | void);
  readonly down?: string | ((runner: OrmQueryExecutor) => Promise<void> | void);
  readonly transactional?: boolean;
}

export interface OrmMigrationRecord {
  readonly id: string;
  readonly name: string;
  readonly batch: number;
  readonly appliedAt: string;
}

export interface OrmMigrationStatus {
  readonly applied: readonly OrmMigrationRecord[];
  readonly pending: readonly OrmMigration[];
}

export interface OrmQueryResult<T = Record<string, unknown>> {
  readonly rows: T[];
  readonly affectedRows: number;
  readonly lastInsertRowid?: string | number | bigint | null;
}

export interface OrmQueryExecutor {
  readonly dialect: OrmDialect;
  query<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<OrmQueryResult<T>>;
  execute(sql: string, params?: readonly unknown[]): Promise<OrmQueryResult>;
}

export interface OrmQueryLogEvent {
  readonly sql: string;
  readonly params: readonly unknown[];
  readonly durationMs: number;
  readonly error?: Error;
}

export interface OrmTlsOptions {
  readonly ca?: string | Uint8Array | Bun.BunFile | Array<string | Uint8Array>;
  readonly cert?: string | Uint8Array | Bun.BunFile;
  readonly key?: string | Uint8Array | Bun.BunFile;
  readonly passphrase?: string;
  readonly rejectUnauthorized?: boolean;
  readonly serverName?: string;
  readonly [key: string]: unknown;
}

export type OrmSslOption =
  | boolean
  | "disable"
  | "allow"
  | "prefer"
  | "require"
  | "verify-ca"
  | "verify-full"
  | Bun.BunFile
  | OrmTlsOptions;

/**
 * TypeORM-compatible connection credentials for primary/replica nodes.
 */
export interface OrmConnectionCredentials {
  readonly url?: string | URL;
  readonly host?: string;
  readonly hostname?: string;
  readonly port?: number;
  readonly username?: string;
  readonly user?: string;
  readonly password?: string | (() => Promise<string> | string);
  readonly database?: string;
  readonly schema?: string;
  readonly ssl?: OrmSslOption;
  readonly tls?: OrmSslOption;
  readonly socketPath?: string;
  readonly path?: string;
  readonly poolSize?: number;
  readonly max?: number;
  readonly idleTimeout?: number;
  readonly connectionTimeout?: number;
  readonly connectTimeoutMS?: number;
  readonly maxLifetime?: number;
  readonly authToken?: string;
  readonly authSource?: string;
}

export interface OrmReplicationOptions {
  readonly master: OrmConnectionCredentials;
  readonly slaves: readonly OrmConnectionCredentials[];
  readonly defaultMode?: "master" | "slave";
}

/**
 * Minimal Cloudflare D1 binding interface (for Workers / Bun D1 adapters).
 */
export interface CloudflareD1DatabaseLike {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      all<T = Record<string, unknown>>(): Promise<{
        results?: T[];
        meta?: { changes?: number; last_row_id?: number };
      }>;
      run(): Promise<{
        meta?: { changes?: number; last_row_id?: number };
      }>;
    };
    all<T = Record<string, unknown>>(): Promise<{
      results?: T[];
      meta?: { changes?: number; last_row_id?: number };
    }>;
    run(): Promise<{
      meta?: { changes?: number; last_row_id?: number };
    }>;
  };
  exec?(sql: string): Promise<unknown>;
}

/**
 * Document-level operations implemented by MongoDB drivers (both Bun TCP wire
 * protocol `OP_MSG` and embedded local Bun document store).
 */
export interface OrmDocumentDriverLike extends OrmDriverLike {
  readonly isDocumentDriver: true;
  ensureCollection(collectionName: string): Promise<void>;
  dropCollection(collectionName: string): Promise<void>;
  docInsertMany(
    collectionName: string,
    docs: readonly Record<string, unknown>[],
  ): Promise<{ insertedCount: number; insertedIds: unknown[] }>;
  docFind(
    collectionName: string,
    filter?: Record<string, unknown>,
    options?: {
      sort?: Record<string, 1 | -1>;
      skip?: number;
      limit?: number;
      projection?: Record<string, 0 | 1>;
    },
  ): Promise<Array<Record<string, unknown>>>;
  docUpdate(
    collectionName: string,
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: { multi?: boolean; upsert?: boolean },
  ): Promise<{ matchedCount: number; modifiedCount: number; upsertedId?: unknown }>;
  docDelete(
    collectionName: string,
    filter: Record<string, unknown>,
    options?: { multi?: boolean },
  ): Promise<{ deletedCount: number }>;
  docCount(
    collectionName: string,
    filter?: Record<string, unknown>,
  ): Promise<number>;
  docDistinct<T = unknown>(
    collectionName: string,
    field: string,
    filter?: Record<string, unknown>,
  ): Promise<T[]>;
  docAggregate<T = Record<string, unknown>>(
    collectionName: string,
    pipeline: readonly Record<string, unknown>[],
  ): Promise<T[]>;
  docCreateIndex?(
    collectionName: string,
    keys: Record<string, 1 | -1>,
    options?: { unique?: boolean; name?: string },
  ): Promise<string>;
}

/**
 * Structural driver interface powering all SQL & document databases in `@bunest/orm`.
 */
export interface OrmDriverLike extends OrmQueryExecutor {
  readonly isConnected: boolean;
  /**
   * Optional underlying database family (`"bun-sqlite"`, `"bun-sql"`, `"libsql-http"`, `"d1"`, `"mongodb-wire"`, `"mongodb-local"`, `"replicated"`, etc.).
   */
  readonly driverKind?: string;
  /**
   * Optional logical DataSource name attached for diagnostics channel telemetry.
   */
  readonly dataSourceName?: string;
  /**
   * Indicates the driver natively enforces `OrmTransactionOptions` (propagation,
   * isolation, retries, lifecycle hooks, and diagnostics channel emission).
   */
  readonly supportsManagedTransactions?: boolean;
  connect(): Promise<void>;
  close(): Promise<void>;
  transaction<T>(
    run: (executor: OrmQueryExecutor) => Promise<T> | T,
    options?: OrmTransactionOptions,
  ): Promise<T>;
  isInTransaction(): boolean;
  setForeignKeysEnabled?(enabled: boolean): Promise<void>;
  ping?(): Promise<boolean>;
}

export interface OrmDataSourceOptions extends OrmConnectionCredentials {
  readonly name?: string;
  /**
   * TypeORM-compatible database type:
   * - SQLite family: `"sqlite"`, `"bun-sqlite"`, `"better-sqlite3"`, `"sqljs"`, `"expo"`, `"capacitor"`, `"cordova"`, `"nativescript"`, `"react-native"`
   * - PostgreSQL family (native `Bun.SQL`): `"postgres"`, `"postgresql"`, `"cockroachdb"`, `"aurora-postgres"`
   * - MySQL / MariaDB family (native `Bun.SQL`): `"mysql"`, `"mariadb"`, `"aurora-mysql"`
   * - Edge HTTP SQL (native Bun `fetch`): `"libsql"`, `"turso"`, `"d1"`
   * - Enterprise SQL dialects: `"mssql"`, `"oracle"`, `"sap"`, `"spanner"`
   * - MongoDB (native `Bun.connect` wire protocol `OP_MSG` + BSON, or local embedded store): `"mongodb"`
   */
  readonly type?: OrmDatabaseType;
  /**
   * For SQLite: set `true` to use Bun's unified `Bun.SQL` SQLite adapter instead of direct `bun:sqlite`.
   * @default false
   */
  readonly useBunSql?: boolean;
  /**
   * SQLite `bun:sqlite` open flags.
   */
  readonly readonly?: boolean;
  readonly create?: boolean;
  readonly readwrite?: boolean;
  readonly safeIntegers?: boolean;
  readonly strict?: boolean;
  readonly busyTimeout?: number;
  /**
   * Bun.SQL Postgres/MySQL tuning options.
   */
  readonly bigint?: boolean;
  readonly prepare?: boolean;
  readonly allowPublicKeyRetrieval?: boolean;
  readonly applicationName?: string;
  readonly connection?: Record<string, string | boolean | number>;
  readonly onconnect?: (err: Error | null) => void;
  readonly onclose?: (err: Error | null) => void;
  /**
   * Cloudflare D1 options (REST API via Bun `fetch` OR direct binding).
   */
  readonly accountId?: string;
  readonly databaseId?: string;
  readonly apiToken?: string;
  readonly d1Binding?: CloudflareD1DatabaseLike;
  /**
   * Custom HTTP headers for HTTP-based drivers (`libsql`/`turso`, `d1`, custom).
   */
  readonly headers?: Record<string, string>;
  /**
   * Master / Read-Replica configuration (compatible with TypeORM `replication`).
   */
  readonly replication?: OrmReplicationOptions;
  /**
   * Extra driver-specific options (TypeORM `extra` compatibility).
   */
  readonly extra?: Record<string, unknown>;
  /**
   * Custom driver instance (overrides built-in driver factory).
   */
  readonly driver?: OrmDriverLike;
  /**
   * Registered entities (classes, lazy thunks, string names, or EntityRefs).
   */
  readonly entities?: readonly EntityTarget[];
  readonly autoLoadEntities?: boolean;
  readonly synchronize?: boolean;
  /**
   * Alias for `synchronize`.
   */
  readonly autoSync?: boolean;
  readonly dropSchema?: boolean;
  readonly migrations?: readonly OrmMigration[];
  readonly migrationsRun?: boolean;
  /**
   * Alias for `migrationsRun`.
   */
  readonly autoMigrate?: boolean;
  /**
   * Custom table/collection name used by `OrmMigrationRunner` to track applied migrations.
   * @default "__bunest_orm_migrations"
   */
  readonly migrationsTable?: string;
  /**
   * Automatically discover and register all `@Repository(...)` classes from `DecoratorRegistry`
   * matching this DataSource name, and auto-include their entity classes in the DataSource.
   * @default false
   */
  readonly autoRegisterRepositories?: boolean;
  /**
   * Register `OrmModule.forRoot()` globally so its exports are available across all modules.
   * @default true
   */
  readonly global?: boolean;
  readonly entityPrefix?: string;
  readonly maxEagerDepth?: number;
  readonly safeJsonSerialization?: boolean;
  readonly circularJsonStrategy?: CircularJsonStrategy;
  readonly logging?: boolean | ((event: OrmQueryLogEvent) => void);
  readonly enableWAL?: boolean;
  readonly enforceForeignKeys?: boolean;
  /**
   * Opt-in runtime N+1 query detector (subscribes to `"bunest:orm:query"`).
   * Zero overhead when `false` or omitted.
   * @default false
   */
  readonly detectNPlusOne?:
    | boolean
    | {
        readonly threshold?: number;
        readonly windowMs?: number;
        readonly strict?: boolean;
        readonly onDetect?: (event: {
          readonly fingerprint: string;
          readonly sampleSql: string;
          readonly count: number;
          readonly threshold: number;
          readonly dataSource?: string;
        }) => void;
        readonly ignorePatterns?: readonly RegExp[];
        readonly maxDetections?: number;
      };
}
