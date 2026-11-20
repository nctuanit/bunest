import "reflect-metadata";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "bun:test";
import { Injectable, Module } from "@bunest/common";
import { Test } from "@bunest/testing";
import {
  BunSqliteDrizzleDatabase,
  DRIZZLE_INSTANCE,
  DrizzleModule,
  DrizzleService,
  InjectDrizzle,
  InjectDrizzleService,
  closeDrizzleClient,
  createBunSqliteDrizzle,
  getDrizzleClients,
  getDrizzleToken,
  watchDrizzleClient,
  type DrizzleModuleFactoryOptions,
  type DrizzleOptionsFactory,
} from "../src/index";

describe("@bunest/drizzle utilities & client lifecycle", () => {
  it("computes tokens matching @nestjs/drizzle@0.0.2", () => {
    expect(DRIZZLE_INSTANCE).toBe("DrizzleDatabase");
    expect(getDrizzleToken()).toBe("DrizzleDatabase");
    expect(getDrizzleToken("default")).toBe("DrizzleDatabase");
    expect(getDrizzleToken("analytics")).toBe("analyticsDrizzleDatabase");
  });

  it("discovers primary & replica clients, closes them idempotently, and watches background errors", async () => {
    let primaryEnded = 0;
    let replicaClosed = 0;
    let mysqlPromiseEnded = 0;

    const primaryClient = {
      end: async () => {
        primaryEnded++;
      },
    };
    const replicaClient = {
      close: () => {
        replicaClosed++;
      },
    };
    const mysqlCallbackClient = {
      promise: () => ({
        end: async () => {
          mysqlPromiseEnded++;
        },
      }),
    };

    const replicatedDb = {
      $client: primaryClient,
      $primary: { $client: primaryClient },
      $replicas: [{ $client: replicaClient }, { $client: mysqlCallbackClient }],
    };

    const clients = getDrizzleClients(replicatedDb);
    expect(clients).toHaveLength(3);

    // Calling close twice is idempotent via WeakSet
    for (const c of clients) {
      await closeDrizzleClient(c);
      await closeDrizzleClient(c);
    }
    expect(primaryEnded).toBe(1);
    expect(replicaClosed).toBe(1);
    expect(mysqlPromiseEnded).toBe(1);

    // Error watching on EventEmitter & node-postgres-like pool checked-out connections
    const pool = Object.assign(new EventEmitter(), {
      totalCount: 1,
      idleCount: 0,
      waitingCount: 0,
    });
    const observedErrors: unknown[] = [];
    watchDrizzleClient(pool as any, (err) => observedErrors.push(err));
    watchDrizzleClient(pool as any, (err) => observedErrors.push(err)); // idempotent

    pool.emit("error", new Error("idle-disconnect"));
    expect(observedErrors).toHaveLength(1);

    const checkedOutConn = new EventEmitter();
    pool.emit("acquire", checkedOutConn);
    checkedOutConn.emit("error", new Error("mid-tx-disconnect"));
    expect(observedErrors).toHaveLength(2);
  });
});

