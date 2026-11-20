import { randomUUID } from "node:crypto";
import { Logger, type Type } from "@bunest/common";
import type {
  Subscribable,
  SubscribableObserver,
  Unsubscribable,
} from "@bunest/core";
import { CircularDependencyException } from "../exceptions/circular-dependency.exception";
import type { DataSourceRef } from "../interfaces/data-source-ref.type";
import type { EntityClassOrSchema } from "../interfaces/entity-class-or-schema.type";
import {
  DataSource,
  EntityManager,
  EntitySchema,
  Repository,
  type EntitySchemaLike,
} from "../runtime/typeorm-runtime";
import {
  DEFAULT_DATA_SOURCE_NAME,
  TYPEORM_CUSTOM_REPOSITORY_ENTITY,
} from "../typeorm.constants";

const logger = new Logger("TypeOrmModule");

function isEntitySchemaLike(entity: unknown): entity is EntitySchemaLike {
  return (
    entity instanceof EntitySchema ||
    (typeof entity === "object" &&
      entity !== null &&
      "options" in entity &&
      typeof (entity as EntitySchemaLike).options === "object" &&
      (entity as EntitySchemaLike).options !== null)
  );
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isSubscribable<T>(value: unknown): value is Subscribable<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Subscribable<T>).subscribe === "function"
  );
}

/**
 * Returns the DataSource name for the given DataSource, DataSourceOptions,
 * or dataSource name. Defaults to `"default"` when no name is set.
 *
 * @publicApi
 */
export function getDataSourceName(
  dataSource: DataSourceRef | { name?: string } = DEFAULT_DATA_SOURCE_NAME,
): string {
  if (typeof dataSource === "string") {
    return dataSource || DEFAULT_DATA_SOURCE_NAME;
  }
  return dataSource?.name || DEFAULT_DATA_SOURCE_NAME;
}

/**
 * Returns the target entity associated with a custom repository class
 * (via `@CustomRepository(Entity)` metadata or static `entity` property).
 *
 * @publicApi
 */
export function getCustomRepositoryEntity(
  repository: Function,
): EntityClassOrSchema | undefined {
  if (!repository) {
    return undefined;
  }
  const fromMetadata = Reflect.getMetadata?.(
    TYPEORM_CUSTOM_REPOSITORY_ENTITY,
    repository,
  ) as EntityClassOrSchema | undefined;
  if (fromMetadata) {
    return fromMetadata;
  }
  const staticEntity = (repository as { entity?: EntityClassOrSchema }).entity;
  return staticEntity;
}

/**
 * Generates an injection token for a custom repository class.
 *
 * @publicApi
 */
export function getCustomRepositoryToken(repository: Function): string {
  if (repository === null || repository === undefined) {
    throw new CircularDependencyException("@InjectRepository()");
  }
  return repository.name;
}

/**
 * Generates an injection token for an Entity, EntitySchema, or custom Repository.
 *
 * @publicApi
 */
export function getRepositoryToken(
  entity: EntityClassOrSchema,
  dataSource: DataSourceRef = DEFAULT_DATA_SOURCE_NAME,
): Function | string {
  if (entity === null || entity === undefined) {
    throw new CircularDependencyException("@InjectRepository()");
  }

  const dataSourcePrefix = getDataSourcePrefix(dataSource);

  if (
    entity instanceof Function &&
    (entity.prototype instanceof Repository ||
      getCustomRepositoryEntity(entity) !== undefined)
  ) {
    if (!dataSourcePrefix) {
      return entity;
    }
    return `${dataSourcePrefix}${getCustomRepositoryToken(entity)}`;
  }

  if (isEntitySchemaLike(entity)) {
    const schemaName = entity.options.target
      ? entity.options.target.name
      : entity.options.name;
    if (!schemaName) {
      throw new Error(
        'EntitySchema must have either "target" or "name" defined',
      );
    }
    return `${dataSourcePrefix}${schemaName}Repository`;
  }

  return `${dataSourcePrefix}${entity.name}Repository`;
}

/**
 * Returns a DataSource injection token for the given DataSource,
 * DataSourceOptions, or dataSource name.
 *
 * @publicApi
 */
export function getDataSourceToken(
  dataSource: DataSourceRef = DEFAULT_DATA_SOURCE_NAME,
): string | Function | Type<DataSource> {
  const name = getDataSourceName(dataSource);
  return name === DEFAULT_DATA_SOURCE_NAME ? DataSource : `${name}DataSource`;
}

/**
 * @deprecated Use `getDataSourceToken` instead.
 * @publicApi
 */
