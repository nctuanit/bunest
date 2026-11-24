import { getDialectProfile } from "./dialect/dialect-profile";
import { EntityNotFoundError } from "./errors";
import {
  IdentityMap,
  hydrateEntityRow,
  invokeLifecycleHooks,
  setShadowFk,
} from "./hydrator";
import {
  assertSafeSqlIdentifier,
  formatTableRef,
  quoteIdentifier,
} from "./identifiers";
import type {
  CompiledEntityMetadata,
  CompiledMetadataGraph,
  CompiledRelationMetadata,
} from "./metadata-graph";
import {
  ParameterCollector,
  bindNamedParamsInFragment,
  compileWhereClause,
} from "./where-builder";
import type {
  CircularJsonStrategy,
  DeleteResult,
  FindOptionsWhere,
  InsertResult,
  OrmDialect,
  OrmQueryExecutor,
  UpdateResult,
} from "./types";

interface JoinSpec {
  readonly type: "INNER" | "LEFT";
  readonly parentAlias: string;
  readonly relation: CompiledRelationMetadata;
  readonly targetMeta: CompiledEntityMetadata;
  readonly alias: string;
  readonly select: boolean;
  readonly customCondition?: string;
}

interface WhereClauseItem {
  readonly combinator: "AND" | "OR";
  readonly sql: string;
}

export interface QueryBuilderContext {
  readonly executor: OrmQueryExecutor;
  readonly graph: CompiledMetadataGraph;
  readonly safeJsonSerialization: boolean;
  readonly circularJsonStrategy: CircularJsonStrategy;
}

/**
 * Fluent TypeORM-style `SelectQueryBuilder` with alias-prefixed column selection,
 * safe `:param` / `:...array` binding, multi-level & cyclic `leftJoinAndSelect` /
 * `innerJoinAndSelect`, and `IdentityMap`-backed row deduplication!
 */
export class SelectQueryBuilder<Entity = Record<string, unknown>> {
  private readonly aliasMeta = new Map<string, CompiledEntityMetadata>();
  private readonly joins: JoinSpec[] = [];
  private readonly customSelects: string[] = [];
  private readonly wheres: WhereClauseItem[] = [];
  private readonly orderBys: Array<{ expr: string; dir: "ASC" | "DESC" }> = [];
  private readonly groupBys: string[] = [];
  private readonly havings: WhereClauseItem[] = [];
  private readonly namedParams: Record<string, unknown> = {};
  private skipCount?: number;
  private takeCount?: number;
  private includeDeleted = false;
  private isDistinct = false;

  constructor(
    private readonly rootMeta: CompiledEntityMetadata,
    private readonly rootAlias: string,
    private readonly ctx: QueryBuilderContext,
  ) {
    assertSafeSqlIdentifier(rootAlias, "query alias");
    this.aliasMeta.set(rootAlias, rootMeta);
  }

  private get dialect(): OrmDialect {
    return this.ctx.executor.dialect;
  }

  distinct(enable = true): this {
    this.isDistinct = enable;
    return this;
  }

  select(selection?: string | readonly string[]): this {
    this.customSelects.length = 0;
    if (selection) {
      this.addSelect(selection);
    }
    return this;
  }

  addSelect(selection: string | readonly string[], alias?: string): this {
    if (Array.isArray(selection)) {
      for (const s of selection) {
        this.customSelects.push(s);
      }
    } else if (typeof selection === "string") {
      this.customSelects.push(
        alias
          ? `${selection} AS ${quoteIdentifier(alias, this.dialect, "column alias")}`
          : selection,
      );
    }
    return this;
  }

  leftJoin(
    relationPath: string,
    alias: string,
    condition?: string,
    params?: Record<string, unknown>,
  ): this {
    return this.addJoin("LEFT", relationPath, alias, false, condition, params);
  }

  innerJoin(
    relationPath: string,
    alias: string,
    condition?: string,
    params?: Record<string, unknown>,
  ): this {
    return this.addJoin("INNER", relationPath, alias, false, condition, params);
  }

