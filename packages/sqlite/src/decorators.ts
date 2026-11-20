import { Inject, MetadataRegistry, type Abstract, type Type } from "@bunest/common";
import { assertSafeSqlIdentifier } from "./identifiers";
import type { SqliteEntityMetadata } from "./interfaces";
import {
  DEFAULT_SQLITE_CONNECTION,
  SQLITE_ENTITY_METADATA,
  getSqliteConnectionToken,
  getSqliteMigrationRunnerToken,
  getSqliteRepositoryToken,
} from "./tokens";

/**
 * Injects a `SqliteService` instance for the specified connection name (defaults to `"default"`).
 */
export function InjectSqlite(
  connectionName: string = DEFAULT_SQLITE_CONNECTION,
): ParameterDecorator & PropertyDecorator {
  return Inject(getSqliteConnectionToken(connectionName));
}

/**
 * Injects a `SqliteMigrationRunner` instance for the specified connection name (defaults to `"default"`).
 */
export function InjectSqliteMigrations(
  connectionName: string = DEFAULT_SQLITE_CONNECTION,
): ParameterDecorator & PropertyDecorator {
  return Inject(getSqliteMigrationRunnerToken(connectionName));
}

/**
 * Injects a repository registered via `SqliteModule.forFeature(...)` for the given
 * table name, entity class, or repository class.
 */
export function InjectSqliteRepository(
  target: string | Type<any> | Abstract<any>,
  connectionName: string = DEFAULT_SQLITE_CONNECTION,
): ParameterDecorator & PropertyDecorator {
  return Inject(getSqliteRepositoryToken(target, connectionName));
}

/**
 * Associates an entity class with a SQLite table name (and optional primary key column)
 * for ergonomic registration via `SqliteModule.forFeature([MyEntity])`.
 */
export function SqliteEntity(
  tableName: string,
  idColumn: string = "id",
): ClassDecorator {
  assertSafeSqlIdentifier(tableName, "table name");
  assertSafeSqlIdentifier(idColumn, "id column name");
  const metadata: SqliteEntityMetadata = { tableName, idColumn };
  return (target) => {
    MetadataRegistry.define(SQLITE_ENTITY_METADATA, metadata, target);
  };
}
