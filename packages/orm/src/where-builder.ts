import { getDialectProfile } from "./dialect/dialect-profile";
import {
  assertSafeSqlIdentifier,
  escapeLikePattern,
  formatPlaceholder,
  formatTableRef,
  quoteIdentifier,
} from "./identifiers";
import type {
  CompiledColumnMetadata,
  CompiledEmbeddedMetadata,
  CompiledEntityMetadata,
  CompiledMetadataGraph,
  CompiledRelationMetadata,
} from "./metadata-graph";
import { toDbValue } from "./hydrator";
import { isFindOperator } from "./operators";
import type {
  FindOperatorLike,
  FindOptionsOrder,
  FindOptionsWhere,
  OrmDialect,
} from "./types";

export interface CompiledSqlPredicate {
  readonly sql: string;
  readonly params: unknown[];
}

export class ParameterCollector {
  readonly values: unknown[] = [];

  constructor(private readonly dialect: OrmDialect) {}

  add(value: unknown): string {
    this.values.push(value);
    return formatPlaceholder(this.values.length, this.dialect);
  }
}

function compileOperator(
  colRef: string,
  col: CompiledColumnMetadata | undefined,
  op: FindOperatorLike,
  params: ParameterCollector,
  dialect: OrmDialect,
): string {
  const convert = (val: unknown) => (col ? toDbValue(col, val, dialect) : val);

  switch (op.type) {
    case "equal":
      if (op.value === null) return `${colRef} IS NULL`;
      return `${colRef} = ${params.add(convert(op.value))}`;

    case "not": {
      const inner = op.value;
      if (inner === null) return `${colRef} IS NOT NULL`;
      if (isFindOperator(inner)) {
        if (inner.type === "isNull") return `${colRef} IS NOT NULL`;
        if (inner.type === "in") {
          const arr = Array.isArray(inner.value) ? inner.value : [];
          if (arr.length === 0) return "1 = 1";
          const phs = arr.map((v) => params.add(convert(v))).join(", ");
          return `${colRef} NOT IN (${phs})`;
        }
        return `NOT (${compileOperator(colRef, col, inner, params, dialect)})`;
      }
      return `${colRef} <> ${params.add(convert(inner))}`;
    }

    case "lessThan":
      return `${colRef} < ${params.add(convert(op.value))}`;

    case "lessThanOrEqual":
      return `${colRef} <= ${params.add(convert(op.value))}`;

    case "moreThan":
      return `${colRef} > ${params.add(convert(op.value))}`;

    case "moreThanOrEqual":
      return `${colRef} >= ${params.add(convert(op.value))}`;

    case "like":
      return `${colRef} LIKE ${params.add(String(op.value))}`;

    case "ilike":
      return getDialectProfile(dialect).formatILike(
        colRef,
        params.add(String(op.value)),
      );

    case "between": {
      const pair = op.value as readonly [unknown, unknown];
      const p1 = params.add(convert(pair[0]));
      const p2 = params.add(convert(pair[1]));
      return `${colRef} BETWEEN ${p1} AND ${p2}`;
    }

    case "in": {
      const arr = Array.isArray(op.value) ? op.value : [];
      if (arr.length === 0) return "1 = 0";
      const phs = arr.map((v) => params.add(convert(v))).join(", ");
      return `${colRef} IN (${phs})`;
    }

    case "isNull":
      return `${colRef} IS NULL`;

    case "raw": {
      const rawParamMap = (op.extra ?? {}) as Record<string, unknown>;
      const rawSql =
        typeof op.value === "function"
          ? (op.value as (alias: string) => string)(colRef)
          : `${colRef} ${String(op.value)}`;
      // Replace `:paramName` safely
      return bindNamedParamsInFragment(rawSql, rawParamMap, params);
    }

    case "and": {
      const items = Array.isArray(op.value) ? op.value : [];
      if (items.length === 0) return "1 = 1";
      const parts = items.map((item) =>
        isFindOperator(item)
          ? compileOperator(colRef, col, item, params, dialect)
          : item === null
            ? `${colRef} IS NULL`
            : `${colRef} = ${params.add(convert(item))}`,
      );
      return `(${parts.join(" AND ")})`;
    }

    case "or": {
      const items = Array.isArray(op.value) ? op.value : [];
      if (items.length === 0) return "1 = 0";
      const parts = items.map((item) =>
        isFindOperator(item)
          ? compileOperator(colRef, col, item, params, dialect)
          : item === null
            ? `${colRef} IS NULL`
            : `${colRef} = ${params.add(convert(item))}`,
      );
      return `(${parts.join(" OR ")})`;
    }
  }
}

