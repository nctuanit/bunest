import { SqliteEntityNotFoundException } from "./exceptions";
import { assertSafeSqlIdentifier, quoteSqlIdentifier } from "./identifiers";
import type {
  SqliteParamValue,
  SqliteQueryExecutor,
  SqliteRunResult,
} from "./interfaces";

export interface SqliteOrderBySpec {
  readonly column: string;
  readonly order?: "ASC" | "DESC";
}

export interface SqliteFindOptions<
  T extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly select?: readonly (keyof T & string)[];
  readonly limit?: number;
  readonly offset?: number;
  readonly orderBy?: string | readonly (string | SqliteOrderBySpec)[];
  readonly order?: "ASC" | "DESC";
  /**
   * When `true` (default), passing a `where` object whose keys are all `undefined`
   * (e.g. `{ userId: undefined }`) throws an error instead of silently scanning the full table.
   * Set `strictWhere: false` to intentionally treat all-undefined filters as unfiltered.
   * @default true
   */
  readonly strictWhere?: boolean;
}

interface CountRow {
  readonly count: number;
}

/**
 * Optional base CRUD repository for SQLite tables.
 * Every table/column identifier is validated and quoted; every value is strictly
 * bound via parameterized `?` placeholders (zero string interpolation of user values).
 */
export class BaseSqliteRepository<
  T extends Record<string, unknown>,
  ID extends SqliteParamValue = number | string,
