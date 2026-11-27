import {
  DecoratorRegistry,
  getEntitySchema,
  hasEntitySchema,
} from "@bunest/core";
import { extractInversePropertyName, isEntityRef } from "./entity-ref";
import {
  CircularEmbeddedError,
  EntityMetadataNotFoundError,
  RelationMetadataError,
} from "./errors";
import {
  assertSafeSqlIdentifier,
  camelToSnake,
  inferTableName,
  makeConstraintName,
} from "./identifiers";
import {
  OrmMetadataStorage,
  getInheritanceChain,
  type StoredOrmColumnMetadata,
  type StoredOrmEmbeddedMetadata,
  type StoredOrmEntityMetadata,
  type StoredOrmIndexMetadata,
  type StoredOrmJoinColumnMetadata,
  type StoredOrmJoinTableMetadata,
  type StoredOrmListenerMetadata,
  type StoredOrmRelationMetadata,
} from "./metadata-storage";
import type {
  CascadeOption,
  EntityTarget,
  LifecycleEventKind,
  ObjectType,
  OrmColumnTransformer,
  OrmColumnType,
  PrimaryGeneratedStrategy,
  ReferentialAction,
  RelationKind,
} from "./types";

export interface CompiledColumnMetadata {
  readonly propertyName: string;
  /**
   * Dotted path for flattened embedded columns (e.g. `["address", "geo", "lat"]`),
   * or `[propertyName]` for regular entity columns.
   */
  readonly propertyPath: readonly string[];
  /**
   * Actual SQL column name on the table.
   */
  readonly columnName: string;
  readonly type: OrmColumnType;
  readonly length?: number;
  readonly precision?: number;
  readonly scale?: number;
  readonly nullable: boolean;
  readonly unique: boolean;
  readonly hasDefault: boolean;
  readonly default?: unknown;
  readonly primary: boolean;
  readonly generated: boolean;
  readonly generationStrategy?: PrimaryGeneratedStrategy;
  readonly select: boolean;
  readonly insert: boolean;
  readonly update: boolean;
  readonly enum?: readonly (string | number)[];
  readonly transformer?: OrmColumnTransformer;
  readonly createdAt: boolean;
  readonly updatedAt: boolean;
  readonly deletedAt: boolean;
  readonly version: boolean;
  readonly isEmbeddedFlat: boolean;
  readonly isEmbeddedJson: boolean;
  /**
   * True when this column was auto-synthesized as a foreign key join column
   * (no explicit `@Column()` property on the class).
   */
  readonly isVirtualJoinColumn: boolean;
  /**
   * Relation property name that owns this FK column (when applicable).
   */
  readonly relationPropertyName?: string;
}

export interface CompiledEmbeddedMetadata {
  readonly propertyName: string;
  readonly propertyPath: readonly string[];
  readonly target: ObjectType;
  readonly resolvedMode: "flat" | "json";
  readonly isArray: boolean;
  readonly nullable: boolean;
  readonly prefix: string;
  /**
   * SQL column name when `resolvedMode === "json"`.
   */
  readonly jsonColumnName?: string;
  readonly maxDepth: number;
  readonly columns: readonly CompiledColumnMetadata[];
  readonly nestedEmbeddeds: readonly CompiledEmbeddedMetadata[];
  /**
   * True when the embedded target recursively references itself or an ancestor embedded class.
   */
  readonly isRecursive: boolean;
}

export interface CompiledJoinTableMetadata {
  readonly tableName: string;
  readonly joinColumnName: string;
  readonly joinReferencedColumnName: string;
  readonly inverseJoinColumnName: string;
  readonly inverseReferencedColumnName: string;
  readonly ownerEntityName: string;
  readonly targetEntityName: string;
  readonly onDelete: ReferentialAction;
  readonly onUpdate: ReferentialAction;
}

export interface CompiledMorphTargetEntry {
  readonly typeKey: string;
  readonly target: ObjectType;
  readonly targetName: string;
  readonly primaryPropertyName: string;
  readonly primaryColumnName: string;
}

export interface CompiledRelationMetadata {
  readonly propertyName: string;
  readonly kind: RelationKind;
  readonly target: ObjectType;
  readonly targetName: string;
  readonly inversePropertyName?: string;
  readonly isOwning: boolean;
  /**
   * Foreign key SQL column name on the owning table (for `many-to-one` and owning `one-to-one`).
   */
  readonly joinColumnName?: string;
  /**
   * Referenced SQL column name on the target table (usually target's primary key column).
   */
  readonly referencedColumnName?: string;
  /**
   * Referenced property name on the target entity (usually target's primary key property).
   */
  readonly referencedPropertyName?: string;
  /**
   * If the owning entity ALSO declared an explicit `@Column()` sharing `joinColumnName`,
   * this holds that explicit property name (e.g. `"authorId"`).
   */
  readonly explicitFkPropertyName?: string;
  readonly foreignKeyConstraintName?: string;
  readonly joinTable?: CompiledJoinTableMetadata;
  /**
   * Polymorphic relation metadata (`@MorphTo` / `@MorphMany`).
   */
  readonly morphName?: string;
  readonly morphTypeColumnName?: string;
  readonly morphIdColumnName?: string;
  readonly morphTypePropertyName?: string;
  readonly morphIdPropertyName?: string;
  readonly morphTypeValue?: string;
  readonly morphTargets?: ReadonlyMap<string, CompiledMorphTargetEntry>;
  readonly morphTargetByClass?: ReadonlyMap<Function, CompiledMorphTargetEntry>;
  readonly nullable: boolean;
  readonly eager: boolean;
  readonly cascadeInsert: boolean;
  readonly cascadeUpdate: boolean;
  readonly cascadeRemove: boolean;
  readonly cascadeSoftRemove: boolean;
  readonly onDelete: ReferentialAction;
  readonly onUpdate: ReferentialAction;
  readonly createForeignKeyConstraints: boolean;
  readonly persistence: boolean;
}

export interface CompiledIndexMetadata {
  readonly name: string;
  readonly columns: readonly string[];
  readonly unique: boolean;
  readonly where?: string;
}

export interface CompiledEntityMetadata {
  readonly target: ObjectType;
  readonly name: string;
  readonly tableName: string;
  readonly schema?: string;
  readonly camelCaseMapping: boolean;
  readonly columns: readonly CompiledColumnMetadata[];
  readonly columnsByProperty: ReadonlyMap<string, CompiledColumnMetadata>;
  readonly columnsByColumnName: ReadonlyMap<string, CompiledColumnMetadata>;
  readonly primaryColumns: readonly CompiledColumnMetadata[];
  readonly primaryColumn: CompiledColumnMetadata;
  readonly deleteDateColumn?: CompiledColumnMetadata;
  readonly versionColumn?: CompiledColumnMetadata;
  readonly createDateColumns: readonly CompiledColumnMetadata[];
  readonly updateDateColumns: readonly CompiledColumnMetadata[];
  readonly embeddeds: readonly CompiledEmbeddedMetadata[];
  readonly embeddedsByProperty: ReadonlyMap<string, CompiledEmbeddedMetadata>;
  readonly relations: readonly CompiledRelationMetadata[];
  readonly relationsByProperty: ReadonlyMap<string, CompiledRelationMetadata>;
  readonly indexes: readonly CompiledIndexMetadata[];
  readonly listeners: Readonly<Record<LifecycleEventKind, readonly string[]>>;
}

