import { isPlainObject, uncapitalize } from "@bunest/core/common";
import {
  DecoratorRegistry,
  MetadataRegistry,
  getEntityColumns,
  getEntitySchema,
  type Abstract,
  type Type,
} from "@bunest/core";
import { getDialectProfile } from "./dialect/dialect-profile";
import { generateObjectId } from "./driver/bson";
import { EntityNotFoundError } from "./errors";
import { fromDbValue, hydrateEntityRow, toDbValue } from "./hydrator";
import {
  assertSafeSqlIdentifier,
  camelToSnake,
  escapeLikePattern,
  formatPlaceholder,
  formatTableRef,
  inferTableName,
  quoteIdentifier,
} from "./identifiers";
import type {
  CompiledColumnMetadata,
  CompiledEntityMetadata,
  CompiledMetadataGraph,
} from "./metadata-graph";
import {
  OrmMetadataStorage,
  getInheritanceChain,
  type StoredOrmColumnMetadata,
} from "./metadata-storage";
import {
  createSoftDeleteMethods,
  extractCursorValue,
  getAmbientIgnoredScopes,
  getCustomQueryOperatorRegistryVersion,
  getRepositoryFragments,
  getRepositoryScopes,
  getSoftDeleteConfig,
  hasTopLevelSqlOr,
  isCursorPageable,
  isPageable,
  isScopeIgnored,
  listRegisteredQueryOperators,
  rewriteQuestionPlaceholders,
  runWithIgnoredScopes,
  type CursorPage,
  type CursorPageable,
  type CustomQueryOperator,
  type IgnoreScopeSpec,
  type Page,
  type Pageable,
  type RepositoryFragmentRuntimeContext,
  type RepositoryScopeContext,
  type RepositoryScopeDefinition,
  type RepositoryScopeOperation,
  type RepositoryScopeWhereResult,
} from "./repository-extensions";
import type {
  CircularJsonStrategy,
  ObjectType,
  OrmColumnTransformer,
  OrmColumnType,
  OrmDialect,
  OrmDriverLike,
  OrmQueryResult,
  PrimaryGeneratedStrategy,
} from "./types";

// ============================================================================
// Metadata Keys
// ============================================================================

export const ORM_REPOSITORY_METADATA = Symbol.for(
  "bunest:orm:declarative_repository",
);
export const ORM_QUERY_METADATA = Symbol.for("bunest:orm:declarative_query");
export const ORM_MODIFYING_METADATA = Symbol.for(
  "bunest:orm:declarative_modifying",
);
export const ORM_PARAM_METADATA = Symbol.for("bunest:orm:declarative_param");

// ============================================================================
// Interfaces & Types
// ============================================================================

/**
 * Parameter binding input for `this.query(sql, params)`, `this.queryOne(sql, params)`,
 * and `this.execute(sql, params)` on `CrudRepository`.
 *
 * - Pass a plain object for named `:param` placeholders (e.g. `{ id: 10 }`).
 * - Pass an array for positional `$1` / `?` placeholders (e.g. `[10]`).
 */
export type OrmSqlParams =
  | readonly unknown[]
  | Readonly<Record<string, unknown>>;

/**
 * Structural host accepted by compiled declarative repositories (implemented by `DataSource`).
 */
export interface OrmDeclarativeHost {
  readonly driver: OrmDriverLike;
  readonly dialect: OrmDialect;
  readonly metadataGraph?: CompiledMetadataGraph;
  readonly options?: {
    readonly safeJsonSerialization?: boolean;
    readonly circularJsonStrategy?: CircularJsonStrategy;
  };
}

export type OrmQueryReturnMode =
  | "auto"
  | "many"
  | "one"
  | "scalar"
  | "count"
  | "exists"
  | "changes"
  | "runResult"
  | "void";

export interface OrmQueryOptions {
  /**
   * Explicitly controls how the query result is shaped.
   * Defaults to `"auto"` (inferred from `@Modifying()` and method naming convention).
   */
  readonly mode?: OrmQueryReturnMode;

  /**
   * Shorthand for `mode: "one"` (`true`) vs `mode: "many"` (`false`).
   */
  readonly single?: boolean;

  /**
   * Whether to run the repository row hydrator over returned rows.
   * Defaults to `true` for `"one"` / `"many"` modes.
   */
  readonly mapRows?: boolean;
}

export interface OrmQueryMetadata {
  readonly sql: string;
  readonly options?: OrmQueryOptions;
}

export interface OrmModifyingOptions {
  /**
   * Return shape for a `@Modifying()` query:
   * - `"changes"` (default): affected row count (`number`)
   * - `"void"`: `undefined`
   * - `"runResult"`: normalized `OrmQueryResult` (with `.affectedRows` and `.changes` alias)
   * @default "changes"
   */
  readonly returnType?: "changes" | "void" | "runResult";
}

export type OrmParamMetadataMap = Record<number, string>;

export interface OrmRepositoryOptions<TEntity = any> {
  /**
   * Target entity class decorated with `@Entity()`.
   */
  readonly entity?: Type<TEntity> | Abstract<TEntity>;

  /**
   * Explicit SQL table name (overrides entity table name).
   */
  readonly table?: string;

  /**
   * Optional SQL schema name.
   */
  readonly schema?: string;

  /**
   * Primary key SQL column name. Defaults to the entity's primary column or `"id"`.
   */
  readonly idColumn?: string;

  /**
   * Entity property name corresponding to `idColumn`.
   */
  readonly idProperty?: string;

  /**
   * Explicit entity property -> SQL column name mapping.
   */
  readonly columns?: Readonly<Record<string, string>>;

  /**
   * Optional default DataSource name when not overridden in `OrmModule.forFeature(targets, dataSourceName)`.
   */
  readonly dataSource?: string;

  /**
   * Alias for `dataSource`.
   */
  readonly connectionName?: string;

  /**
   * Optional explicit SQL dialect override (auto-detected from `DataSource.driver.dialect` by default).
   */
  readonly dialect?: OrmDialect;

  /**
   * Automatically map `camelCase` property names <-> `snake_case` SQL columns.
   * @default true
   */
  readonly camelCaseMapping?: boolean;

  /**
   * Pluralize inferred table names from entity class names when neither `table` nor `@Entity` is provided.
   * @default true
   */
  readonly pluralizeTableName?: boolean;

  /**
   * Optional custom row hydrator transforming a raw database row into `TEntity`.
   */
  readonly mapRow?: (row: Record<string, unknown>) => TEntity;
}

export interface OrmRepositoryMetadata<TEntity = any> {
  readonly entity?: Type<TEntity> | Abstract<TEntity>;
  readonly table: string;
  readonly schema?: string;
  readonly idColumn: string;
  readonly idProperty: string;
  readonly columns: Readonly<Record<string, string>>;
  readonly dataSource?: string;
  readonly dialect?: OrmDialect;
  readonly camelCaseMapping: boolean;
  readonly mapRow?: (row: Record<string, unknown>) => TEntity;
}

export interface CompiledOrmRepositoryFactory<TRepo extends object = object> {
  readonly metadata: OrmRepositoryMetadata;
  createInstance(host: OrmDeclarativeHost): TRepo;
}

// ============================================================================
// Abstract Base CRUD Repository
// ============================================================================

/**
 * Spring Data-style abstract base CRUD repository for `@bunest/orm`.
 *
 * Subclass this as an `abstract class`, decorate with `@Repository(Entity)`,
 * declare derived finder methods or `@Query(...)` / `@Modifying()` methods, and register via
 * `OrmModule.forFeature([MyRepository])` or `autoRegisterRepositories: true`.
 */
export abstract class CrudRepository<
  TEntity extends object,
  TKey = number,
> {
  abstract findById(id: TKey): Promise<TEntity | null>;
  abstract findByIdOrFail(id: TKey): Promise<TEntity>;
  abstract findAll(): Promise<TEntity[]>;
  abstract save(entity: Partial<TEntity>): Promise<TEntity>;
  abstract saveMany(entities: readonly Partial<TEntity>[]): Promise<TEntity[]>;
  abstract deleteById(id: TKey): Promise<void>;
  abstract count(): Promise<number>;
  abstract existsById(id: TKey): Promise<boolean>;

  /**
   * Executes a parameterized multi-dialect SQL query and returns all rows.
   * Supports named `:param` placeholders with an object (`{ id: 10 }`)
   * as well as positional (`$1`, `?`) placeholders with an array (`[10]`).
   */
  protected abstract query<TRow = Record<string, unknown>>(
    sql: string,
    params?: OrmSqlParams,
  ): Promise<TRow[]>;

  /**
   * Executes a parameterized multi-dialect SQL query and returns the first row or `null`.
   */
  protected abstract queryOne<TRow = Record<string, unknown>>(
    sql: string,
    params?: OrmSqlParams,
  ): Promise<TRow | null>;

  /**
   * Executes a parameterized write/DDL SQL statement (`INSERT`, `UPDATE`, `DELETE`)
   * and returns `{ affectedRows, lastInsertId, rows }`.
   */
  protected abstract execute(
    sql: string,
    params?: OrmSqlParams,
  ): Promise<OrmQueryResult>;
}

// ============================================================================
// Naming & Column Metadata Extraction Helpers
// ============================================================================

function snakeToCamel(input: string): string {
  return input.replace(/_([a-z0-9])/g, (_, ch: string) => ch.toUpperCase());
}

function booleanLiteral(dialect: OrmDialect, value: boolean): string {
  if (
    dialect === "sqlite" ||
    dialect === "libsql" ||
    dialect === "d1" ||
    dialect === "mssql" ||
    dialect === "oracle"
  ) {
    return value ? "1" : "0";
  }
  return value ? "TRUE" : "FALSE";
}

interface DeclarativeColumnDescriptor {
  readonly propertyName: string;
  readonly columnName: string;
  readonly type: OrmColumnType;
  readonly designType?: Function;
  readonly primary: boolean;
  readonly generated: boolean;
  readonly generationStrategy?: PrimaryGeneratedStrategy;
  readonly hasDefault: boolean;
  readonly default?: unknown;
  readonly transformer?: OrmColumnTransformer;
  readonly createdAt: boolean;
  readonly updatedAt: boolean;
}

function inferColumnType(designType: unknown): OrmColumnType {
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
  return "text";
}

