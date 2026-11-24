import { METADATA_KEYS } from "../constants/metadata-keys";
import type { Abstract, Type } from "../interfaces/type.interface";
import { DecoratorRegistry } from "../metadata/decorator-registry";
import { MetadataRegistry } from "../metadata/metadata-registry";

export type ColumnDataType =
  | "integer"
  | "text"
  | "real"
  | "boolean"
  | "json"
  | "datetime"
  | "blob"
  | "bigint"
  | "varchar"
  | "uuid";

export type ColumnGenerationStrategy = "increment" | "uuid";

export interface ColumnTransformer<TApp = any, TDb = any> {
  readonly to: (value: TApp) => TDb;
  readonly from: (value: TDb) => TApp;
}

export interface ColumnOptions {
  readonly name?: string;
  readonly type?: ColumnDataType;
  readonly nullable?: boolean;
  readonly unique?: boolean;
  readonly default?: unknown;
  readonly primary?: boolean;
  readonly generated?: boolean | ColumnGenerationStrategy;
  readonly length?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly min?: number;
  readonly max?: number;
  readonly pattern?: RegExp | string;
  readonly enum?: readonly (string | number)[];
  readonly description?: string;
  readonly example?: unknown;
  readonly transformer?: ColumnTransformer;
  readonly createdAt?: boolean;
  readonly updatedAt?: boolean;
}

export interface EntitySchemaOptions {
  readonly name?: string;
  readonly tableName?: string;
  readonly schema?: string;
  readonly description?: string;
  readonly camelCaseMapping?: boolean;
  readonly pluralizeTableName?: boolean;
}

export interface IndexOptions {
  readonly name?: string;
  readonly columns?: readonly string[];
  readonly unique?: boolean;
  readonly where?: string;
}

export interface UniqueOptions {
  readonly name?: string;
  readonly columns?: readonly string[];
  readonly where?: string;
}

interface StoredEntityMetadata {
  readonly explicitTableName?: string;
  readonly schema?: string;
  readonly description?: string;
  readonly camelCaseMapping: boolean;
  readonly pluralizeTableName: boolean;
}

interface StoredColumnMetadata {
  readonly propertyName: string;
  readonly explicitName?: string;
  readonly type: ColumnDataType;
  readonly designType?: Function;
  readonly nullable: boolean;
  readonly unique: boolean;
  readonly hasDefault: boolean;
  readonly default?: unknown;
  readonly primary: boolean;
  readonly generated: boolean;
  readonly generationStrategy?: ColumnGenerationStrategy;
  readonly length?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly min?: number;
  readonly max?: number;
  readonly pattern?: RegExp | string;
  readonly enum?: readonly (string | number)[];
  readonly description?: string;
  readonly example?: unknown;
  readonly transformer?: ColumnTransformer;
  readonly createdAt: boolean;
  readonly updatedAt: boolean;
}

export interface EntityColumnMetadata {
  readonly propertyName: string;
  readonly name: string;
  readonly type: ColumnDataType;
  readonly designType?: Function;
  readonly nullable: boolean;
  readonly unique: boolean;
  readonly hasDefault: boolean;
  readonly default?: unknown;
  readonly primary: boolean;
  readonly generated: boolean;
  readonly generationStrategy?: ColumnGenerationStrategy;
  readonly length?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly min?: number;
  readonly max?: number;
  readonly pattern?: RegExp | string;
  readonly enum?: readonly (string | number)[];
  readonly description?: string;
  readonly example?: unknown;
  readonly transformer?: ColumnTransformer;
  readonly createdAt: boolean;
  readonly updatedAt: boolean;
}

export interface EntityIndexMetadata {
  readonly name?: string;
  readonly columns: readonly string[];
  readonly unique: boolean;
  readonly where?: string;
}

export interface EntitySchemaMetadata {
  readonly target: Type<unknown> | Abstract<unknown>;
  readonly name: string;
  readonly tableName: string;
  readonly schema?: string;
  readonly description?: string;
  readonly camelCaseMapping: boolean;
  readonly columns: readonly EntityColumnMetadata[];
  readonly primaryKeys: readonly EntityColumnMetadata[];
  readonly primaryKey?: EntityColumnMetadata;
  readonly indexes: readonly EntityIndexMetadata[];
}

