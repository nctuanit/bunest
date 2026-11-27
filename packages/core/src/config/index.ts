import "../common/metadata/reflect-shim";

export {
  CONFIG_OPTIONS_TOKEN,
  CONFIG_STORE_TOKEN,
  CONFIGURATION_NAMESPACE_PREFIX,
  NAMESPACED_CONFIG_MARKER,
} from "./constants";

export type {
  ConfigChangeEvent,
  ConfigGetOptions,
  ConfigObserver,
  ConfigSubscribable,
  ConfigSubscription,
  ConfigType,
  NoInferType,
  Parser,
  Path,
  PathImpl,
  PathImpl2,
  PathValue,
} from "./types/path.types";

export type {
  BunestConfigRegistry,
  ConfigPathInput,
  DefaultConfigSchema,
  HasConcreteConfigSchema,
  RegisteredConfigPath,
  RegisteredConfigValue,
} from "./interfaces/config-registry.interface";
export {
  ConfigValidationError,
  type ConfigFactory,
  type ConfigFactoryKeyHost,
  type ConfigModuleOptions,
  type ConfigObject,
  type ConfigServiceInternalOptions,
  type ConfigValidatorFn,
  type ExpandVariablesOptions,
  type NamespacedConfigFactory,
  type SecretRedactorOptions,
} from "./interfaces/config.interface";

export {
  expandEnvEntries,
  getDefaultParser,
  loadEnvironmentVariables,
  parseEnvContent,
  parseEnvEntries,
  parseJsoncConfig,
  parseTomlConfig,
  parseYamlConfig,
  type LoadEnvOptions,
  type ParsedEnvEntry,
} from "./env-parser";

export { createSecretRedactor } from "./redactor";
export {
  getConfigToken,
  isNamespacedConfigFactory,
  registerAs,
} from "./register-as";
export { validateConfiguration } from "./validator";
export { ConfigService } from "./config.service";
export { ConfigModule } from "./config.module";
export {
  PRELOADED_CONFIG_MARKER,
  isLoadedConfig,
  loadConfig,
  type LoadConfigOptions,
  type LoadedConfig,
} from "./load-config";
export {
  CONFIG_VALUE_METADATA,
  ConfigValue,
  InjectConfig,
  type ConfigValueMetadata,
} from "./decorators/config.decorators";
export {
  ConditionalModule,
  type ConditionalModuleOptions,
} from "./conditional.module";
