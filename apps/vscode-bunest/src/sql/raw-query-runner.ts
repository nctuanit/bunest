import {
  existsSyncPath,
  join,
  readDirSyncEntries,
  readTextSync,
  relative,
  resolve,
  runSubprocess,
} from "@bunest/core";

export type SqlDialect =
  | "sqlite"
  | "postgres"
  | "cockroachdb"
  | "mysql"
  | "mariadb"
  | "libsql"
  | "d1";

export interface SqlConnectionConfig {
  readonly name?: string;
  readonly dialect?: SqlDialect;
  readonly url?: string;
  readonly authToken?: string;
  readonly accountId?: string;
  readonly databaseId?: string;
  readonly apiToken?: string;
  readonly apiBaseUrl?: string;
  readonly headers?: Record<string, string>;
}

export interface ExtractedSqlPlaceholders {
  readonly named: readonly string[];
  readonly positionalCount: number;
  readonly style: "none" | "named" | "positional";
}

export interface CompiledSqlQuery {
  readonly compiledSql: string;
  readonly values: readonly unknown[];
}

export interface DatabaseCandidate {
  readonly label: string;
  readonly url: string;
  readonly dialect: SqlDialect;
  readonly source: string;
  readonly connection: SqlConnectionConfig;
}

export interface ExecuteRawSqlOptions {
  readonly sql: string;
  readonly databaseUrl?: string;
  readonly connection?: SqlConnectionConfig;
  readonly cwd: string;
  readonly params?: Record<string, unknown> | readonly unknown[];
  readonly maxRows?: number;
  readonly timeoutMs?: number;
  readonly bunExecutable?: string;
  readonly fetchImpl?: typeof fetch;
}

export interface ExecuteRawSqlResult {
  readonly ok: boolean;
  readonly dialect: SqlDialect;
  readonly compiledSql: string;
  readonly rows: readonly Record<string, unknown>[];
  readonly columns: readonly string[];
  readonly rowCount: number;
  readonly affectedRows?: number;
  readonly truncated: boolean;
  readonly elapsedMs: number;
  readonly error?: string;
}

const ENV_FILES = [".env.local", ".env.development", ".env"] as const;

const ENV_DB_KEYS = [
  "DATABASE_URL",
  "DB_URL",
  "POSTGRES_URL",
  "POSTGRESQL_URL",
  "COCKROACHDB_URL",
  "COCKROACH_URL",
  "MYSQL_URL",
  "MARIADB_URL",
  "LIBSQL_URL",
  "TURSO_DATABASE_URL",
  "SQLITE_URL",
  "SQLITE_PATH",
  "DATABASE_PATH",
  "DB_PATH",
] as const;

const WRITE_SQL_RE =
  /^(?:INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER|CREATE|REPLACE|MERGE|VACUUM|ATTACH|DETACH)\b/i;

const CTE_WRITE_RE =
  /^WITH\b[\s\S]*?\)\s*(?:INSERT|UPDATE|DELETE|MERGE)\b/i;

const SQLITE_FILE_EXT_RE = /\.(?:sqlite|sqlite3|db)$/i;

/**
 * Strips leading SQL line (`--`) and block (`/* ... *\/`) comments.
 */
