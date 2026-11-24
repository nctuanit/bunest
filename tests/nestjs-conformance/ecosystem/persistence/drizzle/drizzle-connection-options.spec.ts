import { afterEach, expect, it } from "bun:test";
import {
  Column,
  DataSource,
  Entity,
  OrmModule,
  PrimaryGeneratedColumn,
  getOrmDataSourceToken,
} from "../../../../../packages/orm/src";
import { Test, describeConformance } from "../../../_helpers/index";

@Entity("conn_notes")
class ConnNote {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  body!: string;
}

describeConformance(
  "Persistence (drizzle parity) - connection options & DataSource configuration",
  {
    upstreamPath: "drizzle/tests/e2e/drizzle-connection-options.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-002"],
    notes:
      "Adapts upstream Drizzle connection options tests to @bunest/orm OrmModule.forRoot / DataSource options on bun:sqlite.",
  },
  () => {
    const apps: Array<{ close: () => Promise<unknown> }> = [];

    afterEach(async () => {
      while (apps.length > 0) {
        await apps.pop()!.close();
      }
    });

    it("initializes with synchronize: true and executes queries through the default DataSource", async () => {
      const mod = await Test.createTestingModule({
        imports: [
          OrmModule.forRoot({
            type: "sqlite",
            database: ":memory:",
            entities: [ConnNote],
            synchronize: true,
          }),
        ],
      }).compile({ logger: false });
      apps.push(mod);

      const ds = mod.get<DataSource>(getOrmDataSourceToken());
      expect(ds.isInitialized).toBe(true);
      const repo = ds.getRepository(ConnNote);
      await repo.save({ body: "first note" });
      const rows = await repo.find();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.body).toBe("first note");
    });

    it("supports named connection options without colliding with the default connection", async () => {
      const mod = await Test.createTestingModule({
        imports: [
          OrmModule.forRoot({
            name: "audit",
            type: "sqlite",
            database: ":memory:",
            entities: [ConnNote],
            synchronize: true,
          }),
        ],
      }).compile({ logger: false });
      apps.push(mod);

      const ds = mod.get<DataSource>(getOrmDataSourceToken("audit"));
      expect(ds.isInitialized).toBe(true);
      const saved = await ds.getRepository(ConnNote).save({ body: "audit log" });
      expect(saved.id).toBeGreaterThan(0);
    });
  },
);
