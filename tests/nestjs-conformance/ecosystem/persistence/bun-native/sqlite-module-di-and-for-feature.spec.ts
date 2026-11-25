import { afterEach, describe, expect, it } from "bun:test";
import { Injectable, Module } from "../../../../../packages/core/src/common";
import {
  Column,
  DataSource,
  Entity,
  InjectDataSource,
  InjectRepository,
  OrmModule,
  PrimaryGeneratedColumn,
  type OrmOptionsFactory,
  type Repository,
} from "../../../../../packages/orm/src";
import { Test, describeConformance } from "../../../_helpers/index";

@Entity("di_items")
class DiItem {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  label!: string;
}

@Injectable()
class DbConfigService {
  readonly dbPath = ":memory:";
}

@Injectable()
class OrmConfigFactory implements OrmOptionsFactory {
  createOrmOptions() {
    return {
      type: "sqlite" as const,
      database: ":memory:",
      entities: [DiItem],
      synchronize: true,
    };
  }
}

@Module({
  providers: [DbConfigService, OrmConfigFactory],
  exports: [DbConfigService, OrmConfigFactory],
})
class DbConfigModule {}

@Injectable()
class ItemService {
  constructor(
    @InjectRepository(DiItem) readonly repo: Repository<DiItem>,
    @InjectDataSource() readonly ds: DataSource,
  ) {}
}

describeConformance(
  "Persistence (bun-native) - OrmModule DI and forFeature on SQLite",
  {
    upstreamPath: "bun-native/sqlite-module-di-and-for-feature",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-002"],
    notes:
      "Adapts SqliteModule DI and forFeature tests to @bunest/orm OrmModule.forRoot / forRootAsync / forFeature.",
  },
  () => {
    const apps: Array<{ close: () => Promise<unknown> }> = [];

    afterEach(async () => {
      while (apps.length > 0) {
        await apps.pop()!.close();
      }
    });

    describe("forRoot + forFeature", () => {
      it("injects Repository and DataSource into feature services", async () => {
        const mod = await Test.createTestingModule({
          imports: [
            OrmModule.forRoot({
              type: "sqlite",
              database: ":memory:",
              entities: [DiItem],
              synchronize: true,
            }),
            OrmModule.forFeature([DiItem]),
          ],
          providers: [ItemService],
        }).compile({ logger: false });
        apps.push(mod);

        const svc = mod.get(ItemService);
        expect(svc.ds).toBeInstanceOf(DataSource);
        const saved = await svc.repo.save({ label: "hello" });
        expect(saved.id).toBeGreaterThan(0);
        expect(await svc.repo.count()).toBe(1);
      });
    });

    describe("forRootAsync", () => {
      it("supports useFactory with injected config service", async () => {
        const mod = await Test.createTestingModule({
          imports: [
            OrmModule.forRootAsync({
              imports: [DbConfigModule],
              inject: [DbConfigService],
              useFactory: (cfg: DbConfigService) => ({
                type: "sqlite",
                database: cfg.dbPath,
                entities: [DiItem],
                synchronize: true,
              }),
            }),
            OrmModule.forFeature([DiItem]),
          ],
          providers: [ItemService],
        }).compile({ logger: false });
        apps.push(mod);

        const svc = mod.get(ItemService);
        await svc.repo.save({ label: "factory" });
        expect(await svc.repo.count()).toBe(1);
      });

      it("supports useClass and useExisting factories", async () => {
        const byClass = await Test.createTestingModule({
          imports: [
            OrmModule.forRootAsync({ useClass: OrmConfigFactory }),
            OrmModule.forFeature([DiItem]),
          ],
          providers: [ItemService],
        }).compile({ logger: false });
        apps.push(byClass);
        expect(byClass.get(ItemService).ds.isInitialized).toBe(true);

        const byExisting = await Test.createTestingModule({
          imports: [
            OrmModule.forRootAsync({
              imports: [DbConfigModule],
              useExisting: OrmConfigFactory,
            }),
            OrmModule.forFeature([DiItem]),
          ],
          providers: [ItemService],
        }).compile({ logger: false });
        apps.push(byExisting);
        expect(byExisting.get(ItemService).ds.isInitialized).toBe(true);
      });
    });
  },
);
