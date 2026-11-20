import {
  DecoratorRegistry,
  MetadataRegistry,
  getEntityColumns,
  getEntitySchema,
  type Abstract,
  type EntityColumnMetadata,
  type Type,
} from "@bunest/common";
import {
  assertSafeSqlIdentifier,
  normalizeSqlDialect,
  quoteSqlIdentifier,
  type SqlDialect,
} from "./identifiers";
import type {
  SqlEntityMetadata,
  SqlModifyingOptions,
  SqlParamMetadataMap,
  SqlQueryMetadata,
  SqlQueryOptions,
  SqlQueryReturnMode,
  SqlRepositoryMetadata,
  SqlRepositoryOptions,
} from "./interfaces";
import type { SqlService } from "./sql.service";
import {
  SQL_ENTITY_METADATA,
  SQL_MODIFYING_METADATA,
  SQL_PARAM_METADATA,
  SQL_QUERY_METADATA,
  SQL_REPOSITORY_METADATA,
} from "./tokens";

/**
 * Spring Data-style abstract base CRUD repository for `@bunest/sql` (`Bun.SQL`).
 *
 * Subclass this as an `abstract class`, decorate with `@SqlRepository(Entity)`,
 * declare derived finder methods or `@SqlQuery(...)` / `@Query(...)` methods,
 * and register via `SqlModule.forFeature([MyRepository])`.
 */
export abstract class SqlCrudRepository<TEntity, TKey = number> {
  abstract findById(id: TKey): Promise<TEntity | null>;
  abstract findAll(): Promise<TEntity[]>;
  abstract save(entity: Partial<TEntity>): Promise<TEntity>;
  abstract deleteById(id: TKey): Promise<void>;
  abstract count(): Promise<number>;
  abstract existsById(id: TKey): Promise<boolean>;
}

/**
 * Descriptive alias for `SqlCrudRepository`.
 */
export const DeclarativeSqlRepository = SqlCrudRepository;

// ============================================================================
// Identifier, Naming & Dialect Helpers
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

function placeholderFor(dialect: SqlDialect, oneBasedIndex: number): string {
  return dialect === "postgres" ? `$${oneBasedIndex}` : "?";
}

function supportsReturningClause(dialect: SqlDialect): boolean {
  return dialect === "postgres" || dialect === "sqlite";
}

function booleanLiteral(dialect: SqlDialect, value: boolean): string {
  if (dialect === "sqlite") {
    return value ? "1" : "0";
  }
  return value ? "TRUE" : "FALSE";
}

// ============================================================================
// Decorators
// ============================================================================

/**
 * Associates an entity class with a SQL table name (and optional primary key column).
 */
export function SqlEntity(
  tableName: string,
  idColumn: string = "id",
): ClassDecorator {
  assertSafeSqlIdentifier(tableName, "table name");
  assertSafeSqlIdentifier(idColumn, "id column name");
  const metadata: SqlEntityMetadata = { tableName, idColumn };
  return (target) => {
    MetadataRegistry.define(SQL_ENTITY_METADATA, metadata, target);
  };
}

/**
 * Marks an `abstract class` (or class) as a Spring Data-style declarative SQL
 * repository compiled once by `SqlModule.forFeature([MyRepository])`.
 */
