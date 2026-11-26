import { removeEntityGraph, saveEntityGraph } from "./cascade-engine";
import { getDialectProfile } from "./dialect/dialect-profile";
import { generateObjectId } from "./driver/bson";
import { isDocumentDriver } from "./driver/driver.interface";
import { EntityNotFoundError } from "./errors";
import {
  IdentityMap,
  fromDbValue,
  hydrateEntityRow,
  invokeLifecycleHooks,
  safeInstantiate,
  toDbValue,
} from "./hydrator";
import {
  assertSafeSqlIdentifier,
  formatPlaceholder,
  formatTableRef,
  quoteIdentifier,
} from "./identifiers";
import { isFindOperator } from "./operators";
import type {
  CompiledEmbeddedMetadata,
  CompiledEntityMetadata,
  CompiledMetadataGraph,
} from "./metadata-graph";
import {
  DeleteQueryBuilder,
  InsertQueryBuilder,
  SelectQueryBuilder,
  UpdateQueryBuilder,
} from "./query-builder";
import {
  loadRelationsForEntities,
  normalizeRelationsOption,
} from "./relation-loader";
import { attachSafeToJson, serializeEntity } from "./serializer";
import {
  ParameterCollector,
  compileOrderByClause,
  compileWhereClause,
} from "./where-builder";
import type {
  CircularJsonStrategy,
  DeepPartial,
  DeleteResult,
  FindManyOptions,
  FindOneOptions,
  FindOperatorLike,
  FindOptionsOrder,
  FindOptionsWhere,
  InsertResult,
  OrmDocumentDriverLike,
  OrmDriverLike,
  RemoveOptions,
  SaveOptions,
  UpdateResult,
} from "./types";

export interface OrmRepositoryRuntime {
  readonly driver: OrmDriverLike;
  readonly graph: CompiledMetadataGraph;
  readonly maxEagerDepth: number;
  readonly safeJsonSerialization: boolean;
  readonly circularJsonStrategy: CircularJsonStrategy;
}

function instantiateEmbeddedInput(
  emb: CompiledEmbeddedMetadata,
  value: unknown,
  depth = 0,
): unknown {
  if (value === null || value === undefined || typeof value !== "object") {
    return value;
  }
  if (depth > emb.maxDepth) return value;
  if (Array.isArray(value)) {
    return value.map((item) => instantiateEmbeddedInput(emb, item, depth + 1));
  }
  const inst =
    value instanceof (emb.target as Function)
      ? value
      : Object.assign(safeInstantiate(emb.target) as object, value);
  const rec = inst as Record<string, unknown>;
  for (const child of emb.nestedEmbeddeds) {
    if (rec[child.propertyName] !== undefined) {
      rec[child.propertyName] = instantiateEmbeddedInput(
        child,
        rec[child.propertyName],
        depth + 1,
      );
    }
  }
  return inst;
}

/**
 * TypeORM-compatible `Repository<Entity>` backed by real SQL tables, multi-level
 * nested/embedded classes, cycle-safe cascade persistence, and batched `IdentityMap`
 * relation loading.
 */
export class OrmRepository<Entity extends object = Record<string, unknown>> {
  readonly metadata: CompiledEntityMetadata;

  constructor(
    metadata: CompiledEntityMetadata,
    protected readonly runtime: OrmRepositoryRuntime,
  ) {
    this.metadata = metadata;
  }

  protected get documentDriver(): OrmDocumentDriverLike | undefined {
    return isDocumentDriver(this.runtime.driver)
      ? this.runtime.driver
      : undefined;
  }

  protected hydrateDocument(doc: Record<string, unknown>): Entity {
    const inst = safeInstantiate(this.metadata.target) as Record<string, unknown>;
    const pkProp = this.metadata.primaryColumn.propertyName;
    for (const [k, v] of Object.entries(doc)) {
      if (k === "_id" && pkProp !== "_id") {
        inst[pkProp] = v;
        continue;
      }
      const col = this.metadata.columnsByProperty.get(k);
      if (col) {
        inst[k] = fromDbValue(col, v);
      } else {
        inst[k] = v;
      }
    }
    for (const emb of this.metadata.embeddeds) {
      if (inst[emb.propertyName] !== undefined) {
        inst[emb.propertyName] = instantiateEmbeddedInput(
          emb,
          inst[emb.propertyName],
        );
      }
    }
    attachSafeToJson(
      inst,
      this.metadata,
      this.runtime.safeJsonSerialization,
      this.runtime.circularJsonStrategy,
    );
    return inst as Entity;
  }

