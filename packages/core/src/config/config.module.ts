import {
  type DynamicModule,
  type InjectionToken,
  Module,
  type Provider,
} from "../common/index";
import { ConfigService } from "./config.service";
import { CONFIG_OPTIONS_TOKEN, CONFIG_STORE_TOKEN } from "./constants";
import { getRegisteredInjectConfigBindings } from "./decorators/config.decorators";
import { loadEnvironmentSnapshot } from "./env-parser";
import type {
  ConfigFactory,
  ConfigModuleOptions,
  ConfigObject,
  ConfigServiceInternalOptions,
  NamespacedConfigFactory,
} from "./interfaces/config.interface";
import { isNamespacedConfigFactory } from "./register-as";
import { validateConfiguration } from "./validator";

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Bunest configuration module providing `.env` loading, `${VAR}` expansion,
 * DTO / Standard Schema / custom validation at bootstrap, typed `registerAs()`
 * namespaces, `envVariablesLoaded` synchronization, and secret-redacting `ConfigService`.
 */
@Module({})
export class ConfigModule {
  private static environmentVariablesLoadedSignal: () => void = () => {};
  private static readonly _envVariablesLoaded: Promise<void> =
    new Promise<void>((resolve) => {
      ConfigModule.environmentVariablesLoadedSignal = resolve;
    });
  private static readonly loadedEnv = new Map<string, string>();

  /**
   * Resolves once `ConfigModule.forRoot()` finishes loading environment variables.
   * Awaited by `ConditionalModule.registerWhen()`.
   */
  static get envVariablesLoaded(): Promise<void> {
    return ConfigModule._envVariablesLoaded;
  }