export interface CompiledMetadataGraph {
  readonly entities: readonly CompiledEntityMetadata[];
  readonly byTarget: ReadonlyMap<Function, CompiledEntityMetadata>;
  readonly byName: ReadonlyMap<string, CompiledEntityMetadata>;
  readonly byTable: ReadonlyMap<string, CompiledEntityMetadata>;
  readonly joinTables: readonly CompiledJoinTableMetadata[];
  /**
   * Entities sorted in parent-before-child topological order.
   */
  readonly creationOrder: readonly CompiledEntityMetadata[];
  /**
   * Foreign key edges that form a cycle (`A -> B -> A` or self-reference),
   * formatted as `"${ownerTable}.${fkColumn}"` so the SchemaBuilder handles
   * them cleanly via deferred FK constraints / PRAGMA toggling.
   */
  readonly cyclicForeignKeys: ReadonlySet<string>;
  get(target: EntityTarget): CompiledEntityMetadata;
  find(target: EntityTarget): CompiledEntityMetadata | undefined;
}

function inferColumnType(
  designType: unknown,
  fallback: OrmColumnType = "text",
): OrmColumnType {
  if (designType === String) return "text";
  if (designType === Number) return "integer";
  if (designType === Boolean) return "boolean";
  if (designType === Date) return "datetime";
  if (designType === BigInt) return "bigint";
  if (
    designType === Uint8Array ||
    designType === ArrayBuffer ||
    (typeof Buffer !== "undefined" && designType === Buffer)
  ) {
    return "blob";
  }
  if (designType === Object || designType === Array) return "json";
  return fallback;
}

function parseCascade(cascade?: CascadeOption): {
  insert: boolean;
  update: boolean;
  remove: boolean;
  softRemove: boolean;
} {
  if (cascade === true) {
    return { insert: true, update: true, remove: true, softRemove: true };
  }
  if (!Array.isArray(cascade)) {
    return { insert: false, update: false, remove: false, softRemove: false };
  }
  return {
    insert: cascade.includes("insert"),
    update: cascade.includes("update"),
    remove: cascade.includes("remove"),
    softRemove: cascade.includes("soft-remove"),
  };
}

/**
 * Resolves an `EntityTarget` (constructor, lazy thunk `() => Class`, string name,
 * or `EntityRef<T>`) to a concrete class constructor during Phase 2 compilation.
 */
export function resolveEntityTargetClass(
  target: EntityTarget,
  localLookup?: ReadonlyMap<string, ObjectType>,
): ObjectType | undefined {
  if (target === null || target === undefined) {
    return undefined;
  }

  if (isEntityRef(target)) {
    return (
      localLookup?.get(target.name) ??
      localLookup?.get(target.name.toLowerCase()) ??
      OrmMetadataStorage.resolveByName(target.name)
    );
  }

  if (typeof target === "string") {
    return (
      localLookup?.get(target) ??
      localLookup?.get(target.toLowerCase()) ??
      OrmMetadataStorage.resolveByName(target)
    );
  }

  if (typeof target === "function") {
    // Already a known entity/embeddable class
    if (
    OrmMetadataStorage.isKnownClass(target) ||
    hasEntitySchema(target, { skipExternalResolvers: true })
  ) {
      return target as ObjectType;
    }

    // Arrow function thunk: `() => TargetClass` (no `.prototype`)
    if (target.prototype === undefined) {
      const resolved = (target as () => EntityTarget)();
      if (resolved === target) {
        return undefined;
      }
      return resolveEntityTargetClass(resolved, localLookup);
    }

    // ES class syntax: `class Foo {}`
    const src = Function.prototype.toString.call(target).trimStart();
    if (src.startsWith("class")) {
      return target as ObjectType;
    }

    // Plain `function() { return TargetClass; }` thunk
    const protoKeys = Object.getOwnPropertyNames(target.prototype);
    if (target.length === 0 && protoKeys.length <= 1) {
      try {
        const result = (target as () => unknown)();
        if (
          typeof result === "function" ||
          typeof result === "string" ||
          isEntityRef(result)
        ) {
          return resolveEntityTargetClass(result as EntityTarget, localLookup);
        }
      } catch {
        // Not a thunk; treat as constructor
      }
    }

    return target as ObjectType;
  }

  return undefined;
}

interface RawMergedClassMetadata {
  entity?: StoredOrmEntityMetadata;
  columns: StoredOrmColumnMetadata[];
  indexes: StoredOrmIndexMetadata[];
  relations: StoredOrmRelationMetadata[];
  joinColumns: Map<string, StoredOrmJoinColumnMetadata>;
  joinTables: Map<string, StoredOrmJoinTableMetadata>;
  embeddeds: StoredOrmEmbeddedMetadata[];
  listeners: StoredOrmListenerMetadata[];
}

function collectClassRawMetadata(ctor: ObjectType): RawMergedClassMetadata {
  const chain = getInheritanceChain(ctor);

  let entity: StoredOrmEntityMetadata | undefined;
  const colOrder: string[] = [];
  const colMap = new Map<string, StoredOrmColumnMetadata>();
  const indexes: StoredOrmIndexMetadata[] = [];
  const relOrder: string[] = [];
  const relMap = new Map<string, StoredOrmRelationMetadata>();
  const joinColumns = new Map<string, StoredOrmJoinColumnMetadata>();
  const joinTables = new Map<string, StoredOrmJoinTableMetadata>();
  const embOrder: string[] = [];
  const embMap = new Map<string, StoredOrmEmbeddedMetadata>();
  const listeners: StoredOrmListenerMetadata[] = [];

  // Interop: merge native `@bunest/core` unified `@Entity()` / `@Column()` metadata first
  // (skipping external lazy resolvers so ORM graph compilation never recurses back into ORM).
  const commonSchema = hasEntitySchema(ctor, { skipExternalResolvers: true })
    ? getEntitySchema(ctor, { skipExternalResolvers: true })
    : undefined;
  if (commonSchema) {
    entity = {
      explicitTableName: commonSchema.tableName,
      ...(commonSchema.schema !== undefined
        ? { schema: commonSchema.schema }
        : {}),
      camelCaseMapping: commonSchema.camelCaseMapping,
      pluralizeTableName: true,
    };
    for (const c of commonSchema.columns) {
      colOrder.push(c.propertyName);
      colMap.set(c.propertyName, {
        propertyName: c.propertyName,
        explicitName: c.name,
        type: c.type,
        ...(c.designType !== undefined ? { designType: c.designType } : {}),
        ...(c.length !== undefined ? { length: c.length } : {}),
        nullable: c.nullable,
        unique: c.unique,
        hasDefault: c.hasDefault,
        ...(c.hasDefault ? { default: c.default } : {}),
        primary: c.primary,
        generated: c.generated,
        ...(c.generationStrategy !== undefined
          ? { generationStrategy: c.generationStrategy }
          : {}),
        select: true,
        insert: true,
        update: true,
        ...(c.enum !== undefined ? { enum: c.enum } : {}),
        ...(c.transformer !== undefined ? { transformer: c.transformer } : {}),
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        deletedAt: false,
        version: false,
      });
    }
    for (const idx of commonSchema.indexes) {
      indexes.push({
        ...(idx.name !== undefined ? { name: idx.name } : {}),
        columns: [...idx.columns],
        unique: idx.unique,
        ...(idx.where !== undefined ? { where: idx.where } : {}),
      });
    }
  }

  for (const cls of chain) {
    const bucket = OrmMetadataStorage.getOwnBucket(cls);
    if (!bucket) continue;

    if (bucket.entity) {
      entity = bucket.entity;
    }
    for (const col of bucket.columns) {
      if (!colMap.has(col.propertyName)) {
        colOrder.push(col.propertyName);
      }
      colMap.set(col.propertyName, col);
    }
    for (const idx of bucket.indexes) {
      indexes.push(idx);
    }
    for (const rel of bucket.relations) {
      if (!relMap.has(rel.propertyName)) {
        relOrder.push(rel.propertyName);
      }
      relMap.set(rel.propertyName, rel);
    }
    for (const [prop, jc] of bucket.joinColumns.entries()) {
      joinColumns.set(prop, jc);
    }
    for (const [prop, jt] of bucket.joinTables.entries()) {
      joinTables.set(prop, jt);
    }
    for (const emb of bucket.embeddeds) {
      if (!embMap.has(emb.propertyName)) {
        embOrder.push(emb.propertyName);
      }
      embMap.set(emb.propertyName, emb);
    }
    for (const listener of bucket.listeners) {
      listeners.push(listener);
    }
  }

  return {
    entity,
    columns: colOrder.map((k) => colMap.get(k)!),
    indexes,
    relations: relOrder.map((k) => relMap.get(k)!),
    joinColumns,
    joinTables,
    embeddeds: embOrder.map((k) => embMap.get(k)!),
    listeners,
  };
}

