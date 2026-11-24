import { assertSafeSqlIdentifier } from "../identifiers";
import type { OrmColumnType, OrmDialect } from "../types";

export type ReturningStyle = "returning" | "output" | "then-return" | "none";
export type ForeignKeySyncStrategy =
  | "sqlite-pragma"
  | "mysql-fk-checks"
  | "deferred-alter"
  | "none";

export interface DialectColumnDescriptor {
  readonly columnName: string;
  readonly type: OrmColumnType;
  readonly length?: number;
  readonly precision?: number;
  readonly scale?: number;
  readonly primary: boolean;
  readonly unique: boolean;
  readonly hasDefault: boolean;
  readonly default?: unknown;
  readonly nullable: boolean;
}

/**
 * Unified SQL / Document dialect profile encapsulating every dialect-specific
 * syntax rule across ALL TypeORM-compatible databases:
 * `sqlite`, `libsql`, `d1`, `postgres`, `cockroachdb`, `mysql`, `mariadb`,
 * `mssql`, `oracle`, `sap`, `spanner`, and `mongodb`.
 */
export interface SqlDialectProfile {
  readonly dialect: OrmDialect;
  readonly isDocumentStore: boolean;
  readonly returningStyle: ReturningStyle;
  readonly fkSyncStrategy: ForeignKeySyncStrategy;
  readonly supportsDefaultValuesInsert: boolean;
  readonly supportsPartialIndexWhere: boolean;
  readonly supportsDropCascade: boolean;
  readonly supportsDeferrableForeignKeys: boolean;
  readonly supportsCreateTableIfNotExists: boolean;
  quoteIdentifier(identifier: string, context?: string): string;
  formatPlaceholder(index1Based: number): string;
  columnSqlType(col: DialectColumnDescriptor): string;
  autoIncrementColumnSql(
    col: DialectColumnDescriptor,
    quotedColName: string,
  ): string;
  formatDefault(col: DialectColumnDescriptor): string | undefined;
  formatLimitOffset(
    take: number | undefined,
    skip: number | undefined,
    hasOrderBy: boolean,
  ): string;
  formatILike(colRef: string, placeholder: string): string;
  formatJsonExtract(colRef: string, jsonKey: string): string;
  formatInsertIgnoreJoinRow(
    joinTableRef: string,
    colA: string,
    colB: string,
    p1: string,
    p2: string,
  ): string;
  formatEmptyInsert(tableRef: string): string;
  formatBooleanParam(value: boolean): unknown;
  formatBigIntParam(value: bigint): unknown;
  formatCreateTablePrefix(tableRef: string): string;
  formatCreateIndexPrefix(unique: boolean, indexNameQuoted: string): string;
}

function escapeSqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function quoteDouble(id: string, ctx = "SQL identifier"): string {
  return `"${assertSafeSqlIdentifier(id, ctx)}"`;
}

function quoteBacktick(id: string, ctx = "SQL identifier"): string {
  return `\`${assertSafeSqlIdentifier(id, ctx)}\``;
}

function quoteBracket(id: string, ctx = "SQL identifier"): string {
  return `[${assertSafeSqlIdentifier(id, ctx)}]`;
}

function standardDefault(
  col: DialectColumnDescriptor,
  opts: {
    boolTrue: string;
    boolFalse: string;
    jsonCast?: string;
    skipJsonDefault?: boolean;
  },
): string | undefined {
  if (!col.hasDefault) return undefined;
  const val = col.default;
  if (val === undefined || typeof val === "function") return undefined;
  if (val === null) return "DEFAULT NULL";
  if (typeof val === "boolean") {
    return val ? `DEFAULT ${opts.boolTrue}` : `DEFAULT ${opts.boolFalse}`;
  }
  if (typeof val === "number") {
    if (!Number.isFinite(val)) return undefined;
    return `DEFAULT ${val}`;
  }
  if (typeof val === "bigint") {
    return `DEFAULT ${val.toString()}`;
  }
  if (val instanceof Date) {
    return `DEFAULT ${escapeSqlString(val.toISOString())}`;
  }
  if (typeof val === "string") {
    return `DEFAULT ${escapeSqlString(val)}`;
  }
  if (col.type === "json" || col.type === "jsonb" || typeof val === "object") {
    if (opts.skipJsonDefault) return undefined;
    const serialized = escapeSqlString(JSON.stringify(val));
    return opts.jsonCast
      ? `DEFAULT ${serialized}${opts.jsonCast}`
      : `DEFAULT ${serialized}`;
  }
  return `DEFAULT ${escapeSqlString(String(val))}`;
}

