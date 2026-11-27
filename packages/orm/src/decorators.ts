import {
  MetadataRegistry,
  getCachedInheritanceChain,
  registerEntitySchemaResolver,
  type Abstract,
  type ColumnDataType,
  type ColumnGenerationStrategy,
  type EntityColumnMetadata,
  type EntityIndexMetadata,
  type EntitySchemaMetadata,
  type Type,
} from "@bunest/core";
import { camelToSnake, inferTableName } from "./identifiers";
import {
  OrmMetadataStorage,
  resolveConstructor,
  type StoredOrmColumnMetadata,
  type StoredOrmEntityMetadata,
  type StoredOrmIndexMetadata,
} from "./metadata-storage";
import type {
  BaseEntityColumnOption,
  BaseEntityOptions,
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
  OrmUniqueOptions,
  PrimaryGeneratedStrategy,
  RelationKind,
} from "./types";

function safeGetDesignType(
  target: object,
  propertyKey: string | symbol,
): Function | undefined {
  try {
    return MetadataRegistry.getType(target, propertyKey);
  } catch {
    return undefined;
  }
}

function toCommonColumnType(
  type: OrmColumnType | undefined,
): ColumnDataType | undefined {
  if (type === undefined) return undefined;
  switch (type) {
    case "float":
    case "decimal":
      return "real";
    case "jsonb":
      return "json";
    case "timestamp":
      return "datetime";
    case "date":
      return "date";
    case "objectid":
      return "text";
    default:
      return type;
  }
}

