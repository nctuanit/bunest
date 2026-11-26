import {
  ClsService,
  ContextStorage,
  MetadataRegistry,
  getCurrentRequestContext,
  type Abstract,
} from "@bunest/core";
import { getDialectProfile } from "./dialect/dialect-profile";
import {
  assertSafeSqlIdentifier,
  camelToSnake,
  formatPlaceholder,
} from "./identifiers";
import type { OrmDialect, OrmDriverLike } from "./types";

// ============================================================================
// Metadata & Single-Realm Registry Symbols
// ============================================================================

/**
 * Single-realm `globalThis` key holding the `Map<string, CustomQueryOperator>`
 * shared between `@bunest/orm` runtime derived-query compilation and
 * `@bunest/cli` / IDE static analyzers.
 */
export const ORM_CUSTOM_QUERY_OPERATORS_SYMBOL = Symbol.for(
  "bunest:orm:custom_query_operators",
);

const ORM_CUSTOM_QUERY_OPERATORS_VERSION_SYMBOL = Symbol.for(
  "bunest:orm:custom_query_operators_version",
);

export const ORM_REPOSITORY_SCOPES_METADATA = Symbol.for(
  "bunest:orm:repository_scopes",
);
export const ORM_IGNORE_SCOPE_METADATA = Symbol.for(
  "bunest:orm:ignore_scope",
);
export const ORM_SOFT_DELETE_CONFIG_METADATA = Symbol.for(
  "bunest:orm:soft_delete_config",
);
export const ORM_PROJECTION_METADATA = Symbol.for("bunest:orm:projection");
export const ORM_REPOSITORY_FRAGMENTS_METADATA = Symbol.for(
  "bunest:orm:repository_fragments",
);

export const PAGEABLE_BRAND = Symbol.for("bunest:orm:pageable");
export const CURSOR_PAGEABLE_BRAND = Symbol.for("bunest:orm:cursor_pageable");

// ============================================================================
// Internal SQL / String Utilities
// ============================================================================

function snakeToCamel(input: string): string {
  return input.replace(/_([a-z0-9])/g, (_, ch: string) => ch.toUpperCase());
}

/**
 * Checks whether a SQL boolean predicate expression contains a top-level `OR`
 * outside quotes and parentheses so callers can safely parenthesize it before
 * combining with `AND`.
 */
