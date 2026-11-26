import { describe, expect, it } from "bun:test";
import { Injectable, Module } from "@bunest/core";
import { Test } from "@bunest/testing";
import {
  Column,
  DataSource,
  Entity,
  EntityManager,
  InjectDataSource,
  InjectEntityManager,
  InjectRepository,
  OrmModule,
  PrimaryGeneratedColumn,
  OrmRepository,
  Repository,
  Transactional,
  entityRef,
} from "../src/index";

@Entity("di_accounts")
class DiAccount {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ unique: true })
  handle!: string;

  @Column("integer")
  balance!: number;
}

const DiAccountRef = entityRef<DiAccount>("DiAccount");

describe("@bunest/orm — Bunest DI Module & @Transactional AOP", () => {
  it("injects Repository via class, string, EntityRef, and lazy thunk () => Class, plus @Transactional rollback", async () => {
    @Injectable()
    class AccountsService {
      constructor(
        @InjectRepository(DiAccount)
        public readonly byClass: OrmRepository<DiAccount>,
        @InjectRepository("DiAccount")
        public readonly byName: OrmRepository<DiAccount>,
        @InjectRepository(DiAccountRef)
        public readonly byRef: OrmRepository<DiAccount>,
        @InjectRepository(() => DiAccount)
        public readonly byThunk: OrmRepository<DiAccount>,
        @InjectDataSource()
        public readonly dataSource: DataSource,
        @InjectEntityManager()
        public readonly manager: EntityManager,
      ) {}

      @Transactional()
      async transfer(fromId: number, toId: number, amount: number, fail = false) {
        await this.byClass.decrement({ id: fromId }, "balance", amount);
        if (fail) {
          throw new Error("simulated-transfer-failure");
        }
        await this.byClass.increment({ id: toId }, "balance", amount);
      }
    }

    const mod = await Test.createTestingModule({
      imports: [
        OrmModule.forRoot({
          type: "sqlite",
          database: ":memory:",
          synchronize: true,
        }),
        OrmModule.forFeature([DiAccount]),
      ],
      providers: [AccountsService],
    }).compile();

    await mod.init();
    try {
      const svc = mod.get(AccountsService);

      // All 4 injection styles resolve the EXACT SAME Repository instance!
      expect(svc.byClass).toBeInstanceOf(OrmRepository);
      expect(svc.byName).toBe(svc.byClass);
      expect(svc.byRef).toBe(svc.byClass);
      expect(svc.byThunk).toBe(svc.byClass);
      expect(svc.dataSource.isInitialized).toBe(true);
      expect(svc.manager).toBe(svc.dataSource.manager);

      const a = await svc.byClass.save({ handle: "alice", balance: 100 });
      const b = await svc.byClass.save({ handle: "bob", balance: 50 });

      // Failed @Transactional rolls back decrement atomically!
      await expect(svc.transfer(a.id, b.id, 30, true)).rejects.toThrow(
        "simulated-transfer-failure",
      );
      expect((await svc.byClass.findOneByOrFail({ id: a.id })).balance).toBe(100);
      expect((await svc.byClass.findOneByOrFail({ id: b.id })).balance).toBe(50);

      // Successful @Transactional commits atomically!
      await svc.transfer(a.id, b.id, 30, false);
      expect((await svc.byClass.findOneByOrFail({ id: a.id })).balance).toBe(70);
      expect((await svc.byClass.findOneByOrFail({ id: b.id })).balance).toBe(80);
    } finally {
      await mod.close();
    }
  });

  it("isolates multiple named DataSources and supports forRootAsync", async () => {
    @Injectable()
    class DbConfig {
      db = ":memory:";
    }

    @Module({
      providers: [DbConfig],
      exports: [DbConfig],
    })
    class ConfigMod {}

    @Injectable()
    class DualDbService {
      constructor(
        @InjectRepository(DiAccount, "primary")
        public readonly primaryRepo: OrmRepository<DiAccount>,
        @InjectRepository(DiAccount, "analytics")
        public readonly analyticsRepo: OrmRepository<DiAccount>,
        @InjectDataSource("primary")
        public readonly primaryDs: DataSource,
        @InjectDataSource("analytics")
        public readonly analyticsDs: DataSource,
      ) {}
    }

    const mod = await Test.createTestingModule({
      imports: [
        OrmModule.forRoot({
          name: "primary",
          type: "sqlite",
          database: ":memory:",
          synchronize: true,
        }),
        OrmModule.forRootAsync({
          name: "analytics",
          imports: [ConfigMod],
          inject: [DbConfig],
          useFactory: (cfg: DbConfig) => ({
            type: "sqlite",
            database: cfg.db,
            synchronize: true,
          }),
        }),
        OrmModule.forFeature([DiAccount], "primary"),
        OrmModule.forFeature([DiAccount], "analytics"),
      ],
      providers: [DualDbService],
    }).compile();

    await mod.init();
    try {
      const svc = mod.get(DualDbService);
      expect(svc.primaryDs).not.toBe(svc.analyticsDs);
      await svc.primaryRepo.save({ handle: "p1", balance: 10 });
      await svc.analyticsRepo.save({ handle: "a1", balance: 999 });

      expect(await svc.primaryRepo.count()).toBe(1);
      expect(await svc.analyticsRepo.count()).toBe(1);
      expect((await svc.primaryRepo.findOneBy({ handle: "a1" }))).toBeNull();
    } finally {
      await mod.close();
      expect(mod.get(DualDbService).primaryDs.isInitialized).toBe(false);
      expect(mod.get(DualDbService).analyticsDs.isInitialized).toBe(false);
    }
  });
});
