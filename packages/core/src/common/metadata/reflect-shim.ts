/**
 * Zero-dependency ECMAScript Reflect Metadata shim backed by a single-realm
 * `globalThis[Symbol.for("bunest:reflect:metadata")]` WeakMap store.
 *
 * Implements all 10 ECMAScript Reflect Metadata Proposal methods idempotently
 * so Bunest requires zero external `reflect-metadata` npm dependency while
 * remaining 100% compatible if an application also loads `reflect-metadata`.
 */

export const REFLECT_METADATA_STORE_SYMBOL = Symbol.for(
  "bunest:reflect:metadata",
);

export type ReflectMetadataStore = WeakMap<
  object,
  Map<PropertyKey | undefined, Map<unknown, unknown>>
>;

function isObjectLike(value: unknown): value is object {
  return (
    (typeof value === "object" && value !== null) || typeof value === "function"
  );
}

function toPropertyKey(key: unknown): PropertyKey {
  if (typeof key === "symbol") {
    return key;
  }
  return String(key);
}

function assertObjectTarget(target: unknown, method: string): asserts target is object {
  if (!isObjectLike(target)) {
    throw new TypeError(`Reflect.${method} called on non-object`);
  }
}

export function getReflectMetadataStore(): ReflectMetadataStore {
  const g = globalThis as Record<PropertyKey, unknown>;
  let store = g[REFLECT_METADATA_STORE_SYMBOL] as
    | ReflectMetadataStore
    | undefined;
  if (!store) {
    store = new WeakMap<
      object,
      Map<PropertyKey | undefined, Map<unknown, unknown>>
    >();
    g[REFLECT_METADATA_STORE_SYMBOL] = store;
  }
  return store;
}

export interface ReflectMetadataApi {
  defineMetadata(
    metadataKey: unknown,
    metadataValue: unknown,
    target: object,
    propertyKey?: PropertyKey,
  ): void;
  getMetadata(
    metadataKey: unknown,
    target: object,
    propertyKey?: PropertyKey,
  ): unknown;
  getOwnMetadata(
    metadataKey: unknown,
    target: object,
    propertyKey?: PropertyKey,
  ): unknown;
  hasMetadata(
    metadataKey: unknown,
    target: object,
    propertyKey?: PropertyKey,
  ): boolean;
  hasOwnMetadata(
    metadataKey: unknown,
    target: object,
    propertyKey?: PropertyKey,
  ): boolean;
  deleteMetadata(
    metadataKey: unknown,
    target: object,
    propertyKey?: PropertyKey,
  ): boolean;
  getMetadataKeys(target: object, propertyKey?: PropertyKey): unknown[];
  getOwnMetadataKeys(target: object, propertyKey?: PropertyKey): unknown[];
  metadata(
    metadataKey: unknown,
    metadataValue: unknown,
  ): {
    (target: Function): void;
    (target: object, propertyKey: PropertyKey): void;
  };
  decorate(
    decorators: readonly Function[],
    target: object,
    propertyKey?: PropertyKey,
    attributes?: PropertyDescriptor | null,
  ): unknown;
}