function collectEntityMetaFromRegistries(entity: Function): {
  explicitTableName?: string;
  schema?: string;
  camelCaseMapping?: boolean;
  pluralizeTableName?: boolean;
  columns: DeclarativeColumnDescriptor[];
} {
  let explicitTableName: string | undefined;
  let schema: string | undefined;
  let camelCaseMapping: boolean | undefined;
  let pluralizeTableName: boolean | undefined;

  const colOrder: string[] = [];
  const colMap = new Map<string, StoredOrmColumnMetadata>();

  // 1. Read unified @bunest/common metadata first
  const commonSchema = getEntitySchema(entity);
  if (commonSchema) {
    explicitTableName = commonSchema.tableName;
    schema = commonSchema.schema;
    camelCaseMapping = commonSchema.camelCaseMapping;
  }
  const commonCols = getEntityColumns(entity);
  for (let i = 0; i < commonCols.length; i++) {
    const c = commonCols[i]!;
    colOrder.push(c.propertyName);
    colMap.set(c.propertyName, {
      propertyName: c.propertyName,
      explicitName: c.name,
      type: c.type,
      ...(c.designType !== undefined ? { designType: c.designType } : {}),
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

  // 2. Overlay @bunest/orm OrmMetadataStorage across inheritance chain (base -> derived)
  const chain = getInheritanceChain(entity);
  for (let i = 0; i < chain.length; i++) {
    const bucket = OrmMetadataStorage.getOwnBucket(chain[i]!);
    if (!bucket) continue;
    if (bucket.entity) {
      if (bucket.entity.explicitTableName !== undefined) {
        explicitTableName = bucket.entity.explicitTableName;
      }
      if (bucket.entity.schema !== undefined) {
        schema = bucket.entity.schema;
      }
      camelCaseMapping = bucket.entity.camelCaseMapping;
      pluralizeTableName = bucket.entity.pluralizeTableName;
    }
    for (let j = 0; j < bucket.columns.length; j++) {
      const col = bucket.columns[j]!;
      if (!colMap.has(col.propertyName)) {
        colOrder.push(col.propertyName);
      }
      colMap.set(col.propertyName, col);
    }
  }

  const effectiveCamel = camelCaseMapping ?? true;
  const columns: DeclarativeColumnDescriptor[] = colOrder.map((prop) => {
    const stored = colMap.get(prop)!;
    const columnName =
      stored.explicitName ??
      (effectiveCamel ? camelToSnake(stored.propertyName) : stored.propertyName);
    const type: OrmColumnType =
      stored.type ??
      (stored.generationStrategy === "uuid" ||
      stored.generationStrategy === "objectid"
        ? stored.generationStrategy
        : inferColumnType(stored.designType));
    return {
      propertyName: stored.propertyName,
      columnName,
      type,
      ...(stored.designType !== undefined ? { designType: stored.designType } : {}),
      primary: stored.primary,
      generated: stored.generated,
      ...(stored.generationStrategy !== undefined
        ? { generationStrategy: stored.generationStrategy }
        : {}),
      hasDefault: stored.hasDefault,
      ...(stored.hasDefault ? { default: stored.default } : {}),
      ...(stored.transformer !== undefined ? { transformer: stored.transformer } : {}),
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
    };
  });

  return {
    explicitTableName,
    schema,
    camelCaseMapping,
    pluralizeTableName,
    columns,
  };
}

function toCompiledLikeColumn(
  col: DeclarativeColumnDescriptor,
): CompiledColumnMetadata {
  return {
    propertyName: col.propertyName,
    propertyPath: [col.propertyName],
    columnName: col.columnName,
    type: col.type,
    nullable: !col.primary,
    unique: false,
    hasDefault: col.hasDefault,
    ...(col.hasDefault ? { default: col.default } : {}),
    primary: col.primary,
    generated: col.generated,
    ...(col.generationStrategy !== undefined
      ? { generationStrategy: col.generationStrategy }
      : {}),
    select: true,
    insert: true,
    update: true,
    ...(col.transformer !== undefined ? { transformer: col.transformer } : {}),
    createdAt: col.createdAt,
    updatedAt: col.updatedAt,
    deletedAt: false,
    version: false,
    isEmbeddedFlat: false,
    isEmbeddedJson: false,
    isVirtualJoinColumn: false,
  };
}

// ============================================================================
// Decorators
// ============================================================================

/**
 * Marks an `abstract class` (or class) as a Spring Data-style declarative ORM
 * repository compiled once by `OrmModule.forFeature([MyRepository])` or
 * `autoRegisterRepositories: true`.
 */
export function Repository<TEntity = any, TKey = number>(
  entityOrOptions?:
    | Type<TEntity>
    | Abstract<TEntity>
    | string
    | OrmRepositoryOptions<TEntity>,
): ClassDecorator {
  if (entityOrOptions === undefined) {
    throw new Error(
      `@Repository<TEntity, TKey>() without a runtime entity argument requires registerBunestPlugin() in bunfig.toml preload (or pass the entity class explicitly: @Repository(MyEntity)).`,
    );
  }
  let opts: OrmRepositoryOptions<TEntity>;
  if (typeof entityOrOptions === "function") {
    opts = { entity: entityOrOptions };
  } else if (typeof entityOrOptions === "string") {
    opts = { table: entityOrOptions };
  } else {
    opts = entityOrOptions;
  }

  const entity = opts.entity;
  const regInfo = entity ? collectEntityMetaFromRegistries(entity) : undefined;

  const pluralize = opts.pluralizeTableName ?? regInfo?.pluralizeTableName ?? true;
  const table =
    opts.table ??
    regInfo?.explicitTableName ??
    (entity ? inferTableName(entity.name, pluralize) : "");

  if (!table) {
    throw new Error(
      `@Repository() requires either an entity class or an explicit "table" name.`,
    );
  }

  const schema = opts.schema ?? regInfo?.schema;
  const pkCol = regInfo?.columns.find((c) => c.primary);
  const idColumn = opts.idColumn ?? pkCol?.columnName ?? "id";

  assertSafeSqlIdentifier(table, "table name");
  assertSafeSqlIdentifier(idColumn, "id column name");
  if (schema !== undefined && schema.length > 0) {
    assertSafeSqlIdentifier(schema, "schema name");
  }

  const columns: Record<string, string> = {};
  if (regInfo) {
    for (let i = 0; i < regInfo.columns.length; i++) {
      const col = regInfo.columns[i]!;
      assertSafeSqlIdentifier(
        col.columnName,
        `column mapping for "${col.propertyName}"`,
      );
      columns[col.propertyName] = col.columnName;
    }
  }
  if (opts.columns) {
    for (const [prop, col] of Object.entries(opts.columns)) {
      assertSafeSqlIdentifier(col, `column mapping for "${prop}"`);
      columns[prop] = col;
    }
  }

  const camelCaseMapping =
    opts.camelCaseMapping ?? regInfo?.camelCaseMapping ?? true;
  const defaultIdProperty = camelCaseMapping
    ? snakeToCamel(idColumn)
    : idColumn;
  const idProperty =
    opts.idProperty ??
    (opts.idColumn === undefined && pkCol !== undefined
      ? pkCol.propertyName
      : defaultIdProperty);

  const dataSource = opts.dataSource ?? opts.connectionName;

  const metadata: OrmRepositoryMetadata<TEntity> = {
    ...(entity !== undefined ? { entity } : {}),
    table,
    ...(schema !== undefined ? { schema } : {}),
    idColumn,
    idProperty,
    columns,
    ...(dataSource !== undefined ? { dataSource } : {}),
    ...(opts.dialect !== undefined ? { dialect: opts.dialect } : {}),
    camelCaseMapping,
    ...(opts.mapRow !== undefined ? { mapRow: opts.mapRow } : {}),
  };

  return (target) => {
    MetadataRegistry.define(ORM_REPOSITORY_METADATA, metadata, target);
    DecoratorRegistry.register("orm-repository", target, metadata);
  };
}

// ============================================================================
// Inspection Helpers
// ============================================================================

export function getOrmRepositoryMetadata(
  target: Function,
): OrmRepositoryMetadata | undefined {
  return MetadataRegistry.get<OrmRepositoryMetadata>(
    ORM_REPOSITORY_METADATA,
    target,
  );
}

export function isDeclarativeOrmRepository(
  target: unknown,
): target is Abstract<unknown> {
  if (typeof target !== "function") {
    return false;
  }
  return (
    MetadataRegistry.has(ORM_REPOSITORY_METADATA, target) ||
    target.prototype instanceof CrudRepository
  );
}

// ============================================================================
// Dialect-Aware SQL Placeholder Scanner (Skips Quotes, Comments & ::casts)
// ============================================================================

type PlaceholderBinding =
  | { readonly kind: "named"; readonly name: string }
  | { readonly kind: "positional"; readonly index: number };

interface CompiledDialectSql {
  readonly sql: string;
  readonly bindings: readonly PlaceholderBinding[];
  readonly hasNamedPlaceholders: boolean;
}

function compileDialectSql(
  rawSql: string,
  dialect: OrmDialect,
): CompiledDialectSql {
  let out = "";
  const bindings: PlaceholderBinding[] = [];
  let hasNamedPlaceholders = false;
  let positionalCursor = 0;
  let outParamCounter = 0;
  let i = 0;
  const len = rawSql.length;

  while (i < len) {
    const ch = rawSql[i]!;

    // Single-quoted string literal '...'
    if (ch === "'") {
      out += ch;
      i++;
      while (i < len) {
        const c = rawSql[i]!;
        out += c;
        i++;
        if (c === "'") {
          if (i < len && rawSql[i] === "'") {
            out += rawSql[i]!;
            i++;
          } else {
            break;
          }
        }
      }
      continue;
    }

    // Double-quoted identifier "..."
    if (ch === '"') {
      out += ch;
      i++;
      while (i < len) {
        const c = rawSql[i]!;
        out += c;
        i++;
        if (c === '"') {
          if (i < len && rawSql[i] === '"') {
            out += rawSql[i]!;
            i++;
          } else {
            break;
          }
        }
      }
      continue;
    }

    // Backtick-quoted identifier `...`
    if (ch === "`") {
      out += ch;
      i++;
      while (i < len) {
        const c = rawSql[i]!;
        out += c;
        i++;
        if (c === "`") {
          if (i < len && rawSql[i] === "`") {
            out += rawSql[i]!;
            i++;
          } else {
            break;
          }
        }
      }
      continue;
    }

    // Single-line comment -- ...
    if (ch === "-" && i + 1 < len && rawSql[i + 1] === "-") {
      while (i < len && rawSql[i] !== "\n") {
        out += rawSql[i]!;
        i++;
      }
      continue;
    }

    // Block comment /* ... */
    if (ch === "/" && i + 1 < len && rawSql[i + 1] === "*") {
      out += "/*";
      i += 2;
      while (i < len) {
        if (rawSql[i] === "*" && i + 1 < len && rawSql[i + 1] === "/") {
          out += "*/";
          i += 2;
          break;
        }
        out += rawSql[i]!;
        i++;
      }
      continue;
    }

    // PostgreSQL type cast ::type
    if (ch === ":" && i + 1 < len && rawSql[i + 1] === ":") {
      out += "::";
      i += 2;
      continue;
    }

    // Named placeholder :paramName
    if (ch === ":" && i + 1 < len && /[A-Za-z_]/.test(rawSql[i + 1]!)) {
      let j = i + 1;
      while (j < len && /[A-Za-z0-9_]/.test(rawSql[j]!)) {
        j++;
      }
      const paramName = rawSql.slice(i + 1, j);
      hasNamedPlaceholders = true;
      bindings.push({ kind: "named", name: paramName });
      out += formatPlaceholder(++outParamCounter, dialect);
      i = j;
      continue;
    }

    // Positional placeholder ?
    if (ch === "?") {
      bindings.push({ kind: "positional", index: positionalCursor++ });
      out += formatPlaceholder(++outParamCounter, dialect);
      i++;
      continue;
    }

    // Numbered positional placeholder $1, $2, ...
    if (ch === "$" && i + 1 < len && /[1-9]/.test(rawSql[i + 1]!)) {
      let j = i + 1;
      while (j < len && /[0-9]/.test(rawSql[j]!)) {
        j++;
      }
      const oneBased = Number.parseInt(rawSql.slice(i + 1, j), 10);
      bindings.push({ kind: "positional", index: oneBased - 1 });
      out += formatPlaceholder(++outParamCounter, dialect);
      i = j;
      continue;
    }

    out += ch;
    i++;
  }

  return {
    sql: out,
    bindings,
    hasNamedPlaceholders,
  };
}

// ============================================================================
// Derived Query Parser & Multi-Dialect Compiler
// ============================================================================

type DerivedAction =
  | "findOne"
  | "findAll"
  | "findPage"
  | "findCursor"
  | "exists"
  | "count"
  | "delete";

type DerivedOperator =
  | "eq"
  | "ne"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "between"
  | "containing"
  | "notContaining"
  | "startsWith"
  | "endsWith"
  | "like"
  | "notLike"
  | "in"
  | "notIn"
  | "isNull"
  | "isNotNull"
  | "isTrue"
  | "isFalse"
  | "custom";

interface ParsedPredicate {
  readonly combinator: "AND" | "OR" | null;
  readonly column: string;
  readonly operator: DerivedOperator;
  readonly customOperator?: CustomQueryOperator;
  readonly ignoreCase: boolean;
  readonly argCount: number;
}

interface ParsedOrderBy {
  readonly column: string;
  readonly direction: "ASC" | "DESC";
}

interface ParsedDerivedQuery {
  readonly action: DerivedAction;
  readonly limit?: number;
  readonly predicates: readonly ParsedPredicate[];
  readonly orderBy: readonly ParsedOrderBy[];
  readonly totalArgs: number;
}

const DERIVED_OPERATOR_SUFFIXES: ReadonlyArray<{
  readonly suffix: string;
  readonly operator: Exclude<DerivedOperator, "custom">;
  readonly argCount: number;
}> = [
  { suffix: "GreaterThanEqual", operator: "gte", argCount: 1 },
  { suffix: "LessThanEqual", operator: "lte", argCount: 1 },
  { suffix: "NotContaining", operator: "notContaining", argCount: 1 },
  { suffix: "StartingWith", operator: "startsWith", argCount: 1 },
  { suffix: "GreaterThan", operator: "gt", argCount: 1 },
  { suffix: "EndingWith", operator: "endsWith", argCount: 1 },
  { suffix: "Containing", operator: "containing", argCount: 1 },
  { suffix: "StartsWith", operator: "startsWith", argCount: 1 },
  { suffix: "IsNotNull", operator: "isNotNull", argCount: 0 },
  { suffix: "NotEquals", operator: "ne", argCount: 1 },
  { suffix: "LessThan", operator: "lt", argCount: 1 },
  { suffix: "Contains", operator: "containing", argCount: 1 },
  { suffix: "EndsWith", operator: "endsWith", argCount: 1 },
  { suffix: "NotNull", operator: "isNotNull", argCount: 0 },
  { suffix: "NotLike", operator: "notLike", argCount: 1 },
  { suffix: "Between", operator: "between", argCount: 2 },
  { suffix: "IsFalse", operator: "isFalse", argCount: 0 },
  { suffix: "IsNull", operator: "isNull", argCount: 0 },
  { suffix: "IsTrue", operator: "isTrue", argCount: 0 },
  { suffix: "Equals", operator: "eq", argCount: 1 },
  { suffix: "IsNot", operator: "ne", argCount: 1 },
  { suffix: "NotIn", operator: "notIn", argCount: 1 },
  { suffix: "Like", operator: "like", argCount: 1 },
  { suffix: "Gte", operator: "gte", argCount: 1 },
  { suffix: "Lte", operator: "lte", argCount: 1 },
  { suffix: "Not", operator: "ne", argCount: 1 },
  { suffix: "In", operator: "in", argCount: 1 },
  { suffix: "Gt", operator: "gt", argCount: 1 },
  { suffix: "Lt", operator: "lt", argCount: 1 },
  { suffix: "Is", operator: "eq", argCount: 1 },
];

const DERIVED_METHOD_PREFIX =
  /^(?:findAllBy|findOneBy|findFirst(\d*)By|findTop(\d+)By|findPageBy|findPageOrderBy|findPage$|findCursorBy|findCursorOrderBy|findCursor$|findBy|findAllOrderBy|existsBy|countBy|deleteBy|removeBy)/;

function isDerivedMethodName(name: string): boolean {
  return DERIVED_METHOD_PREFIX.test(name);
}

function resolvePropertyColumnName(
  propSegment: string,
  meta: OrmRepositoryMetadata,
): string {
  const propName = uncapitalize(propSegment);
  const mapped =
    meta.columns[propName] ??
    meta.columns[propSegment] ??
    (meta.camelCaseMapping ? camelToSnake(propName) : propName);
  return assertSafeSqlIdentifier(mapped, `column for "${propName}"`);
}

function parseOrderByPart(
  orderByPart: string,
  meta: OrmRepositoryMetadata,
  methodName: string,
): ParsedOrderBy[] {
  const items: ParsedOrderBy[] = [];
  const regex = /([A-Z][A-Za-z0-9]*?)(Asc|Desc)(?=[A-Z]|$)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(orderByPart)) !== null) {
    if (match.index !== lastIndex) {
      throw new Error(
        `Unable to parse OrderBy clause "${orderByPart}" in derived query "${methodName}".`,
      );
    }
    const propSeg = match[1]!;
    const dir = match[2] === "Desc" ? "DESC" : "ASC";
    items.push({
      column: resolvePropertyColumnName(propSeg, meta),
      direction: dir,
    });
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < orderByPart.length) {
    const trailing = orderByPart.slice(lastIndex);
    if (!/^[A-Z][A-Za-z0-9]*$/.test(trailing)) {
      throw new Error(
        `Unable to parse OrderBy clause "${orderByPart}" in derived query "${methodName}".`,
      );
    }
    items.push({
      column: resolvePropertyColumnName(trailing, meta),
      direction: "ASC",
    });
  }

  if (items.length === 0) {
    throw new Error(`Empty OrderBy clause in derived query "${methodName}".`);
  }

  return items;
}

function findLongestCustomOperatorMatch(
  segment: string,
  customOperators: readonly CustomQueryOperator[],
): CustomQueryOperator | undefined {
  let best: CustomQueryOperator | undefined;
  for (let i = 0; i < customOperators.length; i++) {
    const op = customOperators[i]!;
    if (
      segment.endsWith(op.suffix) &&
      segment.length > op.suffix.length &&
      (!best || op.suffix.length > best.suffix.length)
    ) {
      best = op;
    }
  }
  return best;
}

function parseSinglePredicate(
  rawSegment: string,
  combinator: "AND" | "OR" | null,
  meta: OrmRepositoryMetadata,
  methodName: string,
  customOperators: readonly CustomQueryOperator[],
): ParsedPredicate {
  let segment = rawSegment;
  let ignoreCase = false;

  // Check if a registered custom operator matches the full raw segment directly
  // (e.g. a custom suffix that itself ends in "IgnoreCase").
  const directCustom =
    customOperators.length > 0 && segment.endsWith("IgnoreCase")
      ? findLongestCustomOperatorMatch(segment, customOperators)
      : undefined;

  if (directCustom && directCustom.suffix.endsWith("IgnoreCase")) {
    const propPart = segment.slice(0, -directCustom.suffix.length);
    if (propPart.length === 0) {
      throw new Error(
        `Missing property name in predicate "${rawSegment}" of derived query "${methodName}".`,
      );
    }
    return {
      combinator,
      column: resolvePropertyColumnName(propPart, meta),
      operator: "custom",
      customOperator: directCustom,
      ignoreCase: false,
      argCount: directCustom.arity,
    };
  }

  if (segment.endsWith("IgnoreCase") && segment.length > "IgnoreCase".length) {
    ignoreCase = true;
    segment = segment.slice(0, -"IgnoreCase".length);
  }

  let operator: DerivedOperator = "eq";
  let customOperator: CustomQueryOperator | undefined;
  let argCount = 1;
  let propPart = segment;

  // Longest-suffix match across BOTH built-in and registered custom operators.
  // On an exact suffix-length tie, custom operators take precedence over built-in ones.
  let bestLen = 0;

  for (let i = 0; i < DERIVED_OPERATOR_SUFFIXES.length; i++) {
    const entry = DERIVED_OPERATOR_SUFFIXES[i]!;
    if (
      segment.endsWith(entry.suffix) &&
      segment.length > entry.suffix.length &&
      entry.suffix.length > bestLen
    ) {
      bestLen = entry.suffix.length;
      propPart = segment.slice(0, -entry.suffix.length);
      operator = entry.operator;
      customOperator = undefined;
      argCount = entry.argCount;
    }
  }

  for (let i = 0; i < customOperators.length; i++) {
    const custom = customOperators[i]!;
    if (
      segment.endsWith(custom.suffix) &&
      segment.length > custom.suffix.length &&
      custom.suffix.length >= bestLen
    ) {
      bestLen = custom.suffix.length;
      propPart = segment.slice(0, -custom.suffix.length);
      operator = "custom";
      customOperator = custom;
      argCount = custom.arity;
    }
  }

  if (propPart.length === 0) {
    throw new Error(
      `Missing property name in predicate "${rawSegment}" of derived query "${methodName}".`,
    );
  }

  const column = resolvePropertyColumnName(propPart, meta);
  return {
    combinator,
    column,
    operator,
    ...(customOperator !== undefined ? { customOperator } : {}),
    ignoreCase,
    argCount,
  };
}

function parseDerivedMethod(
  methodName: string,
  meta: OrmRepositoryMetadata,
): ParsedDerivedQuery {
  let action: DerivedAction;
  let limit: number | undefined;
  let remainder: string;
  let orderByOnly = false;
  let noCriteria = false;

  if (methodName === "findPage") {
    action = "findPage";
    remainder = "";
    noCriteria = true;
  } else if (methodName.startsWith("findPageOrderBy")) {
    action = "findPage";
    remainder = methodName.slice("findPageOrderBy".length);
    orderByOnly = true;
  } else if (methodName.startsWith("findPageBy")) {
    action = "findPage";
    remainder = methodName.slice("findPageBy".length);
  } else if (methodName === "findCursor") {
    action = "findCursor";
    remainder = "";
    noCriteria = true;
  } else if (methodName.startsWith("findCursorOrderBy")) {
    action = "findCursor";
    remainder = methodName.slice("findCursorOrderBy".length);
    orderByOnly = true;
  } else if (methodName.startsWith("findCursorBy")) {
    action = "findCursor";
    remainder = methodName.slice("findCursorBy".length);
  } else if (methodName.startsWith("findAllOrderBy")) {
    action = "findAll";
    remainder = methodName.slice("findAllOrderBy".length);
    orderByOnly = true;
  } else if (methodName.startsWith("findAllBy")) {
    action = "findAll";
    remainder = methodName.slice("findAllBy".length);
  } else if (methodName.startsWith("findOneBy")) {
    action = "findOne";
    limit = 1;
    remainder = methodName.slice("findOneBy".length);
  } else if (methodName.startsWith("findFirst")) {
    const m = /^findFirst(\d*)By(.+)$/.exec(methodName);
    if (!m) {
      throw new Error(`Invalid derived query method "${methodName}".`);
    }
    const countStr = m[1];
    remainder = m[2]!;
    if (countStr && countStr.length > 0) {
      action = "findAll";
      limit = Number.parseInt(countStr, 10);
    } else {
      action = "findOne";
      limit = 1;
    }
  } else if (methodName.startsWith("findTop")) {
    const m = /^findTop(\d+)By(.+)$/.exec(methodName);
    if (!m) {
      throw new Error(`Invalid derived query method "${methodName}".`);
    }
    action = "findAll";
    limit = Number.parseInt(m[1]!, 10);
    remainder = m[2]!;
  } else if (methodName.startsWith("findBy")) {
    action = "findOne";
    limit = 1;
    remainder = methodName.slice("findBy".length);
  } else if (methodName.startsWith("existsBy")) {
    action = "exists";
    limit = 1;
    remainder = methodName.slice("existsBy".length);
  } else if (methodName.startsWith("countBy")) {
    action = "count";
    remainder = methodName.slice("countBy".length);
  } else if (methodName.startsWith("deleteBy")) {
    action = "delete";
    remainder = methodName.slice("deleteBy".length);
  } else if (methodName.startsWith("removeBy")) {
    action = "delete";
    remainder = methodName.slice("removeBy".length);
  } else {
    throw new Error(`Unsupported derived query method "${methodName}".`);
  }

  if (noCriteria) {
    return {
      action,
      limit,
      predicates: [],
      orderBy: [],
      totalArgs: 0,
    };
  }

  if (orderByOnly) {
    const orderBy = parseOrderByPart(remainder, meta, methodName);
    return {
      action,
      limit,
      predicates: [],
      orderBy,
      totalArgs: 0,
    };
  }

  let criteriaPart = remainder;
  let orderBy: ParsedOrderBy[] = [];

  const orderByMatch = /OrderBy([A-Z].*)$/.exec(remainder);
  if (orderByMatch && orderByMatch.index > 0) {
    criteriaPart = remainder.slice(0, orderByMatch.index);
    orderBy = parseOrderByPart(orderByMatch[1]!, meta, methodName);
  }

  if (criteriaPart.length === 0) {
    throw new Error(
      `Missing filter criteria in derived query "${methodName}".`,
    );
  }

  const customOperators = listRegisteredQueryOperators();
  const tokens = criteriaPart.split(/(And|Or)(?=[A-Z])/);
  const predicates: ParsedPredicate[] = [];
  let pendingCombinator: "AND" | "OR" | null = null;
  let totalArgs = 0;

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (tok === "And") {
      pendingCombinator = "AND";
      continue;
    }
    if (tok === "Or") {
      pendingCombinator = "OR";
      continue;
    }
    if (tok.length === 0) {
      continue;
    }
    const pred = parseSinglePredicate(
      tok,
      pendingCombinator,
      meta,
      methodName,
      customOperators,
    );
    predicates.push(pred);
    totalArgs += pred.argCount;
    pendingCombinator = null;
  }

  if (predicates.length === 0) {
    throw new Error(`No predicates parsed in derived query "${methodName}".`);
  }

  return {
    action,
    limit,
    predicates,
    orderBy,
    totalArgs,
  };
}

