import {
  DecoratorRegistry,
  MetadataRegistry,
  getEntityColumns,
  getEntitySchema,
  type Abstract,
  type EntityColumnMetadata,
  type Type,
} from "@bunest/common";
import { assertSafeSqlIdentifier, quoteSqlIdentifier } from "./identifiers";
import type {
  SqliteEntityMetadata,
  SqliteModifyingOptions,
  SqliteParamMetadataMap,
  SqliteParamValue,
  SqliteQueryExecutor,
  SqliteQueryMetadata,
  SqliteQueryOptions,
  SqliteQueryReturnMode,
  SqliteRepositoryMetadata,
  SqliteRepositoryOptions,
} from "./interfaces";
import {
  SQLITE_ENTITY_METADATA,
  SQLITE_MODIFYING_METADATA,
  SQLITE_PARAM_METADATA,
  SQLITE_QUERY_METADATA,
  SQLITE_REPOSITORY_METADATA,
} from "./tokens";

/**
 * Spring Data JPA-style abstract base repository for `@bunest/sqlite`.
 *
 * Subclass this as an `abstract class`, decorate with `@SqliteRepository(Entity)`
 * (or `@Repository(Entity)`), declare derived finder methods or `@Query(...)`
 * methods, and register via `SqliteModule.forFeature([MyRepository])`.
 */
export abstract class JpaRepository<TEntity, TKey = number> {
  abstract findById(id: TKey): Promise<TEntity | null>;
  abstract findAll(): Promise<TEntity[]>;
  abstract save(entity: Partial<TEntity>): Promise<TEntity>;
  abstract deleteById(id: TKey): Promise<void>;
  abstract count(): Promise<number>;
  abstract existsById(id: TKey): Promise<boolean>;
}

/**
 * Descriptive alias for `JpaRepository`.
 */
export const DeclarativeSqliteRepository = JpaRepository;

// ============================================================================
// Identifier, Naming & Pluralization Helpers
// ============================================================================

