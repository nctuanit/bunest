import type { Abstract } from "@bunest/core";
import { compileOrmRepository } from "./declarative-repository";
import {
  getDialectProfile,
  type SqlDialectProfile,
} from "./dialect/dialect-profile";
import { createDriverFromOptions } from "./driver/driver-factory";
import { EntityManager } from "./entity-manager";
import { DataSourceNotInitializedError } from "./errors";
import { normalizeDialect } from "./identifiers";
import {
  compileMetadataGraph,
  type CompiledEntityMetadata,
  type CompiledMetadataGraph,
} from "./metadata-graph";
import { OrmMigrationRunner } from "./migration-runner";
import {
  createNPlusOneDetector,
  type NPlusOneDetectorHandle,
} from "./n-plus-one-detector";
import type { MongoRepository } from "./mongo-repository";
import type { SelectQueryBuilder } from "./query-builder";
import type { OrmRepository, OrmRepositoryRuntime } from "./repository";
import { SchemaBuilder, type GeneratedSchemaPlan } from "./schema-builder";
import type {
  EntityTarget,
  OrmDataSourceOptions,
  OrmDialect,
  OrmDriverLike,
  OrmMigrationRecord,
  OrmTransactionOptions,
} from "./types";

interface MutableOrmRepositoryRuntime {
  driver: OrmDriverLike;
  graph: CompiledMetadataGraph;
  maxEagerDepth: number;
  safeJsonSerialization: boolean;
  circularJsonStrategy: OrmRepositoryRuntime["circularJsonStrategy"];
  dataSourceName: string;
}

/**
 * Primary ORM connection & metadata graph host (TypeORM `DataSource` equivalent).
 *
 * Compatible with ALL TypeORM database types powered natively by Bun APIs
 * (`bun:sqlite`, `Bun.SQL` for Postgres/CockroachDB/MySQL/MariaDB/SQLite,
 * Bun `fetch()` for LibSQL/Turso & Cloudflare D1, Bun `Bun.connect()` Wire Protocol
 * `OP_MSG` + BSON for MongoDB, Master/Slave Replication, and `OrmDriverRegistry`).
 */
export class DataSource {
  readonly name: string;
  readonly options: OrmDataSourceOptions;
  readonly dialect: OrmDialect;

  private _isInitialized = false;
  private _driver?: OrmDriverLike;
  private _graph?: CompiledMetadataGraph;
  private _runtime?: MutableOrmRepositoryRuntime;
  private _manager?: EntityManager;
  private _schemaBuilder?: SchemaBuilder;
  private _migrationRunner?: OrmMigrationRunner;
  private _nPlusOneDetector?: NPlusOneDetectorHandle;
  private readonly _registeredEntities: EntityTarget[] = [];
  private readonly _declarativeRepoCache = new Map<Function, object>();

  constructor(options: OrmDataSourceOptions = {}) {
    this.options = options;
    this.name = options.name ?? "default";
    this.dialect =
      options.driver?.dialect ?? normalizeDialect(options.type ?? "sqlite");
    if (options.entities) {
      this._registeredEntities.push(...options.entities);
    }
  }

  get isInitialized(): boolean {
    return this._isInitialized;
  }

  get driver(): OrmDriverLike {
    if (!this._driver) {
      throw new DataSourceNotInitializedError(this.name);
    }
    return this._driver;
  }

  get dialectProfile(): SqlDialectProfile {
    return getDialectProfile(this.dialect);
  }

  get metadataGraph(): CompiledMetadataGraph {
    if (!this._graph) {
      throw new DataSourceNotInitializedError(this.name);
    }
    return this._graph;
  }

  get entityMetadatas(): readonly CompiledEntityMetadata[] {
    return this._graph?.entities ?? [];
  }

  get manager(): EntityManager {
    if (!this._manager) {
      throw new DataSourceNotInitializedError(this.name);
    }
    return this._manager;
  }

  get migrationRunner(): OrmMigrationRunner {
    if (!this._migrationRunner) {
      this._migrationRunner = new OrmMigrationRunner(
        this,
        this.options.migrations,
        this.options.migrationsTable,
      );
    }
    return this._migrationRunner;
  }

  /**
   * Connects to the database using Bun's native driver, compiles the two-phase lazy
   * metadata graph across all entities / nested classes / cyclic relations, and
   * optionally synchronizes schema or executes pending migrations.
   */
  async initialize(): Promise<this> {
    if (this._isInitialized) {
      return this;
    }

    const driver = createDriverFromOptions({
      ...this.options,
      name: this.name,
    });
    await driver.connect();

    const graph = compileMetadataGraph({
      entities: this._registeredEntities,
      autoLoadEntities: this.options.autoLoadEntities,
      entityPrefix: this.options.entityPrefix,
    });

    const runtime: MutableOrmRepositoryRuntime = {
      driver,
      graph,
      maxEagerDepth: this.options.maxEagerDepth ?? 2,
      safeJsonSerialization: this.options.safeJsonSerialization ?? true,
      circularJsonStrategy: this.options.circularJsonStrategy ?? "omit",
      dataSourceName: this.name,
    };

    this._driver = driver;
    this._graph = graph;
    this._runtime = runtime;
    this._manager = new EntityManager(runtime);
    this._schemaBuilder = new SchemaBuilder(
      driver,
      graph,
      this.options.enforceForeignKeys ?? true,
    );
    this._migrationRunner = new OrmMigrationRunner(
      this,
      this.options.migrations,
      this.options.migrationsTable,
    );
    this._isInitialized = true;

    if (this.options.dropSchema) {
      await this._schemaBuilder.dropSchema();
    }
    if (this.options.synchronize || this.options.autoSync) {
      await this._schemaBuilder.synchronize(false);
    }
    if (
      (this.options.migrationsRun || this.options.autoMigrate) &&
      this.options.migrations?.length
    ) {
      await this.runMigrations();
    }

    if (this.options.detectNPlusOne) {
      const detectorOpts =
        this.options.detectNPlusOne === true
          ? { dataSourceName: this.name }
          : { ...this.options.detectNPlusOne, dataSourceName: this.name };
      this._nPlusOneDetector = createNPlusOneDetector(detectorOpts);
    }

    return this;
  }