describe("@bunest/drizzle DI, @bunest/sql ALS transactions & validation", () => {
  it("supports forRoot({ drizzle, connection }) with Bun SQLite, ALS transactions, and auto-close", async () => {
    @Injectable()
    class NotesService {
      constructor(
        @InjectDrizzle() public readonly db: BunSqliteDrizzleDatabase,
        public readonly drizzleService: DrizzleService<BunSqliteDrizzleDatabase>,
      ) {}

      initSchema() {
        this.db.run(
          "CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL)",
        );
      }

      insertInContext(body: string) {
        this.drizzleService.db.run("INSERT INTO notes (body) VALUES (?1)", [
          body,
        ]);
      }

      listAll(): Array<{ id: number; body: string }> {
        return this.db.all("SELECT id, body FROM notes ORDER BY id ASC");
      }
    }

    const mod = await Test.createTestingModule({
      imports: [
        DrizzleModule.forRoot({
          drizzle: createBunSqliteDrizzle,
          connection: ":memory:",
        }),
      ],
      providers: [NotesService],
    }).compile();

    await mod.init();
    const svc = mod.get(NotesService);
    svc.initSchema();
    expect(await svc.drizzleService.healthCheck()).toBe(true);

    // Outer transaction + rolled-back nested savepoint
    await svc.drizzleService.transaction(async () => {
      expect(svc.drizzleService.isInTransaction()).toBe(true);
      svc.insertInContext("keep-1");
      try {
        await svc.drizzleService.transaction(async () => {
          svc.insertInContext("discard-inner");
          throw new Error("rollback-inner");
        });
      } catch {
        // expected
      }
      svc.insertInContext("keep-2");
    });

    expect(svc.drizzleService.isInTransaction()).toBe(false);
    expect(svc.listAll().map((r) => r.body)).toEqual(["keep-1", "keep-2"]);

    // Shutdown closes underlying SQLite client
    let closeCalls = 0;
    const origClose = svc.db.$client.close.bind(svc.db.$client);
    svc.db.$client.close = ((...args: any[]) => {
      closeCalls++;
      return origClose(...args);
    }) as any;

    await mod.close();
    expect(closeCalls).toBe(1);
  });

  it("supports multiple named connections, autoCloseConnection: false, and forRootAsync (useFactory, useClass, useExisting)", async () => {
    let closedAnalytics = 0;
    let closedStatic = 0;

    const analyticsDb = {
      tag: "analytics",
      $client: {
        end: async () => {
          closedAnalytics++;
        },
      },
    };
    const staticDb = {
      tag: "static",
      $client: {
        close: () => {
          closedStatic++;
        },
      },
    };

    @Injectable()
    class MultiDrizzleConsumer {
      constructor(
        @InjectDrizzle() public readonly defaultDb: any,
        @InjectDrizzle("analytics") public readonly analytics: any,
        @InjectDrizzleService("analytics")
        public readonly analyticsService: DrizzleService<any>,
      ) {}
    }

    const mod = await Test.createTestingModule({
      imports: [
        DrizzleModule.forRoot({
          db: staticDb,
          autoCloseConnection: false,
        }),
        DrizzleModule.forRootAsync({
          name: "analytics",
          useFactory: async () => ({
            db: analyticsDb,
          }),
        }),
      ],
      providers: [MultiDrizzleConsumer],
    }).compile();

    await mod.init();
    const consumer = mod.get(MultiDrizzleConsumer);
    expect(consumer.defaultDb).toBe(staticDb);
    expect(consumer.analytics).toBe(analyticsDb);
    expect(consumer.analyticsService.connectionName).toBe("analytics");

    await mod.close();
    expect(closedStatic).toBe(0); // autoCloseConnection: false
    expect(closedAnalytics).toBe(1);

    // useClass & useExisting
    let receivedName: string | undefined;
    @Injectable()
    class DrizzleConfigFactory implements DrizzleOptionsFactory {
      createDrizzleOptions(
        connectionName?: string,
      ): DrizzleModuleFactoryOptions {
        receivedName = connectionName;
        return {
          drizzle: createBunSqliteDrizzle,
          connection: ":memory:",
        };
      }
    }

    const modClass = await Test.createTestingModule({
      imports: [
        DrizzleModule.forRootAsync({
          name: "factory-conn",
          useClass: DrizzleConfigFactory,
        }),
      ],
    }).compile();
    await modClass.init();
    expect(receivedName).toBe("factory-conn");
    expect(
      modClass.get(getDrizzleToken("factory-conn")),
    ).toBeInstanceOf(BunSqliteDrizzleDatabase);
    await modClass.close();

    @Module({
      providers: [DrizzleConfigFactory],
      exports: [DrizzleConfigFactory],
    })
    class FactoryModule {}

    const modExisting = await Test.createTestingModule({
      imports: [
        DrizzleModule.forRootAsync({
          name: "existing-conn",
          imports: [FactoryModule],
          useExisting: DrizzleConfigFactory,
        }),
      ],
    }).compile();
    await modExisting.init();
    expect(receivedName).toBe("existing-conn");
    await modExisting.close();
  });

  it("throws clear upstream validation errors for invalid options", async () => {
    await expect(
      Test.createTestingModule({
        imports: [
          DrizzleModule.forRoot({
            name: "   ",
            db: { $client: {} },
          }),
        ],
      }).compile(),
    ).rejects.toThrow('DrizzleModule received an empty "name"');

    await expect(
      Test.createTestingModule({
        imports: [
          DrizzleModule.forRoot({
            db: {},
            drizzle: createBunSqliteDrizzle,
          } as any),
        ],
      }).compile(),
    ).rejects.toThrow('received both a "db" and a "drizzle" option');

    await expect(
      Test.createTestingModule({
        imports: [
          DrizzleModule.forRoot({
            drizzle: "not-a-fn",
          } as any),
        ],
      }).compile(),
    ).rejects.toThrow("isn't a function");

    await expect(
      Test.createTestingModule({
        imports: [DrizzleModule.forRoot({ $client: {} } as any)],
      }).compile(),
    ).rejects.toThrow('Pass it as the "db" option: { db }');

    await expect(
      Test.createTestingModule({
        imports: [DrizzleModule.forRoot({} as any)],
      }).compile(),
    ).rejects.toThrow('registered without a "db" or "drizzle" option');

    expect(() => DrizzleModule.forRootAsync({} as any)).toThrow(
      'requires one of "useFactory", "useClass" or "useExisting"',
    );
  });
});