  leftJoinAndSelect(
    relationPath: string,
    alias: string,
    condition?: string,
    params?: Record<string, unknown>,
  ): this {
    return this.addJoin("LEFT", relationPath, alias, true, condition, params);
  }

  innerJoinAndSelect(
    relationPath: string,
    alias: string,
    condition?: string,
    params?: Record<string, unknown>,
  ): this {
    return this.addJoin("INNER", relationPath, alias, true, condition, params);
  }

  private addJoin(
    type: "INNER" | "LEFT",
    relationPath: string,
    alias: string,
    select: boolean,
    condition?: string,
    params?: Record<string, unknown>,
  ): this {
    assertSafeSqlIdentifier(alias, "join alias");
    if (params) {
      Object.assign(this.namedParams, params);
    }

    const dotIdx = relationPath.indexOf(".");
    if (dotIdx === -1) {
      throw new Error(
        `Join path "${relationPath}" must be formatted as "<parentAlias>.<relationProperty>".`,
      );
    }
    const parentAlias = relationPath.slice(0, dotIdx);
    const relProp = relationPath.slice(dotIdx + 1);
    const parentMeta = this.aliasMeta.get(parentAlias);
    if (!parentMeta) {
      throw new Error(
        `Unknown join parent alias "${parentAlias}" in "${relationPath}".`,
      );
    }
    const rel = parentMeta.relationsByProperty.get(relProp);
    if (!rel) {
      throw new Error(
        `Relation "${relProp}" does not exist on entity "${parentMeta.name}".`,
      );
    }
    const targetMeta = this.ctx.graph.byTarget.get(rel.target);
    if (!targetMeta) {
      throw new Error(
        `Target entity for relation "${parentMeta.name}.${relProp}" is not registered.`,
      );
    }

    this.aliasMeta.set(alias, targetMeta);
    this.joins.push({
      type,
      parentAlias,
      relation: rel,
      targetMeta,
      alias,
      select,
      ...(condition !== undefined ? { customCondition: condition } : {}),
    });
    return this;
  }

  where(
    condition: string | FindOptionsWhere<Entity>,
    params?: Record<string, unknown>,
  ): this {
    this.wheres.length = 0;
    return this.andWhere(condition, params);
  }

  andWhere(
    condition: string | FindOptionsWhere<Entity>,
    params?: Record<string, unknown>,
  ): this {
    return this.pushWhere("AND", condition, params);
  }

  orWhere(
    condition: string | FindOptionsWhere<Entity>,
    params?: Record<string, unknown>,
  ): this {
    return this.pushWhere("OR", condition, params);
  }

  private pushWhere(
    combinator: "AND" | "OR",
    condition: string | FindOptionsWhere<Entity>,
    params?: Record<string, unknown>,
  ): this {
    if (params) {
      Object.assign(this.namedParams, params);
    }
    if (typeof condition === "string") {
      if (condition.trim().length > 0) {
        this.wheres.push({ combinator, sql: condition });
      }
      return this;
    }
    // Object-style where compiled via parameter keys injected into namedParams
    const collector = new ParameterCollector("sqlite");
    const compiled = compileWhereClause(
      this.rootMeta,
      condition,
      this.rootAlias,
      this.ctx.graph,
      "sqlite",
      true,
      collector,
    );
    if (compiled.sql) {
      let idx = 0;
      const rewritten = compiled.sql.replace(/\?/g, () => {
        const key = `__qb_w_${Object.keys(this.namedParams).length}_${idx}`;
        this.namedParams[key] = compiled.params[idx++];
        return `:${key}`;
      });
      this.wheres.push({ combinator, sql: rewritten });
    }
    return this;
  }

  setParameter(key: string, value: unknown): this {
    this.namedParams[key] = value;
    return this;
  }

  setParameters(params: Record<string, unknown>): this {
    Object.assign(this.namedParams, params);
    return this;
  }

  orderBy(sort: string, direction: "ASC" | "DESC" = "ASC"): this {
    this.orderBys.length = 0;
    return this.addOrderBy(sort, direction);
  }