function inferCommonColumnTypeFromDesignType(
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

function collectOrmEntityChainData(ctor: Function): {
  entity?: StoredOrmEntityMetadata;
  columns: StoredOrmColumnMetadata[];
  indexes: StoredOrmIndexMetadata[];
} {
  const chain = getCachedInheritanceChain(ctor);
  let entity: StoredOrmEntityMetadata | undefined;
  const colOrder: string[] = [];
  const colMap = new Map<string, StoredOrmColumnMetadata>();
  const indexes: StoredOrmIndexMetadata[] = [];

  for (let i = 0; i < chain.length; i++) {
    const bucket = OrmMetadataStorage.getOwnBucket(chain[i]!);
    if (!bucket) continue;
    if (bucket.entity) {
      entity = bucket.entity;
    }
    for (let j = 0; j < bucket.columns.length; j++) {
      const col = bucket.columns[j]!;
      if (!colMap.has(col.propertyName)) {
        colOrder.push(col.propertyName);
      }
      colMap.set(col.propertyName, col);
    }
    for (let j = 0; j < bucket.indexes.length; j++) {
      indexes.push(bucket.indexes[j]!);
    }
  }

  const columns: StoredOrmColumnMetadata[] = [];
  for (let i = 0; i < colOrder.length; i++) {
    columns.push(colMap.get(colOrder[i]!)!);
  }
  return { entity, columns, indexes };
}

function materializeOrmCommonColumns(
  ctor: Function,
): EntityColumnMetadata[] {
  const { entity, columns, indexes } = collectOrmEntityChainData(ctor);
  if (columns.length === 0) {
    return [];
  }
  const camelCaseMapping = entity?.camelCaseMapping ?? true;

  const uniqueProps = new Set<string>();
  for (let i = 0; i < indexes.length; i++) {
    const idx = indexes[i]!;
    if (idx.unique && idx.columns.length === 1 && idx.columns[0]) {
      uniqueProps.add(idx.columns[0]);
    }
  }

  const out: EntityColumnMetadata[] = [];
  for (let i = 0; i < columns.length; i++) {
    const col = columns[i]!;
    if (col.excludeFromCommonSchema) continue;

    const resolvedName =
      col.explicitName ??
      (camelCaseMapping ? camelToSnake(col.propertyName) : col.propertyName);
    const commonGenStrategy: ColumnGenerationStrategy | undefined =
      col.generationStrategy === "uuid"
        ? "uuid"
        : col.generationStrategy === "objectid"
          ? undefined
          : col.generated
            ? "increment"
            : undefined;
    const mappedType = toCommonColumnType(col.type);
    const resolvedType: ColumnDataType =
      mappedType ??
      (commonGenStrategy === "uuid"
        ? "uuid"
        : inferCommonColumnTypeFromDesignType(col.designType, "text"));

    out.push({
      propertyName: col.propertyName,
      name: resolvedName,
      type: resolvedType,
      ...(col.designType !== undefined ? { designType: col.designType } : {}),
      nullable: col.nullable ?? false,
      unique:
        col.unique ||
        uniqueProps.has(col.propertyName) ||
        uniqueProps.has(resolvedName),
      hasDefault: col.hasDefault,
      ...(col.hasDefault ? { default: col.default } : {}),
      primary: col.primary,
      generated: col.generated,
      ...(commonGenStrategy !== undefined
        ? { generationStrategy: commonGenStrategy }
        : {}),
      ...(col.length !== undefined ? { length: col.length } : {}),
      ...(col.minLength !== undefined ? { minLength: col.minLength } : {}),
      ...(col.maxLength !== undefined ? { maxLength: col.maxLength } : {}),
      ...(col.min !== undefined ? { min: col.min } : {}),
      ...(col.max !== undefined ? { max: col.max } : {}),
      ...(col.pattern !== undefined ? { pattern: col.pattern } : {}),
      ...(col.enum !== undefined ? { enum: [...col.enum] } : {}),
      ...(col.description !== undefined ? { description: col.description } : {}),
      ...(col.example !== undefined ? { example: col.example } : {}),
      ...(col.transformer !== undefined ? { transformer: col.transformer } : {}),
      ...(col.select === false ? { select: false } : {}),
      createdAt: col.createdAt,
      updatedAt: col.updatedAt,
    });
  }
  return out;
}

function materializeOrmCommonIndexes(
  ctor: Function,
  columns?: readonly EntityColumnMetadata[],
): EntityIndexMetadata[] {
  const { entity, indexes } = collectOrmEntityChainData(ctor);
  if (indexes.length === 0) {
    return [];
  }
  const resolvedCols = columns ?? materializeOrmCommonColumns(ctor);
  const propToCol = new Map<string, string>();
  for (let i = 0; i < resolvedCols.length; i++) {
    const col = resolvedCols[i]!;
    propToCol.set(col.propertyName, col.name);
  }
  const camelCaseMapping = entity?.camelCaseMapping ?? true;

  return indexes.map((idx) => ({
    ...(idx.name !== undefined ? { name: idx.name } : {}),
    columns: idx.columns.map(
      (c) => propToCol.get(c) ?? (camelCaseMapping ? camelToSnake(c) : c),
    ),
    unique: idx.unique,
    ...(idx.where !== undefined ? { where: idx.where } : {}),
  }));
}

// Lazy ORM -> @bunest/core EntitySchema bridge (zero decoration-time double-writes).
registerEntitySchemaResolver({
  id: "bunest:orm",
  getVersion: () => OrmMetadataStorage.getVersion(),
  hasSchema(ctor: Function): boolean {
    const chain = getCachedInheritanceChain(ctor);
    for (let i = chain.length - 1; i >= 0; i--) {
      if (OrmMetadataStorage.getOwnBucket(chain[i]!)?.entity) {
        return true;
      }
    }
    return false;
  },
  getColumns(ctor: Function): EntityColumnMetadata[] {
    return materializeOrmCommonColumns(ctor);
  },
  getIndexes(ctor: Function): EntityIndexMetadata[] {
    return materializeOrmCommonIndexes(ctor);
  },
  getSchema(ctor: Function): EntitySchemaMetadata | undefined {
    const { entity } = collectOrmEntityChainData(ctor);
    if (!entity) {
      return undefined;
    }
    const tableName =
      entity.explicitTableName ??
      entity.explicitName ??
      inferTableName(ctor.name, entity.pluralizeTableName);
    const columns = materializeOrmCommonColumns(ctor);
    const primaryKeys = columns.filter((col) => col.primary);
    const indexes = materializeOrmCommonIndexes(ctor, columns);

    return {
      target: ctor as Type<any> | Abstract<any>,
      name: tableName,
      tableName,
      ...(entity.schema !== undefined ? { schema: entity.schema } : {}),
      ...(entity.description !== undefined
        ? { description: entity.description }
        : {}),
      camelCaseMapping: entity.camelCaseMapping,
      columns,
      primaryKeys,
      ...(primaryKeys[0] !== undefined ? { primaryKey: primaryKeys[0] } : {}),
      indexes,
    };
  },
});

function recordColumn(
  target: object,
  propertyKey: string | symbol,
  options: OrmColumnOptions,
  fallbackType?: OrmColumnType,
  mirrorToCommon = true,
  prepend = false,
): void {
  const ctor = resolveConstructor(target);
  if (!ctor) return;

  const propertyName = String(propertyKey);
  const designType = safeGetDesignType(target, propertyKey);

  const generatedFlag =
    options.generated === true ||
    options.generated === "increment" ||
    options.generated === "uuid" ||
    options.generated === "objectid";

  const generationStrategy: PrimaryGeneratedStrategy | undefined =
    options.generated === "objectid" ||
    (generatedFlag && options.type === "objectid")
      ? "objectid"
      : options.generated === "uuid" || (generatedFlag && options.type === "uuid")
        ? "uuid"
        : generatedFlag
          ? "increment"
          : undefined;

  const hasDefault = "default" in options && options.default !== undefined;

  const entry: StoredOrmColumnMetadata = {
    propertyName,
    ...(options.name !== undefined ? { explicitName: options.name } : {}),
    ...(options.type !== undefined
      ? { type: options.type }
      : fallbackType !== undefined
        ? { type: fallbackType }
        : {}),
    ...(designType !== undefined ? { designType } : {}),
    ...(options.length !== undefined ? { length: options.length } : {}),
    ...(options.minLength !== undefined ? { minLength: options.minLength } : {}),
    ...(options.maxLength !== undefined ? { maxLength: options.maxLength } : {}),
    ...(options.min !== undefined ? { min: options.min } : {}),
    ...(options.max !== undefined ? { max: options.max } : {}),
    ...(options.pattern !== undefined ? { pattern: options.pattern } : {}),
    ...(options.precision !== undefined ? { precision: options.precision } : {}),
    ...(options.scale !== undefined ? { scale: options.scale } : {}),
    ...(options.nullable !== undefined ? { nullable: options.nullable } : {}),
    unique: options.unique === true,
    hasDefault,
    ...(hasDefault ? { default: options.default } : {}),
    primary: options.primary === true,
    generated: generatedFlag,
    ...(generationStrategy !== undefined ? { generationStrategy } : {}),
    select: options.select ?? true,
    insert: options.insert ?? true,
    update: options.update ?? true,
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
    deletedAt: options.deletedAt === true,
    version: options.version === true,
    ...(options.comment !== undefined ? { comment: options.comment } : {}),
    ...(!mirrorToCommon ? { excludeFromCommonSchema: true } : {}),
  };

  OrmMetadataStorage.addColumn(ctor, entry, prepend);
}

function normalizeRelationArgs<T>(
  inverseSideOrOptions?: InverseSideSelector<T> | OrmRelationOptions,
  maybeOptions?: OrmRelationOptions,
): {
  inverseSide?: InverseSideSelector;
  options: OrmRelationOptions;
} {
  if (
    typeof inverseSideOrOptions === "function" ||
    typeof inverseSideOrOptions === "string"
  ) {
    return {
      inverseSide: inverseSideOrOptions as InverseSideSelector,
      options: maybeOptions ?? {},
    };
  }
  return {
    inverseSide: inverseSideOrOptions?.inverseSide,
    options: inverseSideOrOptions ?? maybeOptions ?? {},
  };
}

function createPropertyRelationDecorator<T>(
  kind: RelationKind,
  target: EntityTarget<T>,
  inverseSideOrOptions?: InverseSideSelector<T> | OrmRelationOptions,
  maybeOptions?: OrmRelationOptions,
): PropertyDecorator {
  const { inverseSide, options } = normalizeRelationArgs(
    inverseSideOrOptions,
    maybeOptions,
  );
  return (proto: object, propertyKey: string | symbol) => {
    const ctor = resolveConstructor(proto);
    if (!ctor) return;
    const propertyName = String(propertyKey);
    OrmMetadataStorage.addRelation(ctor, {
      propertyName,
      kind,
      target,
      ...(inverseSide !== undefined ? { inverseSide } : {}),
      options,
    });
    if (options.joinColumn) {
      OrmMetadataStorage.setJoinColumn(
        ctor,
        propertyName,
        options.joinColumn === true ? {} : options.joinColumn,
      );
    }
    if (options.joinTable) {
      OrmMetadataStorage.setJoinTable(
        ctor,
        propertyName,
        options.joinTable === true ? {} : options.joinTable,
      );
    }
  };
}

function createClassRelationDecorator<T>(
  kind: RelationKind,
  propertyName: string,
  target: EntityTarget<T>,
  options: OrmRelationOptions = {},
): ClassDecorator {
  return (ctor: Function) => {
    const cls = ctor as ObjectType;
    OrmMetadataStorage.addRelation(cls, {
      propertyName,
      kind,
      target,
      ...(options.inverseSide !== undefined
        ? { inverseSide: options.inverseSide }
        : {}),
      options,
    });
    if (options.joinColumn) {
      OrmMetadataStorage.setJoinColumn(
        cls,
        propertyName,
        options.joinColumn === true ? {} : options.joinColumn,
      );
    }
    if (options.joinTable) {
      OrmMetadataStorage.setJoinTable(
        cls,
        propertyName,
        options.joinTable === true ? {} : options.joinTable,
      );
    }
  };
}

// ============================================================================
// Entity & Embeddable Class Decorators
// ============================================================================

/**
 * Declares an ORM entity mapped to a SQL table.
 * Passive at decoration time — relation/embedded targets are resolved lazily in Phase 2.
 */
export function Entity(
  tableOrOptions?: string | OrmEntityOptions,
): ClassDecorator {
  const opts: OrmEntityOptions =
    typeof tableOrOptions === "string"
      ? { tableName: tableOrOptions }
      : (tableOrOptions ?? {});
  return (target: Function) => {
    const pluralize = opts.pluralizeTableName ?? true;
    const resolvedTableName =
      opts.tableName ?? opts.name ?? inferTableName(target.name, pluralize);
    OrmMetadataStorage.registerEntity(
      target as ObjectType,
      opts,
      resolvedTableName,
    );
  };
}

function normalizeBaseEntityColumnOption(
  raw: BaseEntityColumnOption | undefined,
  defaultProperty: string,
):
  | { readonly property: string; readonly columnOptions: OrmColumnOptions }
  | undefined {
  if (raw === false) return undefined;
  if (raw === undefined || raw === true) {
    return { property: defaultProperty, columnOptions: {} };
  }
  if (typeof raw === "string") {
    return { property: raw, columnOptions: {} };
  }
  const { property, ...colOpts } = raw;
  return { property: property ?? defaultProperty, columnOptions: colOpts };
}

/**
 * Class decorator that registers an ORM entity with standard base columns:
 * primary key (`id: Key`), `createdAt`, `updatedAt`, and `deletedAt`.
 *
 * Works standalone (`@BaseEntity<number>("users")`) or stacked with `@Entity("users")`
 * and Class Macros (`@Data()`, `@Builder()`, `@FieldNameConstants()`).
 * Paired with Bunest Typegen (and `vscode-bunest` live typegen), `id: Key`,
 * `createdAt: Date`, `updatedAt: Date`, and `deletedAt?: Date | null` are
 * automatically augmented onto the class type in `.bunest/types/bunest.d.ts`.
 */
export function BaseEntity<Key = number>(
  tableOrOptions?: string | BaseEntityOptions,
): ClassDecorator {
  const opts: BaseEntityOptions =
    typeof tableOrOptions === "string"
      ? { tableName: tableOrOptions }
      : (tableOrOptions ?? {});

  const entityOpts: OrmEntityOptions = {
    ...(opts.name !== undefined ? { name: opts.name } : {}),
    ...(opts.tableName !== undefined ? { tableName: opts.tableName } : {}),
    ...(opts.schema !== undefined ? { schema: opts.schema } : {}),
    ...(opts.description !== undefined ? { description: opts.description } : {}),
    ...(opts.camelCaseMapping !== undefined
      ? { camelCaseMapping: opts.camelCaseMapping }
      : {}),
    ...(opts.pluralizeTableName !== undefined
      ? { pluralizeTableName: opts.pluralizeTableName }
      : {}),
    ...(opts.comment !== undefined ? { comment: opts.comment } : {}),
  };

  const hasExplicitEntityOpts =
    opts.tableName !== undefined ||
    opts.name !== undefined ||
    opts.schema !== undefined ||
    opts.description !== undefined ||
    opts.camelCaseMapping !== undefined ||
    opts.pluralizeTableName !== undefined ||
    opts.comment !== undefined;

  return (target: Function) => {
    const cls = target as ObjectType;
    const ownBucket = OrmMetadataStorage.getOwnBucket(cls);

    if (hasExplicitEntityOpts || !ownBucket?.entity) {
      Entity(entityOpts)(target);
    }

    const existingProps = new Set(
      (OrmMetadataStorage.getOwnBucket(cls)?.columns ?? []).map(
        (c) => c.propertyName,
      ),
    );
    const registeredFields: string[] = [];

    // 1. Primary Key (`id: Key`) — prepended so `id` is the first column in DDL
    const idProp = opts.idProperty ?? "id";
    if (!existingProps.has(idProp)) {
      const idColOpts: OrmColumnOptions =
        typeof opts.idColumn === "string"
          ? { name: opts.idColumn }
          : (opts.idColumn ?? {});

      if (opts.idStrategy === false) {
        recordColumn(
          target.prototype,
          idProp,
          { ...idColOpts, primary: true, nullable: idColOpts.nullable ?? false },
          idColOpts.type ?? "integer",
          true,
          true,
        );
      } else if (
        opts.idStrategy === "objectid" ||
        (opts.idStrategy === undefined && idColOpts.type === "objectid")
      ) {
        recordColumn(
          target.prototype,
          idProp,
          {
            ...idColOpts,
            name: idColOpts.name ?? "_id",
            primary: true,
            generated: "objectid",
            type: "objectid",
            nullable: false,
          },
          "objectid",
          true,
          true,
        );
      } else if (
        opts.idStrategy === "uuid" ||
        (opts.idStrategy === undefined && idColOpts.type === "uuid")
      ) {
        recordColumn(
          target.prototype,
          idProp,
          {
            ...idColOpts,
            primary: true,
            generated: "uuid",
            type: idColOpts.type ?? "uuid",
            nullable: false,
          },
          "uuid",
          true,
          true,
        );
      } else {
        recordColumn(
          target.prototype,
          idProp,
          {
            ...idColOpts,
            primary: true,
            generated: opts.idStrategy ?? "increment",
            type: idColOpts.type ?? "integer",
            nullable: false,
          },
          "integer",
          true,
          true,
        );
      }
      registeredFields.push(idProp);
    }

    // 2. Creation timestamp (`createdAt`)
    const createdCfg = normalizeBaseEntityColumnOption(
      opts.createdAt,
      "createdAt",
    );
    if (createdCfg && !existingProps.has(createdCfg.property)) {
      CreateDateColumn(createdCfg.columnOptions)(
        target.prototype,
        createdCfg.property,
      );
      registeredFields.push(createdCfg.property);
    }

    // 3. Modification timestamp (`updatedAt`)
    const updatedCfg = normalizeBaseEntityColumnOption(
      opts.updatedAt,
      "updatedAt",
    );
    if (updatedCfg && !existingProps.has(updatedCfg.property)) {
      UpdateDateColumn(updatedCfg.columnOptions)(
        target.prototype,
        updatedCfg.property,
      );
      registeredFields.push(updatedCfg.property);
    }

    // 4. Soft-delete timestamp (`deletedAt`)
    const deletedCfg = normalizeBaseEntityColumnOption(
      opts.deletedAt,
      "deletedAt",
    );
    if (deletedCfg && !existingProps.has(deletedCfg.property)) {
      DeleteDateColumn(deletedCfg.columnOptions)(
        target.prototype,
        deletedCfg.property,
      );
      registeredFields.push(deletedCfg.property);
    }
  };
}

/**
 * Marks a class as an embeddable / nested value object class (optional: any class
 * with `@Column()` or `@Embedded()` properties can also be embedded directly).
 */
export function Embeddable(alias?: string): ClassDecorator {
  return (target: Function) => {
    OrmMetadataStorage.registerEmbeddable(target as ObjectType, alias);
  };
}

// ============================================================================
// Column Decorators
// ============================================================================

/**
 * Declares a regular SQL column.
 */
export function Column(
  typeOrOptions?: OrmColumnType | OrmColumnOptions,
  extraOptions?: OrmColumnOptions,
): PropertyDecorator {
  const opts: OrmColumnOptions =
    typeof typeOrOptions === "string"
      ? { ...extraOptions, type: typeOrOptions }
      : (typeOrOptions ?? {});
  return (target: object, propertyKey: string | symbol) => {
    recordColumn(target, propertyKey, opts);
  };
}

/**
 * Declares an explicit (non-generated) primary key column.
 */
export function PrimaryColumn(
  typeOrOptions?: OrmColumnType | OrmColumnOptions,
  extraOptions?: OrmColumnOptions,
): PropertyDecorator {
  const base: OrmColumnOptions =
    typeof typeOrOptions === "string"
      ? { ...extraOptions, type: typeOrOptions }
      : (typeOrOptions ?? {});
  return (target: object, propertyKey: string | symbol) => {
    recordColumn(
      target,
      propertyKey,
      { ...base, primary: true, nullable: base.nullable ?? false },
      "integer",
    );
  };
}

/**
 * Declares an auto-generated primary key column (`"increment"` or `"uuid"`).
 */
export function PrimaryGeneratedColumn(
  strategyOrOptions?: PrimaryGeneratedStrategy | OrmColumnOptions,
  extraOptions?: OrmColumnOptions,
): PropertyDecorator {
  let opts: OrmColumnOptions;
  if (typeof strategyOrOptions === "string") {
    opts = {
      ...extraOptions,
      primary: true,
      generated: strategyOrOptions,
      type:
        extraOptions?.type ??
        (strategyOrOptions === "uuid" ? "uuid" : "integer"),
      nullable: false,
    };
  } else {
    const raw = strategyOrOptions ?? {};
    const generated = raw.generated ?? "increment";
    const isUuid = generated === "uuid" || raw.type === "uuid";
    opts = {
      ...raw,
      primary: true,
      generated,
      ...(isUuid && raw.type === undefined ? { type: "uuid" } : {}),
      nullable: false,
    };
  }
  return (target: object, propertyKey: string | symbol) => {
    recordColumn(target, propertyKey, opts, "integer");
  };
}

/**
 * Marks a property as an auto-generated MongoDB 24-hex ObjectId primary key column
 * (TypeORM `@ObjectIdColumn()` parity). Works seamlessly on both MongoDB and SQL!
 */
export function ObjectIdColumn(
  options: OrmColumnOptions = {},
): PropertyDecorator {
  return (target: object, propertyKey: string | symbol) => {
    recordColumn(
      target,
      propertyKey,
      {
        ...options,
        name: options.name ?? "_id",
        primary: true,
        generated: "objectid",
        type: "objectid",
        nullable: false,
      },
      "objectid",
      true,
    );
  };
}

/**
 * Automatically populates creation timestamp on insert.
 */
export function CreateDateColumn(
  options: OrmColumnOptions = {},
): PropertyDecorator {
  return (target: object, propertyKey: string | symbol) => {
    recordColumn(
      target,
      propertyKey,
      { ...options, type: options.type ?? "datetime", createdAt: true },
      "datetime",
    );
  };
}

/**
 * Automatically updates modification timestamp on insert and update.
 */
export function UpdateDateColumn(
  options: OrmColumnOptions = {},
): PropertyDecorator {
  return (target: object, propertyKey: string | symbol) => {
    recordColumn(
      target,
      propertyKey,
      { ...options, type: options.type ?? "datetime", updatedAt: true },
      "datetime",
    );
  };
}

/**
 * Enables soft-delete support (`softDelete`, `softRemove`, `restore`, `withDeleted`).
 */
export function DeleteDateColumn(
  options: OrmColumnOptions = {},
): PropertyDecorator {
  return (target: object, propertyKey: string | symbol) => {
    recordColumn(
      target,
      propertyKey,
      {
        ...options,
        type: options.type ?? "datetime",
        nullable: options.nullable ?? true,
        deletedAt: true,
      },
      "datetime",
      false,
    );
  };
}

/**
 * Enables optimistic locking by incrementing a numeric version column on every update.
 */
export function VersionColumn(
  options: OrmColumnOptions = {},
): PropertyDecorator {
  return (target: object, propertyKey: string | symbol) => {
    recordColumn(
      target,
      propertyKey,
      {
        ...options,
        type: options.type ?? "integer",
        default: options.default ?? 1,
        version: true,
      },
      "integer",
      false,
    );
  };
}

// ============================================================================
// Index & Unique Decorators
// ============================================================================

export function Index(
  columnsOrOptions?: string | readonly string[] | OrmIndexOptions,
  extraOptions?: Omit<OrmIndexOptions, "columns">,
): ClassDecorator & PropertyDecorator {
  const decorator = (target: object, propertyKey?: string | symbol): unknown => {
    const ctor = resolveConstructor(target);
    if (!ctor) return;

    if (propertyKey !== undefined) {
      const propName = String(propertyKey);
      let opts: OrmIndexOptions;
      if (typeof columnsOrOptions === "string") {
        opts = { name: columnsOrOptions, ...extraOptions };
      } else if (Array.isArray(columnsOrOptions)) {
        opts = { ...extraOptions };
      } else {
        opts = {
          ...(columnsOrOptions as OrmIndexOptions | undefined),
          ...extraOptions,
        };
      }
      OrmMetadataStorage.addIndex(ctor, {
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

    let columns: string[] = [];
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
      const idx = columnsOrOptions as OrmIndexOptions;
      columns = idx.columns ? [...idx.columns] : [];
      name = idx.name ?? extraOptions?.name;
      unique = (idx.unique ?? extraOptions?.unique) === true;
      where = idx.where ?? extraOptions?.where;
    }

    if (columns.length === 0) {
      throw new Error(
        `@Index() on class "${ctor.name || "Anonymous"}" requires at least one column.`,
      );
    }

    OrmMetadataStorage.addIndex(ctor, {
      ...(name !== undefined ? { name } : {}),
      columns,
      unique,
      ...(where !== undefined ? { where } : {}),
    });
    return target;
  };
  return decorator as ClassDecorator & PropertyDecorator;
}

export function Unique(
  columnsOrOptions?: string | readonly string[] | OrmUniqueOptions,
  extraOptions?: Omit<OrmUniqueOptions, "columns">,
): ClassDecorator & PropertyDecorator {
  if (typeof columnsOrOptions === "string") {
    return Index(columnsOrOptions, { ...extraOptions, unique: true });
  }
  if (Array.isArray(columnsOrOptions)) {
    return Index(columnsOrOptions, { ...extraOptions, unique: true });
  }
  return Index({
    ...(columnsOrOptions as OrmUniqueOptions | undefined),
    ...extraOptions,
    unique: true,
  });
}

// ============================================================================
// Nested / Embedded Class Decorators (Property-Level & Zero-TDZ Class-Level)
// ============================================================================

/**
 * Embeds a nested class (or array of nested classes) inside an entity or another
 * embedded class. Supports arbitrary nesting depth (`Company -> Address -> GeoPoint`),
 * arrays of nested classes (`array: true`), and self-recursive nested classes (`mode: "auto"` / `"json"`).
 *
 * Tip: Use `Nested<Target>` on the property type (or class-level `@Embeds()`) to prevent
 * `emitDecoratorMetadata` TDZ errors when the nested class is declared below or circularly imported.
 */
export function Embedded<T = unknown>(
  target: EntityTarget<T>,
  options: OrmEmbeddedOptions = {},
): PropertyDecorator {
  return (proto: object, propertyKey: string | symbol) => {
    const ctor = resolveConstructor(proto);
    if (!ctor) return;
    OrmMetadataStorage.addEmbedded(ctor, {
      propertyName: String(propertyKey),
      target,
      options,
    });
  };
}

// ============================================================================
// Relation Decorators (TypeORM-Style Property-Level)
// ============================================================================

export function OneToOne<T = unknown>(
  target: EntityTarget<T>,
  inverseSideOrOptions?: InverseSideSelector<T> | OrmRelationOptions,
  options?: OrmRelationOptions,
): PropertyDecorator {
  return createPropertyRelationDecorator(
    "one-to-one",
    target,
    inverseSideOrOptions,
    options,
  );
}

export function ManyToOne<T = unknown>(
  target: EntityTarget<T>,
  inverseSideOrOptions?: InverseSideSelector<T> | OrmRelationOptions,
  options?: OrmRelationOptions,
): PropertyDecorator {
  return createPropertyRelationDecorator(
    "many-to-one",
    target,
    inverseSideOrOptions,
    options,
  );
}

export function OneToMany<T = unknown>(
  target: EntityTarget<T>,
  inverseSide: InverseSideSelector<T>,
  options?: OrmRelationOptions,
): PropertyDecorator {
  return createPropertyRelationDecorator(
    "one-to-many",
    target,
    inverseSide,
    options,
  );
}

export function ManyToMany<T = unknown>(
  target: EntityTarget<T>,
  inverseSideOrOptions?: InverseSideSelector<T> | OrmRelationOptions,
  options?: OrmRelationOptions,
): PropertyDecorator {
  return createPropertyRelationDecorator(
    "many-to-many",
    target,
    inverseSideOrOptions,
    options,
  );
}

export function JoinColumn(
  options: OrmJoinColumnOptions = {},
): PropertyDecorator {
  return (proto: object, propertyKey: string | symbol) => {
    const ctor = resolveConstructor(proto);
    if (!ctor) return;
    OrmMetadataStorage.setJoinColumn(ctor, String(propertyKey), options);
  };
}

export function JoinTable(
  options: OrmJoinTableOptions = {},
): PropertyDecorator {
  return (proto: object, propertyKey: string | symbol) => {
    const ctor = resolveConstructor(proto);
    if (!ctor) return;
    OrmMetadataStorage.setJoinTable(ctor, String(propertyKey), options);
  };
}

/**
 * Declares a polymorphic owning relation (`comment.commentable -> Post | Video`)
 * backed by a type discriminator column (`<name>_type`) and ID column (`<name>_id`).
 *
 * Accepts either a map of `{ typeKey: () => TargetEntity }` or an array `[() => Post, () => Video]`.
 */
export function MorphTo(
  targets: OrmMorphTargets,
  options: OrmMorphToOptions = {},
): PropertyDecorator {
  return (proto: object, propertyKey: string | symbol) => {
    const ctor = resolveConstructor(proto);
    if (!ctor) return;
    OrmMetadataStorage.addRelation(ctor, {
      propertyName: String(propertyKey),
      kind: "morph-to",
      morphTargets: targets,
      morphToOptions: options,
      options: {
        nullable: options.nullable ?? true,
        eager: options.eager === true,
        persistence: options.persistence ?? true,
        createForeignKeyConstraints: false,
      },
    });
  };
}

/**
 * Declares the inverse polymorphic one-to-many relation (`post.comments -> Comment[]`)
 * targeting the child entity's `@MorphTo()` property named `morphName`.
 */
export function MorphMany<T = unknown>(
  target: EntityTarget<T>,
  morphName: string,
  options: OrmMorphManyOptions = {},
): PropertyDecorator {
  return (proto: object, propertyKey: string | symbol) => {
    const ctor = resolveConstructor(proto);
    if (!ctor) return;
    OrmMetadataStorage.addRelation(ctor, {
      propertyName: String(propertyKey),
      kind: "morph-many",
      target,
      morphName,
      morphManyOptions: options,
      options: {
        ...(options.cascade !== undefined ? { cascade: options.cascade } : {}),
        eager: options.eager === true,
        persistence: options.persistence ?? true,
        createForeignKeyConstraints: false,
      },
    });
  };
}

// ============================================================================
// Lifecycle Hook Decorators
// ============================================================================

function createLifecycleDecorator(kind: LifecycleEventKind): MethodDecorator {
  return (target: object, propertyKey: string | symbol) => {
    const ctor = resolveConstructor(target);
    if (!ctor) return;
    OrmMetadataStorage.addListener(ctor, {
      kind,
      methodName: String(propertyKey),
    });
  };
}

export function BeforeInsert(): MethodDecorator {
  return createLifecycleDecorator("before-insert");
}

export function AfterInsert(): MethodDecorator {
  return createLifecycleDecorator("after-insert");
}

export function BeforeUpdate(): MethodDecorator {
  return createLifecycleDecorator("before-update");
}

export function AfterUpdate(): MethodDecorator {
  return createLifecycleDecorator("after-update");
}

export function BeforeRemove(): MethodDecorator {
  return createLifecycleDecorator("before-remove");
}

export function AfterRemove(): MethodDecorator {
  return createLifecycleDecorator("after-remove");
}

export function AfterLoad(): MethodDecorator {
  return createLifecycleDecorator("after-load");
}
