import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import {
  Body,
  BunestFactory,
  Controller,
  Injectable,
  InternalServerErrorException,
  Module,
  Post,
} from "@bunest/core";
import {
  IdempotencyModule,
  IdempotencyStorage,
  Idempotent,
  LUA_REDIS_IDEMPOTENCY_ACQUIRE,
  LUA_REDIS_IDEMPOTENCY_COMPLETE,
  LUA_REDIS_IDEMPOTENCY_EXTEND,
  LUA_REDIS_IDEMPOTENCY_RELEASE,
  RedisIdempotencyStore,
  SqlIdempotencyStore,
  createBunSqliteIdempotencyExecutor,
  getIdempotencyMigrationSql,
  getIdempotencyMigrationStatements,
  type RedisIdempotencyClientLike,
  type SqlIdempotencyQueryExecutor,
} from "../../src/idempotency/index";
import { LOCK_STORAGE } from "../../src/idempotency/storage/idempotency.storage";
import { idempotencyStoreContract } from "../../src/idempotency/testing/index";
import {
  RedisIdempotencyStore as RootRedisIdempotencyStore,
  SqlIdempotencyStore as RootSqlIdempotencyStore,
  getIdempotencyMigrationSql as rootGetIdempotencyMigrationSql,
} from "../../src/index";

interface MockHashEntry {
  fields: Map<string, string>;
  expiresAt?: number;
}

/**
 * Faithful Lua-evaluating in-memory Redis mock supporting `eval`, `evalsha` +
 * `scriptLoad` (including `NOSCRIPT` recovery), and `send("EVAL", ...)`.
 * Executes the exact atomic semantics of all 4 exported `RedisIdempotencyStore`
 * Lua scripts over Redis Hashes with millisecond `PEXPIRE` tracking.
 */
class MockLuaRedisIdempotencyClient implements RedisIdempotencyClientLike {
  readonly hashes = new Map<string, MockHashEntry>();
  readonly scripts = new Map<string, string>();
  readonly executedScripts: string[] = [];
  simulateNoScriptOnce = false;
  closeCalled = false;

  private readonly now: () => number;
  private readonly mode: "eval" | "evalsha" | "send";

  constructor(
    options: {
      now?: () => number;
      mode?: "eval" | "evalsha" | "send";
    } = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.mode = options.mode ?? "eval";

    if (this.mode === "eval") {
      this.eval = this.evalImpl.bind(this);
    } else if (this.mode === "evalsha") {
      this.evalsha = this.evalshaImpl.bind(this);
      this.scriptLoad = this.scriptLoadImpl.bind(this);
    } else {
      this.send = this.sendImpl.bind(this);
    }
  }

  eval?: (
    script: string,
    numKeys: number,
    ...args: Array<string | number>
  ) => Promise<unknown>;

  evalsha?: (
    sha1: string,
    numKeys: number,
    ...args: Array<string | number>
  ) => Promise<unknown>;

  scriptLoad?: (script: string) => Promise<string>;

  send?: (command: string, args: string[]) => Promise<unknown>;

  close(): void {
    this.closeCalled = true;
  }

