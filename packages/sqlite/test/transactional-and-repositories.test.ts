import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { Injectable, Module, REQUEST, Scope, Inject } from "@bunest/common";
import { BunestFactory, ContextIdFactory } from "@bunest/core";
import { Test } from "@bunest/testing";
import {
  InjectSqlite,
  InjectSqliteRepository,
  JpaRepository,
  Modifying,
  Param,
  Query,
  Repository,
  SqlParam,
  SqliteEntity,
  SqliteModule,
  SqliteRepository,
  SqliteService,
  Transactional,
  type SqliteRunResult,
} from "../src/index";

class User {
  id!: number;
  name!: string;
  email!: string;
  role!: string;
  active!: number;
  age!: number;
  bio!: string | null;
  createdAt!: string;
}

@Repository(User)
abstract class UserRepository extends JpaRepository<User, number> {
  abstract findByEmail(email: string): Promise<User | null>;
  abstract findOneByEmail(email: string): Promise<User | null>;
  abstract findByEmailIgnoreCase(email: string): Promise<User | null>;
  abstract findAllByRoleAndActiveOrderByIdDesc(
    role: string,
    active: number,
  ): Promise<User[]>;
  abstract findAllByRoleOrActiveOrderByNameAscIdDesc(
    role: string,
    active: number,
  ): Promise<User[]>;
  abstract findAllByNameContaining(part: string): Promise<User[]>;
  abstract findAllByEmailStartsWith(prefix: string): Promise<User[]>;
  abstract findAllByEmailEndsWith(suffix: string): Promise<User[]>;
  abstract findAllByAgeGreaterThan(min: number): Promise<User[]>;
  abstract findAllByAgeGreaterThanEqual(min: number): Promise<User[]>;
  abstract findAllByAgeLessThan(max: number): Promise<User[]>;
  abstract findAllByAgeLessThanEqual(max: number): Promise<User[]>;
  abstract findAllByAgeBetween(min: number, max: number): Promise<User[]>;
  abstract findAllByIdIn(ids: number[]): Promise<User[]>;
  abstract findAllByIdNotIn(ids: number[]): Promise<User[]>;
  abstract findAllByBioIsNull(): Promise<User[]>;
  abstract findAllByBioIsNotNull(): Promise<User[]>;
  abstract findAllByCreatedAtGreaterThan(since: string): Promise<User[]>;
  abstract findTop2ByActiveOrderByAgeDesc(active: number): Promise<User[]>;
  abstract existsByEmail(email: string): Promise<boolean>;
  abstract countByRole(role: string): Promise<number>;
  abstract deleteByEmail(email: string): Promise<number>;

  @Query(
    "SELECT * FROM users WHERE email = :email AND created_at >= '2020-01-01 00:00:00'",
  )
  findOneCustomByEmail(@SqlParam("email") _email: string): Promise<User | null> {
    return null as unknown as Promise<User | null>;
  }

  @Query(
    "SELECT * FROM users WHERE name LIKE :pattern OR email LIKE :pattern ORDER BY id ASC",
  )
  searchByPattern(@Param("pattern") _pattern: string): Promise<User[]> {
    return [] as unknown as Promise<User[]>;
  }

  @Query("SELECT * FROM users WHERE role = ? AND active = ? ORDER BY id ASC")
  findAllByPositional(_role: string, _active: number): Promise<User[]> {
    return [] as unknown as Promise<User[]>;
  }

  @Query("SELECT COUNT(*) AS cnt FROM users WHERE active = :active")
  countActiveCustom(@SqlParam("active") _active: number): Promise<number> {
    return 0 as unknown as Promise<number>;
  }

  @Query("SELECT EXISTS(SELECT 1 FROM users WHERE role = :role)")
  existsRoleCustom(@SqlParam("role") _role: string): Promise<boolean> {
    return false as unknown as Promise<boolean>;
  }

  @Query("SELECT name FROM users WHERE id = :id", { mode: "scalar" })
  findNameScalar(@SqlParam("id") _id: number): Promise<string | null> {
    return null as unknown as Promise<string | null>;
  }

