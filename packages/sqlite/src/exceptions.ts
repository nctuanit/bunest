/**
 * Thrown when duplicate SQLite connection names are registered in the same configuration.
 */
export class DuplicateSqliteConnectionException extends Error {
  public readonly connectionName: string;

  constructor(connectionName: string) {
    super(
      `Duplicate SQLite connection "${connectionName}". Each SQLite connection in an application must have a unique "name".`,
    );
    this.name = "DuplicateSqliteConnectionException";
    this.connectionName = connectionName;
  }
}

/**
 * Thrown by `findByIdOrFail()` or `findOneWhereOrFail()` when no matching row exists.
 */
export class SqliteEntityNotFoundException extends Error {
  public readonly tableName: string;

  constructor(tableName: string, detail?: string) {
    super(
      detail
        ? `No record found in table "${tableName}" (${detail}).`
        : `No record found in table "${tableName}".`,
    );
    this.name = "SqliteEntityNotFoundException";
    this.tableName = tableName;
  }
}