// ============================================================================
// Column Maps, Hydration & Serialization
// ============================================================================

interface ResolvedColumnMaps {
  readonly byProp: ReadonlyMap<string, CompiledColumnMetadata>;
  readonly byCol: ReadonlyMap<string, CompiledColumnMetadata>;
  readonly createdAtCols: readonly CompiledColumnMetadata[];
  readonly updatedAtCols: readonly CompiledColumnMetadata[];
  readonly generatedNonIncrementPkCols: readonly CompiledColumnMetadata[];
  readonly dynamicDefaultCols: readonly CompiledColumnMetadata[];
}

function buildColumnMaps(meta: OrmRepositoryMetadata): ResolvedColumnMaps {
  const regInfo = meta.entity
    ? collectEntityMetaFromRegistries(meta.entity)
    : undefined;
  const byProp = new Map<string, CompiledColumnMetadata>();
  const byCol = new Map<string, CompiledColumnMetadata>();
  const createdAtCols: CompiledColumnMetadata[] = [];
  const updatedAtCols: CompiledColumnMetadata[] = [];
  const generatedNonIncrementPkCols: CompiledColumnMetadata[] = [];
  const dynamicDefaultCols: CompiledColumnMetadata[] = [];

  if (regInfo) {
    for (let i = 0; i < regInfo.columns.length; i++) {
      const desc = regInfo.columns[i]!;
      const effectiveColName = meta.columns[desc.propertyName] ?? desc.columnName;
      const compiled = toCompiledLikeColumn({
        ...desc,
        columnName: effectiveColName,
      });
      byProp.set(compiled.propertyName, compiled);
      byCol.set(effectiveColName, compiled);
      if (compiled.createdAt) {
        createdAtCols.push(compiled);
      }
      if (compiled.updatedAt) {
        updatedAtCols.push(compiled);
      }
      if (
        compiled.primary &&
        compiled.generated &&
        (compiled.generationStrategy === "uuid" ||
          compiled.generationStrategy === "objectid")
      ) {
        generatedNonIncrementPkCols.push(compiled);
      }
      if (compiled.hasDefault && typeof compiled.default === "function") {
        dynamicDefaultCols.push(compiled);
      }
    }
  }

  return {
    byProp,
    byCol,
    createdAtCols,
    updatedAtCols,
    generatedNonIncrementPkCols,
    dynamicDefaultCols,
  };
}

function createAutoTimestampValue(
  col: CompiledColumnMetadata,
  now: Date,
  dialect: OrmDialect,
): unknown {
  if (col.transformer) {
    return col.transformer.to(now);
  }
  if (col.type === "integer" || col.type === "bigint") {
    return now.getTime();
  }
  return toDbValue(col, now, dialect);
}

interface CompiledProjection {
  readonly fields: readonly string[];
  readonly columns: readonly string[];
  readonly selectSql: string;
}

function compileProjection(
  fields: readonly string[],
  meta: OrmRepositoryMetadata,
  dialect: OrmDialect,
  extraColumns?: readonly string[],
): CompiledProjection {
  const columns: string[] = [];
  const selectColSet = new Set<string>();
  const selectCols: string[] = [];

  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]!;
    const col =
      meta.columns[field] ??
      (meta.camelCaseMapping ? camelToSnake(field) : field);
    assertSafeSqlIdentifier(col, `projection column for "${field}"`);
    columns.push(col);
    if (!selectColSet.has(col)) {
      selectColSet.add(col);
      selectCols.push(col);
    }
  }

  if (extraColumns) {
    for (let i = 0; i < extraColumns.length; i++) {
      const extra = assertSafeSqlIdentifier(
        extraColumns[i]!,
        "extra projection column",
      );
      if (!selectColSet.has(extra)) {
        selectColSet.add(extra);
        selectCols.push(extra);
      }
    }
  }

  const selectSql = selectCols
    .map((c) => quoteIdentifier(c, dialect, "projection column"))
    .join(", ");

  return { fields, columns, selectSql };
}

function hydrateProjectedRow(
  row: Record<string, unknown>,
  projection: CompiledProjection,
  colMaps: ResolvedColumnMaps,
  compiledMeta?: CompiledEntityMetadata,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const hasSchemaColumns = colMaps.byCol.size > 0 || colMaps.byProp.size > 0;

  for (let i = 0; i < projection.fields.length; i++) {
    const field = projection.fields[i]!;
    const col = projection.columns[i]!;
    const rawVal = row[col] !== undefined ? row[col] : row[field];
    const colMeta =
      compiledMeta?.columnsByColumnName.get(col) ??
      (hasSchemaColumns
        ? (colMaps.byCol.get(col) ?? colMaps.byProp.get(field))
        : undefined);
    out[field] = colMeta ? fromDbValue(colMeta, rawVal) : rawVal;
  }

  return out;
}

