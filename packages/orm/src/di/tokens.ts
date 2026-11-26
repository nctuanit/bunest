import { DataSource } from "../data-source";
import {
  ORM_MODIFYING_METADATA,
  ORM_PARAM_METADATA,
  ORM_QUERY_METADATA,
  ORM_REPOSITORY_METADATA,
  isDeclarativeOrmRepository,
} from "../declarative-repository";
import { EntityManager } from "../entity-manager";
import { isEntityRef } from "../entity-ref";
import { resolveEntityTargetClass } from "../metadata-graph";
import { OrmMigrationRunner } from "../migration-runner";
import type { EntityTarget } from "../types";

export const DEFAULT_ORM_DATA_SOURCE = "default";
export const ORM_MODULE_OPTIONS = Symbol.for("bunest:orm:module_options");
export const ORM_DATA_SOURCE_NAME = Symbol.for("bunest:orm:data_source_name");

export {
  ORM_MODIFYING_METADATA,
  ORM_PARAM_METADATA,
  ORM_QUERY_METADATA,
  ORM_REPOSITORY_METADATA,
};

export function getOrmDataSourceToken(
  dataSourceName: string = DEFAULT_ORM_DATA_SOURCE,
): typeof DataSource | string {
  return dataSourceName === DEFAULT_ORM_DATA_SOURCE
    ? DataSource
    : `bunest:orm:data_source:${dataSourceName}`;
}

export function getOrmEntityManagerToken(
  dataSourceName: string = DEFAULT_ORM_DATA_SOURCE,
): typeof EntityManager | string {
  return dataSourceName === DEFAULT_ORM_DATA_SOURCE
    ? EntityManager
    : `bunest:orm:entity_manager:${dataSourceName}`;
}

export function getOrmMigrationRunnerToken(
  dataSourceName: string = DEFAULT_ORM_DATA_SOURCE,
): typeof OrmMigrationRunner | string {
  return dataSourceName === DEFAULT_ORM_DATA_SOURCE
    ? OrmMigrationRunner
    : `bunest:orm:migration_runner:${dataSourceName}`;
}

export function getOrmTransactionalAspectToken(
  dataSourceName: string = DEFAULT_ORM_DATA_SOURCE,
): string {
  return `bunest:orm:transactional_aspect:${dataSourceName}`;
}

/**
 * Computes a deterministic injection token for an entity repository or declarative
 * `@Repository(...)` abstract class.
 *
 * Notice that `User`, `"User"`, and `entityRef<User>("User")` all normalize to the
 * exact same token (`bunest:orm:repo:<dsName>:User`), allowing services to inject
 * repositories via `EntityRef` or string name with ZERO circular imports!
 */
export function getOrmRepositoryToken(
  entity: EntityTarget,
  dataSourceName: string = DEFAULT_ORM_DATA_SOURCE,
): string {
  let entityKey: string;
  if (typeof entity === "string") {
    entityKey = entity;
  } else if (isEntityRef(entity)) {
    entityKey = entity.name;
  } else if (typeof entity === "function") {
    if (isDeclarativeOrmRepository(entity)) {
      entityKey = entity.name;
    } else {
      const resolved = resolveEntityTargetClass(entity);
      entityKey = resolved?.name || entity.name;
    }
  } else {
    throw new Error(
      `getOrmRepositoryToken() received invalid entity target: ${String(entity)}`,
    );
  }

  if (!entityKey) {
    throw new Error(
      "getOrmRepositoryToken() could not determine entity name. Provide a named class, string name, or entityRef().",
    );
  }

  return `bunest:orm:repo:${dataSourceName}:${entityKey}`;
}
