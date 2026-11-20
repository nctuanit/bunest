import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { Injectable, Module } from "@bunest/common";
import { Test } from "@bunest/testing";
import {
  DrizzleModule,
  DrizzleService,
  InjectDrizzle,
  InjectDrizzleService,
  InjectPrisma,
  InjectPrismaService,
  PrismaModule,
  PrismaServiceBase,
  type DrizzleDatabaseLike,
  type DrizzleModuleOptions,
  type DrizzleOptionsFactory,
  type PrismaClientLike,
  type PrismaModuleOptions,
  type PrismaOptionsFactory,
} from "../src/index";

/**
 * Lightweight mock Drizzle instance mimicking `drizzle-orm` transaction/savepoint behavior.
 */
class FakeDrizzleDb implements DrizzleDatabaseLike<FakeDrizzleDb> {
  public readonly ops: string[] = [];

  constructor(
    public readonly label: string = "root",
    private readonly sharedStore: string[] = [],
  ) {}

  insertItem(value: string): void {
    this.ops.push(value);
    this.sharedStore.push(`${this.label}:${value}`);
  }

  getAll(): string[] {
    return [...this.sharedStore];
  }

  async transaction<T>(fn: (tx: FakeDrizzleDb) => Promise<T>): Promise<T> {
    const snapshot = [...this.sharedStore];
    const txDb = new FakeDrizzleDb(`${this.label}>tx`, this.sharedStore);
    try {
      return await fn(txDb);
    } catch (err) {
      this.sharedStore.length = 0;
      this.sharedStore.push(...snapshot);
      throw err;
    }
  }
}

/**
 * Lightweight mock Prisma Client mimicking `$connect`, `$disconnect`, and interactive `$transaction`.
 */
class FakePrismaClient implements PrismaClientLike<FakePrismaClient> {
  public connectCount = 0;
  public disconnectCount = 0;
  public transactionCount = 0;
  public readonly records: string[] = [];

  constructor(
    public readonly isTx = false,
    sharedRecords?: string[],
  ) {
    if (sharedRecords) {
      this.records = sharedRecords;
    }
  }

  async $connect(): Promise<void> {
    this.connectCount++;
  }

  async $disconnect(): Promise<void> {
    this.disconnectCount++;
  }

  async $transaction<T>(fn: (tx: FakePrismaClient) => Promise<T>): Promise<T> {
    if (this.isTx) {
      throw new Error("Nested $transaction is not supported by Prisma");
    }
    this.transactionCount++;
    const snapshot = [...this.records];
    const txClient = new FakePrismaClient(true, this.records);
    try {
      return await fn(txClient);
    } catch (err) {
      this.records.length = 0;
      this.records.push(...snapshot);
      throw err;
    }
  }
}

