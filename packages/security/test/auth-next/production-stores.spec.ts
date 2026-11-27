import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import {
  AuthenticationStorage,
  RedisAuthenticationStore,
  SqlAuthenticationStore,
  TokenService,
  createBunSqliteAuthExecutor,
  getAuthMigrationSql,
  getAuthMigrationStatements,
  type RedisAuthClientLike,
  type SqlAuthQueryExecutor,
} from "../../src/auth-next/index";
import { LOCK_STORAGE } from "../../src/auth-next/storage/authentication.storage";
import { authenticationStoreContract } from "../../src/auth-next/testing/index";
import {
  RedisAuthenticationStore as RootRedisAuthenticationStore,
  SqlAuthenticationStore as RootSqlAuthenticationStore,
  getAuthMigrationSql as rootGetAuthMigrationSql,
} from "../../src/index";

/**
 * Faithful mock Redis implementing ONLY the 8 core `RedisAuthClientLike` methods
 * (`get`, `set`, `del`, `sadd`, `srem`, `smembers`, `expire`, `exists`) with
 * simulated TTL tracking and async tick boundaries to exercise race conditions.
 */
class MockRedisAuthClient implements RedisAuthClientLike {
  readonly strings = new Map<string, string>();
  readonly sets = new Map<string, Set<string>>();
  readonly ttls = new Map<string, number>(); // epoch ms expiry
  readonly recordedExpires: Array<{ key: string; seconds: number }> = [];
  private nowMs: () => number;

  constructor(nowMs: () => number = () => Date.now()) {
    this.nowMs = nowMs;
  }

  private evictIfExpired(key: string): void {
    const exp = this.ttls.get(key);
    if (exp !== undefined && exp <= this.nowMs()) {
      this.strings.delete(key);
      this.sets.delete(key);
      this.ttls.delete(key);
    }
  }

