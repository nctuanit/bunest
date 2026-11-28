import { isFiniteNumber } from "@bunest/core/common";
import type { SchedulerLockDriver } from "./scheduler-lock";

export type SchedulerLockSqlDialect = "postgres" | "mysql" | "sqlite";

export interface SqlQueryResultLike<T = Record<string, unknown>> {
  readonly rows?: readonly T[];
  readonly affectedRows?: number | null;
  readonly rowCount?: number | null;
  readonly changes?: number | null;
  readonly count?: number | null;
}

/**
 * Structural query runner compatible with `@bunest/orm`, `pg`, `mysql2`,
 * `createBunSqliteSchedulerLockExecutor(db)`, and custom SQL executors.
 */
export interface SqlQueryExecutorLike {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ):
    | Promise<SqlQueryResultLike<T> | readonly T[]>
    | SqlQueryResultLike<T>
    | readonly T[];
  execute?(
    sql: string,
    params?: readonly unknown[],
  ): Promise<SqlQueryResultLike | void> | SqlQueryResultLike | void;
}

/**
 * Structural subset of Bun's native `Bun.SQL` client (`sql.unsafe(query, params)`).
 */
export interface BunSqlClientLike {
  unsafe<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): PromiseLike<
    readonly T[] & {
      readonly count?: number | null;
      readonly affectedRows?: number | null;
    }
  >;
}

/**
 * Structural subset of `bun:sqlite` `Database`.
 */
export interface BunSqliteDatabaseLike {
  query(sql: string): {
    all(...params: any[]): unknown[];
    run(...params: any[]): { changes: number };
  };
  prepare?(sql: string): {
    all(...params: any[]): unknown[];
    run(...params: any[]): { changes: number };
  };
  exec?(sql: string): void;
}

/**
 * Any SQL executor accepted by `SqlSchedulerLockDriver`:
 * native `Bun.SQL`, `bun:sqlite` `Database`, or structural `SqlQueryExecutorLike`.
 */
export type SqlExecutorLike =
  | SqlQueryExecutorLike
  | BunSqlClientLike
  | BunSqliteDatabaseLike;

export interface SqlSchedulerLockMigrationOptions {
  /**
   * Lock table name. Must be a strict ASCII SQL identifier (`/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/`).
   * @default "bunest_scheduler_locks"
   */
  readonly tableName?: string;
}

export interface SqlSchedulerLockDriverOptions
  extends SqlSchedulerLockMigrationOptions {
  /**
   * SQL dialect controlling parameter placeholders and upsert syntax.
   * Automatically defaults to `"sqlite"` when passed a `bun:sqlite` `Database`,
   * otherwise defaults to `"postgres"`.
   */
  readonly dialect?: SchedulerLockSqlDialect;
  /**
   * Optional key prefix prepended to lock keys (`<prefix>:<key>`).
   * Pass `""` to use raw keys with no prefix or leading colon.
   * @default "bunest:cron:lock"
   */
  readonly prefix?: string;
  /**
   * Optional clock provider returning epoch milliseconds (useful for deterministic tests).
   * @default Date.now
   */
  readonly now?: () => number;
  /**
   * When `true`, lazily runs `ensureTable()` once before the first lock operation.
   * @default false
   */
  readonly autoCreateTable?: boolean;
}

const DEFAULT_LOCK_TABLE = "bunest_scheduler_locks";
const SAFE_SQL_IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;
const SUPPORTED_DIALECTS = new Set<SchedulerLockSqlDialect>([
  "postgres",
  "mysql",
  "sqlite",
]);

function validateSqlTableName(tableName: string): string {
  if (typeof tableName !== "string" || !SAFE_SQL_IDENTIFIER_RE.test(tableName)) {
    throw new TypeError(
      `SqlSchedulerLockDriver: tableName must be a valid SQL identifier matching /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/ (got "${String(tableName)}").`,
    );
  }
  return tableName;
}