function camelToSnake(input: string): string {
  return input
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

function snakeToCamel(input: string): string {
  return input.replace(/_([a-z0-9])/g, (_, ch: string) => ch.toUpperCase());
}

function lowerFirst(input: string): string {
  if (input.length === 0) return input;
  return input[0]!.toLowerCase() + input.slice(1);
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

function inferTableNameFromEntity(
  entity: Function,
  pluralize: boolean,
): string {
  const snake = camelToSnake(entity.name || "entity");
  if (!pluralize) {
    return snake;
  }
  const parts = snake.split("_");
  const last = parts[parts.length - 1] ?? snake;
  parts[parts.length - 1] = pluralizeWord(last);
  return parts.join("_");
}

function escapeLikeValue(raw: unknown): string {
  return String(raw).replace(/[!%_]/g, "!$&");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// ============================================================================
// Decorators
// ============================================================================

/**
 * Marks an `abstract class` (or class) as a Spring Data-style declarative SQLite
 * repository compiled once by `SqliteModule.forFeature([MyRepository])`.
 *
 * Accepts an entity class, a raw table name, or a full `SqliteRepositoryOptions` config.
 */
export function SqliteRepository<TEntity = any>(
  entityOrOptions:
    | Type<TEntity>
    | Abstract<TEntity>
    | string
    | SqliteRepositoryOptions<TEntity>,
): ClassDecorator {
  const opts: SqliteRepositoryOptions<TEntity> =
    typeof entityOrOptions === "function"
      ? { entity: entityOrOptions }
      : typeof entityOrOptions === "string"
        ? { table: entityOrOptions }
        : entityOrOptions;

  const entity = opts.entity;
  const entitySchema = entity ? getEntitySchema(entity) : undefined;
  const entityColumns = entity ? getEntityColumns(entity) : [];
  const entityMeta = entity
    ? MetadataRegistry.get<SqliteEntityMetadata>(SQLITE_ENTITY_METADATA, entity)
    : undefined;

  const pluralize = opts.pluralizeTableName ?? true;
  const table =
    opts.table ??
    entitySchema?.tableName ??
    entityMeta?.tableName ??
    (entity ? inferTableNameFromEntity(entity, pluralize) : "");

  if (!table) {
    throw new Error(
      `@SqliteRepository() requires either an entity class or an explicit "table" name.`,
    );
  }

  const pkColumn =
    entitySchema?.primaryKey ?? entityColumns.find((col) => col.primary);
  const idColumn = opts.idColumn ?? pkColumn?.name ?? entityMeta?.idColumn ?? "id";
  assertSafeSqlIdentifier(table, "table name");
  assertSafeSqlIdentifier(idColumn, "id column name");

  const columns: Record<string, string> = {};
  for (let i = 0; i < entityColumns.length; i++) {
    const col = entityColumns[i]!;
    assertSafeSqlIdentifier(
      col.name,
      `column mapping for "${col.propertyName}"`,
    );
    columns[col.propertyName] = col.name;
  }
  if (opts.columns) {
    for (const [prop, col] of Object.entries(opts.columns)) {
      assertSafeSqlIdentifier(col, `column mapping for "${prop}"`);
      columns[prop] = col;
    }
  }

  const camelCaseMapping =
    opts.camelCaseMapping ?? entitySchema?.camelCaseMapping ?? true;
  const idProperty =
    opts.idProperty ??
    (opts.idColumn === undefined && pkColumn !== undefined
      ? pkColumn.propertyName
      : camelCaseMapping
        ? snakeToCamel(idColumn)
        : idColumn);

  const metadata: SqliteRepositoryMetadata<TEntity> = {
    ...(entity !== undefined ? { entity } : {}),
    table,
    idColumn,
    idProperty,
    columns,
    ...(opts.connectionName !== undefined
      ? { connectionName: opts.connectionName }
      : {}),
    camelCaseMapping,
    ...(opts.mapRow !== undefined ? { mapRow: opts.mapRow } : {}),
  };

  return (target) => {
    MetadataRegistry.define(SQLITE_REPOSITORY_METADATA, metadata, target);
    DecoratorRegistry.register("sqlite-repository", target, metadata);
  };
}

/**
 * Spring Data-style alias for `@SqliteRepository(...)`.
 */
export const Repository = SqliteRepository;

/**
 * Binds a parameterized custom SQL query (`:name` or `?` placeholders) to a
 * declarative repository method. Compiled once at registration time with zero
 * string interpolation of runtime arguments.
 */
export function Query(
  sql: string,
  options?: SqliteQueryOptions,
): MethodDecorator {
  if (typeof sql !== "string" || sql.trim().length === 0) {
    throw new Error("@Query() requires a non-empty SQL string.");
  }
  const metadata: SqliteQueryMetadata = {
    sql,
    ...(options !== undefined ? { options } : {}),
  };
  return (target, propertyKey, descriptor) => {
    MetadataRegistry.define(
      SQLITE_QUERY_METADATA,
      metadata,
      target,
      propertyKey,
    );
    return descriptor;
  };
}

/**
 * Disambiguated alias for `@Query(...)`.
 */
export const SqliteQuery = Query;

/**
 * Marks a `@Query(...)` repository method as a write statement (`INSERT`, `UPDATE`, `DELETE`).
 * Returns affected row count (`changes`) by default, or `void` / `SqliteRunResult` via options.
 */
export function Modifying(options?: SqliteModifyingOptions): MethodDecorator {
  const normalized: SqliteModifyingOptions = options ?? {};
  return (target, propertyKey, descriptor) => {
    MetadataRegistry.define(
      SQLITE_MODIFYING_METADATA,
      normalized,
      target,
      propertyKey,
    );
    return descriptor;
  };
}

/**
 * Binds a repository method parameter index to a named `:name` placeholder in `@Query(sql)`.
 */
export function SqlParam(name: string): ParameterDecorator {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(
      `Invalid @SqlParam("${name}"): parameter name must match /^[A-Za-z_][A-Za-z0-9_]*$/.`,
    );
  }
  return (target, propertyKey, parameterIndex) => {
    if (propertyKey === undefined) {
      return;
    }
    const existing =
      MetadataRegistry.getOwn<SqliteParamMetadataMap>(
        SQLITE_PARAM_METADATA,
        target,
        propertyKey,
      ) ?? {};
    MetadataRegistry.define(
      SQLITE_PARAM_METADATA,
      { ...existing, [parameterIndex]: name },
      target,
      propertyKey,
    );
  };
}

/**
 * Spring Data-style alias for `@SqlParam(name)`.
 */
export const Param = SqlParam;

// ============================================================================
// Inspection Helpers
// ============================================================================

export function getSqliteRepositoryMetadata(
  target: Function,
): SqliteRepositoryMetadata | undefined {
  return MetadataRegistry.get<SqliteRepositoryMetadata>(
    SQLITE_REPOSITORY_METADATA,
    target,
  );
}

export function isDeclarativeSqliteRepository(target: unknown): boolean {
  if (typeof target !== "function") {
    return false;
  }
  return (
    MetadataRegistry.has(SQLITE_REPOSITORY_METADATA, target) ||
    target.prototype instanceof JpaRepository
  );
}

// ============================================================================
// SQL Placeholder Scanner (Skips Quotes, Comments & ::casts)
// ============================================================================

interface CompiledQueryTemplate {
  readonly sql: string;
  readonly namedBindings: readonly string[];
  readonly hasNamedPlaceholders: boolean;
}

function compileSqliteNamedSql(rawSql: string): CompiledQueryTemplate {
  let out = "";
  const namedBindings: string[] = [];
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

    // PostgreSQL type cast ::type (skip both colons)
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
      namedBindings.push(paramName);
      out += "?";
      i = j;
      continue;
    }

    out += ch;
    i++;
  }

  return {
    sql: out,
    namedBindings,
    hasNamedPlaceholders: namedBindings.length > 0,
  };
}

// ============================================================================
// Derived Query Parser & Compiler
// ============================================================================

type DerivedAction = "findOne" | "findAll" | "exists" | "count" | "delete";

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
  | "isFalse";

interface ParsedPredicate {
  readonly combinator: "AND" | "OR" | null;
  readonly column: string;
  readonly quotedColumn: string;
  readonly operator: DerivedOperator;
  readonly ignoreCase: boolean;
  readonly argCount: number;
}

interface ParsedOrderBy {
  readonly quotedColumn: string;
  readonly direction: "ASC" | "DESC";
}

interface ParsedDerivedQuery {
  readonly action: DerivedAction;
  readonly limit?: number;
  readonly predicates: readonly ParsedPredicate[];
  readonly orderBy: readonly ParsedOrderBy[];
  readonly totalArgs: number;
  readonly hasDynamicIn: boolean;
}

const DERIVED_OPERATOR_SUFFIXES: ReadonlyArray<{
  readonly suffix: string;
  readonly operator: DerivedOperator;
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
  /^(?:findAllBy|findOneBy|findFirst(\d*)By|findTop(\d+)By|findBy|findAllOrderBy|existsBy|countBy|deleteBy|removeBy)/;

function isDerivedMethodName(name: string): boolean {
  return DERIVED_METHOD_PREFIX.test(name);
}

function resolvePropertyColumn(
  propSegment: string,
  meta: SqliteRepositoryMetadata,
): { column: string; quotedColumn: string } {
  const propName = lowerFirst(propSegment);
  const mapped =
    meta.columns[propName] ??
    meta.columns[propSegment] ??
    (meta.camelCaseMapping ? camelToSnake(propName) : propName);
  const safe = assertSafeSqlIdentifier(mapped, `column for "${propName}"`);
  return { column: safe, quotedColumn: quoteSqlIdentifier(safe, "column name") };
}

function parseOrderByPart(
  orderByPart: string,
  meta: SqliteRepositoryMetadata,
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
    const { quotedColumn } = resolvePropertyColumn(propSeg, meta);
    items.push({ quotedColumn, direction: dir });
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < orderByPart.length) {
    const trailing = orderByPart.slice(lastIndex);
    if (!/^[A-Z][A-Za-z0-9]*$/.test(trailing)) {
      throw new Error(
        `Unable to parse OrderBy clause "${orderByPart}" in derived query "${methodName}".`,
      );
    }
    const { quotedColumn } = resolvePropertyColumn(trailing, meta);
    items.push({ quotedColumn, direction: "ASC" });
  }

  if (items.length === 0) {
    throw new Error(
      `Empty OrderBy clause in derived query "${methodName}".`,
    );
  }

  return items;
}

