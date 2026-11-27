import {
  formatPlaceholder,
  formatTableRef,
  quoteIdentifier,
} from "./identifiers";
import {
  IdentityMap,
  getShadowFk,
  hydrateEntityRow,
  invokeLifecycleHooks,
  setShadowFk,
} from "./hydrator";
import type {
  CompiledEntityMetadata,
  CompiledMetadataGraph,
  CompiledRelationMetadata,
} from "./metadata-graph";
import type {
  CircularJsonStrategy,
  FindOptionsRelations,
  OrmQueryExecutor,
} from "./types";

interface RelationNode {
  readonly explicit: boolean;
  readonly children: Map<string, RelationNode>;
}

function getOrCreateNode(
  map: Map<string, RelationNode>,
  key: string,
  explicit: boolean,
): RelationNode {
  let existing = map.get(key);
  if (!existing) {
    existing = { explicit, children: new Map() };
    map.set(key, existing);
  } else if (explicit && !existing.explicit) {
    const upgraded: RelationNode = { explicit: true, children: existing.children };
    map.set(key, upgraded);
    return upgraded;
  }
  return existing;
}

/**
 * Normalizes both array-style (`["posts", "posts.tags"]`) and object-style
 * (`{ posts: { tags: true } }`) `relations` options into a unified tree.
 */
export function normalizeRelationsOption<Entity>(
  relations?: FindOptionsRelations<Entity>,
): Map<string, RelationNode> {
  const root = new Map<string, RelationNode>();
  if (!relations) return root;

  if (Array.isArray(relations)) {
    for (const path of relations) {
      if (typeof path !== "string" || path.trim().length === 0) continue;
      const parts = path.split(".").map((p) => p.trim()).filter(Boolean);
      let cursor = root;
      for (const part of parts) {
        const node = getOrCreateNode(cursor, part, true);
        cursor = node.children;
      }
    }
    return root;
  }

  const walkObj = (
    obj: Record<string, unknown>,
    targetMap: Map<string, RelationNode>,
  ): void => {
    for (const [key, val] of Object.entries(obj)) {
      if (!val) continue;
      const node = getOrCreateNode(targetMap, key, true);
      if (typeof val === "object" && val !== null) {
        walkObj(val as Record<string, unknown>, node.children);
      }
    }
  };

  walkObj(relations as Record<string, unknown>, root);
  return root;
}

export interface LoadRelationsContext {
  readonly executor: OrmQueryExecutor;
  readonly graph: CompiledMetadataGraph;
  readonly identityMap: IdentityMap;
  readonly withDeleted: boolean;
  readonly loadEagerRelations: boolean;
  readonly maxEagerDepth: number;
  readonly safeJsonSerialization: boolean;
  readonly circularJsonStrategy: CircularJsonStrategy;
  readonly loadedHooks: WeakSet<object>;
}

/**
 * Cycle-safe, batched (`WHERE fk IN (...)`) relation loader backed by a per-query
 * `IdentityMap`.
 *
 * - Eliminates N+1 queries and Cartesian-product row explosion across multiple `OneToMany` / `ManyToMany` relations.
 * - Guarantees mutual `eager: true` relations (`User <-> Profile`) and self-referencing trees
 *   (`Category.parent` / `Category.children`) NEVER infinite-loop, while preserving live object
 *   identity (`user.posts[0].author === user`)!
 */
