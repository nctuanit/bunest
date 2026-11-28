import { isNumber, sha256 } from "@bunest/core/common";
import type {
  LockAcquireResult,
  LockStore,
} from "../interfaces/lock-store.interface";
import type { LocksStorageRegisterOptions } from "../interfaces/locks-storage-register-options.interface";
import type { LocksStorage } from "../storage/locks.storage";

export type SqlLockDialect = "postgres" | "mysql" | "sqlite";

export interface SqlLockQueryResult<T = Record<string, unknown>> {
  rows?: readonly T[];
  affectedRows?: number | null;
  rowCount?: number | null;
  changes?: number | null;
  count?: number | null;
}

/**
 * Structural SQL query executor compatible with `@bunest/orm`, `pg`, `mysql2`,
 * `createBunSqliteLockExecutor(db)`, and custom executors.
 */
export interface SqlLockQueryExecutor {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ):
    | Promise<SqlLockQueryResult<T> | readonly T[]>
    | SqlLockQueryResult<T>
    | readonly T[];
  execute?(
    sql: string,
    params?: readonly unknown[],
  ): Promise<SqlLockQueryResult | void> | SqlLockQueryResult | void;
}

/**
 * Structural subset of Bun's native `Bun.SQL` client (`sql.unsafe(query, params)`).
 */
export interface BunSqlLockClientLike {
  unsafe<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): PromiseLike<
    readonly T[] & {
      count?: number | null;
      affectedRows?: number | null;
    }
  >;
}

/**
 * Structural subset of `bun:sqlite` `Database` accepted directly by `SqlLockStore`
 * and `createBunSqliteLockExecutor`.
 */
export interface BunSqliteLockDatabaseLike {
  prepare(sql: string): {
    all(...params: any[]): unknown[];
    run(...params: any[]): { changes: number };
    finalize?(): void;
  };
  exec(sql: string): void;
}

/**
 * Any SQL executor accepted by `SqlLockStore`: native `Bun.SQL`, `bun:sqlite` `Database`,
 * `createBunSqliteLockExecutor(db)`, `@bunest/orm` executors, or `pg`/`mysql2` pools.
 */
export type SqlLockExecutorLike =
  | SqlLockQueryExecutor
  | BunSqlLockClientLike
  | BunSqliteLockDatabaseLike;

export interface LocksMigrationOptions {
  /**
   * Prefix applied to the locks table (default `"bunest_"` -> `"bunest_locks"`).
   * Must match `/^[a-zA-Z_][a-zA-Z0-9_]*$/` or be empty `""`.
   * Ignored when `tableName` is explicitly provided.
   * @default "bunest_"
   */
  readonly tablePrefix?: string;
  /**
   * Explicit locks table name overriding `tablePrefix`.
   * Must match `/^[a-zA-Z_][a-zA-Z0-9_]*$/`.
   */
  readonly tableName?: string;
}

export interface SqlLockStoreOptions extends LocksMigrationOptions {
  /**
   * SQL dialect controlling parameter placeholders (`$1` for postgres, `?` for sqlite/mysql)
   * and upsert/returning syntax.
   * @default "postgres"
   */
  readonly dialect?: SqlLockDialect;
  /**
   * Optional clock returning epoch milliseconds (defaults to `Date.now`).
   */
  readonly now?: () => number;
  /**
   * Optional `LockClock`-compatible clock object (`{ now(): number }`).
   * Takes precedence over `Date.now` when `now` is not supplied.
   */
  readonly clock?: { now(): number };
}

const DEFAULT_TABLE_PREFIX = "bunest_";
const SAFE_IDENTIFIER_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function resolveTableName(options: LocksMigrationOptions = {}): string {
  if (options.tableName !== undefined) {
    if (!SAFE_IDENTIFIER_PATTERN.test(options.tableName)) {
      throw new TypeError(
        `SqlLockStore: tableName must match /^[a-zA-Z_][a-zA-Z0-9_]*$/ (got ${JSON.stringify(options.tableName)})`,
      );
    }
    return options.tableName;
  }
  const prefix = options.tablePrefix ?? DEFAULT_TABLE_PREFIX;
  if (prefix !== "" && !SAFE_IDENTIFIER_PATTERN.test(prefix)) {
    throw new TypeError(
      `SqlLockStore: tablePrefix must match /^[a-zA-Z_][a-zA-Z0-9_]*$/ or be empty (got ${JSON.stringify(prefix)})`,
    );
  }
  return `${prefix}locks`;
}

function hashKey(key: string): string {
  return sha256(key);
}

