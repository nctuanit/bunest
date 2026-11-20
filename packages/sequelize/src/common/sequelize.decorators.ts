import { Inject, type InjectionToken } from "@bunest/common";
import type { SequelizeModuleOptions } from "../interfaces/sequelize-options.interface";
import { DEFAULT_CONNECTION_NAME } from "../sequelize.constants";
import { getConnectionToken, getModelToken } from "./sequelize.utils";

export const InjectModel = (
  entity: Function,
  connection: string = DEFAULT_CONNECTION_NAME,
): PropertyDecorator & ParameterDecorator =>
  Inject(getModelToken(entity, connection));

export const InjectConnection = (
  connection?: SequelizeModuleOptions | string,
): ParameterDecorator & PropertyDecorator =>
  Inject(getConnectionToken(connection) as InjectionToken);
