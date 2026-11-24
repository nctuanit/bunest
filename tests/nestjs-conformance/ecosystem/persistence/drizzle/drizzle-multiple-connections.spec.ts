import { afterEach, expect, it } from "bun:test";
import { Injectable } from "../../../../../packages/core/src/common";
import {
  Column,
  DataSource,
  Entity,
  InjectDataSource,
  OrmModule,
  PrimaryGeneratedColumn,
  getOrmDataSourceToken,
} from "../../../../../packages/orm/src";
import { Test, describeConformance } from "../../../_helpers/index";

@Entity("multi_users")
class MultiUser {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  email!: string;
}

@Injectable()
class DualDbService {
  constructor(
    @InjectDataSource("db1") readonly db1: DataSource,
    @InjectDataSource("db2") readonly db2: DataSource,
  ) {}
}

describeConformance(
  "Persistence (drizzle parity) - multiple isolated connections",
  {
    upstreamPath: "drizzle/tests/e2e/drizzle-multiple-connections.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-002"],
    notes:
      "Adapts multiple-connection isolation tests to @bunest/orm named DataSources.",
  },
  () => {
    const apps: Array<{ close: () => Promise<unknown> }> = [];

    afterEach(async () => {
      while (apps.length > 0) {
        await apps.pop()!.close();
      }
    });

    it("keeps data isolated between two named connections", async () => {
      const mod = await Test.createTestingModule({
        imports: [
          OrmModule.forRoot({
            name: "db1",
            type: "sqlite",
            database: ":memory:",
            entities: [MultiUser],
            synchronize: true,
          }),
          OrmModule.forRoot({
            name: "db2",
            type: "sqlite",
            database: ":memory:",
            entities: [MultiUser],
            synchronize: true,
          }),
        ],
        providers: [DualDbService],
      }).compile({ logger: false });
      apps.push(mod);

      const svc = mod.get(DualDbService);
      expect(svc.db1).toBe(mod.get(getOrmDataSourceToken("db1")));
      expect(svc.db2).toBe(mod.get(getOrmDataSourceToken("db2")));
      expect(svc.db1).not.toBe(svc.db2);

      await svc.db1.getRepository(MultiUser).save({ email: "a@db1.test" });
      expect(await svc.db1.getRepository(MultiUser).count()).toBe(1);
      expect(await svc.db2.getRepository(MultiUser).count()).toBe(0);
    });
  },
);
