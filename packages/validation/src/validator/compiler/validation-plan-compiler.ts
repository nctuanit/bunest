import { ValidationTypes } from "../constants/validation-types";
import type {
  ConstraintMetadata,
  ValidationMetadata,
} from "../interfaces/metadata.interface";
import type { ValidatorConstraintInterface } from "../interfaces/validator-constraint.interface";
import { MetadataStorage } from "../storage/metadata-storage";

export interface FastConstraintInstance extends ValidatorConstraintInterface {
  readonly __fastValidate?: (value: unknown) => boolean;
}

export type ConditionFn = (object: object, value: unknown) => boolean;

export interface CompiledRule {
  readonly metadata: ValidationMetadata;
  readonly constraintMeta: ConstraintMetadata;
  readonly constraintName: string;
  readonly isAsync: boolean;
  readonly each: boolean;
  readonly fastValidate?: (value: unknown) => boolean;
}

export interface CompiledPropertyPlan {
  readonly propertyName: string;
  readonly hasPromiseValidation: boolean;
  readonly conditions: readonly ConditionFn[];
  readonly definedRules: readonly CompiledRule[];
  readonly customRules: readonly CompiledRule[];
  readonly nestedMetadatas: readonly ValidationMetadata[];
  readonly hasContexts: boolean;
  readonly contextMetadatas: readonly ValidationMetadata[];
}

export interface CompiledValidationPlan {
  readonly target: Function;
  readonly schema: string;
  readonly epoch: number;
  readonly isEmpty: boolean;
  readonly hasAsync: boolean;
  readonly hasNested: boolean;
  readonly canRunSync: boolean;
  readonly allowedProperties: ReadonlySet<string>;
  readonly properties: readonly CompiledPropertyPlan[];
}

const PLAN_CACHE_SYMBOL = Symbol.for("bunest:class-validator:plan_cache");

interface TargetPlanCache {
  epoch: number;
  byKey: Map<string, CompiledValidationPlan>;
}

function getPlanCache(): WeakMap<Function, TargetPlanCache> {
  const g = globalThis as Record<PropertyKey, unknown>;
  let cache = g[PLAN_CACHE_SYMBOL] as
    | WeakMap<Function, TargetPlanCache>
    | undefined;
  if (!cache) {
    cache = new WeakMap();
    g[PLAN_CACHE_SYMBOL] = cache;
  }
  return cache;
}

function buildOptionsKey(
  schema: string,
  always: boolean,
  strictGroups: boolean,
  groups: readonly string[] | undefined,
): string {
  if (!schema && !always && !strictGroups && (!groups || groups.length === 0)) {
    return "0";
  }
  const gKey = groups && groups.length > 0 ? groups.join("\u0001") : "";
  return `${schema}\u0000${always ? 1 : 0}${strictGroups ? 1 : 0}\u0000${gKey}`;
}

function resolveCompiledRules(
  metadatas: readonly ValidationMetadata[],
  storage: MetadataStorage,
): { rules: CompiledRule[]; hasAsync: boolean } {
  const rules: CompiledRule[] = [];
  let hasAsync = false;

  for (let i = 0; i < metadatas.length; i++) {
    const metadata = metadatas[i]!;
    if (!metadata.constraintCls) continue;
    const constraints = storage.getTargetValidatorConstraints(
      metadata.constraintCls,
    );
    for (let j = 0; j < constraints.length; j++) {
      const constraintMeta = constraints[j]!;
      const constraintName =
        constraintMeta.name || metadata.name || metadata.type;
      if (constraintMeta.async) hasAsync = true;
      let fastValidate: ((value: unknown) => boolean) | undefined;
      const descriptor = Object.getOwnPropertyDescriptor(
        constraintMeta,
        "instance",
      );
      if (descriptor && "value" in descriptor && descriptor.value) {
        const fast = (descriptor.value as FastConstraintInstance).__fastValidate;
        if (typeof fast === "function") fastValidate = fast;
      }

      rules.push({
        metadata,
        constraintMeta,
        constraintName,
        isAsync: constraintMeta.async,
        each: metadata.each === true,
        fastValidate,
      });
    }
  }

  return { rules, hasAsync };
}

