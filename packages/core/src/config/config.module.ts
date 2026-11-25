import {
  type DynamicModule,
  Global,
  type InjectionToken,
  Module,
  type Provider,
} from "../common/index";
import { ConfigService, readDotPath } from "./config.service";
import { CONFIG_OPTIONS_TOKEN, CONFIG_STORE_TOKEN } from "./constants";
import { getRegisteredInjectConfigBindings } from "./decorators/config.decorators";
import {
  loadEnvironmentSnapshot,
  type ParsedEnvEntry,
} from "./env-parser";
import type {
  ConfigFactory,
  ConfigModuleOptions,
  ConfigObject,
  ConfigServiceInternalOptions,
  EnvExpansionContext,
  NamespacedConfigFactory,
} from "./interfaces/config.interface";
import { isNamespacedConfigFactory } from "./register-as";
import { validateConfiguration } from "./validator";

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isClassInstance(value: unknown): value is object {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto !== Object.prototype && proto !== null;
}

/**
 * Global host module holding the single shared configuration store and options
 * per application container so multiple `ConfigModule.forRoot()`, `forFeature()`,
 * and plain `ConfigModule` imports share state without provider ambiguity.
 */
@Global()
@Module({
  providers: [
    {
      provide: CONFIG_STORE_TOKEN,
      useFactory: (): Record<PropertyKey, unknown> => ({}),
    },
    {
      provide: CONFIG_OPTIONS_TOKEN,
      useFactory: (): ConfigServiceInternalOptions => ({}),
    },
  ],
  exports: [CONFIG_STORE_TOKEN, CONFIG_OPTIONS_TOKEN],
})
export class ConfigHostModule {}

/**
 * Non-global module owning the single `ConfigService` provider per application
 * container. Re-exported by `ConfigModule`, `ConfigModule.forRoot()`, and
 * `ConfigModule.forFeature()` so importing multiple config modules never causes
 * `AmbiguousProviderException` while still respecting `isGlobal: false`.
 */
@Module({
  imports: [ConfigHostModule],
  providers: [ConfigService],
  exports: [ConfigService],
})
export class ConfigServiceModule {}

/**
 * Bunest configuration module providing `.env` loading, `${VAR}` expansion,
 * DTO / Standard Schema / custom validation at bootstrap, typed `registerAs()`
 * namespaces, `envVariablesLoaded` synchronization, and secret-redacting `ConfigService`.
 */
@Module({
  imports: [ConfigHostModule, ConfigServiceModule],
  exports: [ConfigServiceModule],
})
export class ConfigModule {
  private static environmentVariablesLoadedSignal: () => void = () => {};
  private static readonly _envVariablesLoaded: Promise<void> =
    new Promise<void>((resolve) => {
      ConfigModule.environmentVariablesLoadedSignal = resolve;
    });
  private static readonly loadedEnv = new Map<string, string>();
  private static readonly forFeatureTokens = new Set<InjectionToken>();

  /**
   * Resolves once `ConfigModule.forRoot()` finishes loading environment variables.
   * Awaited by `ConditionalModule.registerWhen()`.
   */
  static get envVariablesLoaded(): Promise<void> {
    return ConfigModule._envVariablesLoaded;
  }

