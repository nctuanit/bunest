import {
  Global,
  Inject,
  Logger,
  Module,
  type DynamicModule,
  type InjectionToken,
  type OnApplicationShutdown,
  type Provider,
  type Type,
} from "@bunest/common";
import { ModuleRef } from "@bunest/core";
import {
  generateString,
  getDataSourceName,
  getDataSourceToken,
  getEntityManagerToken,
  handleRetry,
} from "./common/typeorm.utils";
import { DataSourceNameRegistry } from "./data-source-name.registry";
import { EntitiesMetadataStorage } from "./entities-metadata.storage";
import type {
  TypeOrmDataSourceFactory,
  TypeOrmModuleAsyncOptions,
  TypeOrmModuleOptions,
  TypeOrmOptionsFactory,
} from "./interfaces/typeorm-options.interface";
import { DataSource, type DataSourceLike } from "./runtime/typeorm-runtime";
import {
  TYPEORM_DATA_SOURCE_NAME,
  TYPEORM_MODULE_ID,
  TYPEORM_MODULE_OPTIONS,
} from "./typeorm.constants";

@Global()
@Module({})
export class TypeOrmCoreModule implements OnApplicationShutdown {
  private readonly logger = new Logger("TypeOrmModule");

  constructor(
    @Inject(TYPEORM_DATA_SOURCE_NAME)
    private readonly dataSourceName: string,
    private readonly moduleRef: ModuleRef,
  ) {}

  static forRoot(options: TypeOrmModuleOptions = {}): DynamicModule {
    const dataSourceName = getDataSourceName(options);
    DataSourceNameRegistry.register(
      dataSourceName,
      options.strictDuplicateCheck,
    );

    const typeOrmModuleOptions: Provider = {
      provide: TYPEORM_MODULE_OPTIONS,
      useValue: options,
    };

    const dataSourceProvider: Provider = {
      provide: getDataSourceToken(dataSourceName) as InjectionToken,
      useFactory: async () =>
        await this.createDataSourceFactory(options, options.dataSourceFactory),
    };

    const entityManagerProvider = this.createEntityManagerProvider(options);

    const providers: Provider[] = [
      entityManagerProvider,
      dataSourceProvider,
      typeOrmModuleOptions,
      {
        provide: TYPEORM_MODULE_ID,
        useValue: generateString(),
      },
      {
        provide: TYPEORM_DATA_SOURCE_NAME,
        useValue: dataSourceName,
      },
    ];

    return {
      module: TypeOrmCoreModule,
      providers,
      exports: [entityManagerProvider, dataSourceProvider],
    };
  }

  static forRootAsync(options: TypeOrmModuleAsyncOptions): DynamicModule {
    const dataSourceName = getDataSourceName(options);
    DataSourceNameRegistry.register(dataSourceName);

    const dataSourceProvider: Provider = {
      provide: getDataSourceToken(dataSourceName) as InjectionToken,
      useFactory: async (typeOrmOptions: TypeOrmModuleOptions) => {
        const mergedOptions: TypeOrmModuleOptions = options.name
          ? { ...typeOrmOptions, name: options.name }
          : typeOrmOptions;
        return await this.createDataSourceFactory(
          mergedOptions,
          options.dataSourceFactory ?? mergedOptions.dataSourceFactory,
        );
      },
      inject: [TYPEORM_MODULE_OPTIONS],
    };

    const entityManagerProvider: Provider = {
      provide: getEntityManagerToken(dataSourceName) as InjectionToken,
      useFactory: (dataSource: DataSourceLike) => dataSource.manager,
      inject: [getDataSourceToken(dataSourceName) as InjectionToken],
    };

    const asyncProviders = this.createAsyncProviders(options);

    const providers: Provider[] = [
      ...asyncProviders,
      entityManagerProvider,
      dataSourceProvider,
      {
        provide: TYPEORM_MODULE_ID,
        useValue: generateString(),
      },
      {
        provide: TYPEORM_DATA_SOURCE_NAME,
        useValue: dataSourceName,
      },
      ...(options.extraProviders || []),
    ];

    return {
      module: TypeOrmCoreModule,
      imports: options.imports ?? [],
      providers,
      exports: [entityManagerProvider, dataSourceProvider],
    };
  }

  async onApplicationShutdown(): Promise<void> {
    try {
      const dataSource = this.moduleRef.get<DataSourceLike>(
        getDataSourceToken(this.dataSourceName) as InjectionToken,
      );
      if (dataSource && dataSource.isInitialized) {
        await dataSource.destroy();
      }
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      this.logger.error(
        `Failed to close the "${this.dataSourceName}" data source: ${e.message}`,
        e.stack,
      );
    } finally {
      DataSourceNameRegistry.unregister(this.dataSourceName);
    }
  }

  private static createAsyncProviders(
    options: TypeOrmModuleAsyncOptions,
  ): Provider[] {
    if (options.useExisting || options.useFactory) {
      return [this.createAsyncOptionsProvider(options)];
    }
    const useClass = options.useClass as Type<TypeOrmOptionsFactory>;
    if (!useClass) {
      throw new Error(
        'TypeOrmModule.forRootAsync() requires one of "useFactory", "useClass", or "useExisting".',
      );
    }
    return [
      this.createAsyncOptionsProvider(options),
      {
        provide: useClass,
        useClass,
      },
    ];
  }

  private static createAsyncOptionsProvider(
    options: TypeOrmModuleAsyncOptions,
  ): Provider {
    if (options.useFactory) {
      return {
        provide: TYPEORM_MODULE_OPTIONS,
        useFactory: options.useFactory,
        inject: options.inject || [],
      };
    }

    const inject = [
      (options.useClass || options.useExisting) as Type<TypeOrmOptionsFactory>,
    ];
    return {
      provide: TYPEORM_MODULE_OPTIONS,
      useFactory: async (optionsFactory: TypeOrmOptionsFactory) =>
        await optionsFactory.createTypeOrmOptions(options.name),
      inject,
    };
  }

  private static createEntityManagerProvider(
    options: TypeOrmModuleOptions,
  ): Provider {
    return {
      provide: getEntityManagerToken(options) as InjectionToken,
      useFactory: (dataSource: DataSourceLike) => dataSource.manager,
      inject: [getDataSourceToken(options) as InjectionToken],
    };
  }

  private static async createDataSourceFactory(
    options: TypeOrmModuleOptions,
    dataSourceFactory?: TypeOrmDataSourceFactory,
  ): Promise<DataSourceLike> {
    const dataSourceToken = getDataSourceName(options);
    const createTypeormDataSource: TypeOrmDataSourceFactory =
      dataSourceFactory ?? ((opts) => new DataSource(opts));

    return await handleRetry(
      options.retryAttempts,
      options.retryDelay,
      dataSourceToken,
      options.verboseRetryLog,
      options.toRetry,
    )(async () => {
      let dataSource: DataSourceLike;
      if (!options.autoLoadEntities) {
        dataSource = await createTypeormDataSource(options);
      } else {
        const explicitEntities = Array.isArray(options.entities)
          ? options.entities
          : Object.values(options.entities ?? {});
        const storedEntities =
          EntitiesMetadataStorage.getEntitiesByDataSource(dataSourceToken);
        const entities = [...explicitEntities];
        for (const entity of storedEntities) {
          if (!entities.includes(entity)) {
            entities.push(entity);
          }
        }
        dataSource = await createTypeormDataSource({
          ...options,
          entities,
        });
      }

      return !dataSource.isInitialized && !options.manualInitialization
        ? await dataSource.initialize()
        : dataSource;
    });
  }
}
