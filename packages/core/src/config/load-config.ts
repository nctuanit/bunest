import {
  formatStandardSchemaIssues,
  identity,
  isDefined,
  isObject,
  isStandardSchema,
  ternaryFor,
  toArray,
  type StandardSchemaV1,
  type Type,
} from "../common/index";
import { ConfigService } from "./config.service";
import { loadEnvironmentSnapshot } from "./env-parser";
import {
  ConfigValidationError,
  type ConfigModuleOptions,
  type ConfigObject,
  type ConfigServiceInternalOptions,
  type ConfigValidatorFn,
  type EnvExpansionContext,
  type NamespacedConfigFactory,
} from "./interfaces/config.interface";
import { isNamespacedConfigFactory } from "./register-as";
import { validateConfiguration } from "./validator";

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Symbol tagging a `LoadedConfig<T>` returned by `loadConfig()`. */
export const PRELOADED_CONFIG_MARKER = Symbol.for(
  "bunest:config:preloaded",
);

/** @internal Snapshot carried inside a `LoadedConfig<T>` for zero-reload `ConfigModule.forRoot({ preloaded })`. */
export interface PreloadedConfigInternal<T extends object = ConfigObject> {
  readonly store: Record<PropertyKey, unknown>;
  readonly internalOptions: ConfigServiceInternalOptions;
  readonly values: T;
  readonly namespaceFactories: ReadonlyArray<NamespacedConfigFactory<any, any>>;
  readonly loadedEntries: ReadonlyArray<{
    readonly factory:
      | (() => ConfigObject | Promise<ConfigObject>)
      | NamespacedConfigFactory<any, any>;
    readonly value: ConfigObject;
  }>;
}

/**
 * Strongly-typed configuration handle returned by `loadConfig()`, usable
 * BEFORE `BunestFactory.create()` in `main.ts` and passable directly into
 * `ConfigModule.forRoot({ preloaded })` without re-reading `.env` or re-validating.
 */
export interface LoadedConfig<T extends object = ConfigObject> {
  readonly values: T;
  readonly service: ConfigService<T, true>;
  readonly [PRELOADED_CONFIG_MARKER]: PreloadedConfigInternal<T>;
}

/** Options accepted by `loadConfig()`. */
export interface LoadConfigOptions<T extends object = ConfigObject>
  extends Omit<ConfigModuleOptions<T>, "isGlobal" | "preloaded"> {
  /** Shorthand alias for `validationSchema` (Standard Schema v1). */
  schema?: StandardSchemaV1<Record<string, unknown>, T>;
}

function isClassConstructor(fn: Function): fn is Type<object> {
  const source = Function.prototype.toString.call(fn).trimStart();
  return source.startsWith("class ") || source.startsWith("class{");
}

function isClassInstance(value: unknown): value is object {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto !== Object.prototype && proto !== null;
}

function defineSafeProp(
  target: Record<PropertyKey, unknown>,
  key: string,
  value: unknown,
): void {
  if (DANGEROUS_KEYS.has(key)) return;
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function redactRejectedValueInMessage(
  message: string,
  field: string,
  rawConfig: Record<string, unknown>,
): string {
  const rawVal =
    field !== "<env>" && Object.prototype.hasOwnProperty.call(rawConfig, field)
      ? rawConfig[field]
      : undefined;
  if (typeof rawVal !== "string" || rawVal.length === 0) {
    return message;
  }
  let sanitized = message;
  for (const quote of ['"', "'", "`"]) {
    const quoted = `${quote}${rawVal}${quote}`;
    if (sanitized.includes(quoted)) {
      sanitized = sanitized.split(quoted).join("[redacted]");
    }
  }
  if (sanitized.includes(rawVal)) {
    sanitized = sanitized.split(rawVal).join("[redacted]");
  }
  return sanitized;
}

/** Type guard checking whether `value` was produced by `loadConfig()`. */
export function isLoadedConfig<T extends object = ConfigObject>(
  value: unknown,
): value is LoadedConfig<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    PRELOADED_CONFIG_MARKER in value &&
    typeof (value as Record<PropertyKey, unknown>)[PRELOADED_CONFIG_MARKER] ===
      "object"
  );
}

