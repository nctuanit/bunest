import { Database } from "bun:sqlite";

export type MixedList<T> = T[] | Record<string, T>;

export type LoggerOptions =
  | boolean
  | "all"
  | Array<"query" | "schema" | "error" | "warn" | "info" | "log" | "migration">;

export interface TypeOrmLoggerLike {
  logQuery?(query: string, parameters?: unknown[]): void;
  logQueryError?(
    error: string | Error,
    query: string,
    parameters?: unknown[],
  ): void;
  logQuerySlow?(time: number, query: string, parameters?: unknown[]): void;
  logSchemaBuild?(message: string): void;
  logMigration?(message: string): void;
  log?(level: "log" | "info" | "warn", message: unknown): void;
}

export interface NamingStrategyInterface {
  name?: string;
  tableName?(targetName: string, userSpecifiedName: string | undefined): string;
  columnName?(
    propertyName: string,
    customName: string | undefined,
    embeddedPrefixes: string[],
  ): string;
  [key: string]: unknown;
}

export interface QueryResultCache {
  connect?(): Promise<void>;
  disconnect?(): Promise<void>;
  synchronize?(queryRunner?: QueryRunnerLike): Promise<void>;
  getFromCache?(
    options: Record<string, unknown>,
    queryRunner?: QueryRunnerLike,
  ): Promise<unknown>;
  storeInCache?(
    options: Record<string, unknown>,
    savedCache: unknown,
    queryRunner?: QueryRunnerLike,
  ): Promise<void>;
  isExpired?(savedCache: Record<string, unknown>): boolean;
  clear?(queryRunner?: QueryRunnerLike): Promise<void>;
  remove?(
    identifiers: string[],
    queryRunner?: QueryRunnerLike,
  ): Promise<void>;
}

export type InvalidFindOptionsWhereBehavior = "ignore" | "throw" | "sql-null";
export type ReplicationMode = "master" | "slave";
export type ReadPreference =
  | "primary"
  | "primaryPreferred"
  | "secondary"
  | "secondaryPreferred"
  | "nearest"
  | Record<string, unknown>;

export interface TlsOptions {
  rejectUnauthorized?: boolean;
  ca?: string | Uint8Array | Array<string | Uint8Array>;
  cert?: string | Uint8Array | Array<string | Uint8Array>;
  key?: string | Uint8Array | Array<string | Uint8Array>;
  passphrase?: string;
  [key: string]: unknown;
}

export interface OracleThickModeOptions {
  libDir?: string;
  configDir?: string;
  errorUrl?: string;
  driverName?: string;
}

export interface SqlServerConnectionCredentialsOptions {
  readonly host?: string;
  readonly port?: number;
  readonly username?: string;
  readonly password?: string;
  readonly database?: string;
  readonly url?: string;
  readonly domain?: string;
  readonly authentication?: SqlServerConnectionCredentialsAuthenticationOptions;
  readonly [key: string]: unknown;
}

export interface SqlServerConnectionCredentialsAuthenticationOptions {
  readonly type: string;
  readonly options?: Record<string, unknown>;
}

export interface EntitySchemaColumnOptionsLike {
  type?: string | Function;
  primary?: boolean;
  generated?: boolean | "increment" | "uuid" | "rowid" | "identity";
  nullable?: boolean;
  default?: unknown;
  name?: string;
  unique?: boolean;
  [key: string]: unknown;
}

export interface EntitySchemaOptionsLike<T = any> {
  name: string;
  target?: new (...args: any[]) => T;
  tableName?: string;
  schema?: string;
  database?: string;
  columns?: Record<string, EntitySchemaColumnOptionsLike>;
  relations?: Record<string, unknown>;
  indices?: Array<Record<string, unknown>>;
  uniques?: Array<Record<string, unknown>>;
  treeType?: "adjacency-list" | "closure-table" | "nested-set" | "materialized-path";
  [key: string]: unknown;
}

export interface EntitySchemaLike<T = any> {
  readonly "@instanceof"?: symbol;
  readonly options: EntitySchemaOptionsLike<T>;
}

export class EntitySchema<T = any> implements EntitySchemaLike<T> {
  readonly options: EntitySchemaOptionsLike<T>;

  constructor(options: EntitySchemaOptionsLike<T>) {
    this.options = options;
  }
}

export interface EntityMetadataLike {
  readonly target: Function | string;
  readonly name: string;
  readonly tableName: string;
  readonly primaryColumnName: string;
  readonly treeType?:
    | "adjacency-list"
    | "closure-table"
    | "nested-set"
    | "materialized-path";
  readonly columns: Array<{ propertyName: string; isPrimary?: boolean }>;
}