export const getConnectionToken: typeof getDataSourceToken = getDataSourceToken;

/**
 * Returns a DataSource prefix based on the dataSource name (`""` for default,
 * `"${name}_"` for named data sources).
 *
 * @publicApi
 */
export function getDataSourcePrefix(
  dataSource: DataSourceRef = DEFAULT_DATA_SOURCE_NAME,
): string {
  const name = getDataSourceName(dataSource);
  return name === DEFAULT_DATA_SOURCE_NAME ? "" : `${name}_`;
}

/**
 * Returns an EntityManager injection token for the given DataSource,
 * DataSourceOptions, or dataSource name.
 *
 * @publicApi
 */
export function getEntityManagerToken(
  dataSource: DataSourceRef = DEFAULT_DATA_SOURCE_NAME,
): string | Function {
  const name = getDataSourceName(dataSource);
  return name === DEFAULT_DATA_SOURCE_NAME
    ? EntityManager
    : `${name}EntityManager`;
}

export interface RetryHandler {
  <T>(factory: () => Promise<T> | T): Promise<T>;
  <T>(source: Subscribable<T>): Subscribable<T>;
}

/**
 * Zero-RxJS retry/backoff handler (ADR-008) supporting both Promise factories
 * (`await handleRetry(attempts, delay)(() => connect())`) and `Subscribable<T>`.
 *
 * @publicApi
 */
export function handleRetry(
  retryAttempts = 10,
  retryDelay = 3000,
  dataSourceName = DEFAULT_DATA_SOURCE_NAME,
  verboseRetryLog = false,
  toRetry?: (err: any) => boolean,
): RetryHandler {
  const logRetry = (errorCount: number, error: unknown): void => {
    const errObj = error instanceof Error ? error : new Error(String(error));
    const dataSourceInfo =
      dataSourceName === DEFAULT_DATA_SOURCE_NAME
        ? ""
        : ` (${dataSourceName})`;
    const verboseMessage = verboseRetryLog
      ? ` Message: ${errObj.message}.`
      : "";
    logger.error(
      `Unable to connect to the database${dataSourceInfo}.${verboseMessage} Retrying (${errorCount + 1})...`,
      errObj.stack,
    );
  };

  function runRetry<T>(factory: () => Promise<T> | T): Promise<T>;
  function runRetry<T>(source: Subscribable<T>): Subscribable<T>;
  function runRetry<T>(
    sourceOrFactory: (() => Promise<T> | T) | Subscribable<T>,
  ): Promise<T> | Subscribable<T> {
    if (isSubscribable<T>(sourceOrFactory)) {
      const source = sourceOrFactory;
      return {
        subscribe(
          observerOrNext?:
            | Partial<SubscribableObserver<T>>
            | ((value: T) => void),
          errorCb?: (err: unknown) => void,
          completeCb?: () => void,
        ): Unsubscribable {
          const observer: Partial<SubscribableObserver<T>> =
            typeof observerOrNext === "function"
              ? { next: observerOrNext, error: errorCb, complete: completeCb }
              : (observerOrNext ?? {});
          let errorCount = 0;
          let unsubscribed = false;
          let activeSub: Unsubscribable | undefined;
          let timer: ReturnType<typeof setTimeout> | undefined;

          const attempt = () => {
            if (unsubscribed) return;
            activeSub = source.subscribe({
              next: (val) => observer.next?.(val),
              complete: () => observer.complete?.(),
              error: (error) => {
                if (unsubscribed) return;
                if (toRetry && !toRetry(error)) {
                  observer.error?.(error);
                  return;
                }
                logRetry(errorCount, error);
                errorCount++;
                if (errorCount >= retryAttempts) {
                  observer.error?.(error);
                  return;
                }
                timer = setTimeout(attempt, retryDelay);
              },
            });
          };
          attempt();

          return {
            unsubscribe() {
              unsubscribed = true;
              if (timer !== undefined) clearTimeout(timer);
              activeSub?.unsubscribe();
            },
          };
        },
      };
    }

    const factory = sourceOrFactory;
    return (async () => {
      let errorCount = 0;
      while (true) {
        try {
          return await factory();
        } catch (error) {
          if (toRetry && !toRetry(error)) {
            throw error;
          }
          logRetry(errorCount, error);
          errorCount++;
          if (errorCount >= retryAttempts) {
            throw error;
          }
          await sleep(retryDelay);
        }
      }
    })();
  }

  return runRetry;
}

/**
 * Generates a unique UUID string identifier.
 *
 * @publicApi
 */
export const generateString = (): string => randomUUID();
