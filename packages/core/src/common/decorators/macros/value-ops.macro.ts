import { METADATA_KEYS } from "../../constants/metadata-keys";
import { MetadataRegistry } from "../../metadata/metadata-registry";
import {
  applyNonNullParamWrappers,
  installStaticFactories,
  installWithMethods,
  instantiateFromProps,
} from "./accessors.macro";
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
  extractGlobalToStringDefaults,
  mergeDefinedOptions,
  mergeOptionalOptions,
  readGlobalMacroDefaults,
  tagMacroDecorator,
  type ClassMacroConfig,
  type CompiledMacroPlan,
  type DataOptions,
  type EqualsAndHashCodeOptions,
  type JsonSerializableOptions,
  type ToStringIncludeOptions,
  type ToStringOptions,
  type ValueOptions,
} from "./macro-types";

// ============================================================================
// Deep Structural Equality & Deterministic 32-bit FNV-1a HashCode
// ============================================================================

export function deepEqual(
  a: unknown,
  b: unknown,
  deep: boolean,
  seen: WeakMap<object, WeakSet<object>> = new WeakMap(),
): boolean {
  if (Object.is(a, b)) return true;
  if (!deep) return false;
  if (
    a === null ||
    b === null ||
    typeof a !== "object" ||
    typeof b !== "object"
  ) {
    return false;
  }

  if (a instanceof Date && b instanceof Date) {
    return Object.is(a.getTime(), b.getTime());
  }
  if (a instanceof RegExp && b instanceof RegExp) {
    return a.source === b.source && a.flags === b.flags;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i], true, seen)) return false;
    }
    return true;
  }
  if (a instanceof Set && b instanceof Set) {
    if (a.size !== b.size) return false;
    for (const v of a) {
      if (!b.has(v)) return false;
    }
    return true;
  }
  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) return false;
    for (const [k, v] of a) {
      if (!b.has(k) || !deepEqual(v, b.get(k), true, seen)) return false;
    }
    return true;
  }

  let bSet = seen.get(a);
  if (bSet?.has(b)) return true;
  if (!bSet) {
    bSet = new WeakSet();
    seen.set(a, bSet);
  }
  bSet.add(b);

  if (
    typeof (a as { equals?: unknown }).equals === "function" &&
    Object.getPrototypeOf(a) === Object.getPrototypeOf(b)
  ) {
    return Boolean((a as { equals(o: unknown): boolean }).equals(b));
  }

  const keysA = Object.keys(a as Record<string, unknown>);
  const keysB = Object.keys(b as Record<string, unknown>);
  if (keysA.length !== keysB.length) return false;
  for (let i = 0; i < keysA.length; i++) {
    const key = keysA[i]!;
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (
      !deepEqual(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
        true,
        seen,
      )
    ) {
      return false;
    }
  }
  return true;
}

export function fnv1aMix(hash: number, str: string): number {
  let h = hash | 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h | 0;
}

