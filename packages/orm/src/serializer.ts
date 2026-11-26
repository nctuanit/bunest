import type { CompiledEntityMetadata } from "./metadata-graph";
import type { CircularJsonStrategy } from "./types";

export const ORM_ENTITY_META = Symbol.for("bunest:orm:entity_meta");

export interface SerializeEntityOptions {
  /**
   * How to handle circular back-references along the current ancestor path:
   * - `"omit"` (default): omits the cyclic property (or skips the cyclic array item)
   * - `"id"`: replaces with `{ [pk]: idValue }` when entity metadata is present
   * - `"ref"`: replaces with `{ $ref: "EntityName#idValue" }`
   */
  readonly circularStrategy?: CircularJsonStrategy;
  /**
   * Maximum traversal depth (default: `32`).
   */
  readonly maxDepth?: number;
}

function getAttachedMeta(obj: object): CompiledEntityMetadata | undefined {
  return (obj as Record<PropertyKey, unknown>)[ORM_ENTITY_META] as
    | CompiledEntityMetadata
    | undefined;
}

function makeCircularReplacement(
  obj: object,
  strategy: CircularJsonStrategy,
): unknown {
  if (strategy === "omit") {
    return undefined;
  }
  const meta = getAttachedMeta(obj);
  const rec = obj as Record<string, unknown>;
  if (meta) {
    const pkProp = meta.primaryColumn.propertyName;
    const pkVal = rec[pkProp];
    if (strategy === "id") {
      return pkVal !== undefined ? { [pkProp]: pkVal } : undefined;
    }
    return {
      $ref: `${meta.name}#${pkVal !== undefined ? String(pkVal) : "transient"}`,
    };
  }
  if (strategy === "id" && "id" in rec && rec.id !== undefined) {
    return { id: rec.id };
  }
  return { $ref: `${obj.constructor?.name || "Object"}#circular` };
}

function serializeValue(
  value: unknown,
  ancestors: Set<object>,
  strategy: CircularJsonStrategy,
  depth: number,
  maxDepth: number,
): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return Array.from(value);
  if (depth > maxDepth) {
    return strategy === "omit" ? undefined : "[MaxDepth]";
  }

  if (ancestors.has(value)) {
    return makeCircularReplacement(value, strategy);
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      for (let i = 0; i < value.length; i++) {
        const item = value[i];
        if (typeof item === "object" && item !== null && ancestors.has(item)) {
          const replacement = makeCircularReplacement(item, strategy);
          if (replacement !== undefined) {
            out.push(replacement);
          }
          continue;
        }
        out.push(serializeValue(item, ancestors, strategy, depth + 1, maxDepth));
      }
      return out;
    }

    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      const propVal = (value as Record<string, unknown>)[key];
      if (propVal === undefined) continue;
      if (
        typeof propVal === "object" &&
        propVal !== null &&
        ancestors.has(propVal)
      ) {
        const replacement = makeCircularReplacement(propVal, strategy);
        if (replacement !== undefined) {
          out[key] = replacement;
        }
        continue;
      }
      const serialized = serializeValue(
        propVal,
        ancestors,
        strategy,
        depth + 1,
        maxDepth,
      );
      if (serialized !== undefined) {
        out[key] = serialized;
      }
    }
    return out;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Converts an entity (or arbitrarily cyclic graph of entities and nested classes)
 * into a cycle-free plain JSON-serializable object.
 *
 * Unlike `JSON.stringify()`, NEVER throws `TypeError: JSON.stringify cannot serialize cyclic structures`.
 */
export function serializeEntity<T = Record<string, unknown>>(
  entity: unknown,
  options: SerializeEntityOptions = {},
): T {
  const strategy = options.circularStrategy ?? "omit";
  const maxDepth = options.maxDepth ?? 32;
  return serializeValue(entity, new Set<object>(), strategy, 0, maxDepth) as T;
}

/**
 * Attaches non-enumerable entity metadata and a cycle-safe `toJSON()` method to
 * a hydrated entity instance so native `JSON.stringify(entity)` and HTTP `Response.json(entity)`
 * work out-of-the-box on bidirectional / cyclic entity graphs without mutating own enumerable keys.
 */
export function attachSafeToJson(
  instance: object,
  meta: CompiledEntityMetadata,
  enableSafeToJson: boolean,
  strategy: CircularJsonStrategy,
): void {
  Object.defineProperty(instance, ORM_ENTITY_META, {
    value: meta,
    enumerable: false,
    writable: true,
    configurable: true,
  });

  if (!enableSafeToJson) return;
  if (
    typeof (instance as { toJSON?: unknown }).toJSON === "function" &&
    !(instance as Record<PropertyKey, unknown>)[SAFE_TO_JSON_MARKER]
  ) {
    // Respect user-defined custom `toJSON()` methods
    return;
  }

  Object.defineProperty(instance, SAFE_TO_JSON_MARKER, {
    value: true,
    enumerable: false,
    configurable: true,
  });

  Object.defineProperty(instance, "toJSON", {
    value: function toJSON(this: object) {
      return serializeEntity(this, { circularStrategy: strategy });
    },
    enumerable: false,
    writable: true,
    configurable: true,
  });
}

const SAFE_TO_JSON_MARKER = Symbol.for("bunest:orm:safe_to_json");
