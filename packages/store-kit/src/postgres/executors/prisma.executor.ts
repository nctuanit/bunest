import type {
  SqlExecuteResult,
  SqlExecutor,
  SqlTransaction,
  SqlTransactionOptions,
} from "../../interfaces/sql-executor.interface";
import { notATransaction } from "../../sql/not-a-transaction";
import { type Duration, parseDuration } from "../../utils/duration.util";
import {
  describeValue,
  hasMethod,
  isolationSql,
  type UpperSqlIsolationLevel,
} from "../../utils/executor.util";
import { runTransactionWork } from "./transaction-work";

/** The part of a Prisma client (or of the transaction client `$transaction()` hands its callback) the executor uses. */
export interface PrismaClientLike {
  $queryRawUnsafe(query: string, ...values: any[]): PromiseLike<unknown>;
  $executeRawUnsafe(query: string, ...values: any[]): PromiseLike<number>;
}

/** The part of a Prisma client the executor uses. */
export interface PrismaRootClientLike extends PrismaClientLike {
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

/**
 * What `fromPrisma()` takes besides the client: limits of the interactive transactions the store runs itself.
 */
export interface PrismaExecutorOptions {
  /** How long a transaction of the store's may wait to start (for a connection). Default: `'10s'`. */
  maxWait?: Duration;
  /** How long a transaction of the store's may run before Prisma rolls it back. Default: `'1m'`. */
  timeout?: Duration;
}

const PRISMA_ISOLATION: Record<UpperSqlIsolationLevel, string> = {
  "READ UNCOMMITTED": "ReadUncommitted",
  "READ COMMITTED": "ReadCommitted",
  "REPEATABLE READ": "RepeatableRead",
  SERIALIZABLE: "Serializable",
};

/**
 * A `SqlExecutor` on a Prisma client for PostgreSQL (`$queryRawUnsafe()` and interactive transactions).
 */
export function fromPrisma(
  prisma: PrismaRootClientLike,
  options: PrismaExecutorOptions = {},
): SqlExecutor<"postgres"> {
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

class PrismaExecutor implements SqlExecutor<"postgres"> {
  readonly dialect = "postgres" as const;

  constructor(
    private readonly prisma: PrismaRootClientLike,
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
      (tx: PrismaClientLike) =>
        runTransactionWork(work, prismaTransaction(tx)),
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
    return prismaTransaction(transaction as PrismaClientLike);
  }
}

function prismaTransaction(tx: PrismaClientLike): SqlTransaction {
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
  prisma: PrismaClientLike,
  text: string,
  params: readonly unknown[],
): Promise<R[]> {
  return ((await prisma.$queryRawUnsafe(text, ...params)) ?? []) as R[];
}

async function write(
  prisma: PrismaClientLike,
  text: string,
  params: readonly unknown[],
): Promise<SqlExecuteResult> {
  return {
    affectedRows: Number(await prisma.$executeRawUnsafe(text, ...params)),
  };
}