function stripLeadingSqlComments(sql: string): string {
  let i = 0;
  const n = sql.length;
  while (i < n) {
    while (i < n && /\s/.test(sql[i]!)) i++;
    if (sql[i] === "-" && sql[i + 1] === "-") {
      i += 2;
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    if (sql[i] === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    break;
  }
  return sql.slice(i);
}

/**
 * Detects whether a SQL statement performs writes or DDL mutations.
 */
export function isWriteSqlStatement(sql: string): boolean {
  const trimmed = stripLeadingSqlComments(sql).trim();
  if (!trimmed) return false;
  return WRITE_SQL_RE.test(trimmed) || CTE_WRITE_RE.test(trimmed);
}

/**
 * Infers the SQL dialect from a connection URL, explicit dialect, or SQLite file path.
 */
export function detectSqlDialect(
  databaseUrl: string,
  explicitDialect?: SqlDialect,
): SqlDialect {
  if (explicitDialect) return explicitDialect;
  const lower = databaseUrl.trim().toLowerCase();
  if (lower.startsWith("cockroachdb://") || lower.startsWith("cockroach://")) {
    return "cockroachdb";
  }
  if (lower.startsWith("postgres://") || lower.startsWith("postgresql://")) {
    return "postgres";
  }
  if (lower.startsWith("mariadb://")) {
    return "mariadb";
  }
  if (lower.startsWith("mysql://") || lower.startsWith("mysql2://")) {
    return "mysql";
  }
  if (
    lower.startsWith("libsql://") ||
    lower.includes(".turso.io") ||
    ((lower.startsWith("http://") || lower.startsWith("https://")) &&
      !lower.includes("api.cloudflare.com"))
  ) {
    return "libsql";
  }
  if (lower.startsWith("d1://") || lower.includes("api.cloudflare.com")) {
    return "d1";
  }
  return "sqlite";
}

/**
 * Resolves relative SQLite paths against `cwd` while preserving remote URLs
 * (`postgres://`, `cockroachdb://`, `mysql://`, `mariadb://`, `libsql://`, `d1://`) and `:memory:`.
 */
export function normalizeDatabaseUrl(raw: string, cwd: string): string {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === ":memory:") {
    return ":memory:";
  }
  const lower = trimmed.toLowerCase();
  if (
    lower.startsWith("postgres://") ||
    lower.startsWith("postgresql://") ||
    lower.startsWith("cockroachdb://") ||
    lower.startsWith("cockroach://") ||
    lower.startsWith("mysql://") ||
    lower.startsWith("mysql2://") ||
    lower.startsWith("mariadb://") ||
    lower.startsWith("libsql://") ||
    lower.startsWith("http://") ||
    lower.startsWith("https://") ||
    lower.startsWith("d1://")
  ) {
    return trimmed;
  }
  if (lower.startsWith("sqlite://")) {
    const rest = trimmed.slice("sqlite://".length);
    if (!rest || rest === ":memory:") return ":memory:";
    if (rest.startsWith("/")) return rest;
    return resolve(cwd, rest);
  }
  if (lower.startsWith("file:")) {
    const rest = trimmed.slice("file:".length);
    if (!rest || rest === ":memory:") return ":memory:";
    return resolve(cwd, rest);
  }
  return resolve(cwd, trimmed);
}

/**
 * Redacts password credentials in connection URLs for safe UI display.
 */
export function maskDatabaseUrl(
  databaseUrl: string,
  cwd?: string,
  explicitDialect?: SqlDialect,
): string {
  const trimmed = databaseUrl.trim();
  if (trimmed === ":memory:") return ":memory:";
  const dialect = detectSqlDialect(trimmed, explicitDialect);
  if (dialect === "sqlite") {
    if (cwd) {
      const rel = relative(cwd, trimmed).replace(/\\/g, "/");
      if (rel && !rel.startsWith("..")) return `./${rel}`;
    }
    return trimmed;
  }
  try {
    const u = new URL(trimmed);
    if (u.password) {
      u.password = "***";
    }
    return u.toString();
  } catch {
    return trimmed.replace(/(:\/\/[^:@/\s]+):([^@/\s]+)@/, "$1:***@");
  }
}

/**
 * Quote- and comment-aware scanner for `:named`, `$1`, and `?` SQL placeholders.
 * Skips single/double/backtick quotes, SQL comments, and Postgres `::type` casts.
 */
export function extractSqlPlaceholders(sql: string): ExtractedSqlPlaceholders {
  const named: string[] = [];
  const namedSeen = new Set<string>();
  let positionalCount = 0;
  let maxDollarIndex = 0;

  let i = 0;
  const n = sql.length;

  while (i < n) {
    const ch = sql[i]!;

    // Single-line comment `-- ...`
    if (ch === "-" && sql[i + 1] === "-") {
      i += 2;
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }

    // Block comment `/* ... */`
    if (ch === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      continue;
    }

    // Quoted strings / identifiers
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      i++;
      while (i < n) {
        if (sql[i] === "\\" && i + 1 < n) {
          i += 2;
          continue;
        }
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    // Postgres cast `::type` -> skip both colons
    if (ch === ":" && sql[i + 1] === ":") {
      i += 2;
      continue;
    }

    // Named placeholder `:name`
    if (ch === ":" && i + 1 < n && /[A-Za-z_]/.test(sql[i + 1]!)) {
      let j = i + 2;
      while (j < n && /[A-Za-z0-9_]/.test(sql[j]!)) j++;
      const name = sql.slice(i + 1, j);
      if (!namedSeen.has(name)) {
        namedSeen.add(name);
        named.push(name);
      }
      i = j;
      continue;
    }

    // Positional `$1`, `$2`, ...
    if (ch === "$" && i + 1 < n && /[1-9]/.test(sql[i + 1]!)) {
      let j = i + 2;
      while (j < n && /[0-9]/.test(sql[j]!)) j++;
      const idx = Number(sql.slice(i + 1, j));
      if (idx > maxDollarIndex) maxDollarIndex = idx;
      i = j;
      continue;
    }

    // Positional `?`
    if (ch === "?") {
      positionalCount++;
      i++;
      continue;
    }

    i++;
  }

  const totalPositional = Math.max(positionalCount, maxDollarIndex);
  const style =
    named.length > 0
      ? "named"
      : totalPositional > 0
        ? "positional"
        : "none";

  return {
    named,
    positionalCount: totalPositional,
    style,
  };
}

/**
 * Compiles `:named`, `$1`, and `?` placeholders into target dialect syntax
 * (`$1..$N` for PostgreSQL/CockroachDB, `?` for SQLite/MySQL/MariaDB/LibSQL/D1)
 * with ordered bound values.
 */
export function compileSqlForDialect(
  sql: string,
  dialect: SqlDialect,
  params?: Record<string, unknown> | readonly unknown[],
): CompiledSqlQuery {
  const usesDollar = dialect === "postgres" || dialect === "cockroachdb";
  const values: unknown[] = [];
  const isArray = Array.isArray(params);
  const namedMap =
    params && !isArray ? (params as Record<string, unknown>) : undefined;
  const posArr = isArray ? (params as readonly unknown[]) : undefined;

  let out = "";
  let i = 0;
  const n = sql.length;
  let nextPosIdx = 0;

  const emitPlaceholder = (val: unknown): void => {
    values.push(val);
    out += usesDollar ? `$${values.length}` : "?";
  };

  while (i < n) {
    const ch = sql[i]!;

    // Single-line comment
    if (ch === "-" && sql[i + 1] === "-") {
      const start = i;
      i += 2;
      while (i < n && sql[i] !== "\n") i++;
      out += sql.slice(start, i);
      continue;
    }

    // Block comment
    if (ch === "/" && sql[i + 1] === "*") {
      const start = i;
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      out += sql.slice(start, i);
      continue;
    }

    // Quoted strings / identifiers
    if (ch === "'" || ch === '"' || ch === "`") {
      const start = i;
      const quote = ch;
      i++;
      while (i < n) {
        if (sql[i] === "\\" && i + 1 < n) {
          i += 2;
          continue;
        }
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      out += sql.slice(start, i);
      continue;
    }

    // Postgres `::cast`
    if (ch === ":" && sql[i + 1] === ":") {
      out += "::";
      i += 2;
      continue;
    }

    // Named `:param`
    if (ch === ":" && i + 1 < n && /[A-Za-z_]/.test(sql[i + 1]!)) {
      let j = i + 2;
      while (j < n && /[A-Za-z0-9_]/.test(sql[j]!)) j++;
      const name = sql.slice(i + 1, j);
      const val = namedMap ? namedMap[name] : posArr?.[nextPosIdx++];
      emitPlaceholder(val ?? null);
      i = j;
      continue;
    }

    // Positional `$1`
    if (ch === "$" && i + 1 < n && /[1-9]/.test(sql[i + 1]!)) {
      let j = i + 2;
      while (j < n && /[0-9]/.test(sql[j]!)) j++;
      const oneBased = Number(sql.slice(i + 1, j));
      const val = posArr
        ? posArr[oneBased - 1]
        : namedMap?.[String(oneBased)] ?? namedMap?.[`$${oneBased}`];
      emitPlaceholder(val ?? null);
      i = j;
      continue;
    }

    // Positional `?`
    if (ch === "?") {
      const idx = nextPosIdx++;
      const val = posArr
        ? posArr[idx]
        : namedMap?.[String(idx + 1)] ?? namedMap?.[`$${idx + 1}`];
      emitPlaceholder(val ?? null);
      i++;
      continue;
    }

    out += ch;
    i++;
  }

  return { compiledSql: out, values };
}

/**
 * Coerces a user-entered string parameter into an appropriate SQL bind value
 * using the TypeScript parameter type hint when available.
 */
export function coerceSqlParamValue(raw: string, tsType?: string): unknown {
  const trimmed = raw.trim();
  const normalizedType = tsType?.toLowerCase().replace(/\s+/g, "") ?? "";

  const isExplicitString =
    normalizedType === "string" ||
    normalizedType === "string|null" ||
    normalizedType === "string|undefined";

  if ((trimmed === "null" || trimmed === "NULL") && normalizedType !== "string") {
    return null;
  }

  if (normalizedType.includes("number") || normalizedType.includes("bigint")) {
    if (trimmed !== "" && !Number.isNaN(Number(trimmed))) {
      return Number(trimmed);
    }
  }

  if (normalizedType.includes("boolean")) {
    if (trimmed.toLowerCase() === "true" || trimmed === "1") return true;
    if (trimmed.toLowerCase() === "false" || trimmed === "0") return false;
  }

  if (isExplicitString) {
    return raw;
  }

  if (!normalizedType) {
    if (trimmed === "true") return true;
    if (trimmed === "false") return false;
    if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  }

  return raw;
}

/**
 * Discovers candidate database connections from workspace `.env*` files
 * (PostgreSQL, CockroachDB, MySQL, MariaDB, LibSQL/Turso, Cloudflare D1, SQLite)
 * and local SQLite database files.
 */
export function discoverWorkspaceDatabaseCandidates(
  cwd: string,
): DatabaseCandidate[] {
  const candidates: DatabaseCandidate[] = [];
  const seen = new Set<string>();

  const pushCandidate = (
    rawUrl: string,
    source: string,
    extra: Partial<SqlConnectionConfig> = {},
  ): void => {
    const normalized = normalizeDatabaseUrl(rawUrl, cwd);
    const dialect = detectSqlDialect(normalized, extra.dialect);
    const dedupKey = `${dialect}:${normalized}`;
    if (seen.has(dedupKey)) return;
    seen.add(dedupKey);
    const connection: SqlConnectionConfig = {
      ...extra,
      dialect,
      url: normalized,
    };
    candidates.push({
      label: `${dialect}: ${maskDatabaseUrl(normalized, cwd, dialect)}`,
      url: normalized,
      dialect,
      source,
      connection,
    });
  };

  // 1. Scan .env files for standard DB connection keys
  for (const rel of ENV_FILES) {
    const abs = resolve(cwd, rel);
    if (!existsSyncPath(abs)) continue;
    let content: string;
    try {
      content = readTextSync(abs);
    } catch {
      continue;
    }
    const envMap = new Map<string, string>();
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const cleaned = line.startsWith("export ") ? line.slice(7).trim() : line;
      const eqIdx = cleaned.indexOf("=");
      if (eqIdx <= 0) continue;
      const k = cleaned.slice(0, eqIdx).trim();
      const v = cleaned
        .slice(eqIdx + 1)
        .trim()
        .replace(/^(['"])(.*)\1$/, "$2");
      if (v) envMap.set(k, v);
    }

    const libsqlToken =
      envMap.get("TURSO_AUTH_TOKEN") ?? envMap.get("LIBSQL_AUTH_TOKEN");

    for (const key of ENV_DB_KEYS) {
      const val = envMap.get(key);
      if (!val) continue;
      const dialect = detectSqlDialect(val);
      pushCandidate(val, `${rel} (${key})`, {
        dialect,
        ...(dialect === "libsql" && libsqlToken ? { authToken: libsqlToken } : {}),
      });
    }

    // Cloudflare D1 credentials in .env
    const d1AccountId =
      envMap.get("CLOUDFLARE_ACCOUNT_ID") ?? envMap.get("CF_ACCOUNT_ID");
    const d1DatabaseId =
      envMap.get("CLOUDFLARE_D1_DATABASE_ID") ?? envMap.get("D1_DATABASE_ID");
    const d1ApiToken =
      envMap.get("CLOUDFLARE_API_TOKEN") ??
      envMap.get("CLOUDFLARE_D1_API_TOKEN") ??
      envMap.get("CF_API_TOKEN");
    if (d1AccountId && d1DatabaseId) {
      pushCandidate(
        `d1://${d1AccountId}/${d1DatabaseId}`,
        `${rel} (CLOUDFLARE_D1)`,
        {
          dialect: "d1",
          accountId: d1AccountId,
          databaseId: d1DatabaseId,
          apiToken: d1ApiToken,
        },
      );
    }
  }

  // 2. Scan shallow workspace directories for SQLite files (.db / .sqlite / .sqlite3)
  const scanDirs = ["", "data", "db", "database", "storage", "prisma"];
  for (const sub of scanDirs) {
    const dir = sub ? resolve(cwd, sub) : resolve(cwd);
    if (!existsSyncPath(dir)) continue;
    let entries;
    try {
      entries = readDirSyncEntries(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!SQLITE_FILE_EXT_RE.test(entry.name)) continue;
      const abs = join(dir, entry.name);
      const rel = relative(cwd, abs).replace(/\\/g, "/");
      pushCandidate(abs, `workspace file (${rel})`, { dialect: "sqlite" });
    }
  }

  return candidates;
}

// ============================================================================
// HTTP-Native Drivers (LibSQL / Turso Hrana v2 & Cloudflare D1 REST API)
// ============================================================================

interface HranaValue {
  readonly type: "null" | "integer" | "float" | "text" | "blob";
  readonly value?: string | number;
  readonly base64?: string;
}

function encodeHranaValue(val: unknown): HranaValue {
  if (val === null || val === undefined) return { type: "null" };
  if (typeof val === "boolean") return { type: "integer", value: val ? "1" : "0" };
  if (typeof val === "bigint") return { type: "integer", value: val.toString() };
  if (typeof val === "number") {
    return Number.isInteger(val)
      ? { type: "integer", value: String(val) }
      : { type: "float", value: val };
  }
  if (val instanceof Date) return { type: "text", value: val.toISOString() };
  return { type: "text", value: String(val) };
}

function decodeHranaValue(val: HranaValue | undefined): unknown {
  if (!val || val.type === "null") return null;
  if (val.type === "integer") {
    const n = Number(val.value);
    return Number.isSafeInteger(n) ? n : String(val.value);
  }
  if (val.type === "float") return Number(val.value);
  if (val.type === "blob") return `<Blob ${val.base64?.length ?? 0} b64>`;
  return val.value ?? null;
}

async function executeLibSqlHttp(opts: {
  readonly url: string;
  readonly authToken?: string;
  readonly headers?: Record<string, string>;
  readonly compiledSql: string;
  readonly values: readonly unknown[];
  readonly maxRows: number;
  readonly timeoutMs: number;
  readonly fetchImpl: typeof fetch;
}): Promise<ExecuteRawSqlResult> {
  const startedAt = performance.now();
  const baseUrl = opts.url
    .trim()
    .replace(/^libsql:\/\//i, "https://")
    .replace(/\/+$/, "");

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(opts.headers ?? {}),
  };
  if (opts.authToken) {
    headers["Authorization"] = `Bearer ${opts.authToken}`;
  }

  try {
    const response = await opts.fetchImpl(`${baseUrl}/v2/pipeline`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(opts.timeoutMs),
      body: JSON.stringify({
        requests: [
          {
            type: "execute",
            stmt: {
              sql: opts.compiledSql,
              args: opts.values.map(encodeHranaValue),
            },
          },
          { type: "close" },
        ],
      }),
    });

    const elapsedMs = performance.now() - startedAt;
    if (!response.ok) {
      const text = await response.text().catch(() => response.statusText);
      return {
        ok: false,
        dialect: "libsql",
        compiledSql: opts.compiledSql,
        rows: [],
        columns: [],
        rowCount: 0,
        truncated: false,
        elapsedMs,
        error: `LibSQL Hrana HTTP ${response.status}: ${text}`,
      };
    }

    const parsed = (await response.json()) as {
      results?: Array<{
        type?: "ok" | "error";
        error?: { message?: string; code?: string };
        response?: {
          result?: {
            cols?: Array<{ name?: string | null }>;
            rows?: HranaValue[][];
            affected_row_count?: number;
          };
        };
      }>;
    };

    const first = parsed.results?.[0];
    if (first?.type === "error") {
      return {
        ok: false,
        dialect: "libsql",
        compiledSql: opts.compiledSql,
        rows: [],
        columns: [],
        rowCount: 0,
        truncated: false,
        elapsedMs,
        error:
          first.error?.message ??
          `LibSQL error (${first.error?.code ?? "UNKNOWN"})`,
      };
    }

    const result = first?.response?.result;
    const cols = (result?.cols ?? []).map((c, idx) => c.name ?? `col_${idx}`);
    const rawRows = result?.rows ?? [];
    const truncated = rawRows.length > opts.maxRows;
    const sliced = truncated ? rawRows.slice(0, opts.maxRows) : rawRows;

    const rows = sliced.map((r) => {
      const obj: Record<string, unknown> = {};
      for (let i = 0; i < cols.length; i++) {
        obj[cols[i]!] = decodeHranaValue(r[i]);
      }
      return obj;
    });

    return {
      ok: true,
      dialect: "libsql",
      compiledSql: opts.compiledSql,
      rows,
      columns: cols,
      rowCount: rawRows.length,
      affectedRows: result?.affected_row_count,
      truncated,
      elapsedMs,
    };
  } catch (err) {
    return {
      ok: false,
      dialect: "libsql",
      compiledSql: opts.compiledSql,
      rows: [],
      columns: [],
      rowCount: 0,
      truncated: false,
      elapsedMs: performance.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function parseD1Url(url: string): { accountId?: string; databaseId?: string } {
  const m = /^d1:\/\/([^/]+)\/([^/?#]+)/i.exec(url.trim());
  if (!m) return {};
  return { accountId: m[1], databaseId: m[2] };
}

async function executeCloudflareD1Http(opts: {
  readonly connection: SqlConnectionConfig;
  readonly compiledSql: string;
  readonly values: readonly unknown[];
  readonly maxRows: number;
  readonly timeoutMs: number;
  readonly fetchImpl: typeof fetch;
}): Promise<ExecuteRawSqlResult> {
  const startedAt = performance.now();
  const fromUrl = opts.connection.url ? parseD1Url(opts.connection.url) : {};
  const accountId = opts.connection.accountId ?? fromUrl.accountId;
  const databaseId = opts.connection.databaseId ?? fromUrl.databaseId;
  const apiToken = opts.connection.apiToken ?? opts.connection.authToken;

  if (!accountId || !databaseId || !apiToken) {
    return {
      ok: false,
      dialect: "d1",
      compiledSql: opts.compiledSql,
      rows: [],
      columns: [],
      rowCount: 0,
      truncated: false,
      elapsedMs: performance.now() - startedAt,
      error:
        'Cloudflare D1 requires `accountId`, `databaseId`, and `apiToken` (configure via `bunest.sql.connections` or `.env` `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_D1_DATABASE_ID`, `CLOUDFLARE_API_TOKEN`).',
    };
  }

  const base = (
    opts.connection.apiBaseUrl ?? "https://api.cloudflare.com/client/v4"
  ).replace(/\/+$/, "");
  const endpoint = `${base}/accounts/${accountId}/d1/database/${databaseId}/query`;

  const bound = opts.values.map((p) => {
    if (p === undefined) return null;
    if (typeof p === "boolean") return p ? 1 : 0;
    if (p instanceof Date) return p.toISOString();
    if (typeof p === "bigint") return Number(p);
    return p;
  });

  try {
    const response = await opts.fetchImpl(endpoint, {
      method: "POST",
      signal: AbortSignal.timeout(opts.timeoutMs),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiToken}`,
        ...(opts.connection.headers ?? {}),
      },
      body: JSON.stringify({ sql: opts.compiledSql, params: bound }),
    });

    const elapsedMs = performance.now() - startedAt;
    if (!response.ok) {
      const text = await response.text().catch(() => response.statusText);
      return {
        ok: false,
        dialect: "d1",
        compiledSql: opts.compiledSql,
        rows: [],
        columns: [],
        rowCount: 0,
        truncated: false,
        elapsedMs,
        error: `Cloudflare D1 HTTP ${response.status}: ${text}`,
      };
    }

    const data = (await response.json()) as {
      success?: boolean;
      errors?: Array<{ message?: string }>;
      result?: Array<{
        results?: Record<string, unknown>[];
        meta?: { changes?: number };
      }>;
    };

    if (data.success === false) {
      return {
        ok: false,
        dialect: "d1",
        compiledSql: opts.compiledSql,
        rows: [],
        columns: [],
        rowCount: 0,
        truncated: false,
        elapsedMs,
        error:
          data.errors?.map((e) => e.message).join("; ") ||
          "Cloudflare D1 query failed",
      };
    }

    const first = data.result?.[0];
    const allRows = first?.results ?? [];
    const truncated = allRows.length > opts.maxRows;
    const rows = truncated ? allRows.slice(0, opts.maxRows) : allRows;
    const colSet = new Set<string>();
    for (const r of rows) {
      for (const k of Object.keys(r)) colSet.add(k);
    }

    return {
      ok: true,
      dialect: "d1",
      compiledSql: opts.compiledSql,
      rows,
      columns: Array.from(colSet),
      rowCount: allRows.length,
      affectedRows: first?.meta?.changes,
      truncated,
      elapsedMs,
    };
  } catch (err) {
    return {
      ok: false,
      dialect: "d1",
      compiledSql: opts.compiledSql,
      rows: [],
      columns: [],
      rowCount: 0,
      truncated: false,
      elapsedMs: performance.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Inline Bun one-shot SQL execution script run via `bun -e`.
 * Supports SQLite, PostgreSQL, CockroachDB, MySQL, and MariaDB via native `Bun.SQL`.
 */
const BUN_SQL_RUNNER_SCRIPT = `
const rawInput = await new Response(Bun.stdin.stream()).text();
const payload = JSON.parse(rawInput);
const { dialect, databaseUrl, sql, values, maxRows } = payload;

const startedAt = performance.now();
let client;
try {
  if (dialect === "sqlite") {
    client = new Bun.SQL({ adapter: "sqlite", filename: databaseUrl });
  } else if (dialect === "mariadb") {
    client = new Bun.SQL({ adapter: "mariadb", url: databaseUrl });
  } else if (dialect === "cockroachdb") {
    const pgUrl = databaseUrl.replace(/^cockroach(?:db)?:\\/\\//i, "postgres://");
    client = new Bun.SQL(pgUrl);
  } else {
    client = new Bun.SQL(databaseUrl);
  }

  const rawResult = await client.unsafe(sql, values ?? []);
  const elapsedMs = performance.now() - startedAt;

  const isArrayLike = Array.isArray(rawResult);
  const allRows = isArrayLike ? Array.from(rawResult) : [];
  const truncated = allRows.length > maxRows;
  const sliced = truncated ? allRows.slice(0, maxRows) : allRows;

  const colSet = new Set();
  const normalizedRows = sliced.map((row) => {
    if (row && typeof row === "object" && !Array.isArray(row)) {
      const obj = {};
      for (const [k, v] of Object.entries(row)) {
        colSet.add(k);
        if (typeof v === "bigint") obj[k] = v.toString();
        else if (v instanceof Date) obj[k] = v.toISOString();
        else if (v instanceof Uint8Array) obj[k] = "<Buffer " + v.byteLength + " bytes>";
        else obj[k] = v;
      }
      return obj;
    }
    colSet.add("value");
    return { value: row };
  });

  const affectedRows =
    typeof rawResult?.count === "number"
      ? rawResult.count
      : typeof rawResult?.affectedRows === "number"
        ? rawResult.affectedRows
        : typeof rawResult?.changes === "number"
          ? rawResult.changes
          : undefined;

  console.log(
    JSON.stringify({
      ok: true,
      dialect,
      rows: normalizedRows,
      columns: Array.from(colSet),
      rowCount: allRows.length,
      affectedRows,
      truncated,
      elapsedMs,
    }),
  );
} catch (err) {
  const elapsedMs = performance.now() - startedAt;
  console.log(
    JSON.stringify({
      ok: false,
      dialect,
      rows: [],
      columns: [],
      rowCount: 0,
      truncated: false,
      elapsedMs,
      error: err instanceof Error ? err.message : String(err),
    }),
  );
} finally {
  if (client && typeof client.close === "function") {
    try {
      await client.close();
    } catch {
      // ignore close errors
    }
  }
}
`;

/**
 * Executes a raw SQL query across SQLite, PostgreSQL, CockroachDB, MySQL,
 * MariaDB, LibSQL/Turso, and Cloudflare D1 with zero external npm dependencies.
 */
export async function executeRawSql(
  options: ExecuteRawSqlOptions,
): Promise<ExecuteRawSqlResult> {
  const rawUrl = options.connection?.url ?? options.databaseUrl ?? "";
  const normalizedUrl =
    rawUrl || !options.connection?.accountId
      ? normalizeDatabaseUrl(rawUrl, options.cwd)
      : `d1://${options.connection.accountId}/${options.connection.databaseId ?? ""}`;
  const dialect = detectSqlDialect(normalizedUrl, options.connection?.dialect);
  const compiled = compileSqlForDialect(options.sql, dialect, options.params);
  const maxRows = options.maxRows ?? 500;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const fetchImpl = options.fetchImpl ?? fetch;

  if (dialect === "libsql") {
    return executeLibSqlHttp({
      url: normalizedUrl,
      authToken: options.connection?.authToken,
      headers: options.connection?.headers,
      compiledSql: compiled.compiledSql,
      values: compiled.values,
      maxRows,
      timeoutMs,
      fetchImpl,
    });
  }

  if (dialect === "d1") {
    return executeCloudflareD1Http({
      connection: {
        ...options.connection,
        url: normalizedUrl,
      },
      compiledSql: compiled.compiledSql,
      values: compiled.values,
      maxRows,
      timeoutMs,
      fetchImpl,
    });
  }

  const bunBin = options.bunExecutable?.trim() || "bun";
  const payload = JSON.stringify({
    dialect,
    databaseUrl: normalizedUrl,
    sql: compiled.compiledSql,
    values: compiled.values,
    maxRows,
  });

  const startedAt = performance.now();
  try {
    const res = await runSubprocess([bunBin, "-e", BUN_SQL_RUNNER_SCRIPT], {
      cwd: options.cwd,
      stdin: payload,
      timeoutMs,
    });

    if (res.timedOut) {
      return {
        ok: false,
        dialect,
        compiledSql: compiled.compiledSql,
        rows: [],
        columns: [],
        rowCount: 0,
        truncated: false,
        elapsedMs: performance.now() - startedAt,
        error: `Query timed out after ${timeoutMs}ms.`,
      };
    }

    const stdoutLines = res.stdout
      .trim()
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0);
    const lastLine = stdoutLines[stdoutLines.length - 1];

    if (lastLine) {
      try {
        const parsed = JSON.parse(lastLine) as Partial<ExecuteRawSqlResult>;
        if (typeof parsed.ok === "boolean") {
          return {
            ok: parsed.ok,
            dialect,
            compiledSql: compiled.compiledSql,
            rows: parsed.rows ?? [],
            columns: parsed.columns ?? [],
            rowCount: parsed.rowCount ?? 0,
            affectedRows: parsed.affectedRows,
            truncated: parsed.truncated ?? false,
            elapsedMs: parsed.elapsedMs ?? performance.now() - startedAt,
            error: parsed.error,
          };
        }
      } catch {
        // fall through to stderr reporting
      }
    }

    return {
      ok: false,
      dialect,
      compiledSql: compiled.compiledSql,
      rows: [],
      columns: [],
      rowCount: 0,
      truncated: false,
      elapsedMs: performance.now() - startedAt,
      error:
        res.stderr.trim() ||
        res.stdout.trim() ||
        `Bun SQL runner exited with code ${res.exitCode}.`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const hint = message.includes("ENOENT")
      ? ` (Could not find "${bunBin}". Install Bun or configure "bunest.sql.bunPath".)`
      : "";
    return {
      ok: false,
      dialect,
      compiledSql: compiled.compiledSql,
      rows: [],
      columns: [],
      rowCount: 0,
      truncated: false,
      elapsedMs: performance.now() - startedAt,
      error: `${message}${hint}`,
    };
  }
}
