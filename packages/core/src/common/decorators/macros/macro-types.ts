import type { Type } from "../../interfaces/type.interface";

// ============================================================================
// Public Option Types
// ============================================================================

export interface AccessorsOptions {
  /** Use field name directly (`user.email()` / `user.email("x")`) instead of `getEmail`/`setEmail`. */
  readonly fluent?: boolean;
  /** Return `this` from setters to allow method chaining. @default true */
  readonly chain?: boolean;
  /** Strip matching leading prefixes (e.g. `"_"` or `["_", "m_"]`) from accessor names. */
  readonly prefix?: string | readonly string[];
}

export interface GetterOptions {
  /** Cache the computed value on the instance after first access (Lombok `@Getter(lazy = true)`). */
  readonly lazy?: boolean;
  /** Override accessor naming/prefix rules for this getter. */
  readonly accessors?: AccessorsOptions;
  /** Explicit field list for class-level `@Getter()` when fields have no runtime initializers. */
  readonly fields?: readonly string[];
}

export interface SetterOptions {
  /** Override accessor naming/chaining rules for this setter. */
  readonly accessors?: AccessorsOptions;
  /** Explicit field list for class-level `@Setter()` when fields have no runtime initializers. */
  readonly fields?: readonly string[];
}

export interface ToStringOptions {
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  /** Mask listed fields in `toString()` output (e.g. `["password", "token"]`). */
  readonly mask?: readonly string[];
  /** Replacement text for masked or `@Secret()` fields. @default "***" */
  readonly maskValue?: string;
  /** Include parent class `toString()` output. @default false */
  readonly callSuper?: boolean;
  /** Render `key=value` pairs instead of bare values. @default true */
  readonly includeFieldNames?: boolean;
  /** Only include fields explicitly marked with `@ToString.Include()` or `include`. @default false */
  readonly onlyExplicitlyIncluded?: boolean;
}

export interface ToStringIncludeOptions {
  readonly name?: string;
  readonly rank?: number;
}

export interface SecretOptions {
  /** Mask string used in `toString()`. @default "***" */
  readonly mask?: string;
  /** Omit this field completely from `toJSON()`. @default true */
  readonly omitFromJson?: boolean;
}

export interface EqualsAndHashCodeOptions {
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  /** Include parent class equality/hash comparison. @default false */
  readonly callSuper?: boolean;
  /** Perform deep structural comparison for nested objects/arrays/Maps/Sets. @default true */
  readonly deep?: boolean;
  /** Only include fields explicitly marked with `@EqualsAndHashCode.Include()` or `include`. @default false */
  readonly onlyExplicitlyIncluded?: boolean;
}

export interface WithOptions {
  /** Explicit field list when class fields have no runtime initializers. */
  readonly fields?: readonly string[];
}

export interface BuilderOptions {
  /** Also generate `instance.toBuilder()` for cloning/mutating existing instances. @default false */
  readonly toBuilder?: boolean;
  /** Static factory method name. @default "builder" */
  readonly builderMethodName?: string;
  /** Terminal builder method name. @default "build" */
  readonly buildMethodName?: string;
  /** Optional prefix for builder setter methods (e.g. `"with"` -> `.withEmail(...)`). @default "" */
  readonly setterPrefix?: string;
}

export interface BuilderObtainViaOptions {
  readonly field?: string;
  readonly method?: string;
}

export interface DataOptions {
  readonly fields?: readonly string[];
  readonly accessors?: AccessorsOptions;
  readonly toStringOptions?: ToStringOptions;
  readonly equalsAndHashCode?: EqualsAndHashCodeOptions;
  /** Shorthand to exclude fields from both `toString()` and `equals()`/`hashCode()`. */
  readonly exclude?: readonly string[];
  /** Shorthand to mask sensitive fields in `toString()` and omit from `toJSON()`. */
  readonly mask?: readonly string[];
  /** Generate `getX()` / `setX()` accessors in addition to `of()`, `with()`, `equals()`, `toString()`, `toJSON()`, `clone()`. @default true */
  readonly accessorsEnabled?: boolean;
}

export interface ValueOptions {
  readonly fields?: readonly string[];
  readonly accessors?: AccessorsOptions;
  readonly toStringOptions?: ToStringOptions;
  readonly equalsAndHashCode?: EqualsAndHashCodeOptions;
  readonly exclude?: readonly string[];
  readonly mask?: readonly string[];
  /** Freeze instances created via `of()`, `from()`, `with()`, and `builder().build()`. @default true */
  readonly freeze?: boolean;
}