  private getLive(key: string): MockHashEntry | undefined {
    const entry = this.hashes.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt !== undefined && entry.expiresAt <= this.now()) {
      this.hashes.delete(key);
      return undefined;
    }
    return entry;
  }

  private executeScript(
    script: string,
    keys: string[],
    argv: string[],
  ): unknown {
    this.executedScripts.push(script);
    const key = keys[0]!;

    if (script === LUA_REDIS_IDEMPOTENCY_ACQUIRE) {
      const owner = argv[0]!;
      const fingerprint = argv[1]!;
      const lockTtl = Number(argv[2]!);
      const live = this.getLive(key);
      if (!live) {
        const fields = new Map<string, string>([
          ["state", "in-flight"],
          ["owner", owner],
          ["fingerprint", fingerprint],
        ]);
        this.hashes.set(key, { fields, expiresAt: this.now() + lockTtl });
        return ["acquired"];
      }
      const state = live.fields.get("state");
      const fp = live.fields.get("fingerprint") ?? "";
      if (state === "completed") {
        return ["completed", fp, live.fields.get("response") ?? ""];
      }
      return ["in-flight", fp];
    }

    if (script === LUA_REDIS_IDEMPOTENCY_COMPLETE) {
      const owner = argv[0]!;
      const responseJson = argv[1]!;
      const ttl = Number(argv[2]!);
      const live = this.getLive(key);
      if (
        !live ||
        live.fields.get("state") !== "in-flight" ||
        live.fields.get("owner") !== owner
      ) {
        return 0;
      }
      live.fields.set("state", "completed");
      live.fields.set("response", responseJson);
      live.fields.delete("owner");
      live.expiresAt = this.now() + ttl;
      return 1;
    }

    if (script === LUA_REDIS_IDEMPOTENCY_RELEASE) {
      const owner = argv[0]!;
      const live = this.getLive(key);
      if (
        !live ||
        live.fields.get("state") !== "in-flight" ||
        live.fields.get("owner") !== owner
      ) {
        return 0;
      }
      this.hashes.delete(key);
      return 1;
    }

    if (script === LUA_REDIS_IDEMPOTENCY_EXTEND) {
      const owner = argv[0]!;
      const lockTtl = Number(argv[1]!);
      const live = this.getLive(key);
      if (
        !live ||
        live.fields.get("state") !== "in-flight" ||
        live.fields.get("owner") !== owner
      ) {
        return 0;
      }
      live.expiresAt = this.now() + lockTtl;
      return 1;
    }

    throw new Error(
      `Unexpected Lua script in MockLuaRedisIdempotencyClient: ${script}`,
    );
  }

  private async evalImpl(
    script: string,
    numKeys: number,
    ...args: Array<string | number>
  ): Promise<unknown> {
    await Promise.resolve();
    const strArgs = args.map(String);
    return this.executeScript(
      script,
      strArgs.slice(0, numKeys),
      strArgs.slice(numKeys),
    );
  }

  private async scriptLoadImpl(script: string): Promise<string> {
    await Promise.resolve();
    const sha = new Bun.CryptoHasher("sha1").update(script).digest("hex");
    this.scripts.set(sha, script);
    return sha;
  }

  private async evalshaImpl(
    sha1: string,
    numKeys: number,
    ...args: Array<string | number>
  ): Promise<unknown> {
    await Promise.resolve();
    if (this.simulateNoScriptOnce) {
      this.simulateNoScriptOnce = false;
      throw new Error("NOSCRIPT No matching script. Please use EVAL.");
    }
    const script = this.scripts.get(sha1);
    if (!script) {
      throw new Error("NOSCRIPT No matching script. Please use EVAL.");
    }
    const strArgs = args.map(String);
    return this.executeScript(
      script,
      strArgs.slice(0, numKeys),
      strArgs.slice(numKeys),
    );
  }

  private async sendImpl(command: string, args: string[]): Promise<unknown> {
    await Promise.resolve();
    if (command.toUpperCase() !== "EVAL") {
      throw new Error(`Unexpected Redis command: ${command}`);
    }
    const script = args[0]!;
    const numKeys = Number(args[1]!);
    const keys = args.slice(2, 2 + numKeys);
    const argv = args.slice(2 + numKeys);
    return this.executeScript(script, keys, argv);
  }
}

describe("RedisIdempotencyStore — full 19-case idempotencyStoreContract", () => {
  for (const mode of ["eval", "evalsha", "send"] as const) {
    describe(`transport mode: ${mode}`, () => {
      let now = 1_000_000;
      const redis = new MockLuaRedisIdempotencyClient({
        now: () => now,
        mode,
      });
      const cases = idempotencyStoreContract(
        () => new RedisIdempotencyStore(redis),
        {
          concurrent: true,
          lockTtl: 120,
          advanceTime: (ms) => {
            now += ms;
          },
        },
      );

      for (const c of cases) {
        it(c.name, c.run);
      }
    });
  }
});

