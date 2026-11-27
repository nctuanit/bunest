import { inferTableName } from "./identifiers";
import { OrmMetadataStorage } from "./metadata-storage";
import type {
  EntityTarget,
  InverseSideSelector,
  LifecycleEventKind,
  ObjectType,
  OrmColumnOptions,
  OrmEmbeddedOptions,
  OrmEntityOptions,
  OrmIndexOptions,
  OrmJoinColumnOptions,
  OrmJoinTableOptions,
  OrmMorphManyOptions,
  OrmMorphTargets,
  OrmMorphToOptions,
  OrmRelationOptions,
  RelationKind,
} from "./types";

export interface DefineRelationConfig<TTarget = unknown>
  extends Omit<OrmRelationOptions, "inverseSide"> {
  readonly kind: RelationKind;
  readonly target?: EntityTarget<TTarget>;
  readonly inverseSide?: InverseSideSelector<TTarget>;
  readonly joinColumn?: boolean | OrmJoinColumnOptions;
  readonly joinTable?: boolean | OrmJoinTableOptions;
  readonly morphTargets?: OrmMorphTargets;
  readonly morphName?: string;
  readonly morphToOptions?: OrmMorphToOptions;
  readonly morphManyOptions?: OrmMorphManyOptions;
}

export interface DefineEmbeddedConfig<TTarget = unknown>
  extends OrmEmbeddedOptions {
  readonly target: EntityTarget<TTarget>;
}

export interface DefineEntitySchemaConfig<TEntity = Record<string, unknown>>
  extends OrmEntityOptions {
  readonly columns?: Partial<Record<keyof TEntity & string, OrmColumnOptions>> &
    Record<string, OrmColumnOptions>;
  readonly relations?: Partial<
    Record<keyof TEntity & string, DefineRelationConfig>
  > &
    Record<string, DefineRelationConfig>;
  readonly embedded?: Partial<
    Record<keyof TEntity & string, DefineEmbeddedConfig>
  > &
    Record<string, DefineEmbeddedConfig>;
  readonly indexes?: readonly OrmIndexOptions[];
  readonly listeners?: Partial<Record<LifecycleEventKind, string>>;
}

/**
 * Programmatically defines entity metadata on a plain class WITHOUT requiring
 * property decorators — completely immune to `emitDecoratorMetadata` TDZ errors
 * even with arbitrarily nested or mutually-referencing classes!
 *
 * Works both for entities and embeddable classes (pass `embeddable: true` or use `defineEmbeddable`).
 */
export function defineEntity<TEntity>(
  target: ObjectType<TEntity>,
  config: DefineEntitySchemaConfig<TEntity>,
): ObjectType<TEntity> {
  const pluralize = config.pluralizeTableName ?? true;
  const resolvedTableName =
    config.tableName ?? config.name ?? inferTableName(target.name, pluralize);

  OrmMetadataStorage.registerEntity(target, config, resolvedTableName);
  applySchemaMembers(target, config);
  return target;
}

/**
 * Programmatically defines an embeddable / nested class schema without decorators.
 */
export function defineEmbeddable<TModel>(
  target: ObjectType<TModel>,
  config: Pick<
    DefineEntitySchemaConfig<TModel>,
    "name" | "columns" | "embedded"
  >,
): ObjectType<TModel> {
  OrmMetadataStorage.registerEmbeddable(target, config.name);
  applySchemaMembers(target, config);
  return target;
}