/**
 * Replaces `:paramName` placeholders in a SQL expression while ignoring string literals,
 * comments, and PostgreSQL `::type` casts.
 */
export function bindNamedParamsInFragment(
  fragment: string,
  namedParams: Record<string, unknown>,
  collector: ParameterCollector,
): string {
  let out = "";
  let i = 0;
  const len = fragment.length;

  while (i < len) {
    const ch = fragment[i]!;

    // Single-quoted SQL string literal
    if (ch === "'") {
      out += ch;
      i++;
      while (i < len) {
        const c = fragment[i]!;
        out += c;
        i++;
        if (c === "'") {
          if (fragment[i] === "'") {
            out += "'";
            i++;
          } else {
            break;
          }
        }
      }
      continue;
    }

    // Double-quoted identifier
    if (ch === '"') {
      out += ch;
      i++;
      while (i < len) {
        const c = fragment[i]!;
        out += c;
        i++;
        if (c === '"') break;
      }
      continue;
    }

    // PostgreSQL `::cast`
    if (ch === ":" && fragment[i + 1] === ":") {
      out += "::";
      i += 2;
      continue;
    }

    // Named parameter `:foo` or `:...foo` (spread array for IN clauses)
    if (ch === ":") {
      let isSpread = false;
      let start = i + 1;
      if (fragment.slice(start, start + 3) === "...") {
        isSpread = true;
        start += 3;
      }
      let end = start;
      while (end < len && /[A-Za-z0-9_]/.test(fragment[end]!)) {
        end++;
      }
      if (end > start) {
        const name = fragment.slice(start, end);
        if (name in namedParams) {
          const val = namedParams[name];
          if (isSpread && Array.isArray(val)) {
            if (val.length === 0) {
              out += "NULL";
            } else {
              out += val.map((v) => collector.add(v)).join(", ");
            }
          } else {
            out += collector.add(val);
          }
          i = end;
          continue;
        }
      }
    }

    out += ch;
    i++;
  }

  return out;
}

function compileEmbeddedWhere(
  emb: CompiledEmbeddedMetadata,
  filterObj: Record<string, unknown>,
  tableAlias: string,
  params: ParameterCollector,
  dialect: OrmDialect,
  outClauses: string[],
): void {
  if (emb.resolvedMode === "json" && emb.jsonColumnName) {
    // Filter JSON embedded columns using dialect-native JSON extraction
    const colRef = `${quoteIdentifier(tableAlias, dialect)}.${quoteIdentifier(emb.jsonColumnName, dialect)}`;
    for (const [k, v] of Object.entries(filterObj)) {
      if (v === undefined) continue;
      assertSafeSqlIdentifier(k, "JSON path property");
      const jsonExpr = getDialectProfile(dialect).formatJsonExtract(colRef, k);
      if (isFindOperator(v)) {
        outClauses.push(compileOperator(jsonExpr, undefined, v, params, dialect));
      } else if (v === null) {
        outClauses.push(`${jsonExpr} IS NULL`);
      } else {
        outClauses.push(`${jsonExpr} = ${params.add(v)}`);
      }
    }
    return;
  }

  for (const [key, val] of Object.entries(filterObj)) {
    if (val === undefined) continue;
    const flatCol = emb.columns.find((c) => c.propertyName === key);
    if (flatCol) {
      const colRef = `${quoteIdentifier(tableAlias, dialect)}.${quoteIdentifier(flatCol.columnName, dialect)}`;
      if (isFindOperator(val)) {
        outClauses.push(compileOperator(colRef, flatCol, val, params, dialect));
      } else if (val === null) {
        outClauses.push(`${colRef} IS NULL`);
      } else {
        outClauses.push(
          `${colRef} = ${params.add(toDbValue(flatCol, val, dialect))}`,
        );
      }
      continue;
    }

    const childEmb = emb.nestedEmbeddeds.find((e) => e.propertyName === key);
    if (childEmb && typeof val === "object" && val !== null && !isFindOperator(val)) {
      compileEmbeddedWhere(
        childEmb,
        val as Record<string, unknown>,
        tableAlias,
        params,
        dialect,
        outClauses,
      );
    }
  }
}

