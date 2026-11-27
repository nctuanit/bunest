import { getDialectProfile } from "./dialect/dialect-profile";
import { OptimisticLockError } from "./errors";
import {
  formatPlaceholder,
  formatTableRef,
  quoteIdentifier,
} from "./identifiers";
import {
  dehydrateEntity,
  fromDbValue,
  invokeLifecycleHooks,
  safeInstantiate,
  setShadowFk,
} from "./hydrator";
import type {
  CompiledEntityMetadata,
  CompiledMetadataGraph,
  CompiledRelationMetadata,
} from "./metadata-graph";
import { attachSafeToJson } from "./serializer";
import type {
  CircularJsonStrategy,
  OrmDriverLike,
  OrmQueryExecutor,
  RemoveOptions,
  SaveOptions,
} from "./types";

interface PersistNode {
  readonly id: number;
  readonly meta: CompiledEntityMetadata;
  readonly entity: Record<string, unknown>;
  /**
   * Owning FK dependencies pointing to OTHER nodes in this same persistence batch.
   */
  readonly fkDeps: Array<{
    readonly targetNode: PersistNode;
    readonly rel: CompiledRelationMetadata;
    readonly fkColumnName: string;
  }>;
  persisted: boolean;
}

interface DeferredFkPatch {
  readonly ownerNode: PersistNode;
  readonly targetNode: PersistNode;
  readonly rel: CompiledRelationMetadata;
  readonly fkColumnName: string;
}

interface ManyToManySyncTask {
  readonly ownerNode: PersistNode;
  readonly rel: CompiledRelationMetadata;
  readonly targets: Array<{
    readonly targetMeta: CompiledEntityMetadata;
    readonly targetEntity: Record<string, unknown>;
  }>;
}

export interface CascadeContext {
  readonly driver: OrmDriverLike;
  readonly graph: CompiledMetadataGraph;
  readonly safeJsonSerialization: boolean;
  readonly circularJsonStrategy: CircularJsonStrategy;
}

function ensureEntityInstance(
  meta: CompiledEntityMetadata,
  input: Record<string, unknown>,
  ctx: CascadeContext,
): Record<string, unknown> {
  if (input instanceof (meta.target as Function)) {
    attachSafeToJson(
      input,
      meta,
      ctx.safeJsonSerialization,
      ctx.circularJsonStrategy,
    );
    return input;
  }
  const instance = safeInstantiate(meta.target) as Record<string, unknown>;
  Object.assign(instance, input);
  attachSafeToJson(
    instance,
    meta,
    ctx.safeJsonSerialization,
    ctx.circularJsonStrategy,
  );
  return instance;
}

function hasPrimaryKey(
  meta: CompiledEntityMetadata,
  entity: Record<string, unknown>,
): boolean {
  return meta.primaryColumns.every(
    (pk) => entity[pk.propertyName] !== undefined && entity[pk.propertyName] !== null,
  );
}

/**
 * Graph-aware, 3-phase cycle-safe transactional cascade persistence engine!
 *
 * Handles ANY cyclic JS object graph cleanly without stack overflow or FK errors:
 * - Bidirectional `User` <-> `Post` (`user.posts = [post]; post.author = user;`)
 * - Mutual owning FKs `User` <-> `Profile` (`user.profile = profile; profile.user = user;`)
 * - N-way rings (`A -> B -> C -> A`)
 * - Self-referencing trees & self-loops (`cat.parent = cat`)
 * - Bidirectional `ManyToMany` (`student.courses = [c]; c.students = [student];`)
 */
