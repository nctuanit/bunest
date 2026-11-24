import { METADATA_KEYS } from "../../constants/metadata-keys";
import { MetadataRegistry } from "../../metadata/metadata-registry";
import {
  applyFieldDefaultsAndFreeze,
  assertNonNullFields,
  collectKnownFieldNames,
  getClassMacroConfig,
  getCompiledMacroPlan,
  invalidateMacroPlanCache,
  updateFieldConfig,
} from "./macro-plan";
import {
  MEMOIZE_CACHE_SYM,
  capitalize,
  defineIfAbsent,
  getGetterName,
  getSetterName,
  mergeDefinedOptions,
  mergeOptionalOptions,
  readGlobalMacroDefaults,
  tagMacroDecorator,
  toUpperSnake,
  type AccessorsOptions,
  type ClassMacroConfig,
  type FieldDefaultsOptions,
  type FieldNameConstantsOptions,
  type FieldNameConstantsState,
  type GetterOptions,
  type NonNullParamEntry,
  type SecretOptions,
  type SetterOptions,
  type WithOptions,
} from "./macro-types";

const NON_NULL_WRAPPED_SYM = Symbol("bunest:macro:nonnull_wrapped");
const INSTALLED_FIELD_METHODS_SYM = Symbol("bunest:macro:installed_fields");
const INSTALLED_ACCESSOR_KEYS_SYM = Symbol(
  "bunest:macro:installed_accessor_keys",
);
const FIELD_NAME_CONSTANTS_TARGET_SYM = Symbol(
  "bunest:macro:field_name_constants_target",
);

// ============================================================================
// Prototype Accessor / Wither / Factory Installers
// ============================================================================

export function resetInstalledAccessorMethods(ctor: Function): void {
  const proto = ctor.prototype as Record<PropertyKey, unknown>;
  const installed = (proto as Record<symbol, Set<string> | undefined>)[
    INSTALLED_FIELD_METHODS_SYM
  ];
  const installedKeys = (
    proto as Record<symbol, Set<PropertyKey> | undefined>
  )[INSTALLED_ACCESSOR_KEYS_SYM];

  if (installedKeys) {
    for (const key of installedKeys) {
      delete proto[key];
    }
    installedKeys.clear();
  }
  if (installed) {
    for (const tag of [...installed]) {
      if (
        tag.startsWith("get:") ||
        tag.startsWith("set:") ||
        tag.startsWith("fluent:")
      ) {
        installed.delete(tag);
      }
    }
  }
}

export function populateFieldNameConstants(
  ctor: Function,
  state: FieldNameConstantsState,
): void {
  const plan = getCompiledMacroPlan(ctor);
  const fieldMap = plan.fieldConfigMap;
  const onlyExplicit = state.options.onlyExplicitlyIncluded === true;
  const fields = collectKnownFieldNames(ctor, undefined, state.options.fields);
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]!;
    const fCfg = fieldMap[field];
    if (fCfg?.fieldConstantExclude) continue;
    if (onlyExplicit && !fCfg?.fieldConstantInclude) continue;
    const key = state.options.uppercase ? toUpperSnake(field) : field;
    state.known[key] = field;
  }
}

export function reinstallClassMacrosForFields(ctor: Function): void {
  invalidateMacroPlanCache(ctor);
  const cfg = MetadataRegistry.get<ClassMacroConfig>(
    METADATA_KEYS.CLASS_MACROS,
    ctor,
  );
  if (!cfg) return;

  if (
    cfg.getter ||
    cfg.setter ||
    cfg.with ||
    cfg.withBy ||
    cfg.data ||
    cfg.value
  ) {
    installFieldAccessorsOnPrototype(ctor, collectKnownFieldNames(ctor));
  }

  const fncState = (
    ctor as unknown as Record<symbol, FieldNameConstantsState | undefined>
  )[FIELD_NAME_CONSTANTS_TARGET_SYM];
  if (fncState) {
    populateFieldNameConstants(ctor, fncState);
  }
}

