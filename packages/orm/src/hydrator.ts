import { getDialectProfile } from "./dialect/dialect-profile";
import { ObjectId, generateObjectId } from "./driver/bson";
import type {
  CompiledColumnMetadata,
  CompiledEmbeddedMetadata,
  CompiledEntityMetadata,
} from "./metadata-graph";
import { attachSafeToJson } from "./serializer";
import type { CircularJsonStrategy, ObjectType, OrmDialect } from "./types";

/**
 * Non-enumerable symbol storing loaded foreign key column values (for virtual join columns)
 * on hydrated entities so partial saves never accidentally erase unpopulated relations.
 */
export const ORM_SHADOW_FKS = Symbol.for("bunest:orm:shadow_fks");

export function getShadowFks(entity: object): Record<string, unknown> {
  const existing = (entity as Record<PropertyKey, unknown>)[ORM_SHADOW_FKS] as
    | Record<string, unknown>
    | undefined;
  if (existing) return existing;
  const created: Record<string, unknown> = {};
  Object.defineProperty(entity, ORM_SHADOW_FKS, {
    value: created,
    enumerable: false,
    writable: true,
    configurable: true,
  });
  return created;
}

export function setShadowFk(
  entity: object,
  joinColumnName: string,
  value: unknown,
): void {
  getShadowFks(entity)[joinColumnName] = value;
}

export function getShadowFk(
  entity: object,
  joinColumnName: string,
): unknown {
  const map = (entity as Record<PropertyKey, unknown>)[ORM_SHADOW_FKS] as
    | Record<string, unknown>
    | undefined;
  return map?.[joinColumnName];
}

/**
 * Per-operation Identity Map guaranteeing that every `(EntityTarget, PrimaryKey)`
 * pair resolves to ONE live instance — enabling circular bidirectional links
 * (`user.posts[0].author === user`) with zero duplicate objects and zero infinite loops.
 */
export class IdentityMap {
  private readonly buckets = new Map<Function, Map<string, object>>();

  private makeKey(meta: CompiledEntityMetadata, pkValues: unknown[]): string {
    return pkValues.map((v) => String(v)).join("\0");
  }

  getByPkValues(
    meta: CompiledEntityMetadata,
    pkValues: unknown[],
  ): object | undefined {
    if (pkValues.some((v) => v === undefined || v === null)) {
      return undefined;
    }
    return this.buckets.get(meta.target)?.get(this.makeKey(meta, pkValues));
  }

  getByRow(
    meta: CompiledEntityMetadata,
    row: Record<string, unknown>,
    columnPrefix = "",
  ): object | undefined {
    const pkVals = meta.primaryColumns.map(
      (pk) => row[`${columnPrefix}${pk.columnName}`],
    );
    return this.getByPkValues(meta, pkVals);
  }

  set(meta: CompiledEntityMetadata, instance: object): void {
    const rec = instance as Record<string, unknown>;
    const pkVals = meta.primaryColumns.map((pk) => rec[pk.propertyName]);
    if (pkVals.some((v) => v === undefined || v === null)) {
      return;
    }
    let map = this.buckets.get(meta.target);
    if (!map) {
      map = new Map();
      this.buckets.set(meta.target, map);
    }
    map.set(this.makeKey(meta, pkVals), instance);
  }

  clear(): void {
    this.buckets.clear();
  }
}

/**
 * Safely instantiates an entity or nested class WITHOUT crashing when the class
 * has required constructor arguments or throwing field initializers.
 * Preserves `instanceof`, prototype methods, and getters cleanly!
 */
export function safeInstantiate<T = Record<string, unknown>>(
  ctor: ObjectType<T>,
): T {
  try {
    return new (ctor as new () => T)();
  } catch {
    return Object.create(ctor.prototype) as T;
  }
}

/**
 * Converts a raw DB column value into its TypeScript application value.
 */