export function hashValue(
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
): number {
  let h = 0x811c9dc5 | 0;
  if (value === null) return fnv1aMix(h, "null");
  if (value === undefined) return fnv1aMix(h, "undef");
  const t = typeof value;
  if (t === "string") return fnv1aMix(h, `s:${value}`);
  if (t === "number")
    return fnv1aMix(h, `n:${Object.is(value, -0) ? "0" : String(value)}`);
  if (t === "boolean") return fnv1aMix(h, value ? "b:1" : "b:0");
  if (t === "bigint") return fnv1aMix(h, `bi:${value.toString()}`);
  if (t === "symbol") return fnv1aMix(h, `sym:${String(value)}`);
  if (t !== "object") return h;

  const obj = value as object;
  if (seen.has(obj)) return fnv1aMix(h, "cycle");
  seen.add(obj);

  if (obj instanceof Date) {
    return fnv1aMix(h, `date:${obj.getTime()}`);
  }
  if (obj instanceof RegExp) {
    return fnv1aMix(h, `re:${obj.source}/${obj.flags}`);
  }
  if (Array.isArray(obj)) {
    h = fnv1aMix(h, `arr:${obj.length}`);
    for (let i = 0; i < obj.length; i++) {
      h = Math.imul(h ^ hashValue(obj[i], seen), 0x01000193) | 0;
    }
    return h >>> 0;
  }
  if (obj instanceof Set) {
    let acc = 0;
    for (const v of obj) {
      acc = (acc + hashValue(v, seen)) | 0;
    }
    return fnv1aMix(h, `set:${obj.size}:${acc}`) >>> 0;
  }
  if (obj instanceof Map) {
    let acc = 0;
    for (const [k, v] of obj) {
      acc = (acc + (hashValue(k, seen) ^ hashValue(v, seen))) | 0;
    }
    return fnv1aMix(h, `map:${obj.size}:${acc}`) >>> 0;
  }
  if (typeof (obj as { hashCode?: unknown }).hashCode === "function") {
    return Number((obj as { hashCode(): number }).hashCode()) >>> 0;
  }
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!;
    h = fnv1aMix(h, key);
    h =
      Math.imul(
        h ^ hashValue((obj as Record<string, unknown>)[key], seen),
        0x01000193,
      ) | 0;
  }
  return h >>> 0;
}

export function formatToStringValue(val: unknown): string {
  if (val === null) return "null";
  if (val === undefined) return "undefined";
  if (typeof val === "string") return val;
  if (
    typeof val === "number" ||
    typeof val === "boolean" ||
    typeof val === "bigint"
  ) {
    return String(val);
  }
  if (val instanceof Date) return val.toISOString();
  if (Array.isArray(val)) return `[${val.map(formatToStringValue).join(", ")}]`;
  if (typeof val === "object") {
    if (
      typeof (val as { toString?: unknown }).toString === "function" &&
      (val as { toString: () => string }).toString !== Object.prototype.toString
    ) {
      return (val as { toString: () => string }).toString();
    }
    try {
      return JSON.stringify(val);
    } catch {
      return "[Object]";
    }
  }
  return String(val);
}

// ============================================================================
// Pre-Compiled Hot-Path Installers (`toString`, `equals`, `hashCode`, `toJSON`)
// ============================================================================

interface CompiledToStringField {
  readonly name: string;
  readonly label: string;
  readonly rank: number;
  readonly masked: boolean;
  readonly maskText: string;
}