describe("RedisIdempotencyStore — NOSCRIPT recovery, prefix isolation, lifecycle & multi-node @Idempotent() E2E", () => {
  it("isolates prefixes, recovers from NOSCRIPT, handles close(), and validates inputs", async () => {
    const redis = new MockLuaRedisIdempotencyClient({ mode: "evalsha" });
    const storeA = new RedisIdempotencyStore(redis, { prefix: "app-a:idem" });
    const storeB = new RedisIdempotencyStore(redis, { prefix: "app-b:idem" });

    expect(await storeA.acquire("pay-1", "o1", "fp-1", 5_000)).toEqual({
      state: "acquired",
    });
    expect(await storeB.acquire("pay-1", "o2", "fp-2", 5_000)).toEqual({
      state: "acquired",
    });

    redis.simulateNoScriptOnce = true;
    expect(await storeA.extend("pay-1", "o1", 5_000)).toBe(true);
    expect(
      await storeA.complete(
        "pay-1",
        "o1",
        { status: 201, headers: {}, body: { ok: true } },
        60_000,
      ),
    ).toBe(true);

    // External client is NOT closed by store.close()
    await storeA.close();
    expect(redis.closeCalled).toBe(false);

    // URL-owned client closes cleanly and idempotently
    const urlStore = new RedisIdempotencyStore("redis://127.0.0.1:6399");
    await urlStore.close();
    await urlStore.close();

    expect(() => new RedisIdempotencyStore("")).toThrow(TypeError);
    expect(() =>
      new RedisIdempotencyStore({} as RedisIdempotencyClientLike),
    ).toThrow(TypeError);
    await expect(storeA.acquire("k", "o", "fp", 0)).rejects.toThrow(RangeError);
    await expect(
      storeA.complete("k", "o", { status: 200, headers: {}, body: null }, -1),
    ).rejects.toThrow(RangeError);
    await expect(storeA.extend("k", "o", Number.NaN)).rejects.toThrow(
      RangeError,
    );
  });

  it("shares @Idempotent() replay, 409 in-flight conflict, 422 fingerprint mismatch, 5xx release & AES-GCM encryption across two app nodes", async () => {
    const redis = new MockLuaRedisIdempotencyClient();
    const sharedStore = new RedisIdempotencyStore(redis);
    const encKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32)));

    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";

    let chargeCalls = 0;
    let failOnce = true;
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((r) => {
      releaseSlow = r;
    });

    try {
      @Injectable()
      class RedisIdemRegistrar {
        constructor(storage: IdempotencyStorage) {
          sharedStore.registerInto(storage);
        }
      }

      @Controller("charges")
      class ChargesController {
        @Post()
        @Idempotent()
        charge(@Body() body: { amount: number }) {
          chargeCalls++;
          return { chargeId: `ch_${chargeCalls}`, amount: body.amount };
        }

        @Post("slow")
        @Idempotent({ lockTtl: "5s", retryAfter: "2s" })
        async slow(@Body() body: { id: string }) {
          await slowGate;
          return { done: body.id };
        }

        @Post("flaky")
        @Idempotent()
        flaky() {
          if (failOnce) {
            failOnce = false;
            throw new InternalServerErrorException("transient outage");
          }
          return { ok: true };
        }
      }

      const bootNode = async () => {
        @Module({
          imports: [
            IdempotencyModule.forRoot({
              encryption: { keys: [encKey] },
            }),
          ],
          controllers: [ChargesController],
          providers: [RedisIdemRegistrar],
        })
        class NodeModule {}
        return BunestFactory.create(NodeModule, { logger: false });
      };

      const nodeA = await bootNode();
      const nodeB = await bootNode();

      try {
        // 1. Node A executes and persists sealed payload -> Node B replays without re-running handler
        const r1 = await nodeA.inject({
          method: "POST",
          url: "/charges",
          headers: { "Idempotency-Key": "k-charge-1" },
          payload: { amount: 250 },
        });
        expect(r1.statusCode).toBe(201);
        expect(r1.json()).toEqual({ chargeId: "ch_1", amount: 250 });

        const r2 = await nodeB.inject({
          method: "POST",
          url: "/charges",
          headers: { "Idempotency-Key": "k-charge-1" },
          payload: { amount: 250 },
        });
        expect(r2.statusCode).toBe(201);
        expect(r2.headers["idempotent-replayed"]).toBe("true");
        expect(r2.json()).toEqual({ chargeId: "ch_1", amount: 250 });
        expect(chargeCalls).toBe(1);

        // Stored response in Redis is AES-256-GCM sealed (no plaintext leak)
        const storedHash = redis.hashes.get("bunest:idempotency:k-charge-1");
        expect(storedHash?.fields.get("state")).toBe("completed");
        expect(storedHash?.fields.get("response")).toContain('"sealed":"v1.');
        expect(storedHash?.fields.get("response")).not.toContain("ch_1");

        // 2. Same key with different payload on Node B -> 422 IDEMPOTENCY_KEY_REUSED
        const mismatch = await nodeB.inject({
          method: "POST",
          url: "/charges",
          headers: { "Idempotency-Key": "k-charge-1" },
          payload: { amount: 999 },
        });
        expect(mismatch.statusCode).toBe(422);
        expect(mismatch.json<{ code: string }>().code).toBe(
          "IDEMPOTENCY_KEY_REUSED",
        );

        // 3. In-flight request on Node A -> concurrent request on Node B gets 409
        const slowPromise = nodeA.inject({
          method: "POST",
          url: "/charges/slow",
          headers: { "Idempotency-Key": "k-slow-1" },
          payload: { id: "s1" },
        });
        await Bun.sleep(10);
        const conflict = await nodeB.inject({
          method: "POST",
          url: "/charges/slow",
          headers: { "Idempotency-Key": "k-slow-1" },
          payload: { id: "s1" },
        });
        expect(conflict.statusCode).toBe(409);
        expect(conflict.json<{ code: string }>().code).toBe(
          "IDEMPOTENCY_KEY_IN_USE",
        );
        expect(conflict.headers["retry-after"]).toBe("2");
        releaseSlow();
        expect((await slowPromise).statusCode).toBe(201);

        // 4. 5xx error on Node A releases key -> retry on Node B executes and succeeds
        const f1 = await nodeA.inject({
          method: "POST",
          url: "/charges/flaky",
          headers: { "Idempotency-Key": "k-flaky-1" },
        });
        expect(f1.statusCode).toBe(500);
        const f2 = await nodeB.inject({
          method: "POST",
          url: "/charges/flaky",
          headers: { "Idempotency-Key": "k-flaky-1" },
        });
        expect(f2.statusCode).toBe(201);
        expect(f2.json()).toEqual({ ok: true });
      } finally {
        await nodeA.close();
        await nodeB.close();
      }
    } finally {
      process.env.NODE_ENV = prevEnv;
    }
  });
});