/**
 * Loads `.env` files & runtime environment variables, validates them against a
 * Standard Schema v1 (`Zod`, `Valibot`, `ArkType`, `@bunest/validation`'s `s.*`),
 * custom validator function, or DTO class, and returns a strongly-typed
 * `{ values, service }` handle usable BEFORE `BunestFactory.create()` in `main.ts`.
 *
 * Pass the returned handle to `ConfigModule.forRoot({ preloaded })` so the DI
 * container reuses the exact preloaded & validated configuration without
 * re-reading files or running validation a second time.
 */
export async function loadConfig<T extends object>(
  schema: StandardSchemaV1<Record<string, unknown>, T>,
  options?: Omit<LoadConfigOptions<T>, "schema" | "validationSchema">,
): Promise<LoadedConfig<T>>;
export async function loadConfig<T extends object>(
  validator: ConfigValidatorFn<T>,
  options?: Omit<LoadConfigOptions<T>, "validate">,
): Promise<LoadedConfig<T>>;
export async function loadConfig<T extends object>(
  dtoClass: Type<T>,
  options?: Omit<LoadConfigOptions<T>, "validationClass">,
): Promise<LoadedConfig<T>>;
export async function loadConfig<T extends object = ConfigObject>(
  options?: LoadConfigOptions<T>,
): Promise<LoadedConfig<T>>;
export async function loadConfig<T extends object = ConfigObject>(
  schemaOrOptions?:
    | StandardSchemaV1<Record<string, unknown>, T>
    | ConfigValidatorFn<T>
    | Type<T>
    | LoadConfigOptions<T>,
  extraOptions?: LoadConfigOptions<T>,
): Promise<LoadedConfig<T>> {
  let options: LoadConfigOptions<T>;

  if (schemaOrOptions === undefined) {
    options = { ...(extraOptions ?? {}) };
  } else if (isStandardSchema(schemaOrOptions)) {
    options = {
      ...(extraOptions ?? {}),
      validationSchema: schemaOrOptions as StandardSchemaV1<
        Record<string, unknown>,
        T
      >,
    };
  } else if (typeof schemaOrOptions === "function") {
    if (isClassConstructor(schemaOrOptions)) {
      options = {
        ...(extraOptions ?? {}),
        validationClass: schemaOrOptions as Type<T>,
      };
    } else {
      options = {
        ...(extraOptions ?? {}),
        validate: schemaOrOptions as ConfigValidatorFn<T>,
      };
    }
  } else {
    options = { ...schemaOrOptions, ...(extraOptions ?? {}) };
  }

  const effectiveSchema = options.validationSchema ?? options.schema;

  const snapshot = loadEnvironmentSnapshot({
    envFilePath: options.envFilePath,
    ignoreEnvFile: options.ignoreEnvFile,
    ignoreEnvVars: options.ignoreEnvVars,
    expandVariables: options.expandVariables,
    override: options.override,
    parser: options.parser,
    envSource: options.envSource,
  });

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

  const store: Record<PropertyKey, unknown> = {};
  const validatedKeys = new Set<string>();
  const validatedSources: object[] = [];

  let typedValues: T;

  if (effectiveSchema && isStandardSchema(effectiveSchema)) {
    const validateFn = effectiveSchema["~standard"].validate as (
      input: Record<string, unknown>,
      opts?: unknown,
    ) =>
      | Promise<{ issues?: readonly unknown[]; value?: unknown }>
      | { issues?: readonly unknown[]; value?: unknown };

    const result = await (options.validationOptions !== undefined
      ? validateFn({ ...validatorInput }, options.validationOptions)
      : validateFn({ ...validatorInput }));

    if (result.issues) {
      const details = formatStandardSchemaIssues(
        result.issues as Parameters<typeof formatStandardSchemaIssues>[0],
        "<env>",
      ).map((d) => ({
        ...d,
        messages: d.messages.map((m) =>
          redactRejectedValueInMessage(m, d.field, validatorInput),
        ),
      }));
      const lines = details.map((d) =>
        d.field === "<env>"
          ? d.messages.join(", ")
          : `${d.field}: ${d.messages.join(", ")}`,
      );
      throw new ConfigValidationError(
        `Config validation error: ${lines.join("\n")}`,
        { details },
      );
    }

    const validatedValue = (
      result.value && typeof result.value === "object" ? result.value : {}
    ) as Record<string, unknown>;

    const baseForMerge = options.skipProcessEnv
      ? snapshot.fileValues
      : validatorInput;
    for (const [k, v] of Object.entries(baseForMerge)) {
      defineSafeProp(store, k, v);
    }
    for (const [k, v] of Object.entries(validatedValue)) {
      if (DANGEROUS_KEYS.has(k)) continue;
      validatedKeys.add(k);
      defineSafeProp(store, k, v);
    }
    typedValues = validatedValue as T;
  } else if (options.validate || options.validationClass) {
    const validated = await validateConfiguration(validatorInput, {
      validate: options.validate,
      validationClass: options.validationClass,
      validationOptions: options.validationOptions,
      skipProcessEnv: options.skipProcessEnv,
      fileValues: snapshot.fileValues,
    });
    if (isClassInstance(validated)) {
      validatedSources.push(validated);
    }
    for (const [k, v] of Object.entries(validated)) {
      if (DANGEROUS_KEYS.has(k)) continue;
      validatedKeys.add(k);
      defineSafeProp(store, k, v);
    }
    typedValues = validated as T;
  } else {
    const source =
      options.skipProcessEnv || options.ignoreEnvVars
        ? snapshot.fileValues
        : snapshot.combined;
    for (const [k, v] of Object.entries(source)) {
      defineSafeProp(store, k, v);
    }
    typedValues = { ...(store as Record<string, unknown>) } as T;
  }

  const normalizedPaths = isDefined(options.envFilePath)
    ? toArray(options.envFilePath)
    : undefined;

  const expandOpts = ternaryFor(options.expandVariables)
    .when(isObject, identity)
    .when(Boolean, () => ({}))
    .elseEval(undefined);

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

  const internalOptions: ConfigServiceInternalOptions = {
    cache: options.cache,
    skipProcessEnv: options.skipProcessEnv,
    ignoreEnvVars: options.ignoreEnvVars,
    envSource: options.envSource,
    envFilePaths: normalizedPaths,
    parser: options.parser,
    secretKeys: options.secretKeys ? [...options.secretKeys] : undefined,
    redactionMask: options.redactionMask,
    ...(expansionContext ? { envExpansionContexts: [expansionContext] } : {}),
    ...(validatedKeys.size > 0 ? { validatedKeys } : {}),
    ...(validatedSources.length > 0 ? { validatedSources } : {}),
  };

  const service = new ConfigService<T, true>(store, internalOptions);

  const loadEntries = options.load ?? [];
  const loadedEntries: Array<{
    factory:
      | (() => ConfigObject | Promise<ConfigObject>)
      | NamespacedConfigFactory<any, any>;
    value: ConfigObject;
  }> = [];
  const namespaceFactories: Array<NamespacedConfigFactory<any, any>> = [];

  for (let i = 0; i < loadEntries.length; i++) {
    const rawEntry = loadEntries[i];
    if (!rawEntry) continue;
    const factory = await rawEntry;
    if (!factory) continue;
    if (isNamespacedConfigFactory(factory)) {
      namespaceFactories.push(factory);
    }
    const loaded = await factory();
    if (loaded && typeof loaded === "object") {
      loadedEntries.push({ factory, value: loaded });
      if (isNamespacedConfigFactory(factory)) {
        service.mergeNamespace(factory.namespace, loaded);
      } else {
        service.mergeRecord(loaded);
      }
    }
  }

  return {
    values: typedValues,
    service,
    [PRELOADED_CONFIG_MARKER]: {
      store,
      internalOptions,
      values: typedValues,
      namespaceFactories,
      loadedEntries,
    },
  };
}
