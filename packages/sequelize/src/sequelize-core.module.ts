import {
  Global,
  Inject,
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
  getConnectionToken,
  handleRetry,
} from "./common/sequelize.utils";
import { EntitiesMetadataStorage } from "./entities-metadata.storage";
import type {
  SequelizeModuleAsyncOptions,
  SequelizeModuleOptions,
  SequelizeOptionsFactory,
} from "./interfaces/sequelize-options.interface";
import { Sequelize, type SequelizeLike } from "./runtime/sequelize-runtime";
import {
  DEFAULT_CONNECTION_NAME,
  SEQUELIZE_CONNECTION_NAME,
  SEQUELIZE_MODULE_ID,
  SEQUELIZE_MODULE_OPTIONS,
} from "./sequelize.constants";

@Global()
@Module({})
export class SequelizeCoreModule implements OnApplicationShutdown {
  constructor(
    @Inject(SEQUELIZE_MODULE_OPTIONS)
    private readonly options: SequelizeModuleOptions,
    @Inject(SEQUELIZE_CONNECTION_NAME)
    private readonly connectionName: string,
    private readonly moduleRef: ModuleRef,
  ) {}

  static forRoot(options: SequelizeModuleOptions = {}): DynamicModule {
    const connectionName = options.name || DEFAULT_CONNECTION_NAME;

    const sequelizeModuleOptions: Provider = {
      provide: SEQUELIZE_MODULE_OPTIONS,
      useValue: options,
    };

    const connectionProvider: Provider = {
      provide: getConnectionToken(connectionName) as InjectionToken,
      useFactory: async () => await this.createConnectionFactory(options),
    };

    return {
      module: SequelizeCoreModule,
      providers: [
        connectionProvider,
        sequelizeModuleOptions,
        {
          provide: SEQUELIZE_MODULE_ID,
          useValue: generateString(),
        },
        {
          provide: SEQUELIZE_CONNECTION_NAME,
          useValue: connectionName,
        },
      ],
      exports: [connectionProvider],
    };
  }

  static forRootAsync(options: SequelizeModuleAsyncOptions): DynamicModule {
    const connectionName = options.name || DEFAULT_CONNECTION_NAME;

    const connectionProvider: Provider = {
      provide: getConnectionToken(connectionName) as InjectionToken,
      useFactory: async (sequelizeOptions: SequelizeModuleOptions) => {
        if (options.name) {
          return await this.createConnectionFactory({
            ...sequelizeOptions,
            name: options.name,
          });
        }
        return await this.createConnectionFactory(sequelizeOptions);
      },
      inject: [SEQUELIZE_MODULE_OPTIONS],
    };

    const asyncProviders = this.createAsyncProviders(options);

    return {
      module: SequelizeCoreModule,
      imports: options.imports ?? [],
      providers: [
        ...asyncProviders,
        connectionProvider,
        {
          provide: SEQUELIZE_MODULE_ID,
          useValue: generateString(),
        },
        {
          provide: SEQUELIZE_CONNECTION_NAME,
          useValue: connectionName,
        },
      ],
      exports: [connectionProvider],
    };
  }

  async onApplicationShutdown(): Promise<void> {
    if (
      typeof this.options.autoCloseConnection !== "undefined" &&
      !this.options.autoCloseConnection
    ) {
      return;
    }

    const connection = this.moduleRef.get<SequelizeLike>(
      getConnectionToken(this.connectionName) as InjectionToken,
    );
    if (connection) {
      await connection.close();
    }
  }

  private static createAsyncProviders(
    options: SequelizeModuleAsyncOptions,
  ): Provider[] {
    if (options.useExisting || options.useFactory) {
      return [this.createAsyncOptionsProvider(options)];
    }
    const useClass = options.useClass as Type<SequelizeOptionsFactory>;
    if (!useClass) {
      throw new Error(
        'SequelizeModule.forRootAsync() requires one of "useFactory", "useClass", or "useExisting".',
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
    options: SequelizeModuleAsyncOptions,
  ): Provider {
    if (options.useFactory) {
      return {
        provide: SEQUELIZE_MODULE_OPTIONS,
        useFactory: options.useFactory,
        inject: options.inject || [],
      };
    }

    const inject = [
      (options.useClass ||
        options.useExisting) as Type<SequelizeOptionsFactory>,
    ];
    return {
      provide: SEQUELIZE_MODULE_OPTIONS,
      useFactory: async (optionsFactory: SequelizeOptionsFactory) =>
        await optionsFactory.createSequelizeOptions(options.name),
      inject,
    };
  }

  private static async createConnectionFactory(
    options: SequelizeModuleOptions,
  ): Promise<SequelizeLike> {
    return await handleRetry(
      options.retryAttempts,
      options.retryDelay,
    )(async () => {
      const sequelize: SequelizeLike = options.sequelizeFactory
        ? await options.sequelizeFactory(options)
        : options.uri
          ? new Sequelize(options.uri, options)
          : new Sequelize(options);

      if (!options.autoLoadModels) {
        return sequelize;
      }

      const connectionToken = options.name || DEFAULT_CONNECTION_NAME;
      const models =
        EntitiesMetadataStorage.getEntitiesByConnection(connectionToken);
      sequelize.addModels(models);

      await sequelize.authenticate();

      if (typeof options.synchronize === "undefined" || options.synchronize) {
        await sequelize.sync(options.sync);
      }

      return sequelize;
    });
  }
}
