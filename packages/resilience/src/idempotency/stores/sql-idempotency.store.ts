import type { IdempotencyStorageRegisterOptions } from "../interfaces/idempotency-storage.interface";
import type {
  IdempotencyAcquireResult,
  IdempotencyStore,
  IdempotencyStoredPayload,
} from "../interfaces/idempotency-store.interface";
import type { IdempotencyStorage } from "../storage/idempotency.storage";

export type SqlIdempotencyDialect = "postgres" | "mysql" | "sqlite";

export interface SqlIdempotencyQueryResult<T = Record<string, unknown>> {
  rows?: readonly T[];
  affectedRows?: number | null;
  rowCount?: number | null;
  changes?: number | null;
  count?: number | null;
}

/**
 * Structural SQL query executor compatible with `@bunest/orm`, `pg`, `mysql2`,
 * `createBunSqliteIdempotencyExecutor(db)`, and custom executors.
 */
export interface SqlIdempotencyQueryExecutor {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ):
    | Promise<SqlIdempotencyQueryResult<T> | readonly T[]>
    | SqlIdempotencyQueryResult<T>
    | readonly T[];
  execute?(
    sql: string,
    params?: readonly unknown[],
  ):
    | Promise<SqlIdempotencyQueryResult | void>
    | SqlIdempotencyQueryResult
    | void;
}

/**
 * Structural subset of Bun's native `Bun.SQL` client (`sql.unsafe(query, params)`).
 */
