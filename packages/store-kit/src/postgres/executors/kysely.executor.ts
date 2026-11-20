import type {
  SqlExecuteResult,
  SqlExecutor,
  SqlIsolationLevel,
  SqlTransaction,
  SqlTransactionOptions,
} from "../../interfaces/sql-executor.interface";
import { notATransaction } from "../../sql/not-a-transaction";
import {
  describeValue,
  hasMethod,
  isolationSql,
} from "../../utils/executor.util";
import { loadOptionalModule } from "../../utils/module.util";
import { runTransactionWork } from "./transaction-work";

/** The part of a Kysely instance (or of a `Transaction`) the executor uses. */
export interface KyselyLike {
  readonly isTransaction: boolean;
  executeQuery(query: any): Promise<{
    rows: any[];
    numAffectedRows?: bigint;
  }>;
  withoutPlugins(): KyselyLike;
  transaction(): {
    setIsolationLevel(level: SqlIsolationLevel): {
      execute<T>(work: (trx: any) => Promise<T>): Promise<T>;
    };
    execute<T>(work: (trx: any) => Promise<T>): Promise<T>;
  };
  getExecutor?(): { adapter?: object };
}

/**
 * A `SqlExecutor` on a Kysely instance with a PostgreSQL dialect.
 */
export function fromKysely(db: KyselyLike): SqlExecutor<"postgres"> {
  if (!isKysely(db) || db.isTransaction) {
    throw new TypeError(
      isKysely(db)
        ? "fromKysely() takes the Kysely instance, not a transaction: pass that to a store method that takes your transaction ({ transaction: trx })."
        : `fromKysely() takes a Kysely instance, got ${describeValue(db)}.`,
    );
  }
  const database = otherDatabase(db);
  if (database) {
    throw new TypeError(
      `fromKysely() takes a Kysely instance with a PostgreSQL dialect, not a ${database} one.`,
    );
  }
  return new KyselyExecutor(db);
}

class KyselyExecutor implements SqlExecutor<"postgres"> {
  readonly dialect = "postgres" as const;
  private readonly raw: KyselyLike;

  constructor(private readonly db: KyselyLike) {
    this.raw = db.withoutPlugins();
  }

  query<R extends object = Record<string, unknown>>(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<R[]> {
    return run<R>(this.raw, text, params);
  }

  execute(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<SqlExecuteResult> {
    return write(this.raw, text, params);
  }

  async transaction<T>(
    work: (transaction: SqlTransaction) => Promise<T>,
    options: SqlTransactionOptions = {},
  ): Promise<T> {
    const builder = this.db.transaction();
    const inTransaction = (trx: KyselyLike) =>
      runTransactionWork(work, kyselyTransaction(trx));
    if (!options.isolationLevel) {
      return builder.execute(inTransaction);
    }
    isolationSql(options.isolationLevel);
    return builder
      .setIsolationLevel(options.isolationLevel)
      .execute(inTransaction);
  }

  wrapTransaction(transaction: unknown): SqlTransaction {
    if (!isKysely(transaction) || !transaction.isTransaction) {
      throw notATransaction(
        isKysely(transaction)
          ? "Pass the trx your db.transaction().execute() callback receives, not the Kysely instance: it runs each statement outside your transaction."
          : `Pass the trx your Kysely db.transaction().execute() callback receives, got ${describeValue(transaction)}.`,
      );
    }
    const database = otherDatabase(transaction);
    if (database) {
      throw notATransaction(
        `Pass the trx of a Kysely instance with a PostgreSQL dialect, not a ${database} one: the store's statements run on PostgreSQL.`,
      );
    }
    return kyselyTransaction(transaction);
  }
}

function kyselyTransaction(trx: KyselyLike): SqlTransaction {
  const raw = trx.withoutPlugins();
  return {
    query: <R extends object = Record<string, unknown>>(
      text: string,
      params: readonly unknown[] = [],
    ) => run<R>(raw, text, params),
    execute: (text: string, params: readonly unknown[] = []) =>
      write(raw, text, params),
    native: trx,
  };
}

interface CompiledQueryFactory {
  raw(sql: string, parameters?: unknown[]): unknown;
}

const FALLBACK_COMPILED_QUERY: CompiledQueryFactory = {
  raw: (sql: string, parameters: unknown[] = []) =>
    Object.freeze({
      query: { kind: "RawNode", sqlFragments: [sql], parameters },
      sql,
      parameters,
    }),
};

let compiledQueryPromise: Promise<CompiledQueryFactory> | undefined;

async function getCompiledQuery(): Promise<CompiledQueryFactory> {
  if (!compiledQueryPromise) {
    compiledQueryPromise = loadOptionalModule<{
      CompiledQuery?: CompiledQueryFactory;
    }>("kysely")
      .then((mod) => mod.CompiledQuery ?? FALLBACK_COMPILED_QUERY)
      .catch(() => FALLBACK_COMPILED_QUERY);
  }
  return compiledQueryPromise;
}

async function send(
  db: KyselyLike,
  text: string,
  params: readonly unknown[],
): Promise<{ rows: any[]; numAffectedRows?: bigint }> {
  const CompiledQuery = await getCompiledQuery();
  return db.executeQuery(CompiledQuery.raw(text, [...params]));
}

async function run<R extends object>(
  db: KyselyLike,
  text: string,
  params: readonly unknown[],
): Promise<R[]> {
  return (await send(db, text, params)).rows as R[];
}

async function write(
  db: KyselyLike,
  text: string,
  params: readonly unknown[],
): Promise<SqlExecuteResult> {
  return {
    affectedRows: Number((await send(db, text, params)).numAffectedRows ?? 0),
  };
}

const OTHER_ADAPTERS = new Map<string, string>([
  ["MysqlAdapter", "MySQL"],
  ["SqliteAdapter", "SQLite"],
  ["MssqlAdapter", "SQL Server"],
]);

function otherDatabase(db: KyselyLike): string | undefined {
  let adapter: object | undefined;
  try {
    adapter = db.getExecutor?.()?.adapter;
  } catch {
    return undefined;
  }
  for (
    let type: unknown = (adapter as { constructor?: unknown } | undefined)
      ?.constructor;
    typeof type === "function";
    type = Object.getPrototypeOf(type)
  ) {
    const database = OTHER_ADAPTERS.get(type.name);
    if (database) {
      return database;
    }
  }
  return undefined;
}

function isKysely(value: unknown): value is KyselyLike {
  return (
    hasMethod(value, "executeQuery") &&
    hasMethod(value, "withoutPlugins") &&
    typeof (value as { isTransaction?: unknown }).isTransaction === "boolean"
  );
}