export function fromDbValue(
  col: CompiledColumnMetadata,
  raw: unknown,
): unknown {
  if (raw === null || raw === undefined) {
    return raw === null ? null : undefined;
  }
  if (col.transformer) {
    return col.transformer.from(raw);
  }
  switch (col.type) {
    case "boolean":
      if (typeof raw === "boolean") return raw;
      if (typeof raw === "number") return raw !== 0;
      if (typeof raw === "string") return raw === "1" || raw.toLowerCase() === "true";
      return Boolean(raw);
    case "datetime":
    case "timestamp":
    case "date":
      if (raw instanceof Date) return raw;
      if (typeof raw === "string" || typeof raw === "number") {
        const d = new Date(raw);
        return Number.isNaN(d.getTime()) ? raw : d;
      }
      return raw;
    case "json":
    case "jsonb":
      if (typeof raw === "string") {
        try {
          return JSON.parse(raw);
        } catch {
          return raw;
        }
      }
      return raw;
    case "bigint":
      if (typeof raw === "bigint") return raw;
      if (typeof raw === "number" || typeof raw === "string") {
        return BigInt(raw);
      }
      return raw;
    case "integer":
    case "real":
    case "float":
    case "decimal":
      if (typeof raw === "number") return raw;
      if (typeof raw === "string" && raw.trim() !== "") {
        const num = Number(raw);
        return Number.isNaN(num) ? raw : num;
      }
      return raw;
    case "objectid":
      return raw instanceof ObjectId ? raw.toHexString() : String(raw);
    default:
      return raw instanceof ObjectId ? raw.toHexString() : raw;
  }
}

/**
 * Converts a TypeScript application value into its SQL bind parameter value.
 */
export function toDbValue(
  col: CompiledColumnMetadata,
  value: unknown,
  dialect: OrmDialect,
): unknown {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (col.transformer) {
    return col.transformer.to(value);
  }
  const profile = getDialectProfile(dialect);
  switch (col.type) {
    case "boolean":
      return profile.formatBooleanParam(Boolean(value));
    case "datetime":
    case "timestamp":
    case "date":
      if (value instanceof Date) return value.toISOString();
      return value;
    case "json":
    case "jsonb":
      return typeof value === "string" ? value : JSON.stringify(value);
    case "bigint":
      return typeof value === "bigint"
        ? profile.formatBigIntParam(value)
        : value;
    case "objectid":
      return value instanceof ObjectId ? value.toHexString() : String(value);
    default:
      return value instanceof ObjectId ? value.toHexString() : value;
  }
}

/**
 * Recursively hydrates a JSON-mode `@Embedded` / `@Nested` value (single object, array,
 * or self-recursive tree!) back into genuine class instances (`instanceof Target === true`).
 */
export function hydrateEmbeddedJsonValue(
  emb: CompiledEmbeddedMetadata,
  raw: unknown,
  depth = 0,
): unknown {
  if (raw === null || raw === undefined) {
    return raw;
  }

  let parsed = raw;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return raw;
    }
  }

  if (parsed === null || parsed === undefined) {
    return parsed;
  }

  if (depth > emb.maxDepth) {
    return parsed;
  }

  if (emb.isArray) {
    if (!Array.isArray(parsed)) return parsed;
    return parsed.map((item) => hydrateSingleJsonNestedObject(emb, item, depth));
  }

  return hydrateSingleJsonNestedObject(emb, parsed, depth);
}

function hydrateSingleJsonNestedObject(
  emb: CompiledEmbeddedMetadata,
  raw: unknown,
  depth: number,
  rootEmbedded?: CompiledEmbeddedMetadata,
): unknown {
  if (raw === null || raw === undefined || typeof raw !== "object") {
    return raw;
  }
  if (Array.isArray(raw)) {
    return raw.map((item) =>
      hydrateSingleJsonNestedObject(emb, item, depth + 1, rootEmbedded ?? emb),
    );
  }

  const effectiveEmb =
    emb.isRecursive && emb.columns.length === 0 && rootEmbedded
      ? rootEmbedded
      : emb;
  const instance = safeInstantiate(effectiveEmb.target) as Record<string, unknown>;
  const source = raw as Record<string, unknown>;

  // Copy all plain fields first (preserving dynamic/unannotated properties)
  for (const [k, v] of Object.entries(source)) {
    instance[k] = v;
  }

  // Convert declared columns (e.g., Date / boolean / custom transformer)
  for (const col of effectiveEmb.columns) {
    if (col.propertyName in source) {
      instance[col.propertyName] = fromDbValue(col, source[col.propertyName]);
    }
  }

  // Recursively hydrate nested embedded classes (including self-recursive children!)
  for (const childEmb of effectiveEmb.nestedEmbeddeds) {
    const childVal = source[childEmb.propertyName];
    if (childVal === undefined || childVal === null) continue;
    if (depth >= childEmb.maxDepth) continue;

    if (childEmb.isArray && Array.isArray(childVal)) {
      const targetMeta =
        childEmb.isRecursive && childEmb.target === effectiveEmb.target
          ? effectiveEmb
          : childEmb;
      instance[childEmb.propertyName] = childVal.map((item) =>
        hydrateSingleJsonNestedObject(
          targetMeta,
          item,
          depth + 1,
          targetMeta,
        ),
      );
    } else {
      const targetMeta =
        childEmb.isRecursive && childEmb.target === effectiveEmb.target
          ? effectiveEmb
          : childEmb;
      instance[childEmb.propertyName] = hydrateSingleJsonNestedObject(
        targetMeta,
        childVal,
        depth + 1,
        targetMeta,
      );
    }
  }

  return instance;
}

