import { isPlainObject } from "@bunest/core/common";
import { TransformationType } from "../enums/transformation-type.enum";
import {
  DEFAULT_TRANSFORM_OPTIONS,
  type ClassTransformOptions,
} from "../interfaces/class-transform-options.interface";
import type {
  Discriminator,
  TypeHelpOptions,
} from "../interfaces/decorator-options.interface";
import type {
  ExposeMetadata,
  TransformMetadata,
  TypeMetadata,
} from "../interfaces/metadata.interface";
import {
  TransformMetadataStorage,
  defaultMetadataStorage,
} from "../storage/metadata-storage";
import {
  getCachedDesignType,
  getCompiledTransformPlan,
  type CompiledTransformClassPlan,
} from "../compiler/transform-plan-compiler";
import {
  coerceBooleanSafe,
  coerceNumberSafe,
  convertExplicitBoolean,
  isDangerousKey,
  isPassthroughNativeObject,
  isPromiseLike,
} from "./builtins.util";

interface ResolvedTypeDescriptor {
  readonly ctor?: Function;
  readonly isImplicit?: boolean;
  readonly discriminator?: Discriminator;
  readonly keepDiscriminatorProperty?: boolean;
  readonly fallbackTypeFunction?: (options?: TypeHelpOptions) => Function;
  readonly reflectedType?: Function;
}

function instantiateArrayType(arrayType: Function): unknown[] | Set<unknown> {
  try {
    const arr = new (arrayType as new () => unknown)();
    if (arr instanceof Set) return arr;
    if (
      Array.isArray(arr) ||
      (typeof arr === "object" && arr !== null && "push" in arr)
    ) {
      return arr as unknown[];
    }
  } catch {
    // Fallback to plain Array
  }
  return [];
}

function instantiateClass(targetType: Function): Record<string, unknown> {
  return new (targetType as new () => Record<string, unknown>)();
}

function hasPrefixMatch(key: string, prefixes: readonly string[]): boolean {
  for (let i = 0; i < prefixes.length; i++) {
    if (key.startsWith(prefixes[i]!)) return true;
  }
  return false;
}

function checkVersion(
  version: number | undefined,
  since: number | undefined,
  until: number | undefined,
): boolean {
  if (version === undefined) return true;
  if (since !== undefined && version < since) return false;
  if (until !== undefined && version >= until) return false;
  return true;
}

function checkGroups(
  optionGroups: readonly string[] | undefined,
  metaGroups: readonly string[] | undefined,
): boolean {
  if (!metaGroups || metaGroups.length === 0) return true;
  if (!optionGroups || optionGroups.length === 0) return false;
  for (let i = 0; i < optionGroups.length; i++) {
    if (metaGroups.includes(optionGroups[i]!)) return true;
  }
  return false;
}

export function tryFastPlainToInstance(
  targetType: Function,
  plain: unknown,
  options: ClassTransformOptions | undefined,
  storage: TransformMetadataStorage = defaultMetadataStorage,
): { matched: true; result: unknown } | { matched: false } {
  if (!isPlainObject(plain)) {
    return { matched: false };
  }

  if (
    options &&
    (options.strategy === "excludeAll" ||
      options.excludeExtraneousValues === true ||
      options.enableCircularCheck === true ||
      options.enableImplicitConversion === true ||
      options.exposeDefaultValues === true ||
      options.ignoreDecorators === true ||
      options.version !== undefined ||
      (options.groups !== undefined && options.groups.length > 0) ||
      (options.excludePrefixes !== undefined &&
        options.excludePrefixes.length > 0) ||
      (options.targetMaps !== undefined && options.targetMaps.length > 0))
  ) {
    return { matched: false };
  }

  const plan = getCompiledTransformPlan(targetType, storage);
  if (!plan.isTrivialPlainToClass) {
    return { matched: false };
  }

  const exposeUnsetFields = options?.exposeUnsetFields ?? true;
  const record = plain as Record<string, unknown>;
  const instance = instantiateClass(targetType);
  const keys = Object.keys(record);
  const skipSet = plan.readOnlyOrMethodProps;

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!;
    if (isDangerousKey(key) || skipSet.has(key)) continue;
    const val = record[key];
    if (val === undefined && !exposeUnsetFields) continue;
    if (typeof val === "object" && val !== null) {
      return { matched: false };
    }
    instance[key] = val;
  }

  return { matched: true, result: instance };
}

