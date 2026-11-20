import { METADATA_KEYS } from "../constants/metadata-keys";
import { Scope } from "../enums/scope.enum";
import type { PipeLike, RouteParamMetadata } from "../interfaces/http.interface";
import type { Type } from "../interfaces/type.interface";
import { MetadataRegistry } from "../metadata/metadata-registry";

let mixinCounter = 0;

/**
 * Marks a dynamically generated mixin class as `@Injectable()` with a unique
 * diagnostic name (matching NestJS `mixin()`).
 */
export function mixin<T extends Type<any>>(mixinClass: T): T {
  Object.defineProperty(mixinClass, "name", {
    value: `${mixinClass.name || "Mixin"}_${++mixinCounter}`,
    configurable: true,
  });
  if (!MetadataRegistry.hasOwn(METADATA_KEYS.INJECTABLE, mixinClass)) {
    MetadataRegistry.define(
      METADATA_KEYS.INJECTABLE,
      { scope: Scope.SINGLETON },
      mixinClass,
    );
  }
  return mixinClass;
}

/**
 * Recursively flattens nested arrays (matching NestJS `flatten()`).
 */
export function flatten<T extends any[]>(
  arr: T,
): Array<T extends Array<infer U> ? U : T> {
  const result: any[] = [];
  const stack: any[] = [...arr];
  while (stack.length > 0) {
    const item = stack.shift();
    if (Array.isArray(item)) {
      stack.unshift(...item);
    } else {
      result.push(item);
    }
  }
  return result;
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
  data?: any,
  ...pipes: PipeLike[]
): TArgs & Record<string, RouteParamMetadata & { pipes?: PipeLike[] }> {
  return {
    ...args,
    [`${String(paramtype)}:${index}`]: {
      index,
      data,
      ...(pipes.length > 0 ? { pipes } : {}),
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
      for (let i = 0; i < node.length; i++) {
        walk(node[i]);
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
