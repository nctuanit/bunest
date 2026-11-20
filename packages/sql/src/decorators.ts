import { Inject, type Abstract, type Type } from "@bunest/common";
import {
  DEFAULT_DRIZZLE_CONNECTION,
  DEFAULT_PRISMA_CONNECTION,
  DEFAULT_SQL_CONNECTION,
  getDrizzleServiceToken,
  getDrizzleToken,
  getPrismaServiceToken,
  getPrismaToken,
  getSqlConnectionToken,
  getSqlMigrationRunnerToken,
  getSqlRepositoryToken,
} from "./tokens";

/**
 * Injects a `SqlService` instance for the given connection name (defaults to `"default"`).
 */
export function InjectSql(
  connectionName: string = DEFAULT_SQL_CONNECTION,
): ParameterDecorator & PropertyDecorator {
  return Inject(getSqlConnectionToken(connectionName));
}

/**
 * Injects a `SqlMigrationRunner` instance for the given connection name (defaults to `"default"`).
 */
export function InjectSqlMigrations(
  connectionName: string = DEFAULT_SQL_CONNECTION,
): ParameterDecorator & PropertyDecorator {
  return Inject(getSqlMigrationRunnerToken(connectionName));
}

/**
 * Injects a declarative repository registered via `SqlModule.forFeature(...)`.
 */
export function InjectSqlRepository(
  target: string | Type<any> | Abstract<any>,
  connectionName: string = DEFAULT_SQL_CONNECTION,
): ParameterDecorator & PropertyDecorator {
  return Inject(getSqlRepositoryToken(target, connectionName));
}

/**
 * Injects the configured Drizzle database instance (or ALS transactional proxy) for the given connection name.
 */
export function InjectDrizzle(
  connectionName: string = DEFAULT_DRIZZLE_CONNECTION,
): ParameterDecorator & PropertyDecorator {
  return Inject(getDrizzleToken(connectionName));
}

/**
 * Injects the `DrizzleService` lifecycle & ALS transaction wrapper for the given connection name.
 */
export function InjectDrizzleService(
  connectionName: string = DEFAULT_DRIZZLE_CONNECTION,
): ParameterDecorator & PropertyDecorator {
  return Inject(getDrizzleServiceToken(connectionName));
}

/**
 * Injects the configured Prisma client instance (or ALS transactional proxy) for the given connection name.
 */
export function InjectPrisma(
  connectionName: string = DEFAULT_PRISMA_CONNECTION,
): ParameterDecorator & PropertyDecorator {
  return Inject(getPrismaToken(connectionName));
}

/**
 * Injects the `PrismaServiceBase` lifecycle & ALS transaction wrapper for the given connection name.
 */
export function InjectPrismaService(
  connectionName: string = DEFAULT_PRISMA_CONNECTION,
): ParameterDecorator & PropertyDecorator {
  return Inject(getPrismaServiceToken(connectionName));
}
