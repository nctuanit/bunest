import { describe, expect, it } from "bun:test";
import {
  Column as CommonColumn,
  Entity as CommonEntity,
  PrimaryGeneratedColumn as CommonPrimaryGeneratedColumn,
} from "@bunest/core";
import {
  AfterInsert,
  AfterLoad,
  AfterRemove,
  AfterUpdate,
  And,
  BeforeInsert,
  BeforeRemove,
  BeforeUpdate,
  Between,
  Column,
  CreateDateColumn,
  DataSource,
  DeleteDateColumn,
  Entity,
  EntityNotFoundError,
  ILike,
  In,
  Index,
  IsNull,
  JoinColumn,
  JoinTable,
  LessThan,
  Like,
  ManyToMany,
  ManyToOne,
  MoreThan,
  MoreThanOrEqual,
  Not,
  OneToMany,
  OptimisticLockError,
  Or,
  PrimaryGeneratedColumn,
  Raw,
  Unique,
  UpdateDateColumn,
  VersionColumn,
  generateSchemaPlan,
} from "../src/index";

abstract class AuditableBaseEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @DeleteDateColumn()
  deletedAt!: Date | null;

  @VersionColumn()
  version!: number;
}

@Entity("blog_users")
@Unique(["email"])
class BlogUser extends AuditableBaseEntity {
  @Column()
  @Index()
  name!: string;

  @Column()
  email!: string;

  @Column({ type: "integer", default: 0 })
  score!: number;

  @Column({ type: "boolean", default: true })
  active!: boolean;

  @OneToMany(() => BlogPost, (p) => p.author, { cascade: true })
  posts!: BlogPost[];

  hookEvents: string[] = [];

  @BeforeInsert()
  onBeforeInsert() {
    this.email = this.email.trim().toLowerCase();
    this.hookEvents.push("before-insert");
  }

  @AfterInsert()
  onAfterInsert() {
    this.hookEvents.push("after-insert");
  }

  @BeforeUpdate()
  onBeforeUpdate() {
    this.hookEvents.push("before-update");
  }

  @AfterUpdate()
  onAfterUpdate() {
    this.hookEvents.push("after-update");
  }

  @BeforeRemove()
  onBeforeRemove() {
    this.hookEvents.push("before-remove");
  }

  @AfterRemove()
  onAfterRemove() {
    this.hookEvents.push("after-remove");
  }

  @AfterLoad()
  onAfterLoad() {
    this.hookEvents.push("after-load");
  }
}

@Entity("blog_tags")
class BlogTag {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ unique: true })
  slug!: string;

  @ManyToMany(() => BlogPost, (p) => p.tags)
  posts!: BlogPost[];
}

@Entity("blog_posts")
class BlogPost extends AuditableBaseEntity {
  @Column()
  title!: string;

  @Column({ type: "integer", default: 0 })
  views!: number;

  @ManyToOne(() => BlogUser, (u) => u.posts, { onDelete: "CASCADE" })
  @JoinColumn({ name: "author_id" })
  author!: BlogUser;

  @ManyToMany(() => BlogTag, (t) => t.posts, { cascade: true })
  @JoinTable({ name: "blog_post_tags" })
  tags!: BlogTag[];
}

// Unified @bunest/common @Entity interop check!
@CommonEntity("common_interop_items")
class CommonInteropItem {
  @CommonPrimaryGeneratedColumn()
  id!: number;

  @CommonColumn()
  label!: string;
}