  @Query("SELECT * FROM users WHERE email = :email", {
    single: true,
    sync: true,
  })
  findSyncByEmail(@SqlParam("email") _email: string): User | null {
    return null;
  }

  @Modifying()
  @Query("UPDATE users SET active = :active WHERE id = :id")
  updateActiveStatus(
    @SqlParam("id") _id: number,
    @SqlParam("active") _active: number,
  ): Promise<number> {
    return 0 as unknown as Promise<number>;
  }

  @Modifying({ returnType: "runResult" })
  @Query("UPDATE users SET role = :role WHERE id = :id")
  updateRoleWithResult(
    @SqlParam("role") _role: string,
    @SqlParam("id") _id: number,
  ): Promise<SqliteRunResult> {
    return {} as unknown as Promise<SqliteRunResult>;
  }

  @Modifying({ returnType: "void" })
  @Query("DELETE FROM users WHERE active = 0")
  purgeInactive(): Promise<void> {
    return undefined as unknown as Promise<void>;
  }

  async findOrCreateByEmail(
    email: string,
    defaults: Omit<Partial<User>, "email">,
  ): Promise<User> {
    const existing = await this.findByEmail(email);
    if (existing) {
      return existing;
    }
    return await this.save({ ...defaults, email });
  }
}

const USERS_SCHEMA_MIGRATION = {
  id: "001_users",
  up: `
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      active INTEGER NOT NULL DEFAULT 1,
      age INTEGER NOT NULL DEFAULT 25,
      bio TEXT,
      created_at TEXT NOT NULL DEFAULT '2026-01-01 00:00:00'
    );
  `,
};

