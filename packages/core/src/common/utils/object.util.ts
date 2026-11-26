import { include, not } from "./predicate.util";
import {
  hasOwn,
  isAnyNullish,
  isArray,
  isDate,
  isFunction,
  isInstanceof,
  isMap,
  isNotUndefined,
  isNullish,
  isObject,
  isPlainObject,
  isRegExp,
  isSet,
  isTypeof,
  isUndefined,
} from "./type-guards.util";

const FORBIDDEN_PATH_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

function isValueObjectLike(value: object): boolean {
  const candidate = value as { toHexString?: unknown; equals?: unknown };
  return isFunction(candidate.toHexString) && isFunction(candidate.equals);
}

/**
 * Deeply clones JavaScript values including plain objects, arrays, `Date`, `RegExp`,
 * `Map`, `Set`, `Uint8Array`/`Buffer`, `ArrayBuffer`, and circular references.
 * Preserves value objects exposing `toHexString()` and `equals()` (e.g., `ObjectId`)
 * and strips prototype-pollution keys from cloned plain objects.
 */
export function deepClone<T>(value: T): T {
  const seen = new WeakMap<object, unknown>();

  const clone = (input: unknown): unknown => {
    if (isNullish(input) || not(isTypeof(input, "object"))) {
      return input;
    }

    const obj = input as object;
    if (seen.has(obj)) {
      return seen.get(obj);
    }

    if (isDate(obj)) {
      return new Date(obj.getTime());
    }

    if (isRegExp(obj)) {
      return new RegExp(obj.source, obj.flags);
    }

    if (isInstanceof(obj, ArrayBuffer)) {
      return obj.slice(0);
    }

    if (isInstanceof(obj, Uint8Array)) {
      if (typeof Buffer !== "undefined" && Buffer.isBuffer(obj)) {
        return Buffer.from(obj);
      }
      return new Uint8Array(obj);
    }

    if (ArrayBuffer.isView(obj)) {
      const clonedBuffer = obj.buffer.slice(
        obj.byteOffset,
        obj.byteOffset + obj.byteLength,
      );
      const Ctor = obj.constructor as new (
        buf: ArrayBufferLike,
      ) => ArrayBufferView;
      return new Ctor(clonedBuffer);
    }

    if (isMap(obj)) {
      const clonedMap = new Map<unknown, unknown>();
      seen.set(obj, clonedMap);
      for (const [k, v] of obj.entries()) {
        clonedMap.set(clone(k), clone(v));
      }
      return clonedMap;
    }

    if (isSet(obj)) {
      const clonedSet = new Set<unknown>();
      seen.set(obj, clonedSet);
      for (const item of obj.values()) {
        clonedSet.add(clone(item));
      }
      return clonedSet;
    }

    if (isArray(obj)) {
      const clonedArr: unknown[] = new Array(obj.length);
      seen.set(obj, clonedArr);
      for (let i = 0; i < obj.length; i++) {
        clonedArr[i] = clone(obj[i]);
      }
      return clonedArr;
    }

    if (isValueObjectLike(obj)) {
      return obj;
    }

    const copy: Record<string, unknown> = {};
    seen.set(obj, copy);
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (include(FORBIDDEN_PATH_KEYS, k)) {
        continue;
      }
      copy[k] = clone(v);
    }
    return copy;
  };

  return clone(value) as T;
}