function createTargetCollection(
  arrayType: Function | undefined,
  isPlainToClass: boolean,
  isClassToClass: boolean,
  isInputSet: boolean,
): unknown[] | Set<unknown> {
  if (arrayType && isPlainToClass) {
    return instantiateArrayType(arrayType);
  }
  if (isInputSet && (isPlainToClass || isClassToClass)) {
    return new Set();
  }
  return [];
}

export class TransformExecutor {
  private readonly transformationType: TransformationType;
  private readonly options: ClassTransformOptions;
  private readonly storage: TransformMetadataStorage;
  private recursionStack: Set<object> | undefined;

  constructor(
    transformationType: TransformationType,
    options?: ClassTransformOptions,
    storage: TransformMetadataStorage = defaultMetadataStorage,
  ) {
    this.transformationType = transformationType;
    this.options = options
      ? { ...DEFAULT_TRANSFORM_OPTIONS, ...options }
      : DEFAULT_TRANSFORM_OPTIONS;
    this.storage = storage;
  }

  transform(
    source: Record<string, unknown> | unknown[] | undefined,
    value: unknown,
    targetType: Function | ResolvedTypeDescriptor | undefined,
    arrayType: Function | undefined,
    isMap: boolean,
    level = 0,
    omittedKey?: string,
  ): unknown {
    if (Array.isArray(value) || value instanceof Set) {
      const isPlainToClass =
        this.transformationType === TransformationType.PLAIN_TO_CLASS;
      const isClassToClass =
        this.transformationType === TransformationType.CLASS_TO_CLASS;
      const newCollection = createTargetCollection(
        arrayType,
        isPlainToClass,
        isClassToClass,
        value instanceof Set,
      );
      const isSetOut = newCollection instanceof Set;
      const isSourceArr = Array.isArray(source);
      const isDescriptor =
        typeof targetType === "object" && targetType !== null;
      const disc = isDescriptor ? targetType.discriminator : undefined;

      const isInputArray = Array.isArray(value);
      const iterEntries: Array<[number, unknown]> = [];
      if (isInputArray) {
        if (!isSetOut) {
          (newCollection as unknown[]).length = value.length;
        }
        for (const key of Object.keys(value)) {
          const k = Number(key);
          if (Number.isInteger(k) && k >= 0 && String(k) === key) {
            iterEntries.push([k, value[k]]);
          }
        }
      } else {
        let i = 0;
        for (const subValue of value) {
          iterEntries.push([i++, subValue]);
        }
      }

      for (const [idx, subValue] of iterEntries) {
        const subSource = isSourceArr
          ? (source[idx] as Record<string, unknown> | unknown[] | undefined)
          : undefined;

        if (
          this.options.enableCircularCheck &&
          typeof subValue === "object" &&
          subValue !== null &&
          this.isCircular(subValue)
        ) {
          if (this.transformationType === TransformationType.CLASS_TO_CLASS) {
            if (isSetOut) newCollection.add(subValue);
            else if (isInputArray) newCollection[idx] = subValue;
            else newCollection.push(subValue);
          }
          continue;
        }

        let realTargetType: Function | undefined;
        let skipDiscKey: string | undefined;
        let injectDiscEntry: [string, string] | undefined;

        if (disc && isDescriptor) {
          if (
            this.transformationType === TransformationType.PLAIN_TO_CLASS &&
            typeof subValue === "object" &&
            subValue !== null
          ) {
            const discVal = (subValue as Record<string, unknown>)[disc.property];
            const matchedSub = disc.subTypes.find((st) => st.name === discVal);
            if (matchedSub) {
              realTargetType = matchedSub.value;
            } else if (targetType.fallbackTypeFunction) {
              realTargetType = targetType.fallbackTypeFunction({
                newObject: newCollection as unknown as Record<string, unknown>,
                object: subValue as Record<string, unknown>,
                property: undefined,
              });
            }
            if (!targetType.keepDiscriminatorProperty) {
              skipDiscKey = disc.property;
            }
          } else if (
            this.transformationType === TransformationType.CLASS_TO_CLASS &&
            typeof subValue === "object" &&
            subValue !== null
          ) {
            realTargetType = (subValue as { constructor?: Function })
              .constructor;
          } else if (
            this.transformationType === TransformationType.CLASS_TO_PLAIN &&
            typeof subValue === "object" &&
            subValue !== null
          ) {
            const subCtor = (subValue as { constructor?: Function })
              .constructor;
            const matchedSub = disc.subTypes.find((st) => st.value === subCtor);
            if (matchedSub) {
              injectDiscEntry = [disc.property, matchedSub.name];
            }
          }
        } else if (typeof targetType === "function") {
          realTargetType = targetType;
        } else if (isDescriptor) {
          realTargetType = targetType.ctor;
        }

        const transformedItem = this.transform(
          subSource,
          subValue,
          realTargetType,
          undefined,
          subValue instanceof Map,
          level + 1,
          skipDiscKey,
        );

        if (
          injectDiscEntry &&
          typeof transformedItem === "object" &&
          transformedItem !== null
        ) {
          (transformedItem as Record<string, unknown>)[injectDiscEntry[0]] =
            injectDiscEntry[1];
        }

        if (isSetOut) newCollection.add(transformedItem);
        else if (isInputArray) newCollection[idx] = transformedItem;
        else newCollection.push(transformedItem);
      }
      return newCollection;
    }

    const resolvedCtor =
      typeof targetType === "function" ? targetType : targetType?.ctor;
    const isImplicit =
      typeof targetType === "object" && targetType !== null
        ? targetType.isImplicit === true
        : false;

    const safeCoerce = isImplicit || this.options.enableImplicitConversion === true;

    if (resolvedCtor === String && !isMap) {
      if (value === null || value === undefined) return value;
      return String(value);
    }

    if (resolvedCtor === Number && !isMap) {
      if (value === null || value === undefined) return value;
      return safeCoerce ? coerceNumberSafe(value) : Number(value);
    }

    if (resolvedCtor === Boolean && !isMap) {
      if (value === null || value === undefined) return value;
      return safeCoerce
        ? coerceBooleanSafe(value)
        : convertExplicitBoolean(value);
    }

    if ((resolvedCtor === Date || value instanceof Date) && !isMap) {
      if (value instanceof Date) return new Date(value.valueOf());
      if (value === null || value === undefined) return value;
      if (typeof value === "string" || typeof value === "number") {
        if (safeCoerce && typeof value === "string" && value.trim() === "") {
          return value;
        }
        const parsed = new Date(value);
        if (safeCoerce && Number.isNaN(parsed.getTime())) {
          return value;
        }
        return parsed;
      }
      return value;
    }

    if (
      typeof Buffer !== "undefined" &&
      (resolvedCtor === Buffer || Buffer.isBuffer(value)) &&
      !isMap
    ) {
      if (value === null || value === undefined) return value;
      if (Buffer.isBuffer(value)) return Buffer.from(value);
      if (
        typeof value === "string" ||
        value instanceof Uint8Array ||
        Array.isArray(value)
      ) {
        return Buffer.from(value as string | Uint8Array);
      }
      return value;
    }

    if (isPromiseLike(value) && !isMap) {
      if (value instanceof Promise) {
        return value.then((data) =>
          this.transform(undefined, data, targetType, undefined, false, level + 1),
        );
      }
      return value;
    }

    if (typeof value === "object" && value !== null) {
      if (!isMap && isPassthroughNativeObject(value)) {
        return value;
      }

      let effectiveTarget: Function | undefined = resolvedCtor;

      if (!effectiveTarget) {
        const valCtor = (value as { constructor?: unknown }).constructor;
        if (
          typeof valCtor === "function" &&
          valCtor !== Object &&
          !(!Array.isArray(value) && valCtor === Array)
        ) {
          effectiveTarget = valCtor;
        }
      }
      if (!effectiveTarget && source && typeof source === "object") {
        const srcCtor = (source as { constructor?: unknown }).constructor;
        if (typeof srcCtor === "function" && srcCtor !== Object) {
          effectiveTarget = srcCtor;
        }
      }

      if (this.options.enableCircularCheck) {
        this.recursionStack ??= new Set();
        this.recursionStack.add(value);
      }

      const plan =
        effectiveTarget && effectiveTarget !== Map && effectiveTarget !== Object
          ? getCompiledTransformPlan(effectiveTarget, this.storage)
          : undefined;

      const keys = this.collectKeys(plan, value, isMap);

      let newValue: Record<string, unknown> | Map<unknown, unknown>;
      if (source && !Array.isArray(source)) {
        newValue = source;
      } else if (
        this.transformationType === TransformationType.PLAIN_TO_CLASS ||
        this.transformationType === TransformationType.CLASS_TO_CLASS
      ) {
        if (isMap) newValue = new Map();
        else if (effectiveTarget) newValue = instantiateClass(effectiveTarget);
        else newValue = {};
      } else {
        newValue = {};
      }

      const isPlainToClass =
        this.transformationType === TransformationType.PLAIN_TO_CLASS;
      const isClassToPlain =
        this.transformationType === TransformationType.CLASS_TO_PLAIN;
      const isClassToClass =
        this.transformationType === TransformationType.CLASS_TO_CLASS;
      const ignoreDecorators = this.options.ignoreDecorators === true;
      const exposeUnsetFields = this.options.exposeUnsetFields ?? true;
      const exposeDefaultValues = this.options.exposeDefaultValues === true;

      const valueRecord = value as Record<string, unknown>;
      const isValueMap = value instanceof Map;
      const dirPlan = plan ? plan.directions[this.transformationType] : undefined;
      const skipProtoProps =
        (isPlainToClass || isClassToClass) && plan
          ? plan.readOnlyOrMethodProps
          : undefined;

      for (let i = 0; i < keys.length; i++) {
        const key = keys[i]!;
        if (isDangerousKey(key)) continue;
        if (omittedKey !== undefined && key === omittedKey) continue;

        const valueKey = key;
        let newValueKey = key;
        let propertyName = key;

        if (!ignoreDecorators && plan) {
          if (isPlainToClass) {
            const aliasMeta = plan.exposeByAlias.get(key);
            if (aliasMeta && aliasMeta.propertyName !== undefined) {
              propertyName = aliasMeta.propertyName;
              newValueKey = aliasMeta.propertyName;
            }
          } else {
            const exposeMeta = plan.exposeByProperty.get(key);
            if (exposeMeta?.options.name) {
              newValueKey = exposeMeta.options.name;
            }
          }
        }

        if (skipProtoProps && skipProtoProps.has(newValueKey)) continue;
        if (
          (isPlainToClass || isClassToClass) &&
          !(newValue instanceof Map) &&
          typeof newValue[newValueKey] === "function"
        ) {
          continue;
        }

        let subValue: unknown;
        if (isPlainToClass) {
          subValue = valueRecord[valueKey];
        } else if (isValueMap) {
          subValue = value.get(valueKey);
        } else {
          const candidate = valueRecord[valueKey];
          if (typeof candidate === "function") {
            subValue = (candidate as () => unknown).call(value);
          } else {
            subValue = candidate;
          }
        }

        let nextType: Function | ResolvedTypeDescriptor | undefined;
        let isSubValueMap = subValue instanceof Map;
        let nestedOmitKey: string | undefined;
        let nestedInjectDisc: [string, string] | undefined;

        if (effectiveTarget && isMap) {
          nextType = effectiveTarget;
        } else if (plan) {
          const typeMeta: TypeMetadata | undefined =
            plan.typeByProperty.get(propertyName);
          if (typeMeta) {
            const helpOptions: TypeHelpOptions = {
              newObject: newValue instanceof Map ? {} : newValue,
              object: valueRecord,
              property: propertyName,
            };
            const resolvedFnType = typeMeta.typeFunction
              ? typeMeta.typeFunction(helpOptions)
              : typeMeta.reflectedType;

            const disc = typeMeta.options.discriminator;
            if (disc && disc.property && disc.subTypes) {
              if (Array.isArray(subValue) || subValue instanceof Set) {
                nextType = {
                  ctor: resolvedFnType,
                  discriminator: disc,
                  keepDiscriminatorProperty:
                    typeMeta.options.keepDiscriminatorProperty,
                  fallbackTypeFunction: typeMeta.typeFunction,
                  reflectedType: typeMeta.reflectedType,
                };
              } else if (isPlainToClass) {
                if (
                  typeof subValue === "object" &&
                  subValue !== null &&
                  disc.property in subValue
                ) {
                  const discVal = (subValue as Record<string, unknown>)[
                    disc.property
                  ];
                  const matched = disc.subTypes.find(
                    (st) => st.name === discVal,
                  );
                  nextType = matched ? matched.value : resolvedFnType;
                  if (!typeMeta.options.keepDiscriminatorProperty) {
                    nestedOmitKey = disc.property;
                  }
                } else {
                  nextType = resolvedFnType;
                }
              } else if (isClassToClass) {
                nextType =
                  typeof subValue === "object" && subValue !== null
                    ? (subValue as { constructor?: Function }).constructor
                    : resolvedFnType;
              } else if (isClassToPlain) {
                if (typeof subValue === "object" && subValue !== null) {
                  const subCtor = (subValue as { constructor?: Function })
                    .constructor;
                  const matched = disc.subTypes.find(
                    (st) => st.value === subCtor,
                  );
                  if (matched) {
                    nestedInjectDisc = [disc.property, matched.name];
                  }
                }
              }
            } else {
              nextType = resolvedFnType;
            }

            if (typeMeta.reflectedType === Map) {
              isSubValueMap = true;
            }
          } else if (this.options.targetMaps && effectiveTarget) {
            for (let t = 0; t < this.options.targetMaps.length; t++) {
              const tm = this.options.targetMaps[t]!;
              if (tm.target === effectiveTarget && tm.properties[propertyName]) {
                nextType = tm.properties[propertyName];
              }
            }
          } else if (this.options.enableImplicitConversion && isPlainToClass) {
            const reflectedType = getCachedDesignType(plan, propertyName);
            if (reflectedType) {
              nextType = { ctor: reflectedType, isImplicit: true };
            }
          }
        }

        const arrayType =
          Array.isArray(subValue) && plan
            ? plan.typeByProperty.get(propertyName)?.reflectedType
            : undefined;

        const subSource =
          source && !Array.isArray(source)
            ? (source[valueKey] as
                | Record<string, unknown>
                | unknown[]
                | undefined)
            : undefined;

        const isSubCircular =
          this.options.enableCircularCheck &&
          typeof subValue === "object" &&
          subValue !== null &&
          this.isCircular(subValue);

        if (!isSubCircular) {
          const transformKey = isPlainToClass ? newValueKey : key;
          const transforms =
            !ignoreDecorators && dirPlan
              ? dirPlan.transformByProperty.get(transformKey)
              : undefined;

          let finalValue: unknown;

          if (isClassToPlain) {
            const rawOriginal = isValueMap
              ? subValue
              : valueRecord[transformKey];
            const transformedRaw = transforms
              ? this.applyTransforms(
                  rawOriginal,
                  transforms,
                  transformKey,
                  valueRecord,
                )
              : rawOriginal;
            const afterCustom =
              transformedRaw === rawOriginal ? subValue : transformedRaw;
            finalValue = this.transform(
              subSource,
              afterCustom,
              nextType,
              arrayType,
              isSubValueMap,
              level + 1,
              nestedOmitKey,
            );
          } else {
            if (subValue === undefined && exposeDefaultValues) {
              finalValue =
                newValue instanceof Map
                  ? newValue.get(newValueKey)
                  : newValue[newValueKey];
            } else {
              finalValue = this.transform(
                subSource,
                subValue,
                nextType,
                arrayType,
                isSubValueMap,
                level + 1,
                nestedOmitKey,
              );
              if (transforms) {
                finalValue = this.applyTransforms(
                  finalValue,
                  transforms,
                  transformKey,
                  valueRecord,
                );
              }
            }
          }

          if (
            nestedInjectDisc &&
            typeof finalValue === "object" &&
            finalValue !== null
          ) {
            (finalValue as Record<string, unknown>)[nestedInjectDisc[0]] =
              nestedInjectDisc[1];
          }

          if (finalValue !== undefined || exposeUnsetFields) {
            if (newValue instanceof Map) {
              newValue.set(newValueKey, finalValue);
            } else {
              newValue[newValueKey] = finalValue;
            }
          }
        } else if (isClassToClass) {
          const transforms =
            !ignoreDecorators && dirPlan
              ? dirPlan.transformByProperty.get(key)
              : undefined;
          const finalValue = transforms
            ? this.applyTransforms(subValue, transforms, key, valueRecord)
            : subValue;
          if (finalValue !== undefined || exposeUnsetFields) {
            if (newValue instanceof Map) {
              newValue.set(newValueKey, finalValue);
            } else {
              newValue[newValueKey] = finalValue;
            }
          }
        }
      }

      if (this.options.enableCircularCheck && this.recursionStack) {
        this.recursionStack.delete(value);
      }

      return newValue;
    }

    return value;
  }

