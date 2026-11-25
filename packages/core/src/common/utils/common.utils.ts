import { DESIGN_METADATA_KEYS, METADATA_KEYS } from "../constants/metadata-keys";
import { Scope } from "../enums/scope.enum";
import type {
  ParamData,
  PipeLike,
  RouteParamMetadata,
} from "../interfaces/http.interface";
import type { Type } from "../interfaces/type.interface";
import { MetadataRegistry } from "../metadata/metadata-registry";

let mixinCounter = 0;

/**
 * Marks a dynamically generated mixin class as `@Injectable()` with a unique
 * diagnostic name (matching NestJS `mixin()`).
 */
export function mixin<T extends Type<unknown>>(mixinClass: T): T {
  Object.defineProperty(mixinClass, "name", {
    value: `${mixinClass.name || "Mixin"}_${++mixinCounter}`,
    configurable: true,
  });
  if (!MetadataRegistry.has(METADATA_KEYS.INJECTABLE, mixinClass)) {
    MetadataRegistry.define(
      METADATA_KEYS.INJECTABLE,
      { scope: Scope.SINGLETON },
      mixinClass,
    );
  }
  if (!MetadataRegistry.has(DESIGN_METADATA_KEYS.PARAMTYPES, mixinClass)) {
    MetadataRegistry.define(DESIGN_METADATA_KEYS.PARAMTYPES, [], mixinClass);
  }
  return mixinClass;
}

/**
 * Recursively flattens nested arrays (matching NestJS `flatten()`).
 */
export function flatten<T extends readonly unknown[]>(
  arr: T,
): Array<T extends ReadonlyArray<infer U> ? U : T> {
  const result: unknown[] = [];
  const stack: unknown[] = [...arr];
  while (stack.length > 0) {
    const item = stack.shift();
    if (Array.isArray(item)) {
      stack.unshift(...item);
    } else {
      result.push(item);
    }
  }
  return result as Array<T extends ReadonlyArray<infer U> ? U : T>;
}

/**
 * Helper matching NestJS `assignMetadata()` for constructing route parameter metadata maps.
 */
export function assignMetadata<
  TParamtype = string | number,
  TArgs extends Record<string, RouteParamMetadata> = Record<
    string,
    RouteParamMetadata
  >,
>(
  args: TArgs,
  paramtype: TParamtype,
  index: number,
  data?: ParamData,
  ...pipes: PipeLike[]
): TArgs & Record<string, RouteParamMetadata & { pipes?: PipeLike[] }> {
  return {
    ...args,
    [`${String(paramtype)}:${index}`]: {
      index,
      data,
      pipes,
    },
  };
}

const PROTO_POLLUTION_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Recursively deletes dangerous prototype-pollution keys (`__proto__`, `constructor`,
 * `prototype`) in place from plain objects and arrays (matching NestJS v12 `stripProtoKeys()`).
 */
export function stripProtoKeys<T>(value: T): T {
  if (
    value === null ||
    typeof value !== "object" ||
    value instanceof Date ||
    value instanceof RegExp ||
    ArrayBuffer.isView(value) ||
    value instanceof ArrayBuffer
  ) {
    return value;
  }

  const visited = new WeakSet<object>();
  const walk = (node: unknown): void => {
    if (
      node === null ||
      typeof node !== "object" ||
      node instanceof Date ||
      node instanceof RegExp ||
      ArrayBuffer.isView(node) ||
      node instanceof ArrayBuffer
    ) {
      return;
    }
    if (visited.has(node)) {
      return;
    }
    visited.add(node);

    if (Array.isArray(node)) {
      // Iterate own keys only: `for (i < length)` visits every hole of a sparse
      // array (up to 2^32-1 iterations -> DoS) and reads `length` through proxies.
      for (const key of Object.keys(node)) {
        walk((node as unknown as Record<string, unknown>)[key]);
      }
      return;
    }

    const record = node as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (PROTO_POLLUTION_KEYS.has(key)) {
        delete record[key];
      } else {
        walk(record[key]);
      }
    }
  };

  walk(value);
  return value;
}
