import type { ModuleMetadata, Provider, Type } from "@bunest/common";
import type {
  DataSourceLike,
  DataSourceOptionsLike,
} from "../runtime/typeorm-runtime";

/**
 * @publicApi
 */
export type TypeOrmModuleOptions = {
  /**
   * NestJS-level datasource identifier.
   * In TypeORM 0.3.x this also existed on DataSourceOptions; in 1.0 it was removed.
   */
  name?: string;
  /**
   * Maximum number of connection attempts, including the first one.
   * @default 10
   */
  retryAttempts?: number;
  /**
   * Delay between connection retry attempts (ms).
   * @default 3000
   */
  retryDelay?: number;
  /**
   * Function that determines whether the module should attempt to connect upon failure.
   */
  toRetry?: (err: any) => boolean;
  /**
   * If `true`, entities registered via `TypeOrmModule.forFeature()` will be loaded automatically.
   */
  autoLoadEntities?: boolean;
  /**
   * If `true`, will show verbose error messages on each connection retry.
   */
  verboseRetryLog?: boolean;
  /**
   * If `true`, database initialization will not be performed during module initialization.
   */
  manualInitialization?: boolean;
  /**
   * Optional custom DataSource factory (e.g. to supply a real `typeorm` `DataSource`).
   */
  dataSourceFactory?: TypeOrmDataSourceFactory;
  /**
   * Optional strict mode to throw `DuplicateDataSourceException` when registering a duplicate name.
   */
  strictDuplicateCheck?: boolean;
} & Partial<DataSourceOptionsLike>;

/**
 * @publicApi
 */
export interface TypeOrmOptionsFactory {
  createTypeOrmOptions(
    connectionName?: string,
  ): Promise<TypeOrmModuleOptions> | TypeOrmModuleOptions;
}

/**
 * @publicApi
 */
export type TypeOrmDataSourceFactory = (
  options?: DataSourceOptionsLike,
) => Promise<DataSourceLike> | DataSourceLike;

/**
 * @publicApi
 */
export interface TypeOrmModuleAsyncOptions
  extends Pick<ModuleMetadata, "imports"> {
  name?: string;
  useExisting?: Type<TypeOrmOptionsFactory>;
  useClass?: Type<TypeOrmOptionsFactory>;
  useFactory?: (
    ...args: any[]
  ) => Promise<TypeOrmModuleOptions> | TypeOrmModuleOptions;
  dataSourceFactory?: TypeOrmDataSourceFactory;
  inject?: any[];
  extraProviders?: Provider[];
}
