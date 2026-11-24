import type {
  SqlDialect,
  SqlExecuteResult,
  SqlExecutor,
  SqlIsolationLevel,
  SqlTransaction,
  SqlTransactionOptions,
} from "../interfaces/sql-executor.interface";
import { notATransaction } from "../sql/not-a-transaction";

export interface BunSqlExecutorOptions<D extends SqlDialect = SqlDialect> {
  /** Target dialect (`"postgres"` or `"mysql"`). Auto-detected from URL when omitted. */
  dialect?: D;
}

const BUN_SQL_TX_TAG = Symbol.for("bunest:store-kit:bun_sql_tx");

interface TaggedBunSqlTx {
  readonly [BUN_SQL_TX_TAG]: true;
  readonly client: Bun.SQL;
}

function detectDialectFromUrl(urlOrSql: string | Bun.SQL): SqlDialect {
  if (typeof urlOrSql === "string") {
    const lower = urlOrSql.toLowerCase();
    if (lower.startsWith("mysql://") || lower.startsWith("mysql2://") || lower.startsWith("mariadb://")) {
      return "mysql";
    }
    return "postgres";
  }
  const adapter = (urlOrSql as { options?: { adapter?: string } }).options?.adapter;
  return adapter === "mysql" ? "mysql" : "postgres";
}

function isolationSql(level: SqlIsolationLevel): string {
  switch (level) {
    case "read uncommitted":
      return "READ UNCOMMITTED";
    case "read committed":
      return "READ COMMITTED";
    case "repeatable read":
      return "REPEATABLE READ";
    case "serializable":
      return "SERIALIZABLE";
  }
}

function createTxWrapper(txClient: Bun.SQL, native: unknown): SqlTransaction {
  return {
    native,
    async query<R extends object = Record<string, unknown>>(
      text: string,
      params: readonly unknown[] = [],
    ): Promise<R[]> {
      const result = await txClient.unsafe(text, [...params]);
      return Array.isArray(result) ? (result as R[]) : [];
    },
    async execute(
      text: string,
      params: readonly unknown[] = [],
    ): Promise<SqlExecuteResult> {
      const result = (await txClient.unsafe(text, [...params])) as {
        count?: number;
        affectedRows?: number;
        length?: number;
      };
      const affectedRows =
        typeof result?.count === "number"
          ? result.count
          : typeof result?.affectedRows === "number"
            ? result.affectedRows
            : Array.isArray(result)
              ? result.length
              : 0;
      return { affectedRows };
    },
  };
}

/**
 * Creates a first-class Bun-native `SqlExecutor` backed directly by `Bun.SQL`
 * (`new Bun.SQL(url)` or an existing `Bun.SQL` pool), usable across `@bunest/messaging/outbox`,
 * `@bunest/messaging/webhooks`, and `@bunest/workflows` with zero external database drivers.
 */
export function createBunSqlExecutor<D extends SqlDialect = SqlDialect>(
  sqlOrUrl: Bun.SQL | string,
  options: BunSqlExecutorOptions<D> = {},
): SqlExecutor<D> & { readonly sql: Bun.SQL; close(): Promise<void> } {
  const sql = typeof sqlOrUrl === "string" ? new Bun.SQL(sqlOrUrl) : sqlOrUrl;
  const dialect = (options.dialect ?? detectDialectFromUrl(sqlOrUrl)) as D;

  return {
    dialect,
    sql,
    async query<R extends object = Record<string, unknown>>(
      text: string,
      params: readonly unknown[] = [],
    ): Promise<R[]> {
      const result = await sql.unsafe(text, [...params]);
      return Array.isArray(result) ? (result as R[]) : [];
    },
    async execute(
      text: string,
      params: readonly unknown[] = [],
    ): Promise<SqlExecuteResult> {
      const result = (await sql.unsafe(text, [...params])) as {
        count?: number;
        affectedRows?: number;
      };
      const affectedRows =
        typeof result?.count === "number"
          ? result.count
          : typeof result?.affectedRows === "number"
            ? result.affectedRows
            : Array.isArray(result)
              ? result.length
              : 0;
      return { affectedRows };
    },
    async transaction<T>(
      work: (transaction: SqlTransaction) => Promise<T>,
      txOptions?: SqlTransactionOptions,
    ): Promise<T> {
      return await sql.begin(async (tx) => {
        const txSql = tx as unknown as Bun.SQL;
        if (txOptions?.isolationLevel) {
          const iso = isolationSql(txOptions.isolationLevel);
          await txSql.unsafe(`SET TRANSACTION ISOLATION LEVEL ${iso}`);
        }
        const tagged: TaggedBunSqlTx = {
          [BUN_SQL_TX_TAG]: true,
          client: txSql,
        };
        return await work(createTxWrapper(txSql, tagged));
      });
    },
    wrapTransaction(transaction: unknown): SqlTransaction {
      if (
        transaction !== null &&
        typeof transaction === "object" &&
        (transaction as Partial<TaggedBunSqlTx>)[BUN_SQL_TX_TAG] === true
      ) {
        const tagged = transaction as TaggedBunSqlTx;
        return createTxWrapper(tagged.client, transaction);
      }
      if (
        transaction !== null &&
        typeof transaction === "object" &&
        transaction !== sql &&
        typeof (transaction as { unsafe?: unknown }).unsafe === "function" &&
        typeof (transaction as { savepoint?: unknown }).savepoint === "function"
      ) {
        return createTxWrapper(transaction as Bun.SQL, transaction);
      }
      throw notATransaction(
        `createBunSqlExecutor.wrapTransaction(): expected a Bun.SQL transaction handle, got ${typeof transaction}`,
      );
    },
    async close(): Promise<void> {
      await sql.close();
    },
  };
}
