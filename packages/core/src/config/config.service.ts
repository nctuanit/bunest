import { Inject, Injectable, Optional } from "../common/index";
import { CONFIG_OPTIONS_TOKEN, CONFIG_STORE_TOKEN } from "./constants";
import { getDefaultParser, loadEnvironmentVariables } from "./env-parser";
import type {
  ConfigObject,
  ConfigServiceInternalOptions,
  SecretRedactorOptions,
} from "./interfaces/config.interface";
import type {
  DefaultConfigSchema,
  HasConcreteConfigSchema,
} from "./interfaces/config-registry.interface";
import { createSecretRedactor } from "./redactor";
import type {
  ConfigChangeEvent,
  ConfigGetOptions,
  ConfigObserver,
  ConfigSubscribable,
  ConfigSubscription,
  NoInferType,
  Parser,
  Path,
  PathValue,
} from "./types/path.types";

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

type ValidatedResult<
  WasValidated extends boolean,
  T,
> = WasValidated extends true ? T : T | undefined;

type KeyOf<T> = keyof T extends never ? string | symbol : keyof T;

function isGetOptionsObject(value: unknown): value is ConfigGetOptions {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { infer?: unknown }).infer === true &&
    Object.keys(value).length === 1
  );
}

function readDotPath(
  source: Record<PropertyKey, unknown> | NodeJS.ProcessEnv,
  propertyPath: PropertyKey,
): unknown {
  const map = source as Record<PropertyKey, unknown>;
  if (typeof propertyPath === "symbol") {
    return Object.prototype.hasOwnProperty.call(map, propertyPath)
      ? map[propertyPath]
      : undefined;
  }

  const keyStr = String(propertyPath);
  if (DANGEROUS_KEYS.has(keyStr)) {
    return undefined;
  }

  // Exact top-level key lookup first (supports flat env keys and keys literally containing `.`)
  if (Object.prototype.hasOwnProperty.call(map, keyStr)) {
    return map[keyStr];
  }

  if (!keyStr.includes(".")) {
    return undefined;
  }

  const segments = keyStr.split(".");
  let current: unknown = map;

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (
      !segment ||
      DANGEROUS_KEYS.has(segment) ||
      current === null ||
      typeof current !== "object"
    ) {
      return undefined;
    }
    const record = current as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(record, segment)) {
      return undefined;
    }
    current = record[segment];
  }

  return current;
}