function normalizeTtlMs(ttl: number, method: string): number {
  if (!Number.isFinite(ttl) || ttl <= 0) {
    throw new RangeError(
      `SqlLockStore.${method}(): ttl must be a positive finite number of milliseconds, got ${String(ttl)}`,
    );
  }
  return Math.max(1, Math.trunc(ttl));
}

function isBunSqlClient(executor: unknown): executor is BunSqlLockClientLike {
  return (
    executor !== null &&
    (typeof executor === "object" || typeof executor === "function") &&
    typeof (executor as BunSqlLockClientLike).unsafe === "function"
  );
}

function isBunSqliteDatabase(
  executor: unknown,
): executor is BunSqliteLockDatabaseLike {
  return (
    executor !== null &&
    typeof executor === "object" &&
    typeof (executor as BunSqliteLockDatabaseLike).prepare === "function" &&
    typeof (executor as BunSqliteLockDatabaseLike).exec === "function"
  );
}

/**
 * Adapts a `bun:sqlite` `Database` instance into a `SqlLockQueryExecutor`
 * with zero external dependencies.
 */
export function createBunSqliteLockExecutor(
  db: BunSqliteLockDatabaseLike,
): SqlLockQueryExecutor {
  const queryDb = db as BunSqliteLockDatabaseLike & {
    query?(sql: string): {
      all(...params: any[]): unknown[];
      run(...params: any[]): { changes: number };
    };
  };

  const runStatement = <T>(
    sql: string,
    params: readonly unknown[],
    expectsRows: boolean,
  ): SqlLockQueryResult<T> => {
    if (typeof queryDb.query === "function") {
      const stmt = queryDb.query(sql);
      if (expectsRows) {
        const rows = stmt.all(...params) as T[];
        return { rows, affectedRows: rows.length };
      }
      const res = stmt.run(...params);
      return { rows: [], affectedRows: res.changes, changes: res.changes };
    }
    const stmt = db.prepare(sql);
    try {
      if (expectsRows) {
        const rows = stmt.all(...params) as T[];
        return { rows, affectedRows: rows.length };
      }
      const res = stmt.run(...params);
      return { rows: [], affectedRows: res.changes, changes: res.changes };
    } finally {
      stmt.finalize?.();
    }
  };

  return {
    query<T = Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = [],
    ): SqlLockQueryResult<T> {
      const trimmed = sql.trimStart().toUpperCase();
      const expectsRows =
        trimmed.startsWith("SELECT") ||
        trimmed.startsWith("PRAGMA") ||
        /\bRETURNING\b/i.test(sql);
      return runStatement<T>(sql, params, expectsRows);
    },
    execute(
      sql: string,
      params: readonly unknown[] = [],
    ): SqlLockQueryResult {
      if (params.length === 0) {
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
      return runStatement(sql, params, false);
    },
  };
}

/**
 * Returns the individual `CREATE TABLE IF NOT EXISTS` (and index) DDL statements
 * for `SqlLockStore` tailored to `"postgres"`, `"mysql"`, or `"sqlite"`.
 */
export function getLocksMigrationStatements(
  dialect: SqlLockDialect = "postgres",
  options: LocksMigrationOptions = {},
): string[] {
  const table = resolveTableName(options);

  if (dialect === "mysql") {
    return [
      `CREATE TABLE IF NOT EXISTS ${table} (
  key_hash CHAR(64) PRIMARY KEY,
  lock_key LONGTEXT NOT NULL,
  owner VARCHAR(255) NULL,
  fencing_token BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  renew_count BIGINT NOT NULL DEFAULT 0,
  INDEX idx_${table}_expires_at (expires_at)
);`,
    ];
  }

  const intType = dialect === "sqlite" ? "INTEGER" : "BIGINT";
  return [
    `CREATE TABLE IF NOT EXISTS ${table} (
  key_hash TEXT PRIMARY KEY,
  lock_key TEXT NOT NULL,
  owner TEXT,
  fencing_token ${intType} NOT NULL,
  expires_at ${intType} NOT NULL,
  renew_count ${intType} NOT NULL DEFAULT 0
);`,
    `CREATE INDEX IF NOT EXISTS idx_${table}_expires_at ON ${table} (expires_at);`,
  ];
}

/**
 * Returns ready-to-run DDL for `SqlLockStore` tailored to `"postgres"`, `"mysql"`,
 * or `"sqlite"`.
 */
export function getLocksMigrationSql(
  dialect: SqlLockDialect = "postgres",
  options: LocksMigrationOptions = {},
): string {
  return getLocksMigrationStatements(dialect, options).join("\n\n");
}

