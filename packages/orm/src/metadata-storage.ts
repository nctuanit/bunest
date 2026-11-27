import { DecoratorRegistry, getCachedInheritanceChain } from "@bunest/core";
import type {
  EntityTarget,
  InverseSideSelector,
  LifecycleEventKind,
  ObjectType,
  OrmColumnOptions,
  OrmColumnType,
  OrmEmbeddedOptions,
  OrmEntityOptions,
  OrmIndexOptions,
  OrmJoinColumnOptions,
  OrmJoinTableOptions,
  OrmMorphManyOptions,
  OrmMorphTargets,
  OrmMorphToOptions,
  OrmRelationOptions,
  PrimaryGeneratedStrategy,
  RelationKind,
} from "./types";

export interface StoredOrmEntityMetadata {
  readonly explicitTableName?: string;
  readonly explicitName?: string;
  readonly schema?: string;
  readonly description?: string;
  readonly camelCaseMapping: boolean;
  readonly pluralizeTableName: boolean;
  readonly comment?: string;
}

export interface StoredOrmColumnMetadata {
  readonly propertyName: string;
  readonly explicitName?: string;
  readonly type?: OrmColumnType;
  readonly designType?: Function;
  readonly length?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly min?: number;
  readonly max?: number;
  readonly pattern?: RegExp | string;
  readonly precision?: number;
  readonly scale?: number;
  readonly nullable?: boolean;
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
  readonly description?: string;
  readonly example?: unknown;
  readonly transformer?: OrmColumnOptions["transformer"];
  readonly createdAt: boolean;
  readonly updatedAt: boolean;
  readonly deletedAt: boolean;
  readonly version: boolean;
  readonly comment?: string;
  /** When true, excluded from lazy `@bunest/core` EntitySchemaMaterialization (e.g. `@DeleteDateColumn`, `@VersionColumn`). */
  readonly excludeFromCommonSchema?: boolean;
}

export interface StoredOrmIndexMetadata {
  readonly name?: string;
  readonly columns: readonly string[];
  readonly unique: boolean;
  readonly where?: string;
}

export interface StoredOrmRelationMetadata {
  readonly propertyName: string;
  readonly kind: RelationKind;
  readonly target?: EntityTarget;
  readonly inverseSide?: InverseSideSelector;
  readonly options: OrmRelationOptions;
  readonly morphTargets?: OrmMorphTargets;
  readonly morphName?: string;
  readonly morphToOptions?: OrmMorphToOptions;
  readonly morphManyOptions?: OrmMorphManyOptions;
}

export interface StoredOrmJoinColumnMetadata {
  readonly propertyName: string;
  readonly options: OrmJoinColumnOptions;
}

export interface StoredOrmJoinTableMetadata {
  readonly propertyName: string;
  readonly options: OrmJoinTableOptions;
}

export interface StoredOrmEmbeddedMetadata {
  readonly propertyName: string;
  readonly target: EntityTarget;
  readonly options: OrmEmbeddedOptions;
}

export interface StoredOrmListenerMetadata {
  readonly kind: LifecycleEventKind;
  readonly methodName: string;
}

export interface ClassOrmMetadataBucket {
  entity?: StoredOrmEntityMetadata;
  embeddable?: boolean;
  columns: StoredOrmColumnMetadata[];
  indexes: StoredOrmIndexMetadata[];
  relations: StoredOrmRelationMetadata[];
  joinColumns: Map<string, StoredOrmJoinColumnMetadata>;
  joinTables: Map<string, StoredOrmJoinTableMetadata>;
  embeddeds: StoredOrmEmbeddedMetadata[];
  listeners: StoredOrmListenerMetadata[];
}

export interface OrmRegistrySnapshot {
  readonly entities: readonly ObjectType[];
  readonly aliases: ReadonlyArray<readonly [string, ObjectType]>;
}

interface OrmGlobalStore {
  readonly buckets: WeakMap<Function, ClassOrmMetadataBucket>;
  readonly entities: Set<ObjectType>;
  readonly aliases: Map<string, ObjectType>;
  version: number;
}

const ORM_STORE_SYMBOL = Symbol.for("bunest:orm:metadata_store:v1");