/**
 * Performs structural deep equality comparison across primitives (treating `NaN === NaN`
 * and `+0 === -0`), arrays, plain objects, `Date`, `RegExp`, `Uint8Array`, `Map`, `Set`,
 * value objects with `.equals()`, and circular references.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  const visited = new WeakMap<object, WeakSet<object>>();

  const compare = (left: unknown, right: unknown): boolean => {
    if (left === right) {
      return true;
    }
    if (
      isTypeof(left, "number") &&
      isTypeof(right, "number") &&
      Number.isNaN(left) &&
      Number.isNaN(right)
    ) {
      return true;
    }
    if (
      isAnyNullish(left, right) ||
      not(isTypeof(left, "object")) ||
      not(isTypeof(right, "object"))
    ) {
      return false;
    }

    const leftObj = left as object;
    const rightObj = right as object;

    // Break circular reference loops
    let rightSet = visited.get(leftObj);
    if (rightSet?.has(rightObj)) {
      return true;
    }
    if (isUndefined(rightSet)) {
      rightSet = new WeakSet<object>();
      visited.set(leftObj, rightSet);
    }
    rightSet.add(rightObj);

    if (isDate(leftObj) && isDate(rightObj)) {
      const lt = leftObj.getTime();
      const rt = rightObj.getTime();
      return lt === rt || (Number.isNaN(lt) && Number.isNaN(rt));
    }

    if (isRegExp(leftObj) && isRegExp(rightObj)) {
      return (
        leftObj.source === rightObj.source && leftObj.flags === rightObj.flags
      );
    }

    if (
      isInstanceof(leftObj, Uint8Array) &&
      isInstanceof(rightObj, Uint8Array)
    ) {
      return (
        leftObj.byteLength === rightObj.byteLength &&
        Buffer.compare(leftObj, rightObj) === 0
      );
    }

    if (isArray(leftObj) && isArray(rightObj)) {
      if (leftObj.length !== rightObj.length) {
        return false;
      }
      for (let i = 0; i < leftObj.length; i++) {
        if (not(compare(leftObj[i], rightObj[i]))) {
          return false;
        }
      }
      return true;
    }

    if (isArray(leftObj) || isArray(rightObj)) {
      return false;
    }

    if (isSet(leftObj) && isSet(rightObj)) {
      if (leftObj.size !== rightObj.size) {
        return false;
      }
      for (const item of leftObj) {
        if (include(rightObj, item)) {
          continue;
        }
        let found = false;
        for (const candidate of rightObj) {
          if (compare(item, candidate)) {
            found = true;
            break;
          }
        }
        if (not(found)) {
          return false;
        }
      }
      return true;
    }

    if (isMap(leftObj) && isMap(rightObj)) {
      if (leftObj.size !== rightObj.size) {
        return false;
      }
      for (const [k, v] of leftObj.entries()) {
        if (include(rightObj, k)) {
          if (not(compare(v, rightObj.get(k)))) {
            return false;
          }
          continue;
        }
        let matched = false;
        for (const [rk, rv] of rightObj.entries()) {
          if (compare(k, rk) && compare(v, rv)) {
            matched = true;
            break;
          }
        }
        if (not(matched)) {
          return false;
        }
      }
      return true;
    }

    if (isValueObjectLike(leftObj) && isValueObjectLike(rightObj)) {
      return (leftObj as { equals(other: unknown): boolean }).equals(rightObj);
    }

    if (isPlainObject(leftObj) && isPlainObject(rightObj)) {
      const leftKeys = Object.keys(leftObj);
      const rightKeys = Object.keys(rightObj);
      if (leftKeys.length !== rightKeys.length) {
        return false;
      }
      for (const key of leftKeys) {
        if (not(hasOwn(rightObj, key))) {
          return false;
        }
        if (not(compare(leftObj[key], rightObj[key]))) {
          return false;
        }
      }
      return true;
    }

    return false;
  };

  return compare(a, b);
}

/**
 * Immutably deep-merges plain objects from left to right.
 * Arrays and non-plain objects are cloned and replaced rather than concatenated.
 * Prototype-pollution keys (`__proto__`, `constructor`, `prototype`) are ignored.
 */
export function deepMerge<T extends Record<string, unknown>>(
  ...sources: readonly (Partial<T> | Record<string, unknown> | undefined)[]
): T {
  const result: Record<string, unknown> = {};

  for (const source of sources) {
    if (!isPlainObject(source)) {
      continue;
    }
    for (const [key, value] of Object.entries(source)) {
      if (include(FORBIDDEN_PATH_KEYS, key) || isUndefined(value)) {
        continue;
      }
      const existing = result[key];
      if (isPlainObject(existing) && isPlainObject(value)) {
        result[key] = deepMerge(existing, value);
      } else {
        result[key] = deepClone(value);
      }
    }
  }

  return result as T;
}

/**
 * Reads a value from an object using a dot-separated path (e.g. `"user.profile.name"`).
 * Supports numeric indices and Mongo-style array property projection.
 * Blocks prototype-pollution keys (`__proto__`, `constructor`, `prototype`).
 */
