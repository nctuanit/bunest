import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  DecoratorRegistry,
  Injectable,
  MetadataRegistry,
  Module,
  SetMetadata,
  createMethodAspectDecorator,
  type DecoratorRegistrySnapshot,
  type MethodAspectContext,
  type MethodAspectHandler,
} from "@bunest/core";
import { Test } from "@bunest/testing";
import {
  Column,
  CreateDateColumn,
  CrudRepository,
  DataSource,
  DeclarativeRepository,
  Entity,
  EntityNotFoundError,
  InjectOrmMigrations,
  InjectRepository,
  Modifying,
  OrmMigrationRunner,
  OrmModule,
  OrmRepository,
  Param,
  PrimaryGeneratedColumn,
  Query,
  Repository,
  SqlParam,
  Transactional,
  UpdateDateColumn,
  compileOrmRepository,
  getEntitySchema,
  getOrmMigrationRunnerToken,
  hasEntitySchema,
  splitSqlStatements,
  type OrmDialect,
  type OrmDriverLike,
  type OrmMigration,
  type OrmQueryResult,
} from "../src/index";
import {
  isNotATransactionError,
  runStoreCli,
  toBool,
  toInt,
  toJson,
  toText,
  type SqlExecutor,
  type SqlTransaction,
  type StoreCliIo,
} from "@bunest/orm/store";
import {
  SqlParams as PgSqlParams,
  StoreSchema as PgStoreSchema,
  advisoryLock as pgAdvisoryLock,
  assertReadCommittedTransaction,
  columns as pgColumns,
  fromBunSql as pgFromBunSql,
  quoteSchema as pgQuoteSchema,
} from "@bunest/orm/postgres";
import {
  SqlParams as MySqlParams,
  StoreSchema as MySqlStoreSchema,
  columns as mysqlColumns,
  ensureLockRows,
  fromBunSql as mysqlFromBunSql,
  keyColumn,
  lockKeys,
  lockRowId,
  mysqlErrorCode,
  quoteIdentifier as mysqlQuoteIdentifier,
  quoteTable as mysqlQuoteTable,
  retryOnDeadlock,
} from "@bunest/orm/mysql";
import { sqlExecutorContract } from "@bunest/orm/testing";