export async function loadRelationsForEntities(
  meta: CompiledEntityMetadata,
  entities: object[],
  requestedTree: Map<string, RelationNode>,
  ctx: LoadRelationsContext,
  eagerDepth = 0,
  visitedEagerEdges: ReadonlySet<string> = new Set(),
): Promise<void> {
  if (entities.length === 0) return;

  // Determine which relations to load at this level (explicit + cycle-guarded eager)
  const relationsToLoad: Array<{
    rel: CompiledRelationMetadata;
    childTree: Map<string, RelationNode>;
    isEagerStep: boolean;
  }> = [];

  const seenProps = new Set<string>();

  for (const [propName, node] of requestedTree.entries()) {
    const rel = meta.relationsByProperty.get(propName);
    if (!rel) continue;
    seenProps.add(propName);
    relationsToLoad.push({
      rel,
      childTree: node.children,
      isEagerStep: false,
    });
  }

  if (ctx.loadEagerRelations && eagerDepth < ctx.maxEagerDepth) {
    for (const rel of meta.relations) {
      if (!rel.eager || seenProps.has(rel.propertyName)) continue;
      const isSelfRelation = rel.target === meta.target;
      const edgeKey = `${meta.name}.${rel.propertyName}->${rel.targetName}`;
      const reverseEdgeKey = rel.inversePropertyName
        ? `${rel.targetName}.${rel.inversePropertyName}->${meta.name}`
        : undefined;
      // For cross-entity mutual eager cycles (`User <-> Profile`), block immediate
      // ping-pong back via `visitedEagerEdges` (linking already-loaded IdentityMap objects).
      // For self-referencing trees (`Category.children -> Category`), allow expansion up to `maxEagerDepth`!
      if (
        !isSelfRelation &&
        (visitedEagerEdges.has(edgeKey) ||
          (reverseEdgeKey && visitedEagerEdges.has(reverseEdgeKey)))
      ) {
        linkFromIdentityMapOnly(meta, entities, rel, ctx);
        continue;
      }
      relationsToLoad.push({
        rel,
        childTree: new Map(),
        isEagerStep: true,
      });
    }
  }

  for (const { rel, childTree, isEagerStep } of relationsToLoad) {
    if (rel.kind === "morph-to") {
      const loadedByMeta = await loadMorphTo(
        meta,
        entities,
        rel,
        ctx,
        isEagerStep ? visitedEagerEdges : undefined,
      );
      for (const [concreteTargetMeta, group] of loadedByMeta.entries()) {
        if (group.length === 0) continue;
        const uniqueTargets = [...new Set(group)];
        const nextVisited = new Set(visitedEagerEdges);
        if (isEagerStep) {
          nextVisited.add(
            `${meta.name}.${rel.propertyName}->${concreteTargetMeta.name}`,
          );
        }
        await loadRelationsForEntities(
          concreteTargetMeta,
          uniqueTargets,
          childTree,
          ctx,
          isEagerStep ? eagerDepth + 1 : eagerDepth,
          nextVisited,
        );
      }
      continue;
    }

    const targetMeta = ctx.graph.byTarget.get(rel.target);
    if (!targetMeta) continue;

    let loadedTargets: object[] = [];

    if (rel.kind === "many-to-one" || (rel.kind === "one-to-one" && rel.isOwning)) {
      loadedTargets = await loadOwningToOne(meta, entities, rel, targetMeta, ctx);
    } else if (rel.kind === "one-to-many" || (rel.kind === "one-to-one" && !rel.isOwning)) {
      loadedTargets = await loadInverseToOneOrMany(meta, entities, rel, targetMeta, ctx);
    } else if (rel.kind === "many-to-many") {
      loadedTargets = await loadManyToMany(meta, entities, rel, targetMeta, ctx);
    } else if (rel.kind === "morph-many") {
      loadedTargets = await loadMorphMany(meta, entities, rel, targetMeta, ctx);
    }

    if (loadedTargets.length > 0) {
      // Deduplicate targets before recursing
      const uniqueTargets = [...new Set(loadedTargets)];
      const nextVisited = new Set(visitedEagerEdges);
      if (isEagerStep) {
        nextVisited.add(`${meta.name}.${rel.propertyName}->${rel.targetName}`);
        if (rel.kind === "morph-many" && rel.morphName) {
          nextVisited.add(`${rel.targetName}.${rel.morphName}->${meta.name}`);
        }
      }
      await loadRelationsForEntities(
        targetMeta,
        uniqueTargets,
        childTree,
        ctx,
        isEagerStep ? eagerDepth + 1 : eagerDepth,
        nextVisited,
      );
    }
  }
}