export interface DataSourceOptionsLike {
  readonly name?: string;
  readonly type?:
    | "mysql"
    | "mariadb"
    | "postgres"
    | "cockroachdb"
    | "sqlite"
    | "better-sqlite3"
    | "bun-sqlite"
    | "mssql"
    | "sap"
    | "oracle"
    | "cordova"
    | "nativescript"
    | "react-native"
    | "sqljs"
    | "mongodb"
    | "aurora-mysql"
    | "aurora-postgres"
    | "expo"
    | "capacitor"
    | "spanner"
    | (string & {});
  readonly region?: string;
  readonly secretArn?: string;
  readonly resourceArn?: string;
  readonly database?: string;
  readonly driver?: any;
  readonly serviceConfigOptions?: Record<string, any>;
  readonly formatOptions?: { [key: string]: any; castParameters?: boolean };
  readonly legacySpatialSupport?: boolean;
  readonly poolSize?: number;
  readonly entities?: MixedList<string | Function | EntitySchemaLike<any>>;
  readonly subscribers?: MixedList<string | Function>;
  readonly isolationLevel?:
    | "READ COMMITTED"
    | "READ UNCOMMITTED"
    | "REPEATABLE READ"
    | "SERIALIZABLE"
    | "SNAPSHOT";
  readonly migrations?: MixedList<string | Function>;
  readonly migrationsTableName?: string;
  readonly migrationsTransactionMode?: "all" | "none" | "each";
  readonly metadataTableName?: string;
  readonly namingStrategy?: NamingStrategyInterface;
  readonly logging?: LoggerOptions;
  readonly logger?:
    | "advanced-console"
    | "simple-console"
    | "formatted-console"
    | "file"
    | "debug"
    | TypeOrmLoggerLike;
  readonly maxQueryExecutionTime?: number;
  readonly synchronize?: boolean;
  readonly migrationsRun?: boolean;
  readonly dropSchema?: boolean;
  readonly entityPrefix?: string;
  readonly entitySkipConstructor?: boolean;
  readonly extra?: any;
  readonly relationLoadStrategy?: "query" | "join";
  readonly typename?: string;
  readonly cache?:
    | boolean
    | {
        readonly type?: "database" | "redis" | "ioredis" | "ioredis/cluster";
        readonly provider?: (dataSource: DataSourceLike) => QueryResultCache;
        readonly tableName?: string;
        readonly options?: any;
        readonly alwaysEnabled?: boolean;
        readonly duration?: number;
        readonly ignoreErrors?: boolean;
      };
  readonly isolateWhereStatements?: boolean;
  readonly invalidWhereValuesBehavior?: InvalidFindOptionsWhereBehavior;
  readonly url?: string;
  readonly host?: string;
  readonly port?: number;
  readonly username?: string;
  readonly password?: string;
  readonly ssl?: boolean | TlsOptions;
  readonly uuidExtension?: "pgcrypto" | "uuid-ossp";
  readonly transformParameters?: boolean;
  readonly poolErrorHandler?: (err: any) => any;
  readonly key?: string;
  readonly statementCacheSize?: number;
  readonly prepareDatabase?: (db: any) => void | Promise<void>;
  readonly readonly?: boolean;
  readonly fileMustExist?: boolean;
  readonly timeout?: number;
  readonly verbose?: Function;
  readonly nativeBinding?: string;
  readonly enableWAL?: boolean;
  readonly mode?: "no-encryption" | "encryption" | "secret" | "newsecret";
  readonly version?: number;
  readonly journalMode?:
    | "DELETE"
    | "TRUNCATE"
    | "PERSIST"
    | "MEMORY"
    | "WAL"
    | "OFF";
  readonly timeTravelQueries?: boolean;
  readonly schema?: string;
  readonly nativeDriver?: any;
  readonly replication?: {
    readonly master: SqlServerConnectionCredentialsOptions;
    readonly slaves: SqlServerConnectionCredentialsOptions[];
    readonly defaultMode?: ReplicationMode;
  };
  readonly applicationName?: string;
  readonly maxTransactionRetries?: number;
  readonly location?: string;
  readonly hostReplicaSet?: string;
  readonly appName?: string;
  readonly authMechanism?: string;
  readonly authSource?: string;
  readonly autoEncryption?: any;
  readonly checkServerIdentity?: Function;
  readonly compressors?: string | string[];
  readonly connectTimeoutMS?: number;
  readonly directConnection?: boolean;
  readonly family?: number;
  readonly forceServerObjectId?: boolean;
  readonly ignoreUndefined?: boolean;
  readonly localThresholdMS?: number;
  readonly maxStalenessSeconds?: number;
  readonly minPoolSize?: number;
  readonly monitorCommands?: boolean;
  readonly noDelay?: boolean;
  readonly pkFactory?: any;
  readonly promoteBuffers?: boolean;
  readonly promoteLongs?: boolean;
  readonly promoteValues?: boolean;
  readonly raw?: boolean;
  readonly readConcern?: any;
  readonly readPreference?: string | ReadPreference;
  readonly readPreferenceTags?: any[];
  readonly replicaSet?: string;
  readonly retryWrites?: boolean;
  readonly serializeFunctions?: boolean;
  readonly socketTimeoutMS?: number;
  readonly tls?: boolean;
  readonly tlsAllowInvalidCertificates?: boolean;
  readonly tlsCAFile?: string;
  readonly tlsCertificateKeyFile?: string;
  readonly tlsCertificateKeyFilePassword?: string;
  readonly writeConcern?: any;
  readonly proxyHost?: string;
  readonly proxyPort?: number;
  readonly proxyUsername?: string;
  readonly proxyPassword?: string;
  readonly charset?: string;
  readonly timezone?: string;
  readonly connectTimeout?: number;
  readonly acquireTimeout?: number;
  readonly insecureAuth?: boolean;
  readonly supportBigNumbers?: boolean;
  readonly bigNumberStrings?: boolean;
  readonly dateStrings?: boolean | string[];
  readonly debug?: boolean | string[];
  readonly trace?: boolean;
  readonly multipleStatements?: boolean;
  readonly flags?: string[];
  readonly enableQueryTimeout?: boolean;
  readonly socketPath?: string;
  readonly readOnly?: boolean;
  readonly multithreading?: boolean;
  readonly migrate?: boolean;
  readonly iosFlags?: number;
  readonly androidFlags?: number;
  readonly thickMode?: boolean | OracleThickModeOptions;
  readonly useUTC?: boolean;
  readonly sid?: string;
  readonly serviceName?: string;
  readonly connectString?: string;
  readonly logNotifications?: boolean;
  readonly installExtensions?: boolean;
  readonly parseInt8?: boolean;
  readonly extensions?: string[];
  readonly encryptionKey?: string;
  readonly pool?: {
    readonly max?: number;
    readonly min?: number;
    readonly maxWaitingClients?: number;
    readonly acquireTimeoutMillis?: number;
    readonly fifo?: boolean;
    readonly priorityRange?: number;
    readonly autostart?: boolean;
    readonly evictionRunIntervalMillis?: number;
    readonly numTestsPerEvictionRun?: number;
    readonly softIdleTimeoutMillis?: number;
    readonly idleTimeoutMillis?: number;
    readonly [key: string]: unknown;
  };
  readonly encrypt?: boolean;
  readonly sslValidateCertificate?: boolean;
  readonly cert?: string;
  readonly ca?: string;
  readonly instanceId?: string;
  readonly projectId?: string;
  readonly databaseId?: string;
  readonly credentials?: {
    readonly client_email: string;
    readonly private_key: string;
  };
  readonly sqlJsConfig?: any;
  readonly autoSave?: boolean;
  readonly autoSaveCallback?: Function;
  readonly useLocalForage?: boolean;
  readonly connectionTimeout?: number;
  readonly requestTimeout?: number;
  readonly stream?: boolean;
  readonly options?: {
    readonly instanceName?: string;
    readonly fallbackToDefaultDb?: boolean;
    readonly enableAnsiNullDefault?: boolean;
    readonly connectTimeout?: number;
    readonly cancelTimeout?: number;
    readonly [key: string]: unknown;
  };
  readonly authentication?: SqlServerConnectionCredentialsAuthenticationOptions;
}