  static forRoot<T extends object = ConfigObject>(
    options: ConfigModuleOptions<T> = {},
  ): DynamicModule {
    const snapshot = loadEnvironmentSnapshot({
      envFilePath: options.envFilePath,
      ignoreEnvFile: options.ignoreEnvFile,
      ignoreEnvVars: options.ignoreEnvVars,
      expandVariables: options.expandVariables,
      override: options.override,
      parser: options.parser,
      envSource: options.envSource,
    });

    const hasValidatorOption = Boolean(
      options.validate ||
      options.validationClass ||
      options.validationSchema,
    );

    // Populate `process.env` immediately when no validator is configured, OR
    // when a synchronous validationSchema passes cleanly (never writing raw or
    // stripped keys to `process.env` before validation succeeds).
    if (
      !options.envSource &&
      !options.ignoreEnvVars &&
      !options.ignoreEnvFile
    ) {
      if (!hasValidatorOption) {
        ConfigModule.assignVariablesToProcess(
          snapshot.fileValues,
          Boolean(options.override),
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
            );
          }
        } catch {
          // Validation errors will be surfaced cleanly in CONFIG_STORE_TOKEN factory
        }
      }
    }

    // Signal any waiting `ConditionalModule.registerWhen()` calls
    ConfigModule.environmentVariablesLoadedSignal();

    const normalizedPaths =
      options.envFilePath === undefined
        ? undefined
        : typeof options.envFilePath === "string"
          ? [options.envFilePath]
          : [...options.envFilePath];

    const internalOptions: ConfigServiceInternalOptions = {
      secretKeys: options.secretKeys,
      redactionMask: options.redactionMask,
      cache: options.cache,
      skipProcessEnv: options.skipProcessEnv,
      ignoreEnvVars: options.ignoreEnvVars,
      envSource: options.envSource,
      envFilePaths: normalizedPaths,
      parser: options.parser,
    };

    const loadEntries = options.load ?? [];
    const syncNamespaceFactories = loadEntries.filter(
      (entry): entry is NamespacedConfigFactory<any, any> =>
        isNamespacedConfigFactory(entry),
    );

    const providers: Provider[] = [
      {
        provide: CONFIG_OPTIONS_TOKEN,
        useValue: internalOptions,
      },
      {
        provide: CONFIG_STORE_TOKEN,
        useFactory: async (): Promise<Record<PropertyKey, unknown>> => {
          const validatePredefined =
            !options.ignoreEnvVars && options.validatePredefined !== false;

          const validatorInput: Record<string, unknown> = validatePredefined
            ? { ...snapshot.combined }
            : { ...snapshot.fileValues };

          const hasValidator = Boolean(
            options.validate ||
            options.validationClass ||
            options.validationSchema,
          );

          const validated = hasValidator
            ? await validateConfiguration(validatorInput, {
                validate: options.validate,
                validationClass: options.validationClass,
                validationSchema: options.validationSchema,
                validationOptions: options.validationOptions,
                skipProcessEnv: options.skipProcessEnv,
                fileValues: snapshot.fileValues,
              })
            : options.skipProcessEnv
              ? { ...snapshot.fileValues }
              : { ...snapshot.combined };

          const store: Record<PropertyKey, unknown> = {};

          if (
            hasValidator &&
            !options.envSource &&
            !options.ignoreEnvVars &&
            !options.ignoreEnvFile
          ) {
            const stringified: Record<string, string> = {};
            for (const [k, v] of Object.entries(validated)) {
              if (v !== undefined && v !== null && Object.hasOwn(snapshot.fileValues, k)) {
                stringified[k] = String(v);
              }
            }
            ConfigModule.assignVariablesToProcess(
              stringified,
              Boolean(options.override),
            );
          }

          if (
            !validatePredefined &&
            !options.ignoreEnvVars &&
            !options.skipProcessEnv
          ) {
            if (options.override) {
              Object.assign(store, snapshot.runtimeEnv, validated);
            } else {
              Object.assign(store, validated);
              for (const [k, v] of Object.entries(snapshot.runtimeEnv)) {
                if (!Object.hasOwn(validated, k) || snapshot.fileValues[k] !== v) {
                  store[k] = v;
                }
              }
            }
          } else {
            Object.assign(store, validated);
          }

          for (let i = 0; i < loadEntries.length; i++) {
            const rawEntry = loadEntries[i];
            if (!rawEntry) continue;
            const factory = await rawEntry;
            if (!factory) continue;
            const loaded = await factory();
            if (!loaded || typeof loaded !== "object") {
              continue;
            }

            if (isNamespacedConfigFactory(factory)) {
              const ns = factory.namespace;
              if (typeof ns === "symbol" || !DANGEROUS_KEYS.has(ns)) {
                store[ns] = { ...loaded };
              }
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

          return store;
        },
      },
      ConfigService,
    ];

    const exportsList: InjectionToken[] = [ConfigService];
    const explicitNamespaceTokens = new Set<InjectionToken>();

    for (let i = 0; i < syncNamespaceFactories.length; i++) {
      const nsFactory = syncNamespaceFactories[i]!;
      providers.push({
        provide: nsFactory.KEY,
        inject: [CONFIG_STORE_TOKEN],
        useFactory: (store: Record<PropertyKey, unknown>) =>
          store[nsFactory.namespace],
      });
      exportsList.push(nsFactory.KEY);
      explicitNamespaceTokens.add(nsFactory.KEY);
    }

    const buildDynamicInjectConfigProviders = (): Provider[] => {
      const extra: Provider[] = [];
      for (const binding of getRegisteredInjectConfigBindings()) {
        if (explicitNamespaceTokens.has(binding.token)) {
          continue;
        }
        extra.push({
          provide: binding.token,
          inject: [ConfigService],
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
        if (!explicitNamespaceTokens.has(binding.token)) {
          extra.push(binding.token);
        }
      }
      return extra;
    };

    return {
      module: ConfigModule,
      global: options.isGlobal ?? false,
      get providers(): Provider[] {
        return [...providers, ...buildDynamicInjectConfigProviders()];
      },
      get exports(): InjectionToken[] {
        return [...exportsList, ...buildDynamicInjectConfigExports()];
      },
    };
  }

  /**
   * Registers a partial/feature configuration namespace (created via `registerAs()`)
   * in a feature module, exporting its `KEY` token and merging it into `ConfigService`
   * if `ConfigModule.forRoot({ isGlobal: true })` is present.
   */
  static forFeature<TConfig extends ConfigObject>(
    configFactory:
      | NamespacedConfigFactory<TConfig, string | symbol>
      | ConfigFactory<TConfig>,
  ): DynamicModule {
    if (isNamespacedConfigFactory(configFactory)) {
      return {
        module: ConfigModule,
        providers: [
          {
            provide: configFactory.KEY,
            inject: [{ token: ConfigService, optional: true }],
            useFactory: async (
              configService?: ConfigService,
            ): Promise<TConfig> => {
              const value = await configFactory();
              if (configService && value && typeof value === "object") {
                configService.mergeNamespace(configFactory.namespace, value);
              }
              return value;
            },
          },
        ],
        exports: [configFactory.KEY],
      };
    }

    // Anonymous factory registration: run at bootstrap and merge keys into ConfigService if available
    const anonymousToken = Symbol("bunest:config:feature");
    return {
      module: ConfigModule,
      providers: [
        {
          provide: anonymousToken,
          inject: [{ token: ConfigService, optional: true }],
          useFactory: async (
            configService?: ConfigService,
          ): Promise<TConfig> => {
            const value = await configFactory();
            if (configService && value && typeof value === "object") {
              configService.mergeRecord(value);
            }
            return value;
          },
        },
      ],
      exports: [anonymousToken],
    };
  }

  private static assignVariablesToProcess(
    fileValues: Record<string, unknown>,
    override: boolean,
  ): void {
    for (const [key, value] of Object.entries(fileValues)) {
      if (DANGEROUS_KEYS.has(key)) continue;
      if (
        !override &&
        Object.prototype.hasOwnProperty.call(process.env, key) &&
        process.env[key] !== undefined &&
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
