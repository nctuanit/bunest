import { instantiateFromProps } from "./accessors.macro";
import {
  getClassMacroConfig,
  getCompiledMacroPlan,
  getInstanceFieldNamesFast,
  invalidateMacroPlanCache,
  updateFieldConfig,
} from "./macro-plan";
import {
  capitalize,
  defineIfAbsent,
  mergeDefinedOptions,
  readGlobalMacroDefaults,
  tagMacroDecorator,
  type BuilderObtainViaOptions,
  type BuilderOptions,
  type CompiledMacroPlan,
} from "./macro-types";
import { formatToStringValue } from "./value-ops.macro";

interface CachedBuilderTables {
  readonly version: number;
  readonly setterPrefix: string;
  readonly singularToPlural: ReadonlyMap<string, string>;
  readonly clearToPlural: ReadonlyMap<string, string>;
  readonly pluralSingularSet: ReadonlySet<string>;
}

const builderTablesCache = new WeakMap<Function, CachedBuilderTables>();

function getBuilderTables(
  ctor: Function,
  plan: CompiledMacroPlan,
  setterPrefix: string,
): CachedBuilderTables {
  const cached = builderTablesCache.get(ctor);
  if (
    cached &&
    cached.version === plan.version &&
    cached.setterPrefix === setterPrefix
  ) {
    return cached;
  }

  const singularToPlural = new Map<string, string>();
  const clearToPlural = new Map<string, string>();
  const pluralSingularSet = new Set<string>();

  for (let i = 0; i < plan.singularFields.length; i++) {
    const entry = plan.singularFields[i]!;
    pluralSingularSet.add(entry.field);
    const singleKey = setterPrefix
      ? `${setterPrefix}${capitalize(entry.singularName)}`
      : entry.singularName;
    singularToPlural.set(singleKey, entry.field);
    clearToPlural.set(`clear${capitalize(entry.field)}`, entry.field);
  }

  const tables: CachedBuilderTables = {
    version: plan.version,
    setterPrefix,
    singularToPlural,
    clearToPlural,
    pluralSingularSet,
  };
  builderTablesCache.set(ctor, tables);
  return tables;
}

export function createRuntimeBuilder(
  ctor: Function,
  options: BuilderOptions,
  initialValues?: Record<string, unknown>,
): Record<PropertyKey, unknown> {
  const buildMethodName = options.buildMethodName ?? "build";
  const setterPrefix = options.setterPrefix ?? "";
  const plan = getCompiledMacroPlan(ctor);
  const fieldMap = plan.fieldConfigMap;
  const { singularToPlural, clearToPlural, pluralSingularSet } =
    getBuilderTables(ctor, plan, setterPrefix);
  const values: Record<string, unknown> = { ...(initialValues ?? {}) };

  const normalizeSetterTarget = (prop: string): string | undefined => {
    if (!setterPrefix) return prop;
    if (prop.startsWith(setterPrefix) && prop.length > setterPrefix.length) {
      const rest = prop.slice(setterPrefix.length);
      return rest[0]!.toLowerCase() + rest.slice(1);
    }
    return undefined;
  };

  const builderTarget: Record<PropertyKey, unknown> = {};
  const proxy: Record<PropertyKey, unknown> = new Proxy(builderTarget, {
    get(_target, prop) {
      if (prop === "then" || typeof prop === "symbol") {
        return undefined;
      }
      if (prop === buildMethodName) {
        return () => {
          const finalProps: Record<string, unknown> = { ...values };
          for (const plural of pluralSingularSet) {
            if (!(plural in finalProps)) {
              const def = fieldMap[plural]?.builderDefault;
              if (!def?.hasDefault) {
                finalProps[plural] = [];
              }
            }
          }
          return instantiateFromProps(ctor, finalProps);
        };
      }
      if (prop === "toString") {
        return () =>
          `${ctor.name}Builder(${Object.entries(values)
            .map(([k, v]) => `${k}=${formatToStringValue(v)}`)
            .join(", ")})`;
      }

      const clearField = clearToPlural.get(prop);
      if (clearField) {
        return () => {
          const cur = values[clearField];
          if (cur instanceof Set) {
            values[clearField] = new Set();
          } else if (cur instanceof Map) {
            values[clearField] = new Map();
          } else {
            values[clearField] = [];
          }
          return proxy;
        };
      }

      const singularPlural = singularToPlural.get(prop);
      if (singularPlural) {
        return (...args: unknown[]) => {
          const cur = values[singularPlural];
          if (args.length >= 2 || cur instanceof Map) {
            const map = cur instanceof Map ? new Map(cur) : new Map();
            map.set(args[0], args[1]);
            values[singularPlural] = map;
          } else if (cur instanceof Set) {
            const next = new Set(cur);
            next.add(args[0]);
            values[singularPlural] = next;
          } else {
            const arr = Array.isArray(cur) ? [...cur] : [];
            arr.push(args[0]);
            values[singularPlural] = arr;
          }
          return proxy;
        };
      }

      const targetField = normalizeSetterTarget(prop);
      if (targetField) {
        return (value: unknown) => {
          if (pluralSingularSet.has(targetField)) {
            if (value instanceof Set) {
              const base =
                values[targetField] instanceof Set
                  ? new Set(values[targetField] as Set<unknown>)
                  : new Set<unknown>();
              for (const item of value) base.add(item);
              values[targetField] = base;
            } else if (value instanceof Map) {
              const base =
                values[targetField] instanceof Map
                  ? new Map(values[targetField] as Map<unknown, unknown>)
                  : new Map<unknown, unknown>();
              for (const [k, v] of value) base.set(k, v);
              values[targetField] = base;
            } else if (Array.isArray(value)) {
              const base = Array.isArray(values[targetField])
                ? [...(values[targetField] as unknown[])]
                : [];
              base.push(...value);
              values[targetField] = base;
            } else {
              values[targetField] = value;
            }
          } else {
            values[targetField] = value;
          }
          return proxy;
        };
      }

      return undefined;
    },
  });

  return proxy;
}