function validateDialect(dialect: string): SchedulerLockSqlDialect {
  if (!SUPPORTED_DIALECTS.has(dialect as SchedulerLockSqlDialect)) {
    throw new TypeError(
      `SqlSchedulerLockDriver: unsupported SQL dialect "${String(dialect)}". Expected "postgres", "mysql", or "sqlite".`,
    );
  }
  return dialect as SchedulerLockSqlDialect;
}

function isBunSqlClient(executor: unknown): executor is BunSqlClientLike {
  return (
    (typeof executor === "object" || typeof executor === "function") &&
    executor !== null &&
    typeof (executor as BunSqlClientLike).unsafe === "function"
  );
}

function isBunSqliteDatabase(
  executor: unknown,
): executor is BunSqliteDatabaseLike {
  if (typeof executor !== "object" || executor === null) {
    return false;
  }
  const candidate = executor as Partial<BunSqliteDatabaseLike>;
  return (
    typeof candidate.query === "function" &&
    typeof candidate.exec === "function" &&
    (typeof candidate.prepare === "function" || candidate.query.length === 1)
  );
}

/**
 * Adapts a `bun:sqlite` `Database` instance into a `SqlQueryExecutorLike`
 * with zero external dependencies.
 */
export function createBunSqliteSchedulerLockExecutor(
  db: BunSqliteDatabaseLike,
): SqlQueryExecutorLike {
  return {
    query<T = Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = [],
    ): SqlQueryResultLike<T> {
      const trimmed = sql.trimStart().toUpperCase();
      const expectsRows =
        trimmed.startsWith("SELECT") ||
        trimmed.startsWith("PRAGMA") ||
        /\bRETURNING\b/i.test(sql);
      const stmt = db.query(sql);
      if (expectsRows) {
        const rows = stmt.all(...params) as T[];
        return { rows, affectedRows: rows.length };
      }
      const res = stmt.run(...params);
      return { rows: [], affectedRows: res.changes, changes: res.changes };
    },
    execute(
      sql: string,
      params: readonly unknown[] = [],
    ): SqlQueryResultLike {
      if (params.length === 0 && typeof db.exec === "function") {
        const trimmed = sql.trimStart().toUpperCase();
        if (
          trimmed.startsWith("CREATE ") ||
          trimmed.startsWith("DROP ") ||
          trimmed.startsWith("ALTER ")
        ) {
          db.exec(sql);
          return { rows: [], affectedRows: 0 };
        }
      }
      const res = db.query(sql).run(...params);
      return { rows: [], affectedRows: res.changes, changes: res.changes };
    },
  };
}

/**
 * Returns individual DDL migration statements creating the scheduler lock table
 * and expiration index for `"postgres"`, `"mysql"`, or `"sqlite"`.
 */
export function getSchedulerLockMigrationStatements(
  dialect: SchedulerLockSqlDialect = "postgres",
  options: SqlSchedulerLockMigrationOptions = {},
): string[] {
  const validDialect = validateDialect(dialect);
  const table = validateSqlTableName(options.tableName ?? DEFAULT_LOCK_TABLE);
  const idxName = validateSqlTableName(`idx_${table.slice(0, 55)}_exp`);

  if (validDialect === "postgres") {
    return [
      `CREATE TABLE IF NOT EXISTS ${table} (
  lock_key TEXT PRIMARY KEY,
  owner_token TEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);`,
      `CREATE INDEX IF NOT EXISTS ${idxName} ON ${table} (expires_at);`,
    ];
  }

  if (validDialect === "sqlite") {
    return [
      `CREATE TABLE IF NOT EXISTS ${table} (
  lock_key TEXT PRIMARY KEY,
  owner_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);`,
      `CREATE INDEX IF NOT EXISTS ${idxName} ON ${table} (expires_at);`,
    ];
  }

  return [
    `CREATE TABLE IF NOT EXISTS ${table} (
  lock_key VARCHAR(255) PRIMARY KEY,
  owner_token VARCHAR(255) NOT NULL,
  expires_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  INDEX ${idxName} (expires_at)
);`,
  ];
}

