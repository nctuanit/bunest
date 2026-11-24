import { METADATA_KEYS } from "../../constants/metadata-keys";
import { MetadataRegistry } from "../../metadata/metadata-registry";
import { getCachedInheritanceChain } from "../../metadata/typed-metadata";
import { getEntityColumns } from "../entity-schema.decorators";
import {
  singularizeFieldName,
  type ClassMacroConfig,
  type CompiledBuilderDefault,
  type CompiledMacroPlan,
  type CompiledMacroPlanInput,
  type CompiledNonNullField,
  type CompiledSingularField,
  type MacroFieldConfig,
} from "./macro-types";

// ============================================================================
// WeakMap-Cached CompiledMacroPlan Store
// ============================================================================

let macroPlanVersion = 1;
const compiledPlanCache = new WeakMap<Function, CompiledMacroPlan>();
const aotPlanInputs = new WeakMap<Function, CompiledMacroPlanInput>();

/**
 * Invalidates cached `CompiledMacroPlan` entries.
 * Always bumps the global version counter so subclasses inheriting from a mutated
 * base class recompute their plan lazily on next access.
 */
export function invalidateMacroPlanCache(ctor?: Function): void {
  macroPlanVersion += 1;
  if (ctor) {
    compiledPlanCache.delete(ctor);
  }
}

/**
 * Registers an AOT build-time macro plan (emitted by `createBunestPlugin({ aotMacros: true })`)
 * so runtime macro methods skip `new ctor()` probing and reuse known class fields immediately.
 */
export function registerCompiledMacroPlan(
  ctor: Function,
  input: CompiledMacroPlanInput,
): CompiledMacroPlan {
  const existing = aotPlanInputs.get(ctor);
  const mergedFields =
    existing?.fields || input.fields
      ? [...new Set([...(existing?.fields ?? []), ...(input.fields ?? [])])]
      : undefined;
  aotPlanInputs.set(ctor, {
    ...(mergedFields ? { fields: mergedFields } : {}),
    skipProbe: input.skipProbe ?? existing?.skipProbe,
  });
  if (mergedFields && mergedFields.length > 0) {
    const cfg = getClassMacroConfig(ctor);
    cfg.explicitFields = [
      ...new Set([...(cfg.explicitFields ?? []), ...mergedFields]),
    ];
  }
  invalidateMacroPlanCache(ctor);
  return getCompiledMacroPlan(ctor);
}

// ============================================================================
// Metadata Accessors (Copy-on-Write + Cache Invalidation)
// ============================================================================

export function getOrCreateClassMacroConfig(target: Function): ClassMacroConfig {
  return getClassMacroConfig(target);
}

export function getClassMacroConfig(target: Function): ClassMacroConfig {
  const existing = MetadataRegistry.getOwn<ClassMacroConfig>(
    METADATA_KEYS.CLASS_MACROS,
    target,
  );
  if (existing) {
    return existing;
  }
  const parent = MetadataRegistry.get<ClassMacroConfig>(
    METADATA_KEYS.CLASS_MACROS,
    target,
  );
  const copy: ClassMacroConfig = parent
    ? {
        ...parent,
        explicitFields: parent.explicitFields
          ? [...parent.explicitFields]
          : undefined,
        customMacros: parent.customMacros
          ? [...parent.customMacros]
          : undefined,
      }
    : {};
  MetadataRegistry.define(METADATA_KEYS.CLASS_MACROS, copy, target);
  invalidateMacroPlanCache(target);
  return copy;
}

function getOwnFieldConfigMap(
  ctor: Function,
): Record<string, MacroFieldConfig> {
  const existing = MetadataRegistry.getOwn<Record<string, MacroFieldConfig>>(
    METADATA_KEYS.MACRO_FIELD_OPTIONS,
    ctor,
  );
  if (existing) {
    return existing;
  }
  const created: Record<string, MacroFieldConfig> = {};
  MetadataRegistry.define(METADATA_KEYS.MACRO_FIELD_OPTIONS, created, ctor);
  return created;
}

export function updateMacroFieldConfig(
  protoOrCtor: object,
  propertyKey: string | symbol,
  patch: Partial<MacroFieldConfig>,
): void {
  updateFieldConfig(protoOrCtor, propertyKey, patch);
}

export function updateFieldConfig(
  protoOrCtor: object,
  propertyKey: string | symbol,
  patch: Partial<MacroFieldConfig>,
): void {
  const ctor =
    typeof protoOrCtor === "function" ? protoOrCtor : protoOrCtor.constructor;
  const map = getOwnFieldConfigMap(ctor);
  const key = String(propertyKey);
  map[key] = { ...(map[key] ?? {}), ...patch };
  invalidateMacroPlanCache(ctor);
}