export function createReflectMetadataApi(
  store: ReflectMetadataStore = getReflectMetadataStore(),
): ReflectMetadataApi {
  function getMetadataMap(
    target: object,
    propertyKey: PropertyKey | undefined,
    create: true,
  ): Map<unknown, unknown>;
  function getMetadataMap(
    target: object,
    propertyKey: PropertyKey | undefined,
    create: false,
  ): Map<unknown, unknown> | undefined;
  function getMetadataMap(
    target: object,
    propertyKey: PropertyKey | undefined,
    create: boolean,
  ): Map<unknown, unknown> | undefined {
    let targetMap = store.get(target);
    if (!targetMap) {
      if (!create) return undefined;
      targetMap = new Map();
      store.set(target, targetMap);
    }
    let propMap = targetMap.get(propertyKey);
    if (!propMap) {
      if (!create) return undefined;
      propMap = new Map();
      targetMap.set(propertyKey, propMap);
    }
    return propMap;
  }

  function defineMetadata(
    metadataKey: unknown,
    metadataValue: unknown,
    target: object,
    propertyKey?: PropertyKey,
  ): void {
    assertObjectTarget(target, "defineMetadata");
    const key = propertyKey === undefined ? undefined : toPropertyKey(propertyKey);
    getMetadataMap(target, key, true).set(metadataKey, metadataValue);
  }

  function hasOwnMetadata(
    metadataKey: unknown,
    target: object,
    propertyKey?: PropertyKey,
  ): boolean {
    assertObjectTarget(target, "hasOwnMetadata");
    const key = propertyKey === undefined ? undefined : toPropertyKey(propertyKey);
    return getMetadataMap(target, key, false)?.has(metadataKey) ?? false;
  }

  function hasMetadata(
    metadataKey: unknown,
    target: object,
    propertyKey?: PropertyKey,
  ): boolean {
    assertObjectTarget(target, "hasMetadata");
    const key = propertyKey === undefined ? undefined : toPropertyKey(propertyKey);
    let current: object | null = target;
    while (current !== null) {
      if (getMetadataMap(current, key, false)?.has(metadataKey)) {
        return true;
      }
      current = Object.getPrototypeOf(current) as object | null;
    }
    return false;
  }

  function getOwnMetadata(
    metadataKey: unknown,
    target: object,
    propertyKey?: PropertyKey,
  ): unknown {
    assertObjectTarget(target, "getOwnMetadata");
    const key = propertyKey === undefined ? undefined : toPropertyKey(propertyKey);
    return getMetadataMap(target, key, false)?.get(metadataKey);
  }

  function getMetadata(
    metadataKey: unknown,
    target: object,
    propertyKey?: PropertyKey,
  ): unknown {
    assertObjectTarget(target, "getMetadata");
    const key = propertyKey === undefined ? undefined : toPropertyKey(propertyKey);
    let current: object | null = target;
    while (current !== null) {
      const map = getMetadataMap(current, key, false);
      if (map?.has(metadataKey)) {
        return map.get(metadataKey);
      }
      current = Object.getPrototypeOf(current) as object | null;
    }
    return undefined;
  }

  function getOwnMetadataKeys(
    target: object,
    propertyKey?: PropertyKey,
  ): unknown[] {
    assertObjectTarget(target, "getOwnMetadataKeys");
    const key = propertyKey === undefined ? undefined : toPropertyKey(propertyKey);
    const map = getMetadataMap(target, key, false);
    return map ? Array.from(map.keys()) : [];
  }

  function getMetadataKeys(
    target: object,
    propertyKey?: PropertyKey,
  ): unknown[] {
    assertObjectTarget(target, "getMetadataKeys");
    const key = propertyKey === undefined ? undefined : toPropertyKey(propertyKey);
    const keys = new Set<unknown>();
    let current: object | null = target;
    while (current !== null) {
      const map = getMetadataMap(current, key, false);
      if (map) {
        for (const k of map.keys()) {
          keys.add(k);
        }
      }
      current = Object.getPrototypeOf(current) as object | null;
    }
    return Array.from(keys);
  }

  function deleteMetadata(
    metadataKey: unknown,
    target: object,
    propertyKey?: PropertyKey,
  ): boolean {
    assertObjectTarget(target, "deleteMetadata");
    const key = propertyKey === undefined ? undefined : toPropertyKey(propertyKey);
    const targetMap = store.get(target);
    const propMap = targetMap?.get(key);
    if (!propMap) {
      return false;
    }
    const deleted = propMap.delete(metadataKey);
    if (deleted && propMap.size === 0) {
      targetMap!.delete(key);
    }
    return deleted;
  }

  function metadata(
    metadataKey: unknown,
    metadataValue: unknown,
  ): {
    (target: Function): void;
    (target: object, propertyKey: PropertyKey): void;
  } {
    function decorator(target: object, propertyKey?: PropertyKey): void {
      assertObjectTarget(target, "metadata");
      if (
        propertyKey !== undefined &&
        typeof propertyKey !== "string" &&
        typeof propertyKey !== "symbol"
      ) {
        throw new TypeError("Reflect.metadata propertyKey must be string or symbol");
      }
      defineMetadata(metadataKey, metadataValue, target, propertyKey);
    }
    return decorator as {
      (target: Function): void;
      (target: object, propertyKey: PropertyKey): void;
    };
  }

  function decorate(
    decorators: readonly Function[],
    target: object,
    propertyKey?: PropertyKey,
    attributes?: PropertyDescriptor | null,
  ): unknown {
    if (!Array.isArray(decorators)) {
      throw new TypeError("Reflect.decorate decorators must be an array");
    }
    if (propertyKey !== undefined) {
      assertObjectTarget(target, "decorate");
      if (
        attributes !== undefined &&
        attributes !== null &&
        !isObjectLike(attributes)
      ) {
        throw new TypeError("Reflect.decorate attributes must be an object");
      }
      const key = toPropertyKey(propertyKey);
      let descriptor: PropertyDescriptor | undefined =
        attributes === null ? undefined : attributes;
      for (let i = decorators.length - 1; i >= 0; i--) {
        const decorator = decorators[i]!;
        const decorated = decorator(target, key, descriptor) as unknown;
        if (decorated !== undefined && decorated !== null) {
          if (!isObjectLike(decorated)) {
            throw new TypeError("Reflect.decorate decorator returned non-object");
          }
          descriptor = decorated as PropertyDescriptor;
        }
      }
      return descriptor;
    }

    if (typeof target !== "function") {
      throw new TypeError("Reflect.decorate target must be a constructor");
    }
    let currentTarget: Function = target;
    for (let i = decorators.length - 1; i >= 0; i--) {
      const decorator = decorators[i]!;
      const decorated = decorator(currentTarget) as unknown;
      if (decorated !== undefined && decorated !== null) {
        if (typeof decorated !== "function") {
          throw new TypeError("Reflect.decorate class decorator returned non-function");
        }
        currentTarget = decorated;
      }
    }
    return currentTarget;
  }

  return {
    defineMetadata,
    getMetadata,
    getOwnMetadata,
    hasMetadata,
    hasOwnMetadata,
    deleteMetadata,
    getMetadataKeys,
    getOwnMetadataKeys,
    metadata,
    decorate,
  };
}

