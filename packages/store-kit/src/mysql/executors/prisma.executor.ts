import type {
  SqlExecuteResult,
  SqlTransactionOptions,
} from "../../interfaces/sql-executor.interface";
import type { PrismaExecutorOptions } from "../../postgres/executors/prisma.executor";
import { notATransaction } from "../../sql/not-a-transaction";
import { parseDuration } from "../../utils/duration.util";
import {
  describeValue,
  hasMethod,
  isolationSql,
  type UpperSqlIsolationLevel,
} from "../../utils/executor.util";
import type {
  SqlExecutor,
  SqlTransaction,
} from "../interfaces/mysql-executor.interface";
import { checkPlaceholders } from "./mysql-client.util";

/** The part of a Prisma client (or of the transaction client `$transaction()` hands its callback) the executor uses. */
export interface PrismaMySqlClientLike {
  $queryRawUnsafe(query: string, ...values: any[]): PromiseLike<unknown>;
  $executeRawUnsafe(query: string, ...values: any[]): PromiseLike<number>;
}

/** The part of a Prisma client the executor uses. */
export interface PrismaMySqlRootClientLike extends PrismaMySqlClientLike {
  $connect(): Promise<void>;
  $transaction<T>(
    work: (tx: any) => Promise<T>,
    options?: {
      isolationLevel?: any;
      maxWait?: number;
      timeout?: number;
    },
  ): Promise<T>;
}

const PRISMA_ISOLATION: Record<UpperSqlIsolationLevel, string> = {
  "READ UNCOMMITTED": "ReadUncommitted",
  "READ COMMITTED": "ReadCommitted",
  "REPEATABLE READ": "RepeatableRead",
  SERIALIZABLE: "Serializable",
};

/**
 * A `SqlExecutor` on a Prisma client for MySQL (`$queryRawUnsafe()`, `$executeRawUnsafe()` and interactive transactions).
 */
export function fromPrisma(
  prisma: PrismaMySqlRootClientLike,
  options: PrismaExecutorOptions = {},
): SqlExecutor {
  if (
    !hasMethod(prisma, "$queryRawUnsafe") ||
    !hasMethod(prisma, "$transaction") ||
    !hasMethod(prisma, "$connect")
  ) {
    throw new TypeError(
      hasMethod(prisma, "$queryRawUnsafe")
        ? "fromPrisma() takes the Prisma client, not a transaction client: pass that to a store method that takes your transaction ({ transaction: tx })."
        : `fromPrisma() takes a Prisma client, got ${describeValue(prisma)}.`,
    );
  }
  return new PrismaExecutor(prisma, {
    maxWait: parseDuration(options.maxWait ?? "10s"),
    timeout: parseDuration(options.timeout ?? "1m"),
  });
}

class PrismaExecutor implements SqlExecutor {
  readonly dialect = "mysql" as const;

  constructor(
    private readonly prisma: PrismaMySqlRootClientLike,
    private readonly limits: { maxWait: number; timeout: number },
  ) {}

  query<R extends object = Record<string, unknown>>(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<R[]> {
    return run<R>(this.prisma, text, params);
  }

  execute(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<SqlExecuteResult> {
    return write(this.prisma, text, params);
  }

  async transaction<T>(
    work: (transaction: SqlTransaction) => Promise<T>,
    options: SqlTransactionOptions = {},
  ): Promise<T> {
    return this.prisma.$transaction(
      (tx: PrismaMySqlClientLike) => work(prismaTransaction(tx)),
      {
        ...this.limits,
        ...(options.isolationLevel
          ? { isolationLevel: PRISMA_ISOLATION[isolationSql(options.isolationLevel)] }
          : {}),
      },
    );
  }

  wrapTransaction(transaction: unknown): SqlTransaction {
    if (
      !hasMethod(transaction, "$queryRawUnsafe") ||
      hasMethod(transaction, "$connect")
    ) {
      throw notATransaction(
        hasMethod(transaction, "$connect")
          ? "Pass the tx your prisma.$transaction(async (tx) => ...) callback receives, not the client: it runs each statement outside your transaction."
          : `Pass the tx your Prisma $transaction(async (tx) => ...) callback receives, got ${describeValue(transaction)}.`,
      );
    }
    return prismaTransaction(transaction as PrismaMySqlClientLike);
  }
}

function prismaTransaction(tx: PrismaMySqlClientLike): SqlTransaction {
  return {
    query: <R extends object = Record<string, unknown>>(
      text: string,
      params: readonly unknown[] = [],
    ) => run<R>(tx, text, params),
    execute: (text: string, params: readonly unknown[] = []) =>
      write(tx, text, params),
    native: tx,
  };
}

async function run<R extends object>(
  prisma: PrismaMySqlClientLike,
  text: string,
  params: readonly unknown[],
): Promise<R[]> {
  checkPlaceholders(text, params);
  return ((await prisma.$queryRawUnsafe(text, ...params)) ?? []) as R[];
}

async function write(
  prisma: PrismaMySqlClientLike,
  text: string,
  params: readonly unknown[],
): Promise<SqlExecuteResult> {
  checkPlaceholders(text, params);
  return {
    affectedRows: Number(await prisma.$executeRawUnsafe(text, ...params)),
  };
}