// ============================================================================
// Compiled Plan Computation
// ============================================================================

function collectEntityColumnNames(ctor: Function): string[] {
  const cols = getEntityColumns(ctor);
  if (!cols || cols.length === 0) {
    return [];
  }
  const names: string[] = [];
  for (let i = 0; i < cols.length; i++) {
    names.push(cols[i]!.propertyName);
  }
  return names;
}

function probeInitializerFieldNames(ctor: Function): string[] {
  try {
    const probe = new (ctor as new () => Record<string, unknown>)();
    if (probe && typeof probe === "object") {
      return Object.keys(probe);
    }
  } catch {
    // Constructor may require arguments or be @UtilityClass; skip probe safely.
  }
  return [];
}

/**
 * Returns the cached `CompiledMacroPlan` for `ctor`, computing it once per
 * metadata version without repeated prototype-chain traversal or `new ctor()` probing.
 */
export function getCompiledMacroPlan(ctor: Function): CompiledMacroPlan {
  const cached = compiledPlanCache.get(ctor);
  if (cached && cached.version === macroPlanVersion) {
    return cached;
  }

  const chain = getCachedInheritanceChain(ctor);
  const classConfig = MetadataRegistry.get<ClassMacroConfig>(
    METADATA_KEYS.CLASS_MACROS,
    ctor,
  );
  const loggerProp =
    classConfig?.withLogger && typeof classConfig.withLogger === "object"
      ? (classConfig.withLogger.propertyName ?? "logger")
      : classConfig?.withLogger
        ? "logger"
        : undefined;

  const fieldConfigMap: Record<string, MacroFieldConfig> = {};
  const explicitFields: string[] = [];
  let skipProbe = false;

  for (let i = 0; i < chain.length; i++) {
    const fn = chain[i]!;
    const ownMacro = MetadataRegistry.getOwn<ClassMacroConfig>(
      METADATA_KEYS.CLASS_MACROS,
      fn,
    );
    if (ownMacro?.explicitFields) {
      for (let j = 0; j < ownMacro.explicitFields.length; j++) {
        explicitFields.push(ownMacro.explicitFields[j]!);
      }
    }

    const ownFields = MetadataRegistry.getOwn<Record<string, MacroFieldConfig>>(
      METADATA_KEYS.MACRO_FIELD_OPTIONS,
      fn,
    );
    if (ownFields) {
      for (const [k, v] of Object.entries(ownFields)) {
        fieldConfigMap[k] = { ...(fieldConfigMap[k] ?? {}), ...v };
      }
    }

    const aot = aotPlanInputs.get(fn);
    if (aot?.fields) {
      for (let j = 0; j < aot.fields.length; j++) {
        explicitFields.push(aot.fields[j]!);
      }
    }
    if (aot?.skipProbe) {
      skipProbe = true;
    }
  }

  const nonNullFields: CompiledNonNullField[] = [];
  const builderDefaults: CompiledBuilderDefault[] = [];
  const singularFields: CompiledSingularField[] = [];
  let hasNonFinal = false;

  for (const [field, fCfg] of Object.entries(fieldConfigMap)) {
    if (fCfg.nonNull) {
      nonNullFields.push({ field, message: fCfg.nonNullMessage });
    }
    if (fCfg.builderDefault?.hasDefault) {
      builderDefaults.push({
        field,
        value: fCfg.builderDefault.value,
        isFactory: typeof fCfg.builderDefault.value === "function",
        macroReadonly: fCfg.macroReadonly === true,
      });
    }
    if (fCfg.singular) {
      singularFields.push({
        field,
        singularName: fCfg.singularName ?? singularizeFieldName(field),
      });
    }
    if (fCfg.nonFinal) {
      hasNonFinal = true;
    }
  }

  const baseKnownFieldSet = new Set<string>();
  const addField = (name: string): void => {
    if (!name || name === loggerProp) return;
    baseKnownFieldSet.add(name);
  };

  for (const name of collectEntityColumnNames(ctor)) addField(name);
  for (const name of Object.keys(fieldConfigMap)) addField(name);
  for (let i = 0; i < explicitFields.length; i++) addField(explicitFields[i]!);
  if (!skipProbe) {
    for (const name of probeInitializerFieldNames(ctor)) addField(name);
  }

  const isValueFrozen = Boolean(
    classConfig?.value &&
      (typeof classConfig.value !== "object" ||
        classConfig.value.freeze !== false),
  );
  const isFieldDefaultsReadonly = Boolean(classConfig?.fieldDefaults?.readonly);

  const plan: CompiledMacroPlan = {
    version: macroPlanVersion,
    ctor,
    classConfig,
    loggerProp,
    fieldConfigMap,
    baseKnownFields: [...baseKnownFieldSet],
    baseKnownFieldSet,
    nonNullFields,
    builderDefaults,
    singularFields,
    isValueFrozen,
    isFieldDefaultsReadonly,
    hasNonFinal,
  };

  compiledPlanCache.set(ctor, plan);
  return plan;
}