function readEntityFk(
  entity: object,
  rel: CompiledRelationMetadata,
): unknown {
  const rec = entity as Record<string, unknown>;
  if (rel.explicitFkPropertyName && rec[rel.explicitFkPropertyName] !== undefined) {
    return rec[rel.explicitFkPropertyName];
  }
  if (rel.joinColumnName) {
    const shadow = getShadowFk(entity, rel.joinColumnName);
    if (shadow !== undefined) return shadow;
  }
  return undefined;
}

function readMorphFields(
  entity: object,
  rel: CompiledRelationMetadata,
): { typeVal: unknown; idVal: unknown } {
  const rec = entity as Record<string, unknown>;
  const typeVal =
    rel.morphTypePropertyName && rec[rel.morphTypePropertyName] !== undefined
      ? rec[rel.morphTypePropertyName]
      : rel.morphTypeColumnName
        ? getShadowFk(entity, rel.morphTypeColumnName)
        : undefined;
  const idVal =
    rel.morphIdPropertyName && rec[rel.morphIdPropertyName] !== undefined
      ? rec[rel.morphIdPropertyName]
      : rel.morphIdColumnName
        ? getShadowFk(entity, rel.morphIdColumnName)
        : undefined;
  return { typeVal, idVal };
}

function resolveMorphTargetEntry(
  rel: CompiledRelationMetadata,
  rawType: unknown,
) {
  if (rawType === undefined || rawType === null || !rel.morphTargets) {
    return undefined;
  }
  const typeStr = String(rawType);
  const exact = rel.morphTargets.get(typeStr);
  if (exact) return exact;
  const lower = typeStr.toLowerCase();
  for (const entry of rel.morphTargets.values()) {
    if (
      entry.typeKey.toLowerCase() === lower ||
      entry.targetName.toLowerCase() === lower
    ) {
      return entry;
    }
  }
  return undefined;
}

function linkFromIdentityMapOnly(
  _meta: CompiledEntityMetadata,
  entities: object[],
  rel: CompiledRelationMetadata,
  ctx: LoadRelationsContext,
): void {
  if (rel.kind === "morph-to") {
    for (const entity of entities) {
      const { typeVal, idVal } = readMorphFields(entity, rel);
      if (
        typeVal === undefined ||
        typeVal === null ||
        idVal === undefined ||
        idVal === null
      ) {
        continue;
      }
      const entry = resolveMorphTargetEntry(rel, typeVal);
      if (!entry) continue;
      const targetMeta = ctx.graph.byTarget.get(entry.target);
      if (!targetMeta) continue;
      const existing = ctx.identityMap.getByPkValues(targetMeta, [idVal]);
      if (existing) {
        (entity as Record<string, unknown>)[rel.propertyName] = existing;
      }
    }
    return;
  }

  const targetMeta = ctx.graph.byTarget.get(rel.target);
  if (!targetMeta) return;
  if (rel.isOwning && (rel.kind === "many-to-one" || rel.kind === "one-to-one")) {
    for (const entity of entities) {
      const fkVal = readEntityFk(entity, rel);
      if (fkVal === undefined || fkVal === null) continue;
      const existing = ctx.identityMap.getByPkValues(targetMeta, [fkVal]);
      if (existing) {
        (entity as Record<string, unknown>)[rel.propertyName] = existing;
      }
    }
  }
}