export function installToStringMethod(
  ctor: Function,
  options: ToStringOptions = {},
): void {
  const excludeSet = new Set(options.exclude ?? []);
  const includeSet = new Set(options.include ?? []);
  const maskSet = new Set(options.mask ?? []);
  const defaultMask = options.maskValue ?? "***";
  const includeFieldNames = options.includeFieldNames !== false;
  const onlyExplicit = options.onlyExplicitlyIncluded === true;
  const callSuper = options.callSuper === true;

  let cachedVersion = -1;
  let cachedBaseEntries: CompiledToStringField[] = [];

  const getBaseEntries = (plan: CompiledMacroPlan): CompiledToStringField[] => {
    if (cachedVersion === plan.version) {
      return cachedBaseEntries;
    }
    const entries: CompiledToStringField[] = [];
    const fieldMap = plan.fieldConfigMap;
    const baseFields = plan.baseKnownFields;
    for (let i = 0; i < baseFields.length; i++) {
      const field = baseFields[i]!;
      const fCfg = fieldMap[field];
      if (fCfg?.toStringExclude || excludeSet.has(field)) continue;
      if (onlyExplicit && !fCfg?.toStringInclude && !includeSet.has(field)) {
        continue;
      }
      const masked = Boolean(fCfg?.secret || maskSet.has(field));
      entries.push({
        name: field,
        label: fCfg?.toStringName ?? field,
        rank: fCfg?.toStringRank ?? 0,
        masked,
        maskText: fCfg?.secretMask ?? defaultMask,
      });
    }
    entries.sort((a, b) => b.rank - a.rank);
    cachedBaseEntries = entries;
    cachedVersion = plan.version;
    return entries;
  };

  defineIfAbsent(ctor.prototype, "toString", {
    enumerable: false,
    configurable: true,
    writable: true,
    value: function (this: Record<string, unknown>): string {
      const plan = getCompiledMacroPlan(ctor);
      const baseEntries = getBaseEntries(plan);
      const allFields = getInstanceFieldNamesFast(plan, this);

      let entries: readonly CompiledToStringField[];
      if (allFields === plan.baseKnownFields) {
        entries = baseEntries;
      } else {
        const fieldMap = plan.fieldConfigMap;
        const dynamicEntries: CompiledToStringField[] = [];
        for (let i = 0; i < allFields.length; i++) {
          const field = allFields[i]!;
          const fCfg = fieldMap[field];
          if (fCfg?.toStringExclude || excludeSet.has(field)) continue;
          if (
            onlyExplicit &&
            !fCfg?.toStringInclude &&
            !includeSet.has(field)
          ) {
            continue;
          }
          const masked = Boolean(fCfg?.secret || maskSet.has(field));
          dynamicEntries.push({
            name: field,
            label: fCfg?.toStringName ?? field,
            rank: fCfg?.toStringRank ?? 0,
            masked,
            maskText: fCfg?.secretMask ?? defaultMask,
          });
        }
        dynamicEntries.sort((a, b) => b.rank - a.rank);
        entries = dynamicEntries;
      }

      const parts: string[] = [];
      if (callSuper) {
        const parentProto = Object.getPrototypeOf(ctor.prototype) as {
          toString?: () => string;
        } | null;
        if (
          parentProto &&
          parentProto !== Object.prototype &&
          typeof parentProto.toString === "function"
        ) {
          parts.push(`super=${parentProto.toString.call(this)}`);
        }
      }
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]!;
        const rendered = entry.masked
          ? entry.maskText
          : formatToStringValue(this[entry.name]);
        parts.push(
          includeFieldNames ? `${entry.label}=${rendered}` : rendered,
        );
      }

      return `${ctor.name}(${parts.join(", ")})`;
    },
  });
}

