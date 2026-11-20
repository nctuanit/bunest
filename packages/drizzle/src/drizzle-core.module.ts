import { randomUUID } from "node:crypto";
import {
  Global,
  Inject,
  Logger,
  Module,
  type DynamicModule,
  type ModuleExport,
  type ModuleImport,
  type OnApplicationShutdown,
  type Provider,
  type Type,
} from "@bunest/common";
import {
  DrizzleService,
  getDrizzleServiceToken,
  type DrizzleDatabaseLike,
} from "@bunest/sql";
import {
  closeDrizzleClient,
  getDrizzleClients,
  getDrizzleToken,
  watchDrizzleClient,
} from "./common/drizzle.utils";
import {
  DEFAULT_CONNECTION_NAME,
  DRIZZLE_MODULE_DATABASE,
  DRIZZLE_MODULE_ID,
  DRIZZLE_MODULE_OPTIONS,
} from "./drizzle.constants";
import type {
  DrizzleModuleAsyncOptions,
  DrizzleModuleFactoryOptions,
  DrizzleModuleOptions,
  DrizzleOptionsFactory,
} from "./interfaces/drizzle-options.interface";

@Global()
@Module({})
export class DrizzleCoreModule implements OnApplicationShutdown {
  private readonly logger = new Logger("DrizzleModule");

  constructor(
    @Inject(DRIZZLE_MODULE_OPTIONS)
    private readonly options: DrizzleModuleOptions,
    @Inject(DRIZZLE_MODULE_DATABASE)
    private readonly db: unknown,
  ) {
    for (const client of getDrizzleClients(this.db)) {
      watchDrizzleClient(client, (error) =>
        this.logger.error(
          "Database connection error",
          error instanceof Error ? error.stack : String(error),
        ),
      );
    }
  }

  static forRoot(options: DrizzleModuleOptions): DynamicModule {
    const optionsProvider: Provider = {
      provide: DRIZZLE_MODULE_OPTIONS,
      useFactory: () => options,
    };
    return this.createDynamicModule(options?.name, [optionsProvider]);
  }

  static forRootAsync(options: DrizzleModuleAsyncOptions): DynamicModule {
    return this.createDynamicModule(
      options.name,
      this.createAsyncProviders(options),
      options.imports,
    );
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.options.autoCloseConnection === false) {
      return;
    }

    await Promise.all(
      getDrizzleClients(this.db).map(async (client) => {
        try {
          await closeDrizzleClient(client);
        } catch (err) {
          this.logger.error(
            "Unable to close the database connection",
            err instanceof Error ? err.stack : String(err),
          );
        }
      }),
    );
  }

  private static createDynamicModule(
    name: string | undefined,
    optionsProviders: Provider[],
    imports: ModuleImport[] = [],
  ): DynamicModule {
    const connectionName =
      name === undefined ? DEFAULT_CONNECTION_NAME : name;
    const databaseProvider: Provider = {
      provide: DRIZZLE_MODULE_DATABASE,
      useFactory: (options: DrizzleModuleOptions) =>
        this.createDatabase(options, name),
      inject: [DRIZZLE_MODULE_OPTIONS],
    };
    const exportedDatabaseProvider: Provider = {
      provide: getDrizzleToken(name),
      useFactory: (db: unknown) => db,
      inject: [DRIZZLE_MODULE_DATABASE],
    };

    const serviceToken = getDrizzleServiceToken(connectionName);
    const serviceProvider: Provider = {
      provide: serviceToken,
      useFactory: (db: DrizzleDatabaseLike) =>
        new DrizzleService({
          name: connectionName,
          db,
          // Client cleanup is owned by DrizzleCoreModule.onApplicationShutdown()
          autoClose: false,
        }),
      inject: [DRIZZLE_MODULE_DATABASE],
    };

    const providers: Provider[] = [
      ...optionsProviders,
      databaseProvider,
      exportedDatabaseProvider,
      serviceProvider,
      {
        provide: DRIZZLE_MODULE_ID,
        useValue: randomUUID(),
      },
    ];

    const exportsList: ModuleExport[] = [
      exportedDatabaseProvider,
      serviceToken,
    ];

    if (connectionName === DEFAULT_CONNECTION_NAME) {
      providers.push({
        provide: DrizzleService,
        useExisting: serviceToken,
      });
      exportsList.push(DrizzleService);
    }

    return {
      module: DrizzleCoreModule,
      imports,
      providers,
      exports: exportsList,
    };
  }

  private static createDatabase(
    options: DrizzleModuleOptions | DrizzleModuleFactoryOptions,
    name?: string,
  ): unknown {
    if (name !== undefined && name.trim() === "") {
      throw new Error(
        'DrizzleModule received an empty "name". Leave it out to register the default connection, or pass a name for this one.',
      );
    }

    const connection =
      name && name !== DEFAULT_CONNECTION_NAME ? ` ("${name}")` : "";
    const rawOpts = options as Record<string, unknown> | undefined;
    const hasDatabase =
      rawOpts?.db !== undefined && rawOpts?.db !== null;
    const hasDrizzle = rawOpts?.drizzle !== undefined;

    if (hasDatabase && hasDrizzle) {
      throw new Error(
        `DrizzleModule${connection} received both a "db" and a "drizzle" option. Pass either a database instance ("db") or a drizzle() function with its "connection" ("drizzle").`,
      );
    }

    if (hasDatabase) {
      return rawOpts!.db;
    }

    if (typeof rawOpts?.drizzle === "function") {
      const {
        name: _name,
        autoCloseConnection: _autoCloseConnection,
        db: _db,
        drizzle,
        ...config
      } = rawOpts;
      return (drizzle as (cfg: Record<string, unknown>) => unknown)(config);
    }

    if (hasDrizzle) {
      throw new Error(
        `DrizzleModule${connection} received a "drizzle" option that isn't a function. Pass the drizzle() function exported by your driver's entry point (e.g., drizzle-orm/node-postgres).`,
      );
    }

    const receivedDatabase =
      typeof rawOpts === "object" &&
      rawOpts !== null &&
      "$client" in rawOpts;
    throw new Error(
      receivedDatabase
        ? `DrizzleModule${connection} received a database instance instead of the module options. Pass it as the "db" option: { db }.`
        : `DrizzleModule${connection} was registered without a "db" or "drizzle" option. Pass the database instance returned by Drizzle's drizzle() function ("db"), or the drizzle() function and a "connection" ("drizzle").`,
    );
  }

  private static createAsyncProviders(
    options: DrizzleModuleAsyncOptions,
  ): Provider[] {
    if (options.useExisting || options.useFactory) {
      return [this.createAsyncOptionsProvider(options)];
    }
    if (!options.useClass) {
      throw new Error(
        'DrizzleModule.forRootAsync() requires one of "useFactory", "useClass" or "useExisting".',
      );
    }
    return [
      this.createAsyncOptionsProvider(options),
      {
        provide: options.useClass,
        useClass: options.useClass,
      },
    ];
  }

  private static createAsyncOptionsProvider(
    options: DrizzleModuleAsyncOptions,
  ): Provider {
    if (options.useFactory) {
      return {
        provide: DRIZZLE_MODULE_OPTIONS,
        useFactory: options.useFactory,
        inject: options.inject || [],
      };
    }

    const inject = [
      (options.useClass || options.useExisting) as Type<DrizzleOptionsFactory>,
    ];
    return {
      provide: DRIZZLE_MODULE_OPTIONS,
      useFactory: async (optionsFactory: DrizzleOptionsFactory) =>
        await optionsFactory.createDrizzleOptions(options.name),
      inject,
    };
  }
}