function writeDotPath(
  target: Record<PropertyKey, unknown>,
  propertyPath: PropertyKey,
  value: unknown,
): boolean {
  if (typeof propertyPath === "symbol") {
    target[propertyPath] = value;
    return true;
  }

  const keyStr = String(propertyPath);
  if (!keyStr || DANGEROUS_KEYS.has(keyStr)) {
    return false;
  }

  if (
    !keyStr.includes(".") ||
    Object.prototype.hasOwnProperty.call(target, keyStr)
  ) {
    Object.defineProperty(target, keyStr, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    return true;
  }

  const segments = keyStr.split(".");
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (!seg || DANGEROUS_KEYS.has(seg)) {
      return false;
    }
  }

  let current: Record<string, unknown> = target as Record<string, unknown>;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]!;
    const existing = Object.prototype.hasOwnProperty.call(current, seg)
      ? current[seg]
      : undefined;
    if (
      existing === null ||
      typeof existing !== "object" ||
      Array.isArray(existing)
    ) {
      const next: Record<string, unknown> = {};
      Object.defineProperty(current, seg, {
        value: next,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      current = next;
    } else {
      current = existing as Record<string, unknown>;
    }
  }

  const leaf = segments[segments.length - 1]!;
  Object.defineProperty(current, leaf, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
  return true;
}

/**
 * Typed configuration service supporting flat keys, dot-path namespace lookups
 * (e.g. `"database.host"`), `{ infer: true }` type inference, live `set()` +
 * zero-RxJS `changes$` subscriptions, memory caching, fail-fast `getOrThrow()`,
 * and secret-redacted snapshots.
 */
@Injectable()
export class ConfigService<
  K = DefaultConfigSchema,
  WasValidated extends boolean = false,
> {
  private readonly store: Record<PropertyKey, unknown>;
  private readonly options: ConfigServiceInternalOptions;
  private readonly redactor: <T>(value: T) => T;
  private readonly cache = new Map<PropertyKey, unknown>();
  private readonly changeListeners = new Set<
    (event: ConfigChangeEvent<any, any>) => void
  >();
  private _isCacheEnabled: boolean;
  private _skipProcessEnv: boolean;
  private envFilePaths: string[];
  private parser: Parser;

  constructor(
    @Optional()
    @Inject(CONFIG_STORE_TOKEN)
    store: Record<PropertyKey, unknown> = {},
    @Optional()
    @Inject(CONFIG_OPTIONS_TOKEN)
    options: ConfigServiceInternalOptions = {},
  ) {
    this.store = { ...store };
    this.options = options;
    this._isCacheEnabled = Boolean(options.cache);
    this._skipProcessEnv = Boolean(options.skipProcessEnv);
    this.envFilePaths = options.envFilePaths ? [...options.envFilePaths] : [];
    this.parser = options.parser ?? getDefaultParser();
    this.redactor = createSecretRedactor({
      secretKeys: options.secretKeys,
      redactionMask: options.redactionMask,
    });
  }

  /**
   * Returns a lightweight zero-RxJS subscribable stream of configuration changes
   * emitted whenever `set()` updates a property.
   */
  get changes$(): ConfigSubscribable<ConfigChangeEvent<any, any>> {
    return {
      subscribe: (
        observerOrNext?:
          | ConfigObserver<ConfigChangeEvent<any, any>>
          | ((value: ConfigChangeEvent<any, any>) => void),
      ): ConfigSubscription => {
        const listener =
          typeof observerOrNext === "function"
            ? observerOrNext
            : observerOrNext?.next
              ? (event: ConfigChangeEvent<any, any>) =>
                  observerOrNext.next!(event)
              : undefined;

        if (!listener) {
          return { unsubscribe() {} };
        }

        this.changeListeners.add(listener);
        return {
          unsubscribe: () => {
            this.changeListeners.delete(listener);
          },
        };
      },
    };
  }

  /**
   * Get a configuration value with automatic return-type inference from a
   * concrete `ConfigService<K>` or augmented `BunestConfigRegistry`.
   */
  get<P extends (HasConcreteConfigSchema<K> extends true ? Path<K> : never)>(
    propertyPath: P,
  ): ValidatedResult<WasValidated, PathValue<K, P>>;
  /**
   * Get a configuration value based on property path (dot notation supported).
   */
  get<T = any>(propertyPath: KeyOf<K>): ValidatedResult<WasValidated, T>;
  /**
   * Get a configuration value with automatic return-type inference from `K`.
   */
  get<
    T = K,
    P extends Path<T> = any,
    R extends PathValue<T, P> = PathValue<T, P>,
  >(
    propertyPath: P,
    options: ConfigGetOptions,
  ): ValidatedResult<WasValidated, R>;
  /**
   * Get a configuration value with automatic return-type inference and a fallback default.
   */
  get<P extends (HasConcreteConfigSchema<K> extends true ? Path<K> : never)>(
    propertyPath: P,
    defaultValue: NoInferType<Exclude<PathValue<K, P>, undefined>>,
  ): Exclude<PathValue<K, P>, undefined>;
  /**
   * Get a configuration value, returning `defaultValue` when undefined.
   */
  get<T = any>(propertyPath: KeyOf<K>, defaultValue: NoInferType<T>): T;
  /**
   * Get a configuration value with automatic return-type inference and a fallback default.
   */
  get<
    T = K,
    P extends Path<T> = any,
    R extends PathValue<T, P> = PathValue<T, P>,
  >(
    propertyPath: P,
    defaultValue: NoInferType<R>,
    options: ConfigGetOptions,
  ): Exclude<R, undefined>;
  get(
    propertyPath: PropertyKey,
    defaultValueOrOptions?: unknown,
    options?: ConfigGetOptions,
  ): unknown {
    const defaultValue =
      isGetOptionsObject(defaultValueOrOptions) && !options
        ? undefined
        : defaultValueOrOptions;

    if (this._isCacheEnabled && this.cache.has(propertyPath)) {
      const cached = this.cache.get(propertyPath);
      return cached === undefined ? defaultValue : cached;
    }

    let value = readDotPath(this.store, propertyPath);

    if (
      value === undefined &&
      this.canReadLiveProcessEnv() &&
      typeof propertyPath === "string"
    ) {
      value = readDotPath(process.env, propertyPath);
    }

    if (this._isCacheEnabled && value !== undefined) {
      this.cache.set(propertyPath, value);
    }

    return value === undefined ? defaultValue : value;
  }

  /**
   * Get a configuration value or throw a `TypeError` when the resolved value is `undefined`.
   */
  getOrThrow<
    P extends (HasConcreteConfigSchema<K> extends true ? Path<K> : never),
  >(propertyPath: P): Exclude<PathValue<K, P>, undefined>;
  getOrThrow<T = any>(propertyPath: KeyOf<K>): Exclude<T, undefined>;
  getOrThrow<
    T = K,
    P extends Path<T> = any,
    R extends PathValue<T, P> = PathValue<T, P>,
  >(propertyPath: P, options: ConfigGetOptions): Exclude<R, undefined>;
  getOrThrow<
    P extends (HasConcreteConfigSchema<K> extends true ? Path<K> : never),
  >(
    propertyPath: P,
    defaultValue: NoInferType<Exclude<PathValue<K, P>, undefined>>,
  ): Exclude<PathValue<K, P>, undefined>;
  getOrThrow<T = any>(
    propertyPath: KeyOf<K>,
    defaultValue: NoInferType<T>,
  ): Exclude<T, undefined>;
  getOrThrow<
    T = K,
    P extends Path<T> = any,
    R extends PathValue<T, P> = PathValue<T, P>,
  >(
    propertyPath: P,
    defaultValue: NoInferType<R>,
    options: ConfigGetOptions,
  ): Exclude<R, undefined>;
  getOrThrow(
    propertyPath: PropertyKey,
    defaultValueOrOptions?: unknown,
    options?: ConfigGetOptions,
  ): unknown {
    const value = (
      this.get as (
        path: PropertyKey,
        defaultOrOpts?: unknown,
        opts?: ConfigGetOptions,
      ) => unknown
    )(propertyPath, defaultValueOrOptions, options);

    if (value === undefined) {
      throw new TypeError(
        `Configuration key "${String(propertyPath)}" does not exist or is undefined.`,
      );
    }
    return value;
  }

  /**
   * Sets a configuration value at `propertyPath` (supports dot notation),
   * invalidates affected cache entries, and notifies `changes$` subscribers.
   */
  set<T = any>(
    propertyPath: KeyOf<K> | (Path<K> & string) | (string & {}),
    value: T,
  ): void {
    const key = propertyPath as PropertyKey;
    const oldValue = (this.get as (path: PropertyKey) => unknown)(key);

    if (!writeDotPath(this.store, key, value)) {
      return;
    }

    if (this._isCacheEnabled) {
      this.invalidateCacheForPath(key);
      if (value !== undefined) {
        this.cache.set(key, value);
      }
    }

    const event: ConfigChangeEvent<any, T> = {
      path: String(key),
      oldValue,
      newValue: value,
    };

    for (const listener of [...this.changeListeners]) {
      listener(event);
    }
  }

  /**
   * Sets env file paths to parse using the active parser and merges loaded values.
   * @deprecated `ConfigModule.forRoot()` loads environment files directly.
   */
  setEnvFilePaths(paths: string[]): void {
    this.envFilePaths = [...paths];
    this.reloadEnvFiles();
  }

  /**
   * Sets the parser used for `.env` files configured via `setEnvFilePaths()`.
   * @deprecated `ConfigModule.forRoot({ parser })` configures the parser directly.
   */
  setParser(parser: Parser): void {
    this.parser = parser;
    if (this.envFilePaths.length > 0) {
      this.reloadEnvFiles();
    }
  }

  has(propertyPath: KeyOf<K> | (string & {})): boolean {
    return (
      (this.get as (path: PropertyKey) => unknown)(
        propertyPath as PropertyKey,
      ) !== undefined
    );
  }

  /**
   * Registers a loaded namespace object into the configuration store
   * (used by `ConfigModule.forFeature()`).
   */
  mergeNamespace(namespace: string | symbol, value: ConfigObject): void {
    if (
      !namespace ||
      (typeof namespace === "string" && DANGEROUS_KEYS.has(namespace))
    ) {
      return;
    }
    const existing = this.store[namespace];
    if (existing && typeof existing === "object" && !Array.isArray(existing)) {
      this.store[namespace] = {
        ...(existing as Record<string, unknown>),
        ...value,
      };
    } else {
      this.store[namespace] = { ...value };
    }
    if (this._isCacheEnabled) {
      this.invalidateCacheForPath(namespace);
    }
  }

  /**
   * Merges all non-dangerous top-level entries (primitives, arrays, or nested objects)
   * into the configuration store (used by anonymous `ConfigModule.forFeature()`).
   */
  mergeRecord(values: ConfigObject): void {
    for (const [key, value] of Object.entries(values)) {
      if (!key || DANGEROUS_KEYS.has(key)) {
        continue;
      }
      const existing = this.store[key];
      if (
        existing &&
        typeof existing === "object" &&
        !Array.isArray(existing) &&
        value &&
        typeof value === "object" &&
        !Array.isArray(value)
      ) {
        this.store[key] = {
          ...(existing as Record<string, unknown>),
          ...(value as Record<string, unknown>),
        };
      } else {
        Object.defineProperty(this.store, key, {
          value,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      if (this._isCacheEnabled) {
        this.invalidateCacheForPath(key);
      }
    }
  }

  /**
   * Returns a deep-cloned snapshot of the active configuration with all
   * secret keys masked for safe structured logging or diagnostics.
   */
  getRedactedSnapshot(): Record<string, unknown> {
    return this.redactor(this.store as Record<string, unknown>);
  }

  /**
   * Creates a secret redactor pre-seeded with this `ConfigService`'s secret keys
   * plus any additional keys/mask passed in `extraOptions`.
   */
  createSecretRedactor(
    extraOptions: SecretRedactorOptions = {},
  ): <T>(value: T) => T {
    return createSecretRedactor({
      secretKeys: [
        ...(this.options.secretKeys ?? []),
        ...(extraOptions.secretKeys ?? []),
      ],
      redactionMask: extraOptions.redactionMask ?? this.options.redactionMask,
    });
  }

  private canReadLiveProcessEnv(): boolean {
    return (
      !this._skipProcessEnv &&
      !this.options.ignoreEnvVars &&
      this.options.envSource === undefined
    );
  }

  private invalidateCacheForPath(key: PropertyKey): void {
    this.cache.delete(key);
    if (typeof key !== "string") {
      return;
    }
    const prefix = `${key}.`;
    for (const cachedKey of this.cache.keys()) {
      if (typeof cachedKey !== "string") continue;
      if (cachedKey.startsWith(prefix) || key.startsWith(`${cachedKey}.`)) {
        this.cache.delete(cachedKey);
      }
    }
  }

  private reloadEnvFiles(): void {
    if (this.envFilePaths.length === 0) {
      return;
    }
    const loaded = loadEnvironmentVariables({
      envFilePath: this.envFilePaths,
      ignoreEnvVars: true,
      parser: this.parser,
    });
    this.mergeRecord(loaded);
  }
}