export function installBuilderMethods(
  ctor: Function,
  options: BuilderOptions = {},
): void {
  const builderMethodName = options.builderMethodName ?? "builder";

  defineIfAbsent(ctor, builderMethodName, {
    enumerable: false,
    configurable: true,
    writable: true,
    value: function () {
      return createRuntimeBuilder(ctor, options);
    },
  });

  if (options.toBuilder) {
    defineIfAbsent(ctor.prototype, "toBuilder", {
      enumerable: false,
      configurable: true,
      writable: true,
      value: function (this: Record<string, unknown>) {
        const plan = getCompiledMacroPlan(ctor);
        const fieldMap = plan.fieldConfigMap;
        const fields = getInstanceFieldNamesFast(plan, this);
        const seed: Record<string, unknown> = {};
        for (let i = 0; i < fields.length; i++) {
          const field = fields[i]!;
          const obtain = fieldMap[field]?.builderObtainVia;
          if (obtain?.method && typeof this[obtain.method] === "function") {
            seed[field] = (this[obtain.method] as () => unknown)();
          } else if (obtain?.field) {
            seed[field] = this[obtain.field];
          } else if (field in this) {
            const val = this[field];
            if (Array.isArray(val)) seed[field] = [...val];
            else if (val instanceof Set) seed[field] = new Set(val);
            else if (val instanceof Map) seed[field] = new Map(val);
            else seed[field] = val;
          }
        }
        return createRuntimeBuilder(ctor, options, seed);
      },
    });
  }
}

interface BuilderDecorator {
  (options?: BuilderOptions): ClassDecorator;
  Default: (valueOrFactory: unknown) => PropertyDecorator;
  ObtainVia: (options: BuilderObtainViaOptions) => PropertyDecorator;
}

/**
 * Generates a fluent static `Class.builder()...build()` builder (with inheritance, `@Builder.Default`,
 * `@Singular`, and optional `toBuilder()` support).
 */
export const Builder: BuilderDecorator = Object.assign(
  function Builder(options: BuilderOptions = {}): ClassDecorator {
    return tagMacroDecorator((target: Function): void => {
      const effective = mergeDefinedOptions(
        readGlobalMacroDefaults().builder,
        options,
      );
      const cfg = getClassMacroConfig(target);
      cfg.builder = { ...effective };
      invalidateMacroPlanCache(target);
      installBuilderMethods(target, effective);
    }, "Builder");
  },
  {
    Default(valueOrFactory: unknown): PropertyDecorator {
      return (target: object, propertyKey: string | symbol): void => {
        updateFieldConfig(target, propertyKey, {
          builderDefault: { hasDefault: true, value: valueOrFactory },
        });
      };
    },
    ObtainVia(options: BuilderObtainViaOptions): PropertyDecorator {
      return (target: object, propertyKey: string | symbol): void => {
        updateFieldConfig(target, propertyKey, {
          builderObtainVia: options,
        });
      };
    },
  },
);

/**
 * Inheritance-aware fluent builder (`extends`-friendly counterpart of `@Builder()`).
 */
export function SuperBuilder(options: BuilderOptions = {}): ClassDecorator {
  return tagMacroDecorator((target: Function): void => {
    const effective = mergeDefinedOptions(
      readGlobalMacroDefaults().builder,
      options,
    );
    const cfg = getClassMacroConfig(target);
    cfg.builder = { ...effective, superBuilder: true };
    invalidateMacroPlanCache(target);
    installBuilderMethods(target, effective);
  }, "SuperBuilder");
}

/**
 * Marks an Array / Set / Map property for single-item builder accumulation
 * (`.tag(item)`, `.tags(items)`, `.clearTags()`).
 */
export function Singular(singularName?: string): PropertyDecorator {
  return (target: object, propertyKey: string | symbol): void => {
    updateFieldConfig(target, propertyKey, {
      singular: true,
      singularName,
    });
  };
}