function buildCompiledColumn(
  stored: StoredOrmColumnMetadata,
  camelCaseMapping: boolean,
  propertyPath: readonly string[],
  columnPrefix: string,
  forceNullable: boolean,
  isEmbeddedFlat: boolean,
): CompiledColumnMetadata {
  const baseColName =
    stored.explicitName ??
    (camelCaseMapping ? camelToSnake(stored.propertyName) : stored.propertyName);
  const columnName = `${columnPrefix}${baseColName}`;
  assertSafeSqlIdentifier(columnName, `column "${stored.propertyName}"`);

  const type: OrmColumnType =
    stored.type ??
    (stored.generationStrategy === "uuid"
      ? "uuid"
      : inferColumnType(stored.designType, "text"));

  const nullable = stored.primary
    ? false
    : forceNullable
      ? true
      : (stored.nullable ?? false);

  return {
    propertyName: stored.propertyName,
    propertyPath,
    columnName,
    type,
    ...(stored.length !== undefined ? { length: stored.length } : {}),
    ...(stored.precision !== undefined ? { precision: stored.precision } : {}),
    ...(stored.scale !== undefined ? { scale: stored.scale } : {}),
    nullable,
    unique: stored.unique,
    hasDefault: stored.hasDefault,
    ...(stored.hasDefault ? { default: stored.default } : {}),
    primary: stored.primary,
    generated: stored.generated,
    ...(stored.generationStrategy !== undefined
      ? { generationStrategy: stored.generationStrategy }
      : {}),
    select: stored.select,
    insert: stored.insert,
    update: stored.update,
    ...(stored.enum !== undefined ? { enum: stored.enum } : {}),
    ...(stored.transformer !== undefined
      ? { transformer: stored.transformer }
      : {}),
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    deletedAt: stored.deletedAt,
    version: stored.version,
    isEmbeddedFlat,
    isEmbeddedJson: false,
    isVirtualJoinColumn: false,
  };
}

/**
 * Checks whether an embedded class graph has any cycle reachable from `ctor`.
 */
function hasEmbeddedCycle(
  ctor: ObjectType,
  localLookup: ReadonlyMap<string, ObjectType>,
  visiting = new Set<Function>(),
): { cyclic: boolean; cyclePath: string[] } {
  if (visiting.has(ctor)) {
    return {
      cyclic: true,
      cyclePath: [...[...visiting].map((c) => c.name || "Anonymous"), ctor.name || "Anonymous"],
    };
  }
  visiting.add(ctor);
  const raw = collectClassRawMetadata(ctor);
  for (const emb of raw.embeddeds) {
    const target = resolveEntityTargetClass(emb.target, localLookup);
    if (!target) continue;
    // Skip checking inside explicitly json-mode nested children
    if (emb.options.mode === "json") continue;
    const sub = hasEmbeddedCycle(target, localLookup, visiting);
    if (sub.cyclic) {
      visiting.delete(ctor);
      return sub;
    }
  }
  visiting.delete(ctor);
  return { cyclic: false, cyclePath: [] };
}

function compileEmbeddedField(
  stored: StoredOrmEmbeddedMetadata,
  parentPath: readonly string[],
  parentPrefix: string,
  parentNullable: boolean,
  camelCaseMapping: boolean,
  localLookup: ReadonlyMap<string, ObjectType>,
  flatAncestors: Set<Function>,
  currentDepth: number,
  flatColumnsOut: CompiledColumnMetadata[],
): CompiledEmbeddedMetadata {
  const target = resolveEntityTargetClass(stored.target, localLookup);
  if (!target) {
    throw new EntityMetadataNotFoundError(
      stored.target,
      `Referenced by @Embedded() property "${stored.propertyName}".`,
    );
  }

  const propPath = [...parentPath, stored.propertyName];
  const isArray = stored.options.array === true;
  const nullable = parentNullable || (stored.options.nullable ?? true);
  const requestedMode = stored.options.mode ?? "auto";
  const maxDepth = stored.options.maxDepth ?? 16;

  // Detect cycle across embedded classes
  const cycleCheck = flatAncestors.has(target)
    ? {
        cyclic: true,
        cyclePath: [
          ...[...flatAncestors].map((c) => c.name || "Anonymous"),
          target.name || "Anonymous",
        ],
      }
    : hasEmbeddedCycle(target, localLookup, new Set(flatAncestors));

  // Decide storage mode cleanly:
  // - Arrays ALWAYS use "json"
  // - Explicit "json" uses "json"
  // - Explicit "flat" with unbounded cycle throws actionable CircularEmbeddedError
  //   (unless explicit maxDepth was configured)
  // - Default "auto" seamlessly switches cyclic embedded graphs to "json"!
  let resolvedMode: "flat" | "json";
  if (isArray || requestedMode === "json") {
    resolvedMode = "json";
  } else if (cycleCheck.cyclic) {
    if (requestedMode === "flat" && stored.options.maxDepth === undefined) {
      throw new CircularEmbeddedError(cycleCheck.cyclePath);
    }
    resolvedMode = requestedMode === "flat" ? "flat" : "json";
  } else {
    resolvedMode = "flat";
  }

  if (resolvedMode === "json") {
    const jsonColumnName =
      stored.options.columnName ??
      `${parentPrefix}${camelCaseMapping ? camelToSnake(stored.propertyName) : stored.propertyName}`;
    assertSafeSqlIdentifier(
      jsonColumnName,
      `embedded JSON column "${propPath.join(".")}"`,
    );

    const jsonCol: CompiledColumnMetadata = {
      propertyName: stored.propertyName,
      propertyPath: propPath,
      columnName: jsonColumnName,
      type: "json",
      nullable,
      unique: false,
      hasDefault: false,
      primary: false,
      generated: false,
      select: true,
      insert: true,
      update: true,
      createdAt: false,
      updatedAt: false,
      deletedAt: false,
      version: false,
      isEmbeddedFlat: false,
      isEmbeddedJson: true,
      isVirtualJoinColumn: false,
    };

    // Only emit a physical column if we are at the top level (not nested inside an already-JSON parent)
    if (parentPath.length === 0) {
      flatColumnsOut.push(jsonCol);
    }

    // Compile the target's own structure once (stopping recursion on cycles)
    const rawTarget = collectClassRawMetadata(target);
    const innerCols: CompiledColumnMetadata[] = rawTarget.columns.map((c) =>
      buildCompiledColumn(c, camelCaseMapping, [c.propertyName], "", false, false),
    );
    const nestedEmbeddeds: CompiledEmbeddedMetadata[] = [];
    if (!flatAncestors.has(target)) {
      const nextAnc = new Set(flatAncestors);
      nextAnc.add(target);
      for (const childEmb of rawTarget.embeddeds) {
        const childTarget = resolveEntityTargetClass(childEmb.target, localLookup);
        if (!childTarget) continue;
        if (nextAnc.has(childTarget)) {
          // Record self/mutual cycle descriptor cleanly so hydrator knows the target constructor!
          nestedEmbeddeds.push({
            propertyName: childEmb.propertyName,
            propertyPath: [...propPath, childEmb.propertyName],
            target: childTarget,
            resolvedMode: "json",
            isArray: childEmb.options.array === true,
            nullable: childEmb.options.nullable ?? true,
            prefix: "",
            maxDepth: childEmb.options.maxDepth ?? maxDepth,
            columns: [],
            nestedEmbeddeds: [],
            isRecursive: true,
          });
        } else {
          nestedEmbeddeds.push(
            compileEmbeddedField(
              childEmb,
              propPath,
              "",
              nullable,
              camelCaseMapping,
              localLookup,
              nextAnc,
              currentDepth + 1,
              [], // Do NOT emit physical columns for nested fields inside a JSON column
            ),
          );
        }
      }
    }

    return {
      propertyName: stored.propertyName,
      propertyPath: propPath,
      target,
      resolvedMode: "json",
      isArray,
      nullable,
      prefix: "",
      jsonColumnName,
      maxDepth,
      columns: innerCols,
      nestedEmbeddeds,
      isRecursive: cycleCheck.cyclic,
    };
  }

  // Flat mode: expand columns onto the parent SQL table with prefix
  let ownPrefix: string;
  if (stored.options.prefix === false) {
    ownPrefix = "";
  } else if (typeof stored.options.prefix === "string") {
    ownPrefix = stored.options.prefix;
  } else {
    ownPrefix = `${camelCaseMapping ? camelToSnake(stored.propertyName) : stored.propertyName}_`;
  }
  const combinedPrefix = `${parentPrefix}${ownPrefix}`;

  const rawTarget = collectClassRawMetadata(target);
  const directColumns: CompiledColumnMetadata[] = [];

  for (const col of rawTarget.columns) {
    const compiled = buildCompiledColumn(
      col,
      camelCaseMapping,
      [...propPath, col.propertyName],
      combinedPrefix,
      nullable,
      true,
    );
    directColumns.push(compiled);
    flatColumnsOut.push(compiled);
  }

  const nestedEmbeddeds: CompiledEmbeddedMetadata[] = [];
  if (currentDepth < maxDepth) {
    const nextAnc = new Set(flatAncestors);
    nextAnc.add(target);
    for (const childEmb of rawTarget.embeddeds) {
      nestedEmbeddeds.push(
        compileEmbeddedField(
          childEmb,
          propPath,
          combinedPrefix,
          nullable,
          camelCaseMapping,
          localLookup,
          nextAnc,
          currentDepth + 1,
          flatColumnsOut,
        ),
      );
    }
  }

  return {
    propertyName: stored.propertyName,
    propertyPath: propPath,
    target,
    resolvedMode: "flat",
    isArray: false,
    nullable,
    prefix: combinedPrefix,
    maxDepth,
    columns: directColumns,
    nestedEmbeddeds,
    isRecursive: cycleCheck.cyclic,
  };
}