  /**
   * Ensures dynamically-added feature entities are present in the compiled metadata graph
   * (and synchronized when `synchronize` / `autoSync` is enabled). No-op when already registered.
   */
  async ensureEntities(targets: readonly EntityTarget[]): Promise<void> {
    if (!this._isInitialized || !this._graph || !this._driver || !this._runtime) {
      for (const t of targets) {
        if (!this._registeredEntities.includes(t)) {
          this._registeredEntities.push(t);
        }
      }
      return;
    }

    const missing: EntityTarget[] = [];
    for (const target of targets) {
      if (!this._graph.find(target)) {
        missing.push(target);
        if (!this._registeredEntities.includes(target)) {
          this._registeredEntities.push(target);
        }
      }
    }
    if (missing.length === 0) {
      return;
    }

    const nextGraph = compileMetadataGraph({
      entities: this._registeredEntities,
      autoLoadEntities: this.options.autoLoadEntities,
      entityPrefix: this.options.entityPrefix,
    });
    this._graph = nextGraph;
    this._runtime.graph = nextGraph;
    this._schemaBuilder = new SchemaBuilder(
      this._driver,
      nextGraph,
      this.options.enforceForeignKeys ?? true,
    );

    if (this.options.synchronize || this.options.autoSync) {
      await this._schemaBuilder.synchronize(false);
    }
  }

  async destroy(): Promise<void> {
    if (!this._isInitialized) return;
    this._nPlusOneDetector?.stop();
    this._nPlusOneDetector = undefined;
    this._manager?.clearRepositoryCache();
    this._declarativeRepoCache.clear();
    await this._driver?.close();
    this._driver = undefined;
    this._graph = undefined;
    this._runtime = undefined;
    this._manager = undefined;
    this._schemaBuilder = undefined;
    this._migrationRunner = undefined;
    this._isInitialized = false;
  }

  async ping(): Promise<boolean> {
    if (!this._driver) return false;
    if (this._driver.ping) {
      return await this._driver.ping();
    }
    return this._driver.isConnected;
  }

  getSchemaPlan(): GeneratedSchemaPlan {
    if (!this._schemaBuilder) {
      throw new DataSourceNotInitializedError(this.name);
    }
    return this._schemaBuilder.getPlan();
  }

  async synchronize(dropBeforeSync = false): Promise<void> {
    if (!this._schemaBuilder) {
      throw new DataSourceNotInitializedError(this.name);
    }
    await this._schemaBuilder.synchronize(dropBeforeSync);
  }

  async dropDatabase(): Promise<void> {
    if (!this._schemaBuilder) {
      throw new DataSourceNotInitializedError(this.name);
    }
    await this._schemaBuilder.dropSchema();
  }

  async runMigrations(): Promise<string[]> {
    if (!this._isInitialized) {
      throw new DataSourceNotInitializedError(this.name);
    }
    const applied = await this.migrationRunner.up();
    return applied.map((record) => record.id);
  }

  async revertLastMigration(): Promise<OrmMigrationRecord[]> {
    if (!this._isInitialized) {
      throw new DataSourceNotInitializedError(this.name);
    }
    return this.migrationRunner.down();
  }

  getMetadata<Entity extends object = Record<string, unknown>>(
    target: EntityTarget<Entity>,
  ): CompiledEntityMetadata {
    return this.metadataGraph.get(target);
  }

  getRepository<Entity extends object = Record<string, unknown>>(
    target: EntityTarget<Entity>,
  ): OrmRepository<Entity> {
    return this.manager.getRepository<Entity>(target);
  }

  getMongoRepository<Entity extends object = Record<string, unknown>>(
    target: EntityTarget<Entity>,
  ): MongoRepository<Entity> {
    return this.manager.getMongoRepository<Entity>(target);
  }

  /**
   * Instantiates (and caches) a compiled `@Repository(...)` declarative repository
   * bound to this `DataSource`.
   */
  getDeclarativeRepository<TRepo extends object>(
    RepoClass: Abstract<TRepo>,
  ): TRepo {
    if (!this._isInitialized) {
      throw new DataSourceNotInitializedError(this.name);
    }
    let instance = this._declarativeRepoCache.get(RepoClass);
    if (!instance) {
      const compiled = compileOrmRepository(RepoClass);
      instance = compiled.createInstance(this);
      this._declarativeRepoCache.set(RepoClass, instance);
    }
    return instance as TRepo;
  }

  createQueryBuilder<Entity extends object = Record<string, unknown>>(
    target: EntityTarget<Entity>,
    alias?: string,
  ): SelectQueryBuilder<Entity> {
    return this.manager.createQueryBuilder<Entity>(target, alias);
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    parameters: readonly unknown[] = [],
  ): Promise<T[]> {
    return this.manager.query<T>(sql, parameters);
  }

  async transaction<T>(
    runInTransaction: (entityManager: EntityManager) => Promise<T> | T,
    options?: OrmTransactionOptions,
  ): Promise<T> {
    return this.manager.transaction(runInTransaction, options);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.destroy();
  }
}