export function SqlRepository<TEntity = any>(
  entityOrOptions:
    | Type<TEntity>
    | Abstract<TEntity>
    | string
    | SqlRepositoryOptions<TEntity>,
): ClassDecorator {
  const opts: SqlRepositoryOptions<TEntity> =
    typeof entityOrOptions === "function"
      ? { entity: entityOrOptions }
      : typeof entityOrOptions === "string"
        ? { table: entityOrOptions }
        : entityOrOptions;

  const entity = opts.entity;
  const entitySchema = entity ? getEntitySchema(entity) : undefined;
  const entityColumns = entity ? getEntityColumns(entity) : [];
  const entityMeta = entity
    ? MetadataRegistry.get<SqlEntityMetadata>(SQL_ENTITY_METADATA, entity)
    : undefined;

  const pluralize = opts.pluralizeTableName ?? true;
  const table =
    opts.table ??
    entitySchema?.tableName ??
    entityMeta?.tableName ??
    (entity ? inferTableNameFromEntity(entity, pluralize) : "");

  if (!table) {
    throw new Error(
      `@SqlRepository() requires either an entity class or an explicit "table" name.`,
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

  const metadata: SqlRepositoryMetadata<TEntity> = {
    ...(entity !== undefined ? { entity } : {}),
    table,
    idColumn,
    idProperty,
    columns,
    ...(opts.connectionName !== undefined
      ? { connectionName: opts.connectionName }
      : {}),
    ...(opts.dialect !== undefined ? { dialect: opts.dialect } : {}),
    camelCaseMapping,
    ...(opts.mapRow !== undefined ? { mapRow: opts.mapRow } : {}),
  };

  return (target) => {
    MetadataRegistry.define(SQL_REPOSITORY_METADATA, metadata, target);
    DecoratorRegistry.register("sql-repository", target, metadata);
  };
}

/**
 * Binds a parameterized dialect-aware custom SQL query (`:name`, `?`, or `$1`)
 * to a declarative SQL repository method.
 */
export function SqlQuery(
  sql: string,
  options?: SqlQueryOptions,
): MethodDecorator {
  if (typeof sql !== "string" || sql.trim().length === 0) {
    throw new Error("@SqlQuery() requires a non-empty SQL string.");
  }
  const metadata: SqlQueryMetadata = {
    sql,
    ...(options !== undefined ? { options } : {}),
  };
  return (target, propertyKey, descriptor) => {
    MetadataRegistry.define(
      SQL_QUERY_METADATA,
      metadata,
      target,
      propertyKey,
    );
    return descriptor;
  };
}

/**
 * Spring Data-style alias for `@SqlQuery(...)`.
 */
export const Query = SqlQuery;

/**
 * Marks a `@SqlQuery(...)` repository method as a write statement (`INSERT`, `UPDATE`, `DELETE`).
 */
export function Modifying(options?: SqlModifyingOptions): MethodDecorator {
  const normalized: SqlModifyingOptions = options ?? {};
  return (target, propertyKey, descriptor) => {
    MetadataRegistry.define(
      SQL_MODIFYING_METADATA,
      normalized,
      target,
      propertyKey,
    );
    return descriptor;
  };
}

/**
 * Binds a repository method parameter index to a named `:name` placeholder in `@SqlQuery(sql)`.
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
      MetadataRegistry.getOwn<SqlParamMetadataMap>(
        SQL_PARAM_METADATA,
        target,
        propertyKey,
      ) ?? {};
    MetadataRegistry.define(
      SQL_PARAM_METADATA,
      { ...existing, [parameterIndex]: name },
      target,
      propertyKey,
    );
  };
}

/**
 * Alias for `@SqlParam(name)`.
 */
export const Param = SqlParam;

// ============================================================================
// Inspection Helpers
// ============================================================================

export function getSqlRepositoryMetadata(
  target: Function,
): SqlRepositoryMetadata | undefined {
  return MetadataRegistry.get<SqlRepositoryMetadata>(
    SQL_REPOSITORY_METADATA,
    target,
  );
}

export function isDeclarativeSqlRepository(
  target: unknown,
): target is Abstract<any> {
  if (typeof target !== "function") {
    return false;
  }
  return (
    MetadataRegistry.has(SQL_REPOSITORY_METADATA, target) ||
    target.prototype instanceof SqlCrudRepository
  );
}

// ============================================================================
// Dialect-Aware SQL Placeholder Scanner
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
  dialect: SqlDialect,
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
      out += placeholderFor(dialect, ++outParamCounter);
      i = j;
      continue;
    }

    // Positional placeholder ?
    if (ch === "?") {
      bindings.push({ kind: "positional", index: positionalCursor++ });
      out += placeholderFor(dialect, ++outParamCounter);
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
      out += placeholderFor(dialect, ++outParamCounter);
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
// Derived Query Parser & Dialect-Aware SQL Compiler
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
  readonly operator: DerivedOperator;
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

function resolvePropertyColumnName(
  propSegment: string,
  meta: SqlRepositoryMetadata,
): string {
  const propName = lowerFirst(propSegment);
  const mapped =
    meta.columns[propName] ??
    meta.columns[propSegment] ??
    (meta.camelCaseMapping ? camelToSnake(propName) : propName);
  return assertSafeSqlIdentifier(mapped, `column for "${propName}"`);
}

function parseOrderByPart(
  orderByPart: string,
  meta: SqlRepositoryMetadata,
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
    throw new Error(
      `Empty OrderBy clause in derived query "${methodName}".`,
    );
  }

  return items;
}

function parseSinglePredicate(
  rawSegment: string,
  combinator: "AND" | "OR" | null,
  meta: SqlRepositoryMetadata,
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

  const column = resolvePropertyColumnName(propPart, meta);
  return {
    combinator,
    column,
    operator,
    ignoreCase,
    argCount,
  };
}

function parseDerivedMethod(
  methodName: string,
  meta: SqlRepositoryMetadata,
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
  };
}

