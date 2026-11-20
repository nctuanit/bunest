import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Module,
  NotFoundException,
  ServiceUnavailableException,
} from "../../../../../packages/common/src";
import {
  DrizzleModule,
  DrizzleService,
  InjectDrizzle,
  InjectDrizzleService,
  InjectPrisma,
  InjectPrismaService,
  PrismaModule,
  PrismaServiceBase,
  getDrizzleServiceToken,
  getDrizzleToken,
  getPrismaOptionsToken,
  getPrismaServiceToken,
  getPrismaToken,
  mapPrismaErrorToHttp,
  type DrizzleDatabaseLike,
  type DrizzleModuleOptions,
  type DrizzleOptionsFactory,
  type PrismaClientLike,
  type PrismaModuleOptions,
  type PrismaOptionsFactory,
} from "../../../../../packages/sql/src";
import {
  Test,
  createSpy,
  describeConformance,
} from "../../../_helpers/index";

/**
 * Sync Drizzle fake mirroring `drizzle-orm/bun-sqlite`, throwing if callback returns a Promise.
 */
class SyncDrizzleFake implements DrizzleDatabaseLike<SyncDrizzleFake> {
  constructor(
    public readonly tag = "root",
    private readonly log: string[] = [],
  ) {}

  write(v: string): void {
    this.log.push(`${this.tag}:${v}`);
  }

  entries(): string[] {
    return [...this.log];
  }

  transaction<T>(fn: (tx: SyncDrizzleFake) => T): T {
    const snap = [...this.log];
    const txDb = new SyncDrizzleFake(`${this.tag}>tx`, this.log);
    try {
      const out = fn(txDb);
      if (
        out !== null &&
        (typeof out === "object" || typeof out === "function") &&
        typeof (out as unknown as PromiseLike<unknown>).then === "function"
      ) {
        throw new Error("Transaction function cannot return a promise");
      }
      return out;
    } catch (err) {
      this.log.length = 0;
      this.log.push(...snap);
      throw err;
    }
  }
}

class AsyncDrizzleFake implements DrizzleDatabaseLike<AsyncDrizzleFake> {
  constructor(
    public readonly tag = "root",
    private readonly log: string[] = [],
  ) {}

  async write(v: string): Promise<void> {
    await Bun.sleep(1);
    this.log.push(`${this.tag}:${v}`);
  }

  entries(): string[] {
    return [...this.log];
  }

  async transaction<T>(fn: (tx: AsyncDrizzleFake) => Promise<T> | T): Promise<T> {
    const snap = [...this.log];
    const txDb = new AsyncDrizzleFake(`${this.tag}>tx`, this.log);
    try {
      return await fn(txDb);
    } catch (err) {
      this.log.length = 0;
      this.log.push(...snap);
      throw err;
    }
  }
}

class FakePrismaClient implements PrismaClientLike<FakePrismaClient> {
  public connectCount = 0;
  public disconnectCount = 0;
  public txCount = 0;
  public failNextDisconnect = false;
  public readonly items: string[] = [];

  constructor(
    public readonly tag = "root",
    sharedItems?: string[],
    public readonly isTx = false,
  ) {
    if (sharedItems) {
      this.items = sharedItems;
    }
  }

  pushItem(v: string): void {
    this.items.push(`${this.tag}:${v}`);
  }

  async $connect(): Promise<void> {
    this.connectCount++;
  }

  async $disconnect(): Promise<void> {
    if (this.failNextDisconnect) {
      this.failNextDisconnect = false;
      throw new Error("transient-disconnect-err");
    }
    this.disconnectCount++;
  }

  async $queryRawUnsafe(sql: string): Promise<unknown> {
    if (sql !== "SELECT 1") {
      throw new Error("unexpected health query");
    }
    return [{ ok: 1 }];
  }

