import { Injectable } from "@bunest/core";
import { isNumber } from "@bunest/core/common";
import type {
  AuthenticationStorageRegisterOptions,
  AuthenticationStorageSources,
} from "../interfaces/authentication-storage.interface";
import type {
  EmailTokenPurpose,
  EmailTokenRecord,
  EmailTokenStore,
} from "../interfaces/email-token-store.interface";
import type {
  MagicLinkRecord,
  MagicLinkStore,
} from "../interfaces/magic-link-store.interface";
import type { MfaStore, TotpRecord } from "../interfaces/mfa-store.interface";
import type { OidcTransaction } from "../interfaces/oidc.interface";
import type { OidcStateStore } from "../interfaces/oidc-state-store.interface";
import type {
  RefreshTokenRecord,
  RefreshTokenStore,
} from "../interfaces/refresh-token-store.interface";
import type {
  SessionRecord,
  SessionStore,
} from "../interfaces/session-store.interface";
import type {
  PasskeyChallengeRecord,
  PasskeyChallengeType,
  PasskeyCredential,
  PasskeyStore,
} from "../webauthn/webauthn.interface";
import type { AuthenticationStorage } from "./authentication.storage";

export type SqlAuthDialect = "postgres" | "sqlite" | "mysql";

export interface SqlAuthQueryResult<T = Record<string, unknown>> {
  rows?: readonly T[];
  affectedRows?: number | null;
  rowCount?: number | null;
  changes?: number | null;
  count?: number | null;
}

/**
 * Structural query runner compatible with `@bunest/orm`, `pg`, `mysql2`,
 * `bun:sqlite` adapters, and custom SQL executors.
 */
export interface SqlAuthQueryExecutor {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ):
    | Promise<SqlAuthQueryResult<T> | readonly T[]>
    | SqlAuthQueryResult<T>
    | readonly T[];
  execute?(
    sql: string,
    params?: readonly unknown[],
  ): Promise<SqlAuthQueryResult | void> | SqlAuthQueryResult | void;
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
      count?: number | null;
      affectedRows?: number | null;
    }
  >;
}

/**
 * Any SQL executor accepted by `SqlAuthenticationStore` (native `Bun.SQL`,
 * `@bunest/orm` executor, `pg`/`mysql2` pools, or `createBunSqliteAuthExecutor(db)`).
 */
export type SqlAuthExecutorLike = SqlAuthQueryExecutor | BunSqlClientLike;

/**
 * Structural subset of `bun:sqlite` `Database` accepted by `createBunSqliteAuthExecutor`.
 */
export interface BunSqliteDatabaseLike {
  query(sql: string): {
    all(...params: any[]): unknown[];
    run(...params: any[]): { changes: number };
  };
  exec?(sql: string): void;
}

export interface AuthMigrationOptions {
  /**
   * Prefix applied to all 6 auth tables.
   * Must contain only ASCII letters, digits, and underscores (or be empty).
   * @default "bunest_auth_"
   */
  tablePrefix?: string;
}

export interface SqlAuthenticationStoreOptions extends AuthMigrationOptions {
  /**
   * SQL dialect controlling parameter placeholders (`$1` for postgres, `?` for sqlite/mysql)
   * and upsert/returning syntax.
   * @default "postgres"
   */
  dialect?: SqlAuthDialect;
  /**
   * Optional maximum number of pending magic links, OIDC logins, and email tokens
   * retained per kind (drops earliest-expiring rows once exceeded).
   */
  maxPending?: number;
}

const DEFAULT_TABLE_PREFIX = "bunest_auth_";
const SAFE_PREFIX_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function validateTablePrefix(prefix: string): string {
  if (prefix === "") {
    return "";
  }
  if (!SAFE_PREFIX_PATTERN.test(prefix)) {
    throw new TypeError(
      `SqlAuthenticationStore: tablePrefix must match /^[a-zA-Z_][a-zA-Z0-9_]*$/ or be empty (got "${prefix}")`,
    );
  }
  return prefix;
}

function tableNames(prefix: string) {
  return {
    sessions: `${prefix}sessions`,
    refreshTokens: `${prefix}refresh_tokens`,
    mfa: `${prefix}mfa`,
    magicLinks: `${prefix}magic_links`,
    oidcStates: `${prefix}oidc_states`,
    emailTokens: `${prefix}email_tokens`,
    passkeys: `${prefix}passkeys`,
  } as const;
}

/**
 * Adapts a `bun:sqlite` `Database` instance into a `SqlAuthQueryExecutor`
 * with zero external dependencies.
 */
