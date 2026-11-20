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
import { Test } from "@bunest/testing";
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  InjectSqlRepository,
  Modifying,
  PrimaryGeneratedColumn,
  PrimaryKey,
  Query,
  SqlCrudRepository,
  SqlModule,
  SqlParam,
  SqlQuery,
  SqlRepository,
  SqlService,
  Transactional,
  Unique,
  UpdateDateColumn,
  generateCreateTableSql,
  getEntitySchema,
  hasEntitySchema,
  type ColumnMetadata,
  type EntitySchemaMetadata,
} from "../src/index";

describe("@bunest/sql Wave 2A: Unified Entity Schema, Auto-DDL, Auto-Register & Repository AOP", () => {
  let registrySnapshot: DecoratorRegistrySnapshot;

  beforeEach(() => {
    registrySnapshot = DecoratorRegistry.snapshot();
  });

  afterEach(() => {
    DecoratorRegistry.restore(registrySnapshot);
  });

  it("re-exports unified entity decorators and generates dialect-aware DDL for sqlite, postgres, and mysql", () => {
    @Entity("orders")
    @Index(["customerId", "status"])
    @Unique(["referenceCode"])
    class Order {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: "bigint" })
      customerId!: bigint;

      @Column({ type: "varchar", length: 64 })
      referenceCode!: string;

      @Column({ type: "real", default: 0 })
      totalAmount!: number;

      @Column({ type: "boolean", default: false })
      paid!: boolean;

      @Column({ type: "json", nullable: true })
      lineItems!: Array<{ sku: string; qty: number }> | null;

      @Column({ type: "blob", nullable: true })
      receiptPdf!: Uint8Array | null;

      @Column({ type: "uuid", nullable: true })
      correlationId!: string | null;

      @Column({ default: "pending" })
      status!: string;

      @CreateDateColumn()
      createdAt!: Date;

      @UpdateDateColumn()
      updatedAt!: Date;
    }

    expect(hasEntitySchema(Order)).toBe(true);
    const schema: EntitySchemaMetadata | undefined = getEntitySchema(Order);
    const pk: ColumnMetadata | undefined = schema?.primaryKey;
    expect(schema?.tableName).toBe("orders");
    expect(pk?.name).toBe("id");

    // SQLite
    const sqliteDdl = generateCreateTableSql(Order, "sqlite");
    expect(sqliteDdl.tableSql).toContain('CREATE TABLE IF NOT EXISTS "orders"');
    expect(sqliteDdl.tableSql).toContain('"id" INTEGER PRIMARY KEY AUTOINCREMENT');
    expect(sqliteDdl.tableSql).toContain('"paid" INTEGER NOT NULL DEFAULT 0');
    expect(sqliteDdl.tableSql).toContain('"line_items" TEXT');
    expect(sqliteDdl.tableSql).toContain('"receipt_pdf" BLOB');
    expect(sqliteDdl.tableSql).toContain('"correlation_id" TEXT');
    expect(sqliteDdl.tableSql).toContain('"created_at" TEXT NOT NULL');
    expect(sqliteDdl.indexSqls).toEqual([
      'CREATE UNIQUE INDEX IF NOT EXISTS "uq_orders_reference_code" ON "orders" ("reference_code")',
      'CREATE INDEX IF NOT EXISTS "idx_orders_customer_id_status" ON "orders" ("customer_id", "status")',
    ]);

    // PostgreSQL
    const pgDdl = generateCreateTableSql(Order, "postgres");
    expect(pgDdl.tableSql).toContain('"id" SERIAL PRIMARY KEY');
    expect(pgDdl.tableSql).toContain('"customer_id" BIGINT NOT NULL');
    expect(pgDdl.tableSql).toContain('"total_amount" DOUBLE PRECISION NOT NULL DEFAULT 0');
    expect(pgDdl.tableSql).toContain('"paid" BOOLEAN NOT NULL DEFAULT FALSE');
    expect(pgDdl.tableSql).toContain('"line_items" JSONB');
    expect(pgDdl.tableSql).toContain('"receipt_pdf" BYTEA');
    expect(pgDdl.tableSql).toContain('"correlation_id" UUID');
    expect(pgDdl.tableSql).toContain('"created_at" TIMESTAMPTZ NOT NULL');

    // MySQL
    const mysqlDdl = generateCreateTableSql(Order, "mysql");
    expect(mysqlDdl.tableSql).toContain("CREATE TABLE IF NOT EXISTS `orders`");
    expect(mysqlDdl.tableSql).toContain("`id` INT AUTO_INCREMENT PRIMARY KEY");
    expect(mysqlDdl.tableSql).toContain("`paid` TINYINT(1) NOT NULL DEFAULT FALSE");
    expect(mysqlDdl.tableSql).toContain("`line_items` JSON");
    expect(mysqlDdl.tableSql).toContain("`receipt_pdf` LONGBLOB");
    expect(mysqlDdl.tableSql).toContain("`correlation_id` CHAR(36)");
    expect(mysqlDdl.tableSql).toContain("`created_at` DATETIME NOT NULL");
    expect(mysqlDdl.indexSqls[1]).toBe(
      "CREATE INDEX IF NOT EXISTS `idx_orders_customer_id_status` ON `orders` (`customer_id`, `status`)",
    );

    // Bigint auto-increment on postgres/mysql & composite PK
    @Entity("audit_entries")
    class BigIdEntry {
      @PrimaryGeneratedColumn({ type: "bigint" })
      id!: bigint;

      @Column()
      message!: string;
    }
    expect(generateCreateTableSql(BigIdEntry, "postgres").tableSql).toContain(
      '"id" BIGSERIAL PRIMARY KEY',
    );
    expect(generateCreateTableSql(BigIdEntry, "mysql").tableSql).toContain(
      "`id` BIGINT AUTO_INCREMENT PRIMARY KEY",
    );

    @Entity("role_grants")
    class RoleGrant {
      @PrimaryKey()
      userId!: number;

      @PrimaryKey()
      roleKey!: string;
    }
    expect(generateCreateTableSql(RoleGrant, "postgres").tableSql).toContain(
      'PRIMARY KEY ("user_id", "role_key")',
    );

    // Rejects SQL injection in identifiers
    @Entity("orders; DROP TABLE users")
    class BadEntity {
      @PrimaryGeneratedColumn()
      id!: number;
    }
    expect(() => generateCreateTableSql(BadEntity, "postgres")).toThrow(
      /Invalid table name/,
    );
  });

  it("auto-registers @SqlRepository and auto-syncs tables & indexes with ZERO forFeature and ZERO manual CREATE TABLE SQL", async () => {
    DecoratorRegistry.clear("sql-repository");
    DecoratorRegistry.clear("entity");

    @Entity("profiles")
    @Index(["orgSlug", "enabled"])
    class Profile {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ name: "email_addr", unique: true })
      emailAddress!: string;

      @Column()
      displayName!: string;

      @Column({ default: "acme" })
      orgSlug!: string;

      @Column({ default: true })
      enabled!: boolean;

      @Column({ type: "json", nullable: true })
      settings!: { theme: string; flags: string[] } | null;

      @Column({
        type: "text",
        nullable: true,
        transformer: {
          to: (val: string) => `enc:${val.toUpperCase()}`,
          from: (val: string) => val.replace(/^enc:/, "").toLowerCase(),
        },
      })
      secretCode!: string | null;

      @Column({ type: "datetime", nullable: true })
      verifiedAt!: Date | null;

      @CreateDateColumn()
      createdAt!: Date;

      @UpdateDateColumn()
      updatedAt!: Date;
    }

    @Entity("tokens")
    class ApiToken {
      @PrimaryGeneratedColumn("uuid")
      id!: string;

      @Column()
      label!: string;
    }

    @SqlRepository(Profile)
    abstract class ProfileRepository extends SqlCrudRepository<Profile, number> {
      abstract findByEmailAddress(email: string): Promise<Profile | null>;
      abstract findAllByEnabled(enabled: boolean): Promise<Profile[]>;
      abstract findAllByCreatedAtGreaterThan(since: Date): Promise<Profile[]>;

      @SqlQuery("SELECT * FROM profiles WHERE email_addr = :email", { single: true })
      findCustomProfile(
        @SqlParam("email") _email: string,
      ): Promise<Profile | null> {
        return null as unknown as Promise<Profile | null>;
      }
    }

    @SqlRepository(ApiToken)
    abstract class ApiTokenRepository extends SqlCrudRepository<ApiToken, string> {}

    @Injectable()
    class ProfileFacade {
      constructor(
        public readonly profiles: ProfileRepository,
        @InjectSqlRepository(ProfileRepository)
        public readonly profilesByToken: ProfileRepository,
        public readonly tokens: ApiTokenRepository,
      ) {}
    }

    const mod = await Test.createTestingModule({
      imports: [
        SqlModule.forRoot({
          url: "sqlite://:memory:",
          autoSync: true,
          autoRegisterRepositories: true,
        }),
      ],
      providers: [ProfileFacade],
    }).compile();

    await mod.init();
    try {
      const sql = mod.get(SqlService);
      const facade = mod.get(ProfileFacade);
      const repo = facade.profiles;

      expect(repo).toBe(facade.profilesByToken);
      expect(repo).toBeInstanceOf(ProfileRepository);
      expect(repo).toBeInstanceOf(SqlCrudRepository);

      // Verify tables & indexes exist on the SQLite Bun.SQL instance
      const tblRows = (
        await sql.query<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table'",
        )
      ).rows.map((r) => r.name);
      expect(tblRows).toContain("profiles");
      expect(tblRows).toContain("tokens");

      const idxRows = (
        await sql.query<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'profiles'",
        )
      ).rows.map((r) => r.name);
      expect(idxRows).toContain("idx_profiles_org_slug_enabled");

      const verifiedDate = new Date("2026-07-04T09:15:00.000Z");
      const saved = await repo.save({
        emailAddress: "grace@bunest.dev",
        displayName: "Grace Hopper",
        orgSlug: "navy",
        enabled: true,
        settings: { theme: "dark", flags: ["beta", "sql"] },
        secretCode: "cobol",
        verifiedAt: verifiedDate,
      });

      expect(saved).toBeInstanceOf(Profile);
      expect(saved.id).toBe(1);
      expect(saved.emailAddress).toBe("grace@bunest.dev");
      expect(saved.enabled).toBe(true);
      expect(typeof saved.enabled).toBe("boolean");
      expect(saved.settings).toEqual({ theme: "dark", flags: ["beta", "sql"] });
      expect(saved.secretCode).toBe("cobol");
      expect(saved.verifiedAt).toBeInstanceOf(Date);
      expect(saved.verifiedAt?.toISOString()).toBe(verifiedDate.toISOString());
      expect(saved.createdAt).toBeInstanceOf(Date);
      expect(saved.updatedAt).toBeInstanceOf(Date);

      // Verify raw persisted column values
      const raw = await sql.queryOne<Record<string, unknown>>(
        "SELECT email_addr, enabled, settings, secret_code FROM profiles WHERE id = ?",
        [saved.id],
      );
      expect(raw?.email_addr).toBe("grace@bunest.dev");
      expect(raw?.enabled).toBe(1);
      expect(raw?.settings).toBe('{"theme":"dark","flags":["beta","sql"]}');
      expect(raw?.secret_code).toBe("enc:COBOL");

      // Second profile with false boolean & nulls
      const disabled = await repo.save({
        emailAddress: "linus@bunest.dev",
        displayName: "Linus",
        enabled: false,
        settings: null,
        secretCode: null,
        verifiedAt: null,
      });
      expect(disabled.enabled).toBe(false);
      expect(disabled.settings).toBeNull();
      expect(disabled.secretCode).toBeNull();
      expect(disabled.verifiedAt).toBeNull();

      // Partial update preserves createdAt and bumps updatedAt
      await Bun.sleep(15);
      const updated = await repo.save({ id: saved.id, displayName: "Admiral Grace" });
      expect(updated.createdAt.toISOString()).toBe(saved.createdAt.toISOString());
      expect(updated.updatedAt.getTime()).toBeGreaterThan(
        saved.updatedAt.getTime(),
      );
      expect(updated.secretCode).toBe("cobol");

      // Derived queries with custom column name, boolean, and Date args
      expect((await repo.findByEmailAddress("grace@bunest.dev"))?.id).toBe(
        saved.id,
      );
      expect(
        (await repo.findAllByEnabled(true)).map((p) => p.emailAddress),
      ).toEqual(["grace@bunest.dev"]);
      expect(
        (await repo.findAllByEnabled(false)).map((p) => p.emailAddress),
      ).toEqual(["linus@bunest.dev"]);
      expect(
        await repo.findAllByCreatedAtGreaterThan(new Date(Date.now() - 60_000)),
      ).toHaveLength(2);

      // Custom @SqlQuery hydrates automatically
      const custom = await repo.findCustomProfile("grace@bunest.dev");
      expect(custom?.enabled).toBe(true);
      expect(custom?.settings).toEqual({ theme: "dark", flags: ["beta", "sql"] });
      expect(custom?.secretCode).toBe("cobol");

      // UUID PK auto-generation
      const tok = await facade.tokens.save({ label: "ci-runner" });
      expect(tok.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      expect((await facade.tokens.findById(tok.id))?.label).toBe("ci-runner");
    } finally {
      await mod.close();
    }
  });

  it("supports SqlModule.forRootAsync({ autoSync, autoRegisterRepositories }) and Postgres dialect boolean/timestamp serialization", async () => {
    DecoratorRegistry.clear("sql-repository");
    DecoratorRegistry.clear("entity");

    @Entity("pg_flags")
    class PgFlag {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column()
      name!: string;

      @Column({ default: true })
      active!: boolean;

      @CreateDateColumn()
      createdAt!: Date;
    }

    @SqlRepository(PgFlag)
    abstract class PgFlagRepository extends SqlCrudRepository<PgFlag, number> {
      abstract findAllByActive(active: boolean): Promise<PgFlag[]>;
    }

    // 1. Live SQLite via forRootAsync
    const asyncMod = await Test.createTestingModule({
      imports: [
        SqlModule.forRootAsync({
          autoRegisterRepositories: true,
          autoSync: true,
          useFactory: async () => ({
            url: "sqlite://:memory:",
          }),
        }),
      ],
    }).compile();

    await asyncMod.init();
    try {
      const repo = asyncMod.get(PgFlagRepository);
      const saved = await repo.save({ name: "dark_mode", active: true });
      expect(saved.active).toBe(true);
      expect(saved.createdAt).toBeInstanceOf(Date);
      expect(await repo.findAllByActive(true)).toHaveLength(1);
    } finally {
      await asyncMod.close();
    }

    // 1b. Explicit forFeature([PgFlagRepository]) with forRoot({ autoSync: true }) (no autoRegisterRepositories)
    const featureMod = await Test.createTestingModule({
      imports: [
        SqlModule.forRoot({
          url: "sqlite://:memory:",
          autoSync: true,
        }),
        SqlModule.forFeature([PgFlagRepository]),
      ],
    }).compile();

    await featureMod.init();
    try {
      const repo = featureMod.get(PgFlagRepository);
      const saved = await repo.save({ name: "feature_flag", active: false });
      expect(saved.id).toBe(1);
      expect(saved.active).toBe(false);
      expect(saved.createdAt).toBeInstanceOf(Date);
    } finally {
      await featureMod.close();
    }

    // 2. Mock PostgreSQL client verifying SERIAL DDL + native boolean params!
    const recorded: Array<{ sql: string; params: unknown }> = [];
    const mockPgClient = {
      options: { adapter: "postgres" },
      unsafe: (query: string, params?: unknown) => {
        recorded.push({ sql: query, params });
        if (query.startsWith("INSERT")) {
          const rows: any = [
            {
              id: 1,
              name: "beta",
              active: true,
              created_at: new Date().toISOString(),
            },
          ];
          rows.count = 1;
          return Promise.resolve(rows);
        }
        const empty: any = [];
        empty.count = 0;
        return Promise.resolve(empty);
      },
      close: async () => {},
    } as unknown as Bun.SQL;

    const pgMod = await Test.createTestingModule({
      imports: [
        SqlModule.forRoot({
          client: mockPgClient,
          autoSync: true,
          autoRegisterRepositories: true,
        }),
      ],
    }).compile();

    await pgMod.init();
    try {
      const repo = pgMod.get(PgFlagRepository);
      await repo.save({ name: "beta", active: true });
      await repo.findAllByActive(true);

      expect(recorded[0]!.sql).toContain('"id" SERIAL PRIMARY KEY');
      expect(recorded[0]!.sql).toContain('"active" BOOLEAN NOT NULL DEFAULT TRUE');
      // Postgres receives native boolean `true` (not 1)
      expect((recorded[1]!.params as unknown[])[1]).toBe(true);
      expect((recorded[2]!.params as unknown[])[0]).toBe(true);
    } finally {
      await pgMod.close();
    }
  });

  it("preserves method metadata and weaves @Transactional() + custom MethodAspects on CRUD, @SqlQuery, concrete, and derived methods", async () => {
    DecoratorRegistry.clear("sql-repository");
    DecoratorRegistry.clear("entity");

    const traces: Array<{ span: string; method: string; inTx: boolean }> = [];
    const QUERY_TAG_KEY = Symbol("test:sql_query_tag");

    @Injectable()
    class SqlSpanAspect implements MethodAspectHandler<string | undefined> {
      constructor(private readonly sql: SqlService) {}

      async intercept(ctx: MethodAspectContext<string | undefined>) {
        const span = ctx.options ?? `${ctx.targetClass.name}.${String(ctx.methodName)}`;
        const res = await ctx.proceed();
        traces.push({
          span,
          method: String(ctx.methodName),
          inTx: this.sql.isInTransaction(),
        });
        return res;
      }
    }

    const Traced = (span?: string) =>
      createMethodAspectDecorator(SqlSpanAspect, span);

    @Entity("staff")
    class Staff {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ unique: true })
      email!: string;

      @Column()
      name!: string;

      @Column({ default: true })
      active!: boolean;
    }

    @Traced("staff-repo")
    @SqlRepository(Staff)
    abstract class StaffRepository extends SqlCrudRepository<Staff, number> {
      abstract findByEmail(email: string): Promise<Staff | null>;

      @Transactional()
      @Traced("sql-query-deactivate")
      @SetMetadata(QUERY_TAG_KEY, "sensitive-write")
      @Modifying()
      @Query("UPDATE staff SET active = 0 WHERE email = :email")
      deactivateByEmail(@SqlParam("email") _email: string): Promise<number> {
        return 0 as unknown as Promise<number>;
      }

      @Transactional()
      @Traced("concrete-batch")
      async hirePair(
        firstEmail: string,
        secondEmail: string,
        failSecond: boolean,
      ): Promise<void> {
        await this.save({ email: firstEmail, name: "One", active: true });
        if (failSecond) {
          throw new Error("sql-repo-tx-abort");
        }
        await this.save({ email: secondEmail, name: "Two", active: true });
      }
    }

    // Method-level aspects on CRUD `save` and derived `findByEmail`
    Transactional()(StaffRepository.prototype, "save", undefined as any);
    Traced("derived-find-email")(
      StaffRepository.prototype,
      "findByEmail",
      undefined as any,
    );

    const mod = await Test.createTestingModule({
      imports: [
        SqlModule.forRoot({
          url: "sqlite://:memory:",
          autoSync: true,
          autoRegisterRepositories: true,
        }),
      ],
      providers: [SqlSpanAspect],
    }).compile();

    await mod.init();
    try {
      const repo = mod.get(StaffRepository);

      // 1. Metadata copied from prototype stub onto bound @Query function (and preserved across weaving)
      expect(
        MetadataRegistry.getOwn(QUERY_TAG_KEY, repo.deactivateByEmail),
      ).toBe("sensitive-write");

      // 2. CRUD `save()` woven with class-level @Traced + method-level @Transactional
      const saved = await repo.save({
        email: "alan@aop.dev",
        name: "Alan",
        active: true,
      });
      expect(saved.id).toBe(1);
      expect(
        traces.some((t) => t.method === "save" && t.span === "staff-repo"),
      ).toBe(true);

      // 3. Derived `findByEmail()` woven with method-level + class-level @Traced
      traces.length = 0;
      const found = await repo.findByEmail("alan@aop.dev");
      expect(found?.name).toBe("Alan");
      expect(traces.map((t) => t.span)).toEqual([
        "derived-find-email",
        "staff-repo",
      ]);

      // 4. @Query + @Modifying woven with @Transactional + @Traced
      traces.length = 0;
      const changed = await repo.deactivateByEmail("alan@aop.dev");
      expect(changed).toBe(1);
      expect((await repo.findById(saved.id))?.active).toBe(false);
      const queryTrace = traces.find((t) => t.span === "sql-query-deactivate");
      expect(queryTrace).toBeDefined();
      expect(queryTrace?.inTx).toBe(true);

      // 5. Concrete method with @Transactional rolls back atomically on throw
      await expect(
        repo.hirePair("h1@aop.dev", "h2@aop.dev", true),
      ).rejects.toThrow("sql-repo-tx-abort");
      expect(await repo.findByEmail("h1@aop.dev")).toBeNull();

      await repo.hirePair("h1@aop.dev", "h2@aop.dev", false);
      expect(await repo.findByEmail("h1@aop.dev")).not.toBeNull();
      expect(await repo.findByEmail("h2@aop.dev")).not.toBeNull();
    } finally {
      await mod.close();
    }
  });
});
