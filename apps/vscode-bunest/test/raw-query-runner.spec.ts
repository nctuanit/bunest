import { afterEach, describe, expect, it } from "bun:test";
import {
  dirname,
  join,
  mkdirSyncPath,
  removePath,
  resolve,
  writeTextSync,
} from "@bunest/core";
import {
  coerceSqlParamValue,
  compileSqlForDialect,
  detectSqlDialect,
  discoverWorkspaceDatabaseCandidates,
  executeRawSql,
  extractSqlPlaceholders,
  isWriteSqlStatement,
  maskDatabaseUrl,
  normalizeDatabaseUrl,
} from "../src/sql/raw-query-runner";

const tempDirs: string[] = [];

function createTempDir(files: Record<string, string> = {}): string {
  const base = Bun.env.TMPDIR ?? Bun.env.TEMP ?? "/tmp";
  const dir = join(base, `bunest-sql-runner-${crypto.randomUUID().slice(0, 8)}`);
  mkdirSyncPath(dir, { recursive: true });
  tempDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSyncPath(dirname(abs), { recursive: true });
    writeTextSync(abs, content);
  }
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await removePath(dir, { recursive: true, force: true });
  }
});

describe("vscode-bunest raw SQL runner utilities", () => {
  it("detects all 7 SQL dialects, normalizes SQLite paths, and masks credentials", () => {
    expect(detectSqlDialect("postgres://user:pass@localhost:5432/app")).toBe("postgres");
    expect(detectSqlDialect("postgresql://localhost/app")).toBe("postgres");
    expect(detectSqlDialect("cockroachdb://root@localhost:26257/defaultdb")).toBe("cockroachdb");
    expect(detectSqlDialect("mysql://root:secret@127.0.0.1:3306/app")).toBe("mysql");
    expect(detectSqlDialect("mariadb://root:secret@127.0.0.1:3306/app")).toBe("mariadb");
    expect(detectSqlDialect("libsql://my-db-org.turso.io")).toBe("libsql");
    expect(detectSqlDialect("https://my-db-org.turso.io")).toBe("libsql");
    expect(detectSqlDialect("d1://acc123/db456")).toBe("d1");
    expect(detectSqlDialect("./data/dev.sqlite")).toBe("sqlite");
    expect(detectSqlDialect(":memory:")).toBe("sqlite");

    expect(normalizeDatabaseUrl(":memory:", "/repo")).toBe(":memory:");
    expect(normalizeDatabaseUrl("sqlite://./dev.db", "/repo")).toBe(
      resolve("/repo", "dev.db"),
    );
    expect(normalizeDatabaseUrl("./dev.db", "/repo")).toBe(
      resolve("/repo", "dev.db"),
    );
    expect(normalizeDatabaseUrl("mariadb://root:pw@localhost/db", "/repo")).toBe(
      "mariadb://root:pw@localhost/db",
    );

    expect(maskDatabaseUrl("postgres://admin:s3cr3t@localhost:5432/mydb")).toBe(
      "postgres://admin:***@localhost:5432/mydb",
    );
    expect(maskDatabaseUrl("mariadb://root:pw@localhost:3306/app")).toBe(
      "mariadb://root:***@localhost:3306/app",
    );
    expect(maskDatabaseUrl("/repo/data/dev.db", "/repo")).toBe("./data/dev.db");
  });

  it("extracts and compiles :named, $1, and ? placeholders while skipping literals, comments, and ::casts", () => {
    const sql = `
      -- :ignoredComment
      SELECT id, created_at::date AS day, ':not_a_param' AS literal
      FROM users
      WHERE email = :email AND age >= :minAge /* :also_ignored */
    `;
    const ph = extractSqlPlaceholders(sql);
    expect(ph.style).toBe("named");
    expect(ph.named).toEqual(["email", "minAge"]);
    expect(ph.positionalCount).toBe(0);

    const sqliteCompiled = compileSqlForDialect(sql, "sqlite", {
      email: "alice@bunest.dev",
      minAge: 21,
    });
    expect(sqliteCompiled.compiledSql).toContain("created_at::date");
    expect(sqliteCompiled.compiledSql).toContain("':not_a_param'");
    expect(sqliteCompiled.compiledSql).toContain("WHERE email = ? AND age >= ?");
    expect(sqliteCompiled.values).toEqual(["alice@bunest.dev", 21]);

    const pgCompiled = compileSqlForDialect(sql, "postgres", {
      email: "alice@bunest.dev",
      minAge: 21,
    });
    expect(pgCompiled.compiledSql).toContain("WHERE email = $1 AND age >= $2");
    expect(pgCompiled.values).toEqual(["alice@bunest.dev", 21]);

    const crdbCompiled = compileSqlForDialect(sql, "cockroachdb", {
      email: "alice@bunest.dev",
      minAge: 21,
    });
    expect(crdbCompiled.compiledSql).toContain("WHERE email = $1 AND age >= $2");

    const mariadbCompiled = compileSqlForDialect(sql, "mariadb", {
      email: "alice@bunest.dev",
      minAge: 21,
    });
    expect(mariadbCompiled.compiledSql).toContain("WHERE email = ? AND age >= ?");
  });

  it("detects write/DDL SQL statements accurately", () => {
    expect(isWriteSqlStatement("SELECT COUNT(*) AS count FROM users")).toBe(false);
    expect(isWriteSqlStatement("/* header */ SELECT * FROM users")).toBe(false);
    expect(isWriteSqlStatement("INSERT INTO users (email) VALUES (:email)")).toBe(true);
    expect(isWriteSqlStatement("-- note\nUPDATE users SET active = 0")).toBe(true);
    expect(isWriteSqlStatement("DELETE FROM users WHERE id = ?")).toBe(true);
    expect(isWriteSqlStatement("WITH old AS (SELECT id FROM users) DELETE FROM users")).toBe(true);
  });

  it("coerces parameter values based on TypeScript type hints", () => {
    expect(coerceSqlParamValue("42", "number")).toBe(42);
    expect(coerceSqlParamValue("true", "boolean")).toBe(true);
    expect(coerceSqlParamValue("false", "boolean")).toBe(false);
    expect(coerceSqlParamValue("null", "number | null")).toBeNull();
    expect(coerceSqlParamValue("null", "string")).toBe("null");
    expect(coerceSqlParamValue("123", "string")).toBe("123");
    expect(coerceSqlParamValue("123")).toBe(123);
  });

  it("discovers workspace database candidates across Postgres, MySQL, MariaDB, LibSQL/Turso, Cloudflare D1, and SQLite", () => {
    const dir = createTempDir({
      ".env": [
        "DATABASE_URL=postgres://dev:pass@localhost:5432/bunest_dev",
        "MYSQL_URL=mysql://root:pass@localhost:3306/shop",
        "MARIADB_URL=mariadb://root:pass@localhost:3307/shop",
        "TURSO_DATABASE_URL=libsql://app-org.turso.io",
        "TURSO_AUTH_TOKEN=turso_secret_token",
        "CLOUDFLARE_ACCOUNT_ID=acc_123",
        "CLOUDFLARE_D1_DATABASE_ID=db_456",
        "CLOUDFLARE_API_TOKEN=cf_secret_token",
      ].join("\n"),
      "data/local.sqlite": "",
    });
    const candidates = discoverWorkspaceDatabaseCandidates(dir);
    const dialects = candidates.map((c) => c.dialect);
    expect(dialects).toContain("postgres");
    expect(dialects).toContain("mysql");
    expect(dialects).toContain("mariadb");
    expect(dialects).toContain("libsql");
    expect(dialects).toContain("d1");
    expect(dialects).toContain("sqlite");

    const turso = candidates.find((c) => c.dialect === "libsql")!;
    expect(turso.connection.authToken).toBe("turso_secret_token");

    const d1 = candidates.find((c) => c.dialect === "d1")!;
    expect(d1.connection.accountId).toBe("acc_123");
    expect(d1.connection.databaseId).toBe("db_456");
    expect(d1.connection.apiToken).toBe("cf_secret_token");
  });

  it("executes raw SQL against LibSQL/Turso Hrana HTTP v2 and Cloudflare D1 REST API", async () => {
    const dir = createTempDir();

    // 1. LibSQL / Turso Hrana HTTP v2
    const libsqlFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://demo.turso.io/v2/pipeline");
      const headers = init?.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer tok_libsql");
      const body = JSON.parse(String(init?.body)) as {
        requests: Array<{ stmt?: { sql: string; args: unknown[] } }>;
      };
      expect(body.requests[0]?.stmt?.sql).toBe(
        "SELECT COUNT(*) AS count FROM users WHERE active = ?",
      );
      return new Response(
        JSON.stringify({
          results: [
            {
              type: "ok",
              response: {
                result: {
                  cols: [{ name: "count" }],
                  rows: [[{ type: "integer", value: "7" }]],
                  affected_row_count: 0,
                },
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const libsqlRes = await executeRawSql({
      sql: "SELECT COUNT(*) AS count FROM users WHERE active = :active",
      connection: {
        dialect: "libsql",
        url: "libsql://demo.turso.io",
        authToken: "tok_libsql",
      },
      params: { active: true },
      cwd: dir,
      fetchImpl: libsqlFetch,
    });
    expect(libsqlRes.ok).toBe(true);
    expect(libsqlRes.dialect).toBe("libsql");
    expect(libsqlRes.columns).toEqual(["count"]);
    expect(libsqlRes.rows).toEqual([{ count: 7 }]);

    // 2. Cloudflare D1 REST API
    const d1Fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe(
        "https://api.cloudflare.com/client/v4/accounts/acc_1/d1/database/db_2/query",
      );
      const headers = init?.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer tok_cf");
      return new Response(
        JSON.stringify({
          success: true,
          result: [
            {
              results: [{ count: 12 }],
              meta: { changes: 0 },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const d1Res = await executeRawSql({
      sql: "SELECT COUNT(*) AS count FROM users",
      connection: {
        dialect: "d1",
        accountId: "acc_1",
        databaseId: "db_2",
        apiToken: "tok_cf",
      },
      cwd: dir,
      fetchImpl: d1Fetch,
    });
    expect(d1Res.ok).toBe(true);
    expect(d1Res.dialect).toBe("d1");
    expect(d1Res.rows).toEqual([{ count: 12 }]);
  });

  it("executes raw SQL queries directly against a real SQLite database via Bun.SQL", async () => {
    const dir = createTempDir();
    const dbPath = join(dir, "test.sqlite");

    // Seed database
    const seedRes = await executeRawSql({
      sql: "CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL, age INTEGER NOT NULL)",
      databaseUrl: dbPath,
      cwd: dir,
    });
    expect(seedRes.ok).toBe(true);

    const ins1 = await executeRawSql({
      sql: "INSERT INTO users (email, age) VALUES (:email, :age)",
      databaseUrl: dbPath,
      cwd: dir,
      params: { email: "alice@bunest.dev", age: 28 },
    });
    expect(ins1.ok).toBe(true);

    const ins2 = await executeRawSql({
      sql: "INSERT INTO users (email, age) VALUES (?, ?)",
      databaseUrl: dbPath,
      cwd: dir,
      params: ["bob@bunest.dev", 19],
    });
    expect(ins2.ok).toBe(true);

    // Execute user's exact example query: SELECT COUNT(*) AS count FROM users
    const countRes = await executeRawSql({
      sql: "SELECT COUNT(*) AS count FROM users",
      databaseUrl: dbPath,
      cwd: dir,
    });
    expect(countRes.ok).toBe(true);
    expect(countRes.dialect).toBe("sqlite");
    expect(countRes.columns).toEqual(["count"]);
    expect(countRes.rowCount).toBe(1);
    expect(countRes.rows[0]?.count).toBe(2);

    // Parameterized named query
    const namedRes = await executeRawSql({
      sql: "SELECT email, age FROM users WHERE age >= :minAge ORDER BY age DESC",
      databaseUrl: dbPath,
      cwd: dir,
      params: { minAge: 21 },
    });
    expect(namedRes.ok).toBe(true);
    expect(namedRes.rows).toEqual([{ email: "alice@bunest.dev", age: 28 }]);

    // maxRows truncation
    const truncRes = await executeRawSql({
      sql: "SELECT * FROM users ORDER BY id ASC",
      databaseUrl: dbPath,
      cwd: dir,
      maxRows: 1,
    });
    expect(truncRes.ok).toBe(true);
    expect(truncRes.rowCount).toBe(2);
    expect(truncRes.rows.length).toBe(1);
    expect(truncRes.truncated).toBe(true);

    // Error handling
    const errRes = await executeRawSql({
      sql: "SELECT * FROM missing_table",
      databaseUrl: dbPath,
      cwd: dir,
    });
    expect(errRes.ok).toBe(false);
    expect(errRes.error).toBeDefined();
  });
});