> {
  protected readonly quotedTable: string;
  protected readonly quotedIdColumn: string;

  constructor(
    protected readonly sqlite: SqliteQueryExecutor,
    protected readonly tableName: string,
    protected readonly idColumn: string = "id",
  ) {
    assertSafeSqlIdentifier(tableName, "table name");
    assertSafeSqlIdentifier(idColumn, "id column name");
    this.quotedTable = quoteSqlIdentifier(tableName, "table name");
    this.quotedIdColumn = quoteSqlIdentifier(idColumn, "id column name");
  }

  get executor(): SqliteQueryExecutor {
    return this.sqlite;
  }

  get table(): string {
    return this.tableName;
  }

  get primaryKeyColumn(): string {
    return this.idColumn;
  }

  findAll(options?: SqliteFindOptions<T>): T[] {
    const params: SqliteParamValue[] = [];
    const projection = this.buildSelectProjection(options?.select);
    const suffix = this.buildFindSuffix(options, params);
    return this.sqlite.query<T>(
      `SELECT ${projection} FROM ${this.quotedTable}${suffix}`,
      params.length > 0 ? params : undefined,
    );
  }

  findById(id: ID): T | null {
    return this.sqlite.queryOne<T>(
      `SELECT * FROM ${this.quotedTable} WHERE ${this.quotedIdColumn} = ? LIMIT 1`,
      [id],
    );
  }

  findByIdOrFail(id: ID): T {
    const row = this.findById(id);
    if (row === null) {
      throw new SqliteEntityNotFoundException(
        this.tableName,
        `${this.idColumn} = ${String(id)}`,
      );
    }
    return row;
  }

  findWhere(
    where: Partial<Record<keyof T & string, SqliteParamValue>>,
    options?: SqliteFindOptions<T>,
  ): T[] {
    const params: SqliteParamValue[] = [];
    const projection = this.buildSelectProjection(options?.select);
    const whereClause = this.buildWhereClause(
      where,
      params,
      options?.strictWhere ?? true,
    );
    const suffix = this.buildFindSuffix(options, params);
    return this.sqlite.query<T>(
      `SELECT ${projection} FROM ${this.quotedTable}${whereClause}${suffix}`,
      params.length > 0 ? params : undefined,
    );
  }

  findOneWhere(
    where: Partial<Record<keyof T & string, SqliteParamValue>>,
    options?: Pick<SqliteFindOptions<T>, "strictWhere" | "select" | "orderBy" | "order">,
  ): T | null {
    const rows = this.findWhere(where, { ...options, limit: 1 });
    return rows[0] ?? null;
  }

  findOneWhereOrFail(
    where: Partial<Record<keyof T & string, SqliteParamValue>>,
    options?: Pick<SqliteFindOptions<T>, "strictWhere" | "select" | "orderBy" | "order">,
  ): T {
    const row = this.findOneWhere(where, options);
    if (row === null) {
      throw new SqliteEntityNotFoundException(this.tableName);
    }
    return row;
  }

  /**
   * Returns `[rows, totalCount]` matching `where`, where `rows` respects pagination/sorting
   * options and `totalCount` is the full unfiltered count for `where`.
   */
  findAndCount(
    where?: Partial<Record<keyof T & string, SqliteParamValue>>,
    options?: SqliteFindOptions<T>,
  ): [T[], number] {
    const rows = where ? this.findWhere(where, options) : this.findAll(options);
    const total = this.count(where, { strictWhere: options?.strictWhere });
    return [rows, total];
  }

  /**
   * Streams matching rows lazily via `bun:sqlite` cursor (`stmt.iterate()`).
   */
  iterate(
    where?: Partial<Record<keyof T & string, SqliteParamValue>>,
    options?: SqliteFindOptions<T>,
  ): IterableIterator<T> {
    const params: SqliteParamValue[] = [];
    const projection = this.buildSelectProjection(options?.select);
    const whereClause = where
      ? this.buildWhereClause(where, params, options?.strictWhere ?? true)
      : "";
    const suffix = this.buildFindSuffix(options, params);
    const sql = `SELECT ${projection} FROM ${this.quotedTable}${whereClause}${suffix}`;

    if (typeof this.sqlite.iterate === "function") {
      return this.sqlite.iterate<T>(sql, params.length > 0 ? params : undefined);
    }

    const rows = this.sqlite.query<T>(
      sql,
      params.length > 0 ? params : undefined,
    );
    return rows[Symbol.iterator]();
  }

  count(
    where?: Partial<Record<keyof T & string, SqliteParamValue>>,
    options?: Pick<SqliteFindOptions<T>, "strictWhere">,
  ): number {
    const params: SqliteParamValue[] = [];
    const whereClause = where
      ? this.buildWhereClause(where, params, options?.strictWhere ?? true)
      : "";
    const row = this.sqlite.queryOne<CountRow>(
      `SELECT COUNT(*) AS count FROM ${this.quotedTable}${whereClause}`,
      params.length > 0 ? params : undefined,
    );
    return row?.count ?? 0;
  }

  exists(id: ID): boolean {
    const row = this.sqlite.queryOne<{ found: number }>(
      `SELECT 1 AS found FROM ${this.quotedTable} WHERE ${this.quotedIdColumn} = ? LIMIT 1`,
      [id],
    );
    return row !== null;
  }

  existsWhere(
    where: Partial<Record<keyof T & string, SqliteParamValue>>,
    options?: Pick<SqliteFindOptions<T>, "strictWhere">,
  ): boolean {
    const params: SqliteParamValue[] = [];
    const whereClause = this.buildWhereClause(
      where,
      params,
      options?.strictWhere ?? true,
    );
    const row = this.sqlite.queryOne<{ found: number }>(
      `SELECT 1 AS found FROM ${this.quotedTable}${whereClause} LIMIT 1`,
      params.length > 0 ? params : undefined,
    );
    return row !== null;
  }

  insert(
    data: Partial<Record<keyof T & string, SqliteParamValue>>,
  ): SqliteRunResult {
    const { columns, placeholders, params } = this.prepareInsert(data);
    return this.sqlite.run(
      `INSERT INTO ${this.quotedTable} (${columns.join(", ")}) VALUES (${placeholders.join(", ")})`,
      params,
    );
  }

  /**
   * Inserts a row and returns the inserted record using SQLite `RETURNING *`.
   */
  insertReturning(
    data: Partial<Record<keyof T & string, SqliteParamValue>>,
  ): T {
    const { columns, placeholders, params } = this.prepareInsert(data);
    const row = this.sqlite.queryOne<T>(
      `INSERT INTO ${this.quotedTable} (${columns.join(", ")}) VALUES (${placeholders.join(", ")}) RETURNING *`,
      params,
    );
    if (row === null) {
      throw new Error(
        `insertReturning() on table "${this.tableName}" did not return a row.`,
      );
    }
    return row;
  }

  /**
   * Inserts multiple rows atomically in a single synchronous transaction (or nested savepoint).
   */
  insertMany(
    rows: readonly Partial<Record<keyof T & string, SqliteParamValue>>[],
  ): SqliteRunResult {
    if (rows.length === 0) {
      return { changes: 0, lastInsertRowid: 0 };
    }

    const executeBatch = (): SqliteRunResult => {
      let totalChanges = 0;
      let lastRowid: number | bigint = 0;
      for (const row of rows) {
        const res = this.insert(row);
        totalChanges += res.changes;
        lastRowid = res.lastInsertRowid;
      }
      return { changes: totalChanges, lastInsertRowid: lastRowid };
    };

    if (typeof this.sqlite.transactionSync === "function") {
      return this.sqlite.transactionSync(() => executeBatch());
    }
    return executeBatch();
  }

  /**
   * Inserts a row or updates specified columns on unique/primary key conflict
   * (`INSERT INTO ... ON CONFLICT (...) DO UPDATE SET ...`).
   */
  upsert(
    data: Partial<Record<keyof T & string, SqliteParamValue>>,
    conflictColumns: (keyof T & string) | readonly (keyof T & string)[],
    updateColumns?: readonly (keyof T & string)[],
  ): SqliteRunResult {
    const { rawColumns, columns, placeholders, params } =
      this.prepareInsert(data);
    const conflictList = Array.isArray(conflictColumns)
      ? conflictColumns
      : [conflictColumns];

    if (conflictList.length === 0) {
      throw new Error(
        `upsert() on table "${this.tableName}" requires at least one conflict column.`,
      );
    }

    const quotedConflicts = conflictList.map((col) =>
      quoteSqlIdentifier(col, "conflict column"),
    );
    const conflictSet = new Set(conflictList);

    const colsToUpdate =
      updateColumns !== undefined
        ? [...updateColumns]
        : rawColumns.filter((col) => !conflictSet.has(col));

    const conflictAction =
      colsToUpdate.length === 0
        ? "DO NOTHING"
        : `DO UPDATE SET ${colsToUpdate
            .map((col) => {
              const q = quoteSqlIdentifier(col, "update column");
              return `${q} = excluded.${q}`;
            })
            .join(", ")}`;

    return this.sqlite.run(
      `INSERT INTO ${this.quotedTable} (${columns.join(", ")}) VALUES (${placeholders.join(", ")}) ON CONFLICT (${quotedConflicts.join(", ")}) ${conflictAction}`,
      params,
    );
  }

  updateById(
    id: ID,
    data: Partial<Record<keyof T & string, SqliteParamValue>>,
  ): SqliteRunResult {
    const entries = Object.entries(data).filter(
      ([, value]) => value !== undefined,
    ) as Array<[string, SqliteParamValue]>;

    if (entries.length === 0) {
      throw new Error(
        `Cannot update table "${this.tableName}" with an empty object.`,
      );
    }

    const assignments: string[] = [];
    const params: SqliteParamValue[] = [];

    for (const [col, val] of entries) {
      assignments.push(`${quoteSqlIdentifier(col, "column name")} = ?`);
      params.push(val);
    }

    params.push(id);
    return this.sqlite.run(
      `UPDATE ${this.quotedTable} SET ${assignments.join(", ")} WHERE ${this.quotedIdColumn} = ?`,
      params,
    );
  }

  updateWhere(
    where: Partial<Record<keyof T & string, SqliteParamValue>>,
    data: Partial<Record<keyof T & string, SqliteParamValue>>,
  ): SqliteRunResult {
    const entries = Object.entries(data).filter(
      ([, value]) => value !== undefined,
    ) as Array<[string, SqliteParamValue]>;

    if (entries.length === 0) {
      throw new Error(
        `Cannot update table "${this.tableName}" with an empty object.`,
      );
    }

    const assignments: string[] = [];
    const params: SqliteParamValue[] = [];

    for (const [col, val] of entries) {
      assignments.push(`${quoteSqlIdentifier(col, "column name")} = ?`);
      params.push(val);
    }

    const whereClause = this.buildWhereClause(where, params, true);
    if (!whereClause) {
      throw new Error(
        `updateWhere() on table "${this.tableName}" requires at least one filter condition.`,
      );
    }

    return this.sqlite.run(
      `UPDATE ${this.quotedTable} SET ${assignments.join(", ")}${whereClause}`,
      params,
    );
  }

  deleteById(id: ID): SqliteRunResult {
    return this.sqlite.run(
      `DELETE FROM ${this.quotedTable} WHERE ${this.quotedIdColumn} = ?`,
      [id],
    );
  }

  deleteWhere(
    where: Partial<Record<keyof T & string, SqliteParamValue>>,
  ): SqliteRunResult {
    const params: SqliteParamValue[] = [];
    const whereClause = this.buildWhereClause(where, params, true);
    if (!whereClause) {
      throw new Error(
        `deleteWhere() on table "${this.tableName}" requires at least one filter condition.`,
      );
    }
    return this.sqlite.run(
      `DELETE FROM ${this.quotedTable}${whereClause}`,
      params.length > 0 ? params : undefined,
    );
  }

  private prepareInsert(
    data: Partial<Record<keyof T & string, SqliteParamValue>>,
  ): {
    rawColumns: string[];
    columns: string[];
    placeholders: string[];
    params: SqliteParamValue[];
  } {
    const entries = Object.entries(data).filter(
      ([, value]) => value !== undefined,
    ) as Array<[string, SqliteParamValue]>;

    if (entries.length === 0) {
      throw new Error(
        `Cannot insert an empty object into table "${this.tableName}".`,
      );
    }

    const rawColumns: string[] = [];
    const columns: string[] = [];
    const placeholders: string[] = [];
    const params: SqliteParamValue[] = [];

    for (const [col, val] of entries) {
      rawColumns.push(col);
      columns.push(quoteSqlIdentifier(col, "column name"));
      placeholders.push("?");
      params.push(val);
    }

    return { rawColumns, columns, placeholders, params };
  }

  private buildSelectProjection(
    select?: readonly (keyof T & string)[],
  ): string {
    if (!select || select.length === 0) {
      return "*";
    }
    return select
      .map((col) => quoteSqlIdentifier(col, "select column"))
      .join(", ");
  }

  private buildWhereClause(
    where: Partial<Record<string, SqliteParamValue>>,
    params: SqliteParamValue[],
    strictWhere: boolean,
  ): string {
    const allEntries = Object.entries(where);
    const entries = allEntries.filter(
      ([, value]) => value !== undefined,
    ) as Array<[string, SqliteParamValue]>;

    if (entries.length === 0) {
      if (strictWhere && allEntries.length > 0) {
        const keys = allEntries.map(([k]) => `"${k}"`).join(", ");
        throw new Error(
          `Refusing to execute unfiltered query on table "${this.tableName}": all provided filter values (${keys}) were undefined. Pass { strictWhere: false } to explicitly allow an unfiltered query.`,
        );
      }
      return "";
    }

    const predicates: string[] = [];
    for (const [col, val] of entries) {
      const quotedCol = quoteSqlIdentifier(col, "column name");
      if (val === null) {
        predicates.push(`${quotedCol} IS NULL`);
      } else {
        predicates.push(`${quotedCol} = ?`);
        params.push(val);
      }
    }

    return ` WHERE ${predicates.join(" AND ")}`;
  }

  private buildFindSuffix(
    options: SqliteFindOptions<T> | undefined,
    params: SqliteParamValue[],
  ): string {
    if (!options) {
      return "";
    }

    let suffix = "";

    if (options.orderBy !== undefined) {
      if (typeof options.orderBy === "string") {
        const quotedOrder = quoteSqlIdentifier(
          options.orderBy,
          "orderBy column",
        );
        const direction = options.order ?? "ASC";
        if (direction !== "ASC" && direction !== "DESC") {
          throw new Error(
            `Invalid sort direction "${String(direction)}": expected "ASC" or "DESC".`,
          );
        }
        suffix += ` ORDER BY ${quotedOrder} ${direction}`;
      } else if (Array.isArray(options.orderBy) && options.orderBy.length > 0) {
        const clauses = options.orderBy.map((item) => {
          const col = typeof item === "string" ? item : item.column;
          const dir =
            typeof item === "string"
              ? (options.order ?? "ASC")
              : (item.order ?? "ASC");
          const quoted = quoteSqlIdentifier(col, "orderBy column");
          if (dir !== "ASC" && dir !== "DESC") {
            throw new Error(
              `Invalid sort direction "${String(dir)}": expected "ASC" or "DESC".`,
            );
          }
          return `${quoted} ${dir}`;
        });
        suffix += ` ORDER BY ${clauses.join(", ")}`;
      }
    }

    if (options.limit !== undefined) {
      if (!Number.isInteger(options.limit) || options.limit < 0) {
        throw new Error(
          `Invalid limit "${options.limit}": expected a non-negative integer.`,
        );
      }
      suffix += " LIMIT ?";
      params.push(options.limit);
    } else if (options.offset !== undefined) {
      // SQLite requires LIMIT before OFFSET
      suffix += " LIMIT -1";
    }

    if (options.offset !== undefined) {
      if (!Number.isInteger(options.offset) || options.offset < 0) {
        throw new Error(
          `Invalid offset "${options.offset}": expected a non-negative integer.`,
        );
      }
      suffix += " OFFSET ?";
      params.push(options.offset);
    }

    return suffix;
  }
}