/**
 * Safely dehydrates a nested JSON-mode object/array (breaking cycles with `WeakSet`
 * so circular nested value objects NEVER throw `TypeError: cyclic object value`!).
 */
export function dehydrateEmbeddedJsonValue(
  emb: CompiledEmbeddedMetadata,
  value: unknown,
  dialect: OrmDialect,
  ancestors = new Set<object>(),
  depth = 0,
): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  if (depth > emb.maxDepth) {
    return null;
  }
  if (typeof value !== "object") {
    return value;
  }
  if (ancestors.has(value)) {
    return null;
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) =>
        dehydrateSingleJsonNestedObject(emb, item, dialect, ancestors, depth + 1),
      );
    }
    return dehydrateSingleJsonNestedObject(emb, value, dialect, ancestors, depth);
  } finally {
    ancestors.delete(value);
  }
}

function dehydrateSingleJsonNestedObject(
  emb: CompiledEmbeddedMetadata,
  value: unknown,
  dialect: OrmDialect,
  ancestors: Set<object>,
  depth: number,
  rootEmbedded?: CompiledEmbeddedMetadata,
): unknown {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((item) =>
      dehydrateSingleJsonNestedObject(
        emb,
        item,
        dialect,
        ancestors,
        depth + 1,
        rootEmbedded ?? emb,
      ),
    );
  }

  const effectiveEmb =
    emb.isRecursive && emb.columns.length === 0 && rootEmbedded
      ? rootEmbedded
      : emb;
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const key of Object.keys(src)) {
    const v = src[key];
    if (v === undefined) continue;
    if (typeof v === "object" && v !== null && ancestors.has(v)) {
      continue; // Break cycle safely!
    }
    const col = effectiveEmb.columns.find((c) => c.propertyName === key);
    if (col) {
      out[key] =
        col.type === "boolean"
          ? Boolean(v)
          : col.type === "datetime" || col.type === "timestamp" || col.type === "date"
            ? v instanceof Date
              ? v.toISOString()
              : v
            : col.transformer
              ? col.transformer.to(v)
              : v;
      continue;
    }
    const childEmb = effectiveEmb.nestedEmbeddeds.find(
      (e) => e.propertyName === key,
    );
    if (childEmb) {
      if (v === null) {
        out[key] = null;
      } else if (depth < childEmb.maxDepth) {
        ancestors.add(v as object);
        try {
          const targetMeta =
            childEmb.isRecursive && childEmb.target === effectiveEmb.target
              ? effectiveEmb
              : childEmb;
          out[key] = dehydrateSingleJsonNestedObject(
            targetMeta,
            v,
            dialect,
            ancestors,
            depth + 1,
            targetMeta,
          );
        } finally {
          ancestors.delete(v as object);
        }
      }
      continue;
    }
    if (v instanceof Date) {
      out[key] = v.toISOString();
    } else if (typeof v === "object" && v !== null) {
      ancestors.add(v);
      try {
        out[key] = dehydratePlainCycleSafe(v, ancestors, depth + 1, emb.maxDepth);
      } finally {
        ancestors.delete(v);
      }
    } else {
      out[key] = v;
    }
  }
  return out;
}