export type FindOptionsWhereLike<Entity = Record<string, any>> = {
  [K in keyof Entity]?: Entity[K];
} & Record<string, any>;

export interface FindManyOptionsLike<Entity = Record<string, any>> {
  where?: FindOptionsWhereLike<Entity> | Array<FindOptionsWhereLike<Entity>>;
  order?: Partial<Record<keyof Entity | string, "ASC" | "DESC" | "asc" | "desc" | 1 | -1>>;
  skip?: number;
  take?: number;
  select?: Array<keyof Entity> | Partial<Record<keyof Entity, boolean>>;
}

export interface FindOneOptionsLike<Entity = Record<string, any>> {
  where?: FindOptionsWhereLike<Entity> | Array<FindOptionsWhereLike<Entity>>;
  order?: Partial<Record<keyof Entity | string, "ASC" | "DESC" | "asc" | "desc" | 1 | -1>>;
  select?: Array<keyof Entity> | Partial<Record<keyof Entity, boolean>>;
}

export interface UpdateResultLike {
  raw?: unknown;
  affected?: number;
  generatedMaps: Array<Record<string, unknown>>;
}

export interface DeleteResultLike {
  raw?: unknown;
  affected?: number | null;
}

export interface InsertResultLike {
  identifiers: Array<Record<string, unknown>>;
  generatedMaps: Array<Record<string, unknown>>;
  raw?: unknown;
}

export interface QueryRunnerLike {
  readonly isTransactionActive: boolean;
  readonly isReleased: boolean;
  readonly manager: EntityManagerLike;
  connect(): Promise<unknown>;
  startTransaction(isolationLevel?: string): Promise<void>;
  commitTransaction(): Promise<void>;
  rollbackTransaction(): Promise<void>;
  release(): Promise<void>;
  query(sql: string, parameters?: unknown[]): Promise<any>;
}

export interface RepositoryLike<Entity = any> {
  readonly target: Function | EntitySchemaLike<Entity> | string;
  readonly manager: EntityManagerLike;
  readonly metadata: EntityMetadataLike;
  create(entityLike?: Partial<Entity>): Entity;
  save<T extends Partial<Entity>>(entity: T): Promise<Entity>;
  save<T extends Partial<Entity>>(entities: T[]): Promise<Entity[]>;
  insert(entity: Partial<Entity> | Array<Partial<Entity>>): Promise<InsertResultLike>;
  update(
    criteria: string | number | FindOptionsWhereLike<Entity>,
    partialEntity: Partial<Entity>,
  ): Promise<UpdateResultLike>;
  delete(
    criteria: string | number | FindOptionsWhereLike<Entity>,
  ): Promise<DeleteResultLike>;
  remove(entity: Entity): Promise<Entity>;
  remove(entities: Entity[]): Promise<Entity[]>;
  find(options?: FindManyOptionsLike<Entity>): Promise<Entity[]>;
  findBy(
    where: FindOptionsWhereLike<Entity> | Array<FindOptionsWhereLike<Entity>>,
  ): Promise<Entity[]>;
  findOne(options: FindOneOptionsLike<Entity>): Promise<Entity | null>;
  findOneBy(
    where: FindOptionsWhereLike<Entity> | Array<FindOptionsWhereLike<Entity>>,
  ): Promise<Entity | null>;
  findOneOrFail(options: FindOneOptionsLike<Entity>): Promise<Entity>;
  findOneByOrFail(
    where: FindOptionsWhereLike<Entity> | Array<FindOptionsWhereLike<Entity>>,
  ): Promise<Entity>;
  findAndCount(options?: FindManyOptionsLike<Entity>): Promise<[Entity[], number]>;
  findAndCountBy(
    where: FindOptionsWhereLike<Entity> | Array<FindOptionsWhereLike<Entity>>,
  ): Promise<[Entity[], number]>;
  count(options?: FindManyOptionsLike<Entity>): Promise<number>;
  countBy(
    where: FindOptionsWhereLike<Entity> | Array<FindOptionsWhereLike<Entity>>,
  ): Promise<number>;
  exists(options?: FindManyOptionsLike<Entity>): Promise<boolean>;
  existsBy(
    where: FindOptionsWhereLike<Entity> | Array<FindOptionsWhereLike<Entity>>,
  ): Promise<boolean>;
  clear(): Promise<void>;
  query(query: string, parameters?: unknown[]): Promise<any>;
  extend<CustomRepository>(
    custom: CustomRepository & ThisType<this & CustomRepository>,
  ): this & CustomRepository;
}