interface ResolvedSqlEntityColumnMaps {
  readonly columns: readonly EntityColumnMetadata[];
  readonly byProp: ReadonlyMap<string, EntityColumnMetadata>;
  readonly byCol: ReadonlyMap<string, EntityColumnMetadata>;
  readonly createdAtCols: readonly EntityColumnMetadata[];
  readonly updatedAtCols: readonly EntityColumnMetadata[];
  readonly uuidPrimaryCols: readonly EntityColumnMetadata[];
  readonly dynamicDefaultCols: readonly EntityColumnMetadata[];
}

function buildSqlEntityColumnMaps(
  meta: SqlRepositoryMetadata,
): ResolvedSqlEntityColumnMaps {
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

function hydrateSqlColumnValue(
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

function serializeSqlColumnValue(
  col: EntityColumnMetadata,
  rawVal: unknown,
  dialect: SqlDialect,
): unknown {
  if (rawVal === null) {
    return null;
  }
  if (col.transformer) {
    return col.transformer.to(rawVal);
  }
  switch (col.type) {
    case "boolean":
      return dialect === "postgres" ? Boolean(rawVal) : rawVal ? 1 : 0;
    case "json":
      return JSON.stringify(rawVal);
    case "datetime":
      if (rawVal instanceof Date) return rawVal.toISOString();
      if (typeof rawVal === "number") return new Date(rawVal).toISOString();
      return rawVal;
    default:
      return rawVal;
  }
}

function createAutoTimestampSqlValue(
  col: EntityColumnMetadata,
  now: Date,
  dialect: SqlDialect,
): unknown {
  if (col.transformer) {
    return col.transformer.to(now);
  }
  if (col.type === "integer" || col.type === "bigint") {
    return now.getTime();
  }
  return serializeSqlColumnValue(col, now, dialect);
}

function buildDerivedSqlAndParams(
  parsed: ParsedDerivedQuery,
  quotedTable: string,
  dialect: SqlDialect,
  args: readonly unknown[],
  methodName: string,
  colMaps: ResolvedSqlEntityColumnMaps,
): { sql: string; params: unknown[] } {
  if (args.length < parsed.totalArgs) {
    throw new Error(
      `Derived query "${methodName}" expects at least ${parsed.totalArgs} argument(s), received ${args.length}.`,
    );
  }

  const whereParts: string[] = [];
  const params: unknown[] = [];
  let argCursor = 0;
  let paramCounter = 0;
  const nextPh = () => placeholderFor(dialect, ++paramCounter);

  const serializeArg = (colName: string, raw: unknown): unknown => {
    const colMeta = colMaps.byCol.get(colName);
    if (!colMeta) {
      return raw;
    }
    return serializeSqlColumnValue(colMeta, raw, dialect);
  };

  for (let i = 0; i < parsed.predicates.length; i++) {
    const p = parsed.predicates[i]!;
    const prefix = p.combinator ? ` ${p.combinator} ` : "";
    const quotedCol = quoteSqlIdentifier(p.column, dialect, "column name");
    const colExpr = p.ignoreCase ? `LOWER(${quotedCol})` : quotedCol;
    const wrapPh = (ph: string) => (p.ignoreCase ? `LOWER(${ph})` : ph);

    switch (p.operator) {
      case "isNull":
        whereParts.push(`${prefix}${quotedCol} IS NULL`);
        break;
      case "isNotNull":
        whereParts.push(`${prefix}${quotedCol} IS NOT NULL`);
        break;
      case "isTrue":
        whereParts.push(`${prefix}${quotedCol} = ${booleanLiteral(dialect, true)}`);
        break;
      case "isFalse":
        whereParts.push(`${prefix}${quotedCol} = ${booleanLiteral(dialect, false)}`);
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
        params.push(`%${escapeLikeValue(val)}%`);
        break;
      }
      case "notContaining": {
        const val = args[argCursor++];
        whereParts.push(
          `${prefix}${colExpr} NOT LIKE ${wrapPh(nextPh())} ESCAPE '!'`,
        );
        params.push(`%${escapeLikeValue(val)}%`);
        break;
      }
      case "startsWith": {
        const val = args[argCursor++];
        whereParts.push(
          `${prefix}${colExpr} LIKE ${wrapPh(nextPh())} ESCAPE '!'`,
        );
        params.push(`${escapeLikeValue(val)}%`);
        break;
      }
      case "endsWith": {
        const val = args[argCursor++];
        whereParts.push(
          `${prefix}${colExpr} LIKE ${wrapPh(nextPh())} ESCAPE '!'`,
        );
        params.push(`%${escapeLikeValue(val)}`);
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

  const whereClause =
    whereParts.length > 0 ? ` WHERE ${whereParts.join("")}` : "";
  const orderClause =
    parsed.orderBy.length > 0
      ? ` ORDER BY ${parsed.orderBy.map((o) => `${quoteSqlIdentifier(o.column, dialect, "orderBy column")} ${o.direction}`).join(", ")}`
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
// Compiled Repository Factory (Dialect-Aware & Cached)
// ============================================================================

export interface CompiledSqlRepositoryFactory<TRepo extends object = object> {
  readonly metadata: SqlRepositoryMetadata;
  createInstance(sqlService: SqlService): TRepo;
}

type SqlMethodExecutor = (
  sqlService: SqlService,
  args: readonly unknown[],
) => Promise<unknown>;

function inferQueryMode(
  methodName: string,
  sql: string,
  queryOptions: SqlQueryOptions | undefined,
  modifyingOptions: SqlModifyingOptions | undefined,
): SqlQueryReturnMode {
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
  meta: SqlRepositoryMetadata<TEntity>,
  colMaps: ResolvedSqlEntityColumnMaps,
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
      const val = colMeta ? hydrateSqlColumnValue(colMeta, rawVal) : rawVal;
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
  meta: SqlRepositoryMetadata,
  colMaps: ResolvedSqlEntityColumnMaps,
): (
  entity: Record<string, unknown>,
  dialect: SqlDialect,
) => {
  idValue: unknown;
  entries: Array<{ col: string; value: unknown }>;
  seenCols: Set<string>;
} {
  const hasSchemaColumns = colMaps.byProp.size > 0 || colMaps.byCol.size > 0;

  return (entity: Record<string, unknown>, dialect: SqlDialect) => {
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
      const val = colMeta
        ? serializeSqlColumnValue(colMeta, rawVal, dialect)
        : rawVal;
      if (col === meta.idColumn || prop === meta.idProperty) {
        idValue = val;
      }
      entries.push({ col, value: val });
    }

    return { idValue, entries, seenCols };
  };
}

interface RawQueryDeclaration {
  readonly methodName: string;
  readonly queryMeta: SqlQueryMetadata;
  readonly modifyingMeta?: SqlModifyingOptions;
  readonly paramMap?: SqlParamMetadataMap;
}

interface CompiledDialectBundle {
  readonly baseCrud: Record<string, SqlMethodExecutor>;
  readonly queryMethods: Map<string, SqlMethodExecutor>;
  readonly derivedCache: Map<string, SqlMethodExecutor>;
  getOrCompileDerived(methodName: string): SqlMethodExecutor | undefined;
}

function compileCustomSqlQueryMethod(
  decl: RawQueryDeclaration,
  dialect: SqlDialect,
  hydrateRow: (row: Record<string, unknown>) => unknown,
  repoName: string,
): SqlMethodExecutor {
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

  let extractParams: (args: readonly unknown[]) => unknown[] | undefined;

  if (compiled.bindings.length === 0) {
    extractParams = () => undefined;
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
              `@SqlQuery on ${repoName}.${methodName}() references ":${b.name}", which has no matching @SqlParam("${b.name}") decorator.`,
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
        if (args.length === 1 && isPlainRecord(args[0])) {
          const record = args[0];
          return bindings.map((b) => {
            if (b.kind === "named") {
              if (!(b.name in record)) {
                throw new Error(
                  `@SqlQuery on ${repoName}.${methodName}() is missing named parameter "${b.name}".`,
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
          `@SqlQuery on ${repoName}.${methodName}() uses named placeholders (${names.join(", ")}) without @SqlParam(...) decorators. Add @SqlParam(...) or pass a parameter object.`,
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

  return async (sqlService, args) => {
    const params = extractParams(args);
    switch (mode) {
      case "changes": {
        const res = await sqlService.query(compiled.sql, params);
        return res.affectedRows ?? res.rowCount;
      }
      case "void": {
        await sqlService.query(compiled.sql, params);
        return undefined;
      }
      case "runResult": {
        return await sqlService.query(compiled.sql, params);
      }
      case "count": {
        const row = await sqlService.queryOne<Record<string, unknown>>(
          compiled.sql,
          params,
        );
        return Number(interpretScalarRow(row) ?? 0);
      }
      case "exists": {
        const row = await sqlService.queryOne<Record<string, unknown>>(
          compiled.sql,
          params,
        );
        return interpretExistsRow(row);
      }
      case "scalar": {
        const row = await sqlService.queryOne<Record<string, unknown>>(
          compiled.sql,
          params,
        );
        return interpretScalarRow(row);
      }
      case "one": {
        const row = await sqlService.queryOne<Record<string, unknown>>(
          compiled.sql,
          params,
        );
        if (row === null) return null;
        return shouldMapRows ? hydrateRow(row) : row;
      }
      case "many":
      case "auto": {
        const res = await sqlService.query<Record<string, unknown>>(
          compiled.sql,
          params,
        );
        return shouldMapRows ? res.rows.map((r) => hydrateRow(r)) : [...res.rows];
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
 * Compiles a `@SqlRepository(...)` abstract class ONCE into a dialect-aware
 * repository factory with precompiled CRUD, `@SqlQuery` / `@Modifying` / `@SqlParam`,
 * and cached derived query executors (`$1` on PostgreSQL, `?` on MySQL/SQLite).
 */
export function compileSqlRepository<TRepo extends object>(
  RepoClass: Abstract<TRepo>,
): CompiledSqlRepositoryFactory<TRepo> {
  const meta = getSqlRepositoryMetadata(RepoClass);
  if (!meta) {
    throw new Error(
      `Declarative SQL repository "${RepoClass.name}" is missing @SqlRepository(Entity) decorator metadata.`,
    );
  }

  const colMaps = buildSqlEntityColumnMaps(meta);
  const hydrateRow = createRowHydrator(meta, colMaps);
  const serializeEntity = createEntitySerializer(meta, colMaps);

  // Collect prototype chain and raw @SqlQuery declarations ONCE
  const protoChain: object[] = [];
  let cursor: object | null = (RepoClass.prototype as object | null) ?? null;
  while (
    cursor &&
    cursor !== Object.prototype &&
    cursor !== SqlCrudRepository.prototype
  ) {
    protoChain.unshift(cursor);
    cursor = Object.getPrototypeOf(cursor) as object | null;
  }

  const rawQueryDeclarations = new Map<string, RawQueryDeclaration>();
  for (const proto of protoChain) {
    const names = Object.getOwnPropertyNames(proto);
    for (let i = 0; i < names.length; i++) {
      const name = names[i]!;
      if (name === "constructor") continue;
      const queryMeta = MetadataRegistry.getOwn<SqlQueryMetadata>(
        SQL_QUERY_METADATA,
        proto,
        name,
      );
      if (queryMeta) {
        const modifyingMeta = MetadataRegistry.getOwn<SqlModifyingOptions>(
          SQL_MODIFYING_METADATA,
          proto,
          name,
        );
        const paramMap = MetadataRegistry.getOwn<SqlParamMetadataMap>(
          SQL_PARAM_METADATA,
          proto,
          name,
        );
        rawQueryDeclarations.set(name, {
          methodName: name,
          queryMeta,
          modifyingMeta,
          paramMap,
        });
      }
    }
  }

  // Validate named @SqlParam bindings eagerly at registration time using default dialect
  const validationDialect: SqlDialect = meta.dialect ?? "postgres";
  for (const decl of rawQueryDeclarations.values()) {
    compileCustomSqlQueryMethod(decl, validationDialect, hydrateRow, RepoClass.name);
  }

  const dialectBundles = new Map<SqlDialect, CompiledDialectBundle>();

  const getDialectBundle = (dialect: SqlDialect): CompiledDialectBundle => {
    const existing = dialectBundles.get(dialect);
    if (existing) {
      return existing;
    }

    const quotedTable = quoteSqlIdentifier(meta.table, dialect, "table name");
    const quotedId = quoteSqlIdentifier(meta.idColumn, dialect, "id column name");
    const p1 = placeholderFor(dialect, 1);
    const hasReturning = supportsReturningClause(dialect);

    const findByIdSql = `SELECT * FROM ${quotedTable} WHERE ${quotedId} = ${p1} LIMIT 1`;
    const findAllSql = `SELECT * FROM ${quotedTable}`;
    const deleteByIdSql = `DELETE FROM ${quotedTable} WHERE ${quotedId} = ${p1}`;
    const countSql = `SELECT COUNT(*) AS count FROM ${quotedTable}`;
    const existsByIdSql = `SELECT 1 AS found FROM ${quotedTable} WHERE ${quotedId} = ${p1} LIMIT 1`;

    const baseCrud: Record<string, SqlMethodExecutor> = {
      findById: async (sqlService, args) => {
        const row = await sqlService.queryOne<Record<string, unknown>>(
          findByIdSql,
          [args[0]],
        );
        return row === null ? null : hydrateRow(row);
      },
      findAll: async (sqlService) => {
        const res = await sqlService.query<Record<string, unknown>>(findAllSql);
        return res.rows.map((r) => hydrateRow(r));
      },
      save: async (sqlService, args) => {
        const entity = args[0];
        if (!entity || typeof entity !== "object") {
          throw new Error(
            `${RepoClass.name}.save() requires an entity object.`,
          );
        }
        const { idValue, entries, seenCols } = serializeEntity(
          entity as Record<string, unknown>,
          dialect,
        );
        const now = new Date();

        if (idValue !== undefined && idValue !== null) {
          const userNonIdEntries = entries.filter(
            (e) => e.col !== meta.idColumn,
          );
          if (userNonIdEntries.length > 0) {
            const updateEntries = [...userNonIdEntries];
            for (let i = 0; i < colMaps.updatedAtCols.length; i++) {
              const uCol = colMaps.updatedAtCols[i]!;
              const colName = meta.columns[uCol.propertyName] ?? uCol.name;
              if (!seenCols.has(colName)) {
                updateEntries.push({
                  col: colName,
                  value: createAutoTimestampSqlValue(uCol, now, dialect),
                });
              }
            }
            const assignments = updateEntries.map(
              (e, idx) =>
                `${quoteSqlIdentifier(e.col, dialect, "column name")} = ${placeholderFor(dialect, idx + 1)}`,
            );
            const idPh = placeholderFor(dialect, updateEntries.length + 1);
            const updateParams = [
              ...updateEntries.map((e) => e.value),
              idValue,
            ];

            if (hasReturning) {
              const updated = await sqlService.queryOne<
                Record<string, unknown>
              >(
                `UPDATE ${quotedTable} SET ${assignments.join(", ")} WHERE ${quotedId} = ${idPh} RETURNING *`,
                updateParams,
              );
              if (updated !== null) {
                return hydrateRow(updated);
              }
            } else {
              const updateRes = await sqlService.query(
                `UPDATE ${quotedTable} SET ${assignments.join(", ")} WHERE ${quotedId} = ${idPh}`,
                updateParams,
              );
              const changed = updateRes.affectedRows ?? updateRes.rowCount;
              if (changed > 0) {
                const reloaded = await sqlService.queryOne<
                  Record<string, unknown>
                >(findByIdSql, [idValue]);
                if (reloaded !== null) {
                  return hydrateRow(reloaded);
                }
                const fallbackRow: Record<string, unknown> = {
                  [meta.idColumn]: idValue,
                };
                for (let i = 0; i < updateEntries.length; i++) {
                  const e = updateEntries[i]!;
                  fallbackRow[e.col] = e.value;
                }
                return hydrateRow(fallbackRow);
              }
            }
          } else {
            const existingRow = await sqlService.queryOne<
              Record<string, unknown>
            >(findByIdSql, [idValue]);
            if (existingRow !== null) {
              return hydrateRow(existingRow);
            }
          }
        }

        const insertEntries = [...entries];
        const insertSeen = new Set(seenCols);
        const appendAutoColumn = (
          col: EntityColumnMetadata,
          value: unknown,
        ): void => {
          const colName = meta.columns[col.propertyName] ?? col.name;
          if (insertSeen.has(colName)) {
            return;
          }
          insertSeen.add(colName);
          insertEntries.push({ col: colName, value });
        };

        for (let i = 0; i < colMaps.uuidPrimaryCols.length; i++) {
          appendAutoColumn(colMaps.uuidPrimaryCols[i]!, crypto.randomUUID());
        }
        for (let i = 0; i < colMaps.createdAtCols.length; i++) {
          const cCol = colMaps.createdAtCols[i]!;
          appendAutoColumn(
            cCol,
            createAutoTimestampSqlValue(cCol, now, dialect),
          );
        }
        for (let i = 0; i < colMaps.updatedAtCols.length; i++) {
          const uCol = colMaps.updatedAtCols[i]!;
          appendAutoColumn(
            uCol,
            createAutoTimestampSqlValue(uCol, now, dialect),
          );
        }
        for (let i = 0; i < colMaps.dynamicDefaultCols.length; i++) {
          const dCol = colMaps.dynamicDefaultCols[i]!;
          const fn = dCol.default as () => unknown;
          const val = fn();
          if (val !== undefined) {
            appendAutoColumn(
              dCol,
              serializeSqlColumnValue(dCol, val, dialect),
            );
          }
        }

        if (insertEntries.length === 0) {
          throw new Error(
            `${RepoClass.name}.save() cannot persist an empty object into table "${meta.table}".`,
          );
        }

        const cols = insertEntries
          .map((e) => quoteSqlIdentifier(e.col, dialect, "column name"))
          .join(", ");
        const placeholders = insertEntries
          .map((_, idx) => placeholderFor(dialect, idx + 1))
          .join(", ");
        const values = insertEntries.map((e) => e.value);

        if (hasReturning) {
          const inserted = await sqlService.queryOne<Record<string, unknown>>(
            `INSERT INTO ${quotedTable} (${cols}) VALUES (${placeholders}) RETURNING *`,
            values,
          );
          if (inserted === null) {
            throw new Error(
              `${RepoClass.name}.save() did not return a row from table "${meta.table}".`,
            );
          }
          return hydrateRow(inserted);
        }

        const insertRes = await sqlService.query(
          `INSERT INTO ${quotedTable} (${cols}) VALUES (${placeholders})`,
          values,
        );
        const insertedId =
          idValue !== undefined && idValue !== null
            ? idValue
            : insertRes.lastInsertRowid;
        if (insertedId !== undefined && insertedId !== null) {
          const reloaded = await sqlService.queryOne<Record<string, unknown>>(
            findByIdSql,
            [insertedId],
          );
          if (reloaded !== null) {
            return hydrateRow(reloaded);
          }
          const fallbackRow: Record<string, unknown> = {
            [meta.idColumn]: insertedId,
          };
          for (let i = 0; i < insertEntries.length; i++) {
            const e = insertEntries[i]!;
            fallbackRow[e.col] = e.value;
          }
          return hydrateRow(fallbackRow);
        }
        const fallbackRow: Record<string, unknown> = {};
        for (let i = 0; i < insertEntries.length; i++) {
          const e = insertEntries[i]!;
          fallbackRow[e.col] = e.value;
        }
        return hydrateRow(fallbackRow);
      },
      deleteById: async (sqlService, args) => {
        await sqlService.query(deleteByIdSql, [args[0]]);
      },
      count: async (sqlService) => {
        const row = await sqlService.queryOne<{
          count: number | bigint | string;
        }>(countSql);
        return Number(row?.count ?? 0);
      },
      existsById: async (sqlService, args) => {
        const row = await sqlService.queryOne<Record<string, unknown>>(
          existsByIdSql,
          [args[0]],
        );
        return row !== null;
      },
    };

    const queryMethods = new Map<string, SqlMethodExecutor>();
    for (const [name, decl] of rawQueryDeclarations.entries()) {
      queryMethods.set(
        name,
        compileCustomSqlQueryMethod(decl, dialect, hydrateRow, RepoClass.name),
      );
    }

    const derivedCache = new Map<string, SqlMethodExecutor>();
    const getOrCompileDerived = (
      methodName: string,
    ): SqlMethodExecutor | undefined => {
      const cached = derivedCache.get(methodName);
      if (cached) {
        return cached;
      }
      if (!isDerivedMethodName(methodName)) {
        return undefined;
      }
      const parsed = parseDerivedMethod(methodName, meta);
      const staticZeroArgSql =
        parsed.totalArgs === 0
          ? buildDerivedSqlAndParams(
              parsed,
              quotedTable,
              dialect,
              [],
              methodName,
              colMaps,
            ).sql
          : undefined;

      const executor: SqlMethodExecutor = async (sqlService, args) => {
        const { sql, params } =
          staticZeroArgSql !== undefined
            ? { sql: staticZeroArgSql, params: [] as unknown[] }
            : buildDerivedSqlAndParams(
                parsed,
                quotedTable,
                dialect,
                args,
                methodName,
                colMaps,
              );
        const bound = params.length > 0 ? params : undefined;

        switch (parsed.action) {
          case "findOne": {
            const row = await sqlService.queryOne<Record<string, unknown>>(
              sql,
              bound,
            );
            return row === null ? null : hydrateRow(row);
          }
          case "findAll": {
            const res = await sqlService.query<Record<string, unknown>>(
              sql,
              bound,
            );
            return res.rows.map((r) => hydrateRow(r));
          }
          case "exists": {
            const row = await sqlService.queryOne<Record<string, unknown>>(
              sql,
              bound,
            );
            return row !== null;
          }
          case "count": {
            const row = await sqlService.queryOne<{
              count: number | bigint | string;
            }>(sql, bound);
            return Number(row?.count ?? 0);
          }
          case "delete": {
            const res = await sqlService.query(sql, bound);
            return res.affectedRows ?? res.rowCount;
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
      getOrCompileDerived,
    };
    dialectBundles.set(dialect, bundle);
    return bundle;
  };

  return {
    metadata: meta,
    createInstance(sqlService: SqlService): TRepo {
      const effectiveDialect =
        meta.dialect ?? normalizeSqlDialect(sqlService.adapter);
      const bundle = getDialectBundle(effectiveDialect);

      const target = Object.create(RepoClass.prototype) as Record<
        PropertyKey,
        unknown
      >;
      const boundDerivedCache = new Map<string, Function>();

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
          SqlCrudRepository.prototype,
          methodName,
        );
        if (baseDesc && typeof baseDesc.value === "function") {
          return baseDesc.value as Function;
        }
        return undefined;
      };

      for (const [name, executor] of Object.entries(bundle.baseCrud)) {
        if (bundle.queryMethods.has(name)) {
          continue;
        }
        const hasConcreteOverride = protoChain.some((p) => {
          const desc = Object.getOwnPropertyDescriptor(p, name);
          return desc !== undefined && typeof desc.value === "function";
        });
        if (!hasConcreteOverride) {
          const fn = (...args: unknown[]) => executor(sqlService, args);
          Object.defineProperty(fn, "name", { value: name, configurable: true });
          const protoMethod = findProtoMethod(name);
          if (protoMethod) {
            MetadataRegistry.copyMetadata(protoMethod, fn);
          }
          target[name] = fn;
        }
      }

      for (const [name, executor] of bundle.queryMethods.entries()) {
        const fn = (...args: unknown[]) => executor(sqlService, args);
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
            return Reflect.get(obj, prop, receiver);
          }

          const cached = boundDerivedCache.get(prop);
          if (cached) {
            return cached;
          }

          const derivedExecutor = bundle.getOrCompileDerived(prop);
          if (derivedExecutor) {
            const fn = (...args: unknown[]) => derivedExecutor(sqlService, args);
            Object.defineProperty(fn, "name", {
              value: prop,
              configurable: true,
            });
            boundDerivedCache.set(prop, fn);
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
