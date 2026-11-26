import { afterEach, expect, it } from "bun:test";
import { Injectable } from "../../../../../packages/core/src/common";
import {
  Column,
  DataSource,
  Entity,
  InjectDataSource,
  InjectRepository,
  OrmModule,
  PrimaryGeneratedColumn,
  getOrmDataSourceToken,
  getOrmRepositoryToken,
  type OrmRepository,
} from "../../../../../packages/orm/src";
import { Test, describeConformance } from "../../../_helpers/index";

@Entity("primary_records")
class PrimaryRecord {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  title!: string;
}

@Entity("analytics_records")
class AnalyticsRecord {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  metric!: string;
}

@Injectable()
class MultiConnectionService {
  constructor(
    @InjectDataSource("primary") readonly primaryDs: DataSource,
    @InjectDataSource("analytics") readonly analyticsDs: DataSource,
    @InjectRepository(PrimaryRecord, "primary")
    readonly primaryRepo: OrmRepository<PrimaryRecord>,
    @InjectRepository(AnalyticsRecord, "analytics")
    readonly analyticsRepo: OrmRepository<AnalyticsRecord>,
  ) {}
}

describeConformance(
  "Persistence (bun-native) - OrmModule multi-connection DI",
  {
    upstreamPath: "bun-native/sql-module-di-and-multi-connection",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-002"],
    notes:
      "Adapts SqlModule multi-connection DI tests to @bunest/orm named DataSource & Repository tokens.",
  },
  () => {
    const apps: Array<{ close: () => Promise<unknown> }> = [];

    afterEach(async () => {
      while (apps.length > 0) {
        await apps.pop()!.close();
      }
    });

    it("isolates multiple named DataSource connections and repositories", async () => {
      const mod = await Test.createTestingModule({
        imports: [
          OrmModule.forRoot({
            name: "primary",
            type: "sqlite",
            database: ":memory:",
            entities: [PrimaryRecord],
            synchronize: true,
          }),
          OrmModule.forRoot({
            name: "analytics",
            type: "sqlite",
            database: ":memory:",
            entities: [AnalyticsRecord],
            synchronize: true,
          }),
          OrmModule.forFeature([PrimaryRecord], "primary"),
          OrmModule.forFeature([AnalyticsRecord], "analytics"),
        ],
        providers: [MultiConnectionService],
      }).compile({ logger: false });
      apps.push(mod);

      const svc = mod.get(MultiConnectionService);
      expect(svc.primaryDs).not.toBe(svc.analyticsDs);
      expect(mod.get(getOrmDataSourceToken("primary"))).toBe(svc.primaryDs);
      expect(mod.get(getOrmDataSourceToken("analytics"))).toBe(svc.analyticsDs);
      expect(mod.get(getOrmRepositoryToken(PrimaryRecord, "primary"))).toBe(
        svc.primaryRepo,
      );
      expect(mod.get(getOrmRepositoryToken(AnalyticsRecord, "analytics"))).toBe(
        svc.analyticsRepo,
      );

      await svc.primaryRepo.save({ title: "order-1" });
      await svc.analyticsRepo.save({ metric: "clicks:42" });

      expect(await svc.primaryRepo.count()).toBe(1);
      expect(await svc.analyticsRepo.count()).toBe(1);
    });
  },
);
