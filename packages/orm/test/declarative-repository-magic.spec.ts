import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  ClsService,
  DecoratorRegistry,
  Injectable,
  Module,
  RequestContext,
  requestContextStorage,
  type DecoratorRegistrySnapshot,
} from "@bunest/core";
import { Test } from "@bunest/testing";
import {
  Column,
  CrudRepository,
  DataSource,
  DeleteDateColumn,
  Entity,
  EntityNotFoundError,
  IgnoreScope,
  ORM_CUSTOM_QUERY_OPERATORS_SYMBOL,
  OrmModule,
  OrmRepository,
  PrimaryGeneratedColumn,
  Projection,
  RepositoryScope,
  SoftDelete,
  TenantScoped,
  UseRepositoryFragments,
  clearRegisteredQueryOperators,
  compileOrmRepository,
  composeRepository,
  createCursorPageable,
  createPageable,
  defineRepositoryFragment,
  getRegisteredQueryOperator,
  isCursorPageable,
  isPageable,
  listRegisteredQueryOperators,
  registerQueryOperator,
  runWithIgnoredScopes,
  unregisterQueryOperator,
  withCursorPagination,
  withSoftDelete,
  type CursorPage,
  type CursorPageable,
  type CustomQueryOperator,
  type OrmDialect,
  type OrmDriverLike,
  type OrmQueryResult,
  type Page,
  type Pageable,
} from "../src/index";

function createRecordingDriver(
  dialect: OrmDialect,
  rowsProvider?: (sql: string, params: readonly unknown[]) => Record<string, unknown>[],
): {
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
      if (rowsProvider) {
        const rows = rowsProvider(sql, params) as T[];
        return { rows, affectedRows: rows.length };
      }
      if (/^SELECT COUNT/i.test(sql)) {
        return { rows: [{ count: 5 } as T], affectedRows: 1 };
      }
      if (/^SELECT 1 AS found/i.test(sql)) {
        return { rows: [{ found: 1 } as T], affectedRows: 1 };
      }
      return {
        rows: [{ id: 1, email_addr: "ada@bunest.dev", full_name: "Ada" } as T],
        affectedRows: 1,
      };
    },
    execute: async (
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<OrmQueryResult> => {
      calls.push({ method: "execute", sql, params });
      return { rows: [], affectedRows: 1, lastInsertRowid: 1 };
    },
  };

  return { driver, calls };
}