  private applyTransforms(
    initialValue: unknown,
    transforms: readonly TransformMetadata[],
    key: string,
    obj: Record<string, unknown>,
  ): unknown {
    let current = initialValue;
    const version = this.options.version;
    const groups = this.options.groups;

    for (let i = 0; i < transforms.length; i++) {
      const meta = transforms[i]!;
      const opts = meta.options;
      if (opts) {
        if (!checkVersion(version, opts.since, opts.until)) continue;
        if (!checkGroups(groups, opts.groups)) continue;
      }
      current = meta.transformFn({
        value: current,
        key,
        obj,
        type: this.transformationType,
        options: this.options,
      });
    }
    return current;
  }

  private isCircular(obj: object): boolean {
    return this.recursionStack !== undefined && this.recursionStack.has(obj);
  }

  private collectKeys(
    plan: CompiledTransformClassPlan | undefined,
    value: object,
    isMap: boolean,
  ): string[] {
    if (isMap) {
      return value instanceof Map
        ? Array.from(value.keys(), (k) => String(k))
        : Object.keys(value);
    }

    const strategy: "excludeAll" | "exposeAll" =
      plan && plan.strategy !== "none"
        ? plan.strategy
        : (this.options.strategy ?? "exposeAll");

    const ignoreDecorators = this.options.ignoreDecorators === true;
    const excludeExtraneous = this.options.excludeExtraneousValues === true;
    const dirPlan = plan ? plan.directions[this.transformationType] : undefined;

    let rawKeys: string[];

    if (ignoreDecorators && excludeExtraneous && plan && dirPlan) {
      rawKeys = [...dirPlan.exposedPropertyNames, ...dirPlan.excludedKeySet];
    } else if (!ignoreDecorators && plan && dirPlan) {
      if (excludeExtraneous) {
        rawKeys = [...dirPlan.exposedSourceKeys];
      } else {
        rawKeys = strategy === "exposeAll" ? Object.keys(value) : [];
        if (dirPlan.exposedSourceKeys.length > 0) {
          for (let i = 0; i < dirPlan.exposedSourceKeys.length; i++) {
            rawKeys.push(dirPlan.exposedSourceKeys[i]!);
          }
        }
      }
    } else {
      rawKeys = strategy === "exposeAll" ? Object.keys(value) : [];
    }

    const version = this.options.version;
    const groups = this.options.groups;
    const prefixes = this.options.excludePrefixes;
    const hasExcluded =
      !ignoreDecorators &&
      dirPlan !== undefined &&
      dirPlan.excludedKeySet.size > 0;
    const isPlainToClass =
      this.transformationType === TransformationType.PLAIN_TO_CLASS;
    const needMetaFilter =
      !ignoreDecorators &&
      plan !== undefined &&
      (plan.hasGroupsOrVersion ||
        version !== undefined ||
        (groups !== undefined && groups.length > 0));

    if (
      !hasExcluded &&
      !needMetaFilter &&
      (!prefixes || prefixes.length === 0) &&
      (!dirPlan || dirPlan.exposedSourceKeys.length === 0)
    ) {
      return rawKeys;
    }

    const seen = new Set<string>();
    const out: string[] = [];

    for (let i = 0; i < rawKeys.length; i++) {
      const key = rawKeys[i]!;
      if (seen.has(key)) continue;
      if (hasExcluded && dirPlan!.excludedKeySet.has(key)) continue;

      if (needMetaFilter && plan) {
        const exposeMeta: ExposeMetadata | undefined = isPlainToClass
          ? (plan.exposeByAlias.get(key) ?? plan.exposeByProperty.get(key))
          : plan.exposeByProperty.get(key);
        if (exposeMeta?.options) {
          if (
            !checkVersion(
              version,
              exposeMeta.options.since,
              exposeMeta.options.until,
            )
          ) {
            continue;
          }
          if (!checkGroups(groups, exposeMeta.options.groups)) continue;
        }
      }

      if (prefixes && prefixes.length > 0 && hasPrefixMatch(key, prefixes)) {
        continue;
      }

      seen.add(key);
      out.push(key);
    }

    return out;
  }
}
