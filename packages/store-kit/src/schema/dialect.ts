import type { SqlDialect } from "../interfaces/sql-executor.interface";

/** How messages name each dialect. */
export const DIALECT_NAMES: Record<SqlDialect, string> = {
  postgres: "PostgreSQL",
  mysql: "MySQL",
};

/** What the shared schema/options code needs of a dialect. */
export interface SchemaDialect<D extends SqlDialect = SqlDialect> {
  readonly dialect: D;
  readonly executors: string;
  readonly executorNames: string;
  checkSchema(schema: string, store: string): void;
}
