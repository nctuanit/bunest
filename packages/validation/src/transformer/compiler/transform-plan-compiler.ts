import { TransformationType } from "../enums/transformation-type.enum";
import type {
  ExcludeMetadata,
  ExposeMetadata,
  TransformMetadata,
  TypeMetadata,
} from "../interfaces/metadata.interface";
import {
  TransformMetadataStorage,
  matchesDirection,
} from "../storage/metadata-storage";
import { readDesignType } from "../engine/builtins.util";

export interface CompiledDirectionPlan {
  readonly exposedPropertyNames: readonly string[];
  readonly exposedSourceKeys: readonly string[];
  readonly excludedKeySet: ReadonlySet<string>;
  readonly transformByProperty: ReadonlyMap<
    string,
    readonly TransformMetadata[]
  >;
}

export interface CompiledTransformClassPlan {
  readonly target: Function;
  readonly epoch: number;
  readonly strategy: "excludeAll" | "exposeAll" | "none";
  readonly exposeByProperty: ReadonlyMap<string, ExposeMetadata>;
  readonly exposeByAlias: ReadonlyMap<string, ExposeMetadata>;
  readonly excludeByProperty: ReadonlyMap<string, ExcludeMetadata>;
  readonly typeByProperty: ReadonlyMap<string, TypeMetadata>;
  readonly designTypeCache: Map<string, Function | null>;
  readonly readOnlyOrMethodProps: ReadonlySet<string>;
  readonly directions: readonly [
    CompiledDirectionPlan,
    CompiledDirectionPlan,
    CompiledDirectionPlan,
  ];
  readonly hasAnyDecorators: boolean;
  readonly hasGroupsOrVersion: boolean;
  readonly isTrivialPlainToClass: boolean;
}

const PLAN_CACHE_SYMBOL = Symbol.for("bunest:class-transformer:plan_cache");

function getPlanCache(): WeakMap<Function, CompiledTransformClassPlan> {
  const g = globalThis as Record<PropertyKey, unknown>;
  let cache = g[PLAN_CACHE_SYMBOL] as
    | WeakMap<Function, CompiledTransformClassPlan>
    | undefined;
  if (!cache) {
    cache = new WeakMap();
    g[PLAN_CACHE_SYMBOL] = cache;
  }
  return cache;
}

function collectReadOnlyOrMethodProps(target: Function): Set<string> {
  const result = new Set<string>();
  let proto: object | null = target.prototype as object | null;
  while (proto && proto !== Object.prototype) {
    const names = Object.getOwnPropertyNames(proto);
    for (let i = 0; i < names.length; i++) {
      const prop = names[i]!;
      if (prop === "constructor") continue;
      const desc = Object.getOwnPropertyDescriptor(proto, prop);
      if (!desc) continue;
      if (
        (typeof desc.get === "function" && desc.set === undefined) ||
        typeof desc.value === "function"
      ) {
        result.add(prop);
      }
    }
    proto = Object.getPrototypeOf(proto) as object | null;
  }
  return result;
}

function compileDirection(
  transformationType: TransformationType,
  exposeByProperty: ReadonlyMap<string, ExposeMetadata>,
  excludeByProperty: ReadonlyMap<string, ExcludeMetadata>,
  allTransformsByProperty: ReadonlyMap<string, readonly TransformMetadata[]>,
): CompiledDirectionPlan {
  const exposedPropertyNames: string[] = [];
  const exposedSourceKeys: string[] = [];
  const excludedKeySet = new Set<string>();
  const transformByProperty = new Map<string, TransformMetadata[]>();

  for (const [prop, meta] of exposeByProperty.entries()) {
    if (!matchesDirection(meta.options, transformationType)) continue;
    exposedPropertyNames.push(prop);
    if (
      transformationType === TransformationType.PLAIN_TO_CLASS &&
      meta.options.name
    ) {
      exposedSourceKeys.push(meta.options.name);
    } else {
      exposedSourceKeys.push(prop);
    }
  }

  for (const [prop, meta] of excludeByProperty.entries()) {
    if (!matchesDirection(meta.options, transformationType)) continue;
    excludedKeySet.add(prop);
    const exposeMeta = exposeByProperty.get(prop);
    if (
      transformationType === TransformationType.PLAIN_TO_CLASS &&
      exposeMeta?.options.name
    ) {
      excludedKeySet.add(exposeMeta.options.name);
    }
  }

  for (const [prop, list] of allTransformsByProperty.entries()) {
    const matching: TransformMetadata[] = [];
    for (let i = 0; i < list.length; i++) {
      const meta = list[i]!;
      if (matchesDirection(meta.options, transformationType)) {
        matching.push(meta);
      }
    }
    if (matching.length > 0) {
      transformByProperty.set(prop, matching);
    }
  }

  return {
    exposedPropertyNames,
    exposedSourceKeys,
    excludedKeySet,
    transformByProperty,
  };
}