export interface EntityManagerLike {
  readonly connection: DataSourceLike;
  getRepository<Entity = any>(
    target: Function | EntitySchemaLike<Entity> | string,
  ): RepositoryLike<Entity>;
  getTreeRepository<Entity = any>(
    target: Function | EntitySchemaLike<Entity> | string,
  ): TreeRepository<Entity>;
  getMongoRepository<Entity = any>(
    target: Function | EntitySchemaLike<Entity> | string,
  ): MongoRepository<Entity>;
  query(query: string, parameters?: unknown[]): Promise<any>;
  transaction<T>(
    runInTransaction: (entityManager: EntityManagerLike) => Promise<T>,
  ): Promise<T>;
  save<Entity = any>(
    targetOrEntity:
      | (new (...args: any[]) => Entity)
      | Function
      | EntitySchemaLike<Entity>
      | Entity,
    entity?: Record<string, any>,
  ): Promise<any>;
  find<Entity = any>(
    entityClass: Function | EntitySchemaLike<Entity> | string,
    options?: FindManyOptionsLike<Entity>,
  ): Promise<Entity[]>;
  findOne<Entity = any>(
    entityClass: Function | EntitySchemaLike<Entity> | string,
    options: FindOneOptionsLike<Entity>,
  ): Promise<Entity | null>;
  clear(entityClass: Function | EntitySchemaLike<any> | string): Promise<void>;
}

export interface DataSourceLike {
  readonly name?: string;
  readonly options: DataSourceOptionsLike;
  readonly isInitialized: boolean;
  readonly manager: EntityManagerLike;
  readonly entityMetadatas: EntityMetadataLike[];
  initialize(): Promise<this>;
  destroy(): Promise<void>;
  getRepository<Entity = any>(
    target: Function | EntitySchemaLike<Entity> | string,
  ): RepositoryLike<Entity>;
  getTreeRepository<Entity = any>(
    target: Function | EntitySchemaLike<Entity> | string,
  ): TreeRepository<Entity>;
  getMongoRepository<Entity = any>(
    target: Function | EntitySchemaLike<Entity> | string,
  ): MongoRepository<Entity>;
  query(query: string, parameters?: unknown[]): Promise<any>;
  transaction<T>(
    runInTransaction: (entityManager: EntityManagerLike) => Promise<T>,
  ): Promise<T>;
  createQueryRunner(): QueryRunnerLike;
  synchronize(dropBeforeSync?: boolean): Promise<void>;
}

function isEntitySchemaInstance(value: unknown): value is EntitySchemaLike {
  return (
    value instanceof EntitySchema ||
    (typeof value === "object" &&
      value !== null &&
      "options" in value &&
      typeof (value as EntitySchemaLike).options === "object" &&
      (value as EntitySchemaLike).options !== null &&
      typeof (value as EntitySchemaLike).options.name === "string")
  );
}

function sanitizeTableIdent(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();
}

function resolveEntityMetadata(
  entity: Function | EntitySchemaLike<any> | string,
  entityPrefix = "",
): EntityMetadataLike {
  if (isEntitySchemaInstance(entity)) {
    const opts = entity.options;
    const baseName = opts.target?.name ?? opts.name;
    const rawTable = opts.tableName ?? opts.name;
    const columns = Object.entries(opts.columns ?? {}).map(([key, col]) => ({
      propertyName: key,
      isPrimary: Boolean(col?.primary),
    }));
    const primary = columns.find((c) => c.isPrimary)?.propertyName ?? "id";
    return {
      target: opts.target ?? opts.name,
      name: baseName,
      tableName: `${entityPrefix}${sanitizeTableIdent(rawTable)}`,
      primaryColumnName: primary,
      treeType: opts.treeType,
      columns,
    };
  }
  if (typeof entity === "string") {
    return {
      target: entity,
      name: entity,
      tableName: `${entityPrefix}${sanitizeTableIdent(entity)}`,
      primaryColumnName: "id",
      columns: [{ propertyName: "id", isPrimary: true }],
    };
  }
  const treeType = Reflect.getMetadata?.(
    "typeorm:treeType",
    entity,
  ) as EntityMetadataLike["treeType"];
  return {
    target: entity,
    name: entity.name || "Entity",
    tableName: `${entityPrefix}${sanitizeTableIdent(entity.name || "entity")}`,
    primaryColumnName: "id",
    treeType,
    columns: [{ propertyName: "id", isPrimary: true }],
  };
}

function matchesWhere(
  row: Record<string, any>,
  where?: FindOptionsWhereLike<any> | Array<FindOptionsWhereLike<any>>,
): boolean {
  if (!where) return true;
  if (Array.isArray(where)) {
    if (where.length === 0) return true;
    return where.some((clause) => matchesWhere(row, clause));
  }
  for (const [key, expected] of Object.entries(where)) {
    if (expected === undefined) continue;
    if (row[key] !== expected) return false;
  }
  return true;
}

function applyOrderAndSlice<T extends Record<string, any>>(
  rows: T[],
  options?: FindManyOptionsLike<T>,
): T[] {
  let result = [...rows];
  if (options?.order) {
    const entries = Object.entries(options.order);
    result.sort((a, b) => {
      for (const [field, dir] of entries) {
        const av = a[field];
        const bv = b[field];
        if (av === bv) continue;
        const mult = dir === "DESC" || dir === "desc" || dir === -1 ? -1 : 1;
        if (av === undefined || av === null) return -1 * mult;
        if (bv === undefined || bv === null) return 1 * mult;
        return av < bv ? -1 * mult : 1 * mult;
      }
      return 0;
    });
  }
  if (options?.skip !== undefined || options?.take !== undefined) {
    const start = options.skip ?? 0;
    const end = options.take !== undefined ? start + options.take : undefined;
    result = result.slice(start, end);
  }
  if (options?.select) {
    const keys = Array.isArray(options.select)
      ? (options.select as string[])
      : Object.entries(options.select)
          .filter(([, v]) => Boolean(v))
          .map(([k]) => k);
    result = result.map((row) => {
      const picked: Record<string, any> = {};
      for (const k of keys) {
        if (k in row) picked[k] = row[k];
      }
      return picked as T;
    });
  }
  return result;
}