describe("@bunest/sqlite @Transactional() Method Aspect", () => {
  it("commits on success, rolls back on throw, supports sync/async & nested SAVEPOINT propagation across services", async () => {
    @Injectable()
    class AuditService {
      constructor(private readonly db: SqliteService) {}

      @Transactional({ savepointName: "audit_step" })
      async recordOrFail(entry: string, shouldFail: boolean): Promise<void> {
        expect(this.db.isInTransaction()).toBe(true);
        const tx = this.db.getCurrentTransaction();
        expect(tx?.isNested).toBe(true);
        expect(tx?.depth).toBe(1);
        expect(tx?.savepointName).toMatch(/^audit_step_/);
        this.db.run("INSERT INTO ledger (entry) VALUES (?)", [entry]);
        await Bun.sleep(1);
        if (shouldFail) {
          throw new Error(`audit-fail:${entry}`);
        }
      }
    }

    @Injectable()
    class LedgerService {
      constructor(
        private readonly db: SqliteService,
        private readonly audit: AuditService,
      ) {}

      @Transactional({ mode: "IMMEDIATE" })
      async transferWithOptionalAudit(
        label: string,
        failAudit: boolean,
        failOuter: boolean,
      ): Promise<string> {
        expect(this.db.isInTransaction()).toBe(true);
        expect(this.db.getCurrentTransaction()?.depth).toBe(0);
        this.db.run("INSERT INTO ledger (entry) VALUES (?)", [`outer:${label}`]);

        try {
          await this.audit.recordOrFail(`inner:${label}`, failAudit);
        } catch (err) {
          if (!failAudit) throw err;
          // Swallow savepoint rollback so outer transaction continues!
        }

        if (failOuter) {
          throw new Error(`outer-fail:${label}`);
        }

        this.db.run("INSERT INTO ledger (entry) VALUES (?)", [`done:${label}`]);
        return `ok:${label}`;
      }

      @Transactional()
      insertSyncWrappedAsync(entry: string, fail = false): number {
        expect(this.db.isInTransaction()).toBe(true);
        const res = this.db.run("INSERT INTO ledger (entry) VALUES (?)", [entry]);
        if (fail) {
          throw new Error("sync-method-boom");
        }
        return Number(res.lastInsertRowid);
      }

      @Transactional({ sync: true, mode: "IMMEDIATE" })
      insertTrulySync(entry: string, fail = false): number {
        expect(this.db.isInTransaction()).toBe(true);
        const res = this.db.run("INSERT INTO ledger (entry) VALUES (?)", [entry]);
        if (fail) {
          throw new Error("truly-sync-boom");
        }
        return Number(res.lastInsertRowid);
      }
    }

    const mod = await Test.createTestingModule({
      imports: [
        SqliteModule.forRoot({
          filename: ":memory:",
          autoMigrate: true,
          migrations: [
            {
              id: "001_ledger",
              up: "CREATE TABLE ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, entry TEXT NOT NULL)",
            },
          ],
        }),
      ],
      providers: [AuditService, LedgerService],
    }).compile();

    await mod.init();
    try {
      const db = mod.get(SqliteService);
      const ledger = mod.get(LedgerService);

      // 1. Nested savepoint failure caught -> inner rolled back, outer commits
      const res1 = await ledger.transferWithOptionalAudit("tx1", true, false);
      expect(res1).toBe("ok:tx1");
      expect(db.isInTransaction()).toBe(false);
      expect(
        db.query<{ entry: string }>("SELECT entry FROM ledger ORDER BY id"),
      ).toEqual([{ entry: "outer:tx1" }, { entry: "done:tx1" }]);

      // 2. Both outer and inner succeed -> both commit
      await ledger.transferWithOptionalAudit("tx2", false, false);
      expect(
        db.query<{ entry: string }>("SELECT entry FROM ledger ORDER BY id"),
      ).toEqual([
        { entry: "outer:tx1" },
        { entry: "done:tx1" },
        { entry: "outer:tx2" },
        { entry: "inner:tx2" },
        { entry: "done:tx2" },
      ]);

      // 3. Outer throws -> full rollback (including succeeded inner savepoint!)
      await expect(
        ledger.transferWithOptionalAudit("tx3", false, true),
      ).rejects.toThrow("outer-fail:tx3");
      expect(db.isInTransaction()).toBe(false);
      expect(db.query("SELECT * FROM ledger")).toHaveLength(5);

      // 4. Non-async method decorated with @Transactional() works via Promise & rolls back on throw
      const syncWrappedId = await ledger.insertSyncWrappedAsync("sync-wrapped");
      expect(syncWrappedId).toBeGreaterThan(0);
      await expect(
        Promise.resolve(ledger.insertSyncWrappedAsync("sync-rollback", true)),
      ).rejects.toThrow("sync-method-boom");
      expect(db.query("SELECT * FROM ledger WHERE entry = ?", ["sync-rollback"])).toHaveLength(0);

      // 5. Truly synchronous @Transactional({ sync: true }) stays non-Promise & rolls back on throw
      const syncId = ledger.insertTrulySync("truly-sync");
      expect(typeof syncId).toBe("number");
      expect(() => ledger.insertTrulySync("truly-sync-rb", true)).toThrow(
        "truly-sync-boom",
      );
      expect(db.query("SELECT * FROM ledger WHERE entry = ?", ["truly-sync-rb"])).toHaveLength(0);
    } finally {
      await mod.close();
    }
  });

  it("supports named connections, class-level @Transactional(), and TRANSIENT / REQUEST scopes", async () => {
    let transientInstances = 0;

    @Injectable({ scope: Scope.TRANSIENT })
    class TransientWriter {
      readonly instanceId = ++transientInstances;
      constructor(private readonly db: SqliteService) {}

      @Transactional()
      async write(tag: string, fail = false): Promise<string> {
        expect(this.db.isInTransaction()).toBe(true);
        const label = `t${this.instanceId}:${tag}`;
        this.db.run("INSERT INTO logs (msg) VALUES (?)", [label]);
        if (fail) throw new Error("transient-rb");
        return label;
      }
    }

    @Injectable({ scope: Scope.REQUEST })
    @Transactional()
    class RequestScopedWriter {
      constructor(
        private readonly db: SqliteService,
        @Inject(REQUEST) private readonly req: { tenant: string },
      ) {}

      async writeTenantLog(action: string, fail = false): Promise<string> {
        expect(this.db.isInTransaction()).toBe(true);
        const msg = `${this.req.tenant}:${action}`;
        this.db.run("INSERT INTO logs (msg) VALUES (?)", [msg]);
        if (fail) throw new Error("request-rb");
        return msg;
      }
    }

    @Injectable()
    class AnalyticsWriter {
      constructor(
        @InjectSqlite("analytics") private readonly analytics: SqliteService,
      ) {}

      @Transactional({ connectionName: "analytics" })
      async track(event: string, fail = false): Promise<void> {
        expect(this.analytics.isInTransaction()).toBe(true);
        this.analytics.run("INSERT INTO events (ev) VALUES (?)", [event]);
        if (fail) throw new Error("analytics-rb");
      }
    }

    @Module({
      imports: [
        SqliteModule.forRootMultiple([
          {
            filename: ":memory:",
            autoMigrate: true,
            migrations: [
              {
                id: "001_logs",
                up: "CREATE TABLE logs (id INTEGER PRIMARY KEY AUTOINCREMENT, msg TEXT NOT NULL)",
              },
            ],
          },
          {
            name: "analytics",
            filename: ":memory:",
            autoMigrate: true,
            migrations: [
              {
                id: "001_events",
                up: "CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ev TEXT NOT NULL)",
              },
            ],
          },
        ]),
      ],
      providers: [TransientWriter, RequestScopedWriter, AnalyticsWriter],
    })
    class AppMod {}

    const ctx = await BunestFactory.createApplicationContext(AppMod, {
      logger: false,
    });
    try {
      const db = ctx.get(SqliteService);

      // TRANSIENT scope: distinct instances both woven with @Transactional()
      const t1 = await ctx.resolve(TransientWriter);
      const t2 = await ctx.resolve(TransientWriter);
      expect(t1).not.toBe(t2);
      expect(await t1.write("ok")).toBe("t1:ok");
      await expect(t2.write("nope", true)).rejects.toThrow("transient-rb");

      // REQUEST scope + class-level @Transactional()
      const ctxId1 = ContextIdFactory.create();
      ctx.registerRequestByContextId({ tenant: "acme" }, ctxId1);
      const r1 = await ctx.resolve(RequestScopedWriter, ctxId1);
      expect(await r1.writeTenantLog("login")).toBe("acme:login");

      const ctxId2 = ContextIdFactory.create();
      ctx.registerRequestByContextId({ tenant: "globex" }, ctxId2);
      const r2 = await ctx.resolve(RequestScopedWriter, ctxId2);
      await expect(r2.writeTenantLog("bad", true)).rejects.toThrow("request-rb");

      expect(
        db.query<{ msg: string }>("SELECT msg FROM logs ORDER BY id"),
      ).toEqual([{ msg: "t1:ok" }, { msg: "acme:login" }]);

      // Named connection @Transactional({ connectionName: "analytics" })
      const analyticsWriter = ctx.get(AnalyticsWriter);
      await analyticsWriter.track("signup");
      await expect(analyticsWriter.track("aborted", true)).rejects.toThrow(
        "analytics-rb",
      );
      const analyticsDb = ctx.get<SqliteService>(
        "bunest:sqlite:connection:analytics",
      );
      expect(
        analyticsDb.query<{ ev: string }>("SELECT ev FROM events"),
      ).toEqual([{ ev: "signup" }]);
    } finally {
      await ctx.close();
    }
  });
});