  addOrderBy(sort: string, direction: "ASC" | "DESC" = "ASC"): this {
    const dir = direction.toUpperCase() === "DESC" ? "DESC" : "ASC";
    this.orderBys.push({ expr: this.resolvePropertyExpression(sort), dir });
    return this;
  }

  groupBy(expr: string): this {
    this.groupBys.length = 0;
    return this.addGroupBy(expr);
  }

  addGroupBy(expr: string): this {
    this.groupBys.push(this.resolvePropertyExpression(expr));
    return this;
  }

  having(condition: string, params?: Record<string, unknown>): this {
    this.havings.length = 0;
    return this.andHaving(condition, params);
  }

  andHaving(condition: string, params?: Record<string, unknown>): this {
    if (params) Object.assign(this.namedParams, params);
    this.havings.push({ combinator: "AND", sql: condition });
    return this;
  }

  skip(skip?: number): this {
    this.skipCount = skip;
    return this;
  }

  offset(offset?: number): this {
    this.skipCount = offset;
    return this;
  }

  take(take?: number): this {
    this.takeCount = take;
    return this;
  }

  limit(limit?: number): this {
    this.takeCount = limit;
    return this;
  }

  withDeleted(): this {
    this.includeDeleted = true;
    return this;
  }

  /**
   * Resolves `alias.propertyName` (including embedded paths `u.hq.city`) to `"alias"."column_name"`.
   */
  private resolvePropertyExpression(expr: string): string {
    const trimmed = expr.trim();
    const parts = trimmed.split(".");
    if (parts.length >= 2) {
      const alias = parts[0]!;
      const meta = this.aliasMeta.get(alias);
      if (meta) {
        const propPath = parts.slice(1).join(".");
        const col =
          meta.columnsByProperty.get(propPath) ??
          meta.columnsByColumnName.get(propPath);
        if (col) {
          return `${quoteIdentifier(alias, this.dialect)}.${quoteIdentifier(col.columnName, this.dialect)}`;
        }
      }
    }
    return trimmed;
  }

  /**
   * Rewrites `alias.propertyName` occurrences inside a SQL expression cleanly while
   * preserving SQL string literals and `:param` placeholders.
   */
  private rewriteAliasProperties(sql: string): string {
    let out = "";
    let i = 0;
    const len = sql.length;

    while (i < len) {
      const ch = sql[i]!;
      if (ch === "'") {
        out += ch;
        i++;
        while (i < len) {
          const c = sql[i]!;
          out += c;
          i++;
          if (c === "'") {
            if (sql[i] === "'") {
              out += "'";
              i++;
            } else {
              break;
            }
          }
        }
        continue;
      }

      if (/[A-Za-z_]/.test(ch)) {
        // Skip `:param` prefixes
        const prev = i > 0 ? sql[i - 1] : "";
        if (prev === ":") {
          out += ch;
          i++;
          continue;
        }
        let end = i;
        while (end < len && /[A-Za-z0-9_.]/.test(sql[end]!)) {
          end++;
        }
        const token = sql.slice(i, end);
        if (token.includes(".")) {
          const parts = token.split(".");
          const alias = parts[0]!;
          const meta = this.aliasMeta.get(alias);
          if (meta) {
            const rest = parts.slice(1).join(".");
            const col =
              meta.columnsByProperty.get(rest) ??
              meta.columnsByColumnName.get(rest);
            if (col) {
              out += `${quoteIdentifier(alias, this.dialect)}.${quoteIdentifier(col.columnName, this.dialect)}`;
              i = end;
              continue;
            }
          }
        }
        out += token;
        i = end;
        continue;
      }

      out += ch;
      i++;
    }
    return out;
  }