/**
 * Idempotently installs all 10 ECMAScript Reflect Metadata methods onto `targetReflect`
 * (defaults to global `Reflect`), preserving any methods already installed by the host
 * runtime or an application's own `reflect-metadata` import.
 */
export function installReflectMetadataShim(
  targetReflect: Record<string, unknown> = Reflect as unknown as Record<
    string,
    unknown
  >,
  store?: ReflectMetadataStore,
): void {
  const api = createReflectMetadataApi(store);
  const methods = Object.keys(api) as Array<keyof ReflectMetadataApi>;
  for (let i = 0; i < methods.length; i++) {
    const name = methods[i]!;
    if (typeof targetReflect[name] !== "function") {
      Object.defineProperty(targetReflect, name, {
        value: api[name],
        writable: true,
        enumerable: false,
        configurable: true,
      });
    }
  }
}

installReflectMetadataShim();

declare global {
  namespace Reflect {
    function decorate(decorators: ClassDecorator[], target: Function): Function;
    function decorate(
      decorators: (PropertyDecorator | MethodDecorator)[],
      target: Object,
      propertyKey: string | symbol,
      attributes?: PropertyDescriptor,
    ): PropertyDescriptor;
    function metadata(
      metadataKey: any,
      metadataValue: any,
    ): {
      (target: Function): void;
      (target: Object, propertyKey: string | symbol): void;
    };
    function defineMetadata(
      metadataKey: any,
      metadataValue: any,
      target: Object,
    ): void;
    function defineMetadata(
      metadataKey: any,
      metadataValue: any,
      target: Object,
      propertyKey: string | symbol,
    ): void;
    function hasMetadata(metadataKey: any, target: Object): boolean;
    function hasMetadata(
      metadataKey: any,
      target: Object,
      propertyKey: string | symbol,
    ): boolean;
    function hasOwnMetadata(metadataKey: any, target: Object): boolean;
    function hasOwnMetadata(
      metadataKey: any,
      target: Object,
      propertyKey: string | symbol,
    ): boolean;
    function getMetadata(metadataKey: any, target: Object): any;
    function getMetadata(
      metadataKey: any,
      target: Object,
      propertyKey: string | symbol,
    ): any;
    function getOwnMetadata(metadataKey: any, target: Object): any;
    function getOwnMetadata(
      metadataKey: any,
      target: Object,
      propertyKey: string | symbol,
    ): any;
    function getMetadataKeys(target: Object): any[];
    function getMetadataKeys(
      target: Object,
      propertyKey: string | symbol,
    ): any[];
    function getOwnMetadataKeys(target: Object): any[];
    function getOwnMetadataKeys(
      target: Object,
      propertyKey: string | symbol,
    ): any[];
    function deleteMetadata(metadataKey: any, target: Object): boolean;
    function deleteMetadata(
      metadataKey: any,
      target: Object,
      propertyKey: string | symbol,
    ): boolean;
  }
}