/**
 * Phase 2: Compiles all registered entities, nested/embedded classes, relations,
 * join columns, join tables, and cycle-aware DDL creation order.
 *
 * Called ONLY after all user modules have finished evaluating (inside `DataSource.initialize()`),
 * eliminating all circular-import and class-declaration-order bugs!
 */
export function compileMetadataGraph(options: {
  entities?: readonly EntityTarget[];
  autoLoadEntities?: boolean;
  entityPrefix?: string;
}): CompiledMetadataGraph {
  const entityPrefix = options.entityPrefix ?? "";

  // Step 1: Collect initial seed entity classes
  const localLookup = new Map<string, ObjectType>();
  const registerLookup = (cls: ObjectType) => {
    if (cls.name) {
      localLookup.set(cls.name, cls);
      localLookup.set(cls.name.toLowerCase(), cls);
    }
    const own = OrmMetadataStorage.getOwnBucket(cls);
    if (own?.entity?.explicitName) {
      localLookup.set(own.entity.explicitName, cls);
      localLookup.set(own.entity.explicitName.toLowerCase(), cls);
    }
    if (own?.entity?.explicitTableName) {
      localLookup.set(own.entity.explicitTableName, cls);
      localLookup.set(own.entity.explicitTableName.toLowerCase(), cls);
    }
  };

  for (const reg of OrmMetadataStorage.getRegisteredEntities()) {
    registerLookup(reg);
  }
  for (const dec of DecoratorRegistry.getEntities()) {
    registerLookup(dec as ObjectType);
  }

  const discoveredSet = new Set<ObjectType>();
  const queue: ObjectType[] = [];

  const enqueue = (cls: ObjectType) => {
    if (!discoveredSet.has(cls)) {
      discoveredSet.add(cls);
      registerLookup(cls);
      queue.push(cls);
    }
  };

  if (options.autoLoadEntities) {
    for (const reg of OrmMetadataStorage.getRegisteredEntities()) {
      enqueue(reg);
    }
    for (const dec of DecoratorRegistry.getEntities()) {
      enqueue(dec as ObjectType);
    }
  }

  for (const target of options.entities ?? []) {
    const resolved = resolveEntityTargetClass(target, localLookup);
    if (!resolved) {
      throw new EntityMetadataNotFoundError(target);
    }
    enqueue(resolved);
  }

  // Step 2: Transitive BFS discovery of relation target entities!
  // Even if the user only listed `[User]` and `User` links to `Post -> Tag`,
  // we automatically discover `Post` and `Tag`!
  const rawByClass = new Map<ObjectType, RawMergedClassMetadata>();

  while (queue.length > 0) {
    const cls = queue.shift()!;
    const raw = collectClassRawMetadata(cls);
    rawByClass.set(cls, raw);

    for (const rel of raw.relations) {
      if (rel.kind === "morph-to" && rel.morphTargets) {
        const targetsList = Array.isArray(rel.morphTargets)
          ? rel.morphTargets
          : Object.values(rel.morphTargets);
        for (const morphTarget of targetsList) {
          const targetCls = resolveEntityTargetClass(morphTarget, localLookup);
          if (targetCls) {
            enqueue(targetCls);
          }
        }
        continue;
      }
      if (rel.target !== undefined) {
        const targetCls = resolveEntityTargetClass(rel.target, localLookup);
        if (targetCls) {
          enqueue(targetCls);
        }
      }
    }
  }

  // Step 3: Build base entity descriptors (tables, columns, embedded classes, primary keys)
  interface PartialEntity {
    target: ObjectType;
    name: string;
    tableName: string;
    schema?: string;
    camelCaseMapping: boolean;
    raw: RawMergedClassMetadata;
    columns: CompiledColumnMetadata[];
    embeddeds: CompiledEmbeddedMetadata[];
    primaryColumns: CompiledColumnMetadata[];
    relations: CompiledRelationMetadata[];
    indexes: CompiledIndexMetadata[];
  }

  const partialByTarget = new Map<Function, PartialEntity>();
  const partialByName = new Map<string, PartialEntity>();
  const partialByTable = new Map<string, PartialEntity>();

  for (const [cls, raw] of rawByClass.entries()) {
    const entityMeta = raw.entity;
    const pluralize = entityMeta?.pluralizeTableName ?? true;
    const camelCaseMapping = entityMeta?.camelCaseMapping ?? true;
    const baseTable =
      entityMeta?.explicitTableName ?? inferTableName(cls.name || "entity", pluralize);
    const tableName = `${entityPrefix}${baseTable}`;
    assertSafeSqlIdentifier(tableName, `table name for entity "${cls.name}"`);

    const columns: CompiledColumnMetadata[] = [];
    for (const col of raw.columns) {
      columns.push(
        buildCompiledColumn(
          col,
          camelCaseMapping,
          [col.propertyName],
          "",
          false,
          false,
        ),
      );
    }

    // Compile embedded / nested classes
    const embeddeds: CompiledEmbeddedMetadata[] = [];
    for (const emb of raw.embeddeds) {
      embeddeds.push(
        compileEmbeddedField(
          emb,
          [],
          "",
          false,
          camelCaseMapping,
          localLookup,
          new Set([cls]),
          0,
          columns,
        ),
      );
    }

    let primaryColumns = columns.filter((c) => c.primary);
    if (primaryColumns.length === 0) {
      // Fallback: if an entity has a column named "id", promote it; otherwise synthesize one
      const idColIdx = columns.findIndex((c) => c.propertyName === "id");
      if (idColIdx !== -1) {
        const promoted: CompiledColumnMetadata = {
          ...columns[idColIdx]!,
          primary: true,
          nullable: false,
        };
        columns[idColIdx] = promoted;
        primaryColumns = [promoted];
      } else {
        const synthId: CompiledColumnMetadata = {
          propertyName: "id",
          propertyPath: ["id"],
          columnName: "id",
          type: "integer",
          nullable: false,
          unique: false,
          hasDefault: false,
          primary: true,
          generated: true,
          generationStrategy: "increment",
          select: true,
          insert: true,
          update: true,
          createdAt: false,
          updatedAt: false,
          deletedAt: false,
          version: false,
          isEmbeddedFlat: false,
          isEmbeddedJson: false,
          isVirtualJoinColumn: false,
        };
        columns.unshift(synthId);
        primaryColumns = [synthId];
      }
    }

    const name = entityMeta?.explicitName ?? (cls.name || tableName);
    const partial: PartialEntity = {
      target: cls,
      name,
      tableName,
      ...(entityMeta?.schema !== undefined ? { schema: entityMeta.schema } : {}),
      camelCaseMapping,
      raw,
      columns,
      embeddeds,
      primaryColumns,
      relations: [],
      indexes: [],
    };

    partialByTarget.set(cls, partial);
    partialByName.set(name, partial);
    partialByName.set(name.toLowerCase(), partial);
    if (cls.name) {
      partialByName.set(cls.name, partial);
      partialByName.set(cls.name.toLowerCase(), partial);
    }
    partialByTable.set(tableName, partial);
  }

  // Step 4: Compile relations, pair inverse sides, synthesize join columns & join tables
  const joinTablesMap = new Map<string, CompiledJoinTableMetadata>();

  for (const partial of partialByTarget.values()) {
    for (const rel of partial.raw.relations) {
      if (rel.kind === "morph-to") {
        const rawTargets = rel.morphTargets;
        if (!rawTargets) {
          throw new RelationMetadataError(
            `@MorphTo() on "${partial.name}.${rel.propertyName}" requires at least one target entity.`,
          );
        }

        const morphTargets = new Map<string, CompiledMorphTargetEntry>();
        const morphTargetByClass = new Map<Function, CompiledMorphTargetEntry>();
        const targetPkTypes = new Set<OrmColumnType>();

        const entries: Array<[string | undefined, EntityTarget]> = Array.isArray(
          rawTargets,
        )
          ? rawTargets.map((t) => [undefined, t])
          : Object.entries(rawTargets);

        if (entries.length === 0) {
          throw new RelationMetadataError(
            `@MorphTo() on "${partial.name}.${rel.propertyName}" requires at least one target entity.`,
          );
        }

        for (const [explicitKey, targetRef] of entries) {
          const targetCls = resolveEntityTargetClass(targetRef, localLookup);
          if (!targetCls) {
            throw new RelationMetadataError(
              `Cannot resolve @MorphTo() target for "${partial.name}.${rel.propertyName}".`,
            );
          }
          const targetPartial = partialByTarget.get(targetCls);
          if (!targetPartial) {
            throw new EntityMetadataNotFoundError(
              targetCls,
              `Referenced by @MorphTo() "${partial.name}.${rel.propertyName}".`,
            );
          }
          const targetPk = targetPartial.primaryColumns[0]!;
          targetPkTypes.add(targetPk.type);
          const typeKey = explicitKey ?? targetPartial.name;
          const compiledEntry: CompiledMorphTargetEntry = {
            typeKey,
            target: targetPartial.target,
            targetName: targetPartial.name,
            primaryPropertyName: targetPk.propertyName,
            primaryColumnName: targetPk.columnName,
          };
          morphTargets.set(typeKey, compiledEntry);
          morphTargetByClass.set(targetPartial.target, compiledEntry);
        }

        const morphOpts = rel.morphToOptions ?? {};
        const defaultBase = partial.camelCaseMapping
          ? camelToSnake(rel.propertyName)
          : rel.propertyName;

        const requestedTypeCol = morphOpts.typeColumn ?? `${defaultBase}_type`;
        const requestedIdCol = morphOpts.idColumn ?? `${defaultBase}_id`;

        const existingTypeCol = partial.columns.find(
          (c) =>
            c.columnName === requestedTypeCol ||
            c.propertyName === requestedTypeCol ||
            c.propertyName === `${rel.propertyName}Type`,
        );
        const existingIdCol = partial.columns.find(
          (c) =>
            c.columnName === requestedIdCol ||
            c.propertyName === requestedIdCol ||
            c.propertyName === `${rel.propertyName}Id`,
        );

        const morphTypeColumnName =
          existingTypeCol?.columnName ??
          (morphOpts.typeColumn
            ? partial.camelCaseMapping && /[A-Z]/.test(morphOpts.typeColumn)
              ? camelToSnake(morphOpts.typeColumn)
              : morphOpts.typeColumn
            : `${defaultBase}_type`);
        const morphIdColumnName =
          existingIdCol?.columnName ??
          (morphOpts.idColumn
            ? partial.camelCaseMapping && /[A-Z]/.test(morphOpts.idColumn)
              ? camelToSnake(morphOpts.idColumn)
              : morphOpts.idColumn
            : `${defaultBase}_id`);

        assertSafeSqlIdentifier(
          morphTypeColumnName,
          `morph type column for "${partial.name}.${rel.propertyName}"`,
        );
        assertSafeSqlIdentifier(
          morphIdColumnName,
          `morph id column for "${partial.name}.${rel.propertyName}"`,
        );

        const morphNullable = morphOpts.nullable ?? rel.options.nullable ?? true;

        if (!existingTypeCol) {
          partial.columns.push({
            propertyName: `__morph_type_${rel.propertyName}`,
            propertyPath: [`__morph_type_${rel.propertyName}`],
            columnName: morphTypeColumnName,
            type: "text",
            nullable: morphNullable,
            unique: false,
            hasDefault: false,
            primary: false,
            generated: false,
            select: true,
            insert: true,
            update: true,
            createdAt: false,
            updatedAt: false,
            deletedAt: false,
            version: false,
            isEmbeddedFlat: false,
            isEmbeddedJson: false,
            isVirtualJoinColumn: true,
            relationPropertyName: rel.propertyName,
          });
        }

        if (!existingIdCol) {
          const inferredIdType: OrmColumnType =
            morphOpts.idColumnType ??
            (targetPkTypes.size === 1 ? [...targetPkTypes][0]! : "text");
          partial.columns.push({
            propertyName: `__morph_id_${rel.propertyName}`,
            propertyPath: [`__morph_id_${rel.propertyName}`],
            columnName: morphIdColumnName,
            type: inferredIdType,
            nullable: morphNullable,
            unique: false,
            hasDefault: false,
            primary: false,
            generated: false,
            select: true,
            insert: true,
            update: true,
            createdAt: false,
            updatedAt: false,
            deletedAt: false,
            version: false,
            isEmbeddedFlat: false,
            isEmbeddedJson: false,
            isVirtualJoinColumn: true,
            relationPropertyName: rel.propertyName,
          });
        }

        const firstEntry = [...morphTargets.values()][0]!;
        partial.relations.push({
          propertyName: rel.propertyName,
          kind: "morph-to",
          target: firstEntry.target,
          targetName: [...morphTargets.values()]
            .map((e) => e.targetName)
            .join("|"),
          isOwning: true,
          morphName: rel.propertyName,
          morphTypeColumnName,
          morphIdColumnName,
          ...(existingTypeCol
            ? { morphTypePropertyName: existingTypeCol.propertyName }
            : {}),
          ...(existingIdCol
            ? { morphIdPropertyName: existingIdCol.propertyName }
            : {}),
          morphTargets,
          morphTargetByClass,
          nullable: morphNullable,
          eager: rel.options.eager === true,
          cascadeInsert: false,
          cascadeUpdate: false,
          cascadeRemove: false,
          cascadeSoftRemove: false,
          onDelete: "NO ACTION",
          onUpdate: "NO ACTION",
          createForeignKeyConstraints: false,
          persistence: rel.options.persistence ?? true,
        });
        continue;
      }

      if (rel.kind === "morph-many") {
        const targetCls =
          rel.target !== undefined
            ? resolveEntityTargetClass(rel.target, localLookup)
            : undefined;
        if (!targetCls) {
          throw new RelationMetadataError(
            `Cannot resolve target for @MorphMany() relation "${partial.name}.${rel.propertyName}".`,
          );
        }
        const targetPartial = partialByTarget.get(targetCls);
        if (!targetPartial) {
          throw new EntityMetadataNotFoundError(
            targetCls,
            `Referenced by @MorphMany() "${partial.name}.${rel.propertyName}".`,
          );
        }
        const morphName = rel.morphName;
        if (!morphName) {
          throw new RelationMetadataError(
            `@MorphMany() on "${partial.name}.${rel.propertyName}" requires a morphName.`,
          );
        }
        const cascade = parseCascade(rel.options.cascade);
        const morphManyOpts = rel.morphManyOptions ?? {};
        const ownerPk = partial.primaryColumns[0]!;

        partial.relations.push({
          propertyName: rel.propertyName,
          kind: "morph-many",
          target: targetPartial.target,
          targetName: targetPartial.name,
          inversePropertyName: morphName,
          isOwning: false,
          referencedColumnName: ownerPk.columnName,
          referencedPropertyName: ownerPk.propertyName,
          morphName,
          ...(morphManyOpts.typeColumn !== undefined
            ? { morphTypeColumnName: morphManyOpts.typeColumn }
            : {}),
          ...(morphManyOpts.idColumn !== undefined
            ? { morphIdColumnName: morphManyOpts.idColumn }
            : {}),
          ...(morphManyOpts.morphType !== undefined
            ? { morphTypeValue: morphManyOpts.morphType }
            : {}),
          nullable: true,
          eager: rel.options.eager === true,
          cascadeInsert: cascade.insert,
          cascadeUpdate: cascade.update,
          cascadeRemove: cascade.remove,
          cascadeSoftRemove: cascade.softRemove,
          onDelete: "NO ACTION",
          onUpdate: "NO ACTION",
          createForeignKeyConstraints: false,
          persistence: rel.options.persistence ?? true,
        });
        continue;
      }

      const targetCls =
        rel.target !== undefined
          ? resolveEntityTargetClass(rel.target, localLookup)
          : undefined;
      if (!targetCls) {
        throw new RelationMetadataError(
          `Cannot resolve target for relation "${partial.name}.${rel.propertyName}". ` +
            `Ensure the target entity is decorated with @Entity() and loaded before DataSource.initialize().`,
        );
      }
      const targetPartial = partialByTarget.get(targetCls);
      if (!targetPartial) {
        throw new EntityMetadataNotFoundError(
          targetCls,
          `Referenced by relation "${partial.name}.${rel.propertyName}".`,
        );
      }

      const inversePropertyName = extractInversePropertyName(rel.inverseSide);
      const explicitJoinColumn = partial.raw.joinColumns.get(rel.propertyName);
      const explicitJoinTable = partial.raw.joinTables.get(rel.propertyName);
      const cascade = parseCascade(rel.options.cascade);

      // Determine ownership cleanly
      let isOwning = false;
      if (rel.kind === "many-to-one") {
        isOwning = true;
      } else if (rel.kind === "one-to-many") {
        isOwning = false;
      } else if (rel.kind === "one-to-one") {
        if (explicitJoinColumn) {
          isOwning = true;
        } else if (inversePropertyName) {
          // Check if inverse side has @JoinColumn; if not, and target doesn't own, default first side to non-owning only if inverse owns
          const targetOwns = targetPartial.raw.joinColumns.has(inversePropertyName);
          isOwning = !targetOwns && targetPartial.target === partial.target;
        } else {
          // Unidirectional @OneToOne without @JoinColumn defaults to owning side
          isOwning = true;
        }
      } else if (rel.kind === "many-to-many") {
        if (explicitJoinTable) {
          isOwning = true;
        } else if (!inversePropertyName) {
          // Unidirectional @ManyToMany defaults to owning
          isOwning = true;
        } else {
          isOwning = false;
        }
      }

      const targetPk = targetPartial.primaryColumns[0]!;
      const ownerPk = partial.primaryColumns[0]!;

      let joinColumnName: string | undefined;
      let referencedColumnName: string | undefined;
      let referencedPropertyName: string | undefined;
      let explicitFkPropertyName: string | undefined;
      let foreignKeyConstraintName: string | undefined;
      let joinTable: CompiledJoinTableMetadata | undefined;

      if (isOwning && (rel.kind === "many-to-one" || rel.kind === "one-to-one")) {
        const refColName =
          explicitJoinColumn?.options.referencedColumnName ?? targetPk.columnName;
        const refCol =
          targetPartial.columns.find(
            (c) => c.columnName === refColName || c.propertyName === refColName,
          ) ?? targetPk;

        referencedColumnName = refCol.columnName;
        referencedPropertyName = refCol.propertyName;

        joinColumnName =
          explicitJoinColumn?.options.name ??
          `${partial.camelCaseMapping ? camelToSnake(rel.propertyName) : rel.propertyName}_${refCol.columnName}`;
        assertSafeSqlIdentifier(
          joinColumnName,
          `join column for "${partial.name}.${rel.propertyName}"`,
        );

        foreignKeyConstraintName =
          explicitJoinColumn?.options.foreignKeyConstraintName ??
          makeConstraintName("fk", [partial.tableName, joinColumnName]);

        // Check if an explicit @Column() already maps to this SQL column (e.g. `authorId` -> `author_id`)
        const existingCol = partial.columns.find(
          (c) => c.columnName === joinColumnName,
        );
        if (existingCol) {
          explicitFkPropertyName = existingCol.propertyName;
        } else {
          // Synthesize a virtual FK column on the owning table
          const fkNullable = rel.options.nullable ?? true;
          const virtualCol: CompiledColumnMetadata = {
            propertyName: `__fk_${rel.propertyName}`,
            propertyPath: [`__fk_${rel.propertyName}`],
            columnName: joinColumnName,
            type: refCol.type,
            ...(refCol.length !== undefined ? { length: refCol.length } : {}),
            nullable: fkNullable,
            unique: rel.kind === "one-to-one",
            hasDefault: false,
            primary: false,
            generated: false,
            select: true,
            insert: true,
            update: true,
            createdAt: false,
            updatedAt: false,
            deletedAt: false,
            version: false,
            isEmbeddedFlat: false,
            isEmbeddedJson: false,
            isVirtualJoinColumn: true,
            relationPropertyName: rel.propertyName,
          };
          partial.columns.push(virtualCol);
        }
      } else if (isOwning && rel.kind === "many-to-many") {
        const jtOpts = explicitJoinTable?.options ?? {};
        const jtName =
          jtOpts.name ??
          `${entityPrefix}${partial.tableName}_${camelToSnake(rel.propertyName)}_${targetPartial.tableName}`;
        assertSafeSqlIdentifier(
          jtName,
          `join table for "${partial.name}.${rel.propertyName}"`,
        );

        const ownerColName =
          jtOpts.joinColumn?.name ??
          `${camelToSnake(partial.name)}_${ownerPk.columnName}`;
        const targetColName =
          jtOpts.inverseJoinColumn?.name ??
          (partial.target === targetPartial.target
            ? `related_${camelToSnake(targetPartial.name)}_${targetPk.columnName}`
            : `${camelToSnake(targetPartial.name)}_${targetPk.columnName}`);
        assertSafeSqlIdentifier(ownerColName, `join table column "${ownerColName}"`);
        assertSafeSqlIdentifier(targetColName, `join table column "${targetColName}"`);

        joinTable = {
          tableName: jtName,
          joinColumnName: ownerColName,
          joinReferencedColumnName:
            jtOpts.joinColumn?.referencedColumnName ?? ownerPk.columnName,
          inverseJoinColumnName: targetColName,
          inverseReferencedColumnName:
            jtOpts.inverseJoinColumn?.referencedColumnName ?? targetPk.columnName,
          ownerEntityName: partial.name,
          targetEntityName: targetPartial.name,
          onDelete: rel.options.onDelete ?? "CASCADE",
          onUpdate: rel.options.onUpdate ?? "CASCADE",
        };
        joinTablesMap.set(jtName, joinTable);
      }

      partial.relations.push({
        propertyName: rel.propertyName,
        kind: rel.kind,
        target: targetPartial.target,
        targetName: targetPartial.name,
        ...(inversePropertyName !== undefined ? { inversePropertyName } : {}),
        isOwning,
        ...(joinColumnName !== undefined ? { joinColumnName } : {}),
        ...(referencedColumnName !== undefined ? { referencedColumnName } : {}),
        ...(referencedPropertyName !== undefined ? { referencedPropertyName } : {}),
        ...(explicitFkPropertyName !== undefined ? { explicitFkPropertyName } : {}),
        ...(foreignKeyConstraintName !== undefined
          ? { foreignKeyConstraintName }
          : {}),
        ...(joinTable !== undefined ? { joinTable } : {}),
        nullable: rel.options.nullable ?? true,
        eager: rel.options.eager === true,
        cascadeInsert: cascade.insert,
        cascadeUpdate: cascade.update,
        cascadeRemove: cascade.remove,
        cascadeSoftRemove: cascade.softRemove,
        onDelete: rel.options.onDelete ?? (rel.options.nullable === false ? "CASCADE" : "SET NULL"),
        onUpdate: rel.options.onUpdate ?? "CASCADE",
        createForeignKeyConstraints: rel.options.createForeignKeyConstraints ?? true,
        persistence: rel.options.persistence ?? true,
      });
    }
  }

  // Step 5: Link inverse sides (so inverse OneToOne / OneToMany / ManyToMany know their owning joinColumn / joinTable!)
  for (const partial of partialByTarget.values()) {
    for (let i = 0; i < partial.relations.length; i++) {
      const rel = partial.relations[i]!;
      if (rel.isOwning) continue;

      const targetPartial = partialByTarget.get(rel.target)!;
      if (rel.kind === "morph-many") {
        const childMorphRel = targetPartial.relations.find(
          (r) => r.kind === "morph-to" && r.propertyName === rel.morphName,
        );
        const defaultBase = targetPartial.camelCaseMapping
          ? camelToSnake(rel.morphName!)
          : rel.morphName!;
        const morphTypeColumnName =
          rel.morphTypeColumnName ??
          childMorphRel?.morphTypeColumnName ??
          `${defaultBase}_type`;
        const morphIdColumnName =
          rel.morphIdColumnName ??
          childMorphRel?.morphIdColumnName ??
          `${defaultBase}_id`;
        assertSafeSqlIdentifier(
          morphTypeColumnName,
          `morph type column for "${partial.name}.${rel.propertyName}"`,
        );
        assertSafeSqlIdentifier(
          morphIdColumnName,
          `morph id column for "${partial.name}.${rel.propertyName}"`,
        );
        const inferredMorphType =
          rel.morphTypeValue ??
          childMorphRel?.morphTargetByClass?.get(partial.target)?.typeKey ??
          partial.name;

        partial.relations[i] = {
          ...rel,
          morphTypeColumnName,
          morphIdColumnName,
          morphTypeValue: inferredMorphType,
          ...(childMorphRel?.morphTypePropertyName !== undefined
            ? { morphTypePropertyName: childMorphRel.morphTypePropertyName }
            : {}),
          ...(childMorphRel?.morphIdPropertyName !== undefined
            ? { morphIdPropertyName: childMorphRel.morphIdPropertyName }
            : {}),
        };
        continue;
      }

      const inverseRel = rel.inversePropertyName
        ? targetPartial.relations.find(
            (r) => r.propertyName === rel.inversePropertyName,
          )
        : targetPartial.relations.find(
            (r) => r.target === partial.target && r.isOwning,
          );

      if (!inverseRel) {
        continue;
      }

      if (rel.kind === "one-to-many" || rel.kind === "one-to-one") {
        partial.relations[i] = {
          ...rel,
          inversePropertyName: inverseRel.propertyName,
          joinColumnName: inverseRel.joinColumnName,
          referencedColumnName: inverseRel.referencedColumnName,
          referencedPropertyName: inverseRel.referencedPropertyName,
          explicitFkPropertyName: inverseRel.explicitFkPropertyName,
        };
      } else if (rel.kind === "many-to-many" && inverseRel.joinTable) {
        // Flip joinTable columns from the inverse entity's perspective!
        partial.relations[i] = {
          ...rel,
          inversePropertyName: inverseRel.propertyName,
          joinTable: {
            ...inverseRel.joinTable,
            joinColumnName: inverseRel.joinTable.inverseJoinColumnName,
            joinReferencedColumnName:
              inverseRel.joinTable.inverseReferencedColumnName,
            inverseJoinColumnName: inverseRel.joinTable.joinColumnName,
            inverseReferencedColumnName:
              inverseRel.joinTable.joinReferencedColumnName,
            ownerEntityName: partial.name,
            targetEntityName: targetPartial.name,
          },
        };
      }
    }
  }

  // Step 6: Normalize indexes & build final CompiledEntityMetadata objects
  const compiledEntities: CompiledEntityMetadata[] = [];
  const byTarget = new Map<Function, CompiledEntityMetadata>();
  const byName = new Map<string, CompiledEntityMetadata>();
  const byTable = new Map<string, CompiledEntityMetadata>();

  for (const partial of partialByTarget.values()) {
    const columnsByProperty = new Map<string, CompiledColumnMetadata>();
    const columnsByColumnName = new Map<string, CompiledColumnMetadata>();
    for (const col of partial.columns) {
      if (!col.isVirtualJoinColumn) {
        columnsByProperty.set(col.propertyPath.join("."), col);
        if (col.propertyPath.length === 1) {
          columnsByProperty.set(col.propertyName, col);
        }
      }
      columnsByColumnName.set(col.columnName, col);
    }

    const propToCol = new Map<string, string>();
    for (const col of partial.columns) {
      propToCol.set(col.propertyPath.join("."), col.columnName);
      if (col.propertyPath.length === 1) {
        propToCol.set(col.propertyName, col.columnName);
      }
    }

    const compiledIndexes: CompiledIndexMetadata[] = partial.raw.indexes.map(
      (idx) => {
        const mappedCols = idx.columns.map(
          (c) =>
            propToCol.get(c) ??
            (partial.camelCaseMapping ? camelToSnake(c) : c),
        );
        for (const c of mappedCols) {
          assertSafeSqlIdentifier(c, `index column on "${partial.tableName}"`);
        }
        const idxName =
          idx.name ??
          makeConstraintName(idx.unique ? "uq" : "idx", [
            partial.tableName,
            ...mappedCols,
          ]);
        assertSafeSqlIdentifier(idxName, `index name on "${partial.tableName}"`);
        return {
          name: idxName,
          columns: mappedCols,
          unique: idx.unique,
          ...(idx.where !== undefined ? { where: idx.where } : {}),
        };
      },
    );

    const listeners: Record<LifecycleEventKind, string[]> = {
      "before-insert": [],
      "after-insert": [],
      "before-update": [],
      "after-update": [],
      "before-remove": [],
      "after-remove": [],
      "after-load": [],
    };
    for (const l of partial.raw.listeners) {
      if (!listeners[l.kind].includes(l.methodName)) {
        listeners[l.kind].push(l.methodName);
      }
    }

    const embeddedsByProperty = new Map<string, CompiledEmbeddedMetadata>();
    for (const emb of partial.embeddeds) {
      embeddedsByProperty.set(emb.propertyName, emb);
    }

    const relationsByProperty = new Map<string, CompiledRelationMetadata>();
    for (const rel of partial.relations) {
      relationsByProperty.set(rel.propertyName, rel);
    }

    const compiled: CompiledEntityMetadata = {
      target: partial.target,
      name: partial.name,
      tableName: partial.tableName,
      ...(partial.schema !== undefined ? { schema: partial.schema } : {}),
      camelCaseMapping: partial.camelCaseMapping,
      columns: partial.columns,
      columnsByProperty,
      columnsByColumnName,
      primaryColumns: partial.primaryColumns,
      primaryColumn: partial.primaryColumns[0]!,
      deleteDateColumn: partial.columns.find((c) => c.deletedAt),
      versionColumn: partial.columns.find((c) => c.version),
      createDateColumns: partial.columns.filter((c) => c.createdAt),
      updateDateColumns: partial.columns.filter((c) => c.updatedAt),
      embeddeds: partial.embeddeds,
      embeddedsByProperty,
      relations: partial.relations,
      relationsByProperty,
      indexes: compiledIndexes,
      listeners,
    };

    compiledEntities.push(compiled);
    byTarget.set(compiled.target, compiled);
    byName.set(compiled.name, compiled);
    byName.set(compiled.name.toLowerCase(), compiled);
    if (compiled.target.name) {
      byName.set(compiled.target.name, compiled);
      byName.set(compiled.target.name.toLowerCase(), compiled);
    }
    byTable.set(compiled.tableName, compiled);
  }

  // Step 7: Topological ordering + cyclic foreign key detection for cycle-safe DDL!
  const { creationOrder, cyclicForeignKeys } = computeDdlOrderAndCycles(
    compiledEntities,
    byTarget,
  );

  const find = (target: EntityTarget): CompiledEntityMetadata | undefined => {
    if (typeof target === "function") {
      const direct = byTarget.get(target);
      if (direct) return direct;
      const resolved = resolveEntityTargetClass(target, localLookup);
      if (resolved) return byTarget.get(resolved);
      return undefined;
    }
    if (isEntityRef(target)) {
      return (
        byName.get(target.name) ??
        byName.get(target.name.toLowerCase()) ??
        byTable.get(target.name)
      );
    }
    if (typeof target === "string") {
      return (
        byName.get(target) ??
        byName.get(target.toLowerCase()) ??
        byTable.get(target)
      );
    }
    return undefined;
  };

  const get = (target: EntityTarget): CompiledEntityMetadata => {
    const found = find(target);
    if (!found) {
      throw new EntityMetadataNotFoundError(target);
    }
    return found;
  };

  return {
    entities: compiledEntities,
    byTarget,
    byName,
    byTable,
    joinTables: [...joinTablesMap.values()],
    creationOrder,
    cyclicForeignKeys,
    get,
    find,
  };
}

