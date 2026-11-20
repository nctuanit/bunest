import { ValidationError } from "class-validator";

/**
 * Property keys that can trigger prototype pollution attacks when present
 * as own properties on untrusted payloads (ADR-009).
 */
export const DANGEROUS_PROTOTYPE_KEYS = Object.freeze([
  "__proto__",
  "constructor",
  "prototype",
] as const);

export type DangerousPrototypeKey = (typeof DANGEROUS_PROTOTYPE_KEYS)[number];

export interface DangerousKeyViolation {
  readonly path: string;
  readonly key: DangerousPrototypeKey;
  readonly segments: readonly (string | number)[];
}

function isNonTraversableObject(value: object): boolean {
  if (
    value instanceof Date ||
    value instanceof RegExp ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value) ||
    value instanceof Map ||
    value instanceof Set ||
    value instanceof WeakMap ||
    value instanceof WeakSet
  ) {
    return true;
  }

  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return true;
  }
  if (typeof URL !== "undefined" && value instanceof URL) {
    return true;
  }
  if (typeof ReadableStream !== "undefined" && value instanceof ReadableStream) {
    return true;
  }
  if (typeof Response !== "undefined" && value instanceof Response) {
    return true;
  }
  if (typeof Request !== "undefined" && value instanceof Request) {
    return true;
  }

  return false;
}

function appendSegment(parentPath: string, segment: string | number): string {
  if (typeof segment === "number") {
    return `${parentPath}[${segment}]`;
  }
  return parentPath.length > 0 ? `${parentPath}.${segment}` : segment;
}

/**
 * Recursively scans an untrusted value for own dangerous keys
 * (`"__proto__"`, `"constructor"`, `"prototype"`) using `Object.hasOwn`.
 * Guards against cyclic object graphs.
 */
export function findDangerousKeys(value: unknown): DangerousKeyViolation[] {
  const violations: DangerousKeyViolation[] = [];
  const activeAncestors = new Set<object>();

  const walk = (
    current: unknown,
    currentPath: string,
    segments: readonly (string | number)[],
  ): void => {
    if (typeof current !== "object" || current === null) {
      return;
    }

    if (activeAncestors.has(current)) {
      return;
    }

    activeAncestors.add(current);
    try {
      for (const dangerousKey of DANGEROUS_PROTOTYPE_KEYS) {
        if (Object.hasOwn(current, dangerousKey)) {
          violations.push({
            path: appendSegment(currentPath, dangerousKey),
            key: dangerousKey,
            segments: [...segments, dangerousKey],
          });
        }
      }

      if (isNonTraversableObject(current)) {
        return;
      }

      if (Array.isArray(current)) {
        for (let i = 0; i < current.length; i += 1) {
          walk(current[i], appendSegment(currentPath, i), [...segments, i]);
        }
        return;
      }

      const record = current as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        if (
          key === "__proto__" ||
          key === "constructor" ||
          key === "prototype"
        ) {
          continue;
        }
        walk(record[key], appendSegment(currentPath, key), [...segments, key]);
      }
    } finally {
      activeAncestors.delete(current);
    }
  };

  walk(value, "", []);
  return violations;
}

/**
 * Converts dangerous prototype-key violations into standard `class-validator`
 * `ValidationError` trees so both the default normalizer and custom
 * `exceptionFactory` callbacks receive a uniform error shape.
 */
export function buildDangerousKeyValidationErrors(
  violations: readonly DangerousKeyViolation[],
): ValidationError[] {
  return violations.map((violation) => {
    const leaf = new ValidationError();
    leaf.property = violation.key;
    leaf.children = [];
    leaf.constraints = {
      forbiddenKey: `property ${violation.key} is not allowed`,
    };

    let current = leaf;
    for (let i = violation.segments.length - 2; i >= 0; i -= 1) {
      const parent = new ValidationError();
      parent.property = String(violation.segments[i]);
      parent.children = [current];
      current = parent;
    }

    return current;
  });
}

/**
 * Returns a sanitized copy of a plain payload with any own dangerous prototype
 * keys (`"__proto__"`, `"constructor"`, `"prototype"`) removed recursively.
 */
export function stripDangerousKeys<T>(value: T): T {
  const seen = new WeakMap<object, unknown>();

  const clone = (current: unknown): unknown => {
    if (typeof current !== "object" || current === null) {
      return current;
    }

    if (isNonTraversableObject(current)) {
      return current;
    }

    if (seen.has(current)) {
      return seen.get(current);
    }

    if (Array.isArray(current)) {
      const arr: unknown[] = [];
      seen.set(current, arr);
      for (let i = 0; i < current.length; i += 1) {
        arr.push(clone(current[i]));
      }
      return arr;
    }

    const proto = Object.getPrototypeOf(current);
    const out: Record<string, unknown> =
      proto === null ? Object.create(null) : {};
    seen.set(current, out);

    for (const key of Object.keys(current)) {
      if (
        key === "__proto__" ||
        key === "constructor" ||
        key === "prototype"
      ) {
        continue;
      }
      out[key] = clone((current as Record<string, unknown>)[key]);
    }

    return out;
  };

  return clone(value) as T;
}
