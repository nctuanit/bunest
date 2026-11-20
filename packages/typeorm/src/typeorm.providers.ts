import type { InjectionToken, Provider } from "@bunest/common";
import {
  getCustomRepositoryEntity,
  getDataSourceToken,
  getRepositoryToken,
} from "./common/typeorm.utils";
import type { DataSourceRef } from "./interfaces/data-source-ref.type";
import type { EntityClassOrSchema } from "./interfaces/entity-class-or-schema.type";
import {
  EntitySchema,
  Repository,
  type DataSourceLike,
  type EntitySchemaLike,
} from "./runtime/typeorm-runtime";

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

export function createTypeOrmProviders(
  entities?: EntityClassOrSchema[],
  dataSource?: DataSourceRef,
): Provider[] {
  return (entities || []).map((entity) => ({
    provide: getRepositoryToken(entity, dataSource) as InjectionToken,
    useFactory: (ds: DataSourceLike) => {
      if (
        entity instanceof Function &&
        (entity.prototype instanceof Repository ||
          getCustomRepositoryEntity(entity) !== undefined)
      ) {
        const targetEntity = getCustomRepositoryEntity(entity);
        if (entity.prototype instanceof Repository && targetEntity) {
          const CustomRepoCtor = entity as new (
            target: EntityClassOrSchema,
            manager: DataSourceLike["manager"],
          ) => unknown;
          return new CustomRepoCtor(targetEntity, ds.manager);
        }
        if (targetEntity) {
          return ds.getRepository(targetEntity);
        }
      }

      if (ds.options?.type === "mongodb") {
        return ds.getMongoRepository(entity);
      }

      const target = isEntitySchemaLike(entity)
        ? (entity.options.target ?? entity.options.name)
        : entity;
      const entityMetadata = Array.isArray(ds.entityMetadatas)
        ? ds.entityMetadatas.find((meta) => meta.target === target)
        : undefined;
      const isTreeEntity = typeof entityMetadata?.treeType !== "undefined";

      return isTreeEntity
        ? ds.getTreeRepository(entity)
        : ds.getRepository(entity);
    },
    inject: [getDataSourceToken(dataSource) as InjectionToken],
  }));
}
