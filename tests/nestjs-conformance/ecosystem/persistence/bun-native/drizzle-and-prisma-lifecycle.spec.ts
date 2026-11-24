import { afterEach, describe, expect, it } from "bun:test";
import { Injectable } from "../../../../../packages/core/src/common";
import {
  Column,
  DataSource,
  Entity,
  EntityNotFoundError,
  InjectDataSource,
  InjectRepository,
  OrmModule,
  PrimaryGeneratedColumn,
  getOrmDataSourceToken,
  getOrmEntityManagerToken,
  getOrmRepositoryToken,
  type OrmOptionsFactory,
  type Repository,
} from "../../../../../packages/orm/src";
import { Test, describeConformance } from "../../../_helpers/index";

@Entity("lifecycle_notes")
class LifecycleNote {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  body!: string;
}

@Injectable()
class LifecycleOptionsFactory implements OrmOptionsFactory {
  calls = 0;
  createOrmOptions() {
    this.calls++;
    return {
      type: "sqlite" as const,
      database: ":memory:",
      entities: [LifecycleNote],
      synchronize: true,
    };
  }
}

@Injectable()
class LifecycleConsumer {
  constructor(
    @InjectDataSource() readonly ds: DataSource,
    @InjectRepository(LifecycleNote) readonly repo: Repository<LifecycleNote>,
  ) {}
}

describeConformance(
  "Persistence (bun-native) - ORM DataSource lifecycle & error parity",
  {
    upstreamPath: "bun-native/drizzle-and-prisma-lifecycle",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-002"],
    notes:
      "Adapts Drizzle/Prisma lifecycle & token derivation tests to @bunest/orm DataSource & OrmModule lifecycle.",
  },
  () => {
    const apps: Array<{ close: () => Promise<unknown> }> = [];

    afterEach(async () => {
      while (apps.length > 0) {
        await apps.pop()!.close();
      }
    });

    describe("token derivation & lifecycle", () => {
      it("derives distinct default vs named tokens", () => {
        expect(getOrmDataSourceToken()).not.toBe(
          getOrmDataSourceToken("reporting"),
        );
        expect(getOrmEntityManagerToken()).not.toBe(
          getOrmEntityManagerToken("reporting"),
        );
        expect(getOrmRepositoryToken(LifecycleNote)).not.toBe(
          getOrmRepositoryToken(LifecycleNote, "reporting"),
        );
      });

      it("initializes DataSource on startup and destroys it cleanly on module close", async () => {
        const mod = await Test.createTestingModule({
          imports: [
            OrmModule.forRootAsync({ useClass: LifecycleOptionsFactory }),
            OrmModule.forFeature([LifecycleNote]),
          ],
          providers: [LifecycleConsumer],
        }).compile({ logger: false });

        const consumer = mod.get(LifecycleConsumer);
        expect(consumer.ds.isInitialized).toBe(true);

        const saved = await consumer.repo.save({ body: "alive" });
        expect(saved.body).toBe("alive");

        await expect(
          consumer.repo.findOneOrFail({ where: { id: 9999 } }),
        ).rejects.toBeInstanceOf(EntityNotFoundError);

        await mod.close();
        expect(consumer.ds.isInitialized).toBe(false);
      });
    });
  },
);
