import {
  DecoratorRegistry,
  Injectable,
  createMethodAspectDecorator,
  type InjectionToken,
  type MethodAspectContext,
  type MethodAspectHandler,
} from "@bunest/common";
import type {
  SqlTransactionOptions,
  SqlTransactionalOptions,
} from "./interfaces";
import { DrizzleTransactionalAspect } from "./orm/drizzle.module";
import { PrismaTransactionalAspect } from "./orm/prisma.module";
import { SqlService } from "./sql.service";
import {
  DEFAULT_DRIZZLE_CONNECTION,
  DEFAULT_PRISMA_CONNECTION,
  DEFAULT_SQL_CONNECTION,
  getDrizzleTransactionalAspectToken,
  getPrismaTransactionalAspectToken,
  getSqlTransactionalAspectToken,
} from "./tokens";

export { DrizzleTransactionalAspect } from "./orm/drizzle.module";
export { PrismaTransactionalAspect } from "./orm/prisma.module";

/**
 * Core Method Aspect handler powering `@Transactional()` for `SqlService`
 * (`Bun.SQL` — PostgreSQL, MySQL/MariaDB, and SQLite).
 */
@Injectable()
export class SqlTransactionalAspect
  implements MethodAspectHandler<SqlTransactionalOptions | undefined>
{
  constructor(private readonly sql: SqlService) {}

  intercept(
    ctx: MethodAspectContext<SqlTransactionalOptions | undefined>,
  ): unknown {
    const opts = ctx.options;
    const txOptions: SqlTransactionOptions | undefined =
      opts?.options !== undefined || opts?.savepointName !== undefined
        ? {
            ...(opts.options !== undefined ? { options: opts.options } : {}),
            ...(opts.savepointName !== undefined
              ? { savepointName: opts.savepointName }
              : {}),
          }
        : undefined;

    return this.sql.transaction(() => ctx.proceed(), txOptions);
  }
}

/**
 * Declaratively runs a method (or all methods of a class) inside a database
 * `AsyncLocalStorage` transaction (`SqlService`, `DrizzleService`, or `PrismaServiceBase`)
 * with automatic nested `SAVEPOINT` propagation and rollback on thrown errors.
 *
 * Powered by Bunest's Core Method Aspect Weaver (`createMethodAspectDecorator`).
 */
export function Transactional(
  options?: SqlTransactionalOptions,
): ClassDecorator & MethodDecorator {
  const adapter = options?.adapter ?? "sql";
  const connectionName = options?.connectionName ?? DEFAULT_SQL_CONNECTION;

  let aspectToken: InjectionToken;
  if (adapter === "drizzle") {
    aspectToken =
      connectionName === DEFAULT_DRIZZLE_CONNECTION
        ? DrizzleTransactionalAspect
        : getDrizzleTransactionalAspectToken(connectionName);
  } else if (adapter === "prisma") {
    aspectToken =
      connectionName === DEFAULT_PRISMA_CONNECTION
        ? PrismaTransactionalAspect
        : getPrismaTransactionalAspectToken(connectionName);
  } else {
    aspectToken =
      connectionName === DEFAULT_SQL_CONNECTION
        ? SqlTransactionalAspect
        : getSqlTransactionalAspectToken(connectionName);
  }

  return createMethodAspectDecorator(aspectToken, options);
}

/**
 * Disambiguated alias for `@Transactional()` when importing alongside `@bunest/sqlite`.
 */
export const SqlTransactional = Transactional;

DecoratorRegistry.markInternal(SqlTransactionalAspect);
