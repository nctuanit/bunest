import { Inject, type InjectionToken } from "@bunest/common";
import type { DataSourceRef } from "../interfaces/data-source-ref.type";
import type { EntityClassOrSchema } from "../interfaces/entity-class-or-schema.type";
import { TYPEORM_CUSTOM_REPOSITORY_ENTITY } from "../typeorm.constants";
import {
  getDataSourceToken,
  getEntityManagerToken,
  getRepositoryToken,
} from "./typeorm.utils";

/**
 * @publicApi
 */
export const InjectRepository = (
  entity: EntityClassOrSchema,
  dataSource?: DataSourceRef,
): ReturnType<typeof Inject> =>
  Inject(getRepositoryToken(entity, dataSource) as InjectionToken);

/**
 * @publicApi
 */
export const InjectDataSource = (
  dataSource?: DataSourceRef,
): ReturnType<typeof Inject> =>
  Inject(getDataSourceToken(dataSource) as InjectionToken);

/**
 * @deprecated Use `InjectDataSource` instead.
 * @publicApi
 */
export const InjectConnection: typeof InjectDataSource = InjectDataSource;

/**
 * @publicApi
 */
export const InjectEntityManager = (
  dataSource?: DataSourceRef,
): ReturnType<typeof Inject> =>
  Inject(getEntityManagerToken(dataSource) as InjectionToken);

/**
 * Associates a custom `Repository` subclass with its target entity.
 *
 * @publicApi
 */
export const CustomRepository = (
  entity: EntityClassOrSchema,
): ClassDecorator => {
  return (target) => {
    Reflect.defineMetadata(TYPEORM_CUSTOM_REPOSITORY_ENTITY, entity, target);
  };
};