  getQueryAndParameters(): [string, unknown[]] {
    const collector = new ParameterCollector(this.dialect);
    const dialect = this.dialect;

    // SELECT clause
    const selectParts: string[] = [];
    if (this.customSelects.length > 0) {
      for (const s of this.customSelects) {
        selectParts.push(this.rewriteAliasProperties(s));
      }
    } else {
      const pushEntitySelect = (alias: string, meta: CompiledEntityMetadata) => {
        const aliasQ = quoteIdentifier(alias, dialect);
        for (const col of meta.columns) {
          if (!col.select && !col.primary && !col.isVirtualJoinColumn) continue;
          const colQ = quoteIdentifier(col.columnName, dialect);
          const asName = quoteIdentifier(`${alias}__${col.columnName}`, dialect);
          selectParts.push(`${aliasQ}.${colQ} AS ${asName}`);
        }
      };

      pushEntitySelect(this.rootAlias, this.rootMeta);
      for (const j of this.joins) {
        if (j.select) {
          pushEntitySelect(j.alias, j.targetMeta);
        }
      }
    }

    const distinctKw = this.isDistinct ? "DISTINCT " : "";
    const rootTableRef = formatTableRef(
      this.rootMeta.tableName,
      this.rootMeta.schema,
      dialect,
    );
    const rootAliasQ = quoteIdentifier(this.rootAlias, dialect);

    let sql = `SELECT ${distinctKw}${selectParts.join(", ")} FROM ${rootTableRef} ${rootAliasQ}`;

    // JOIN clauses
    let jtCounter = 0;
    for (const j of this.joins) {
      const parentMeta = this.aliasMeta.get(j.parentAlias)!;
      const parentAliasQ = quoteIdentifier(j.parentAlias, dialect);
      const targetAliasQ = quoteIdentifier(j.alias, dialect);
      const targetTableRef = formatTableRef(
        j.targetMeta.tableName,
        j.targetMeta.schema,
        dialect,
      );
      const rel = j.relation;

      let extraOn = "";
      if (j.customCondition) {
        const rewritten = this.rewriteAliasProperties(j.customCondition);
        extraOn = ` AND (${bindNamedParamsInFragment(rewritten, this.namedParams, collector)})`;
      }
      if (!this.includeDeleted && j.targetMeta.deleteDateColumn) {
        extraOn += ` AND ${targetAliasQ}.${quoteIdentifier(j.targetMeta.deleteDateColumn.columnName, dialect)} IS NULL`;
      }

      if (rel.kind === "many-to-many" && rel.joinTable) {
        const jt = rel.joinTable;
        const jtAlias = `__jt_${++jtCounter}`;
        const jtAliasQ = quoteIdentifier(jtAlias, dialect);
        const jtRef = formatTableRef(jt.tableName, parentMeta.schema, dialect);
        const ownerPkQ = quoteIdentifier(jt.joinReferencedColumnName, dialect);
        const targetPkQ = quoteIdentifier(jt.inverseReferencedColumnName, dialect);
        const jtOwnerQ = quoteIdentifier(jt.joinColumnName, dialect);
        const jtTargetQ = quoteIdentifier(jt.inverseJoinColumnName, dialect);

        sql += ` ${j.type} JOIN ${jtRef} ${jtAliasQ} ON ${jtAliasQ}.${jtOwnerQ} = ${parentAliasQ}.${ownerPkQ}`;
        sql += ` ${j.type} JOIN ${targetTableRef} ${targetAliasQ} ON ${targetAliasQ}.${targetPkQ} = ${jtAliasQ}.${jtTargetQ}${extraOn}`;
      } else if (rel.isOwning && rel.joinColumnName) {
        const fkQ = quoteIdentifier(rel.joinColumnName, dialect);
        const refQ = quoteIdentifier(
          rel.referencedColumnName ?? j.targetMeta.primaryColumn.columnName,
          dialect,
        );
        sql += ` ${j.type} JOIN ${targetTableRef} ${targetAliasQ} ON ${targetAliasQ}.${refQ} = ${parentAliasQ}.${fkQ}${extraOn}`;
      } else if (rel.joinColumnName) {
        const fkQ = quoteIdentifier(rel.joinColumnName, dialect);
        const ownerRefQ = quoteIdentifier(
          rel.referencedColumnName ?? parentMeta.primaryColumn.columnName,
          dialect,
        );
        sql += ` ${j.type} JOIN ${targetTableRef} ${targetAliasQ} ON ${targetAliasQ}.${fkQ} = ${parentAliasQ}.${ownerRefQ}${extraOn}`;
      }
    }

    // WHERE clause
    const whereParts: string[] = [];
    for (let i = 0; i < this.wheres.length; i++) {
      const w = this.wheres[i]!;
      const rewritten = this.rewriteAliasProperties(w.sql);
      const bound = bindNamedParamsInFragment(rewritten, this.namedParams, collector);
      if (i === 0) {
        whereParts.push(`(${bound})`);
      } else {
        whereParts.push(`${w.combinator} (${bound})`);
      }
    }

    if (!this.includeDeleted && this.rootMeta.deleteDateColumn) {
      const delCond = `${rootAliasQ}.${quoteIdentifier(this.rootMeta.deleteDateColumn.columnName, dialect)} IS NULL`;
      if (whereParts.length === 0) {
        whereParts.push(delCond);
      } else {
        whereParts.push(`AND ${delCond}`);
      }
    }

    if (whereParts.length > 0) {
      sql += ` WHERE ${whereParts.join(" ")}`;
    }

    if (this.groupBys.length > 0) {
      sql += ` GROUP BY ${this.groupBys.join(", ")}`;
    }

    if (this.havings.length > 0) {
      const havingParts = this.havings.map((h, i) => {
        const bound = bindNamedParamsInFragment(
          this.rewriteAliasProperties(h.sql),
          this.namedParams,
          collector,
        );
        return i === 0 ? `(${bound})` : `${h.combinator} (${bound})`;
      });
      sql += ` HAVING ${havingParts.join(" ")}`;
    }

    if (this.orderBys.length > 0) {
      sql += ` ORDER BY ${this.orderBys.map((o) => `${o.expr} ${o.dir}`).join(", ")}`;
    }

    // Only push SQL LIMIT/OFFSET when there are no to-many joins that could slice child rows prematurely
    const hasToManyJoin = this.joins.some(
      (j) =>
        j.select &&
        (j.relation.kind === "one-to-many" || j.relation.kind === "many-to-many"),
    );

    if (!hasToManyJoin) {
      sql += getDialectProfile(dialect).formatLimitOffset(
        this.takeCount,
        this.skipCount,
        this.orderBys.length > 0,
      );
    }

    return [sql, collector.values];
  }

