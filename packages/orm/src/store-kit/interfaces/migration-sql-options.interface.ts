/**
 * Which migrations `StoreSchema.statements()` returns: those that bring `schema` from version `from` to `to`.
 */
export interface MigrationStatementsOptions {
  /**
   * The store's schema: on PostgreSQL the schema its tables live in, on MySQL the start of its tables' names
   * (`<schema>_<table>`). Default: the store's (`defaultSchema`).
   */
  schema?: string;
  /** The version to start from: `0` (the default) is a new database. */
  from?: number;
  /** The version to end at. Default: the latest. */
  to?: number;
}

/**
 * What `StoreSchema.sql()` takes, and a store's `static migrationSql()` with it.
 */
export interface MigrationSqlOptions extends MigrationStatementsOptions {
  /**
   * Put drizzle-kit's `--> statement-breakpoint` between the statements, for a custom drizzle-kit migration
   * (`drizzle-kit generate --custom`). Default: `false`.
   */
  statementBreakpoints?: boolean;
}