function camelToSnake(input: string): string {
  return input
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

function pluralizeWord(word: string): string {
  if (word.length === 0) return word;
  if (/(?:s|x|z|ch|sh)$/i.test(word)) {
    return `${word}es`;
  }
  if (/[^aeiou]y$/i.test(word)) {
    return `${word.slice(0, -1)}ies`;
  }
  return `${word}s`;
}

function inferTableName(entity: Function, pluralize: boolean): string {
  const snake = camelToSnake(entity.name || "entity");
  if (!pluralize) {
    return snake;
  }
  const parts = snake.split("_");
  const last = parts[parts.length - 1] ?? snake;
  parts[parts.length - 1] = pluralizeWord(last);
  return parts.join("_");
}

function inferColumnTypeFromDesignType(
  designType: unknown,
  fallback: ColumnDataType = "text",
): ColumnDataType {
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
  if (typeof designType === "function") return "json";
  return fallback;
}

function resolveTargetConstructor(target: object): Function | undefined {
  if (typeof target === "function") {
    return target;
  }
  const ctor = (target as { constructor?: unknown }).constructor;
  return typeof ctor === "function" ? ctor : undefined;
}

function recordColumnMetadata(
  target: object,
  propertyKey: string | symbol,
  options: ColumnOptions,
  fallbackType: ColumnDataType = "text",
): void {
  const ctor = resolveTargetConstructor(target);
  if (!ctor) {
    return;
  }

  const propertyName = String(propertyKey);
  const designType = MetadataRegistry.getType(target, propertyKey);

  const generatedFlag =
    options.generated === true ||
    options.generated === "increment" ||
    options.generated === "uuid";
  const generationStrategy: ColumnGenerationStrategy | undefined =
    options.generated === "uuid" || (generatedFlag && options.type === "uuid")
      ? "uuid"
      : generatedFlag
        ? "increment"
        : undefined;

  const resolvedType: ColumnDataType =
    options.type ??
    (generationStrategy === "uuid"
      ? "uuid"
      : inferColumnTypeFromDesignType(designType, fallbackType));

  const primary = options.primary === true;
  const nullable = options.nullable ?? (primary ? false : false);
  const hasDefault = "default" in options && options.default !== undefined;

  const entry: StoredColumnMetadata = {
    propertyName,
    ...(options.name !== undefined ? { explicitName: options.name } : {}),
    type: resolvedType,
    ...(designType !== undefined ? { designType } : {}),
    nullable,
    unique: options.unique === true,
    hasDefault,
    ...(hasDefault ? { default: options.default } : {}),
    primary,
    generated: generatedFlag,
    ...(generationStrategy !== undefined ? { generationStrategy } : {}),
    ...(options.length !== undefined ? { length: options.length } : {}),
    ...(options.minLength !== undefined
      ? { minLength: options.minLength }
      : {}),
    ...(options.maxLength !== undefined
      ? { maxLength: options.maxLength }
      : {}),
    ...(options.min !== undefined ? { min: options.min } : {}),
    ...(options.max !== undefined ? { max: options.max } : {}),
    ...(options.pattern !== undefined ? { pattern: options.pattern } : {}),
    ...(options.enum !== undefined ? { enum: [...options.enum] } : {}),
    ...(options.description !== undefined
      ? { description: options.description }
      : {}),
    ...(options.example !== undefined ? { example: options.example } : {}),
    ...(options.transformer !== undefined
      ? { transformer: options.transformer }
      : {}),
    createdAt: options.createdAt === true,
    updatedAt: options.updatedAt === true,
  };

  // Copy-on-write on ctor so subclasses never mutate parent column metadata.
  // If multiple column decorators stack on the same property, merge cleanly.
  const existing =
    MetadataRegistry.getOwn<readonly StoredColumnMetadata[]>(
      METADATA_KEYS.ENTITY_COLUMNS,
      ctor,
    ) ?? [];
  const existingIdx = existing.findIndex(
    (col) => col.propertyName === propertyName,
  );
  const next =
    existingIdx !== -1
      ? [
          ...existing.slice(0, existingIdx),
          entry,
          ...existing.slice(existingIdx + 1),
        ]
      : [...existing, entry];

  MetadataRegistry.define(METADATA_KEYS.ENTITY_COLUMNS, next, ctor);
  bumpEntitySchemaVersion();
}

function recordIndexMetadata(target: object, entry: EntityIndexMetadata): void {
  const ctor = resolveTargetConstructor(target);
  if (!ctor) {
    return;
  }
  MetadataRegistry.appendOwnArray<EntityIndexMetadata>(
    METADATA_KEYS.ENTITY_INDEXES,
    [entry],
    ctor,
  );
  bumpEntitySchemaVersion();
}

/**
 * Declares a unified single-source-of-truth Bunest entity schema class and
 * self-registers it in `DecoratorRegistry` at class-evaluation time.
 */
export function Entity(
  tableOrOptions?: string | EntitySchemaOptions,
): ClassDecorator {
  const opts: EntitySchemaOptions =
    typeof tableOrOptions === "string"
      ? { tableName: tableOrOptions }
      : (tableOrOptions ?? {});

  const stored: StoredEntityMetadata = {
    ...((opts.tableName ?? opts.name)
      ? { explicitTableName: opts.tableName ?? opts.name }
      : {}),
    ...(opts.schema !== undefined ? { schema: opts.schema } : {}),
    ...(opts.description !== undefined
      ? { description: opts.description }
      : {}),
    camelCaseMapping: opts.camelCaseMapping ?? true,
    pluralizeTableName: opts.pluralizeTableName ?? true,
  };

  return (target: Function) => {
    MetadataRegistry.define<StoredEntityMetadata>(
      METADATA_KEYS.ENTITY_SCHEMA,
      stored,
      target,
    );
    bumpEntitySchemaVersion();
    const resolvedTableName =
      stored.explicitTableName ??
      inferTableName(target, stored.pluralizeTableName);
    DecoratorRegistry.registerEntity(target, {
      tableName: resolvedTableName,
      ...(stored.schema !== undefined ? { schema: stored.schema } : {}),
    });
  };
}

/**
 * Declares a column on a unified `@Entity()` schema class.
 * Automatically infers SQL/schema `type` from TypeScript `design:type` when omitted.
 */
export function Column(options: ColumnOptions = {}): PropertyDecorator {
  return (target: object, propertyKey: string | symbol) => {
    recordColumnMetadata(target, propertyKey, options, "text");
  };
}

/**
 * Marks a property as a primary key column on an `@Entity()` class.
 */
export function PrimaryKey(options: ColumnOptions = {}): PropertyDecorator {
  return (target: object, propertyKey: string | symbol) => {
    recordColumnMetadata(
      target,
      propertyKey,
      {
        ...options,
        primary: true,
        nullable: options.nullable ?? false,
      },
      "integer",
    );
  };
}

/**
 * Marks a property as an auto-generated primary key column (auto-increment integer
 * or UUID) on an `@Entity()` class.
 */
export function PrimaryGeneratedColumn(
  strategyOrOptions?: ColumnGenerationStrategy | ColumnOptions,
  extraOptions?: ColumnOptions,
): PropertyDecorator {
  let normalized: ColumnOptions;
  if (typeof strategyOrOptions === "string") {
    normalized = {
      ...extraOptions,
      primary: true,
      generated: strategyOrOptions,
      type:
        extraOptions?.type ??
        (strategyOrOptions === "uuid" ? "uuid" : "integer"),
      nullable: extraOptions?.nullable ?? false,
    };
  } else {
    const opts = strategyOrOptions ?? {};
    const generated = opts.generated ?? true;
    const isUuid = generated === "uuid" || opts.type === "uuid";
    normalized = {
      ...opts,
      primary: true,
      generated,
      ...(isUuid && opts.type === undefined ? { type: "uuid" } : {}),
      nullable: opts.nullable ?? false,
    };
  }

  return (target: object, propertyKey: string | symbol) => {
    recordColumnMetadata(target, propertyKey, normalized, "integer");
  };
}

/**
 * Marks a property as an automatic creation timestamp column (`createdAt: true`,
 * defaulting to `"datetime"`).
 */
export function CreateDateColumn(
  options: ColumnOptions = {},
): PropertyDecorator {
  return (target: object, propertyKey: string | symbol) => {
    recordColumnMetadata(
      target,
      propertyKey,
      {
        ...options,
        type: options.type ?? "datetime",
        createdAt: true,
      },
      "datetime",
    );
  };
}

/**
 * Marks a property as an automatic update timestamp column (`updatedAt: true`,
 * defaulting to `"datetime"`).
 */
export function UpdateDateColumn(
  options: ColumnOptions = {},
): PropertyDecorator {
  return (target: object, propertyKey: string | symbol) => {
    recordColumnMetadata(
      target,
      propertyKey,
      {
        ...options,
        type: options.type ?? "datetime",
        updatedAt: true,
      },
      "datetime",
    );
  };
}

/**
 * Declares a single-column (property decorator) or composite (class decorator)
 * database index on an `@Entity()` class.
 */
export function Index(
  columnsOrOptions?: string | readonly string[] | IndexOptions,
  extraOptions?: Omit<IndexOptions, "columns">,
): ClassDecorator & PropertyDecorator {
  const decorator = (target: object, propertyKey?: string | symbol): any => {
    // Property decorator usage
    if (propertyKey !== undefined) {
      const propName = String(propertyKey);
      let opts: IndexOptions;
      if (typeof columnsOrOptions === "string") {
        opts = { name: columnsOrOptions, ...extraOptions };
      } else if (Array.isArray(columnsOrOptions)) {
        opts = { ...extraOptions };
      } else {
        opts = {
          ...(columnsOrOptions as IndexOptions | undefined),
          ...extraOptions,
        };
      }
      recordIndexMetadata(target, {
        ...(opts.name !== undefined ? { name: opts.name } : {}),
        columns:
          opts.columns && opts.columns.length > 0
            ? [...opts.columns]
            : [propName],
        unique: opts.unique === true,
        ...(opts.where !== undefined ? { where: opts.where } : {}),
      });
      return;
    }

    // Class decorator usage
    let columns: string[];
    let name: string | undefined;
    let unique = false;
    let where: string | undefined;

    if (Array.isArray(columnsOrOptions)) {
      columns = [...columnsOrOptions];
      name = extraOptions?.name;
      unique = extraOptions?.unique === true;
      where = extraOptions?.where;
    } else if (typeof columnsOrOptions === "string") {
      columns = [columnsOrOptions];
      name = extraOptions?.name;
      unique = extraOptions?.unique === true;
      where = extraOptions?.where;
    } else if (columnsOrOptions && typeof columnsOrOptions === "object") {
      const idxOpts = columnsOrOptions as IndexOptions;
      columns = idxOpts.columns ? [...idxOpts.columns] : [];
      name = idxOpts.name ?? extraOptions?.name;
      unique = (idxOpts.unique ?? extraOptions?.unique) === true;
      where = idxOpts.where ?? extraOptions?.where;
    } else {
      columns = [];
    }

    if (columns.length === 0) {
      throw new Error(
        `@Index() as a class decorator on "${(target as Function).name || "Anonymous"}" requires at least one column name.`,
      );
    }

    recordIndexMetadata(target, {
      ...(name !== undefined ? { name } : {}),
      columns,
      unique,
      ...(where !== undefined ? { where } : {}),
    });
    return target;
  };

  return decorator as ClassDecorator & PropertyDecorator;
}

/**
 * Declares a single-column (property decorator) or composite (class decorator)
 * unique constraint/index on an `@Entity()` class.
 */
export function Unique(
  columnsOrOptions?: string | readonly string[] | UniqueOptions,
  extraOptions?: Omit<UniqueOptions, "columns">,
): ClassDecorator & PropertyDecorator {
  if (typeof columnsOrOptions === "string") {
    return Index(columnsOrOptions, { ...extraOptions, unique: true });
  }
  if (Array.isArray(columnsOrOptions)) {
    return Index(columnsOrOptions, { ...extraOptions, unique: true });
  }
  return Index({
    ...(columnsOrOptions as UniqueOptions | undefined),
    ...extraOptions,
    unique: true,
  });
}

// ============================================================================
// Lazy External Entity Schema Resolvers (e.g. @bunest/orm -> @bunest/core bridge)
// ============================================================================

export interface EntitySchemaQueryOptions {
  /** Skip external lazy schema resolvers (e.g. `@bunest/orm`) and inspect only native `@bunest/core` metadata. */
  readonly skipExternalResolvers?: boolean;
}

export interface ExternalEntitySchemaResolver {
  readonly id: string;
  hasSchema(ctor: Function): boolean;
  getSchema(ctor: Function): EntitySchemaMetadata | undefined;
  getColumns?(ctor: Function): EntityColumnMetadata[] | undefined;
  getIndexes?(ctor: Function): EntityIndexMetadata[] | undefined;
  /** Optional version counter for WeakMap cache invalidation. */
  getVersion?(): number;
}

interface EntitySchemaResolverRegistryState {
  readonly resolvers: Map<string, ExternalEntitySchemaResolver>;
  version: number;
}

const ENTITY_SCHEMA_RESOLVERS_SYM = Symbol.for("bunest:entity_schema:resolvers");

function getResolverRegistryState(): EntitySchemaResolverRegistryState {
  const g = globalThis as Record<PropertyKey, unknown>;
  let state = g[ENTITY_SCHEMA_RESOLVERS_SYM] as
    | EntitySchemaResolverRegistryState
    | undefined;
  if (!state) {
    state = {
      resolvers: new Map<string, ExternalEntitySchemaResolver>(),
      version: 1,
    };
    g[ENTITY_SCHEMA_RESOLVERS_SYM] = state;
  }
  return state;
}

function bumpEntitySchemaVersion(): void {
  getResolverRegistryState().version += 1;
}

function computeSchemaCacheStamp(skipExternal: boolean): string {
  const state = getResolverRegistryState();
  if (skipExternal || state.resolvers.size === 0) {
    return `c:${state.version}`;
  }
  let stamp = `c:${state.version}`;
  for (const resolver of state.resolvers.values()) {
    stamp += `|${resolver.id}:${resolver.getVersion ? resolver.getVersion() : 0}`;
  }
  return stamp;
}

const entitySchemaCache = new WeakMap<
  Function,
  { readonly stamp: string; readonly schema: EntitySchemaMetadata | undefined }
>();

/**
 * Registers a lazy external entity schema bridge (such as `@bunest/orm`) so
 * `getEntitySchema()`, `getEntityColumns()`, `getEntityIndexes()`, and `hasEntitySchema()`
 * materialize unified schemas on demand without eager decoration-time double-writes.
 */
export function registerEntitySchemaResolver(
  resolver: ExternalEntitySchemaResolver,
): () => void {
  const state = getResolverRegistryState();
  state.resolvers.set(resolver.id, resolver);
  state.version += 1;
  return () => {
    unregisterEntitySchemaResolver(resolver.id);
  };
}

/**
 * Removes a previously registered lazy external entity schema bridge by `id`.
 */
export function unregisterEntitySchemaResolver(id: string): boolean {
  const state = getResolverRegistryState();
  const removed = state.resolvers.delete(id);
  if (removed) {
    state.version += 1;
  }
  return removed;
}

/**
 * Returns `true` when `target` (or an ancestor class) is decorated with `@Entity()`
 * (natively in `@bunest/core` or via a registered lazy bridge like `@bunest/orm`).
 */
export function hasEntitySchema(
  target: object,
  options?: EntitySchemaQueryOptions,
): boolean {
  const ctor = resolveTargetConstructor(target);
  if (!ctor) {
    return false;
  }
  if (MetadataRegistry.has(METADATA_KEYS.ENTITY_SCHEMA, ctor)) {
    return true;
  }
  if (options?.skipExternalResolvers) {
    return false;
  }
  const { resolvers } = getResolverRegistryState();
  for (const resolver of resolvers.values()) {
    if (resolver.hasSchema(ctor)) {
      return true;
    }
  }
  return false;
}

function getNativeEntityColumns(ctor: Function): EntityColumnMetadata[] {
  const storedEntity = MetadataRegistry.get<StoredEntityMetadata>(
    METADATA_KEYS.ENTITY_SCHEMA,
    ctor,
  );
  const camelCaseMapping = storedEntity?.camelCaseMapping ?? true;

  const orderedProps: string[] = [];
  const byProp = new Map<string, StoredColumnMetadata>();
  const chain = MetadataRegistry.getPrototypeChain(ctor);

  for (let i = 0; i < chain.length; i++) {
    const cls = chain[i]!;
    const ownCols = MetadataRegistry.getOwn<readonly StoredColumnMetadata[]>(
      METADATA_KEYS.ENTITY_COLUMNS,
      cls,
    );
    if (!ownCols || ownCols.length === 0) {
      continue;
    }
    for (let j = 0; j < ownCols.length; j++) {
      const col = ownCols[j]!;
      if (!byProp.has(col.propertyName)) {
        orderedProps.push(col.propertyName);
      }
      byProp.set(col.propertyName, col);
    }
  }

  // Collect single-column @Unique() property decorators so `col.unique` reflects them
  const uniqueProps = new Set<string>();
  const rawIndexes = MetadataRegistry.getMergedClassArray<EntityIndexMetadata>(
    METADATA_KEYS.ENTITY_INDEXES,
    ctor,
  );
  for (let i = 0; i < rawIndexes.length; i++) {
    const idx = rawIndexes[i]!;
    if (idx.unique && idx.columns.length === 1 && idx.columns[0]) {
      uniqueProps.add(idx.columns[0]);
    }
  }

  const result: EntityColumnMetadata[] = [];
  for (let i = 0; i < orderedProps.length; i++) {
    const prop = orderedProps[i]!;
    const stored = byProp.get(prop)!;
    const resolvedName =
      stored.explicitName ??
      (camelCaseMapping
        ? camelToSnake(stored.propertyName)
        : stored.propertyName);

    result.push({
      propertyName: stored.propertyName,
      name: resolvedName,
      type: stored.type,
      ...(stored.designType !== undefined
        ? { designType: stored.designType }
        : {}),
      nullable: stored.nullable,
      unique:
        stored.unique ||
        uniqueProps.has(stored.propertyName) ||
        uniqueProps.has(resolvedName),
      hasDefault: stored.hasDefault,
      ...(stored.hasDefault ? { default: stored.default } : {}),
      primary: stored.primary,
      generated: stored.generated,
      ...(stored.generationStrategy !== undefined
        ? { generationStrategy: stored.generationStrategy }
        : {}),
      ...(stored.length !== undefined ? { length: stored.length } : {}),
      ...(stored.minLength !== undefined
        ? { minLength: stored.minLength }
        : {}),
      ...(stored.maxLength !== undefined
        ? { maxLength: stored.maxLength }
        : {}),
      ...(stored.min !== undefined ? { min: stored.min } : {}),
      ...(stored.max !== undefined ? { max: stored.max } : {}),
      ...(stored.pattern !== undefined ? { pattern: stored.pattern } : {}),
      ...(stored.enum !== undefined ? { enum: [...stored.enum] } : {}),
      ...(stored.description !== undefined
        ? { description: stored.description }
        : {}),
      ...(stored.example !== undefined ? { example: stored.example } : {}),
      ...(stored.transformer !== undefined
        ? { transformer: stored.transformer }
        : {}),
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
    });
  }

  return result;
}

/**
 * Returns normalized column descriptors for an entity class across its
 * inheritance chain (base -> derived), resolving SQL column names cleanly.
 */
export function getEntityColumns(
  target: object,
  options?: EntitySchemaQueryOptions,
): EntityColumnMetadata[] {
  const ctor = resolveTargetConstructor(target);
  if (!ctor) {
    return [];
  }

  const nativeCols = getNativeEntityColumns(ctor);
  if (options?.skipExternalResolvers) {
    return nativeCols;
  }

  const { resolvers } = getResolverRegistryState();
  if (resolvers.size === 0) {
    return nativeCols;
  }

  const order: string[] = [];
  const merged = new Map<string, EntityColumnMetadata>();
  for (let i = 0; i < nativeCols.length; i++) {
    const col = nativeCols[i]!;
    order.push(col.propertyName);
    merged.set(col.propertyName, col);
  }

  for (const resolver of resolvers.values()) {
    const extCols = resolver.getColumns?.(ctor);
    if (!extCols || extCols.length === 0) continue;
    for (let i = 0; i < extCols.length; i++) {
      const col = extCols[i]!;
      if (!merged.has(col.propertyName)) {
        order.push(col.propertyName);
      }
      merged.set(col.propertyName, col);
    }
  }

  const result: EntityColumnMetadata[] = [];
  for (let i = 0; i < order.length; i++) {
    result.push(merged.get(order[i]!)!);
  }
  return result;
}

function getNativeEntityIndexes(
  ctor: Function,
  columns: readonly EntityColumnMetadata[],
): EntityIndexMetadata[] {
  const propToColumn = new Map<string, string>();
  for (let i = 0; i < columns.length; i++) {
    const col = columns[i]!;
    propToColumn.set(col.propertyName, col.name);
  }

  const storedEntity = MetadataRegistry.get<StoredEntityMetadata>(
    METADATA_KEYS.ENTITY_SCHEMA,
    ctor,
  );
  const camelCaseMapping = storedEntity?.camelCaseMapping ?? true;

  const raw = MetadataRegistry.getMergedClassArray<EntityIndexMetadata>(
    METADATA_KEYS.ENTITY_INDEXES,
    ctor,
  );
  return raw.map((idx) => ({
    ...(idx.name !== undefined ? { name: idx.name } : {}),
    columns: idx.columns.map(
      (c) => propToColumn.get(c) ?? (camelCaseMapping ? camelToSnake(c) : c),
    ),
    unique: idx.unique,
    ...(idx.where !== undefined ? { where: idx.where } : {}),
  }));
}

/**
 * Returns normalized index & unique definitions for an entity class across its
 * inheritance chain (base -> derived).
 */
export function getEntityIndexes(
  target: object,
  options?: EntitySchemaQueryOptions,
): EntityIndexMetadata[] {
  const ctor = resolveTargetConstructor(target);
  if (!ctor) {
    return [];
  }
  const columns = getEntityColumns(ctor, options);
  const nativeIndexes = getNativeEntityIndexes(ctor, columns);
  if (options?.skipExternalResolvers) {
    return nativeIndexes;
  }

  const { resolvers } = getResolverRegistryState();
  if (resolvers.size === 0) {
    return nativeIndexes;
  }

  const all = [...nativeIndexes];
  for (const resolver of resolvers.values()) {
    const extIndexes = resolver.getIndexes?.(ctor);
    if (extIndexes && extIndexes.length > 0) {
      all.push(...extIndexes);
    }
  }
  return all;
}

/**
 * Returns the complete unified `EntitySchemaMetadata` for an `@Entity()` class
 * (including inherited columns, primary keys, and indexes), or `undefined` if
 * the target is not decorated with `@Entity()`.
 */
export function getEntitySchema(
  target: object,
  options?: EntitySchemaQueryOptions,
): EntitySchemaMetadata | undefined {
  const ctor = resolveTargetConstructor(target);
  if (!ctor) {
    return undefined;
  }

  const skipExternal = options?.skipExternalResolvers === true;
  if (!skipExternal) {
    const stamp = computeSchemaCacheStamp(false);
    const cached = entitySchemaCache.get(ctor);
    if (cached && cached.stamp === stamp) {
      return cached.schema;
    }

    const computed = computeEntitySchema(ctor, false);
    entitySchemaCache.set(ctor, { stamp, schema: computed });
    return computed;
  }

  return computeEntitySchema(ctor, true);
}

function computeEntitySchema(
  ctor: Function,
  skipExternal: boolean,
): EntitySchemaMetadata | undefined {
  const stored = MetadataRegistry.get<StoredEntityMetadata>(
    METADATA_KEYS.ENTITY_SCHEMA,
    ctor,
  );
  if (stored) {
    const tableName =
      stored.explicitTableName ??
      inferTableName(ctor, stored.pluralizeTableName);
    const columns = getEntityColumns(ctor, {
      skipExternalResolvers: skipExternal,
    });
    const primaryKeys = columns.filter((col) => col.primary);
    const indexes = getEntityIndexes(ctor, {
      skipExternalResolvers: skipExternal,
    });

    return {
      target: ctor as Type<any> | Abstract<any>,
      name: tableName,
      tableName,
      ...(stored.schema !== undefined ? { schema: stored.schema } : {}),
      ...(stored.description !== undefined
        ? { description: stored.description }
        : {}),
      camelCaseMapping: stored.camelCaseMapping,
      columns,
      primaryKeys,
      ...(primaryKeys[0] !== undefined ? { primaryKey: primaryKeys[0] } : {}),
      indexes,
    };
  }

  if (skipExternal) {
    return undefined;
  }

  const { resolvers } = getResolverRegistryState();
  for (const resolver of resolvers.values()) {
    const extSchema = resolver.getSchema(ctor);
    if (extSchema) {
      // Merge any native @bunest/core columns/indexes if the class mixes decorators
      const nativeCols = getNativeEntityColumns(ctor);
      if (nativeCols.length === 0) {
        return extSchema;
      }
      const columns = getEntityColumns(ctor, { skipExternalResolvers: false });
      const primaryKeys = columns.filter((col) => col.primary);
      const indexes = getEntityIndexes(ctor, { skipExternalResolvers: false });
      return {
        ...extSchema,
        columns,
        primaryKeys,
        ...(primaryKeys[0] !== undefined ? { primaryKey: primaryKeys[0] } : {}),
        indexes,
      };
    }
  }

  return undefined;
}