/**
 * Returns the full SQL migration script creating the scheduler lock table
 * for `"postgres"`, `"mysql"`, or `"sqlite"`.
 */
export function getSchedulerLockMigrationSql(
  dialect: SchedulerLockSqlDialect = "postgres",
  options: SqlSchedulerLockMigrationOptions = {},
): string {
  return getSchedulerLockMigrationStatements(dialect, options).join("\n\n");
}

interface NormalizedSqlResult<T = Record<string, unknown>> {
  readonly rows: readonly T[];
  readonly affectedRows: number;
}

function firstFiniteNumber(
  ...values: ReadonlyArray<number | null | undefined>
): number | undefined {
  return values.find(isFiniteNumber);
}

function normalizeSqlResult<T = Record<string, unknown>>(
  raw: unknown,
): NormalizedSqlResult<T> {
  if (Array.isArray(raw)) {
    const arr = raw as readonly T[] & {
      count?: number | null;
      affectedRows?: number | null;
    };
    const affected =
      firstFiniteNumber(arr.affectedRows, arr.count, arr.length) ?? arr.length;
    return { rows: arr, affectedRows: affected };
  }
  if (raw && typeof raw === "object") {
    const obj = raw as SqlQueryResultLike<T>;
    const rows = Array.isArray(obj.rows) ? obj.rows : [];
    const affected =
      firstFiniteNumber(
        obj.affectedRows,
        obj.rowCount,
        obj.changes,
        obj.count,
        rows.length,
      ) ?? 0;
    return { rows, affectedRows: affected };
  }
  return { rows: [], affectedRows: 0 };
}

/**
 * Distributed SQL-backed `SchedulerLockDriver` supporting PostgreSQL, MySQL, and
 * SQLite over native `Bun.SQL`, `bun:sqlite`, or any structural `SqlExecutorLike`.
 *
 * Guarantees atomic expiry-reclaiming lock acquisition and owner-token-verified
 * lease renewal and release with strict SQL identifier validation.
 */
export class SqlSchedulerLockDriver implements SchedulerLockDriver {
  public readonly dialect: SchedulerLockSqlDialect;
  public readonly tableName: string;

  private readonly prefix: string;
  private readonly now: () => number;
  private readonly autoCreateTable: boolean;
  private readonly bunSql?: BunSqlClientLike;
  private readonly executor?: SqlQueryExecutorLike;
  private tableEnsured = false;
  private ensureTablePromise?: Promise<void>;

  constructor(
    executor: SqlExecutorLike,
    options: SqlSchedulerLockDriverOptions = {},
  ) {
    this.tableName = validateSqlTableName(
      options.tableName ?? DEFAULT_LOCK_TABLE,
    );
    this.prefix = options.prefix ?? "bunest:cron:lock";
    this.now = options.now ?? Date.now;
    this.autoCreateTable = options.autoCreateTable ?? false;

    if (isBunSqlClient(executor)) {
      this.bunSql = executor;
      this.dialect = validateDialect(options.dialect ?? "postgres");
    } else if (isBunSqliteDatabase(executor)) {
      this.executor = createBunSqliteSchedulerLockExecutor(executor);
      this.dialect = validateDialect(options.dialect ?? "sqlite");
    } else if (
      typeof executor === "object" &&
      executor !== null &&
      typeof (executor as SqlQueryExecutorLike).query === "function"
    ) {
      this.executor = executor as SqlQueryExecutorLike;
      this.dialect = validateDialect(options.dialect ?? "postgres");
    } else {
      throw new TypeError(
        "SqlSchedulerLockDriver requires a Bun.SQL client, bun:sqlite Database, or SqlQueryExecutorLike with query(sql, params).",
      );
    }
  }