interface EntityStoreBackend {
  ensureTable(tableName: string): void;
  getAll(tableName: string): Array<Record<string, any>>;
  upsert(tableName: string, id: string, record: Record<string, any>): void;
  deleteById(tableName: string, id: string): boolean;
  clear(tableName: string): void;
  nextId(tableName: string): number;
  query(sql: string, parameters?: unknown[]): any;
  beginTransaction(): void;
  commitTransaction(): void;
  rollbackTransaction(): void;
  close(): void;
}

class SqliteEntityStoreBackend implements EntityStoreBackend {
  private readonly db: Database;
  private readonly ensuredTables = new Set<string>();
  private readonly sequences = new Map<string, number>();
  private savepointDepth = 0;

  constructor(filename: string) {
    this.db = new Database(filename);
  }

  private physicalTable(tableName: string): string {
    return `__bunest_orm_${sanitizeTableIdent(tableName)}`;
  }

  ensureTable(tableName: string): void {
    const physical = this.physicalTable(tableName);
    if (this.ensuredTables.has(physical)) return;
    this.db.run(
      `CREATE TABLE IF NOT EXISTS "${physical}" (id TEXT PRIMARY KEY, payload TEXT NOT NULL)`,
    );
    this.ensuredTables.add(physical);
  }

  getAll(tableName: string): Array<Record<string, any>> {
    this.ensureTable(tableName);
    const physical = this.physicalTable(tableName);
    const rows = this.db
      .query(`SELECT payload FROM "${physical}" ORDER BY rowid ASC`)
      .all() as Array<{ payload: string }>;
    return rows.map((r) => JSON.parse(r.payload) as Record<string, any>);
  }

  upsert(tableName: string, id: string, record: Record<string, any>): void {
    this.ensureTable(tableName);
    const physical = this.physicalTable(tableName);
    this.db
      .query(
        `INSERT INTO "${physical}" (id, payload) VALUES (?1, ?2) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload`,
      )
      .run(id, JSON.stringify(record));
  }

  deleteById(tableName: string, id: string): boolean {
    this.ensureTable(tableName);
    const physical = this.physicalTable(tableName);
    const res = this.db
      .query(`DELETE FROM "${physical}" WHERE id = ?1`)
      .run(id);
    return (res.changes ?? 0) > 0;
  }

  clear(tableName: string): void {
    this.ensureTable(tableName);
    const physical = this.physicalTable(tableName);
    this.db.run(`DELETE FROM "${physical}"`);
  }

  nextId(tableName: string): number {
    const next = (this.sequences.get(tableName) ?? 0) + 1;
    this.sequences.set(tableName, next);
    return next;
  }

  query(sql: string, parameters: unknown[] = []): any {
    const trimmed = sql.trim().toUpperCase();
    const stmt = this.db.query(sql);
    const args = parameters as any[];
    if (
      trimmed.startsWith("SELECT") ||
      trimmed.startsWith("PRAGMA") ||
      trimmed.startsWith("WITH") ||
      trimmed.includes("RETURNING")
    ) {
      return stmt.all(...args);
    }
    return stmt.run(...args);
  }

  beginTransaction(): void {
    if (this.savepointDepth === 0) {
      this.db.run("BEGIN TRANSACTION");
    } else {
      this.db.run(`SAVEPOINT sp_${this.savepointDepth}`);
    }
    this.savepointDepth++;
  }

  commitTransaction(): void {
    if (this.savepointDepth <= 0) return;
    this.savepointDepth--;
    if (this.savepointDepth === 0) {
      this.db.run("COMMIT");
    } else {
      this.db.run(`RELEASE SAVEPOINT sp_${this.savepointDepth}`);
    }
  }

  rollbackTransaction(): void {
    if (this.savepointDepth <= 0) return;
    this.savepointDepth--;
    if (this.savepointDepth === 0) {
      this.db.run("ROLLBACK");
    } else {
      this.db.run(`ROLLBACK TO SAVEPOINT sp_${this.savepointDepth}`);
    }
  }

  close(): void {
    this.ensuredTables.clear();
    this.db.close();
  }
}