  getSql(): string {
    return this.getQueryAndParameters()[0];
  }

  async getRawMany<T = Record<string, unknown>>(): Promise<T[]> {
    const [sql, params] = this.getQueryAndParameters();
    const res = await this.ctx.executor.query<T>(sql, params);
    return res.rows;
  }

  async getRawOne<T = Record<string, unknown>>(): Promise<T | undefined> {
    const rows = await this.getRawMany<T>();
    return rows[0];
  }

  /**
   * Executes the query and hydrates root entities + all joined relations via an
   * `IdentityMap`, collapsing duplicate joined rows and preserving circular object identity!
   */
  async getMany(): Promise<Entity[]> {
    const rawRows = await this.getRawMany<Record<string, unknown>>();
    if (rawRows.length === 0) return [];

    const identityMap = new IdentityMap();
    const hooksRun = new WeakSet<object>();
    const rootList: Entity[] = [];
    const seenRoots = new Set<object>();

    const selectedJoins = this.joins.filter((j) => j.select);

    const hydrateOptions = {
      identityMap,
      safeJsonSerialization: this.ctx.safeJsonSerialization,
      circularJsonStrategy: this.ctx.circularJsonStrategy,
    };

    for (const row of rawRows) {
      const rootPkVal = row[`${this.rootAlias}__${this.rootMeta.primaryColumn.columnName}`];
      if (rootPkVal === undefined || rootPkVal === null) continue;

      const rootEntity = hydrateEntityRow<Record<string, unknown>>(
        this.rootMeta,
        row,
        {
          ...hydrateOptions,
          columnPrefix: `${this.rootAlias}__`,
        },
      );

      if (!seenRoots.has(rootEntity)) {
        seenRoots.add(rootEntity);
        rootList.push(rootEntity as Entity);
      }

      if (!hooksRun.has(rootEntity)) {
        hooksRun.add(rootEntity);
        await invokeLifecycleHooks(this.rootMeta, "after-load", rootEntity);
      }

      const aliasInstances = new Map<string, Record<string, unknown>>();
      aliasInstances.set(this.rootAlias, rootEntity);

      for (const j of selectedJoins) {
        const parentInst = aliasInstances.get(j.parentAlias);
        if (!parentInst) continue;

        const targetPrefix = `${j.alias}__`;
        const targetPkVal =
          row[`${targetPrefix}${j.targetMeta.primaryColumn.columnName}`];

        const isCollection =
          j.relation.kind === "one-to-many" || j.relation.kind === "many-to-many";

        if (isCollection && !Array.isArray(parentInst[j.relation.propertyName])) {
          parentInst[j.relation.propertyName] = [];
        }

        if (targetPkVal === undefined || targetPkVal === null) {
          if (!isCollection && parentInst[j.relation.propertyName] === undefined) {
            parentInst[j.relation.propertyName] = null;
          }
          continue;
        }

        const targetInst = hydrateEntityRow<Record<string, unknown>>(
          j.targetMeta,
          row,
          {
            ...hydrateOptions,
            columnPrefix: targetPrefix,
          },
        );

        if (!hooksRun.has(targetInst)) {
          hooksRun.add(targetInst);
          await invokeLifecycleHooks(j.targetMeta, "after-load", targetInst);
        }

        if (j.relation.joinColumnName && `${targetPrefix}${j.relation.joinColumnName}` in row) {
          setShadowFk(
            targetInst,
            j.relation.joinColumnName,
            row[`${targetPrefix}${j.relation.joinColumnName}`],
          );
        }

        aliasInstances.set(j.alias, targetInst);

        if (isCollection) {
          const arr = parentInst[j.relation.propertyName] as unknown[];
          if (!arr.includes(targetInst)) {
            arr.push(targetInst);
          }
        } else {
          parentInst[j.relation.propertyName] = targetInst;
        }
      }
    }

    // Apply skip/take in memory when to-many joins prevented SQL-level slicing
    const hasToManyJoin = selectedJoins.some(
      (j) =>
        j.relation.kind === "one-to-many" || j.relation.kind === "many-to-many",
    );
    if (hasToManyJoin && (this.skipCount !== undefined || this.takeCount !== undefined)) {
      const start = this.skipCount ?? 0;
      const end = this.takeCount !== undefined ? start + this.takeCount : undefined;
      return rootList.slice(start, end);
    }

    return rootList;
  }