function dehydratePlainCycleSafe(
  obj: object,
  ancestors: Set<object>,
  depth: number,
  maxDepth: number,
): unknown {
  if (depth > maxDepth) return null;
  if (obj instanceof Date) return obj.toISOString();
  if (Array.isArray(obj)) {
    return obj
      .filter((item) => !(typeof item === "object" && item !== null && ancestors.has(item)))
      .map((item) => {
        if (typeof item === "object" && item !== null) {
          ancestors.add(item);
          try {
            return dehydratePlainCycleSafe(item, ancestors, depth + 1, maxDepth);
          } finally {
            ancestors.delete(item);
          }
        }
        return item;
      });
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    const val = (obj as Record<string, unknown>)[key];
    if (val === undefined) continue;
    if (typeof val === "object" && val !== null) {
      if (ancestors.has(val)) continue;
      ancestors.add(val);
      try {
        out[key] = dehydratePlainCycleSafe(val, ancestors, depth + 1, maxDepth);
      } finally {
        ancestors.delete(val);
      }
    } else {
      out[key] = val;
    }
  }
  return out;
}

/**
 * Recursively hydrates a flat-mode `@Embedded` / `@Nested` class from prefixed SQL columns.
 * Returns `null` when all columns belonging to this embedded object are `null`/`undefined`.
 */
function hydrateEmbeddedFlat(
  emb: CompiledEmbeddedMetadata,
  row: Record<string, unknown>,
  columnPrefix: string,
): unknown {
  const instance = safeInstantiate(emb.target) as Record<string, unknown>;
  let hasAnyNonNull = false;

  for (const col of emb.columns) {
    const key = `${columnPrefix}${col.columnName}`;
    if (!(key in row)) continue;
    const val = fromDbValue(col, row[key]);
    if (val !== null && val !== undefined) {
      hasAnyNonNull = true;
    }
    instance[col.propertyName] = val;
  }

  for (const child of emb.nestedEmbeddeds) {
    if (child.resolvedMode === "json" && child.jsonColumnName) {
      const key = `${columnPrefix}${child.jsonColumnName}`;
      if (key in row) {
        const val = hydrateEmbeddedJsonValue(child, row[key]);
        if (val !== null && val !== undefined) {
          hasAnyNonNull = true;
        }
        instance[child.propertyName] = val;
      }
    } else {
      const childVal = hydrateEmbeddedFlat(child, row, columnPrefix);
      if (childVal !== null && childVal !== undefined) {
        hasAnyNonNull = true;
      }
      instance[child.propertyName] = childVal;
    }
  }

  if (!hasAnyNonNull && emb.nullable) {
    return null;
  }
  return instance;
}

export interface HydrateRowOptions {
  readonly identityMap?: IdentityMap;
  readonly columnPrefix?: string;
  readonly safeJsonSerialization: boolean;
  readonly circularJsonStrategy: CircularJsonStrategy;
}

/**
 * Hydrates a SQL result row into a genuine `Entity` instance, recursively instantiating
 * all nested `@Embedded` / `@Nested` classes, recording shadow FK values, registering
 * in the per-query `IdentityMap`, and attaching cycle-safe `toJSON()`.
 */
export function hydrateEntityRow<T = Record<string, unknown>>(
  meta: CompiledEntityMetadata,
  row: Record<string, unknown>,
  options: HydrateRowOptions,
): T {
  const prefix = options.columnPrefix ?? "";

  // Check IdentityMap first so cyclic/duplicate rows return the exact same object!
  if (options.identityMap) {
    const existing = options.identityMap.getByRow(meta, row, prefix);
    if (existing) {
      return existing as T;
    }
  }

  const instance = safeInstantiate(meta.target) as Record<string, unknown>;

  for (const col of meta.columns) {
    const rowKey = `${prefix}${col.columnName}`;
    if (!(rowKey in row)) continue;
    const rawVal = row[rowKey];

    if (col.isVirtualJoinColumn) {
      setShadowFk(instance, col.columnName, fromDbValue(col, rawVal));
      continue;
    }

    if (col.isEmbeddedFlat || col.isEmbeddedJson) {
      continue; // Handled cleanly by embedded hydrators below
    }

    instance[col.propertyName] = fromDbValue(col, rawVal);
  }

  // Hydrate embedded / nested classes
  for (const emb of meta.embeddeds) {
    if (emb.resolvedMode === "json" && emb.jsonColumnName) {
      const rowKey = `${prefix}${emb.jsonColumnName}`;
      if (rowKey in row) {
        instance[emb.propertyName] = hydrateEmbeddedJsonValue(emb, row[rowKey]);
      }
    } else {
      instance[emb.propertyName] = hydrateEmbeddedFlat(emb, row, prefix);
    }
  }

  attachSafeToJson(
    instance,
    meta,
    options.safeJsonSerialization,
    options.circularJsonStrategy,
  );

  if (options.identityMap) {
    options.identityMap.set(meta, instance);
  }

  return instance as T;
}