export function installEqualsAndHashCodeMethods(
  ctor: Function,
  options: EqualsAndHashCodeOptions = {},
): void {
  const excludeSet = new Set(options.exclude ?? []);
  const includeSet = new Set(options.include ?? []);
  const onlyExplicit = options.onlyExplicitlyIncluded === true;
  const deep = options.deep !== false;
  const callSuper = options.callSuper === true;

  let cachedVersion = -1;
  let cachedBaseFields: string[] = [];
  let cachedBaseSortedFields: string[] = [];

  const ensureBaseCache = (plan: CompiledMacroPlan): void => {
    if (cachedVersion === plan.version) {
      return;
    }
    const fieldMap = plan.fieldConfigMap;
    const selected: string[] = [];
    const baseFields = plan.baseKnownFields;
    for (let i = 0; i < baseFields.length; i++) {
      const field = baseFields[i]!;
      const fCfg = fieldMap[field];
      if (fCfg?.equalsExclude || excludeSet.has(field)) continue;
      if (onlyExplicit && !fCfg?.equalsInclude && !includeSet.has(field)) {
        continue;
      }
      selected.push(field);
    }
    cachedBaseFields = selected;
    cachedBaseSortedFields = [...selected].sort();
    cachedVersion = plan.version;
  };

  const selectFields = (
    plan: CompiledMacroPlan,
    instance: Record<string, unknown>,
  ): readonly string[] => {
    ensureBaseCache(plan);
    const allFields = getInstanceFieldNamesFast(plan, instance);
    if (allFields === plan.baseKnownFields) {
      return cachedBaseFields;
    }
    const fieldMap = plan.fieldConfigMap;
    const selected: string[] = [];
    for (let i = 0; i < allFields.length; i++) {
      const field = allFields[i]!;
      const fCfg = fieldMap[field];
      if (fCfg?.equalsExclude || excludeSet.has(field)) continue;
      if (onlyExplicit && !fCfg?.equalsInclude && !includeSet.has(field)) {
        continue;
      }
      selected.push(field);
    }
    return selected;
  };

  defineIfAbsent(ctor.prototype, "equals", {
    enumerable: false,
    configurable: true,
    writable: true,
    value: function (this: Record<string, unknown>, other: unknown): boolean {
      if (this === other) return true;
      if (other === null || other === undefined || typeof other !== "object") {
        return false;
      }
      if (Object.getPrototypeOf(this) !== Object.getPrototypeOf(other)) {
        return false;
      }
      if (callSuper) {
        const parentProto = Object.getPrototypeOf(ctor.prototype) as {
          equals?: (o: unknown) => boolean;
        } | null;
        if (
          parentProto &&
          parentProto !== Object.prototype &&
          typeof parentProto.equals === "function" &&
          !parentProto.equals.call(this, other)
        ) {
          return false;
        }
      }

      const plan = getCompiledMacroPlan(ctor);
      const otherRec = other as Record<string, unknown>;
      const fieldsA = selectFields(plan, this);
      const fieldsB = selectFields(plan, otherRec);

      // Zero-allocation fast path when both instances match compiled class fields
      if (fieldsA === fieldsB) {
        for (let i = 0; i < fieldsA.length; i++) {
          const field = fieldsA[i]!;
          if (!deepEqual(this[field], otherRec[field], deep)) {
            return false;
          }
        }
        return true;
      }

      const union = new Set<string>(fieldsA);
      for (let i = 0; i < fieldsB.length; i++) {
        union.add(fieldsB[i]!);
      }
      for (const field of union) {
        if (!deepEqual(this[field], otherRec[field], deep)) {
          return false;
        }
      }
      return true;
    },
  });

  defineIfAbsent(ctor.prototype, "hashCode", {
    enumerable: false,
    configurable: true,
    writable: true,
    value: function (this: Record<string, unknown>): number {
      let h = fnv1aMix(0x811c9dc5 | 0, ctor.name);
      if (callSuper) {
        const parentProto = Object.getPrototypeOf(ctor.prototype) as {
          hashCode?: () => number;
        } | null;
        if (
          parentProto &&
          parentProto !== Object.prototype &&
          typeof parentProto.hashCode === "function"
        ) {
          h = Math.imul(h ^ parentProto.hashCode.call(this), 0x01000193) | 0;
        }
      }
      const plan = getCompiledMacroPlan(ctor);
      const selected = selectFields(plan, this);
      const fields =
        selected === cachedBaseFields
          ? cachedBaseSortedFields
          : [...selected].sort();
      for (let i = 0; i < fields.length; i++) {
        const field = fields[i]!;
        h = fnv1aMix(h, field);
        h = Math.imul(h ^ hashValue(this[field]), 0x01000193) | 0;
      }
      return h >>> 0;
    },
  });
}