  async getOne(): Promise<Entity | null> {
    const prevTake = this.takeCount;
    const hasToManyJoin = this.joins.some(
      (j) =>
        j.select &&
        (j.relation.kind === "one-to-many" || j.relation.kind === "many-to-many"),
    );
    if (!hasToManyJoin && this.takeCount === undefined) {
      this.takeCount = 1;
    }
    try {
      const items = await this.getMany();
      return items[0] ?? null;
    } finally {
      this.takeCount = prevTake;
    }
  }

  async getOneOrFail(): Promise<Entity> {
    const found = await this.getOne();
    if (!found) {
      throw new EntityNotFoundError(this.rootMeta.name);
    }
    return found;
  }

  async getCount(): Promise<number> {
    const prevSelects = [...this.customSelects];
    const prevOrder = [...this.orderBys];
    const prevSkip = this.skipCount;
    const prevTake = this.takeCount;
    try {
      const pkExpr = `${quoteIdentifier(this.rootAlias, this.dialect)}.${quoteIdentifier(this.rootMeta.primaryColumn.columnName, this.dialect)}`;
      this.customSelects.length = 0;
      this.customSelects.push(`COUNT(DISTINCT ${pkExpr}) AS __orm_cnt`);
      this.orderBys.length = 0;
      this.skipCount = undefined;
      this.takeCount = undefined;
      const [sql, params] = this.getQueryAndParameters();
      const res = await this.ctx.executor.query<{ __orm_cnt: number | string }>(
        sql,
        params,
      );
      return Number(res.rows[0]?.__orm_cnt ?? 0);
    } finally {
      this.customSelects.length = 0;
      this.customSelects.push(...prevSelects);
      this.orderBys.length = 0;
      this.orderBys.push(...prevOrder);
      this.skipCount = prevSkip;
      this.takeCount = prevTake;
    }
  }

