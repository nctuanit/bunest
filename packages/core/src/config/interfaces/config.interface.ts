import type {
  FactoryProvider,
  StandardSchemaV1,
  Type,
  ValidationErrorDetail,
} from "../../common/index";
import type { ValidationPipeOptions } from "../../common/index";
import type { NAMESPACED_CONFIG_MARKER } from "../constants";
import type { Parser } from "../types/path.types";

export type ConfigObject = Record<string, any>;

export type ConfigFactory<T extends ConfigObject = ConfigObject> = () =>
  T | Promise<T>;

export interface ConfigFactoryKeyHost<T = unknown> {
  readonly KEY: string | symbol;
  readonly namespace?: string | symbol;
  asProvider(): FactoryProvider<T>;
}

export interface NamespacedConfigFactory<
  T extends ConfigObject = ConfigObject,
  TNamespace extends string | symbol = string,
> extends ConfigFactoryKeyHost<T> {
  (): T | Promise<T>;
  readonly KEY: string;
  readonly namespace: TNamespace;
  readonly [NAMESPACED_CONFIG_MARKER]: true;
}

export interface ExpandVariablesOptions {
  /**
   * When true, `${VAR}` expansion ignores `process.env` and only expands
   * variables loaded from `.env` files.
   */
  ignoreProcessEnv?: boolean;
  /**
   * Optional target environment object used for expansion lookup.
   */
  processEnv?: Record<string, string | undefined>;
}

export type ConfigValidatorFn<T extends object = ConfigObject> = (
  config: Record<string, any>,
) => T | Promise<T>;

export interface SecretRedactorOptions {
  /**
   * Additional secret key names or substrings to mask (case-insensitive, ignoring `-`, `_`, spaces).
   */
  secretKeys?: readonly string[];
  /**
   * Replacement string for masked values. Defaults to `"[REDACTED]"`.
   */
  redactionMask?: string;
}

export interface ConfigModuleOptions<T extends object = ConfigObject> {
  /**
   * If `true`, values resolved by `ConfigService.get()` are cached in memory.
   * Cache entries are updated/invalidated automatically on `ConfigService.set()`.
   * Defaults to `false`.
   */
  cache?: boolean;
  /**
   * Path or ordered list of `.env` file paths to load.
   * Earlier entries take precedence over later entries (e.g. `[".env.local", ".env"]`).
   * Defaults to `".env"`.
   */
  envFilePath?: string | readonly string[];
  /**
   * Skip reading `.env` files entirely. Defaults to `false`.
   */
  ignoreEnvFile?: boolean;
  /**
   * Skip reading runtime environment variables (`process.env`). Defaults to `false`.
   */
  ignoreEnvVars?: boolean;
  /**
   * If `true`, existing environment variables (`process.env` / `envSource`) are
   * overridden by values loaded from `.env` file(s). Defaults to `false`.
   */
  override?: boolean;
  /**
   * Custom parser function used to parse `.env` file content into key-value pairs.
   * Defaults to `getDefaultParser()` (`parseEnvContent`).
   */
  parser?: Parser;
  /**
   * If `true`, `ConfigService.get()` ignores undeclared `process.env` variables and
   * only serves values from `.env` files, validated schemas/validators, `load` factories,
   * and explicit `ConfigService.set()` calls. Defaults to `false`.
   */
  skipProcessEnv?: boolean;
  /**
   * If `true` (default), predefined runtime environment variables (`process.env` / `envSource`)
   * are included in validation (`validate`, `validationClass`, `validationSchema`).
   * If `false`, only `.env` file variables are validated while predefined runtime variables
   * remain accessible as-is (unless `ignoreEnvVars` or `skipProcessEnv` is `true`).
   */
  validatePredefined?: boolean;
  /**
   * Expand `${VAR}` / `${VAR:-default}` / `$VAR` references inside loaded env values.
   * Defaults to `false`.
   */
  expandVariables?: boolean | ExpandVariablesOptions;
  /**
   * Register `ConfigModule` as a global module (`@Global()`). Defaults to `false`.
   */
  isGlobal?: boolean;
  /**
   * Custom configuration factories or `registerAs()` typed namespaces to load.
   */
  load?: ReadonlyArray<
    | ConfigFactory
    | NamespacedConfigFactory<ConfigObject, string | symbol>
    | Promise<
        ConfigFactory | NamespacedConfigFactory<ConfigObject, string | symbol>
      >
  >;
  /**
   * Custom validation function OR DTO class validated via `ValidationPipe` (`class-validator` + `class-transformer`).
   */
  validate?: ConfigValidatorFn<T> | Type<T>;
  /**
   * Explicit DTO class to validate configuration against using `ValidationPipe`.
   */
  validationClass?: Type<T>;
  /**
   * First-class Standard Schema v1 (`@standard-schema/spec`, e.g. Zod v3.24+/v4,
   * Valibot, ArkType) schema validating loaded environment variables at bootstrap
   * (NestJS v12 `@nestjs/config` parity).
   */
  validationSchema?: StandardSchemaV1<Record<string, unknown>, T>;
  /**
   * Optional overrides for `ValidationPipe` when validating against a DTO class.
   */
  validationOptions?: ValidationPipeOptions;
  /**
   * Additional secret keys to mask in `getRedactedSnapshot()` and `createSecretRedactor()`.
   */
  secretKeys?: readonly string[];
  /**
   * Replacement string for masked secret values. Defaults to `"[REDACTED]"`.
   */
  redactionMask?: string;
  /**
   * Custom environment record used instead of `process.env` (useful for isolated tests).
   */
  envSource?: Readonly<Record<string, string | undefined>>;
  /**
   * Preloaded typed configuration created via `loadConfig()` before `BunestFactory.create()`.
   * When provided, `ConfigModule.forRoot()` hydrates the DI `ConfigService` directly from
   * the preloaded snapshot without re-reading `.env` files or running validation a second time.
   */
  preloaded?: {
    readonly values: T;
    readonly service: unknown;
  };
}

export interface EnvExpansionContext {
  readonly rawEntries: ReadonlyMap<
    string,
    { readonly value: string; readonly singleQuoted: boolean }
  >;
  readonly predefinedKeys: ReadonlySet<string>;
  readonly expandOptions: ExpandVariablesOptions;
  readonly override: boolean;
  readonly ignoreEnvVars: boolean;
  readonly skipProcessEnv: boolean;
  readonly envSource?: Readonly<Record<string, string | undefined>>;
}

export interface ConfigServiceInternalOptions {
  secretKeys?: readonly string[];
  redactionMask?: string;
  cache?: boolean;
  skipProcessEnv?: boolean;
  ignoreEnvVars?: boolean;
  envSource?: Readonly<Record<string, string | undefined>>;
  envFilePaths?: readonly string[];
  parser?: Parser;
  envExpansionContexts?: EnvExpansionContext[];
  validatedSources?: object[];
  validatedKeys?: Set<string>;
  onEnvAssigned?: (key: string, value: string) => void;
}

/**
 * Thrown at bootstrap when environment or configuration validation fails.
 */
export class ConfigValidationError extends Error {
  public readonly details?: readonly ValidationErrorDetail[];

  constructor(
    message: string,
    options?: {
      details?: readonly ValidationErrorDetail[];
      cause?: unknown;
    },
  ) {
    super(
      message,
      options?.cause !== undefined ? { cause: options.cause } : undefined,
    );
    this.name = "ConfigValidationError";
    this.details = options?.details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