function createSqliteProfile(dialect: "sqlite" | "libsql" | "d1"): SqlDialectProfile {
  return {
    dialect,
    isDocumentStore: false,
    returningStyle: "returning",
    fkSyncStrategy: dialect === "sqlite" ? "sqlite-pragma" : "none",
    supportsDefaultValuesInsert: true,
    supportsPartialIndexWhere: true,
    supportsDropCascade: false,
    supportsDeferrableForeignKeys: false,
    supportsCreateTableIfNotExists: true,
    quoteIdentifier: quoteDouble,
    formatPlaceholder: () => "?",
    columnSqlType(col) {
      switch (col.type) {
        case "integer":
        case "bigint":
        case "boolean":
          return "INTEGER";
        case "real":
        case "float":
        case "decimal":
          return "REAL";
        case "varchar":
          return `VARCHAR(${col.length ?? 255})`;
        case "text":
          return col.length !== undefined ? `VARCHAR(${col.length})` : "TEXT";
        case "blob":
          return "BLOB";
        case "json":
        case "jsonb":
        case "datetime":
        case "timestamp":
        case "date":
        case "uuid":
        case "objectid":
          return "TEXT";
      }
    },
    autoIncrementColumnSql(_col, quoted) {
      return `${quoted} INTEGER PRIMARY KEY AUTOINCREMENT`;
    },
    formatDefault(col) {
      return standardDefault(col, { boolTrue: "1", boolFalse: "0" });
    },
    formatLimitOffset(take, skip) {
      let sql = "";
      if (take !== undefined) {
        sql += ` LIMIT ${Math.max(0, Math.floor(take))}`;
      } else if (skip !== undefined && skip > 0) {
        sql += " LIMIT -1";
      }
      if (skip !== undefined && skip > 0) {
        sql += ` OFFSET ${Math.floor(skip)}`;
      }
      return sql;
    },
    formatILike(colRef, ph) {
      return `LOWER(${colRef}) LIKE LOWER(${ph})`;
    },
    formatJsonExtract(colRef, key) {
      return `json_extract(${colRef}, '$.${assertSafeSqlIdentifier(key, "JSON key")}')`;
    },
    formatInsertIgnoreJoinRow(jtRef, colA, colB, p1, p2) {
      return `INSERT OR IGNORE INTO ${jtRef} (${colA}, ${colB}) VALUES (${p1}, ${p2})`;
    },
    formatEmptyInsert(tableRef) {
      return `INSERT INTO ${tableRef} DEFAULT VALUES RETURNING *`;
    },
    formatBooleanParam: (v) => (v ? 1 : 0),
    formatBigIntParam: (v) => Number(v),
    formatCreateTablePrefix: (t) => `CREATE TABLE IF NOT EXISTS ${t}`,
    formatCreateIndexPrefix: (u, n) =>
      `CREATE ${u ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${n}`,
  };
}