export function createBunSqliteAuthExecutor(
  db: BunSqliteDatabaseLike,
): SqlAuthQueryExecutor {
  return {
    query<T = Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = [],
    ): SqlAuthQueryResult<T> {
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
    ): SqlAuthQueryResult {
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
 * Returns the individual `CREATE TABLE IF NOT EXISTS` (and index) DDL statements
 * for all 6 `@bunest/security/auth` tables in the requested SQL dialect.
 */
export function getAuthMigrationStatements(
  dialect: SqlAuthDialect = "postgres",
  options: AuthMigrationOptions = {},
): string[] {
  const prefix = validateTablePrefix(
    options.tablePrefix ?? DEFAULT_TABLE_PREFIX,
  );
  const t = tableNames(prefix);

  if (dialect === "mysql") {
    return [
      `CREATE TABLE IF NOT EXISTS ${t.sessions} (
  id VARCHAR(255) PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  last_active_at BIGINT NOT NULL,
  mfa VARCHAR(32) NULL,
  metadata LONGTEXT NULL,
  INDEX idx_${t.sessions}_user_id (user_id),
  INDEX idx_${t.sessions}_expires_at (expires_at)
);`,
      `CREATE TABLE IF NOT EXISTS ${t.refreshTokens} (
  id VARCHAR(255) NOT NULL,
  record_type VARCHAR(32) NOT NULL DEFAULT 'token',
  family_id VARCHAR(255) NOT NULL,
  user_id VARCHAR(255) NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  family_expires_at BIGINT NOT NULL,
  used_at BIGINT NULL,
  claims LONGTEXT NULL,
  PRIMARY KEY (id, record_type),
  INDEX idx_${t.refreshTokens}_user_id (user_id, record_type),
  INDEX idx_${t.refreshTokens}_family_id (family_id, record_type)
);`,
      `CREATE TABLE IF NOT EXISTS ${t.mfa} (
  user_id VARCHAR(255) NOT NULL,
  record_type VARCHAR(32) NOT NULL,
  record_key VARCHAR(255) NOT NULL,
  payload LONGTEXT NULL,
  numeric_value BIGINT NULL,
  PRIMARY KEY (user_id, record_type, record_key),
  INDEX idx_${t.mfa}_lookup (user_id, record_type, numeric_value)
);`,
      `CREATE TABLE IF NOT EXISTS ${t.magicLinks} (
  id VARCHAR(255) PRIMARY KEY,
  email VARCHAR(320) NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  redirect_to TEXT NULL,
  INDEX idx_${t.magicLinks}_expires_at (expires_at)
);`,
      `CREATE TABLE IF NOT EXISTS ${t.oidcStates} (
  state VARCHAR(255) PRIMARY KEY,
  provider VARCHAR(128) NOT NULL,
  nonce VARCHAR(255) NULL,
  code_verifier VARCHAR(255) NOT NULL,
  redirect_to TEXT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  link_json TEXT NULL,
  INDEX idx_${t.oidcStates}_expires_at (expires_at)
);`,
      `CREATE TABLE IF NOT EXISTS ${t.emailTokens} (
  id VARCHAR(255) PRIMARY KEY,
  purpose VARCHAR(64) NOT NULL,
  user_id VARCHAR(255) NOT NULL,
  email VARCHAR(320) NOT NULL,
  fingerprint VARCHAR(255) NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  INDEX idx_${t.emailTokens}_user_purpose (user_id, purpose),
  INDEX idx_${t.emailTokens}_expires_at (expires_at)
);`,
      `CREATE TABLE IF NOT EXISTS ${t.passkeys} (
  id VARCHAR(512) NOT NULL,
  record_type VARCHAR(32) NOT NULL DEFAULT 'credential',
  user_id VARCHAR(255) NULL,
  payload LONGTEXT NOT NULL,
  counter BIGINT NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  last_used_at BIGINT NULL,
  expires_at BIGINT NULL,
  PRIMARY KEY (id, record_type),
  INDEX idx_${t.passkeys}_user_id (user_id, record_type),
  INDEX idx_${t.passkeys}_expires_at (expires_at)
);`,
    ];
  }

  const intType = dialect === "sqlite" ? "INTEGER" : "BIGINT";

  return [
    `CREATE TABLE IF NOT EXISTS ${t.sessions} (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at ${intType} NOT NULL,
  expires_at ${intType} NOT NULL,
  last_active_at ${intType} NOT NULL,
  mfa TEXT,
  metadata TEXT
);`,
    `CREATE INDEX IF NOT EXISTS idx_${t.sessions}_user_id ON ${t.sessions} (user_id);`,
    `CREATE INDEX IF NOT EXISTS idx_${t.sessions}_expires_at ON ${t.sessions} (expires_at);`,
    `CREATE TABLE IF NOT EXISTS ${t.refreshTokens} (
  id TEXT NOT NULL,
  record_type TEXT NOT NULL DEFAULT 'token',
  family_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at ${intType} NOT NULL,
  expires_at ${intType} NOT NULL,
  family_expires_at ${intType} NOT NULL,
  used_at ${intType},
  claims TEXT,
  PRIMARY KEY (id, record_type)
);`,
    `CREATE INDEX IF NOT EXISTS idx_${t.refreshTokens}_user_id ON ${t.refreshTokens} (user_id, record_type);`,
    `CREATE INDEX IF NOT EXISTS idx_${t.refreshTokens}_family_id ON ${t.refreshTokens} (family_id, record_type);`,
    `CREATE TABLE IF NOT EXISTS ${t.mfa} (
  user_id TEXT NOT NULL,
  record_type TEXT NOT NULL,
  record_key TEXT NOT NULL,
  payload TEXT,
  numeric_value ${intType},
  PRIMARY KEY (user_id, record_type, record_key)
);`,
    `CREATE INDEX IF NOT EXISTS idx_${t.mfa}_lookup ON ${t.mfa} (user_id, record_type, numeric_value);`,
    `CREATE TABLE IF NOT EXISTS ${t.magicLinks} (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  created_at ${intType} NOT NULL,
  expires_at ${intType} NOT NULL,
  redirect_to TEXT
);`,
    `CREATE INDEX IF NOT EXISTS idx_${t.magicLinks}_expires_at ON ${t.magicLinks} (expires_at);`,
    `CREATE TABLE IF NOT EXISTS ${t.oidcStates} (
  state TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  nonce TEXT,
  code_verifier TEXT NOT NULL,
  redirect_to TEXT,
  created_at ${intType} NOT NULL,
  expires_at ${intType} NOT NULL,
  link_json TEXT
);`,
    `CREATE INDEX IF NOT EXISTS idx_${t.oidcStates}_expires_at ON ${t.oidcStates} (expires_at);`,
    `CREATE TABLE IF NOT EXISTS ${t.emailTokens} (
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL,
  user_id TEXT NOT NULL,
  email TEXT NOT NULL,
  fingerprint TEXT,
  created_at ${intType} NOT NULL,
  expires_at ${intType} NOT NULL
);`,
    `CREATE INDEX IF NOT EXISTS idx_${t.emailTokens}_user_purpose ON ${t.emailTokens} (user_id, purpose);`,
    `CREATE INDEX IF NOT EXISTS idx_${t.emailTokens}_expires_at ON ${t.emailTokens} (expires_at);`,
    `CREATE TABLE IF NOT EXISTS ${t.passkeys} (
  id TEXT NOT NULL,
  record_type TEXT NOT NULL DEFAULT 'credential',
  user_id TEXT,
  payload TEXT NOT NULL,
  counter ${intType} NOT NULL DEFAULT 0,
  created_at ${intType} NOT NULL,
  last_used_at ${intType},
  expires_at ${intType},
  PRIMARY KEY (id, record_type)
);`,
    `CREATE INDEX IF NOT EXISTS idx_${t.passkeys}_user_id ON ${t.passkeys} (user_id, record_type);`,
    `CREATE INDEX IF NOT EXISTS idx_${t.passkeys}_expires_at ON ${t.passkeys} (expires_at);`,
  ];
}

/**
 * Returns ready-to-run `CREATE TABLE IF NOT EXISTS` DDL for all 6 authentication
 * tables (`sessions`, `refresh_tokens`, `mfa`, `magic_links`, `oidc_states`, `email_tokens`)
 * tailored to `"postgres"`, `"sqlite"`, or `"mysql"`.
 */
export function getAuthMigrationSql(
  dialect: SqlAuthDialect = "postgres",
  options: AuthMigrationOptions = {},
): string {
  return getAuthMigrationStatements(dialect, options).join("\n\n");
}

interface NormalizedQueryResult<T> {
  rows: T[];
  affectedRows: number;
}

interface SessionRow {
  id: string;
  user_id: string;
  created_at: number | string;
  expires_at: number | string;
  last_active_at: number | string;
  mfa: string | null;
  metadata: string | null;
}

interface RefreshTokenRow {
  id: string;
  family_id: string;
  user_id: string;
  created_at: number | string;
  expires_at: number | string;
  family_expires_at: number | string;
  used_at: number | string | null;
  claims: string | null;
}

interface MfaTotpRow {
  payload: string | null;
  numeric_value: number | string | null;
}

interface MagicLinkRow {
  id: string;
  email: string;
  created_at: number | string;
  expires_at: number | string;
  redirect_to: string | null;
}

interface OidcStateRow {
  state: string;
  provider: string;
  nonce: string | null;
  code_verifier: string;
  redirect_to: string | null;
  created_at: number | string;
  expires_at: number | string;
  link_json: string | null;
}

interface EmailTokenRow {
  id: string;
  purpose: EmailTokenPurpose;
  user_id: string;
  email: string;
  fingerprint: string | null;
  created_at: number | string;
  expires_at: number | string;
}

interface PasskeyRow {
  id: string;
  record_type: string;
  user_id: string | null;
  payload: string;
  counter: number | string;
  created_at: number | string;
  last_used_at: number | string | null;
  expires_at: number | string | null;
}

interface SerializedPasskeyPayload {
  publicKey: string;
  algorithm: number;
  transports?: PasskeyCredential["transports"];
  deviceType?: PasskeyCredential["deviceType"];
  backedUp?: boolean;
  aaguid?: string;
  name?: string;
}

/**
 * Production SQL adapter implementing all seven `@bunest/security/auth` storage contracts
 * (`sessions`, `refreshTokens`, `mfa`, `magicLinks`, `oidcStates`, `emailTokens`, `passkeys`)
 * using strictly parameterized queries across `"postgres"`, `"sqlite"`, and `"mysql"`.
 */
@Injectable()
export class SqlAuthenticationStore
  implements
    SessionStore,
    RefreshTokenStore,
    MfaStore,
    MagicLinkStore,
    OidcStateStore,
    EmailTokenStore,
    PasskeyStore
{
  private readonly executor: SqlAuthExecutorLike;
  private readonly dialect: SqlAuthDialect;
  private readonly tablePrefix: string;
  private readonly tables: ReturnType<typeof tableNames>;
  private readonly maxPending?: number;

  constructor(
    executor: SqlAuthExecutorLike,
    options: SqlAuthenticationStoreOptions = {},
  ) {
    if (
      !executor ||
      (typeof executor !== "object" && typeof executor !== "function") ||
      (typeof (executor as SqlAuthQueryExecutor).query !== "function" &&
        typeof (executor as BunSqlClientLike).unsafe !== "function")
    ) {
      throw new TypeError(
        "SqlAuthenticationStore: expected a SqlAuthExecutorLike providing query(sql, params) or unsafe(sql, params).",
      );
    }
    this.executor = executor;
    this.dialect = options.dialect ?? "postgres";
    this.tablePrefix = validateTablePrefix(
      options.tablePrefix ?? DEFAULT_TABLE_PREFIX,
    );
    this.tables = tableNames(this.tablePrefix);
    if (
      options.maxPending !== undefined &&
      !(Number.isSafeInteger(options.maxPending) && options.maxPending > 0)
    ) {
      throw new TypeError(
        `SqlAuthenticationStore: maxPending must be a positive integer (got ${String(options.maxPending)})`,
      );
    }
    this.maxPending = options.maxPending;
  }

  /**
   * Executes all `CREATE TABLE IF NOT EXISTS` and index statements for this store's
   * dialect and `tablePrefix`.
   */
  async migrate(): Promise<void> {
    const statements = getAuthMigrationStatements(this.dialect, {
      tablePrefix: this.tablePrefix,
    });
    for (const stmt of statements) {
      await this.runWrite(stmt, []);
    }
  }

  /**
   * Returns an `AuthenticationStorageSources` mapping all seven contracts to this store,
   * ready to pass to `storage.registerSource(store.asSources())`.
   */
  asSources(): Required<AuthenticationStorageSources> {
    return {
      sessions: this,
      refreshTokens: this,
      mfa: this,
      magicLinks: this,
      oidcStates: this,
      emailTokens: this,
      passkeys: this,
    };
  }

  /**
   * Convenience helper registering all six authentication storage contracts into `AuthenticationStorage`.
   */
  registerInto(
    storage: AuthenticationStorage,
    options?: AuthenticationStorageRegisterOptions,
  ): void {
    storage.registerSource(this.asSources(), options);
  }

  // ------------------------------------------------------------------ Parameterized SQL helpers

  private p(index: number): string {
    return this.dialect === "postgres" ? `$${index}` : "?";
  }

  private normalizeResult<T>(
    raw: SqlAuthQueryResult<T> | readonly T[] | void,
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
    const obj = raw as SqlAuthQueryResult<T>;
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
    if (typeof (this.executor as BunSqlClientLike).unsafe === "function") {
      const res =
        normalizedParams.length > 0
          ? await (this.executor as BunSqlClientLike).unsafe<T>(
              sql,
              normalizedParams,
            )
          : await (this.executor as BunSqlClientLike).unsafe<T>(sql);
      return this.normalizeResult<T>(res);
    }
    const res = await (this.executor as SqlAuthQueryExecutor).query<T>(
      sql,
      normalizedParams,
    );
    return this.normalizeResult<T>(res);
  }

  private async runWrite(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<NormalizedQueryResult<Record<string, unknown>>> {
    const normalizedParams = params.map((v) => (v === undefined ? null : v));
    const queryExec = this.executor as SqlAuthQueryExecutor;
    if (
      typeof (this.executor as BunSqlClientLike).unsafe !== "function" &&
      typeof queryExec.execute === "function"
    ) {
      const res = await queryExec.execute(sql, normalizedParams);
      return this.normalizeResult(res);
    }
    return this.runQuery(sql, normalizedParams);
  }

  private mapSessionRow(row: SessionRow): SessionRecord {
    const record: SessionRecord = {
      id: row.id,
      userId: row.user_id,
      createdAt: new Date(Number(row.created_at)),
      expiresAt: new Date(Number(row.expires_at)),
      lastActiveAt: new Date(Number(row.last_active_at)),
    };
    if (row.mfa !== null && row.mfa !== undefined) {
      record.mfa = row.mfa as SessionRecord["mfa"];
    }
    if (row.metadata !== null && row.metadata !== undefined) {
      record.metadata = JSON.parse(row.metadata) as Record<string, unknown>;
    }
    return record;
  }

  private mapRefreshTokenRow(row: RefreshTokenRow): RefreshTokenRecord {
    const record: RefreshTokenRecord = {
      id: row.id,
      familyId: row.family_id,
      userId: row.user_id,
      createdAt: new Date(Number(row.created_at)),
      expiresAt: new Date(Number(row.expires_at)),
      familyExpiresAt: new Date(Number(row.family_expires_at)),
    };
    if (row.used_at !== null && row.used_at !== undefined) {
      record.usedAt = new Date(Number(row.used_at));
    }
    if (row.claims !== null && row.claims !== undefined) {
      record.claims = JSON.parse(row.claims) as Record<string, unknown>;
    }
    return record;
  }

  private mapMagicLinkRow(row: MagicLinkRow): MagicLinkRecord {
    const record: MagicLinkRecord = {
      id: row.id,
      email: row.email,
      createdAt: new Date(Number(row.created_at)),
      expiresAt: new Date(Number(row.expires_at)),
    };
    if (row.redirect_to !== null && row.redirect_to !== undefined) {
      record.redirectTo = row.redirect_to;
    }
    return record;
  }

  private mapOidcStateRow(row: OidcStateRow): OidcTransaction {
    const record: OidcTransaction = {
      state: row.state,
      provider: row.provider,
      codeVerifier: row.code_verifier,
      createdAt: new Date(Number(row.created_at)),
      expiresAt: new Date(Number(row.expires_at)),
    };
    if (row.nonce !== null && row.nonce !== undefined) {
      record.nonce = row.nonce;
    }
    if (row.redirect_to !== null && row.redirect_to !== undefined) {
      record.redirectTo = row.redirect_to;
    }
    if (row.link_json !== null && row.link_json !== undefined) {
      record.link = JSON.parse(row.link_json) as OidcTransaction["link"];
    }
    return record;
  }

  private mapEmailTokenRow(row: EmailTokenRow): EmailTokenRecord {
    const record: EmailTokenRecord = {
      id: row.id,
      purpose: row.purpose,
      userId: row.user_id,
      email: row.email,
      createdAt: new Date(Number(row.created_at)),
      expiresAt: new Date(Number(row.expires_at)),
    };
    if (row.fingerprint !== null && row.fingerprint !== undefined) {
      record.fingerprint = row.fingerprint;
    }
    return record;
  }

  private async enforcePendingCap(
    table: string,
    keyColumn: string,
  ): Promise<void> {
    if (this.maxPending === undefined) {
      return;
    }
    const { rows } = await this.runQuery<Record<string, unknown>>(
      `SELECT ${keyColumn} AS k FROM ${table} ORDER BY expires_at ASC`,
      [],
    );
    const excessCount = rows.length - this.maxPending;
    if (excessCount <= 0) {
      return;
    }
    for (let i = 0; i < excessCount; i++) {
      const keyVal = rows[i]?.k;
      if (keyVal !== undefined) {
        await this.runWrite(
          `DELETE FROM ${table} WHERE ${keyColumn} = ${this.p(1)}`,
          [keyVal],
        );
      }
    }
  }

  // ------------------------------------------------------------------ SessionStore

  async getSession(id: string): Promise<SessionRecord | undefined> {
    const { rows } = await this.runQuery<SessionRow>(
      `SELECT id, user_id, created_at, expires_at, last_active_at, mfa, metadata FROM ${this.tables.sessions} WHERE id = ${this.p(1)}`,
      [id],
    );
    return rows[0] ? this.mapSessionRow(rows[0]) : undefined;
  }

  async createSession(record: SessionRecord): Promise<void> {
    const params = [
      record.id,
      record.userId,
      record.createdAt.getTime(),
      record.expiresAt.getTime(),
      record.lastActiveAt.getTime(),
      record.mfa ?? null,
      record.metadata !== undefined ? JSON.stringify(record.metadata) : null,
    ];
    const placeholders = [1, 2, 3, 4, 5, 6, 7]
      .map((i) => this.p(i))
      .join(", ");

    if (this.dialect === "mysql") {
      await this.runWrite(
        `INSERT INTO ${this.tables.sessions} (id, user_id, created_at, expires_at, last_active_at, mfa, metadata) VALUES (${placeholders}) ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), created_at = VALUES(created_at), expires_at = VALUES(expires_at), last_active_at = VALUES(last_active_at), mfa = VALUES(mfa), metadata = VALUES(metadata)`,
        params,
      );
      return;
    }

    await this.runWrite(
      `INSERT INTO ${this.tables.sessions} (id, user_id, created_at, expires_at, last_active_at, mfa, metadata) VALUES (${placeholders}) ON CONFLICT (id) DO UPDATE SET user_id = EXCLUDED.user_id, created_at = EXCLUDED.created_at, expires_at = EXCLUDED.expires_at, last_active_at = EXCLUDED.last_active_at, mfa = EXCLUDED.mfa, metadata = EXCLUDED.metadata`,
      params,
    );
  }

  async touchSession(id: string, lastActiveAt: Date): Promise<void> {
    const nextMs = lastActiveAt.getTime();
    await this.runWrite(
      `UPDATE ${this.tables.sessions} SET last_active_at = ${this.p(1)} WHERE id = ${this.p(2)} AND last_active_at < ${this.p(3)}`,
      [nextMs, id, nextMs],
    );
  }

  async deleteSession(id: string): Promise<boolean> {
    const res = await this.runWrite(
      `DELETE FROM ${this.tables.sessions} WHERE id = ${this.p(1)}`,
      [id],
    );
    return res.affectedRows > 0;
  }

  async listUserSessions(userId: string): Promise<SessionRecord[]> {
    const { rows } = await this.runQuery<SessionRow>(
      `SELECT id, user_id, created_at, expires_at, last_active_at, mfa, metadata FROM ${this.tables.sessions} WHERE user_id = ${this.p(1)}`,
      [userId],
    );
    return rows.map((row) => this.mapSessionRow(row));
  }

  async deleteUserSessions(userId: string): Promise<void> {
    await this.runWrite(
      `DELETE FROM ${this.tables.sessions} WHERE user_id = ${this.p(1)}`,
      [userId],
    );
  }

  // ------------------------------------------------------------------ RefreshTokenStore

  async getRefreshToken(id: string): Promise<RefreshTokenRecord | undefined> {
    const { rows } = await this.runQuery<RefreshTokenRow>(
      `SELECT id, family_id, user_id, created_at, expires_at, family_expires_at, used_at, claims FROM ${this.tables.refreshTokens} WHERE id = ${this.p(1)} AND record_type = ${this.p(2)}`,
      [id, "token"],
    );
    return rows[0] ? this.mapRefreshTokenRow(rows[0]) : undefined;
  }

  async saveRefreshToken(record: RefreshTokenRecord): Promise<void> {
    const params = [
      record.id,
      "token",
      record.familyId,
      record.userId,
      record.createdAt.getTime(),
      record.expiresAt.getTime(),
      record.familyExpiresAt.getTime(),
      record.usedAt ? record.usedAt.getTime() : null,
      record.claims !== undefined ? JSON.stringify(record.claims) : null,
    ];
    const placeholders = [1, 2, 3, 4, 5, 6, 7, 8, 9]
      .map((i) => this.p(i))
      .join(", ");

    if (this.dialect === "mysql") {
      await this.runWrite(
        `INSERT INTO ${this.tables.refreshTokens} (id, record_type, family_id, user_id, created_at, expires_at, family_expires_at, used_at, claims) VALUES (${placeholders}) ON DUPLICATE KEY UPDATE family_id = VALUES(family_id), user_id = VALUES(user_id), created_at = VALUES(created_at), expires_at = VALUES(expires_at), family_expires_at = VALUES(family_expires_at), used_at = VALUES(used_at), claims = VALUES(claims)`,
        params,
      );
      return;
    }

    await this.runWrite(
      `INSERT INTO ${this.tables.refreshTokens} (id, record_type, family_id, user_id, created_at, expires_at, family_expires_at, used_at, claims) VALUES (${placeholders}) ON CONFLICT (id, record_type) DO UPDATE SET family_id = EXCLUDED.family_id, user_id = EXCLUDED.user_id, created_at = EXCLUDED.created_at, expires_at = EXCLUDED.expires_at, family_expires_at = EXCLUDED.family_expires_at, used_at = EXCLUDED.used_at, claims = EXCLUDED.claims`,
      params,
    );
  }

  async markRefreshTokenUsed(id: string, at: Date): Promise<boolean> {
    const res = await this.runWrite(
      `UPDATE ${this.tables.refreshTokens} SET used_at = ${this.p(1)} WHERE id = ${this.p(2)} AND record_type = ${this.p(3)} AND used_at IS NULL`,
      [at.getTime(), id, "token"],
    );
    return res.affectedRows > 0;
  }

  async revokeRefreshTokenFamily(familyId: string): Promise<void> {
    const now = Date.now();
    const params = [familyId, "revoked_family", familyId, "", now, now, now];
    const placeholders = [1, 2, 3, 4, 5, 6, 7]
      .map((i) => this.p(i))
      .join(", ");

    if (this.dialect === "mysql") {
      await this.runWrite(
        `INSERT IGNORE INTO ${this.tables.refreshTokens} (id, record_type, family_id, user_id, created_at, expires_at, family_expires_at) VALUES (${placeholders})`,
        params,
      );
      return;
    }

    await this.runWrite(
      `INSERT INTO ${this.tables.refreshTokens} (id, record_type, family_id, user_id, created_at, expires_at, family_expires_at) VALUES (${placeholders}) ON CONFLICT (id, record_type) DO NOTHING`,
      params,
    );
  }

  async isRefreshTokenFamilyRevoked(familyId: string): Promise<boolean> {
    const { rows } = await this.runQuery<{ id: string }>(
      `SELECT id FROM ${this.tables.refreshTokens} WHERE id = ${this.p(1)} AND record_type = ${this.p(2)} LIMIT 1`,
      [familyId, "revoked_family"],
    );
    return rows.length > 0;
  }

  async revokeUserRefreshTokens(userId: string): Promise<void> {
    const { rows } = await this.runQuery<{ family_id: string }>(
      `SELECT DISTINCT family_id FROM ${this.tables.refreshTokens} WHERE user_id = ${this.p(1)} AND record_type = ${this.p(2)}`,
      [userId, "token"],
    );
    for (const row of rows) {
      await this.revokeRefreshTokenFamily(row.family_id);
    }
  }

  // ------------------------------------------------------------------ MfaStore

  async getTotp(userId: string): Promise<TotpRecord | undefined> {
    const { rows } = await this.runQuery<MfaTotpRow>(
      `SELECT payload, numeric_value FROM ${this.tables.mfa} WHERE user_id = ${this.p(1)} AND record_type = ${this.p(2)} AND record_key = ${this.p(3)}`,
      [userId, "totp", "default"],
    );
    const row = rows[0];
    if (!row || !row.payload) {
      return undefined;
    }
    const parsed = JSON.parse(row.payload) as Omit<TotpRecord, "lastUsedStep">;
    const record: TotpRecord = {
      secret: parsed.secret,
      confirmed: Boolean(parsed.confirmed),
    };
    if (parsed.pendingSecret !== undefined) {
      record.pendingSecret = parsed.pendingSecret;
    }
    if (row.numeric_value !== null && row.numeric_value !== undefined) {
      record.lastUsedStep = Number(row.numeric_value);
    }
    return record;
  }

  async saveTotp(userId: string, record: TotpRecord | null): Promise<void> {
    if (!record) {
      await this.runWrite(
        `DELETE FROM ${this.tables.mfa} WHERE user_id = ${this.p(1)} AND record_type = ${this.p(2)} AND record_key = ${this.p(3)}`,
        [userId, "totp", "default"],
      );
      return;
    }

    const payload = JSON.stringify({
      secret: record.secret,
      confirmed: record.confirmed,
      ...(record.pendingSecret !== undefined
        ? { pendingSecret: record.pendingSecret }
        : {}),
    });
    const lastUsedStep =
      record.lastUsedStep !== undefined ? record.lastUsedStep : null;
    const params = [userId, "totp", "default", payload, lastUsedStep];
    const placeholders = [1, 2, 3, 4, 5].map((i) => this.p(i)).join(", ");

    if (this.dialect === "mysql") {
      await this.runWrite(
        `INSERT INTO ${this.tables.mfa} (user_id, record_type, record_key, payload, numeric_value) VALUES (${placeholders}) ON DUPLICATE KEY UPDATE payload = VALUES(payload), numeric_value = CASE WHEN numeric_value IS NULL THEN VALUES(numeric_value) WHEN VALUES(numeric_value) IS NULL THEN numeric_value WHEN VALUES(numeric_value) > numeric_value THEN VALUES(numeric_value) ELSE numeric_value END`,
        params,
      );
      return;
    }

    await this.runWrite(
      `INSERT INTO ${this.tables.mfa} (user_id, record_type, record_key, payload, numeric_value) VALUES (${placeholders}) ON CONFLICT (user_id, record_type, record_key) DO UPDATE SET payload = EXCLUDED.payload, numeric_value = CASE WHEN ${this.tables.mfa}.numeric_value IS NULL THEN EXCLUDED.numeric_value WHEN EXCLUDED.numeric_value IS NULL THEN ${this.tables.mfa}.numeric_value WHEN EXCLUDED.numeric_value > ${this.tables.mfa}.numeric_value THEN EXCLUDED.numeric_value ELSE ${this.tables.mfa}.numeric_value END`,
      params,
    );
  }

  async claimTotpStep(userId: string, step: number): Promise<boolean> {
    const res = await this.runWrite(
      `UPDATE ${this.tables.mfa} SET numeric_value = ${this.p(1)} WHERE user_id = ${this.p(2)} AND record_type = ${this.p(3)} AND record_key = ${this.p(4)} AND (numeric_value IS NULL OR numeric_value < ${this.p(5)})`,
      [step, userId, "totp", "default", step],
    );
    return res.affectedRows > 0;
  }

  async saveRecoveryCodes(userId: string, hashes: string[]): Promise<void> {
    await this.runWrite(
      `DELETE FROM ${this.tables.mfa} WHERE user_id = ${this.p(1)} AND record_type = ${this.p(2)}`,
      [userId, "recovery_code"],
    );
    const uniqueHashes = [...new Set(hashes)];
    for (const hash of uniqueHashes) {
      const placeholders = [1, 2, 3].map((i) => this.p(i)).join(", ");
      if (this.dialect === "mysql") {
        await this.runWrite(
          `INSERT IGNORE INTO ${this.tables.mfa} (user_id, record_type, record_key) VALUES (${placeholders})`,
          [userId, "recovery_code", hash],
        );
      } else {
        await this.runWrite(
          `INSERT INTO ${this.tables.mfa} (user_id, record_type, record_key) VALUES (${placeholders}) ON CONFLICT (user_id, record_type, record_key) DO NOTHING`,
          [userId, "recovery_code", hash],
        );
      }
    }
  }

  async consumeRecoveryCode(userId: string, hash: string): Promise<boolean> {
    const res = await this.runWrite(
      `DELETE FROM ${this.tables.mfa} WHERE user_id = ${this.p(1)} AND record_type = ${this.p(2)} AND record_key = ${this.p(3)}`,
      [userId, "recovery_code", hash],
    );
    return res.affectedRows > 0;
  }

  async countRecoveryCodes(userId: string): Promise<number> {
    const { rows } = await this.runQuery<{ cnt: number | string }>(
      `SELECT COUNT(*) AS cnt FROM ${this.tables.mfa} WHERE user_id = ${this.p(1)} AND record_type = ${this.p(2)}`,
      [userId, "recovery_code"],
    );
    return Number(rows[0]?.cnt ?? 0);
  }

  async recordMfaFailure(
    userId: string,
    windowMs: number,
    now: number,
  ): Promise<number> {
    const failureKey = `${now}:${crypto.randomUUID()}`;
    const placeholders = [1, 2, 3, 4].map((i) => this.p(i)).join(", ");
    // Record before counting so concurrent attempts commit independently.
    await this.runWrite(
      `INSERT INTO ${this.tables.mfa} (user_id, record_type, record_key, numeric_value) VALUES (${placeholders})`,
      [userId, "mfa_failure", failureKey, now],
    );
    const cutoff = now - windowMs;
    await this.runWrite(
      `DELETE FROM ${this.tables.mfa} WHERE user_id = ${this.p(1)} AND record_type = ${this.p(2)} AND numeric_value <= ${this.p(3)}`,
      [userId, "mfa_failure", cutoff],
    );
    const { rows } = await this.runQuery<{ cnt: number | string }>(
      `SELECT COUNT(*) AS cnt FROM ${this.tables.mfa} WHERE user_id = ${this.p(1)} AND record_type = ${this.p(2)} AND numeric_value > ${this.p(3)}`,
      [userId, "mfa_failure", cutoff],
    );
    return Number(rows[0]?.cnt ?? 0);
  }

  async countMfaFailures(
    userId: string,
    windowMs: number,
    now: number,
  ): Promise<number> {
    const cutoff = now - windowMs;
    const { rows } = await this.runQuery<{ cnt: number | string }>(
      `SELECT COUNT(*) AS cnt FROM ${this.tables.mfa} WHERE user_id = ${this.p(1)} AND record_type = ${this.p(2)} AND numeric_value > ${this.p(3)}`,
      [userId, "mfa_failure", cutoff],
    );
    return Number(rows[0]?.cnt ?? 0);
  }

  async clearMfaFailures(userId: string): Promise<void> {
    await this.runWrite(
      `DELETE FROM ${this.tables.mfa} WHERE user_id = ${this.p(1)} AND record_type = ${this.p(2)}`,
      [userId, "mfa_failure"],
    );
  }

  // ------------------------------------------------------------------ MagicLinkStore

  async saveMagicLink(record: MagicLinkRecord): Promise<void> {
    await this.runWrite(
      `DELETE FROM ${this.tables.magicLinks} WHERE expires_at <= ${this.p(1)}`,
      [record.createdAt.getTime()],
    );
    const params = [
      record.id,
      record.email,
      record.createdAt.getTime(),
      record.expiresAt.getTime(),
      record.redirectTo ?? null,
    ];
    const placeholders = [1, 2, 3, 4, 5].map((i) => this.p(i)).join(", ");

    if (this.dialect === "mysql") {
      await this.runWrite(
        `INSERT INTO ${this.tables.magicLinks} (id, email, created_at, expires_at, redirect_to) VALUES (${placeholders}) ON DUPLICATE KEY UPDATE email = VALUES(email), created_at = VALUES(created_at), expires_at = VALUES(expires_at), redirect_to = VALUES(redirect_to)`,
        params,
      );
    } else {
      await this.runWrite(
        `INSERT INTO ${this.tables.magicLinks} (id, email, created_at, expires_at, redirect_to) VALUES (${placeholders}) ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, created_at = EXCLUDED.created_at, expires_at = EXCLUDED.expires_at, redirect_to = EXCLUDED.redirect_to`,
        params,
      );
    }

    await this.enforcePendingCap(this.tables.magicLinks, "id");
  }

  async consumeMagicLink(id: string): Promise<MagicLinkRecord | undefined> {
    if (this.dialect === "mysql") {
      const { rows } = await this.runQuery<MagicLinkRow>(
        `SELECT id, email, created_at, expires_at, redirect_to FROM ${this.tables.magicLinks} WHERE id = ${this.p(1)}`,
        [id],
      );
      if (!rows[0]) {
        return undefined;
      }
      const del = await this.runWrite(
        `DELETE FROM ${this.tables.magicLinks} WHERE id = ${this.p(1)}`,
        [id],
      );
      return del.affectedRows > 0 ? this.mapMagicLinkRow(rows[0]) : undefined;
    }

    const { rows } = await this.runQuery<MagicLinkRow>(
      `DELETE FROM ${this.tables.magicLinks} WHERE id = ${this.p(1)} RETURNING id, email, created_at, expires_at, redirect_to`,
      [id],
    );
    return rows[0] ? this.mapMagicLinkRow(rows[0]) : undefined;
  }

  // ------------------------------------------------------------------ OidcStateStore

  async saveOidcState(transaction: OidcTransaction): Promise<void> {
    await this.runWrite(
      `DELETE FROM ${this.tables.oidcStates} WHERE expires_at <= ${this.p(1)}`,
      [transaction.createdAt.getTime()],
    );
    const params = [
      transaction.state,
      transaction.provider,
      transaction.nonce ?? null,
      transaction.codeVerifier,
      transaction.redirectTo ?? null,
      transaction.createdAt.getTime(),
      transaction.expiresAt.getTime(),
      transaction.link !== undefined ? JSON.stringify(transaction.link) : null,
    ];
    const placeholders = [1, 2, 3, 4, 5, 6, 7, 8]
      .map((i) => this.p(i))
      .join(", ");

    if (this.dialect === "mysql") {
      await this.runWrite(
        `INSERT INTO ${this.tables.oidcStates} (state, provider, nonce, code_verifier, redirect_to, created_at, expires_at, link_json) VALUES (${placeholders}) ON DUPLICATE KEY UPDATE provider = VALUES(provider), nonce = VALUES(nonce), code_verifier = VALUES(code_verifier), redirect_to = VALUES(redirect_to), created_at = VALUES(created_at), expires_at = VALUES(expires_at), link_json = VALUES(link_json)`,
        params,
      );
    } else {
      await this.runWrite(
        `INSERT INTO ${this.tables.oidcStates} (state, provider, nonce, code_verifier, redirect_to, created_at, expires_at, link_json) VALUES (${placeholders}) ON CONFLICT (state) DO UPDATE SET provider = EXCLUDED.provider, nonce = EXCLUDED.nonce, code_verifier = EXCLUDED.code_verifier, redirect_to = EXCLUDED.redirect_to, created_at = EXCLUDED.created_at, expires_at = EXCLUDED.expires_at, link_json = EXCLUDED.link_json`,
        params,
      );
    }

    await this.enforcePendingCap(this.tables.oidcStates, "state");
  }

  async consumeOidcState(state: string): Promise<OidcTransaction | undefined> {
    if (this.dialect === "mysql") {
      const { rows } = await this.runQuery<OidcStateRow>(
        `SELECT state, provider, nonce, code_verifier, redirect_to, created_at, expires_at, link_json FROM ${this.tables.oidcStates} WHERE state = ${this.p(1)}`,
        [state],
      );
      if (!rows[0]) {
        return undefined;
      }
      const del = await this.runWrite(
        `DELETE FROM ${this.tables.oidcStates} WHERE state = ${this.p(1)}`,
        [state],
      );
      return del.affectedRows > 0 ? this.mapOidcStateRow(rows[0]) : undefined;
    }

    const { rows } = await this.runQuery<OidcStateRow>(
      `DELETE FROM ${this.tables.oidcStates} WHERE state = ${this.p(1)} RETURNING state, provider, nonce, code_verifier, redirect_to, created_at, expires_at, link_json`,
      [state],
    );
    return rows[0] ? this.mapOidcStateRow(rows[0]) : undefined;
  }

  // ------------------------------------------------------------------ EmailTokenStore

  async saveEmailToken(record: EmailTokenRecord): Promise<void> {
    await this.runWrite(
      `DELETE FROM ${this.tables.emailTokens} WHERE expires_at <= ${this.p(1)}`,
      [record.createdAt.getTime()],
    );
    const params = [
      record.id,
      record.purpose,
      record.userId,
      record.email,
      record.fingerprint ?? null,
      record.createdAt.getTime(),
      record.expiresAt.getTime(),
    ];
    const placeholders = [1, 2, 3, 4, 5, 6, 7]
      .map((i) => this.p(i))
      .join(", ");

    if (this.dialect === "mysql") {
      await this.runWrite(
        `INSERT INTO ${this.tables.emailTokens} (id, purpose, user_id, email, fingerprint, created_at, expires_at) VALUES (${placeholders}) ON DUPLICATE KEY UPDATE purpose = VALUES(purpose), user_id = VALUES(user_id), email = VALUES(email), fingerprint = VALUES(fingerprint), created_at = VALUES(created_at), expires_at = VALUES(expires_at)`,
        params,
      );
    } else {
      await this.runWrite(
        `INSERT INTO ${this.tables.emailTokens} (id, purpose, user_id, email, fingerprint, created_at, expires_at) VALUES (${placeholders}) ON CONFLICT (id) DO UPDATE SET purpose = EXCLUDED.purpose, user_id = EXCLUDED.user_id, email = EXCLUDED.email, fingerprint = EXCLUDED.fingerprint, created_at = EXCLUDED.created_at, expires_at = EXCLUDED.expires_at`,
        params,
      );
    }

    await this.enforcePendingCap(this.tables.emailTokens, "id");
  }

  async consumeEmailToken(
    id: string,
    purpose: EmailTokenPurpose,
  ): Promise<EmailTokenRecord | undefined> {
    if (this.dialect === "mysql") {
      const { rows } = await this.runQuery<EmailTokenRow>(
        `SELECT id, purpose, user_id, email, fingerprint, created_at, expires_at FROM ${this.tables.emailTokens} WHERE id = ${this.p(1)} AND purpose = ${this.p(2)}`,
        [id, purpose],
      );
      if (!rows[0]) {
        return undefined;
      }
      const del = await this.runWrite(
        `DELETE FROM ${this.tables.emailTokens} WHERE id = ${this.p(1)} AND purpose = ${this.p(2)}`,
        [id, purpose],
      );
      return del.affectedRows > 0 ? this.mapEmailTokenRow(rows[0]) : undefined;
    }

    const { rows } = await this.runQuery<EmailTokenRow>(
      `DELETE FROM ${this.tables.emailTokens} WHERE id = ${this.p(1)} AND purpose = ${this.p(2)} RETURNING id, purpose, user_id, email, fingerprint, created_at, expires_at`,
      [id, purpose],
    );
    return rows[0] ? this.mapEmailTokenRow(rows[0]) : undefined;
  }

  async deleteUserEmailTokens(
    userId: string,
    purpose: EmailTokenPurpose,
  ): Promise<void> {
    await this.runWrite(
      `DELETE FROM ${this.tables.emailTokens} WHERE user_id = ${this.p(1)} AND purpose = ${this.p(2)}`,
      [userId, purpose],
    );
  }

  // ------------------------------------------------------------------ PasskeyStore

  private mapPasskeyCredentialRow(row: PasskeyRow): PasskeyCredential {
    const parsed = JSON.parse(row.payload) as SerializedPasskeyPayload;
    const record: PasskeyCredential = {
      id: row.id,
      userId: row.user_id ?? "",
      publicKey: parsed.publicKey,
      algorithm: parsed.algorithm,
      counter: Number(row.counter),
      createdAt: new Date(Number(row.created_at)),
    };
    if (parsed.transports !== undefined) {
      record.transports = [...parsed.transports];
    }
    if (parsed.deviceType !== undefined) {
      record.deviceType = parsed.deviceType;
    }
    if (parsed.backedUp !== undefined) {
      record.backedUp = parsed.backedUp;
    }
    if (parsed.aaguid !== undefined) {
      record.aaguid = parsed.aaguid;
    }
    if (parsed.name !== undefined) {
      record.name = parsed.name;
    }
    if (row.last_used_at !== null && row.last_used_at !== undefined) {
      record.lastUsedAt = new Date(Number(row.last_used_at));
    }
    return record;
  }

  private mapPasskeyChallengeRow(
    row: PasskeyRow,
    type: PasskeyChallengeType,
  ): PasskeyChallengeRecord {
    const record: PasskeyChallengeRecord = {
      challenge: row.id,
      type,
      createdAt: new Date(Number(row.created_at)),
      expiresAt: new Date(Number(row.expires_at ?? 0)),
    };
    if (row.user_id !== null && row.user_id !== undefined) {
      record.userId = row.user_id;
    }
    return record;
  }

  async getPasskey(
    credentialId: string,
  ): Promise<PasskeyCredential | undefined> {
    const { rows } = await this.runQuery<PasskeyRow>(
      `SELECT id, record_type, user_id, payload, counter, created_at, last_used_at, expires_at FROM ${this.tables.passkeys} WHERE id = ${this.p(1)} AND record_type = ${this.p(2)}`,
      [credentialId, "credential"],
    );
    return rows[0] ? this.mapPasskeyCredentialRow(rows[0]) : undefined;
  }

  async savePasskey(credential: PasskeyCredential): Promise<void> {
    const payload: SerializedPasskeyPayload = {
      publicKey: credential.publicKey,
      algorithm: credential.algorithm,
      ...(credential.transports !== undefined
        ? { transports: [...credential.transports] }
        : {}),
      ...(credential.deviceType !== undefined
        ? { deviceType: credential.deviceType }
        : {}),
      ...(credential.backedUp !== undefined
        ? { backedUp: credential.backedUp }
        : {}),
      ...(credential.aaguid !== undefined ? { aaguid: credential.aaguid } : {}),
      ...(credential.name !== undefined ? { name: credential.name } : {}),
    };
    const params = [
      credential.id,
      "credential",
      credential.userId,
      JSON.stringify(payload),
      credential.counter,
      credential.createdAt.getTime(),
      credential.lastUsedAt ? credential.lastUsedAt.getTime() : null,
      null,
    ];
    const placeholders = [1, 2, 3, 4, 5, 6, 7, 8]
      .map((i) => this.p(i))
      .join(", ");

    if (this.dialect === "mysql") {
      await this.runWrite(
        `INSERT INTO ${this.tables.passkeys} (id, record_type, user_id, payload, counter, created_at, last_used_at, expires_at) VALUES (${placeholders}) ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), payload = VALUES(payload), counter = VALUES(counter), created_at = VALUES(created_at), last_used_at = VALUES(last_used_at)`,
        params,
      );
      return;
    }

    await this.runWrite(
      `INSERT INTO ${this.tables.passkeys} (id, record_type, user_id, payload, counter, created_at, last_used_at, expires_at) VALUES (${placeholders}) ON CONFLICT (id, record_type) DO UPDATE SET user_id = EXCLUDED.user_id, payload = EXCLUDED.payload, counter = EXCLUDED.counter, created_at = EXCLUDED.created_at, last_used_at = EXCLUDED.last_used_at`,
      params,
    );
  }

  async listUserPasskeys(userId: string): Promise<PasskeyCredential[]> {
    const { rows } = await this.runQuery<PasskeyRow>(
      `SELECT id, record_type, user_id, payload, counter, created_at, last_used_at, expires_at FROM ${this.tables.passkeys} WHERE user_id = ${this.p(1)} AND record_type = ${this.p(2)}`,
      [userId, "credential"],
    );
    return rows.map((row) => this.mapPasskeyCredentialRow(row));
  }

  async updatePasskeyCounter(
    credentialId: string,
    counter: number,
    lastUsedAt?: Date,
  ): Promise<boolean> {
    const lastUsedMs = lastUsedAt ? lastUsedAt.getTime() : null;
    if (counter === 0) {
      const res = await this.runWrite(
        `UPDATE ${this.tables.passkeys} SET last_used_at = COALESCE(${this.p(1)}, last_used_at) WHERE id = ${this.p(2)} AND record_type = ${this.p(3)} AND counter = 0`,
        [lastUsedMs, credentialId, "credential"],
      );
      return res.affectedRows > 0;
    }

    const res = await this.runWrite(
      `UPDATE ${this.tables.passkeys} SET counter = ${this.p(1)}, last_used_at = COALESCE(${this.p(2)}, last_used_at) WHERE id = ${this.p(3)} AND record_type = ${this.p(4)} AND counter < ${this.p(5)}`,
      [counter, lastUsedMs, credentialId, "credential", counter],
    );
    return res.affectedRows > 0;
  }

  async deletePasskey(credentialId: string): Promise<boolean> {
    const res = await this.runWrite(
      `DELETE FROM ${this.tables.passkeys} WHERE id = ${this.p(1)} AND record_type = ${this.p(2)}`,
      [credentialId, "credential"],
    );
    return res.affectedRows > 0;
  }

  async deleteUserPasskeys(userId: string): Promise<void> {
    await this.runWrite(
      `DELETE FROM ${this.tables.passkeys} WHERE user_id = ${this.p(1)} AND record_type = ${this.p(2)}`,
      [userId, "credential"],
    );
  }

  async savePasskeyChallenge(record: PasskeyChallengeRecord): Promise<void> {
    await this.runWrite(
      `DELETE FROM ${this.tables.passkeys} WHERE record_type IN (${this.p(1)}, ${this.p(2)}) AND expires_at <= ${this.p(3)}`,
      [
        "challenge:registration",
        "challenge:authentication",
        record.createdAt.getTime(),
      ],
    );

    const recordType = `challenge:${record.type}`;
    const params = [
      record.challenge,
      recordType,
      record.userId ?? null,
      JSON.stringify({ type: record.type }),
      0,
      record.createdAt.getTime(),
      null,
      record.expiresAt.getTime(),
    ];
    const placeholders = [1, 2, 3, 4, 5, 6, 7, 8]
      .map((i) => this.p(i))
      .join(", ");

    if (this.dialect === "mysql") {
      await this.runWrite(
        `INSERT INTO ${this.tables.passkeys} (id, record_type, user_id, payload, counter, created_at, last_used_at, expires_at) VALUES (${placeholders}) ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), payload = VALUES(payload), created_at = VALUES(created_at), expires_at = VALUES(expires_at)`,
        params,
      );
      return;
    }

    await this.runWrite(
      `INSERT INTO ${this.tables.passkeys} (id, record_type, user_id, payload, counter, created_at, last_used_at, expires_at) VALUES (${placeholders}) ON CONFLICT (id, record_type) DO UPDATE SET user_id = EXCLUDED.user_id, payload = EXCLUDED.payload, created_at = EXCLUDED.created_at, expires_at = EXCLUDED.expires_at`,
      params,
    );
  }

  async consumePasskeyChallenge(
    challenge: string,
    type: PasskeyChallengeType,
  ): Promise<PasskeyChallengeRecord | undefined> {
    const recordType = `challenge:${type}`;
    if (this.dialect === "mysql") {
      const { rows } = await this.runQuery<PasskeyRow>(
        `SELECT id, record_type, user_id, payload, counter, created_at, last_used_at, expires_at FROM ${this.tables.passkeys} WHERE id = ${this.p(1)} AND record_type = ${this.p(2)}`,
        [challenge, recordType],
      );
      if (!rows[0]) {
        return undefined;
      }
      const del = await this.runWrite(
        `DELETE FROM ${this.tables.passkeys} WHERE id = ${this.p(1)} AND record_type = ${this.p(2)}`,
        [challenge, recordType],
      );
      return del.affectedRows > 0
        ? this.mapPasskeyChallengeRow(rows[0], type)
        : undefined;
    }

    const { rows } = await this.runQuery<PasskeyRow>(
      `DELETE FROM ${this.tables.passkeys} WHERE id = ${this.p(1)} AND record_type = ${this.p(2)} RETURNING id, record_type, user_id, payload, counter, created_at, last_used_at, expires_at`,
      [challenge, recordType],
    );
    return rows[0] ? this.mapPasskeyChallengeRow(rows[0], type) : undefined;
  }
}
