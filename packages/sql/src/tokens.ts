import type { Abstract, Type } from "@bunest/common";

export const DEFAULT_SQL_CONNECTION = "default";
export const DEFAULT_DRIZZLE_CONNECTION = "default";
export const DEFAULT_PRISMA_CONNECTION = "default";

export const SQL_ENTITY_METADATA = Symbol.for("bunest:sql:entity_metadata");
export const SQL_REPOSITORY_METADATA = Symbol.for(
  "bunest:sql:repository_metadata",
);
export const SQL_QUERY_METADATA = Symbol.for("bunest:sql:query_metadata");
export const SQL_MODIFYING_METADATA = Symbol.for(
  "bunest:sql:modifying_metadata",
);
export const SQL_PARAM_METADATA = Symbol.for("bunest:sql:param_metadata");

export function getSqlConnectionToken(
  connectionName: string = DEFAULT_SQL_CONNECTION,
): string {
  return `bunest:sql:connection:${connectionName}`;
}

export function getSqlOptionsToken(
  connectionName: string = DEFAULT_SQL_CONNECTION,
): string {
  return `bunest:sql:options:${connectionName}`;
}

export function getSqlMigrationRunnerToken(
  connectionName: string = DEFAULT_SQL_CONNECTION,
): string {
  return `bunest:sql:migrations:${connectionName}`;
}

export function getSqlTransactionalAspectToken(
  connectionName: string = DEFAULT_SQL_CONNECTION,
): string {
  return `bunest:sql:tx_aspect:${connectionName}`;
}

export function getSqlRepositoryToken(
  target: string | Type<any> | Abstract<any>,
  connectionName: string = DEFAULT_SQL_CONNECTION,
): string {
  const name = typeof target === "string" ? target : target.name;
  return `bunest:sql:repository:${connectionName}:${name}`;
}

export function getDrizzleToken(
  connectionName: string = DEFAULT_DRIZZLE_CONNECTION,
): string {
  return `bunest:drizzle:connection:${connectionName}`;
}

export function getDrizzleServiceToken(
  connectionName: string = DEFAULT_DRIZZLE_CONNECTION,
): string {
  return `bunest:drizzle:service:${connectionName}`;
}

export function getDrizzleOptionsToken(
  connectionName: string = DEFAULT_DRIZZLE_CONNECTION,
): string {
  return `bunest:drizzle:options:${connectionName}`;
}

export function getDrizzleTransactionalAspectToken(
  connectionName: string = DEFAULT_DRIZZLE_CONNECTION,
): string {
  return `bunest:drizzle:tx_aspect:${connectionName}`;
}

export function getPrismaToken(
  connectionName: string = DEFAULT_PRISMA_CONNECTION,
): string {
  return `bunest:prisma:connection:${connectionName}`;
}

export function getPrismaServiceToken(
  connectionName: string = DEFAULT_PRISMA_CONNECTION,
): string {
  return `bunest:prisma:service:${connectionName}`;
}

export function getPrismaOptionsToken(
  connectionName: string = DEFAULT_PRISMA_CONNECTION,
): string {
  return `bunest:prisma:options:${connectionName}`;
}

export function getPrismaTransactionalAspectToken(
  connectionName: string = DEFAULT_PRISMA_CONNECTION,
): string {
  return `bunest:prisma:tx_aspect:${connectionName}`;
}