async function loadOwningToOne(
  _ownerMeta: CompiledEntityMetadata,
  entities: object[],
  rel: CompiledRelationMetadata,
  targetMeta: CompiledEntityMetadata,
  ctx: LoadRelationsContext,
): Promise<object[]> {
  if (!rel.joinColumnName) return [];

  const refColName = rel.referencedColumnName ?? targetMeta.primaryColumn.columnName;
  const refPropName = rel.referencedPropertyName ?? targetMeta.primaryColumn.propertyName;
  const isRefPrimary = refColName === targetMeta.primaryColumn.columnName;

  const missingFkValues: unknown[] = [];
  const missingSet = new Set<string>();
  const targetByKey = new Map<string, object>();

  for (const entity of entities) {
    const fkVal = readEntityFk(entity, rel);
    if (fkVal === undefined || fkVal === null) {
      (entity as Record<string, unknown>)[rel.propertyName] = null;
      continue;
    }
    const key = String(fkVal);
    if (isRefPrimary) {
      const cached = ctx.identityMap.getByPkValues(targetMeta, [fkVal]);
      if (cached) {
        targetByKey.set(key, cached);
        continue;
      }
    }
    if (!missingSet.has(key)) {
      missingSet.add(key);
      missingFkValues.push(fkVal);
    }
  }

  if (missingFkValues.length > 0) {
    const dialect = ctx.executor.dialect;
    const tableRef = formatTableRef(targetMeta.tableName, targetMeta.schema, dialect);
    const refColQ = quoteIdentifier(refColName, dialect);
    const placeholders = missingFkValues
      .map((_, i) => formatPlaceholder(i + 1, dialect))
      .join(", ");

    let sql = `SELECT * FROM ${tableRef} WHERE ${refColQ} IN (${placeholders})`;
    if (!ctx.withDeleted && targetMeta.deleteDateColumn) {
      sql += ` AND ${quoteIdentifier(targetMeta.deleteDateColumn.columnName, dialect)} IS NULL`;
    }

    const res = await ctx.executor.query<Record<string, unknown>>(
      sql,
      missingFkValues,
    );
    for (const row of res.rows) {
      const hydrated = hydrateEntityRow<Record<string, unknown>>(targetMeta, row, {
        identityMap: ctx.identityMap,
        safeJsonSerialization: ctx.safeJsonSerialization,
        circularJsonStrategy: ctx.circularJsonStrategy,
      });
      if (!ctx.loadedHooks.has(hydrated)) {
        ctx.loadedHooks.add(hydrated);
        await invokeLifecycleHooks(targetMeta, "after-load", hydrated);
      }
      const keyVal = hydrated[refPropName];
      if (keyVal !== undefined && keyVal !== null) {
        targetByKey.set(String(keyVal), hydrated);
      }
    }
  }

  const allTargets: object[] = [];
  for (const entity of entities) {
    const fkVal = readEntityFk(entity, rel);
    if (fkVal === undefined || fkVal === null) {
      (entity as Record<string, unknown>)[rel.propertyName] = null;
      continue;
    }
    const found = targetByKey.get(String(fkVal)) ?? null;
    (entity as Record<string, unknown>)[rel.propertyName] = found;
    if (found) {
      allTargets.push(found);
    }
  }
  return allTargets;
}

