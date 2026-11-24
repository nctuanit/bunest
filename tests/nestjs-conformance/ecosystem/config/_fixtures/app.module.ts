import { join } from "../../../../../packages/core/src";
import {
  Inject,
  Module,
  Optional,
  type DynamicModule,
  type StandardSchemaV1,
  type StandardSchemaV1Options,
} from "../../../../../packages/core/src/common";
import {
  ConfigModule,
  ConfigService,
  type ConfigFactory,
  type ConfigModuleOptions,
  type ConfigType,
} from "../../../../../packages/core/src/config";
import databaseConfig from "./database.config";
import nestedDatabaseConfig from "./nested-database.config";
import symbolDatabaseConfig, {
  DATABASE_SYMBOL_TOKEN,
} from "./symbol-database.config";
import {
  createJoiLikePortDbSchema,
  createZodLikePortDbSchema,
} from "./schema-helpers";

export const fixturesDir = Bun.fileURLToPath(new URL(".", import.meta.url));

type Config = {
  database: ConfigType<typeof databaseConfig> & {
    driver: ConfigType<typeof nestedDatabaseConfig>;
  };
};

interface ConfigTypeAsInterface {
  database: ConfigType<typeof databaseConfig> & {
    driver: ConfigType<typeof nestedDatabaseConfig>;
  };
}

@Module({})
export class AppModule {
  constructor(
    private readonly configService: ConfigService,
    // The following is the same object as above but narrowing its types
    private readonly configServiceNarrowed: ConfigService<Config, true>,
    private readonly configServiceNarrowed2: ConfigService<
      ConfigTypeAsInterface,
      true
    >,
    @Optional()
    @Inject(databaseConfig.KEY)
    private readonly dbConfig: ConfigType<typeof databaseConfig>,
  ) {}

  /**
   * Type-checking fixture preserved verbatim from upstream `@nestjs/config`.
   * If typings diverge, `bun check` will fail with TypeScript errors.
   */
  protected noop(): void {
    const identityString = (v: string) => v;
    const identityNumber = (v: number) => v;

    const knowConfig =
      this.configServiceNarrowed.get<Config["database"]>("database");
    const knowConfig2 =
      this.configServiceNarrowed2.get<ConfigTypeAsInterface["database"]>(
        "database",
      );

    identityString(knowConfig.host);
    identityNumber(knowConfig.port);
    identityString(knowConfig.driver.host);
    identityNumber(knowConfig.driver.port);
    identityString(knowConfig2.host);
  }

  static withCache(): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot({
          cache: true,
          envFilePath: join(fixturesDir, ".env"),
          load: [databaseConfig],
        }),
      ],
    };
  }

  static withSkipProcessEnv(): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot({
          envFilePath: join(fixturesDir, ".env"),
          load: [() => ({ obj: { test: "true", test2: undefined } })],
          skipProcessEnv: true,
        }),
      ],
    };
  }

  static withEnvVars(): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot({
          envFilePath: join(fixturesDir, ".env"),
          load: [() => ({ obj: { test: "true", test2: undefined } })],
        }),
      ],
    };
  }

  static withExpandedEnvVars(options: ConfigModuleOptions = {}): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot({
          envFilePath: join(fixturesDir, ".env.expanded"),
          expandVariables: true,
          ...options,
        }),
      ],
    };
  }

  static withExpandedEnvVarsIgnoreProcessEnv(): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot({
          envFilePath: join(fixturesDir, ".env.expanded"),
          expandVariables: { processEnv: {} },
        }),
      ],
    };
  }

  static withEnvVarsAndLoadedConfigurations(
    configFactory: ConfigFactory[],
  ): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot({
          envFilePath: join(fixturesDir, ".env"),
          load: configFactory,
        }),
      ],
    };
  }

  static withMultipleEnvFiles(): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot({
          envFilePath: [
            join(fixturesDir, ".env.local"),
            join(fixturesDir, ".env"),
          ],
        }),
      ],
    };
  }

  static withLoadedConfigurations(): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot({
          load: [databaseConfig],
        }),
      ],
    };
  }

  static withLoadedAsyncConfigurations(): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot({
          load: [Promise.resolve(databaseConfig)],
        }),
      ],
    };
  }

  static withNestedLoadedConfigurations(): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot({
          load: [nestedDatabaseConfig],
        }),
      ],
    };
  }

  static withSymbolLoadedConfigurations(): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot({
          load: [symbolDatabaseConfig],
        }),
      ],
    };
  }

  static withDynamicLoadedConfigurations(
    configFactory: ConfigFactory[],
  ): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot({
          load: configFactory,
        }),
      ],
    };
  }

  static withStandardSchemaValidation(
    validationSchema: StandardSchemaV1,
    envFilePath?: string,
    ignoreEnvFile?: boolean,
    validationOptions?: StandardSchemaV1Options,
  ): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot({
          envFilePath,
          ignoreEnvFile,
          validationSchema: validationSchema as StandardSchemaV1<
            Record<string, unknown>,
            any
          >,
          validationOptions: validationOptions as any,
        }),
      ],
    };
  }

  static withSchemaValidation(
    envFilePath?: string,
    ignoreEnvFile?: boolean,
    validationOptions?: StandardSchemaV1Options,
  ): DynamicModule {
    return AppModule.withStandardSchemaValidation(
      createJoiLikePortDbSchema(),
      envFilePath,
      ignoreEnvFile,
      validationOptions,
    );
  }

  static withZodV3SchemaValidation(
    envFilePath?: string,
    ignoreEnvFile?: boolean,
  ): DynamicModule {
    return AppModule.withStandardSchemaValidation(
      createZodLikePortDbSchema("zod-v3"),
      envFilePath,
      ignoreEnvFile,
    );
  }

  static withZodV4SchemaValidation(
    envFilePath?: string,
    ignoreEnvFile?: boolean,
  ): DynamicModule {
    return AppModule.withStandardSchemaValidation(
      createZodLikePortDbSchema("zod-v4"),
      envFilePath,
      ignoreEnvFile,
    );
  }

  static withZodV4MiniSchemaValidation(
    envFilePath?: string,
    ignoreEnvFile?: boolean,
  ): DynamicModule {
    return AppModule.withStandardSchemaValidation(
      createZodLikePortDbSchema("zod-v4-mini"),
      envFilePath,
      ignoreEnvFile,
    );
  }

  static withValidateFunction(
    validate: (config: Record<string, any>) => Record<string, any>,
    envFilePath?: string,
    ignoreEnvFile?: boolean,
  ): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot({
          envFilePath,
          ignoreEnvFile,
          validate,
        }),
      ],
    };
  }

  static withForFeature(): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(),
        ConfigModule.forFeature(databaseConfig),
      ],
    };
  }

  getEnvVariables() {
    return process.env;
  }

  getDatabaseHost() {
    return this.configService.get("database.host");
  }

  getDatabaseConfig() {
    return this.dbConfig;
  }

  getNestedDatabaseHost() {
    return this.configService.get("database.driver.host");
  }

  getSymbolDatabaseConfig() {
    // Note: Bunest ConfigService<K = Record<string, unknown>> resolves KeyOf<K> to `string` instead of `string | symbol`.
    return (
      this.configService as unknown as ConfigService<
        Record<PropertyKey, unknown>
      >
    ).get(DATABASE_SYMBOL_TOKEN);
  }
}