  protected dehydrateDocument(entity: Record<string, unknown>): Record<string, unknown> {
    const plain = serializeEntity<Record<string, unknown>>(entity, {
      circularStrategy: "omit",
    });
    const pkProp = this.metadata.primaryColumn.propertyName;
    if (plain[pkProp] === undefined || plain[pkProp] === null) {
      const id = generateObjectId();
      entity[pkProp] = id;
      plain[pkProp] = id;
    }
    if (pkProp !== "_id") {
      plain._id = plain[pkProp];
    }
    return plain;
  }

  protected whereToMongoFilter(
    where?: FindOptionsWhere<Entity> | ReadonlyArray<FindOptionsWhere<Entity>>,
    withDeleted = false,
  ): Record<string, unknown> {
    const pkProp = this.metadata.primaryColumn.propertyName;
    const convertValue = (val: unknown): unknown => {
      if (!isFindOperator(val)) return val;
      const op = val as FindOperatorLike;
      switch (op.type) {
        case "equal":
          return { $eq: op.value };
        case "not":
          return isFindOperator(op.value)
            ? { $not: convertValue(op.value) }
            : { $ne: op.value };
        case "lessThan":
          return { $lt: op.value };
        case "lessThanOrEqual":
          return { $lte: op.value };
        case "moreThan":
          return { $gt: op.value };
        case "moreThanOrEqual":
          return { $gte: op.value };
        case "in":
          return { $in: Array.isArray(op.value) ? op.value : [] };
        case "isNull":
          return null;
        case "between": {
          const pair = op.value as readonly [unknown, unknown];
          return { $gte: pair[0], $lte: pair[1] };
        }
        case "like":
          return {
            $regex: `^${String(op.value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".")}$`,
          };
        case "ilike":
          return {
            $regex: `^${String(op.value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".")}$`,
            $options: "i",
          };
        default:
          return op.value;
      }
    };

    const convertGroup = (obj: Record<string, unknown>): Record<string, unknown> => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) {
        if (v === undefined) continue;
        const key = k === pkProp && pkProp !== "_id" ? "_id" : k;
        out[key] = convertValue(v);
      }
      if (!withDeleted && this.metadata.deleteDateColumn) {
        out[this.metadata.deleteDateColumn.propertyName] = null;
      }
      return out;
    };

    if (!where) {
      return !withDeleted && this.metadata.deleteDateColumn
        ? { [this.metadata.deleteDateColumn.propertyName]: null }
        : {};
    }
    if (Array.isArray(where)) {
      if (where.length === 0) return {};
      return {
        $or: where.map((w) => convertGroup(w as Record<string, unknown>)),
      };
    }
    return convertGroup(where as Record<string, unknown>);
  }

  protected orderToMongoSort(
    order?: FindOptionsOrder<Entity>,
  ): Record<string, 1 | -1> | undefined {
    if (!order) return undefined;
    const out: Record<string, 1 | -1> = {};
    const visit = (obj: Record<string, unknown>, prefix: string[]) => {
      for (const [k, v] of Object.entries(obj)) {
        if (v === undefined) continue;
        if (v === "ASC" || v === "asc" || v === 1) {
          out[[...prefix, k].join(".")] = 1;
        } else if (v === "DESC" || v === "desc" || v === -1) {
          out[[...prefix, k].join(".")] = -1;
        } else if (typeof v === "object" && v !== null) {
          visit(v as Record<string, unknown>, [...prefix, k]);
        }
      }
    };
    visit(order as Record<string, unknown>, []);
    return Object.keys(out).length > 0 ? out : undefined;
  }

  get target(): CompiledEntityMetadata["target"] {
    return this.metadata.target;
  }

  /**
   * Creates a new entity instance (recursively instantiating nested `@Embedded` classes)
   * without persisting it to the database.
   */
  create(): Entity;
  create(entityLike: DeepPartial<Entity>): Entity;
  create(entityLikes: ReadonlyArray<DeepPartial<Entity>>): Entity[];
  create(
    entityLikeOrArray?: DeepPartial<Entity> | ReadonlyArray<DeepPartial<Entity>>,
  ): Entity | Entity[] {
    if (Array.isArray(entityLikeOrArray)) {
      return entityLikeOrArray.map((item) => this.create(item));
    }
    const inst = safeInstantiate(this.metadata.target) as Record<string, unknown>;
    if (entityLikeOrArray && typeof entityLikeOrArray === "object") {
      Object.assign(inst, entityLikeOrArray);
      for (const emb of this.metadata.embeddeds) {
        if (inst[emb.propertyName] !== undefined) {
          inst[emb.propertyName] = instantiateEmbeddedInput(
            emb,
            inst[emb.propertyName],
          );
        }
      }
    }
    attachSafeToJson(
      inst,
      this.metadata,
      this.runtime.safeJsonSerialization,
      this.runtime.circularJsonStrategy,
    );
    return inst as Entity;
  }

  /**
   * Merges one or more partial objects into an existing entity instance.
   */
  merge(
    mergeIntoEntity: Entity,
    ...entityLikes: Array<DeepPartial<Entity>>
  ): Entity {
    const target = mergeIntoEntity as Record<string, unknown>;
    for (const like of entityLikes) {
      if (!like || typeof like !== "object") continue;
      for (const [k, v] of Object.entries(like)) {
        if (v === undefined) continue;
        const emb = this.metadata.embeddedsByProperty.get(k);
        if (emb) {
          target[k] = instantiateEmbeddedInput(emb, v);
        } else {
          target[k] = v;
        }
      }
    }
    return mergeIntoEntity;
  }

  /**
   * Loads an existing entity by primary key and merges `entityLike` fields into it,
   * returning `undefined` if no matching row exists.
   */
  async preload(entityLike: DeepPartial<Entity>): Promise<Entity | undefined> {
    const rec = entityLike as Record<string, unknown>;
    const where: Record<string, unknown> = {};
    for (const pk of this.metadata.primaryColumns) {
      if (rec[pk.propertyName] === undefined || rec[pk.propertyName] === null) {
        return undefined;
      }
      where[pk.propertyName] = rec[pk.propertyName];
    }
    const existing = await this.findOneBy(where as FindOptionsWhere<Entity>);
    if (!existing) return undefined;
    return this.merge(existing, entityLike);
  }

  /**
   * Persists a single entity or array of entities (including arbitrarily cyclic
   * cascade object graphs) inside an atomic transaction.
   */
  async save(entity: DeepPartial<Entity>, options?: SaveOptions): Promise<Entity>;
  async save(
    entities: ReadonlyArray<DeepPartial<Entity>>,
    options?: SaveOptions,
  ): Promise<Entity[]>;
  async save(
    entityOrEntities: DeepPartial<Entity> | ReadonlyArray<DeepPartial<Entity>>,
    options: SaveOptions = {},
  ): Promise<Entity | Entity[]> {
    const isArray = Array.isArray(entityOrEntities);
    const list = isArray
      ? ([...entityOrEntities] as object[])
      : [entityOrEntities as object];

    const docDriver = this.documentDriver;
    if (docDriver) {
      const results: Entity[] = [];
      for (const raw of list) {
        const inst = this.create(raw as DeepPartial<Entity>);
        if (options.listeners !== false) {
          await invokeLifecycleHooks(this.metadata, "before-insert", inst);
        }
        const doc = this.dehydrateDocument(inst as Record<string, unknown>);
        await docDriver.docInsertMany(this.metadata.tableName, [doc]);
        if (options.listeners !== false) {
          await invokeLifecycleHooks(this.metadata, "after-insert", inst);
        }
        results.push(inst);
      }
      return (isArray ? results : results[0]!) as Entity | Entity[];
    }

    const saved = await saveEntityGraph(
      this.metadata,
      list,
      {
        driver: this.runtime.driver,
        graph: this.runtime.graph,
        safeJsonSerialization: this.runtime.safeJsonSerialization,
        circularJsonStrategy: this.runtime.circularJsonStrategy,
      },
      options,
    );

    return (isArray ? saved : saved[0]!) as Entity | Entity[];
  }

  /**
   * Inserts one or more entities and returns `InsertResult`.
   */
  async insert(
    entity: DeepPartial<Entity> | ReadonlyArray<DeepPartial<Entity>>,
  ): Promise<InsertResult> {
    const items = Array.isArray(entity) ? [...entity] : [entity];
    const saved = await this.save(items);
    const pkProp = this.metadata.primaryColumn.propertyName;
    const identifiers = saved.map((s) => ({
      [pkProp]: (s as Record<string, unknown>)[pkProp],
    }));
    return {
      identifiers,
      generatedMaps: identifiers,
      raw: saved,
    };
  }

  /**
   * Inserts or updates entities on conflict of `conflictPaths` (e.g. `["email"]`).
   */
  async upsert(
    entityOrEntities: DeepPartial<Entity> | ReadonlyArray<DeepPartial<Entity>>,
    conflictPaths: readonly string[],
  ): Promise<InsertResult> {
    const items = Array.isArray(entityOrEntities)
      ? [...entityOrEntities]
      : [entityOrEntities];
    const identifiers: Array<Record<string, unknown>> = [];
    const pkProp = this.metadata.primaryColumn.propertyName;

    await this.runtime.driver.transaction(async () => {
      for (const rawItem of items) {
        const item = rawItem as Record<string, unknown>;
        const where: Record<string, unknown> = {};
        let hasAllConflictKeys = conflictPaths.length > 0;
        for (const p of conflictPaths) {
          if (item[p] === undefined) {
            hasAllConflictKeys = false;
            break;
          }
          where[p] = item[p];
        }
        let saved: Entity;
        if (hasAllConflictKeys) {
          const existing = await this.findOneBy(where as FindOptionsWhere<Entity>);
          if (existing) {
            this.merge(existing, rawItem);
            saved = await this.save(existing as DeepPartial<Entity>, {
              transaction: false,
            });
          } else {
            saved = await this.save(rawItem, { transaction: false });
          }
        } else {
          saved = await this.save(rawItem, { transaction: false });
        }
        identifiers.push({ [pkProp]: (saved as Record<string, unknown>)[pkProp] });
      }
    });

    return { identifiers, generatedMaps: identifiers, raw: identifiers };
  }

  /**
   * Executes a targeted SQL UPDATE matching primary key or `FindOptionsWhere` criteria.
   */
  async update(
    criteria: string | number | readonly (string | number)[] | FindOptionsWhere<Entity>,
    partialEntity: DeepPartial<Entity>,
  ): Promise<UpdateResult> {
    const docDriver = this.documentDriver;
    if (docDriver) {
      const filter = this.whereToMongoFilter(this.normalizeCriteria(criteria), true);
      const res = await docDriver.docUpdate(
        this.metadata.tableName,
        filter,
        { $set: partialEntity as Record<string, unknown> },
        { multi: true },
      );
      return { affected: res.modifiedCount, generatedMaps: [], raw: res };
    }

    const dialect = this.runtime.driver.dialect;
    const alias = "e";
    const tableRef = formatTableRef(
      this.metadata.tableName,
      this.metadata.schema,
      dialect,
    );
    const collector = new ParameterCollector(dialect);
    const setParts: string[] = [];

    const flattenPartial = (
      obj: Record<string, unknown>,
      prefix: string[],
    ): void => {
      for (const [key, val] of Object.entries(obj)) {
        if (val === undefined) continue;
        const fullPath = [...prefix, key].join(".");
        const col =
          this.metadata.columnsByProperty.get(fullPath) ??
          this.metadata.columnsByColumnName.get(key);
        if (col && !col.isEmbeddedJson) {
          setParts.push(
            `${quoteIdentifier(col.columnName, dialect)} = ${collector.add(toDbValue(col, val, dialect))}`,
          );
          continue;
        }
        const emb =
          prefix.length === 0 ? this.metadata.embeddedsByProperty.get(key) : undefined;
        if (emb) {
          if (emb.resolvedMode === "json" && emb.jsonColumnName) {
            setParts.push(
              `${quoteIdentifier(emb.jsonColumnName, dialect)} = ${collector.add(val === null ? null : JSON.stringify(val))}`,
            );
          } else if (val && typeof val === "object") {
            flattenPartial(val as Record<string, unknown>, [...prefix, key]);
          }
          continue;
        }
        const rel =
          prefix.length === 0 ? this.metadata.relationsByProperty.get(key) : undefined;
        if (rel?.isOwning && rel.joinColumnName) {
          const refProp = rel.referencedPropertyName ?? "id";
          const fkVal =
            val && typeof val === "object"
              ? (val as Record<string, unknown>)[refProp]
              : val;
          setParts.push(
            `${quoteIdentifier(rel.joinColumnName, dialect)} = ${collector.add(fkVal ?? null)}`,
          );
        }
      }
    };

    flattenPartial(partialEntity as Record<string, unknown>, []);

    for (const updCol of this.metadata.updateDateColumns) {
      const quoted = quoteIdentifier(updCol.columnName, dialect);
      if (!setParts.some((s) => s.startsWith(`${quoted} =`))) {
        setParts.push(
          `${quoted} = ${collector.add(toDbValue(updCol, new Date(), dialect))}`,
        );
      }
    }

    if (setParts.length === 0) {
      return { affected: 0, generatedMaps: [], raw: null };
    }

    const whereObj = this.normalizeCriteria(criteria);
    const whereCompiled = compileWhereClause(
      this.metadata,
      whereObj,
      alias,
      this.runtime.graph,
      dialect,
      true,
      collector,
    );

    // Strip table alias prefix for plain UPDATE table SET ... WHERE ... compatibility on SQLite
    const aliasPrefix = `${quoteIdentifier(alias, dialect)}.`;
    const cleanWhere = whereCompiled.sql.replaceAll(aliasPrefix, "");
    const sql = `UPDATE ${tableRef} SET ${setParts.join(", ")}${cleanWhere ? ` WHERE ${cleanWhere}` : ""}`;

    const res = await this.runtime.driver.execute(sql, collector.values);
    return { affected: res.affectedRows, generatedMaps: [], raw: res };
  }

  /**
   * Executes a targeted SQL DELETE matching primary key or `FindOptionsWhere` criteria.
   */
  async delete(
    criteria: string | number | readonly (string | number)[] | FindOptionsWhere<Entity>,
  ): Promise<DeleteResult> {
    const docDriver = this.documentDriver;
    if (docDriver) {
      const filter = this.whereToMongoFilter(this.normalizeCriteria(criteria), true);
      const res = await docDriver.docDelete(this.metadata.tableName, filter, {
        multi: true,
      });
      return { affected: res.deletedCount, raw: res };
    }

    const dialect = this.runtime.driver.dialect;
    const alias = "e";
    const tableRef = formatTableRef(
      this.metadata.tableName,
      this.metadata.schema,
      dialect,
    );
    const whereObj = this.normalizeCriteria(criteria);
    const compiled = compileWhereClause(
      this.metadata,
      whereObj,
      alias,
      this.runtime.graph,
      dialect,
      true,
    );
    const aliasPrefix = `${quoteIdentifier(alias, dialect)}.`;
    const cleanWhere = compiled.sql.replaceAll(aliasPrefix, "");
    const sql = `DELETE FROM ${tableRef}${cleanWhere ? ` WHERE ${cleanWhere}` : ""}`;
    const res = await this.runtime.driver.execute(sql, compiled.params);
    return { affected: res.affectedRows, raw: res };
  }

  /**
   * Removes an entity or array of entities (with cycle-safe cascade removal & hooks).
   */
  async remove(entity: Entity, options?: RemoveOptions): Promise<Entity>;
  async remove(entities: Entity[], options?: RemoveOptions): Promise<Entity[]>;
  async remove(
    entityOrEntities: Entity | Entity[],
    options: RemoveOptions = {},
  ): Promise<Entity | Entity[]> {
    const isArray = Array.isArray(entityOrEntities);
    const list = isArray ? [...entityOrEntities] : [entityOrEntities];
    const docDriver = this.documentDriver;
    if (docDriver) {
      const pkProp = this.metadata.primaryColumn.propertyName;
      for (const item of list) {
        if (options.listeners !== false) {
          await invokeLifecycleHooks(this.metadata, "before-remove", item);
        }
        const pkVal = (item as Record<string, unknown>)[pkProp];
        if (pkVal !== undefined && pkVal !== null) {
          await docDriver.docDelete(this.metadata.tableName, { _id: pkVal });
        }
        if (options.listeners !== false) {
          await invokeLifecycleHooks(this.metadata, "after-remove", item);
        }
      }
      return entityOrEntities;
    }

    await removeEntityGraph(
      this.metadata,
      list,
      {
        driver: this.runtime.driver,
        graph: this.runtime.graph,
        safeJsonSerialization: this.runtime.safeJsonSerialization,
        circularJsonStrategy: this.runtime.circularJsonStrategy,
      },
      options,
    );
    return entityOrEntities;
  }

  /**
   * Soft-deletes matching rows by setting the `@DeleteDateColumn` timestamp.
   */
  async softDelete(
    criteria: string | number | readonly (string | number)[] | FindOptionsWhere<Entity>,
  ): Promise<UpdateResult> {
    const delCol = this.metadata.deleteDateColumn;
    if (!delCol) {
      throw new Error(
        `Entity "${this.metadata.name}" does not have a @DeleteDateColumn() defined.`,
      );
    }
    return this.update(criteria, {
      [delCol.propertyName]: new Date(),
    } as DeepPartial<Entity>);
  }

  /**
   * Soft-removes an entity instance (sets `@DeleteDateColumn` and saves).
   */
  async softRemove(entity: Entity): Promise<Entity>;
  async softRemove(entities: Entity[]): Promise<Entity[]>;
  async softRemove(entityOrEntities: Entity | Entity[]): Promise<Entity | Entity[]> {
    const delCol = this.metadata.deleteDateColumn;
    if (!delCol) {
      throw new Error(
        `Entity "${this.metadata.name}" does not have a @DeleteDateColumn() defined.`,
      );
    }
    const now = new Date();
    if (Array.isArray(entityOrEntities)) {
      for (const e of entityOrEntities) {
        (e as Record<string, unknown>)[delCol.propertyName] = now;
      }
      return this.save(entityOrEntities as DeepPartial<Entity>[]);
    }
    (entityOrEntities as Record<string, unknown>)[delCol.propertyName] = now;
    return this.save(entityOrEntities as DeepPartial<Entity>);
  }

  /**
   * Restores soft-deleted rows by setting the `@DeleteDateColumn` back to `NULL`.
   */
  async restore(
    criteria: string | number | readonly (string | number)[] | FindOptionsWhere<Entity>,
  ): Promise<UpdateResult> {
    const delCol = this.metadata.deleteDateColumn;
    if (!delCol) {
      throw new Error(
        `Entity "${this.metadata.name}" does not have a @DeleteDateColumn() defined.`,
      );
    }
    return this.update(criteria, {
      [delCol.propertyName]: null,
    } as DeepPartial<Entity>);
  }

  /**
   * Finds entities matching `FindManyOptions` (including nested embedded filters,
   * relation filters, batched cycle-safe relation loading, sorting, pagination, and soft-delete filtering).
   */
  async find(options: FindManyOptions<Entity> = {}): Promise<Entity[]> {
    const docDriver = this.documentDriver;
    if (docDriver) {
      const filter = this.whereToMongoFilter(
        options.where,
        options.withDeleted === true,
      );
      const sort = this.orderToMongoSort(options.order);
      const docs = await docDriver.docFind(this.metadata.tableName, filter, {
        ...(sort ? { sort } : {}),
        ...(options.skip !== undefined ? { skip: options.skip } : {}),
        ...(options.take !== undefined ? { limit: options.take } : {}),
      });
      const hydrated: Entity[] = [];
      for (const d of docs) {
        const inst = this.hydrateDocument(d);
        await invokeLifecycleHooks(this.metadata, "after-load", inst);
        hydrated.push(inst);
      }
      return hydrated;
    }

    const dialect = this.runtime.driver.dialect;
    const alias = "e";
    const aliasQ = quoteIdentifier(alias, dialect);
    const tableRef = formatTableRef(
      this.metadata.tableName,
      this.metadata.schema,
      dialect,
    );

    const selectCols = this.buildSelectColumns(options.select, alias, dialect);
    const whereCompiled = compileWhereClause(
      this.metadata,
      options.where,
      alias,
      this.runtime.graph,
      dialect,
      options.withDeleted === true,
    );
    const orderSql = compileOrderByClause(
      this.metadata,
      options.order,
      alias,
      dialect,
    );

    let sql = `SELECT ${selectCols} FROM ${tableRef} ${aliasQ}`;
    if (whereCompiled.sql) {
      sql += ` WHERE ${whereCompiled.sql}`;
    }
    if (orderSql) {
      sql += ` ORDER BY ${orderSql}`;
    }
    sql += getDialectProfile(dialect).formatLimitOffset(
      options.take,
      options.skip,
      orderSql.length > 0,
    );

    const res = await this.runtime.driver.query<Record<string, unknown>>(
      sql,
      whereCompiled.params,
    );
    if (res.rows.length === 0) return [];

    const identityMap = new IdentityMap();
    const loadedHooks = new WeakSet<object>();

    const entities: Entity[] = [];
    for (const row of res.rows) {
      const entity = hydrateEntityRow<Entity>(this.metadata, row, {
        identityMap,
        safeJsonSerialization: this.runtime.safeJsonSerialization,
        circularJsonStrategy: this.runtime.circularJsonStrategy,
      });
      if (!loadedHooks.has(entity)) {
        loadedHooks.add(entity);
        await invokeLifecycleHooks(this.metadata, "after-load", entity);
      }
      entities.push(entity);
    }

    const requestedTree = normalizeRelationsOption(options.relations);
    const shouldLoadRelations =
      requestedTree.size > 0 ||
      (options.loadEagerRelations !== false &&
        this.metadata.relations.some((r) => r.eager));

    if (shouldLoadRelations) {
      await loadRelationsForEntities(this.metadata, entities, requestedTree, {
        executor: this.runtime.driver,
        graph: this.runtime.graph,
        identityMap,
        withDeleted: options.withDeleted === true,
        loadEagerRelations: options.loadEagerRelations !== false,
        maxEagerDepth: options.maxEagerDepth ?? this.runtime.maxEagerDepth,
        safeJsonSerialization: this.runtime.safeJsonSerialization,
        circularJsonStrategy: this.runtime.circularJsonStrategy,
        loadedHooks,
      });
    }

    return entities;
  }

  async findBy(
    where: FindOptionsWhere<Entity> | ReadonlyArray<FindOptionsWhere<Entity>>,
  ): Promise<Entity[]> {
    return this.find({ where });
  }

  async findOne(options: FindOneOptions<Entity>): Promise<Entity | null> {
    const items = await this.find({ ...options, take: 1 });
    return items[0] ?? null;
  }

  async findOneBy(
    where: FindOptionsWhere<Entity> | ReadonlyArray<FindOptionsWhere<Entity>>,
  ): Promise<Entity | null> {
    return this.findOne({ where });
  }

  async findOneOrFail(options: FindOneOptions<Entity>): Promise<Entity> {
    const found = await this.findOne(options);
    if (!found) {
      throw new EntityNotFoundError(this.metadata.name, options.where);
    }
    return found;
  }

  async findOneByOrFail(
    where: FindOptionsWhere<Entity> | ReadonlyArray<FindOptionsWhere<Entity>>,
  ): Promise<Entity> {
    const found = await this.findOneBy(where);
    if (!found) {
      throw new EntityNotFoundError(this.metadata.name, where);
    }
    return found;
  }

  async findAndCount(
    options: FindManyOptions<Entity> = {},
  ): Promise<[Entity[], number]> {
    const [items, total] = await Promise.all([
      this.find(options),
      this.count(options),
    ]);
    return [items, total];
  }

  async findAndCountBy(
    where: FindOptionsWhere<Entity> | ReadonlyArray<FindOptionsWhere<Entity>>,
  ): Promise<[Entity[], number]> {
    return this.findAndCount({ where });
  }

  async count(options: FindManyOptions<Entity> = {}): Promise<number> {
    const docDriver = this.documentDriver;
    if (docDriver) {
      return await docDriver.docCount(
        this.metadata.tableName,
        this.whereToMongoFilter(options.where, options.withDeleted === true),
      );
    }

    const dialect = this.runtime.driver.dialect;
    const alias = "e";
    const aliasQ = quoteIdentifier(alias, dialect);
    const tableRef = formatTableRef(
      this.metadata.tableName,
      this.metadata.schema,
      dialect,
    );
    const whereCompiled = compileWhereClause(
      this.metadata,
      options.where,
      alias,
      this.runtime.graph,
      dialect,
      options.withDeleted === true,
    );
    const sql = `SELECT COUNT(*) AS __cnt FROM ${tableRef} ${aliasQ}${whereCompiled.sql ? ` WHERE ${whereCompiled.sql}` : ""}`;
    const res = await this.runtime.driver.query<{ __cnt: number | string }>(
      sql,
      whereCompiled.params,
    );
    return Number(res.rows[0]?.__cnt ?? 0);
  }

  async countBy(
    where: FindOptionsWhere<Entity> | ReadonlyArray<FindOptionsWhere<Entity>>,
  ): Promise<number> {
    return this.count({ where });
  }

  async exists(options: FindManyOptions<Entity> = {}): Promise<boolean> {
    return (await this.count(options)) > 0;
  }

  async existsBy(
    where: FindOptionsWhere<Entity> | ReadonlyArray<FindOptionsWhere<Entity>>,
  ): Promise<boolean> {
    return this.exists({ where });
  }

  async increment(
    where: FindOptionsWhere<Entity>,
    propertyPath: string,
    value: number,
  ): Promise<UpdateResult> {
    return this.adjustNumericColumn(where, propertyPath, value);
  }

  async decrement(
    where: FindOptionsWhere<Entity>,
    propertyPath: string,
    value: number,
  ): Promise<UpdateResult> {
    return this.adjustNumericColumn(where, propertyPath, -value);
  }

  private async adjustNumericColumn(
    where: FindOptionsWhere<Entity>,
    propertyPath: string,
    delta: number,
  ): Promise<UpdateResult> {
    const docDriver = this.documentDriver;
    if (docDriver) {
      const filter = this.whereToMongoFilter(where, false);
      const res = await docDriver.docUpdate(
        this.metadata.tableName,
        filter,
        { $inc: { [propertyPath]: delta } },
        { multi: true },
      );
      return { affected: res.modifiedCount, generatedMaps: [], raw: res };
    }

    const dialect = this.runtime.driver.dialect;
    const col =
      this.metadata.columnsByProperty.get(propertyPath) ??
      this.metadata.columnsByColumnName.get(propertyPath);
    const colName = col
      ? col.columnName
      : assertSafeSqlIdentifier(propertyPath, "column name");
    const colQ = quoteIdentifier(colName, dialect);
    const tableRef = formatTableRef(
      this.metadata.tableName,
      this.metadata.schema,
      dialect,
    );
    const collector = new ParameterCollector(dialect);
    const deltaPh = collector.add(delta);

    const alias = "e";
    const whereCompiled = compileWhereClause(
      this.metadata,
      where,
      alias,
      this.runtime.graph,
      dialect,
      false,
      collector,
    );
    const cleanWhere = whereCompiled.sql.replaceAll(
      `${quoteIdentifier(alias, dialect)}.`,
      "",
    );
    const sql = `UPDATE ${tableRef} SET ${colQ} = ${colQ} + ${deltaPh}${cleanWhere ? ` WHERE ${cleanWhere}` : ""}`;
    const res = await this.runtime.driver.execute(sql, collector.values);
    return { affected: res.affectedRows, generatedMaps: [], raw: res };
  }

  async clear(): Promise<void> {
    const docDriver = this.documentDriver;
    if (docDriver) {
      await docDriver.docDelete(this.metadata.tableName, {}, { multi: true });
      return;
    }

    const dialect = this.runtime.driver.dialect;
    const tableRef = formatTableRef(
      this.metadata.tableName,
      this.metadata.schema,
      dialect,
    );
    await this.runtime.driver.execute(`DELETE FROM ${tableRef}`);
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    parameters: readonly unknown[] = [],
  ): Promise<T[]> {
    const res = await this.runtime.driver.query<T>(sql, parameters);
    return res.rows;
  }

  createQueryBuilder(alias?: string): SelectQueryBuilder<Entity> {
    const safeAlias = alias ?? this.metadata.tableName;
    return new SelectQueryBuilder<Entity>(this.metadata, safeAlias, {
      executor: this.runtime.driver,
      graph: this.runtime.graph,
      safeJsonSerialization: this.runtime.safeJsonSerialization,
      circularJsonStrategy: this.runtime.circularJsonStrategy,
    });
  }

  createInsertQueryBuilder(): InsertQueryBuilder<Entity> {
    return new InsertQueryBuilder<Entity>(this.metadata, this.runtime.driver);
  }

  createUpdateQueryBuilder(): UpdateQueryBuilder<Entity> {
    return new UpdateQueryBuilder<Entity>(this.metadata, this.runtime.driver);
  }

  createDeleteQueryBuilder(): DeleteQueryBuilder {
    return new DeleteQueryBuilder(this.metadata, this.runtime.driver);
  }

  extend<CustomRepository extends object>(
    custom: CustomRepository & ThisType<this & CustomRepository>,
  ): this & CustomRepository {
    const extended = Object.create(this) as this & CustomRepository;
    Object.assign(extended, custom);
    return extended;
  }

  private normalizeCriteria(
    criteria:
      | string
      | number
      | readonly (string | number)[]
      | FindOptionsWhere<Entity>,
  ): FindOptionsWhere<Entity> {
    const pkProp = this.metadata.primaryColumn.propertyName;
    if (typeof criteria === "string" || typeof criteria === "number") {
      return { [pkProp]: criteria } as FindOptionsWhere<Entity>;
    }
    if (Array.isArray(criteria)) {
      return {
        [pkProp]: {
          __ormFindOperator: true,
          type: "in",
          value: criteria,
        },
      } as FindOptionsWhere<Entity>;
    }
    return criteria as FindOptionsWhere<Entity>;
  }

  private buildSelectColumns(
    select: FindManyOptions<Entity>["select"],
    alias: string,
    dialect: OrmDriverLike["dialect"],
  ): string {
    const aliasQ = quoteIdentifier(alias, dialect);
    if (!select) {
      const cols = this.metadata.columns
        .filter((c) => c.select || c.primary || c.isVirtualJoinColumn)
        .map((c) => `${aliasQ}.${quoteIdentifier(c.columnName, dialect)}`);
      return cols.length > 0 ? cols.join(", ") : `${aliasQ}.*`;
    }

    const wantedProps = new Set<string>();
    // Always include primary columns and virtual FK columns so hydration & relation loading work
    for (const pk of this.metadata.primaryColumns) {
      wantedProps.add(pk.columnName);
    }
    for (const c of this.metadata.columns) {
      if (c.isVirtualJoinColumn) wantedProps.add(c.columnName);
    }

    const addSelectedProp = (prop: string) => {
      const col =
        this.metadata.columnsByProperty.get(prop) ??
        this.metadata.columnsByColumnName.get(prop);
      if (col) {
        wantedProps.add(col.columnName);
        return;
      }
      const emb = this.metadata.embeddedsByProperty.get(prop);
      if (emb) {
        if (emb.resolvedMode === "json" && emb.jsonColumnName) {
          wantedProps.add(emb.jsonColumnName);
        } else {
          for (const c of this.metadata.columns) {
            if (c.propertyPath[0] === prop) {
              wantedProps.add(c.columnName);
            }
          }
        }
      }
    };

    if (Array.isArray(select)) {
      for (const s of select) addSelectedProp(String(s));
    } else {
      for (const [k, v] of Object.entries(select)) {
        if (v) addSelectedProp(k);
      }
    }

    return [...wantedProps]
      .map((c) => `${aliasQ}.${quoteIdentifier(c, dialect)}`)
      .join(", ");
  }
}

export { formatPlaceholder };