function parseSinglePredicate(
  rawSegment: string,
  combinator: "AND" | "OR" | null,
  meta: SqliteRepositoryMetadata,
  methodName: string,
): ParsedPredicate {
  let segment = rawSegment;
  let ignoreCase = false;

  if (segment.endsWith("IgnoreCase") && segment.length > "IgnoreCase".length) {
    ignoreCase = true;
    segment = segment.slice(0, -"IgnoreCase".length);
  }

  let operator: DerivedOperator = "eq";
  let argCount = 1;
  let propPart = segment;

  for (let i = 0; i < DERIVED_OPERATOR_SUFFIXES.length; i++) {
    const entry = DERIVED_OPERATOR_SUFFIXES[i]!;
    if (
      segment.endsWith(entry.suffix) &&
      segment.length > entry.suffix.length
    ) {
      propPart = segment.slice(0, -entry.suffix.length);
      operator = entry.operator;
      argCount = entry.argCount;
      break;
    }
  }

  if (propPart.length === 0) {
    throw new Error(
      `Missing property name in predicate "${rawSegment}" of derived query "${methodName}".`,
    );
  }

  const { column, quotedColumn } = resolvePropertyColumn(propPart, meta);
  return {
    combinator,
    column,
    quotedColumn,
    operator,
    ignoreCase,
    argCount,
  };
}