  static async forRoot<T extends object = ConfigObject>(
    options: ConfigModuleOptions<T> = {},
  ): Promise<DynamicModule> {
    const snapshot = loadEnvironmentSnapshot({
      envFilePath: options.envFilePath,
      ignoreEnvFile: options.ignoreEnvFile,
      ignoreEnvVars: options.ignoreEnvVars,
      expandVariables: options.expandVariables,
      override: options.override,
      parser: options.parser,
      envSource: options.envSource,
      previouslyLoadedEnv: ConfigModule.loadedEnv,
    });

    const hasValidatorOption = Boolean(
      options.validate ||
      options.validationClass ||
      options.validationSchema,
    );

    // Populate `process.env` immediately when no validator is configured, OR
    // when a synchronous validationSchema passes cleanly (never writing raw,
    // NUL-containing, or stripped keys to `process.env` before validation succeeds).
    if (
      !snapshot.invalidNulKey &&
      !options.envSource &&
      !options.ignoreEnvVars &&
      !options.ignoreEnvFile
    ) {
      if (!hasValidatorOption) {
        ConfigModule.assignVariablesToProcess(
          snapshot.fileValues,
          Boolean(options.override),
          Boolean(options.expandVariables),
          snapshot.rawEntries,
        );
      } else if (
        options.validationSchema &&
        typeof options.validationSchema === "object" &&
        "~standard" in options.validationSchema
      ) {
        try {
          const validatePredefined = options.validatePredefined !== false;
          const input = validatePredefined
            ? { ...snapshot.combined }
            : { ...snapshot.fileValues };
          const validateFn = options.validationSchema["~standard"].validate as (
            v: Record<string, unknown>,
            opts?: unknown,
          ) => unknown;
          const syncRes =
            options.validationOptions !== undefined
              ? validateFn(input, options.validationOptions)
              : validateFn(input);
          if (
            syncRes &&
            typeof syncRes === "object" &&
            !(syncRes instanceof Promise) &&
            !("issues" in syncRes && (syncRes as { issues?: unknown }).issues) &&
            "value" in syncRes &&
            typeof (syncRes as { value?: unknown }).value === "object" &&
            (syncRes as { value?: unknown }).value !== null
          ) {
            const describedKeys = (
              options.validationSchema as {
                describe?: () => { keys?: Record<string, unknown> };
              }
            ).describe?.()?.keys;
            const valRec = (syncRes as { value: Record<string, unknown> }).value;
            const toAssign: Record<string, string> = {};
            for (const [k, rawV] of Object.entries(snapshot.fileValues)) {
              if (Object.hasOwn(valRec, k)) {
                if (valRec[k] !== undefined && valRec[k] !== null) {
                  toAssign[k] = String(valRec[k]);
                }
              } else if (
                !describedKeys ||
                !Object.hasOwn(describedKeys, k)
              ) {
                toAssign[k] = String(rawV);
              }
            }
            ConfigModule.assignVariablesToProcess(
              toAssign,
              Boolean(options.override),
              Boolean(options.expandVariables),
              snapshot.rawEntries,
            );
          }
        } catch {
          // Validation errors will be surfaced cleanly below
        }
      }
    }

    // Signal any waiting `ConditionalModule.registerWhen()` calls BEFORE awaiting slow `load` factories
    ConfigModule.environmentVariablesLoadedSignal();

    if (snapshot.invalidNulKey) {
      throw new Error(
        `Environment variable "${snapshot.invalidNulKey}" contains a NUL character.`,
      );
    }

    const validatePredefined =
      !options.ignoreEnvVars && options.validatePredefined !== false;

    const validatorInput: Record<string, unknown> = validatePredefined
      ? { ...snapshot.combined }
      : { ...snapshot.fileValues };

    const validated = hasValidatorOption
      ? await validateConfiguration(validatorInput, {
          validate: options.validate,
          validationClass: options.validationClass,
          validationSchema: options.validationSchema,
          validationOptions: options.validationOptions,
          skipProcessEnv: options.skipProcessEnv,
          fileValues: snapshot.fileValues,
        })
      : undefined;

    if (
      hasValidatorOption &&
      validated &&
      !options.envSource &&
      !options.ignoreEnvVars &&
      !options.ignoreEnvFile
    ) {
      const stringified: Record<string, string> = {};
      for (const [k, v] of Object.entries(validated)) {
        if (
          v !== undefined &&
          v !== null &&
          Object.hasOwn(snapshot.fileValues, k)
        ) {
          stringified[k] = String(v);
        }
      }
      ConfigModule.assignVariablesToProcess(
        stringified,
        Boolean(options.override),
        Boolean(options.expandVariables),
        snapshot.rawEntries,
      );
    }

    const loadEntries = options.load ?? [];
    const loadedConfigs: Array<{
      factory: ConfigFactory | NamespacedConfigFactory<any, any>;
      value: ConfigObject;
    }> = [];
    const resolvedNamespaceFactories: Array<NamespacedConfigFactory<any, any>> =
      [];

    for (let i = 0; i < loadEntries.length; i++) {
      const rawEntry = loadEntries[i];
      if (!rawEntry) continue;
      const factory = await rawEntry;
      if (!factory) continue;
      if (isNamespacedConfigFactory(factory)) {
        resolvedNamespaceFactories.push(factory);
      }
      const loaded = await factory();
      if (loaded && typeof loaded === "object") {
        loadedConfigs.push({ factory, value: loaded });
      }
    }

    const normalizedPaths =
      options.envFilePath === undefined
        ? undefined
        : typeof options.envFilePath === "string"
          ? [options.envFilePath]
          : [...options.envFilePath];

    const expandOpts =
      typeof options.expandVariables === "object"
        ? options.expandVariables
        : options.expandVariables
          ? {}
          : undefined;

    const expansionContext: EnvExpansionContext | undefined =
      expandOpts && !options.ignoreEnvFile && snapshot.rawEntries.size > 0
        ? {
            rawEntries: snapshot.rawEntries,
            predefinedKeys: snapshot.predefinedKeys,
            expandOptions: expandOpts,
            override: Boolean(options.override),
            ignoreEnvVars: Boolean(options.ignoreEnvVars),
            skipProcessEnv: Boolean(options.skipProcessEnv),
            envSource: options.envSource,
          }
        : undefined;

    const rootLoaderToken = Symbol("bunest:config:root-loader");

    const providers: Provider[] = [
      {
        provide: rootLoaderToken,
        inject: [CONFIG_STORE_TOKEN, CONFIG_OPTIONS_TOKEN, ConfigService],
        useFactory: (
          store: Record<PropertyKey, unknown>,
          sharedOptions: ConfigServiceInternalOptions,
          configService: ConfigService,
        ): true => {
          if (options.cache !== undefined) {
            sharedOptions.cache = options.cache;
          }
          if (options.skipProcessEnv !== undefined) {
            sharedOptions.skipProcessEnv = options.skipProcessEnv;
          }
          if (options.ignoreEnvVars !== undefined) {
            sharedOptions.ignoreEnvVars = options.ignoreEnvVars;
          }
          if (options.envSource !== undefined) {
            sharedOptions.envSource = options.envSource;
          }
          if (normalizedPaths !== undefined) {
            sharedOptions.envFilePaths = normalizedPaths;
          }
          if (options.parser !== undefined) {
            sharedOptions.parser = options.parser;
          }
          if (options.secretKeys !== undefined) {
            sharedOptions.secretKeys = [
              ...(sharedOptions.secretKeys ?? []),
              ...options.secretKeys,
            ];
          }
          if (options.redactionMask !== undefined) {
            sharedOptions.redactionMask = options.redactionMask;
          }
          sharedOptions.onEnvAssigned = (k: string, v: string) => {
            ConfigModule.loadedEnv.set(k, v);
          };

          if (expansionContext) {
            sharedOptions.envExpansionContexts ??= [];
            sharedOptions.envExpansionContexts.push(expansionContext);
          }

          configService.syncInternalOptions();

          if (hasValidatorOption && validated) {
            sharedOptions.validatedKeys ??= new Set<string>();
            if (isClassInstance(validated)) {
              sharedOptions.validatedSources ??= [];
              sharedOptions.validatedSources.push(validated);
            }

            if (
              !validatePredefined &&
              !options.ignoreEnvVars &&
              !options.skipProcessEnv
            ) {
              // When using an isolated envSource, live process.env is not read,
              // so copy predefined runtimeEnv entries into store first.
              if (options.envSource) {
                for (const [k, v] of Object.entries(snapshot.runtimeEnv)) {
                  if (DANGEROUS_KEYS.has(k)) continue;
                  Object.defineProperty(store, k, {
                    value: v,
                    enumerable: true,
                    writable: true,
                    configurable: true,
                  });
                }
              }
              if (options.override) {
                for (const [k, v] of Object.entries(validated)) {
                  if (DANGEROUS_KEYS.has(k)) continue;
                  sharedOptions.validatedKeys.add(k);
                  Object.defineProperty(store, k, {
                    value: v,
                    enumerable: true,
                    writable: true,
                    configurable: true,
                  });
                }
              } else {
                for (const [k, v] of Object.entries(validated)) {
                  if (DANGEROUS_KEYS.has(k)) continue;
                  const runtimeVal = snapshot.runtimeEnv[k];
                  if (
                    runtimeVal !== undefined &&
                    snapshot.predefinedKeys.has(k) &&
                    snapshot.fileValues[k] !== runtimeVal
                  ) {
                    // Predefined runtime env variable was not validated -> prefer runtime env
                    continue;
                  }
                  sharedOptions.validatedKeys.add(k);
                  Object.defineProperty(store, k, {
                    value: v,
                    enumerable: true,
                    writable: true,
                    configurable: true,
                  });
                }
              }
            } else {
              for (const [k, v] of Object.entries(validated)) {
                if (DANGEROUS_KEYS.has(k)) continue;
                // Do not clobber a value already validated/converted by an earlier
                // ConfigModule.forRoot() with an unchanged raw string from runtimeEnv.
                if (
                  sharedOptions.validatedKeys.has(k) &&
                  Object.prototype.hasOwnProperty.call(store, k) &&
                  typeof v === "string" &&
                  snapshot.runtimeEnv[k] === v &&
                  typeof store[k] !== "string"
                ) {
                  continue;
                }
                sharedOptions.validatedKeys.add(k);
                Object.defineProperty(store, k, {
                  value: v,
                  enumerable: true,
                  writable: true,
                  configurable: true,
                });
              }
            }
          } else {
            // Without a validator, only copy env values into `store` when live `process.env`
            // is not the source of truth (so `cache: false` observes live `process.env` mutations).
            const customProcessEnv = Boolean(expandOpts?.processEnv);
            if (
              options.skipProcessEnv ||
              options.ignoreEnvVars ||
              customProcessEnv
            ) {
              for (const [k, v] of Object.entries(snapshot.fileValues)) {
                if (DANGEROUS_KEYS.has(k)) continue;
                Object.defineProperty(store, k, {
                  value: v,
                  enumerable: true,
                  writable: true,
                  configurable: true,
                });
              }
            } else if (options.envSource) {
              for (const [k, v] of Object.entries(snapshot.combined)) {
                if (DANGEROUS_KEYS.has(k)) continue;
                Object.defineProperty(store, k, {
                  value: v,
                  enumerable: true,
                  writable: true,
                  configurable: true,
                });
              }
            }
          }

          for (let i = 0; i < loadedConfigs.length; i++) {
            const { factory, value: loaded } = loadedConfigs[i]!;
            if (isNamespacedConfigFactory(factory)) {
              configService.mergeNamespace(factory.namespace, loaded);
            } else {
              for (const [k, v] of Object.entries(loaded)) {
                if (!DANGEROUS_KEYS.has(k)) {
                  Object.defineProperty(store, k, {
                    value: v,
                    enumerable: true,
                    writable: true,
                    configurable: true,
                  });
                }
              }
            }
          }

          return true;
        },
      },
    ];

    const exportsList: Array<InjectionToken | typeof ConfigServiceModule> = [
      ConfigServiceModule,
    ];
    const explicitNamespaceTokens = new Set<InjectionToken>();

    for (let i = 0; i < resolvedNamespaceFactories.length; i++) {
      const nsFactory = resolvedNamespaceFactories[i]!;
      providers.push({
        provide: nsFactory.KEY,
        inject: [CONFIG_STORE_TOKEN, rootLoaderToken],
        useFactory: (store: Record<PropertyKey, unknown>) =>
          readDotPath(store, nsFactory.namespace),
      });
      exportsList.push(nsFactory.KEY);
      explicitNamespaceTokens.add(nsFactory.KEY);
    }

    const buildDynamicInjectConfigProviders = (): Provider[] => {
      const extra: Provider[] = [];
      for (const binding of getRegisteredInjectConfigBindings()) {
        if (
          binding.isNamespaceFactory ||
          explicitNamespaceTokens.has(binding.token) ||
          ConfigModule.forFeatureTokens.has(binding.token)
        ) {
          continue;
        }
        extra.push({
          provide: binding.token,
          inject: [ConfigService, rootLoaderToken],
          useFactory: (config: ConfigService<Record<string, unknown>>) =>
            binding.hasDefault
              ? config.get(binding.lookupKey as string, binding.defaultValue)
              : config.get(binding.lookupKey as string),
        });
      }
      return extra;
    };

    const buildDynamicInjectConfigExports = (): InjectionToken[] => {
      const extra: InjectionToken[] = [];
      for (const binding of getRegisteredInjectConfigBindings()) {
        if (
          !binding.isNamespaceFactory &&
          !explicitNamespaceTokens.has(binding.token) &&
          !ConfigModule.forFeatureTokens.has(binding.token)
        ) {
          extra.push(binding.token);
        }
      }
      return extra;
    };

    return {
      module: ConfigModule,
      global: options.isGlobal ?? false,
      imports: [ConfigHostModule, ConfigServiceModule],
      get providers(): Provider[] {
        return [...providers, ...buildDynamicInjectConfigProviders()];
      },
      get exports(): Array<InjectionToken | typeof ConfigServiceModule> {
        return [...exportsList, ...buildDynamicInjectConfigExports()];
      },
    };
  }