  async getManyAndCount(): Promise<[Entity[], number]> {
    const [items, count] = await Promise.all([this.getMany(), this.getCount()]);
    return [items, count];
  }

  async getExists(): Promise<boolean> {
    return (await this.getCount()) > 0;
  }
}

/**
 * Fluent `UpdateQueryBuilder` for targeted SQL updates.
 */
export class UpdateQueryBuilder<Entity = Record<string, unknown>> {
  private valuesObj: Record<string, unknown> = {};
  private readonly wheres: WhereClauseItem[] = [];
  private readonly namedParams: Record<string, unknown> = {};

  constructor(
    private readonly meta: CompiledEntityMetadata,
    private readonly executor: OrmQueryExecutor,
  ) {}

  set(values: Partial<Entity> & Record<string, unknown>): this {
    this.valuesObj = { ...this.valuesObj, ...values };
    return this;
  }

  where(condition: string, params?: Record<string, unknown>): this {
    this.wheres.length = 0;
    return this.andWhere(condition, params);
  }

  andWhere(condition: string, params?: Record<string, unknown>): this {
    if (params) Object.assign(this.namedParams, params);
    this.wheres.push({ combinator: "AND", sql: condition });
    return this;
  }

  orWhere(condition: string, params?: Record<string, unknown>): this {
    if (params) Object.assign(this.namedParams, params);
    this.wheres.push({ combinator: "OR", sql: condition });
    return this;
  }

  async execute(): Promise<UpdateResult> {
    const dialect = this.executor.dialect;
    const tableRef = formatTableRef(this.meta.tableName, this.meta.schema, dialect);
    const collector = new ParameterCollector(dialect);

    const setParts: string[] = [];
    for (const [key, val] of Object.entries(this.valuesObj)) {
      if (val === undefined) continue;
      const col =
        this.meta.columnsByProperty.get(key) ??
        this.meta.columnsByColumnName.get(key);
      const colName = col ? col.columnName : assertSafeSqlIdentifier(key, "update column");
      setParts.push(`${quoteIdentifier(colName, dialect)} = ${collector.add(val)}`);
    }

    if (setParts.length === 0) {
      return { affected: 0, generatedMaps: [], raw: null };
    }

    let sql = `UPDATE ${tableRef} SET ${setParts.join(", ")}`;
    if (this.wheres.length > 0) {
      const whereParts = this.wheres.map((w, i) => {
        const bound = bindNamedParamsInFragment(w.sql, this.namedParams, collector);
        return i === 0 ? `(${bound})` : `${w.combinator} (${bound})`;
      });
      sql += ` WHERE ${whereParts.join(" ")}`;
    }

    const res = await this.executor.execute(sql, collector.values);
    return { affected: res.affectedRows, generatedMaps: [], raw: res };
  }
}

/**
 * Fluent `DeleteQueryBuilder` for targeted SQL deletes.
 */
export class DeleteQueryBuilder {
  private readonly wheres: WhereClauseItem[] = [];
  private readonly namedParams: Record<string, unknown> = {};

  constructor(
    private readonly meta: CompiledEntityMetadata,
    private readonly executor: OrmQueryExecutor,
  ) {}

  where(condition: string, params?: Record<string, unknown>): this {
    this.wheres.length = 0;
    return this.andWhere(condition, params);
  }