function isScopeSqlFragment(
  value: RepositoryScopeWhereResult,
): value is { readonly sql: string; readonly params?: readonly unknown[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const rec = value as Record<string, unknown>;
  if (typeof rec["sql"] !== "string") {
    return false;
  }
  const keys = Object.keys(rec);
  return keys.every((k) => k === "sql" || k === "params");
}

function isStubMethodBody(fn: Function): boolean {
  const src = Function.prototype.toString.call(fn);
  const braceIdx = src.indexOf("{");
  if (braceIdx === -1) {
    return false;
  }
  const body = src
    .slice(braceIdx + 1, src.lastIndexOf("}"))
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  return !/\b(?:this|super)\b/.test(body);
}

interface DerivedWhereCompilation {
  readonly whereClause: string;
  readonly params: unknown[];
  readonly paramCount: number;
  readonly hasUserOr: boolean;
}

function buildDerivedWhereAndParams(
  parsed: ParsedDerivedQuery,
  dialect: OrmDialect,
  args: readonly unknown[],
  methodName: string,
  colMaps: ResolvedColumnMaps,
  scopeWhere?: {
    readonly evaluate: (startParamIndex: number) => {
      readonly sql: string;
      readonly params: readonly unknown[];
    };
  },
  extraClause?: {
    readonly build: (nextPh: () => string) => {
      readonly sql: string;
      readonly params: readonly unknown[];
    };
  },
): DerivedWhereCompilation {
  if (args.length < parsed.totalArgs) {
    throw new Error(
      `Derived query "${methodName}" expects at least ${parsed.totalArgs} argument(s), received ${args.length}.`,
    );
  }

  const whereParts: string[] = [];
  const params: unknown[] = [];
  let argCursor = 0;
  let paramCounter = 0;
  let hasUserOr = false;
  const nextPh = () => formatPlaceholder(++paramCounter, dialect);

  const serializeArg = (colName: string, raw: unknown): unknown => {
    const colMeta = colMaps.byCol.get(colName);
    if (!colMeta) {
      return raw;
    }
    return toDbValue(colMeta, raw, dialect);
  };

  for (let i = 0; i < parsed.predicates.length; i++) {
    const p = parsed.predicates[i]!;
    if (p.combinator === "OR") {
      hasUserOr = true;
    }
    const prefix = p.combinator ? ` ${p.combinator} ` : "";
    const quotedCol = quoteIdentifier(p.column, dialect, "column name");
    const colExpr = p.ignoreCase ? `LOWER(${quotedCol})` : quotedCol;
    const wrapPh = (ph: string) => (p.ignoreCase ? `LOWER(${ph})` : ph);

    switch (p.operator) {
      case "custom": {
        const customOp = p.customOperator;
        if (!customOp) {
          throw new Error(
            `Derived query "${methodName}" references missing custom operator for column "${p.column}".`,
          );
        }
        const opArgs = args.slice(argCursor, argCursor + customOp.arity);
        argCursor += customOp.arity;
        let phCalls = 0;
        const trackedNextPh = (): string => {
          phCalls++;
          return nextPh();
        };
        const result = customOp.toSql({
          column: p.column,
          quotedColumn: quotedCol,
          dialect,
          args: opArgs,
          ignoreCase: p.ignoreCase,
          nextPlaceholder: trackedNextPh,
          quoteIdentifier: (id, ctx) => quoteIdentifier(id, dialect, ctx),
          serializeValue: (val) => serializeArg(p.column, val),
        });
        const opParams = result.params ? [...result.params] : [];
        const rawOpSql = result.sql.trim();
        if (rawOpSql.length === 0) {
          throw new Error(
            `Custom query operator "${customOp.suffix}" in "${methodName}" returned empty SQL.`,
          );
        }
        const finalOpSql =
          phCalls === 0 && opParams.length > 0
            ? rewriteQuestionPlaceholders(rawOpSql, nextPh)
            : rawOpSql;
        const groupedSql = hasTopLevelSqlOr(finalOpSql)
          ? `(${finalOpSql})`
          : finalOpSql;
        whereParts.push(`${prefix}${groupedSql}`);
        for (let k = 0; k < opParams.length; k++) {
          params.push(opParams[k]);
        }
        break;
      }
      case "isNull":
        whereParts.push(`${prefix}${quotedCol} IS NULL`);
        break;
      case "isNotNull":
        whereParts.push(`${prefix}${quotedCol} IS NOT NULL`);
        break;
      case "isTrue":
        whereParts.push(
          `${prefix}${quotedCol} = ${booleanLiteral(dialect, true)}`,
        );
        break;
      case "isFalse":
        whereParts.push(
          `${prefix}${quotedCol} = ${booleanLiteral(dialect, false)}`,
        );
        break;
      case "eq": {
        const val = args[argCursor++];
        if (val === null) {
          whereParts.push(`${prefix}${quotedCol} IS NULL`);
        } else {
          whereParts.push(`${prefix}${colExpr} = ${wrapPh(nextPh())}`);
          params.push(serializeArg(p.column, val));
        }
        break;
      }
      case "ne": {
        const val = args[argCursor++];
        if (val === null) {
          whereParts.push(`${prefix}${quotedCol} IS NOT NULL`);
        } else {
          whereParts.push(`${prefix}${colExpr} <> ${wrapPh(nextPh())}`);
          params.push(serializeArg(p.column, val));
        }
        break;
      }
      case "gt": {
        const val = args[argCursor++];
        whereParts.push(`${prefix}${quotedCol} > ${nextPh()}`);
        params.push(serializeArg(p.column, val));
        break;
      }
      case "gte": {
        const val = args[argCursor++];
        whereParts.push(`${prefix}${quotedCol} >= ${nextPh()}`);
        params.push(serializeArg(p.column, val));
        break;
      }
      case "lt": {
        const val = args[argCursor++];
        whereParts.push(`${prefix}${quotedCol} < ${nextPh()}`);
        params.push(serializeArg(p.column, val));
        break;
      }
      case "lte": {
        const val = args[argCursor++];
        whereParts.push(`${prefix}${quotedCol} <= ${nextPh()}`);
        params.push(serializeArg(p.column, val));
        break;
      }
      case "between": {
        const low = args[argCursor++];
        const high = args[argCursor++];
        const p1 = nextPh();
        const p2 = nextPh();
        whereParts.push(`${prefix}${quotedCol} BETWEEN ${p1} AND ${p2}`);
        params.push(serializeArg(p.column, low), serializeArg(p.column, high));
        break;
      }
      case "containing": {
        const val = args[argCursor++];
        whereParts.push(
          `${prefix}${colExpr} LIKE ${wrapPh(nextPh())} ESCAPE '!'`,
        );
        params.push(`%${escapeLikePattern(String(val))}%`);
        break;
      }
      case "notContaining": {
        const val = args[argCursor++];
        whereParts.push(
          `${prefix}${colExpr} NOT LIKE ${wrapPh(nextPh())} ESCAPE '!'`,
        );
        params.push(`%${escapeLikePattern(String(val))}%`);
        break;
      }
      case "startsWith": {
        const val = args[argCursor++];
        whereParts.push(
          `${prefix}${colExpr} LIKE ${wrapPh(nextPh())} ESCAPE '!'`,
        );
        params.push(`${escapeLikePattern(String(val))}%`);
        break;
      }
      case "endsWith": {
        const val = args[argCursor++];
        whereParts.push(
          `${prefix}${colExpr} LIKE ${wrapPh(nextPh())} ESCAPE '!'`,
        );
        params.push(`%${escapeLikePattern(String(val))}`);
        break;
      }
      case "like": {
        const val = args[argCursor++];
        whereParts.push(`${prefix}${colExpr} LIKE ${wrapPh(nextPh())}`);
        params.push(val);
        break;
      }
      case "notLike": {
        const val = args[argCursor++];
        whereParts.push(`${prefix}${colExpr} NOT LIKE ${wrapPh(nextPh())}`);
        params.push(val);
        break;
      }
      case "in":
      case "notIn": {
        const rawList = args[argCursor++];
        if (!Array.isArray(rawList)) {
          throw new Error(
            `Derived query "${methodName}" expects an Array argument for "${p.column}" ${p.operator.toUpperCase()} predicate.`,
          );
        }
        if (rawList.length === 0) {
          whereParts.push(
            `${prefix}${p.operator === "in" ? "1 = 0" : "1 = 1"}`,
          );
        } else {
          const placeholders: string[] = [];
          for (let k = 0; k < rawList.length; k++) {
            placeholders.push(nextPh());
            params.push(serializeArg(p.column, rawList[k]));
          }
          const opSql = p.operator === "in" ? "IN" : "NOT IN";
          whereParts.push(
            `${prefix}${quotedCol} ${opSql} (${placeholders.join(", ")})`,
          );
        }
        break;
      }
    }
  }

  const userWhereSql = whereParts.join("");
  const combinedParts: string[] = [];

  const scopeResult = scopeWhere ? scopeWhere.evaluate(paramCounter) : undefined;
  const hasScopes = scopeResult !== undefined && scopeResult.sql.length > 0;
  if (scopeResult && scopeResult.params.length > 0) {
    paramCounter += scopeResult.params.length;
  }

  const extraResult = extraClause ? extraClause.build(nextPh) : undefined;
  const hasExtra = extraResult !== undefined && extraResult.sql.length > 0;

  if (userWhereSql.length > 0) {
    if ((hasScopes || hasExtra) && hasUserOr) {
      combinedParts.push(`(${userWhereSql})`);
    } else {
      combinedParts.push(userWhereSql);
    }
  }

  if (hasScopes && scopeResult) {
    combinedParts.push(scopeResult.sql);
    for (let i = 0; i < scopeResult.params.length; i++) {
      params.push(scopeResult.params[i]);
    }
  }

  if (hasExtra && extraResult) {
    combinedParts.push(extraResult.sql);
    for (let i = 0; i < extraResult.params.length; i++) {
      params.push(extraResult.params[i]);
    }
  }

  const whereClause =
    combinedParts.length > 0 ? ` WHERE ${combinedParts.join(" AND ")}` : "";

  return {
    whereClause,
    params,
    paramCount: paramCounter,
    hasUserOr,
  };
}

function buildDerivedSqlAndParams(
  parsed: ParsedDerivedQuery,
  tableRef: string,
  dialect: OrmDialect,
  args: readonly unknown[],
  methodName: string,
  colMaps: ResolvedColumnMaps,
  options?: {
    readonly selectSql?: string;
    readonly scopeWhere?: {
      readonly evaluate: (startParamIndex: number) => {
        readonly sql: string;
        readonly params: readonly unknown[];
      };
    };
  },
): { sql: string; params: unknown[] } {
  const profile = getDialectProfile(dialect);
  const { whereClause, params } = buildDerivedWhereAndParams(
    parsed,
    dialect,
    args,
    methodName,
    colMaps,
    options?.scopeWhere,
  );
  const selectExpr = options?.selectSql ?? "*";
  const orderClause =
    parsed.orderBy.length > 0
      ? ` ORDER BY ${parsed.orderBy.map((o) => `${quoteIdentifier(o.column, dialect, "orderBy column")} ${o.direction}`).join(", ")}`
      : "";
  const limitClause = profile.formatLimitOffset(
    parsed.limit,
    undefined,
    parsed.orderBy.length > 0,
  );

  let sql: string;
  switch (parsed.action) {
    case "findOne":
    case "findAll":
    case "findPage":
    case "findCursor":
      sql = `SELECT ${selectExpr} FROM ${tableRef}${whereClause}${orderClause}${limitClause}`;
      break;
    case "exists": {
      const existsLimit = profile.formatLimitOffset(1, undefined, false);
      sql = `SELECT 1 AS found FROM ${tableRef}${whereClause}${existsLimit}`;
      break;
    }
    case "count":
      sql = `SELECT COUNT(*) AS count FROM ${tableRef}${whereClause}`;
      break;
    case "delete":
      sql = `DELETE FROM ${tableRef}${whereClause}`;
      break;
  }

  return { sql, params };
}

function inferQueryMode(
  methodName: string,
  sql: string,
  queryOptions: OrmQueryOptions | undefined,
  modifyingOptions: OrmModifyingOptions | undefined,
): OrmQueryReturnMode {
  if (queryOptions?.mode && queryOptions.mode !== "auto") {
    return queryOptions.mode;
  }
  if (queryOptions?.single === true) {
    return "one";
  }
  if (queryOptions?.single === false) {
    return "many";
  }
  if (modifyingOptions !== undefined) {
    return modifyingOptions.returnType ?? "changes";
  }

  const trimmed = sql.trimStart();
  const cmd = trimmed.split(/\s+/, 1)[0]?.toUpperCase() ?? "";
  const hasReturning = /\b(?:RETURNING|OUTPUT|THEN\s+RETURN)\b/i.test(sql);
  if (
    (cmd === "INSERT" || cmd === "UPDATE" || cmd === "DELETE") &&
    !hasReturning
  ) {
    return "changes";
  }

  if (/^count/i.test(methodName)) {
    return "count";
  }
  if (/^exists/i.test(methodName)) {
    return "exists";
  }
  if (
    /^(?:findAll|findMany|findTop|list|search|getAll|fetchAll|selectAll|queryAll)/i.test(
      methodName,
    )
  ) {
    return "many";
  }
  if (
    /^(?:findOne|findFirst|findBy|getOne|getBy|fetchOne|selectOne)/i.test(
      methodName,
    )
  ) {
    return "one";
  }
  return "many";
}

function interpretExistsRow(row: Record<string, unknown> | null): boolean {
  if (row === null) {
    return false;
  }
  const keys = Object.keys(row);
  if (keys.length === 1) {
    const val = row[keys[0]!];
    if (typeof val === "boolean") return val;
    if (typeof val === "number") return val !== 0;
    if (typeof val === "bigint") return val !== 0n;
    if (typeof val === "string") {
      if (val === "0" || val.toLowerCase() === "false") return false;
      return val.length > 0;
    }
    return Boolean(val);
  }
  return true;
}

function interpretScalarRow(row: Record<string, unknown> | null): unknown {
  if (row === null) {
    return null;
  }
  const keys = Object.keys(row);
  if (keys.length === 0) {
    return null;
  }
  return row[keys[0]!] ?? null;
}

function createRowHydrator<TEntity>(
  meta: OrmRepositoryMetadata<TEntity>,
  colMaps: ResolvedColumnMaps,
): (
  row: Record<string, unknown>,
  compiledMeta?: CompiledEntityMetadata,
  host?: OrmDeclarativeHost,
) => TEntity {
  if (meta.mapRow) {
    const customMap = meta.mapRow;
    return (row) => customMap(row);
  }

  const reverseColumns = new Map<string, string>();
  for (const [prop, col] of Object.entries(meta.columns)) {
    reverseColumns.set(col, prop);
  }

  const entityProto =
    typeof meta.entity === "function"
      ? (meta.entity.prototype as object | null)
      : null;
  const hasSchemaColumns = colMaps.byCol.size > 0;

  return (row, compiledMeta, host): TEntity => {
    // When the entity uses @Embedded/@Nested columns, delegate to full ORM row hydration
    if (compiledMeta && compiledMeta.embeddeds.length > 0) {
      return hydrateEntityRow<TEntity>(compiledMeta, row, {
        safeJsonSerialization: host?.options?.safeJsonSerialization ?? true,
        circularJsonStrategy: host?.options?.circularJsonStrategy ?? "omit",
      });
    }

    const mapped: Record<string, unknown> = entityProto
      ? (Object.create(entityProto) as Record<string, unknown>)
      : {};
    for (const [col, rawVal] of Object.entries(row)) {
      const colMeta =
        compiledMeta?.columnsByColumnName.get(col) ??
        (hasSchemaColumns ? colMaps.byCol.get(col) : undefined);
      const val = colMeta ? fromDbValue(colMeta, rawVal) : rawVal;
      const explicitProp = reverseColumns.get(col) ?? colMeta?.propertyName;
      if (explicitProp !== undefined) {
        mapped[explicitProp] = val;
      } else if (meta.camelCaseMapping && col.includes("_")) {
        mapped[snakeToCamel(col)] = val;
      } else {
        mapped[col] = val;
      }
    }
    return mapped as TEntity;
  };
}

function createEntitySerializer(
  meta: OrmRepositoryMetadata,
  colMaps: ResolvedColumnMaps,
): (
  entity: Record<string, unknown>,
  dialect: OrmDialect,
) => {
  idValue: unknown;
  entries: Array<{ col: string; value: unknown }>;
  seenCols: Set<string>;
} {
  const hasSchemaColumns = colMaps.byProp.size > 0 || colMaps.byCol.size > 0;

  return (entity: Record<string, unknown>, dialect: OrmDialect) => {
    let idValue: unknown = undefined;
    const entries: Array<{ col: string; value: unknown }> = [];
    const seenCols = new Set<string>();

    for (const [prop, rawVal] of Object.entries(entity)) {
      if (rawVal === undefined) {
        continue;
      }
      const col =
        meta.columns[prop] ??
        (meta.camelCaseMapping ? camelToSnake(prop) : prop);
      assertSafeSqlIdentifier(col, `column name for "${prop}"`);
      if (seenCols.has(col)) {
        continue;
      }
      seenCols.add(col);
      const colMeta = hasSchemaColumns
        ? (colMaps.byProp.get(prop) ?? colMaps.byCol.get(col))
        : undefined;
      const val = colMeta ? toDbValue(colMeta, rawVal, dialect) : rawVal;
      if (col === meta.idColumn || prop === meta.idProperty) {
        idValue = val;
      }
      entries.push({ col, value: val });
    }

    return { idValue, entries, seenCols };
  };
}

// ============================================================================
// Compiled Repository Factory
// ============================================================================

type OrmMethodExecutor = (
  host: OrmDeclarativeHost,
  args: readonly unknown[],
  compiledMeta?: CompiledEntityMetadata,
) => Promise<unknown>;

interface RawQueryDeclaration {
  readonly methodName: string;
  readonly queryMeta: OrmQueryMetadata;
  readonly modifyingMeta?: OrmModifyingOptions;
  readonly paramMap?: OrmParamMetadataMap;
}

interface CompiledDialectBundle {
  readonly baseCrud: Record<string, OrmMethodExecutor>;
  readonly queryMethods: Map<string, OrmMethodExecutor>;
  readonly derivedCache: Map<string, OrmMethodExecutor>;
  readonly tableRef: string;
  readonly resolveColumn: (propertyOrColumn: string) => string;
  readonly serializeScopeValue: (columnName: string, raw: unknown) => unknown;
  readonly evaluateScopesWhere: (
    driver: OrmDriverLike,
    operation: RepositoryScopeOperation,
    methodName: string,
    startParamIndex: number,
    excludeScopes?: readonly string[],
  ) => { readonly sql: string; readonly params: readonly unknown[] };
  getOrCompileDerived(methodName: string): OrmMethodExecutor | undefined;
}

const MAX_RAW_SQL_CACHE = 512;

type CompiledRawSql = ReturnType<typeof compileDialectSql>;

function compileAndBindRawSql(
  sql: string,
  params: OrmSqlParams | undefined,
  dialect: OrmDialect,
  cache: Map<string, CompiledRawSql>,
  repoName: string,
  methodName: "query" | "queryOne" | "execute",
): { readonly sql: string; readonly params: unknown[] } {
  if (typeof sql !== "string" || sql.trim().length === 0) {
    throw new Error(
      `${repoName}.${methodName}() requires a non-empty SQL string.`,
    );
  }
  let compiled = cache.get(sql);
  if (!compiled) {
    compiled = compileDialectSql(sql, dialect);
    if (cache.size >= MAX_RAW_SQL_CACHE) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey !== undefined) {
        cache.delete(oldestKey);
      }
    }
    cache.set(sql, compiled);
  }
  if (compiled.bindings.length === 0) {
    return { sql: compiled.sql, params: [] };
  }
  if (compiled.hasNamedPlaceholders) {
    if (
      params === null ||
      params === undefined ||
      typeof params !== "object" ||
      Array.isArray(params)
    ) {
      const names = compiled.bindings
        .filter(
          (b): b is { readonly kind: "named"; readonly name: string } =>
            b.kind === "named",
        )
        .map((b) => `:${b.name}`);
      throw new Error(
        `${repoName}.${methodName}() uses named placeholders (${names.join(", ")}) and requires a parameter object (e.g. { ${names.map((n) => `${n.slice(1)}: ...`).join(", ")} }).`,
      );
    }
    const record = params as Readonly<Record<string, unknown>>;
    const resolved = compiled.bindings.map((b) => {
      if (b.kind === "named") {
        if (!(b.name in record)) {
          throw new Error(
            `${repoName}.${methodName}() is missing named parameter "${b.name}".`,
          );
        }
        const val = record[b.name];
        return val === undefined ? null : val;
      }
      return null;
    });
    return { sql: compiled.sql, params: resolved };
  }
  const arr = Array.isArray(params) ? params : [];
  const resolved = compiled.bindings.map((b) => {
    const val = b.kind === "positional" ? arr[b.index] : undefined;
    return val === undefined ? null : val;
  });
  return { sql: compiled.sql, params: resolved };
}

