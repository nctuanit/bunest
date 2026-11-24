import type { OrmDatabaseType, OrmDialect } from "./types";

const SAFE_SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Strictly validates SQL identifiers (tables, schemas, columns, aliases, index & constraint names)
 * to prevent SQL injection.
 */
export function assertSafeSqlIdentifier(
  value: string,
  context = "SQL identifier",
): string {
  if (!value || !SAFE_SQL_IDENTIFIER.test(value)) {
    throw new Error(
      `Invalid ${context}: "${value}". Identifiers must match /^[A-Za-z_][A-Za-z0-9_]*$/.`,
    );
  }
  return value;
}

/**
 * Quotes a validated SQL identifier according to the target dialect:
 * - `[id]` for MSSQL
 * - `` `id` `` for MySQL, MariaDB, Spanner
 * - `"id"` for SQLite, LibSQL, D1, PostgreSQL, CockroachDB, Oracle, SAP HANA
 */
export function quoteIdentifier(
  value: string,
  dialect: OrmDialect,
  context = "SQL identifier",
): string {
  const safe = assertSafeSqlIdentifier(value, context);
  if (dialect === "mssql") {
    return `[${safe}]`;
  }
  if (dialect === "mysql" || dialect === "mariadb" || dialect === "spanner") {
    return `\`${safe}\``;
  }
  return `"${safe}"`;
}

/**
 * Formats a schema-qualified or plain table reference safely.
 */
export function formatTableRef(
  tableName: string,
  schema: string | undefined,
  dialect: OrmDialect,
): string {
  const quotedTable = quoteIdentifier(tableName, dialect, "table name");
  if (schema && schema.length > 0) {
    const quotedSchema = quoteIdentifier(schema, dialect, "schema name");
    return `${quotedSchema}.${quotedTable}`;
  }
  return quotedTable;
}

/**
 * Formats a positional SQL parameter placeholder per dialect:
 * - `$1..$n` for PostgreSQL / CockroachDB
 * - `@p1..@pn` for MSSQL / Spanner
 * - `:1..:n` for Oracle
 * - `?` for SQLite / LibSQL / D1 / MySQL / MariaDB / SAP HANA
 */
export function formatPlaceholder(
  index1Based: number,
  dialect: OrmDialect,
): string {
  if (dialect === "postgres" || dialect === "cockroachdb") {
    return `$${index1Based}`;
  }
  if (dialect === "mssql" || dialect === "spanner") {
    return `@p${index1Based}`;
  }
  if (dialect === "oracle") {
    return `:${index1Based}`;
  }
  return "?";
}

/**
 * Converts `camelCase` / `PascalCase` names to `snake_case`.
 */
export function camelToSnake(input: string): string {
  return input
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

/**
 * Basic English pluralization matching `@bunest/core` entity conventions.
 */
export function pluralizeWord(word: string): string {
  if (word.length === 0) return word;
  if (/(?:s|x|z|ch|sh)$/i.test(word)) {
    return `${word}es`;
  }
  if (/[^aeiou]y$/i.test(word)) {
    return `${word.slice(0, -1)}ies`;
  }
  return `${word}s`;
}

/**
 * Infers a SQL table name from an entity class name.
 */
export function inferTableName(className: string, pluralize: boolean): string {
  const snake = camelToSnake(className || "entity") || "entity";
  if (!pluralize) {
    return snake;
  }
  const parts = snake.split("_");
  const last = parts[parts.length - 1] ?? snake;
  parts[parts.length - 1] = pluralizeWord(last);
  return parts.join("_");
}

/**
 * Normalizes EVERY TypeORM database `type` alias into a canonical `OrmDialect`.
 */
export function normalizeDialect(raw?: OrmDatabaseType): OrmDialect {
  if (!raw) return "sqlite";
  const lower = String(raw).toLowerCase();
  switch (lower) {
    case "sqlite":
    case "bun-sqlite":
    case "better-sqlite3":
    case "sqljs":
    case "cordova":
    case "nativescript":
    case "react-native":
    case "expo":
    case "capacitor":
      return "sqlite";
    case "libsql":
    case "turso":
      return "libsql";
    case "d1":
      return "d1";
    case "postgres":
    case "postgresql":
    case "pg":
    case "aurora-postgres":
      return "postgres";
    case "cockroachdb":
      return "cockroachdb";
    case "mysql":
    case "mysql2":
    case "aurora-mysql":
      return "mysql";
    case "mariadb":
      return "mariadb";
    case "mssql":
    case "sqlserver":
      return "mssql";
    case "oracle":
      return "oracle";
    case "sap":
    case "hana":
      return "sap";
    case "spanner":
      return "spanner";
    case "mongodb":
    case "mongo":
      return "mongodb";
    default:
      return "sqlite";
  }
}

/**
 * Escapes `%`, `_`, and `!` characters for LIKE patterns using `ESCAPE '!'`.
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/[!%_]/g, "!$&");
}

/**
 * Creates a deterministic, length-safe SQL identifier for constraints or indexes.
 */
export function makeConstraintName(
  prefix: string,
  parts: readonly string[],
): string {
  const raw = `${prefix}_${parts.join("_")}`
    .replace(/[^A-Za-z0-9_]/g, "_")
    .replace(/_+/g, "_");
  if (raw.length <= 63) {
    return raw;
  }
  let hash = 2166136261;
  for (let i = 0; i < raw.length; i++) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const hex = (hash >>> 0).toString(16).padStart(8, "0");
  return `${raw.slice(0, 54)}_${hex}`;
}