export async function saveEntityGraph<T extends object>(
  rootMeta: CompiledEntityMetadata,
  rootEntities: T[],
  ctx: CascadeContext,
  options: SaveOptions = {},
): Promise<T[]> {
  if (rootEntities.length === 0) return [];

  const runWork = async (executor: OrmQueryExecutor): Promise<T[]> => {
    const nodeByObject = new Map<object, PersistNode>();
    const allNodes: PersistNode[] = [];
    const m2mTasks: ManyToManySyncTask[] = [];
    const seenM2mPairs = new Set<string>();
    let seq = 0;

    const getOrRegisterNode = (
      meta: CompiledEntityMetadata,
      obj: Record<string, unknown>,
    ): PersistNode => {
      const existing = nodeByObject.get(obj);
      if (existing) return existing;
      const node: PersistNode = {
        id: ++seq,
        meta,
        entity: obj,
        fkDeps: [],
        persisted: false,
      };
      nodeByObject.set(obj, node);
      allNodes.push(node);
      return node;
    };

    const addFkDep = (
      owner: PersistNode,
      target: PersistNode,
      rel: CompiledRelationMetadata,
    ) => {
      if (!rel.joinColumnName) return;
      const already = owner.fkDeps.some(
        (d) =>
          d.targetNode === target && d.fkColumnName === rel.joinColumnName,
      );
      if (!already) {
        owner.fkDeps.push({
          targetNode: target,
          rel,
          fkColumnName: rel.joinColumnName,
        });
      }
    };

    // Instantiate plain root objects cleanly while preserving original object identity
    // when users pass already-constructed entity instances (crucial for cyclic graphs!).
    const normalizedRoots: Record<string, unknown>[] = rootEntities.map((raw) =>
      ensureEntityInstance(rootMeta, raw as Record<string, unknown>, ctx),
    );

    const visitedForExpand = new Set<PersistNode>();
    const queue: PersistNode[] = [];

    for (const rootObj of normalizedRoots) {
      const node = getOrRegisterNode(rootMeta, rootObj);
      queue.push(node);
    }

    // Phase 0: BFS graph discovery with identity cycle guard
    while (queue.length > 0) {
      const node = queue.shift()!;
      if (visitedForExpand.has(node)) continue;
      visitedForExpand.add(node);

      for (const rel of node.meta.relations) {
        if (!rel.persistence) continue;
        const relVal = node.entity[rel.propertyName];
        if (relVal === undefined || relVal === null) continue;

        const targetMeta = ctx.graph.byTarget.get(rel.target);
        if (!targetMeta) continue;
        const canCascade = rel.cascadeInsert || rel.cascadeUpdate;

        // 1. Owning ManyToOne / OneToOne
        if (rel.isOwning && (rel.kind === "many-to-one" || rel.kind === "one-to-one")) {
          if (typeof relVal === "object") {
            const targetObj = relVal as Record<string, unknown>;
            const existingTargetNode = nodeByObject.get(targetObj);
            if (existingTargetNode) {
              addFkDep(node, existingTargetNode, rel);
            } else if (canCascade) {
              const targetInst = ensureEntityInstance(targetMeta, targetObj, ctx);
              node.entity[rel.propertyName] = targetInst;
              const targetNode = getOrRegisterNode(targetMeta, targetInst);
              addFkDep(node, targetNode, rel);
              queue.push(targetNode);
            }
          }
          continue;
        }

        // 2. Inverse OneToMany
        if (rel.kind === "one-to-many" && Array.isArray(relVal)) {
          if (!canCascade) continue;
          const inverseRel = rel.inversePropertyName
            ? targetMeta.relationsByProperty.get(rel.inversePropertyName)
            : targetMeta.relations.find(
                (r) => r.target === node.meta.target && r.isOwning,
              );

          for (let i = 0; i < relVal.length; i++) {
            const childRaw = relVal[i];
            if (!childRaw || typeof childRaw !== "object") continue;
            const childInst = ensureEntityInstance(
              targetMeta,
              childRaw as Record<string, unknown>,
              ctx,
            );
            relVal[i] = childInst;

            // Link back inverse owning property so FK is propagated seamlessly
            if (inverseRel && childInst[inverseRel.propertyName] === undefined) {
              childInst[inverseRel.propertyName] = node.entity;
            }

            const childNode = getOrRegisterNode(targetMeta, childInst);
            if (inverseRel) {
              addFkDep(childNode, node, inverseRel);
            }
            queue.push(childNode);
          }
          continue;
        }

        // 3. Inverse OneToOne
        if (rel.kind === "one-to-one" && !rel.isOwning && typeof relVal === "object") {
          if (!canCascade) continue;
          const inverseRel = rel.inversePropertyName
            ? targetMeta.relationsByProperty.get(rel.inversePropertyName)
            : targetMeta.relations.find(
                (r) => r.target === node.meta.target && r.isOwning,
              );
          const childInst = ensureEntityInstance(
            targetMeta,
            relVal as Record<string, unknown>,
            ctx,
          );
          node.entity[rel.propertyName] = childInst;
          if (inverseRel && childInst[inverseRel.propertyName] === undefined) {
            childInst[inverseRel.propertyName] = node.entity;
          }
          const childNode = getOrRegisterNode(targetMeta, childInst);
          if (inverseRel) {
            addFkDep(childNode, node, inverseRel);
          }
          queue.push(childNode);
          continue;
        }

        // 4. ManyToMany (owning OR inverse)
        if (rel.kind === "many-to-many" && Array.isArray(relVal) && rel.joinTable) {
          const taskKey = `${node.id}:${rel.joinTable.tableName}:${rel.propertyName}`;
          if (seenM2mPairs.has(taskKey)) continue;
          seenM2mPairs.add(taskKey);

          const targets: ManyToManySyncTask["targets"] = [];
          for (let i = 0; i < relVal.length; i++) {
            const itemRaw = relVal[i];
            if (!itemRaw || typeof itemRaw !== "object") continue;
            const itemObj = itemRaw as Record<string, unknown>;
            const existingTarget = nodeByObject.get(itemObj);
            if (existingTarget) {
              targets.push({ targetMeta, targetEntity: existingTarget.entity });
            } else if (canCascade) {
              const itemInst = ensureEntityInstance(targetMeta, itemObj, ctx);
              relVal[i] = itemInst;
              const targetNode = getOrRegisterNode(targetMeta, itemInst);
              queue.push(targetNode);
              targets.push({ targetMeta, targetEntity: itemInst });
            } else {
              targets.push({ targetMeta, targetEntity: itemObj });
            }
          }
          m2mTasks.push({ ownerNode: node, rel, targets });
          continue;
        }

        // 5. Inverse MorphMany (`post.comments = [comment1, comment2]`)
        if (rel.kind === "morph-many" && Array.isArray(relVal)) {
          if (!canCascade) continue;
          const childMorphRel = rel.morphName
            ? targetMeta.relationsByProperty.get(rel.morphName)
            : undefined;
          for (let i = 0; i < relVal.length; i++) {
            const childRaw = relVal[i];
            if (!childRaw || typeof childRaw !== "object") continue;
            const childInst = ensureEntityInstance(
              targetMeta,
              childRaw as Record<string, unknown>,
              ctx,
            );
            relVal[i] = childInst;
            if (childMorphRel && childInst[childMorphRel.propertyName] === undefined) {
              childInst[childMorphRel.propertyName] = node.entity;
            }
            const childNode = getOrRegisterNode(targetMeta, childInst);
            if (rel.morphIdColumnName) {
              const already = childNode.fkDeps.some(
                (d) =>
                  d.targetNode === node &&
                  d.fkColumnName === rel.morphIdColumnName,
              );
              if (!already) {
                childNode.fkDeps.push({
                  targetNode: node,
                  rel,
                  fkColumnName: rel.morphIdColumnName,
                });
              }
            }
            queue.push(childNode);
          }
        }
      }
    }

    // Also link any owning FK edges between nodes discovered AFTER the owner was expanded
    for (const node of allNodes) {
      for (const rel of node.meta.relations) {
        if (!rel.isOwning || !rel.joinColumnName || !rel.persistence) continue;
        const val = node.entity[rel.propertyName];
        if (val && typeof val === "object") {
          const targetNode = nodeByObject.get(val);
          if (targetNode) {
            addFkDep(node, targetNode, rel);
          }
        }
      }
    }

    // Phase 1 & 2: Topological persistence with automatic cycle breaking + deferred FK tracking!
    const deferredPatches: DeferredFkPatch[] = [];
    const remaining = new Set<PersistNode>(allNodes);

    while (remaining.size > 0) {
      // Find a node whose FK dependencies are all already persisted (excluding self-loops)
      let chosen: PersistNode | undefined;
      for (const candidate of remaining) {
        const hasUnpersistedDep = candidate.fkDeps.some(
          (d) => d.targetNode !== candidate && !d.targetNode.persisted,
        );
        if (!hasUnpersistedDep) {
          chosen = candidate;
          break;
        }
      }

      const deferredFkCols = new Set<string>();
      if (!chosen) {
        // Cycle detected (e.g. User <-> Profile or A -> B -> C -> A)!
        // Pick the first remaining node and defer its unresolved FK edges until Phase 3.
        chosen = remaining.values().next().value!;
      }

      for (const dep of chosen.fkDeps) {
        if (dep.targetNode === chosen || !dep.targetNode.persisted) {
          deferredFkCols.add(dep.fkColumnName);
          deferredPatches.push({
            ownerNode: chosen,
            targetNode: dep.targetNode,
            rel: dep.rel,
            fkColumnName: dep.fkColumnName,
          });
        }
      }

      await persistSingleNode(
        chosen,
        executor,
        deferredFkCols,
        options.listeners !== false,
      );
      chosen.persisted = true;
      remaining.delete(chosen);
    }

    // Phase 3a: Back-patch any deferred cyclic FKs now that every node has its generated PK!
    const dialect = executor.dialect;
    for (const patch of deferredPatches) {
      const refProp = patch.rel.referencedPropertyName ?? patch.targetNode.meta.primaryColumn.propertyName;
      const targetPkVal = patch.targetNode.entity[refProp];
      if (targetPkVal === undefined) continue;

      const ownerMeta = patch.ownerNode.meta;
      const tableRef = formatTableRef(ownerMeta.tableName, ownerMeta.schema, dialect);
      const fkColQ = quoteIdentifier(patch.fkColumnName, dialect);
      const params: unknown[] = [targetPkVal];
      const whereParts = ownerMeta.primaryColumns.map((pk) => {
        params.push(patch.ownerNode.entity[pk.propertyName]);
        return `${quoteIdentifier(pk.columnName, dialect)} = ${formatPlaceholder(params.length, dialect)}`;
      });

      const sql = `UPDATE ${tableRef} SET ${fkColQ} = ${formatPlaceholder(1, dialect)} WHERE ${whereParts.join(" AND ")}`;
      await executor.execute(sql, params);

      if (patch.rel.explicitFkPropertyName) {
        patch.ownerNode.entity[patch.rel.explicitFkPropertyName] = targetPkVal;
      }
      setShadowFk(patch.ownerNode.entity, patch.fkColumnName, targetPkVal);
    }

    // Phase 3b: Synchronize ManyToMany join tables cleanly (deduplicated!)
    for (const task of m2mTasks) {
      const jt = task.rel.joinTable;
      if (!jt) continue;
      const ownerPkCol =
        task.ownerNode.meta.columnsByColumnName.get(jt.joinReferencedColumnName) ??
        task.ownerNode.meta.primaryColumn;
      const ownerId = task.ownerNode.entity[ownerPkCol.propertyName];
      if (ownerId === undefined || ownerId === null) continue;

      const jtRef = formatTableRef(jt.tableName, task.ownerNode.meta.schema, dialect);
      const ownerColQ = quoteIdentifier(jt.joinColumnName, dialect);
      const targetColQ = quoteIdentifier(jt.inverseJoinColumnName, dialect);

      // Replace existing links for this owner in the join table
      await executor.execute(
        `DELETE FROM ${jtRef} WHERE ${ownerColQ} = ${formatPlaceholder(1, dialect)}`,
        [ownerId],
      );

      const insertedTargetKeys = new Set<string>();
      for (const t of task.targets) {
        const targetPkCol =
          t.targetMeta.columnsByColumnName.get(jt.inverseReferencedColumnName) ??
          t.targetMeta.primaryColumn;
        const targetId = t.targetEntity[targetPkCol.propertyName];
        if (targetId === undefined || targetId === null) continue;
        const pairKey = String(targetId);
        if (insertedTargetKeys.has(pairKey)) continue;
        insertedTargetKeys.add(pairKey);

        const p1 = formatPlaceholder(1, dialect);
        const p2 = formatPlaceholder(2, dialect);
        const insertSql = getDialectProfile(dialect).formatInsertIgnoreJoinRow(
          jtRef,
          ownerColQ,
          targetColQ,
          p1,
          p2,
        );
        await executor.execute(insertSql, [ownerId, targetId]);
      }
    }

    return normalizedRoots as unknown as T[];
  };

  if (options.transaction === false || ctx.driver.isInTransaction()) {
    return await runWork(ctx.driver);
  }
  return await ctx.driver.transaction(runWork);
}