describe("SqlIdempotencyStore — full 19-case idempotencyStoreContract on REAL bun:sqlite & Bun.SQL", () => {
  describe("bun:sqlite Database passed directly + getIdempotencyMigrationSql('sqlite')", () => {
    let now = 1_000_000;
    const db = new Database(":memory:");
    db.exec(getIdempotencyMigrationSql("sqlite"));
    const store = new SqlIdempotencyStore(db, {
      dialect: "sqlite",
      now: () => now,
    });

    const cases = idempotencyStoreContract(() => store, {
      concurrent: true,
      lockTtl: 120,
      advanceTime: (ms) => {
        now += ms;
      },
    });

    for (const c of cases) {
      it(c.name, c.run);
    }
  });

  describe("createBunSqliteIdempotencyExecutor(db) + store.migrate()", () => {
    let now = 2_000_000;
    const cases = idempotencyStoreContract(
      async () => {
        const db = new Database(":memory:");
        const store = new SqlIdempotencyStore(
          createBunSqliteIdempotencyExecutor(db),
          {
            dialect: "sqlite",
            now: () => now,
          },
        );
        await store.migrate();
        return store;
      },
      {
        concurrent: true,
        lockTtl: 120,
        advanceTime: (ms) => {
          now += ms;
        },
      },
    );

    for (const c of cases) {
      it(c.name, c.run);
    }
  });

  describe("native Bun.SQL(':memory:') + store.migrate()", () => {
    let now = 3_000_000;
    const cases = idempotencyStoreContract(
      async () => {
        const sql = new Bun.SQL(":memory:");
        const store = new SqlIdempotencyStore(sql, {
          dialect: "sqlite",
          now: () => now,
        });
        await store.migrate();
        return store;
      },
      {
        concurrent: true,
        lockTtl: 120,
        advanceTime: (ms) => {
          now += ms;
        },
      },
    );

    for (const c of cases) {
      it(c.name, c.run);
    }
  });
});

