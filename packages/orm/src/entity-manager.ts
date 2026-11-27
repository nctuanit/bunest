import {
  emitOrmTransactionDiagnostic,
  hasOrmTransactionSubscribers,
} from "./diagnostics";
import type { CompiledMetadataGraph } from "./metadata-graph";
import { MongoRepository } from "./mongo-repository";
import type { SelectQueryBuilder } from "./query-builder";
import { OrmRepository, type OrmRepositoryRuntime } from "./repository";
import {
  assertTransactionPropagation,
  completeTransactionHookCommit,
  completeTransactionHookRollback,
  createTransactionHookCollector,
  executeWithTransactionRetries,
  exitTransactionHookScope,
  isRetryableTransactionError,
  runInTransactionHookScope,
  validateIsolationLevel,
  validateTransactionPropagation,
} from "./transaction-hooks";
import type {
  DeepPartial,
  EntityTarget,
  FindManyOptions,
  FindOneOptions,
  FindOptionsWhere,
  OrmTransactionOptions,
  RemoveOptions,
  SaveOptions,
} from "./types";

/**
 * TypeORM-compatible `EntityManager` providing unified repository lookup,
 * cross-entity operations, raw SQL queries, and `AsyncLocalStorage`-propagated transactions.
 */
export class EntityManager {
  private readonly repositories = new Map<Function, OrmRepository<object>>();
  private readonly mongoRepositories = new Map<Function, MongoRepository<object>>();

  constructor(private readonly runtime: OrmRepositoryRuntime) {}

  get graph(): CompiledMetadataGraph {
    return this.runtime.graph;
  }

  getRepository<Entity extends object = Record<string, unknown>>(
    target: EntityTarget<Entity>,
  ): OrmRepository<Entity> {
    const meta = this.runtime.graph.get(target);
    let repo = this.repositories.get(meta.target);
    if (!repo) {
      repo = new OrmRepository(meta, this.runtime);
      this.repositories.set(meta.target, repo);
    }
    return repo as unknown as OrmRepository<Entity>;
  }

  getMongoRepository<Entity extends object = Record<string, unknown>>(
    target: EntityTarget<Entity>,
  ): MongoRepository<Entity> {
    const meta = this.runtime.graph.get(target);
    let repo = this.mongoRepositories.get(meta.target);
    if (!repo) {
      repo = new MongoRepository(meta, this.runtime);
      this.mongoRepositories.set(meta.target, repo);
    }
    return repo as unknown as MongoRepository<Entity>;
  }

  create<Entity extends object>(
    target: EntityTarget<Entity>,
    entityLike?: DeepPartial<Entity>,
  ): Entity {
    return entityLike !== undefined
      ? this.getRepository(target).create(entityLike)
      : this.getRepository(target).create();
  }

  async save<Entity extends object>(
    entity: Entity,
    options?: SaveOptions,
  ): Promise<Entity>;
  async save<Entity extends object>(
    target: EntityTarget<Entity>,
    entity: DeepPartial<Entity>,
    options?: SaveOptions,
  ): Promise<Entity>;
  async save<Entity extends object>(
    target: EntityTarget<Entity>,
    entities: ReadonlyArray<DeepPartial<Entity>>,
    options?: SaveOptions,
  ): Promise<Entity[]>;
  async save<Entity extends object>(
    targetOrEntity: EntityTarget<Entity> | Entity,
    entityOrOptions?:
      | DeepPartial<Entity>
      | ReadonlyArray<DeepPartial<Entity>>
      | SaveOptions,
    maybeOptions?: SaveOptions,
  ): Promise<Entity | Entity[]> {
    // Check if first arg is an EntityTarget (function, string, or EntityRef)
    const meta =
      typeof targetOrEntity === "function" ||
      typeof targetOrEntity === "string" ||
      (typeof targetOrEntity === "object" &&
        targetOrEntity !== null &&
        "__ormEntityRef" in targetOrEntity)
        ? this.runtime.graph.find(targetOrEntity as EntityTarget<Entity>)
        : undefined;

    if (meta) {
      const repo = this.getRepository<Entity>(meta.target);
      if (Array.isArray(entityOrOptions)) {
        return repo.save(entityOrOptions, maybeOptions);
      }
      return repo.save(entityOrOptions as DeepPartial<Entity>, maybeOptions);
    }

    // First arg is an entity instance
    const instance = targetOrEntity as Entity;
    const ctor = (instance as { constructor?: Function }).constructor;
    if (!ctor) {
      throw new Error("EntityManager.save() requires an entity class or instance.");
    }
    return this.getRepository<Entity>(ctor as EntityTarget<Entity>).save(
      instance as DeepPartial<Entity>,
      entityOrOptions as SaveOptions | undefined,
    );
  }

  async remove<Entity extends object>(
    entity: Entity,
    options?: RemoveOptions,
  ): Promise<Entity>;
  async remove<Entity extends object>(
    target: EntityTarget<Entity>,
    entity: Entity,
    options?: RemoveOptions,
  ): Promise<Entity>;
  async remove<Entity extends object>(
    targetOrEntity: EntityTarget<Entity> | Entity,
    entityOrOptions?: Entity | RemoveOptions,
    maybeOptions?: RemoveOptions,
  ): Promise<Entity> {
    const meta =
      typeof targetOrEntity === "function" ||
      typeof targetOrEntity === "string" ||
      (typeof targetOrEntity === "object" &&
        targetOrEntity !== null &&
        "__ormEntityRef" in targetOrEntity)
        ? this.runtime.graph.find(targetOrEntity as EntityTarget<Entity>)
        : undefined;

    if (meta) {
      return this.getRepository<Entity>(meta.target).remove(
        entityOrOptions as Entity,
        maybeOptions,
      );
    }
    const instance = targetOrEntity as Entity;
    const ctor = (instance as { constructor?: Function }).constructor;
    if (!ctor) {
      throw new Error("EntityManager.remove() requires an entity class or instance.");
    }
    return this.getRepository<Entity>(ctor as EntityTarget<Entity>).remove(
      instance,
      entityOrOptions as RemoveOptions | undefined,
    );
  }

