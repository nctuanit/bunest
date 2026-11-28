import { StreamableFile } from "@bunest/core";
import { isFunction, isObject, isPromiseLike } from "@bunest/core/common";
import { UnreplayableResult } from "../errors/unreplayable-result.error";

/**
 * How a handler's result is kept in a record, so that a replay hands the
 * platform (the HTTP adapter, GraphQL's field resolution, a transport's
 * serializer) the same kind of value the handler returned.
 *
 * Values JSON can't carry are tagged, as in
 * `{ "__idempotencyType": "Date", "value": "2026-09-22T10:00:00.000Z" }`:
 * Dates, BigInts, Buffers and Uint8Arrays, Maps and Sets.
 */
const TYPE = "__idempotencyType";
const OMIT = Symbol("omit");

/** Why a result, as returned, can't be stored and replayed; `undefined` if it can. */
export function unreplayableReason(value: unknown): string | undefined {
  if (value instanceof StreamableFile) {
    return "it returned a StreamableFile";
  }
  if (typeof Response !== "undefined" && value instanceof Response) {
    return "it returned a raw Response";
  }
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  if (
    typeof (value as { pipe?: unknown }).pipe === "function" ||
    (typeof ReadableStream !== "undefined" && value instanceof ReadableStream)
  ) {
    return "it returned a stream";
  }
  if (
    typeof (value as { [Symbol.asyncIterator]?: unknown })[
      Symbol.asyncIterator
    ] === "function"
  ) {
    return "it returned an async iterable";
  }
  return undefined;
}

/**
 * `strict` is for GraphQL, which awaits promises and calls functions it
 * finds in a result: a copy without them would replay something else, so
 * they make the result unreplayable instead of being left out. GraphQL also
 * reads a field through the prototype chain, so the values of a class
 * instance's getters are stored (each is read once, here), and a getter
 * that throws makes the result unreplayable.
 */
export function encodeResult(
  value: unknown,
  { strict = false }: { strict?: boolean } = {},
): unknown {
  const encoded = encode(value, strict, new Set());
  return encoded === OMIT ? undefined : encoded;
}

function encode(
  value: unknown,
  strict: boolean,
  ancestors: Set<object>,
): unknown {
  if (value instanceof Date) {
    return {
      [TYPE]: "Date",
      value: Number.isNaN(value.getTime()) ? null : value.toISOString(),
    };
  }
  if (value instanceof Uint8Array) {
    const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    return { [TYPE]: "Bytes", value: bytes.toString("base64") };
  }
  if (
    isObject(value) &&
    isFunction((value as { toJSON?: unknown }).toJSON)
  ) {
    value = (value as { toJSON: () => unknown }).toJSON();
  }

  switch (typeof value) {
    case "bigint":
      return { [TYPE]: "BigInt", value: value.toString() };
    case "number":
      return Number.isFinite(value) ? value : null;
    case "string":
    case "boolean":
      return value;
    case "function":
      if (strict) {
        throw new UnreplayableResult(
          "its result holds a function, which GraphQL calls",
        );
      }
      return OMIT;
    case "undefined":
    case "symbol":
      return OMIT;
  }

  if (value === null) {
    return null;
  }

  const object = value as Record<string, unknown>;
  if (strict && (isPromiseLike(object) || unreplayableReason(object))) {
    throw new UnreplayableResult(
      "its result holds a promise or a stream, which GraphQL awaits",
    );
  }
  if (ancestors.has(object)) {
    throw new UnreplayableResult("its result has a circular reference");
  }

  ancestors.add(object);
  try {
    const item = (entry: unknown): unknown => {
      const encoded = encode(entry, strict, ancestors);
      return encoded === OMIT ? null : encoded;
    };
    if (Array.isArray(object)) {
      return object.map(item);
    }
    if (object instanceof Map) {
      return {
        [TYPE]: "Map",
        value: [...object].map(([k, v]) => [item(k), item(v)]),
      };
    }
    if (object instanceof Set) {
      return {
        [TYPE]: "Set",
        value: [...object].map(item),
      };
    }
    const members: Record<string, unknown> = {};
    for (const key of strict ? fieldKeys(object) : Object.keys(object)) {
      const encoded = encode(
        strict ? read(object, key) : object[key],
        strict,
        ancestors,
      );
      if (encoded !== OMIT) {
        assign(members, key, encoded);
      }
    }
    // An object that happens to use the tag key is wrapped, so it can't pass for a tagged value.
    return TYPE in members ? { [TYPE]: "Object", value: members } : members;
  } finally {
    ancestors.delete(object);
  }
}

/** The inverse of `encodeResult()`. */
export function decodeResult(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(decodeResult);
  }
  if (!isObject(value)) {
    return value;
  }
  const tagged = value as Record<string, unknown>;
  switch (tagged[TYPE]) {
    case "Date":
      return new Date((tagged.value as string | null) ?? Number.NaN);
    case "BigInt":
      return BigInt(tagged.value as string);
    case "Bytes":
      return Buffer.from(tagged.value as string, "base64");
    case "Map":
      return new Map(
        (tagged.value as [unknown, unknown][]).map(([k, v]) => [
          decodeResult(k),
          decodeResult(v),
        ]),
      );
    case "Set":
      return new Set((tagged.value as unknown[]).map(decodeResult));
    case "Object":
      return decodeMembers(tagged.value as Record<string, unknown>);
    default:
      return decodeMembers(tagged);
  }
}

function decodeMembers(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const members: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    assign(members, key, decodeResult(value[key]));
  }
  return members;
}

/** Plain assignment, except that an own `__proto__` key stays a key instead of setting the prototype. */
function assign(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  if (key === "__proto__") {
    Object.defineProperty(target, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  } else {
    target[key] = value;
  }
}

/**
 * The own enumerable keys, then the getters on the prototype chain below
 * `Object.prototype`, a nearer key shadowing a farther one as in a property
 * read. A plain object has its own keys only.
 */
function fieldKeys(object: Record<string, unknown>): string[] {
  const keys = Object.keys(object);
  const seen = new Set(Object.getOwnPropertyNames(object));
  for (
    let proto: object | null = Object.getPrototypeOf(object);
    proto !== null && proto !== Object.prototype;
    proto = Object.getPrototypeOf(proto)
  ) {
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (
        !seen.has(key) &&
        key !== "__proto__" &&
        Object.getOwnPropertyDescriptor(proto, key)?.get
      ) {
        keys.push(key);
      }
      seen.add(key);
    }
  }
  return keys;
}

/** A strict-mode read, where a getter that throws makes the result unreplayable. */
function read(object: Record<string, unknown>, key: string): unknown {
  try {
    return object[key];
  } catch {
    throw new UnreplayableResult(
      `its result has a getter that throws ("${key}")`,
    );
  }
}