/**
 * Computes a parent-before-child table creation order and identifies any cyclic
 * foreign keys (e.g. `User <-> Profile`, `A -> B -> C -> A`, or self-referencing `Category`).
 */
function computeDdlOrderAndCycles(
  entities: readonly CompiledEntityMetadata[],
  byTarget: ReadonlyMap<Function, CompiledEntityMetadata>,
): {
  creationOrder: CompiledEntityMetadata[];
  cyclicForeignKeys: Set<string>;
} {
  const deps = new Map<CompiledEntityMetadata, Set<CompiledEntityMetadata>>();
  const dependents = new Map<
    CompiledEntityMetadata,
    Set<CompiledEntityMetadata>
  >();
  const cyclicForeignKeys = new Set<string>();

  for (const e of entities) {
    deps.set(e, new Set());
    dependents.set(e, new Set());
  }

  for (const e of entities) {
    for (const rel of e.relations) {
      if (!rel.isOwning || !rel.joinColumnName || !rel.createForeignKeyConstraints) {
        continue;
      }
      const targetMeta = byTarget.get(rel.target);
      if (!targetMeta) continue;
      if (targetMeta === e) {
        // Self-referencing FK (e.g. Category.parentId -> categories.id)
        cyclicForeignKeys.add(`${e.tableName}.${rel.joinColumnName}`);
        continue;
      }
      deps.get(e)!.add(targetMeta);
      dependents.get(targetMeta)!.add(e);
    }
  }

  // Kahn's topological sort
  const inDegree = new Map<CompiledEntityMetadata, number>();
  const ready: CompiledEntityMetadata[] = [];
  for (const e of entities) {
    const deg = deps.get(e)!.size;
    inDegree.set(e, deg);
    if (deg === 0) {
      ready.push(e);
    }
  }

  const ordered: CompiledEntityMetadata[] = [];
  const placed = new Set<CompiledEntityMetadata>();

  while (ordered.length < entities.length) {
    if (ready.length > 0) {
      const next = ready.shift()!;
      ordered.push(next);
      placed.add(next);
      for (const child of dependents.get(next)!) {
        const nextDeg = (inDegree.get(child) ?? 1) - 1;
        inDegree.set(child, nextDeg);
        if (nextDeg === 0 && !placed.has(child)) {
          ready.push(child);
        }
      }
    } else {
      // Remaining entities are part of one or more FK cycles!
      // Pick the first unplaced entity, mark its unplaced outgoing FKs as cyclic, and continue.
      const remaining = entities.find((e) => !placed.has(e))!;
      for (const rel of remaining.relations) {
        if (!rel.isOwning || !rel.joinColumnName) continue;
        const targetMeta = byTarget.get(rel.target);
        if (targetMeta && !placed.has(targetMeta)) {
          cyclicForeignKeys.add(`${remaining.tableName}.${rel.joinColumnName}`);
        }
      }
      ordered.push(remaining);
      placed.add(remaining);
      for (const child of dependents.get(remaining)!) {
        const nextDeg = Math.max(0, (inDegree.get(child) ?? 1) - 1);
        inDegree.set(child, nextDeg);
        if (nextDeg === 0 && !placed.has(child)) {
          ready.push(child);
        }
      }
    }
  }

  return { creationOrder: ordered, cyclicForeignKeys };
}
