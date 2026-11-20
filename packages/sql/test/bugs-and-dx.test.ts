import "reflect-metadata";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Module,
  NotFoundException,
  ServiceUnavailableException,
} from "@bunest/common";
import { Test } from "@bunest/testing";
import {
  DrizzleModule,
  DrizzleService,
  InjectDrizzle,
  InjectPrisma,
  InjectSqlMigrations,
  PrismaModule,
  PrismaServiceBase,
  SqlMigrationRunner,
  SqlModule,
  SqlService,
  getSqlMigrationRunnerToken,
  mapPrismaErrorToHttp,
  type DrizzleDatabaseLike,
  type MigrationDefinition,
  type PrismaClientLike,
  type PrismaModuleOptions,
  type PrismaOptionsFactory,
  type SqlQueryEvent,
} from "../src/index";

/**
 * Mimics real `drizzle-orm/bun-sqlite`, where `db.transaction()` is strictly
 * synchronous and throws `"Transaction function cannot return a promise"` on async callbacks!
 */
class SyncBunSqliteDrizzleDb implements DrizzleDatabaseLike<SyncBunSqliteDrizzleDb> {
  constructor(
    public readonly label: string = "root",
    private readonly store: string[] = [],
  ) {}

  insert(val: string): void {
    this.store.push(`${this.label}:${val}`);
  }

  all(): string[] {
    return [...this.store];
  }

  transaction<T>(fn: (tx: SyncBunSqliteDrizzleDb) => T): T {
    const snapshot = [...this.store];
    const txDb = new SyncBunSqliteDrizzleDb(`${this.label}>tx`, this.store);
    try {
      const result = fn(txDb);
      if (
        result !== null &&
        (typeof result === "object" || typeof result === "function") &&
        typeof (result as unknown as PromiseLike<unknown>).then === "function"
      ) {
        throw new Error("Transaction function cannot return a promise");
      }
      return result;
    } catch (err) {
      this.store.length = 0;
      this.store.push(...snapshot);
      throw err;
    }
  }
}

class RichPrismaClient implements PrismaClientLike<RichPrismaClient> {
  public connectCount = 0;
  public disconnectCount = 0;
  public failNextDisconnect = false;
  public readonly records: string[] = [];

  constructor(
    public readonly label = "root",
    sharedRecords?: string[],
  ) {
    if (sharedRecords) {
      this.records = sharedRecords;
    }
  }

  write(val: string): void {
    this.records.push(`${this.label}:${val}`);
  }

  async $connect(): Promise<void> {
    this.connectCount++;
  }

  async $disconnect(): Promise<void> {
    if (this.failNextDisconnect) {
      this.failNextDisconnect = false;
      throw new Error("transient disconnect failure");
    }
    this.disconnectCount++;
  }

  async $queryRawUnsafe(query: string): Promise<unknown> {
    return query === "SELECT 1" ? [{ ok: 1 }] : [];
  }

  async $transaction(arg: any): Promise<any> {
    if (Array.isArray(arg)) {
      return await Promise.all(arg);
    }
    const snapshot = [...this.records];
    const tx = new RichPrismaClient(`${this.label}>tx`, this.records);
    try {
      return await arg(tx);
    } catch (err) {
      this.records.length = 0;
      this.records.push(...snapshot);
      throw err;
    }
  }
}

