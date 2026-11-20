import type { Abstract, Type } from "@bunest/common";

export const DEFAULT_SQLITE_CONNECTION = "default";

export const SQLITE_ENTITY_METADATA = Symbol.for(
  "bunest:sqlite:entity_metadata",
);

export const SQLITE_REPOSITORY_METADATA = Symbol.for(
  "bunest:sqlite:repository_metadata",
);

export const SQLITE_QUERY_METADATA = Symbol.for(
  "bunest:sqlite:query_metadata",
);

export const SQLITE_MODIFYING_METADATA = Symbol.for(
  "bunest:sqlite:modifying_metadata",
);

export const SQLITE_PARAM_METADATA = Symbol.for(
  "bunest:sqlite:param_metadata",
);

export function getSqliteConnectionToken(
  connectionName: string = DEFAULT_SQLITE_CONNECTION,
): string {
  return `bunest:sqlite:connection:${connectionName}`;
}

export function getSqliteOptionsToken(
  connectionName: string = DEFAULT_SQLITE_CONNECTION,
): string {
  return `bunest:sqlite:options:${connectionName}`;
}

export function getSqliteMigrationRunnerToken(
  connectionName: string = DEFAULT_SQLITE_CONNECTION,
): string {
  return `bunest:sqlite:migrations:${connectionName}`;
}

export function getSqliteTransactionalAspectToken(
  connectionName: string = DEFAULT_SQLITE_CONNECTION,
): string {
  return `bunest:sqlite:tx_aspect:${connectionName}`;
}

export function getSqliteRepositoryToken(
  target: string | Type<any> | Abstract<any>,
  connectionName: string = DEFAULT_SQLITE_CONNECTION,
): string {
  const name = typeof target === "string" ? target : target.name;
  return `bunest:sqlite:repository:${connectionName}:${name}`;
}
