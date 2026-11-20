const SAFE_SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Validates that a SQL identifier (table name, column name, savepoint name, PRAGMA key)
 * contains only ASCII letters, digits, and underscores and starts with a letter or underscore.
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
 * Validates and double-quote escapes a SQLite identifier.
 */
export function quoteSqlIdentifier(
  identifier: string,
  label: string = "SQL identifier",
): string {
  assertSafeSqlIdentifier(identifier, label);
  return `"${identifier}"`;
}