function createPostgresProfile(
  dialect: "postgres" | "cockroachdb",
): SqlDialectProfile {
  const isCockroach = dialect === "cockroachdb";
  return {
    dialect,
    isDocumentStore: false,
    returningStyle: "returning",
    fkSyncStrategy: "deferred-alter",
    supportsDefaultValuesInsert: true,
    supportsPartialIndexWhere: true,
    supportsDropCascade: true,
    supportsDeferrableForeignKeys: !isCockroach,
    supportsCreateTableIfNotExists: true,
    quoteIdentifier: quoteDouble,
    formatPlaceholder: (i) => `$${i}`,
    columnSqlType(col) {
      switch (col.type) {
        case "integer":
          return isCockroach ? "INT4" : "INTEGER";
        case "bigint":
          return isCockroach ? "INT8" : "BIGINT";
        case "real":
        case "float":
          return "DOUBLE PRECISION";
        case "decimal":
          return `DECIMAL(${col.precision ?? 12}, ${col.scale ?? 2})`;
        case "varchar":
          return `VARCHAR(${col.length ?? 255})`;
        case "text":
          return col.length !== undefined ? `VARCHAR(${col.length})` : "TEXT";
        case "boolean":
          return "BOOLEAN";
        case "json":
        case "jsonb":
          return "JSONB";
        case "datetime":
        case "timestamp":
          return "TIMESTAMPTZ";
        case "date":
          return "DATE";
        case "blob":
          return "BYTEA";
        case "uuid":
          return "UUID";
        case "objectid":
          return "VARCHAR(24)";
      }
    },
    autoIncrementColumnSql(col, quoted) {
      if (isCockroach) {
        return `${quoted} INT8 GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY`;
      }
      const serial = col.type === "bigint" ? "BIGSERIAL" : "SERIAL";
      return `${quoted} ${serial} PRIMARY KEY`;
    },
    formatDefault(col) {
      return standardDefault(col, {
        boolTrue: "TRUE",
        boolFalse: "FALSE",
        jsonCast: "::jsonb",
      });
    },
    formatLimitOffset(take, skip) {
      let sql = "";
      if (take !== undefined) sql += ` LIMIT ${Math.max(0, Math.floor(take))}`;
      if (skip !== undefined && skip > 0) sql += ` OFFSET ${Math.floor(skip)}`;
      return sql;
    },
    formatILike(colRef, ph) {
      return `${colRef} ILIKE ${ph}`;
    },
    formatJsonExtract(colRef, key) {
      return `${colRef}->>'${assertSafeSqlIdentifier(key, "JSON key")}'`;
    },
    formatInsertIgnoreJoinRow(jtRef, colA, colB, p1, p2) {
      return `INSERT INTO ${jtRef} (${colA}, ${colB}) VALUES (${p1}, ${p2}) ON CONFLICT DO NOTHING`;
    },
    formatEmptyInsert(tableRef) {
      return `INSERT INTO ${tableRef} DEFAULT VALUES RETURNING *`;
    },
    formatBooleanParam: (v) => Boolean(v),
    formatBigIntParam: (v) => v.toString(),
    formatCreateTablePrefix: (t) => `CREATE TABLE IF NOT EXISTS ${t}`,
    formatCreateIndexPrefix: (u, n) =>
      `CREATE ${u ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${n}`,
  };
}