async function persistSingleNode(
  node: PersistNode,
  executor: OrmQueryExecutor,
  deferredFkCols: ReadonlySet<string>,
  runListeners: boolean,
): Promise<void> {
  const { meta, entity } = node;
  const dialect = executor.dialect;
  const tableRef = formatTableRef(meta.tableName, meta.schema, dialect);

  // Check if entity already exists in DB when PK is provided
  let isUpdate = false;
  if (hasPrimaryKey(meta, entity)) {
    const pkParams: unknown[] = [];
    const pkConds = meta.primaryColumns.map((pk) => {
      pkParams.push(entity[pk.propertyName]);
      return `${quoteIdentifier(pk.columnName, dialect)} = ${formatPlaceholder(pkParams.length, dialect)}`;
    });
    const existsRes = await executor.query(
      `SELECT 1 AS __exists FROM ${tableRef} WHERE ${pkConds.join(" AND ")} LIMIT 1`,
      pkParams,
    );
    isUpdate = existsRes.rows.length > 0;
  }

  if (isUpdate) {
    if (runListeners) {
      await invokeLifecycleHooks(meta, "before-update", entity);
    }

    const expectedVersion = meta.versionColumn
      ? (entity[meta.versionColumn.propertyName] as number | undefined)
      : undefined;

    const { columnValues, generatedValues } = dehydrateEntity(
      meta,
      entity,
      dialect,
      "update",
      deferredFkCols,
    );

    const entries = Object.entries(columnValues);
    if (entries.length > 0) {
      const params: unknown[] = [];
      const setClauses = entries.map(([colName, val]) => {
        params.push(val);
        return `${quoteIdentifier(colName, dialect)} = ${formatPlaceholder(params.length, dialect)}`;
      });

      const whereClauses = meta.primaryColumns.map((pk) => {
        params.push(entity[pk.propertyName]);
        return `${quoteIdentifier(pk.columnName, dialect)} = ${formatPlaceholder(params.length, dialect)}`;
      });

      if (meta.versionColumn && typeof expectedVersion === "number") {
        params.push(expectedVersion);
        whereClauses.push(
          `${quoteIdentifier(meta.versionColumn.columnName, dialect)} = ${formatPlaceholder(params.length, dialect)}`,
        );
      }

      const sql = `UPDATE ${tableRef} SET ${setClauses.join(", ")} WHERE ${whereClauses.join(" AND ")}`;
      const res = await executor.execute(sql, params);

      if (
        meta.versionColumn &&
        typeof expectedVersion === "number" &&
        res.affectedRows === 0
      ) {
        throw new OptimisticLockError(meta.name, expectedVersion);
      }

      if (meta.versionColumn && generatedValues[meta.versionColumn.propertyName] !== undefined) {
        entity[meta.versionColumn.propertyName] =
          generatedValues[meta.versionColumn.propertyName];
      }
    }

    if (runListeners) {
      await invokeLifecycleHooks(meta, "after-update", entity);
    }
    return;
  }

  // INSERT path
  if (runListeners) {
    await invokeLifecycleHooks(meta, "before-insert", entity);
  }

  const { columnValues } = dehydrateEntity(
    meta,
    entity,
    dialect,
    "insert",
    deferredFkCols,
  );

  const colEntries = Object.entries(columnValues);
  const profile = getDialectProfile(dialect);

  let sql: string;
  const params: unknown[] = [];

  if (colEntries.length === 0) {
    sql = profile.formatEmptyInsert(tableRef);
  } else {
    const colNames = colEntries
      .map(([c]) => quoteIdentifier(c, dialect))
      .join(", ");
    const placeholders = colEntries
      .map(([, val]) => {
        params.push(val);
        return formatPlaceholder(params.length, dialect);
      })
      .join(", ");
    if (profile.returningStyle === "output") {
      sql = `INSERT INTO ${tableRef} (${colNames}) OUTPUT INSERTED.* VALUES (${placeholders})`;
    } else if (profile.returningStyle === "then-return") {
      sql = `INSERT INTO ${tableRef} (${colNames}) VALUES (${placeholders}) THEN RETURN *`;
    } else if (profile.returningStyle === "returning") {
      sql = `INSERT INTO ${tableRef} (${colNames}) VALUES (${placeholders}) RETURNING *`;
    } else {
      sql = `INSERT INTO ${tableRef} (${colNames}) VALUES (${placeholders})`;
    }
  }

  const res = await executor.query<Record<string, unknown>>(sql, params);

  if (res.rows.length > 0) {
    const returned = res.rows[0]!;
    for (const pk of meta.primaryColumns) {
      if (pk.columnName in returned) {
        entity[pk.propertyName] = fromDbValue(pk, returned[pk.columnName]);
      }
    }
    // Also sync default-populated DB columns back onto the entity
    for (const col of meta.columns) {
      if (
        !col.isVirtualJoinColumn &&
        !col.isEmbeddedFlat &&
        !col.isEmbeddedJson &&
        entity[col.propertyName] === undefined &&
        col.columnName in returned
      ) {
        entity[col.propertyName] = fromDbValue(col, returned[col.columnName]);
      }
    }
  } else if (
    meta.primaryColumn.generated &&
    meta.primaryColumn.generationStrategy === "increment" &&
    res.lastInsertRowid !== undefined &&
    res.lastInsertRowid !== null
  ) {
    entity[meta.primaryColumn.propertyName] = Number(res.lastInsertRowid);
  }

  if (runListeners) {
    await invokeLifecycleHooks(meta, "after-insert", entity);
  }
}

