import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import {
  BunestFactory,
  ClsModule,
  ClsService,
  Injectable,
  Module,
} from "@bunest/core";
import {
  Cron,
  CronExpression,
  ScheduleModule,
  SchedulerRegistry,
  SqlSchedulerLockDriver,
  createBunSqliteSchedulerLockExecutor,
  getSchedulerLockMigrationSql,
  getSchedulerLockMigrationStatements,
  type BunSqlClientLike,
  type SqlQueryExecutorLike,
} from "../../src";

describe("Cluster-Default Cron Locks, SqlSchedulerLockDriver & Scheduler CLS Isolation", () => {
  const openDbs: Database[] = [];

  afterEach(() => {
    while (openDbs.length > 0) {
      openDbs.pop()!.close();
    }
  });

  function createSqliteDb(): Database {
    const db = new Database(":memory:");
    openDbs.push(db);
    return db;
  }

  describe("getSchedulerLockMigrationSql & table identifier validation", () => {
    it("generates valid DDL for postgres, mysql, and sqlite", () => {
      const pg = getSchedulerLockMigrationSql("postgres");
      expect(pg).toContain("CREATE TABLE IF NOT EXISTS bunest_scheduler_locks");
      expect(pg).toContain("lock_key TEXT PRIMARY KEY");
      expect(pg).toContain("expires_at BIGINT NOT NULL");
      expect(pg).toContain("CREATE INDEX IF NOT EXISTS");

      const mysql = getSchedulerLockMigrationSql("mysql", {
        tableName: "custom_cron_locks",
      });
      expect(mysql).toContain("CREATE TABLE IF NOT EXISTS custom_cron_locks");
      expect(mysql).toContain("lock_key VARCHAR(255) PRIMARY KEY");
      expect(mysql).toContain("INDEX idx_custom_cron_locks_exp (expires_at)");

      const sqliteStmts = getSchedulerLockMigrationStatements("sqlite", {
        tableName: "app_locks",
      });
      expect(sqliteStmts).toHaveLength(2);
      expect(sqliteStmts[0]).toContain("CREATE TABLE IF NOT EXISTS app_locks");
      expect(sqliteStmts[0]).toContain("expires_at INTEGER NOT NULL");
    });

    it("rejects SQL-injection and invalid table identifiers strictly", () => {
      const badNames = [
        "",
        "locks; DROP TABLE users;--",
        "bad table",
        "locks' OR '1'='1",
        "123_starts_with_digit",
        "schema.table",
        "bad-hyphen",
        "a".repeat(64),
      ];

      for (const bad of badNames) {
        expect(() =>
          getSchedulerLockMigrationSql("sqlite", { tableName: bad }),
        ).toThrow(TypeError);

        const db = createSqliteDb();
        expect(
          () => new SqlSchedulerLockDriver(db, { tableName: bad }),
        ).toThrow(TypeError);
      }

      expect(() =>
        getSchedulerLockMigrationSql("oracle" as "postgres"),
      ).toThrow(TypeError);
    });
  });

  describe("SqlSchedulerLockDriver against real bun:sqlite", () => {
    it("enforces atomic acquire, expiry reclamation, owner-checked renew & release, and pruneExpired", async () => {
      const db = createSqliteDb();
      db.exec(getSchedulerLockMigrationSql("sqlite"));

      let now = 10_000;
      const driver = new SqlSchedulerLockDriver(db, {
        now: () => now,
      });
      expect(driver.dialect).toBe("sqlite");

      // Owner A acquires lock for 1000ms
      expect(await driver.acquire("billing", 1000, "token-a")).toBe(true);
      // Owner B cannot steal an active lock
      expect(await driver.acquire("billing", 1000, "token-b")).toBe(false);
      // Owner A cannot double-acquire either while unexpired
      expect(await driver.acquire("billing", 1000, "token-a")).toBe(false);

      // Owner-checked renew: wrong token fails, right token succeeds
      expect(await driver.renew("billing", 2000, "token-b")).toBe(false);
      now = 10_500;
      expect(await driver.renew("billing", 2000, "token-a")).toBe(true);

      // At t=11_500 original 11_000 TTL passed, but renewed expiry is 12_500 -> B still blocked
      now = 11_500;
      expect(await driver.acquire("billing", 1000, "token-b")).toBe(false);

      // Owner-checked release: wrong token cannot delete A's lock
      expect(await driver.release("billing", "token-b")).toBe(false);
      expect(await driver.acquire("billing", 1000, "token-b")).toBe(false);

      // Advance past renewed expiry (12_500): B atomically reclaims expired lock
      now = 12_500;
      expect(await driver.renew("billing", 1000, "token-a")).toBe(false);
      expect(await driver.release("billing", "token-a")).toBe(false);
      expect(await driver.acquire("billing", 1000, "token-b")).toBe(true);

      // Owner B releases cleanly -> Owner C can immediately acquire
      expect(await driver.release("billing", "token-b")).toBe(true);
      expect(await driver.release("billing", "token-b")).toBe(false);
      expect(await driver.acquire("billing", 500, "token-c")).toBe(true);

      // pruneExpired removes only expired rows
      expect(await driver.acquire("other-job", 2000, "token-d")).toBe(true);
      now = 13_200; // token-c (13_000) expired, token-d (14_500) still live
      const pruned = await driver.pruneExpired();
      expect(pruned).toBe(1);
      expect(await driver.acquire("other-job", 500, "token-e")).toBe(false);
      expect(await driver.acquire("billing", 500, "token-e")).toBe(true);
    });

    it("supports createBunSqliteSchedulerLockExecutor + autoCreateTable: true", async () => {
      const db = createSqliteDb();
      const executor = createBunSqliteSchedulerLockExecutor(db);
      const driver = new SqlSchedulerLockDriver(executor, {
        dialect: "sqlite",
        tableName: "custom_locks",
        prefix: "",
        autoCreateTable: true,
      });

      expect(await driver.acquire("daily-report", 5000, "owner-1")).toBe(true);
      expect(await driver.acquire("daily-report", 5000, "owner-2")).toBe(false);
      expect(await driver.release("daily-report", "owner-1")).toBe(true);
    });

    it("works directly with real callable Bun.SQL(':memory:') instance", async () => {
      const sql = new Bun.SQL(":memory:");
      expect(typeof sql).toBe("function");

      let now = 20_000;
      const driver = new SqlSchedulerLockDriver(sql, {
        dialect: "sqlite",
        tableName: "bun_sql_locks",
        autoCreateTable: true,
        now: () => now,
      });

      try {
        // Explicit ensureTable is idempotent alongside autoCreateTable
        await driver.ensureTable();

        // Atomic acquire & contention
        expect(await driver.acquire("sync-job", 1000, "node-1")).toBe(true);
        expect(await driver.acquire("sync-job", 1000, "node-2")).toBe(false);

        // Owner-checked renew
        expect(await driver.renew("sync-job", 2000, "node-2")).toBe(false);
        now = 20_500;
        expect(await driver.renew("sync-job", 2000, "node-1")).toBe(true);

        // Still held at t=21_500 (renewed until 22_500)
        now = 21_500;
        expect(await driver.acquire("sync-job", 1000, "node-2")).toBe(false);
        expect(await driver.release("sync-job", "node-2")).toBe(false);

        // Expiry takeover at t=22_500
        now = 22_500;
        expect(await driver.renew("sync-job", 1000, "node-1")).toBe(false);
        expect(await driver.release("sync-job", "node-1")).toBe(false);
        expect(await driver.acquire("sync-job", 1000, "node-2")).toBe(true);

        // Owner release allows immediate re-acquire
        expect(await driver.release("sync-job", "node-2")).toBe(true);
        expect(await driver.acquire("sync-job", 500, "node-3")).toBe(true);
        expect(await driver.acquire("live-job", 5000, "node-4")).toBe(true);

        // pruneExpired cleans only expired rows
        now = 23_500;
        await driver.pruneExpired();
        expect(await driver.acquire("sync-job", 500, "node-5")).toBe(true);
        expect(await driver.acquire("live-job", 500, "node-5")).toBe(false);
      } finally {
        await sql.close();
      }
    });

    it("generates dialect-specific parameterized SQL for postgres (Bun.SQL) and mysql", async () => {
      const pgCalls: Array<{ sql: string; params?: unknown[] }> = [];
      const mockBunSql: BunSqlClientLike = {
        async unsafe<T = Record<string, unknown>>(
          sql: string,
          params?: unknown[],
        ) {
          pgCalls.push({ sql, params });
          const rows = [{ owner_token: "tok-pg" }] as unknown as T[] & {
            count?: number;
          };
          rows.count = 1;
          return rows;
        },
      };

      const pgDriver = new SqlSchedulerLockDriver(mockBunSql, {
        dialect: "postgres",
        now: () => 5000,
      });
      expect(await pgDriver.acquire("job1", 1000, "tok-pg")).toBe(true);
      expect(pgCalls[0]!.sql).toContain("ON CONFLICT (lock_key) DO UPDATE");
      expect(pgCalls[0]!.sql).toContain("WHERE bunest_scheduler_locks.expires_at <= $4");
      expect(pgCalls[0]!.params).toEqual([
        "bunest:cron:lock:job1",
        "tok-pg",
        6000,
        5000,
      ]);
      expect(await pgDriver.renew("job1", 2000, "tok-pg")).toBe(true);
      expect(await pgDriver.release("job1", "tok-pg")).toBe(true);

      const mysqlCalls: Array<{ sql: string; params?: readonly unknown[] }> = [];
      const mockMysql: SqlQueryExecutorLike = {
        async query<T = Record<string, unknown>>(
          sql: string,
          params?: readonly unknown[],
        ) {
          mysqlCalls.push({ sql, params });
          if (sql.trimStart().startsWith("SELECT")) {
            return { rows: [{ owner_token: "tok-my" } as T], affectedRows: 1 };
          }
          return { rows: [], affectedRows: 1 };
        },
      };

      const mysqlDriver = new SqlSchedulerLockDriver(mockMysql, {
        dialect: "mysql",
        now: () => 5000,
      });
      expect(await mysqlDriver.acquire("job1", 1000, "tok-my")).toBe(true);
      expect(mysqlCalls[0]!.sql).toContain("ON DUPLICATE KEY UPDATE");
      expect(mysqlCalls[1]!.sql).toContain("SELECT owner_token FROM");
      expect(await mysqlDriver.renew("job1", 2000, "tok-my")).toBe(true);
      expect(await mysqlDriver.release("job1", "tok-my")).toBe(true);
    });
  });

  describe("ScheduleModule.forRoot({ lockDriver, defaultLock }) cluster locking & opt-out", () => {
    it("applies defaultLock to @Cron handlers across replicas, honors { lock: false } opt-out and per-handler overrides", async () => {
      const db = createSqliteDb();
      db.exec(getSchedulerLockMigrationSql("sqlite"));
      const sharedLockDriver = new SqlSchedulerLockDriver(db);

      const defaultLockedRuns: string[] = [];
      const optedOutRuns: string[] = [];

      function createReplicaModule(replicaId: string) {
        @Injectable()
        class ClusterJobs {
          @Cron(CronExpression.EVERY_HOUR, {
            name: "cluster-billing",
            disabled: true,
          })
          async runBilling() {
            defaultLockedRuns.push(replicaId);
            await Bun.sleep(40);
          }

          @Cron(CronExpression.EVERY_HOUR, {
            name: "local-cache-warmup",
            disabled: true,
            lock: false,
          })
          async runLocalWarmup() {
            optedOutRuns.push(replicaId);
            await Bun.sleep(20);
          }

          @Cron(CronExpression.EVERY_HOUR, {
            name: "custom-leader-job",
            disabled: true,
            lock: { ttlMs: 3000, mode: "leader", key: "custom-leader-key" },
          })
          async runLeader() {
            // noop
          }
        }

        @Module({
          imports: [
            ScheduleModule.forRoot({
              lockDriver: sharedLockDriver,
              defaultLock: { ttlMs: 5000, mode: "skip" },
            }),
          ],
          providers: [ClusterJobs],
        })
        class ReplicaAppModule {}

        return ReplicaAppModule;
      }

      const app1 = await BunestFactory.createApplicationContext(
        createReplicaModule("replica-1"),
      );
      const app2 = await BunestFactory.createApplicationContext(
        createReplicaModule("replica-2"),
      );

      try {
        const reg1 = app1.get(SchedulerRegistry);
        const reg2 = app2.get(SchedulerRegistry);

        // 1. Default lock applied automatically -> only ONE replica runs when both fire simultaneously
        const billing1 = reg1.getCronJob("cluster-billing");
        const billing2 = reg2.getCronJob("cluster-billing");
        expect(billing1.lock).toEqual({
          ttlMs: 5000,
          mode: "skip",
          key: "cluster-billing",
        });
        expect(billing2.lockKey).toBe("cluster-billing");

        await Promise.all([billing1.fireOnce(), billing2.fireOnce()]);
        expect(defaultLockedRuns).toHaveLength(1);
        expect(billing1.skippedTicks + billing2.skippedTicks).toBe(1);

        // After lock is released, another replica can run on the next tick
        await billing2.fireOnce();
        expect(defaultLockedRuns).toHaveLength(2);

        // 2. Explicit opt-out `{ lock: false }` -> NO lock attached, BOTH replicas run simultaneously
        const local1 = reg1.getCronJob("local-cache-warmup");
        const local2 = reg2.getCronJob("local-cache-warmup");
        expect(local1.lock).toBeUndefined();
        expect(local2.lock).toBeUndefined();

        await Promise.all([local1.fireOnce(), local2.fireOnce()]);
        expect(optedOutRuns.sort()).toEqual(["replica-1", "replica-2"]);

        // 3. Per-handler override `{ lock: { ... } }` takes precedence over defaultLock
        const leader1 = reg1.getCronJob("custom-leader-job");
        expect(leader1.lock).toEqual({
          ttlMs: 3000,
          mode: "leader",
          key: "custom-leader-key",
        });
      } finally {
        await app1.close();
        await app2.close();
      }
    });

    it("does not attach locks when defaultLock is false", async () => {
      const db = createSqliteDb();
      db.exec(getSchedulerLockMigrationSql("sqlite"));
      const sharedLockDriver = new SqlSchedulerLockDriver(db);

      @Injectable()
      class PlainJobs {
        @Cron(CronExpression.EVERY_HOUR, { name: "plain-job", disabled: true })
        run() {}
      }

      @Module({
        imports: [
          ScheduleModule.forRoot({
            lockDriver: sharedLockDriver,
            defaultLock: false,
          }),
        ],
        providers: [PlainJobs],
      })
      class AppModule {}

      const app = await BunestFactory.createApplicationContext(AppModule);
      try {
        const job = app.get(SchedulerRegistry).getCronJob("plain-job");
        expect(job.lock).toBeUndefined();
      } finally {
        await app.close();
      }
    });
  });

  describe("SchedulerExplorer clean CLS isolation", () => {
    it("wraps scheduled @Cron executions in a fresh CLS context with requestId & jobName without leaking outer CLS", async () => {
      const observed: Array<{
        isActive: boolean;
        clsId: string | undefined;
        requestId: string | undefined;
        jobName: string | undefined;
        tenantId: string | undefined;
      }> = [];

      @Injectable()
      class ClsAwareCronService {
        constructor(private readonly cls: ClsService) {}

        @Cron(CronExpression.EVERY_HOUR, {
          name: "nightly-reconcile",
          disabled: true,
        })
        async reconcile() {
          await Bun.sleep(1);
          observed.push({
            isActive: this.cls.isActive(),
            clsId: this.cls.getId(),
            requestId: this.cls.get<string>("requestId"),
            jobName: this.cls.get<string>("jobName"),
            tenantId: this.cls.get<string>("tenantId"),
          });
        }
      }

      @Module({
        imports: [ClsModule.forRoot({ global: true }), ScheduleModule.forRoot()],
        providers: [ClsAwareCronService],
      })
      class AppModule {}

      const app = await BunestFactory.createApplicationContext(AppModule);
      try {
        const cls = app.get(ClsService);
        const registry = app.get(SchedulerRegistry);
        const cronJob = registry.getCronJob("nightly-reconcile");

        // Fire from inside a polluted outer CLS context to verify zero stale context leakage
        await cls.run(
          async () => {
            await cronJob.fireOnce();
            await cronJob.fireOnce();
            // Outer CLS must remain untouched
            expect(cls.get("tenantId")).toBe("stale-http-tenant");
            expect(cls.get("requestId")).toBe("http-req-outer");
          },
          {
            tenantId: "stale-http-tenant",
            requestId: "http-req-outer",
          },
        );

        expect(observed).toHaveLength(2);
        for (const run of observed) {
          expect(run.isActive).toBe(true);
          expect(run.tenantId).toBeUndefined();
          expect(run.jobName).toBe("nightly-reconcile");
          expect(run.requestId).toBeDefined();
          expect(run.requestId).not.toBe("http-req-outer");
          expect(run.requestId).toContain("nightly-reconcile");
          expect(run.clsId).toBe(run.requestId);
        }
        // Every tick receives its own fresh requestId
        expect(observed[0]!.requestId).not.toBe(observed[1]!.requestId);
      } finally {
        await app.close();
      }
    });
  });
});