export interface BunSqlIdempotencyClientLike {
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
 * Structural subset of `bun:sqlite` `Database` accepted directly by
 * `SqlIdempotencyStore` and `createBunSqliteIdempotencyExecutor`.
 */
export interface BunSqliteIdempotencyDatabaseLike {
  prepare(sql: string): {
    all(...params: any[]): unknown[];
    run(...params: any[]): { changes: number };
    finalize?(): void;
  };
  exec(sql: string): void;
}

/**
 * Any SQL executor accepted by `SqlIdempotencyStore`: native `Bun.SQL`, `bun:sqlite`
 * `Database`, `createBunSqliteIdempotencyExecutor(db)`, `@bunest/orm` executors,
 * or `pg`/`mysql2` pools.
 */
export type SqlIdempotencyExecutorLike =
  | SqlIdempotencyQueryExecutor
  | BunSqlIdempotencyClientLike
  | BunSqliteIdempotencyDatabaseLike;

export interface IdempotencyMigrationOptions {
  /**
   * Prefix applied to the idempotency table (default `"bunest_"` -> `"bunest_idempotency"`).
   * Must match `/^[a-zA-Z_][a-zA-Z0-9_]*$/` or be empty `""`.
   * Ignored when `tableName` is explicitly provided.
   * @default "bunest_"
   */
  readonly tablePrefix?: string;
  /**
   * Explicit idempotency table name overriding `tablePrefix`.
   * Must match `/^[a-zA-Z_][a-zA-Z0-9_]*$/`.
   */
  readonly tableName?: string;
}

export interface SqlIdempotencyStoreOptions extends IdempotencyMigrationOptions {
  /**
   * SQL dialect controlling parameter placeholders (`$1` for postgres, `?` for sqlite/mysql)
   * and upsert/returning syntax.
   * @default "postgres"
   */
  readonly dialect?: SqlIdempotencyDialect;
  /**
   * Optional clock returning epoch milliseconds (defaults to `Date.now`).
   */
  readonly now?: () => number;
}

const DEFAULT_TABLE_PREFIX = "bunest_";
const SAFE_IDENTIFIER_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const MAX_ACQUIRE_ATTEMPTS = 8;

function resolveTableName(options: IdempotencyMigrationOptions = {}): string {
  if (options.tableName !== undefined) {
    if (!SAFE_IDENTIFIER_PATTERN.test(options.tableName)) {
      throw new TypeError(
        `SqlIdempotencyStore: tableName must match /^[a-zA-Z_][a-zA-Z0-9_]*$/ (got ${JSON.stringify(options.tableName)})`,
      );
    }
    return options.tableName;
  }
  const prefix = options.tablePrefix ?? DEFAULT_TABLE_PREFIX;
  if (prefix !== "" && !SAFE_IDENTIFIER_PATTERN.test(prefix)) {
    throw new TypeError(
      `SqlIdempotencyStore: tablePrefix must match /^[a-zA-Z_][a-zA-Z0-9_]*$/ or be empty (got ${JSON.stringify(prefix)})`,
    );
  }
  return `${prefix}idempotency`;
}

function hashKey(key: string): string {
  return new Bun.CryptoHasher("sha256").update(key).digest("hex");
}

function normalizeTtlMs(ttl: number, method: string): number {
  if (!Number.isFinite(ttl) || ttl <= 0) {
    throw new RangeError(
      `SqlIdempotencyStore.${method}(): ttl must be a positive finite number of milliseconds, got ${String(ttl)}`,
    );
  }
  return Math.max(1, Math.trunc(ttl));
}

function isBunSqlClient(
  executor: unknown,
): executor is BunSqlIdempotencyClientLike {
  return (
    executor !== null &&
    (typeof executor === "object" || typeof executor === "function") &&
    typeof (executor as BunSqlIdempotencyClientLike).unsafe === "function"
  );
}

function isBunSqliteDatabase(
  executor: unknown,
): executor is BunSqliteIdempotencyDatabaseLike {
  return (
    executor !== null &&
    typeof executor === "object" &&
    typeof (executor as BunSqliteIdempotencyDatabaseLike).prepare ===
      "function" &&
    typeof (executor as BunSqliteIdempotencyDatabaseLike).exec === "function"
  );
}

/**
 * Adapts a `bun:sqlite` `Database` instance into a `SqlIdempotencyQueryExecutor`
 * with zero external dependencies.
 */
export function createBunSqliteIdempotencyExecutor(
  db: BunSqliteIdempotencyDatabaseLike,
): SqlIdempotencyQueryExecutor {
  const queryDb = db as BunSqliteIdempotencyDatabaseLike & {
    query?(sql: string): {
      all(...params: any[]): unknown[];
      run(...params: any[]): { changes: number };
    };
  };

  const runStatement = <T>(
    sql: string,
    params: readonly unknown[],
    expectsRows: boolean,
  ): SqlIdempotencyQueryResult<T> => {
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
    ): SqlIdempotencyQueryResult<T> {
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
    ): SqlIdempotencyQueryResult {
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
 * for `SqlIdempotencyStore` tailored to `"postgres"`, `"mysql"`, or `"sqlite"`.
 */
export function getIdempotencyMigrationStatements(
  dialect: SqlIdempotencyDialect = "postgres",
  options: IdempotencyMigrationOptions = {},
): string[] {
  const table = resolveTableName(options);

  if (dialect === "mysql") {
    return [
      `CREATE TABLE IF NOT EXISTS ${table} (
  key_hash CHAR(64) PRIMARY KEY,
  record_key LONGTEXT NOT NULL,
  state VARCHAR(16) NOT NULL,
  owner VARCHAR(255) NULL,
  fingerprint TEXT NOT NULL,
  response_json LONGTEXT NULL,
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
  record_key TEXT NOT NULL,
  state TEXT NOT NULL,
  owner TEXT,
  fingerprint TEXT NOT NULL,
  response_json TEXT,
  expires_at ${intType} NOT NULL,
  renew_count ${intType} NOT NULL DEFAULT 0
);`,
    `CREATE INDEX IF NOT EXISTS idx_${table}_expires_at ON ${table} (expires_at);`,
  ];
}

/**
 * Returns ready-to-run DDL for `SqlIdempotencyStore` tailored to `"postgres"`,
 * `"mysql"`, or `"sqlite"`.
 */
export function getIdempotencyMigrationSql(
  dialect: SqlIdempotencyDialect = "postgres",
  options: IdempotencyMigrationOptions = {},
): string {
  return getIdempotencyMigrationStatements(dialect, options).join("\n\n");
}

interface NormalizedQueryResult<T> {
  rows: T[];
  affectedRows: number;
}

interface IdempotencyRow {
  state: string;
  fingerprint: string;
  response_json: string | null;
}

/**
 * Production distributed `IdempotencyStore` backed by SQL (`postgres`, `mysql`,
 * or `sqlite` via `Bun.SQL`, `bun:sqlite`, `@bunest/orm`, `pg`, or `mysql2`).
 *
 * Uses strictly parameterized atomic conditional insert/update statements for
 * lock acquisition, compare-and-set completion (`complete`), owner-checked
 * heartbeat (`extend`), and owner-checked cleanup (`release`).
 */
export class SqlIdempotencyStore implements IdempotencyStore {
  private readonly queryExecutor?: SqlIdempotencyQueryExecutor;
  private readonly bunSql?: BunSqlIdempotencyClientLike;
  private readonly dialect: SqlIdempotencyDialect;
  private readonly table: string;
  private readonly now: () => number;

  constructor(
    executor: SqlIdempotencyExecutorLike,
    options: SqlIdempotencyStoreOptions = {},
  ) {
    if (isBunSqlClient(executor)) {
      this.bunSql = executor;
    } else if (isBunSqliteDatabase(executor)) {
      this.queryExecutor = createBunSqliteIdempotencyExecutor(executor);
    } else if (
      executor !== null &&
      typeof executor === "object" &&
      typeof (executor as SqlIdempotencyQueryExecutor).query === "function"
    ) {
      this.queryExecutor = executor as SqlIdempotencyQueryExecutor;
    } else {
      throw new TypeError(
        "SqlIdempotencyStore: expected a SqlIdempotencyExecutorLike (Bun.SQL, bun:sqlite Database, or executor providing query(sql, params)).",
      );
    }
    this.dialect = options.dialect ?? "postgres";
    this.table = resolveTableName(options);
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Executes the `CREATE TABLE IF NOT EXISTS` and index statements for this store's
   * dialect and table name.
   */
  async migrate(): Promise<void> {
    const statements = getIdempotencyMigrationStatements(this.dialect, {
      tableName: this.table,
    });
    for (const stmt of statements) {
      await this.runWrite(stmt, []);
    }
  }

  /**
   * Convenience helper registering this store into `IdempotencyStorage`.
   */
  registerInto(
    storage: IdempotencyStorage,
    options?: IdempotencyStorageRegisterOptions,
  ): void {
    storage.registerSource(this, options);
  }

  async acquire(
    key: string,
    owner: string,
    fingerprint: string,
    lockTtl: number,
  ): Promise<IdempotencyAcquireResult> {
    const ttlMs = normalizeTtlMs(lockTtl, "acquire");
    const keyHash = hashKey(key);

    for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt++) {
      const now = this.now();
      const expiresAt = now + ttlMs;

      const acquired = await this.tryClaimKey(
        keyHash,
        key,
        owner,
        fingerprint,
        now,
        expiresAt,
      );
      if (acquired) {
        return { state: "acquired" };
      }

      const { rows } = await this.runQuery<IdempotencyRow>(
        `SELECT state, fingerprint, response_json FROM ${this.table} ` +
          `WHERE key_hash = ${this.p(1)} AND expires_at > ${this.p(2)}`,
        [keyHash, now],
      );
      const row = rows[0];
      if (!row) {
        // The competing record expired or was released between claim and read; retry.
        continue;
      }

      if (row.state === "completed") {
        if (row.response_json === null || row.response_json === undefined) {
          throw new Error(
            `SqlIdempotencyStore.acquire(): completed record for key "${key}" is missing response_json.`,
          );
        }
        return {
          state: "completed",
          fingerprint: row.fingerprint,
          response: JSON.parse(row.response_json) as IdempotencyStoredPayload,
        };
      }

      return {
        state: "in-flight",
        fingerprint: row.fingerprint,
      };
    }

    throw new Error(
      `SqlIdempotencyStore.acquire(): could not settle contention for key "${key}" after ${MAX_ACQUIRE_ATTEMPTS} attempts.`,
    );
  }

  async complete(
    key: string,
    owner: string,
    response: IdempotencyStoredPayload,
    ttl: number,
  ): Promise<boolean> {
    const ttlMs = normalizeTtlMs(ttl, "complete");
    const now = this.now();
    const expiresAt = now + ttlMs;
    const keyHash = hashKey(key);
    const serialized = JSON.stringify(response);

    const res = await this.runWrite(
      `UPDATE ${this.table} ` +
        `SET state = 'completed', owner = NULL, response_json = ${this.p(1)}, expires_at = ${this.p(2)} ` +
        `WHERE key_hash = ${this.p(3)} AND state = 'in-flight' AND owner = ${this.p(4)} AND expires_at > ${this.p(5)}`,
      [serialized, expiresAt, keyHash, owner, now],
    );
    return res.affectedRows > 0;
  }

  async release(key: string, owner: string): Promise<boolean> {
    const now = this.now();
    const keyHash = hashKey(key);

    const res = await this.runWrite(
      `DELETE FROM ${this.table} ` +
        `WHERE key_hash = ${this.p(1)} AND state = 'in-flight' AND owner = ${this.p(2)} AND expires_at > ${this.p(3)}`,
      [keyHash, owner, now],
    );
    return res.affectedRows > 0;
  }

  async extend(key: string, owner: string, lockTtl: number): Promise<boolean> {
    const ttlMs = normalizeTtlMs(lockTtl, "extend");
    const now = this.now();
    const expiresAt = now + ttlMs;
    const keyHash = hashKey(key);

    const res = await this.runWrite(
      `UPDATE ${this.table} ` +
        `SET expires_at = ${this.p(1)}, renew_count = renew_count + 1 ` +
        `WHERE key_hash = ${this.p(2)} AND state = 'in-flight' AND owner = ${this.p(3)} AND expires_at > ${this.p(4)}`,
      [expiresAt, keyHash, owner, now],
    );
    return res.affectedRows > 0;
  }

  /**
   * Deletes expired idempotency locks and completed records (`expires_at <= now`).
   * Returns the number of rows deleted.
   */
  async pruneExpired(): Promise<number> {
    const res = await this.runWrite(
      `DELETE FROM ${this.table} WHERE expires_at <= ${this.p(1)}`,
      [this.now()],
    );
    return res.affectedRows;
  }

  private async tryClaimKey(
    keyHash: string,
    key: string,
    owner: string,
    fingerprint: string,
    now: number,
    expiresAt: number,
  ): Promise<boolean> {
    if (this.dialect === "mysql") {
      const inserted = await this.runWrite(
        `INSERT IGNORE INTO ${this.table} ` +
          `(key_hash, record_key, state, owner, fingerprint, response_json, expires_at, renew_count) ` +
          `VALUES (?, ?, 'in-flight', ?, ?, NULL, ?, 0)`,
        [keyHash, key, owner, fingerprint, expiresAt],
      );
      if (inserted.affectedRows > 0) {
        return true;
      }
      const updated = await this.runWrite(
        `UPDATE ${this.table} ` +
          `SET state = 'in-flight', owner = ?, fingerprint = ?, response_json = NULL, expires_at = ?, renew_count = 0 ` +
          `WHERE key_hash = ? AND expires_at <= ?`,
        [owner, fingerprint, expiresAt, keyHash, now],
      );
      return updated.affectedRows > 0;
    }

    const { rows } = await this.runQuery<{ key_hash: string }>(
      `INSERT INTO ${this.table} ` +
        `(key_hash, record_key, state, owner, fingerprint, response_json, expires_at, renew_count) ` +
        `VALUES (${this.p(1)}, ${this.p(2)}, 'in-flight', ${this.p(3)}, ${this.p(4)}, NULL, ${this.p(5)}, 0) ` +
        `ON CONFLICT (key_hash) DO UPDATE ` +
        `SET state = 'in-flight', ` +
        `owner = EXCLUDED.owner, ` +
        `fingerprint = EXCLUDED.fingerprint, ` +
        `response_json = NULL, ` +
        `expires_at = EXCLUDED.expires_at, ` +
        `renew_count = 0 ` +
        `WHERE ${this.table}.expires_at <= ${this.p(6)} ` +
        `RETURNING key_hash`,
      [keyHash, key, owner, fingerprint, expiresAt, now],
    );
    return rows.length > 0;
  }

  private p(index: number): string {
    return this.dialect === "postgres" ? `$${index}` : "?";
  }

  private normalizeResult<T>(
    raw: SqlIdempotencyQueryResult<T> | readonly T[] | void,
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
        typeof meta.affectedRows === "number"
          ? meta.affectedRows
          : typeof meta.count === "number"
            ? meta.count
            : raw.length;
      return { rows: [...raw] as T[], affectedRows: affected };
    }
    const obj = raw as SqlIdempotencyQueryResult<T>;
    const rows = Array.isArray(obj.rows) ? ([...obj.rows] as T[]) : [];
    const affected =
      typeof obj.affectedRows === "number"
        ? obj.affectedRows
        : typeof obj.rowCount === "number"
          ? obj.rowCount
          : typeof obj.changes === "number"
            ? obj.changes
            : typeof obj.count === "number"
              ? obj.count
              : rows.length;
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