function applySchemaMembers<TEntity>(
  target: ObjectType<TEntity>,
  config: Pick<
    DefineEntitySchemaConfig<TEntity>,
    "columns" | "relations" | "embedded" | "indexes" | "listeners"
  >,
): void {
  if (config.columns) {
    for (const [propertyName, col] of Object.entries(config.columns)) {
      if (!col) continue;
      const generatedFlag =
        col.generated === true ||
        col.generated === "increment" ||
        col.generated === "uuid" ||
        col.generated === "objectid";
      const generationStrategy =
        col.generated === "objectid" || (generatedFlag && col.type === "objectid")
          ? ("objectid" as const)
          : col.generated === "uuid" || (generatedFlag && col.type === "uuid")
            ? ("uuid" as const)
            : generatedFlag
              ? ("increment" as const)
              : undefined;
      const hasDefault = "default" in col && col.default !== undefined;

      OrmMetadataStorage.addColumn(target, {
        propertyName,
        ...(col.name !== undefined ? { explicitName: col.name } : {}),
        ...(col.type !== undefined ? { type: col.type } : {}),
        ...(col.length !== undefined ? { length: col.length } : {}),
        ...(col.precision !== undefined ? { precision: col.precision } : {}),
        ...(col.scale !== undefined ? { scale: col.scale } : {}),
        ...(col.nullable !== undefined ? { nullable: col.nullable } : {}),
        unique: col.unique === true,
        hasDefault,
        ...(hasDefault ? { default: col.default } : {}),
        primary: col.primary === true,
        generated: generatedFlag,
        ...(generationStrategy !== undefined ? { generationStrategy } : {}),
        select: col.select ?? true,
        insert: col.insert ?? true,
        update: col.update ?? true,
        ...(col.enum !== undefined ? { enum: [...col.enum] } : {}),
        ...(col.transformer !== undefined ? { transformer: col.transformer } : {}),
        createdAt: col.createdAt === true,
        updatedAt: col.updatedAt === true,
        deletedAt: col.deletedAt === true,
        version: col.version === true,
        ...(col.comment !== undefined ? { comment: col.comment } : {}),
      });
    }
  }

  if (config.relations) {
    for (const [propertyName, rel] of Object.entries(config.relations)) {
      if (!rel) continue;
      OrmMetadataStorage.addRelation(target, {
        propertyName,
        kind: rel.kind,
        ...(rel.target !== undefined ? { target: rel.target } : {}),
        ...(rel.inverseSide !== undefined
          ? { inverseSide: rel.inverseSide as InverseSideSelector }
          : {}),
        ...(rel.morphTargets !== undefined
          ? { morphTargets: rel.morphTargets }
          : {}),
        ...(rel.morphName !== undefined ? { morphName: rel.morphName } : {}),
        ...(rel.morphToOptions !== undefined
          ? { morphToOptions: rel.morphToOptions }
          : {}),
        ...(rel.morphManyOptions !== undefined
          ? { morphManyOptions: rel.morphManyOptions }
          : {}),
        options: rel,
      });
      if (rel.joinColumn) {
        OrmMetadataStorage.setJoinColumn(
          target,
          propertyName,
          rel.joinColumn === true ? {} : rel.joinColumn,
        );
      }
      if (rel.joinTable) {
        OrmMetadataStorage.setJoinTable(
          target,
          propertyName,
          rel.joinTable === true ? {} : rel.joinTable,
        );
      }
    }
  }

  if (config.embedded) {
    for (const [propertyName, emb] of Object.entries(config.embedded)) {
      if (!emb) continue;
      OrmMetadataStorage.addEmbedded(target, {
        propertyName,
        target: emb.target,
        options: emb,
      });
    }
  }

  if (config.indexes) {
    for (const idx of config.indexes) {
      if (!idx.columns || idx.columns.length === 0) continue;
      OrmMetadataStorage.addIndex(target, {
        ...(idx.name !== undefined ? { name: idx.name } : {}),
        columns: [...idx.columns],
        unique: idx.unique === true,
        ...(idx.where !== undefined ? { where: idx.where } : {}),
      });
    }
  }

  if (config.listeners) {
    for (const [kind, methodName] of Object.entries(config.listeners)) {
      if (!methodName) continue;
      OrmMetadataStorage.addListener(target, {
        kind: kind as LifecycleEventKind,
        methodName,
      });
    }
  }
}