  private formatKey(key: string): string {
    return this.prefix.length > 0 ? `${this.prefix}:${key}` : key;
  }

  /**
   * Executes the idempotent DDL migration statements for this driver's dialect
   * and table name.
   */
  async ensureTable(): Promise<void> {
    if (this.tableEnsured) {
      return;
    }
    if (this.ensureTablePromise) {
      return this.ensureTablePromise;
    }

    const statements = getSchedulerLockMigrationStatements(this.dialect, {
      tableName: this.tableName,
    });
    const run = (async () => {
      for (const stmt of statements) {
        await this.execDdl(stmt);
      }
      this.tableEnsured = true;
    })();

    this.ensureTablePromise = run;
    try {
      await run;
    } finally {
      if (this.ensureTablePromise === run) {
        this.ensureTablePromise = undefined;
      }
    }
  }

  async acquire(key: string, ttlMs: number, token: string): Promise<boolean> {
    if (this.autoCreateTable && !this.tableEnsured) {
      await this.ensureTable();
    }

    const fullKey = this.formatKey(key);
    const now = Math.floor(this.now());
    const ttl = Math.max(1, Math.floor(ttlMs));
    const expiresAt = now + ttl;
    const t = this.tableName;

    if (this.dialect === "postgres") {
      const res = await this.runQuery<{ owner_token?: string }>(
        `INSERT INTO ${t} (lock_key, owner_token, expires_at, updated_at)
VALUES ($1, $2, $3, $4)
ON CONFLICT (lock_key) DO UPDATE
SET owner_token = EXCLUDED.owner_token,
    expires_at = EXCLUDED.expires_at,
    updated_at = EXCLUDED.updated_at
WHERE ${t}.expires_at <= $4
RETURNING owner_token`,
        [fullKey, token, expiresAt, now],
      );
      if (res.rows.length === 0) {
        return false;
      }
      const returnedOwner = res.rows[0]?.owner_token;
      return returnedOwner === undefined || returnedOwner === token;
    }

    if (this.dialect === "sqlite") {
      const res = await this.runQuery<{ owner_token?: string }>(
        `INSERT INTO ${t} (lock_key, owner_token, expires_at, updated_at)
VALUES (?, ?, ?, ?)
ON CONFLICT(lock_key) DO UPDATE
SET owner_token = excluded.owner_token,
    expires_at = excluded.expires_at,
    updated_at = excluded.updated_at
WHERE ${t}.expires_at <= excluded.updated_at
RETURNING owner_token`,
        [fullKey, token, expiresAt, now],
      );
      if (res.rows.length === 0) {
        return false;
      }
      const returnedOwner = res.rows[0]?.owner_token;
      return returnedOwner === undefined || returnedOwner === token;
    }

    // MySQL atomic expiry-reclaiming upsert (note: expires_at updated LAST so IF() sees previous value)
    await this.runQuery(
      `INSERT INTO ${t} (lock_key, owner_token, expires_at, updated_at)
VALUES (?, ?, ?, ?)
ON DUPLICATE KEY UPDATE
  owner_token = IF(expires_at <= ?, ?, owner_token),
  updated_at = IF(expires_at <= ?, ?, updated_at),
  expires_at = IF(expires_at <= ?, ?, expires_at)`,
      [fullKey, token, expiresAt, now, now, token, now, now, now, expiresAt],
    );
    const verify = await this.runQuery<{ owner_token?: string }>(
      `SELECT owner_token FROM ${t} WHERE lock_key = ? AND owner_token = ? AND expires_at > ?`,
      [fullKey, token, now],
    );
    return (
      verify.rows.length > 0 &&
      (verify.rows[0]?.owner_token === undefined ||
        verify.rows[0]?.owner_token === token)
    );
  }

