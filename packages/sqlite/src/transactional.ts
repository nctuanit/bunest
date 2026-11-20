import {
  DecoratorRegistry,
  Injectable,
  createMethodAspectDecorator,
  type InjectionToken,
  type MethodAspectContext,
  type MethodAspectHandler,
} from "@bunest/common";
import type {
  SqliteTransactionOptions,
  SqliteTransactionalOptions,
} from "./interfaces";
import { SqliteService } from "./sqlite.service";
import {
  DEFAULT_SQLITE_CONNECTION,
  getSqliteTransactionalAspectToken,
} from "./tokens";

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as PromiseLike<unknown>).then === "function"
  );
}

/**
 * Core Method Aspect handler powering `@Transactional()` in `@bunest/sqlite`.
 *
 * Automatically wraps decorated service methods inside `SqliteService.transaction(...)`
 * (or `SqliteService.transactionSync(...)` when `{ sync: true }` is specified),
 * leveraging `AsyncLocalStorage` propagation, nested `SAVEPOINT`s, and automatic
 * rollback on error across `SINGLETON`, `TRANSIENT`, and `REQUEST` scopes.
 */
@Injectable()
export class SqliteTransactionalAspect
  implements MethodAspectHandler<SqliteTransactionalOptions | undefined>
{
  constructor(private readonly sqlite: SqliteService) {}

  intercept(
    ctx: MethodAspectContext<SqliteTransactionalOptions | undefined>,
  ): unknown {
    const opts = ctx.options;
    const txOptions: SqliteTransactionOptions | undefined =
      opts?.mode !== undefined || opts?.savepointName !== undefined
        ? {
            ...(opts.mode !== undefined ? { mode: opts.mode } : {}),
            ...(opts.savepointName !== undefined
              ? { savepointName: opts.savepointName }
              : {}),
          }
        : undefined;

    if (opts?.sync) {
      return this.sqlite.transactionSync(() => {
        const result = ctx.proceed();
        if (isThenable(result)) {
          throw new Error(
            `@Transactional({ sync: true }) on ${ctx.targetClass.name}.${String(ctx.methodName)} cannot wrap an asynchronous method returning a Promise. Remove "sync: true" to run inside async SqliteService.transaction().`,
          );
        }
        return result;
      }, txOptions);
    }

    return this.sqlite.transaction(() => ctx.proceed(), txOptions);
  }
}

/**
 * Declaratively runs a method (or all methods of a class) inside a SQLite
 * `AsyncLocalStorage` transaction (with automatic nested `SAVEPOINT` propagation
 * and rollback on thrown errors).
 *
 * Powered by Bunest's Core Method Aspect Weaver (`createMethodAspectDecorator`).
 */
export function Transactional(
  options?: SqliteTransactionalOptions,
): ClassDecorator & MethodDecorator {
  const connectionName = options?.connectionName ?? DEFAULT_SQLITE_CONNECTION;
  const aspectToken: InjectionToken =
    connectionName === DEFAULT_SQLITE_CONNECTION
      ? SqliteTransactionalAspect
      : getSqliteTransactionalAspectToken(connectionName);
  return createMethodAspectDecorator(aspectToken, options);
}

/**
 * Disambiguated alias for `@Transactional()` when importing alongside `@bunest/sql`.
 */
export const SqliteTransactional = Transactional;

DecoratorRegistry.markInternal(SqliteTransactionalAspect);
