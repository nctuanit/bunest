import type {
  SqlExecuteResult,
  SqlIsolationLevel,
  SqlTransactionOptions,
} from "../../interfaces/sql-executor.interface";
import { notATransaction } from "../../sql/not-a-transaction";
import {
  describeValue,
  hasMethod,
  isMysql2Client,
  isolationSql,
} from "../../utils/executor.util";
import { loadOptionalModule } from "../../utils/module.util";
import type {
  SqlExecutor,
  SqlTransaction,
} from "../interfaces/mysql-executor.interface";
import {
  assertFoundRows,
  checkPlaceholders,
  mysql2Flags,
} from "./mysql-client.util";

const ENTITY_KIND = Symbol.for("drizzle:entityKind");

/** The part of a Drizzle MySQL database (or its `tx`) the executor uses. */
export interface DrizzleMySqlDatabaseLike {
  execute(query: any): PromiseLike<unknown>;
  transaction<T>(
    work: (tx: any) => Promise<T>,
    config?: {
      isolationLevel?: SqlIsolationLevel;
    },
  ): Promise<T>;
  $client?: unknown;
}

/**
 * A `SqlExecutor` on a Drizzle MySQL database (`drizzle-orm/mysql2`).
 */
export function fromDrizzle(db: DrizzleMySqlDatabaseLike): SqlExecutor {
  if (!isDatabase(db) || isTransaction(db) || !hasMethod(db, "execute")) {
    const other = otherDatabase(db);
    let message: string;
    if (isTransaction(db)) {
      message =
        "fromDrizzle() takes the database drizzle() returns, not a transaction: pass the tx to a store method that takes your transaction ({ transaction: tx }).";
    } else if (other) {
      const hint =
        other === "PostgreSQL"
          ? ": a PostgreSQL store takes that, through fromDrizzle() from its package's /postgres subpath."
          : ".";
      message = `fromDrizzle() takes a Drizzle MySQL database (drizzle() of drizzle-orm/mysql2), not a ${other} one${hint}`;
    } else {
      message = `fromDrizzle() takes a Drizzle MySQL database (drizzle() of drizzle-orm/mysql2), got ${describeValue(db)}.`;
    }
    throw new TypeError(message);
  }
  const client = db.$client;
  if (isMysql2Client(client)) {
    assertFoundRows(mysql2Flags(client), "fromDrizzle()");
  }
  return new DrizzleExecutor(db);
}

class DrizzleExecutor implements SqlExecutor {
  readonly dialect = "mysql" as const;

  constructor(private readonly db: DrizzleMySqlDatabaseLike) {}

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
      (tx: DrizzleMySqlDatabaseLike) => work(drizzleTransaction(tx)),
      config,
    );
  }

  wrapTransaction(transaction: unknown): SqlTransaction {
    if (!isTransaction(transaction)) {
      const other = otherDatabase(transaction);
      let message: string;
      if (isDatabase(transaction)) {
        message =
          "Pass the tx your db.transaction() callback receives, not the database: a statement on the database runs outside your transaction.";
      } else if (other) {
        message = `Pass the tx of a Drizzle MySQL database, not of a ${other} one: the store's statements run on MySQL.`;
      } else {
        message = `Pass the tx your Drizzle db.transaction() callback receives, got ${describeValue(transaction)}.`;
      }
      throw notATransaction(message);
    }
    return drizzleTransaction(transaction as DrizzleMySqlDatabaseLike);
  }
}

function drizzleTransaction(tx: DrizzleMySqlDatabaseLike): SqlTransaction {
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
  db: DrizzleMySqlDatabaseLike,
  text: string,
  params: readonly unknown[],
): Promise<unknown> {
  checkPlaceholders(text, params);
  const sql = await getDrizzleSql();
  const pieces = text.split("?");
  const chunks: unknown[] = [];
  chunks.push(sql.raw(pieces[0]!));
  for (const [i, piece] of pieces.slice(1).entries()) {
    chunks.push(sql.param(params[i]), sql.raw(piece));
  }
  const [result] = (await db.execute(sql.join(chunks))) as [unknown];
  return result;
}

async function run<R extends object>(
  db: DrizzleMySqlDatabaseLike,
  text: string,
  params: readonly unknown[],
): Promise<R[]> {
  const result = await send(db, text, params);
  return (Array.isArray(result) ? result : []) as R[];
}

async function write(
  db: DrizzleMySqlDatabaseLike,
  text: string,
  params: readonly unknown[],
): Promise<SqlExecuteResult> {
  const result = await send(db, text, params);
  return {
    affectedRows: Array.isArray(result)
      ? 0
      : Number(
          (result as { affectedRows?: unknown } | undefined)?.affectedRows ?? 0,
        ),
  };
}

function isDatabase(value: unknown): boolean {
  return entityKinds(value).some((kind) => /^MySql\w*Database$/.test(kind));
}

function isTransaction(value: unknown): boolean {
  return entityKinds(value).some((kind) => /^MySql\w*Transaction$/.test(kind));
}

function otherDatabase(value: unknown): string | undefined {
  const kinds = entityKinds(value);
  if (kinds.some((kind) => /^Pg\w*(Database|Transaction)$/.test(kind))) {
    return "PostgreSQL";
  }
  if (kinds.some((kind) => /SQLite\w*(Database|Transaction)$/.test(kind))) {
    return "SQLite";
  }
  return undefined;
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