export function installFieldAccessorsOnPrototype(
  ctor: Function,
  fields: readonly string[],
): void {
  const plan = getCompiledMacroPlan(ctor);
  const cfg = plan.classConfig;
  if (!cfg) return;

  const proto = ctor.prototype as Record<PropertyKey, unknown>;
  let installed = (proto as Record<symbol, Set<string>>)[
    INSTALLED_FIELD_METHODS_SYM
  ];
  if (!installed) {
    installed = new Set<string>();
    Object.defineProperty(proto, INSTALLED_FIELD_METHODS_SYM, {
      value: installed,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }

  let installedAccessorKeys = (proto as Record<symbol, Set<PropertyKey>>)[
    INSTALLED_ACCESSOR_KEYS_SYM
  ];
  if (!installedAccessorKeys) {
    installedAccessorKeys = new Set<PropertyKey>();
    Object.defineProperty(proto, INSTALLED_ACCESSOR_KEYS_SYM, {
      value: installedAccessorKeys,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }

  const fieldMap = plan.fieldConfigMap;
  const accessors =
    cfg.accessors ??
    (typeof cfg.data === "object" ? cfg.data.accessors : undefined) ??
    (typeof cfg.value === "object" ? cfg.value.accessors : undefined);

  const wantsGetters =
    Boolean(cfg.getter) ||
    Boolean(cfg.value) ||
    (Boolean(cfg.data) &&
      (typeof cfg.data !== "object" || cfg.data.accessorsEnabled !== false));
  const wantsSetters =
    !cfg.value &&
    (Boolean(cfg.setter) ||
      (Boolean(cfg.data) &&
        (typeof cfg.data !== "object" || cfg.data.accessorsEnabled !== false)));
  const wantsWith = Boolean(cfg.with) || Boolean(cfg.data) || Boolean(cfg.value);
  const wantsWithBy = Boolean(cfg.withBy);

  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]!;
    const fCfg = fieldMap[field];
    const effectiveAccessors = mergeOptionalOptions(
      accessors,
      fCfg?.getterAccessors,
    );

    // Getter
    if (wantsGetters || fCfg?.getter) {
      const getterName = getGetterName(field, effectiveAccessors);
      if (effectiveAccessors?.fluent && (wantsSetters || fCfg?.setter)) {
        const keyTag = `fluent:${field}`;
        if (!installed.has(keyTag)) {
          installed.add(keyTag);
          const setterAccessors = mergeOptionalOptions(
            accessors,
            fCfg?.setterAccessors,
          );
          const chain = setterAccessors?.chain !== false;
          if (
            defineIfAbsent(proto, getterName, {
              enumerable: false,
              configurable: true,
              writable: true,
              value: function (
                this: Record<string, unknown>,
                ...args: unknown[]
              ) {
                if (args.length === 0) {
                  return this[field];
                }
                const nextVal = args[0];
                if (
                  fCfg?.nonNull &&
                  (nextVal === null || nextVal === undefined)
                ) {
                  throw new TypeError(
                    fCfg.nonNullMessage ??
                      `@NonNull() constraint violated: ${ctor.name}.${field} must not be null or undefined.`,
                  );
                }
                this[field] = nextVal;
                return chain ? this : undefined;
              },
            })
          ) {
            installedAccessorKeys.add(getterName);
          }
        }
      } else {
        const keyTag = `get:${field}:${getterName}`;
        if (!installed.has(keyTag)) {
          installed.add(keyTag);
          if (
            defineIfAbsent(proto, getterName, {
              enumerable: false,
              configurable: true,
              writable: true,
              value: function (this: Record<string, unknown>) {
                return this[field];
              },
            })
          ) {
            installedAccessorKeys.add(getterName);
          }
        }
      }
    }

    // Setter (non-fluent, or fluent without getter)
    if (
      (wantsSetters || fCfg?.setter) &&
      !(effectiveAccessors?.fluent && (wantsGetters || fCfg?.getter))
    ) {
      const setterAccessors = mergeOptionalOptions(
        accessors,
        fCfg?.setterAccessors,
      );
      const setterName = getSetterName(field, setterAccessors);
      const chain = setterAccessors?.chain !== false;
      const keyTag = `set:${field}:${setterName}`;
      if (!installed.has(keyTag)) {
        installed.add(keyTag);
        if (
          defineIfAbsent(proto, setterName, {
            enumerable: false,
            configurable: true,
            writable: true,
            value: function (this: Record<string, unknown>, value: unknown) {
              if (fCfg?.nonNull && (value === null || value === undefined)) {
                throw new TypeError(
                  fCfg.nonNullMessage ??
                    `@NonNull() constraint violated: ${ctor.name}.${field} must not be null or undefined.`,
                );
              }
              this[field] = value;
              return chain ? this : undefined;
            },
          })
        ) {
          installedAccessorKeys.add(setterName);
        }
      }
    }

    // Wither: `withFieldName(value)`
    if (wantsWith || fCfg?.with) {
      const witherName = `with${capitalize(field)}`;
      const keyTag = `with:${field}`;
      if (!installed.has(keyTag)) {
        installed.add(keyTag);
        defineIfAbsent(proto, witherName, {
          enumerable: false,
          configurable: true,
          writable: true,
          value: function (this: Record<string, unknown>, value: unknown) {
            return cloneWithPatch(ctor, this, { [field]: value });
          },
        });
      }
    }

    // Functional Wither: `withFieldNameBy(updater)`
    if (wantsWithBy || fCfg?.withBy) {
      const withByName = `with${capitalize(field)}By`;
      const keyTag = `withBy:${field}`;
      if (!installed.has(keyTag)) {
        installed.add(keyTag);
        defineIfAbsent(proto, withByName, {
          enumerable: false,
          configurable: true,
          writable: true,
          value: function (
            this: Record<string, unknown>,
            updater: (current: unknown) => unknown,
          ) {
            return cloneWithPatch(ctor, this, {
              [field]: updater(this[field]),
            });
          },
        });
      }
    }
  }
}

export function instantiateFromProps(
  ctor: Function,
  props: Record<string, unknown> = {},
): Record<string, unknown> {
  let instance: Record<string, unknown>;
  try {
    instance = new (ctor as new () => Record<string, unknown>)();
  } catch {
    instance = Object.create(ctor.prototype) as Record<string, unknown>;
  }

  const plan = getCompiledMacroPlan(ctor);
  const defaults = plan.builderDefaults;
  for (let i = 0; i < defaults.length; i++) {
    const entry = defaults[i]!;
    if (entry.field in props) continue;
    const hasOwn = Object.prototype.hasOwnProperty.call(instance, entry.field);
    if (!hasOwn || instance[entry.field] === undefined) {
      const value = entry.isFactory
        ? (entry.value as () => unknown)()
        : entry.value;
      if (entry.macroReadonly) {
        Object.defineProperty(instance, entry.field, {
          value,
          enumerable: true,
          configurable: true,
          writable: false,
        });
      } else {
        instance[entry.field] = value;
      }
    }
  }

  const propKeys = Object.keys(props);
  for (let i = 0; i < propKeys.length; i++) {
    const k = propKeys[i]!;
    instance[k] = props[k];
  }

  installFieldAccessorsOnPrototype(ctor, Object.keys(instance));
  assertNonNullFields(ctor, instance, plan);
  return applyFieldDefaultsAndFreeze(ctor, instance, plan);
}

export function cloneWithPatch(
  ctor: Function,
  source: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const clone = Object.create(Object.getPrototypeOf(source)) as Record<
    string,
    unknown
  >;
  const sourceKeys = Object.keys(source);
  for (let i = 0; i < sourceKeys.length; i++) {
    const key = sourceKeys[i]!;
    if (Object.prototype.hasOwnProperty.call(patch, key)) continue;
    clone[key] = source[key];
  }
  const patchKeys = Object.keys(patch);
  for (let i = 0; i < patchKeys.length; i++) {
    const key = patchKeys[i]!;
    clone[key] = patch[key];
  }
  const plan = getCompiledMacroPlan(ctor);
  installFieldAccessorsOnPrototype(ctor, Object.keys(clone));
  assertNonNullFields(ctor, clone, plan);
  return applyFieldDefaultsAndFreeze(ctor, clone, plan);
}

export function installWithMethods(
  ctor: Function,
  extraFields?: readonly string[],
): void {
  defineIfAbsent(ctor.prototype, "with", {
    enumerable: false,
    configurable: true,
    writable: true,
    value: function (
      this: Record<string, unknown>,
      patch: Record<string, unknown>,
    ) {
      return cloneWithPatch(ctor, this, patch ?? {});
    },
  });
  installFieldAccessorsOnPrototype(
    ctor,
    collectKnownFieldNames(ctor, undefined, extraFields),
  );
}

export function installStaticFactories(ctor: Function): void {
  defineIfAbsent(ctor, "of", {
    enumerable: false,
    configurable: true,
    writable: true,
    value: function (props: Record<string, unknown> = {}) {
      return instantiateFromProps(ctor, props);
    },
  });

  defineIfAbsent(ctor, "from", {
    enumerable: false,
    configurable: true,
    writable: true,
    value: function (source: Record<string, unknown> = {}) {
      return instantiateFromProps(ctor, { ...source });
    },
  });

  defineIfAbsent(ctor.prototype, "clone", {
    enumerable: false,
    configurable: true,
    writable: true,
    value: function (this: Record<string, unknown>) {
      return cloneWithPatch(ctor, this, {});
    },
  });
}

export function applyNonNullParamWrappers(ctor: Function): void {
  const paramMap = MetadataRegistry.getOwn<
    Map<string | symbol, NonNullParamEntry[]>
  >(METADATA_KEYS.MACRO_NON_NULL_PARAMS, ctor);
  if (!paramMap) return;
  const proto = ctor.prototype as object;
  for (const [propertyKey] of paramMap) {
    const desc = Object.getOwnPropertyDescriptor(proto, propertyKey);
    if (
      desc &&
      typeof desc.value === "function" &&
      !(desc.value as unknown as Record<symbol, boolean>)[NON_NULL_WRAPPED_SYM]
    ) {
      const original = desc.value as (...args: unknown[]) => unknown;
      const wrapped = function (this: object, ...args: unknown[]) {
        const rules = paramMap.get(propertyKey) ?? [];
        for (let i = 0; i < rules.length; i++) {
          const rule = rules[i]!;
          if (args[rule.index] === null || args[rule.index] === undefined) {
            throw new TypeError(
              rule.message ??
                `@NonNull() constraint violated: ${ctor.name}.${String(propertyKey)}() argument #${rule.index} must not be null or undefined.`,
            );
          }
        }
        return original.apply(this, args);
      };
      (wrapped as unknown as Record<symbol, boolean>)[NON_NULL_WRAPPED_SYM] =
        true;
      Object.defineProperty(proto, propertyKey, {
        ...desc,
        value: wrapped,
      });
    }
  }
}

// ============================================================================
// Public Accessor / Field Decorators
// ============================================================================

/**
 * Configures naming & chaining conventions for `@Getter`, `@Setter`, `@Data`, and `@Value`.
 */
export function Accessors(
  options: AccessorsOptions = {},
): ClassDecorator & PropertyDecorator {
  return tagMacroDecorator(
    (target: object, propertyKey?: string | symbol): void => {
      if (propertyKey !== undefined) {
        updateFieldConfig(target, propertyKey, {
          getterAccessors: options,
          setterAccessors: options,
        });
        return;
      }
      const ctor = target as Function;
      const cfg = getClassMacroConfig(ctor);
      cfg.accessors = mergeDefinedOptions(
        mergeOptionalOptions(readGlobalMacroDefaults().accessors, cfg.accessors),
        options,
      );
      invalidateMacroPlanCache(ctor);
      if (cfg.getter || cfg.setter || cfg.data || cfg.value) {
        resetInstalledAccessorMethods(ctor);
        installFieldAccessorsOnPrototype(ctor, collectKnownFieldNames(ctor));
      }
    },
    "Accessors",
  );
}

/**
 * Generates getter methods (`getField()` or fluent `field()`).
 * When applied to a property with `{ lazy: true }`, caches the computed value on first access.
 */
export function Getter(
  options: GetterOptions = {},
): ClassDecorator & PropertyDecorator {
  return tagMacroDecorator(
    (target: object, propertyKey?: string | symbol): void => {
      if (propertyKey !== undefined) {
        const ctor = target.constructor;
        updateFieldConfig(target, propertyKey, {
          getter: true,
          getterLazy: options.lazy,
          getterAccessors: options.accessors,
        });
        const cfg = getClassMacroConfig(ctor);
        if (!cfg.accessors) {
          const globalAcc = readGlobalMacroDefaults().accessors;
          if (globalAcc) {
            cfg.accessors = { ...globalAcc };
          }
        }
        invalidateMacroPlanCache(ctor);
        if (options.lazy) {
          const key = String(propertyKey);
          const getterName = getGetterName(
            key,
            mergeOptionalOptions(cfg.accessors, options.accessors),
          );
          defineIfAbsent(target, getterName, {
            enumerable: false,
            configurable: true,
            writable: true,
            value: function (this: Record<PropertyKey, unknown>) {
              let cache = this[MEMOIZE_CACHE_SYM] as
                | Map<string, unknown>
                | undefined;
              if (!cache) {
                cache = new Map();
                Object.defineProperty(this, MEMOIZE_CACHE_SYM, {
                  value: cache,
                  enumerable: false,
                  configurable: true,
                  writable: true,
                });
              }
              const cacheKey = `lazy:${key}`;
              if (cache.has(cacheKey)) {
                return cache.get(cacheKey);
              }
              const raw = this[key];
              const computed =
                typeof raw === "function"
                  ? (raw as () => unknown).call(this)
                  : raw;
              cache.set(cacheKey, computed);
              return computed;
            },
          });
        } else {
          installFieldAccessorsOnPrototype(ctor, [String(propertyKey)]);
        }
        return;
      }

      const ctor = target as Function;
      const cfg = getClassMacroConfig(ctor);
      cfg.getter = options;
      if (options.fields) {
        cfg.explicitFields = [
          ...new Set([...(cfg.explicitFields ?? []), ...options.fields]),
        ];
      }
      const effectiveAccessors = mergeOptionalOptions(
        readGlobalMacroDefaults().accessors,
        cfg.accessors,
        options.accessors,
      );
      if (effectiveAccessors) {
        cfg.accessors = effectiveAccessors;
      }
      invalidateMacroPlanCache(ctor);
      installFieldAccessorsOnPrototype(
        ctor,
        collectKnownFieldNames(ctor, undefined, options.fields),
      );
    },
    "Getter",
  );
}

/**
 * Generates setter methods (`setField(value): this` by default, or fluent `field(value)`).
 */
export function Setter(
  options: SetterOptions = {},
): ClassDecorator & PropertyDecorator {
  return tagMacroDecorator(
    (target: object, propertyKey?: string | symbol): void => {
      if (propertyKey !== undefined) {
        const ctor = target.constructor;
        updateFieldConfig(target, propertyKey, {
          setter: true,
          setterAccessors: options.accessors,
        });
        const cfg = getClassMacroConfig(ctor);
        if (!cfg.accessors) {
          const globalAcc = readGlobalMacroDefaults().accessors;
          if (globalAcc) {
            cfg.accessors = { ...globalAcc };
          }
        }
        invalidateMacroPlanCache(ctor);
        installFieldAccessorsOnPrototype(ctor, [String(propertyKey)]);
        return;
      }

      const ctor = target as Function;
      const cfg = getClassMacroConfig(ctor);
      cfg.setter = options;
      if (options.fields) {
        cfg.explicitFields = [
          ...new Set([...(cfg.explicitFields ?? []), ...options.fields]),
        ];
      }
      const effectiveAccessors = mergeOptionalOptions(
        readGlobalMacroDefaults().accessors,
        cfg.accessors,
        options.accessors,
      );
      if (effectiveAccessors) {
        cfg.accessors = effectiveAccessors;
      }
      invalidateMacroPlanCache(ctor);
      installFieldAccessorsOnPrototype(
        ctor,
        collectKnownFieldNames(ctor, undefined, options.fields),
      );
    },
    "Setter",
  );
}

/**
 * Marks a field as sensitive: masks it in `toString()` (default `"***"`) and omits it from `toJSON()`.
 */
export function Secret(options: SecretOptions | string = {}): PropertyDecorator {
  const normalized: SecretOptions =
    typeof options === "string" ? { mask: options } : options;
  return (target: object, propertyKey: string | symbol): void => {
    updateFieldConfig(target, propertyKey, {
      secret: true,
      secretMask: normalized.mask ?? "***",
      secretOmitFromJson: normalized.omitFromJson ?? true,
    });
  };
}

/**
 * Generates immutable copy methods: `instance.with(patch)` and per-field `instance.withField(value)`.
 */
export function With(
  options: WithOptions = {},
): ClassDecorator & PropertyDecorator {
  return tagMacroDecorator(
    (target: object, propertyKey?: string | symbol): void => {
      if (propertyKey !== undefined) {
        const ctor = target.constructor;
        updateFieldConfig(target, propertyKey, { with: true });
        installWithMethods(ctor, [String(propertyKey)]);
        return;
      }
      const ctor = target as Function;
      const cfg = getClassMacroConfig(ctor);
      cfg.with = options;
      if (options.fields) {
        cfg.explicitFields = [
          ...new Set([...(cfg.explicitFields ?? []), ...options.fields]),
        ];
      }
      invalidateMacroPlanCache(ctor);
      installWithMethods(ctor, options.fields);
    },
    "With",
  );
}

/**
 * Generates functional immutable copy methods: `instance.withFieldBy(current => next)`.
 */
export function WithBy(
  options: WithOptions = {},
): ClassDecorator & PropertyDecorator {
  return tagMacroDecorator(
    (target: object, propertyKey?: string | symbol): void => {
      if (propertyKey !== undefined) {
        const ctor = target.constructor;
        updateFieldConfig(target, propertyKey, { withBy: true });
        installFieldAccessorsOnPrototype(ctor, [String(propertyKey)]);
        return;
      }
      const ctor = target as Function;
      const cfg = getClassMacroConfig(ctor);
      cfg.withBy = options;
      if (options.fields) {
        cfg.explicitFields = [
          ...new Set([...(cfg.explicitFields ?? []), ...options.fields]),
        ];
      }
      invalidateMacroPlanCache(ctor);
      installFieldAccessorsOnPrototype(
        ctor,
        collectKnownFieldNames(ctor, undefined, options.fields),
      );
    },
    "WithBy",
  );
}

interface FieldNameConstantsDecorator {
  (options?: FieldNameConstantsOptions): ClassDecorator;
  Include: () => PropertyDecorator;
  Exclude: () => PropertyDecorator;
}

/**
 * Attaches static `Class.Fields` (or custom `innerName`) containing strongly-typed field name constants.
 * Uses a `Proxy` fallback so TS-stripped fields (`email!: string`) resolve cleanly at runtime too.
 */
export const FieldNameConstants: FieldNameConstantsDecorator = Object.assign(
  function FieldNameConstants(
    options: FieldNameConstantsOptions = {},
  ): ClassDecorator {
    return tagMacroDecorator((target: Function): void => {
      const effective = mergeDefinedOptions(
        readGlobalMacroDefaults().fieldNameConstants,
        options,
      );
      const cfg = getClassMacroConfig(target);
      cfg.fieldNameConstants = effective;
      invalidateMacroPlanCache(target);
      const innerName = effective.innerName ?? "Fields";

      const known: Record<string, string> = {};
      const state: FieldNameConstantsState = { known, options: effective };
      populateFieldNameConstants(target, state);

      const fieldsProxy = new Proxy(known, {
        get(obj, prop) {
          if (typeof prop !== "string") return undefined;
          if (Object.prototype.hasOwnProperty.call(obj, prop)) {
            return obj[prop];
          }
          if (prop === "toJSON") {
            return () => ({ ...obj });
          }
          if (prop === "then") {
            return undefined;
          }
          // Runtime fallback for definite-assignment stripped fields (e.g. `email!: string`)
          return effective.uppercase ? prop.toLowerCase() : prop;
        },
      });

      const defined = defineIfAbsent(target, innerName, {
        enumerable: false,
        configurable: true,
        writable: false,
        value: fieldsProxy,
      });
      if (defined) {
        Object.defineProperty(target, FIELD_NAME_CONSTANTS_TARGET_SYM, {
          value: state,
          enumerable: false,
          configurable: true,
          writable: true,
        });
      }
    }, "FieldNameConstants");
  },
  {
    Include(): PropertyDecorator {
      return (target: object, propertyKey: string | symbol): void => {
        updateFieldConfig(target, propertyKey, { fieldConstantInclude: true });
      };
    },
    Exclude(): PropertyDecorator {
      return (target: object, propertyKey: string | symbol): void => {
        updateFieldConfig(target, propertyKey, { fieldConstantExclude: true });
      };
    },
  },
);

/**
 * Runtime non-null/undefined assertion decorator for class properties and method parameters.
 */
export function NonNull(
  message?: string,
): PropertyDecorator & ParameterDecorator {
  return ((
    target: object,
    propertyKey: string | symbol | undefined,
    parameterIndex?: number,
  ): PropertyDescriptor | void => {
    // Method parameter guard
    if (typeof parameterIndex === "number" && propertyKey !== undefined) {
      const ctor = target.constructor;
      const existing =
        MetadataRegistry.getOwn<Map<string | symbol, NonNullParamEntry[]>>(
          METADATA_KEYS.MACRO_NON_NULL_PARAMS,
          ctor,
        ) ?? new Map<string | symbol, NonNullParamEntry[]>();

      const list = existing.get(propertyKey) ?? [];
      list.push({ index: parameterIndex, message });
      existing.set(propertyKey, list);
      MetadataRegistry.define(
        METADATA_KEYS.MACRO_NON_NULL_PARAMS,
        existing,
        ctor,
      );

      const desc = Object.getOwnPropertyDescriptor(target, propertyKey);
      if (
        desc &&
        typeof desc.value === "function" &&
        !(desc.value as unknown as Record<symbol, boolean>)[NON_NULL_WRAPPED_SYM]
      ) {
        const original = desc.value as (...args: unknown[]) => unknown;
        const wrapped = function (this: object, ...args: unknown[]) {
          const rules = existing.get(propertyKey) ?? [];
          for (let i = 0; i < rules.length; i++) {
            const rule = rules[i]!;
            if (args[rule.index] === null || args[rule.index] === undefined) {
              throw new TypeError(
                rule.message ??
                  `@NonNull() constraint violated: ${ctor.name}.${String(propertyKey)}() argument #${rule.index} must not be null or undefined.`,
              );
            }
          }
          return original.apply(this, args);
        };
        (wrapped as unknown as Record<symbol, boolean>)[NON_NULL_WRAPPED_SYM] =
          true;
        const nextDesc: PropertyDescriptor = {
          ...desc,
          value: wrapped,
        };
        Object.defineProperty(target, propertyKey, nextDesc);
        return nextDesc;
      }
      return;
    }

    // Property guard
    if (propertyKey !== undefined) {
      updateFieldConfig(target, propertyKey, {
        nonNull: true,
        nonNullMessage: message,
      });
    }
  }) as PropertyDecorator & ParameterDecorator;
}

/**
 * Sets default field behavior for a class (e.g. `readonly: true`, overridden per-field by `@NonFinal()`).
 */
export function FieldDefaults(
  options: FieldDefaultsOptions = { readonly: true },
): ClassDecorator {
  return tagMacroDecorator((target: Function): void => {
    const cfg = getClassMacroConfig(target);
    cfg.fieldDefaults = options;
    invalidateMacroPlanCache(target);
  }, "FieldDefaults");
}

/**
 * Opts a specific field out of `@FieldDefaults({ readonly: true })` or `@Value()` freezing.
 */
export function NonFinal(): PropertyDecorator {
  return (target: object, propertyKey: string | symbol): void => {
    updateFieldConfig(target, propertyKey, { nonFinal: true });
  };
}
