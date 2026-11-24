import { METADATA_KEYS, type MetadataKey } from "../constants/metadata-keys";
import { Scope } from "../enums/scope.enum";
import { MetadataRegistry } from "./metadata-registry";

export type CustomDecorator<TKey extends MetadataKey = string> =
  ClassDecorator & MethodDecorator & { KEY: TKey };

export interface CreateDecoratorOptions<TParam = any, TTransformed = TParam> {
  key?: MetadataKey;
  transform?: (value: TParam) => TTransformed;
}

export interface KeyedMetadataSource<TTransformed = any> {
  readonly KEY: MetadataKey;
  readonly __transformed?: TTransformed;
}

export type ReflectableDecorator<TParam, TTransformed = TParam> = ((
  ...args: [TParam] extends [void] ? [] : [opts: TParam]
) => CustomDecorator<MetadataKey>) &
  KeyedMetadataSource<TTransformed>;

export type MetadataKeyInput<TResult = any> =
  MetadataKey | KeyedMetadataSource<TResult>;

function resolveKey(input: MetadataKeyInput): MetadataKey {
  if (typeof input === "string" || typeof input === "symbol") {
    return input;
  }
  return input.KEY;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Helper service for reading and merging custom metadata across
 * route handlers, controller classes, and other reflection targets.
 */
export class Reflector {
  static createDecorator<TParam = void, TTransformed = TParam>(
    options: CreateDecoratorOptions<TParam, TTransformed> = {},
  ): ReflectableDecorator<TParam, TTransformed> {
    const metadataKey: MetadataKey =
      options.key ?? Symbol("bunest:custom_decorator");

    const decoratorFn = (
      metadataValue?: TParam,
    ): CustomDecorator<MetadataKey> => {
      const value = options.transform
        ? options.transform(metadataValue as TParam)
        : metadataValue === undefined
          ? ({} as TTransformed)
          : metadataValue;

      const decorator = (
        target: object,
        _key?: string | symbol,
        descriptor?: PropertyDescriptor,
      ) => {
        if (descriptor && descriptor.value !== undefined) {
          MetadataRegistry.define(metadataKey, value, descriptor.value);
          return descriptor;
        }
        MetadataRegistry.define(metadataKey, value, target);
        return target;
      };
      decorator.KEY = metadataKey;
      return decorator as CustomDecorator<MetadataKey>;
    };

    decoratorFn.KEY = metadataKey;
    return decoratorFn as ReflectableDecorator<TParam, TTransformed>;
  }

  get<TResult = any>(
    metadataKeyOrDecorator: MetadataKeyInput<TResult>,
    target: object,
    propertyKey?: string | symbol,
  ): TResult | undefined {
    const key = resolveKey(metadataKeyOrDecorator);
    return MetadataRegistry.get<TResult>(key, target, propertyKey);
  }

  getAll<TResult extends any[] = any[]>(
    metadataKeyOrDecorator: MetadataKeyInput,
    targets: ReadonlyArray<object | undefined> | null | undefined,
  ): TResult {
    if (!Array.isArray(targets)) {
      return [] as unknown as TResult;
    }
    const key = resolveKey(metadataKeyOrDecorator);
    return targets.map((target) =>
      target ? MetadataRegistry.get(key, target) : undefined,
    ) as TResult;
  }

  getAllAndMerge<TResult = any>(
    metadataKeyOrDecorator: MetadataKeyInput<TResult>,
    targets: ReadonlyArray<object | undefined> | null | undefined,
  ): TResult {
    if (!Array.isArray(targets)) {
      return [] as unknown as TResult;
    }
    const key = resolveKey(metadataKeyOrDecorator);
    const targetSet = new Set<object>();
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      if (t) targetSet.add(t);
    }

    const expandedAncestors = new Set<Function>();
    const values: unknown[] = [];

    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      if (!target) continue;

      if (typeof target === "function") {
        const chain = MetadataRegistry.getPrototypeChain(target);
        if (chain.length > 1) {
          const chainEntries: Array<{ cls: Function; value: unknown }> = [];
          for (let j = 0; j < chain.length; j++) {
            const cls = chain[j]!;
            if (
              cls !== target &&
              (targetSet.has(cls) || expandedAncestors.has(cls))
            ) {
              continue;
            }
            const own = MetadataRegistry.getOwn(key, cls);
            if (own !== undefined) {
              chainEntries.push({ cls, value: own });
            }
          }

          if (chainEntries.length > 1) {
            const sample = chainEntries[0]!.value;
            if (Array.isArray(sample) || isPlainObject(sample)) {
              for (let j = 0; j < chainEntries.length; j++) {
                const entry = chainEntries[j]!;
                if (entry.cls !== target) {
                  expandedAncestors.add(entry.cls);
                }
                values.push(entry.value);
              }
              continue;
            }
            // Non-mergeable primitives along prototype chain: most-derived wins
            values.push(chainEntries[chainEntries.length - 1]!.value);
            continue;
          }

          if (chainEntries.length === 1) {
            const singleEntry = chainEntries[0]!;
            if (singleEntry.cls !== target) {
              expandedAncestors.add(singleEntry.cls);
            }
            values.push(singleEntry.value);
            continue;
          }

          // Fallback for metadata defined outside chain (e.g. Function.prototype)
          const fallback = MetadataRegistry.get(key, target);
          if (fallback !== undefined) {
            values.push(fallback);
          }
          continue;
        }
      }

      const val = MetadataRegistry.get(key, target);
      if (val !== undefined) {
        values.push(val);
      }
    }

    if (values.length === 0) {
      return [] as unknown as TResult;
    }

    if (values.length === 1) {
      const single = values[0];
      if (Array.isArray(single)) {
        return [...single] as unknown as TResult;
      }
      if (isPlainObject(single)) {
        return { ...single } as unknown as TResult;
      }
      return [single] as unknown as TResult;
    }

    if (values.every((item) => isPlainObject(item))) {
      let merged: Record<string, unknown> = {};
      for (const item of values) {
        merged = { ...merged, ...(item as Record<string, unknown>) };
      }
      return merged as unknown as TResult;
    }

    const merged: unknown[] = [];
    for (const item of values) {
      if (Array.isArray(item)) {
        merged.push(...item);
      } else {
        merged.push(item);
      }
    }
    return merged as unknown as TResult;
  }

  getAllAndOverride<TResult = any>(
    metadataKeyOrDecorator: MetadataKeyInput<TResult>,
    targets: ReadonlyArray<object | undefined>,
  ): TResult | undefined {
    const key = resolveKey(metadataKeyOrDecorator);
    for (const target of targets) {
      if (!target) continue;
      const value = MetadataRegistry.get<TResult>(key, target);
      if (value !== undefined) {
        return value;
      }
    }
    return undefined;
  }
}

// Mark Reflector as injectable without creating a circular dependency on core.decorators.ts
MetadataRegistry.define(
  METADATA_KEYS.INJECTABLE,
  { scope: Scope.SINGLETON },
  Reflector,
);