describe("@bunest/sql Audited Bug Fixes & DX Completeness", () => {
  const openServices: SqlService[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (openServices.length > 0) {
      await openServices.pop()!.close();
    }
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("BUG-1: DrizzleService.transactionSync() and transaction() work cleanly with synchronous drizzle-orm/bun-sqlite", async () => {
    const syncDb = new SyncBunSqliteDrizzleDb("sqlite");
    const service = new DrizzleService({ db: syncDb });

    // Synchronous transactionSync with nested savepoint rollback
    const rows = service.transactionSync((tx) => {
      expect(service.isInTransaction()).toBe(true);
      expect(service.getCurrentTransaction()).toBe(tx);
      service.db.insert("a");

      try {
        service.transactionSync(() => {
          service.db.insert("aborted");
          throw new Error("inner-sync-fail");
        });
      } catch {
        // swallowed
      }

      service.db.insert("b");
      return service.db.all();
    });
    expect(rows).toEqual(["sqlite>tx:a", "sqlite>tx:b"]);
    expect(service.isInTransaction()).toBe(false);

    // Even async service.transaction() works with a synchronous callback on sync drizzle-orm/bun-sqlite!
    const syncViaAsync = await service.transaction(() => {
      service.db.insert("c");
      return service.db.all();
    });
    expect(syncViaAsync).toEqual(["sqlite>tx:a", "sqlite>tx:b", "sqlite>tx:c"]);
  });

  it("BUG-2: DrizzleService.close() still closes underlying client when onDestroy throws", async () => {
    let clientClosed = 0;
    const service = new DrizzleService({
      db: new SyncBunSqliteDrizzleDb(),
      onDestroy: () => {
        throw new Error("onDestroy exploded");
      },
      client: {
        close: () => {
          clientClosed++;
        },
      },
    });

    await expect(service.close()).rejects.toThrow("onDestroy exploded");
    expect(service.isClosed).toBe(true);
    expect(clientClosed).toBe(1);
  });

  it("BUG-3 & BUG-7: SqlMigrationRunner uses .simple() for multi-statement PostgreSQL SQL and session-pinned reserved advisory locks", async () => {
    const simpleCalls: string[] = [];
    const poolQueries: string[] = [];
    const reservedQueries: string[] = [];
    let reserveCount = 0;
    let releaseCount = 0;

    const createDialectMock = (
      adapter: "postgres" | "mysql",
      opts: {
        mysqlLockResult?: number | null;
        failUnlock?: boolean;
      } = {},
    ) => {
      const makeTaggedFn = (sink: string[]) =>
        ((first: unknown) => {
          if (typeof first === "string") return { identifier: first };
          if (Array.isArray(first)) {
            const text = (first as readonly string[]).join("?");
            sink.push(text);
            if (text.includes("MAX(batch)")) {
              return Promise.resolve([{ max_batch: 0 }]);
            }
            if (text.includes("GET_LOCK")) {
              const val =
                "mysqlLockResult" in opts ? opts.mysqlLockResult : 1;
              return Promise.resolve([{ acquired: val }]);
            }
            if (
              opts.failUnlock &&
              (text.includes("pg_advisory_unlock") ||
                text.includes("RELEASE_LOCK"))
            ) {
              return Promise.reject(new Error("unlock-network-error"));
            }
            return Promise.resolve([]);
          }
          return { value: first };
        }) as unknown as Bun.SQL;

      const fn = makeTaggedFn(poolQueries);
      Object.defineProperty(fn, "options", {
        value: { adapter },
        configurable: true,
      });
      fn.reserve = (async () => {
        reserveCount++;
        const reservedFn = makeTaggedFn(reservedQueries) as unknown as Bun.ReservedSQL;
        reservedFn.release = async () => {
          releaseCount++;
        };
        return reservedFn;
      }) as unknown as Bun.SQL["reserve"];
      fn.unsafe = ((query: string) => {
        const p = Promise.resolve([]) as any;
        p.simple = () => {
          simpleCalls.push(query);
          return Promise.resolve([]);
        };
        return p;
      }) as unknown as Bun.SQL["unsafe"];
      fn.begin = (async (cbOrOpts: unknown, maybeCb?: unknown) => {
        const cb = (typeof cbOrOpts === "function" ? cbOrOpts : maybeCb) as (
          tx: Bun.SQL,
        ) => Promise<unknown>;
        return await cb(fn);
      }) as unknown as Bun.SQL["begin"];
      fn.close = (async () => {}) as unknown as Bun.SQL["close"];
      return fn;
    };

    // 1. PostgreSQL: multi-statement uses .simple(), lock/unlock run on SAME reserved connection, never pool!
    const pgSvc = new SqlService({ client: createDialectMock("postgres") });
    const multiStmtSql =
      "CREATE TABLE a (id INT); CREATE INDEX idx_a ON a(id);";
    const pgRunner = new SqlMigrationRunner(
      pgSvc,
      [{ id: "001_multi", up: multiStmtSql, down: "DROP TABLE a;" }],
      "_bunest_migrations",
      { advisoryLock: true },
    );

    await pgRunner.up();
    expect(simpleCalls).toContain(multiStmtSql);
    expect(reserveCount).toBe(1);
    expect(releaseCount).toBe(1);
    expect(reservedQueries.some((q) => q.includes("pg_advisory_lock"))).toBe(
      true,
    );
    expect(reservedQueries.some((q) => q.includes("pg_advisory_unlock"))).toBe(
      true,
    );
    expect(poolQueries.some((q) => q.includes("pg_advisory_lock"))).toBe(false);
    expect(poolQueries.some((q) => q.includes("pg_advisory_unlock"))).toBe(
      false,
    );
    await pgSvc.close();

    // 2. PostgreSQL unlock failure STILL calls reserved.release() in outer finally!
    reservedQueries.length = 0;
    const pgFailUnlockSvc = new SqlService({
      client: createDialectMock("postgres", { failUnlock: true }),
    });
    const pgFailUnlockRunner = new SqlMigrationRunner(
      pgFailUnlockSvc,
      [{ id: "001_ok", up: async () => {} }],
      "_bunest_migrations",
      { advisoryLock: true },
    );
    await expect(pgFailUnlockRunner.up()).rejects.toThrow(
      "unlock-network-error",
    );
    expect(reserveCount).toBe(2);
    expect(releaseCount).toBe(2);
    await pgFailUnlockSvc.close();

    // 3. MySQL advisory lock on reserved connection (even when migration fails -> RELEASE_LOCK + release() run!)
    poolQueries.length = 0;
    reservedQueries.length = 0;
    const mysqlSvc = new SqlService({
      client: createDialectMock("mysql", { mysqlLockResult: 1 }),
    });
    const mysqlRunner = new SqlMigrationRunner(mysqlSvc, [
      {
        id: "001_fail",
        up: () => {
          throw new Error("boom");
        },
      },
    ]);
    await expect(
      mysqlRunner.up(undefined, {
        advisoryLock: true,
        advisoryLockId: "mig_lock",
      }),
    ).rejects.toThrow("boom");
    expect(reserveCount).toBe(3);
    expect(releaseCount).toBe(3);
    expect(reservedQueries.some((q) => q.includes("GET_LOCK"))).toBe(true);
    expect(reservedQueries.some((q) => q.includes("RELEASE_LOCK"))).toBe(true);
    expect(poolQueries.some((q) => q.includes("GET_LOCK"))).toBe(false);
    await mysqlSvc.close();

    // 4. MySQL GET_LOCK returning 0 (timeout) rejects, skips migrations & RELEASE_LOCK, and still releases reserved connection!
    reservedQueries.length = 0;
    let ranWhenLocked = false;
    const mysqlTimeoutSvc = new SqlService({
      client: createDialectMock("mysql", { mysqlLockResult: 0 }),
    });
    const mysqlTimeoutRunner = new SqlMigrationRunner(mysqlTimeoutSvc, [
      {
        id: "001_never",
        up: () => {
          ranWhenLocked = true;
        },
      },
    ]);
    await expect(
      mysqlTimeoutRunner.up(undefined, { advisoryLock: true }),
    ).rejects.toThrow(/Failed to acquire MySQL migration advisory lock.*0/);
    expect(ranWhenLocked).toBe(false);
    expect(reservedQueries.some((q) => q.includes("GET_LOCK"))).toBe(true);
    expect(reservedQueries.some((q) => q.includes("RELEASE_LOCK"))).toBe(false);
    expect(reserveCount).toBe(4);
    expect(releaseCount).toBe(4);
    await mysqlTimeoutSvc.close();

    // 5. MySQL GET_LOCK returning null (error) rejects, skips RELEASE_LOCK, and still releases reserved connection!
    reservedQueries.length = 0;
    const mysqlNullSvc = new SqlService({
      client: createDialectMock("mysql", { mysqlLockResult: null }),
    });
    const mysqlNullRunner = new SqlMigrationRunner(mysqlNullSvc, [
      { id: "001_never", up: async () => {} },
    ]);
    await expect(
      mysqlNullRunner.up(undefined, { advisoryLock: true }),
    ).rejects.toThrow(/Failed to acquire MySQL migration advisory lock.*null/);
    expect(reservedQueries.some((q) => q.includes("RELEASE_LOCK"))).toBe(false);
    expect(reserveCount).toBe(5);
    expect(releaseCount).toBe(5);
    await mysqlNullSvc.close();
  });

  it("BUG-4: SqlMigrationRunner.status() and getApplied() never execute write DDL", async () => {
    // 1. SQLite: no CREATE TABLE executed on status()
    const svc = new SqlService("sqlite://:memory:");
    openServices.push(svc);
    const runner = new SqlMigrationRunner(svc, [
      { id: "001", up: "CREATE TABLE x (id INTEGER PRIMARY KEY)" },
    ]);

    const status = await runner.status();
    expect(status.applied).toEqual([]);
    expect(status.pending).toHaveLength(1);

    const tables = await svc.sql<{ name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_bunest_migrations'
    `;
    expect(tables).toHaveLength(0);

    // 2. Postgres missing table (42P01) returns [] without DDL
    let unsafeInvoked = 0;
    const pgRoMock = ((first: unknown) => {
      if (typeof first === "string") return { identifier: first };
      return Promise.reject(Object.assign(new Error('relation "_bunest_migrations" does not exist'), { code: "42P01" }));
    }) as unknown as Bun.SQL;
    Object.defineProperty(pgRoMock, "options", { value: { adapter: "postgres" } });
    pgRoMock.unsafe = (() => {
      unsafeInvoked++;
      return Promise.resolve([]);
    }) as any;
    pgRoMock.close = (async () => {}) as any;

    const pgRoSvc = new SqlService({ client: pgRoMock });
    const pgRoRunner = new SqlMigrationRunner(pgRoSvc, [{ id: "001", up: "SELECT 1" }]);
    expect(await pgRoRunner.getApplied()).toEqual([]);
    expect(unsafeInvoked).toBe(0);
    await pgRoSvc.close();
  });

  it("BUG-5: SqlService.transaction() serializes concurrent nested savepoints on sqlite:// without interleaving corruption", async () => {
    const svc = new SqlService("sqlite://:memory:");
    openServices.push(svc);
    await svc.sql`CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)`;

    await svc.transaction(async () => {
      await svc.sql`INSERT INTO items (name) VALUES (${"outer-1"})`;

      const [a, b, c] = await Promise.all([
        svc
          .transaction(async () => {
            await svc.sql`INSERT INTO items (name) VALUES (${"a-rollback"})`;
            await Bun.sleep(15);
            throw new Error("a-failed");
          })
          .catch((e: Error) => e.message),
        svc.transaction(async () => {
          await svc.sql`INSERT INTO items (name) VALUES (${"b-keep"})`;
          await Bun.sleep(5);
          await svc.transaction(async () => {
            await svc.sql`INSERT INTO items (name) VALUES (${"b-nested-keep"})`;
          });
          return "b-ok";
        }),
        svc.transaction(async () => {
          await svc.sql`INSERT INTO items (name) VALUES (${"c-keep"})`;
          return "c-ok";
        }),
      ]);

      expect(a).toBe("a-failed");
      expect(b).toBe("b-ok");
      expect(c).toBe("c-ok");
    });

    const rows = await svc.sql<{ name: string }>`SELECT name FROM items ORDER BY id`;
    expect([...rows].map((r) => r.name)).toEqual([
      "outer-1",
      "b-keep",
      "b-nested-keep",
      "c-keep",
    ]);
  });

  it("BUG-6: PrismaServiceBase.disconnect() allows retry after transient failure and guards disconnected client access", async () => {
    const client = new RichPrismaClient();
    client.failNextDisconnect = true;
    const svc = new PrismaServiceBase(client);
    await svc.connect();

    await expect(svc.disconnect()).rejects.toThrow("transient disconnect failure");
    expect(svc.isDisconnected).toBe(false);

    // Retry succeeds cleanly!
    await svc.disconnect();
    expect(svc.isDisconnected).toBe(true);
    expect(client.disconnectCount).toBe(1);
    expect(() => svc.client).toThrow(/has been disconnected/);
    expect(await svc.healthCheck()).toBe(false);
  });

  it("BUG-8 + ALS transactionalProxy: PrismaModule.forRootAsync({ useExisting }) and ALS-aware @InjectDrizzle() / @InjectPrisma()", async () => {
    // 1. PrismaModule.forRootAsync({ useExisting })
    const existingClient = new RichPrismaClient("existing");
    @Injectable()
    class SharedPrismaFactory implements PrismaOptionsFactory<RichPrismaClient> {
      createPrismaOptions(): PrismaModuleOptions<RichPrismaClient> {
        return {
          client: existingClient,
          transactionalProxy: true,
        };
      }
    }

    @Module({
      providers: [SharedPrismaFactory],
      exports: [SharedPrismaFactory],
    })
    class PrismaFactoryMod {}

    @Injectable()
    class ProxyConsumer {
      constructor(
        @InjectPrisma() public readonly prisma: RichPrismaClient,
        public readonly prismaSvc: PrismaServiceBase<RichPrismaClient>,
        @InjectDrizzle() public readonly drizzle: SyncBunSqliteDrizzleDb,
        public readonly drizzleSvc: DrizzleService<SyncBunSqliteDrizzleDb>,
      ) {}
    }

    const drizzleDb = new SyncBunSqliteDrizzleDb("drz");
    const mod = await Test.createTestingModule({
      imports: [
        PrismaModule.forRootAsync({
          imports: [PrismaFactoryMod],
          useExisting: SharedPrismaFactory,
        }),
        DrizzleModule.forRoot({
          db: drizzleDb,
          transactionalProxy: true,
          healthCheck: () => true,
        }),
      ],
      providers: [ProxyConsumer],
    }).compile();

    await mod.init();
    try {
      const consumer = mod.get(ProxyConsumer);
      expect(existingClient.connectCount).toBe(1);

      // @InjectPrisma() proxy automatically routes into active transaction()!
      consumer.prisma.write("outside");
      await consumer.prismaSvc.transaction(async () => {
        consumer.prisma.write("inside");
      });
      expect(existingClient.records).toEqual([
        "existing:outside",
        "existing>tx:inside",
      ]);

      // @InjectDrizzle() proxy automatically routes into active transactionSync()!
      consumer.drizzle.insert("outside");
      consumer.drizzleSvc.transactionSync(() => {
        consumer.drizzle.insert("inside");
      });
      expect(drizzleDb.all()).toEqual(["drz:outside", "drz>tx:inside"]);

      // Health checks & batchTransaction
      expect(await consumer.drizzleSvc.healthCheck()).toBe(true);
      expect(await consumer.prismaSvc.healthCheck()).toBe(true);
      const batch = await consumer.prismaSvc.batchTransaction([
        Promise.resolve(1),
        Promise.resolve("two"),
      ]);
      expect(batch).toEqual([1, "two"]);
    } finally {
      await mod.close();
    }
    expect(existingClient.disconnectCount).toBe(1);
  });

  it("supports SqlModule migration DI (autoMigrate, @InjectSqlMigrations), native Bun.SQL features (connect, reserve, simple, queryScalar, file, json, array, onQuery, asyncDispose), and ORM edge cases", async () => {
    const queryEvents: SqlQueryEvent[] = [];
    const migrations: MigrationDefinition<SqlService>[] = [
      {
        id: "001_notes",
        up: "CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL)",
        down: "DROP TABLE notes",
      },
    ];

    @Injectable()
    class NotesService {
      constructor(
        public readonly sql: SqlService,
        @InjectSqlMigrations() public readonly migrations: SqlMigrationRunner<SqlService>,
      ) {}
    }

    const mod = await Test.createTestingModule({
      imports: [
        SqlModule.forRoot({
          url: "sqlite://:memory:",
          connectOnInit: true,
          autoMigrate: true,
          migrations,
          onQuery: (e) => queryEvents.push(e),
        }),
      ],
      providers: [NotesService],
    }).compile();

    await mod.init();
    try {
      const notes = mod.get(NotesService);
      expect(getSqlMigrationRunnerToken()).toBe("bunest:sql:migrations:default");
      expect((await notes.migrations.status()).applied).toHaveLength(1);

      await notes.sql.simple(
        "INSERT INTO notes (body) VALUES ('hello'); INSERT INTO notes (body) VALUES ('world');",
      );
      expect(
        await notes.sql.queryScalar<number>("SELECT COUNT(*) AS cnt FROM notes"),
      ).toBe(2);
      expect(
        await notes.sql.queryScalar<string>(
          "SELECT body FROM notes WHERE id = ?",
          [999],
        ),
      ).toBeNull();
      expect(queryEvents.length).toBeGreaterThanOrEqual(2);

      // connect() on sqlite & reserve()/json()/array()/begin(options) on pooled Postgres client mock
      await notes.sql.connect();
      let released = false;
      let capturedTxOptions: string | undefined;
      const mockPgClient = {
        options: { adapter: "postgres" },
        reserve: async () => ({
          release: () => {
            released = true;
          },
        }),
        json: (v: unknown) => ({ __json: v }),
        array: (v: unknown[], typeName?: string) => ({ __array: v, typeName }),
        begin: async (optsOrCb: unknown, maybeCb?: unknown) => {
          if (typeof optsOrCb === "string") {
            capturedTxOptions = optsOrCb;
            return await (maybeCb as (tx: unknown) => Promise<unknown>)(
              mockPgClient,
            );
          }
          return await (optsOrCb as (tx: unknown) => Promise<unknown>)(
            mockPgClient,
          );
        },
        close: async () => {},
      } as unknown as Bun.SQL;
      const pooledSvc = new SqlService({ client: mockPgClient });
      const reserved = await pooledSvc.reserve();
      reserved.release();
      expect(released).toBe(true);
      expect(pooledSvc.json({ a: 1 })).toEqual({ __json: { a: 1 } } as any);
      expect(pooledSvc.array([1, 2, 3], "int4")).toEqual({
        __array: [1, 2, 3],
        typeName: "int4",
      } as any);
      const txVal = await pooledSvc.transaction(async () => "isolated", {
        options: "isolation level serializable",
      });
      expect(txVal).toBe("isolated");
      expect(capturedTxOptions).toBe("isolation level serializable");
      await pooledSvc.close();
      await expect(pooledSvc.reserve()).rejects.toThrow(/closed/i);

      // file()
      const dir = mkdtempSync(join(tmpdir(), "bunest-sql-file-"));
      tempDirs.push(dir);
      const sqlFile = join(dir, "q.sql");
      writeFileSync(sqlFile, "SELECT body FROM notes ORDER BY id ASC", "utf8");
      const fileRows = await notes.sql.file<{ body: string }>(sqlFile);
      expect([...fileRows]).toEqual([{ body: "hello" }, { body: "world" }]);

      // SQLite adapter throws descriptive error on Postgres-only json()/array() helpers
      expect(() => notes.sql.json({ a: 1 })).toThrow(/support.*json/i);
      expect(() => notes.sql.array([1, 2, 3])).toThrow(/support.*array/i);
    } finally {
      await mod.close();
    }

    // Symbol.asyncDispose + closeTimeout
    let disposedSql!: SqlService;
    {
      await using scopedSql = new SqlService({
        url: "sqlite://:memory:",
        closeTimeout: 1,
      });
      disposedSql = scopedSql;
      expect(await scopedSql.healthCheck()).toBe(true);
    }
    expect(disposedSql.isClosed).toBe(true);

    // SqlMigrationRunner edge cases (rollback on fail, duplicate/empty id, non-tx, missing down/def, latest batch)
    const mSvc = new SqlService("sqlite://:memory:");
    openServices.push(mSvc);
    const mRunner = new SqlMigrationRunner(mSvc);
    await expect(mRunner.status([{ id: "", up: "SELECT 1" }])).rejects.toThrow(
      /non-empty/,
    );
    await expect(
      mRunner.status([
        { id: "m1", up: "SELECT 1" },
        { id: "m1", up: "SELECT 1" },
      ]),
    ).rejects.toThrow(/Duplicate/);

    await expect(
      mRunner.up([
        {
          id: "001_fail_tx",
          up: async (db) => {
            await db.unsafe("CREATE TABLE tmp_rb (id INT)");
            throw new Error("tx-fail");
          },
        },
      ]),
    ).rejects.toThrow("tx-fail");
    expect((await mRunner.status()).applied).toHaveLength(0);

    await mRunner.up([
      {
        id: "001_a",
        up: "CREATE TABLE t1 (id INT)",
        transactional: false,
      },
    ]);
    await mRunner.up([
      { id: "001_a", up: "CREATE TABLE t1 (id INT)" },
      {
        id: "002_b",
        up: "CREATE TABLE t2 (id INT)",
        down: "DROP TABLE t2",
      },
    ]);
    // Default down() reverts latest batch (002_b)
    const rev = await mRunner.down([
      { id: "001_a", up: "CREATE TABLE t1 (id INT)" },
      { id: "002_b", up: "CREATE TABLE t2 (id INT)", down: "DROP TABLE t2" },
    ]);
    expect(rev.map((r) => r.id)).toEqual(["002_b"]);

    // Missing down handler & missing definition
    await expect(
      mRunner.down([{ id: "001_a", up: "SELECT 1" }]),
    ).rejects.toThrow(/no "down" handler/);
    await expect(mRunner.down([])).rejects.toThrow(/definition not found/);

    // ORM edge cases: Drizzle autoClose: false, closed-state, missing transaction(); Prisma missing client/$transaction/disconnectOnDestroy: false/mapPrismaErrorToHttp
    let shouldStayOpen = 0;
    const noCloseDrizzle = new DrizzleService({
      db: {},
      autoClose: false,
      client: { close: () => { shouldStayOpen++; } },
    });
    await expect(noCloseDrizzle.transaction(async () => 1)).rejects.toThrow(
      /does not implement transaction/,
    );
    await noCloseDrizzle[Symbol.asyncDispose]();
    expect(shouldStayOpen).toBe(0);
    expect(() => noCloseDrizzle.db).toThrow(/has been closed/);

    const noClientPrisma = new PrismaServiceBase();
    expect(() => noClientPrisma.rawClient).toThrow(/has no Prisma client/);

    const noTxClient = {
      $connect: async () => {},
      $disconnect: async () => {
        shouldStayOpen++;
      },
    };
    const noTxPrisma = new PrismaServiceBase(noTxClient, {
      disconnectOnDestroy: false,
    });
    await expect(noTxPrisma.transaction(async () => 1)).rejects.toThrow(
      /does not implement \$transaction/,
    );
    expect(noTxPrisma.getCurrentTransaction()).toBeUndefined();
    await noTxPrisma.onModuleDestroy();
    expect(shouldStayOpen).toBe(0);

    // mapPrismaErrorToHttp
    expect(
      mapPrismaErrorToHttp(Object.assign(new Error("unique"), { code: "P2002" })),
    ).toBeInstanceOf(ConflictException);
    expect(
      mapPrismaErrorToHttp(Object.assign(new Error("missing"), { code: "P2025" })),
    ).toBeInstanceOf(NotFoundException);
    expect(
      mapPrismaErrorToHttp(Object.assign(new Error("fk"), { code: "P2003" })),
    ).toBeInstanceOf(BadRequestException);
    expect(
      mapPrismaErrorToHttp(Object.assign(new Error("pool"), { code: "P2024" })),
    ).toBeInstanceOf(ServiceUnavailableException);
    expect(mapPrismaErrorToHttp(new Error("other"))).toBeUndefined();
  });
});