describe("@bunest/orm — Declarative Repository Magic Extensions", () => {
  let registrySnapshot: DecoratorRegistrySnapshot;

  beforeEach(() => {
    registrySnapshot = DecoratorRegistry.snapshot();
    clearRegisteredQueryOperators();
  });

  afterEach(() => {
    clearRegisteredQueryOperators();
    DecoratorRegistry.restore(registrySnapshot);
  });

  // ==========================================================================
  // 1. Custom Derived Query Operators Registry
  // ==========================================================================

  it("registers custom derived query operators in single-realm globalThis registry with longest-suffix matching & multi-dialect SQL", async () => {
    // Registry CRUD & validation
    expect(
      () =>
        registerQueryOperator({
          suffix: "lowercase",
          arity: 1,
          toSql: () => ({ sql: "1=1" }),
        }),
    ).toThrow(/PascalCase/);

    expect(
      () =>
        registerQueryOperator({
          suffix: "BadArity",
          arity: -1,
          toSql: () => ({ sql: "1=1" }),
        }),
    ).toThrow(/non-negative integer/);

    registerQueryOperator({
      suffix: "Matches",
      arity: 1,
      description: "Case-insensitive substring/glob match on text columns",
      toSql: ({ quotedColumn, nextPlaceholder, args, dialect }) => {
        if (dialect === "postgres") {
          return {
            sql: `${quotedColumn} ~* ${nextPlaceholder()}`,
            params: [String(args[0] ?? "")],
          };
        }
        return {
          sql: `LOWER(${quotedColumn}) LIKE LOWER(${nextPlaceholder()})`,
          params: [`%${String(args[0] ?? "")}%`],
        };
      },
    });

    // Longer suffix "JsonContains" must beat built-in "Contains" (length 12 > 8)!
    registerQueryOperator({
      suffix: "JsonContains",
      arity: 1,
      description: "Checks whether a JSON array column contains a string element",
      toSql: ({ quotedColumn, nextPlaceholder, args, dialect }) => {
        if (dialect === "postgres") {
          return {
            sql: `${quotedColumn}::jsonb @> ${nextPlaceholder()}::jsonb`,
            params: [JSON.stringify([args[0]])],
          };
        }
        return {
          sql: `EXISTS (SELECT 1 FROM json_each(${quotedColumn}) WHERE json_each.value = ${nextPlaceholder()})`,
          params: [args[0]],
        };
      },
    });

    // 0-arity custom operator
    registerQueryOperator({
      suffix: "HasContent",
      arity: 0,
      description: "Checks that a text column is non-null and non-empty",
      toSql: ({ quotedColumn }) => ({
        sql: `${quotedColumn} IS NOT NULL AND LENGTH(TRIM(${quotedColumn})) > 0`,
      }),
    });

    // 2-arity custom operator using raw `?` placeholders (auto-rewritten per dialect)
    registerQueryOperator({
      suffix: "InClosedRange",
      arity: 2,
      description: "Inclusive range predicate using raw ? placeholders",
      toSql: ({ quotedColumn, args }) => ({
        sql: `${quotedColumn} >= ? AND ${quotedColumn} <= ?`,
        params: [args[0], args[1]],
      }),
    });

    // Verify single-realm globalThis symbol exposure for @bunest/cli & VS Code
    const globalMap = (
      globalThis as unknown as Record<symbol, Map<string, CustomQueryOperator>>
    )[ORM_CUSTOM_QUERY_OPERATORS_SYMBOL];
    expect(globalMap).toBeInstanceOf(Map);
    expect(globalMap!.get("Matches")?.description).toContain("match");
    expect(getRegisteredQueryOperator("JsonContains")?.arity).toBe(1);
    expect(listRegisteredQueryOperators().map((o) => o.suffix)).toEqual([
      "Matches",
      "JsonContains",
      "HasContent",
      "InClosedRange",
    ]);

    @Entity("magic_profiles")
    class Profile {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column()
      handle!: string;

      @Column({ type: "text", nullable: true })
      bio!: string | null;

      @Column({ type: "json" })
      tags!: string[];

      @Column("integer")
      score!: number;

      @Column({ type: "boolean", default: true })
      active!: boolean;
    }

    @OrmRepository(Profile)
    abstract class ProfileRepository extends CrudRepository<Profile, number> {
      abstract findByBioMatches(q: string): Promise<Profile | null>;
      abstract findAllByTagsJsonContainsAndActiveIsTrue(
        tag: string,
      ): Promise<Profile[]>;
      abstract findAllByBioHasContentOrderByScoreDesc(): Promise<Profile[]>;
      abstract findAllByScoreInClosedRange(
        min: number,
        max: number,
      ): Promise<Profile[]>;
    }

    const ds = new DataSource({
      type: "sqlite",
      database: ":memory:",
      entities: [Profile],
      synchronize: true,
    });
    await ds.initialize();

    try {
      const repo = ds.getDeclarativeRepository(ProfileRepository);
      await repo.saveMany([
        {
          handle: "ada",
          bio: "Analytical Engine pioneer",
          tags: ["math", "bun", "orm"],
          score: 95,
          active: true,
        },
        {
          handle: "grace",
          bio: "COBOL compiler architect",
          tags: ["compiler", "bun"],
          score: 88,
          active: true,
        },
        {
          handle: "ghost",
          bio: "   ",
          tags: ["bun", "legacy"],
          score: 40,
          active: false,
        },
      ]);

      // Matches operator
      const ada = await repo.findByBioMatches("analytical");
      expect(ada?.handle).toBe("ada");

      // JsonContains (longest suffix beats built-in Contains) + IsTrue
      const bunActive =
        await repo.findAllByTagsJsonContainsAndActiveIsTrue("bun");
      expect(bunActive.map((p) => p.handle).sort()).toEqual(["ada", "grace"]);

      // 0-arity custom operator + OrderBy
      const withBio = await repo.findAllByBioHasContentOrderByScoreDesc();
      expect(withBio.map((p) => p.handle)).toEqual(["ada", "grace"]);

      // 2-arity custom operator
      const midRange = await repo.findAllByScoreInClosedRange(80, 100);
      expect(midRange.map((p) => p.handle).sort()).toEqual(["ada", "grace"]);

      // Verify Postgres dialect placeholder numbering ($1, $2) & quoting
      const pg = createRecordingDriver("postgres");
      const pgRepo = compileOrmRepository(ProfileRepository).createInstance({
        driver: pg.driver,
        dialect: "postgres",
      });
      await pgRepo.findByBioMatches("engine");
      await pgRepo.findAllByTagsJsonContainsAndActiveIsTrue("orm");
      await pgRepo.findAllByScoreInClosedRange(10, 50);

      expect(pg.calls[0]!.sql).toBe(
        'SELECT * FROM "magic_profiles" WHERE "bio" ~* $1 LIMIT 1',
      );
      expect(pg.calls[0]!.params).toEqual(["engine"]);
      expect(pg.calls[1]!.sql).toBe(
        'SELECT * FROM "magic_profiles" WHERE "tags"::jsonb @> $1::jsonb AND "active" = TRUE',
      );
      expect(pg.calls[1]!.params).toEqual(['["orm"]']);
      expect(pg.calls[2]!.sql).toBe(
        'SELECT * FROM "magic_profiles" WHERE "score" >= $1 AND "score" <= $2',
      );
      expect(pg.calls[2]!.params).toEqual([10, 50]);

      // Dynamic operator replacement invalidates compiled derived cache immediately
      registerQueryOperator({
        suffix: "Matches",
        arity: 1,
        toSql: ({ quotedColumn, nextPlaceholder, args }) => ({
          sql: `${quotedColumn} = ${nextPlaceholder()}`,
          params: [String(args[0] ?? "")],
        }),
      });
      expect(await repo.findByBioMatches("analytical")).toBeNull();
      expect(
        (await repo.findByBioMatches("Analytical Engine pioneer"))?.handle,
      ).toBe("ada");

      expect(unregisterQueryOperator("Matches")).toBe(true);
      expect(unregisterQueryOperator("Matches")).toBe(false);
      expect(getRegisteredQueryOperator("Matches")).toBeUndefined();
    } finally {
      await ds.destroy();
    }
  });

  // ==========================================================================
  // 2. @SoftDelete + @IgnoreScope + softDeleteById / restoreById / hardDeleteById
  // ==========================================================================

  it("enforces @SoftDelete across CRUD & derived queries (including OR precedence), intercepts deleteById, and supports @IgnoreScope + restore/hardDelete", async () => {
    @Entity("magic_notes")
    class Note {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column()
      title!: string;

      @Column()
      category!: string;

      @Column({ type: "boolean", default: false })
      pinned!: boolean;

      @DeleteDateColumn()
      deletedAt!: Date | null;
    }

    const fixedNow = "2026-06-01T12:00:00.000Z";

    @OrmRepository(Note)
    @SoftDelete({ now: () => fixedNow })
    abstract class NoteRepository extends CrudRepository<Note, number> {
      abstract findByTitle(title: string): Promise<Note | null>;
      abstract findAllByCategory(category: string): Promise<Note[]>;
      abstract findAllByCategoryOrTitle(
        category: string,
        title: string,
      ): Promise<Note[]>;
      abstract countByCategory(category: string): Promise<number>;
      abstract existsByTitle(title: string): Promise<boolean>;
      abstract deleteByCategory(category: string): Promise<number>;

      // Implicit soft-delete methods provided by @SoftDelete
      abstract softDeleteById(id: number): Promise<void>;
      abstract restoreById(id: number): Promise<void>;
      abstract hardDeleteById(id: number): Promise<void>;

      // Concrete method delegating to CrudRepository with @IgnoreScope("softDelete")
      @IgnoreScope("softDelete")
      findWithDeletedById(id: number): Promise<Note | null> {
        return this.findById(id);
      }

      @IgnoreScope()
      adminFindAll(): Promise<Note[]> {
        return this.findAll();
      }

      // Decorated derived stub ignoring softDelete
      @IgnoreScope("softDelete")
      findAllByPinned(_pinned: boolean): Promise<Note[]> {
        return [] as unknown as Promise<Note[]>;
      }
    }

    // Verify exact UPDATE SQL for deleteById via recording driver
    const rec = createRecordingDriver("sqlite");
    const recRepo = compileOrmRepository(NoteRepository).createInstance({
      driver: rec.driver,
      dialect: "sqlite",
    });
    await recRepo.deleteById(42);
    expect(rec.calls[0]!.sql).toBe(
      'UPDATE "magic_notes" SET "deleted_at" = ? WHERE "id" = ? AND "deleted_at" IS NULL',
    );
    expect(rec.calls[0]!.params).toEqual([fixedNow, 42]);

    const ds = new DataSource({
      type: "sqlite",
      database: ":memory:",
      entities: [Note],
      synchronize: true,
    });
    await ds.initialize();

    try {
      const repo = ds.getDeclarativeRepository(NoteRepository);
      const [n1, n2, n3] = await repo.saveMany([
        { title: "Roadmap", category: "work", pinned: true },
        { title: "Groceries", category: "home", pinned: false },
        { title: "Secret", category: "work", pinned: true },
      ]);

      expect(await repo.count()).toBe(3);
      expect(await repo.countByCategory("work")).toBe(2);

      // deleteById performs soft-delete
      await repo.deleteById(n3!.id);

      expect(await repo.count()).toBe(2);
      expect(await repo.findAll()).toHaveLength(2);
      expect(await repo.findById(n3!.id)).toBeNull();
      await expect(repo.findByIdOrFail(n3!.id)).rejects.toThrow(
        EntityNotFoundError,
      );
      expect(await repo.existsById(n3!.id)).toBe(false);
      expect(await repo.findByTitle("Secret")).toBeNull();
      expect(await repo.existsByTitle("Secret")).toBe(false);
      expect(await repo.countByCategory("work")).toBe(1);
      expect((await repo.findAllByCategory("work")).map((n) => n.title)).toEqual(
        ["Roadmap"],
      );

      // CRITICAL: OR predicate MUST stay parenthesized so deleted "Secret" never leaks!
      const orRes = await repo.findAllByCategoryOrTitle("home", "Secret");
      expect(orRes.map((n) => n.title)).toEqual(["Groceries"]);

      // @IgnoreScope("softDelete") sees deleted row with hydrated deletedAt Date
      const deletedRow = await repo.findWithDeletedById(n3!.id);
      expect(deletedRow).not.toBeNull();
      expect(deletedRow!.title).toBe("Secret");
      expect(deletedRow!.deletedAt).toBeInstanceOf(Date);
      expect(deletedRow!.deletedAt!.toISOString()).toBe(fixedNow);

      // @IgnoreScope() sees all rows
      expect(await repo.adminFindAll()).toHaveLength(3);

      // Decorated derived stub with @IgnoreScope("softDelete") sees both pinned notes
      const allPinned = await repo.findAllByPinned(true);
      expect(allPinned.map((n) => n.title).sort()).toEqual([
        "Roadmap",
        "Secret",
      ]);

      // Programmatic runWithIgnoredScopes helper
      const bypassed = await runWithIgnoredScopes(["softDelete"], () =>
        repo.findAll(),
      );
      expect(bypassed).toHaveLength(3);

      // restoreById brings the soft-deleted row back
      await repo.restoreById(n3!.id);
      expect(await repo.count()).toBe(3);
      expect((await repo.findById(n3!.id))?.deletedAt).toBeNull();

      // softDeleteById + hardDeleteById permanently removes the row
      await repo.softDeleteById(n2!.id);
      expect(await repo.count()).toBe(2);
      expect(await repo.adminFindAll()).toHaveLength(3);

      await repo.hardDeleteById(n2!.id);
      expect(await repo.adminFindAll()).toHaveLength(2);
      expect(await repo.findWithDeletedById(n2!.id)).toBeNull();

      // Derived deleteBy* respects softDelete scope (only deletes non-deleted rows)
      await repo.softDeleteById(n1!.id);
      const affected = await repo.deleteByCategory("work");
      expect(affected).toBe(1); // Only n3 ("Secret"), NOT soft-deleted n1 ("Roadmap")
      expect(await repo.findWithDeletedById(n1!.id)).not.toBeNull();
    } finally {
      await ds.destroy();
    }
  });

  // ==========================================================================
  // 3. @TenantScoped (explicit resolver, CLS & RequestContext fallbacks, required error)
  //    + Combined @SoftDelete + @TenantScoped + Custom @RepositoryScope
  // ==========================================================================

  it("enforces @TenantScoped isolation, auto-fill on save/saveMany, missing-tenant errors, CLS/RequestContext fallback, and combined scopes", async () => {
    @Entity("magic_invoices")
    class Invoice {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column()
      tenantId!: string;

      @Column()
      code!: string;

      @Column("integer")
      amount!: number;

      @Column({ type: "text", default: "open" })
      status!: string;

      @DeleteDateColumn()
      deletedAt!: Date | null;
    }

    let currentTenant: string | undefined = "acme";
    let onlyOpenEnabled = false;

    @OrmRepository(Invoice)
    @SoftDelete()
    @TenantScoped({ resolveTenant: () => currentTenant })
    @RepositoryScope<Invoice>({
      name: "onlyOpen",
      where: () => (onlyOpenEnabled ? { status: "open" } : null),
      beforeSave: (entity) => ({
        ...entity,
        code:
          typeof entity.code === "string"
            ? entity.code.trim().toUpperCase()
            : entity.code,
      }),
    })
    abstract class InvoiceRepository extends CrudRepository<Invoice, number> {
      abstract findByCode(code: string): Promise<Invoice | null>;
      abstract findAllByAmountGreaterThanEqual(min: number): Promise<Invoice[]>;
      abstract countByStatus(status: string): Promise<number>;
      abstract softDeleteById(id: number): Promise<void>;
      abstract restoreById(id: number): Promise<void>;
      abstract hardDeleteById(id: number): Promise<void>;

      @IgnoreScope("softDelete")
      findTenantWithDeleted(): Promise<Invoice[]> {
        return this.findAll();
      }

      @IgnoreScope("tenant")
      findActiveAcrossAllTenants(): Promise<Invoice[]> {
        return this.findAll();
      }

      @IgnoreScope()
      adminDumpAll(): Promise<Invoice[]> {
        return this.findAll();
      }
    }

    const ds = new DataSource({
      type: "sqlite",
      database: ":memory:",
      entities: [Invoice],
      synchronize: true,
    });
    await ds.initialize();

    try {
      const repo = ds.getDeclarativeRepository(InvoiceRepository);

      // Tenant "acme": auto-fills tenantId & runs custom beforeSave uppercase normalization
      currentTenant = "acme";
      const [inv1, inv2] = await repo.saveMany([
        { code: " inv-001 ", amount: 100, status: "open" },
        { code: "inv-002", amount: 250, status: "paid" },
      ]);
      expect(inv1!.tenantId).toBe("acme");
      expect(inv1!.code).toBe("INV-001");
      expect(inv2!.tenantId).toBe("acme");

      // Tenant "globex": isolated writes & reads
      currentTenant = "globex";
      const inv3 = await repo.save({
        code: "inv-003",
        amount: 500,
        status: "open",
      });
      expect(inv3.tenantId).toBe("globex");

      expect(await repo.count()).toBe(1);
      expect((await repo.findAll()).map((i) => i.code)).toEqual(["INV-003"]);
      expect(await repo.findById(inv1!.id)).toBeNull();
      expect(await repo.existsById(inv1!.id)).toBe(false);
      expect(await repo.findByCode("INV-001")).toBeNull();

      // Cross-tenant deleteById / softDeleteById MUST NOT affect "acme"'s row!
      await repo.deleteById(inv1!.id);
      await repo.hardDeleteById(inv1!.id);

      currentTenant = "acme";
      expect(await repo.count()).toBe(2);
      expect(await repo.findById(inv1!.id)).not.toBeNull();

      // Soft-delete inv2 in "acme"
      await repo.deleteById(inv2!.id);
      expect(await repo.count()).toBe(1);

      // Tenant "globex" CANNOT restore "acme"'s soft-deleted row!
      currentTenant = "globex";
      await repo.restoreById(inv2!.id);

      currentTenant = "acme";
      expect(await repo.findById(inv2!.id)).toBeNull();
      // @IgnoreScope("softDelete") still enforces tenant="acme"
      expect(await repo.findTenantWithDeleted()).toHaveLength(2);
      // @IgnoreScope("tenant") still enforces softDelete (sees inv1 + inv3, not deleted inv2)
      expect(
        (await repo.findActiveAcrossAllTenants()).map((i) => i.code).sort(),
      ).toEqual(["INV-001", "INV-003"]);
      // @IgnoreScope() sees everything across all tenants & deleted rows
      expect(await repo.adminDumpAll()).toHaveLength(3);

      // Custom @RepositoryScope returning plain Record<string, unknown>
      await repo.restoreById(inv2!.id);
      expect(await repo.count()).toBe(2);
      onlyOpenEnabled = true;
      expect(await repo.count()).toBe(1);
      expect((await repo.findAll()).map((i) => i.code)).toEqual(["INV-001"]);
      onlyOpenEnabled = false;

      // Missing tenant throws clear error when required !== false
      currentTenant = undefined;
      await expect(repo.findAll()).rejects.toThrow(/requires an active tenant ID/i);
      await expect(
        repo.save({ code: "inv-fail", amount: 10 }),
      ).rejects.toThrow(/requires an active tenant ID/i);
      // @IgnoreScope() still succeeds when tenant is missing
      expect(await repo.adminDumpAll()).toHaveLength(3);
    } finally {
      await ds.destroy();
    }

    // Verify ambient ClsService & RequestContext fallback resolution + required: false
    @Entity("magic_ambient_items")
    class AmbientItem {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column()
      tenantId!: string;

      @Column()
      label!: string;
    }

    @OrmRepository(AmbientItem)
    @TenantScoped()
    abstract class AmbientTenantRepo extends CrudRepository<AmbientItem, number> {}

    @OrmRepository(AmbientItem)
    @TenantScoped({ required: false })
    abstract class OptionalTenantRepo extends CrudRepository<AmbientItem, number> {}

    const ds2 = new DataSource({
      type: "sqlite",
      database: ":memory:",
      entities: [AmbientItem],
      synchronize: true,
    });
    await ds2.initialize();

    try {
      const repo = ds2.getDeclarativeRepository(AmbientTenantRepo);
      const optRepo = ds2.getDeclarativeRepository(OptionalTenantRepo);
      const cls = new ClsService();

      // 1. ClsService fallback
      await cls.run(
        async () => {
          const item = await repo.save({ label: "from-cls" });
          expect(item.tenantId).toBe("tenant-cls");
          expect(await repo.count()).toBe(1);
        },
        { tenantId: "tenant-cls" },
      );

      // 2. RequestContext fallback via x-tenant-id header
      const reqCtx = new RequestContext({
        request: new Request("http://localhost/items", {
          headers: { "x-tenant-id": "tenant-http" },
        }),
      });
      await requestContextStorage.run(reqCtx, async () => {
        const item = await repo.save({ label: "from-http" });
        expect(item.tenantId).toBe("tenant-http");
        expect((await repo.findAll()).map((i) => i.label)).toEqual(["from-http"]);
      });

      // 3. required: false allows unscoped read outside any tenant context
      expect(await optRepo.findAll()).toHaveLength(2);
    } finally {
      await ds2.destroy();
    }
  });

  // ==========================================================================
  // 4. Selective Column Projection (@Projection)
  // ==========================================================================

  it("compiles @Projection(...fields) and @Projection([...fields]) into selective SELECT SQL and returns plain projected objects", async () => {
    @Entity("magic_accounts")
    class Account {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ name: "email_addr" })
      email!: string;

      @Column()
      displayName!: string;

      @Column()
      passwordHash!: string;

      @Column({ type: "boolean", default: true })
      active!: boolean;
    }

    interface AccountSummary {
      id: number;
      email: string;
      displayName: string;
    }

    @OrmRepository(Account)
    abstract class AccountRepository extends CrudRepository<Account, number> {
      @Projection("id", "email", "displayName")
      findByEmail(_email: string): Promise<AccountSummary | null> {
        return null as unknown as Promise<AccountSummary | null>;
      }

      @Projection(["id", "email"])
      findAllByActiveOrderByIdAsc(
        _active: boolean,
      ): Promise<Array<{ id: number; email: string }>> {
        return [] as unknown as Promise<Array<{ id: number; email: string }>>;
      }

      @Projection("id", "email", "active")
      findOneByDisplayName(
        _name: string,
      ): Promise<{ id: number; email: string; active: boolean } | null> {
        return null as unknown as Promise<{
          id: number;
          email: string;
          active: boolean;
        } | null>;
      }

      @Projection("id", "email")
      findPageByActive(
        _active: boolean,
        _pageable: Pageable,
      ): Promise<Page<{ id: number; email: string }>> {
        return {} as unknown as Promise<Page<{ id: number; email: string }>>;
      }

      // Projection omits cursorField ("id") intentionally to verify cursor still works!
      @Projection("email", "displayName")
      findCursorByActive(
        _active: boolean,
        _pageable: CursorPageable,
      ): Promise<CursorPage<{ email: string; displayName: string }>> {
        return {} as unknown as Promise<
          CursorPage<{ email: string; displayName: string }>
        >;
      }
    }

    // Verify exact SELECT column SQL via recording driver
    const rec = createRecordingDriver("sqlite");
    const recRepo = compileOrmRepository(AccountRepository).createInstance({
      driver: rec.driver,
      dialect: "sqlite",
    });
    await recRepo.findByEmail("ada@bunest.dev");
    await recRepo.findAllByActiveOrderByIdAsc(true);
    expect(rec.calls[0]!.sql).toBe(
      'SELECT "id", "email_addr", "display_name" FROM "magic_accounts" WHERE "email_addr" = ? LIMIT 1',
    );
    expect(rec.calls[1]!.sql).toBe(
      'SELECT "id", "email_addr" FROM "magic_accounts" WHERE "active" = ? ORDER BY "id" ASC',
    );

    const ds = new DataSource({
      type: "sqlite",
      database: ":memory:",
      entities: [Account],
      synchronize: true,
    });
    await ds.initialize();

    try {
      const repo = ds.getDeclarativeRepository(AccountRepository);
      await repo.saveMany([
        {
          email: "ada@bunest.dev",
          displayName: "Ada Lovelace",
          passwordHash: "secret-1",
          active: true,
        },
        {
          email: "grace@bunest.dev",
          displayName: "Grace Hopper",
          passwordHash: "secret-2",
          active: true,
        },
        {
          email: "linus@bunest.dev",
          displayName: "Linus Torvalds",
          passwordHash: "secret-3",
          active: false,
        },
      ]);

      const summary = await repo.findByEmail("ada@bunest.dev");
      expect(summary).toEqual({
        id: 1,
        email: "ada@bunest.dev",
        displayName: "Ada Lovelace",
      });
      // Must be plain projected object (NOT Account class instance, NO passwordHash)
      expect(Object.getPrototypeOf(summary)).toBe(Object.prototype);
      expect(summary instanceof Account).toBe(false);
      expect("passwordHash" in (summary as object)).toBe(false);

      const activeList = await repo.findAllByActiveOrderByIdAsc(true);
      expect(activeList).toEqual([
        { id: 1, email: "ada@bunest.dev" },
        { id: 2, email: "grace@bunest.dev" },
      ]);
      expect(Object.keys(activeList[0]!)).toEqual(["id", "email"]);

      const oneDecoded = await repo.findOneByDisplayName("Grace Hopper");
      expect(oneDecoded).toEqual({
        id: 2,
        email: "grace@bunest.dev",
        active: true,
      });

      // Projected Page<T>
      const page = await repo.findPageByActive(true, {
        page: 1,
        size: 1,
        sort: [{ property: "id", direction: "ASC" }],
      });
      expect(page).toEqual({
        items: [{ id: 1, email: "ada@bunest.dev" }],
        total: 2,
        page: 1,
        size: 1,
        totalPages: 2,
        hasNext: true,
        hasPrevious: false,
      });
      expect(Object.getPrototypeOf(page.items[0])).toBe(Object.prototype);

      // Projected CursorPage<T> even when cursorField ("id") is omitted from @Projection
      const c1 = await repo.findCursorByActive(true, { limit: 1 });
      expect(c1).toEqual({
        items: [{ email: "ada@bunest.dev", displayName: "Ada Lovelace" }],
        nextCursor: 1,
        hasMore: true,
        limit: 1,
      });
      expect("id" in c1.items[0]!).toBe(false);

      const c2 = await repo.findCursorByActive(true, {
        limit: 1,
        cursor: c1.nextCursor!,
      });
      expect(c2).toEqual({
        items: [{ email: "grace@bunest.dev", displayName: "Grace Hopper" }],
        nextCursor: null,
        hasMore: false,
        limit: 1,
      });
    } finally {
      await ds.destroy();
    }
  });

  // ==========================================================================
  // 5. First-Class Offset Pagination (Page<T>) & Keyset Cursor Pagination (CursorPage<T>)
  // ==========================================================================

  it("supports Page<T> and CursorPage<T> pagination via findPageBy*, findCursorBy*, trailing Pageable/CursorPageable args, and type guards", async () => {
    // Type guards
    expect(isPageable({ page: 1, size: 10 })).toBe(true);
    expect(
      isPageable({
        page: 2,
        size: 5,
        sort: [{ property: "createdAt", direction: "DESC" }],
      }),
    ).toBe(true);
    expect(isPageable(createPageable({ page: 1, size: 20 }))).toBe(true);
    expect(isPageable({ limit: 10 })).toBe(false);
    expect(isPageable({ page: 1, size: 0 })).toBe(false);
    expect(isPageable(null)).toBe(false);

    expect(isCursorPageable({ limit: 10 })).toBe(true);
    expect(
      isCursorPageable({
        limit: 10,
        cursor: 42,
        cursorField: "id",
        direction: "DESC",
      }),
    ).toBe(true);
    expect(isCursorPageable(createCursorPageable({ limit: 5 }))).toBe(true);
    expect(isCursorPageable({ page: 1, size: 10 })).toBe(false);
    expect(isCursorPageable({ limit: 0 })).toBe(false);

    @Entity("magic_articles")
    class Article {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column()
      slug!: string;

      @Column()
      topic!: string;

      @Column("integer")
      views!: number;

      @DeleteDateColumn()
      deletedAt!: Date | null;
    }

    @OrmRepository(Article)
    @SoftDelete()
    abstract class ArticleRepository extends CrudRepository<Article, number> {
      abstract findPageByTopicOrderByViewsDesc(
        topic: string,
        pageable: Pageable,
      ): Promise<Page<Article>>;

      abstract findAllByTopic(topic: string): Promise<Article[]>;
      abstract findAllByTopic(
        topic: string,
        pageable: Pageable,
      ): Promise<Page<Article>>;
      abstract findAllByTopic(
        topic: string,
        cursorPageable: CursorPageable,
      ): Promise<CursorPage<Article>>;

      abstract findCursorByTopic(
        topic: string,
        cursorPageable: CursorPageable,
      ): Promise<CursorPage<Article>>;

      abstract findPage(pageable: Pageable): Promise<Page<Article>>;
      abstract findCursor(
        cursorPageable: CursorPageable,
      ): Promise<CursorPage<Article>>;
    }

    const ds = new DataSource({
      type: "sqlite",
      database: ":memory:",
      entities: [Article],
      synchronize: true,
    });
    await ds.initialize();

    try {
      const repo = ds.getDeclarativeRepository(ArticleRepository);
      const created = await repo.saveMany([
        { slug: "a-01", topic: "bun", views: 100 },
        { slug: "a-02", topic: "bun", views: 500 },
        { slug: "a-03", topic: "bun", views: 300 },
        { slug: "a-04", topic: "bun", views: 200 },
        { slug: "a-05", topic: "bun", views: 400 },
        { slug: "a-06", topic: "bun", views: 999 }, // will be soft-deleted
        { slug: "b-01", topic: "sql", views: 150 },
      ]);

      // Soft-delete a-06; pagination & COUNT(*) MUST exclude it!
      await repo.deleteById(created[5]!.id);

      // Page 1 of 3 (size 2, total 5)
      const p1 = await repo.findPageByTopicOrderByViewsDesc("bun", {
        page: 1,
        size: 2,
      });
      expect(p1.total).toBe(5);
      expect(p1.page).toBe(1);
      expect(p1.size).toBe(2);
      expect(p1.totalPages).toBe(3);
      expect(p1.hasPrevious).toBe(false);
      expect(p1.hasNext).toBe(true);
      expect(p1.items.map((a) => a.views)).toEqual([500, 400]);

      // Page 2 of 3
      const p2 = await repo.findPageByTopicOrderByViewsDesc("bun", {
        page: 2,
        size: 2,
      });
      expect(p2.hasPrevious).toBe(true);
      expect(p2.hasNext).toBe(true);
      expect(p2.items.map((a) => a.views)).toEqual([300, 200]);

      // Page 3 of 3
      const p3 = await repo.findPageByTopicOrderByViewsDesc("bun", {
        page: 3,
        size: 2,
      });
      expect(p3.hasPrevious).toBe(true);
      expect(p3.hasNext).toBe(false);
      expect(p3.items.map((a) => a.views)).toEqual([100]);

      // Trailing Pageable arg on findAllBy* with dynamic sort override
      const dynPage = await repo.findAllByTopic("bun", {
        page: 1,
        size: 3,
        sort: [{ property: "slug", direction: "ASC" }],
      });
      expect(dynPage.total).toBe(5);
      expect(dynPage.items.map((a) => a.slug)).toEqual([
        "a-01",
        "a-02",
        "a-03",
      ]);

      // Unfiltered findPage (respecting @SoftDelete -> 6 active total)
      const allPage = await repo.findPage({
        page: 1,
        size: 4,
        sort: [{ property: "id", direction: "ASC" }],
      });
      expect(allPage.total).toBe(6);
      expect(allPage.totalPages).toBe(2);
      expect(allPage.items).toHaveLength(4);

      // Keyset cursor pagination ASC via findCursorBy*
      const k1 = await repo.findCursorByTopic("bun", { limit: 2 });
      expect(k1.items.map((a) => a.slug)).toEqual(["a-01", "a-02"]);
      expect(k1.hasMore).toBe(true);
      expect(k1.nextCursor).toBe(created[1]!.id);
      expect(k1.limit).toBe(2);

      const k2 = await repo.findCursorByTopic("bun", {
        limit: 2,
        cursor: k1.nextCursor!,
      });
      expect(k2.items.map((a) => a.slug)).toEqual(["a-03", "a-04"]);
      expect(k2.hasMore).toBe(true);
      expect(k2.nextCursor).toBe(created[3]!.id);

      const k3 = await repo.findCursorByTopic("bun", {
        limit: 2,
        cursor: k2.nextCursor!,
      });
      expect(k3.items.map((a) => a.slug)).toEqual(["a-05"]);
      expect(k3.hasMore).toBe(false);
      expect(k3.nextCursor).toBeNull();

      // Keyset cursor pagination DESC on custom cursorField ("views") via trailing arg on findAllBy*
      const d1 = await repo.findAllByTopic("bun", {
        limit: 2,
        cursorField: "views",
        direction: "DESC",
      });
      expect(d1.items.map((a) => a.views)).toEqual([500, 400]);
      expect(d1.hasMore).toBe(true);
      expect(d1.nextCursor).toBe(400);

      const d2 = await repo.findAllByTopic("bun", {
        limit: 3,
        cursorField: "views",
        direction: "DESC",
        cursor: d1.nextCursor!,
      });
      // Exact page multiple (3 remaining for limit 3) -> hasMore: false, nextCursor: null
      expect(d2.items.map((a) => a.views)).toEqual([300, 200, 100]);
      expect(d2.hasMore).toBe(false);
      expect(d2.nextCursor).toBeNull();

      // Unfiltered findCursor
      const fc = await repo.findCursor({ limit: 3 });
      expect(fc.items).toHaveLength(3);
      expect(fc.hasMore).toBe(true);
    } finally {
      await ds.destroy();
    }
  });

  // ==========================================================================
  // 6. Composable Repository Fragments (composeRepository, @UseRepositoryFragments,
  //    withSoftDelete, withCursorPagination, custom fragments, & OrmModule DI)
  // ==========================================================================

  it("composes reusable fragments with composeRepository & @UseRepositoryFragments and integrates cleanly with OrmModule DI", async () => {
    @Entity("magic_tasks")
    class Task {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column()
      slug!: string;

      @Column()
      title!: string;

      @Column({ type: "boolean", default: false })
      done!: boolean;

      @DeleteDateColumn()
      deletedAt!: Date | null;
    }

    interface SlugLookupMethods {
      findBySlugStrict(slug: string): Promise<Task>;
    }

    const withSlugLookup = defineRepositoryFragment<SlugLookupMethods, Task>({
      name: "withSlugLookup",
      createMethods(ctx) {
        return {
          async findBySlugStrict(slug: string): Promise<Task> {
            const slugCol = ctx.resolveColumn("slug");
            const scopeWhere = ctx.buildActiveScopesWhere({
              startParamIndex: 1,
              methodName: "findBySlugStrict",
            });
            const extra = scopeWhere.sql ? ` AND ${scopeWhere.sql}` : "";
            const sql = `SELECT * FROM ${ctx.tableRef} WHERE ${ctx.quoteIdentifier(slugCol)} = ${ctx.formatPlaceholder(1)}${extra} LIMIT 1`;
            const res = await ctx.driver.query<Record<string, unknown>>(sql, [
              slug,
              ...scopeWhere.params,
            ]);
            const row = res.rows[0];
            if (!row) {
              throw new EntityNotFoundError("Task", { slug });
            }
            return ctx.hydrateRow(row);
          },
        };
      },
    });

    @OrmRepository(Task)
    abstract class BaseTaskRepository extends CrudRepository<Task, number> {
      abstract findAllByDone(done: boolean): Promise<Task[]>;
    }

    const ComposedTaskRepository = composeRepository(
      BaseTaskRepository,
      withSoftDelete<Task, number>(),
      withCursorPagination<Task>({ defaultLimit: 2 }),
      withSlugLookup,
    );

    @Injectable()
    class TaskService {
      constructor(
        public readonly tasks: InstanceType<typeof ComposedTaskRepository>,
      ) {}
    }

    @Module({
      imports: [
        OrmModule.forRoot({
          type: "sqlite",
          database: ":memory:",
          synchronize: true,
        }),
        OrmModule.forFeature([ComposedTaskRepository]),
      ],
      providers: [
        {
          provide: TaskService,
          useFactory: (
            repo: InstanceType<typeof ComposedTaskRepository>,
          ) => new TaskService(repo),
          inject: [ComposedTaskRepository],
        },
      ],
    })
    class TasksTestModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [TasksTestModule],
    }).compile();

    try {
      const service = moduleRef.get(TaskService);
      const repo = service.tasks;

      expect(repo).toBeInstanceOf(ComposedTaskRepository);
      expect(repo).toBeInstanceOf(BaseTaskRepository);
      expect(repo).toBeInstanceOf(CrudRepository);

      const [t1, t2, t3] = await repo.saveMany([
        { slug: "setup-ci", title: "Setup CI", done: true },
        { slug: "ship-orm", title: "Ship ORM", done: false },
        { slug: "write-docs", title: "Write Docs", done: false },
      ]);

      // Derived query from BaseTaskRepository
      expect((await repo.findAllByDone(false)).map((t) => t.slug)).toEqual([
        "ship-orm",
        "write-docs",
      ]);

      // Custom fragment method respects withSoftDelete scope!
      expect((await repo.findBySlugStrict("ship-orm")).title).toBe("Ship ORM");

      // withSoftDelete fragment methods
      await repo.softDeleteById(t2!.id);
      expect(await repo.count()).toBe(2);
      await expect(repo.findBySlugStrict("ship-orm")).rejects.toThrow(
        EntityNotFoundError,
      );

      // withCursorPagination fragment method respects softDelete scope!
      const c1 = await repo.findCursorPage(); // uses defaultLimit: 2
      expect(c1.items.map((t) => t.slug)).toEqual(["setup-ci", "write-docs"]);
      expect(c1.hasMore).toBe(false);
      expect(c1.nextCursor).toBeNull();

      // Restore & paginate again (now 3 rows -> 2 + 1)
      await repo.restoreById(t2!.id);
      const r1 = await repo.findCursorPage({ limit: 2 });
      expect(r1.items.map((t) => t.slug)).toEqual(["setup-ci", "ship-orm"]);
      expect(r1.hasMore).toBe(true);
      expect(r1.nextCursor).toBe(t2!.id);

      const r2 = await repo.findCursorPage({ limit: 2, cursor: r1.nextCursor! });
      expect(r2.items.map((t) => t.slug)).toEqual(["write-docs"]);
      expect(r2.hasMore).toBe(false);

      // hardDeleteById removes permanently
      await repo.hardDeleteById(t1!.id);
      expect(await repo.count()).toBe(2);
    } finally {
      await moduleRef.close();
    }

    // Also verify @UseRepositoryFragments(...) class decorator syntax
    @OrmRepository(Task)
    @UseRepositoryFragments(
      withSoftDelete<Task, number>(),
      withCursorPagination<Task>({ defaultLimit: 1 }),
    )
    abstract class DecoratedTaskRepo extends CrudRepository<Task, number> {
      abstract softDeleteById(id: number): Promise<void>;
      abstract restoreById(id: number): Promise<void>;
      abstract hardDeleteById(id: number): Promise<void>;
      abstract findCursorPage(
        pageable?: Partial<CursorPageable>,
      ): Promise<CursorPage<Task>>;
    }

    const ds = new DataSource({
      type: "sqlite",
      database: ":memory:",
      entities: [Task],
      synchronize: true,
    });
    await ds.initialize();
    try {
      const repo = ds.getDeclarativeRepository(DecoratedTaskRepo);
      const [a, b] = await repo.saveMany([
        { slug: "d-1", title: "D1", done: false },
        { slug: "d-2", title: "D2", done: false },
      ]);
      const p1 = await repo.findCursorPage();
      expect(p1.items.map((t) => t.slug)).toEqual(["d-1"]);
      expect(p1.hasMore).toBe(true);
      await repo.softDeleteById(a!.id);
      expect((await repo.findCursorPage()).items.map((t) => t.slug)).toEqual([
        "d-2",
      ]);
      await repo.restoreById(a!.id);
      expect(await repo.count()).toBe(2);
      await repo.hardDeleteById(b!.id);
      expect(await repo.count()).toBe(1);
    } finally {
      await ds.destroy();
    }
  });
});
