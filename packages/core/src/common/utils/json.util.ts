import { type Result, tryCatch } from "./functional.util";
import { not } from "./predicate.util";
import {
  isArray,
  isBigInt,
  isDate,
  isNullish,
  isPlainObject,
  isTypeof,
  isUndefined,
} from "./type-guards.util";

/**
 * Safely parses JSON into a `Result<T, Error>` without throwing.
 */
export function safeJsonParse<T = unknown>(text: string): Result<T, Error> {
  return tryCatch(() => JSON.parse(text) as T);
}

/**
 * Safely serializes a value to JSON as a `Result<string, Error>`.
 * Converts `bigint` values to strings and replaces circular references with `"[Circular]"`.
 */
export function safeJsonStringify(
  value: unknown,
  space?: number,
): Result<string, Error> {
  return tryCatch(() => {
    const ancestors: object[] = [];
    const serialized = JSON.stringify(
      value,
      function (this: unknown, _key: string, val: unknown): unknown {
        if (isBigInt(val)) {
          return val.toString();
        }
        if (isNullish(val) || not(isTypeof(val, "object"))) {
          return val;
        }
        const obj = val as object;
        const parentIndex = ancestors.indexOf(this as object);
        if (parentIndex !== -1) {
          ancestors.splice(parentIndex + 1);
        }
        if (ancestors.includes(obj)) {
          return "[Circular]";
        }
        ancestors.push(obj);
        return val;
      },
      space,
    );
    if (isUndefined(serialized)) {
      throw new TypeError("Value cannot be serialized to JSON (returned undefined)");
    }
    return serialized;
  });
}

function canonicalize(value: unknown, seen: WeakSet<object>): unknown {
  if (isNullish(value) || not(isTypeof(value, "object"))) {
    return isBigInt(value) ? value.toString() : value;
  }

  const obj = value as object;
  if (seen.has(obj)) {
    return "[Circular]";
  }

  if (isDate(obj)) {
    return obj.toISOString();
  }

  seen.add(obj);
  try {
    if (isArray(obj)) {
      return obj.map((item) => canonicalize(item, seen));
    }
    if (isPlainObject(obj)) {
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(obj).sort()) {
        const entry = obj[key];
        if (not(isUndefined(entry))) {
          sorted[key] = canonicalize(entry, seen);
        }
      }
      return sorted;
    }
    return obj;
  } finally {
    seen.delete(obj);
  }
}

/**
 * Produces a deterministic, key-sorted JSON string suitable for cache keys,
 * request fingerprinting, and structural deduplication.
 */
export function stableStringify(value: unknown): string {
  const result = safeJsonStringify(canonicalize(value, new WeakSet<object>()));
  return result.ok ? result.value : String(value);
}

/**
 * Convenience helper to parse JSON with a typed fallback instead of `Result`.
 */
export function parseJsonOr<T>(text: string, fallback: T): T {
  const parsed = safeJsonParse<T>(text);
  return parsed.ok ? parsed.value : fallback;
}