function compileRelationWhere(
  ownerMeta: CompiledEntityMetadata,
  rel: CompiledRelationMetadata,
  filterVal: unknown,
  ownerAlias: string,
  graph: CompiledMetadataGraph,
  params: ParameterCollector,
  dialect: OrmDialect,
  subquerySeq: { count: number },
  outClauses: string[],
): void {
  const targetMeta = graph.byTarget.get(rel.target);
  if (!targetMeta) return;

  const ownerAliasQ = quoteIdentifier(ownerAlias, dialect);

  if (filterVal === null) {
    if (rel.isOwning && rel.joinColumnName) {
      outClauses.push(
        `${ownerAliasQ}.${quoteIdentifier(rel.joinColumnName, dialect)} IS NULL`,
      );
    }
    return;
  }

  if (typeof filterVal !== "object" || isFindOperator(filterVal)) {
    // Filtering directly by FK scalar or FindOperator on owning side
    if (rel.isOwning && rel.joinColumnName) {
      const colRef = `${ownerAliasQ}.${quoteIdentifier(rel.joinColumnName, dialect)}`;
      if (isFindOperator(filterVal)) {
        outClauses.push(compileOperator(colRef, undefined, filterVal, params, dialect));
      } else {
        outClauses.push(`${colRef} = ${params.add(filterVal)}`);
      }
    }
    return;
  }

  const filterObj = filterVal as Record<string, unknown>;
  const refProp = rel.referencedPropertyName ?? targetMeta.primaryColumn.propertyName;
  const filterKeys = Object.keys(filterObj).filter((k) => filterObj[k] !== undefined);

  // Fast path: owning relation filtered ONLY by target's primary key (`where: { author: { id: 5 } }`)
  if (
    rel.isOwning &&
    rel.joinColumnName &&
    filterKeys.length === 1 &&
    filterKeys[0] === refProp
  ) {
    const colRef = `${ownerAliasQ}.${quoteIdentifier(rel.joinColumnName, dialect)}`;
    const expected = filterObj[refProp];
    if (isFindOperator(expected)) {
      outClauses.push(compileOperator(colRef, undefined, expected, params, dialect));
    } else if (expected === null) {
      outClauses.push(`${colRef} IS NULL`);
    } else {
      outClauses.push(`${colRef} = ${params.add(expected)}`);
    }
    return;
  }

  // General path: correlated EXISTS subquery (works for OneToOne, ManyToOne, OneToMany, ManyToMany, AND nested relations!)
  const subAlias = `rel_${++subquerySeq.count}`;
  const subAliasQ = quoteIdentifier(subAlias, dialect);
  const targetTableRef = formatTableRef(targetMeta.tableName, targetMeta.schema, dialect);

  const innerClauses: string[] = [];
  compileWhereObject(
    targetMeta,
    filterObj,
    subAlias,
    graph,
    params,
    dialect,
    true,
    subquerySeq,
    innerClauses,
  );

  if (targetMeta.deleteDateColumn) {
    innerClauses.push(
      `${subAliasQ}.${quoteIdentifier(targetMeta.deleteDateColumn.columnName, dialect)} IS NULL`,
    );
  }

  if (rel.kind === "many-to-many" && rel.joinTable) {
    const jt = rel.joinTable;
    const jtAlias = `jt_${++subquerySeq.count}`;
    const jtAliasQ = quoteIdentifier(jtAlias, dialect);
    const jtTableRef = formatTableRef(jt.tableName, ownerMeta.schema, dialect);
    const ownerPkQ = quoteIdentifier(jt.joinReferencedColumnName, dialect);
    const targetPkQ = quoteIdentifier(jt.inverseReferencedColumnName, dialect);
    const jtOwnerColQ = quoteIdentifier(jt.joinColumnName, dialect);
    const jtTargetColQ = quoteIdentifier(jt.inverseJoinColumnName, dialect);

    const whereBody =
      innerClauses.length > 0 ? ` AND ${innerClauses.join(" AND ")}` : "";
    outClauses.push(
      `EXISTS (SELECT 1 FROM ${jtTableRef} ${jtAliasQ} INNER JOIN ${targetTableRef} ${subAliasQ} ON ${subAliasQ}.${targetPkQ} = ${jtAliasQ}.${jtTargetColQ} WHERE ${jtAliasQ}.${jtOwnerColQ} = ${ownerAliasQ}.${ownerPkQ}${whereBody})`,
    );
    return;
  }

  let joinCondition: string;
  if (rel.isOwning && rel.joinColumnName) {
    const fkQ = quoteIdentifier(rel.joinColumnName, dialect);
    const refQ = quoteIdentifier(
      rel.referencedColumnName ?? targetMeta.primaryColumn.columnName,
      dialect,
    );
    joinCondition = `${subAliasQ}.${refQ} = ${ownerAliasQ}.${fkQ}`;
  } else if (rel.joinColumnName) {
    const fkQ = quoteIdentifier(rel.joinColumnName, dialect);
    const ownerRefQ = quoteIdentifier(
      rel.referencedColumnName ?? ownerMeta.primaryColumn.columnName,
      dialect,
    );
    joinCondition = `${subAliasQ}.${fkQ} = ${ownerAliasQ}.${ownerRefQ}`;
  } else {
    return;
  }

  const allInner = [joinCondition, ...innerClauses].join(" AND ");
  outClauses.push(`EXISTS (SELECT 1 FROM ${targetTableRef} ${subAliasQ} WHERE ${allInner})`);
}