export function getNestedValue(
  obj: Record<string, unknown>,
  path: string,
): unknown {
  if (!path) {
    return undefined;
  }
  const segments = path.split(".");
  for (const seg of segments) {
    if (include(FORBIDDEN_PATH_KEYS, seg)) {
      return undefined;
    }
  }

  if (segments.length === 1) {
    const key = segments[0];
    return isNotUndefined(key) ? obj[key] : undefined;
  }

  let current: unknown = obj;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (isAnyNullish(current, seg)) {
      return undefined;
    }
    if (isArray(current)) {
      if (/^\d+$/.test(seg as string)) {
        current = current[Number(seg)];
        continue;
      }
      const rest = segments.slice(i).join(".");
      return current.map((item) =>
        isObject(item) ? getNestedValue(item, rest) : undefined,
      );
    }
    if (not(isTypeof(current, "object"))) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[seg as string];
  }
  return current;
}

/**
 * Checks whether a dot-separated nested path exists as own properties on `obj`.
 * Distinguishes a key whose value is `undefined` (`true`) from a missing key (`false`).
 */
export function hasNestedValue(
  obj: Record<string, unknown>,
  path: string,
): boolean {
  if (!path) {
    return false;
  }
  const segments = path.split(".");
  for (const seg of segments) {
    if (include(FORBIDDEN_PATH_KEYS, seg)) {
      return false;
    }
  }

  let current: unknown = obj;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (isAnyNullish(current, seg) || not(isTypeof(current, "object"))) {
      return false;
    }
    if (not(hasOwn(current as object, seg as string))) {
      return false;
    }
    current = (current as Record<string, unknown>)[seg as string];
  }
  return true;
}

/**
 * Sets a value on `obj` at a dot-separated path, creating intermediate plain objects as needed.
 * Returns `false` if the path is empty or contains a forbidden prototype-pollution segment.
 */
export function setNestedValue(
  obj: Record<string, unknown>,
  path: string,
  value: unknown,
): boolean {
  if (!path) {
    return false;
  }
  const segments = path.split(".");
  for (const seg of segments) {
    if (include(FORBIDDEN_PATH_KEYS, seg)) {
      return false;
    }
  }

  if (segments.length === 1) {
    const key = segments[0];
    if (isUndefined(key)) {
      return false;
    }
    obj[key] = value;
    return true;
  }

  let current: Record<string, unknown> = obj;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    if (isUndefined(seg)) {
      return false;
    }
    const next = current[seg];
    if (isNullish(next) || not(isTypeof(next, "object"))) {
      const created: Record<string, unknown> = {};
      current[seg] = created;
      current = created;
    } else {
      current = next as Record<string, unknown>;
    }
  }

  const last = segments[segments.length - 1];
  if (isUndefined(last)) {
    return false;
  }
  current[last] = value;
  return true;
}

/**
 * Deletes a property at a dot-separated path on `obj`.
 * Returns `true` if the property existed and was deleted, `false` otherwise.
 */
export function deleteNestedValue(
  obj: Record<string, unknown>,
  path: string,
): boolean {
  if (!path) {
    return false;
  }
  const segments = path.split(".");
  for (const seg of segments) {
    if (include(FORBIDDEN_PATH_KEYS, seg)) {
      return false;
    }
  }

  if (segments.length === 1) {
    const key = segments[0];
    if (isUndefined(key) || not(hasOwn(obj, key))) {
      return false;
    }
    delete obj[key];
    return true;
  }

  let current: unknown = obj;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    if (isAnyNullish(current, seg) || not(isTypeof(current, "object"))) {
      return false;
    }
    current = (current as Record<string, unknown>)[seg as string];
  }

  const last = segments[segments.length - 1];
  if (
    not(isAnyNullish(current, last)) &&
    isTypeof(current, "object") &&
    hasOwn(current as object, last as string)
  ) {
    delete (current as Record<string, unknown>)[last as string];
    return true;
  }
  return false;
}

/**
 * Creates a shallow object containing only the specified own `keys` from `obj`.
 * Supports both direct `pick(obj, keys)` and curried `pick(keys)` usage (for `pipe` / `.map`).
 */