export interface FieldNameConstantsOptions {
  /** Static property name holding field constants. @default "Fields" */
  readonly innerName?: string;
  /** Convert constant keys to UPPER_SNAKE_CASE. @default false */
  readonly uppercase?: boolean;
  /** Only include fields marked with `@FieldNameConstants.Include()`. @default false */
  readonly onlyExplicitlyIncluded?: boolean;
  /** Explicit field list when fields have no runtime initializers. */
  readonly fields?: readonly string[];
}

export interface JsonSerializableOptions {
  /** Omit fields marked `@Secret()`. @default true */
  readonly omitSecrets?: boolean;
  /** Include fields excluded from `toString()`. @default true */
  readonly includeToStringExcluded?: boolean;
  /** Explicit field exclusion list for `toJSON()`. */
  readonly exclude?: readonly string[];
}

export interface WithLoggerOptions {
  /** Custom logger context name. Defaults to the decorated class name. */
  readonly context?: string;
  /** Property name exposed on the instance. @default "logger" */
  readonly propertyName?: string;
}

export interface MemoizeDecoratorOptions {
  /** Optional time-to-live in milliseconds for cached values. */
  readonly ttlMs?: number;
  /** Maximum number of distinct argument-key cache entries per instance. @default 256 */
  readonly maxSize?: number;
  /** Custom cache key serializer for parameterized methods. */
  readonly keyFn?: (...args: unknown[]) => unknown;
}

export interface DelegateOptions {
  /** Explicit constructor/prototype to delegate methods from (inferred via `design:type` when omitted). */
  readonly target?: Type<unknown> | Function;
  /** Explicit list of method names to forward (useful for interface-typed properties). */
  readonly methods?: readonly string[];
  /** Method names excluded from delegation. */
  readonly excludes?: readonly string[];
}

export interface StandardExceptionOptions {
  /** Default machine-readable error code attached as `this.code`. */
  readonly code?: string;
  /** Optional HTTP status code attached as `this.statusCode`. */
  readonly statusCode?: number;
}

export interface LogExecutionOptions {
  /** Log level for normal execution logs. @default "debug" */
  readonly level?: "log" | "debug" | "verbose";
  /** Emit a `warn` log when execution exceeds this threshold in milliseconds. */
  readonly slowMs?: number;
  /** Include serialized call arguments in logs. @default false */
  readonly logArgs?: boolean;
  /** Include return value in logs. @default false */
  readonly logResult?: boolean;
  /** Override logger context name. */
  readonly context?: string;
}

export interface FieldDefaultsOptions {
  /** Treat all fields (except `@NonFinal()`) as readonly on created instances. @default true */
  readonly readonly?: boolean;
}

/**
 * Project-wide default options inherited by Bunest built-in Class Macros whenever
 * per-class decorator options omit a setting. Per-class options always take precedence.
 */
export interface GlobalMacroDefaults {
  readonly accessors?: AccessorsOptions;
  /**
   * Project-wide defaults for `@ToString()` (and `toString()` inside `@Data()`/`@Value()`).
   * Structurally permits `Object.prototype.toString` so plain object literals that omit
   * `toString` (e.g. `setGlobalMacroDefaults({ builder: { toBuilder: true } })`) typecheck cleanly.
   */
  readonly toString?: ToStringOptions | (() => string);
  /** Optional alias for `toString` that avoids `Object.prototype.toString` shadowing. */
  readonly toStringOptions?: ToStringOptions;
  readonly equalsAndHashCode?: EqualsAndHashCodeOptions;
  readonly builder?: BuilderOptions;
  readonly data?: DataOptions;
  readonly value?: ValueOptions;
  readonly jsonSerializable?: JsonSerializableOptions;
  readonly withLogger?: WithLoggerOptions;
  readonly fieldNameConstants?: FieldNameConstantsOptions;
}

export const GLOBAL_MACRO_DEFAULTS_SYM: symbol = Symbol.for(
  "bunest:macro_defaults",
);

const EMPTY_GLOBAL_MACRO_DEFAULTS: GlobalMacroDefaults = Object.freeze({});