  /**
   * Registers a partial/feature configuration namespace (created via `registerAs()`)
   * in a feature module, exporting its `KEY` token and `ConfigService` (via
   * `ConfigServiceModule`) and merging it into the shared `ConfigService` store.
   */
  static forFeature<TConfig extends ConfigObject>(
    configFactory:
      | NamespacedConfigFactory<TConfig, string | symbol>
      | ConfigFactory<TConfig>,
  ): DynamicModule {
    if (isNamespacedConfigFactory(configFactory)) {
      ConfigModule.forFeatureTokens.add(configFactory.KEY);
      return {
        module: ConfigModule,
        imports: [ConfigHostModule, ConfigServiceModule],
        providers: [
          {
            provide: configFactory.KEY,
            inject: [ConfigService],
            useFactory: async (
              configService: ConfigService,
            ): Promise<TConfig> => {
              const value = await configFactory();
              if (value && typeof value === "object") {
                configService.mergeNamespace(configFactory.namespace, value);
              }
              return value;
            },
          },
        ],
        exports: [ConfigServiceModule, configFactory.KEY],
      };
    }

    // Anonymous factory registration: run at bootstrap and merge keys into ConfigService
    const anonymousToken = Symbol("bunest:config:feature");
    return {
      module: ConfigModule,
      imports: [ConfigHostModule, ConfigServiceModule],
      providers: [
        {
          provide: anonymousToken,
          inject: [ConfigService],
          useFactory: async (
            configService: ConfigService,
          ): Promise<TConfig> => {
            const value = await configFactory();
            if (value && typeof value === "object") {
              configService.mergeRecord(value);
            }
            return value;
          },
        },
      ],
      exports: [ConfigServiceModule, anonymousToken],
    };
  }

  private static assignVariablesToProcess(
    fileValues: Record<string, unknown>,
    override: boolean,
    expandVariables = false,
    rawEntries?: ReadonlyMap<string, ParsedEnvEntry>,
  ): void {
    for (const [key, value] of Object.entries(fileValues)) {
      if (DANGEROUS_KEYS.has(key)) continue;
      if (
        !override &&
        Object.prototype.hasOwnProperty.call(process.env, key) &&
        process.env[key] !== undefined &&
        !(expandVariables && process.env[key] === "") &&
        !(expandVariables && rawEntries?.get(key)?.value === process.env[key]) &&
        ConfigModule.loadedEnv.get(key) !== process.env[key]
      ) {
        continue;
      }

      if (typeof value === "string") {
        process.env[key] = value;
      } else if (typeof value === "number" || typeof value === "boolean") {
        process.env[key] = `${value}`;
      } else {
        continue;
      }

      ConfigModule.loadedEnv.set(key, process.env[key]!);
    }
  }
}