export function pick<T extends object, K extends keyof T>(
  obj: T,
  keys: readonly K[],
): Pick<T, K>;
export function pick<const K extends PropertyKey>(
  keys: readonly K[],
): <T extends object>(obj: T) => Pick<T, Extract<K, keyof T>>;
export function pick(
  objOrKeys: object | readonly PropertyKey[],
  maybeKeys?: readonly PropertyKey[],
):
  | Record<PropertyKey, unknown>
  | ((obj: object) => Record<PropertyKey, unknown>) {
  const exec = (
    target: object,
    keys: readonly PropertyKey[],
  ): Record<PropertyKey, unknown> => {
    const out: Record<PropertyKey, unknown> = {};
    for (const key of keys) {
      if (hasOwn(target, key)) {
        out[key] = (target as Record<PropertyKey, unknown>)[key];
      }
    }
    return out;
  };

  if (arguments.length === 1 && isArray(objOrKeys)) {
    return (target: object) =>
      exec(target, objOrKeys as readonly PropertyKey[]);
  }
  return exec(objOrKeys as object, maybeKeys ?? []);
}

/**
 * Creates a shallow copy of `obj` without the specified `keys`.
 * Supports both direct `omit(obj, keys)` and curried `omit(keys)` usage (for `pipe` / `.map`).
 */
export function omit<T extends object, K extends keyof T>(
  obj: T,
  keys: readonly K[],
): Omit<T, K>;
export function omit<const K extends PropertyKey>(
  keys: readonly K[],
): <T extends object>(obj: T) => Omit<T, K>;
export function omit(
  objOrKeys: object | readonly PropertyKey[],
  maybeKeys?: readonly PropertyKey[],
):
  | Record<PropertyKey, unknown>
  | ((obj: object) => Record<PropertyKey, unknown>) {
  const exec = (
    target: object,
    keys: readonly PropertyKey[],
  ): Record<PropertyKey, unknown> => {
    const excluded = new Set<PropertyKey>(keys);
    const out: Record<PropertyKey, unknown> = {};
    for (const key of Object.keys(target)) {
      if (not(include(excluded, key))) {
        out[key] = (target as Record<string, unknown>)[key];
      }
    }
    return out;
  };

  if (arguments.length === 1 && isArray(objOrKeys)) {
    return (target: object) =>
      exec(target, objOrKeys as readonly PropertyKey[]);
  }
  return exec(objOrKeys as object, maybeKeys ?? []);
}

/**
 * Returns a new object with all keys whose value is `undefined` omitted.
 */
export function definedOnly<T extends object>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (not(isUndefined(value))) {
      out[key] = value;
    }
  }
  return out as Partial<T>;
}

/**
 * Picks only the specified own `keys` from `obj` whose value is not `undefined`.
 * Prototype-pollution keys (`__proto__`, `constructor`, `prototype`) are ignored.
 */
export function pickDefined<T extends object, K extends keyof T>(
  obj: T,
  keys: readonly K[],
): Partial<Pick<T, K>> {
  const out: Record<PropertyKey, unknown> = {};
  for (const key of keys) {
    if (isTypeof(key, "string") && include(FORBIDDEN_PATH_KEYS, key)) {
      continue;
    }
    if (hasOwn(obj, key)) {
      const value = (obj as Record<PropertyKey, unknown>)[key];
      if (not(isUndefined(value))) {
        out[key] = value;
      }
    }
  }
  return out as Partial<Pick<T, K>>;
}

/**
 * Shallow-merges `base` with one or more partial patch objects, skipping any
 * keys whose value is `undefined` (and prototype-pollution keys).
 *
 * Ideal for applying partial update DTOs onto an existing entity:
 * `mergeDefined(existing, dto)` instead of repetitive `...(dto.x !== undefined ? { x: dto.x } : {})`.
 */
export function mergeDefined<T extends object>(
  base: T,
  ...patches: readonly (Partial<T> | undefined | null)[]
): T {
  const out: Record<string, unknown> = {
    ...(base as Record<string, unknown>),
  };
  for (const patch of patches) {
    if (isNullish(patch)) {
      continue;
    }
    for (const [key, value] of Object.entries(patch)) {
      if (include(FORBIDDEN_PATH_KEYS, key) || isUndefined(value)) {
        continue;
      }
      out[key] = value;
    }
  }
  return out as T;
}

/**
 * Creates a new object with the same own enumerable keys and values transformed by `fn`.
 */
export function mapValues<T extends Record<string, unknown>, R>(
  obj: T,
  fn: (value: T[keyof T], key: keyof T & string) => R,
): Record<keyof T & string, R> {
  const out: Record<string, R> = {};
  for (const [key, value] of Object.entries(obj)) {
    out[key] = fn(value as T[keyof T], key as keyof T & string);
  }
  return out as Record<keyof T & string, R>;
}