interface NormalizedQueryResult<T> {
  rows: T[];
  affectedRows: number;
}

interface LockTokenRow {
  fencing_token: number | string | bigint;
}

/**
 * Production distributed `LockStore` backed by SQL (`postgres`, `mysql`, or `sqlite`
 * via `Bun.SQL`, `bun:sqlite`, `@bunest/orm`, `pg`, or `mysql2`).
 *
 * Uses strictly parameterized atomic conditional insert/update statements that:
 * - Reclaim released or expired locks while incrementing a per-key monotonic `fencing_token`
 * - Never reset a key's `fencing_token` on release or expiry
 * - Enforce owner-checked renewal and owner-checked release
 * - Keep arbitrary-length, case-sensitive, whitespace- and Unicode-distinct keys isolated via SHA-256 `key_hash`
 */
export class SqlLockStore implements LockStore {
  private readonly queryExecutor?: SqlLockQueryExecutor;
  private readonly bunSql?: BunSqlLockClientLike;
  private readonly dialect: SqlLockDialect;
  private readonly table: string;
  private readonly now: () => number;

  constructor(
    executor: SqlLockExecutorLike,
    options: SqlLockStoreOptions = {},
  ) {
    if (isBunSqlClient(executor)) {
      this.bunSql = executor;
    } else if (isBunSqliteDatabase(executor)) {
      this.queryExecutor = createBunSqliteLockExecutor(executor);
    } else if (
      executor !== null &&
      typeof executor === "object" &&
      typeof (executor as SqlLockQueryExecutor).query === "function"
    ) {
      this.queryExecutor = executor as SqlLockQueryExecutor;
    } else {
      throw new TypeError(
        "SqlLockStore: expected a SqlLockExecutorLike (Bun.SQL, bun:sqlite Database, or executor providing query(sql, params)).",
      );
    }
    this.dialect = options.dialect ?? "postgres";
    this.table = resolveTableName(options);
    this.now =
      options.now ??
      (options.clock ? () => options.clock!.now() : () => Date.now());
  }

  /**
   * Executes the `CREATE TABLE IF NOT EXISTS` and index statements for this store's
   * dialect and table name.
   */
  async migrate(): Promise<void> {
    const statements = getLocksMigrationStatements(this.dialect, {
      tableName: this.table,
    });
    for (const stmt of statements) {
      await this.runWrite(stmt, []);
    }
  }

  /**
   * Convenience helper registering this store into `LocksStorage`.
   */
  registerInto(
    storage: LocksStorage,
    options?: LocksStorageRegisterOptions,
  ): void {
    storage.registerSource(this, options);
  }

  async acquire(
    key: string,
    owner: string,
    ttl: number,
  ): Promise<LockAcquireResult> {
    const ttlMs = normalizeTtlMs(ttl, "acquire");
    const now = this.now();
    const expiresAt = now + ttlMs;
    const keyHash = hashKey(key);

    if (this.dialect === "mysql") {
      return this.acquireMysql(keyHash, key, owner, now, expiresAt);
    }

    const { rows } = await this.runQuery<LockTokenRow>(
      `INSERT INTO ${this.table} (key_hash, lock_key, owner, fencing_token, expires_at, renew_count) ` +
        `VALUES (${this.p(1)}, ${this.p(2)}, ${this.p(3)}, 1, ${this.p(4)}, 0) ` +
        `ON CONFLICT (key_hash) DO UPDATE ` +
        `SET owner = EXCLUDED.owner, ` +
        `expires_at = EXCLUDED.expires_at, ` +
        `fencing_token = ${this.table}.fencing_token + 1, ` +
        `renew_count = 0 ` +
        `WHERE ${this.table}.owner IS NULL OR ${this.table}.expires_at <= ${this.p(5)} ` +
        `RETURNING fencing_token`,
      [keyHash, key, owner, expiresAt, now],
    );

    const row = rows[0];
    if (!row) {
      return { acquired: false };
    }
    const fencingToken = Number(row.fencing_token);
    if (!Number.isSafeInteger(fencingToken) || fencingToken < 1) {
      throw new Error(
        `SqlLockStore.acquire(): invalid fencing_token returned from database (${String(row.fencing_token)})`,
      );
    }
    return { acquired: true, fencingToken };
  }