function createMySqlProfile(dialect: "mysql" | "mariadb"): SqlDialectProfile {
  const isMaria = dialect === "mariadb";
  return {
    dialect,
    isDocumentStore: false,
    returningStyle: isMaria ? "returning" : "none",
    fkSyncStrategy: "mysql-fk-checks",
    supportsDefaultValuesInsert: false,
    supportsPartialIndexWhere: false,
    supportsDropCascade: false,
    supportsDeferrableForeignKeys: false,
    supportsCreateTableIfNotExists: true,
    quoteIdentifier: quoteBacktick,
    formatPlaceholder: () => "?",
    columnSqlType(col) {
      switch (col.type) {
        case "integer":
          return "INT";
        case "bigint":
          return "BIGINT";
        case "real":
        case "float":
          return "DOUBLE";
        case "decimal":
          return `DECIMAL(${col.precision ?? 12}, ${col.scale ?? 2})`;
        case "varchar":
          return `VARCHAR(${col.length ?? 255})`;
        case "text":
          if (col.length !== undefined) return `VARCHAR(${col.length})`;
          if (col.primary || col.unique || col.hasDefault) return "VARCHAR(255)";
          return "TEXT";
        case "boolean":
          return "TINYINT(1)";
        case "json":
        case "jsonb":
          return "JSON";
        case "datetime":
        case "timestamp":
          return "DATETIME";
        case "date":
          return "DATE";
        case "blob":
          return "LONGBLOB";
        case "uuid":
          return "CHAR(36)";
        case "objectid":
          return "CHAR(24)";
      }
    },
    autoIncrementColumnSql(col, quoted) {
      const intType = col.type === "bigint" ? "BIGINT" : "INT";
      return `${quoted} ${intType} AUTO_INCREMENT PRIMARY KEY`;
    },
    formatDefault(col) {
      return standardDefault(col, {
        boolTrue: "TRUE",
        boolFalse: "FALSE",
        skipJsonDefault: true,
      });
    },
    formatLimitOffset(take, skip) {
      let sql = "";
      if (take !== undefined) {
        sql += ` LIMIT ${Math.max(0, Math.floor(take))}`;
      } else if (skip !== undefined && skip > 0) {
        sql += " LIMIT 18446744073709551615";
      }
      if (skip !== undefined && skip > 0) {
        sql += ` OFFSET ${Math.floor(skip)}`;
      }
      return sql;
    },
    formatILike(colRef, ph) {
      return `LOWER(${colRef}) LIKE LOWER(${ph})`;
    },
    formatJsonExtract(colRef, key) {
      return `JSON_UNQUOTE(JSON_EXTRACT(${colRef}, '$.${assertSafeSqlIdentifier(key, "JSON key")}'))`;
    },
    formatInsertIgnoreJoinRow(jtRef, colA, colB, p1, p2) {
      return `INSERT IGNORE INTO ${jtRef} (${colA}, ${colB}) VALUES (${p1}, ${p2})`;
    },
    formatEmptyInsert(tableRef) {
      return isMaria
        ? `INSERT INTO ${tableRef} () VALUES () RETURNING *`
        : `INSERT INTO ${tableRef} () VALUES ()`;
    },
    formatBooleanParam: (v) => (v ? 1 : 0),
    formatBigIntParam: (v) => v.toString(),
    formatCreateTablePrefix: (t) => `CREATE TABLE IF NOT EXISTS ${t}`,
    formatCreateIndexPrefix: (u, n) =>
      `CREATE ${u ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${n}`,
  };
}

const MSSQL_PROFILE: SqlDialectProfile = {
  dialect: "mssql",
  isDocumentStore: false,
  returningStyle: "output",
  fkSyncStrategy: "deferred-alter",
  supportsDefaultValuesInsert: true,
  supportsPartialIndexWhere: true,
  supportsDropCascade: false,
  supportsDeferrableForeignKeys: false,
  supportsCreateTableIfNotExists: false,
  quoteIdentifier: quoteBracket,
  formatPlaceholder: (i) => `@p${i}`,
  columnSqlType(col) {
    switch (col.type) {
      case "integer":
        return "INT";
      case "bigint":
        return "BIGINT";
      case "real":
      case "float":
        return "FLOAT";
      case "decimal":
        return `DECIMAL(${col.precision ?? 12}, ${col.scale ?? 2})`;
      case "varchar":
        return `NVARCHAR(${col.length ?? 255})`;
      case "text":
        if (col.length !== undefined) return `NVARCHAR(${col.length})`;
        if (col.primary || col.unique) return "NVARCHAR(255)";
        return "NVARCHAR(MAX)";
      case "boolean":
        return "BIT";
      case "json":
      case "jsonb":
        return "NVARCHAR(MAX)";
      case "datetime":
      case "timestamp":
        return "DATETIME2";
      case "date":
        return "DATE";
      case "blob":
        return "VARBINARY(MAX)";
      case "uuid":
        return "UNIQUEIDENTIFIER";
      case "objectid":
        return "NVARCHAR(24)";
    }
  },
  autoIncrementColumnSql(col, quoted) {
    const intType = col.type === "bigint" ? "BIGINT" : "INT";
    return `${quoted} ${intType} IDENTITY(1,1) PRIMARY KEY`;
  },
  formatDefault(col) {
    return standardDefault(col, { boolTrue: "1", boolFalse: "0" });
  },
  formatLimitOffset(take, skip, hasOrderBy) {
    if (take === undefined && (skip === undefined || skip <= 0)) return "";
    const orderPrefix = hasOrderBy ? "" : " ORDER BY (SELECT NULL)";
    const offsetVal = skip !== undefined && skip > 0 ? Math.floor(skip) : 0;
    if (take !== undefined) {
      return `${orderPrefix} OFFSET ${offsetVal} ROWS FETCH NEXT ${Math.max(0, Math.floor(take))} ROWS ONLY`;
    }
    return `${orderPrefix} OFFSET ${offsetVal} ROWS`;
  },
  formatILike(colRef, ph) {
    return `LOWER(${colRef}) LIKE LOWER(${ph})`;
  },
  formatJsonExtract(colRef, key) {
    return `JSON_VALUE(${colRef}, '$.${assertSafeSqlIdentifier(key, "JSON key")}')`;
  },
  formatInsertIgnoreJoinRow(jtRef, colA, colB, p1, p2) {
    return `IF NOT EXISTS (SELECT 1 FROM ${jtRef} WHERE ${colA} = ${p1} AND ${colB} = ${p2}) INSERT INTO ${jtRef} (${colA}, ${colB}) VALUES (${p1}, ${p2})`;
  },
  formatEmptyInsert(tableRef) {
    return `INSERT INTO ${tableRef} OUTPUT INSERTED.* DEFAULT VALUES`;
  },
  formatBooleanParam: (v) => (v ? 1 : 0),
  formatBigIntParam: (v) => v.toString(),
  formatCreateTablePrefix: (t) => `IF OBJECT_ID('${t.replace(/[[\]]/g, "")}', 'U') IS NULL CREATE TABLE ${t}`,
  formatCreateIndexPrefix: (u, n) => `CREATE ${u ? "UNIQUE " : ""}INDEX ${n}`,
};