function parseDerivedMethod(
  methodName: string,
  meta: SqliteRepositoryMetadata,
): ParsedDerivedQuery {
  let action: DerivedAction;
  let limit: number | undefined;
  let remainder: string;
  let orderByOnly = false;

  if (methodName.startsWith("findAllOrderBy")) {
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

  if (orderByOnly) {
    const orderBy = parseOrderByPart(remainder, meta, methodName);
    return {
      action,
      limit,
      predicates: [],
      orderBy,
      totalArgs: 0,
      hasDynamicIn: false,
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

  const tokens = criteriaPart.split(/(And|Or)(?=[A-Z])/);
  const predicates: ParsedPredicate[] = [];
  let pendingCombinator: "AND" | "OR" | null = null;
  let totalArgs = 0;
  let hasDynamicIn = false;

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
    const pred = parseSinglePredicate(tok, pendingCombinator, meta, methodName);
    predicates.push(pred);
    totalArgs += pred.argCount;
    if (pred.operator === "in" || pred.operator === "notIn") {
      hasDynamicIn = true;
    }
    pendingCombinator = null;
  }

  if (predicates.length === 0) {
    throw new Error(
      `No predicates parsed in derived query "${methodName}".`,
    );
  }

  return {
    action,
    limit,
    predicates,
    orderBy,
    totalArgs,
    hasDynamicIn,
  };
}

interface ResolvedEntityColumnMaps {
  readonly columns: readonly EntityColumnMetadata[];
  readonly byProp: ReadonlyMap<string, EntityColumnMetadata>;
  readonly byCol: ReadonlyMap<string, EntityColumnMetadata>;
  readonly createdAtCols: readonly EntityColumnMetadata[];
  readonly updatedAtCols: readonly EntityColumnMetadata[];
  readonly uuidPrimaryCols: readonly EntityColumnMetadata[];
  readonly dynamicDefaultCols: readonly EntityColumnMetadata[];
}

function buildEntityColumnMaps(
  meta: SqliteRepositoryMetadata,
): ResolvedEntityColumnMaps {
  const columns = meta.entity ? getEntityColumns(meta.entity) : [];
  const byProp = new Map<string, EntityColumnMetadata>();
  const byCol = new Map<string, EntityColumnMetadata>();
  const createdAtCols: EntityColumnMetadata[] = [];
  const updatedAtCols: EntityColumnMetadata[] = [];
  const uuidPrimaryCols: EntityColumnMetadata[] = [];
  const dynamicDefaultCols: EntityColumnMetadata[] = [];

  for (let i = 0; i < columns.length; i++) {
    const col = columns[i]!;
    const effectiveColName = meta.columns[col.propertyName] ?? col.name;
    byProp.set(col.propertyName, col);
    byCol.set(effectiveColName, col);
    if (col.createdAt) {
      createdAtCols.push(col);
    }
    if (col.updatedAt) {
      updatedAtCols.push(col);
    }
    if (col.primary && col.generated && col.generationStrategy === "uuid") {
      uuidPrimaryCols.push(col);
    }
    if (col.hasDefault && typeof col.default === "function") {
      dynamicDefaultCols.push(col);
    }
  }

  return {
    columns,
    byProp,
    byCol,
    createdAtCols,
    updatedAtCols,
    uuidPrimaryCols,
    dynamicDefaultCols,
  };
}

function hydrateSqliteColumnValue(
  col: EntityColumnMetadata,
  rawVal: unknown,
): unknown {
  if (rawVal === null || rawVal === undefined) {
    return rawVal;
  }
  if (col.transformer) {
    return col.transformer.from(rawVal);
  }
  switch (col.type) {
    case "boolean": {
      if (typeof rawVal === "boolean") return rawVal;
      if (typeof rawVal === "number") return rawVal !== 0;
      if (typeof rawVal === "bigint") return rawVal !== 0n;
      if (typeof rawVal === "string") {
        const lower = rawVal.toLowerCase();
        return rawVal !== "0" && lower !== "false" && rawVal.length > 0;
      }
      return Boolean(rawVal);
    }
    case "json": {
      if (typeof rawVal === "string") {
        return JSON.parse(rawVal);
      }
      if (rawVal instanceof Uint8Array) {
        return JSON.parse(new TextDecoder().decode(rawVal));
      }
      return rawVal;
    }
    case "datetime": {
      if (rawVal instanceof Date) return rawVal;
      if (typeof rawVal === "string" || typeof rawVal === "number") {
        const d = new Date(rawVal);
        return Number.isNaN(d.getTime()) ? rawVal : d;
      }
      return rawVal;
    }
    case "bigint": {
      if (typeof rawVal === "bigint") return rawVal;
      if (
        col.designType === BigInt &&
        (typeof rawVal === "number" || typeof rawVal === "string")
      ) {
        return BigInt(rawVal);
      }
      return rawVal;
    }
    default:
      return rawVal;
  }
}

function serializeSqliteColumnValue(
  col: EntityColumnMetadata,
  rawVal: unknown,
): SqliteParamValue {
  if (rawVal === null) {
    return null;
  }
  if (col.transformer) {
    return col.transformer.to(rawVal) as SqliteParamValue;
  }
  switch (col.type) {
    case "boolean":
      return rawVal ? 1 : 0;
    case "json":
      return JSON.stringify(rawVal);
    case "datetime":
      if (rawVal instanceof Date) return rawVal.toISOString();
      if (typeof rawVal === "number") return new Date(rawVal).toISOString();
      return rawVal as SqliteParamValue;
    default:
      return rawVal as SqliteParamValue;
  }
}

function createAutoTimestampSqliteValue(
  col: EntityColumnMetadata,
  now: Date,
): SqliteParamValue {
  if (col.transformer) {
    return col.transformer.to(now) as SqliteParamValue;
  }
  if (col.type === "integer" || col.type === "bigint") {
    return now.getTime();
  }
  return serializeSqliteColumnValue(col, now);
}

function buildDerivedSqlAndParams(
  parsed: ParsedDerivedQuery,
  quotedTable: string,
  args: readonly unknown[],
  methodName: string,
  colMaps: ResolvedEntityColumnMaps,
): { sql: string; params: SqliteParamValue[] } {
  if (args.length < parsed.totalArgs) {
    throw new Error(
      `Derived query "${methodName}" expects at least ${parsed.totalArgs} argument(s), received ${args.length}.`,
    );
  }

  const whereParts: string[] = [];
  const params: SqliteParamValue[] = [];
  let argCursor = 0;

  const serializeArg = (
    colName: string,
    raw: unknown,
  ): SqliteParamValue => {
    const colMeta = colMaps.byCol.get(colName);
    if (!colMeta) {
      return raw as SqliteParamValue;
    }
    return serializeSqliteColumnValue(colMeta, raw);
  };

  for (let i = 0; i < parsed.predicates.length; i++) {
    const p = parsed.predicates[i]!;
    const prefix = p.combinator ? ` ${p.combinator} ` : "";
    const colExpr = p.ignoreCase ? `LOWER(${p.quotedColumn})` : p.quotedColumn;
    const paramExpr = p.ignoreCase ? "LOWER(?)" : "?";

    switch (p.operator) {
      case "isNull":
        whereParts.push(`${prefix}${p.quotedColumn} IS NULL`);
        break;
      case "isNotNull":
        whereParts.push(`${prefix}${p.quotedColumn} IS NOT NULL`);
        break;
      case "isTrue":
        whereParts.push(`${prefix}${p.quotedColumn} = 1`);
        break;
      case "isFalse":
        whereParts.push(`${prefix}${p.quotedColumn} = 0`);
        break;
      case "eq": {
        const raw = args[argCursor++];
        if (raw === null) {
          whereParts.push(`${prefix}${p.quotedColumn} IS NULL`);
        } else {
          whereParts.push(`${prefix}${colExpr} = ${paramExpr}`);
          params.push(serializeArg(p.column, raw));
        }
        break;
      }
      case "ne": {
        const raw = args[argCursor++];
        if (raw === null) {
          whereParts.push(`${prefix}${p.quotedColumn} IS NOT NULL`);
        } else {
          whereParts.push(`${prefix}${colExpr} <> ${paramExpr}`);
          params.push(serializeArg(p.column, raw));
        }
        break;
      }
      case "gt": {
        const raw = args[argCursor++];
        whereParts.push(`${prefix}${p.quotedColumn} > ?`);
        params.push(serializeArg(p.column, raw));
        break;
      }
      case "gte": {
        const raw = args[argCursor++];
        whereParts.push(`${prefix}${p.quotedColumn} >= ?`);
        params.push(serializeArg(p.column, raw));
        break;
      }
      case "lt": {
        const raw = args[argCursor++];
        whereParts.push(`${prefix}${p.quotedColumn} < ?`);
        params.push(serializeArg(p.column, raw));
        break;
      }
      case "lte": {
        const raw = args[argCursor++];
        whereParts.push(`${prefix}${p.quotedColumn} <= ?`);
        params.push(serializeArg(p.column, raw));
        break;
      }
      case "between": {
        const low = args[argCursor++];
        const high = args[argCursor++];
        whereParts.push(`${prefix}${p.quotedColumn} BETWEEN ? AND ?`);
        params.push(serializeArg(p.column, low), serializeArg(p.column, high));
        break;
      }
      case "containing": {
        const val = args[argCursor++];
        whereParts.push(`${prefix}${colExpr} LIKE ${paramExpr} ESCAPE '!'`);
        params.push(`%${escapeLikeValue(val)}%`);
        break;
      }
      case "notContaining": {
        const val = args[argCursor++];
        whereParts.push(
          `${prefix}${colExpr} NOT LIKE ${paramExpr} ESCAPE '!'`,
        );
        params.push(`%${escapeLikeValue(val)}%`);
        break;
      }
      case "startsWith": {
        const val = args[argCursor++];
        whereParts.push(`${prefix}${colExpr} LIKE ${paramExpr} ESCAPE '!'`);
        params.push(`${escapeLikeValue(val)}%`);
        break;
      }
      case "endsWith": {
        const val = args[argCursor++];
        whereParts.push(`${prefix}${colExpr} LIKE ${paramExpr} ESCAPE '!'`);
        params.push(`%${escapeLikeValue(val)}`);
        break;
      }
      case "like": {
        const val = args[argCursor++] as SqliteParamValue;
        whereParts.push(`${prefix}${colExpr} LIKE ${paramExpr}`);
        params.push(val);
        break;
      }
      case "notLike": {
        const val = args[argCursor++] as SqliteParamValue;
        whereParts.push(`${prefix}${colExpr} NOT LIKE ${paramExpr}`);
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
          const placeholders = rawList.map(() => "?").join(", ");
          const opSql = p.operator === "in" ? "IN" : "NOT IN";
          whereParts.push(
            `${prefix}${p.quotedColumn} ${opSql} (${placeholders})`,
          );
          for (let k = 0; k < rawList.length; k++) {
            params.push(serializeArg(p.column, rawList[k]));
          }
        }
        break;
      }
    }
  }

  const whereClause =
    whereParts.length > 0 ? ` WHERE ${whereParts.join("")}` : "";
  const orderClause =
    parsed.orderBy.length > 0
      ? ` ORDER BY ${parsed.orderBy.map((o) => `${o.quotedColumn} ${o.direction}`).join(", ")}`
      : "";
  const limitClause =
    parsed.limit !== undefined ? ` LIMIT ${parsed.limit}` : "";

  let sql: string;
  switch (parsed.action) {
    case "findOne":
    case "findAll":
      sql = `SELECT * FROM ${quotedTable}${whereClause}${orderClause}${limitClause}`;
      break;
    case "exists":
      sql = `SELECT 1 AS found FROM ${quotedTable}${whereClause} LIMIT 1`;
      break;
    case "count":
      sql = `SELECT COUNT(*) AS count FROM ${quotedTable}${whereClause}`;
      break;
    case "delete":
      sql = `DELETE FROM ${quotedTable}${whereClause}`;
      break;
  }

  return { sql, params };
}

// ============================================================================
// Compiled Repository Factory
// ============================================================================

export interface CompiledSqliteRepositoryFactory<TRepo extends object = object> {
  readonly metadata: SqliteRepositoryMetadata;
  createInstance(sqlite: SqliteQueryExecutor): TRepo;
}

type CompiledMethodExecutor = (
  sqlite: SqliteQueryExecutor,
  args: readonly unknown[],
) => unknown;

function inferQueryMode(
  methodName: string,
  sql: string,
  queryOptions: SqliteQueryOptions | undefined,
  modifyingOptions: SqliteModifyingOptions | undefined,
): SqliteQueryReturnMode {
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
  const hasReturning = /\bRETURNING\b/i.test(sql);
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
  meta: SqliteRepositoryMetadata<TEntity>,
  colMaps: ResolvedEntityColumnMaps,
): (row: Record<string, unknown>) => TEntity {
  if (meta.mapRow) {
    return meta.mapRow;
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

  return (row: Record<string, unknown>): TEntity => {
    const mapped: Record<string, unknown> = entityProto
      ? (Object.create(entityProto) as Record<string, unknown>)
      : {};
    for (const [col, rawVal] of Object.entries(row)) {
      const colMeta = hasSchemaColumns ? colMaps.byCol.get(col) : undefined;
      const val = colMeta ? hydrateSqliteColumnValue(colMeta, rawVal) : rawVal;
      const explicitProp = reverseColumns.get(col);
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
  meta: SqliteRepositoryMetadata,
  colMaps: ResolvedEntityColumnMaps,
): (entity: Record<string, unknown>) => {
  idValue: SqliteParamValue | undefined;
  entries: Array<{ col: string; quotedCol: string; value: SqliteParamValue }>;
  seenCols: Set<string>;
} {
  const hasSchemaColumns = colMaps.byProp.size > 0 || colMaps.byCol.size > 0;

  return (entity: Record<string, unknown>) => {
    let idValue: SqliteParamValue | undefined;
    const entries: Array<{
      col: string;
      quotedCol: string;
      value: SqliteParamValue;
    }> = [];
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
      const val = colMeta
        ? serializeSqliteColumnValue(colMeta, rawVal)
        : (rawVal as SqliteParamValue);
      if (col === meta.idColumn || prop === meta.idProperty) {
        idValue = val;
      }
      entries.push({
        col,
        quotedCol: quoteSqlIdentifier(col, "column name"),
        value: val,
      });
    }

    return { idValue, entries, seenCols };
  };
}

function compileCustomQueryMethod(
  methodName: string,
  queryMeta: SqliteQueryMetadata,
  modifyingMeta: SqliteModifyingOptions | undefined,
  paramMap: SqliteParamMetadataMap | undefined,
  hydrateRow: (row: Record<string, unknown>) => unknown,
  repoName: string,
): CompiledMethodExecutor {
  const compiled = compileSqliteNamedSql(queryMeta.sql);
  const mode = inferQueryMode(
    methodName,
    queryMeta.sql,
    queryMeta.options,
    modifyingMeta,
  );
  const shouldMapRows =
    queryMeta.options?.mapRows ?? (mode === "one" || mode === "many");
  const isSync = queryMeta.options?.sync === true;

  // Build compile-time parameter extraction plan
  let extractParams: (args: readonly unknown[]) => SqliteParamValue[] | undefined;

  if (compiled.hasNamedPlaceholders) {
    const nameToIndex = new Map<string, number>();
    if (paramMap) {
      for (const [idxStr, paramName] of Object.entries(paramMap)) {
        nameToIndex.set(paramName, Number(idxStr));
      }
    }

    const hasExplicitParams = nameToIndex.size > 0;
    if (hasExplicitParams) {
      const bindingIndices: number[] = [];
      for (let i = 0; i < compiled.namedBindings.length; i++) {
        const name = compiled.namedBindings[i]!;
        const idx = nameToIndex.get(name);
        if (idx === undefined) {
          throw new Error(
            `@Query on ${repoName}.${methodName}() references ":${name}", which has no matching @SqlParam("${name}") decorator.`,
          );
        }
        bindingIndices.push(idx);
      }

      extractParams = (args) => {
        const out: SqliteParamValue[] = new Array(bindingIndices.length);
        for (let i = 0; i < bindingIndices.length; i++) {
          const val = args[bindingIndices[i]!];
          out[i] = (val === undefined ? null : val) as SqliteParamValue;
        }
        return out;
      };
    } else {
      const names = compiled.namedBindings;
      extractParams = (args) => {
        if (args.length === 1 && isPlainRecord(args[0])) {
          const record = args[0];
          return names.map((name) => {
            if (!(name in record)) {
              throw new Error(
                `@Query on ${repoName}.${methodName}() is missing named parameter "${name}".`,
              );
            }
            const val = record[name];
            return (val === undefined ? null : val) as SqliteParamValue;
          });
        }
        throw new Error(
          `@Query on ${repoName}.${methodName}() uses named placeholders (${names.map((n) => `:${n}`).join(", ")}) without @SqlParam(...) decorators. Add @SqlParam(...) or pass a parameter object.`,
        );
      };
    }
  } else {
    extractParams = (args) =>
      args.length > 0 ? (args as SqliteParamValue[]) : undefined;
  }

  const execute = (
    sqlite: SqliteQueryExecutor,
    args: readonly unknown[],
  ): unknown => {
    const params = extractParams(args);
    switch (mode) {
      case "changes":
        return sqlite.run(compiled.sql, params).changes;
      case "void":
        sqlite.run(compiled.sql, params);
        return undefined;
      case "runResult":
        return sqlite.run(compiled.sql, params);
      case "count": {
        const row = sqlite.queryOne<Record<string, unknown>>(
          compiled.sql,
          params,
        );
        return Number(interpretScalarRow(row) ?? 0);
      }
      case "exists": {
        const row = sqlite.queryOne<Record<string, unknown>>(
          compiled.sql,
          params,
        );
        return interpretExistsRow(row);
      }
      case "scalar": {
        const row = sqlite.queryOne<Record<string, unknown>>(
          compiled.sql,
          params,
        );
        return interpretScalarRow(row);
      }
      case "one": {
        const row = sqlite.queryOne<Record<string, unknown>>(
          compiled.sql,
          params,
        );
        if (row === null) return null;
        return shouldMapRows ? hydrateRow(row) : row;
      }
      case "many":
      case "auto": {
        const rows = sqlite.query<Record<string, unknown>>(
          compiled.sql,
          params,
        );
        return shouldMapRows ? rows.map((r) => hydrateRow(r)) : rows;
      }
    }
  };

  if (isSync) {
    return execute;
  }

  return async (sqlite, args) => execute(sqlite, args);
}

function compileDerivedMethod(
  methodName: string,
  meta: SqliteRepositoryMetadata,
  quotedTable: string,
  hydrateRow: (row: Record<string, unknown>) => unknown,
  colMaps: ResolvedEntityColumnMaps,
): CompiledMethodExecutor {
  // Parse ONCE per method name!
  const parsed = parseDerivedMethod(methodName, meta);

  // Fast path: when there is no dynamic IN (...) and no nullable eq/ne runtime rewrite needed,
  // we still handle null cleanly via buildDerivedSqlAndParams (or precompute static SQL for 0-arg queries).
  const staticZeroArgSql =
    parsed.totalArgs === 0
      ? buildDerivedSqlAndParams(parsed, quotedTable, [], methodName, colMaps)
          .sql
      : undefined;

  return async (sqlite, args) => {
    const { sql, params } =
      staticZeroArgSql !== undefined
        ? { sql: staticZeroArgSql, params: [] as SqliteParamValue[] }
        : buildDerivedSqlAndParams(
            parsed,
            quotedTable,
            args,
            methodName,
            colMaps,
          );
    const bound = params.length > 0 ? params : undefined;

    switch (parsed.action) {
      case "findOne": {
        const row = sqlite.queryOne<Record<string, unknown>>(sql, bound);
        return row === null ? null : hydrateRow(row);
      }
      case "findAll": {
        const rows = sqlite.query<Record<string, unknown>>(sql, bound);
        return rows.map((r) => hydrateRow(r));
      }
      case "exists": {
        const row = sqlite.queryOne<Record<string, unknown>>(sql, bound);
        return row !== null;
      }
      case "count": {
        const row = sqlite.queryOne<{ count: number | bigint | string }>(
          sql,
          bound,
        );
        return Number(row?.count ?? 0);
      }
      case "delete": {
        const res = sqlite.run(sql, bound);
        return res.changes;
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
 * Compiles a `@SqliteRepository(...)` abstract class ONCE into a concrete,
 * reusable repository factory with precompiled CRUD, `@Query` / `@Modifying` / `@SqlParam`,
 * and cached derived query executors.
 */
export function compileSqliteRepository<TRepo extends object>(
  RepoClass: Abstract<TRepo>,
): CompiledSqliteRepositoryFactory<TRepo> {
  const meta = getSqliteRepositoryMetadata(RepoClass);
  if (!meta) {
    throw new Error(
      `Declarative repository "${RepoClass.name}" is missing @SqliteRepository(Entity) decorator metadata.`,
    );
  }

  const quotedTable = quoteSqlIdentifier(meta.table, "table name");
  const quotedId = quoteSqlIdentifier(meta.idColumn, "id column name");
  const colMaps = buildEntityColumnMaps(meta);
  const hydrateRow = createRowHydrator(meta, colMaps);
  const serializeEntity = createEntitySerializer(meta, colMaps);

  // Precompiled SQL strings for standard JpaRepository CRUD operations
  const findByIdSql = `SELECT * FROM ${quotedTable} WHERE ${quotedId} = ? LIMIT 1`;
  const findAllSql = `SELECT * FROM ${quotedTable}`;
  const deleteByIdSql = `DELETE FROM ${quotedTable} WHERE ${quotedId} = ?`;
  const countSql = `SELECT COUNT(*) AS count FROM ${quotedTable}`;
  const existsByIdSql = `SELECT 1 AS found FROM ${quotedTable} WHERE ${quotedId} = ? LIMIT 1`;

  // Collect all @Query methods across prototype chain (base -> derived)
  const compiledQueryMethods = new Map<string, CompiledMethodExecutor>();
  const protoChain: object[] = [];
  let cursor: object | null = (RepoClass.prototype as object | null) ?? null;
  while (
    cursor &&
    cursor !== Object.prototype &&
    cursor !== JpaRepository.prototype
  ) {
    protoChain.unshift(cursor);
    cursor = Object.getPrototypeOf(cursor) as object | null;
  }

  for (const proto of protoChain) {
    const names = Object.getOwnPropertyNames(proto);
    for (let i = 0; i < names.length; i++) {
      const name = names[i]!;
      if (name === "constructor") continue;
      const queryMeta = MetadataRegistry.getOwn<SqliteQueryMetadata>(
        SQLITE_QUERY_METADATA,
        proto,
        name,
      );
      if (queryMeta) {
        const modifyingMeta = MetadataRegistry.getOwn<SqliteModifyingOptions>(
          SQLITE_MODIFYING_METADATA,
          proto,
          name,
        );
        const paramMap = MetadataRegistry.getOwn<SqliteParamMetadataMap>(
          SQLITE_PARAM_METADATA,
          proto,
          name,
        );
        compiledQueryMethods.set(
          name,
          compileCustomQueryMethod(
            name,
            queryMeta,
            modifyingMeta,
            paramMap,
            hydrateRow,
            RepoClass.name,
          ),
        );
      }
    }
  }

  // Shared per-repository derived method compilation cache (each derived method parsed ONCE!)
  const compiledDerivedMethods = new Map<string, CompiledMethodExecutor>();

  const getOrCompileDerived = (
    methodName: string,
  ): CompiledMethodExecutor | undefined => {
    const existing = compiledDerivedMethods.get(methodName);
    if (existing) {
      return existing;
    }
    if (!isDerivedMethodName(methodName)) {
      return undefined;
    }
    const compiled = compileDerivedMethod(
      methodName,
      meta,
      quotedTable,
      hydrateRow,
      colMaps,
    );
    compiledDerivedMethods.set(methodName, compiled);
    return compiled;
  };

  // Base CRUD method executors
  const baseCrudMethods: Record<string, CompiledMethodExecutor> = {
    findById: async (sqlite, args) => {
      const id = args[0] as SqliteParamValue;
      const row = sqlite.queryOne<Record<string, unknown>>(findByIdSql, [id]);
      return row === null ? null : hydrateRow(row);
    },
    findAll: async (sqlite) => {
      const rows = sqlite.query<Record<string, unknown>>(findAllSql);
      return rows.map((r) => hydrateRow(r));
    },
    save: async (sqlite, args) => {
      const entity = args[0];
      if (!entity || typeof entity !== "object") {
        throw new Error(
          `${RepoClass.name}.save() requires an entity object.`,
        );
      }
      const { idValue, entries, seenCols } = serializeEntity(
        entity as Record<string, unknown>,
      );
      const now = new Date();

      // If an ID is provided, attempt UPDATE ... RETURNING * first (handles partial updates with NOT NULL columns!),
      // then fall back to INSERT ... RETURNING * when inserting with an explicit ID.
      if (idValue !== undefined && idValue !== null) {
        const userNonIdEntries = entries.filter((e) => e.col !== meta.idColumn);
        if (userNonIdEntries.length > 0) {
          const updateEntries = [...userNonIdEntries];
          for (let i = 0; i < colMaps.updatedAtCols.length; i++) {
            const uCol = colMaps.updatedAtCols[i]!;
            const colName = meta.columns[uCol.propertyName] ?? uCol.name;
            if (!seenCols.has(colName)) {
              updateEntries.push({
                col: colName,
                quotedCol: quoteSqlIdentifier(colName, "column name"),
                value: createAutoTimestampSqliteValue(uCol, now),
              });
            }
          }
          const setClause = updateEntries
            .map((e) => `${e.quotedCol} = ?`)
            .join(", ");
          const updateParams = [
            ...updateEntries.map((e) => e.value),
            idValue,
          ];
          const updated = sqlite.queryOne<Record<string, unknown>>(
            `UPDATE ${quotedTable} SET ${setClause} WHERE ${quotedId} = ? RETURNING *`,
            updateParams,
          );
          if (updated !== null) {
            return hydrateRow(updated);
          }
        } else {
          const existing = sqlite.queryOne<Record<string, unknown>>(
            findByIdSql,
            [idValue],
          );
          if (existing !== null) {
            return hydrateRow(existing);
          }
        }
      }

      const insertEntries = [...entries];
      const insertSeen = new Set(seenCols);
      const appendAutoColumn = (
        col: EntityColumnMetadata,
        value: SqliteParamValue,
      ): void => {
        const colName = meta.columns[col.propertyName] ?? col.name;
        if (insertSeen.has(colName)) {
          return;
        }
        insertSeen.add(colName);
        insertEntries.push({
          col: colName,
          quotedCol: quoteSqlIdentifier(colName, "column name"),
          value,
        });
      };

      for (let i = 0; i < colMaps.uuidPrimaryCols.length; i++) {
        appendAutoColumn(colMaps.uuidPrimaryCols[i]!, crypto.randomUUID());
      }
      for (let i = 0; i < colMaps.createdAtCols.length; i++) {
        const cCol = colMaps.createdAtCols[i]!;
        appendAutoColumn(cCol, createAutoTimestampSqliteValue(cCol, now));
      }
      for (let i = 0; i < colMaps.updatedAtCols.length; i++) {
        const uCol = colMaps.updatedAtCols[i]!;
        appendAutoColumn(uCol, createAutoTimestampSqliteValue(uCol, now));
      }
      for (let i = 0; i < colMaps.dynamicDefaultCols.length; i++) {
        const dCol = colMaps.dynamicDefaultCols[i]!;
        const fn = dCol.default as () => unknown;
        const val = fn();
        if (val !== undefined) {
          appendAutoColumn(dCol, serializeSqliteColumnValue(dCol, val));
        }
      }

      if (insertEntries.length === 0) {
        throw new Error(
          `${RepoClass.name}.save() cannot persist an empty object into table "${meta.table}".`,
        );
      }

      const cols = insertEntries.map((e) => e.quotedCol).join(", ");
      const placeholders = insertEntries.map(() => "?").join(", ");
      const values = insertEntries.map((e) => e.value);
      const inserted = sqlite.queryOne<Record<string, unknown>>(
        `INSERT INTO ${quotedTable} (${cols}) VALUES (${placeholders}) RETURNING *`,
        values,
      );
      if (inserted === null) {
        throw new Error(
          `${RepoClass.name}.save() did not return a row from table "${meta.table}".`,
        );
      }
      return hydrateRow(inserted);
    },
    deleteById: async (sqlite, args) => {
      const id = args[0] as SqliteParamValue;
      sqlite.run(deleteByIdSql, [id]);
    },
    count: async (sqlite) => {
      const row = sqlite.queryOne<{ count: number | bigint | string }>(
        countSql,
      );
      return Number(row?.count ?? 0);
    },
    existsById: async (sqlite, args) => {
      const id = args[0] as SqliteParamValue;
      const row = sqlite.queryOne<{ found: number }>(existsByIdSql, [id]);
      return row !== null;
    },
  };

  return {
    metadata: meta,
    createInstance(sqlite: SqliteQueryExecutor): TRepo {
      // Instantiate an object inheriting directly from RepoClass.prototype so
      // `instance instanceof UserRepository` and `instance instanceof JpaRepository` are true!
      const target = Object.create(RepoClass.prototype) as Record<
        PropertyKey,
        unknown
      >;
      const boundMethodCache = new Map<string, Function>();

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
          JpaRepository.prototype,
          methodName,
        );
        if (baseDesc && typeof baseDesc.value === "function") {
          return baseDesc.value as Function;
        }
        return undefined;
      };

      // Bind base CRUD methods (unless overridden by a custom @Query or concrete subclass method)
      for (const [name, executor] of Object.entries(baseCrudMethods)) {
        if (compiledQueryMethods.has(name)) {
          continue;
        }
        const hasConcreteOverride = protoChain.some((p) => {
          const desc = Object.getOwnPropertyDescriptor(p, name);
          return desc !== undefined && typeof desc.value === "function";
        });
        if (!hasConcreteOverride) {
          const fn = (...args: unknown[]) => executor(sqlite, args);
          Object.defineProperty(fn, "name", { value: name, configurable: true });
          const protoMethod = findProtoMethod(name);
          if (protoMethod) {
            MetadataRegistry.copyMetadata(protoMethod, fn);
          }
          target[name] = fn;
        }
      }

      // Bind compiled @Query / @Modifying methods directly onto instance (replacing stub bodies)
      for (const [name, executor] of compiledQueryMethods.entries()) {
        const fn = (...args: unknown[]) => executor(sqlite, args);
        Object.defineProperty(fn, "name", { value: name, configurable: true });
        const protoMethod = findProtoMethod(name);
        if (protoMethod) {
          MetadataRegistry.copyMetadata(protoMethod, fn);
        }
        target[name] = fn;
      }

      const proxy = new Proxy(target, {
        get(obj, prop, receiver) {
          if (typeof prop === "symbol" || RESERVED_NON_DERIVED_KEYS.has(prop)) {
            return Reflect.get(obj, prop, receiver);
          }

          if (prop in obj) {
            const existing = Reflect.get(obj, prop, receiver);
            if (typeof existing === "function") {
              // Ensure concrete helper methods on RepoClass.prototype see `this === proxy`
              return existing;
            }
            return existing;
          }

          const cached = boundMethodCache.get(prop);
          if (cached) {
            return cached;
          }

          const derivedExecutor = getOrCompileDerived(prop);
          if (derivedExecutor) {
            const fn = (...args: unknown[]) => derivedExecutor(sqlite, args);
            Object.defineProperty(fn, "name", {
              value: prop,
              configurable: true,
            });
            boundMethodCache.set(prop, fn);
            return fn;
          }

          return undefined;
        },
        has(obj, prop) {
          if (typeof prop === "string" && !RESERVED_NON_DERIVED_KEYS.has(prop)) {
            if (prop in obj || isDerivedMethodName(prop)) {
              return true;
            }
          }
          return Reflect.has(obj, prop);
        },
      });

      return proxy as TRepo;
    },
  };
}