/**
 * Creates a new object retaining only own entries satisfying `predicate`.
 */
export function filterObject<T extends Record<string, unknown>>(
  obj: T,
  predicate: (value: T[keyof T], key: keyof T & string) => boolean,
): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (predicate(value as T[keyof T], key as keyof T & string)) {
      out[key] = value;
    }
  }
  return out as Partial<T>;
}

/**
 * Checks whether a value is a plain object with zero own enumerable keys.
 */
export function isEmptyObject(value: unknown): boolean {
  return isPlainObject(value) && Object.keys(value).length === 0;
}

/**
 * Strongly-typed `Object.keys()` returning `Array<keyof T & string>`.
 */
export function keysOf<T extends object>(obj: T): Array<keyof T & string> {
  return Object.keys(obj) as Array<keyof T & string>;
}

/**
 * Strongly-typed `Object.entries()` returning `Array<[keyof T & string, T[keyof T]]>`.
 */
export function entriesOf<T extends object>(
  obj: T,
): Array<[keyof T & string, T[keyof T]]> {
  return Object.entries(obj) as Array<[keyof T & string, T[keyof T]]>;
}

/**
 * Strongly-typed `Object.values()` returning `Array<T[keyof T]>`.
 */
export function valuesOf<T extends object>(obj: T): Array<T[keyof T]> {
  return Object.values(obj) as Array<T[keyof T]>;
}

/**
 * Swaps keys and values of a record (`{ a: "1" }` -> `{ "1": "a" }`).
 */
export function invertObject<K extends string, V extends string | number>(
  obj: Record<K, V>,
): Record<V, K> {
  const out = {} as Record<V, K>;
  for (const [k, v] of Object.entries(obj)) {
    out[v as V] = k as K;
  }
  return out;
}

/**
 * Flattens nested plain objects into a single-level dictionary with `separator`-joined keys
 * (e.g. `{ a: { b: 1 } }` -> `{ "a.b": 1 }`).
 */
export function flattenObject(
  obj: Record<string, unknown>,
  separator = ".",
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const walk = (current: Record<string, unknown>, prefix: string): void => {
    for (const [key, val] of Object.entries(current)) {
      if (include(FORBIDDEN_PATH_KEYS, key)) {
        continue;
      }
      const nextKey = prefix ? `${prefix}${separator}${key}` : key;
      if (isPlainObject(val) && Object.keys(val).length > 0) {
        walk(val, nextKey);
      } else {
        out[nextKey] = val;
      }
    }
  };
  walk(obj, "");
  return out;
}

/**
 * Reconstructs a nested plain object from a `separator`-joined flat dictionary.
 * Prototype-pollution keys (`__proto__`, `constructor`, `prototype`) are ignored.
 */
export function unflattenObject(
  obj: Record<string, unknown>,
  separator = ".",
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [flatKey, val] of Object.entries(obj)) {
    const segments = flatKey.split(separator);
    if (segments.some((seg) => include(FORBIDDEN_PATH_KEYS, seg))) {
      continue;
    }
    let current = out;
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i]!;
      const existing = current[seg];
      if (isNullish(existing) || not(isPlainObject(existing))) {
        const next: Record<string, unknown> = {};
        current[seg] = next;
        current = next;
      } else {
        current = existing as Record<string, unknown>;
      }
    }
    const last = segments[segments.length - 1];
    if (isNotUndefined(last)) {
      current[last] = val;
    }
  }
  return out;
}

/**
 * Recursively calls `Object.freeze()` on an object graph (safe against circular references).
 */
export function deepFreeze<T>(value: T): Readonly<T> {
  const seen = new WeakSet<object>();
  const freeze = (node: unknown): void => {
    if (isNullish(node) || not(isTypeof(node, "object"))) {
      return;
    }
    const obj = node as object;
    if (seen.has(obj) || Object.isFrozen(obj)) {
      return;
    }
    seen.add(obj);
    Object.freeze(obj);
    if (isArray(obj)) {
      for (const item of obj) {
        freeze(item);
      }
      return;
    }
    for (const propVal of Object.values(obj as Record<string, unknown>)) {
      freeze(propVal);
    }
  };
  freeze(value);
  return value;
}