const ORACLE_PROFILE: SqlDialectProfile = {
  dialect: "oracle",
  isDocumentStore: false,
  returningStyle: "none",
  fkSyncStrategy: "deferred-alter",
  supportsDefaultValuesInsert: false,
  supportsPartialIndexWhere: false,
  supportsDropCascade: false,
  supportsDeferrableForeignKeys: true,
  supportsCreateTableIfNotExists: true,
  quoteIdentifier: quoteDouble,
  formatPlaceholder: (i) => `:${i}`,
  columnSqlType(col) {
    switch (col.type) {
      case "integer":
        return "NUMBER(10)";
      case "bigint":
        return "NUMBER(19)";
      case "real":
      case "float":
        return "BINARY_DOUBLE";
      case "decimal":
        return `NUMBER(${col.precision ?? 12}, ${col.scale ?? 2})`;
      case "varchar":
        return `VARCHAR2(${col.length ?? 255})`;
      case "text":
        if (col.length !== undefined) return `VARCHAR2(${col.length})`;
        if (col.primary || col.unique) return "VARCHAR2(255)";
        return "CLOB";
      case "boolean":
        return "NUMBER(1)";
      case "json":
      case "jsonb":
        return "CLOB";
      case "datetime":
      case "timestamp":
        return "TIMESTAMP WITH TIME ZONE";
      case "date":
        return "DATE";
      case "blob":
        return "BLOB";
      case "uuid":
        return "VARCHAR2(36)";
      case "objectid":
        return "VARCHAR2(24)";
    }
  },
  autoIncrementColumnSql(col, quoted) {
    const numType = col.type === "bigint" ? "NUMBER(19)" : "NUMBER(10)";
    return `${quoted} ${numType} GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY`;
  },
  formatDefault(col) {
    return standardDefault(col, { boolTrue: "1", boolFalse: "0" });
  },
  formatLimitOffset(take, skip) {
    if (take === undefined && (skip === undefined || skip <= 0)) return "";
    let sql = "";
    if (skip !== undefined && skip > 0) {
      sql += ` OFFSET ${Math.floor(skip)} ROWS`;
    }
    if (take !== undefined) {
      sql += ` FETCH NEXT ${Math.max(0, Math.floor(take))} ROWS ONLY`;
    }
    return sql;
  },
  formatILike(colRef, ph) {
    return `LOWER(${colRef}) LIKE LOWER(${ph})`;
  },
  formatJsonExtract(colRef, key) {
    return `JSON_VALUE(${colRef}, '$.${assertSafeSqlIdentifier(key, "JSON key")}')`;
  },
  formatInsertIgnoreJoinRow(jtRef, colA, colB, p1, p2) {
    return `MERGE INTO ${jtRef} t USING (SELECT ${p1} AS a, ${p2} AS b FROM DUAL) s ON (t.${colA} = s.a AND t.${colB} = s.b) WHEN NOT MATCHED THEN INSERT (${colA}, ${colB}) VALUES (s.a, s.b)`;
  },
  formatEmptyInsert(tableRef) {
    return `INSERT INTO ${tableRef} DEFAULT VALUES`;
  },
  formatBooleanParam: (v) => (v ? 1 : 0),
  formatBigIntParam: (v) => v.toString(),
  formatCreateTablePrefix: (t) => `CREATE TABLE IF NOT EXISTS ${t}`,
  formatCreateIndexPrefix: (u, n) =>
    `CREATE ${u ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${n}`,
};