describe("DrizzleModule & DrizzleService", () => {
  it("injects raw Drizzle db + DrizzleService, propagates ALS transactions, and cleans up on shutdown", async () => {
    const rootDb = new FakeDrizzleDb("primary");
    const replicaDb = new FakeDrizzleDb("replica");
    let clientClosed = 0;
    let customDestroyed = 0;

    @Injectable()
    class ArticlesRepo {
      constructor(
        @InjectDrizzle() public readonly rawDb: FakeDrizzleDb,
        private readonly drizzle: DrizzleService<FakeDrizzleDb>,
        @InjectDrizzle("replica") public readonly replica: FakeDrizzleDb,
        @InjectDrizzleService("replica")
        public readonly replicaService: DrizzleService<FakeDrizzleDb>,
      ) {}

      saveInCurrentContext(title: string) {
        this.drizzle.db.insertItem(title);
      }

      async createWithNestedRollback() {
        return this.drizzle.transaction(async (outerTx) => {
          expect(this.drizzle.isInTransaction()).toBe(true);
          expect(this.drizzle.getCurrentTransaction()).toBe(outerTx);
          this.saveInCurrentContext("post-1");

          try {
            await this.drizzle.transaction(async (innerTx) => {
              expect(this.drizzle.getCurrentTransaction()).toBe(innerTx);
              this.saveInCurrentContext("post-aborted");
              throw new Error("inner-abort");
            });
          } catch {
            // caught inner rollback
          }

          expect(this.drizzle.getCurrentTransaction()).toBe(outerTx);
          this.saveInCurrentContext("post-2");
          return this.drizzle.db.getAll();
        });
      }
    }

    const mod = await Test.createTestingModule({
      imports: [
        DrizzleModule.forRoot({
          db: rootDb,
          client: {
            close: () => {
              clientClosed++;
            },
          },
          onDestroy: () => {
            customDestroyed++;
          },
        }),
        DrizzleModule.forRoot({
          name: "replica",
          db: replicaDb,
        }),
      ],
      providers: [ArticlesRepo],
    }).compile();

    await mod.init();
    const repo = mod.get(ArticlesRepo);
    expect(repo.rawDb).toBe(rootDb);
    expect(repo.replica).toBe(replicaDb);
    expect(repo.replicaService.connectionName).toBe("replica");

    const rows = await repo.createWithNestedRollback();
    expect(rows).toEqual(["primary>tx:post-1", "primary>tx:post-2"]);

    const drizzleService = mod.get(DrizzleService);
    expect(drizzleService.isInTransaction()).toBe(false);
    expect(drizzleService.isClosed).toBe(false);

    await mod.close();
    expect(drizzleService.isClosed).toBe(true);
    expect(clientClosed).toBe(1);
    expect(customDestroyed).toBe(1);
  });

  it("supports DrizzleModule.forRootAsync (useFactory, useClass, useExisting) and global scope", async () => {
    let ended = 0;

    @Injectable()
    class DrizzleOptionsProvider implements DrizzleOptionsFactory<FakeDrizzleDb> {
      createDrizzleOptions(): DrizzleModuleOptions<FakeDrizzleDb> {
        return {
          db: new FakeDrizzleDb("async-class"),
          client: {
            end: () => {
              ended++;
            },
          },
        };
      }
    }

    @Injectable()
    class ChildService {
      constructor(@InjectDrizzle() public readonly db: FakeDrizzleDb) {}
    }

    @Module({
      providers: [ChildService],
      exports: [ChildService],
    })
    class ChildModule {}

    const modFactory = await Test.createTestingModule({
      imports: [
        DrizzleModule.forRootAsync({
          global: true,
          useFactory: async () => ({ db: new FakeDrizzleDb("async-factory") }),
        }),
        ChildModule,
      ],
    }).compile();
    await modFactory.init();
    expect(modFactory.get(ChildService).db.label).toBe("async-factory");
    await modFactory.close();

    const modClass = await Test.createTestingModule({
      imports: [
        DrizzleModule.forRootAsync({
          useClass: DrizzleOptionsProvider,
        }),
      ],
    }).compile();
    await modClass.init();
    expect(modClass.get(DrizzleService).db).toBeInstanceOf(FakeDrizzleDb);
    await modClass.close();
    expect(ended).toBe(1);

    @Module({
      providers: [DrizzleOptionsProvider],
      exports: [DrizzleOptionsProvider],
    })
    class FactoryModule {}

    const modExisting = await Test.createTestingModule({
      imports: [
        DrizzleModule.forRootAsync({
          imports: [FactoryModule],
          useExisting: DrizzleOptionsProvider,
        }),
      ],
    }).compile();
    await modExisting.init();
    expect(modExisting.get(DrizzleService).db).toBeInstanceOf(FakeDrizzleDb);
    await modExisting.close();
    expect(ended).toBe(2);
  });
});

