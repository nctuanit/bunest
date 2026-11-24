import type {
  DynamicModule,
  ModuleImport,
} from "../interfaces/module.interface";
import type {
  FactoryDependency,
  OptionalFactoryDependency,
  Provider,
} from "../interfaces/provider.interface";
import {
  isForwardReference,
  type InjectionToken,
  type Type,
} from "../interfaces/type.interface";
import { Logger } from "../logger/logger";

export const CONFIGURABLE_MODULE_ID = "CONFIGURABLE_MODULE_ID";

const DEFAULT_METHOD_KEY = "register";
const DEFAULT_FACTORY_CLASS_METHOD_KEY = "create";
const ASYNC_METHOD_SUFFIX = "Async";

const ASYNC_OPTIONS_METADATA_KEYS = new Set<string>([
  "imports",
  "useFactory",
  "useClass",
  "useExisting",
  "inject",
  "provideInjectionTokensFrom",
  "extraProviders",
]);

export type ConfigurableModuleOptionsFactory<
  ModuleOptions,
  FactoryClassMethodKey extends string = "create",
> = {
  [K in FactoryClassMethodKey]: () => ModuleOptions | Promise<ModuleOptions>;
};

export interface ConfigurableModuleAsyncOptions<
  ModuleOptions,
  FactoryClassMethodKey extends string = "create",
> {
  imports?: ModuleImport[];
  useFactory?: (...args: any[]) => ModuleOptions | Promise<ModuleOptions>;
  inject?: FactoryDependency[];
  useClass?: Type<
    ConfigurableModuleOptionsFactory<ModuleOptions, FactoryClassMethodKey>
  >;
  useExisting?: Type<
    ConfigurableModuleOptionsFactory<ModuleOptions, FactoryClassMethodKey>
  >;
  /**
   * List of parent module's providers filtered to include only the providers
   * needed to satisfy `inject` tokens (NestJS v12 parity).
   */
  provideInjectionTokensFrom?: Provider[];
  /**
   * Additional providers appended to the generated async dynamic module.
   */
  extraProviders?: Provider[];
}

export interface ConfigurableModuleBuilderOptions {
  /**
   * Optional diagnostic name included in the generated injection token description.
   */
  moduleName?: string;
  /**
   * Optional explicit injection token instead of an auto-generated token.
   */
  optionsInjectionToken?: InjectionToken;
  /**
   * When `true`, marks every constructed dynamic module as uniquely transient
   * via a unique `CONFIGURABLE_MODULE_ID` provider (NestJS v12 parity).
   * @default false
   */
  alwaysTransient?: boolean;
}

export type ConfigurableModuleCls<
  ModuleOptions,
  StaticMethodKey extends string = "register",
  FactoryClassMethodKey extends string = "create",
  ExtraModuleDefinitionOptions = {},
> = {
  new (...args: any[]): object;
} & {
  [K in StaticMethodKey]: (
    options: ModuleOptions & Partial<ExtraModuleDefinitionOptions>,
  ) => DynamicModule;
} & {
  [K in `${StaticMethodKey}Async`]: (
    options: ConfigurableModuleAsyncOptions<
      ModuleOptions,
      FactoryClassMethodKey
    > &
      Partial<ExtraModuleDefinitionOptions>,
  ) => DynamicModule;
};

export interface ConfigurableModuleHost<
  ModuleOptions = Record<string, unknown>,
  StaticMethodKey extends string = "register",
  FactoryClassMethodKey extends string = "create",
  ExtraModuleDefinitionOptions = {},
> {
  readonly ConfigurableModuleClass: ConfigurableModuleCls<
    ModuleOptions,
    StaticMethodKey,
    FactoryClassMethodKey,
    ExtraModuleDefinitionOptions
  >;
  readonly MODULE_OPTIONS_TOKEN: InjectionToken<ModuleOptions>;
  readonly OPTIONS_TYPE: ModuleOptions & Partial<ExtraModuleDefinitionOptions>;
  readonly ASYNC_OPTIONS_TYPE: ConfigurableModuleAsyncOptions<
    ModuleOptions,
    FactoryClassMethodKey
  > &
    Partial<ExtraModuleDefinitionOptions>;
}

let builderTokenSeq = 1;

function unwrapDependencyToken(
  dep: FactoryDependency,
): InjectionToken | undefined {
  if (
    typeof dep === "object" &&
    dep !== null &&
    "token" in dep &&
    "optional" in dep
  ) {
    const inner = (dep as OptionalFactoryDependency).token;
    return isForwardReference(inner) ? inner.forwardRef() : inner;
  }
  if (isForwardReference(dep)) {
    return dep.forwardRef();
  }
  return dep;
}