export function installJsonMethods(
  ctor: Function,
  options: JsonSerializableOptions = {},
): void {
  const omitSecrets = options.omitSecrets !== false;
  const excludeSet = new Set(options.exclude ?? []);
  const excludeToStringExcluded = options.includeToStringExcluded === false;

  let cachedVersion = -1;
  let cachedBaseFields: string[] = [];

  const getBaseFields = (plan: CompiledMacroPlan): string[] => {
    if (cachedVersion === plan.version) {
      return cachedBaseFields;
    }
    const fieldMap = plan.fieldConfigMap;
    const out: string[] = [];
    const baseFields = plan.baseKnownFields;
    for (let i = 0; i < baseFields.length; i++) {
      const key = baseFields[i]!;
      if (excludeSet.has(key)) continue;
      const fCfg = fieldMap[key];
      if (omitSecrets && fCfg?.secret && fCfg.secretOmitFromJson !== false) {
        continue;
      }
      if (excludeToStringExcluded && fCfg?.toStringExclude) {
        continue;
      }
      out.push(key);
    }
    cachedBaseFields = out;
    cachedVersion = plan.version;
    return out;
  };

  defineIfAbsent(ctor.prototype, "toJSON", {
    enumerable: false,
    configurable: true,
    writable: true,
    value: function (this: Record<string, unknown>): Record<string, unknown> {
      const plan = getCompiledMacroPlan(ctor);
      const allFields = getInstanceFieldNamesFast(plan, this);
      const out: Record<string, unknown> = {};

      if (allFields === plan.baseKnownFields) {
        const keys = getBaseFields(plan);
        for (let i = 0; i < keys.length; i++) {
          const key = keys[i]!;
          if (key in this) {
            out[key] = this[key];
          }
        }
        return out;
      }

      const fieldMap = plan.fieldConfigMap;
      for (let i = 0; i < allFields.length; i++) {
        const key = allFields[i]!;
        if (!(key in this)) continue;
        if (excludeSet.has(key)) continue;
        const fCfg = fieldMap[key];
        if (omitSecrets && fCfg?.secret && fCfg.secretOmitFromJson !== false) {
          continue;
        }
        if (excludeToStringExcluded && fCfg?.toStringExclude) {
          continue;
        }
        out[key] = this[key];
      }
      return out;
    },
  });

  defineIfAbsent(ctor, "fromJSON", {
    enumerable: false,
    configurable: true,
    writable: true,
    value: function (raw: unknown): Record<string, unknown> {
      const parsed =
        typeof raw === "string"
          ? (JSON.parse(raw) as Record<string, unknown>)
          : ((raw ?? {}) as Record<string, unknown>);
      const cfg = MetadataRegistry.get<ClassMacroConfig>(
        METADATA_KEYS.CLASS_MACROS,
        ctor,
      );
      if (cfg?.builder) {
        const bMethod = cfg.builder.builderMethodName ?? "builder";
        const buildMethod = cfg.builder.buildMethodName ?? "build";
        const builderFn = (
          ctor as unknown as Record<string, () => Record<string, unknown>>
        )[bMethod];
        if (typeof builderFn === "function") {
          const builder = builderFn.call(ctor);
          const prefix = cfg.builder.setterPrefix ?? "";
          for (const [k, v] of Object.entries(parsed)) {
            const method = prefix ? `${prefix}${capitalize(k)}` : k;
            const setter = builder[method];
            if (typeof setter === "function") {
              (setter as (val: unknown) => unknown).call(builder, v);
            }
          }
          const finish = builder[buildMethod];
          if (typeof finish === "function") {
            return (finish as () => Record<string, unknown>).call(builder);
          }
        }
      }
      return instantiateFromProps(ctor, parsed);
    },
  });
}

// ============================================================================
// Public Value-Ops Decorators (`ToString`, `EqualsAndHashCode`, `JsonSerializable`, `Data`, `Value`)
// ============================================================================

interface ToStringDecorator {
  (options?: ToStringOptions): ClassDecorator;
  Include: (options?: ToStringIncludeOptions) => PropertyDecorator;
  Exclude: () => PropertyDecorator;
}

/**
 * Generates a structured `toString()` method with `include`, `exclude`, `mask`, `callSuper`, and `@Secret()` support.
 */
