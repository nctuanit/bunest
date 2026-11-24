import { afterEach, expect, it } from "bun:test";
import {
  Column,
  DataSource,
  Entity,
  EntityNotFoundError,
  IsNull,
  PrimaryGeneratedColumn,
  type Repository,
} from "../../../../../packages/orm/src";
import { describeConformance } from "../../../_helpers/index";

@Entity("products")
class Product {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ unique: true })
  sku!: string;

  @Column()
  tenant!: string;

  @Column()
  name!: string;

  @Column({ type: "integer" })
  price!: number;

  @Column()
  category!: string;

  @Column({ type: "text", nullable: true })
  notes!: string | null;
}

describeConformance(
  "Persistence (bun-native) - ORM Repository CRUD, upsert, pagination & guardrails",
  {
    upstreamPath: "bun-native/base-sqlite-repository",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-002"],
    notes:
      "Adapts BaseSqliteRepository CRUD, batch insert, upsert, projection, sorting, pagination, IS NULL matching, and EntityNotFoundError guardrails to @bunest/orm Repository on bun:sqlite.",
  },
  () => {
    const openSources: DataSource[] = [];

    const setup = async (): Promise<{
      ds: DataSource;
      repo: Repository<Product>;
    }> => {
      const ds = new DataSource({
        type: "sqlite",
        database: ":memory:",
        entities: [Product],
        synchronize: true,
      });
      await ds.initialize();
      openSources.push(ds);
      return { ds, repo: ds.getRepository(Product) };
    };

    afterEach(async () => {
      while (openSources.length > 0) {
        await openSources.pop()!.destroy();
      }
    });

    it("supports save, findOne, findOneOrFail, update, and delete", async () => {
      const { repo } = await setup();
      const created = await repo.save({
        sku: "SKU-1",
        tenant: "t1",
        name: "Widget",
        price: 100,
        category: "tools",
        notes: null,
      });
      expect(created.id).toBeGreaterThan(0);
      expect(created.sku).toBe("SKU-1");

      const found = await repo.findOne({ where: { id: created.id } });
      expect(found?.name).toBe("Widget");

      await repo.update({ id: created.id }, { price: 150 });
      const updated = await repo.findOneOrFail({ where: { id: created.id } });
      expect(updated.price).toBe(150);

      await repo.delete({ id: created.id });
      expect(await repo.findOne({ where: { id: created.id } })).toBeNull();
      await expect(
        repo.findOneOrFail({ where: { id: created.id } }),
      ).rejects.toBeInstanceOf(EntityNotFoundError);
    });

    it("supports batch insert, projection (select), sorting (order), and pagination (skip/take)", async () => {
      const { repo } = await setup();
      await repo.save([
        {
          sku: "A1",
          tenant: "t1",
          name: "Alpha",
          price: 30,
          category: "cat",
          notes: "first",
        },
        {
          sku: "A2",
          tenant: "t1",
          name: "Beta",
          price: 10,
          category: "cat",
          notes: null,
        },
        {
          sku: "A3",
          tenant: "t1",
          name: "Gamma",
          price: 20,
          category: "cat",
          notes: null,
        },
      ]);

      const page = await repo.find({
        where: { tenant: "t1" },
        select: { sku: true, price: true },
        order: { price: "ASC" },
        skip: 1,
        take: 2,
      });
      expect(page).toHaveLength(2);
      expect(page[0]?.sku).toBe("A3");
      expect(page[0]?.price).toBe(20);
      expect(page[1]?.sku).toBe("A1");
      expect(page[1]?.price).toBe(30);
    });

    it("supports IsNull() matching, count, and upsert conflict handling", async () => {
      const { repo } = await setup();
      await repo.save([
        {
          sku: "N1",
          tenant: "t1",
          name: "NoNotes",
          price: 5,
          category: "misc",
          notes: null,
        },
        {
          sku: "N2",
          tenant: "t1",
          name: "HasNotes",
          price: 15,
          category: "misc",
          notes: "hello",
        },
      ]);

      const nullNotes = await repo.find({ where: { notes: IsNull() } });
      expect(nullNotes).toHaveLength(1);
      expect(nullNotes[0]?.sku).toBe("N1");
      expect(await repo.count({ where: { tenant: "t1" } })).toBe(2);

      await repo.upsert(
        {
          sku: "N1",
          tenant: "t1",
          name: "UpdatedNoNotes",
          price: 99,
          category: "misc",
          notes: "added",
        },
        ["sku"],
      );
      const afterUpsert = await repo.findOneOrFail({ where: { sku: "N1" } });
      expect(afterUpsert.name).toBe("UpdatedNoNotes");
      expect(afterUpsert.price).toBe(99);
      expect(afterUpsert.notes).toBe("added");
    });
  },
);
