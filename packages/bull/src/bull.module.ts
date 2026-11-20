import {
  Module,
  REQUEST,
  Scope,
  type DynamicModule,
  type ModuleImport,
  type Provider,
  type Type,
} from "@bunest/common";
import { DiscoveryModule } from "@bunest/core";
import { JOB_REF } from "./bull.constants";
import { BullMetadataAccessor } from "./bull-metadata.accessor";
import { BullExplorer } from "./bull.explorer";
import {
  createQueueOptionProviders,
  createQueueProviders,
} from "./bull.providers";
import type {
  BullModuleAsyncOptions,
  BullModuleOptions,
  BullOptionsFactory,
  BullRootModuleOptions,
} from "./interfaces/bull-module-options.interface";
import type {
  SharedBullAsyncConfiguration,
  SharedBullConfigurationFactory,
} from "./interfaces/shared-bull-config.interface";
import {
  createConditionalDepHolder,
  type IConditionalDepHolder,
} from "./utils/create-conditional-dep-holder.helper";
import { getQueueOptionsToken } from "./utils/get-queue-options-token.util";
import {
  BULL_CONFIG_DEFAULT_TOKEN,
  getSharedConfigToken,
} from "./utils/get-shared-config-token.util";

@Module({})
class BullCoreModule {}

/**
 * @publicApi
 */
@Module({})
export class BullModule {
  private static readonly coreModuleDefinition: DynamicModule = {
    global: true,
    module: BullCoreModule,
    imports: [DiscoveryModule],
    providers: [
      BullExplorer,
      BullMetadataAccessor,
      {
        provide: JOB_REF,
        scope: Scope.REQUEST,
        useFactory: (job: unknown) => job,
        inject: [{ token: REQUEST, optional: true }],
      },
    ],
    exports: [BullExplorer, BullMetadataAccessor, JOB_REF],
  };

  /**
   * Registers a globally available configuration for all queues.
   *
   * @param bullConfig shared bull configuration object
   */
  static forRoot(bullConfig: BullRootModuleOptions): DynamicModule;
  /**
   * Registers a globally available configuration under a specified "configKey".
   *
   * @param configKey a key under which the configuration should be available
   * @param sharedBullConfig shared bull configuration object
   */
  static forRoot(
    configKey: string,
    bullConfig: BullRootModuleOptions,
  ): DynamicModule;
  static forRoot(
    keyOrConfig: string | BullRootModuleOptions,
    bullConfig?: BullRootModuleOptions,
  ): DynamicModule {
    const [configKey, sharedBullConfig] =
      typeof keyOrConfig === "string"
        ? [keyOrConfig, bullConfig ?? {}]
        : [undefined, keyOrConfig];

    const token = getSharedConfigToken(configKey);
    const sharedBullConfigProvider: Provider = {
      provide: token,
      useValue: sharedBullConfig,
    };

    return {
      global: true,
      module: BullModule,
      providers: [sharedBullConfigProvider],
      exports: [token],
    };
  }

  /**
   * Registers a globally available configuration for all queues.
   *
   * @param asyncBullConfig shared bull configuration async factory
   */
  static forRootAsync(
    asyncBullConfig: SharedBullAsyncConfiguration,
  ): DynamicModule;
  /**
   * Registers a globally available configuration under a specified "configKey".
   *
   * @param configKey a key under which the configuration should be available
   * @param asyncBullConfig shared bull configuration async factory
   */
  static forRootAsync(
    configKey: string,
    asyncBullConfig: SharedBullAsyncConfiguration,
  ): DynamicModule;
  static forRootAsync(
    keyOrAsyncConfig: string | SharedBullAsyncConfiguration,
    asyncBullConfig?: SharedBullAsyncConfiguration,
  ): DynamicModule {
    const [configKey, asyncSharedBullConfig] =
      typeof keyOrAsyncConfig === "string"
        ? [keyOrAsyncConfig, asyncBullConfig!]
        : [undefined, keyOrAsyncConfig];

    const imports = this.getUniqImports([asyncSharedBullConfig]);
    const providers = this.createAsyncSharedConfigurationProviders(
      configKey,
      asyncSharedBullConfig,
    );
    const token = getSharedConfigToken(configKey);

    return {
      global: true,
      module: BullModule,
      imports,
      providers: asyncSharedBullConfig.extraProviders
        ? [...providers, ...asyncSharedBullConfig.extraProviders]
        : providers,
      exports: [token],
    };
  }

  static registerQueue(...options: BullModuleOptions[]): DynamicModule {
    const optionsArr = ([] as BullModuleOptions[]).concat(options);
    const queueProviders = createQueueProviders(optionsArr);
    const queueOptionProviders = createQueueOptionProviders(optionsArr);
    const exportTokens = queueProviders.map((p) => (p as { provide: any }).provide);

    return {
      module: BullModule,
      imports: [BullModule.coreModuleDefinition],
      providers: [...queueOptionProviders, ...queueProviders],
      exports: exportTokens,
    };
  }

