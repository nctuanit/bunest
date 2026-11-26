import { describe, expect, it } from "bun:test";
import { ensureDir, join, realpathOf, removePath } from "@bunest/core";
import {
  CircularEmbeddedError,
  Column,
  DataSource,
  Embeddable,
  Embedded,
  Entity,
  JoinColumn,
  ManyToOne,
  MoreThan,
  OneToMany,
  OneToOne,
  PrimaryGeneratedColumn,
  createOrmCircularSafePlugin,
  defineEmbeddable,
  defineEntity,
  generateSchemaPlan,
  serializeEntity,
  transformCircularMetadataSource,
} from "../src/index";
import {
  AuthorContact,
  CircularAuthor,
} from "./fixtures/circular-author.entity";
import { CircularBook } from "./fixtures/circular-book.entity";
import { CircularProfile } from "./fixtures/circular-profile.entity";

describe("@bunest/orm — Circular & Nested Classes (Zero Class Errors)", () => {
  it("1. Multi-file ESM circular entities: load, cascade save cyclic graph, IdentityMap, and cycle-safe JSON.stringify", async () => {
    // Only pass CircularAuthor — CircularBook & CircularProfile are auto-discovered transitively!
    const ds = new DataSource({
      type: "sqlite",
      database: ":memory:",
      entities: [CircularAuthor],
      synchronize: true,
    });
    await ds.initialize();

    try {
      expect(ds.entityMetadatas.map((m) => m.name).sort()).toEqual([
        "CircularAuthor",
        "CircularBook",
        "CircularProfile",
      ]);

      const authorRepo = ds.getRepository(CircularAuthor);

      // Build an actual circular in-memory JS object graph!
      const author = new CircularAuthor();
      author.name = "Nguyen Nhat Anh";
      author.contact = Object.assign(new AuthorContact(), {
        city: "HCMC",
        website: "https://nna.example",
      });

      const profile = new CircularProfile();
      profile.bio = "Vietnamese novelist";
      profile.author = author;
      author.profile = profile;

      const b1 = new CircularBook();
      b1.title = "Mat Biec";
      b1.author = author;

      const b2 = new CircularBook();
      b2.title = "Kinh Van Hoa";
      b2.author = author;

      author.books = [b1, b2];

      // Cascade save cyclic graph in ONE call — zero stack overflow, zero FK error!
      const saved = await authorRepo.save(author);
      expect(saved.id).toBeGreaterThan(0);
      expect(profile.id).toBeGreaterThan(0);
      expect(b1.id).toBeGreaterThan(0);
      expect(b2.id).toBeGreaterThan(0);
      expect(b1.authorId).toBe(saved.id);
      expect(b2.authorId).toBe(saved.id);

      // Reload with bidirectional relations — IdentityMap preserves exact instance identity!
      const loaded = await authorRepo.findOneOrFail({
        where: { id: saved.id },
        relations: {
          profile: { author: true },
          books: { author: true },
        },
      });

      expect(loaded).toBeInstanceOf(CircularAuthor);
      expect(loaded.contact).toBeInstanceOf(AuthorContact);
      expect(loaded.contact?.format()).toBe("HCMC (https://nna.example)");
      expect(loaded.backupContact).toBeNull();
      expect(loaded.profile).toBeInstanceOf(CircularProfile);
      expect(loaded.profile?.author).toBe(loaded); // Exact same object via IdentityMap!
      expect(loaded.books).toHaveLength(2);
      expect(loaded.books[0]).toBeInstanceOf(CircularBook);
      expect(loaded.books[0]?.author).toBe(loaded); // Exact same object!

      // JSON.stringify() MUST NOT throw cyclic structure error!
      const jsonOmit = JSON.parse(JSON.stringify(loaded));
      expect(jsonOmit.name).toBe("Nguyen Nhat Anh");
      expect(jsonOmit.books).toHaveLength(2);
      expect(jsonOmit.books[0].title).toBe("Mat Biec");
      expect(jsonOmit.books[0].author).toBeUndefined(); // Cyclic back-reference cleanly omitted

      // Also verify "id" and "ref" circular serialization strategies
      const plainId = serializeEntity<Record<string, unknown>>(loaded, {
        circularStrategy: "id",
      });
      expect(
        (plainId.books as Array<Record<string, unknown>>)[0]?.author,
      ).toEqual({ id: loaded.id });

      const plainRef = serializeEntity<Record<string, unknown>>(loaded, {
        circularStrategy: "ref",
      });
      expect(
        (plainRef.profile as Record<string, unknown>).author,
      ).toEqual({ $ref: `CircularAuthor#${loaded.id}` });
    } finally {
      await ds.destroy();
    }
  });

  it("2. Same-file forward-referenced nested & circular classes via T and defineEntity (ZERO TDZ)", async () => {
    @Entity("forward_orders")
    class ForwardOrder {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column()
      code!: string;

      @Embedded(() => ForwardShipping)
      shipping!: ForwardShipping;

      @OneToMany(() => ForwardItem, (item) => item.order, { cascade: true })
      items!: ForwardItem[];
    }

    class ForwardShipping {
      @Column()
      carrier!: string;

      @Embedded(() => ForwardGeo)
      geo!: ForwardGeo;
    }

    class ForwardGeo {
      @Column("real")
      lat!: number;

      @Column("real")
      lng!: number;

      coords(): string {
        return `${this.lat},${this.lng}`;
      }
    }

    @Entity("forward_items")
    class ForwardItem {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column()
      sku!: string;

      @ManyToOne(() => ForwardOrder, (order) => order.items)
      order!: ForwardOrder;
    }

    // Pattern B: Zero-decorator programmatic `defineEntity` / `defineEmbeddable`
    class PlainTag {
      id!: number;
      label!: string;
      meta!: PlainMeta;
    }
    class PlainMeta {
      color!: string;
    }
    defineEmbeddable(PlainMeta, {
      columns: { color: { type: "text" } },
    });
    defineEntity(PlainTag, {
      tableName: "plain_tags",
      columns: {
        id: { primary: true, generated: "increment" },
        label: { type: "text" },
      },
      embedded: {
        meta: { target: () => PlainMeta },
      },
    });

    const ds = new DataSource({
      type: "sqlite",
      database: ":memory:",
      entities: [ForwardOrder, PlainTag],
      synchronize: true,
    });
    await ds.initialize();

    try {
      const orderRepo = ds.getRepository(ForwardOrder);
      const saved = await orderRepo.save({
        code: "ORD-001",
        shipping: { carrier: "GHTK", geo: { lat: 21.0285, lng: 105.8542 } },
        items: [{ sku: "SKU-A" }, { sku: "SKU-B" }],
      });

      const found = await orderRepo.findOneOrFail({
        where: { id: saved.id },
        relations: ["items"],
      });
      expect(found.shipping).toBeInstanceOf(ForwardShipping);
      expect(found.shipping.geo).toBeInstanceOf(ForwardGeo);
      expect(found.shipping.geo.coords()).toBe("21.0285,105.8542");
      expect(found.items).toHaveLength(2);
      expect(found.items[0]).toBeInstanceOf(ForwardItem);

      const tagRepo = ds.getRepository(PlainTag);
      const tag = await tagRepo.save({ label: "urgent", meta: { color: "red" } });
      const foundTag = await tagRepo.findOneByOrFail({ id: tag.id });
      expect(foundTag).toBeInstanceOf(PlainTag);
      expect(foundTag.meta).toBeInstanceOf(PlainMeta);
      expect(foundTag.meta.color).toBe("red");
    } finally {
      await ds.destroy();
    }
  });

  it("3. 4-level deep nested @Embedded classes: flat SQL columns, nested WHERE/ORDER, prototype methods, required-arg constructors", async () => {
    class Money {
      @Column("real")
      amount: number;

      @Column()
      currency: string;

      // Required constructor args that THROW if called with `new Money()`!
      // `@bunest/orm`'s `safeInstantiate()` falls back cleanly to `Object.create(Money.prototype)`.
      constructor(amount: number, currency: string) {
        if (typeof currency !== "string" || currency.length === 0) {
          throw new Error("Currency is required in Money constructor");
        }
        this.amount = amount;
        this.currency = currency;
      }

      format(): string {
        return `${this.amount} ${this.currency}`;
      }
    }

    @Embeddable()
    class GeoCoord {
      @Column("real")
      lat!: number;

      @Column("real")
      lng!: number;
    }

    @Embeddable()
    class StreetAddress {
      @Column()
      city!: string;

      @Column()
      country!: string;

      @Embedded(() => GeoCoord)
      geo!: GeoCoord;
    }

    @Embeddable()
    class OfficeInfo {
      @Column()
      floor!: number;

      @Embedded(() => StreetAddress)
      address!: StreetAddress;
    }

    @Entity("deep_companies")
    class DeepCompany {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column()
      name!: string;

      @Embedded(() => OfficeInfo)
      hq!: OfficeInfo;

      @Embedded(() => Money)
      valuation?: Money;
    }

    const ds = new DataSource({
      type: "sqlite",
      database: ":memory:",
      entities: [DeepCompany],
      synchronize: true,
    });
    await ds.initialize();

    try {
      const repo = ds.getRepository(DeepCompany);
      await repo.save([
        {
          name: "Bunest Vietnam",
          hq: {
            floor: 12,
            address: {
              city: "Hanoi",
              country: "VN",
              geo: { lat: 21.0285, lng: 105.8542 },
            },
          },
          valuation: new Money(1000000, "USD"),
        },
        {
          name: "Southern Tech",
          hq: {
            floor: 5,
            address: {
              city: "Da Nang",
              country: "VN",
              geo: { lat: 16.0544, lng: 108.2022 },
            },
          },
          valuation: new Money(500000, "USD"),
        },
      ]);

      // Nested WHERE on 4th-level flattened column (`hq_address_geo_lat > 20`)!
      const northern = await repo.find({
        where: {
          hq: {
            address: {
              country: "VN",
              geo: { lat: MoreThan(20) },
            },
          },
        },
      });
      expect(northern).toHaveLength(1);
      expect(northern[0]?.name).toBe("Bunest Vietnam");
      expect(northern[0]?.hq).toBeInstanceOf(OfficeInfo);
      expect(northern[0]?.hq.address).toBeInstanceOf(StreetAddress);
      expect(northern[0]?.hq.address.geo).toBeInstanceOf(GeoCoord);
      expect(northern[0]?.valuation).toBeInstanceOf(Money);
      expect(northern[0]?.valuation?.format()).toBe("1000000 USD");

      // Nested ORDER BY on deeply nested column
      const sorted = await repo.find({
        order: { hq: { address: { city: "ASC" } } },
      });
      expect(sorted.map((c) => c.hq.address.city)).toEqual(["Da Nang", "Hanoi"]);
    } finally {
      await ds.destroy();
    }
  });

  it("4. Arrays of nested classes, self-recursive nested classes, mutual cyclic nested classes, and CircularEmbeddedError guard", async () => {
    class LineItem {
      @Column()
      sku!: string;

      @Column("integer")
      qty!: number;

      @Column("real")
      unitPrice!: number;

      lineTotal(): number {
        return this.qty * this.unitPrice;
      }
    }

    // Self-recursive nested class: MenuNode -> children: MenuNode[]
    class MenuNode {
      @Column()
      label!: string;

      @Embedded(() => MenuNode, { array: true })
      children?: MenuNode[];

      countNodes(): number {
        return (
          1 +
          (this.children ?? []).reduce((acc, c) => acc + c.countNodes(), 0)
        );
      }
    }

    // Mutually-referencing nested classes: MutualBoxA <-> MutualBoxB
    class MutualBoxA {
      @Column()
      tagA!: string;

      @Embedded(() => MutualBoxB)
      boxB?: MutualBoxB;
    }

    class MutualBoxB {
      @Column()
      tagB!: string;

      @Embedded(() => MutualBoxA)
      boxA?: MutualBoxA;
    }

    @Entity("rich_documents")
    class RichDocument {
      @PrimaryGeneratedColumn()
      id!: number;

      @Embedded(() => LineItem, { array: true })
      items!: LineItem[];

      // mode: "auto" automatically detects self-recursion -> switches to JSON cleanly!
      @Embedded(() => MenuNode)
      menu!: MenuNode;

      // mode: "auto" automatically detects MutualBoxA <-> MutualBoxB cycle -> switches to JSON!
      @Embedded(() => MutualBoxA)
      mutual?: MutualBoxA;
    }

    const ds = new DataSource({
      type: "sqlite",
      database: ":memory:",
      entities: [RichDocument],
      synchronize: true,
    });
    await ds.initialize();

    try {
      const repo = ds.getRepository(RichDocument);

      // Even build a circular JS reference inside MutualBoxA <-> MutualBoxB!
      const boxA = new MutualBoxA();
      boxA.tagA = "alpha";
      const boxB = new MutualBoxB();
      boxB.tagB = "beta";
      boxA.boxB = boxB;
      boxB.boxA = boxA; // Cyclic value-object pointer — dehydrated safely without throwing!

      const saved = await repo.save({
        items: [
          { sku: "BOOK", qty: 2, unitPrice: 15 },
          { sku: "PEN", qty: 5, unitPrice: 2 },
        ],
        menu: {
          label: "Root",
          children: [
            {
              label: "Docs",
              children: [{ label: "Getting Started" }, { label: "API" }],
            },
            { label: "Blog" },
          ],
        },
        mutual: boxA,
      });

      const found = await repo.findOneByOrFail({ id: saved.id });

      // Array of nested classes hydrated to real LineItem instances!
      expect(found.items).toHaveLength(2);
      expect(found.items[0]).toBeInstanceOf(LineItem);
      expect(found.items[0]?.lineTotal()).toBe(30);
      expect(found.items[1]?.lineTotal()).toBe(10);

      // Self-recursive MenuNode tree hydrated to real MenuNode instances at every depth!
      expect(found.menu).toBeInstanceOf(MenuNode);
      expect(found.menu.children?.[0]).toBeInstanceOf(MenuNode);
      expect(found.menu.children?.[0]?.children?.[0]).toBeInstanceOf(MenuNode);
      expect(found.menu.countNodes()).toBe(5);

      // Mutually nested boxes hydrated to real instances!
      expect(found.mutual).toBeInstanceOf(MutualBoxA);
      expect(found.mutual?.tagA).toBe("alpha");
      expect(found.mutual?.boxB).toBeInstanceOf(MutualBoxB);
      expect(found.mutual?.boxB?.tagB).toBe("beta");
    } finally {
      await ds.destroy();
    }

    // Explicit `mode: "flat"` WITHOUT `maxDepth` on a cyclic embedded class MUST throw actionable CircularEmbeddedError
    class BadCycleA {
      @Column()
      x!: string;
      @Embedded(() => BadCycleA, { mode: "flat" })
      self?: BadCycleA;
    }
    @Entity("bad_flat_entities")
    class BadFlatEntity {
      @PrimaryGeneratedColumn()
      id!: number;
      @Embedded(() => BadCycleA, { mode: "flat" })
      cycle!: BadCycleA;
    }

    const badDs = new DataSource({
      type: "sqlite",
      database: ":memory:",
      entities: [BadFlatEntity],
    });
    await expect(badDs.initialize()).rejects.toThrow(CircularEmbeddedError);
    await badDs.destroy();
  });

  it("5. Mutual owning FK cycles (A <-> B) and 3-way FK ring (RingA -> RingB -> RingC -> RingA) with strict FK enforcement", async () => {
    @Entity("ring_a")
    class RingA {
      @PrimaryGeneratedColumn()
      id!: number;
      @Column()
      name!: string;
      @OneToOne(() => RingB, { cascade: true })
      @JoinColumn({ name: "next_b_id" })
      next?: RingB;
    }

    @Entity("ring_b")
    class RingB {
      @PrimaryGeneratedColumn()
      id!: number;
      @Column()
      name!: string;
      @OneToOne(() => RingC, { cascade: true })
      @JoinColumn({ name: "next_c_id" })
      next?: RingC;
    }

    @Entity("ring_c")
    class RingC {
      @PrimaryGeneratedColumn()
      id!: number;
      @Column()
      name!: string;
      @OneToOne(() => RingA, { cascade: true })
      @JoinColumn({ name: "next_a_id" })
      next?: RingA;
    }

    const ds = new DataSource({
      type: "sqlite",
      database: ":memory:",
      entities: [RingA, RingB, RingC],
      synchronize: true,
      enforceForeignKeys: true,
    });
    await ds.initialize();

    try {
      // Verify cyclic FK detection & PostgreSQL deferred ALTER TABLE plan
      expect(ds.metadataGraph.cyclicForeignKeys.size).toBeGreaterThan(0);
      const pgPlan = generateSchemaPlan(ds.metadataGraph, "postgres");
      expect(pgPlan.hasCyclicForeignKeys).toBe(true);
      expect(pgPlan.deferredForeignKeySqls.length).toBeGreaterThan(0);
      expect(pgPlan.deferredForeignKeySqls[0]).toContain("ALTER TABLE");
      expect(pgPlan.deferredForeignKeySqls[0]).toContain("FOREIGN KEY");

      // Save a complete 3-way circular ring in ONE atomic transaction with SQLite PRAGMA foreign_keys = ON!
      const a = new RingA();
      a.name = "Node-A";
      const b = new RingB();
      b.name = "Node-B";
      const c = new RingC();
      c.name = "Node-C";
      a.next = b;
      b.next = c;
      c.next = a; // Closes the 3-way FK cycle!

      await ds.getRepository(RingA).save(a);
      expect(a.id).toBeGreaterThan(0);
      expect(b.id).toBeGreaterThan(0);
      expect(c.id).toBeGreaterThan(0);

      // Reload full 3-way ring — `loadedA.next.next.next === loadedA` via IdentityMap!
      const loadedA = await ds.getRepository(RingA).findOneOrFail({
        where: { id: a.id },
        relations: { next: { next: { next: true } } },
      });
      expect(loadedA.name).toBe("Node-A");
      expect(loadedA.next?.name).toBe("Node-B");
      expect(loadedA.next?.next?.name).toBe("Node-C");
      expect(loadedA.next?.next?.next).toBe(loadedA);
      expect(() => JSON.stringify(loadedA)).not.toThrow();
    } finally {
      await ds.destroy();
    }
  });

  it("6. Mutual eager:true relations and self-referencing eager trees never infinite-loop", async () => {
    @Entity("eager_users")
    class EagerUser {
      @PrimaryGeneratedColumn()
      id!: number;
      @Column()
      username!: string;
      @OneToOne(() => EagerProfile, (p) => p.user, { eager: true, cascade: true })
      profile?: EagerProfile;
    }

    @Entity("eager_profiles")
    class EagerProfile {
      @PrimaryGeneratedColumn()
      id!: number;
      @Column()
      avatar!: string;
      @OneToOne(() => EagerUser, (u) => u.profile, { eager: true })
      @JoinColumn({ name: "user_id" })
      user?: EagerUser;
    }

    @Entity("tree_categories")
    class TreeCategory {
      @PrimaryGeneratedColumn()
      id!: number;
      @Column()
      name!: string;
      @ManyToOne(() => TreeCategory, (c) => c.children, { nullable: true })
      @JoinColumn({ name: "parent_id" })
      parent?: TreeCategory | null;
      @OneToMany(() => TreeCategory, (c) => c.parent, { eager: true, cascade: true })
      children!: TreeCategory[];
    }

    const ds = new DataSource({
      type: "sqlite",
      database: ":memory:",
      entities: [EagerUser, EagerProfile, TreeCategory],
      synchronize: true,
      maxEagerDepth: 2,
    });
    await ds.initialize();

    try {
      const user = new EagerUser();
      user.username = "tuannc";
      const profile = new EagerProfile();
      profile.avatar = "avatar.png";
      profile.user = user;
      user.profile = profile;
      await ds.getRepository(EagerUser).save(user);

      // Mutual eager:true loads both cleanly without infinite recursion!
      const loadedUser = await ds.getRepository(EagerUser).findOneByOrFail({
        id: user.id,
      });
      expect(loadedUser.profile?.avatar).toBe("avatar.png");
      expect(loadedUser.profile?.user).toBe(loadedUser);

      // Self-referencing tree with eager children
      const root = new TreeCategory();
      root.name = "Root";
      const child = new TreeCategory();
      child.name = "Child";
      const grandchild = new TreeCategory();
      grandchild.name = "Grandchild";
      child.children = [grandchild];
      root.children = [child];
      await ds.getRepository(TreeCategory).save(root);

      const loadedRoot = await ds.getRepository(TreeCategory).findOneByOrFail({
        id: root.id,
      });
      expect(loadedRoot.children).toHaveLength(1);
      expect(loadedRoot.children[0]?.name).toBe("Child");
      expect(loadedRoot.children[0]?.children).toHaveLength(1);
      expect(loadedRoot.children[0]?.children[0]?.name).toBe("Grandchild");
    } finally {
      await ds.destroy();
    }
  });

  it("7. Bun TDZ-safe preload plugin makes EVEN raw TypeORM-style circular value imports & same-file forward classes work!", async () => {
    // Unit check of source transformer
    const sample = `
      import { TargetB } from "./b";
      @Entity()
      export class TargetA {
        @OneToOne(() => TargetB)
        b!: TargetB;
      }
    `;
    const transformed = transformCircularMetadataSource(sample);
    expect(transformed).toContain("try { return typeof TargetB");
    expect(transformed).toContain("catch { return Object; }");

    // End-to-end runtime test: create real circular ESM files using RAW `post!: RawPost`
    // (NO T, NO import type, NO class-level decorator) + same-file forward class!
    const rawDir = join(
      Bun.env.TMPDIR ?? Bun.env.TEMP ?? "/tmp",
      `bunest-orm-plugin-${crypto.randomUUID()}`,
    );
    await ensureDir(rawDir);
    const dir = await realpathOf(rawDir);
    const ormEntry = join(import.meta.dir, "../src/index.ts");

    try {
      await Bun.write(
        join(dir, "raw-user.ts"),
        `
        import { Entity, PrimaryGeneratedColumn, Column, OneToOne, JoinColumn } from ${JSON.stringify(ormEntry)};
        import { RawProfile } from "./raw-profile";
        @Entity("raw_users")
        export class RawUser {
          @PrimaryGeneratedColumn() id!: number;
          @Column() name!: string;
          @OneToOne(() => RawProfile, (p) => p.user, { cascade: true })
          @JoinColumn({ name: "profile_id" })
          profile!: RawProfile;
        }
        `,
      );
      await Bun.write(
        join(dir, "raw-profile.ts"),
        `
        import { Entity, PrimaryGeneratedColumn, Column, OneToOne } from ${JSON.stringify(ormEntry)};
        import { RawUser } from "./raw-user";
        @Entity("raw_profiles")
        export class RawProfile {
          @PrimaryGeneratedColumn() id!: number;
          @Column() bio!: string;
          @OneToOne(() => RawUser, (u) => u.profile)
          user!: RawUser;
        }
        `,
      );
      await Bun.write(
        join(dir, "same-file-raw.ts"),
        `
        import { Entity, PrimaryGeneratedColumn, Column, Embedded } from ${JSON.stringify(ormEntry)};
        @Entity("raw_outers")
        export class RawOuter {
          @PrimaryGeneratedColumn() id!: number;
          @Embedded(() => RawInner)
          inner!: RawInner;
        }
        export class RawInner {
          @Column() label!: string;
        }
        `,
      );

      // Register plugin scoped strictly to this temp directory
      const escapedDir = dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      Bun.plugin(
        createOrmCircularSafePlugin({
          filter: new RegExp(`^${escapedDir}[\\\\/].*\\.ts$`),
        }),
      );

      const { RawUser } = (await import(join(dir, "raw-user.ts"))) as {
        RawUser: new () => { id: number; name: string; profile: { id: number; bio: string; user?: unknown } };
      };
      const { RawProfile } = (await import(join(dir, "raw-profile.ts"))) as {
        RawProfile: new () => { id: number; bio: string; user?: unknown };
      };
      const { RawOuter, RawInner } = (await import(join(dir, "same-file-raw.ts"))) as {
        RawOuter: new () => { id: number; inner: { label: string } };
        RawInner: new () => { label: string };
      };

      const ds = new DataSource({
        type: "sqlite",
        database: ":memory:",
        entities: [RawUser, RawProfile, RawOuter],
        synchronize: true,
      });
      await ds.initialize();
      try {
        const u = new RawUser();
        u.name = "RawPluginUser";
        const p = new RawProfile();
        p.bio = "Works without Relation<>!";
        u.profile = p;
        await ds.getRepository(RawUser).save(u);

        const loaded = await ds.getRepository(RawUser).findOneOrFail({
          where: { id: u.id },
          relations: ["profile"],
        });
        expect(loaded.name).toBe("RawPluginUser");
        expect(loaded.profile.bio).toBe("Works without Relation<>!");

        const outerSaved = await ds
          .getRepository(RawOuter)
          .save({ inner: { label: "ForwardNestedOK" } });
        const outerLoaded = await ds
          .getRepository(RawOuter)
          .findOneByOrFail({ id: outerSaved.id });
        expect(outerLoaded.inner).toBeInstanceOf(RawInner);
        expect(outerLoaded.inner.label).toBe("ForwardNestedOK");
      } finally {
        await ds.destroy();
      }
    } finally {
      await removePath(dir, { recursive: true, force: true });
    }
  });
});