const SAP_PROFILE: SqlDialectProfile = {
  dialect: "sap",
  isDocumentStore: false,
  returningStyle: "none",
  fkSyncStrategy: "deferred-alter",
  supportsDefaultValuesInsert: false,
  supportsPartialIndexWhere: false,
  supportsDropCascade: false,
  supportsDeferrableForeignKeys: false,
  supportsCreateTableIfNotExists: true,
  quoteIdentifier: quoteDouble,
  formatPlaceholder: () => "?",
  columnSqlType(col) {
    switch (col.type) {
      case "integer":
        return "INTEGER";
      case "bigint":
        return "BIGINT";
      case "real":
      case "float":
        return "DOUBLE";
      case "decimal":
        return `DECIMAL(${col.precision ?? 12}, ${col.scale ?? 2})`;
      case "varchar":
        return `NVARCHAR(${col.length ?? 255})`;
      case "text":
        return col.length !== undefined ? `NVARCHAR(${col.length})` : "NCLOB";
      case "boolean":
        return "BOOLEAN";
      case "json":
      case "jsonb":
        return "NCLOB";
      case "datetime":
      case "timestamp":
        return "TIMESTAMP";
      case "date":
        return "DATE";
      case "blob":
        return "BLOB";
      case "uuid":
        return "NVARCHAR(36)";
      case "objectid":
        return "NVARCHAR(24)";
    }
  },
  autoIncrementColumnSql(col, quoted) {
    const intType = col.type === "bigint" ? "BIGINT" : "INTEGER";
    return `${quoted} ${intType} GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY`;
  },
  formatDefault(col) {
    return standardDefault(col, { boolTrue: "TRUE", boolFalse: "FALSE" });
  },
  formatLimitOffset(take, skip) {
    let sql = "";
    if (take !== undefined) sql += ` LIMIT ${Math.max(0, Math.floor(take))}`;
    if (skip !== undefined && skip > 0) sql += ` OFFSET ${Math.floor(skip)}`;
    return sql;
  },
  formatILike(colRef, ph) {
    return `LOWER(${colRef}) LIKE LOWER(${ph})`;
  },
  formatJsonExtract(colRef, key) {
    return `JSON_VALUE(${colRef}, '$.${assertSafeSqlIdentifier(key, "JSON key")}')`;
  },
  formatInsertIgnoreJoinRow(jtRef, colA, colB, p1, p2) {
    return `UPSERT ${jtRef} (${colA}, ${colB}) VALUES (${p1}, ${p2}) WITH PRIMARY KEY`;
  },
  formatEmptyInsert(tableRef) {
    return `INSERT INTO ${tableRef} DEFAULT VALUES`;
  },
  formatBooleanParam: (v) => Boolean(v),
  formatBigIntParam: (v) => v.toString(),
  formatCreateTablePrefix: (t) => `CREATE COLUMN TABLE IF NOT EXISTS ${t}`,
  formatCreateIndexPrefix: (u, n) => `CREATE ${u ? "UNIQUE " : ""}INDEX ${n}`,
};

