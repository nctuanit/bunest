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

/** Drizzle marks its classes with this: `is()` compares these names up the class chain, across copies of the package. */
const ENTITY_KIND = Symbol.for("drizzle:entityKind");

/** The part of a Drizzle PostgreSQL database (or its `tx`) the executor uses. */
export interface DrizzleDatabaseLike {
  execute(query: any): PromiseLike<unknown>;
  transaction<T>(
    work: (tx: any) => Promise<T>,
    config?: {
      isolationLevel?: SqlIsolationLevel;
    },
  ): Promise<T>;
}

/**
 * A `SqlExecutor` on a Drizzle PostgreSQL database, whatever its driver (`drizzle-orm/node-postgres`, `/pglite`,
 * `/postgres-js`...). The transaction object is the `tx` that `db.transaction()` hands its callback.
 */
export function fromDrizzle(
  db: DrizzleDatabaseLike,
): SqlExecutor<"postgres"> {
  if (!isDatabase(db) || isTransaction(db) || !hasMethod(db, "execute")) {
    throw new TypeError(
      isTransaction(db)
        ? "fromDrizzle() takes the database drizzle() returns, not a transaction: pass the tx to a store method that takes your transaction ({ transaction: tx })."
        : `fromDrizzle() takes a Drizzle PostgreSQL database (drizzle() of drizzle-orm/node-postgres, /pglite...), got ${describeValue(db)}.`,
    );
  }
  return new DrizzleExecutor(db);
}

class DrizzleExecutor implements SqlExecutor<"postgres"> {
  readonly dialect = "postgres" as const;

  constructor(private readonly db: DrizzleDatabaseLike) {}

  query<R extends object = Record<string, unknown>>(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<R[]> {
    return run<R>(this.db, text, params);
  }

  execute(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<SqlExecuteResult> {
    return write(this.db, text, params);
  }

  async transaction<T>(
    work: (transaction: SqlTransaction) => Promise<T>,
    options: SqlTransactionOptions = {},
  ): Promise<T> {
    const config = options.isolationLevel
      ? { isolationLevel: options.isolationLevel }
      : undefined;
    if (config) {
      isolationSql(config.isolationLevel);
    }
    return this.db.transaction(
      (tx: DrizzleDatabaseLike) =>
        runTransactionWork(work, drizzleTransaction(tx)),
      config,
    );
  }

  wrapTransaction(transaction: unknown): SqlTransaction {
    if (!isTransaction(transaction)) {
      throw notATransaction(
        isDatabase(transaction)
          ? "Pass the tx your db.transaction() callback receives, not the database: a statement on the database runs outside your transaction."
          : `Pass the tx your Drizzle db.transaction() callback receives, got ${describeValue(transaction)}.`,
      );
    }
    return drizzleTransaction(transaction as DrizzleDatabaseLike);
  }
}

function drizzleTransaction(tx: DrizzleDatabaseLike): SqlTransaction {
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

interface DrizzleSqlBuilder {
  raw(text: string): unknown;
  param(value: unknown): unknown;
  join(chunks: unknown[]): unknown;
}

const FALLBACK_SQL: DrizzleSqlBuilder = {
  raw: (text: string) => ({ value: [text] }),
  param: (value: unknown) => ({ value }),
  join: (chunks: unknown[]) => ({ queryChunks: chunks }),
};

let drizzleSqlPromise: Promise<DrizzleSqlBuilder> | undefined;

async function getDrizzleSql(): Promise<DrizzleSqlBuilder> {
  if (!drizzleSqlPromise) {
    drizzleSqlPromise = loadOptionalModule<{ sql?: DrizzleSqlBuilder }>(
      "drizzle-orm",
    )
      .then((mod) => mod.sql ?? FALLBACK_SQL)
      .catch(() => FALLBACK_SQL);
  }
  return drizzleSqlPromise;
}

async function send(
  db: DrizzleDatabaseLike,
  text: string,
  params: readonly unknown[],
): Promise<unknown> {
  const sql = await getDrizzleSql();
  const chunks: unknown[] = [];
  let last = 0;
  for (const match of text.matchAll(/\$(\d+)/g)) {
    const index = match.index ?? 0;
    chunks.push(
      sql.raw(text.slice(last, index)),
      sql.param(params[Number(match[1]) - 1]),
    );
    last = index + match[0].length;
  }
  chunks.push(sql.raw(text.slice(last)));
  return db.execute(sql.join(chunks));
}

async function run<R extends object>(
  db: DrizzleDatabaseLike,
  text: string,
  params: readonly unknown[],
): Promise<R[]> {
  const result = await send(db, text, params);
  return (
    Array.isArray(result) ? result : (result as { rows: R[] }).rows
  ) as R[];
}

async function write(
  db: DrizzleDatabaseLike,
  text: string,
  params: readonly unknown[],
): Promise<SqlExecuteResult> {
  const result = (await send(db, text, params)) as {
    rowCount?: number | null;
    affectedRows?: number | null;
    count?: number | null;
  };
  return {
    affectedRows: result.rowCount ?? result.affectedRows ?? result.count ?? 0,
  };
}

function isDatabase(value: unknown): boolean {
  return entityKinds(value).some((kind) => /^Pg\w*Database$/.test(kind));
}

function isTransaction(value: unknown): boolean {
  return entityKinds(value).some((kind) => /^Pg\w*Transaction$/.test(kind));
}

function entityKinds(value: unknown): string[] {
  const kinds: string[] = [];
  if (typeof value !== "object" || value === null) {
    return kinds;
  }
  for (
    let type: unknown = (value as { constructor?: unknown }).constructor;
    typeof type === "function";
    type = Object.getPrototypeOf(type)
  ) {
    const kind = (type as unknown as Record<symbol, unknown>)[ENTITY_KIND];
    if (typeof kind === "string") {
      kinds.push(kind);
    }
  }
  return kinds;
}