async function loadInverseToOneOrMany(
  ownerMeta: CompiledEntityMetadata,
  entities: object[],
  rel: CompiledRelationMetadata,
  targetMeta: CompiledEntityMetadata,
  ctx: LoadRelationsContext,
): Promise<object[]> {
  if (!rel.joinColumnName) return [];

  const ownerRefProp =
    rel.referencedPropertyName ?? ownerMeta.primaryColumn.propertyName;

  const ownerIds: unknown[] = [];
  const ownerIdSet = new Set<string>();
  for (const entity of entities) {
    const idVal = (entity as Record<string, unknown>)[ownerRefProp];
    if (idVal === undefined || idVal === null) continue;
    const key = String(idVal);
    if (!ownerIdSet.has(key)) {
      ownerIdSet.add(key);
      ownerIds.push(idVal);
    }
  }

  if (ownerIds.length === 0) {
    for (const entity of entities) {
      (entity as Record<string, unknown>)[rel.propertyName] =
        rel.kind === "one-to-many" ? [] : null;
    }
    return [];
  }

  const dialect = ctx.executor.dialect;
  const targetTableRef = formatTableRef(
    targetMeta.tableName,
    targetMeta.schema,
    dialect,
  );
  const fkColQ = quoteIdentifier(rel.joinColumnName, dialect);
  const placeholders = ownerIds
    .map((_, i) => formatPlaceholder(i + 1, dialect))
    .join(", ");

  let sql = `SELECT * FROM ${targetTableRef} WHERE ${fkColQ} IN (${placeholders})`;
  if (!ctx.withDeleted && targetMeta.deleteDateColumn) {
    sql += ` AND ${quoteIdentifier(targetMeta.deleteDateColumn.columnName, dialect)} IS NULL`;
  }

  const res = await ctx.executor.query<Record<string, unknown>>(sql, ownerIds);

  const grouped = new Map<string, object[]>();
  const allTargets: object[] = [];

  for (const row of res.rows) {
    const hydrated = hydrateEntityRow<Record<string, unknown>>(targetMeta, row, {
      identityMap: ctx.identityMap,
      safeJsonSerialization: ctx.safeJsonSerialization,
      circularJsonStrategy: ctx.circularJsonStrategy,
    });
    if (!ctx.loadedHooks.has(hydrated)) {
      ctx.loadedHooks.add(hydrated);
      await invokeLifecycleHooks(targetMeta, "after-load", hydrated);
    }
    const fkVal = row[rel.joinColumnName];
    if (fkVal !== undefined && fkVal !== null) {
      setShadowFk(hydrated, rel.joinColumnName, fkVal);
      const key = String(fkVal);
      let bucket = grouped.get(key);
      if (!bucket) {
        bucket = [];
        grouped.set(key, bucket);
      }
      bucket.push(hydrated);
    }
    allTargets.push(hydrated);
  }

  for (const entity of entities) {
    const idVal = (entity as Record<string, unknown>)[ownerRefProp];
    const children =
      idVal !== undefined && idVal !== null
        ? (grouped.get(String(idVal)) ?? [])
        : [];
    if (rel.kind === "one-to-many") {
      (entity as Record<string, unknown>)[rel.propertyName] = children;
    } else {
      (entity as Record<string, unknown>)[rel.propertyName] = children[0] ?? null;
    }
  }

  return allTargets;
}