describe("PrismaModule & PrismaServiceBase", () => {
  it("runs $connect on onModuleInit, $disconnect on onModuleDestroy, and manages ALS transactions", async () => {
    const primaryClient = new FakePrismaClient();
    const auditClient = new FakePrismaClient();

    @Injectable()
    class OrdersService {
      constructor(
        @InjectPrisma() public readonly prisma: FakePrismaClient,
        private readonly prismaService: PrismaServiceBase<FakePrismaClient>,
        @InjectPrisma("audit") public readonly audit: FakePrismaClient,
        @InjectPrismaService("audit")
        public readonly auditService: PrismaServiceBase<FakePrismaClient>,
      ) {}

      async createOrderWithAudit(orderId: string) {
        return this.prismaService.transaction(async (tx) => {
          expect(this.prismaService.isInTransaction()).toBe(true);
          expect(this.prismaService.client).toBe(tx);
          tx.records.push(`order:${orderId}`);

          // Nested transaction call joins active tx cleanly without crashing Prisma
          await this.prismaService.transaction(async (nestedTx) => {
            expect(nestedTx).toBe(tx);
            nestedTx.records.push(`line:${orderId}`);
          });

          return [...tx.records];
        });
      }
    }

    const mod = await Test.createTestingModule({
      imports: [
        PrismaModule.forRoot({ client: primaryClient }),
        PrismaModule.forRoot({
          name: "audit",
          client: auditClient,
          connectOnInit: false,
        }),
      ],
      providers: [OrdersService],
    }).compile();

    expect(primaryClient.connectCount).toBe(0);
    await mod.init();
    expect(primaryClient.connectCount).toBe(1);
    expect(auditClient.connectCount).toBe(0); // connectOnInit: false

    const orders = mod.get(OrdersService);
    expect(orders.prisma).toBe(primaryClient);
    expect(orders.audit).toBe(auditClient);
    expect(orders.auditService.connectionName).toBe("audit");

    const committed = await orders.createOrderWithAudit("ord_1");
    expect(committed).toEqual(["order:ord_1", "line:ord_1"]);
    expect(primaryClient.transactionCount).toBe(1);

    // Failed transaction rolls back
    const prismaSvc = mod.get(PrismaServiceBase);
    await expect(
      prismaSvc.transaction(async (tx) => {
        (tx as FakePrismaClient).records.push("order:rolled_back");
        throw new Error("payment-declined");
      }),
    ).rejects.toThrow("payment-declined");
    expect(primaryClient.records).toEqual(["order:ord_1", "line:ord_1"]);

    await mod.close();
    expect(primaryClient.disconnectCount).toBe(1);
    expect(auditClient.disconnectCount).toBe(1);
    expect(prismaSvc.isDisconnected).toBe(true);
  });

  it("supports PrismaServiceBase subclassing pattern and forRootAsync", async () => {
    const raw = new FakePrismaClient();

    @Injectable()
    class AppPrismaService extends PrismaServiceBase<FakePrismaClient> {
      constructor() {
        super(raw);
      }
    }

    const subMod = await Test.createTestingModule({
      providers: [AppPrismaService],
    }).compile();

    await subMod.init();
    const appPrisma = subMod.get(AppPrismaService);
    expect(appPrisma.isConnected).toBe(true);
    expect(raw.connectCount).toBe(1);

    await subMod.close();
    expect(raw.disconnectCount).toBe(1);
    expect(appPrisma.isDisconnected).toBe(true);

    // forRootAsync with useFactory, useClass, useExisting
    const asyncClient1 = new FakePrismaClient();
    const asyncMod1 = await Test.createTestingModule({
      imports: [
        PrismaModule.forRootAsync({
          global: true,
          useFactory: async () => ({ client: asyncClient1 }),
        }),
      ],
    }).compile();
    await asyncMod1.init();
    expect(asyncClient1.connectCount).toBe(1);
    await asyncMod1.close();
    expect(asyncClient1.disconnectCount).toBe(1);

    const asyncClient2 = new FakePrismaClient();
    @Injectable()
    class MyPrismaFactory implements PrismaOptionsFactory<FakePrismaClient> {
      createPrismaOptions(): PrismaModuleOptions<FakePrismaClient> {
        return { client: asyncClient2 };
      }
    }

    const asyncMod2 = await Test.createTestingModule({
      imports: [PrismaModule.forRootAsync({ useClass: MyPrismaFactory })],
    }).compile();
    await asyncMod2.init();
    expect(asyncClient2.connectCount).toBe(1);
    await asyncMod2.close();
    expect(asyncClient2.disconnectCount).toBe(1);
  });
});