function compileCustomQueryMethod(
  decl: RawQueryDeclaration,
  dialect: OrmDialect,
  hydrateRow: (
    row: Record<string, unknown>,
    compiledMeta?: CompiledEntityMetadata,
    host?: OrmDeclarativeHost,
  ) => unknown,
  repoName: string,
): OrmMethodExecutor {
  const { methodName, queryMeta, modifyingMeta, paramMap } = decl;
  const compiled = compileDialectSql(queryMeta.sql, dialect);
  const mode = inferQueryMode(
    methodName,
    queryMeta.sql,
    queryMeta.options,
    modifyingMeta,
  );
  const shouldMapRows =
    queryMeta.options?.mapRows ?? (mode === "one" || mode === "many");

  let extractParams: (args: readonly unknown[]) => unknown[];

  if (compiled.bindings.length === 0) {
    extractParams = () => [];
  } else if (compiled.hasNamedPlaceholders) {
    const nameToIndex = new Map<string, number>();
    if (paramMap) {
      for (const [idxStr, paramName] of Object.entries(paramMap)) {
        nameToIndex.set(paramName, Number(idxStr));
      }
    }

    if (nameToIndex.size > 0) {
      const resolvedIndices: number[] = [];
      for (let i = 0; i < compiled.bindings.length; i++) {
        const b = compiled.bindings[i]!;
        if (b.kind === "named") {
          const idx = nameToIndex.get(b.name);
          if (idx === undefined) {
            throw new Error(
              `@Query on ${repoName}.${methodName}() references ":${b.name}", which has no matching @SqlParam("${b.name}") decorator.`,
            );
          }
          resolvedIndices.push(idx);
        } else {
          resolvedIndices.push(b.index);
        }
      }

      extractParams = (args) =>
        resolvedIndices.map((idx) => {
          const val = args[idx];
          return val === undefined ? null : val;
        });
    } else {
      const bindings = compiled.bindings;
      extractParams = (args) => {
        if (args.length === 1 && isPlainObject(args[0])) {
          const record = args[0];
          return bindings.map((b) => {
            if (b.kind === "named") {
              if (!(b.name in record)) {
                throw new Error(
                  `@Query on ${repoName}.${methodName}() is missing named parameter "${b.name}".`,
                );
              }
              const val = record[b.name];
              return val === undefined ? null : val;
            }
            const val = args[b.index];
            return val === undefined ? null : val;
          });
        }
        const names = bindings
          .filter(
            (b): b is { readonly kind: "named"; readonly name: string } =>
              b.kind === "named",
          )
          .map((b) => `:${b.name}`);
        throw new Error(
          `@Query on ${repoName}.${methodName}() uses named placeholders (${names.join(", ")}) without @SqlParam(...) decorators. Add @SqlParam(...) or pass a parameter object.`,
        );
      };
    }
  } else {
    const indices = compiled.bindings.map((b) =>
      b.kind === "positional" ? b.index : 0,
    );
    extractParams = (args) =>
      indices.map((idx) => {
        const val = args[idx];
        return val === undefined ? null : val;
      });
  }

  return async (host, args, compiledMeta) => {
    const params = extractParams(args);
    const driver = host.driver;
    switch (mode) {
      case "changes": {
        const res = await driver.execute(compiled.sql, params);
        return res.affectedRows;
      }
      case "void": {
        await driver.execute(compiled.sql, params);
        return undefined;
      }
      case "runResult": {
        const res: OrmQueryResult = await driver.execute(compiled.sql, params);
        return { ...res, changes: res.affectedRows };
      }
      case "count": {
        const res = await driver.query<Record<string, unknown>>(
          compiled.sql,
          params,
        );
        return Number(interpretScalarRow(res.rows[0] ?? null) ?? 0);
      }
      case "exists": {
        const res = await driver.query<Record<string, unknown>>(
          compiled.sql,
          params,
        );
        return interpretExistsRow(res.rows[0] ?? null);
      }
      case "scalar": {
        const res = await driver.query<Record<string, unknown>>(
          compiled.sql,
          params,
        );
        return interpretScalarRow(res.rows[0] ?? null);
      }
      case "one": {
        const res = await driver.query<Record<string, unknown>>(
          compiled.sql,
          params,
        );
        const row = res.rows[0] ?? null;
        if (row === null) return null;
        return shouldMapRows ? hydrateRow(row, compiledMeta, host) : row;
      }
      case "many":
      case "auto": {
        const res = await driver.query<Record<string, unknown>>(
          compiled.sql,
          params,
        );
        return shouldMapRows
          ? res.rows.map((r) => hydrateRow(r, compiledMeta, host))
          : [...res.rows];
      }
    }
  };
}

const RESERVED_NON_DERIVED_KEYS = new Set<PropertyKey>([
  "constructor",
  "then",
  "catch",
  "finally",
  "toJSON",
  "toString",
  "valueOf",
  "onModuleInit",
  "onApplicationBootstrap",
  "onModuleDestroy",
  "beforeApplicationShutdown",
  "onApplicationShutdown",
]);

/**
 * Compiles an `@Repository(...)` abstract class ONCE into a multi-dialect
 * repository factory with precompiled CRUD (`findById`, `findByIdOrFail`, `findAll`,
 * `save`, `saveMany`, `deleteById`, `count`, `existsById`), `@Query` / `@Modifying` /
 * `@SqlParam`, and cached derived query executors across ALL ORM dialects.
 */