async function loadManyToMany(
  ownerMeta: CompiledEntityMetadata,
  entities: object[],
  rel: CompiledRelationMetadata,
  targetMeta: CompiledEntityMetadata,
  ctx: LoadRelationsContext,
): Promise<object[]> {
  const jt = rel.joinTable;
  if (!jt) return [];

  const ownerPkCol =
    ownerMeta.columnsByColumnName.get(jt.joinReferencedColumnName) ??
    ownerMeta.primaryColumn;
  const ownerPkProp = ownerPkCol.propertyName;

  const ownerIds: unknown[] = [];
  const ownerIdSet = new Set<string>();
  for (const entity of entities) {
    const idVal = (entity as Record<string, unknown>)[ownerPkProp];
    if (idVal === undefined || idVal === null) continue;
    const key = String(idVal);
    if (!ownerIdSet.has(key)) {
      ownerIdSet.add(key);
      ownerIds.push(idVal);
    }
  }

  if (ownerIds.length === 0) {
    for (const entity of entities) {
      (entity as Record<string, unknown>)[rel.propertyName] = [];
    }
    return [];
  }

  const dialect = ctx.executor.dialect;
  const targetTableRef = formatTableRef(
    targetMeta.tableName,
    targetMeta.schema,
    dialect,
  );
  const jtTableRef = formatTableRef(jt.tableName, ownerMeta.schema, dialect);
  const targetPkQ = quoteIdentifier(jt.inverseReferencedColumnName, dialect);
  const jtOwnerQ = quoteIdentifier(jt.joinColumnName, dialect);
  const jtTargetQ = quoteIdentifier(jt.inverseJoinColumnName, dialect);
  const ownerAliasCol = quoteIdentifier("__orm_m2m_owner_id", dialect);

  const placeholders = ownerIds
    .map((_, i) => formatPlaceholder(i + 1, dialect))
    .join(", ");

  let sql =
    `SELECT t.*, jt.${jtOwnerQ} AS ${ownerAliasCol} ` +
    `FROM ${targetTableRef} t ` +
    `INNER JOIN ${jtTableRef} jt ON t.${targetPkQ} = jt.${jtTargetQ} ` +
    `WHERE jt.${jtOwnerQ} IN (${placeholders})`;

  if (!ctx.withDeleted && targetMeta.deleteDateColumn) {
    sql += ` AND t.${quoteIdentifier(targetMeta.deleteDateColumn.columnName, dialect)} IS NULL`;
  }

  const res = await ctx.executor.query<Record<string, unknown>>(sql, ownerIds);

  const grouped = new Map<string, object[]>();
  const allTargets: object[] = [];

  for (const row of res.rows) {
    const ownerKeyVal = row["__orm_m2m_owner_id"];
    const hydrated = hydrateEntityRow<Record<string, unknown>>(targetMeta, row, {
      identityMap: ctx.identityMap,
      safeJsonSerialization: ctx.safeJsonSerialization,
      circularJsonStrategy: ctx.circularJsonStrategy,
    });
    if (!ctx.loadedHooks.has(hydrated)) {
      ctx.loadedHooks.add(hydrated);
      await invokeLifecycleHooks(targetMeta, "after-load", hydrated);
    }
    if (ownerKeyVal !== undefined && ownerKeyVal !== null) {
      const key = String(ownerKeyVal);
      let bucket = grouped.get(key);
      if (!bucket) {
        bucket = [];
        grouped.set(key, bucket);
      }
      if (!bucket.includes(hydrated)) {
        bucket.push(hydrated);
      }
    }
    allTargets.push(hydrated);
  }

  for (const entity of entities) {
    const idVal = (entity as Record<string, unknown>)[ownerPkProp];
    const items =
      idVal !== undefined && idVal !== null
        ? (grouped.get(String(idVal)) ?? [])
        : [];
    (entity as Record<string, unknown>)[rel.propertyName] = items;
  }

  return allTargets;
}

/**
 * Cycle-safe batched `@MorphTo` loader:
 * Groups parent entities by concrete morph type key and executes AT MOST ONE
 * `WHERE pk IN (...)` query per concrete target type (zero N+1 queries!).
 */