function createRecordingDriver(dialect: OrmDialect): {
  driver: OrmDriverLike;
  calls: Array<{ method: "query" | "execute"; sql: string; params: readonly unknown[] }>;
} {
  const calls: Array<{
    method: "query" | "execute";
    sql: string;
    params: readonly unknown[];
  }> = [];

  const driver: OrmDriverLike = {
    dialect,
    isConnected: true,
    connect: async () => {},
    close: async () => {},
    isInTransaction: () => false,
    transaction: async (run) => run(driver),
    query: async <T = Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<OrmQueryResult<T>> => {
      calls.push({ method: "query", sql, params });
      if (/^SELECT COUNT/i.test(sql)) {
        return { rows: [{ count: 3 } as T], affectedRows: 1 };
      }
      if (/^SELECT 1 AS found/i.test(sql)) {
        return { rows: [{ found: 1 } as T], affectedRows: 1 };
      }
      return {
        rows: [{ id: 7, email: "x@test.dev", full_name: "X" } as T],
        affectedRows: 1,
        lastInsertRowid: 7,
      };
    },
    execute: async (
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<OrmQueryResult> => {
      calls.push({ method: "execute", sql, params });
      return { rows: [], affectedRows: 2, lastInsertRowid: 7 };
    },
  };

  return { driver, calls };
}

describe("@bunest/orm — Declarative Compiled-Once Repository Engine", () => {
  let registrySnapshot: DecoratorRegistrySnapshot;

  beforeEach(() => {
    registrySnapshot = DecoratorRegistry.snapshot();
  });

  afterEach(() => {
    DecoratorRegistry.restore(registrySnapshot);
  });

  it("supports full CRUD, derived finders, @Query/@Modifying/@SqlParam/@Param, and strict identifier validation", async () => {
    @Entity("decl_users")
    class DeclUser {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ name: "email_addr", unique: true, minLength: 3, description: "User email" })
      email!: string;

      @Column({ example: "Ada Lovelace" })
      displayName!: string;

      @Column("integer")
      age!: number;

      @Column({ type: "boolean", default: true })
      active!: boolean;

      @Column({ type: "text", nullable: true })
      bio!: string | null;

      @Column({ type: "json", nullable: true })
      tags!: string[] | null;

      @Column({
        type: "integer",
        nullable: true,
        transformer: {
          to: (v: number) => Math.round(v * 100),
          from: (v: number) => v / 100,
        },
      })
      balance!: number | null;

      @CreateDateColumn()
      createdAt!: Date;

      @UpdateDateColumn()
      updatedAt!: Date;
    }

    // Verify unified @bunest/common metadata mirroring (for Swagger & ValidationPipe)
    expect(hasEntitySchema(DeclUser)).toBe(true);
    const schema = getEntitySchema(DeclUser);
    expect(schema?.tableName).toBe("decl_users");
    const emailCol = schema?.columns.find((c) => c.propertyName === "email");
    expect(emailCol?.minLength).toBe(3);
    expect(emailCol?.description).toBe("User email");

    @OrmRepository(DeclUser)
    abstract class DeclUserRepository extends CrudRepository<DeclUser, number> {
      abstract findByEmail(email: string): Promise<DeclUser | null>;
      abstract findOneByEmailIgnoreCase(email: string): Promise<DeclUser | null>;
      abstract findFirstByActiveOrderByAgeDesc(active: boolean): Promise<DeclUser | null>;
      abstract findFirst2ByActiveOrderByAgeAsc(active: boolean): Promise<DeclUser[]>;
      abstract findTop2ByAgeGreaterThanEqualOrderByAgeDesc(minAge: number): Promise<DeclUser[]>;
      abstract findAllByActiveAndAgeBetween(active: boolean, min: number, max: number): Promise<DeclUser[]>;
      abstract findAllByDisplayNameContainingIgnoreCase(part: string): Promise<DeclUser[]>;
      abstract findAllByEmailStartsWith(prefix: string): Promise<DeclUser[]>;
      abstract findAllByEmailEndsWith(suffix: string): Promise<DeclUser[]>;
      abstract findAllByAgeGreaterThanOrAgeLessThan(high: number, low: number): Promise<DeclUser[]>;
      abstract findAllByAgeLessThanEqual(maxAge: number): Promise<DeclUser[]>;
      abstract findAllByEmailIn(emails: string[]): Promise<DeclUser[]>;
      abstract findAllByEmailNotIn(emails: string[]): Promise<DeclUser[]>;
      abstract findAllByBioIsNull(): Promise<DeclUser[]>;
      abstract findAllByBioIsNotNull(): Promise<DeclUser[]>;
      abstract findAllOrderByAgeDescDisplayNameAsc(): Promise<DeclUser[]>;
      abstract existsByEmail(email: string): Promise<boolean>;
      abstract countByActive(active: boolean): Promise<number>;
      abstract deleteByActive(active: boolean): Promise<number>;
      abstract removeByEmail(email: string): Promise<number>;

      @Query(
        "SELECT * FROM decl_users WHERE age >= :minAge AND display_name != ':ignored' -- :comment\n ORDER BY age ASC",
      )
      findAdults(@SqlParam("minAge") _minAge: number): Promise<DeclUser[]> {
        return [] as unknown as Promise<DeclUser[]>;
      }

      @Query("SELECT * FROM decl_users WHERE email_addr = :email", { single: true })
      findByEmailParamAlias(@Param("email") _email: string): Promise<DeclUser | null> {
        return null as unknown as Promise<DeclUser | null>;
      }

      @Query("SELECT * FROM decl_users WHERE age >= :minAge AND active = :active")
      findAllByParamsObject(_params: { minAge: number; active: number }): Promise<DeclUser[]> {
        return [] as unknown as Promise<DeclUser[]>;
      }

      @Modifying()
      @Query("UPDATE decl_users SET bio = :bio WHERE id = :id")
      updateBio(
        @SqlParam("id") _id: number,
        @SqlParam("bio") _bio: string,
      ): Promise<number> {
        return 0 as unknown as Promise<number>;
      }

      @Modifying({ returnType: "void" })
      @Query("UPDATE decl_users SET active = 0 WHERE id = :id")
      deactivate(@SqlParam("id") _id: number): Promise<void> {
        return undefined as unknown as Promise<void>;
      }

      @Query("SELECT COUNT(*) AS total FROM decl_users WHERE active = :active")
      countActiveCustom(@SqlParam("active") _active: number): Promise<number> {
        return 0 as unknown as Promise<number>;
      }
    }

    const ds = new DataSource({
      type: "sqlite",
      database: ":memory:",
      entities: [DeclUser],
      synchronize: true,
    });
    await ds.initialize();

    try {
      const repo = ds.getDeclarativeRepository(DeclUserRepository);
      expect(repo).toBeInstanceOf(DeclUserRepository);
      expect(repo).toBeInstanceOf(CrudRepository);

      // saveMany (atomic batch)
      const [ada, grace, alan, linus] = await repo.saveMany([
        {
          email: "ada@bunest.dev",
          displayName: "Ada Lovelace",
          age: 36,
          active: true,
          bio: "First programmer",
          tags: ["math", "engine"],
          balance: 120.5,
        },
        {
          email: "grace@bunest.dev",
          displayName: "Grace Hopper",
          age: 85,
          active: true,
          bio: null,
          tags: ["compiler"],
          balance: 250.25,
        },
        {
          email: "alan@example.org",
          displayName: "Alan Turing",
          age: 41,
          active: true,
          bio: "100% logic_master",
          tags: null,
          balance: null,
        },
        {
          email: "linus@kernel.org",
          displayName: "Linus Torvalds",
          age: 54,
          active: false,
          bio: null,
          tags: ["git"],
          balance: 10,
        },
      ]);

      expect(ada).toBeInstanceOf(DeclUser);
      expect(ada!.id).toBe(1);
      expect(ada!.active).toBe(true);
      expect(ada!.tags).toEqual(["math", "engine"]);
      expect(ada!.balance).toBe(120.5);
      expect(ada!.createdAt).toBeInstanceOf(Date);
      expect(ada!.updatedAt).toBeInstanceOf(Date);
      expect(grace!.bio).toBeNull();
      expect(linus!.active).toBe(false);

      // Base CRUD
      expect(await repo.count()).toBe(4);
      expect(await repo.existsById(ada!.id)).toBe(true);
      expect(await repo.existsById(999)).toBe(false);
      expect((await repo.findById(ada!.id))?.email).toBe("ada@bunest.dev");
      expect(await repo.findById(999)).toBeNull();
      expect((await repo.findByIdOrFail(ada!.id)).displayName).toBe("Ada Lovelace");
      await expect(repo.findByIdOrFail(999)).rejects.toThrow(EntityNotFoundError);
      expect(await repo.findAll()).toHaveLength(4);
      expect(await repo.saveMany([])).toEqual([]);

      // Partial save update preserves createdAt and refreshes updatedAt
      await Bun.sleep(10);
      const updatedAda = await repo.save({ id: ada!.id, balance: 200.75 });
      expect(updatedAda.balance).toBe(200.75);
      expect(updatedAda.displayName).toBe("Ada Lovelace");
      expect(updatedAda.createdAt.toISOString()).toBe(ada!.createdAt.toISOString());
      expect(updatedAda.updatedAt.getTime()).toBeGreaterThan(ada!.updatedAt.getTime());

      // Derived queries
      expect((await repo.findByEmail("ada@bunest.dev"))?.id).toBe(ada!.id);
      expect((await repo.findOneByEmailIgnoreCase("ADA@BUNEST.DEV"))?.id).toBe(ada!.id);
      expect((await repo.findFirstByActiveOrderByAgeDesc(true))?.email).toBe("grace@bunest.dev");
      expect((await repo.findFirst2ByActiveOrderByAgeAsc(true)).map((u) => u.email)).toEqual([
        "ada@bunest.dev",
        "alan@example.org",
      ]);
      expect((await repo.findTop2ByAgeGreaterThanEqualOrderByAgeDesc(40)).map((u) => u.email)).toEqual([
        "grace@bunest.dev",
        "linus@kernel.org",
      ]);
      expect((await repo.findAllByActiveAndAgeBetween(true, 35, 45)).map((u) => u.email).sort()).toEqual([
        "ada@bunest.dev",
        "alan@example.org",
      ]);
      expect((await repo.findAllByDisplayNameContainingIgnoreCase("hopper")).map((u) => u.email)).toEqual([
        "grace@bunest.dev",
      ]);
      // Escaped LIKE pattern check (% and _ in bio)
      expect((await repo.findAllByEmailStartsWith("a")).map((u) => u.email).sort()).toEqual([
        "ada@bunest.dev",
        "alan@example.org",
      ]);
      expect((await repo.findAllByEmailEndsWith("@bunest.dev")).map((u) => u.email).sort()).toEqual([
        "ada@bunest.dev",
        "grace@bunest.dev",
      ]);
      expect((await repo.findAllByAgeGreaterThanOrAgeLessThan(80, 38)).map((u) => u.email).sort()).toEqual([
        "ada@bunest.dev",
        "grace@bunest.dev",
      ]);
      expect((await repo.findAllByAgeLessThanEqual(41)).map((u) => u.email).sort()).toEqual([
        "ada@bunest.dev",
        "alan@example.org",
      ]);
      expect((await repo.findAllByEmailIn(["ada@bunest.dev", "linus@kernel.org"])).map((u) => u.email).sort()).toEqual([
        "ada@bunest.dev",
        "linus@kernel.org",
      ]);
      expect(await repo.findAllByEmailIn([])).toEqual([]);
      expect(await repo.findAllByEmailNotIn([])).toHaveLength(4);
      expect((await repo.findAllByEmailNotIn(["ada@bunest.dev", "grace@bunest.dev"])).map((u) => u.email).sort()).toEqual([
        "alan@example.org",
        "linus@kernel.org",
      ]);
      expect((await repo.findAllByBioIsNull()).map((u) => u.email).sort()).toEqual([
        "grace@bunest.dev",
        "linus@kernel.org",
      ]);
      expect((await repo.findAllByBioIsNotNull()).map((u) => u.email).sort()).toEqual([
        "ada@bunest.dev",
        "alan@example.org",
      ]);
      expect((await repo.findAllOrderByAgeDescDisplayNameAsc()).map((u) => u.age)).toEqual([
        85, 54, 41, 36,
      ]);
      expect(await repo.existsByEmail("alan@example.org")).toBe(true);
      expect(await repo.existsByEmail("missing@example.org")).toBe(false);
      expect(await repo.countByActive(true)).toBe(3);

      // @Query, @Param, parameter object, @Modifying
      expect((await repo.findAdults(41)).map((u) => u.email)).toEqual([
        "alan@example.org",
        "linus@kernel.org",
        "grace@bunest.dev",
      ]);
      expect((await repo.findByEmailParamAlias("grace@bunest.dev"))?.displayName).toBe(
        "Grace Hopper",
      );
      expect(await repo.findAllByParamsObject({ minAge: 40, active: 1 })).toHaveLength(2);
      expect(await repo.updateBio(grace!.id, "COBOL pioneer")).toBe(1);
      expect((await repo.findById(grace!.id))?.bio).toBe("COBOL pioneer");
      expect(await repo.deactivate(alan!.id)).toBeUndefined();
      expect((await repo.findById(alan!.id))?.active).toBe(false);
      expect(await repo.countActiveCustom(1)).toBe(2);

      // deleteBy*, removeBy*, deleteById
      expect(await repo.removeByEmail("linus@kernel.org")).toBe(1);
      expect(await repo.deleteByActive(false)).toBe(1);
      await repo.deleteById(grace!.id);
      expect(await repo.count()).toBe(1);
    } finally {
      await ds.destroy();
    }

    // Strict SQL identifier validation
    expect(() => OrmRepository("users; DROP TABLE x")).toThrow(/Invalid table name/);
    expect(() =>
      OrmRepository({ table: "ok", idColumn: "id; --" }),
    ).toThrow(/Invalid id column name/);
    expect(() =>
      OrmRepository({ table: "ok", columns: { x: "bad col" } }),
    ).toThrow(/Invalid column mapping/);
    expect(() => SqlParam("1bad")).toThrow(/Invalid @SqlParam/);
  });

  it("compiles dialect-accurate SQL across postgres, mysql, mariadb, and mssql drivers", async () => {
    interface AccountRow {
      id: number;
      email: string;
      fullName: string;
    }

    @DeclarativeRepository({ table: "accounts" })
    abstract class MultiDialectAccountRepo extends CrudRepository<AccountRow, number> {
      abstract findByEmailIgnoreCase(email: string): Promise<AccountRow | null>;

      @Query("SELECT * FROM accounts WHERE email = :email AND full_name = :name", {
        single: true,
      })
      findCustom(
        @SqlParam("email") _email: string,
        @SqlParam("name") _name: string,
      ): Promise<AccountRow | null> {
        return null as unknown as Promise<AccountRow | null>;
      }
    }

    const factory = compileOrmRepository(MultiDialectAccountRepo);

    // PostgreSQL ($1, "ident", RETURNING *)
    const pg = createRecordingDriver("postgres");
    const pgRepo = factory.createInstance({ driver: pg.driver, dialect: "postgres" });
    await pgRepo.findByEmailIgnoreCase("A@B.CO");
    await pgRepo.findCustom("a@b.co", "Ada");
    await pgRepo.save({ email: "new@b.co", fullName: "New" });
    expect(pg.calls[0]!.sql).toBe(
      'SELECT * FROM "accounts" WHERE LOWER("email") = LOWER($1) LIMIT 1',
    );
    expect(pg.calls[1]!.sql).toBe(
      "SELECT * FROM accounts WHERE email = $1 AND full_name = $2",
    );
    expect(pg.calls[2]!.sql).toContain('INSERT INTO "accounts" ("email", "full_name") VALUES ($1, $2) RETURNING *');

    // MySQL (?, `ident`, no RETURNING)
    const my = createRecordingDriver("mysql");
    const myRepo = factory.createInstance({ driver: my.driver, dialect: "mysql" });
    await myRepo.findByEmailIgnoreCase("A@B.CO");
    await myRepo.save({ email: "new@b.co", fullName: "New" });
    expect(my.calls[0]!.sql).toBe(
      "SELECT * FROM `accounts` WHERE LOWER(`email`) = LOWER(?) LIMIT 1",
    );
    expect(my.calls[1]!.sql).toBe(
      "INSERT INTO `accounts` (`email`, `full_name`) VALUES (?, ?)",
    );
    expect(my.calls[2]!.sql).toBe("SELECT * FROM `accounts` WHERE `id` = ? LIMIT 1");

    // MSSQL (@p1, [ident], OUTPUT INSERTED.*, FETCH NEXT)
    const ms = createRecordingDriver("mssql");
    const msRepo = factory.createInstance({ driver: ms.driver, dialect: "mssql" });
    await msRepo.findByEmailIgnoreCase("A@B.CO");
    await msRepo.save({ email: "new@b.co", fullName: "New" });
    expect(ms.calls[0]!.sql).toContain(
      "SELECT * FROM [accounts] WHERE LOWER([email]) = LOWER(@p1)",
    );
    expect(ms.calls[0]!.sql).toContain("FETCH NEXT 1 ROWS ONLY");
    expect(ms.calls[1]!.sql).toContain("OUTPUT INSERTED.*");
  });

  it("integrates with OrmModule.forFeature (mixed entities & repos), autoRegisterRepositories, and Bunest AOP (@Transactional + @Span)", async () => {
    DecoratorRegistry.clear("orm-repository");

    const spans: Array<{ label: string; method: string; inTx: boolean }> = [];
    const CUSTOM_META_KEY = Symbol("test:orm_repo_meta");

    @Injectable()
    class TestSpanAspect implements MethodAspectHandler<string | undefined> {
      constructor(private readonly ds: DataSource) {}

      async intercept(ctx: MethodAspectContext<string | undefined>) {
        const label =
          ctx.options ?? `${ctx.targetClass.name}.${String(ctx.methodName)}`;
        const result = await ctx.proceed();
        spans.push({
          label,
          method: String(ctx.methodName),
          inTx: this.ds.driver.isInTransaction(),
        });
        return result;
      }
    }

    const Span = (label?: string) =>
      createMethodAspectDecorator(TestSpanAspect, label);

    @Entity("orm_di_projects")
    class ProjectEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ unique: true })
      slug!: string;

      @Column({ default: true })
      active!: boolean;
    }

    @Entity("orm_di_notes")
    class NoteEntity {
      @PrimaryGeneratedColumn("uuid")
      id!: string;

      @Column()
      body!: string;
    }

    @Span("project-repo-class")
    @OrmRepository(ProjectEntity)
    abstract class ProjectRepository extends CrudRepository<ProjectEntity, number> {
      abstract findBySlug(slug: string): Promise<ProjectEntity | null>;

      @Transactional()
      @Span("archive-project")
      @SetMetadata(CUSTOM_META_KEY, { audited: true })
      @Modifying()
      @Query("UPDATE orm_di_projects SET active = 0 WHERE slug = :slug")
      archiveBySlug(@SqlParam("slug") _slug: string): Promise<number> {
        return 0 as unknown as Promise<number>;
      }

      @Transactional()
      async createPairOrFail(a: string, b: string, fail: boolean): Promise<void> {
        await this.save({ slug: a, active: true });
        if (fail) throw new Error("pair-rollback");
        await this.save({ slug: b, active: true });
      }
    }

    // Mix entity class (`NoteEntity`) AND declarative repo (`ProjectRepository`) in ONE forFeature()!
    @Injectable()
    class WorkspaceService {
      constructor(
        public readonly projects: ProjectRepository,
        @InjectRepository(ProjectRepository)
        public readonly projectsByToken: ProjectRepository,
        @InjectRepository(NoteEntity)
        public readonly notes: Repository<NoteEntity>,
      ) {}
    }

    @Module({
      imports: [
        OrmModule.forRoot({
          type: "sqlite",
          database: ":memory:",
          synchronize: true,
        }),
        OrmModule.forFeature([NoteEntity, ProjectRepository]),
      ],
      providers: [TestSpanAspect, WorkspaceService],
    })
    class ReusableWorkspaceModule {}

    // Run twice to verify reusable static @Module works even after close() clears feature registry!
    for (let run = 0; run < 2; run++) {
      spans.length = 0;
      const mod = await Test.createTestingModule({
        imports: [ReusableWorkspaceModule],
      }).compile();
      await mod.init();
      try {
        const svc = mod.get(WorkspaceService);
        expect(svc.projects).toBe(svc.projectsByToken);
        expect(svc.projects).toBeInstanceOf(ProjectRepository);
        expect(svc.notes).toBeInstanceOf(Repository);

        // Method metadata preserved through compiled wrapper + AOP weaver
        expect(
          MetadataRegistry.getOwn(CUSTOM_META_KEY, svc.projects.archiveBySlug),
        ).toEqual({ audited: true });

        const p = await svc.projects.save({ slug: "bunest-v2", active: true });
        expect(p.id).toBe(1);
        expect((await svc.projects.findBySlug("bunest-v2"))?.active).toBe(true);
        expect(await svc.projects.archiveBySlug("bunest-v2")).toBe(1);
        expect((await svc.projects.findById(p.id))?.active).toBe(false);
        expect(spans.some((s) => s.label === "archive-project" && s.inTx)).toBe(true);
        expect(spans.some((s) => s.label === "project-repo-class")).toBe(true);

        // Transactional rollback on concrete repo method
        await expect(
          svc.projects.createPairOrFail("p1", "p2", true),
        ).rejects.toThrow("pair-rollback");
        expect(await svc.projects.findBySlug("p1")).toBeNull();

        const note = await svc.notes.save({ body: `run-${run}` });
        expect(note.id).toMatch(/^[0-9a-f-]{36}$/i);
      } finally {
        await mod.close();
      }
    }

    // autoRegisterRepositories: true with ZERO forFeature() in both forRoot and forRootAsync
    const autoMod = await Test.createTestingModule({
      imports: [
        OrmModule.forRootAsync({
          autoRegisterRepositories: true,
          synchronize: true,
          useFactory: async () => ({
            type: "sqlite",
            database: ":memory:",
          }),
        }),
      ],
      providers: [TestSpanAspect],
    }).compile();
    await autoMod.init();
    try {
      const repo = autoMod.get(ProjectRepository);
      const saved = await repo.save({ slug: "auto-registered" });
      expect(saved.id).toBe(1);
      expect((await repo.findBySlug("auto-registered"))?.slug).toBe("auto-registered");
    } finally {
      await autoMod.close();
    }
  });
});