export function readGlobalMacroDefaults(): GlobalMacroDefaults {
  const stored = (
    globalThis as Record<symbol, GlobalMacroDefaults | undefined>
  )[GLOBAL_MACRO_DEFAULTS_SYM];
  return stored ?? EMPTY_GLOBAL_MACRO_DEFAULTS;
}

export function extractGlobalToStringDefaults(
  defaults: GlobalMacroDefaults = readGlobalMacroDefaults(),
): ToStringOptions | undefined {
  if (
    Object.prototype.hasOwnProperty.call(defaults, "toString") &&
    typeof defaults.toString === "object" &&
    defaults.toString !== null
  ) {
    return defaults.toString;
  }
  if (
    defaults.toStringOptions &&
    typeof defaults.toStringOptions === "object"
  ) {
    return defaults.toStringOptions;
  }
  return undefined;
}

// ============================================================================
// Internal Metadata & Pre-Compiled Plan Types
// ============================================================================

export interface MacroFieldConfig {
  getter?: boolean;
  getterLazy?: boolean;
  getterAccessors?: AccessorsOptions;
  setter?: boolean;
  setterAccessors?: AccessorsOptions;
  with?: boolean;
  withBy?: boolean;
  toStringInclude?: boolean;
  toStringName?: string;
  toStringRank?: number;
  toStringExclude?: boolean;
  secret?: boolean;
  secretMask?: string;
  secretOmitFromJson?: boolean;
  equalsInclude?: boolean;
  equalsExclude?: boolean;
  fieldConstantInclude?: boolean;
  fieldConstantExclude?: boolean;
  builderDefault?: { readonly hasDefault: true; readonly value: unknown };
  builderObtainVia?: BuilderObtainViaOptions;
  singular?: boolean;
  singularName?: string;
  nonNull?: boolean;
  nonNullMessage?: string;
  nonFinal?: boolean;
  macroReadonly?: boolean;
}

export interface ClassMacroConfig {
  accessors?: AccessorsOptions;
  getter?: GetterOptions | boolean;
  setter?: SetterOptions | boolean;
  toStringConfig?: ToStringOptions | boolean;
  equalsAndHashCode?: EqualsAndHashCodeOptions | boolean;
  with?: WithOptions | boolean;
  withBy?: WithOptions | boolean;
  builder?: BuilderOptions & { readonly superBuilder?: boolean };
  data?: DataOptions | boolean;
  value?: ValueOptions | boolean;
  fieldNameConstants?: FieldNameConstantsOptions | boolean;
  jsonSerializable?: JsonSerializableOptions | boolean;
  withLogger?: WithLoggerOptions | boolean;
  fieldDefaults?: FieldDefaultsOptions;
  utilityClass?: boolean;
  standardException?: StandardExceptionOptions | boolean;
  explicitFields?: string[];
  customMacros?: Array<{ readonly name: string; readonly options: unknown }>;
}

export interface NonNullParamEntry {
  readonly index: number;
  readonly message?: string;
}

export interface FieldNameConstantsState {
  readonly known: Record<string, string>;
  readonly options: FieldNameConstantsOptions;
}

export interface CompiledNonNullField {
  readonly field: string;
  readonly message?: string;
}

export interface CompiledBuilderDefault {
  readonly field: string;
  readonly value: unknown;
  readonly isFactory: boolean;
  readonly macroReadonly: boolean;
}

export interface CompiledSingularField {
  readonly field: string;
  readonly singularName: string;
}

/**
 * Optional AOT build-time plan registered by `@bunest/cli` (`createBunestPlugin({ aotMacros: true })`)
 * to avoid runtime `new ctor()` probing and pre-seed field metadata on startup.
 */
export interface CompiledMacroPlanInput {
  readonly fields?: readonly string[];
  readonly skipProbe?: boolean;
}

/**
 * WeakMap-cached compiled macro metadata plan per class constructor.
 * Eliminates repeated prototype-chain traversal and `new ctor()` probing on
 * `equals()`, `hashCode()`, `toString()`, `toJSON()`, `of()`, `with()`, and `clone()`.
 */
export interface CompiledMacroPlan {
  readonly version: number;
  readonly ctor: Function;
  readonly classConfig: ClassMacroConfig | undefined;
  readonly loggerProp: string | undefined;
  readonly fieldConfigMap: Readonly<Record<string, MacroFieldConfig>>;
  readonly baseKnownFields: readonly string[];
  readonly baseKnownFieldSet: ReadonlySet<string>;
  readonly nonNullFields: readonly CompiledNonNullField[];
  readonly builderDefaults: readonly CompiledBuilderDefault[];
  readonly singularFields: readonly CompiledSingularField[];
  readonly isValueFrozen: boolean;
  readonly isFieldDefaultsReadonly: boolean;
  readonly hasNonFinal: boolean;
}