describe("@bunest/sqlite Spring Data-style Declarative Repositories", () => {
  it("supports JpaRepository CRUD, derived queries, @Query + @SqlParam + @Modifying, class-token DI, and @Transactional integration", async () => {
    @Injectable()
    class UsersService {
      constructor(
        public readonly users: UserRepository,
        @InjectSqliteRepository(UserRepository)
        public readonly usersByDecorator: UserRepository,
      ) {}

      @Transactional()
      async onboardBatch(
        entries: Array<{ name: string; email: string; role: string }>,
        failAfterSecond = false,
      ): Promise<User[]> {
        const created: User[] = [];
        for (let i = 0; i < entries.length; i++) {
          const item = entries[i]!;
          created.push(await this.users.save(item));
          if (failAfterSecond && i === 1) {
            throw new Error("onboard-aborted");
          }
        }
        return created;
      }
    }

    const mod = await Test.createTestingModule({
      imports: [
        SqliteModule.forRoot({
          filename: ":memory:",
          autoMigrate: true,
          migrations: [USERS_SCHEMA_MIGRATION],
        }),
        SqliteModule.forFeature([UserRepository]),
      ],
      providers: [UsersService],
    }).compile();

    await mod.init();
    try {
      const svc = mod.get(UsersService);
      const repo = svc.users;

      // Direct class token injection AND @InjectSqliteRepository resolve to the exact same singleton repo
      expect(repo).toBe(svc.usersByDecorator);
      expect(repo).toBeInstanceOf(UserRepository);
      expect(repo).toBeInstanceOf(JpaRepository);

      // Base CRUD: save (insert) + camelCase <-> snake_case mapping + entity prototype hydration
      const alice = await repo.save({
        name: "Alice",
        email: "alice@example.com",
        role: "admin",
        active: 1,
        age: 34,
        bio: "Architect",
        createdAt: "2026-01-10 10:00:00",
      });
      expect(alice).toBeInstanceOf(User);
      expect(alice.id).toBe(1);
      expect(alice.createdAt).toBe("2026-01-10 10:00:00");

      const bob = await repo.save({
        name: "Bob 50%_off",
        email: "bob@example.com",
        role: "admin",
        active: 1,
        age: 29,
        bio: null,
        createdAt: "2026-02-15 12:00:00",
      });
      const carol = await repo.save({
        name: "Carol",
        email: "carol@company.org",
        role: "member",
        active: 0,
        age: 42,
        bio: "Designer",
        createdAt: "2026-03-01 08:30:00",
      });
      const dave = await repo.save({
        id: 10, // explicit ID insert
        name: "Dave",
        email: "dave@company.org",
        role: "member",
        active: 1,
        age: 22,
        bio: null,
        createdAt: "2026-03-20 09:00:00",
      });
      expect(dave.id).toBe(10);

      // Partial save update preserves NOT NULL columns (email, name, etc.)
      const updatedAlice = await repo.save({ id: alice.id, age: 35 });
      expect(updatedAlice.name).toBe("Alice");
      expect(updatedAlice.email).toBe("alice@example.com");
      expect(updatedAlice.age).toBe(35);

      // findById / findAll / count / existsById
      expect((await repo.findById(alice.id))?.age).toBe(35);
      expect(await repo.findById(9999)).toBeNull();
      expect(await repo.findAll()).toHaveLength(4);
      expect(await repo.count()).toBe(4);
      expect(await repo.existsById(bob.id)).toBe(true);
      expect(await repo.existsById(9999)).toBe(false);

      // Derived queries: findBy / findOneBy / IgnoreCase
      expect((await repo.findByEmail("alice@example.com"))?.id).toBe(alice.id);
      expect((await repo.findOneByEmail("carol@company.org"))?.name).toBe("Carol");
      expect((await repo.findByEmailIgnoreCase("ALICE@EXAMPLE.COM"))?.id).toBe(
        alice.id,
      );
      expect(await repo.findByEmail("missing@example.com")).toBeNull();

      // And / Or / OrderBy single & multi-column
      const adminsDesc = await repo.findAllByRoleAndActiveOrderByIdDesc("admin", 1);
      expect(adminsDesc.map((u) => u.name)).toEqual(["Bob 50%_off", "Alice"]);

      const orMultiOrder = await repo.findAllByRoleOrActiveOrderByNameAscIdDesc(
        "admin",
        0,
      );
      expect(orMultiOrder.map((u) => u.name)).toEqual([
        "Alice",
        "Bob 50%_off",
        "Carol",
      ]);

      // Containing (with LIKE wildcard escaping!), StartsWith, EndsWith
      expect(
        (await repo.findAllByNameContaining("50%_")).map((u) => u.id),
      ).toEqual([bob.id]);
      expect(
        (await repo.findAllByEmailStartsWith("alice")).map((u) => u.id),
      ).toEqual([alice.id]);
      expect(
        (await repo.findAllByEmailEndsWith("@company.org")).map((u) => u.name),
      ).toEqual(["Carol", "Dave"]);

      // Comparisons & Between
      expect(
        (await repo.findAllByAgeGreaterThan(30)).map((u) => u.name).sort(),
      ).toEqual(["Alice", "Carol"]);
      expect(
        (await repo.findAllByAgeGreaterThanEqual(35)).map((u) => u.name).sort(),
      ).toEqual(["Alice", "Carol"]);
      expect(
        (await repo.findAllByAgeLessThan(30)).map((u) => u.name).sort(),
      ).toEqual(["Bob 50%_off", "Dave"]);
      expect(
        (await repo.findAllByAgeLessThanEqual(29)).map((u) => u.name).sort(),
      ).toEqual(["Bob 50%_off", "Dave"]);
      expect(
        (await repo.findAllByAgeBetween(25, 36)).map((u) => u.name).sort(),
      ).toEqual(["Alice", "Bob 50%_off"]);

      // In & NotIn (including safe empty array handling!)
      expect(
        (await repo.findAllByIdIn([alice.id, dave.id])).map((u) => u.name).sort(),
      ).toEqual(["Alice", "Dave"]);
      expect(await repo.findAllByIdIn([])).toEqual([]);
      expect(await repo.findAllByIdNotIn([alice.id, bob.id, carol.id])).toHaveLength(1);
      expect(await repo.findAllByIdNotIn([])).toHaveLength(4);

      // IsNull / IsNotNull / camelCase -> snake_case / TopN
      expect(
        (await repo.findAllByBioIsNull()).map((u) => u.name).sort(),
      ).toEqual(["Bob 50%_off", "Dave"]);
      expect(
        (await repo.findAllByBioIsNotNull()).map((u) => u.name).sort(),
      ).toEqual(["Alice", "Carol"]);
      expect(
        (await repo.findAllByCreatedAtGreaterThan("2026-02-01 00:00:00")).length,
      ).toBe(3);
      expect(
        (await repo.findTop2ByActiveOrderByAgeDesc(1)).map((u) => u.name),
      ).toEqual(["Alice", "Bob 50%_off"]);

      // existsBy / countBy / deleteBy
      expect(await repo.existsByEmail("carol@company.org")).toBe(true);
      expect(await repo.existsByEmail("nobody@company.org")).toBe(false);
      expect(await repo.countByRole("admin")).toBe(2);
      expect(await repo.countByRole("member")).toBe(2);

      // Custom @Query + @SqlParam + @Modifying
      expect((await repo.findOneCustomByEmail("alice@example.com"))?.name).toBe(
        "Alice",
      );
      expect(
        (await repo.searchByPattern("%company.org%")).map((u) => u.name),
      ).toEqual(["Carol", "Dave"]);
      expect(
        (await repo.findAllByPositional("admin", 1)).map((u) => u.name),
      ).toEqual(["Alice", "Bob 50%_off"]);
      expect(await repo.countActiveCustom(1)).toBe(3);
      expect(await repo.existsRoleCustom("admin")).toBe(true);
      expect(await repo.existsRoleCustom("ghost")).toBe(false);
      expect(await repo.findNameScalar(alice.id)).toBe("Alice");
      expect(repo.findSyncByEmail("alice@example.com")?.name).toBe("Alice");

      // @Modifying UPDATE (changes, runResult, void)
      const changed = await repo.updateActiveStatus(dave.id, 0);
      expect(changed).toBe(1);
      expect((await repo.findById(dave.id))?.active).toBe(0);

      const runRes = await repo.updateRoleWithResult("owner", alice.id);
      expect(runRes.changes).toBe(1);
      expect((await repo.findById(alice.id))?.role).toBe("owner");

      // Concrete helper method calling derived methods + save()
      const reused = await repo.findOrCreateByEmail("alice@example.com", {
        name: "Ignored",
      });
      expect(reused.id).toBe(alice.id);
      const createdNew = await repo.findOrCreateByEmail("eve@example.com", {
        name: "Eve",
        role: "member",
        active: 1,
        age: 27,
      });
      expect(createdNew.name).toBe("Eve");

      // SQL injection safety: payloads stored & queried literally as parameters
      const payload = "x' OR '1'='1'; DROP TABLE users; --";
      const injected = await repo.save({
        name: payload,
        email: "safe@example.com",
        role: "guest",
        active: 1,
        age: 20,
      });
      expect((await repo.findByEmail(payload))).toBeNull();
      expect((await repo.findById(injected.id))?.name).toBe(payload);

      // @Transactional() rollback rolls back repository saves atomically!
      const countBeforeTx = await repo.count();
      await expect(
        svc.onboardBatch(
          [
            { name: "Temp1", email: "t1@ex.com", role: "guest" },
            { name: "Temp2", email: "t2@ex.com", role: "guest" },
          ],
          true,
        ),
      ).rejects.toThrow("onboard-aborted");
      expect(await repo.count()).toBe(countBeforeTx);
      expect(await repo.findByEmail("t1@ex.com")).toBeNull();

      // deleteByEmail, purgeInactive, deleteById
      expect(await repo.deleteByEmail("safe@example.com")).toBe(1);
      await repo.purgeInactive(); // deletes carol & dave (active=0)
      expect(await repo.findById(carol.id)).toBeNull();
      expect(await repo.findById(dave.id)).toBeNull();

      await repo.deleteById(createdNew.id);
      expect(await repo.existsById(createdNew.id)).toBe(false);
    } finally {
      await mod.close();
    }
  });

  it("respects @SqliteEntity table metadata, custom columns/idColumn, named connections, and fail-fast validation", async () => {
    @SqliteEntity("app_accounts", "account_id")
    class Account {
      accountId!: number;
      fullName!: string;
      emailAddress!: string;
    }

    @SqliteRepository({
      entity: Account,
      columns: { emailAddress: "email_addr" },
      connectionName: "accounts_db",
    })
    abstract class AccountRepository extends JpaRepository<Account, number> {
      abstract findByEmailAddress(email: string): Promise<Account | null>;
    }

    const mod = await Test.createTestingModule({
      imports: [
        SqliteModule.forRoot({
          name: "accounts_db",
          filename: ":memory:",
          autoMigrate: true,
          migrations: [
            {
              id: "001_accounts",
              up: "CREATE TABLE app_accounts (account_id INTEGER PRIMARY KEY AUTOINCREMENT, full_name TEXT NOT NULL, email_addr TEXT UNIQUE NOT NULL)",
            },
          ],
        }),
        SqliteModule.forFeature([AccountRepository]),
      ],
    }).compile();

    await mod.init();
    try {
      const repo = mod.get(AccountRepository);
      const saved = await repo.save({
        fullName: "Grace Hopper",
        emailAddress: "grace@navy.mil",
      });
      expect(saved.accountId).toBe(1);
      expect(saved.fullName).toBe("Grace Hopper");
      expect(saved.emailAddress).toBe("grace@navy.mil");

      const found = await repo.findByEmailAddress("grace@navy.mil");
      expect(found?.accountId).toBe(1);
      expect(found?.fullName).toBe("Grace Hopper");
    } finally {
      await mod.close();
    }

    // Fail-fast on missing @SqlParam binding
    @SqliteRepository("users")
    abstract class BrokenParamRepo extends JpaRepository<User, number> {
      @Query("SELECT * FROM users WHERE email = :email AND role = :role")
      findBroken(@SqlParam("email") _email: string): Promise<User | null> {
        return null as unknown as Promise<User | null>;
      }
    }
    expect(() => SqliteModule.forFeature([BrokenParamRepo])).toThrow(
      /references ":role".*no matching @SqlParam/,
    );

    // Fail-fast on missing @SqliteRepository decorator
    abstract class UndecoratedRepo extends JpaRepository<User, number> {}
    expect(() => SqliteModule.forFeature([UndecoratedRepo])).toThrow(
      /missing @SqliteRepository/,
    );
  });
});
