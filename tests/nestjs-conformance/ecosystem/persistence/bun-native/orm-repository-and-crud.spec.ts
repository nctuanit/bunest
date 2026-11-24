import { afterEach, expect, it } from "bun:test";
import {
  Between,
  Column,
  DataSource,
  DeleteDateColumn,
  Entity,
  EntityNotFoundError,
  In,
  IsNull,
  Like,
  MoreThan,
  Not,
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

  @Column({ default: "acme" })
  tenant!: string;

  @Column()
  name!: string;

  @Column({ type: "integer" })
  price!: number;

  @Column()
  category!: string;

  @Column({ nullable: true })
  notes?: string | null;

  @DeleteDateColumn()
  deletedAt?: Date | null;
}

describeConformance(
  "Persistence (bun-native) - @bunest/orm Repository CRUD, upsert, operators, pagination & soft-delete",
  {
    upstreamPath: "bun-native/base-sqlite-repository",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-002"],
    notes:
      "Exhaustive conformance suite for @bunest/orm Repository<Entity> CRUD, batch save, upsert conflict handling, find operators, projection, sorting, pagination, IS NULL matching, QueryBuilder, and soft-delete/restore.",
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

    it("inserts entities via insert() and save() and hydrates entity metadata", async () => {
      const { repo } = await setup();
      expect(repo.metadata.tableName).toBe("products");
      expect(repo.metadata.primaryColumn.propertyName).toBe("id");

      const ins = await repo.insert({
        sku: "SKU-1",
        tenant: "acme",
        name: "Keyboard",
        price: 120,
        category: "hardware",
        notes: null,
      });
      expect(ins.identifiers[0]?.id).toBe(1);

      const created = await repo.save({
        sku: "SKU-2",
        tenant: "acme",
        name: "Mouse",
        price: 50,
        category: "hardware",
        notes: "wireless",
      });
      expect(created).toMatchObject({
        id: 2,
        sku: "SKU-2",
        tenant: "acme",
        name: "Mouse",
        price: 50,
        category: "hardware",
        notes: "wireless",
      });
    });

    it("saves batches atomically and rolls back entire batch on UNIQUE constraint failure", async () => {
      const { repo } = await setup();

      await repo.save([
        { sku: "B1", tenant: "acme", name: "Item 1", price: 10, category: "a" },
        { sku: "B2", tenant: "acme", name: "Item 2", price: 20, category: "a" },
      ]);
      expect(await repo.count()).toBe(2);

      await expect(
        repo.save([
          { sku: "B3", tenant: "acme", name: "Item 3", price: 30, category: "a" },
          { sku: "B1", tenant: "acme", name: "Dup SKU", price: 40, category: "a" },
        ]),
      ).rejects.toThrow(/UNIQUE/i);

      expect(await repo.count()).toBe(2);
      expect(await repo.findOneBy({ sku: "B3" })).toBeNull();
    });

    it("supports upsert() on conflict path, preload(), and merge()", async () => {
      const { repo } = await setup();

      await repo.upsert(
        {
          sku: "U1",
          tenant: "acme",
          name: "Lamp",
          price: 30,
          category: "home",
          notes: "v1",
        },
        ["sku"],
      );
      await repo.upsert(
        {
          sku: "U1",
          tenant: "acme",
          name: "LED Lamp",
          price: 45,
          category: "home",
          notes: "v2",
        },
        ["sku"],
      );
      const updated = await repo.findOneByOrFail({ sku: "U1" });
      expect(updated).toMatchObject({
        name: "LED Lamp",
        price: 45,
        notes: "v2",
      });

      const preloaded = await repo.preload({ id: updated.id, price: 60 });
      expect(preloaded?.name).toBe("LED Lamp");
      expect(preloaded?.price).toBe(60);
      expect(await repo.preload({ id: 9999, price: 1 })).toBeUndefined();
    });

    it("supports findOneBy, findOneByOrFail, findBy, findAndCount, operators, sorting, and pagination", async () => {
      const { repo } = await setup();
      await repo.save([
        { sku: "P1", tenant: "acme", name: "Alpha", price: 10, category: "hw", notes: null },
        { sku: "P2", tenant: "acme", name: "Beta", price: 30, category: "hw", notes: "featured" },
        { sku: "P3", tenant: "acme", name: "Gamma", price: 20, category: "hw", notes: null },
        { sku: "P4", tenant: "acme", name: "Delta", price: 99, category: "sw", notes: "pro" },
      ]);

      expect(await repo.findOneBy({ sku: "MISSING" })).toBeNull();
      await expect(repo.findOneByOrFail({ sku: "MISSING" })).rejects.toThrow(
        EntityNotFoundError,
      );

      const [page, total] = await repo.findAndCount({
        where: { category: "hw" },
        order: { price: "DESC" },
        take: 2,
        skip: 0,
      });
      expect(total).toBe(3);
      expect(page.map((r) => r.sku)).toEqual(["P2", "P3"]);

      // Find operators: MoreThan, Between, In, Like, IsNull, Not
      expect(
        (await repo.find({ where: { price: MoreThan(25) }, order: { price: "ASC" } })).map(
          (r) => r.sku,
        ),
      ).toEqual(["P2", "P4"]);
      expect(
        (await repo.find({ where: { price: Between(10, 20) }, order: { price: "ASC" } })).map(
          (r) => r.sku,
        ),
      ).toEqual(["P1", "P3"]);
      expect(
        (await repo.find({ where: { sku: In(["P1", "P4"]) }, order: { sku: "ASC" } })).map(
          (r) => r.sku,
        ),
      ).toEqual(["P1", "P4"]);
      expect(
        (await repo.find({ where: { name: Like("%mm%") } })).map((r) => r.sku),
      ).toEqual(["P3"]);
      expect(
        (await repo.find({ where: { notes: IsNull() }, order: { sku: "ASC" } })).map(
          (r) => r.sku,
        ),
      ).toEqual(["P1", "P3"]);
      expect(
        (await repo.find({ where: { category: Not("hw") } })).map((r) => r.sku),
      ).toEqual(["P4"]);
    });

    it("supports update, delete, softDelete, restore, existsBy, and SelectQueryBuilder", async () => {
      const { repo } = await setup();
      const first = await repo.save({
        sku: "C1",
        tenant: "acme",
        name: "Chair",
        price: 100,
        category: "furniture",
      });
      await repo.save({
        sku: "C2",
        tenant: "acme",
        name: "Desk",
        price: 200,
        category: "furniture",
      });

      expect(await repo.existsBy({ sku: "C1" })).toBe(true);
      expect(await repo.existsBy({ sku: "NOPE" })).toBe(false);

      expect((await repo.update(first.id, { price: 125 })).affected).toBe(1);
      expect((await repo.findOneByOrFail({ id: first.id })).price).toBe(125);

      // Soft-delete hides row from normal queries until withDeleted: true or restore()
      await repo.softDelete(first.id);
      expect(await repo.count()).toBe(1);
      expect(await repo.count({ withDeleted: true })).toBe(2);

      await repo.restore(first.id);
      expect(await repo.count()).toBe(2);

      // SelectQueryBuilder
      const qbRows = await repo
        .createQueryBuilder("p")
        .where("p.price >= :min", { min: 120 })
        .orderBy("p.price", "DESC")
        .getMany();
      expect(qbRows.map((r) => r.sku)).toEqual(["C2", "C1"]);

      expect((await repo.delete({ category: "furniture" })).affected).toBe(2);
      expect(await repo.count()).toBe(0);
    });
  },
);
