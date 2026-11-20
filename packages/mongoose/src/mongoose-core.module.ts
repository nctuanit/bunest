import {
  Global,
  Inject,
  Module,
  type DynamicModule,
  type OnApplicationShutdown,
  type Provider,
  type Type,
} from "@bunest/common";
import { ModuleRef } from "@bunest/core";
import { getConnectionToken, handleRetry } from "./common/mongoose.utils";
import { createConnection } from "./driver/connection";
import { MongooseError } from "./errors/mongoose.error";
import type {
  ConnectionLike,
  ConnectOptions,
  MongooseModuleAsyncOptions,
  MongooseModuleFactoryOptions,
  MongooseModuleOptions,
  MongooseOptionsFactory,
} from "./interfaces/mongoose-options.interface";
import {
  MONGOOSE_CONNECTION_NAME,
  MONGOOSE_MODULE_OPTIONS,
} from "./mongoose.constants";

interface ConnectionCreationOptions {
  lazyConnection?: boolean;
  onConnectionCreate?: (connection: ConnectionLike) => void;
}

@Global()
@Module({})
export class MongooseCoreModule implements OnApplicationShutdown {
  constructor(
    @Inject(MONGOOSE_CONNECTION_NAME)
    private readonly connectionName: string,
    private readonly moduleRef: ModuleRef,
  ) {}

  static forRoot(
    uri: string,
    options: MongooseModuleOptions = {},
  ): DynamicModule {
    const {
      retryAttempts,
      retryDelay,
      connectionName,
      connectionFactory,
      connectionErrorFactory,
      lazyConnection,
      onConnectionCreate,
      verboseRetryLog,
      ...mongooseOptions
    } = options;

    const mongooseConnectionFactory =
      connectionFactory ?? ((connection: any) => connection);
    const mongooseConnectionError =
      connectionErrorFactory ?? ((error: MongooseError) => error);
    const mongooseConnectionName = getConnectionToken(connectionName);

    const mongooseConnectionNameProvider: Provider = {
      provide: MONGOOSE_CONNECTION_NAME,
      useValue: mongooseConnectionName,
    };

    const connectionProvider: Provider = {
      provide: mongooseConnectionName,
      useFactory: async () => {
        const retry = handleRetry(retryAttempts, retryDelay, verboseRetryLog);
        try {
          return await retry(async () => {
            const rawConn = await this.createMongooseConnection(
              uri,
              mongooseOptions,
              { lazyConnection, onConnectionCreate },
            );
            return await mongooseConnectionFactory(
              rawConn,
              mongooseConnectionName,
            );
          });
        } catch (error: unknown) {
          const normalized =
            error instanceof MongooseError
              ? error
              : error instanceof Error
                ? new MongooseError(error.message, { cause: error })
                : new MongooseError(String(error));
          throw mongooseConnectionError(normalized);
        }
      },
    };

    return {
      module: MongooseCoreModule,
      providers: [connectionProvider, mongooseConnectionNameProvider],
      exports: [connectionProvider],
    };
  }

  static forRootAsync(options: MongooseModuleAsyncOptions): DynamicModule {
    const mongooseConnectionName = getConnectionToken(options.connectionName);

    const mongooseConnectionNameProvider: Provider = {
      provide: MONGOOSE_CONNECTION_NAME,
      useValue: mongooseConnectionName,
    };

    const connectionProvider: Provider = {
      provide: mongooseConnectionName,
      useFactory: async (
        mongooseModuleOptions: MongooseModuleFactoryOptions,
      ) => {
        const {
          retryAttempts,
          retryDelay,
          uri,
          connectionFactory,
          connectionErrorFactory,
          lazyConnection,
          onConnectionCreate,
          verboseRetryLog,
          ...mongooseOptions
        } = mongooseModuleOptions;

        const mongooseConnectionFactory =
          connectionFactory ?? ((connection: any) => connection);
        const mongooseConnectionError =
          connectionErrorFactory ?? ((error: MongooseError) => error);

        const retry = handleRetry(retryAttempts, retryDelay, verboseRetryLog);
        try {
          return await retry(async () => {
            const rawConn = await this.createMongooseConnection(
              uri ?? "memory://localhost/test",
              mongooseOptions,
              { lazyConnection, onConnectionCreate },
            );
            return await mongooseConnectionFactory(
              rawConn,
              mongooseConnectionName,
            );
          });
        } catch (error: unknown) {
          const normalized =
            error instanceof MongooseError
              ? error
              : error instanceof Error
                ? new MongooseError(error.message, { cause: error })
                : new MongooseError(String(error));
          throw mongooseConnectionError(normalized);
        }
      },
      inject: [MONGOOSE_MODULE_OPTIONS],
    };

    const asyncProviders = this.createAsyncProviders(options);

    return {
      module: MongooseCoreModule,
      imports: options.imports ?? [],
      providers: [
        ...asyncProviders,
        connectionProvider,
        mongooseConnectionNameProvider,
      ],
      exports: [connectionProvider],
    };
  }

  private static createAsyncProviders(
    options: MongooseModuleAsyncOptions,
  ): Provider[] {
    if (options.useExisting || options.useFactory) {
      return [this.createAsyncOptionsProvider(options)];
    }
    const useClass = options.useClass as Type<MongooseOptionsFactory>;
    return [
      this.createAsyncOptionsProvider(options),
      {
        provide: useClass,
        useClass,
      },
    ];
  }

  private static createAsyncOptionsProvider(
    options: MongooseModuleAsyncOptions,
  ): Provider {
    if (options.useFactory) {
      return {
        provide: MONGOOSE_MODULE_OPTIONS,
        useFactory: options.useFactory,
        inject: options.inject ?? [],
      };
    }
    const inject = [
      (options.useClass ?? options.useExisting) as Type<MongooseOptionsFactory>,
    ];
    return {
      provide: MONGOOSE_MODULE_OPTIONS,
      useFactory: async (optionsFactory: MongooseOptionsFactory) =>
        await optionsFactory.createMongooseOptions(),
      inject,
    };
  }

  private static async createMongooseConnection(
    uri: string,
    mongooseOptions: ConnectOptions,
    factoryOptions?: ConnectionCreationOptions,
  ): Promise<ConnectionLike> {
    const connection = createConnection(uri, mongooseOptions);
    factoryOptions?.onConnectionCreate?.(connection);
    if (factoryOptions?.lazyConnection) {
      return connection;
    }
    return await connection.asPromise();
  }

  async onApplicationShutdown(): Promise<void> {
    try {
      const connection = this.moduleRef.get<ConnectionLike>(
        this.connectionName,
      );
      if (connection && typeof connection.close === "function") {
        await connection.close();
      }
    } catch {
      // Connection was never resolved or already torn down
    }
  }
}
