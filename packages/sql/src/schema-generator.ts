import {
  getEntitySchema,
  type Abstract,
  type EntityColumnMetadata,
  type EntityIndexMetadata,
  type Type,
} from "@bunest/common";
import {
  assertSafeSqlIdentifier,
  quoteSqlIdentifier,
  type SqlDialect,
} from "./identifiers";

export interface GeneratedTableDdl {
  readonly tableSql: string;
  readonly indexSqls: string[];
}

const UNSAFE_WHERE_PATTERN = /(?:;|--|\/\*|\*\/)/;

function isMySqlDialect(dialect: SqlDialect): boolean {
  return dialect === "mysql" || dialect === "mariadb";
}

function formatTableReference(
  tableName: string,
  schema: string | undefined,
  dialect: SqlDialect,
): string {
  const quotedTable = quoteSqlIdentifier(tableName, dialect, "table name");
  if (schema !== undefined && schema.length > 0) {
    const quotedSchema = quoteSqlIdentifier(schema, dialect, "schema name");
    return `${quotedSchema}.${quotedTable}`;
  }
  return quotedTable;
}

function validateColumnLength(col: EntityColumnMetadata): number | undefined {
  if (col.length === undefined) {
    return undefined;
  }
  if (!Number.isInteger(col.length) || col.length <= 0) {
    throw new Error(
      `Invalid length "${String(col.length)}" on column "${col.name}": expected a positive integer.`,
    );
  }
  return col.length;
}

function escapeSqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function formatDefaultLiteral(
  col: EntityColumnMetadata,
  dialect: SqlDialect,
): string | undefined {
  if (!col.hasDefault) {
    return undefined;
  }
  const value = col.default;
  if (value === undefined || typeof value === "function") {
    return undefined;
  }
  if (value === null) {
    return "DEFAULT NULL";
  }
  if (typeof value === "boolean") {
    if (dialect === "sqlite") {
      return value ? "DEFAULT 1" : "DEFAULT 0";
    }
    return value ? "DEFAULT TRUE" : "DEFAULT FALSE";
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(
        `Invalid numeric default value "${String(value)}" on column "${col.name}": must be finite.`,
      );
    }
    return `DEFAULT ${value}`;
  }
  if (typeof value === "bigint") {
    return `DEFAULT ${value.toString()}`;
  }
  if (value instanceof Date) {
    return `DEFAULT ${escapeSqlStringLiteral(value.toISOString())}`;
  }
  if (typeof value === "string") {
    return `DEFAULT ${escapeSqlStringLiteral(value)}`;
  }
  if (col.type === "json" || typeof value === "object") {
    if (isMySqlDialect(dialect)) {
      return undefined;
    }
    const serialized = escapeSqlStringLiteral(JSON.stringify(value));
    if (dialect === "postgres") {
      return `DEFAULT ${serialized}::jsonb`;
    }
    return `DEFAULT ${serialized}`;
  }
  return `DEFAULT ${escapeSqlStringLiteral(String(value))}`;
}

function resolveColumnSqlType(
  col: EntityColumnMetadata,
  dialect: SqlDialect,
): string {
  const length = validateColumnLength(col);

  switch (col.type) {
    case "integer":
      if (isMySqlDialect(dialect)) return "INT";
      return "INTEGER";
    case "bigint":
      if (dialect === "sqlite") return "INTEGER";
      return "BIGINT";
    case "real":
      if (dialect === "postgres") return "DOUBLE PRECISION";
      if (isMySqlDialect(dialect)) return "DOUBLE";
      return "REAL";
    case "varchar":
      return `VARCHAR(${length ?? 255})`;
    case "text":
      if (length !== undefined) {
        return `VARCHAR(${length})`;
      }
      if (
        isMySqlDialect(dialect) &&
        (col.primary || col.unique || col.hasDefault)
      ) {
        return "VARCHAR(255)";
      }
      return "TEXT";
    case "boolean":
      if (dialect === "postgres") return "BOOLEAN";
      if (isMySqlDialect(dialect)) return "TINYINT(1)";
      return "INTEGER";
    case "json":
      if (dialect === "postgres") return "JSONB";
      if (isMySqlDialect(dialect)) return "JSON";
      return "TEXT";
    case "datetime":
      if (dialect === "postgres") return "TIMESTAMPTZ";
      if (isMySqlDialect(dialect)) return "DATETIME";
      return "TEXT";
    case "blob":
      if (dialect === "postgres") return "BYTEA";
      if (isMySqlDialect(dialect)) return "LONGBLOB";
      return "BLOB";
    case "uuid":
      if (dialect === "postgres") return "UUID";
      if (isMySqlDialect(dialect)) return "CHAR(36)";
      return "TEXT";
  }
}