function compileWhereObject(
  meta: CompiledEntityMetadata,
  clause: Record<string, unknown>,
  tableAlias: string,
  graph: CompiledMetadataGraph,
  params: ParameterCollector,
  dialect: OrmDialect,
  _inSubquery: boolean,
  subquerySeq: { count: number },
  outClauses: string[],
): void {
  const aliasQ = quoteIdentifier(tableAlias, dialect);

  for (const [key, val] of Object.entries(clause)) {
    if (val === undefined) continue;

    // 1. Direct column match (by propertyName or columnName)
    const col =
      meta.columnsByProperty.get(key) ?? meta.columnsByColumnName.get(key);
    if (col && !col.isEmbeddedJson) {
      const colRef = `${aliasQ}.${quoteIdentifier(col.columnName, dialect)}`;
      if (isFindOperator(val)) {
        outClauses.push(compileOperator(colRef, col, val, params, dialect));
      } else if (val === null) {
        outClauses.push(`${colRef} IS NULL`);
      } else {
        outClauses.push(`${colRef} = ${params.add(toDbValue(col, val, dialect))}`);
      }
      continue;
    }

    // 2. Embedded / nested class filter (`where: { address: { city: "Hanoi" } }`)
    const emb = meta.embeddedsByProperty.get(key);
    if (emb) {
      if (val === null) {
        if (emb.resolvedMode === "json" && emb.jsonColumnName) {
          outClauses.push(
            `${aliasQ}.${quoteIdentifier(emb.jsonColumnName, dialect)} IS NULL`,
          );
        } else {
          for (const flatCol of emb.columns) {
            outClauses.push(
              `${aliasQ}.${quoteIdentifier(flatCol.columnName, dialect)} IS NULL`,
            );
          }
        }
      } else if (typeof val === "object" && !isFindOperator(val)) {
        compileEmbeddedWhere(
          emb,
          val as Record<string, unknown>,
          tableAlias,
          params,
          dialect,
          outClauses,
        );
      }
      continue;
    }

    // 3. Relation filter (`where: { author: { email: "a@b.com" } }`)
    const rel = meta.relationsByProperty.get(key);
    if (rel) {
      compileRelationWhere(
        meta,
        rel,
        val,
        tableAlias,
        graph,
        params,
        dialect,
        subquerySeq,
        outClauses,
      );
      continue;
    }

    // 4. Fallback: allow explicit raw column name if validated
    const safeCol = assertSafeSqlIdentifier(key, `where field on "${meta.name}"`);
    const colRef = `${aliasQ}.${quoteIdentifier(safeCol, dialect)}`;
    if (isFindOperator(val)) {
      outClauses.push(compileOperator(colRef, undefined, val, params, dialect));
    } else if (val === null) {
      outClauses.push(`${colRef} IS NULL`);
    } else {
      outClauses.push(`${colRef} = ${params.add(val)}`);
    }
  }
}