/**
 * Cycle-safe transactional cascade removal.
 */
export async function removeEntityGraph<T extends object>(
  rootMeta: CompiledEntityMetadata,
  rootEntities: T[],
  ctx: CascadeContext,
  options: RemoveOptions = {},
): Promise<T[]> {
  if (rootEntities.length === 0) return [];

  const runWork = async (executor: OrmQueryExecutor): Promise<T[]> => {
    const visited = new Set<object>();
    const dialect = executor.dialect;

    const removeOne = async (
      meta: CompiledEntityMetadata,
      entity: Record<string, unknown>,
    ): Promise<void> => {
      if (visited.has(entity)) return;
      visited.add(entity);

      if (options.listeners !== false) {
        await invokeLifecycleHooks(meta, "before-remove", entity);
      }

      // Cascade remove inverse children first (avoid FK violations)
      for (const rel of meta.relations) {
        if (!rel.cascadeRemove) continue;
        const targetMeta = ctx.graph.byTarget.get(rel.target);
        if (!targetMeta) continue;
        const val = entity[rel.propertyName];
        if (!val) continue;
        if (Array.isArray(val)) {
          for (const child of val) {
            if (child && typeof child === "object") {
              await removeOne(targetMeta, child as Record<string, unknown>);
            }
          }
        } else if (typeof val === "object") {
          await removeOne(targetMeta, val as Record<string, unknown>);
        }
      }

      if (!hasPrimaryKey(meta, entity)) return;

      // Clean ManyToMany join table rows
      for (const rel of meta.relations) {
        if (rel.kind !== "many-to-many" || !rel.joinTable) continue;
        const jt = rel.joinTable;
        const ownerPkCol =
          meta.columnsByColumnName.get(jt.joinReferencedColumnName) ??
          meta.primaryColumn;
        const ownerId = entity[ownerPkCol.propertyName];
        if (ownerId === undefined || ownerId === null) continue;
        const jtRef = formatTableRef(jt.tableName, meta.schema, dialect);
        await executor.execute(
          `DELETE FROM ${jtRef} WHERE ${quoteIdentifier(jt.joinColumnName, dialect)} = ${formatPlaceholder(1, dialect)}`,
          [ownerId],
        );
      }

      const tableRef = formatTableRef(meta.tableName, meta.schema, dialect);
      const params: unknown[] = [];
      const whereParts = meta.primaryColumns.map((pk) => {
        params.push(entity[pk.propertyName]);
        return `${quoteIdentifier(pk.columnName, dialect)} = ${formatPlaceholder(params.length, dialect)}`;
      });

      await executor.execute(
        `DELETE FROM ${tableRef} WHERE ${whereParts.join(" AND ")}`,
        params,
      );

      if (options.listeners !== false) {
        await invokeLifecycleHooks(meta, "after-remove", entity);
      }
    };

    for (const item of rootEntities) {
      await removeOne(rootMeta, item as Record<string, unknown>);
    }

    return rootEntities;
  };

  if (options.transaction === false || ctx.driver.isInTransaction()) {
    return await runWork(ctx.driver);
  }
  return await ctx.driver.transaction(runWork);
}
