// ============================================================================
// Bunest Class Macros Barrel (Modularized under ./macros/*)
// ============================================================================

export {
  GLOBAL_MACRO_DEFAULTS_SYM,
  MACRO_DECORATOR_NAME_SYM,
  defineMacroMemberIfAbsent,
  extractGlobalToStringDefaults,
  readGlobalMacroDefaults,
  singularizeFieldName,
  tagMacroDecorator,
  type AccessorsOptions,
  type BuilderObtainViaOptions,
  type BuilderOptions,
  type ClassMacroConfig,
  type CompiledBuilderDefault,
  type CompiledMacroPlan,
  type CompiledMacroPlanInput,
  type CompiledNonNullField,
  type CompiledSingularField,
  type DataOptions,
  type DelegateOptions,
  type EqualsAndHashCodeOptions,
  type FieldDefaultsOptions,
  type FieldNameConstantsOptions,
  type GetterOptions,
  type GlobalMacroDefaults,
  type JsonSerializableOptions,
  type LogExecutionOptions,
  type MacroFieldConfig,
  type MemoizeDecoratorOptions,
  type SecretOptions,
  type SetterOptions,
  type StandardExceptionOptions,
  type ToStringIncludeOptions,
  type ToStringOptions,
  type ValueOptions,
  type WithLoggerOptions,
  type WithOptions,
} from "./macros/macro-types";

export {
  collectKnownFieldNames,
  getCompiledMacroPlan,
  getOrCreateClassMacroConfig,
  invalidateMacroPlanCache,
  registerCompiledMacroPlan,
  updateMacroFieldConfig,
} from "./macros/macro-plan";

export {
  Accessors,
  FieldDefaults,
  FieldNameConstants,
  Getter,
  NonFinal,
  NonNull,
  Secret,
  Setter,
  With,
  WithBy,
  reinstallClassMacrosForFields,
} from "./macros/accessors.macro";

export {
  Data,
  EqualsAndHashCode,
  JsonSerializable,
  ToString,
  Value,
} from "./macros/value-ops.macro";

export {
  Builder,
  Singular,
  SuperBuilder,
} from "./macros/builder.macro";

export { Locked, Synchronized } from "./macros/concurrency.macro";

export {
  Delegate,
  LogExecution,
  Memoize,
  StandardException,
  UtilityClass,
  WithLogger,
  clearMemoizeCache,
} from "./macros/utility-logger.macro";
