import { afterEach, expect, it } from "bun:test";
import { Injectable } from "../../../../../packages/core/src/common";
import {
  Column,
  Entity,
  ORM_MODULE_OPTIONS,
  OrmModule,
  PrimaryGeneratedColumn,
  getOrmDataSourceToken,
  getOrmEntityManagerToken,
  getOrmRepositoryToken,
  type OrmOptionsFactory,
} from "../../../../../packages/orm/src";
import { Test, createSpy, describeConformance } from "../../../_helpers/index";

@Entity("reg_entities")
class RegEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  value!: string;
}

describeConformance(
  "Persistence (drizzle parity) - registration & token derivation",
  {
    upstreamPath: "drizzle/tests/e2e/drizzle-registration.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-002"],
    notes:
      "Adapts token derivation and OrmOptionsFactory invocation tests to @bunest/orm.",
  },
  () => {
    const apps: Array<{ close: () => Promise<unknown> }> = [];

    afterEach(async () => {
      while (apps.length > 0) {
        await apps.pop()!.close();
      }
    });

    it("derives distinct DataSource, EntityManager, and Repository tokens per connection name", () => {
      expect(getOrmDataSourceToken("default")).toBe(getOrmDataSourceToken());
      expect(getOrmDataSourceToken("secondary")).not.toBe(
        getOrmDataSourceToken(),
      );
      expect(getOrmEntityManagerToken("secondary")).not.toBe(
        getOrmEntityManagerToken(),
      );
      expect(getOrmRepositoryToken(RegEntity, "secondary")).not.toBe(
        getOrmRepositoryToken(RegEntity),
      );
      expect(ORM_MODULE_OPTIONS).toBeDefined();
    });

    it("invokes OrmOptionsFactory.createOrmOptions once during bootstrap", async () => {
      const spy = createSpy(() => ({
        type: "sqlite" as const,
        database: ":memory:",
        entities: [RegEntity],
        synchronize: true,
      }));

      @Injectable()
      class SpyFactory implements OrmOptionsFactory {
        createOrmOptions() {
          return spy();
        }
      }

      const mod = await Test.createTestingModule({
        imports: [OrmModule.forRootAsync({ useClass: SpyFactory })],
      }).compile({ logger: false });
      apps.push(mod);

      expect(spy.callCount).toBe(1);
    });
  },
);