/**
 * Returns known field names for `ctor`, leveraging the WeakMap-cached `CompiledMacroPlan`
 * and avoiding `new ctor()` probing or redundant `Set` allocations on the hot path.
 */
export function collectKnownFieldNames(
  ctor: Function,
  instance?: Record<string, unknown>,
  extraFields?: readonly string[],
): string[] {
  const plan = getCompiledMacroPlan(ctor);
  const hasExtras = Boolean(extraFields && extraFields.length > 0);

  if (!instance && !hasExtras) {
    return [...plan.baseKnownFields];
  }

  if (instance && !hasExtras) {
    const instKeys = Object.keys(instance);
    let hasUnknown = false;
    for (let i = 0; i < instKeys.length; i++) {
      const key = instKeys[i]!;
      if (key !== plan.loggerProp && !plan.baseKnownFieldSet.has(key)) {
        hasUnknown = true;
        break;
      }
    }
    if (!hasUnknown) {
      return [...plan.baseKnownFields];
    }
    const merged = new Set(plan.baseKnownFields);
    for (let i = 0; i < instKeys.length; i++) {
      const key = instKeys[i]!;
      if (key && key !== plan.loggerProp) {
        merged.add(key);
      }
    }
    return [...merged];
  }

  const seen = new Set<string>(plan.baseKnownFields);
  const add = (name: string): void => {
    if (!name || name === plan.loggerProp) return;
    seen.add(name);
  };
  if (extraFields) {
    for (let i = 0; i < extraFields.length; i++) add(extraFields[i]!);
  }
  if (instance) {
    const instKeys = Object.keys(instance);
    for (let i = 0; i < instKeys.length; i++) add(instKeys[i]!);
  }
  return [...seen];
}

/**
 * Fast internal helper returning the effective field list for an instance without
 * allocating a copy when all instance own keys are already in `plan.baseKnownFieldSet`.
 */
export function getInstanceFieldNamesFast(
  plan: CompiledMacroPlan,
  instance: Record<string, unknown>,
): readonly string[] {
  const instKeys = Object.keys(instance);
  let hasUnknown = false;
  for (let i = 0; i < instKeys.length; i++) {
    const key = instKeys[i]!;
    if (key !== plan.loggerProp && !plan.baseKnownFieldSet.has(key)) {
      hasUnknown = true;
      break;
    }
  }
  if (!hasUnknown) {
    return plan.baseKnownFields;
  }
  const merged = [...plan.baseKnownFields];
  for (let i = 0; i < instKeys.length; i++) {
    const key = instKeys[i]!;
    if (key && key !== plan.loggerProp && !plan.baseKnownFieldSet.has(key)) {
      merged.push(key);
    }
  }
  return merged;
}

export function assertNonNullFields(
  ctor: Function,
  instance: Record<string, unknown>,
  plan: CompiledMacroPlan = getCompiledMacroPlan(ctor),
): void {
  const nonNulls = plan.nonNullFields;
  for (let i = 0; i < nonNulls.length; i++) {
    const entry = nonNulls[i]!;
    const val = instance[entry.field];
    if (val === null || val === undefined) {
      throw new TypeError(
        entry.message ??
          `@NonNull() constraint violated: ${ctor.name}.${entry.field} must not be null or undefined.`,
      );
    }
  }
}

export function applyFieldDefaultsAndFreeze<T extends object>(
  ctor: Function,
  instance: T,
  plan: CompiledMacroPlan = getCompiledMacroPlan(ctor),
): T {
  const { fieldConfigMap, isFieldDefaultsReadonly, isValueFrozen, hasNonFinal } =
    plan;

  if (isFieldDefaultsReadonly) {
    const keys = Object.keys(instance);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]!;
      if (fieldConfigMap[key]?.nonFinal) continue;
      const desc = Object.getOwnPropertyDescriptor(instance, key);
      if (desc && desc.configurable && "value" in desc) {
        Object.defineProperty(instance, key, {
          ...desc,
          writable: false,
        });
      }
    }
  }

  if (isValueFrozen) {
    if (!hasNonFinal) {
      Object.freeze(instance);
    } else {
      const keys = Object.keys(instance);
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i]!;
        if (fieldConfigMap[key]?.nonFinal) continue;
        const desc = Object.getOwnPropertyDescriptor(instance, key);
        if (desc && desc.configurable && "value" in desc) {
          Object.defineProperty(instance, key, {
            ...desc,
            writable: false,
          });
        }
      }
    }
  }
  return instance;
}
