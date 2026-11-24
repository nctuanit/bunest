import type { SqlExecutor as AnySqlExecutor } from "../../interfaces/sql-executor.interface";

/**
 * How a PostgreSQL store reaches its database through the client the application already has:
 * what `fromBunSql()`, `fromPg()`, `fromDrizzle()`, `fromTypeOrm()`, `fromPrisma()`, and `fromKysely()`
 * from `@bunest/orm/postgres` make, and what a PostgreSQL store's options take.
 */
export type SqlExecutor<D extends "postgres" = "postgres"> = AnySqlExecutor<D>;