export function compileOrmRepository<TRepo extends object>(
  RepoClass: Abstract<TRepo>,
): CompiledOrmRepositoryFactory<TRepo> {
  const meta = getOrmRepositoryMetadata(RepoClass);
  if (!meta) {
    throw new Error(
      `Declarative ORM repository "${RepoClass.name}" is missing @Repository(Entity) decorator metadata.`,
    );
  }

  const colMaps = buildColumnMaps(meta);
  const hydrateRow = createRowHydrator(meta, colMaps);
  const serializeEntity = createEntitySerializer(meta, colMaps);

  // Collect prototype chain and raw @Query declarations ONCE
  const protoChain: object[] = [];
  let cursor: object | null = (RepoClass.prototype as object | null) ?? null;
  while (
    cursor &&
    cursor !== Object.prototype &&
    cursor !== CrudRepository.prototype
  ) {
    protoChain.unshift(cursor);
    cursor = Object.getPrototypeOf(cursor) as object | null;
  }

  const rawQueryDeclarations = new Map<string, RawQueryDeclaration>();
  const methodProjections = new Map<string, readonly string[]>();
  const methodIgnoreScopes = new Map<string, IgnoreScopeSpec>();

  const repoScopes = getRepositoryScopes(RepoClass);
  const softDeleteConfig = getSoftDeleteConfig(RepoClass);
  const repoFragments = getRepositoryFragments(RepoClass);

  const dialectBundles = new Map<OrmDialect, CompiledDialectBundle>();

  const getDialectBundle = (dialect: OrmDialect): CompiledDialectBundle => {
    const existing = dialectBundles.get(dialect);
    if (existing) {
      return existing;
    }

    const profile = getDialectProfile(dialect);
    const tableRef = formatTableRef(meta.table, meta.schema, dialect);
    const quotedId = quoteIdentifier(meta.idColumn, dialect, "id column name");
    const p1 = formatPlaceholder(1, dialect);
    const limitOne = profile.formatLimitOffset(1, undefined, false);

    const findByIdSql = `SELECT * FROM ${tableRef} WHERE ${quotedId} = ${p1}${limitOne}`;
    const findAllSql = `SELECT * FROM ${tableRef}`;
    const deleteByIdSql = `DELETE FROM ${tableRef} WHERE ${quotedId} = ${p1}`;
    const countSql = `SELECT COUNT(*) AS count FROM ${tableRef}`;
    const existsByIdSql = `SELECT 1 AS found FROM ${tableRef} WHERE ${quotedId} = ${p1}${limitOne}`;

    const resolveColumn = (propOrCol: string): string => {
      const mapped =
        meta.columns[propOrCol] ??
        (meta.camelCaseMapping ? camelToSnake(propOrCol) : propOrCol);
      return assertSafeSqlIdentifier(mapped, `column for "${propOrCol}"`);
    };

    const serializeScopeValue = (colName: string, raw: unknown): unknown => {
      const colMeta = colMaps.byCol.get(colName);
      if (colMeta) {
        return toDbValue(colMeta, raw, dialect);
      }
      if (raw instanceof Date) {
        return raw.toISOString();
      }
      if (typeof raw === "boolean") {
        return profile.formatBooleanParam(raw);
      }
      return raw;
    };

    const getActiveScopes = (
      methodName: string,
      excludeScopes?: readonly string[],
    ): readonly RepositoryScopeDefinition<any>[] => {
      if (repoScopes.length === 0) {
        return [];
      }
      const methodIgnore = methodIgnoreScopes.get(methodName);
      const ambientIgnore = getAmbientIgnoredScopes();
      const active: RepositoryScopeDefinition<any>[] = [];
      for (let i = 0; i < repoScopes.length; i++) {
        const s = repoScopes[i]!;
        if (excludeScopes?.includes(s.name)) {
          continue;
        }
        if (isScopeIgnored(s.name, methodIgnore, ambientIgnore)) {
          continue;
        }
        active.push(s);
      }
      return active;
    };

    const evaluateScopesWhere = (
      driver: OrmDriverLike,
      operation: RepositoryScopeOperation,
      methodName: string,
      startParamIndex: number,
      excludeScopes?: readonly string[],
    ): { readonly sql: string; readonly params: readonly unknown[] } => {
      const activeScopes = getActiveScopes(methodName, excludeScopes);
      if (activeScopes.length === 0) {
        return { sql: "", params: [] };
      }

      let paramCounter = startParamIndex;
      const nextPh = () => formatPlaceholder(++paramCounter, dialect);
      const clauses: string[] = [];
      const params: unknown[] = [];

      for (let i = 0; i < activeScopes.length; i++) {
        const scope = activeScopes[i]!;
        if (!scope.where) {
          continue;
        }
        let phCalls = 0;
        const trackedNextPh = (): string => {
          phCalls++;
          return nextPh();
        };
        const scopeCtx: RepositoryScopeContext = {
          operation,
          methodName,
          dialect,
          table: meta.table,
          ...(meta.schema !== undefined ? { schema: meta.schema } : {}),
          tableRef,
          idColumn: meta.idColumn,
          idProperty: meta.idProperty,
          columns: meta.columns,
          camelCaseMapping: meta.camelCaseMapping,
          driver,
          quoteIdentifier: (id, ctx) => quoteIdentifier(id, dialect, ctx),
          formatPlaceholder: (idx) => formatPlaceholder(idx, dialect),
          nextPlaceholder: trackedNextPh,
          resolveColumn,
          serializeValue: serializeScopeValue,
          activeScopes,
          buildActiveScopesWhere: (opts) =>
            evaluateScopesWhere(
              driver,
              operation,
              methodName,
              opts?.startParamIndex ?? paramCounter,
              opts?.excludeScopes,
            ),
        };

        const res = scope.where(scopeCtx);
        if (res === null || res === undefined) {
          continue;
        }

        if (isScopeSqlFragment(res)) {
          const rawSql = res.sql.trim();
          if (rawSql.length === 0) {
            continue;
          }
          const rawParams = res.params ? [...res.params] : [];
          const finalSql =
            phCalls === 0 && rawParams.length > 0
              ? rewriteQuestionPlaceholders(rawSql, nextPh)
              : rawSql;
          clauses.push(hasTopLevelSqlOr(finalSql) ? `(${finalSql})` : finalSql);
          for (let k = 0; k < rawParams.length; k++) {
            params.push(rawParams[k]);
          }
        } else {
          for (const [key, val] of Object.entries(res)) {
            if (val === undefined) {
              continue;
            }
            const col = resolveColumn(key);
            const quotedCol = quoteIdentifier(col, dialect, "scope column");
            if (val === null) {
              clauses.push(`${quotedCol} IS NULL`);
            } else {
              clauses.push(`${quotedCol} = ${nextPh()}`);
              params.push(serializeScopeValue(col, val));
            }
          }
        }
      }

      return { sql: clauses.join(" AND "), params };
    };

    const saveOne = async (
      host: OrmDeclarativeHost,
      entity: unknown,
      compiledMeta?: CompiledEntityMetadata,
      methodName = "save",
    ): Promise<unknown> => {
      if (!entity || typeof entity !== "object") {
        throw new Error(`${RepoClass.name}.save() requires an entity object.`);
      }
      const driver = host.driver;

      // Apply active repository scopes' beforeSave hooks
      let workingEntity = entity as Record<string, unknown>;
      const activeScopes = getActiveScopes(methodName);
      if (activeScopes.length > 0) {
        let phCounter = 0;
        const scopeCtx: RepositoryScopeContext = {
          operation: "save",
          methodName,
          dialect,
          table: meta.table,
          ...(meta.schema !== undefined ? { schema: meta.schema } : {}),
          tableRef,
          idColumn: meta.idColumn,
          idProperty: meta.idProperty,
          columns: meta.columns,
          camelCaseMapping: meta.camelCaseMapping,
          driver,
          quoteIdentifier: (id, ctx) => quoteIdentifier(id, dialect, ctx),
          formatPlaceholder: (idx) => formatPlaceholder(idx, dialect),
          nextPlaceholder: () => formatPlaceholder(++phCounter, dialect),
          resolveColumn,
          serializeValue: serializeScopeValue,
          activeScopes,
          buildActiveScopesWhere: (opts) =>
            evaluateScopesWhere(
              driver,
              "save",
              methodName,
              opts?.startParamIndex ?? 0,
              opts?.excludeScopes,
            ),
        };
        for (let i = 0; i < activeScopes.length; i++) {
          const scope = activeScopes[i]!;
          if (scope.beforeSave) {
            const mutated = scope.beforeSave(workingEntity, scopeCtx);
            if (mutated && typeof mutated === "object") {
              workingEntity = mutated as Record<string, unknown>;
            }
          }
        }
      }

      const { idValue, entries, seenCols } = serializeEntity(
        workingEntity,
        dialect,
      );
      const now = new Date();

      const buildScopedReloadById = (
        idVal: unknown,
      ): { sql: string; params: unknown[] } => {
        const scopeWhere = evaluateScopesWhere(driver, "save", methodName, 1);
        if (!scopeWhere.sql) {
          return { sql: findByIdSql, params: [idVal] };
        }
        return {
          sql: `SELECT * FROM ${tableRef} WHERE ${quotedId} = ${p1} AND ${scopeWhere.sql}${limitOne}`,
          params: [idVal, ...scopeWhere.params],
        };
      };

      // Update path when an ID is provided
      if (idValue !== undefined && idValue !== null) {
        const userNonIdEntries = entries.filter((e) => e.col !== meta.idColumn);
        if (userNonIdEntries.length > 0) {
          const updateEntries = [...userNonIdEntries];
          for (let i = 0; i < colMaps.updatedAtCols.length; i++) {
            const uCol = colMaps.updatedAtCols[i]!;
            const colName = meta.columns[uCol.propertyName] ?? uCol.columnName;
            if (!seenCols.has(colName)) {
              updateEntries.push({
                col: colName,
                value: createAutoTimestampValue(uCol, now, dialect),
              });
            }
          }
          const assignments = updateEntries.map(
            (e, idx) =>
              `${quoteIdentifier(e.col, dialect, "column name")} = ${formatPlaceholder(idx + 1, dialect)}`,
          );
          const idPhIdx = updateEntries.length + 1;
          const idPh = formatPlaceholder(idPhIdx, dialect);
          const scopeWhere = evaluateScopesWhere(
            driver,
            "save",
            methodName,
            idPhIdx,
          );
          const extraScopeSql = scopeWhere.sql ? ` AND ${scopeWhere.sql}` : "";
          const updateParams = [
            ...updateEntries.map((e) => e.value),
            idValue,
            ...scopeWhere.params,
          ];

          if (profile.returningStyle === "returning") {
            const updated = await driver.query<Record<string, unknown>>(
              `UPDATE ${tableRef} SET ${assignments.join(", ")} WHERE ${quotedId} = ${idPh}${extraScopeSql} RETURNING *`,
              updateParams,
            );
            const row = updated.rows[0] ?? null;
            if (row !== null) {
              return hydrateRow(row, compiledMeta, host);
            }
          } else if (profile.returningStyle === "output") {
            const updated = await driver.query<Record<string, unknown>>(
              `UPDATE ${tableRef} SET ${assignments.join(", ")} OUTPUT INSERTED.* WHERE ${quotedId} = ${idPh}${extraScopeSql}`,
              updateParams,
            );
            const row = updated.rows[0] ?? null;
            if (row !== null) {
              return hydrateRow(row, compiledMeta, host);
            }
          } else {
            const updateRes = await driver.execute(
              `UPDATE ${tableRef} SET ${assignments.join(", ")} WHERE ${quotedId} = ${idPh}${extraScopeSql}`,
              updateParams,
            );
            if (updateRes.affectedRows > 0) {
              const reload = buildScopedReloadById(idValue);
              const reloaded = await driver.query<Record<string, unknown>>(
                reload.sql,
                reload.params,
              );
              const row = reloaded.rows[0] ?? null;
              if (row !== null) {
                return hydrateRow(row, compiledMeta, host);
              }
              const fallbackRow: Record<string, unknown> = {
                [meta.idColumn]: idValue,
              };
              for (const e of updateEntries) {
                fallbackRow[e.col] = e.value;
              }
              return hydrateRow(fallbackRow, compiledMeta, host);
            }
          }
        } else {
          const reload = buildScopedReloadById(idValue);
          const existing = await driver.query<Record<string, unknown>>(
            reload.sql,
            reload.params,
          );
          const row = existing.rows[0] ?? null;
          if (row !== null) {
            return hydrateRow(row, compiledMeta, host);
          }
        }
      }

      // Insert path
      const insertEntries = [...entries];
      const insertSeen = new Set(seenCols);
      const appendAutoColumn = (
        col: CompiledColumnMetadata,
        value: unknown,
      ): void => {
        const colName = meta.columns[col.propertyName] ?? col.columnName;
        if (insertSeen.has(colName)) {
          return;
        }
        insertSeen.add(colName);
        insertEntries.push({ col: colName, value });
      };

      for (let i = 0; i < colMaps.generatedNonIncrementPkCols.length; i++) {
        const pkCol = colMaps.generatedNonIncrementPkCols[i]!;
        const generatedId =
          pkCol.generationStrategy === "objectid"
            ? generateObjectId()
            : crypto.randomUUID();
        appendAutoColumn(pkCol, generatedId);
      }
      for (let i = 0; i < colMaps.createdAtCols.length; i++) {
        const cCol = colMaps.createdAtCols[i]!;
        appendAutoColumn(cCol, createAutoTimestampValue(cCol, now, dialect));
      }
      for (let i = 0; i < colMaps.updatedAtCols.length; i++) {
        const uCol = colMaps.updatedAtCols[i]!;
        appendAutoColumn(uCol, createAutoTimestampValue(uCol, now, dialect));
      }
      for (let i = 0; i < colMaps.dynamicDefaultCols.length; i++) {
        const dCol = colMaps.dynamicDefaultCols[i]!;
        const fn = dCol.default as () => unknown;
        const val = fn();
        if (val !== undefined) {
          appendAutoColumn(dCol, toDbValue(dCol, val, dialect));
        }
      }

      if (insertEntries.length === 0) {
        throw new Error(
          `${RepoClass.name}.save() cannot persist an empty object into table "${meta.table}".`,
        );
      }

      const cols = insertEntries
        .map((e) => quoteIdentifier(e.col, dialect, "column name"))
        .join(", ");
      const placeholders = insertEntries
        .map((_, idx) => formatPlaceholder(idx + 1, dialect))
        .join(", ");
      const values = insertEntries.map((e) => e.value);

      if (profile.returningStyle === "returning") {
        const inserted = await driver.query<Record<string, unknown>>(
          `INSERT INTO ${tableRef} (${cols}) VALUES (${placeholders}) RETURNING *`,
          values,
        );
        const row = inserted.rows[0] ?? null;
        if (row === null) {
          throw new Error(
            `${RepoClass.name}.save() did not return a row from table "${meta.table}".`,
          );
        }
        return hydrateRow(row, compiledMeta, host);
      }

      if (profile.returningStyle === "then-return") {
        const inserted = await driver.query<Record<string, unknown>>(
          `INSERT INTO ${tableRef} (${cols}) VALUES (${placeholders}) THEN RETURN *`,
          values,
        );
        const row = inserted.rows[0] ?? null;
        if (row !== null) {
          return hydrateRow(row, compiledMeta, host);
        }
      } else if (profile.returningStyle === "output") {
        const inserted = await driver.query<Record<string, unknown>>(
          `INSERT INTO ${tableRef} (${cols}) OUTPUT INSERTED.* VALUES (${placeholders})`,
          values,
        );
        const row = inserted.rows[0] ?? null;
        if (row !== null) {
          return hydrateRow(row, compiledMeta, host);
        }
      }

      const insertRes = await driver.execute(
        `INSERT INTO ${tableRef} (${cols}) VALUES (${placeholders})`,
        values,
      );
      const insertedId =
        idValue !== undefined && idValue !== null
          ? idValue
          : insertRes.lastInsertRowid;
      if (insertedId !== undefined && insertedId !== null) {
        const reload = buildScopedReloadById(insertedId);
        const reloaded = await driver.query<Record<string, unknown>>(
          reload.sql,
          reload.params,
        );
        const row = reloaded.rows[0] ?? null;
        if (row !== null) {
          return hydrateRow(row, compiledMeta, host);
        }
        const fallbackRow: Record<string, unknown> = {
          [meta.idColumn]: insertedId,
        };
        for (const e of insertEntries) {
          fallbackRow[e.col] = e.value;
        }
        return hydrateRow(fallbackRow, compiledMeta, host);
      }

      const fallbackRow: Record<string, unknown> = {};
      for (const e of insertEntries) {
        fallbackRow[e.col] = e.value;
      }
      return hydrateRow(fallbackRow, compiledMeta, host);
    };

    const findByIdProj = methodProjections.get("findById")
      ? compileProjection(methodProjections.get("findById")!, meta, dialect)
      : undefined;
    const findByIdOrFailProj = methodProjections.get("findByIdOrFail")
      ? compileProjection(
          methodProjections.get("findByIdOrFail")!,
          meta,
          dialect,
        )
      : undefined;
    const findAllProj = methodProjections.get("findAll")
      ? compileProjection(methodProjections.get("findAll")!, meta, dialect)
      : undefined;

    const baseCrud: Record<string, OrmMethodExecutor> = {
      findById: async (host, args, compiledMeta) => {
        const scopeWhere = evaluateScopesWhere(
          host.driver,
          "findById",
          "findById",
          1,
        );
        const selectExpr = findByIdProj ? findByIdProj.selectSql : "*";
        const scopeAnd = scopeWhere.sql ? ` AND ${scopeWhere.sql}` : "";
        const sql =
          !scopeWhere.sql && !findByIdProj
            ? findByIdSql
            : `SELECT ${selectExpr} FROM ${tableRef} WHERE ${quotedId} = ${p1}${scopeAnd}${limitOne}`;
        const params = scopeWhere.sql
          ? [args[0], ...scopeWhere.params]
          : [args[0]];
        const res = await host.driver.query<Record<string, unknown>>(
          sql,
          params,
        );
        const row = res.rows[0] ?? null;
        if (row === null) return null;
        return findByIdProj
          ? hydrateProjectedRow(row, findByIdProj, colMaps, compiledMeta)
          : hydrateRow(row, compiledMeta, host);
      },
      findByIdOrFail: async (host, args, compiledMeta) => {
        const scopeWhere = evaluateScopesWhere(
          host.driver,
          "findByIdOrFail",
          "findByIdOrFail",
          1,
        );
        const selectExpr = findByIdOrFailProj
          ? findByIdOrFailProj.selectSql
          : "*";
        const scopeAnd = scopeWhere.sql ? ` AND ${scopeWhere.sql}` : "";
        const sql =
          !scopeWhere.sql && !findByIdOrFailProj
            ? findByIdSql
            : `SELECT ${selectExpr} FROM ${tableRef} WHERE ${quotedId} = ${p1}${scopeAnd}${limitOne}`;
        const params = scopeWhere.sql
          ? [args[0], ...scopeWhere.params]
          : [args[0]];
        const res = await host.driver.query<Record<string, unknown>>(
          sql,
          params,
        );
        const row = res.rows[0] ?? null;
        if (row === null) {
          throw new EntityNotFoundError(meta.entity?.name ?? meta.table, {
            [meta.idProperty]: args[0],
          });
        }
        return findByIdOrFailProj
          ? hydrateProjectedRow(row, findByIdOrFailProj, colMaps, compiledMeta)
          : hydrateRow(row, compiledMeta, host);
      },
      findAll: async (host, _args, compiledMeta) => {
        const scopeWhere = evaluateScopesWhere(
          host.driver,
          "findAll",
          "findAll",
          0,
        );
        const selectExpr = findAllProj ? findAllProj.selectSql : "*";
        const scopeClause = scopeWhere.sql ? ` WHERE ${scopeWhere.sql}` : "";
        const sql =
          !scopeWhere.sql && !findAllProj
            ? findAllSql
            : `SELECT ${selectExpr} FROM ${tableRef}${scopeClause}`;
        const res = await host.driver.query<Record<string, unknown>>(
          sql,
          scopeWhere.params,
        );
        return findAllProj
          ? res.rows.map((r) =>
              hydrateProjectedRow(r, findAllProj, colMaps, compiledMeta),
            )
          : res.rows.map((r) => hydrateRow(r, compiledMeta, host));
      },
      save: async (host, args, compiledMeta) =>
        saveOne(host, args[0], compiledMeta, "save"),
      saveMany: async (host, args, compiledMeta) => {
        const list = args[0];
        if (!Array.isArray(list)) {
          throw new Error(
            `${RepoClass.name}.saveMany() requires an array of entities.`,
          );
        }
        if (list.length === 0) {
          return [];
        }
        return await host.driver.transaction(async () => {
          const saved: unknown[] = [];
          for (let i = 0; i < list.length; i++) {
            saved.push(await saveOne(host, list[i], compiledMeta, "saveMany"));
          }
          return saved;
        });
      },
      deleteById: async (host, args) => {
        const activeScopes = getActiveScopes("deleteById");
        const interceptors = activeScopes.filter(
          (s) => typeof s.onDeleteById === "function",
        );
        if (interceptors.length > 0) {
          let phCounter = 0;
          const scopeCtx: RepositoryScopeContext = {
            operation: "deleteById",
            methodName: "deleteById",
            dialect,
            table: meta.table,
            ...(meta.schema !== undefined ? { schema: meta.schema } : {}),
            tableRef,
            idColumn: meta.idColumn,
            idProperty: meta.idProperty,
            columns: meta.columns,
            camelCaseMapping: meta.camelCaseMapping,
            driver: host.driver,
            quoteIdentifier: (id, ctx) => quoteIdentifier(id, dialect, ctx),
            formatPlaceholder: (idx) => formatPlaceholder(idx, dialect),
            nextPlaceholder: () => formatPlaceholder(++phCounter, dialect),
            resolveColumn,
            serializeValue: serializeScopeValue,
            activeScopes,
            buildActiveScopesWhere: (opts) =>
              evaluateScopesWhere(
                host.driver,
                "deleteById",
                "deleteById",
                opts?.startParamIndex ?? 0,
                opts?.excludeScopes,
              ),
          };
          for (let i = 0; i < interceptors.length; i++) {
            await interceptors[i]!.onDeleteById!(args[0], scopeCtx);
          }
          return;
        }

        const scopeWhere = evaluateScopesWhere(
          host.driver,
          "deleteById",
          "deleteById",
          1,
        );
        if (!scopeWhere.sql) {
          await host.driver.execute(deleteByIdSql, [args[0]]);
          return;
        }
        await host.driver.execute(
          `DELETE FROM ${tableRef} WHERE ${quotedId} = ${p1} AND ${scopeWhere.sql}`,
          [args[0], ...scopeWhere.params],
        );
      },
      count: async (host) => {
        const scopeWhere = evaluateScopesWhere(
          host.driver,
          "count",
          "count",
          0,
        );
        const sql = scopeWhere.sql
          ? `SELECT COUNT(*) AS count FROM ${tableRef} WHERE ${scopeWhere.sql}`
          : countSql;
        const res = await host.driver.query<{
          count: number | bigint | string;
        }>(sql, scopeWhere.params);
        return Number(res.rows[0]?.count ?? 0);
      },
      existsById: async (host, args) => {
        const scopeWhere = evaluateScopesWhere(
          host.driver,
          "existsById",
          "existsById",
          1,
        );
        const sql = scopeWhere.sql
          ? `SELECT 1 AS found FROM ${tableRef} WHERE ${quotedId} = ${p1} AND ${scopeWhere.sql}${limitOne}`
          : existsByIdSql;
        const params = scopeWhere.sql
          ? [args[0], ...scopeWhere.params]
          : [args[0]];
        const res = await host.driver.query<Record<string, unknown>>(
          sql,
          params,
        );
        return res.rows.length > 0;
      },
      query: async (host, args) => {
        const compiled = compileAndBindRawSql(
          args[0] as string,
          args[1] as OrmSqlParams | undefined,
          dialect,
          rawSqlCache,
          RepoClass.name,
          "query",
        );
        const res = await host.driver.query<Record<string, unknown>>(
          compiled.sql,
          compiled.params,
        );
        return [...res.rows];
      },
      queryOne: async (host, args) => {
        const compiled = compileAndBindRawSql(
          args[0] as string,
          args[1] as OrmSqlParams | undefined,
          dialect,
          rawSqlCache,
          RepoClass.name,
          "queryOne",
        );
        const res = await host.driver.query<Record<string, unknown>>(
          compiled.sql,
          compiled.params,
        );
        return res.rows[0] ?? null;
      },
      execute: async (host, args) => {
        const compiled = compileAndBindRawSql(
          args[0] as string,
          args[1] as OrmSqlParams | undefined,
          dialect,
          rawSqlCache,
          RepoClass.name,
          "execute",
        );
        return host.driver.execute(compiled.sql, compiled.params);
      },
    };

    const rawSqlCache = new Map<string, CompiledRawSql>();

    const queryMethods = new Map<string, OrmMethodExecutor>();
    for (const [name, decl] of rawQueryDeclarations.entries()) {
      queryMethods.set(
        name,
        compileCustomQueryMethod(decl, dialect, hydrateRow, RepoClass.name),
      );
    }

    const derivedCache = new Map<string, OrmMethodExecutor>();
    let cachedOperatorVersion = getCustomQueryOperatorRegistryVersion();

    const executePageQuery = async (
      host: OrmDeclarativeHost,
      parsed: ParsedDerivedQuery,
      predicateArgs: readonly unknown[],
      pageable: Pageable,
      methodName: string,
      compiledProjection: CompiledProjection | undefined,
      compiledMeta?: CompiledEntityMetadata,
    ): Promise<Page<unknown>> => {
      const safePage = Math.max(1, Math.floor(pageable.page));
      const safeSize = Math.max(1, Math.floor(pageable.size));
      const offset = (safePage - 1) * safeSize;

      const { whereClause, params } = buildDerivedWhereAndParams(
        parsed,
        dialect,
        predicateArgs,
        methodName,
        colMaps,
        {
          evaluate: (startIdx) =>
            evaluateScopesWhere(host.driver, "derived", methodName, startIdx),
        },
      );

      let orderClause = "";
      let hasOrderBy = false;
      if (pageable.sort && pageable.sort.length > 0) {
        const parts = pageable.sort.map((s) => {
          const col = resolveColumn(s.property);
          const dir =
            s.direction && s.direction.toUpperCase() === "DESC"
              ? "DESC"
              : "ASC";
          return `${quoteIdentifier(col, dialect, "sort column")} ${dir}`;
        });
        orderClause = ` ORDER BY ${parts.join(", ")}`;
        hasOrderBy = true;
      } else if (parsed.orderBy.length > 0) {
        orderClause = ` ORDER BY ${parsed.orderBy.map((o) => `${quoteIdentifier(o.column, dialect, "orderBy column")} ${o.direction}`).join(", ")}`;
        hasOrderBy = true;
      }

      const limitOffsetClause = profile.formatLimitOffset(
        safeSize,
        offset,
        hasOrderBy,
      );
      const selectExpr = compiledProjection
        ? compiledProjection.selectSql
        : "*";
      const dataSql = `SELECT ${selectExpr} FROM ${tableRef}${whereClause}${orderClause}${limitOffsetClause}`;
      const countPageSql = `SELECT COUNT(*) AS count FROM ${tableRef}${whereClause}`;

      const [dataRes, countRes] = await Promise.all([
        host.driver.query<Record<string, unknown>>(dataSql, params),
        host.driver.query<{ count: number | bigint | string }>(
          countPageSql,
          params,
        ),
      ]);

      const total = Number(countRes.rows[0]?.count ?? 0);
      const totalPages = total === 0 ? 0 : Math.ceil(total / safeSize);
      const items = compiledProjection
        ? dataRes.rows.map((r) =>
            hydrateProjectedRow(r, compiledProjection, colMaps, compiledMeta),
          )
        : dataRes.rows.map((r) => hydrateRow(r, compiledMeta, host));

      return {
        items,
        total,
        page: safePage,
        size: safeSize,
        totalPages,
        hasNext: safePage < totalPages,
        hasPrevious: safePage > 1,
      };
    };

    const executeCursorQuery = async (
      host: OrmDeclarativeHost,
      parsed: ParsedDerivedQuery,
      predicateArgs: readonly unknown[],
      cursorPageable: CursorPageable,
      methodName: string,
      projectionFields: readonly string[] | undefined,
      compiledMeta?: CompiledEntityMetadata,
    ): Promise<CursorPage<unknown>> => {
      const limit = Math.max(1, Math.floor(cursorPageable.limit));
      const cursorField = cursorPageable.cursorField ?? meta.idProperty;
      const cursorCol = resolveColumn(cursorField);
      const quotedCursor = quoteIdentifier(cursorCol, dialect, "cursor column");
      const direction =
        cursorPageable.direction ??
        (parsed.orderBy[0]?.column === cursorCol
          ? parsed.orderBy[0]!.direction
          : "ASC");

      const compiledProjection = projectionFields
        ? compileProjection(projectionFields, meta, dialect, [cursorCol])
        : undefined;

      const hasCursor =
        cursorPageable.cursor !== undefined && cursorPageable.cursor !== null;

      const cursorOp = direction === "DESC" ? "<" : ">";
      const { whereClause, params } = buildDerivedWhereAndParams(
        parsed,
        dialect,
        predicateArgs,
        methodName,
        colMaps,
        {
          evaluate: (startIdx) =>
            evaluateScopesWhere(host.driver, "derived", methodName, startIdx),
        },
        hasCursor
          ? {
              build: (nextPh) => ({
                sql: `${quotedCursor} ${cursorOp} ${nextPh()}`,
                params: [serializeScopeValue(cursorCol, cursorPageable.cursor)],
              }),
            }
          : undefined,
      );

      const selectExpr = compiledProjection
        ? compiledProjection.selectSql
        : "*";
      const orderClause = ` ORDER BY ${quotedCursor} ${direction}`;
      const limitClause = profile.formatLimitOffset(limit + 1, undefined, true);
      const sql = `SELECT ${selectExpr} FROM ${tableRef}${whereClause}${orderClause}${limitClause}`;

      const res = await host.driver.query<Record<string, unknown>>(sql, params);
      const hasMore = res.rows.length > limit;
      const slice = hasMore ? res.rows.slice(0, limit) : res.rows;
      const items = compiledProjection
        ? slice.map((r) =>
            hydrateProjectedRow(r, compiledProjection, colMaps, compiledMeta),
          )
        : slice.map((r) => hydrateRow(r, compiledMeta, host));
      const lastRow = slice[slice.length - 1];
      const nextCursor =
        hasMore && lastRow !== undefined
          ? extractCursorValue(lastRow, cursorCol, cursorField)
          : null;

      return {
        items,
        nextCursor,
        hasMore,
        limit,
      };
    };

    const getOrCompileDerived = (
      methodName: string,
    ): OrmMethodExecutor | undefined => {
      const currentOpVersion = getCustomQueryOperatorRegistryVersion();
      if (currentOpVersion !== cachedOperatorVersion) {
        derivedCache.clear();
        cachedOperatorVersion = currentOpVersion;
      }

      const cached = derivedCache.get(methodName);
      if (cached) {
        return cached;
      }
      if (!isDerivedMethodName(methodName)) {
        return undefined;
      }
      const parsed = parseDerivedMethod(methodName, meta);
      const projectionFields = methodProjections.get(methodName);
      const compiledProjection = projectionFields
        ? compileProjection(projectionFields, meta, dialect)
        : undefined;

      const canUseStaticZeroArg =
        parsed.totalArgs === 0 &&
        repoScopes.length === 0 &&
        !compiledProjection &&
        parsed.action !== "findPage" &&
        parsed.action !== "findCursor";

      const staticZeroArgSql = canUseStaticZeroArg
        ? buildDerivedSqlAndParams(
            parsed,
            tableRef,
            dialect,
            [],
            methodName,
            colMaps,
          ).sql
        : undefined;

      const executor: OrmMethodExecutor = async (host, args, compiledMeta) => {
        if (parsed.action === "findPage") {
          const trailing = args[parsed.totalArgs];
          if (!isPageable(trailing)) {
            throw new Error(
              `Derived query "${methodName}" expects a trailing Pageable argument ({ page, size, sort? }).`,
            );
          }
          return executePageQuery(
            host,
            parsed,
            args.slice(0, parsed.totalArgs),
            trailing,
            methodName,
            compiledProjection,
            compiledMeta,
          );
        }

        if (parsed.action === "findCursor") {
          const trailing = args[parsed.totalArgs];
          if (!isCursorPageable(trailing)) {
            throw new Error(
              `Derived query "${methodName}" expects a trailing CursorPageable argument ({ limit, cursor?, cursorField?, direction? }).`,
            );
          }
          return executeCursorQuery(
            host,
            parsed,
            args.slice(0, parsed.totalArgs),
            trailing,
            methodName,
            projectionFields,
            compiledMeta,
          );
        }

        // Trailing Pageable / CursorPageable overload on findBy* / findAllBy* / findAllOrderBy*
        if (
          (parsed.action === "findAll" || parsed.action === "findOne") &&
          args.length === parsed.totalArgs + 1
        ) {
          const trailing = args[parsed.totalArgs];
          if (isPageable(trailing)) {
            return executePageQuery(
              host,
              parsed,
              args.slice(0, parsed.totalArgs),
              trailing,
              methodName,
              compiledProjection,
              compiledMeta,
            );
          }
          if (isCursorPageable(trailing)) {
            return executeCursorQuery(
              host,
              parsed,
              args.slice(0, parsed.totalArgs),
              trailing,
              methodName,
              projectionFields,
              compiledMeta,
            );
          }
        }

        const useStaticZeroArg =
          staticZeroArgSql !== undefined &&
          args.length === 0 &&
          getActiveScopes(methodName).length === 0;
        let sql: string;
        let params: unknown[];
        if (useStaticZeroArg) {
          sql = staticZeroArgSql;
          params = [];
        } else {
          const built = buildDerivedSqlAndParams(
            parsed,
            tableRef,
            dialect,
            args,
            methodName,
            colMaps,
            {
              ...(compiledProjection !== undefined
                ? { selectSql: compiledProjection.selectSql }
                : {}),
              scopeWhere: {
                evaluate: (startIdx) =>
                  evaluateScopesWhere(
                    host.driver,
                    "derived",
                    methodName,
                    startIdx,
                  ),
              },
            },
          );
          sql = built.sql;
          params = built.params;
        }

        switch (parsed.action) {
          case "findOne": {
            const res = await host.driver.query<Record<string, unknown>>(
              sql,
              params,
            );
            const row = res.rows[0] ?? null;
            if (row === null) return null;
            return compiledProjection
              ? hydrateProjectedRow(row, compiledProjection, colMaps, compiledMeta)
              : hydrateRow(row, compiledMeta, host);
          }
          case "findAll": {
            const res = await host.driver.query<Record<string, unknown>>(
              sql,
              params,
            );
            return compiledProjection
              ? res.rows.map((r) =>
                  hydrateProjectedRow(
                    r,
                    compiledProjection,
                    colMaps,
                    compiledMeta,
                  ),
                )
              : res.rows.map((r) => hydrateRow(r, compiledMeta, host));
          }
          case "exists": {
            const res = await host.driver.query<Record<string, unknown>>(
              sql,
              params,
            );
            return res.rows.length > 0;
          }
          case "count": {
            const res = await host.driver.query<{
              count: number | bigint | string;
            }>(sql, params);
            return Number(res.rows[0]?.count ?? 0);
          }
          case "delete": {
            const res = await host.driver.execute(sql, params);
            return res.affectedRows;
          }
        }
      };

      derivedCache.set(methodName, executor);
      return executor;
    };

    const bundle: CompiledDialectBundle = {
      baseCrud,
      queryMethods,
      derivedCache,
      tableRef,
      resolveColumn,
      serializeScopeValue,
      evaluateScopesWhere,
      getOrCompileDerived,
    };
    dialectBundles.set(dialect, bundle);
    return bundle;
  };

  return {
    metadata: meta,
    createInstance(host: OrmDeclarativeHost): TRepo {
      const effectiveDialect = meta.dialect ?? host.driver.dialect;
      const bundle = getDialectBundle(effectiveDialect);
      const getCompiledMeta = (): CompiledEntityMetadata | undefined =>
        meta.entity
          ? host.metadataGraph?.find(meta.entity as ObjectType)
          : undefined;

      // Instantiate inheriting from RepoClass.prototype so
      // `instance instanceof MyRepository` and `instance instanceof CrudRepository` are true!
      const target = Object.create(RepoClass.prototype) as Record<
        PropertyKey,
        unknown
      >;
      let proxyRef: object = target;
      const boundDerivedCache = new Map<string, Function>();
      let boundDerivedVersion = getCustomQueryOperatorRegistryVersion();

      const findProtoMethod = (methodName: string): Function | undefined => {
        for (let i = protoChain.length - 1; i >= 0; i--) {
          const desc = Object.getOwnPropertyDescriptor(
            protoChain[i]!,
            methodName,
          );
          if (desc && typeof desc.value === "function") {
            return desc.value as Function;
          }
        }
        const baseDesc = Object.getOwnPropertyDescriptor(
          CrudRepository.prototype,
          methodName,
        );
        if (baseDesc && typeof baseDesc.value === "function") {
          return baseDesc.value as Function;
        }
        return undefined;
      };

      const findSubclassConcreteMethod = (
        methodName: string,
      ): Function | undefined => {
        for (let i = protoChain.length - 1; i >= 0; i--) {
          const desc = Object.getOwnPropertyDescriptor(
            protoChain[i]!,
            methodName,
          );
          if (desc && typeof desc.value === "function") {
            return desc.value as Function;
          }
        }
        return undefined;
      };

      const bindWithMetadata = (
        name: string,
        fn: Function,
        protoMethod?: Function,
      ): void => {
        Object.defineProperty(fn, "name", {
          value: name,
          configurable: true,
        });
        if (protoMethod) {
          MetadataRegistry.copyMetadata(protoMethod, fn);
        }
        target[name] = fn;
      };

      // Bind base CRUD methods (unless genuinely overridden by @Query or concrete subclass method)
      for (const [name, executor] of Object.entries(bundle.baseCrud)) {
        if (bundle.queryMethods.has(name)) {
          continue;
        }
        const concreteOverride = findSubclassConcreteMethod(name);
        const hasDeclarativeDecorator =
          methodProjections.has(name) || methodIgnoreScopes.has(name);
        const isDecoratedStub =
          concreteOverride !== undefined &&
          hasDeclarativeDecorator &&
          isStubMethodBody(concreteOverride);

        if (!concreteOverride || isDecoratedStub) {
          const fn = (...args: unknown[]) =>
            executor(host, args, getCompiledMeta());
          bindWithMetadata(name, fn, findProtoMethod(name));
        } else if (methodIgnoreScopes.has(name)) {
          const ignoreSpec = methodIgnoreScopes.get(name)!;
          const wrapped = function (this: unknown, ...args: unknown[]) {
            return runWithIgnoredScopes(ignoreSpec, () =>
              concreteOverride.apply(this, args),
            );
          };
          bindWithMetadata(name, wrapped, concreteOverride);
        }
      }

      // Build shared runtime context for @SoftDelete convenience methods & composable fragments
      const fragmentCtx: RepositoryFragmentRuntimeContext<any> = {
        driver: host.driver,
        dialect: effectiveDialect,
        table: meta.table,
        ...(meta.schema !== undefined ? { schema: meta.schema } : {}),
        tableRef: bundle.tableRef,
        idColumn: meta.idColumn,
        idProperty: meta.idProperty,
        columns: meta.columns,
        camelCaseMapping: meta.camelCaseMapping,
        quoteIdentifier: (id, ctx) => quoteIdentifier(id, effectiveDialect, ctx),
        formatPlaceholder: (idx) => formatPlaceholder(idx, effectiveDialect),
        resolveColumn: bundle.resolveColumn,
        hydrateRow: (row) => hydrateRow(row, getCompiledMeta(), host),
        serializeValue: bundle.serializeScopeValue,
        buildActiveScopesWhere: (opts) =>
          bundle.evaluateScopesWhere(
            host.driver,
            "derived",
            opts?.methodName ?? "fragment",
            opts?.startParamIndex ?? 0,
            opts?.excludeScopes,
          ),
        ...(softDeleteConfig !== undefined ? { softDeleteConfig } : {}),
        getRepository: () => proxyRef,
      };

      const bindFragmentMethods = (methods: object): void => {
        for (const [name, impl] of Object.entries(methods)) {
          if (typeof impl !== "function") {
            continue;
          }
          if (bundle.queryMethods.has(name)) {
            continue;
          }
          const concreteOverride = findSubclassConcreteMethod(name);
          const isRealConcreteOverride =
            concreteOverride !== undefined && !isStubMethodBody(concreteOverride);
          if (isRealConcreteOverride) {
            continue;
          }
          const ignoreSpec = methodIgnoreScopes.get(name);
          const fnImpl = impl as (...args: unknown[]) => unknown;
          const wrapped = ignoreSpec
            ? (...args: unknown[]) =>
                runWithIgnoredScopes(ignoreSpec, () => fnImpl(...args))
            : (...args: unknown[]) => fnImpl(...args);
          bindWithMetadata(name, wrapped, findProtoMethod(name));
        }
      };

      // Attach implicit softDeleteById / restoreById / hardDeleteById when @SoftDelete() is active
      if (softDeleteConfig) {
        bindFragmentMethods(
          createSoftDeleteMethods(softDeleteConfig, fragmentCtx),
        );
      }

      // Attach composable repository fragment methods (withSoftDelete, withCursorPagination, custom)
      for (let i = 0; i < repoFragments.length; i++) {
        const frag = repoFragments[i]!;
        const fragMethods = frag.createMethods(fragmentCtx);
        bindFragmentMethods(fragMethods);
      }

      // Bind compiled @Query / @Modifying methods directly onto instance (preserving AOP metadata)
      for (const [name, executor] of bundle.queryMethods.entries()) {
        const ignoreSpec = methodIgnoreScopes.get(name);
        const fn = ignoreSpec
          ? (...args: unknown[]) =>
              runWithIgnoredScopes(ignoreSpec, () =>
                executor(host, args, getCompiledMeta()),
              )
          : (...args: unknown[]) => executor(host, args, getCompiledMeta());
        bindWithMetadata(name, fn, findProtoMethod(name));
      }

      // Bind prototype methods decorated with @Projection(...) or @IgnoreScope(...)
      const decoratedMethodNames = new Set<string>([
        ...methodProjections.keys(),
        ...methodIgnoreScopes.keys(),
      ]);
      for (const name of decoratedMethodNames) {
        if (Object.prototype.hasOwnProperty.call(target, name)) {
          continue;
        }
        const protoMethod = findSubclassConcreteMethod(name);
        const hasProjection = methodProjections.has(name);
        const ignoreSpec = methodIgnoreScopes.get(name);

        if (
          isDerivedMethodName(name) &&
          (hasProjection || (protoMethod !== undefined && isStubMethodBody(protoMethod)))
        ) {
          const fn = (...args: unknown[]) => {
            const derivedExecutor = bundle.getOrCompileDerived(name);
            if (!derivedExecutor) {
              throw new Error(
                `Unable to compile declarative method "${RepoClass.name}.${name}()".`,
              );
            }
            return derivedExecutor(host, args, getCompiledMeta());
          };
          bindWithMetadata(name, fn, protoMethod);
        } else if (protoMethod && ignoreSpec) {
          const wrapped = function (this: unknown, ...args: unknown[]) {
            return runWithIgnoredScopes(ignoreSpec, () =>
              protoMethod.apply(this, args),
            );
          };
          bindWithMetadata(name, wrapped, protoMethod);
        }
      }

      const proxy = new Proxy(target, {
        get(obj, prop, receiver) {
          if (typeof prop === "symbol" || RESERVED_NON_DERIVED_KEYS.has(prop)) {
            return Reflect.get(obj, prop, receiver);
          }

          if (prop in obj) {
            return Reflect.get(obj, prop, receiver);
          }

          const currentOpVersion = getCustomQueryOperatorRegistryVersion();
          if (currentOpVersion !== boundDerivedVersion) {
            boundDerivedCache.clear();
            boundDerivedVersion = currentOpVersion;
          }

          const cached = boundDerivedCache.get(prop);
          if (cached) {
            return cached;
          }

          const derivedExecutor = bundle.getOrCompileDerived(prop);
          if (derivedExecutor) {
            const fn = (...args: unknown[]) =>
              derivedExecutor(host, args, getCompiledMeta());
            Object.defineProperty(fn, "name", {
              value: prop,
              configurable: true,
            });
            const protoMethod = findProtoMethod(prop);
            if (protoMethod) {
              MetadataRegistry.copyMetadata(protoMethod, fn);
            }
            boundDerivedCache.set(prop, fn);
            return fn;
          }

          return undefined;
        },
        has(obj, prop) {
          if (
            typeof prop === "string" &&
            !RESERVED_NON_DERIVED_KEYS.has(prop)
          ) {
            if (prop in obj || isDerivedMethodName(prop)) {
              return true;
            }
          }
          return Reflect.has(obj, prop);
        },
      });

      proxyRef = proxy;
      return proxy as TRepo;
    },
  };
}