describe("@bunest/orm — Full TypeORM Feature Parity", () => {
  it("supports inheritance, UUID PK, lifecycle hooks, ManyToMany, shadow FK preservation, FindOperators, soft delete, optimistic locking, and @bunest/common @Entity interop", async () => {
    const loggedQueries: string[] = [];
    const ds = new DataSource({
      type: "sqlite",
      database: ":memory:",
      entities: [BlogUser, BlogPost, BlogTag, CommonInteropItem],
      synchronize: true,
      logging: (ev) => loggedQueries.push(ev.sql),
    });
    await ds.initialize();

    try {
      const userRepo = ds.getRepository(BlogUser);
      const postRepo = ds.getRepository(BlogPost);
      const tagRepo = ds.getRepository(BlogTag);

      // Save user + posts + UUID ManyToMany tags in one cyclic cascade!
      const tagTs = tagRepo.create({ slug: "typescript" });
      const tagBun = tagRepo.create({ slug: "bun" });

      const alice = userRepo.create({
        name: "Alice",
        email: "  ALICE@Example.COM ",
        score: 50,
        posts: [
          { title: "Intro to Bunest ORM", views: 120, tags: [tagTs, tagBun] },
          { title: "Zero Circular Errors", views: 300, tags: [tagTs] },
        ],
      });
      await userRepo.save(alice);

      expect(alice.email).toBe("alice@example.com"); // Normalized in @BeforeInsert!
      expect(alice.hookEvents).toEqual(["before-insert", "after-insert"]);
      expect(alice.version).toBe(1);
      expect(alice.createdAt).toBeInstanceOf(Date);
      expect(tagTs.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );

      // Shadow FK preservation: load post WITHOUT `relations: ["author"]`, edit title, save -> author_id MUST NOT be wiped!
      const plainPost = await postRepo.findOneByOrFail({
        title: "Intro to Bunest ORM",
      });
      plainPost.title = "Intro to Bunest ORM (v2)";
      await postRepo.save(plainPost);

      const reloadedWithAuthor = await postRepo.findOneOrFail({
        where: { id: plainPost.id },
        relations: { author: true, tags: true },
      });
      expect(reloadedWithAuthor.author.email).toBe("alice@example.com");
      expect(reloadedWithAuthor.tags.map((t) => t.slug).sort()).toEqual([
        "bun",
        "typescript",
      ]);

      // Inverse ManyToMany query (Tag -> Posts -> Author)
      const loadedTag = await tagRepo.findOneOrFail({
        where: { slug: "typescript" },
        relations: { posts: { author: true } },
      });
      expect(loadedTag.posts).toHaveLength(2);
      expect(loadedTag.posts[0]?.author.name).toBe("Alice");
      // Same author instance shared via IdentityMap across both posts!
      expect(loadedTag.posts[0]?.author).toBe(loadedTag.posts[1]?.author);

      // FindOperators + relation WHERE filtering!
      const highViewPosts = await postRepo.find({
        where: {
          views: And(MoreThanOrEqual(100), LessThan(500)),
          title: ILike("%bunest%"),
          author: { email: "alice@example.com" },
          tags: { slug: In(["bun", "rust"]) },
        },
      });
      expect(highViewPosts).toHaveLength(1);
      expect(highViewPosts[0]?.title).toBe("Intro to Bunest ORM (v2)");

      // More FindOperators: Between, Not, Like, Or, IsNull, Raw
      expect(
        await postRepo.count({
          where: {
            views: Between(100, 200),
            deletedAt: IsNull(),
            title: Not(Like("%Deleted%")),
          },
        }),
      ).toBe(1);

      expect(
        await postRepo.count({
          where: {
            views: Or(MoreThan(250), Raw((col) => `${col} = :v`, { v: 120 })),
          },
        }),
      ).toBe(2);

      // Increment / Decrement & Upsert
      await userRepo.increment({ id: alice.id }, "score", 25);
      await userRepo.decrement({ id: alice.id }, "score", 5);
      const afterInc = await userRepo.findOneByOrFail({ id: alice.id });
      expect(afterInc.score).toBe(70);
      expect(afterInc.hookEvents).toContain("after-load");

      await userRepo.upsert(
        { email: "alice@example.com", name: "Alice Updated" },
        ["email"],
      );
      expect((await userRepo.findOneByOrFail({ id: alice.id })).name).toBe(
        "Alice Updated",
      );

      // Optimistic locking conflict (@VersionColumn)
      const staleCopy = await userRepo.findOneByOrFail({ id: alice.id });
      const freshCopy = await userRepo.findOneByOrFail({ id: alice.id });
      freshCopy.name = "Alice vNext";
      await userRepo.save(freshCopy);
      expect(freshCopy.version).toBe(staleCopy.version + 1);

      staleCopy.name = "Conflicting Edit";
      await expect(userRepo.save(staleCopy)).rejects.toThrow(OptimisticLockError);

      // Soft delete & restore
      await postRepo.softDelete(plainPost.id);
      expect(await postRepo.count()).toBe(1);
      expect(await postRepo.count({ withDeleted: true })).toBe(2);
      await postRepo.restore(plainPost.id);
      expect(await postRepo.count()).toBe(2);

      // EntityNotFoundError
      await expect(
        userRepo.findOneByOrFail({ email: "nobody@example.com" }),
      ).rejects.toThrow(EntityNotFoundError);

      // @bunest/common @Entity interop
      const commonRepo = ds.getRepository(CommonInteropItem);
      const savedCommon = await commonRepo.save({ label: "Shared Entity" });
      expect(
        (await commonRepo.findOneByOrFail({ id: savedCommon.id })).label,
      ).toBe("Shared Entity");

      // Remove triggers lifecycle hooks
      const toDelete = await userRepo.findOneByOrFail({ id: alice.id });
      await userRepo.remove(toDelete);
      expect(toDelete.hookEvents).toContain("before-remove");
      expect(toDelete.hookEvents).toContain("after-remove");
      expect(loggedQueries.length).toBeGreaterThan(5);
    } finally {
      await ds.destroy();
    }
  });

  it("supports SelectQueryBuilder multi-level & cyclic joins, QueryBuilders, nested savepoint transactions, migrations, and multi-dialect DDL", async () => {
    const ds = new DataSource({
      type: "sqlite",
      database: ":memory:",
      entities: [BlogUser, BlogPost, BlogTag],
      synchronize: true,
      migrations: [
        {
          id: "001_audit_table",
          up: async (runner) => {
            await runner.execute(
              "CREATE TABLE audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, msg TEXT NOT NULL)",
            );
          },
        },
      ],
      migrationsRun: true,
    });
    await ds.initialize();

    try {
      // Multi-dialect schema plans (postgres & mysql)
      const pgPlan = generateSchemaPlan(ds.metadataGraph, "postgres");
      expect(pgPlan.tableSqls.some((s) => s.includes("SERIAL PRIMARY KEY"))).toBe(true);
      expect(pgPlan.tableSqls.some((s) => s.includes("UUID PRIMARY KEY"))).toBe(true);
      expect(pgPlan.joinTableSqls.some((s) => s.includes("blog_post_tags"))).toBe(true);

      const mysqlPlan = generateSchemaPlan(ds.metadataGraph, "mysql");
      expect(mysqlPlan.tableSqls.some((s) => s.includes("AUTO_INCREMENT PRIMARY KEY"))).toBe(true);
      expect(mysqlPlan.tableSqls.some((s) => s.includes("`blog_users`"))).toBe(true);

      // Seed data (reuse shared tag entity across both posts)
      const userRepo = ds.getRepository(BlogUser);
      const tagRepo = ds.getRepository(BlogTag);
      const newsTag = tagRepo.create({ slug: "news" });
      const techTag = tagRepo.create({ slug: "tech" });
      const bob = await userRepo.save({
        name: "Bob",
        email: "bob@example.com",
        score: 90,
        posts: [
          { title: "First", views: 10, tags: [newsTag, techTag] },
          { title: "Second", views: 50, tags: [techTag] },
        ],
      });

      // Fluent SelectQueryBuilder with multi-level joins + cyclic back-join to author!
      const [users, count] = await userRepo
        .createQueryBuilder("u")
        .leftJoinAndSelect("u.posts", "p")
        .leftJoinAndSelect("p.tags", "t")
        .leftJoinAndSelect("p.author", "a")
        .where("u.score >= :minScore", { minScore: 50 })
        .andWhere("t.slug IN (:...slugs)", { slugs: ["news", "tech"] })
        .orderBy("p.views", "DESC")
        .getManyAndCount();

      expect(count).toBe(1);
      expect(users).toHaveLength(1);
      expect(users[0]?.id).toBe(bob.id);
      expect(users[0]?.posts).toHaveLength(2);
      expect(users[0]?.posts[0]?.title).toBe("Second");
      // Cyclic join hydrated via IdentityMap — exact same instance!
      expect(users[0]?.posts[0]?.author).toBe(users[0]);

      // UpdateQueryBuilder & DeleteQueryBuilder
      await userRepo
        .createUpdateQueryBuilder()
        .set({ score: 100 })
        .where("id = :id", { id: bob.id })
        .execute();
      expect((await userRepo.findOneByOrFail({ id: bob.id })).score).toBe(100);

      // Nested savepoint transaction: inner fails & rolls back, outer succeeds!
      await ds.transaction(async (em) => {
        await em.save(BlogUser, { name: "Outer", email: "outer@example.com" });
        await expect(
          em.transaction(async (innerEm) => {
            await innerEm.save(BlogUser, {
              name: "InnerRolledBack",
              email: "inner@example.com",
            });
            throw new Error("rollback-inner-savepoint");
          }),
        ).rejects.toThrow("rollback-inner-savepoint");
      });

      expect(await userRepo.existsBy({ email: "outer@example.com" })).toBe(true);
      expect(await userRepo.existsBy({ email: "inner@example.com" })).toBe(false);

      // Migration table created cleanly & idempotent re-run applies 0 new migrations
      await ds.query("INSERT INTO audit_logs (msg) VALUES (?)", ["hello"]);
      const logs = await ds.query<{ msg: string }>("SELECT msg FROM audit_logs");
      expect(logs).toEqual([{ msg: "hello" }]);
      expect(await ds.runMigrations()).toEqual([]);
    } finally {
      await ds.destroy();
    }
  });
});
