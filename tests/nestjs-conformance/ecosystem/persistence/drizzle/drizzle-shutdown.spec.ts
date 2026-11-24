import { describe, expect, it } from "bun:test";
import {
  Column,
  DataSource,
  Entity,
  OrmModule,
  PrimaryGeneratedColumn,
  getOrmDataSourceToken,
} from "../../../../../packages/orm/src";
import { Test, describeConformance } from "../../../_helpers/index";

@Entity("shutdown_items")
class ShutdownItem {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  name!: string;
}

describeConformance(
  "Persistence (drizzle parity) - graceful shutdown",
  {
    upstreamPath: "drizzle/tests/e2e/drizzle-shutdown.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-002"],
    notes:
      "Adapts DrizzleModule shutdown tests to @bunest/orm DataSource teardown on application close.",
  },
  () => {
    describe("single and multiple connections", () => {
      it("destroys DataSource on module close and tolerates repeated close calls", async () => {
        const mod = await Test.createTestingModule({
          imports: [
            OrmModule.forRoot({
              type: "sqlite",
              database: ":memory:",
              entities: [ShutdownItem],
              synchronize: true,
            }),
          ],
        }).compile({ logger: false });

        const ds = mod.get<DataSource>(getOrmDataSourceToken());
        expect(ds.isInitialized).toBe(true);

        await mod.close();
        expect(ds.isInitialized).toBe(false);
        await expect(mod.close()).resolves.toBeUndefined();
      });

      it("destroys all named connections on module close", async () => {
        const mod = await Test.createTestingModule({
          imports: [
            OrmModule.forRoot({
              name: "first",
              type: "sqlite",
              database: ":memory:",
              entities: [ShutdownItem],
              synchronize: true,
            }),
            OrmModule.forRoot({
              name: "second",
              type: "sqlite",
              database: ":memory:",
              entities: [ShutdownItem],
              synchronize: true,
            }),
          ],
        }).compile({ logger: false });

        const first = mod.get<DataSource>(getOrmDataSourceToken("first"));
        const second = mod.get<DataSource>(getOrmDataSourceToken("second"));
        expect(first.isInitialized).toBe(true);
        expect(second.isInitialized).toBe(true);

        await mod.close();
        expect(first.isInitialized).toBe(false);
        expect(second.isInitialized).toBe(false);
      });
    });
  },
);