export class Repository<Entity = any>
  implements RepositoryLike<Entity>
{
  readonly target: Function | EntitySchemaLike<Entity> | string;
  readonly manager: EntityManager;
  readonly metadata: EntityMetadataLike;

  constructor(
    target: Function | EntitySchemaLike<Entity> | string,
    manager: EntityManager,
    metadata?: EntityMetadataLike,
  ) {
    this.target = target;
    this.manager = manager;
    this.metadata = metadata ?? resolveEntityMetadata(target);
  }

  private get backend(): EntityStoreBackend {
    return this.manager.connection._getBackend();
  }

  private hydrate(raw: Record<string, any>): Entity {
    const targetCtor =
      typeof this.metadata.target === "function"
        ? (this.metadata.target as new () => Entity)
        : undefined;
    if (targetCtor && !this.manager.connection.options.entitySkipConstructor) {
      try {
        const instance = new targetCtor();
        return Object.assign(instance as object, raw) as Entity;
      } catch {
        return { ...raw } as Entity;
      }
    }
    return { ...raw } as Entity;
  }

  create(entityLike?: Partial<Entity>): Entity {
    return this.hydrate((entityLike ?? {}) as Record<string, any>);
  }

  async save<T extends Partial<Entity>>(entity: T): Promise<Entity>;
  async save<T extends Partial<Entity>>(entities: T[]): Promise<Entity[]>;
  async save<T extends Partial<Entity>>(
    entityOrEntities: T | T[],
  ): Promise<Entity | Entity[]> {
    if (Array.isArray(entityOrEntities)) {
      const results: Entity[] = [];
      for (const item of entityOrEntities) {
        results.push(await this.save(item));
      }
      return results;
    }
    const pk = this.metadata.primaryColumnName;
    const record: Record<string, any> = { ...entityOrEntities };
    if (record[pk] === undefined || record[pk] === null) {
      record[pk] = this.backend.nextId(this.metadata.tableName);
    }
    this.backend.upsert(this.metadata.tableName, String(record[pk]), record);
    return this.hydrate(record);
  }

  async insert(
    entity: Partial<Entity> | Array<Partial<Entity>>,
  ): Promise<InsertResultLike> {
    const items = Array.isArray(entity) ? entity : [entity];
    const pk = this.metadata.primaryColumnName;
    const identifiers: Array<Record<string, unknown>> = [];
    const generatedMaps: Array<Record<string, unknown>> = [];
    for (const item of items) {
      const saved = await this.save(item);
      const idVal = (saved as Record<string, unknown>)[pk];
      identifiers.push({ [pk]: idVal });
      generatedMaps.push({ [pk]: idVal });
    }
    return { identifiers, generatedMaps, raw: identifiers };
  }

  async update(
    criteria: string | number | FindOptionsWhereLike<Entity>,
    partialEntity: Partial<Entity>,
  ): Promise<UpdateResultLike> {
    const pk = this.metadata.primaryColumnName;
    const where: FindOptionsWhereLike<Entity> =
      typeof criteria === "string" || typeof criteria === "number"
        ? ({ [pk]: criteria } as FindOptionsWhereLike<Entity>)
        : criteria;
    const rows = this.backend.getAll(this.metadata.tableName);
    let affected = 0;
    const generatedMaps: Array<Record<string, unknown>> = [];
    for (const row of rows) {
      if (matchesWhere(row, where)) {
        const updated = { ...row, ...partialEntity };
        this.backend.upsert(
          this.metadata.tableName,
          String(updated[pk]),
          updated,
        );
        affected++;
        generatedMaps.push({ [pk]: updated[pk] });
      }
    }
    return { affected, generatedMaps, raw: generatedMaps };
  }

  async delete(
    criteria: string | number | FindOptionsWhereLike<Entity>,
  ): Promise<DeleteResultLike> {
    const pk = this.metadata.primaryColumnName;
    const where: FindOptionsWhereLike<Entity> =
      typeof criteria === "string" || typeof criteria === "number"
        ? ({ [pk]: criteria } as FindOptionsWhereLike<Entity>)
        : criteria;
    const rows = this.backend.getAll(this.metadata.tableName);
    let affected = 0;
    for (const row of rows) {
      if (matchesWhere(row, where)) {
        if (this.backend.deleteById(this.metadata.tableName, String(row[pk]))) {
          affected++;
        }
      }
    }
    return { affected, raw: [] };
  }

  async remove(entity: Entity): Promise<Entity>;
  async remove(entities: Entity[]): Promise<Entity[]>;
  async remove(entityOrEntities: Entity | Entity[]): Promise<Entity | Entity[]> {
    const pk = this.metadata.primaryColumnName;
    if (Array.isArray(entityOrEntities)) {
      for (const entity of entityOrEntities) {
        this.backend.deleteById(
          this.metadata.tableName,
          String((entity as Record<string, any>)[pk]),
        );
      }
      return entityOrEntities;
    }
    this.backend.deleteById(
      this.metadata.tableName,
      String((entityOrEntities as Record<string, any>)[pk]),
    );
    return entityOrEntities;
  }

  async find(options?: FindManyOptionsLike<Entity>): Promise<Entity[]> {
    const rows = this.backend
      .getAll(this.metadata.tableName)
      .filter((row) => matchesWhere(row, options?.where));
    return applyOrderAndSlice(
      rows,
      options as FindManyOptionsLike<Record<string, any>> | undefined,
    ).map((row) => this.hydrate(row));
  }

  async findBy(
    where: FindOptionsWhereLike<Entity> | Array<FindOptionsWhereLike<Entity>>,
  ): Promise<Entity[]> {
    return this.find({ where });
  }

  async findOne(options: FindOneOptionsLike<Entity>): Promise<Entity | null> {
    const found = await this.find({ ...options, take: 1 });
    return found[0] ?? null;
  }

  async findOneBy(
    where: FindOptionsWhereLike<Entity> | Array<FindOptionsWhereLike<Entity>>,
  ): Promise<Entity | null> {
    return this.findOne({ where });
  }

  async findOneOrFail(options: FindOneOptionsLike<Entity>): Promise<Entity> {
    const found = await this.findOne(options);
    if (!found) {
      throw new Error(
        `Could not find any entity of type "${this.metadata.name}" matching criteria.`,
      );
    }
    return found;
  }

  async findOneByOrFail(
    where: FindOptionsWhereLike<Entity> | Array<FindOptionsWhereLike<Entity>>,
  ): Promise<Entity> {
    return this.findOneOrFail({ where });
  }

  async findAndCount(
    options?: FindManyOptionsLike<Entity>,
  ): Promise<[Entity[], number]> {
    const allMatched = this.backend
      .getAll(this.metadata.tableName)
      .filter((row) => matchesWhere(row, options?.where));
    const sliced = applyOrderAndSlice(
      allMatched,
      options as FindManyOptionsLike<Record<string, any>> | undefined,
    ).map((row) => this.hydrate(row));
    return [sliced, allMatched.length];
  }

  async findAndCountBy(
    where: FindOptionsWhereLike<Entity> | Array<FindOptionsWhereLike<Entity>>,
  ): Promise<[Entity[], number]> {
    return this.findAndCount({ where });
  }

  async count(options?: FindManyOptionsLike<Entity>): Promise<number> {
    return this.backend
      .getAll(this.metadata.tableName)
      .filter((row) => matchesWhere(row, options?.where)).length;
  }

  async countBy(
    where: FindOptionsWhereLike<Entity> | Array<FindOptionsWhereLike<Entity>>,
  ): Promise<number> {
    return this.count({ where });
  }

  async exists(options?: FindManyOptionsLike<Entity>): Promise<boolean> {
    return (await this.count(options)) > 0;
  }

  async existsBy(
    where: FindOptionsWhereLike<Entity> | Array<FindOptionsWhereLike<Entity>>,
  ): Promise<boolean> {
    return this.exists({ where });
  }

  async clear(): Promise<void> {
    this.backend.clear(this.metadata.tableName);
  }

  async query(query: string, parameters?: unknown[]): Promise<any> {
    return this.backend.query(query, parameters);
  }

  extend<CustomRepository>(
    custom: CustomRepository & ThisType<this & CustomRepository>,
  ): this & CustomRepository {
    const extended = Object.create(this) as this & CustomRepository;
    Object.assign(extended, custom);
    return extended;
  }
}