export function getCompiledValidationPlan(
  target: Function,
  targetSchema: string,
  always: boolean,
  strictGroups: boolean,
  groups: string[] | undefined,
  storage: MetadataStorage,
): CompiledValidationPlan {
  const currentEpoch = storage.epoch;
  const cache = getPlanCache();
  const key = buildOptionsKey(targetSchema, always, strictGroups, groups);

  let targetEntry = cache.get(target);
  if (targetEntry && targetEntry.epoch === currentEpoch) {
    const hit = targetEntry.byKey.get(key);
    if (hit) return hit;
  } else {
    targetEntry = { epoch: currentEpoch, byKey: new Map() };
    cache.set(target, targetEntry);
  }

  const targetMetadatas = storage.getTargetValidationMetadatas(
    target,
    targetSchema,
    always,
    strictGroups,
    groups,
  );

  if (targetMetadatas.length === 0) {
    const emptyPlan: CompiledValidationPlan = {
      target,
      schema: targetSchema,
      epoch: currentEpoch,
      isEmpty: true,
      hasAsync: false,
      hasNested: false,
      canRunSync: true,
      allowedProperties: new Set(),
      properties: [],
    };
    targetEntry.byKey.set(key, emptyPlan);
    return emptyPlan;
  }

  const grouped = storage.groupByPropertyName(targetMetadatas);
  const propNames = Object.keys(grouped);
  const allowedProperties = new Set<string>(propNames);
  const properties: CompiledPropertyPlan[] = [];
  let hasAsync = false;
  let hasNested = false;

  for (let i = 0; i < propNames.length; i++) {
    const propertyName = propNames[i]!;
    const propMetas = grouped[propertyName]!;

    const conditions: ConditionFn[] = [];
    const definedMetas: ValidationMetadata[] = [];
    const customMetas: ValidationMetadata[] = [];
    const nestedMetadatas: ValidationMetadata[] = [];
    const contextMetadatas: ValidationMetadata[] = [];
    let hasPromiseValidation = false;

    for (let j = 0; j < propMetas.length; j++) {
      const meta = propMetas[j]!;
      if (meta.context !== undefined) contextMetadatas.push(meta);
      switch (meta.type) {
        case ValidationTypes.IS_DEFINED:
          definedMetas.push(meta);
          break;
        case ValidationTypes.CONDITIONAL_VALIDATION:
          if (meta.constraints && typeof meta.constraints[0] === "function") {
            conditions.push(meta.constraints[0] as ConditionFn);
          }
          break;
        case ValidationTypes.CUSTOM_VALIDATION:
          customMetas.push(meta);
          break;
        case ValidationTypes.NESTED_VALIDATION:
          hasNested = true;
          nestedMetadatas.push(meta);
          break;
        case ValidationTypes.PROMISE_VALIDATION:
          hasPromiseValidation = true;
          hasAsync = true;
          nestedMetadatas.push(meta);
          break;
        case ValidationTypes.WHITELIST:
          break;
        default:
          if (meta.constraintCls) customMetas.push(meta);
          break;
      }
    }

    const compiledDefined = resolveCompiledRules(definedMetas, storage);
    const compiledCustom = resolveCompiledRules(customMetas, storage);
    if (compiledDefined.hasAsync || compiledCustom.hasAsync) {
      hasAsync = true;
    }

    properties.push({
      propertyName,
      hasPromiseValidation,
      conditions,
      definedRules: compiledDefined.rules,
      customRules: compiledCustom.rules,
      nestedMetadatas,
      hasContexts: contextMetadatas.length > 0,
      contextMetadatas,
    });
  }

  const plan: CompiledValidationPlan = {
    target,
    schema: targetSchema,
    epoch: currentEpoch,
    isEmpty: false,
    hasAsync,
    hasNested,
    canRunSync: !hasAsync && !hasNested,
    allowedProperties,
    properties,
  };

  targetEntry.byKey.set(key, plan);
  return plan;
}