/**
 * Compiles a TypeORM-style `where` option (single object or OR-array of objects)
 * plus automatic soft-delete filtering (`deleted_at IS NULL` unless `withDeleted: true`).
 */
export function compileWhereClause<Entity>(
  meta: CompiledEntityMetadata,
  where:
    | FindOptionsWhere<Entity>
    | ReadonlyArray<FindOptionsWhere<Entity>>
    | undefined,
  tableAlias: string,
  graph: CompiledMetadataGraph,
  dialect: OrmDialect,
  withDeleted = false,
  existingCollector?: ParameterCollector,
): CompiledSqlPredicate {
  const collector = existingCollector ?? new ParameterCollector(dialect);
  const subquerySeq = { count: 0 };
  const topParts: string[] = [];

  if (where) {
    const groups = Array.isArray(where) ? where : [where];
    const orParts: string[] = [];
    for (const group of groups) {
      if (!group || typeof group !== "object") continue;
      const andParts: string[] = [];
      compileWhereObject(
        meta,
        group as Record<string, unknown>,
        tableAlias,
        graph,
        collector,
        dialect,
        false,
        subquerySeq,
        andParts,
      );
      if (andParts.length > 0) {
        orParts.push(andParts.length === 1 ? andParts[0]! : `(${andParts.join(" AND ")})`);
      }
    }
    if (orParts.length > 0) {
      topParts.push(orParts.length === 1 ? orParts[0]! : `(${orParts.join(" OR ")})`);
    }
  }

  if (!withDeleted && meta.deleteDateColumn) {
    const aliasQ = quoteIdentifier(tableAlias, dialect);
    const delColQ = quoteIdentifier(meta.deleteDateColumn.columnName, dialect);
    topParts.push(`${aliasQ}.${delColQ} IS NULL`);
  }

  return {
    sql: topParts.join(" AND "),
    params: collector.values,
  };
}

/**
 * Compiles TypeORM-style `order` option including nested embedded properties
 * (`order: { hq: { city: "ASC" }, id: "DESC" }`).
 */
export function compileOrderByClause<Entity>(
  meta: CompiledEntityMetadata,
  order: FindOptionsOrder<Entity> | undefined,
  tableAlias: string,
  dialect: OrmDialect,
): string {
  if (!order) return "";
  const aliasQ = quoteIdentifier(tableAlias, dialect);
  const parts: string[] = [];

  const visit = (
    obj: Record<string, unknown>,
    pathPrefix: string[],
  ): void => {
    for (const [key, val] of Object.entries(obj)) {
      if (val === undefined) continue;
      if (
        val === "ASC" ||
        val === "DESC" ||
        val === "asc" ||
        val === "desc" ||
        val === 1 ||
        val === -1
      ) {
        const dir = val === "DESC" || val === "desc" || val === -1 ? "DESC" : "ASC";
        const fullPath = [...pathPrefix, key].join(".");
        const col =
          meta.columnsByProperty.get(fullPath) ??
          meta.columnsByColumnName.get(key);
        const colName = col ? col.columnName : assertSafeSqlIdentifier(key, "order column");
        parts.push(`${aliasQ}.${quoteIdentifier(colName, dialect)} ${dir}`);
      } else if (typeof val === "object" && val !== null) {
        visit(val as Record<string, unknown>, [...pathPrefix, key]);
      }
    }
  };

  visit(order as Record<string, unknown>, []);
  return parts.join(", ");
}

export { escapeLikePattern };