export function hasTopLevelSqlOr(sql: string): boolean {
  let depth = 0;
  let i = 0;
  const len = sql.length;

  while (i < len) {
    const ch = sql[i]!;
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      i++;
      while (i < len) {
        if (sql[i] === quote) {
          if (i + 1 < len && sql[i + 1] === quote) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === "(") {
      depth++;
      i++;
      continue;
    }
    if (ch === ")") {
      depth = Math.max(0, depth - 1);
      i++;
      continue;
    }
    if (depth === 0 && (ch === "O" || ch === "o")) {
      const next = sql[i + 1];
      if (next === "R" || next === "r") {
        const before = i === 0 ? " " : sql[i - 1]!;
        const after = i + 2 >= len ? " " : sql[i + 2]!;
        if (!/[A-Za-z0-9_]/.test(before) && !/[A-Za-z0-9_]/.test(after)) {
          return true;
        }
      }
    }
    i++;
  }
  return false;
}

/**
 * Rewrites unquoted `?` positional placeholders in a SQL fragment using
 * `nextPlaceholder()` while leaving quoted literals/identifiers and comments untouched.
 */
export function rewriteQuestionPlaceholders(
  rawSql: string,
  nextPlaceholder: () => string,
): string {
  let out = "";
  let i = 0;
  const len = rawSql.length;

  while (i < len) {
    const ch = rawSql[i]!;

    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      out += ch;
      i++;
      while (i < len) {
        const c = rawSql[i]!;
        out += c;
        i++;
        if (c === quote) {
          if (i < len && rawSql[i] === quote) {
            out += rawSql[i]!;
            i++;
          } else {
            break;
          }
        }
      }
      continue;
    }

    if (ch === "-" && i + 1 < len && rawSql[i + 1] === "-") {
      while (i < len && rawSql[i] !== "\n") {
        out += rawSql[i]!;
        i++;
      }
      continue;
    }

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

    if (ch === "?") {
      out += nextPlaceholder();
      i++;
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

function getConstructorChain(target: Function): Function[] {
  const chain: Function[] = [];
  let cursor: unknown = target;
  while (
    typeof cursor === "function" &&
    cursor !== Function.prototype &&
    cursor !== Object
  ) {
    chain.unshift(cursor);
    cursor = Object.getPrototypeOf(cursor);
  }
  return chain;
}

// ============================================================================
// 1. Custom Derived Query Operators Registry
// ============================================================================

export interface CustomQueryOperatorSqlContext {
  /** Validated unquoted SQL column name (e.g. `"bio"`, `"tags"`). */
  readonly column: string;
  /** Dialect-quoted SQL column identifier (e.g. `"\"bio\""`, `` "`tags`" ``). */
  readonly quotedColumn: string;
  /** Active ORM SQL dialect. */
  readonly dialect: OrmDialect;
  /** Method arguments consumed by this predicate (`args.length === operator.arity`). */
  readonly args: readonly unknown[];
  /** Whether the predicate included an `IgnoreCase` modifier. */
  readonly ignoreCase: boolean;
  /** Allocates the next dialect-formatted parameter placeholder (`?`, `$1`, `@p1`, `:1`). */
  readonly nextPlaceholder: () => string;
  /** Safely quotes a SQL identifier using the active dialect. */
  readonly quoteIdentifier: (identifier: string, context?: string) => string;
  /** Serializes a JS value through the target column's ORM transformer / type encoder. */
  readonly serializeValue: (value: unknown) => unknown;
}

export interface CustomQueryOperator {
  /** PascalCase suffix, e.g. `"Matches"`, `"JsonContains"`, `"IContains"`. */
  readonly suffix: string;
  /** Number of method arguments consumed (0, 1, 2, ...). */
  readonly arity: number;
  /** Compiles the predicate into SQL and optional bound parameter values. */
  readonly toSql: (ctx: CustomQueryOperatorSqlContext) => {
    readonly sql: string;
    readonly params?: readonly unknown[];
  };
  /** Optional description surfaced by `@bunest/cli` and VS Code hover/autocomplete. */
  readonly description?: string;
}

type GlobalWithCustomQueryOperators = typeof globalThis & {
  [ORM_CUSTOM_QUERY_OPERATORS_SYMBOL]?: Map<string, CustomQueryOperator>;
  [ORM_CUSTOM_QUERY_OPERATORS_VERSION_SYMBOL]?: number;
};

function getOperatorRegistryMap(): Map<string, CustomQueryOperator> {
  const g = globalThis as GlobalWithCustomQueryOperators;
  let map = g[ORM_CUSTOM_QUERY_OPERATORS_SYMBOL];
  if (!(map instanceof Map)) {
    map = new Map<string, CustomQueryOperator>();
    g[ORM_CUSTOM_QUERY_OPERATORS_SYMBOL] = map;
  }
  return map;
}

function bumpOperatorRegistryVersion(): void {
  const g = globalThis as GlobalWithCustomQueryOperators;
  g[ORM_CUSTOM_QUERY_OPERATORS_VERSION_SYMBOL] =
    (g[ORM_CUSTOM_QUERY_OPERATORS_VERSION_SYMBOL] ?? 0) + 1;
}

/**
 * Monotonic version counter incremented whenever custom query operators are
 * registered, unregistered, or cleared (used to invalidate derived-query caches).
 */
export function getCustomQueryOperatorRegistryVersion(): number {
  const g = globalThis as GlobalWithCustomQueryOperators;
  return g[ORM_CUSTOM_QUERY_OPERATORS_VERSION_SYMBOL] ?? 0;
}

const VALID_OPERATOR_SUFFIX_RE = /^[A-Z][A-Za-z0-9]*$/;

/**
 * Registers a custom derived query operator (e.g. `Matches`, `JsonContains`, `IContains`)
 * in the single-realm global registry (`Symbol.for("bunest:orm:custom_query_operators")`).
 */
export function registerQueryOperator(
  operator: CustomQueryOperator,
): CustomQueryOperator {
  if (
    !operator ||
    typeof operator.suffix !== "string" ||
    !VALID_OPERATOR_SUFFIX_RE.test(operator.suffix)
  ) {
    throw new Error(
      `Invalid custom query operator suffix "${String(operator?.suffix)}": suffix must be PascalCase matching /^[A-Z][A-Za-z0-9]*$/.`,
    );
  }
  if (!Number.isInteger(operator.arity) || operator.arity < 0) {
    throw new Error(
      `Invalid custom query operator "${operator.suffix}": arity must be a non-negative integer, received ${String(operator.arity)}.`,
    );
  }
  if (typeof operator.toSql !== "function") {
    throw new Error(
      `Invalid custom query operator "${operator.suffix}": "toSql" must be a function.`,
    );
  }

  const normalized: CustomQueryOperator = {
    suffix: operator.suffix,
    arity: operator.arity,
    toSql: operator.toSql,
    ...(operator.description !== undefined
      ? { description: operator.description }
      : {}),
  };

  getOperatorRegistryMap().set(normalized.suffix, normalized);
  bumpOperatorRegistryVersion();
  return normalized;
}

/**
 * Removes a previously registered custom derived query operator by suffix.
 */
export function unregisterQueryOperator(suffix: string): boolean {
  const removed = getOperatorRegistryMap().delete(suffix);
  if (removed) {
    bumpOperatorRegistryVersion();
  }
  return removed;
}

/**
 * Looks up a registered custom derived query operator by its PascalCase suffix.
 */
export function getRegisteredQueryOperator(
  suffix: string,
): CustomQueryOperator | undefined {
  return getOperatorRegistryMap().get(suffix);
}

/**
 * Returns all registered custom derived query operators.
 */
export function listRegisteredQueryOperators(): readonly CustomQueryOperator[] {
  return [...getOperatorRegistryMap().values()];
}

/**
 * Clears all registered custom derived query operators from the global registry.
 */
export function clearRegisteredQueryOperators(): void {
  const map = getOperatorRegistryMap();
  if (map.size > 0) {
    map.clear();
    bumpOperatorRegistryVersion();
  }
}

// ============================================================================
// 2. Implicit Repository Scopes (@RepositoryScope, @SoftDelete, @TenantScoped, @IgnoreScope)
// ============================================================================

export type RepositoryScopeOperation =
  | "findById"
  | "findByIdOrFail"
  | "findAll"
  | "count"
  | "existsById"
  | "save"
  | "deleteById"
  | "derived"
  | "query";

export type RepositoryScopeWhereResult =
  | { readonly sql: string; readonly params?: readonly unknown[] }
  | Record<string, unknown>
  | null
  | undefined;

export interface RepositoryScopeContext {
  readonly operation: RepositoryScopeOperation;
  readonly methodName: string;
  readonly dialect: OrmDialect;
  readonly table: string;
  readonly schema?: string;
  readonly tableRef: string;
  readonly idColumn: string;
  readonly idProperty: string;
  readonly columns: Readonly<Record<string, string>>;
  readonly camelCaseMapping: boolean;
  readonly driver: OrmDriverLike;
  readonly quoteIdentifier: (identifier: string, context?: string) => string;
  readonly formatPlaceholder: (index1Based: number) => string;
  readonly nextPlaceholder: () => string;
  readonly resolveColumn: (propertyOrColumn: string) => string;
  readonly serializeValue: (columnName: string, value: unknown) => unknown;
  readonly activeScopes: readonly RepositoryScopeDefinition<any>[];
  readonly buildActiveScopesWhere: (options?: {
    readonly excludeScopes?: readonly string[];
    readonly startParamIndex?: number;
  }) => { readonly sql: string; readonly params: readonly unknown[] };
}

export interface RepositoryScopeDefinition<TEntity = any> {
  /** Unique scope name (used by `@IgnoreScope(name)` and deduplication). */
  readonly name: string;
  /** Optional SQL clause or column-value filter automatically appended to queries. */
  readonly where?: (ctx: RepositoryScopeContext) => RepositoryScopeWhereResult;
  /** Optional mutation hook run before `save()` / `saveMany()` persists an entity. */
  readonly beforeSave?: (
    entity: Partial<TEntity>,
    ctx: RepositoryScopeContext,
  ) => Partial<TEntity> | void;
  /** Optional `deleteById(id)` interceptor (used by `@SoftDelete`). */
  readonly onDeleteById?: (
    id: unknown,
    ctx: RepositoryScopeContext,
  ) => Promise<void> | void;
}

export interface SoftDeleteOptions {
  /** SQL column name storing deletion timestamp. Defaults to `"deleted_at"` (or entity column mapping for `property`). */
  readonly column?: string;
  /** Entity property name corresponding to the deletion timestamp. Defaults to `"deletedAt"`. */
  readonly property?: string;
  /** Scope name used with `@IgnoreScope(...)`. Defaults to `"softDelete"`. */
  readonly name?: string;
  /** Custom timestamp factory invoked on soft-delete. Defaults to `() => new Date()`. */
  readonly now?: () => unknown;
}

export interface ResolvedSoftDeleteConfig {
  readonly name: string;
  readonly property: string;
  readonly explicitColumn?: string;
  readonly now?: () => unknown;
}

export interface TenantScopedOptions {
  /** SQL column name storing the tenant identifier. Defaults to `"tenant_id"` (or entity column mapping for `property`). */
  readonly column?: string;
  /** Entity property name auto-populated on `save()`/`saveMany()`. Defaults to `"tenantId"`. */
  readonly property?: string;
  /** Scope name used with `@IgnoreScope(...)`. Defaults to `"tenant"`. */
  readonly name?: string;
  /** Custom resolver returning the current tenant ID; falls back to `ClsService` / `getCurrentRequestContext()`. */
  readonly resolveTenant?: () => unknown;
  /** When `true` (default), throws an error if no tenant ID can be resolved. */
  readonly required?: boolean;
}

export interface IgnoreScopeSpec {
  readonly all: boolean;
  readonly names: readonly string[];
}

const ambientIgnoreScopeStorage = new ContextStorage<IgnoreScopeSpec>();
const ambientClsService = new ClsService();

function mergeIgnoreScopeSpecs(
  a: IgnoreScopeSpec | undefined,
  b: IgnoreScopeSpec | undefined,
): IgnoreScopeSpec | undefined {
  if (!a) return b;
  if (!b) return a;
  if (a.all || b.all) {
    return { all: true, names: [] };
  }
  const merged = new Set<string>([...a.names, ...b.names]);
  return { all: false, names: [...merged] };
}

/**
 * Returns the active ambient `@IgnoreScope` specification for the current async execution chain.
 */
export function getAmbientIgnoredScopes(): IgnoreScopeSpec | undefined {
  return ambientIgnoreScopeStorage.getStore();
}

/**
 * Runs `fn` with the specified scope names (or ALL scopes when `spec.all` is `true`
 * or `scopeNames` is empty/omitted) disabled across async boundaries.
 */
export function runWithIgnoredScopes<T>(
  specOrNames: IgnoreScopeSpec | readonly string[] | undefined,
  fn: () => T,
): T {
  const incoming: IgnoreScopeSpec =
    specOrNames === undefined
      ? { all: true, names: [] }
      : Array.isArray(specOrNames)
        ? specOrNames.length === 0
          ? { all: true, names: [] }
          : { all: false, names: [...specOrNames] }
        : (specOrNames as IgnoreScopeSpec);
  const merged = mergeIgnoreScopeSpecs(
    ambientIgnoreScopeStorage.getStore(),
    incoming,
  )!;
  return ambientIgnoreScopeStorage.run(merged, fn);
}

/**
 * Returns `true` if `scopeName` is disabled by either the method-level `@IgnoreScope`
 * metadata or the ambient async ignored-scope context.
 */
export function isScopeIgnored(
  scopeName: string,
  methodSpec?: IgnoreScopeSpec,
  ambientSpec?: IgnoreScopeSpec,
): boolean {
  if (methodSpec) {
    if (methodSpec.all || methodSpec.names.includes(scopeName)) {
      return true;
    }
  }
  if (ambientSpec) {
    if (ambientSpec.all || ambientSpec.names.includes(scopeName)) {
      return true;
    }
  }
  return false;
}

function registerRepositoryScopeOnTarget<TEntity>(
  target: object,
  scope: RepositoryScopeDefinition<TEntity>,
): void {
  if (!scope || typeof scope.name !== "string" || scope.name.trim().length === 0) {
    throw new Error(
      "@RepositoryScope() requires a scope definition with a non-empty \"name\".",
    );
  }
  const existing =
    MetadataRegistry.getOwn<readonly RepositoryScopeDefinition<any>[]>(
      ORM_REPOSITORY_SCOPES_METADATA,
      target,
    ) ?? [];
  // Prepend because TypeScript evaluates stacked class decorators bottom-to-top,
  // keeping source declaration order intact; deduplicate by name (top/explicit wins).
  const deduped = existing.filter((s) => s.name !== scope.name);
  MetadataRegistry.define(
    ORM_REPOSITORY_SCOPES_METADATA,
    [scope, ...deduped],
    target,
  );
}

/**
 * Repeatable class decorator attaching an implicit repository scope (`where`,
 * `beforeSave`, and/or `onDeleteById`) to an `@Repository` class.
 */
export function RepositoryScope<TEntity = any>(
  scope: RepositoryScopeDefinition<TEntity>,
): ClassDecorator {
  if (!scope || typeof scope.name !== "string" || scope.name.trim().length === 0) {
    throw new Error(
      "@RepositoryScope() requires a scope definition with a non-empty \"name\".",
    );
  }
  return (target) => {
    registerRepositoryScopeOnTarget(target, scope);
  };
}

export function resolveSoftDeleteConfig(
  options?: SoftDeleteOptions,
): ResolvedSoftDeleteConfig {
  const name = options?.name ?? "softDelete";
  const property = options?.property ?? "deletedAt";
  const explicitColumn =
    options?.column !== undefined
      ? assertSafeSqlIdentifier(options.column, "soft-delete column name")
      : undefined;
  return {
    name,
    property,
    ...(explicitColumn !== undefined ? { explicitColumn } : {}),
    ...(options?.now !== undefined ? { now: options.now } : {}),
  };
}

function resolveSoftDeleteColumnName(
  config: ResolvedSoftDeleteConfig,
  resolveColumn: (propOrCol: string) => string,
): string {
  if (config.explicitColumn !== undefined) {
    return config.explicitColumn;
  }
  return resolveColumn(config.property);
}

function resolveSoftDeleteNowValue(
  config: ResolvedSoftDeleteConfig,
  delCol: string,
  serializeValue: (col: string, val: unknown) => unknown,
): unknown {
  const raw = config.now ? config.now() : new Date();
  if (raw instanceof Date) {
    return serializeValue(delCol, raw);
  }
  return raw;
}

/**
 * Builds the `RepositoryScopeDefinition` backing `@SoftDelete()` and `withSoftDelete()`.
 */
export function createSoftDeleteScope<TEntity = any>(
  options?: SoftDeleteOptions,
): {
  readonly config: ResolvedSoftDeleteConfig;
  readonly scope: RepositoryScopeDefinition<TEntity>;
} {
  const config = resolveSoftDeleteConfig(options);

  const scope: RepositoryScopeDefinition<TEntity> = {
    name: config.name,
    where(ctx) {
      const delCol = resolveSoftDeleteColumnName(config, ctx.resolveColumn);
      const quotedDel = ctx.quoteIdentifier(delCol, "soft-delete column");
      return { sql: `${quotedDel} IS NULL` };
    },
    async onDeleteById(id, ctx) {
      const delCol = resolveSoftDeleteColumnName(config, ctx.resolveColumn);
      const quotedDel = ctx.quoteIdentifier(delCol, "soft-delete column");
      const quotedId = ctx.quoteIdentifier(ctx.idColumn, "id column name");
      const nowVal = resolveSoftDeleteNowValue(config, delCol, ctx.serializeValue);
      const pNow = ctx.formatPlaceholder(1);
      const pId = ctx.formatPlaceholder(2);
      const otherScopes = ctx.buildActiveScopesWhere({
        excludeScopes: [config.name],
        startParamIndex: 2,
      });
      const extraWhere = otherScopes.sql ? ` AND ${otherScopes.sql}` : "";
      const sql = `UPDATE ${ctx.tableRef} SET ${quotedDel} = ${pNow} WHERE ${quotedId} = ${pId} AND ${quotedDel} IS NULL${extraWhere}`;
      await ctx.driver.execute(sql, [nowVal, id, ...otherScopes.params]);
    },
  };

  return { config, scope };
}

/**
 * Class decorator enabling automatic soft-delete scoping (`<col> IS NULL`),
 * soft-delete interception on `deleteById(id)`, and `softDeleteById` /
 * `restoreById` / `hardDeleteById` repository methods.
 */
export function SoftDelete(options?: SoftDeleteOptions): ClassDecorator {
  const { config, scope } = createSoftDeleteScope(options);
  return (target) => {
    MetadataRegistry.define(ORM_SOFT_DELETE_CONFIG_METADATA, config, target);
    registerRepositoryScopeOnTarget(target, scope);
  };
}

function resolveAmbientTenantValue(
  property: string,
  column: string,
): unknown {
  // 1. Check ambient Bunest ClsService store
  if (ambientClsService.isActive()) {
    const fromCls =
      ambientClsService.get(property) ??
      ambientClsService.get("tenantId") ??
      ambientClsService.get("tenant") ??
      ambientClsService.get(column);
    if (fromCls !== undefined && fromCls !== null && fromCls !== "") {
      return fromCls;
    }
  }

  // 2. Check ambient HTTP RequestContext (custom property, session, hostParams, route params, x-tenant-id header)
  const reqCtx = getCurrentRequestContext();
  if (reqCtx) {
    const rec = reqCtx as unknown as Record<string, unknown>;
    const fromReq =
      rec[property] ??
      rec["tenantId"] ??
      reqCtx.session?.[property] ??
      reqCtx.session?.["tenantId"] ??
      reqCtx.session?.["tenant"] ??
      reqCtx.hostParams?.["tenant"] ??
      reqCtx.params?.[property] ??
      reqCtx.params?.["tenantId"] ??
      reqCtx.request.headers.get("x-tenant-id");
    if (fromReq !== undefined && fromReq !== null && fromReq !== "") {
      return fromReq;
    }
  }

  return undefined;
}

/**
 * Class decorator enforcing automatic multi-tenant isolation (`WHERE <tenantCol> = <p>`)
 * on all reads, counts, exists, and deletes, and auto-populating `entity[property] = tenantId`
 * on `save()` / `saveMany()`.
 */
export function TenantScoped(options?: TenantScopedOptions): ClassDecorator {
  const scopeName = options?.name ?? "tenant";
  const explicitColumn =
    options?.column !== undefined
      ? assertSafeSqlIdentifier(options.column, "tenant column name")
      : undefined;
  const explicitProperty = options?.property;
  const defaultProperty =
    explicitProperty ??
    (explicitColumn !== undefined ? snakeToCamel(explicitColumn) : "tenantId");
  const required = options?.required !== false;

  const resolveColumnAndProperty = (
    ctx: RepositoryScopeContext,
  ): { column: string; property: string } => {
    if (explicitColumn !== undefined) {
      if (explicitProperty !== undefined) {
        return { column: explicitColumn, property: explicitProperty };
      }
      for (const [prop, col] of Object.entries(ctx.columns)) {
        if (col === explicitColumn) {
          return { column: explicitColumn, property: prop };
        }
      }
      return {
        column: explicitColumn,
        property: ctx.camelCaseMapping
          ? snakeToCamel(explicitColumn)
          : explicitColumn,
      };
    }
    return {
      column: ctx.resolveColumn(defaultProperty),
      property: defaultProperty,
    };
  };

  const resolveTenantId = (ctx: RepositoryScopeContext): unknown => {
    const { column, property } = resolveColumnAndProperty(ctx);
    const tenantId = options?.resolveTenant
      ? options.resolveTenant()
      : resolveAmbientTenantValue(property, column);

    if (tenantId === undefined || tenantId === null || tenantId === "") {
      if (required) {
        throw new Error(
          `Tenant scope "${scopeName}" requires an active tenant ID for "${ctx.table}.${column}", but none was resolved. Provide resolveTenant(), set "${property}" in ClsService or RequestContext, or bypass with @IgnoreScope("${scopeName}").`,
        );
      }
      return undefined;
    }
    return tenantId;
  };

  const scope: RepositoryScopeDefinition<any> = {
    name: scopeName,
    where(ctx) {
      const tenantId = resolveTenantId(ctx);
      if (tenantId === undefined) {
        return null;
      }
      const { column } = resolveColumnAndProperty(ctx);
      const quotedCol = ctx.quoteIdentifier(column, "tenant column");
      return {
        sql: `${quotedCol} = ${ctx.nextPlaceholder()}`,
        params: [ctx.serializeValue(column, tenantId)],
      };
    },
    beforeSave(entity, ctx) {
      const tenantId = resolveTenantId(ctx);
      if (tenantId === undefined) {
        return;
      }
      const { property } = resolveColumnAndProperty(ctx);
      return {
        ...(entity as Record<string, unknown>),
        [property]: tenantId,
      };
    },
  };

  return (target) => {
    registerRepositoryScopeOnTarget(target, scope);
  };
}

/**
 * Collects all `@RepositoryScope` definitions attached across a repository class's
 * inheritance chain (base -> derived, deduplicated by `name` with derived winning).
 */
export function getRepositoryScopes(
  target: Function,
): readonly RepositoryScopeDefinition<any>[] {
  const chain = getConstructorChain(target);
  const byName = new Map<string, RepositoryScopeDefinition<any>>();
  const order: string[] = [];

  for (let i = 0; i < chain.length; i++) {
    const own = MetadataRegistry.getOwn<readonly RepositoryScopeDefinition<any>[]>(
      ORM_REPOSITORY_SCOPES_METADATA,
      chain[i]!,
    );
    if (!own) continue;
    for (let j = 0; j < own.length; j++) {
      const scope = own[j]!;
      if (!byName.has(scope.name)) {
        order.push(scope.name);
      }
      byName.set(scope.name, scope);
    }
  }

  return order.map((name) => byName.get(name)!);
}

/**
 * Returns the resolved `@SoftDelete()` configuration for a repository class (if any).
 */
export function getSoftDeleteConfig(
  target: Function,
): ResolvedSoftDeleteConfig | undefined {
  return MetadataRegistry.get<ResolvedSoftDeleteConfig>(
    ORM_SOFT_DELETE_CONFIG_METADATA,
    target,
  );
}

// ============================================================================
// 4. First-Class Pagination (Pageable, Page<T>, CursorPageable, CursorPage<T>)
// ============================================================================

export interface PageSortSpec {
  readonly property: string;
  readonly direction?: "ASC" | "DESC";
}

export interface Pageable {
  /** 1-based page number (values `< 1` are clamped to `1`). */
  readonly page: number;
  /** Maximum number of items per page (must be `>= 1`). */
  readonly size: number;
  /** Optional sort clauses overriding default ordering. */
  readonly sort?: readonly PageSortSpec[];
  readonly [PAGEABLE_BRAND]?: true;
}

export interface Page<T> {
  readonly items: T[];
  readonly total: number;
  readonly page: number;
  readonly size: number;
  readonly totalPages: number;
  readonly hasNext: boolean;
  readonly hasPrevious: boolean;
}

export interface CursorPageable {
  /** Keyset cursor from the previous page (`undefined` / `null` starts from the beginning). */
  readonly cursor?: string | number | null;
  /** Maximum number of items per page (must be `>= 1`). */
  readonly limit: number;
  /** Entity property (or SQL column) used for keyset ordering. Defaults to the repository's primary key. */
  readonly cursorField?: string;
  /** Sort direction for keyset traversal. Defaults to `"ASC"`. */
  readonly direction?: "ASC" | "DESC";
  readonly [CURSOR_PAGEABLE_BRAND]?: true;
}

export interface CursorPage<T> {
  readonly items: T[];
  readonly nextCursor: string | number | null;
  readonly hasMore: boolean;
  readonly limit: number;
}

/**
 * Type guard identifying a `Pageable` offset pagination descriptor.
 */
export function isPageable(value: unknown): value is Pageable {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const rec = value as Record<PropertyKey, unknown>;
  if (rec[PAGEABLE_BRAND] === true) {
    return true;
  }
  if ("limit" in rec) {
    return false;
  }
  if (
    typeof rec["page"] !== "number" ||
    !Number.isFinite(rec["page"]) ||
    typeof rec["size"] !== "number" ||
    !Number.isFinite(rec["size"]) ||
    rec["size"] <= 0
  ) {
    return false;
  }
  if ("sort" in rec && rec["sort"] !== undefined) {
    if (!Array.isArray(rec["sort"])) {
      return false;
    }
    for (let i = 0; i < rec["sort"].length; i++) {
      const item = rec["sort"][i] as Record<string, unknown> | null;
      if (
        !item ||
        typeof item !== "object" ||
        typeof item["property"] !== "string" ||
        item["property"].length === 0
      ) {
        return false;
      }
      if (
        item["direction"] !== undefined &&
        item["direction"] !== "ASC" &&
        item["direction"] !== "DESC"
      ) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Type guard identifying a `CursorPageable` keyset pagination descriptor.
 */
export function isCursorPageable(value: unknown): value is CursorPageable {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const rec = value as Record<PropertyKey, unknown>;
  if (rec[CURSOR_PAGEABLE_BRAND] === true) {
    return true;
  }
  if ("page" in rec || "size" in rec) {
    return false;
  }
  if (
    typeof rec["limit"] !== "number" ||
    !Number.isFinite(rec["limit"]) ||
    rec["limit"] <= 0
  ) {
    return false;
  }
  if (
    "cursor" in rec &&
    rec["cursor"] !== undefined &&
    rec["cursor"] !== null &&
    typeof rec["cursor"] !== "string" &&
    typeof rec["cursor"] !== "number"
  ) {
    return false;
  }
  if (
    "cursorField" in rec &&
    rec["cursorField"] !== undefined &&
    typeof rec["cursorField"] !== "string"
  ) {
    return false;
  }
  if (
    "direction" in rec &&
    rec["direction"] !== undefined &&
    rec["direction"] !== "ASC" &&
    rec["direction"] !== "DESC"
  ) {
    return false;
  }
  return true;
}

/**
 * Convenience builder returning a branded `Pageable` descriptor.
 */
export function createPageable(pageable: Omit<Pageable, typeof PAGEABLE_BRAND>): Pageable {
  return {
    ...pageable,
    [PAGEABLE_BRAND]: true,
  };
}

/**
 * Convenience builder returning a branded `CursorPageable` descriptor.
 */
export function createCursorPageable(
  pageable: Omit<CursorPageable, typeof CURSOR_PAGEABLE_BRAND>,
): CursorPageable {
  return {
    ...pageable,
    [CURSOR_PAGEABLE_BRAND]: true,
  };
}

/**
 * Extracts a normalized cursor value (`string | number | null`) from a raw database row.
 */
export function extractCursorValue(
  row: Record<string, unknown>,
  cursorCol: string,
  cursorField: string,
): string | number | null {
  const raw = row[cursorCol] !== undefined ? row[cursorCol] : row[cursorField];
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw === "number" || typeof raw === "string") {
    return raw;
  }
  if (typeof raw === "bigint") {
    return raw <= BigInt(Number.MAX_SAFE_INTEGER) &&
      raw >= BigInt(Number.MIN_SAFE_INTEGER)
      ? Number(raw)
      : raw.toString();
  }
  if (raw instanceof Date) {
    return raw.toISOString();
  }
  return String(raw);
}

// ============================================================================
// 5. Composable Repository Fragments (composeRepository, withSoftDelete, withCursorPagination)
// ============================================================================

export interface RepositoryFragmentRuntimeContext<TEntity extends object = any> {
  readonly driver: OrmDriverLike;
  readonly dialect: OrmDialect;
  readonly table: string;
  readonly schema?: string;
  readonly tableRef: string;
  readonly idColumn: string;
  readonly idProperty: string;
  readonly columns: Readonly<Record<string, string>>;
  readonly camelCaseMapping: boolean;
  readonly quoteIdentifier: (identifier: string, context?: string) => string;
  readonly formatPlaceholder: (index1Based: number) => string;
  readonly resolveColumn: (propertyOrColumn: string) => string;
  readonly hydrateRow: (row: Record<string, unknown>) => TEntity;
  readonly serializeValue: (columnName: string, value: unknown) => unknown;
  readonly buildActiveScopesWhere: (options?: {
    readonly excludeScopes?: readonly string[];
    readonly startParamIndex?: number;
    readonly methodName?: string;
  }) => { readonly sql: string; readonly params: readonly unknown[] };
  readonly softDeleteConfig?: ResolvedSoftDeleteConfig;
  readonly getRepository: () => object;
}

export interface RepositoryFragment<
  TMethods extends object = object,
  TEntity extends object = any,
> {
  readonly name: string;
  readonly scopes?: readonly RepositoryScopeDefinition<TEntity>[];
  readonly softDeleteConfig?: ResolvedSoftDeleteConfig;
  readonly createMethods: (
    ctx: RepositoryFragmentRuntimeContext<TEntity>,
  ) => TMethods;
}

export interface SoftDeleteFragmentMethods<TKey = number> {
  softDeleteById(id: TKey): Promise<void>;
  restoreById(id: TKey): Promise<void>;
  hardDeleteById(id: TKey): Promise<void>;
}

export interface CursorPaginationFragmentOptions {
  readonly cursorField?: string;
  readonly defaultLimit?: number;
  readonly direction?: "ASC" | "DESC";
}

export interface CursorPaginationFragmentMethods<TEntity extends object = any> {
  findCursorPage(
    pageable?: Partial<CursorPageable>,
  ): Promise<CursorPage<TEntity>>;
}

/**
 * Identity helper preserving strong method types when authoring custom `RepositoryFragment`s.
 */
export function defineRepositoryFragment<
  TMethods extends object,
  TEntity extends object = any,
>(
  fragment: RepositoryFragment<TMethods, TEntity>,
): RepositoryFragment<TMethods, TEntity> {
  return fragment;
}

/**
 * Builds the concrete `softDeleteById`, `restoreById`, and `hardDeleteById`
 * method implementations shared by `@SoftDelete()` and `withSoftDelete()`.
 */
export function createSoftDeleteMethods<TKey = number>(
  config: ResolvedSoftDeleteConfig,
  ctx: RepositoryFragmentRuntimeContext<any>,
): SoftDeleteFragmentMethods<TKey> {
  const getDelCol = () => resolveSoftDeleteColumnName(config, ctx.resolveColumn);

  return {
    async softDeleteById(id: TKey): Promise<void> {
      const delCol = getDelCol();
      const quotedDel = ctx.quoteIdentifier(delCol, "soft-delete column");
      const quotedId = ctx.quoteIdentifier(ctx.idColumn, "id column name");
      const nowVal = resolveSoftDeleteNowValue(config, delCol, ctx.serializeValue);
      const pNow = ctx.formatPlaceholder(1);
      const pId = ctx.formatPlaceholder(2);
      const otherScopes = ctx.buildActiveScopesWhere({
        excludeScopes: [config.name],
        startParamIndex: 2,
        methodName: "softDeleteById",
      });
      const extraWhere = otherScopes.sql ? ` AND ${otherScopes.sql}` : "";
      const sql = `UPDATE ${ctx.tableRef} SET ${quotedDel} = ${pNow} WHERE ${quotedId} = ${pId} AND ${quotedDel} IS NULL${extraWhere}`;
      await ctx.driver.execute(sql, [nowVal, id, ...otherScopes.params]);
    },

    async restoreById(id: TKey): Promise<void> {
      const delCol = getDelCol();
      const quotedDel = ctx.quoteIdentifier(delCol, "soft-delete column");
      const quotedId = ctx.quoteIdentifier(ctx.idColumn, "id column name");
      const pId = ctx.formatPlaceholder(1);
      const otherScopes = ctx.buildActiveScopesWhere({
        excludeScopes: [config.name],
        startParamIndex: 1,
        methodName: "restoreById",
      });
      const extraWhere = otherScopes.sql ? ` AND ${otherScopes.sql}` : "";
      const sql = `UPDATE ${ctx.tableRef} SET ${quotedDel} = NULL WHERE ${quotedId} = ${pId} AND ${quotedDel} IS NOT NULL${extraWhere}`;
      await ctx.driver.execute(sql, [id, ...otherScopes.params]);
    },

    async hardDeleteById(id: TKey): Promise<void> {
      const quotedId = ctx.quoteIdentifier(ctx.idColumn, "id column name");
      const pId = ctx.formatPlaceholder(1);
      const otherScopes = ctx.buildActiveScopesWhere({
        excludeScopes: [config.name],
        startParamIndex: 1,
        methodName: "hardDeleteById",
      });
      const extraWhere = otherScopes.sql ? ` AND ${otherScopes.sql}` : "";
      const sql = `DELETE FROM ${ctx.tableRef} WHERE ${quotedId} = ${pId}${extraWhere}`;
      await ctx.driver.execute(sql, [id, ...otherScopes.params]);
    },
  };
}

/**
 * Composable repository fragment adding `softDeleteById(id)`, `restoreById(id)`,
 * and `hardDeleteById(id)` (and registering the soft-delete scope if not already present).
 */
export function withSoftDelete<
  TEntity extends object = any,
  TKey = number,
>(
  options?: SoftDeleteOptions,
): RepositoryFragment<SoftDeleteFragmentMethods<TKey>, TEntity> {
  const { config, scope } = createSoftDeleteScope<TEntity>(options);
  const hasExplicitOptions = options !== undefined;
  return {
    name: `withSoftDelete:${config.name}`,
    scopes: [scope],
    softDeleteConfig: config,
    createMethods(ctx) {
      const effectiveConfig =
        !hasExplicitOptions && ctx.softDeleteConfig
          ? ctx.softDeleteConfig
          : config;
      return createSoftDeleteMethods<TKey>(effectiveConfig, ctx);
    },
  };
}

/**
 * Composable repository fragment adding keyset cursor pagination (`findCursorPage`)
 * that automatically respects all active repository scopes (`@SoftDelete`, `@TenantScoped`, etc.).
 */
export function withCursorPagination<TEntity extends object = any>(
  options?: CursorPaginationFragmentOptions,
): RepositoryFragment<CursorPaginationFragmentMethods<TEntity>, TEntity> {
  const defaultLimit = Math.max(1, Math.floor(options?.defaultLimit ?? 20));
  const defaultDirection = options?.direction ?? "ASC";

  return {
    name: "withCursorPagination",
    createMethods(ctx) {
      const profile = getDialectProfile(ctx.dialect);

      return {
        async findCursorPage(
          pageable?: Partial<CursorPageable>,
        ): Promise<CursorPage<TEntity>> {
          const limit = Math.max(
            1,
            Math.floor(pageable?.limit ?? defaultLimit),
          );
          const cursorField =
            pageable?.cursorField ?? options?.cursorField ?? ctx.idProperty;
          const cursorCol = ctx.resolveColumn(cursorField);
          const quotedCursor = ctx.quoteIdentifier(cursorCol, "cursor column");
          const direction = pageable?.direction ?? defaultDirection;

          const whereParts: string[] = [];
          const params: unknown[] = [];

          const scopeWhere = ctx.buildActiveScopesWhere({
            startParamIndex: 0,
            methodName: "findCursorPage",
          });
          if (scopeWhere.sql) {
            whereParts.push(scopeWhere.sql);
            params.push(...scopeWhere.params);
          }

          if (pageable?.cursor !== undefined && pageable.cursor !== null) {
            const ph = formatPlaceholder(params.length + 1, ctx.dialect);
            const op = direction === "DESC" ? "<" : ">";
            whereParts.push(`${quotedCursor} ${op} ${ph}`);
            params.push(ctx.serializeValue(cursorCol, pageable.cursor));
          }

          const whereClause =
            whereParts.length > 0 ? ` WHERE ${whereParts.join(" AND ")}` : "";
          const orderClause = ` ORDER BY ${quotedCursor} ${direction}`;
          const limitClause = profile.formatLimitOffset(
            limit + 1,
            undefined,
            true,
          );
          const sql = `SELECT * FROM ${ctx.tableRef}${whereClause}${orderClause}${limitClause}`;

          const res = await ctx.driver.query<Record<string, unknown>>(
            sql,
            params,
          );
          const hasMore = res.rows.length > limit;
          const slice = hasMore ? res.rows.slice(0, limit) : res.rows;
          const items = slice.map((r) => ctx.hydrateRow(r));
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
        },
      };
    },
  };
}

type UnionToIntersection<U> = (
  U extends unknown ? (arg: U) => void : never
) extends (arg: infer I) => void
  ? I
  : never;

type ExtractFragmentMethods<
  TFragments extends readonly RepositoryFragment<any, any>[],
> = TFragments extends readonly []
  ? Record<never, never>
  : UnionToIntersection<
      TFragments[number] extends RepositoryFragment<infer TMethods, any>
        ? TMethods
        : never
    >;

export type ComposedRepositoryClass<
  TBase extends Abstract<object>,
  TFragments extends readonly RepositoryFragment<any, any>[],
> = (abstract new (
  ...args: ConstructorParameters<TBase>
) => InstanceType<TBase> & ExtractFragmentMethods<TFragments>) &
  Omit<TBase, "prototype">;

function attachFragmentsToTarget(
  target: object,
  fragments: readonly RepositoryFragment<any, any>[],
  prepend: boolean,
): void {
  const existing =
    MetadataRegistry.getOwn<readonly RepositoryFragment<any, any>[]>(
      ORM_REPOSITORY_FRAGMENTS_METADATA,
      target,
    ) ?? [];

  const combined = prepend
    ? [...fragments, ...existing]
    : [...existing, ...fragments];

  MetadataRegistry.define(
    ORM_REPOSITORY_FRAGMENTS_METADATA,
    combined,
    target,
  );

  const orderedForScopes = prepend ? [...fragments].reverse() : fragments;
  for (let i = 0; i < orderedForScopes.length; i++) {
    const frag = orderedForScopes[i]!;
    if (frag.scopes) {
      const scopes = prepend ? [...frag.scopes].reverse() : frag.scopes;
      for (let j = 0; j < scopes.length; j++) {
        const s = scopes[j]!;
        // Do not overwrite an explicit class-level or inherited scope with the same name
        const existingScopes =
          typeof target === "function"
            ? getRepositoryScopes(target)
            : (MetadataRegistry.getOwn<readonly RepositoryScopeDefinition<any>[]>(
                ORM_REPOSITORY_SCOPES_METADATA,
                target,
              ) ?? []);
        if (!existingScopes.some((ex) => ex.name === s.name)) {
          registerRepositoryScopeOnTarget(target, s);
        }
      }
    }
    if (
      frag.softDeleteConfig &&
      !MetadataRegistry.get<ResolvedSoftDeleteConfig>(
        ORM_SOFT_DELETE_CONFIG_METADATA,
        target,
      )
    ) {
      MetadataRegistry.define(
        ORM_SOFT_DELETE_CONFIG_METADATA,
        frag.softDeleteConfig,
        target,
      );
    }
  }
}

/**
 * Composes a declarative repository base class with one or more reusable
 * `RepositoryFragment` traits (`withSoftDelete()`, `withCursorPagination()`,
 * or custom fragments) with full TypeScript intersection typing and zero
 * single-inheritance constraints.
 */
export function composeRepository<
  TBase extends Abstract<object>,
  const TFragments extends readonly RepositoryFragment<any, any>[],
>(
  BaseRepoClass: TBase,
  ...fragments: TFragments
): ComposedRepositoryClass<TBase, TFragments> {
  abstract class ComposedRepository extends (BaseRepoClass as unknown as new (
    ...args: unknown[]
  ) => object) {}

  if (BaseRepoClass.name) {
    Object.defineProperty(ComposedRepository, "name", {
      value: `${BaseRepoClass.name}Composed`,
      configurable: true,
    });
  }

  attachFragmentsToTarget(ComposedRepository, fragments, false);

  return ComposedRepository as unknown as ComposedRepositoryClass<
    TBase,
    TFragments
  >;
}

/**
 * Collects all `RepositoryFragment`s attached across a repository class's
 * inheritance chain (base -> derived, deduplicated by fragment name).
 */
export function getRepositoryFragments(
  target: Function,
): readonly RepositoryFragment<any, any>[] {
  const chain = getConstructorChain(target);
  const byName = new Map<string, RepositoryFragment<any, any>>();
  const order: string[] = [];

  for (let i = 0; i < chain.length; i++) {
    const own = MetadataRegistry.getOwn<readonly RepositoryFragment<any, any>[]>(
      ORM_REPOSITORY_FRAGMENTS_METADATA,
      chain[i]!,
    );
    if (!own) continue;
    for (let j = 0; j < own.length; j++) {
      const frag = own[j]!;
      if (!byName.has(frag.name)) {
        order.push(frag.name);
      }
      byName.set(frag.name, frag);
    }
  }

  return order.map((name) => byName.get(name)!);
}