export function getCompiledTransformPlan(
  target: Function,
  storage: TransformMetadataStorage,
): CompiledTransformClassPlan {
  const cache = getPlanCache();
  const currentEpoch = storage.epoch;
  const cached = cache.get(target);
  if (cached && cached.epoch === currentEpoch) {
    return cached;
  }

  const chain = storage.getPrototypeChain(target);
  const exposeByProperty = new Map<string, ExposeMetadata>();
  const exposeByAlias = new Map<string, ExposeMetadata>();
  const excludeByProperty = new Map<string, ExcludeMetadata>();
  const typeByProperty = new Map<string, TypeMetadata>();
  const allTransformsByProperty = new Map<string, TransformMetadata[]>();

  let hasGroupsOrVersion = false;

  for (let i = 0; i < chain.length; i++) {
    const ctor = chain[i]!;

    const ownExpose = storage.getOwnExposeMap(ctor);
    if (ownExpose) {
      for (const [prop, meta] of ownExpose.entries()) {
        if (prop === undefined) continue;
        exposeByProperty.set(prop, meta);
        if (
          meta.options.since !== undefined ||
          meta.options.until !== undefined ||
          (meta.options.groups && meta.options.groups.length > 0)
        ) {
          hasGroupsOrVersion = true;
        }
      }
    }

    const ownExclude = storage.getOwnExcludeMap(ctor);
    if (ownExclude) {
      for (const [prop, meta] of ownExclude.entries()) {
        if (prop === undefined) continue;
        excludeByProperty.set(prop, meta);
      }
    }

    const ownType = storage.getOwnTypeMap(ctor);
    if (ownType) {
      for (const [prop, meta] of ownType.entries()) {
        typeByProperty.set(prop, meta);
      }
    }

    const ownTransforms = storage.getOwnTransformMap(ctor);
    if (ownTransforms) {
      for (const [prop, list] of ownTransforms.entries()) {
        let bucket = allTransformsByProperty.get(prop);
        if (!bucket) {
          bucket = [];
          allTransformsByProperty.set(prop, bucket);
        }
        for (let j = list.length - 1; j >= 0; j--) {
          const meta = list[j]!;
          bucket.push(meta);
          if (
            meta.options.since !== undefined ||
            meta.options.until !== undefined ||
            (meta.options.groups && meta.options.groups.length > 0)
          ) {
            hasGroupsOrVersion = true;
          }
        }
      }
    }
  }

  for (const meta of exposeByProperty.values()) {
    if (meta.options.name) {
      exposeByAlias.set(meta.options.name, meta);
    }
  }

  const strategy = storage.getStrategy(target);
  const readOnlyOrMethodProps = collectReadOnlyOrMethodProps(target);

  const p2c = compileDirection(
    TransformationType.PLAIN_TO_CLASS,
    exposeByProperty,
    excludeByProperty,
    allTransformsByProperty,
  );
  const c2p = compileDirection(
    TransformationType.CLASS_TO_PLAIN,
    exposeByProperty,
    excludeByProperty,
    allTransformsByProperty,
  );
  const c2c = compileDirection(
    TransformationType.CLASS_TO_CLASS,
    exposeByProperty,
    excludeByProperty,
    allTransformsByProperty,
  );

  const hasAnyDecorators =
    strategy !== "none" ||
    exposeByProperty.size > 0 ||
    excludeByProperty.size > 0 ||
    typeByProperty.size > 0 ||
    allTransformsByProperty.size > 0;

  const isTrivialPlainToClass =
    strategy !== "excludeAll" &&
    exposeByAlias.size === 0 &&
    p2c.exposedSourceKeys.length === 0 &&
    p2c.excludedKeySet.size === 0 &&
    p2c.transformByProperty.size === 0 &&
    typeByProperty.size === 0 &&
    !hasGroupsOrVersion;

  const plan: CompiledTransformClassPlan = {
    target,
    epoch: currentEpoch,
    strategy,
    exposeByProperty,
    exposeByAlias,
    excludeByProperty,
    typeByProperty,
    designTypeCache: new Map(),
    readOnlyOrMethodProps,
    directions: [p2c, c2p, c2c],
    hasAnyDecorators,
    hasGroupsOrVersion,
    isTrivialPlainToClass,
  };

  cache.set(target, plan);
  return plan;
}

export function getCachedDesignType(
  plan: CompiledTransformClassPlan,
  propertyName: string,
): Function | undefined {
  const cached = plan.designTypeCache.get(propertyName);
  if (cached !== undefined) {
    return cached === null ? undefined : cached;
  }
  const reflected = readDesignType(
    plan.target.prototype as object | undefined,
    propertyName,
  );
  plan.designTypeCache.set(propertyName, reflected ?? null);
  return reflected;
}
