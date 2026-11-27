import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { BunestFactory, Injectable, Module } from "@bunest/core";
import {
  LUA_REDIS_LOCK_ACQUIRE,
  LUA_REDIS_LOCK_RELEASE,
  LUA_REDIS_LOCK_RENEW,
  RedisLockStore as RootRedisLockStore,
  SqlLockStore as RootSqlLockStore,
  getLocksMigrationSql as rootGetLocksMigrationSql,
} from "../../src/index";
import {
  LeaderElection,
  LockNotAcquiredError,
  LocksContext,
  LocksEvents,
  LocksModule,
  LocksStorage,
  ManualLockClock,
  OnOneInstance,
  RedisLockStore,
  SqlLockStore,
  WithLock,
  WithoutOverlapping,
  createBunSqliteLockExecutor,
  getLocksMigrationSql,
  getLocksMigrationStatements,
  type Lock,
  type LocksJobSkippedEvent,
  type OnLeadershipAcquired,
  type OnLeadershipLost,
  type RedisLockClientLike,
  type SqlLockQueryExecutor,
} from "../../src/locks/index";
import { lockStoreContract } from "../../src/locks/testing/index";

interface MockStringEntry {
  value: string;
  expiresAt?: number;
}

/**
 * Faithful Lua-evaluating in-memory Redis mock supporting `eval`, `evalsha` +
 * `scriptLoad` (including `NOSCRIPT` eviction), and `send("EVAL", ...)`.
 * Executes the exact atomic semantics of the exported `RedisLockStore` Lua scripts
 * with millisecond `PX`/`PEXPIRE` TTL tracking against a controllable clock.
 */
class MockLuaRedisLockClient implements RedisLockClientLike {
  readonly strings = new Map<string, MockStringEntry>();
  readonly scripts = new Map<string, string>();
  readonly executedScripts: string[] = [];
  simulateNoScriptOnce = false;
  closeCalled = false;
  quitCalled = false;

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

  async quit(): Promise<string> {
    this.quitCalled = true;
    return "OK";
  }

