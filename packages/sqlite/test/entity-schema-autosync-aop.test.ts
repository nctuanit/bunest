import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  DecoratorRegistry,
  Injectable,
  MetadataRegistry,
  SetMetadata,
  createMethodAspectDecorator,
  type DecoratorRegistrySnapshot,
  type MethodAspectContext,
  type MethodAspectHandler,
} from "@bunest/common";
import { BunestFactory } from "@bunest/core";
import { Test } from "@bunest/testing";
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  InjectSqliteRepository,
  JpaRepository,
  Modifying,
  PrimaryGeneratedColumn,
  PrimaryKey,
  Query,
  SqlParam,
  SqliteModule,
  SqliteRepository,
  SqliteService,
  Transactional,
  Unique,
  UpdateDateColumn,
  generateCreateTableSql,
  getEntitySchema,
  hasEntitySchema,
  type ColumnMetadata,
  type EntitySchemaMetadata,
} from "../src/index";

describe("@bunest/sqlite Wave 2A: Unified Entity Schema, Auto-DDL, Auto-Register & Repository AOP", () => {
  let registrySnapshot: DecoratorRegistrySnapshot;

  beforeEach(() => {
    registrySnapshot = DecoratorRegistry.snapshot();
  });

  afterEach(() => {
    DecoratorRegistry.restore(registrySnapshot);
  });

  it("re-exports unified entity decorators and generates safe DDL across sqlite, postgres, and mysql dialects", () => {
    @Entity({ tableName: "articles", schema: "app" })
    @Index(["authorId", "published"], { name: "idx_articles_author_pub" })
    @Unique(["authorId", "slug"])
    class Article {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: "bigint" })
      authorId!: bigint;

      @Column({ type: "varchar", length: 120, unique: true })
      slug!: string;

      @Column({ type: "text" })
      title!: string;

      @Column({ type: "real", default: 0.5 })
      score!: number;

      @Column({ type: "boolean", default: true })
      published!: boolean;

      @Column({ type: "json", nullable: true })
      tags!: string[] | null;

      @Column({ type: "blob", nullable: true })
      thumbnail!: Uint8Array | null;

      @Column({ type: "uuid", default: "00000000-0000-0000-0000-000000000000" })
      externalId!: string;

      @Index({ where: "published = 1" })
      @Column({ default: "draft's" })
      status!: string;

      @CreateDateColumn()
      createdAt!: Date;

      @UpdateDateColumn()
      updatedAt!: Date;
    }

    expect(hasEntitySchema(Article)).toBe(true);
    const schema: EntitySchemaMetadata | undefined = getEntitySchema(Article);
    expect(schema).toBeDefined();
    const idCol: ColumnMetadata | undefined = schema?.primaryKey;
    expect(idCol?.name).toBe("id");

    // SQLite DDL
    const sqliteDdl = generateCreateTableSql(Article, "sqlite");
    expect(sqliteDdl.tableSql).toContain('CREATE TABLE IF NOT EXISTS "app"."articles"');
    expect(sqliteDdl.tableSql).toContain('"id" INTEGER PRIMARY KEY AUTOINCREMENT');
    expect(sqliteDdl.tableSql).toContain('"author_id" INTEGER NOT NULL');
    expect(sqliteDdl.tableSql).toContain('"slug" VARCHAR(120) NOT NULL UNIQUE');
    expect(sqliteDdl.tableSql).toContain('"score" REAL NOT NULL DEFAULT 0.5');
    expect(sqliteDdl.tableSql).toContain('"published" INTEGER NOT NULL DEFAULT 1');
    expect(sqliteDdl.tableSql).toContain('"tags" TEXT');
    expect(sqliteDdl.tableSql).toContain('"thumbnail" BLOB');
    expect(sqliteDdl.tableSql).toContain(
      '"external_id" TEXT NOT NULL DEFAULT \'00000000-0000-0000-0000-000000000000\'',
    );
    expect(sqliteDdl.tableSql).toContain(
      '"status" TEXT NOT NULL DEFAULT \'draft\'\'s\'',
    );
    expect(sqliteDdl.tableSql).toContain('"created_at" TEXT NOT NULL');
    expect(sqliteDdl.tableSql).toContain('"updated_at" TEXT NOT NULL');
    expect(sqliteDdl.indexSqls).toEqual([
      'CREATE INDEX IF NOT EXISTS "idx_articles_status" ON "app"."articles" ("status") WHERE published = 1',
      'CREATE UNIQUE INDEX IF NOT EXISTS "uq_articles_author_id_slug" ON "app"."articles" ("author_id", "slug")',
      'CREATE INDEX IF NOT EXISTS "idx_articles_author_pub" ON "app"."articles" ("author_id", "published")',
    ]);

    // PostgreSQL DDL
    const pgDdl = generateCreateTableSql(Article, "postgres");
    expect(pgDdl.tableSql).toContain('"id" SERIAL PRIMARY KEY');
    expect(pgDdl.tableSql).toContain('"author_id" BIGINT NOT NULL');
    expect(pgDdl.tableSql).toContain('"score" DOUBLE PRECISION NOT NULL DEFAULT 0.5');
    expect(pgDdl.tableSql).toContain('"published" BOOLEAN NOT NULL DEFAULT TRUE');
    expect(pgDdl.tableSql).toContain('"tags" JSONB');
    expect(pgDdl.tableSql).toContain('"thumbnail" BYTEA');
    expect(pgDdl.tableSql).toContain('"external_id" UUID NOT NULL');
    expect(pgDdl.tableSql).toContain('"created_at" TIMESTAMPTZ NOT NULL');
    expect(pgDdl.tableSql).toContain('"updated_at" TIMESTAMPTZ NOT NULL');
    expect(pgDdl.indexSqls[0]).toContain(
      'CREATE INDEX IF NOT EXISTS "idx_articles_status" ON "app"."articles" ("status") WHERE published = 1',
    );

    // MySQL DDL
    const mysqlDdl = generateCreateTableSql(Article, "mysql");
    expect(mysqlDdl.tableSql).toContain("CREATE TABLE IF NOT EXISTS `app`.`articles`");
    expect(mysqlDdl.tableSql).toContain("`id` INT AUTO_INCREMENT PRIMARY KEY");
    expect(mysqlDdl.tableSql).toContain("`author_id` BIGINT NOT NULL");
    expect(mysqlDdl.tableSql).toContain("`slug` VARCHAR(120) NOT NULL UNIQUE");
    expect(mysqlDdl.tableSql).toContain("`score` DOUBLE NOT NULL DEFAULT 0.5");
    expect(mysqlDdl.tableSql).toContain("`published` TINYINT(1) NOT NULL DEFAULT TRUE");
    expect(mysqlDdl.tableSql).toContain("`tags` JSON");
    expect(mysqlDdl.tableSql).toContain("`thumbnail` LONGBLOB");
    expect(mysqlDdl.tableSql).toContain("`external_id` CHAR(36) NOT NULL");
    expect(mysqlDdl.tableSql).toContain("`created_at` DATETIME NOT NULL");
    expect(mysqlDdl.indexSqls[1]).toBe(
      "CREATE UNIQUE INDEX IF NOT EXISTS `uq_articles_author_id_slug` ON `app`.`articles` (`author_id`, `slug`)",
    );

    // Composite primary key + bigint auto-increment
    @Entity("memberships")
    class Membership {
      @PrimaryKey()
      tenantId!: number;

      @PrimaryKey()
      userId!: number;

      @Column({ default: "member" })
      role!: string;
    }
    const compDdl = generateCreateTableSql(Membership, "sqlite");
    expect(compDdl.tableSql).toContain('PRIMARY KEY ("tenant_id", "user_id")');

    // Rejects unsafe SQL identifiers
    @Entity("users; DROP TABLE x")
    class UnsafeTable {
      @PrimaryGeneratedColumn()
      id!: number;
    }
    expect(() => generateCreateTableSql(UnsafeTable, "sqlite")).toThrow(
      /Invalid table name/,
    );

    @Entity("safe_table")
    class UnsafeColumn {
      @Column({ name: "col; --" })
      bad!: string;
    }
    expect(() => generateCreateTableSql(UnsafeColumn, "sqlite")).toThrow(
      /Invalid column name/,
    );
  });

  it("auto-registers @SqliteRepository and auto-syncs tables & indexes with ZERO forFeature and ZERO manual CREATE TABLE SQL", async () => {
    DecoratorRegistry.clear("sqlite-repository");
    DecoratorRegistry.clear("entity");

    @Entity("customers")
    @Index(["tier", "isActive"])
    class Customer {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ name: "email_addr", unique: true })
      emailAddress!: string;

      @Column()
      fullName!: string;

      @Column({ default: "free" })
      tier!: string;

      @Column({ default: true })
      isActive!: boolean;

      @Column({ type: "json", nullable: true })
      profile!: { company: string; seats: number } | null;

      @Column({
        type: "integer",
        nullable: true,
        transformer: {
          to: (dollars: number) => Math.round(dollars * 100),
          from: (cents: number) => cents / 100,
        },
      })
      creditBalance!: number | null;

      @Column({ type: "datetime", nullable: true })
      lastLoginAt!: Date | null;

      @CreateDateColumn()
      createdAt!: Date;

      @UpdateDateColumn()
      updatedAt!: Date;
    }

    @Entity("standalone_notes")
    class StandaloneNote {
      @PrimaryGeneratedColumn("uuid")
      id!: string;

      @Column()
      body!: string;
    }

    @Entity("analytics_events")
    class AnalyticsEvent {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column()
      eventName!: string;
    }

    @SqliteRepository(Customer)
    abstract class CustomerRepository extends JpaRepository<Customer, number> {
      abstract findByEmailAddress(email: string): Promise<Customer | null>;
      abstract findAllByIsActive(active: boolean): Promise<Customer[]>;
      abstract findAllByCreatedAtGreaterThan(since: Date): Promise<Customer[]>;

      @Query("SELECT * FROM customers WHERE email_addr = :email", { single: true })
      findCustomByEmail(
        @SqlParam("email") _email: string,
      ): Promise<Customer | null> {
        return null as unknown as Promise<Customer | null>;
      }
    }

    @SqliteRepository(StandaloneNote)
    abstract class StandaloneNoteRepository extends JpaRepository<
      StandaloneNote,
      string
    > {}

    @SqliteRepository({ entity: AnalyticsEvent, connectionName: "analytics" })
    abstract class AnalyticsEventRepository extends JpaRepository<
      AnalyticsEvent,
      number
    > {}

    @Injectable()
    class CustomerFacade {
      constructor(
        public readonly customers: CustomerRepository,
        @InjectSqliteRepository(CustomerRepository)
        public readonly customersByToken: CustomerRepository,
        public readonly notes: StandaloneNoteRepository,
      ) {}
    }

    // Notice: ZERO SqliteModule.forFeature([...]) and ZERO manual CREATE TABLE SQL!
    const mod = await Test.createTestingModule({
      imports: [
        SqliteModule.forRoot({
          filename: ":memory:",
          autoSync: true,
          autoRegisterRepositories: true,
        }),
        SqliteModule.forRoot({
          name: "analytics",
          filename: ":memory:",
          autoSync: true,
          autoRegisterRepositories: true,
          entities: [AnalyticsEvent],
        }),
      ],
      providers: [CustomerFacade],
    }).compile();

    await mod.init();
    try {
      const db = mod.get(SqliteService);
      const facade = mod.get(CustomerFacade);
      const repo = facade.customers;

      expect(repo).toBe(facade.customersByToken);
      expect(repo).toBeInstanceOf(CustomerRepository);

      // Verify tables & indexes were created automatically on default connection
      const tables = db
        .query<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
        )
        .map((r) => r.name);
      expect(tables).toContain("customers");
      expect(tables).toContain("standalone_notes");

      const indexes = db
        .query<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'customers'",
        )
        .map((r) => r.name);
      expect(indexes).toContain("idx_customers_tier_is_active");

      // Save with boolean, json, datetime, custom transformer, and auto-timestamps
      const loginDate = new Date("2026-06-15T12:30:00.000Z");
      const saved = await repo.save({
        emailAddress: "ada@bunest.dev",
        fullName: "Ada Lovelace",
        tier: "pro",
        isActive: true,
        profile: { company: "Analytical Engine", seats: 12 },
        creditBalance: 42.75,
        lastLoginAt: loginDate,
      });

      expect(saved).toBeInstanceOf(Customer);
      expect(saved.id).toBe(1);
      expect(saved.emailAddress).toBe("ada@bunest.dev");
      expect(saved.isActive).toBe(true);
      expect(typeof saved.isActive).toBe("boolean");
      expect(saved.profile).toEqual({ company: "Analytical Engine", seats: 12 });
      expect(saved.creditBalance).toBe(42.75);
      expect(saved.lastLoginAt).toBeInstanceOf(Date);
      expect(saved.lastLoginAt?.toISOString()).toBe(loginDate.toISOString());
      expect(saved.createdAt).toBeInstanceOf(Date);
      expect(saved.updatedAt).toBeInstanceOf(Date);

      // Verify raw DB values stored correctly (boolean -> 1, json -> string, cents -> 4275)
      const raw = db.queryOne<Record<string, unknown>>(
        "SELECT email_addr, is_active, profile, credit_balance FROM customers WHERE id = ?",
        [saved.id],
      );
      expect(raw?.email_addr).toBe("ada@bunest.dev");
      expect(raw?.is_active).toBe(1);
      expect(raw?.profile).toBe('{"company":"Analytical Engine","seats":12}');
      expect(raw?.credit_balance).toBe(4275);

      // Save second customer with false boolean & null transformer/json/datetime
      const inactive = await repo.save({
        emailAddress: "bob@bunest.dev",
        fullName: "Bob",
        isActive: false,
        profile: null,
        creditBalance: null,
        lastLoginAt: null,
      });
      expect(inactive.isActive).toBe(false);
      expect(inactive.profile).toBeNull();
      expect(inactive.creditBalance).toBeNull();
      expect(inactive.lastLoginAt).toBeNull();

      // Partial update preserves createdAt and refreshes updatedAt
      await Bun.sleep(15);
      const updated = await repo.save({ id: saved.id, tier: "enterprise" });
      expect(updated.createdAt.toISOString()).toBe(saved.createdAt.toISOString());
      expect(updated.updatedAt.getTime()).toBeGreaterThan(
        saved.updatedAt.getTime(),
      );
      expect(updated.creditBalance).toBe(42.75);
      expect(updated.isActive).toBe(true);

      // Derived queries with custom column name, boolean, and Date arguments
      const byEmail = await repo.findByEmailAddress("ada@bunest.dev");
      expect(byEmail?.id).toBe(saved.id);
      expect(byEmail?.isActive).toBe(true);

      const activeList = await repo.findAllByIsActive(true);
      expect(activeList.map((c) => c.emailAddress)).toEqual(["ada@bunest.dev"]);
      const inactiveList = await repo.findAllByIsActive(false);
      expect(inactiveList.map((c) => c.emailAddress)).toEqual(["bob@bunest.dev"]);

      const recent = await repo.findAllByCreatedAtGreaterThan(
        new Date(Date.now() - 60_000),
      );
      expect(recent).toHaveLength(2);

      // Custom @Query also hydrates boolean, json, datetime, transformer
      const viaCustomQuery = await repo.findCustomByEmail("ada@bunest.dev");
      expect(viaCustomQuery?.isActive).toBe(true);
      expect(viaCustomQuery?.profile).toEqual({
        company: "Analytical Engine",
        seats: 12,
      });
      expect(viaCustomQuery?.creditBalance).toBe(42.75);
      expect(viaCustomQuery?.createdAt).toBeInstanceOf(Date);

      // UUID PrimaryGeneratedColumn auto-generation
      const note = await facade.notes.save({ body: "UUID PK test" });
      expect(note.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      expect((await facade.notes.findById(note.id))?.body).toBe("UUID PK test");

      // Named connection repository auto-registered & auto-synced on its own connection
      const analyticsRepo = mod.get(AnalyticsEventRepository);
      const ev = await analyticsRepo.save({ eventName: "signup" });
      expect(ev.id).toBe(1);
      expect(ev.eventName).toBe("signup");
    } finally {
      await mod.close();
    }
  });

  it("supports forRootAsync({ autoSync: true, autoRegisterRepositories: true }), forFeature autoSync, and BunestFactory.createAuto()", async () => {
    DecoratorRegistry.clear();

    @Entity("items")
    class Item {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column()
      title!: string;

      @Column({ default: false })
      archived!: boolean;
    }

    @SqliteRepository(Item)
    abstract class ItemRepository extends JpaRepository<Item, number> {
      abstract findByTitle(title: string): Promise<Item | null>;
    }

    const mod = await Test.createTestingModule({
      imports: [
        SqliteModule.forRootAsync({
          autoRegisterRepositories: true,
          autoSync: true,
          useFactory: async () => ({
            filename: ":memory:",
          }),
        }),
      ],
    }).compile();

    await mod.init();
    try {
      const repo = mod.get(ItemRepository);
      const created = await repo.save({ title: "AsyncItem", archived: true });
      expect(created.id).toBe(1);
      expect(created.archived).toBe(true);
      expect((await repo.findByTitle("AsyncItem"))?.archived).toBe(true);
    } finally {
      await mod.close();
    }

    // Explicit forFeature([ItemRepository]) with forRoot({ autoSync: true }) (no autoRegisterRepositories)
    const featureMod = await Test.createTestingModule({
      imports: [
        SqliteModule.forRoot({
          filename: ":memory:",
          autoSync: true,
        }),
        SqliteModule.forFeature([ItemRepository]),
      ],
    }).compile();

    await featureMod.init();
    try {
      const repo = featureMod.get(ItemRepository);
      const created = await repo.save({ title: "FeatureSyncedItem", archived: false });
      expect(created.id).toBe(1);
      expect(created.archived).toBe(false);
    } finally {
      await featureMod.close();
    }

    // Readonly + autoSync fails fast
    expect(
      () => new SqliteService({ filename: ":memory:", readonly: true, autoSync: true }),
    ).toThrow(/cannot enable "autoSync" when "readonly" is true/);

    // Works cleanly with BunestFactory.createAuto() without spurious internal injectable discovery
    const app = await BunestFactory.createAuto({
      imports: [
        SqliteModule.forRoot({
          filename: ":memory:",
          autoSync: true,
          autoRegisterRepositories: true,
        }),
      ],
      logger: false,
    });
    await app.init();
    try {
      const repo = app.get(ItemRepository);
      const saved = await repo.save({ title: "AutoAppItem" });
      expect(saved.archived).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("preserves method metadata and weaves @Transactional() + custom MethodAspects on CRUD, @Query, concrete, and derived methods", async () => {
    DecoratorRegistry.clear("sqlite-repository");
    DecoratorRegistry.clear("entity");

    const spans: Array<{ label: string; method: string; inTx: boolean }> = [];
    const CUSTOM_META_KEY = Symbol("test:repo_query_meta");

    @Injectable()
    class SpanAspect implements MethodAspectHandler<string | undefined> {
      constructor(private readonly db: SqliteService) {}

      async intercept(ctx: MethodAspectContext<string | undefined>) {
        const label = ctx.options ?? `${ctx.targetClass.name}.${String(ctx.methodName)}`;
        const result = await ctx.proceed();
        spans.push({
          label,
          method: String(ctx.methodName),
          inTx: this.db.isInTransaction(),
        });
        return result;
      }
    }

    const Span = (label?: string) => createMethodAspectDecorator(SpanAspect, label);

    @Entity("members")
    class Member {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ unique: true })
      email!: string;

      @Column()
      name!: string;

      @Column({ default: true })
      active!: boolean;
    }

    @Span("repo-class")
    @SqliteRepository(Member)
    abstract class MemberRepository extends JpaRepository<Member, number> {
      abstract findByEmail(email: string): Promise<Member | null>;

      @Transactional()
      @Span("query-deactivate")
      @SetMetadata(CUSTOM_META_KEY, { audited: true })
      @Modifying()
      @Query("UPDATE members SET active = 0 WHERE email = :email")
      deactivateByEmail(@SqlParam("email") _email: string): Promise<number> {
        return 0 as unknown as Promise<number>;
      }

      @Transactional()
      @Span("concrete-pair")
      async createPairOrRollback(
        firstEmail: string,
        secondEmail: string,
        shouldFail: boolean,
      ): Promise<void> {
        await this.save({ email: firstEmail, name: "First", active: true });
        if (shouldFail) {
          throw new Error("repo-tx-boom");
        }
        await this.save({ email: secondEmail, name: "Second", active: true });
      }
    }

    // Method-level aspect attached to CRUD `save` and derived `findByEmail`
    Transactional()(MemberRepository.prototype, "save", undefined as any);
    Span("derived-email")(MemberRepository.prototype, "findByEmail", undefined as any);

    const mod = await Test.createTestingModule({
      imports: [
        SqliteModule.forRoot({
          filename: ":memory:",
          autoSync: true,
          autoRegisterRepositories: true,
        }),
      ],
      providers: [SpanAspect],
    }).compile();

    await mod.init();
    try {
      const repo = mod.get(MemberRepository);

      // 1. Metadata preservation from prototype stub -> bound @Query fn -> woven wrapper
      expect(
        MetadataRegistry.getOwn(CUSTOM_META_KEY, repo.deactivateByEmail),
      ).toEqual({ audited: true });

      // 2. CRUD `save()` runs both class-level @Span and method-level @Transactional!
      const alice = await repo.save({
        email: "alice@aop.dev",
        name: "Alice",
        active: true,
      });
      expect(alice.id).toBe(1);
      expect(spans.some((s) => s.method === "save" && s.label === "repo-class")).toBe(
        true,
      );

      // 3. Derived `findByEmail()` runs class-level @Span AND method-level @Span("derived-email")!
      spans.length = 0;
      const found = await repo.findByEmail("alice@aop.dev");
      expect(found?.name).toBe("Alice");
      expect(spans.map((s) => s.label)).toEqual(["derived-email", "repo-class"]);

      // 4. @Query + @Modifying runs @Transactional + @Span("query-deactivate") + class @Span!
      spans.length = 0;
      const changed = await repo.deactivateByEmail("alice@aop.dev");
      expect(changed).toBe(1);
      expect((await repo.findById(alice.id))?.active).toBe(false);
      // Inner @Span("query-deactivate") executes inside @Transactional() -> inTx === true!
      const querySpan = spans.find((s) => s.label === "query-deactivate");
      expect(querySpan).toBeDefined();
      expect(querySpan?.inTx).toBe(true);

      // 5. Concrete method with @Transactional() rolls back atomically on throw!
      await expect(
        repo.createPairOrRollback("p1@aop.dev", "p2@aop.dev", true),
      ).rejects.toThrow("repo-tx-boom");
      expect(await repo.findByEmail("p1@aop.dev")).toBeNull();

      await repo.createPairOrRollback("p1@aop.dev", "p2@aop.dev", false);
      expect(await repo.findByEmail("p1@aop.dev")).not.toBeNull();
      expect(await repo.findByEmail("p2@aop.dev")).not.toBeNull();
    } finally {
      await mod.close();
    }
  });
});