describe("@bunest/orm — OrmMigrationRunner & DI Support", () => {
  it("splits multi-statement SQL scripts safely (quotes, comments, dollar-quoting)", () => {
    const stmts = splitSqlStatements(`
      -- leading comment
      CREATE TABLE a (id INT, note TEXT DEFAULT 'hello; world');
      /* block; comment */
      CREATE FUNCTION f() RETURNS void AS $$ BEGIN PERFORM 1; END; $$ LANGUAGE plpgsql;
      -- trailing comment only
    `);
    expect(stmts).toHaveLength(2);
    expect(stmts[0]).toContain("'hello; world'");
    expect(stmts[1]).toContain("$$ BEGIN PERFORM 1; END; $$");
  });

  it("supports string & callback migrations, status/up/down batches, autoMigrate, and DI injection", async () => {
    const migrations: readonly OrmMigration[] = [
      {
        id: "001_create_accounts",
        name: "create_accounts",
        up: `
          CREATE TABLE mig_accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL
          );
          CREATE INDEX idx_mig_accounts_name ON mig_accounts(name);
        `,
        down: "DROP INDEX idx_mig_accounts_name; DROP TABLE mig_accounts;",
      },
      {
        id: "002_seed_account",
        up: async (runner) => {
          await runner.execute("INSERT INTO mig_accounts (name) VALUES (?)", [
            "system",
          ]);
        },
        down: async (runner) => {
          await runner.execute("DELETE FROM mig_accounts WHERE name = ?", [
            "system",
          ]);
        },
      },
    ];

    @Injectable()
    class MigrationAdminService {
      constructor(
        public readonly defaultRunner: OrmMigrationRunner,
        @InjectOrmMigrations()
        public readonly decoratedDefault: OrmMigrationRunner,
        @InjectOrmMigrations("reporting")
        public readonly reportingRunner: OrmMigrationRunner,
      ) {}
    }

    const mod = await Test.createTestingModule({
      imports: [
        OrmModule.forRoot({
          type: "sqlite",
          database: ":memory:",
          migrations,
          autoMigrate: true,
        }),
        OrmModule.forRootAsync({
          name: "reporting",
          useFactory: () => ({
            type: "sqlite",
            database: ":memory:",
            migrations,
            migrationsTable: "custom_migrations",
          }),
        }),
      ],
      providers: [MigrationAdminService],
    }).compile();

    await mod.init();
    try {
      const admin = mod.get(MigrationAdminService);
      expect(admin.defaultRunner).toBe(admin.decoratedDefault);
      expect(admin.defaultRunner).toBeInstanceOf(OrmMigrationRunner);
      expect(admin.reportingRunner).toBe(
        mod.get(getOrmMigrationRunnerToken("reporting")),
      );

      // Default DS had autoMigrate: true -> both migrations applied
      const defStatus = await admin.defaultRunner.status();
      expect(defStatus.applied.map((m) => m.id)).toEqual([
        "001_create_accounts",
        "002_seed_account",
      ]);
      expect(defStatus.pending).toHaveLength(0);

      // Reporting DS starts unmigrated (read-only safe status() does NOT create table)
      const repBefore = await admin.reportingRunner.status();
      expect(repBefore.applied).toHaveLength(0);
      expect(repBefore.pending).toHaveLength(2);
      expect(admin.reportingRunner.migrationsTableName).toBe("custom_migrations");

      // Stepwise up: batch 1 applies 1 migration, batch 2 applies 2nd
      const b1 = await admin.reportingRunner.up(undefined, { steps: 1 });
      expect(b1.map((m) => [m.id, m.batch])).toEqual([["001_create_accounts", 1]]);
      const b2 = await admin.reportingRunner.up();
      expect(b2.map((m) => [m.id, m.batch])).toEqual([["002_seed_account", 2]]);
      expect(await admin.reportingRunner.up()).toEqual([]); // idempotent

      // Down reverts latest batch (batch 2)
      const rev1 = await admin.reportingRunner.down();
      expect(rev1.map((m) => m.id)).toEqual(["002_seed_account"]);
      expect((await admin.reportingRunner.status()).applied.map((m) => m.id)).toEqual([
        "001_create_accounts",
      ]);

      // Re-apply and revert all
      await admin.reportingRunner.up();
      const revAll = await admin.reportingRunner.down(undefined, { all: true });
      expect(revAll.map((m) => m.id)).toEqual([
        "002_seed_account",
        "001_create_accounts",
      ]);
      expect((await admin.reportingRunner.status()).applied).toHaveLength(0);
    } finally {
      await mod.close();
    }
  });
});