function getProviderToken(provider: Provider): InjectionToken {
  return typeof provider === "function" ? provider : provider.provide;
}

function getProviderInjectDependencies(
  provider: Provider,
): readonly FactoryDependency[] {
  if (typeof provider === "function") {
    return [];
  }
  if ("useFactory" in provider && Array.isArray(provider.inject)) {
    return provider.inject;
  }
  if ("useClass" in provider && Array.isArray(provider.inject)) {
    return provider.inject;
  }
  if ("useExisting" in provider) {
    return [provider.useExisting];
  }
  return [];
}

/**
 * Resolves the subset of `providers` matching `tokens` (and their transitive
 * `inject` dependencies within `providers`), matching NestJS's
 * `provideInjectionTokensFrom` behavior.
 */
function resolveInjectionProviders(
  providers: readonly Provider[],
  tokens: readonly FactoryDependency[],
): Provider[] {
  const result: Provider[] = [];
  const added = new Set<Provider>();
  const queue: InjectionToken[] = [];
  const visitedTokens = new Set<InjectionToken>();

  for (const dep of tokens) {
    const token = unwrapDependencyToken(dep);
    if (token !== undefined && !visitedTokens.has(token)) {
      visitedTokens.add(token);
      queue.push(token);
    }
  }

  while (queue.length > 0) {
    const currentToken = queue.shift()!;
    for (const provider of providers) {
      if (added.has(provider)) continue;
      if (getProviderToken(provider) === currentToken) {
        added.add(provider);
        result.push(provider);
        for (const nestedDep of getProviderInjectDependencies(provider)) {
          const nestedToken = unwrapDependencyToken(nestedDep);
          if (nestedToken !== undefined && !visitedTokens.has(nestedToken)) {
            visitedTokens.add(nestedToken);
            queue.push(nestedToken);
          }
        }
      }
    }
  }

  return result;
}

/**
 * Fluent builder generating typed NestJS-compatible dynamic module base classes
 * supporting synchronous (`register`/`forRoot`) and asynchronous (`registerAsync`/`forRootAsync`
 * with `useFactory`, `useClass`, `useExisting`, `imports`, `inject`,
 * `provideInjectionTokensFrom`, `extraProviders`) registration, `alwaysTransient`,
 * and customizable extras transforms (e.g. `isGlobal`).
 */
export class ConfigurableModuleBuilder<
  ModuleOptions,
  StaticMethodKey extends string = "register",
  FactoryClassMethodKey extends string = "create",
  ExtraModuleDefinitionOptions = {},