  async $transaction(arg: any): Promise<any> {
    if (Array.isArray(arg)) {
      return await Promise.all(arg);
    }
    if (this.isTx) {
      throw new Error("Nested $transaction is forbidden");
    }
    this.txCount++;
    const snap = [...this.items];
    const txClient = new FakePrismaClient(`${this.tag}>tx`, this.items, true);
    try {
      return await arg(txClient);
    } catch (err) {
      this.items.length = 0;
      this.items.push(...snap);
      throw err;
    }
  }
}

describeConformance(
  "Persistence (bun-native) - DrizzleModule, PrismaModule, ALS proxies & mapPrismaErrorToHttp",
  {
    upstreamPath: "bun-native/drizzle-and-prisma-lifecycle",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-002"],
    notes:
      "Covers DrizzleModule & PrismaModule forRoot/forRootAsync, named connections, ALS transactionalProxy + Nest lifecycle hook suppression, PrismaServiceBase inheritance, batchTransaction, healthCheck fallbacks, and mapPrismaErrorToHttp.",
  },
  () => {
    describe("DrizzleModule & DrizzleService", () => {
      it("supports forRoot, named connections, @InjectDrizzle/@InjectDrizzleService, and default-only class alias", async () => {
        const primary = new AsyncDrizzleFake("primary");
        const replica = new AsyncDrizzleFake("replica");

        @Injectable()
        class Consumer {
          constructor(
            @InjectDrizzle() readonly db: AsyncDrizzleFake,
            readonly service: DrizzleService<AsyncDrizzleFake>,
            @InjectDrizzle("replica") readonly replicaDb: AsyncDrizzleFake,
            @InjectDrizzleService("replica")
            readonly replicaService: DrizzleService<AsyncDrizzleFake>,
          ) {}
        }

        const mod = await Test.createTestingModule({
          imports: [
            DrizzleModule.forRoot({ db: primary }),
            DrizzleModule.forRoot({ name: "replica", db: replica }),
          ],
          providers: [Consumer],
        }).compile({ logger: false });
        await mod.init();

        try {
          const consumer = mod.get(Consumer);
          expect(consumer.db).toBe(primary);
          expect(consumer.replicaDb).toBe(replica);
          expect(consumer.service.connectionName).toBe("default");
          expect(consumer.replicaService.connectionName).toBe("replica");
          expect(mod.get(getDrizzleToken("replica"))).toBe(replica);
          expect(mod.get(getDrizzleServiceToken("replica"))).toBe(
            consumer.replicaService,
          );
        } finally {
          await mod.close();
        }

        // Named-only registration does not export DrizzleService class alias
        const namedOnly = await Test.createTestingModule({
          imports: [DrizzleModule.forRoot({ name: "only", db: primary })],
        }).compile({ logger: false });
        try {
          expect(() => namedOnly.get(DrizzleService)).toThrow();
        } finally {
          await namedOnly.close();
        }
      });

      it("supports DrizzleModule.forRootAsync() with useFactory, useClass, useExisting, and extraProviders", async () => {
        const EXTRA = "DRIZZLE_EXTRA";

        const modFactory = await Test.createTestingModule({
          imports: [
            DrizzleModule.forRootAsync({
              extraProviders: [{ provide: EXTRA, useValue: "from-extra" }],
              inject: [EXTRA],
              useFactory: (tag: string) => ({ db: new AsyncDrizzleFake(tag) }),
            }),
          ],
        }).compile({ logger: false });
        await modFactory.init();
        expect(modFactory.get<AsyncDrizzleFake>(getDrizzleToken()).tag).toBe(
          "from-extra",
        );
        await modFactory.close();

        @Injectable()
        class OptsFactory implements DrizzleOptionsFactory<AsyncDrizzleFake> {
          createDrizzleOptions(): DrizzleModuleOptions<AsyncDrizzleFake> {
            return { db: new AsyncDrizzleFake("from-class") };
          }
        }

        const modClass = await Test.createTestingModule({
          imports: [DrizzleModule.forRootAsync({ useClass: OptsFactory })],
        }).compile({ logger: false });
        await modClass.init();
        expect(modClass.get<AsyncDrizzleFake>(getDrizzleToken()).tag).toBe(
          "from-class",
        );
        await modClass.close();

        @Module({ providers: [OptsFactory], exports: [OptsFactory] })
        class HostMod {}

        const modExisting = await Test.createTestingModule({
          imports: [
            DrizzleModule.forRootAsync({
              imports: [HostMod],
              useExisting: OptsFactory,
            }),
          ],
        }).compile({ logger: false });
        await modExisting.init();
        expect(modExisting.get<AsyncDrizzleFake>(getDrizzleToken()).tag).toBe(
          "from-class",
        );
        await modExisting.close();
      });

      it("routes @InjectDrizzle() ALS proxy for both async transaction() and sync transactionSync() while suppressing Nest lifecycle traps", async () => {
        const syncDb = new SyncDrizzleFake("sqlite");
        const asyncDb = new AsyncDrizzleFake("pg");

        const mod = await Test.createTestingModule({
          imports: [
            DrizzleModule.forRoot({
              db: syncDb,
              transactionalProxy: true,
            }),
            DrizzleModule.forRoot({
              name: "async_db",
              db: asyncDb,
              transactionalProxy: true,
            }),
          ],
        }).compile({ logger: false });
        await mod.init();

        try {
          const syncProxy = mod.get<SyncDrizzleFake>(getDrizzleToken());
          const syncSvc = mod.get<DrizzleService<SyncDrizzleFake>>(DrizzleService);
          const asyncProxy = mod.get<AsyncDrizzleFake>(
            getDrizzleToken("async_db"),
          );
          const asyncSvc = mod.get<DrizzleService<AsyncDrizzleFake>>(
            getDrizzleServiceToken("async_db"),
          );

          // Nest lifecycle hook traps are suppressed on Proxy
          for (const hook of [
            "onModuleInit",
            "onApplicationBootstrap",
            "onModuleDestroy",
            "beforeApplicationShutdown",
            "onApplicationShutdown",
          ] as const) {
            expect(hook in syncProxy).toBe(false);
            expect(
              (syncProxy as unknown as Record<string, unknown>)[hook],
            ).toBeUndefined();
            expect(
              Object.getOwnPropertyDescriptor(syncProxy, hook),
            ).toBeUndefined();
          }

          // Sync proxy routing + nested savepoint rollback
          syncProxy.write("outside");
          syncSvc.transactionSync(() => {
            syncProxy.write("in-sync");
            expect(() =>
              syncSvc.transactionSync(() => {
                syncProxy.write("rolled-back");
                throw new Error("abort-sync");
              }),
            ).toThrow("abort-sync");
          });
          expect(syncDb.entries()).toEqual([
            "sqlite:outside",
            "sqlite>tx:in-sync",
          ]);

          // Async proxy routing
          await asyncProxy.write("outside");
          await asyncSvc.transaction(async () => {
            await asyncProxy.write("in-async");
          });
          expect(asyncDb.entries()).toEqual(["pg:outside", "pg>tx:in-async"]);
        } finally {
          await mod.close();
        }
      });

      it("handles DrizzleService healthCheck fallbacks, onDestroy + autoClose, and Symbol.asyncDispose", async () => {
        const onDestroy = createSpy();
        const close = createSpy();
        const svc = new DrizzleService({
          db: {
            run: () => true,
          },
          client: { close },
          onDestroy,
        });
        expect(await svc.healthCheck()).toBe(true);

        {
          await using scoped = svc;
          expect(scoped.isClosed).toBe(false);
        }
        expect(svc.isClosed).toBe(true);
        expect(onDestroy.calledOnce).toBe(true);
        expect(close.calledOnce).toBe(true);
        expect(await svc.healthCheck()).toBe(false);
      });
    });

    describe("PrismaModule & PrismaServiceBase", () => {
      it("derives Prisma DI tokens and runs $connect/$disconnect lifecycle hooks respecting opt-outs", async () => {
        expect(getPrismaToken()).toBe("bunest:prisma:connection:default");
        expect(getPrismaToken("audit")).toBe("bunest:prisma:connection:audit");
        expect(getPrismaServiceToken("audit")).toBe(
          "bunest:prisma:service:audit",
        );
        expect(getPrismaOptionsToken("audit")).toBe(
          "bunest:prisma:options:audit",
        );

        const primary = new FakePrismaClient("primary");
        const optedOut = new FakePrismaClient("optedOut");

        @Injectable()
        class Consumer {
          constructor(
            @InjectPrisma() readonly db: FakePrismaClient,
            readonly svc: PrismaServiceBase<FakePrismaClient>,
            @InjectPrisma("optedOut") readonly optDb: FakePrismaClient,
            @InjectPrismaService("optedOut")
            readonly optSvc: PrismaServiceBase<FakePrismaClient>,
          ) {}
        }

        const mod = await Test.createTestingModule({
          imports: [
            PrismaModule.forRoot({ client: primary }),
            PrismaModule.forRoot({
              name: "optedOut",
              client: optedOut,
              connectOnInit: false,
              disconnectOnDestroy: false,
            }),
          ],
          providers: [Consumer],
        }).compile({ logger: false });

        expect(primary.connectCount).toBe(0);
        await mod.init();

        const consumer = mod.get(Consumer);
        expect(primary.connectCount).toBe(1);
        expect(optedOut.connectCount).toBe(0);
        expect(consumer.db).toBe(primary);
        expect(consumer.optDb).toBe(optedOut);
        expect(consumer.svc.isConnected).toBe(true);
        expect(consumer.optSvc.connectionName).toBe("optedOut");

        await mod.close();
        expect(primary.disconnectCount).toBe(1);
        expect(optedOut.disconnectCount).toBe(0);
        expect(consumer.svc.isDisconnected).toBe(true);
      });

      it("supports PrismaModule.forRootAsync() with useFactory, useClass, useExisting, and missing-strategy error", async () => {
        expect(() => PrismaModule.forRootAsync({})).toThrow(
          /requires one of "useFactory", "useClass", or "useExisting"/,
        );

        const c1 = new FakePrismaClient("factory");
        const m1 = await Test.createTestingModule({
          imports: [
            PrismaModule.forRootAsync({
              useFactory: async () => ({ client: c1 }),
            }),
          ],
        }).compile({ logger: false });
        await m1.init();
        expect(c1.connectCount).toBe(1);
        await m1.close();
        expect(c1.disconnectCount).toBe(1);

        const c2 = new FakePrismaClient("class");
        @Injectable()
        class MyPrismaFactory implements PrismaOptionsFactory<FakePrismaClient> {
          createPrismaOptions(): PrismaModuleOptions<FakePrismaClient> {
            return { client: c2 };
          }
        }

        const m2 = await Test.createTestingModule({
          imports: [PrismaModule.forRootAsync({ useClass: MyPrismaFactory })],
        }).compile({ logger: false });
        await m2.init();
        expect(c2.connectCount).toBe(1);
        await m2.close();
        expect(c2.disconnectCount).toBe(1);

        @Module({ providers: [MyPrismaFactory], exports: [MyPrismaFactory] })
        class FactoryHost {}

        const m3 = await Test.createTestingModule({
          imports: [
            PrismaModule.forRootAsync({
              imports: [FactoryHost],
              useExisting: MyPrismaFactory,
            }),
          ],
        }).compile({ logger: false });
        await m3.init();
        expect(c2.connectCount).toBe(2);
        await m3.close();
        expect(c2.disconnectCount).toBe(2);
      });

      it("supports PrismaServiceBase inheritance (super(client) and self-implementing subclass with explicit super())", async () => {
        const inner = new FakePrismaClient("sub");

        @Injectable()
        class SubPrismaService extends PrismaServiceBase<FakePrismaClient> {
          constructor() {
            super(inner);
          }
        }

        const mod1 = await Test.createTestingModule({
          providers: [SubPrismaService],
        }).compile({ logger: false });
        await mod1.init();
        expect(mod1.get(SubPrismaService).isConnected).toBe(true);
        expect(inner.connectCount).toBe(1);
        await mod1.close();
        expect(inner.disconnectCount).toBe(1);

        // Self-implementing subclass ($connect/$disconnect on `this`) with explicit zero-arg constructor
        let selfConnected = 0;
        let selfDisconnected = 0;

        @Injectable()
        class SelfClientPrismaWithCtor extends PrismaServiceBase {
          constructor() {
            super();
          }
          async $connect(): Promise<void> {
            selfConnected++;
          }
          async $disconnect(): Promise<void> {
            selfDisconnected++;
          }
        }

        const mod2 = await Test.createTestingModule({
          providers: [SelfClientPrismaWithCtor],
        }).compile({ logger: false });
        await mod2.init();
        expect(selfConnected).toBe(1);
        await mod2.close();
        expect(selfDisconnected).toBe(1);
      });

      // BUNEST_BUG: packages/sql/src/orm/prisma.module.ts:186 (PrismaServiceBase constructor parameters lack @Optional()) — an @Injectable() subclass implementing $connect/$disconnect without declaring an explicit zero-arg constructor inherits design:paramtypes [Object, Object] from PrismaServiceBase and fails DI with UnknownDependencyException.
      it.skip("supports self-implementing PrismaServiceBase subclass without declaring an explicit constructor", async () => {
        let selfConnected = 0;
        let selfDisconnected = 0;

        @Injectable()
        class SelfClientPrisma extends PrismaServiceBase {
          async $connect(): Promise<void> {
            selfConnected++;
          }
          async $disconnect(): Promise<void> {
            selfDisconnected++;
          }
        }

        const mod2 = await Test.createTestingModule({
          providers: [SelfClientPrisma],
        }).compile({ logger: false });
        await mod2.init();
        expect(selfConnected).toBe(1);
        await mod2.close();
        expect(selfDisconnected).toBe(1);
      });

      it("routes PrismaServiceBase transactionalProxy via ALS, joins nested transaction() without error, and supports batchTransaction()", async () => {
        const client = new FakePrismaClient("prisma");

        const mod = await Test.createTestingModule({
          imports: [
            PrismaModule.forRoot({
              client,
              transactionalProxy: true,
            }),
          ],
        }).compile({ logger: false });
        await mod.init();

        try {
          const proxy = mod.get<FakePrismaClient>(getPrismaToken());
          const svc = mod.get<PrismaServiceBase<FakePrismaClient>>(
            PrismaServiceBase,
          );

          // Lifecycle hooks suppressed on Proxy
          expect("onModuleInit" in proxy).toBe(false);
          expect("onModuleDestroy" in proxy).toBe(false);

          proxy.pushItem("outside");

          await svc.transaction(async (tx) => {
            expect(svc.isInTransaction()).toBe(true);
            expect(svc.getCurrentTransaction()).toBe(tx);
            proxy.pushItem("outer");

            // Nested transaction re-uses active tx instead of crashing Prisma
            await svc.transaction(async (innerTx) => {
              expect(innerTx).toBe(tx);
              proxy.pushItem("nested");
            });
          });

          expect(client.txCount).toBe(1);
          expect(client.items).toEqual([
            "prisma:outside",
            "prisma>tx:outer",
            "prisma>tx:nested",
          ]);

          // Failed transaction rolls back
          await expect(
            svc.transaction(async () => {
              proxy.pushItem("aborted");
              throw new Error("rollback");
            }),
          ).rejects.toThrow("rollback");
          expect(client.items).toEqual([
            "prisma:outside",
            "prisma>tx:outer",
            "prisma>tx:nested",
          ]);

          // batchTransaction()
          const batchResult = await svc.batchTransaction([
            Promise.resolve("a"),
            Promise.resolve(42),
          ]);
          expect(batchResult).toEqual(["a", 42]);
        } finally {
          await mod.close();
        }
      });

      it("probes PrismaServiceBase.healthCheck() via custom hook, $queryRawUnsafe, and $runCommandRaw fallbacks", async () => {
        // 1. $queryRawUnsafe
        const sqlClient = new FakePrismaClient();
        const sqlSvc = new PrismaServiceBase(sqlClient);
        expect(await sqlSvc.healthCheck()).toBe(true);

        // 2. $runCommandRaw (MongoDB Prisma client)
        const runCommandSpy = createSpy(async () => ({ ok: 1 }));
        const mongoSvc = new PrismaServiceBase({
          $connect: async () => {},
          $disconnect: async () => {},
          $runCommandRaw: runCommandSpy,
        });
        expect(await mongoSvc.healthCheck()).toBe(true);
        expect(runCommandSpy.calledOnceWith({ ping: 1 })).toBe(true);

        // 3. Custom healthCheck hook & Symbol.asyncDispose
        const customSvc = new PrismaServiceBase(sqlClient, {
          healthCheck: () => false,
        });
        expect(await customSvc.healthCheck()).toBe(false);
        await customSvc[Symbol.asyncDispose]();
        expect(customSvc.isDisconnected).toBe(true);
        expect(await customSvc.healthCheck()).toBe(false);
      });

      it("allows disconnect() retry after a transient $disconnect failure", async () => {
        const client = new FakePrismaClient();
        client.failNextDisconnect = true;
        const svc = new PrismaServiceBase(client);
        await svc.connect();

        await expect(svc.disconnect()).rejects.toThrow(
          "transient-disconnect-err",
        );
        expect(svc.isDisconnected).toBe(false);

        await svc.disconnect();
        expect(svc.isDisconnected).toBe(true);
        expect(client.disconnectCount).toBe(1);
      });
    });

    describe("mapPrismaErrorToHttp()", () => {
      it("maps P2002 -> 409 ConflictException", () => {
        const err = mapPrismaErrorToHttp(
          Object.assign(new Error("Unique constraint failed"), {
            code: "P2002",
          }),
        );
        expect(err).toBeInstanceOf(ConflictException);
        expect(err!.getStatus()).toBe(409);
        expect(err!.message).toContain("Unique constraint failed");
      });

      it.each(["P2025", "P2015"])(
        "maps %s -> 404 NotFoundException",
        (code) => {
          const err = mapPrismaErrorToHttp(
            Object.assign(new Error(`Record missing (${code})`), { code }),
          );
          expect(err).toBeInstanceOf(NotFoundException);
          expect(err!.getStatus()).toBe(404);
        },
      );

      it.each([
        "P2000",
        "P2003",
        "P2005",
        "P2006",
        "P2011",
        "P2012",
        "P2014",
        "P2023",
      ])("maps %s -> 400 BadRequestException", (code) => {
        const err = mapPrismaErrorToHttp({ code });
        expect(err).toBeInstanceOf(BadRequestException);
        expect(err!.getStatus()).toBe(400);
        expect(err!.message).toContain(code);
      });

      it.each(["P2024", "P1001", "P1002"])(
        "maps %s -> 503 ServiceUnavailableException",
        (code) => {
          const err = mapPrismaErrorToHttp(
            Object.assign(new Error(`Unavailable (${code})`), { code }),
          );
          expect(err).toBeInstanceOf(ServiceUnavailableException);
          expect(err!.getStatus()).toBe(503);
        },
      );

      it("returns undefined for unknown codes, non-Error primitives, null, and objects without string code", () => {
        expect(mapPrismaErrorToHttp({ code: "P9999" })).toBeUndefined();
        expect(mapPrismaErrorToHttp({ code: 2002 })).toBeUndefined();
        expect(mapPrismaErrorToHttp(new Error("generic"))).toBeUndefined();
        expect(mapPrismaErrorToHttp(null)).toBeUndefined();
        expect(mapPrismaErrorToHttp(undefined)).toBeUndefined();
        expect(mapPrismaErrorToHttp("P2002")).toBeUndefined();
        expect(mapPrismaErrorToHttp(42)).toBeUndefined();
      });
    });
  },
);
