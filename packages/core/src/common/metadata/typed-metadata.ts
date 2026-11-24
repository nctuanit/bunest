import type { MetadataKey } from "../constants/metadata-keys";
import { MetadataRegistry } from "./metadata-registry";

export type MetadataMergeStrategy = "replace" | "append" | "merge";

export type TypedMetadataDecorator = ClassDecorator &
  MethodDecorator &
  PropertyDecorator;

export interface CreateMetadataKeyOptions {
  /**
   * How repeated applications of this metadata key combine with existing/inherited values:
   * - `"replace"` (default): overwrites metadata on the target.
   * - `"append"`: copy-on-write array concatenation (preserves parent metadata safely).
   * - `"merge"`: copy-on-write shallow object merge (preserves parent metadata safely).
   */
  readonly merge?: MetadataMergeStrategy;
}

export interface TypedMetadataKey<T> {
  readonly key: MetadataKey;
  readonly merge: MetadataMergeStrategy;
  define(value: T, target: object, propertyKey?: string | symbol): void;
  get(target: object, propertyKey?: string | symbol): T | undefined;
  getOwn(target: object, propertyKey?: string | symbol): T | undefined;
  has(target: object, propertyKey?: string | symbol): boolean;
  hasOwn(target: object, propertyKey?: string | symbol): boolean;
  /**
   * Appends values copy-on-write (preserving inherited parent array values).
   */
  append<U = T extends readonly (infer Item)[] ? Item : T>(
    items: readonly U[],
    target: object,
    propertyKey?: string | symbol,
  ): readonly U[];
  /**
   * Shallow-merges a partial object copy-on-write with existing/inherited metadata.
   */
  mergeObject(
    patch: Partial<T>,
    target: object,
    propertyKey?: string | symbol,
  ): T;
  /**
   * Returns a reusable class/method/property decorator storing `value` via `MetadataRegistry`.
   */
  decorator(value: T): TypedMetadataDecorator;
}

/**
 * Creates a strongly-typed metadata key backed by `MetadataRegistry` with
 * automatic copy-on-write inheritance safety and cache-epoch invalidation.
 */
export function createMetadataKey<T>(
  nameOrKey: string | symbol,
  options: CreateMetadataKeyOptions = {},
): TypedMetadataKey<T> {
  const key: MetadataKey =
    typeof nameOrKey === "symbol" ? nameOrKey : Symbol.for(nameOrKey);
  const merge: MetadataMergeStrategy = options.merge ?? "replace";

  const define = (
    value: T,
    target: object,
    propertyKey?: string | symbol,
  ): void => {
    MetadataRegistry.define<T>(key, value, target, propertyKey);
  };

  const get = (
    target: object,
    propertyKey?: string | symbol,
  ): T | undefined => MetadataRegistry.get<T>(key, target, propertyKey);

  const getOwn = (
    target: object,
    propertyKey?: string | symbol,
  ): T | undefined => MetadataRegistry.getOwn<T>(key, target, propertyKey);

  const has = (target: object, propertyKey?: string | symbol): boolean =>
    MetadataRegistry.has(key, target, propertyKey);

  const hasOwn = (target: object, propertyKey?: string | symbol): boolean =>
    MetadataRegistry.hasOwn(key, target, propertyKey);

  const append = <U = T extends readonly (infer Item)[] ? Item : T>(
    items: readonly U[],
    target: object,
    propertyKey?: string | symbol,
  ): readonly U[] => {
    const existing =
      MetadataRegistry.getOwn<readonly U[]>(key, target, propertyKey) ??
      MetadataRegistry.get<readonly U[]>(key, target, propertyKey) ??
      [];
    const next = [...existing, ...items];
    MetadataRegistry.define(key, next, target, propertyKey);
    return next;
  };

  const mergeObject = (
    patch: Partial<T>,
    target: object,
    propertyKey?: string | symbol,
  ): T => {
    const existing =
      MetadataRegistry.getOwn<Record<string, unknown>>(
        key,
        target,
        propertyKey,
      ) ??
      MetadataRegistry.get<Record<string, unknown>>(key, target, propertyKey) ??
      {};
    const next = { ...existing, ...(patch as Record<string, unknown>) } as T;
    MetadataRegistry.define<T>(key, next, target, propertyKey);
    return next;
  };

  const decorator = (value: T): TypedMetadataDecorator => {
    return ((
      target: object | Function,
      propertyKey?: string | symbol,
      descriptor?: PropertyDescriptor,
    ): PropertyDescriptor | void => {
      const metadataTarget =
        descriptor && typeof descriptor.value === "function"
          ? descriptor.value
          : target;
      const effectiveKey =
        descriptor && typeof descriptor.value === "function"
          ? undefined
          : propertyKey;

      if (merge === "append") {
        const items = Array.isArray(value) ? value : [value];
        append(items, metadataTarget, effectiveKey);
      } else if (
        merge === "merge" &&
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value)
      ) {
        mergeObject(value as Partial<T>, metadataTarget, effectiveKey);
      } else {
        define(value, metadataTarget, effectiveKey);
      }
      if (descriptor) {
        return descriptor;
      }
    }) as TypedMetadataDecorator;
  };

  return Object.freeze({
    key,
    merge,
    define,
    get,
    getOwn,
    has,
    hasOwn,
    append,
    mergeObject,
    decorator,
  });
}