export const ToString: ToStringDecorator = Object.assign(
  function ToString(options: ToStringOptions = {}): ClassDecorator {
    return tagMacroDecorator((target: Function): void => {
      const effective = mergeDefinedOptions(
        extractGlobalToStringDefaults(),
        options,
      );
      const cfg = getClassMacroConfig(target);
      cfg.toStringConfig = effective;
      invalidateMacroPlanCache(target);
      installToStringMethod(target, effective);
    }, "ToString");
  },
  {
    Include(options: ToStringIncludeOptions = {}): PropertyDecorator {
      return (target: object, propertyKey: string | symbol): void => {
        updateFieldConfig(target, propertyKey, {
          toStringInclude: true,
          toStringName: options.name,
          toStringRank: options.rank,
        });
      };
    },
    Exclude(): PropertyDecorator {
      return (target: object, propertyKey: string | symbol): void => {
        updateFieldConfig(target, propertyKey, {
          toStringExclude: true,
        });
      };
    },
  },
);

interface EqualsAndHashCodeDecorator {
  (options?: EqualsAndHashCodeOptions): ClassDecorator;
  Include: () => PropertyDecorator;
  Exclude: () => PropertyDecorator;
}

/**
 * Generates structural `equals(other)` and deterministic 32-bit `hashCode()` methods.
 */
export const EqualsAndHashCode: EqualsAndHashCodeDecorator = Object.assign(
  function EqualsAndHashCode(
    options: EqualsAndHashCodeOptions = {},
  ): ClassDecorator {
    return tagMacroDecorator((target: Function): void => {
      const effective = mergeDefinedOptions(
        readGlobalMacroDefaults().equalsAndHashCode,
        options,
      );
      const cfg = getClassMacroConfig(target);
      cfg.equalsAndHashCode = effective;
      invalidateMacroPlanCache(target);
      installEqualsAndHashCodeMethods(target, effective);
    }, "EqualsAndHashCode");
  },
  {
    Include(): PropertyDecorator {
      return (target: object, propertyKey: string | symbol): void => {
        updateFieldConfig(target, propertyKey, { equalsInclude: true });
      };
    },
    Exclude(): PropertyDecorator {
      return (target: object, propertyKey: string | symbol): void => {
        updateFieldConfig(target, propertyKey, { equalsExclude: true });
      };
    },
  },
);

/**
 * Full model/DTO macro: attaches `of()`, `from()`, `with()`, `clone()`, `equals()`, `hashCode()`,
 * `toString()`, `toJSON()`, `fromJSON()`, and `getX()`/`setX()` accessors.
 */
export function Data(options: DataOptions = {}): ClassDecorator {
  return tagMacroDecorator((target: Function): void => {
    const defaults = readGlobalMacroDefaults();
    const effective = mergeDefinedOptions(defaults.data, options);
    const cfg = getClassMacroConfig(target);
    cfg.data = effective;

    const effectiveAccessors = mergeOptionalOptions(
      defaults.accessors,
      defaults.data?.accessors,
      options.accessors,
    );
    if (effectiveAccessors && !cfg.accessors) {
      cfg.accessors = effectiveAccessors;
    }
    if (effective.fields) {
      cfg.explicitFields = [
        ...new Set([...(cfg.explicitFields ?? []), ...effective.fields]),
      ];
    }
    invalidateMacroPlanCache(target);

    const effectiveToStringBase = mergeOptionalOptions(
      extractGlobalToStringDefaults(defaults),
      defaults.data?.toStringOptions,
      options.toStringOptions,
    );
    const mergedExclude = [
      ...(effective.exclude ?? []),
      ...(effectiveToStringBase?.exclude ?? []),
    ];
    const mergedMask = [
      ...(effective.mask ?? []),
      ...(effectiveToStringBase?.mask ?? []),
    ];

    const effectiveEqualsBase = mergeOptionalOptions(
      defaults.equalsAndHashCode,
      defaults.data?.equalsAndHashCode,
      options.equalsAndHashCode,
    );

    const effectiveJsonBase = defaults.jsonSerializable;
    const mergedJsonExclude =
      effectiveJsonBase?.exclude || effective.mask
        ? [...(effectiveJsonBase?.exclude ?? []), ...(effective.mask ?? [])]
        : undefined;

    installStaticFactories(target);
    installWithMethods(target, effective.fields);
    installToStringMethod(target, {
      ...effectiveToStringBase,
      exclude: mergedExclude,
      mask: mergedMask,
    });
    installEqualsAndHashCodeMethods(target, {
      ...effectiveEqualsBase,
      exclude: [
        ...(effective.exclude ?? []),
        ...(effectiveEqualsBase?.exclude ?? []),
      ],
    });
    installJsonMethods(target, {
      ...effectiveJsonBase,
      ...(mergedJsonExclude ? { exclude: mergedJsonExclude } : {}),
    });
    applyNonNullParamWrappers(target);
  }, "Data");
}