const SPANNER_PROFILE: SqlDialectProfile = {
  dialect: "spanner",
  isDocumentStore: false,
  returningStyle: "then-return",
  fkSyncStrategy: "deferred-alter",
  supportsDefaultValuesInsert: false,
  supportsPartialIndexWhere: false,
  supportsDropCascade: false,
  supportsDeferrableForeignKeys: false,
  supportsCreateTableIfNotExists: true,
  quoteIdentifier: quoteBacktick,
  formatPlaceholder: (i) => `@p${i}`,
  columnSqlType(col) {
    switch (col.type) {
      case "integer":
      case "bigint":
        return "INT64";
      case "real":
      case "float":
        return "FLOAT64";
      case "decimal":
        return "NUMERIC";
      case "varchar":
        return `STRING(${col.length ?? 255})`;
      case "text":
        return col.length !== undefined ? `STRING(${col.length})` : "STRING(MAX)";
      case "boolean":
        return "BOOL";
      case "json":
      case "jsonb":
        return "JSON";
      case "datetime":
      case "timestamp":
        return "TIMESTAMP";
      case "date":
        return "DATE";
      case "blob":
        return "BYTES(MAX)";
      case "uuid":
        return "STRING(36)";
      case "objectid":
        return "STRING(24)";
    }
  },
  autoIncrementColumnSql(_col, quoted) {
    return `${quoted} INT64 NOT NULL GENERATED BY DEFAULT AS IDENTITY (BIT_REVERSED_POSITIVE)`;
  },
  formatDefault(col) {
    return standardDefault(col, {
      boolTrue: "TRUE",
      boolFalse: "FALSE",
      skipJsonDefault: true,
    });
  },
  formatLimitOffset(take, skip) {
    let sql = "";
    if (take !== undefined) sql += ` LIMIT ${Math.max(0, Math.floor(take))}`;
    if (skip !== undefined && skip > 0) sql += ` OFFSET ${Math.floor(skip)}`;
    return sql;
  },
  formatILike(colRef, ph) {
    return `LOWER(${colRef}) LIKE LOWER(${ph})`;
  },
  formatJsonExtract(colRef, key) {
    return `JSON_VALUE(${colRef}, '$.${assertSafeSqlIdentifier(key, "JSON key")}')`;
  },
  formatInsertIgnoreJoinRow(jtRef, colA, colB, p1, p2) {
    return `INSERT OR IGNORE INTO ${jtRef} (${colA}, ${colB}) VALUES (${p1}, ${p2})`;
  },
  formatEmptyInsert(tableRef) {
    return `INSERT INTO ${tableRef} DEFAULT VALUES THEN RETURN *`;
  },
  formatBooleanParam: (v) => Boolean(v),
  formatBigIntParam: (v) => v.toString(),
  formatCreateTablePrefix: (t) => `CREATE TABLE IF NOT EXISTS ${t}`,
  formatCreateIndexPrefix: (u, n) =>
    `CREATE ${u ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${n}`,
};

const MONGODB_PROFILE: SqlDialectProfile = {
  ...createSqliteProfile("sqlite"),
  dialect: "mongodb",
  isDocumentStore: true,
  fkSyncStrategy: "none",
};

const DIALECT_PROFILES: Readonly<Record<OrmDialect, SqlDialectProfile>> = {
  sqlite: createSqliteProfile("sqlite"),
  libsql: createSqliteProfile("libsql"),
  d1: createSqliteProfile("d1"),
  postgres: createPostgresProfile("postgres"),
  cockroachdb: createPostgresProfile("cockroachdb"),
  mysql: createMySqlProfile("mysql"),
  mariadb: createMySqlProfile("mariadb"),
  mssql: MSSQL_PROFILE,
  oracle: ORACLE_PROFILE,
  sap: SAP_PROFILE,
  spanner: SPANNER_PROFILE,
  mongodb: MONGODB_PROFILE,
};

/**
 * Returns the canonical `SqlDialectProfile` for any supported `OrmDialect`.
 */
export function getDialectProfile(dialect: OrmDialect): SqlDialectProfile {
  return DIALECT_PROFILES[dialect] ?? DIALECT_PROFILES.sqlite;
}

/**
 * Lists all built-in supported canonical dialects.
 */
export function getSupportedDialects(): readonly OrmDialect[] {
  return Object.keys(DIALECT_PROFILES) as OrmDialect[];
}