// ============================================================================
// Reusable Inheritance-Safe Single-Realm ClassMetadataStore<TBucket>
// ============================================================================

const inheritanceChainCache = new WeakMap<Function, readonly Function[]>();

/**
 * Returns the cached prototype inheritance chain from base ancestor -> derived class.
 */
export function getCachedInheritanceChain(ctor: Function): readonly Function[] {
  const cached = inheritanceChainCache.get(ctor);
  if (cached) {
    return cached;
  }
  const chain: Function[] = [];
  let current: unknown = ctor;
  while (
    typeof current === "function" &&
    current !== Function.prototype &&
    current !== Object
  ) {
    chain.push(current);
    const proto = Object.getPrototypeOf(current);
    if (!proto || proto === Function.prototype || proto === Object.prototype) {
      break;
    }
    current = proto;
  }
  chain.reverse();
  const frozen = Object.freeze(chain);
  inheritanceChainCache.set(ctor, frozen);
  return frozen;
}

interface GlobalClassStoreBacking<TBucket> {
  buckets: WeakMap<Function, TBucket>;
  readonly classes: Set<Function>;
  version: number;
}

/**
 * Single-realm, copy-on-write, inheritance-aware class metadata store backed by
 * `globalThis[Symbol.for(...)]` with cached prototype chains and deterministic
 * `snapshot()` / `restore()` / `clear()` support for tests.
 */
export class ClassMetadataStore<TBucket extends object> {
  private readonly storeSymbol: symbol;
  private readonly createEmptyBucket: () => TBucket;

  constructor(storeKey: string | symbol, createEmptyBucket: () => TBucket) {
    this.storeSymbol =
      typeof storeKey === "symbol" ? storeKey : Symbol.for(storeKey);
    this.createEmptyBucket = createEmptyBucket;
  }

  private getBacking(): GlobalClassStoreBacking<TBucket> {
    const g = globalThis as Record<PropertyKey, unknown>;
    let backing = g[this.storeSymbol] as
      | GlobalClassStoreBacking<TBucket>
      | undefined;
    if (!backing) {
      backing = {
        buckets: new WeakMap<Function, TBucket>(),
        classes: new Set<Function>(),
        version: 1,
      };
      g[this.storeSymbol] = backing;
    }
    return backing;
  }

  get version(): number {
    return this.getBacking().version;
  }

  bumpVersion(): number {
    const backing = this.getBacking();
    backing.version += 1;
    return backing.version;
  }

  getOwn(ctor: Function): TBucket | undefined {
    return this.getBacking().buckets.get(ctor);
  }

  getOrCreateOwn(ctor: Function): TBucket {
    const backing = this.getBacking();
    let bucket = backing.buckets.get(ctor);
    if (!bucket) {
      bucket = this.createEmptyBucket();
      backing.buckets.set(ctor, bucket);
      backing.classes.add(ctor);
      backing.version += 1;
    }
    return bucket;
  }

  has(ctor: Function): boolean {
    return this.getBacking().buckets.has(ctor);
  }

  getRegisteredClasses(): Function[] {
    return [...this.getBacking().classes];
  }

  /**
   * Collects all buckets along the inheritance chain from base class -> derived class.
   */
  getInheritanceBuckets(ctor: Function): TBucket[] {
    const backing = this.getBacking();
    const chain = getCachedInheritanceChain(ctor);
    const out: TBucket[] = [];
    for (let i = 0; i < chain.length; i++) {
      const bucket = backing.buckets.get(chain[i]!);
      if (bucket) {
        out.push(bucket);
      }
    }
    return out;
  }

  snapshot(): ReadonlyArray<readonly [Function, TBucket]> {
    const backing = this.getBacking();
    const entries: Array<readonly [Function, TBucket]> = [];
    for (const ctor of backing.classes) {
      const bucket = backing.buckets.get(ctor);
      if (bucket !== undefined) {
        entries.push([ctor, bucket]);
      }
    }
    return entries;
  }

  restore(entries: ReadonlyArray<readonly [Function, TBucket]>): void {
    const backing = this.getBacking();
    backing.buckets = new WeakMap<Function, TBucket>();
    backing.classes.clear();
    for (let i = 0; i < entries.length; i++) {
      const [ctor, bucket] = entries[i]!;
      backing.buckets.set(ctor, bucket);
      backing.classes.add(ctor);
    }
    backing.version += 1;
  }

  clear(): void {
    const backing = this.getBacking();
    backing.buckets = new WeakMap<Function, TBucket>();
    backing.classes.clear();
    backing.version += 1;
  }
}