  async renew(key: string, owner: string, ttl: number): Promise<boolean> {
    const ttlMs = normalizeTtlMs(ttl, "renew");
    const now = this.now();
    const expiresAt = now + ttlMs;
    const keyHash = hashKey(key);

    const res = await this.runWrite(
      `UPDATE ${this.table} ` +
        `SET expires_at = ${this.p(1)}, renew_count = renew_count + 1 ` +
        `WHERE key_hash = ${this.p(2)} AND owner = ${this.p(3)} AND expires_at > ${this.p(4)}`,
      [expiresAt, keyHash, owner, now],
    );
    return res.affectedRows > 0;
  }

  async release(key: string, owner: string): Promise<boolean> {
    const now = this.now();
    const keyHash = hashKey(key);

    // Clear ownership while keeping the row so fencing_token remains strictly monotonic.
    const res = await this.runWrite(
      `UPDATE ${this.table} ` +
        `SET owner = NULL, expires_at = 0 ` +
        `WHERE key_hash = ${this.p(1)} AND owner = ${this.p(2)} AND expires_at > ${this.p(3)}`,
      [keyHash, owner, now],
    );
    return res.affectedRows > 0;
  }

  private async acquireMysql(
    keyHash: string,
    key: string,
    owner: string,
    now: number,
    expiresAt: number,
  ): Promise<LockAcquireResult> {
    const inserted = await this.runWrite(
      `INSERT IGNORE INTO ${this.table} (key_hash, lock_key, owner, fencing_token, expires_at, renew_count) ` +
        `VALUES (?, ?, ?, 1, ?, 0)`,
      [keyHash, key, owner, expiresAt],
    );
    if (inserted.affectedRows > 0) {
      return { acquired: true, fencingToken: 1 };
    }

    const updated = await this.runWrite(
      `UPDATE ${this.table} ` +
        `SET owner = ?, expires_at = ?, fencing_token = fencing_token + 1, renew_count = 0 ` +
        `WHERE key_hash = ? AND (owner IS NULL OR expires_at <= ?)`,
      [owner, expiresAt, keyHash, now],
    );
    if (updated.affectedRows === 0) {
      return { acquired: false };
    }

    const { rows } = await this.runQuery<LockTokenRow>(
      `SELECT fencing_token FROM ${this.table} WHERE key_hash = ? AND owner = ?`,
      [keyHash, owner],
    );
    const row = rows[0];
    if (!row) {
      return { acquired: false };
    }
    const fencingToken = Number(row.fencing_token);
    if (!Number.isSafeInteger(fencingToken) || fencingToken < 1) {
      throw new Error(
        `SqlLockStore.acquire(): invalid fencing_token returned from database (${String(row.fencing_token)})`,
      );
    }
    return { acquired: true, fencingToken };
  }

  private p(index: number): string {
    return this.dialect === "postgres" ? `$${index}` : "?";
  }

  private normalizeResult<T>(
    raw: SqlLockQueryResult<T> | readonly T[] | void,
  ): NormalizedQueryResult<T> {
    if (!raw) {
      return { rows: [], affectedRows: 0 };
    }
    if (Array.isArray(raw)) {
      const meta = raw as readonly T[] & {
        affectedRows?: number | null;
        count?: number | null;
      };
      const affected =
        [meta.affectedRows, meta.count].find(isNumber) ?? raw.length;
      return { rows: [...raw] as T[], affectedRows: affected };
    }
    const obj = raw as SqlLockQueryResult<T>;
    const rows = Array.isArray(obj.rows) ? ([...obj.rows] as T[]) : [];
    const affected =
      [obj.affectedRows, obj.rowCount, obj.changes, obj.count].find(isNumber) ??
      rows.length;
    return { rows, affectedRows: affected };
  }

  private async runQuery<T = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<NormalizedQueryResult<T>> {
    const normalizedParams = params.map((v) => (v === undefined ? null : v));
    if (this.bunSql) {
      const res =
        normalizedParams.length > 0
          ? await this.bunSql.unsafe<T>(sql, normalizedParams)
          : await this.bunSql.unsafe<T>(sql);
      return this.normalizeResult<T>(res);
    }
    const res = await this.queryExecutor!.query<T>(sql, normalizedParams);
    return this.normalizeResult<T>(res);
  }

  private async runWrite(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<NormalizedQueryResult<Record<string, unknown>>> {
    const normalizedParams = params.map((v) => (v === undefined ? null : v));
    if (!this.bunSql && typeof this.queryExecutor?.execute === "function") {
      const res = await this.queryExecutor.execute(sql, normalizedParams);
      return this.normalizeResult(res);
    }
    return this.runQuery(sql, normalizedParams);
  }
}