describe("SqlIdempotencyStore — pruneExpired, DDL dialects, SQL injection guards & HTTP E2E", () => {
  it("expires records in real wall-clock time, supports pruneExpired(), and satisfies production guard", async () => {
    const db = new Database(":memory:");
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      db.exec(
        getIdempotencyMigrationSql("sqlite", {
          tableName: "custom_idempotency",
        }),
      );
      const store = new SqlIdempotencyStore(db, {
        dialect: "sqlite",
        tableName: "custom_idempotency",
      });

      const storage = new IdempotencyStorage({ allowInMemoryStorage: false });
      store.registerInto(storage);
      expect(() => storage[LOCK_STORAGE]()).not.toThrow();
      expect(storage.source).toBe(store);

      expect(await store.acquire("k1", "o1", "fp1", 40)).toEqual({
        state: "acquired",
      });
      expect(
        await store.complete(
          "k1",
          "o1",
          { status: 200, headers: {}, body: { v: 1 } },
          40,
        ),
      ).toBe(true);
      expect(await store.acquire("k2", "o2", "fp2", 10_000)).toEqual({
        state: "acquired",
      });

      await Bun.sleep(60);

      // k1 expired -> pruneExpired removes only k1, leaves live k2 intact
      const pruned = await store.pruneExpired();
      expect(pruned).toBe(1);
      expect(await store.acquire("k1", "o3", "fp3", 1_000)).toEqual({
        state: "acquired",
      });
      expect(await store.acquire("k2", "o4", "fp4", 1_000)).toEqual({
        state: "in-flight",
        fingerprint: "fp2",
      });
    } finally {
      process.env.NODE_ENV = prevEnv;
      db.close();
    }
  });

  it("generates valid DDL for postgres, mysql, and sqlite and blocks SQL injection in identifiers", () => {
    for (const dialect of ["postgres", "mysql", "sqlite"] as const) {
      const ddl = getIdempotencyMigrationSql(dialect);
      expect(ddl).toContain("CREATE TABLE IF NOT EXISTS bunest_idempotency");
      expect(ddl).toContain("response_json");
      expect(ddl).toContain("expires_at");
      if (dialect === "mysql") {
        expect(ddl).toContain("CHAR(64) PRIMARY KEY");
        expect(ddl).toContain("LONGTEXT");
        expect(ddl).toContain("INDEX idx_bunest_idempotency_expires_at");
        expect(ddl).not.toContain("CREATE INDEX IF NOT EXISTS");
      } else {
        expect(ddl).toContain("CREATE INDEX IF NOT EXISTS");
      }
    }

    expect(
      getIdempotencyMigrationStatements("postgres", { tablePrefix: "" })[0],
    ).toContain("CREATE TABLE IF NOT EXISTS idempotency");

    expect(() =>
      getIdempotencyMigrationSql("postgres", {
        tablePrefix: "x; DROP TABLE users;--",
      }),
    ).toThrow(TypeError);
    expect(() =>
      getIdempotencyMigrationSql("mysql", {
        tableName: "tbl; TRUNCATE x",
      }),
    ).toThrow(TypeError);
    expect(() =>
      new SqlIdempotencyStore({} as SqlIdempotencyQueryExecutor),
    ).toThrow(TypeError);
  });

  it("uses $1..$N parameterized queries on postgres and ? on mysql without interpolating values", async () => {
    const malicious = "'; DROP TABLE bunest_idempotency; --";

    // Postgres
    const pgQueries: Array<{ sql: string; params: readonly unknown[] }> = [];
    const pgExec: SqlIdempotencyQueryExecutor = {
      async query(sql, params = []) {
        pgQueries.push({ sql, params });
        if (sql.includes("RETURNING key_hash")) {
          return { rows: [{ key_hash: "h1" } as any], affectedRows: 1 };
        }
        return { rows: [], affectedRows: 1 };
      },
    };
    const pgStore = new SqlIdempotencyStore(pgExec, {
      dialect: "postgres",
      now: () => 50_000,
    });
    expect(await pgStore.acquire(malicious, "o1", "fp1", 5_000)).toEqual({
      state: "acquired",
    });
    expect(await pgStore.extend(malicious, "o1", 5_000)).toBe(true);
    expect(
      await pgStore.complete(
        malicious,
        "o1",
        { status: 200, headers: {}, body: { msg: malicious } },
        10_000,
      ),
    ).toBe(true);
    expect(await pgStore.release(malicious, "o1")).toBe(true);

    expect(pgQueries[0]!.sql).toContain("$1, $2, 'in-flight', $3, $4, NULL, $5, 0");
    expect(pgQueries[0]!.sql).toContain("ON CONFLICT (key_hash) DO UPDATE");
    expect(pgQueries[0]!.sql).toContain("RETURNING key_hash");
    expect(pgQueries[0]!.sql).not.toContain("DROP TABLE");
    expect(pgQueries[0]!.params[1]).toBe(malicious);

    // MySQL
    const mysqlQueries: Array<{ sql: string; params: readonly unknown[] }> = [];
    let insertCount = 0;
    const mysqlExec: SqlIdempotencyQueryExecutor = {
      async query(sql, params = []) {
        mysqlQueries.push({ sql, params });
        if (sql.startsWith("INSERT IGNORE")) {
          insertCount++;
          return { rows: [], affectedRows: insertCount === 1 ? 1 : 0 };
        }
        if (sql.startsWith("UPDATE") && sql.includes("expires_at <=")) {
          return { rows: [], affectedRows: 0 };
        }
        if (sql.startsWith("SELECT state")) {
          return {
            rows: [
              {
                state: "completed",
                fingerprint: "fp1",
                response_json: JSON.stringify({
                  status: 201,
                  headers: {},
                  body: { id: 1 },
                }),
              } as any,
            ],
            affectedRows: 1,
          };
        }
        return { rows: [], affectedRows: 1 };
      },
    };
    const mysqlStore = new SqlIdempotencyStore(mysqlExec, {
      dialect: "mysql",
      now: () => 60_000,
    });
    expect(await mysqlStore.acquire(malicious, "o1", "fp1", 5_000)).toEqual({
      state: "acquired",
    });
    expect(await mysqlStore.acquire(malicious, "o2", "fp2", 5_000)).toEqual({
      state: "completed",
      fingerprint: "fp1",
      response: { status: 201, headers: {}, body: { id: 1 } },
    });
    expect(await mysqlStore.extend(malicious, "o1", 5_000)).toBe(true);
    expect(await mysqlStore.release(malicious, "o1")).toBe(true);

    for (const q of mysqlQueries) {
      expect(q.sql).not.toContain("$1");
      expect(q.sql).not.toContain("DROP TABLE");
    }
    expect(mysqlQueries[0]!.sql).toContain(
      "INSERT IGNORE INTO bunest_idempotency",
    );
    expect(mysqlQueries[4]!.sql).toContain("renew_count = renew_count + 1");
  });

  it("replays @Idempotent() HTTP responses across two app instances backed by real bun:sqlite and matches root re-exports", async () => {
    expect(RootRedisIdempotencyStore).toBe(RedisIdempotencyStore);
    expect(RootSqlIdempotencyStore).toBe(SqlIdempotencyStore);
    expect(rootGetIdempotencyMigrationSql).toBe(getIdempotencyMigrationSql);

    const db = new Database(":memory:");
    const sqlStore = new SqlIdempotencyStore(db, { dialect: "sqlite" });
    await sqlStore.migrate();

    let calls = 0;

    @Injectable()
    class SqlIdemRegistrar {
      constructor(storage: IdempotencyStorage) {
        sqlStore.registerInto(storage);
      }
    }

    @Controller("transfers")
    class TransfersController {
      @Post()
      @Idempotent()
      create(@Body() body: { to: string; amount: number }) {
        calls++;
        return { txId: `tx_${calls}`, to: body.to, amount: body.amount };
      }
    }

    const createApp = async () => {
      @Module({
        imports: [IdempotencyModule.forRoot()],
        controllers: [TransfersController],
        providers: [SqlIdemRegistrar],
      })
      class AppModule {}
      return BunestFactory.create(AppModule, { logger: false });
    };

    const app1 = await createApp();
    const app2 = await createApp();

    try {
      const r1 = await app1.inject({
        method: "POST",
        url: "/transfers",
        headers: { "Idempotency-Key": "tx-key-1" },
        payload: { to: "bob", amount: 42 },
      });
      expect(r1.statusCode).toBe(201);
      expect(r1.json()).toEqual({ txId: "tx_1", to: "bob", amount: 42 });

      // Second instance reads persisted SQLite record and replays it
      const r2 = await app2.inject({
        method: "POST",
        url: "/transfers",
        headers: { "Idempotency-Key": "tx-key-1" },
        payload: { to: "bob", amount: 42 },
      });
      expect(r2.statusCode).toBe(201);
      expect(r2.headers["idempotent-replayed"]).toBe("true");
      expect(r2.json()).toEqual({ txId: "tx_1", to: "bob", amount: 42 });
      expect(calls).toBe(1);

      // Fingerprint mismatch rejected with 422 on app2
      const mismatch = await app2.inject({
        method: "POST",
        url: "/transfers",
        headers: { "Idempotency-Key": "tx-key-1" },
        payload: { to: "eve", amount: 42 },
      });
      expect(mismatch.statusCode).toBe(422);
      expect(mismatch.json<{ code: string }>().code).toBe(
        "IDEMPOTENCY_KEY_REUSED",
      );
    } finally {
      await app1.close();
      await app2.close();
      db.close();
    }
  });
});
