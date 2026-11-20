import type { SqlExecutor as AnySqlExecutor } from "../../interfaces/sql-executor.interface";

/**
 * How a PostgreSQL store reaches its database through the client the application already has:
 * what `fromPg()`, `fromDrizzle()`, `fromTypeOrm()`, `fromPrisma()`, `fromKysely()`, and `fromBunSql()`
 * from `@bunest/store-kit/postgres` make, and what a PostgreSQL store's options take.
 */
export type SqlExecutor<D extends "postgres" = "postgres"> = AnySqlExecutor<D>;
