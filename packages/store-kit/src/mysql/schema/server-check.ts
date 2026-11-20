import type { SqlTransaction } from "../../interfaces/sql-executor.interface";
import type { MySqlServer } from "../interfaces/mysql-store.interface";
import { mysqlErrorCode } from "../sql/errors";

/** The oldest MySQL a store starts on. */
const OLDEST = [8, 0, 19] as const;

/** ER_UNKNOWN_COLLATION: MariaDB before 11.4.5 has no `utf8mb4_0900_bin`. */
const UNKNOWN_COLLATION = 1273;

/**
 * Checks the server and connection a MySQL store runs on before anything else it does.
 */
export async function checkServer(
  db: SqlTransaction,
  storeName: string,
  options: { mariadb?: boolean } = {},
): Promise<{ database: string; server: MySqlServer }> {
  const [found] = await db.query<{ version: unknown }>(
    "SELECT VERSION() AS version",
  );
  const version = String(found?.version ?? "");
  const server: MySqlServer = /mariadb/i.test(version) ? "mariadb" : "mysql";
  if (server === "mariadb") {
    if (!options.mariadb) {
      throw new Error(
        `${storeName} runs on MySQL, and this server is MariaDB (${version}): MariaDB isn't supported yet.`,
      );
    }
    const problem = await collationProblem(db);
    if (problem) {
      throw new Error(
        `${storeName} runs on MySQL 8.4 LTS and 9.x, and on MariaDB 11.4.7 and later or 11.8.2 and later, where utf8mb4_0900_bin compares without padding, and this server (${version}) ${problem}.`,
      );
    }
  } else {
    const parsed = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(version);
    if (!parsed) {
      const servers = options.mariadb ? "MySQL or MariaDB" : "MySQL";
      throw new Error(
        `${storeName} runs on ${servers}, and this server is ${version.split(" ").slice(0, 2).join(" ") || "unknown"}.`,
      );
    }
    const major = Number(parsed[1]);
    const minor = Number(parsed[2]);
    const patch = parsed[3] === undefined ? undefined : Number(parsed[3]);
    if (
      major < OLDEST[0] ||
      (major === OLDEST[0] &&
        minor === OLDEST[1] &&
        patch !== undefined &&
        patch < OLDEST[2])
    ) {
      throw new Error(
        `${storeName} runs on MySQL 8.4 LTS and 9.x (8.0.19 and later may work), and this server is MySQL ${version}.`,
      );
    }
  }

  const [settings] = await db.query<{
    sql_mode: unknown;
    current_database: unknown;
  }>(
    "SELECT @@session.sql_mode AS sql_mode, DATABASE() AS current_database",
  );
  const mode = String(settings?.sql_mode ?? "");
  if (!/(^|,)STRICT_(TRANS|ALL)_TABLES(,|$)/.test(mode)) {
    throw new Error(
      `${storeName} needs a strict sql_mode (STRICT_TRANS_TABLES, MySQL's default), and this connection's is "${mode}": without it, MySQL cuts a value too long for its column, ` +
        "and writes a default for a missing one, with only a warning. Set it back for the server, or for the store's connections (a pool of their own).",
    );
  }
  const database = settings?.current_database;
  if (typeof database !== "string" || database.length === 0) {
    throw new Error(
      `${storeName} keeps its tables in the connection's database, and this connection has none: name one in the pool's or the ORM's settings (its database, or the URL's path).`,
    );
  }
  return { database, server };
}

async function collationProblem(
  db: SqlTransaction,
): Promise<string | undefined> {
  try {
    const [row] = await db.query<{ padded: unknown }>(
      "SELECT CAST(_utf8mb4'abc' = _utf8mb4'abc ' COLLATE utf8mb4_0900_bin AS CHAR) AS padded",
    );
    return String(row?.padded) === "0"
      ? undefined
      : 'pads it, so abc and "abc " would be the same key';
  } catch (error) {
    if (mysqlErrorCode(error) === UNKNOWN_COLLATION) {
      return "doesn't have it";
    }
    throw error;
  }
}