function getGlobalStore(): OrmGlobalStore {
  const g = globalThis as Record<PropertyKey, unknown>;
  let store = g[ORM_STORE_SYMBOL] as OrmGlobalStore | undefined;
  if (!store) {
    store = {
      buckets: new WeakMap<Function, ClassOrmMetadataBucket>(),
      entities: new Set<ObjectType>(),
      aliases: new Map<string, ObjectType>(),
      version: 1,
    };
    g[ORM_STORE_SYMBOL] = store;
  } else if (typeof store.version !== "number") {
    store.version = 1;
  }
  return store;
}

function getOrCreateOwnBucket(ctor: Function): ClassOrmMetadataBucket {
  const store = getGlobalStore();
  let bucket = store.buckets.get(ctor);
  if (!bucket) {
    bucket = {
      columns: [],
      indexes: [],
      relations: [],
      joinColumns: new Map(),
      joinTables: new Map(),
      embeddeds: [],
      listeners: [],
    };
    store.buckets.set(ctor, bucket);
  }
  return bucket;
}

/**
 * Resolves a constructor from either a class constructor or class prototype.
 */
export function resolveConstructor(target: object): ObjectType | undefined {
  if (typeof target === "function") {
    return target as ObjectType;
  }
  const ctor = (target as { constructor?: unknown }).constructor;
  return typeof ctor === "function" ? (ctor as ObjectType) : undefined;
}

/**
 * Returns the prototype inheritance chain from base ancestor -> derived class.
 */
export function getInheritanceChain(ctor: Function): Function[] {
  return [...getCachedInheritanceChain(ctor)];
}

/**
 * Passive, copy-on-write, inheritance-safe metadata storage for `@bunest/orm`.
 *
 * Phase 1 (decoration time) ONLY writes into this store and NEVER invokes
 * relation/embedded target thunks or inspects external classes, guaranteeing
 * zero circular-dependency errors during module evaluation.
 */
export class OrmMetadataStorage {
  static getVersion(): number {
    return getGlobalStore().version;
  }

  static registerEntity(
    ctor: ObjectType,
    options: OrmEntityOptions = {},
    resolvedTableName?: string,
  ): void {
    const store = getGlobalStore();
    const bucket = getOrCreateOwnBucket(ctor);
    bucket.entity = {
      ...(options.tableName !== undefined || options.name !== undefined
        ? { explicitTableName: options.tableName ?? options.name }
        : {}),
      ...(options.name !== undefined ? { explicitName: options.name } : {}),
      ...(options.schema !== undefined ? { schema: options.schema } : {}),
      ...(options.description !== undefined
        ? { description: options.description }
        : {}),
      camelCaseMapping: options.camelCaseMapping ?? true,
      pluralizeTableName: options.pluralizeTableName ?? true,
      ...(options.comment !== undefined ? { comment: options.comment } : {}),
    };
    store.version += 1;

    store.entities.add(ctor);
    if (ctor.name) {
      store.aliases.set(ctor.name, ctor);
    }
    if (options.name) {
      store.aliases.set(options.name, ctor);
    }
    if (options.tableName) {
      store.aliases.set(options.tableName, ctor);
    }
    if (resolvedTableName) {
      store.aliases.set(resolvedTableName, ctor);
    }

    DecoratorRegistry.registerEntity(ctor, {
      tableName: resolvedTableName ?? options.tableName ?? options.name ?? ctor.name,
      ...(options.schema !== undefined ? { schema: options.schema } : {}),
      orm: true,
    });
  }

  static registerEmbeddable(ctor: ObjectType, alias?: string): void {
    const store = getGlobalStore();
    const bucket = getOrCreateOwnBucket(ctor);
    bucket.embeddable = true;
    if (ctor.name) {
      store.aliases.set(ctor.name, ctor);
    }
    if (alias) {
      store.aliases.set(alias, ctor);
    }
  }

  static addColumn(
    ctor: ObjectType,
    col: StoredOrmColumnMetadata,
    prepend = false,
  ): void {
    const bucket = getOrCreateOwnBucket(ctor);
    const idx = bucket.columns.findIndex(
      (existing) => existing.propertyName === col.propertyName,
    );
    if (idx !== -1) {
      bucket.columns = [
        ...bucket.columns.slice(0, idx),
        col,
        ...bucket.columns.slice(idx + 1),
      ];
    } else if (prepend) {
      bucket.columns = [col, ...bucket.columns];
    } else {
      bucket.columns = [...bucket.columns, col];
    }
    getGlobalStore().version += 1;
  }