function buildColumnDefinition(
  col: EntityColumnMetadata,
  dialect: SqlDialect,
  isSinglePrimary: boolean,
): string {
  const quotedName = quoteSqlIdentifier(col.name, dialect, "column name");
  const isAutoIncrement =
    col.primary &&
    col.generated &&
    col.generationStrategy === "increment" &&
    isSinglePrimary;

  if (isAutoIncrement) {
    if (dialect === "sqlite") {
      return `${quotedName} INTEGER PRIMARY KEY AUTOINCREMENT`;
    }
    if (dialect === "postgres") {
      const serialType = col.type === "bigint" ? "BIGSERIAL" : "SERIAL";
      return `${quotedName} ${serialType} PRIMARY KEY`;
    }
    const mysqlIntType = col.type === "bigint" ? "BIGINT" : "INT";
    return `${quotedName} ${mysqlIntType} AUTO_INCREMENT PRIMARY KEY`;
  }

  const parts: string[] = [quotedName, resolveColumnSqlType(col, dialect)];

  if (col.primary && isSinglePrimary) {
    parts.push("PRIMARY KEY");
  } else {
    if (!col.nullable) {
      parts.push("NOT NULL");
    }
    if (col.unique) {
      parts.push("UNIQUE");
    }
  }

  const defaultClause = formatDefaultLiteral(col, dialect);
  if (defaultClause !== undefined) {
    parts.push(defaultClause);
  }

  return parts.join(" ");
}

function buildIndexStatement(
  idx: EntityIndexMetadata,
  tableName: string,
  tableRef: string,
  dialect: SqlDialect,
): string {
  if (idx.columns.length === 0) {
    throw new Error(
      `Index on table "${tableName}" requires at least one column.`,
    );
  }

  const safeColumns = idx.columns.map((c) =>
    assertSafeSqlIdentifier(c, `index column on table "${tableName}"`),
  );
  const indexName =
    idx.name ?? `${idx.unique ? "uq" : "idx"}_${tableName}_${safeColumns.join("_")}`;
  const quotedIndex = quoteSqlIdentifier(indexName, dialect, "index name");
  const quotedCols = safeColumns
    .map((c) => quoteSqlIdentifier(c, dialect, "index column"))
    .join(", ");

  let whereClause = "";
  if (idx.where !== undefined && idx.where.trim().length > 0) {
    if (UNSAFE_WHERE_PATTERN.test(idx.where)) {
      throw new Error(
        `Unsafe WHERE clause in index "${indexName}" on table "${tableName}".`,
      );
    }
    if (!isMySqlDialect(dialect)) {
      whereClause = ` WHERE ${idx.where.trim()}`;
    }
  }

  const uniqueKeyword = idx.unique ? "UNIQUE " : "";
  return `CREATE ${uniqueKeyword}INDEX IF NOT EXISTS ${quotedIndex} ON ${tableRef} (${quotedCols})${whereClause}`;
}

/**
 * Generates idempotent `CREATE TABLE IF NOT EXISTS` and `CREATE [UNIQUE] INDEX IF NOT EXISTS`
 * DDL statements from a unified `@Entity()` / `@Column()` / `@PrimaryKey()` / `@Index()` class.
 *
 * Every table, schema, column, and index identifier is strictly validated via
 * `assertSafeSqlIdentifier` / `quoteSqlIdentifier` across `"sqlite"`, `"postgres"`,
 * and `"mysql"` / `"mariadb"` dialects.
 */
export function generateCreateTableSql(
  entityClass: Type<unknown> | Abstract<unknown>,
  dialect: SqlDialect = "sqlite",
): GeneratedTableDdl {
  const schema = getEntitySchema(entityClass);
  if (!schema) {
    throw new Error(
      `Entity "${entityClass.name || "Anonymous"}" is missing @Entity() metadata.`,
    );
  }
  if (schema.columns.length === 0) {
    throw new Error(
      `Entity "${entityClass.name || "Anonymous"}" (table "${schema.tableName}") has no @Column() or @PrimaryKey() definitions.`,
    );
  }

  assertSafeSqlIdentifier(schema.tableName, "table name");
  const tableRef = formatTableReference(schema.tableName, schema.schema, dialect);
  const isSinglePrimary = schema.primaryKeys.length === 1;

  const definitions: string[] = schema.columns.map((col) =>
    buildColumnDefinition(col, dialect, isSinglePrimary),
  );

  if (schema.primaryKeys.length > 1) {
    const pkCols = schema.primaryKeys
      .map((pk) => quoteSqlIdentifier(pk.name, dialect, "primary key column"))
      .join(", ");
    definitions.push(`PRIMARY KEY (${pkCols})`);
  }

  const tableSql = `CREATE TABLE IF NOT EXISTS ${tableRef} (\n  ${definitions.join(",\n  ")}\n)`;
  const indexSqls = schema.indexes.map((idx) =>
    buildIndexStatement(idx, schema.tableName, tableRef, dialect),
  );

  return { tableSql, indexSqls };
}