> {
  protected readonly options: ConfigurableModuleBuilderOptions;
  protected staticMethodKey: StaticMethodKey;
  protected factoryClassMethodKey: FactoryClassMethodKey;
  protected extras: ExtraModuleDefinitionOptions;
  protected transformModuleDefinition: (
    definition: DynamicModule,
    extraOptions: ExtraModuleDefinitionOptions,
  ) => DynamicModule;
  protected readonly logger: Logger = new Logger(
    ConfigurableModuleBuilder.name,
  );

  constructor(
    options: ConfigurableModuleBuilderOptions = {},
    parentBuilder?: ConfigurableModuleBuilder<ModuleOptions, any, any, any>,
  ) {
    this.options = options;
    if (parentBuilder) {
      this.staticMethodKey = parentBuilder.staticMethodKey as StaticMethodKey;
      this.factoryClassMethodKey =
        parentBuilder.factoryClassMethodKey as FactoryClassMethodKey;
      this.extras = parentBuilder.extras as ExtraModuleDefinitionOptions;
      this.transformModuleDefinition =
        parentBuilder.transformModuleDefinition as (
          definition: DynamicModule,
          extraOptions: ExtraModuleDefinitionOptions,
        ) => DynamicModule;
    } else {
      this.staticMethodKey = DEFAULT_METHOD_KEY as StaticMethodKey;
      this.factoryClassMethodKey =
        DEFAULT_FACTORY_CLASS_METHOD_KEY as FactoryClassMethodKey;
      this.extras = undefined as unknown as ExtraModuleDefinitionOptions;
      this.transformModuleDefinition = (definition) => definition;
    }
  }

  setClassMethodName<Key extends string>(
    key: Key,
  ): ConfigurableModuleBuilder<
    ModuleOptions,
    Key,
    FactoryClassMethodKey,
    ExtraModuleDefinitionOptions
  > {
    const builder = new ConfigurableModuleBuilder<
      ModuleOptions,
      Key,
      FactoryClassMethodKey,
      ExtraModuleDefinitionOptions
    >(this.options, this);
    builder.staticMethodKey = key;
    return builder;
  }

  setFactoryMethodName<Key extends string>(
    key: Key,
  ): ConfigurableModuleBuilder<
    ModuleOptions,
    StaticMethodKey,
    Key,
    ExtraModuleDefinitionOptions
  > {
    const builder = new ConfigurableModuleBuilder<
      ModuleOptions,
      StaticMethodKey,
      Key,
      ExtraModuleDefinitionOptions
    >(this.options, this);
    builder.factoryClassMethodKey = key;
    return builder;
  }

  setExtras<ExtraOptions>(
    extras: ExtraOptions,
    transformDefinition: (
      definition: DynamicModule,
      extras: ExtraOptions,
    ) => DynamicModule = (definition) => definition,
  ): ConfigurableModuleBuilder<
    ModuleOptions,
    StaticMethodKey,
    FactoryClassMethodKey,
    ExtraOptions
  > {
    const builder = new ConfigurableModuleBuilder<
      ModuleOptions,
      StaticMethodKey,
      FactoryClassMethodKey,
      ExtraOptions
    >(this.options, this);
    builder.extras =
      typeof extras === "object" && extras !== null
        ? ({ ...(extras as Record<string, unknown>) } as ExtraOptions)
        : extras;
    builder.transformModuleDefinition = transformDefinition;
    return builder;
  }

  build(): ConfigurableModuleHost<
    ModuleOptions,
    StaticMethodKey,
    FactoryClassMethodKey,
    ExtraModuleDefinitionOptions
  > {
    this.staticMethodKey ??= DEFAULT_METHOD_KEY as StaticMethodKey;
    this.factoryClassMethodKey ??=
      DEFAULT_FACTORY_CLASS_METHOD_KEY as FactoryClassMethodKey;
    this.transformModuleDefinition ??= (definition) => definition;

    const methodKey = this.staticMethodKey;
    const asyncMethodKey = `${methodKey}${ASYNC_METHOD_SUFFIX}`;
    const factoryKey = this.factoryClassMethodKey;
    const defaultExtras =
      typeof this.extras === "object" && this.extras !== null
        ? { ...(this.extras as Record<string, unknown>) }
        : undefined;
    const transformDef = this.transformModuleDefinition;
    const alwaysTransient = this.options.alwaysTransient === true;

    const optionsToken: InjectionToken<ModuleOptions> =
      this.options.optionsInjectionToken ??
      (this.options.moduleName
        ? this.constructInjectionTokenString()
        : Symbol(`BUNEST_CONFIGURABLE_MODULE_OPTIONS_${builderTokenSeq++}`));

    const extractExtrasAndOptions = (
      raw: unknown,
    ): {
      moduleOptions: ModuleOptions;
      mergedExtras: Record<string, unknown>;
    } => {
      if (!defaultExtras) {
        return {
          moduleOptions: raw as ModuleOptions,
          mergedExtras: {},
        };
      }

      const mergedExtras: Record<string, unknown> = { ...defaultExtras };
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return {
          moduleOptions: raw as ModuleOptions,
          mergedExtras,
        };
      }

      const extraKeys = new Set(Object.keys(defaultExtras));
      const cleanOptions: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(
        raw as Record<string, unknown>,
      )) {
        if (extraKeys.has(key)) {
          if (value !== undefined) {
            mergedExtras[key] = value;
          }
        } else {
          cleanOptions[key] = value;
        }
      }

      return {
        moduleOptions: cleanOptions as ModuleOptions,
        mergedExtras,
      };
    };

    const extractAsyncExtras = (raw: unknown): Record<string, unknown> => {
      if (!defaultExtras) {
        return {};
      }
      const mergedExtras: Record<string, unknown> = { ...defaultExtras };
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return mergedExtras;
      }
      for (const [key, value] of Object.entries(
        raw as Record<string, unknown>,
      )) {
        if (!ASYNC_OPTIONS_METADATA_KEYS.has(key) && value !== undefined) {
          mergedExtras[key] = value;
        }
      }
      return mergedExtras;
    };

    const createAsyncProviders = (
      asyncOpts: ConfigurableModuleAsyncOptions<ModuleOptions, string>,
    ): Provider[] => {
      if (asyncOpts.useFactory) {
        const providers: Provider[] = [
          {
            provide: optionsToken,
            useFactory: asyncOpts.useFactory,
            inject: asyncOpts.inject ? [...asyncOpts.inject] : [],
          },
        ];
        if (asyncOpts.inject && asyncOpts.provideInjectionTokensFrom) {
          providers.push(
            ...resolveInjectionProviders(
              asyncOpts.provideInjectionTokensFrom,
              asyncOpts.inject,
            ),
          );
        }
        return providers;
      }

      if (asyncOpts.useClass) {
        const factoryClass = asyncOpts.useClass;
        return [
          {
            provide: factoryClass,
            useClass: factoryClass,
          },
          {
            provide: optionsToken,
            useFactory: async (
              optionsFactory: Record<
                string,
                () => ModuleOptions | Promise<ModuleOptions>
              >,
            ) => {
              const fn = optionsFactory[factoryKey];
              if (typeof fn !== "function") {
                throw new Error(
                  `ConfigurableModule options factory "${factoryClass.name}" is missing method "${factoryKey}()".`,
                );
              }
              return await fn.call(optionsFactory);
            },
            inject: [factoryClass],
          },
        ];
      }

      if (asyncOpts.useExisting) {
        const existingToken = asyncOpts.useExisting;
        const providers: Provider[] = [
          {
            provide: optionsToken,
            useFactory: async (
              optionsFactory: Record<
                string,
                () => ModuleOptions | Promise<ModuleOptions>
              >,
            ) => {
              const fn = optionsFactory[factoryKey];
              if (typeof fn !== "function") {
                throw new Error(
                  `ConfigurableModule existing options factory "${existingToken.name}" is missing method "${factoryKey}()".`,
                );
              }
              return await fn.call(optionsFactory);
            },
            inject: [existingToken],
          },
        ];
        if (asyncOpts.inject && asyncOpts.provideInjectionTokensFrom) {
          providers.push(
            ...resolveInjectionProviders(
              asyncOpts.provideInjectionTokensFrom,
              asyncOpts.inject,
            ),
          );
        }
        return providers;
      }

      throw new Error(
        `${asyncMethodKey}() requires one of "useFactory", "useClass", or "useExisting".`,
      );
    };

    class ConfigurableModuleClass {}

    Object.defineProperty(ConfigurableModuleClass, methodKey, {
      configurable: true,
      writable: true,
      value(
        this: Type<unknown>,
        options: ModuleOptions & Partial<ExtraModuleDefinitionOptions>,
      ): DynamicModule {
        const { moduleOptions, mergedExtras } =
          extractExtrasAndOptions(options);
        const providers: Provider[] = [
          {
            provide: optionsToken,
            useValue: moduleOptions,
          },
        ];
        if (alwaysTransient) {
          providers.push({
            provide: CONFIGURABLE_MODULE_ID,
            useValue: crypto.randomUUID(),
          });
        }
        const baseDefinition: DynamicModule = {
          module: this,
          providers,
        };
        return transformDef(
          baseDefinition,
          mergedExtras as ExtraModuleDefinitionOptions,
        );
      },
    });

    Object.defineProperty(ConfigurableModuleClass, asyncMethodKey, {
      configurable: true,
      writable: true,
      value(
        this: Type<unknown>,
        options: ConfigurableModuleAsyncOptions<ModuleOptions, string> &
          Partial<ExtraModuleDefinitionOptions>,
      ): DynamicModule {
        const mergedExtras = extractAsyncExtras(options);
        const providers: Provider[] = [
          ...createAsyncProviders(options),
          ...(options.extraProviders ?? []),
        ];
        if (alwaysTransient) {
          providers.push({
            provide: CONFIGURABLE_MODULE_ID,
            useValue: crypto.randomUUID(),
          });
        }
        const baseDefinition: DynamicModule = {
          module: this,
          imports: options.imports ? [...options.imports] : [],
          providers,
        };
        return transformDef(
          baseDefinition,
          mergedExtras as ExtraModuleDefinitionOptions,
        );
      },
    });

    return {
      ConfigurableModuleClass:
        ConfigurableModuleClass as unknown as ConfigurableModuleCls<
          ModuleOptions,
          StaticMethodKey,
          FactoryClassMethodKey,
          ExtraModuleDefinitionOptions
        >,
      MODULE_OPTIONS_TOKEN: optionsToken,
      OPTIONS_TYPE: this.createTypeProxy(
        "OPTIONS_TYPE",
      ) as unknown as ModuleOptions & Partial<ExtraModuleDefinitionOptions>,
      ASYNC_OPTIONS_TYPE: this.createTypeProxy(
        "ASYNC_OPTIONS_TYPE",
      ) as unknown as ConfigurableModuleAsyncOptions<
        ModuleOptions,
        FactoryClassMethodKey
      > &
        Partial<ExtraModuleDefinitionOptions>,
    };
  }

  private constructInjectionTokenString(): string {
    const moduleNameInSnakeCase = this.options
      .moduleName!.trim()
      .split(/(?=[A-Z])/)
      .join("_")
      .toUpperCase();
    return `${moduleNameInSnakeCase}_MODULE_OPTIONS`;
  }

  private createTypeProxy(typeName: string): Record<string, unknown> {
    return new Proxy(
      {},
      {
        get: () => {
          throw new Error(
            `"${typeName}" is not supposed to be used as a value.`,
          );
        },
      },
    );
  }
}