  async get(key: string): Promise<string | null> {
    await Promise.resolve();
    this.evictIfExpired(key);
    return this.strings.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<string> {
    await Promise.resolve();
    this.strings.set(key, value);
    this.ttls.delete(key);
    return "OK";
  }

  async del(...keys: string[]): Promise<number> {
    await Promise.resolve();
    let count = 0;
    for (const key of keys) {
      this.evictIfExpired(key);
      const removedStr = this.strings.delete(key);
      const removedSet = this.sets.delete(key);
      this.ttls.delete(key);
      if (removedStr || removedSet) {
        count++;
      }
    }
    return count;
  }

  async sadd(key: string, ...members: string[]): Promise<number> {
    await Promise.resolve();
    this.evictIfExpired(key);
    let set = this.sets.get(key);
    if (!set) {
      set = new Set<string>();
      this.sets.set(key, set);
    }
    let added = 0;
    for (const member of members) {
      if (!set.has(member)) {
        set.add(member);
        added++;
      }
    }
    return added;
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    await Promise.resolve();
    this.evictIfExpired(key);
    const set = this.sets.get(key);
    if (!set) return 0;
    let removed = 0;
    for (const member of members) {
      if (set.delete(member)) {
        removed++;
      }
    }
    if (set.size === 0) {
      this.sets.delete(key);
    }
    return removed;
  }

  async smembers(key: string): Promise<string[]> {
    await Promise.resolve();
    this.evictIfExpired(key);
    const set = this.sets.get(key);
    return set ? [...set] : [];
  }

  async expire(key: string, seconds: number): Promise<number> {
    await Promise.resolve();
    this.recordedExpires.push({ key, seconds });
    if (!this.strings.has(key) && !this.sets.has(key)) {
      return 0;
    }
    if (seconds <= 0) {
      this.strings.delete(key);
      this.sets.delete(key);
      this.ttls.delete(key);
      return 1;
    }
    this.ttls.set(key, this.nowMs() + seconds * 1000);
    return 1;
  }

  async exists(key: string): Promise<number> {
    await Promise.resolve();
    this.evictIfExpired(key);
    return this.strings.has(key) || this.sets.has(key) ? 1 : 0;
  }
}

describe("Production Auth Storage Adapters — RedisAuthenticationStore", () => {
  const cases = authenticationStoreContract(
    () => {
      const store = new RedisAuthenticationStore(new MockRedisAuthClient(), {
        keyPrefix: "test:auth:",
      });
      return store.asSources();
    },
    { concurrent: true },
  );

  for (const c of cases) {
    it(`[contract] ${c.name}`, async () => {
      await c.run();
    });
  }

  const boundedCases = authenticationStoreContract(
    () => {
      const store = new RedisAuthenticationStore(new MockRedisAuthClient(), {
        maxPending: 3,
      });
      return store.asSources();
    },
    {
      contracts: ["magicLinks", "oidcStates", "emailTokens"],
      maxPending: 3,
    },
  );

  for (const c of boundedCases) {
    it(`[contract maxPending=3] ${c.name}`, async () => {
      await c.run();
    });
  }

  it("isolates namespaces via keyPrefix, applies TTLs, and detects refresh token reuse via secondary indexes", async () => {
    let clock = 1_800_000_000_000;
    const redis = new MockRedisAuthClient(() => clock);
    const storeA = new RedisAuthenticationStore(redis, {
      keyPrefix: "tenant-a:auth:",
      now: () => clock,
    });
    const storeB = new RedisAuthenticationStore(redis, {
      keyPrefix: "tenant-b:auth:",
      now: () => clock,
    });

    await storeA.createSession({
      id: "sess-1",
      userId: "u1",
      createdAt: new Date(clock),
      expiresAt: new Date(clock + 60_000),
      lastActiveAt: new Date(clock),
    });

    expect(await storeA.getSession("sess-1")).toBeDefined();
    expect(await storeB.getSession("sess-1")).toBeUndefined();
    expect(redis.strings.has("tenant-a:auth:session:sess-1")).toBe(true);
    expect(
      redis.recordedExpires.some(
        (e) => e.key === "tenant-a:auth:session:sess-1" && e.seconds === 60,
      ),
    ).toBe(true);

    // Advance mock clock past TTL -> key expires automatically
    clock += 61_000;
    expect(await storeA.getSession("sess-1")).toBeUndefined();
    // listUserSessions lazily cleans stale IDs from the user secondary index
    expect(await storeA.listUserSessions("u1")).toEqual([]);

    // Full TokenService refresh rotation + reuse detection + revokeAll
    const storage = new AuthenticationStorage({
      contracts: ["refreshTokens"],
      allowInMemoryStorage: false,
    });
    storeA.registerInto(storage);
    storage[LOCK_STORAGE]({ log: false });

    const tokens = new TokenService(storage, {
      accessToken: { key: "redis-auth-store-secret-at-least-32-bytes!" },
      refreshToken: { now: () => clock },
    });
    const pair1 = await tokens.issue("u1");
    const pair2 = await tokens.refresh(pair1.refreshToken);

    // Reusing pair1 triggers family revocation -> pair2 also becomes invalid
    await expect(tokens.refresh(pair1.refreshToken)).rejects.toThrow();
    await expect(tokens.refresh(pair2.refreshToken)).rejects.toThrow();

    // New family works, then revokeAll invalidates it across secondary user index
    const pair3 = await tokens.issue("u1");
    await tokens.revokeAll("u1");
    await expect(tokens.refresh(pair3.refreshToken)).rejects.toThrow();
  });

  it("supports atomic getdel when provided by client (e.g. Bun.RedisClient)", async () => {
    const base = new MockRedisAuthClient();
    let getdelCalls = 0;
    const withGetDel: RedisAuthClientLike = {
      get: (k) => base.get(k),
      set: (k, v) => base.set(k, v),
      del: (...k) => base.del(...k),
      sadd: (k, ...m) => base.sadd(k, ...m),
      srem: (k, ...m) => base.srem(k, ...m),
      smembers: (k) => base.smembers(k),
      expire: (k, s) => base.expire(k, s),
      exists: (k) => base.exists(k),
      getdel: async (k) => {
        getdelCalls++;
        const v = await base.get(k);
        if (v !== null) await base.del(k);
        return v;
      },
    };
    const store = new RedisAuthenticationStore(withGetDel);
    const now = new Date();
    await store.saveMagicLink({
      id: "ml-1",
      email: "ada@example.com",
      createdAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
    });
    const consumed = await store.consumeMagicLink("ml-1");
    expect(consumed?.email).toBe("ada@example.com");
    expect(await store.consumeMagicLink("ml-1")).toBeUndefined();
    expect(getdelCalls).toBe(2);
  });

  it("re-exports stores and migration helper from root @bunest/security entrypoint", () => {
    expect(RootRedisAuthenticationStore).toBe(RedisAuthenticationStore);
    expect(RootSqlAuthenticationStore).toBe(SqlAuthenticationStore);
    expect(rootGetAuthMigrationSql).toBe(getAuthMigrationSql);
  });
});

describe("Production Auth Storage Adapters — SqlAuthenticationStore (real bun:sqlite)", () => {
  const sqliteCases = authenticationStoreContract(
    async () => {
      const db = new Database(":memory:");
      const store = new SqlAuthenticationStore(
        createBunSqliteAuthExecutor(db),
        { dialect: "sqlite" },
      );
      await store.migrate();
      return store.asSources();
    },
    { concurrent: true },
  );

  for (const c of sqliteCases) {
    it(`[bun:sqlite contract] ${c.name}`, async () => {
      await c.run();
    });
  }

  const sqliteBoundedCases = authenticationStoreContract(
    async () => {
      const db = new Database(":memory:");
      const store = new SqlAuthenticationStore(
        createBunSqliteAuthExecutor(db),
        { dialect: "sqlite", maxPending: 3 },
      );
      await store.migrate();
      return store.asSources();
    },
    {
      contracts: ["magicLinks", "oidcStates", "emailTokens"],
      maxPending: 3,
    },
  );

  for (const c of sqliteBoundedCases) {
    it(`[bun:sqlite maxPending=3] ${c.name}`, async () => {
      await c.run();
    });
  }
});

describe("Production Auth Storage Adapters — SqlAuthenticationStore (real Bun.SQL SQLite)", () => {
  const bunSqlCases = authenticationStoreContract(
    async () => {
      const sql = new Bun.SQL(":memory:");
      const store = new SqlAuthenticationStore(sql, { dialect: "sqlite" });
      await store.migrate();
      return store.asSources();
    },
    { concurrent: true },
  );

  for (const c of bunSqlCases) {
    it(`[Bun.SQL sqlite contract] ${c.name}`, async () => {
      await c.run();
    });
  }
});

describe("Production Auth Storage Adapters — SQL Migration DDL & Dialect Parameterization", () => {
  it("generates ready-to-run CREATE TABLE IF NOT EXISTS DDL for all 7 auth tables across postgres, sqlite, and mysql", () => {
    for (const dialect of ["postgres", "sqlite", "mysql"] as const) {
      const ddl = getAuthMigrationSql(dialect);
      const createTables = ddl.match(/CREATE TABLE IF NOT EXISTS /g) ?? [];
      expect(createTables).toHaveLength(7);
      expect(ddl).toContain("bunest_auth_sessions");
      expect(ddl).toContain("bunest_auth_refresh_tokens");
      expect(ddl).toContain("bunest_auth_mfa");
      expect(ddl).toContain("bunest_auth_magic_links");
      expect(ddl).toContain("bunest_auth_oidc_states");
      expect(ddl).toContain("bunest_auth_email_tokens");
      expect(ddl).toContain("bunest_auth_passkeys");

      if (dialect === "mysql") {
        expect(ddl).toContain("VARCHAR(255)");
        expect(ddl).toContain("INDEX idx_");
        expect(ddl).not.toContain("CREATE INDEX IF NOT EXISTS");
      } else {
        expect(ddl).toContain("CREATE INDEX IF NOT EXISTS");
      }
    }

    // Custom table prefix and SQLite execution verification
    const customDdl = getAuthMigrationSql("sqlite", { tablePrefix: "app_" });
    expect(customDdl).toContain("CREATE TABLE IF NOT EXISTS app_sessions");
    expect(customDdl).toContain("CREATE TABLE IF NOT EXISTS app_passkeys");
    const db = new Database(":memory:");
    try {
      db.exec(customDdl);
      const tables = db
        .query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as Array<{ name: string }>;
      expect(tables.map((t) => t.name)).toEqual([
        "app_email_tokens",
        "app_magic_links",
        "app_mfa",
        "app_oidc_states",
        "app_passkeys",
        "app_refresh_tokens",
        "app_sessions",
      ]);
    } finally {
      db.close();
    }

    // Unsafe tablePrefix is rejected to prevent SQL injection
    expect(() =>
      getAuthMigrationStatements("postgres", { tablePrefix: "bad; DROP TABLE x;" }),
    ).toThrow(TypeError);
  });

  it("uses $1..$N parameterized queries on postgres and ? on mysql without interpolating user values", async () => {
    const pgQueries: Array<{ sql: string; params: readonly unknown[] }> = [];
    const pgExec: SqlAuthQueryExecutor = {
      async query(sql, params = []) {
        pgQueries.push({ sql, params });
        return { rows: [], affectedRows: 1 };
      },
    };
    const pgStore = new SqlAuthenticationStore(pgExec, { dialect: "postgres" });
    const malicious = "'; DROP TABLE bunest_auth_sessions; --";
    const now = new Date(1_700_000_000_000);
    await pgStore.createSession({
      id: malicious,
      userId: "user-1",
      createdAt: now,
      expiresAt: new Date(now.getTime() + 1000),
      lastActiveAt: now,
    });
    await pgStore.consumeMagicLink(malicious);

    expect(pgQueries[0]!.sql).toContain("$1, $2, $3, $4, $5, $6, $7");
    expect(pgQueries[0]!.sql).toContain("ON CONFLICT (id) DO UPDATE");
    expect(pgQueries[0]!.sql).not.toContain("DROP TABLE");
    expect(pgQueries[0]!.params[0]).toBe(malicious);
    expect(pgQueries[1]!.sql).toContain("RETURNING");
    expect(pgQueries[1]!.sql).toContain("$1");

    const mysqlQueries: Array<{ sql: string; params: readonly unknown[] }> = [];
    const mysqlExec: SqlAuthQueryExecutor = {
      async query(sql, params = []) {
        mysqlQueries.push({ sql, params });
        if (sql.startsWith("SELECT")) {
          return {
            rows: [
              {
                id: malicious,
                email: "a@b.com",
                created_at: now.getTime(),
                expires_at: now.getTime() + 1000,
                redirect_to: null,
              } as any,
            ],
            affectedRows: 1,
          };
        }
        return { rows: [], affectedRows: 1 };
      },
    };
    const mysqlStore = new SqlAuthenticationStore(mysqlExec, {
      dialect: "mysql",
    });
    await mysqlStore.createSession({
      id: malicious,
      userId: "user-1",
      createdAt: now,
      expiresAt: new Date(now.getTime() + 1000),
      lastActiveAt: now,
    });
    const ml = await mysqlStore.consumeMagicLink(malicious);
    expect(ml?.id).toBe(malicious);

    expect(mysqlQueries[0]!.sql).toContain("VALUES (?, ?, ?, ?, ?, ?, ?)");
    expect(mysqlQueries[0]!.sql).toContain("ON DUPLICATE KEY UPDATE");
    expect(mysqlQueries[0]!.sql).not.toContain("$1");
    expect(mysqlQueries[0]!.sql).not.toContain("DROP TABLE");
    // MySQL consume uses SELECT + DELETE instead of RETURNING
    expect(mysqlQueries[1]!.sql).not.toContain("RETURNING");
    expect(mysqlQueries[2]!.sql).toContain("DELETE FROM bunest_auth_magic_links");
  });

  it("satisfies AuthenticationStorage production guard when registered under NODE_ENV=production", async () => {
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    const db = new Database(":memory:");
    try {
      const store = new SqlAuthenticationStore(
        createBunSqliteAuthExecutor(db),
        { dialect: "sqlite" },
      );
      await store.migrate();

      const storage = new AuthenticationStorage({
        contracts: [
          "sessions",
          "refreshTokens",
          "mfa",
          "magicLinks",
          "oidcStates",
          "emailTokens",
          "passkeys",
        ],
        allowInMemoryStorage: false,
      });
      store.registerInto(storage);
      expect(() => storage[LOCK_STORAGE]({ log: false })).not.toThrow();
      expect(storage.sessions).toBe(store);
      expect(storage.refreshTokens).toBe(store);
      expect(storage.mfa).toBe(store);
      expect(storage.magicLinks).toBe(store);
      expect(storage.oidcStates).toBe(store);
      expect(storage.emailTokens).toBe(store);
      expect(storage.passkeys).toBe(store);
    } finally {
      process.env.NODE_ENV = prevEnv;
      db.close();
    }
  });
});