  static addIndex(ctor: ObjectType, index: StoredOrmIndexMetadata): void {
    const bucket = getOrCreateOwnBucket(ctor);
    bucket.indexes = [...bucket.indexes, index];
    getGlobalStore().version += 1;
  }

  static addRelation(
    ctor: ObjectType,
    relation: StoredOrmRelationMetadata,
  ): void {
    const bucket = getOrCreateOwnBucket(ctor);
    const idx = bucket.relations.findIndex(
      (r) => r.propertyName === relation.propertyName,
    );
    if (idx !== -1) {
      bucket.relations = [
        ...bucket.relations.slice(0, idx),
        relation,
        ...bucket.relations.slice(idx + 1),
      ];
    } else {
      bucket.relations = [...bucket.relations, relation];
    }
  }

  static setJoinColumn(
    ctor: ObjectType,
    propertyName: string,
    options: OrmJoinColumnOptions,
  ): void {
    const bucket = getOrCreateOwnBucket(ctor);
    bucket.joinColumns.set(propertyName, { propertyName, options });
  }

  static setJoinTable(
    ctor: ObjectType,
    propertyName: string,
    options: OrmJoinTableOptions,
  ): void {
    const bucket = getOrCreateOwnBucket(ctor);
    bucket.joinTables.set(propertyName, { propertyName, options });
  }

  static addEmbedded(
    ctor: ObjectType,
    embedded: StoredOrmEmbeddedMetadata,
  ): void {
    const bucket = getOrCreateOwnBucket(ctor);
    const idx = bucket.embeddeds.findIndex(
      (e) => e.propertyName === embedded.propertyName,
    );
    if (idx !== -1) {
      bucket.embeddeds = [
        ...bucket.embeddeds.slice(0, idx),
        embedded,
        ...bucket.embeddeds.slice(idx + 1),
      ];
    } else {
      bucket.embeddeds = [...bucket.embeddeds, embedded];
    }
  }

  static addListener(
    ctor: ObjectType,
    listener: StoredOrmListenerMetadata,
  ): void {
    const bucket = getOrCreateOwnBucket(ctor);
    bucket.listeners = [...bucket.listeners, listener];
  }

  static getOwnBucket(ctor: Function): ClassOrmMetadataBucket | undefined {
    return getGlobalStore().buckets.get(ctor);
  }

  static isKnownClass(ctor: Function): boolean {
    const store = getGlobalStore();
    return store.buckets.has(ctor) || store.entities.has(ctor as ObjectType);
  }

  static getRegisteredEntities(): ObjectType[] {
    return [...getGlobalStore().entities];
  }

  static resolveByName(name: string): ObjectType | undefined {
    const store = getGlobalStore();
    const direct = store.aliases.get(name);
    if (direct) {
      return direct;
    }
    const lower = name.toLowerCase();
    for (const [alias, ctor] of store.aliases.entries()) {
      if (alias.toLowerCase() === lower) {
        return ctor;
      }
    }
    for (const entity of store.entities) {
      if (entity.name === name || entity.name.toLowerCase() === lower) {
        return entity;
      }
    }
    // Also check DecoratorRegistry for entities declared via @bunest/common
    for (const entity of DecoratorRegistry.getEntities()) {
      const meta = DecoratorRegistry.getMeta<{ tableName?: string }>(
        "entity",
        entity,
      );
      if (
        entity.name === name ||
        entity.name.toLowerCase() === lower ||
        meta?.tableName === name ||
        meta?.tableName?.toLowerCase() === lower
      ) {
        return entity as ObjectType;
      }
    }
    return undefined;
  }

  static registerAlias(name: string, ctor: ObjectType): void {
    getGlobalStore().aliases.set(name, ctor);
  }

  static snapshot(): OrmRegistrySnapshot {
    const store = getGlobalStore();
    return {
      entities: [...store.entities],
      aliases: [...store.aliases.entries()],
    };
  }

  static restore(snapshot: OrmRegistrySnapshot): void {
    const store = getGlobalStore();
    store.entities.clear();
    store.aliases.clear();
    for (const e of snapshot.entities) {
      store.entities.add(e);
    }
    for (const [k, v] of snapshot.aliases) {
      store.aliases.set(k, v);
    }
    store.version += 1;
  }

  static clearRegistry(): void {
    const store = getGlobalStore();
    store.entities.clear();
    store.aliases.clear();
    store.version += 1;
  }
}