  async find<Entity extends object>(
    target: EntityTarget<Entity>,
    options?: FindManyOptions<Entity>,
  ): Promise<Entity[]> {
    return this.getRepository(target).find(options);
  }

  async findBy<Entity extends object>(
    target: EntityTarget<Entity>,
    where: FindOptionsWhere<Entity> | ReadonlyArray<FindOptionsWhere<Entity>>,
  ): Promise<Entity[]> {
    return this.getRepository(target).findBy(where);
  }

  async findOne<Entity extends object>(
    target: EntityTarget<Entity>,
    options: FindOneOptions<Entity>,
  ): Promise<Entity | null> {
    return this.getRepository(target).findOne(options);
  }

  async findOneBy<Entity extends object>(
    target: EntityTarget<Entity>,
    where: FindOptionsWhere<Entity> | ReadonlyArray<FindOptionsWhere<Entity>>,
  ): Promise<Entity | null> {
    return this.getRepository(target).findOneBy(where);
  }

  async count<Entity extends object>(
    target: EntityTarget<Entity>,
    options?: FindManyOptions<Entity>,
  ): Promise<number> {
    return this.getRepository(target).count(options);
  }

  async clear<Entity extends object>(
    target: EntityTarget<Entity>,
  ): Promise<void> {
    return this.getRepository(target).clear();
  }

  createQueryBuilder<Entity extends object>(
    target: EntityTarget<Entity>,
    alias?: string,
  ): SelectQueryBuilder<Entity> {
    return this.getRepository(target).createQueryBuilder(alias);
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    parameters: readonly unknown[] = [],
  ): Promise<T[]> {
    const res = await this.runtime.driver.query<T>(sql, parameters);
    return res.rows;
  }

  /**
   * Executes `runInTransaction` inside a database transaction (or nested `SAVEPOINT`
   * when already inside an active transaction) propagated automatically via `AsyncLocalStorage`,
   * supporting `isolationLevel`, `propagation`, `readOnly`, `retries`, lifecycle hooks,
   * and diagnostics channel telemetry.
   */
  async transaction<T>(
    runInTransaction: (entityManager: EntityManager) => Promise<T> | T,
    options: OrmTransactionOptions = {},
  ): Promise<T> {
    const dataSource =
      options.dataSource ??
      this.runtime.dataSourceName ??
      this.runtime.driver.dataSourceName;
    const effectiveOptions: OrmTransactionOptions = {
      ...options,
      ...(dataSource !== undefined ? { dataSource } : {}),
    };

    if (this.runtime.driver.supportsManagedTransactions) {
      return await this.runtime.driver.transaction(
        () => runInTransaction(this),
        effectiveOptions,
      );
    }

    // Fallback orchestration for custom/mock OrmDriverLike implementations
    const propagation = validateTransactionPropagation(
      effectiveOptions.propagation ?? "REQUIRED",
    );
    const isolationLevel =
      effectiveOptions.isolationLevel !== undefined
        ? validateIsolationLevel(effectiveOptions.isolationLevel)
        : undefined;
    const inTx = this.runtime.driver.isInTransaction();

    assertTransactionPropagation(propagation, inTx);

    if (propagation === "NEVER") {
      return await exitTransactionHookScope(() => runInTransaction(this));
    }

    const isNested =
      inTx && (propagation === "REQUIRED" || propagation === "MANDATORY");

    const runAttempt = async (isFinalAttempt: boolean): Promise<T> => {
      const collector = createTransactionHookCollector(isNested);
      const trackTx = hasOrmTransactionSubscribers();
      const start = trackTx ? performance.now() : 0;

      if (trackTx) {
        emitOrmTransactionDiagnostic({
          phase: "begin",
          ...(isolationLevel !== undefined ? { isolationLevel } : {}),
          propagation,
          ...(dataSource !== undefined ? { dataSource } : {}),
        });
      }

      let result!: T;
      try {
        result = await this.runtime.driver.transaction(
          () => runInTransactionHookScope(collector, () => runInTransaction(this)),
          effectiveOptions,
        );
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (trackTx) {
          emitOrmTransactionDiagnostic({
            phase: "rollback",
            ...(isolationLevel !== undefined ? { isolationLevel } : {}),
            propagation,
            durationMs: performance.now() - start,
            error,
            ...(dataSource !== undefined ? { dataSource } : {}),
          });
        }
        const willRetry =
          !isNested && !isFinalAttempt && isRetryableTransactionError(err);
        if (!willRetry) {
          await completeTransactionHookRollback(collector);
        }
        throw err;
      }

      if (trackTx) {
        emitOrmTransactionDiagnostic({
          phase: "commit",
          ...(isolationLevel !== undefined ? { isolationLevel } : {}),
          propagation,
          durationMs: performance.now() - start,
          ...(dataSource !== undefined ? { dataSource } : {}),
        });
      }
      await completeTransactionHookCommit(collector);
      return result;
    };

    if (!isNested && effectiveOptions.retries && effectiveOptions.retries > 0) {
      return await executeWithTransactionRetries(
        effectiveOptions.retries,
        effectiveOptions.retryDelayMs,
        (_attempt, isFinal) => runAttempt(isFinal),
      );
    }

    return await runAttempt(true);
  }

  clearRepositoryCache(): void {
    this.repositories.clear();
    this.mongoRepositories.clear();
  }
}
