import type { ModuleMetadata, Type } from "@bunest/common";
import type {
  SequelizeLike,
  SequelizeOptions,
} from "../runtime/sequelize-runtime";

export type SequelizeModuleOptions = {
  /**
   * Connection name.
   * @default "default"
   */
  name?: string;
  /**
   * Number of times to retry connecting.
   * @default 9
   */
  retryAttempts?: number;
  /**
   * Delay between connection retry attempts (ms).
   * @default 3000
   */
  retryDelay?: number;
  /**
   * If `true`, models registered via `SequelizeModule.forFeature()` will be loaded automatically.
   */
  autoLoadModels?: boolean;
  /**
   * If `true`, `sequelize.sync()` will be called when `autoLoadModels` is enabled.
   * @default true
   */
  synchronize?: boolean;
  /**
   * Connection URI passed to `new Sequelize(uri, options)`.
   */
  uri?: string;
  /**
   * If `false`, the connection will not be closed automatically on application shutdown.
   * @default true
   */
  autoCloseConnection?: boolean;
  /**
   * Optional custom Sequelize factory (e.g. to supply a real `sequelize-typescript` instance).
   */
  sequelizeFactory?: (
    options: SequelizeModuleOptions,
  ) => Promise<SequelizeLike> | SequelizeLike;
} & Partial<SequelizeOptions>;

export interface SequelizeOptionsFactory {
  createSequelizeOptions(
    connectionName?: string,
  ): Promise<SequelizeModuleOptions> | SequelizeModuleOptions;
}

export interface SequelizeModuleAsyncOptions
  extends Pick<ModuleMetadata, "imports"> {
  name?: string;
  useExisting?: Type<SequelizeOptionsFactory>;
  useClass?: Type<SequelizeOptionsFactory>;
  useFactory?: (
    ...args: any[]
  ) => Promise<SequelizeModuleOptions> | SequelizeModuleOptions;
  inject?: any[];
}