  static registerQueueAsync(
    ...options: BullModuleAsyncOptions[]
  ): DynamicModule {
    const optionsArr = ([] as BullModuleAsyncOptions[]).concat(options);
    const queueProviders = createQueueProviders(optionsArr);
    const imports = this.getUniqImports(optionsArr);
    const asyncQueueOptionsProviders = optionsArr
      .map((queueOptions) => this.createAsyncProviders(queueOptions))
      .reduce((a, b) => a.concat(b), [] as Provider[]);
    const extraProviders = optionsArr
      .map((queueOptions) => queueOptions.extraProviders)
      .filter((ep): ep is Provider[] => Boolean(ep))
      .reduce((a, b) => a.concat(b), [] as Provider[]);
    const exportTokens = queueProviders.map((p) => (p as { provide: any }).provide);

    return {
      imports: imports.concat(BullModule.coreModuleDefinition),
      module: BullModule,
      providers: [
        ...asyncQueueOptionsProviders,
        ...queueProviders,
        ...extraProviders,
      ],
      exports: exportTokens,
    };
  }

  private static createAsyncProviders(
    options: BullModuleAsyncOptions,
  ): Provider[] {
    const optionalSharedConfigHolder = createConditionalDepHolder(
      getSharedConfigToken(options.configKey),
      BULL_CONFIG_DEFAULT_TOKEN,
    );

    if (options.useExisting || options.useFactory) {
      return [
        optionalSharedConfigHolder,
        this.createAsyncOptionsProvider(options, optionalSharedConfigHolder),
      ];
    }

    if (!options.useClass) {
      return createQueueOptionProviders([options]);
    }

    const useClass = options.useClass;
    return [
      optionalSharedConfigHolder,
      this.createAsyncOptionsProvider(options, optionalSharedConfigHolder),
      {
        provide: useClass,
        useClass,
      },
    ];
  }

  private static createAsyncOptionsProvider(
    asyncOptions: BullModuleAsyncOptions,
    optionalSharedConfigHolderRef: Type<IConditionalDepHolder>,
  ): Provider {
    if (asyncOptions.useFactory) {
      return {
        provide: getQueueOptionsToken(asyncOptions.name),
        useFactory: async (
          optionalDepHolder: IConditionalDepHolder,
          ...factoryArgs: any[]
        ) => {
          return {
            ...optionalDepHolder.getDependencyRef(asyncOptions.name),
            ...(await asyncOptions.useFactory!(...factoryArgs)),
          };
        },
        inject: [optionalSharedConfigHolderRef, ...(asyncOptions.inject || [])],
      };
    }

    const inject = [
      (asyncOptions.useClass ||
        asyncOptions.useExisting) as Type<BullOptionsFactory>,
    ];
    return {
      provide: getQueueOptionsToken(asyncOptions.name),
      useFactory: async (
        optionalDepHolder: IConditionalDepHolder,
        optionsFactory: BullOptionsFactory,
      ) => {
        return {
          ...optionalDepHolder.getDependencyRef(asyncOptions.name),
          ...(await optionsFactory.createBullOptions()),
        };
      },
      inject: [optionalSharedConfigHolderRef, ...inject],
    };
  }

  private static createAsyncSharedConfigurationProviders(
    configKey: string | undefined,
    options: SharedBullAsyncConfiguration,
  ): Provider[] {
    if (options.useExisting || options.useFactory) {
      return [this.createAsyncSharedConfigurationProvider(configKey, options)];
    }

    const useClass = options.useClass as Type<SharedBullConfigurationFactory>;
    return [
      this.createAsyncSharedConfigurationProvider(configKey, options),
      {
        provide: useClass,
        useClass,
      },
    ];
  }

  private static createAsyncSharedConfigurationProvider(
    configKey: string | undefined,
    options: SharedBullAsyncConfiguration,
  ): Provider {
    if (options.useFactory) {
      return {
        provide: getSharedConfigToken(configKey),
        useFactory: options.useFactory,
        inject: options.inject || [],
      };
    }

    const inject = [
      (options.useClass ||
        options.useExisting) as Type<SharedBullConfigurationFactory>,
    ];
    return {
      provide: getSharedConfigToken(configKey),
      useFactory: async (optionsFactory: SharedBullConfigurationFactory) =>
        await optionsFactory.createSharedConfiguration(),
      inject,
    };
  }

  private static getUniqImports(
    options: Array<Pick<BullModuleAsyncOptions, "imports">>,
  ): ModuleImport[] {
    return (
      options
        .map((option) => option.imports)
        .reduce<ModuleImport[]>((acc, i) => acc.concat(i || []), [])
        .filter((v, i, a) => a.indexOf(v) === i) || []
    );
  }
}