export class TreeRepository<Entity = any> extends Repository<Entity> {
  async findTrees(): Promise<Entity[]> {
    return this.find();
  }

  async findRoots(): Promise<Entity[]> {
    const all = await this.find();
    return all.filter((item) => {
      const rec = item as Record<string, any>;
      return !rec.parent && !rec.parentId;
    });
  }

  async findDescendants(entity: Entity): Promise<Entity[]> {
    const pk = this.metadata.primaryColumnName;
    const all = await this.find();
    const targetId = (entity as Record<string, any>)[pk];
    return all.filter((item) => (item as Record<string, any>).parentId === targetId);
  }

  async findAncestors(entity: Entity): Promise<Entity[]> {
    const pk = this.metadata.primaryColumnName;
    const all = await this.find();
    const ancestors: Entity[] = [];
    let parentId = (entity as Record<string, any>).parentId;
    while (parentId !== undefined && parentId !== null) {
      const parent = all.find((item) => (item as Record<string, any>)[pk] === parentId);
      if (!parent) break;
      ancestors.push(parent);
      parentId = (parent as Record<string, any>).parentId;
    }
    return ancestors;
  }
}

export class MongoRepository<Entity = any> extends Repository<Entity> {
  async insertOne(doc: Partial<Entity>): Promise<{ insertedId: unknown }> {
    const saved = await this.save(doc);
    return {
      insertedId: (saved as Record<string, any>)[
        this.metadata.primaryColumnName
      ],
    };
  }

  async insertMany(
    docs: Array<Partial<Entity>>,
  ): Promise<{ insertedCount: number; insertedIds: unknown[] }> {
    const saved = await this.save(docs);
    const pk = this.metadata.primaryColumnName;
    return {
      insertedCount: saved.length,
      insertedIds: saved.map((s) => (s as Record<string, any>)[pk]),
    };
  }

  async deleteOne(
    filter: FindOptionsWhereLike<Entity>,
  ): Promise<{ deletedCount: number }> {
    const found = await this.findOneBy(filter);
    if (!found) return { deletedCount: 0 };
    await this.remove(found);
    return { deletedCount: 1 };
  }

  async deleteMany(
    filter: FindOptionsWhereLike<Entity>,
  ): Promise<{ deletedCount: number }> {
    const res = await this.delete(filter);
    return { deletedCount: res.affected ?? 0 };
  }

  async countDocuments(filter?: FindOptionsWhereLike<Entity>): Promise<number> {
    return this.count(filter ? { where: filter } : undefined);
  }
}

export class EntityManager implements EntityManagerLike {
  readonly connection: DataSource;

  constructor(connection: DataSource) {
    this.connection = connection;
  }

  getRepository<Entity = any>(
    target: Function | EntitySchemaLike<Entity> | string,
  ): Repository<Entity> {
    return this.connection.getRepository<Entity>(target);
  }

  getTreeRepository<Entity = any>(
    target: Function | EntitySchemaLike<Entity> | string,
  ): TreeRepository<Entity> {
    return this.connection.getTreeRepository<Entity>(target);
  }

  getMongoRepository<Entity = any>(
    target: Function | EntitySchemaLike<Entity> | string,
  ): MongoRepository<Entity> {
    return this.connection.getMongoRepository<Entity>(target);
  }

  async query(query: string, parameters?: unknown[]): Promise<any> {
    return this.connection.query(query, parameters);
  }

  async transaction<T>(
    runInTransaction: (entityManager: EntityManager) => Promise<T>,
  ): Promise<T> {
    return this.connection.transaction(runInTransaction);
  }

  async save<Entity = any>(
    targetOrEntity:
      | (new (...args: any[]) => Entity)
      | Function
      | EntitySchemaLike<Entity>
      | Entity,
    entity?: Record<string, any>,
  ): Promise<any> {
    if (
      typeof targetOrEntity === "function" ||
      isEntitySchemaInstance(targetOrEntity)
    ) {
      return this.getRepository<Entity>(targetOrEntity).save(
        (entity ?? {}) as Partial<Entity>,
      );
    }
    const ctor = (targetOrEntity as object)?.constructor;
    if (typeof ctor === "function") {
      return this.getRepository<Entity>(ctor).save(
        targetOrEntity as Partial<Entity>,
      );
    }
    throw new Error("EntityManager.save() requires an entity class or instance.");
  }

  async find<Entity = any>(
    entityClass: Function | EntitySchemaLike<Entity> | string,
    options?: FindManyOptionsLike<Entity>,
  ): Promise<Entity[]> {
    return this.getRepository<Entity>(entityClass).find(options);
  }

  async findOne<Entity = any>(
    entityClass: Function | EntitySchemaLike<Entity> | string,
    options: FindOneOptionsLike<Entity>,
  ): Promise<Entity | null> {
    return this.getRepository<Entity>(entityClass).findOne(options);
  }