  private getLive(key: string): MockStringEntry | undefined {
    const entry = this.strings.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt !== undefined && entry.expiresAt <= this.now()) {
      this.strings.delete(key);
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

    if (script === LUA_REDIS_LOCK_ACQUIRE) {
      const lockKey = keys[0]!;
      const fenceKey = keys[1]!;
      const owner = argv[0]!;
      const ttlMs = Number(argv[1]!);
      if (this.getLive(lockKey) !== undefined) {
        return 0;
      }
      this.strings.set(lockKey, {
        value: owner,
        expiresAt: this.now() + ttlMs,
      });
      const prevFence = this.getLive(fenceKey);
      const nextToken = (prevFence ? Number(prevFence.value) : 0) + 1;
      this.strings.set(fenceKey, { value: String(nextToken) });
      return nextToken;
    }

    if (script === LUA_REDIS_LOCK_RENEW) {
      const lockKey = keys[0]!;
      const owner = argv[0]!;
      const ttlMs = Number(argv[1]!);
      const live = this.getLive(lockKey);
      if (!live || live.value !== owner) {
        return 0;
      }
      live.expiresAt = this.now() + ttlMs;
      return 1;
    }

    if (script === LUA_REDIS_LOCK_RELEASE) {
      const lockKey = keys[0]!;
      const owner = argv[0]!;
      const live = this.getLive(lockKey);
      if (!live || live.value !== owner) {
        return 0;
      }
      this.strings.delete(lockKey);
      return 1;
    }

    throw new Error(`Unexpected Lua script in MockLuaRedisLockClient: ${script}`);
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

describe("RedisLockStore — full 16-case lockStoreContract", () => {
  for (const mode of ["eval", "evalsha", "send"] as const) {
    describe(`transport mode: ${mode}`, () => {
      const clock = new ManualLockClock(1_000_000);
      const redis = new MockLuaRedisLockClient({
        now: () => clock.now(),
        mode,
      });
      const cases = lockStoreContract(() => new RedisLockStore(redis), {
        advanceTime: (ms) => clock.advance(ms),
        concurrent: true,
      });

      for (const c of cases) {
        it(c.name, c.run);
      }
    });
  }
});

describe("RedisLockStore — semantics, NOSCRIPT recovery, prefix isolation & lifecycle", () => {
  it("isolates prefixes, prevents lock/fence key collision, and recovers from NOSCRIPT", async () => {
    let now = 5_000_000;
    const redis = new MockLuaRedisLockClient({
      now: () => now,
      mode: "evalsha",
    });
    const storeA = new RedisLockStore(redis, { prefix: "svc-a" });
    const storeB = new RedisLockStore(redis, { prefix: "svc-b" });
    const storeNoPrefix = new RedisLockStore(redis, { prefix: "" });

    const r1 = await storeA.acquire("order:1", "owner-a", 10_000);
    expect(r1).toEqual({ acquired: true, fencingToken: 1 });

    // Trigger NOSCRIPT on next Lua invocation -> must reload and succeed transparently
    redis.simulateNoScriptOnce = true;
    expect(await storeA.renew("order:1", "owner-a", 15_000)).toBe(true);
    expect(await storeA.renew("order:1", "wrong-owner", 15_000)).toBe(false);

    // Different prefix namespace is completely isolated
    const rB = await storeB.acquire("order:1", "owner-b", 10_000);
    expect(rB).toEqual({ acquired: true, fencingToken: 1 });

    // A lock key literally named "fence:order:1" must NOT collide with fence key of "order:1"
    const fenceNamed = await storeA.acquire("fence:order:1", "owner-x", 10_000);
    expect(fenceNamed).toEqual({ acquired: true, fencingToken: 1 });
    expect(await storeA.release("order:1", "owner-a")).toBe(true);
    const r2 = await storeA.acquire("order:1", "owner-a2", 10_000);
    expect(r2).toEqual({ acquired: true, fencingToken: 2 });

    // Empty prefix still keeps lock: and fence: distinct
    expect(await storeNoPrefix.acquire("k", "o1", 5_000)).toEqual({
      acquired: true,
      fencingToken: 1,
    });
    expect(redis.strings.has("lock:k")).toBe(true);
    expect(redis.strings.has("fence:k")).toBe(true);

    // External client is NOT closed by store.close()
    await storeA.close();
    expect(redis.closeCalled).toBe(false);
    expect(redis.quitCalled).toBe(false);
  });

  it("closes owned Bun.RedisClient created from URL and validates inputs", async () => {
    // Creating from URL owns the client; close() is idempotent without connecting
    const urlStore = new RedisLockStore("redis://127.0.0.1:6399");
    await urlStore.close();
    await urlStore.close();

    expect(() => new RedisLockStore("")).toThrow(TypeError);
    expect(() => new RedisLockStore({} as RedisLockClientLike)).toThrow(
      TypeError,
    );

    const redis = new MockLuaRedisLockClient();
    const store = new RedisLockStore(redis);
    await expect(store.acquire("k", "o", 0)).rejects.toThrow(RangeError);
    await expect(store.acquire("k", "o", -100)).rejects.toThrow(RangeError);
    await expect(store.renew("k", "o", Number.NaN)).rejects.toThrow(RangeError);
  });

  it("drives multi-node @OnOneInstance, @WithoutOverlapping, @WithLock & @LeaderElection via RedisLockStore", async () => {
    const sharedClock = new ManualLockClock(1_000_000);
    const redis = new MockLuaRedisLockClient({ now: () => sharedClock.now() });
    const sharedStore = new RedisLockStore(redis);

    // Satisfies production guard under NODE_ENV=production
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";

    try {
      @Injectable()
      class RedisLocksRegistrar {
        constructor(storage: LocksStorage) {
          sharedStore.registerInto(storage);
        }
      }

      let releaseOverlap!: () => void;
      const overlapGate = new Promise<void>((r) => {
        releaseOverlap = r;
      });

      @Injectable()
      class ClusterJobs {
        exportRuns: number[] = [];
        syncRuns: number[] = [];

        constructor(private readonly ctx: LocksContext) {}

        @OnOneInstance({ key: "cluster:export", ttl: "3s" })
        async runExport() {
          this.exportRuns.push(this.ctx.fencingToken!);
          return this.ctx.fencingToken;
        }

        @WithoutOverlapping({ key: "cluster:sync", ttl: "3s" })
        async runSync(waitOnGate: boolean) {
          this.syncRuns.push(this.ctx.fencingToken!);
          if (waitOnGate) {
            await overlapGate;
          }
          return this.ctx.fencingToken;
        }

        @WithLock((sku: string) => `sku:${sku}`, { ttl: "3s" })
        async reserve(sku: string) {
          return { sku, token: this.ctx.fencingToken };
        }
      }

      @Injectable()
      @LeaderElection("cluster:leader", { ttl: "3s" })
      class ClusterLeader implements OnLeadershipAcquired, OnLeadershipLost {
        acquired: Lock[] = [];
        lost: Lock[] = [];
        onLeadershipAcquired(lock: Lock) {
          this.acquired.push(lock);
        }
        onLeadershipLost(lock: Lock) {
          this.lost.push(lock);
        }
      }

      const bootNode = async (clock: ManualLockClock) => {
        @Module({
          imports: [LocksModule.forRoot({ clock, ttl: "3s" })],
          providers: [RedisLocksRegistrar, ClusterJobs, ClusterLeader],
        })
        class NodeModule {}

        const app = await BunestFactory.createApplicationContext(NodeModule, {
          logger: false,
        });
        await app.init();
        return {
          app,
          jobs: app.get(ClusterJobs),
          leader: app.get(ClusterLeader),
          events: app.get(LocksEvents),
        };
      };

      const nodeA = await bootNode(sharedClock);
      await sharedClock.advance(0);
      const nodeB = await bootNode(sharedClock);
      await sharedClock.advance(0);

      const skipsB: LocksJobSkippedEvent[] = [];
      const subB = nodeB.events.jobSkips$.subscribe((e) => skipsB.push(e));

      try {
        // 1. @LeaderElection: Node A leads, Node B stands by
        expect(nodeA.leader.acquired).toHaveLength(1);
        expect(nodeB.leader.acquired).toHaveLength(0);
        const leaderTokenA = nodeA.leader.acquired[0]!.fencingToken;
        expect(leaderTokenA).toBe(1);

        // 2. @OnOneInstance: Node A wins, Node B skips
        const expA = await nodeA.jobs.runExport();
        expect(expA).toBe(1);
        expect(await nodeB.jobs.runExport()).toBeUndefined();
        expect(skipsB.some((s) => s.reason === "ownership-unavailable")).toBe(
          true,
        );

        // 3. @WithoutOverlapping across two nodes: Node B skips while Node A holds run lock
        const pSync = nodeA.jobs.runSync(true);
        await sharedClock.advance(0);
        expect(await nodeB.jobs.runSync(false)).toBeUndefined();
        expect(skipsB.some((s) => s.reason === "run-lock-unavailable")).toBe(
          true,
        );
        releaseOverlap();
        const sync1 = await pSync;
        const sync2 = await nodeB.jobs.runSync(false);
        expect(sync2!).toBeGreaterThan(sync1!);

        // 4. @WithLock: sequential runs get strictly increasing fencing tokens
        const r1 = await nodeA.jobs.reserve("ITEM-1");
        const r2 = await nodeB.jobs.reserve("ITEM-1");
        expect(r2.token!).toBeGreaterThan(r1.token!);

        // 5. Leader failover: close Node A, advance campaign timer -> Node B takes over
        await nodeA.app.close();
        expect(nodeA.leader.lost).toHaveLength(1);
        await sharedClock.advance("1s");
        expect(nodeB.leader.acquired).toHaveLength(1);
        expect(nodeB.leader.acquired[0]!.fencingToken).toBeGreaterThan(
          leaderTokenA,
        );
      } finally {
        subB.unsubscribe();
        await nodeA.app.close();
        await nodeB.app.close();
      }
    } finally {
      process.env.NODE_ENV = prevEnv;
    }
  });
});

describe("SqlLockStore — full 16-case lockStoreContract on REAL bun:sqlite & Bun.SQL", () => {
  describe("bun:sqlite Database passed directly + getLocksMigrationSql('sqlite')", () => {
    const clock = new ManualLockClock(1_000_000);
    const db = new Database(":memory:");
    db.exec(getLocksMigrationSql("sqlite"));
    const store = new SqlLockStore(db, { dialect: "sqlite", clock });

    const cases = lockStoreContract(() => store, {
      advanceTime: (ms) => clock.advance(ms),
      concurrent: true,
    });

    for (const c of cases) {
      it(c.name, c.run);
    }
  });

  describe("createBunSqliteLockExecutor(db) + store.migrate()", () => {
    const clock = new ManualLockClock(2_000_000);
    const cases = lockStoreContract(
      async () => {
        const db = new Database(":memory:");
        const store = new SqlLockStore(createBunSqliteLockExecutor(db), {
          dialect: "sqlite",
          now: () => clock.now(),
        });
        await store.migrate();
        return store;
      },
      {
        advanceTime: (ms) => clock.advance(ms),
        concurrent: true,
      },
    );

    for (const c of cases) {
      it(c.name, c.run);
    }
  });

  describe("native Bun.SQL(':memory:') + store.migrate()", () => {
    const clock = new ManualLockClock(3_000_000);
    const cases = lockStoreContract(
      async () => {
        const sql = new Bun.SQL(":memory:");
        const store = new SqlLockStore(sql, {
          dialect: "sqlite",
          now: () => clock.now(),
        });
        await store.migrate();
        return store;
      },
      {
        advanceTime: (ms) => clock.advance(ms),
        concurrent: true,
      },
    );

    for (const c of cases) {
      it(c.name, c.run);
    }
  });
});

describe("SqlLockStore — real expiry, DDL dialects, SQL injection guards & LocksModule integration", () => {
  it("expires locks in real wall-clock time on bun:sqlite and preserves monotonic fencing tokens", async () => {
    const db = new Database(":memory:");
    try {
      db.exec(getLocksMigrationSql("sqlite", { tableName: "custom_locks" }));
      const store = new SqlLockStore(db, {
        dialect: "sqlite",
        tableName: "custom_locks",
      });

      const a1 = await store.acquire("job:daily", "node-1", 40);
      expect(a1).toEqual({ acquired: true, fencingToken: 1 });
      expect(await store.acquire("job:daily", "node-2", 40)).toEqual({
        acquired: false,
      });

      await Bun.sleep(60);

      // Expired: node-1 cannot renew or release; node-2 takes over with token 2
      expect(await store.renew("job:daily", "node-1", 100)).toBe(false);
      expect(await store.release("job:daily", "node-1")).toBe(false);

      const a2 = await store.acquire("job:daily", "node-2", 1_000);
      expect(a2).toEqual({ acquired: true, fencingToken: 2 });
      expect(await store.release("job:daily", "node-2")).toBe(true);

      const a3 = await store.acquire("job:daily", "node-3", 1_000);
      expect(a3).toEqual({ acquired: true, fencingToken: 3 });
    } finally {
      db.close();
    }
  });

  it("generates valid DDL for postgres, mysql, and sqlite and blocks SQL injection in identifiers", () => {
    for (const dialect of ["postgres", "mysql", "sqlite"] as const) {
      const ddl = getLocksMigrationSql(dialect);
      expect(ddl).toContain("CREATE TABLE IF NOT EXISTS bunest_locks");
      expect(ddl).toContain("fencing_token");
      expect(ddl).toContain("expires_at");
      if (dialect === "mysql") {
        expect(ddl).toContain("CHAR(64) PRIMARY KEY");
        expect(ddl).toContain("INDEX idx_bunest_locks_expires_at");
        expect(ddl).not.toContain("CREATE INDEX IF NOT EXISTS");
      } else {
        expect(ddl).toContain("CREATE INDEX IF NOT EXISTS");
      }
    }

    expect(
      getLocksMigrationStatements("postgres", { tablePrefix: "" })[0],
    ).toContain("CREATE TABLE IF NOT EXISTS locks");

    expect(() =>
      getLocksMigrationSql("postgres", {
        tablePrefix: "bad; DROP TABLE users; --",
      }),
    ).toThrow(TypeError);
    expect(() =>
      getLocksMigrationSql("mysql", { tableName: "locks; DELETE FROM x" }),
    ).toThrow(TypeError);
    expect(() =>
      new SqlLockStore({} as SqlLockQueryExecutor, { dialect: "postgres" }),
    ).toThrow(TypeError);
  });

  it("uses $1..$N parameterized queries on postgres (converting string BIGINT) and ? on mysql without interpolating values", async () => {
    const malicious = "'; DROP TABLE bunest_locks; --";

    // Postgres
    const pgQueries: Array<{ sql: string; params: readonly unknown[] }> = [];
    const pgExec: SqlLockQueryExecutor = {
      async query(sql, params = []) {
        pgQueries.push({ sql, params });
        if (sql.includes("RETURNING fencing_token")) {
          // PostgreSQL drivers return BIGINT columns as strings
          return { rows: [{ fencing_token: "42" } as any], affectedRows: 1 };
        }
        return { rows: [], affectedRows: 1 };
      },
    };
    const pgStore = new SqlLockStore(pgExec, {
      dialect: "postgres",
      now: () => 10_000,
    });
    const pgAcq = await pgStore.acquire(malicious, "owner-1", 5_000);
    expect(pgAcq).toEqual({ acquired: true, fencingToken: 42 });
    expect(await pgStore.renew(malicious, "owner-1", 5_000)).toBe(true);
    expect(await pgStore.release(malicious, "owner-1")).toBe(true);

    expect(pgQueries[0]!.sql).toContain("$1, $2, $3, 1, $4, 0");
    expect(pgQueries[0]!.sql).toContain("ON CONFLICT (key_hash) DO UPDATE");
    expect(pgQueries[0]!.sql).toContain("RETURNING fencing_token");
    expect(pgQueries[0]!.sql).not.toContain("DROP TABLE");
    expect(pgQueries[0]!.params[1]).toBe(malicious);

    // MySQL
    const mysqlQueries: Array<{ sql: string; params: readonly unknown[] }> = [];
    let insertCalls = 0;
    const mysqlExec: SqlLockQueryExecutor = {
      async query(sql, params = []) {
        mysqlQueries.push({ sql, params });
        if (sql.startsWith("INSERT IGNORE")) {
          insertCalls++;
          return { rows: [], affectedRows: insertCalls === 1 ? 1 : 0 };
        }
        if (sql.startsWith("UPDATE")) {
          return { rows: [], affectedRows: 1 };
        }
        if (sql.startsWith("SELECT fencing_token")) {
          return { rows: [{ fencing_token: "7" } as any], affectedRows: 1 };
        }
        return { rows: [], affectedRows: 0 };
      },
    };
    const mysqlStore = new SqlLockStore(mysqlExec, {
      dialect: "mysql",
      now: () => 20_000,
    });
    // First acquire inserts new key -> token 1
    expect(await mysqlStore.acquire(malicious, "owner-1", 5_000)).toEqual({
      acquired: true,
      fencingToken: 1,
    });
    // Second acquire hits duplicate -> conditional UPDATE + SELECT fencing_token -> 7
    expect(await mysqlStore.acquire(malicious, "owner-2", 5_000)).toEqual({
      acquired: true,
      fencingToken: 7,
    });
    expect(await mysqlStore.renew(malicious, "owner-2", 5_000)).toBe(true);
    expect(await mysqlStore.release(malicious, "owner-2")).toBe(true);

    for (const q of mysqlQueries) {
      expect(q.sql).not.toContain("$1");
      expect(q.sql).not.toContain("DROP TABLE");
    }
    expect(mysqlQueries[0]!.sql).toContain("INSERT IGNORE INTO bunest_locks");
    expect(mysqlQueries[2]!.sql).toContain("fencing_token = fencing_token + 1");
    expect(mysqlQueries[4]!.sql).toContain("renew_count = renew_count + 1");
  });

  it("integrates SqlLockStore with LocksModule @WithLock and satisfies root re-exports", async () => {
    expect(RootRedisLockStore).toBe(RedisLockStore);
    expect(RootSqlLockStore).toBe(SqlLockStore);
    expect(rootGetLocksMigrationSql).toBe(getLocksMigrationSql);

    const db = new Database(":memory:");
    const sqlStore = new SqlLockStore(db, { dialect: "sqlite" });
    await sqlStore.migrate();

    @Injectable()
    class SqlLockRegistrar {
      constructor(storage: LocksStorage) {
        sqlStore.registerInto(storage);
      }
    }

    @Injectable()
    class BillingService {
      constructor(private readonly ctx: LocksContext) {}

      @WithLock((acct: string) => `billing:${acct}`, { ttl: "2s" })
      async charge(acct: string, holdMs = 0) {
        if (holdMs > 0) {
          await Bun.sleep(holdMs);
        }
        return { acct, token: this.ctx.fencingToken };
      }
    }

    @Module({
      imports: [LocksModule.forRoot({ ttl: "2s" })],
      providers: [SqlLockRegistrar, BillingService],
    })
    class AppModule {}

    const app = await BunestFactory.createApplicationContext(AppModule, {
      logger: false,
    });
    try {
      const svc = app.get(BillingService);
      const pending = svc.charge("acct-1", 40);
      await Bun.sleep(10);
      await expect(svc.charge("acct-1")).rejects.toBeInstanceOf(
        LockNotAcquiredError,
      );
      const first = await pending;
      const second = await svc.charge("acct-1");
      expect(first.token).toBe(1);
      expect(second.token).toBe(2);
    } finally {
      await app.close();
      db.close();
    }
  });
});