/**
 * Immutable Value Object macro: like `@Data()` without setters, automatically freezing created instances.
 */
export function Value(options: ValueOptions = {}): ClassDecorator {
  return tagMacroDecorator((target: Function): void => {
    const defaults = readGlobalMacroDefaults();
    const effective = mergeDefinedOptions(defaults.value, options);
    const cfg = getClassMacroConfig(target);
    cfg.value = effective;

    const effectiveAccessors = mergeOptionalOptions(
      defaults.accessors,
      defaults.value?.accessors,
      options.accessors,
    );
    if (effectiveAccessors && !cfg.accessors) {
      cfg.accessors = effectiveAccessors;
    }
    if (effective.fields) {
      cfg.explicitFields = [
        ...new Set([...(cfg.explicitFields ?? []), ...effective.fields]),
      ];
    }
    invalidateMacroPlanCache(target);

    const effectiveToStringBase = mergeOptionalOptions(
      extractGlobalToStringDefaults(defaults),
      defaults.value?.toStringOptions,
      options.toStringOptions,
    );
    const effectiveEqualsBase = mergeOptionalOptions(
      defaults.equalsAndHashCode,
      defaults.value?.equalsAndHashCode,
      options.equalsAndHashCode,
    );
    const effectiveJsonBase = defaults.jsonSerializable;
    const mergedJsonExclude =
      effectiveJsonBase?.exclude || effective.mask
        ? [...(effectiveJsonBase?.exclude ?? []), ...(effective.mask ?? [])]
        : undefined;

    installStaticFactories(target);
    installWithMethods(target, effective.fields);
    installToStringMethod(target, {
      ...effectiveToStringBase,
      exclude: [
        ...(effective.exclude ?? []),
        ...(effectiveToStringBase?.exclude ?? []),
      ],
      mask: [
        ...(effective.mask ?? []),
        ...(effectiveToStringBase?.mask ?? []),
      ],
    });
    installEqualsAndHashCodeMethods(target, {
      ...effectiveEqualsBase,
      exclude: [
        ...(effective.exclude ?? []),
        ...(effectiveEqualsBase?.exclude ?? []),
      ],
    });
    installJsonMethods(target, {
      ...effectiveJsonBase,
      ...(mergedJsonExclude ? { exclude: mergedJsonExclude } : {}),
    });
    applyNonNullParamWrappers(target);
  }, "Value");
}

/**
 * Adds clean `toJSON()` (honoring `@Secret()`) and static `fromJSON(raw)` (routing through `builder()` when present).
 */
export function JsonSerializable(
  options: JsonSerializableOptions = {},
): ClassDecorator {
  return tagMacroDecorator((target: Function): void => {
    const effective = mergeDefinedOptions(
      readGlobalMacroDefaults().jsonSerializable,
      options,
    );
    const cfg = getClassMacroConfig(target);
    cfg.jsonSerializable = effective;
    invalidateMacroPlanCache(target);
    installJsonMethods(target, effective);
  }, "JsonSerializable");
}