  async renew(key: string, ttlMs: number, token: string): Promise<boolean> {
    if (this.autoCreateTable && !this.tableEnsured) {
      await this.ensureTable();
    }

    const fullKey = this.formatKey(key);
    const now = Math.floor(this.now());
    const ttl = Math.max(1, Math.floor(ttlMs));
    const expiresAt = now + ttl;
    const t = this.tableName;

    if (this.dialect === "postgres") {
      const res = await this.runQuery<{ owner_token?: string }>(
        `UPDATE ${t}
SET expires_at = $1, updated_at = $2
WHERE lock_key = $3 AND owner_token = $4 AND expires_at > $2
RETURNING owner_token`,
        [expiresAt, now, fullKey, token],
      );
      return res.rows.length > 0 || res.affectedRows > 0;
    }

    if (this.dialect === "sqlite") {
      const res = await this.runQuery<{ owner_token?: string }>(
        `UPDATE ${t}
SET expires_at = ?, updated_at = ?
WHERE lock_key = ? AND owner_token = ? AND expires_at > ?
RETURNING owner_token`,
        [expiresAt, now, fullKey, token, now],
      );
      return res.rows.length > 0 || res.affectedRows > 0;
    }

    const res = await this.runQuery(
      `UPDATE ${t}
SET expires_at = ?, updated_at = ?
WHERE lock_key = ? AND owner_token = ? AND expires_at > ?`,
      [expiresAt, now, fullKey, token, now],
    );
    return res.affectedRows > 0 || res.rows.length > 0;
  }

  async release(key: string, token: string): Promise<boolean> {
    if (this.autoCreateTable && !this.tableEnsured) {
      await this.ensureTable();
    }

    const fullKey = this.formatKey(key);
    const now = Math.floor(this.now());
    const t = this.tableName;

    if (this.dialect === "postgres") {
      const res = await this.runQuery<{ owner_token?: string }>(
        `DELETE FROM ${t}
WHERE lock_key = $1 AND owner_token = $2 AND expires_at > $3
RETURNING owner_token`,
        [fullKey, token, now],
      );
      return res.rows.length > 0 || res.affectedRows > 0;
    }

    if (this.dialect === "sqlite") {
      const res = await this.runQuery<{ owner_token?: string }>(
        `DELETE FROM ${t}
WHERE lock_key = ? AND owner_token = ? AND expires_at > ?
RETURNING owner_token`,
        [fullKey, token, now],
      );
      return res.rows.length > 0 || res.affectedRows > 0;
    }

    const res = await this.runQuery(
      `DELETE FROM ${t}
WHERE lock_key = ? AND owner_token = ? AND expires_at > ?`,
      [fullKey, token, now],
    );
    return res.affectedRows > 0 || res.rows.length > 0;
  }

  /**
   * Optional maintenance helper deleting expired lock rows (`expires_at <= now`).
   */
  async pruneExpired(): Promise<number> {
    if (this.autoCreateTable && !this.tableEnsured) {
      await this.ensureTable();
    }

    const now = Math.floor(this.now());
    const t = this.tableName;
    if (this.dialect === "postgres") {
      const res = await this.runQuery(
        `DELETE FROM ${t} WHERE expires_at <= $1`,
        [now],
      );
      return res.affectedRows;
    }
    const res = await this.runQuery(
      `DELETE FROM ${t} WHERE expires_at <= ?`,
      [now],
    );
    return res.affectedRows;
  }

  private async runQuery<T = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<NormalizedSqlResult<T>> {
    if (this.bunSql) {
      const raw = await this.bunSql.unsafe<T>(sql, [...params]);
      return normalizeSqlResult<T>(raw);
    }
    const raw = await this.executor!.query<T>(sql, params);
    return normalizeSqlResult<T>(raw);
  }

  private async execDdl(sql: string): Promise<void> {
    if (this.bunSql) {
      await this.bunSql.unsafe(sql);
      return;
    }
    if (typeof this.executor!.execute === "function") {
      await this.executor!.execute(sql, []);
      return;
    }
    await this.executor!.query(sql, []);
  }
}