// ============================================================================
// Shared Symbols
// ============================================================================

export const MACRO_DECORATOR_NAME_SYM = Symbol.for(
  "bunest:macro_decorator_name",
);

export const MEMOIZE_CACHE_SYM = Symbol("bunest:macro:memoize");

// ============================================================================
// Shared Pure Helpers
// ============================================================================

export function tagMacroDecorator<T extends Function>(
  decorator: T,
  name: string,
): T {
  Object.defineProperty(decorator, MACRO_DECORATOR_NAME_SYM, {
    value: name,
    enumerable: false,
    configurable: true,
    writable: false,
  });
  return decorator;
}

export function mergeDefinedOptions<T extends object>(
  defaults: T | undefined,
  overrides: T | undefined,
): T {
  if (!defaults) {
    return (overrides ?? {}) as T;
  }
  if (!overrides) {
    return { ...defaults };
  }
  const merged: Record<string, unknown> = {
    ...(defaults as Record<string, unknown>),
  };
  for (const [key, value] of Object.entries(
    overrides as Record<string, unknown>,
  )) {
    if (value !== undefined) {
      merged[key] = value;
    }
  }
  return merged as T;
}

export function mergeOptionalOptions<T extends object>(
  ...layers: Array<T | undefined>
): T | undefined {
  let merged: Record<string, unknown> | undefined;
  for (const layer of layers) {
    if (!layer) continue;
    for (const [key, value] of Object.entries(
      layer as Record<string, unknown>,
    )) {
      if (value !== undefined) {
        if (!merged) merged = {};
        merged[key] = value;
      }
    }
  }
  return merged as T | undefined;
}

export function capitalize(name: string): string {
  return name.length === 0 ? name : name[0]!.toUpperCase() + name.slice(1);
}

export function stripAccessorPrefix(
  fieldName: string,
  accessors?: AccessorsOptions,
): string {
  const prefixes = accessors?.prefix
    ? Array.isArray(accessors.prefix)
      ? accessors.prefix
      : [accessors.prefix]
    : [];
  for (const prefix of prefixes) {
    if (
      prefix &&
      fieldName.startsWith(prefix) &&
      fieldName.length > prefix.length
    ) {
      const rest = fieldName.slice(prefix.length);
      return rest[0]!.toLowerCase() + rest.slice(1);
    }
  }
  return fieldName;
}

export function getGetterName(
  fieldName: string,
  accessors?: AccessorsOptions,
): string {
  const clean = stripAccessorPrefix(fieldName, accessors);
  if (accessors?.fluent) {
    return clean;
  }
  return `get${capitalize(clean)}`;
}

export function getSetterName(
  fieldName: string,
  accessors?: AccessorsOptions,
): string {
  const clean = stripAccessorPrefix(fieldName, accessors);
  if (accessors?.fluent) {
    return clean;
  }
  return `set${capitalize(clean)}`;
}

export function toUpperSnake(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toUpperCase();
}

export function singularizeFieldName(name: string): string {
  if (name.endsWith("ies") && name.length > 3) {
    return `${name.slice(0, -3)}y`;
  }
  if (/(?:ches|shes|xes|zes|ses)$/i.test(name) && name.length > 3) {
    return name.slice(0, -2);
  }
  if (name.endsWith("s") && !name.endsWith("ss") && name.length > 1) {
    return name.slice(0, -1);
  }
  return name;
}

/**
 * Default `@Tolerate` semantics: never overwrites a member explicitly defined
 * on `target` by the developer.
 */
export function defineIfAbsent(
  target: object,
  key: PropertyKey,
  descriptor: PropertyDescriptor,
): boolean {
  if (Object.prototype.hasOwnProperty.call(target, key)) {
    return false;
  }
  Object.defineProperty(target, key, descriptor);
  return true;
}

export function defineMacroMemberIfAbsent(
  target: object,
  key: PropertyKey,
  descriptor: PropertyDescriptor,
): boolean {
  return defineIfAbsent(target, key, descriptor);
}
