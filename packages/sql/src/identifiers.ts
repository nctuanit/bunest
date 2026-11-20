export type SqlDialect = "postgres" | "mysql" | "mariadb" | "sqlite";

const SAFE_SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Normalizes a `Bun.SQL` adapter name into a canonical `SqlDialect`.
 */
export function normalizeSqlDialect(adapter: string | undefined): SqlDialect {
  const lower = (adapter ?? "sqlite").toLowerCase();
  if (lower === "postgres" || lower === "postgresql" || lower === "pg") {
    return "postgres";
  }
  if (lower === "mysql") {
    return "mysql";
  }
  if (lower === "mariadb") {
    return "mariadb";
  }
  return "sqlite";
}

/**
 * Validates that a SQL identifier (table or column name) contains only ASCII
 * letters, digits, and underscores and starts with a letter or underscore.
 */
export function assertSafeSqlIdentifier(
  identifier: string,
  label: string = "SQL identifier",
): string {
  if (!SAFE_SQL_IDENTIFIER.test(identifier)) {
    throw new Error(
      `Invalid ${label} "${identifier}": must match ${SAFE_SQL_IDENTIFIER.source}`,
    );
  }
  return identifier;
}

/**
 * Validates and quotes a SQL identifier according to the active SQL dialect
 * (backticks for MySQL/MariaDB, double quotes for PostgreSQL/SQLite).
 */
export function quoteSqlIdentifier(
  identifier: string,
  dialect: SqlDialect = "sqlite",
  label: string = "SQL identifier",
): string {
  assertSafeSqlIdentifier(identifier, label);
  if (dialect === "mysql" || dialect === "mariadb") {
    return `\`${identifier}\``;
  }
  return `"${identifier}"`;
}