/**
 * Extracts a column's value from an entity instance (walking embedded flat paths cleanly).
 */
export function readPropertyPath(
  obj: Record<string, unknown>,
  path: readonly string[],
): unknown {
  let curr: unknown = obj;
  for (let i = 0; i < path.length; i++) {
    if (curr === null || curr === undefined || typeof curr !== "object") {
      return undefined;
    }
    curr = (curr as Record<string, unknown>)[path[i]!];
  }
  return curr;
}

export interface DehydratedRow {
  readonly columnValues: Record<string, unknown>;
  readonly generatedValues: Record<string, unknown>;
}

/**
 * Converts an entity instance (including nested embedded classes & owning FK relations)
 * into SQL column -> bind-parameter values ready for INSERT or UPDATE.
 */
export function dehydrateEntity(
  meta: CompiledEntityMetadata,
  entity: Record<string, unknown>,
  dialect: OrmDialect,
  mode: "insert" | "update",
  deferredFkColumns?: ReadonlySet<string>,
): DehydratedRow {
  const columnValues: Record<string, unknown> = {};
  const generatedValues: Record<string, unknown> = {};
  const now = new Date();

  // Handle regular & flattened embedded columns
  for (const col of meta.columns) {
    if (col.isVirtualJoinColumn || col.isEmbeddedJson) {
      continue;
    }

    if (mode === "insert" && !col.insert) continue;
    if (mode === "update" && (!col.update || col.primary)) continue;

    // Auto-generated UUID or MongoDB ObjectId primary key
    if (
      mode === "insert" &&
      col.primary &&
      col.generated &&
      (col.generationStrategy === "uuid" || col.generationStrategy === "objectid")
    ) {
      const existing = entity[col.propertyName];
      const generatedId =
        existing !== undefined && existing !== null
          ? existing instanceof ObjectId
            ? existing.toHexString()
            : String(existing)
          : col.generationStrategy === "objectid"
            ? generateObjectId()
            : crypto.randomUUID();
      entity[col.propertyName] = generatedId;
      generatedValues[col.propertyName] = generatedId;
      columnValues[col.columnName] = generatedId;
      continue;
    }

    // Auto-increment primary key (omit on insert when undefined/null so DB generates it)
    if (
      mode === "insert" &&
      col.primary &&
      col.generated &&
      col.generationStrategy === "increment"
    ) {
      const existing = entity[col.propertyName];
      if (existing === undefined || existing === null) {
        continue;
      }
      columnValues[col.columnName] = toDbValue(col, existing, dialect);
      continue;
    }

    // Auto timestamps
    if (col.createdAt && mode === "insert") {
      const existing = entity[col.propertyName];
      const ts = existing !== undefined && existing !== null ? existing : now;
      entity[col.propertyName] = ts;
      generatedValues[col.propertyName] = ts;
      columnValues[col.columnName] = toDbValue(col, ts, dialect);
      continue;
    }
    if (col.updatedAt) {
      const ts =
        mode === "insert" &&
        entity[col.propertyName] !== undefined &&
        entity[col.propertyName] !== null
          ? entity[col.propertyName]
          : now;
      entity[col.propertyName] = ts;
      generatedValues[col.propertyName] = ts;
      columnValues[col.columnName] = toDbValue(col, ts, dialect);
      continue;
    }

    // Optimistic locking version column
    if (col.version) {
      if (mode === "insert") {
        const v =
          typeof entity[col.propertyName] === "number"
            ? (entity[col.propertyName] as number)
            : 1;
        entity[col.propertyName] = v;
        generatedValues[col.propertyName] = v;
        columnValues[col.columnName] = v;
      } else {
        const current =
          typeof entity[col.propertyName] === "number"
            ? (entity[col.propertyName] as number)
            : 1;
        const next = current + 1;
        generatedValues[col.propertyName] = next;
        columnValues[col.columnName] = next;
      }
      continue;
    }

    let val = readPropertyPath(entity, col.propertyPath);

    // Apply JS default on insert when missing
    if (val === undefined && mode === "insert" && col.hasDefault) {
      val = typeof col.default === "function" ? col.default() : col.default;
      if (col.propertyPath.length === 1) {
        entity[col.propertyName] = val;
      }
    }

    if (val === undefined) {
      if (mode === "insert" && col.nullable) {
        columnValues[col.columnName] = null;
      }
      continue;
    }

    columnValues[col.columnName] = toDbValue(col, val, dialect);
  }

  // Handle JSON-mode embedded columns
  for (const emb of meta.embeddeds) {
    if (emb.resolvedMode !== "json" || !emb.jsonColumnName) continue;
    const rawVal = entity[emb.propertyName];
    if (rawVal === undefined) {
      if (mode === "insert" && emb.nullable) {
        columnValues[emb.jsonColumnName] = null;
      }
      continue;
    }
    if (rawVal === null) {
      columnValues[emb.jsonColumnName] = null;
      continue;
    }
    const plain = dehydrateEmbeddedJsonValue(emb, rawVal, dialect);
    columnValues[emb.jsonColumnName] = JSON.stringify(plain);
  }

  // Handle owning FK columns (from populated relation objects, explicit FK columns, or preserved shadow FKs)
  for (const rel of meta.relations) {
    if (!rel.isOwning || !rel.joinColumnName || !rel.persistence) continue;
    const fkColName = rel.joinColumnName;

    if (deferredFkColumns?.has(fkColName)) {
      columnValues[fkColName] = null;
      continue;
    }

    const relVal = entity[rel.propertyName];
    const refProp = rel.referencedPropertyName ?? "id";

    if (relVal !== undefined) {
      if (relVal === null) {
        columnValues[fkColName] = null;
        if (rel.explicitFkPropertyName) {
          entity[rel.explicitFkPropertyName] = null;
        }
        setShadowFk(entity, fkColName, null);
      } else if (typeof relVal === "object") {
        const fkVal = (relVal as Record<string, unknown>)[refProp];
        if (fkVal !== undefined) {
          columnValues[fkColName] = fkVal;
          if (rel.explicitFkPropertyName) {
            entity[rel.explicitFkPropertyName] = fkVal;
          }
          setShadowFk(entity, fkColName, fkVal);
        }
      } else {
        // User assigned raw FK scalar directly to the relation property
        columnValues[fkColName] = relVal;
        if (rel.explicitFkPropertyName) {
          entity[rel.explicitFkPropertyName] = relVal;
        }
        setShadowFk(entity, fkColName, relVal);
      }
    } else if (rel.explicitFkPropertyName && entity[rel.explicitFkPropertyName] !== undefined) {
      columnValues[fkColName] = entity[rel.explicitFkPropertyName];
      setShadowFk(entity, fkColName, entity[rel.explicitFkPropertyName]);
    } else {
      // Preserve loaded shadow FK on update so partial updates don't wipe unpopulated relations!
      const shadowVal = getShadowFk(entity, fkColName);
      if (shadowVal !== undefined) {
        columnValues[fkColName] = shadowVal;
      } else if (mode === "insert" && rel.nullable) {
        columnValues[fkColName] = null;
      }
    }
  }

  return { columnValues, generatedValues };
}

/**
 * Runs lifecycle hooks (`@BeforeInsert`, `@AfterLoad`, etc.) cleanly on an entity instance.
 */
export async function invokeLifecycleHooks(
  meta: CompiledEntityMetadata,
  kind: keyof CompiledEntityMetadata["listeners"],
  entity: object,
): Promise<void> {
  const methods = meta.listeners[kind];
  if (!methods || methods.length === 0) return;
  for (const methodName of methods) {
    const fn = (entity as Record<string, unknown>)[methodName];
    if (typeof fn === "function") {
      await fn.call(entity);
    }
  }
}