async function loadMorphTo(
  ownerMeta: CompiledEntityMetadata,
  entities: object[],
  rel: CompiledRelationMetadata,
  ctx: LoadRelationsContext,
  skipVisitedEagerEdges?: ReadonlySet<string>,
): Promise<Map<CompiledEntityMetadata, object[]>> {
  interface MorphTargetBucket {
    readonly targetMeta: CompiledEntityMetadata;
    readonly refColName: string;
    readonly refPropName: string;
    readonly skipQuery: boolean;
    readonly missingIds: unknown[];
    readonly missingSet: Set<string>;
    readonly resolvedByKey: Map<string, object>;
  }

  const bucketsByMeta = new Map<CompiledEntityMetadata, MorphTargetBucket>();
  const entityBindings: Array<{
    readonly entity: object;
    readonly bucket?: MorphTargetBucket;
    readonly idKey?: string;
  }> = [];

  for (const entity of entities) {
    const { typeVal, idVal } = readMorphFields(entity, rel);
    if (
      typeVal === undefined ||
      typeVal === null ||
      idVal === undefined ||
      idVal === null
    ) {
      (entity as Record<string, unknown>)[rel.propertyName] = null;
      entityBindings.push({ entity });
      continue;
    }

    const entry = resolveMorphTargetEntry(rel, typeVal);
    if (!entry) {
      (entity as Record<string, unknown>)[rel.propertyName] = null;
      entityBindings.push({ entity });
      continue;
    }

    const targetMeta = ctx.graph.byTarget.get(entry.target);
    if (!targetMeta) {
      (entity as Record<string, unknown>)[rel.propertyName] = null;
      entityBindings.push({ entity });
      continue;
    }

    let bucket = bucketsByMeta.get(targetMeta);
    if (!bucket) {
      const edgeKey = `${ownerMeta.name}.${rel.propertyName}->${targetMeta.name}`;
      bucket = {
        targetMeta,
        refColName: entry.primaryColumnName,
        refPropName: entry.primaryPropertyName,
        skipQuery: skipVisitedEagerEdges?.has(edgeKey) === true,
        missingIds: [],
        missingSet: new Set<string>(),
        resolvedByKey: new Map<string, object>(),
      };
      bucketsByMeta.set(targetMeta, bucket);
    }

    const idKey = String(idVal);
    const cached = ctx.identityMap.getByPkValues(targetMeta, [idVal]);
    if (cached) {
      bucket.resolvedByKey.set(idKey, cached);
    } else if (!bucket.skipQuery && !bucket.missingSet.has(idKey)) {
      bucket.missingSet.add(idKey);
      bucket.missingIds.push(idVal);
    }

    entityBindings.push({ entity, bucket, idKey });
  }

  // Execute ONE batched `IN (...)` query per distinct concrete target type!
  const dialect = ctx.executor.dialect;
  for (const bucket of bucketsByMeta.values()) {
    if (bucket.skipQuery || bucket.missingIds.length === 0) continue;
    const { targetMeta, refColName, refPropName, missingIds } = bucket;
    const tableRef = formatTableRef(
      targetMeta.tableName,
      targetMeta.schema,
      dialect,
    );
    const refColQ = quoteIdentifier(refColName, dialect);
    const placeholders = missingIds
      .map((_, i) => formatPlaceholder(i + 1, dialect))
      .join(", ");

    let sql = `SELECT * FROM ${tableRef} WHERE ${refColQ} IN (${placeholders})`;
    if (!ctx.withDeleted && targetMeta.deleteDateColumn) {
      sql += ` AND ${quoteIdentifier(targetMeta.deleteDateColumn.columnName, dialect)} IS NULL`;
    }

    const res = await ctx.executor.query<Record<string, unknown>>(
      sql,
      missingIds,
    );
    for (const row of res.rows) {
      const hydrated = hydrateEntityRow<Record<string, unknown>>(
        targetMeta,
        row,
        {
          identityMap: ctx.identityMap,
          safeJsonSerialization: ctx.safeJsonSerialization,
          circularJsonStrategy: ctx.circularJsonStrategy,
        },
      );
      if (!ctx.loadedHooks.has(hydrated)) {
        ctx.loadedHooks.add(hydrated);
        await invokeLifecycleHooks(targetMeta, "after-load", hydrated);
      }
      const keyVal = hydrated[refPropName];
      if (keyVal !== undefined && keyVal !== null) {
        bucket.resolvedByKey.set(String(keyVal), hydrated);
      }
    }
  }

  // Hydrate resolved targets onto parent entities & group loaded targets by concrete targetMeta
  const loadedByMeta = new Map<CompiledEntityMetadata, object[]>();
  for (const binding of entityBindings) {
    if (!binding.bucket || binding.idKey === undefined) {
      continue;
    }
    const found = binding.bucket.resolvedByKey.get(binding.idKey) ?? null;
    (binding.entity as Record<string, unknown>)[rel.propertyName] = found;
    if (found) {
      let group = loadedByMeta.get(binding.bucket.targetMeta);
      if (!group) {
        group = [];
        loadedByMeta.set(binding.bucket.targetMeta, group);
      }
      group.push(found);
    }
  }

  return loadedByMeta;
}