  async clear(
    entityClass: Function | EntitySchemaLike<any> | string,
  ): Promise<void> {
    await this.getRepository(entityClass).clear();
  }
}

export class DataSource implements DataSourceLike {
  readonly name: string;
  readonly options: DataSourceOptionsLike;
  isInitialized = false;
  readonly manager: EntityManager;
  entityMetadatas: EntityMetadataLike[] = [];

  private backend?: EntityStoreBackend;
  private readonly repositories = new Map<unknown, Repository<any>>();
  private readonly treeRepositories = new Map<unknown, TreeRepository<any>>();
  private readonly mongoRepositories = new Map<unknown, MongoRepository<any>>();

  constructor(options: DataSourceOptionsLike = {}) {
    this.options = options;
    this.name = options.name ?? "default";
    this.manager = new EntityManager(this);
    this.registerEntities(options.entities);
  }

  private registerEntities(
    entities?: MixedList<string | Function | EntitySchemaLike<any>>,
  ): void {
    if (!entities) return;
    const list = Array.isArray(entities) ? entities : Object.values(entities);
    const prefix = this.options.entityPrefix ?? "";
    for (const entity of list) {
      if (typeof entity === "string") continue;
      const meta = resolveEntityMetadata(entity, prefix);
      if (!this.entityMetadatas.some((m) => m.target === meta.target)) {
        this.entityMetadatas.push(meta);
      }
    }
  }

  /** @internal */
  _getBackend(): EntityStoreBackend {
    if (!this.backend) {
      const dbPath =
        this.options.type === "sqlite" ||
        this.options.type === "better-sqlite3" ||
        this.options.type === "bun-sqlite"
          ? this.options.database || ":memory:"
          : ":memory:";
      this.backend = new SqliteEntityStoreBackend(dbPath);
    }
    return this.backend;
  }

  async initialize(): Promise<this> {
    if (this.isInitialized) {
      return this;
    }
    const backend = this._getBackend();
    if (this.options.dropSchema) {
      for (const meta of this.entityMetadatas) {
        backend.clear(meta.tableName);
      }
    }
    if (this.options.synchronize) {
      for (const meta of this.entityMetadatas) {
        backend.ensureTable(meta.tableName);
      }
    }
    this.isInitialized = true;
    return this;
  }

  async destroy(): Promise<void> {
    if (!this.isInitialized) {
      return;
    }
    this.backend?.close();
    this.backend = undefined;
    this.repositories.clear();
    this.treeRepositories.clear();
    this.mongoRepositories.clear();
    this.isInitialized = false;
  }

  async synchronize(dropBeforeSync = false): Promise<void> {
    const backend = this._getBackend();
    for (const meta of this.entityMetadatas) {
      backend.ensureTable(meta.tableName);
      if (dropBeforeSync) {
        backend.clear(meta.tableName);
      }
    }
  }

  private resolveOrRegisterMetadata(
    target: Function | EntitySchemaLike<any> | string,
  ): EntityMetadataLike {
    const lookupKey = isEntitySchemaInstance(target)
      ? (target.options.target ?? target.options.name)
      : target;
    const existing = this.entityMetadatas.find((m) => m.target === lookupKey);
    if (existing) return existing;
    const created = resolveEntityMetadata(target, this.options.entityPrefix);
    this.entityMetadatas.push(created);
    return created;
  }

  getRepository<Entity = any>(
    target: Function | EntitySchemaLike<Entity> | string,
  ): Repository<Entity> {
    const meta = this.resolveOrRegisterMetadata(target);
    let repo = this.repositories.get(meta.target);
    if (!repo) {
      repo = new Repository<Entity>(target, this.manager, meta);
      this.repositories.set(meta.target, repo);
    }
    return repo;
  }

  getTreeRepository<Entity = any>(
    target: Function | EntitySchemaLike<Entity> | string,
  ): TreeRepository<Entity> {
    const meta = this.resolveOrRegisterMetadata(target);
    let repo = this.treeRepositories.get(meta.target);
    if (!repo) {
      repo = new TreeRepository<Entity>(target, this.manager, meta);
      this.treeRepositories.set(meta.target, repo);
    }
    return repo;
  }

  getMongoRepository<Entity = any>(
    target: Function | EntitySchemaLike<Entity> | string,
  ): MongoRepository<Entity> {
    const meta = this.resolveOrRegisterMetadata(target);
    let repo = this.mongoRepositories.get(meta.target);
    if (!repo) {
      repo = new MongoRepository<Entity>(target, this.manager, meta);
      this.mongoRepositories.set(meta.target, repo);
    }
    return repo;
  }

  async query(query: string, parameters?: unknown[]): Promise<any> {
    return this._getBackend().query(query, parameters);
  }

  async transaction<T>(
    runInTransaction: (entityManager: EntityManager) => Promise<T>,
  ): Promise<T> {
    const backend = this._getBackend();
    backend.beginTransaction();
    try {
      const result = await runInTransaction(this.manager);
      backend.commitTransaction();
      return result;
    } catch (err) {
      backend.rollbackTransaction();
      throw err;
    }
  }

  createQueryRunner(): QueryRunnerLike {
    const backend = this._getBackend();
    const manager = this.manager;
    let txActive = false;
    let released = false;
    return {
      get isTransactionActive() {
        return txActive;
      },
      get isReleased() {
        return released;
      },
      manager,
      async connect() {
        return backend;
      },
      async startTransaction() {
        backend.beginTransaction();
        txActive = true;
      },
      async commitTransaction() {
        backend.commitTransaction();
        txActive = false;
      },
      async rollbackTransaction() {
        backend.rollbackTransaction();
        txActive = false;
      },
      async release() {
        released = true;
      },
      async query(sql: string, parameters?: unknown[]) {
        return backend.query(sql, parameters);
      },
    };
  }
}