describe("@bunest/orm — Bun-native Store Kit Subpaths (/store, /postgres, /mysql, /testing)", () => {
  it("@bunest/orm/store exposes converters, transaction error guard, and runStoreCli", async () => {
    expect(toText(42)).toBe("42");
    expect(toText(null)).toBeNull();
    expect(toInt("99")).toBe(99);
    expect(toBool("true")).toBe(true);
    expect(toBool(0)).toBe(false);
    expect(toJson('{"k":1}')).toEqual({ k: 1 });
    expect(isNotATransactionError({ code: "ERR_SQL_NOT_A_TRANSACTION" })).toBe(true);
    expect(isNotATransactionError(new Error("other"))).toBe(false);

    const pgSchema = new PgStoreSchema({
      packageName: "@bunest/test-store",
      storeName: "PostgresTestStore",
      command: "test-store",
      defaultSchema: "test_store",
      migrations: [
        {
          version: 1,
          name: "init",
          up: (s) => [`CREATE TABLE ${s}.items (id text PRIMARY KEY)`],
        },
      ],
      createError: (m) => new Error(m),
    });

    let stdout = "";
    const io: StoreCliIo = {
      out: (t) => {
        stdout += t;
      },
      err: () => {},
      env: {},
    };
    const code = await runStoreCli([pgSchema], ["sql"], io);
    expect(code).toBe(0);
    expect(stdout).toContain('CREATE TABLE "test_store".items');
  });

  it("@bunest/orm/postgres & @bunest/orm/mysql expose full API parity with native Bun.SQL executors", async () => {
    // Postgres helpers + Bun.SQL executor
    const pgParams = new PgSqlParams();
    expect(pgParams.text("hello")).toBe("$1::text");
    expect(pgParams.int(5)).toBe("$2::text::integer");
    expect(pgColumns(["id"], "t")).toBe("t.id::text AS id");
    expect(pgQuoteSchema("app_outbox", "Store")).toBe('"app_outbox"');

    const pgTxCalls: string[] = [];
    const pgTx: SqlTransaction = {
      query: async <R extends object>(sql: string) => {
        pgTxCalls.push(sql);
        if (sql.includes("transaction_isolation")) {
          return [{ isolation: "read committed" }] as R[];
        }
        return [];
      },
    };
    await pgAdvisoryLock(pgTx, "job-1");
    await assertReadCommittedTransaction(pgTx, {
      operation: "test",
      reason: "test",
    });
    expect(pgTxCalls[0]).toContain("pg_advisory_xact_lock");

    const bunPgTx = {
      unsafe: async () => Object.assign([{ ok: "1" }], { count: 1 }),
      savepoint: async (fn: any) => fn(bunPgTx),
    };
    const bunPg = pgFromBunSql({
      options: { adapter: "postgres" },
      unsafe: async () => Object.assign([{ ok: "1" }], { count: 1 }),
      begin: async (a: any, b?: any) => (typeof a === "function" ? a(bunPgTx) : b(bunPgTx)),
    });
    expect(bunPg.dialect).toBe("postgres");
    expect(await bunPg.query("SELECT 1")).toEqual([{ ok: "1" }]);

    // MySQL helpers + Bun.SQL executor
    const myParams = new MySqlParams();
    expect(myParams.text("x")).toBe("?");
    expect(myParams.int(3)).toBe("CAST(? AS SIGNED)");
    expect(mysqlColumns(["id"], "m")).toBe("CAST(`m`.`id` AS CHAR) AS `id`");
    expect(mysqlQuoteIdentifier("id")).toBe("`id`");
    expect(mysqlQuoteTable("app_outbox", "items", "Store")).toBe("`app_outbox_items`");
    expect(keyColumn(128)).toBe(
      "varchar(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin",
    );
    expect(lockRowId("k")).toHaveLength(64);
    expect(mysqlErrorCode({ errno: 1213, sqlState: "40001" })).toBe(1213);

    const mySchema = new MySqlStoreSchema({
      packageName: "@bunest/test-store",
      storeName: "MySqlTestStore",
      command: "test-store",
      defaultSchema: "test_store",
      migrations: [
        {
          version: 1,
          name: "init",
          up: (t) => [`CREATE TABLE ${t("items")} (id ${keyColumn(64)} PRIMARY KEY)`],
        },
      ],
      createError: (m) => new Error(m),
    });
    expect(mySchema.latest).toBe(1);

    const bunMyReserved = {
      unsafe: async () => Object.assign([{ m: "ok" }], { affectedRows: 1 }),
      release: () => {},
    };
    const bunMy = mysqlFromBunSql({
      options: { adapter: "mysql" },
      unsafe: async () => Object.assign([{ m: "ok" }], { affectedRows: 1 }),
      reserve: async () => bunMyReserved,
      begin: async (a: any, b?: any) =>
        typeof a === "function" ? a(bunMyReserved) : b(bunMyReserved),
    });
    expect(bunMy.dialect).toBe("mysql");
    expect(await bunMy.query("SELECT ?", [1])).toEqual([{ m: "ok" }]);
    expect(typeof lockKeys).toBe("function");
    expect(typeof ensureLockRows).toBe("function");
    expect(typeof retryOnDeadlock).toBe("function");
  });

  it("@bunest/orm/testing exports sqlExecutorContract()", async () => {
    const cases = sqlExecutorContract(() => ({
      executor: { dialect: "sqlite" } as unknown as SqlExecutor,
      transaction: async (w) => w({}),
      root: {},
    }));
    expect(cases.length).toBeGreaterThan(0);
    await expect(cases[0]!.run()).rejects.toThrow(
      /sqlExecutorContract\(\) covers postgres and mysql executors/,
    );
  });
});
