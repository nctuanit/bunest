import { describe, expect, it } from "bun:test";
import {
  Builder,
  Data,
  FieldNameConstants,
  METADATA_KEYS,
  MetadataRegistry,
  getEntityColumns,
  getEntityIndexes,
  getEntitySchema,
  hasEntitySchema,
} from "@bunest/core";
import {
  BaseEntity,
  Column,
  CrudRepository,
  DataSource,
  Entity,
  Index,
  OrmRepository,
  PrimaryColumn,
  SoftDelete,
  compileOrmRepository,
} from "../src";

describe("@BaseEntity<Key> decorator", () => {
  it("registers id, createdAt, updatedAt, deletedAt columns and powers full CRUD + softDelete/restore", async () => {
    @BaseEntity<number>("articles")
    class Article {
      @Column()
      title!: string;

      // Type declarations (generated automatically in user apps by bunest typegen)
      id!: number;
      createdAt!: Date;
      updatedAt!: Date;
      deletedAt?: Date | null;
    }

    const ds = new DataSource({
      type: "sqlite",
      database: ":memory:",
      synchronize: true,
      entities: [Article],
    });
    await ds.initialize();

    try {
      const meta = ds.getMetadata(Article);
      expect(meta.tableName).toBe("articles");
      expect(new Set(meta.columns.map((c) => c.propertyName))).toEqual(
        new Set(["id", "title", "createdAt", "updatedAt", "deletedAt"]),
      );
      expect(meta.primaryColumns[0]?.propertyName).toBe("id");
      expect(meta.createDateColumns[0]?.propertyName).toBe("createdAt");
      expect(meta.updateDateColumns[0]?.propertyName).toBe("updatedAt");
      expect(meta.deleteDateColumn?.propertyName).toBe("deletedAt");

      const repo = ds.getRepository(Article);
      const saved = await repo.save({ title: "Hello BaseEntity" });
      expect(typeof saved.id).toBe("number");
      expect(saved.id).toBeGreaterThan(0);
      expect(saved.createdAt).toBeInstanceOf(Date);
      expect(saved.updatedAt).toBeInstanceOf(Date);
      expect(saved.deletedAt ?? null).toBeNull();

      // Update bumps updatedAt while keeping createdAt
      await Bun.sleep(5);
      const originalCreated = saved.createdAt.getTime();
      saved.title = "Updated title";
      const updated = await repo.save(saved);
      expect(updated.createdAt.getTime()).toBe(originalCreated);
      expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(originalCreated);

      // Soft delete hides row from default find() and restores cleanly
      await repo.softDelete(saved.id);
      expect(await repo.find()).toHaveLength(0);

      const withDeleted = await repo.find({ withDeleted: true });
      expect(withDeleted).toHaveLength(1);
      expect(withDeleted[0]!.deletedAt).toBeInstanceOf(Date);

      await repo.restore(saved.id);
      const restored = await repo.find();
      expect(restored).toHaveLength(1);
      expect(restored[0]!.deletedAt ?? null).toBeNull();
    } finally {
      await ds.destroy();
    }
  });

  it("supports UUID string keys, stacked @Entity() in either order, @Data/@Builder/@FieldNameConstants, and CrudRepository", async () => {
    @Entity("accounts")
    @BaseEntity<string>({ idStrategy: "uuid" })
    @Data()
    @Builder()
    @FieldNameConstants()
    class Account {
      @Column()
      email!: string;

      id!: string;
      createdAt!: Date;
      updatedAt!: Date;
      deletedAt?: Date | null;
    }

    @OrmRepository(Account)
    @SoftDelete()
    abstract class AccountRepository extends CrudRepository<Account, string> {
      abstract findByEmail(email: string): Promise<Account | null>;
    }

    const ds = new DataSource({
      type: "sqlite",
      database: ":memory:",
      synchronize: true,
      entities: [Account],
    });
    await ds.initialize();

    try {
      const meta = ds.getMetadata(Account);
      expect(meta.tableName).toBe("accounts");
      expect(meta.primaryColumns[0]?.generationStrategy).toBe("uuid");

      // Class macros automatically include id, createdAt, updatedAt, deletedAt!
      const fieldsConst = (Account as any).Fields as Record<string, string>;
      expect(fieldsConst.id).toBe("id");
      expect(fieldsConst.createdAt).toBe("createdAt");
      expect(fieldsConst.updatedAt).toBe("updatedAt");
      expect(fieldsConst.deletedAt).toBe("deletedAt");

      const built = (Account as any).builder().email("ada@bunest.dev").build() as any;
      expect(built.getEmail()).toBe("ada@bunest.dev");

      const repo = compileOrmRepository(AccountRepository).createInstance(ds);

      const created = await repo.save({ email: "ada@bunest.dev" });
      expect(typeof created.id).toBe("string");
      expect(created.id.length).toBeGreaterThanOrEqual(32);
      expect(created.createdAt).toBeDefined();
      expect(created.updatedAt).toBeDefined();

      const found = await repo.findByEmail("ada@bunest.dev");
      expect(found?.id).toBe(created.id);

      // @SoftDelete() intercepts deleteById using deleted_at column from @BaseEntity
      await repo.deleteById(created.id);
      expect(await repo.findByEmail("ada@bunest.dev")).toBeNull();
    } finally {
      await ds.destroy();
    }
  });

  it("supports opting out of columns, custom property names, and preserving explicit user @PrimaryColumn overrides", async () => {
    @BaseEntity<string>({
      tableName: "custom_items",
      createdAt: "insertedAt",
      updatedAt: true,
      deletedAt: false,
    })
    @Entity("explicit_items")
    class CustomItem {
      @PrimaryColumn("text")
      id!: string;

      @Column()
      label!: string;

      insertedAt!: Date;
      updatedAt!: Date;
    }

    const ds = new DataSource({
      type: "sqlite",
      database: ":memory:",
      synchronize: true,
      entities: [CustomItem],
    });
    await ds.initialize();

    try {
      const meta = ds.getMetadata(CustomItem);
      expect(meta.tableName).toBe("custom_items");
      expect(meta.primaryColumns[0]?.generated).toBe(false);
      expect(meta.columns.map((c) => c.propertyName)).toEqual([
        "id",
        "label",
        "insertedAt",
        "updatedAt",
      ]);
      expect(meta.deleteDateColumn).toBeUndefined();

      const repo = ds.getRepository(CustomItem);
      const row = await repo.save({ id: "sku-01", label: "Widget" });
      expect(row.id).toBe("sku-01");
      expect(row.insertedAt).toBeInstanceOf(Date);
      expect(row.updatedAt).toBeInstanceOf(Date);
    } finally {
      await ds.destroy();
    }
  });

  it("bridges ORM entities lazily to @bunest/core EntitySchema without eager MetadataRegistry double-writes", () => {
    @BaseEntity<number>("lazy_products")
    class LazyProduct {
      @Column({ length: 120, minLength: 2, description: "Display title" })
      @Index({ unique: true })
      title!: string;

      @Column("real")
      price!: number;
    }

    // Decoration time did NOT eagerly write native @bunest/core MetadataRegistry keys
    expect(MetadataRegistry.hasOwn(METADATA_KEYS.ENTITY_SCHEMA, LazyProduct)).toBe(
      false,
    );
    expect(
      MetadataRegistry.hasOwn(METADATA_KEYS.ENTITY_COLUMNS, LazyProduct),
    ).toBe(false);
    expect(
      hasEntitySchema(LazyProduct, { skipExternalResolvers: true }),
    ).toBe(false);

    // Lazy bridge materializes full EntitySchemaMetadata on demand (for Swagger & ValidationPipe)
    expect(hasEntitySchema(LazyProduct)).toBe(true);
    const schema = getEntitySchema(LazyProduct);
    expect(schema).toBeDefined();
    expect(schema!.tableName).toBe("lazy_products");
    expect(schema!.primaryKey?.propertyName).toBe("id");

    const cols = getEntityColumns(LazyProduct);
    const titleCol = cols.find((c) => c.propertyName === "title");
    expect(titleCol).toBeDefined();
    expect(titleCol!.length).toBe(120);
    expect(titleCol!.minLength).toBe(2);
    expect(titleCol!.description).toBe("Display title");
    expect(titleCol!.unique).toBe(true);

    const indexes = getEntityIndexes(LazyProduct);
    expect(indexes).toHaveLength(1);
    expect(indexes[0]!.columns).toEqual(["title"]);
    expect(indexes[0]!.unique).toBe(true);

    // Second call hits the WeakMap cache
    expect(getEntitySchema(LazyProduct)).toBe(schema);
  });
});
