import type { InjectionToken, Provider } from "@bunest/common";
import { getConnectionToken, getModelToken } from "./common/sequelize.utils";
import type {
  SequelizeLike,
  SequelizeOptions,
} from "./runtime/sequelize-runtime";

export function createSequelizeProviders(
  entities?: Function[],
  connection?: SequelizeOptions | string,
): Provider[] {
  const repositories: Provider[] = (entities || []).map((entity) => ({
    provide: getModelToken(entity, connection),
    useFactory: (conn: SequelizeLike) => {
      if (!conn.repositoryMode) {
        return entity;
      }
      return conn.getRepository(entity);
    },
    inject: [getConnectionToken(connection) as InjectionToken],
  }));
  return [...repositories];
}