/**
 * Cycle-safe batched `@MorphMany` loader:
 * Executes ONE batched `WHERE <typeCol> = $1 AND <idCol> IN ($2, ...)` query
 * across all parent entities (zero N+1 queries!).
 */
async function loadMorphMany(
  ownerMeta: CompiledEntityMetadata,
  entities: object[],
  rel: CompiledRelationMetadata,
  targetMeta: CompiledEntityMetadata,
  ctx: LoadRelationsContext,
): Promise<object[]> {
  const typeCol = rel.morphTypeColumnName;
  const idCol = rel.morphIdColumnName;
  const morphTypeVal = rel.morphTypeValue ?? ownerMeta.name;
  if (!typeCol || !idCol) return [];

  const ownerRefProp =
    rel.referencedPropertyName ?? ownerMeta.primaryColumn.propertyName;

  const ownerIds: unknown[] = [];
  const ownerIdSet = new Set<string>();
  for (const entity of entities) {
    const idVal = (entity as Record<string, unknown>)[ownerRefProp];
    if (idVal === undefined || idVal === null) continue;
    const key = String(idVal);
    if (!ownerIdSet.has(key)) {
      ownerIdSet.add(key);
      ownerIds.push(idVal);
    }
  }

  if (ownerIds.length === 0) {
    for (const entity of entities) {
      (entity as Record<string, unknown>)[rel.propertyName] = [];
    }
    return [];
  }

  const dialect = ctx.executor.dialect;
  const targetTableRef = formatTableRef(
    targetMeta.tableName,
    targetMeta.schema,
    dialect,
  );
  const typeColQ = quoteIdentifier(typeCol, dialect);
  const idColQ = quoteIdentifier(idCol, dialect);

  const typePh = formatPlaceholder(1, dialect);
  const idPlaceholders = ownerIds
    .map((_, i) => formatPlaceholder(i + 2, dialect))
    .join(", ");

  let sql = `SELECT * FROM ${targetTableRef} WHERE ${typeColQ} = ${typePh} AND ${idColQ} IN (${idPlaceholders})`;
  if (!ctx.withDeleted && targetMeta.deleteDateColumn) {
    sql += ` AND ${quoteIdentifier(targetMeta.deleteDateColumn.columnName, dialect)} IS NULL`;
  }

  const res = await ctx.executor.query<Record<string, unknown>>(sql, [
    morphTypeVal,
    ...ownerIds,
  ]);

  const grouped = new Map<string, object[]>();
  const allTargets: object[] = [];

  for (const row of res.rows) {
    const hydrated = hydrateEntityRow<Record<string, unknown>>(
      targetMeta,
      row,
      {
        identityMap: ctx.identityMap,
        safeJsonSerialization: ctx.safeJsonSerialization,
        circularJsonStrategy: ctx.circularJsonStrategy,
      },
    );
    if (!ctx.loadedHooks.has(hydrated)) {
      ctx.loadedHooks.add(hydrated);
      await invokeLifecycleHooks(targetMeta, "after-load", hydrated);
    }
    const rowType = row[typeCol];
    const rowId = row[idCol];
    if (rowType !== undefined) {
      setShadowFk(hydrated, typeCol, rowType);
    }
    if (rowId !== undefined && rowId !== null) {
      setShadowFk(hydrated, idCol, rowId);
      const key = String(rowId);
      let bucket = grouped.get(key);
      if (!bucket) {
        bucket = [];
        grouped.set(key, bucket);
      }
      bucket.push(hydrated);
    }
    allTargets.push(hydrated);
  }

  for (const entity of entities) {
    const idVal = (entity as Record<string, unknown>)[ownerRefProp];
    const children =
      idVal !== undefined && idVal !== null
        ? (grouped.get(String(idVal)) ?? [])
        : [];
    (entity as Record<string, unknown>)[rel.propertyName] = children;
  }

  return allTargets;
}