  andWhere(condition: string, params?: Record<string, unknown>): this {
    if (params) Object.assign(this.namedParams, params);
    this.wheres.push({ combinator: "AND", sql: condition });
    return this;
  }

  orWhere(condition: string, params?: Record<string, unknown>): this {
    if (params) Object.assign(this.namedParams, params);
    this.wheres.push({ combinator: "OR", sql: condition });
    return this;
  }

  async execute(): Promise<DeleteResult> {
    const dialect = this.executor.dialect;
    const tableRef = formatTableRef(this.meta.tableName, this.meta.schema, dialect);
    const collector = new ParameterCollector(dialect);

    let sql = `DELETE FROM ${tableRef}`;
    if (this.wheres.length > 0) {
      const whereParts = this.wheres.map((w, i) => {
        const bound = bindNamedParamsInFragment(w.sql, this.namedParams, collector);
        return i === 0 ? `(${bound})` : `${w.combinator} (${bound})`;
      });
      sql += ` WHERE ${whereParts.join(" ")}`;
    }

    const res = await this.executor.execute(sql, collector.values);
    return { affected: res.affectedRows, raw: res };
  }
}

/**
 * Fluent `InsertQueryBuilder` for batch SQL inserts.
 */
export class InsertQueryBuilder<Entity = Record<string, unknown>> {
  private rows: Array<Record<string, unknown>> = [];

  constructor(
    private readonly meta: CompiledEntityMetadata,
    private readonly executor: OrmQueryExecutor,
  ) {}

  values(
    value:
      | (Partial<Entity> & Record<string, unknown>)
      | ReadonlyArray<Partial<Entity> & Record<string, unknown>>,
  ): this {
    this.rows = Array.isArray(value) ? [...value] : [value];
    return this;
  }

  async execute(): Promise<InsertResult> {
    if (this.rows.length === 0) {
      return { identifiers: [], generatedMaps: [], raw: [] };
    }
    const dialect = this.executor.dialect;
    const tableRef = formatTableRef(this.meta.tableName, this.meta.schema, dialect);
    const identifiers: Array<Record<string, unknown>> = [];
    const generatedMaps: Array<Record<string, unknown>> = [];
    const profile = getDialectProfile(dialect);

    for (const row of this.rows) {
      const collector = new ParameterCollector(dialect);
      const colNames: string[] = [];
      const placeholders: string[] = [];

      for (const [key, val] of Object.entries(row)) {
        if (val === undefined) continue;
        const col =
          this.meta.columnsByProperty.get(key) ??
          this.meta.columnsByColumnName.get(key);
        const colName = col
          ? col.columnName
          : assertSafeSqlIdentifier(key, "insert column");
        colNames.push(quoteIdentifier(colName, dialect));
        placeholders.push(collector.add(val));
      }

      const sql =
        profile.returningStyle === "output"
          ? `INSERT INTO ${tableRef} (${colNames.join(", ")}) OUTPUT INSERTED.* VALUES (${placeholders.join(", ")})`
          : profile.returningStyle === "then-return"
            ? `INSERT INTO ${tableRef} (${colNames.join(", ")}) VALUES (${placeholders.join(", ")}) THEN RETURN *`
            : profile.returningStyle === "returning"
              ? `INSERT INTO ${tableRef} (${colNames.join(", ")}) VALUES (${placeholders.join(", ")}) RETURNING *`
              : `INSERT INTO ${tableRef} (${colNames.join(", ")}) VALUES (${placeholders.join(", ")})`;
      const res = await this.executor.query<Record<string, unknown>>(
        sql,
        collector.values,
      );
      const pk = this.meta.primaryColumn;
      const insertedId =
        res.rows[0]?.[pk.columnName] ??
        (res.lastInsertRowid !== undefined && res.lastInsertRowid !== null
          ? Number(res.lastInsertRowid)
          : row[pk.propertyName]);
      identifiers.push({ [pk.propertyName]: insertedId });
      generatedMaps.push(res.rows[0] ?? { [pk.propertyName]: insertedId });
    }

    return { identifiers, generatedMaps, raw: generatedMaps };
  }
}
