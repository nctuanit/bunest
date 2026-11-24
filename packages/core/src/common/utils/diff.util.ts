import {
  deepClone,
  deepEqual,
  deleteNestedValue,
  setNestedValue,
} from "./object.util";
import { not } from "./predicate.util";
import {
  hasOwn,
  isArray,
  isNullish,
  isPlainObject,
  isRegExp,
  isString,
  isTypeof,
} from "./type-guards.util";

export type DiffKind = "added" | "removed" | "changed";

export interface DiffEntry {
  readonly kind: DiffKind;
  readonly path: string;
  readonly before?: unknown;
  readonly after?: unknown;
}

/**
 * Computes structural differences between two plain objects as a list of
 * `added`, `removed`, and `changed` dot-path entries.
 */
export function diffObjects(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): DiffEntry[] {
  const entries: DiffEntry[] = [];

  const walk = (
    left: Record<string, unknown>,
    right: Record<string, unknown>,
    prefix: string,
  ): void => {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const key of keys) {
      const path = prefix ? `${prefix}.${key}` : key;
      const inLeft = hasOwn(left, key);
      const inRight = hasOwn(right, key);

      if (not(inLeft) && inRight) {
        entries.push({ kind: "added", path, after: deepClone(right[key]) });
        continue;
      }
      if (inLeft && not(inRight)) {
        entries.push({ kind: "removed", path, before: deepClone(left[key]) });
        continue;
      }

      const leftVal = left[key];
      const rightVal = right[key];
      if (deepEqual(leftVal, rightVal)) {
        continue;
      }
      if (isPlainObject(leftVal) && isPlainObject(rightVal)) {
        walk(leftVal, rightVal, path);
        continue;
      }
      entries.push({
        kind: "changed",
        path,
        before: deepClone(leftVal),
        after: deepClone(rightVal),
      });
    }
  };

  walk(before, after, "");
  return entries;
}

/**
 * Immutably applies a list of `DiffEntry` patches produced by `diffObjects()` to a target object.
 */
export function applyPatch<T extends Record<string, unknown>>(
  target: T,
  patches: readonly DiffEntry[],
): Record<string, unknown> {
  const result: Record<string, unknown> = deepClone(target);
  for (const patch of patches) {
    if (patch.kind === "removed") {
      deleteNestedValue(result, patch.path);
    } else {
      setNestedValue(result, patch.path, deepClone(patch.after));
    }
  }
  return result;
}

export interface RedactOptions {
  /** Exact key names (case-insensitive) or RegExp patterns to redact. */
  readonly keys?: readonly (string | RegExp)[];
  /** Replacement value (default `"[REDACTED]"`). */
  readonly replacement?: unknown;
}

const DEFAULT_REDACT_PATTERNS: readonly (string | RegExp)[] = [
  /password/i,
  /passwd/i,
  /secret/i,
  /token/i,
  /apikey/i,
  /api_key/i,
  /authorization/i,
  /cookie/i,
  /private_?key/i,
];

function shouldRedactKey(
  key: string,
  patterns: readonly (string | RegExp)[],
): boolean {
  const lower = key.toLowerCase();
  for (const pat of patterns) {
    if (isString(pat)) {
      if (pat.toLowerCase() === lower) {
        return true;
      }
    } else if (isRegExp(pat) && pat.test(key)) {
      return true;
    }
  }
  return false;
}

/**
 * Deeply clones a value while redacting sensitive object keys (safe against circular references).
 */
export function redactFields<T>(value: T, options: RedactOptions = {}): T {
  const patterns = options.keys ?? DEFAULT_REDACT_PATTERNS;
  const replacement = options.replacement ?? "[REDACTED]";
  const seen = new WeakMap<object, unknown>();

  const walk = (node: unknown): unknown => {
    if (isNullish(node) || not(isTypeof(node, "object"))) {
      return node;
    }
    const obj = node as object;
    if (seen.has(obj)) {
      return seen.get(obj);
    }
    if (isArray(obj)) {
      const out: unknown[] = new Array(obj.length);
      seen.set(obj, out);
      for (let i = 0; i < obj.length; i++) {
        out[i] = walk(obj[i]);
      }
      return out;
    }
    if (not(isPlainObject(obj))) {
      return deepClone(obj);
    }
    const copy: Record<string, unknown> = {};
    seen.set(obj, copy);
    for (const [k, v] of Object.entries(obj)) {
      copy[k] = shouldRedactKey(k, patterns) ? replacement : walk(v);
    }
    return copy;
  };

  return walk(value) as T;
}
