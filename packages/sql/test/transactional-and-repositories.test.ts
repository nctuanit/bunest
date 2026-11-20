import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { Inject, Injectable, Module, REQUEST, Scope } from "@bunest/common";
import { BunestFactory, ContextIdFactory } from "@bunest/core";
import { Test } from "@bunest/testing";
import {
  DrizzleModule,
  DrizzleService,
  InjectDrizzle,
  InjectPrisma,
  InjectSql,
  InjectSqlRepository,
  Modifying,
  Param,
  PrismaModule,
  PrismaServiceBase,
  Query,
  SqlCrudRepository,
  SqlEntity,
  SqlModule,
  SqlParam,
  SqlQuery,
  SqlRepository,
  SqlService,
  Transactional,
  type DrizzleDatabaseLike,
  type PrismaClientLike,
  type QueryResult,
} from "../src/index";

class Account {
  id!: number;
  name!: string;
  email!: string;
  role!: string;
  active!: number;
  age!: number;
  bio!: string | null;
  createdAt!: string;
}

@SqlRepository(Account)
abstract class AccountRepository extends SqlCrudRepository<Account, number> {
  abstract findByEmail(email: string): Promise<Account | null>;
  abstract findOneByEmail(email: string): Promise<Account | null>;
  abstract findAllByRoleAndActiveOrderByIdDesc(
    role: string,
    active: number,
  ): Promise<Account[]>;
  abstract findAllByNameContaining(part: string): Promise<Account[]>;
  abstract findAllByEmailStartsWith(prefix: string): Promise<Account[]>;
  abstract findAllByEmailEndsWith(suffix: string): Promise<Account[]>;
  abstract findAllByAgeGreaterThan(min: number): Promise<Account[]>;
  abstract findAllByAgeLessThan(max: number): Promise<Account[]>;
  abstract findAllByIdIn(ids: number[]): Promise<Account[]>;
  abstract findAllByBioIsNull(): Promise<Account[]>;
  abstract findAllByBioIsNotNull(): Promise<Account[]>;
  abstract findAllByCreatedAtGreaterThan(since: string): Promise<Account[]>;
  abstract existsByEmail(email: string): Promise<boolean>;
  abstract countByRole(role: string): Promise<number>;
  abstract deleteByEmail(email: string): Promise<number>;

  @SqlQuery("SELECT * FROM accounts WHERE email = :email")
  findOneCustomByEmail(
    @SqlParam("email") _email: string,
  ): Promise<Account | null> {
    return null as unknown as Promise<Account | null>;
  }

  @Query("SELECT * FROM accounts WHERE role = ? ORDER BY id ASC")
  findAllByPositionalRole(_role: string): Promise<Account[]> {
    return [] as unknown as Promise<Account[]>;
  }

  @SqlQuery("SELECT COUNT(*) AS cnt FROM accounts WHERE active = :active")
  countActiveCustom(@Param("active") _active: number): Promise<number> {
    return 0 as unknown as Promise<number>;
  }

  @Modifying()
  @SqlQuery("UPDATE accounts SET active = :active WHERE id = :id")
  updateActive(
    @SqlParam("id") _id: number,
    @SqlParam("active") _active: number,
  ): Promise<number> {
    return 0 as unknown as Promise<number>;
  }

  @Modifying({ returnType: "runResult" })
  @SqlQuery("UPDATE accounts SET role = :role WHERE id = :id")
  updateRoleResult(
    @SqlParam("role") _role: string,
    @SqlParam("id") _id: number,
  ): Promise<QueryResult> {
    return {} as unknown as Promise<QueryResult>;
  }
}

class MockDrizzleDb implements DrizzleDatabaseLike<MockDrizzleDb> {
  constructor(
    public readonly label = "root",
    private readonly rows: string[] = [],
  ) {}

  insert(val: string): void {
    this.rows.push(`${this.label}:${val}`);
  }

  all(): string[] {
    return [...this.rows];
  }

  async transaction<T>(fn: (tx: MockDrizzleDb) => Promise<T>): Promise<T> {
    const snap = [...this.rows];
    const tx = new MockDrizzleDb(`${this.label}>tx`, this.rows);
    try {
      return await fn(tx);
    } catch (err) {
      this.rows.length = 0;
      this.rows.push(...snap);
      throw err;
    }
  }
}

class MockPrismaClient implements PrismaClientLike<MockPrismaClient> {
  public readonly rows: string[] = [];

  constructor(
    public readonly label = "root",
    shared?: string[],
  ) {
    if (shared) this.rows = shared;
  }

  write(val: string): void {
    this.rows.push(`${this.label}:${val}`);
  }

  async $connect(): Promise<void> {}
  async $disconnect(): Promise<void> {}

  async $transaction<T>(fn: (tx: MockPrismaClient) => Promise<T>): Promise<T> {
    const snap = [...this.rows];
    const tx = new MockPrismaClient(`${this.label}>tx`, this.rows);
    try {
      return await fn(tx);
    } catch (err) {
      this.rows.length = 0;
      this.rows.push(...snap);
      throw err;
    }
  }
}

describe("@bunest/sql @Transactional() Method Aspect", () => {
  it("runs SqlService transactions with commit, rollback, nested SAVEPOINTs, named connections, and TRANSIENT/REQUEST scopes", async () => {
    @Injectable()
    class ChildTxService {
      constructor(private readonly sql: SqlService) {}

      @Transactional({ savepointName: "child_sp" })
      async appendEntry(label: string, fail = false): Promise<void> {
        expect(this.sql.isInTransaction()).toBe(true);
        const tx = this.sql.getCurrentTransaction();
        expect(tx?.isNested).toBe(true);
        expect(tx?.depth).toBe(1);
        expect(tx?.savepointName).toMatch(/^child_sp_/);
        await this.sql.sql`INSERT INTO journal (entry) VALUES (${label})`;
        if (fail) {
          throw new Error(`child-fail:${label}`);
        }
      }
    }

    @Injectable()
    class JournalService {
      constructor(
        private readonly sql: SqlService,
        private readonly child: ChildTxService,
        @InjectSql("replica") private readonly replica: SqlService,
      ) {}

      @Transactional()
      async recordFlow(
        tag: string,
        failChild: boolean,
        failOuter: boolean,
      ): Promise<string> {
        expect(this.sql.isInTransaction()).toBe(true);
        await this.sql.sql`INSERT INTO journal (entry) VALUES (${`outer:${tag}`})`;
        try {
          await this.child.appendEntry(`inner:${tag}`, failChild);
        } catch (err) {
          if (!failChild) throw err;
        }
        if (failOuter) {
          throw new Error(`outer-fail:${tag}`);
        }
        await this.sql.sql`INSERT INTO journal (entry) VALUES (${`done:${tag}`})`;
        return tag;
      }

      @Transactional({ connectionName: "replica" })
      async writeReplica(entry: string, fail = false): Promise<void> {
        expect(this.replica.isInTransaction()).toBe(true);
        await this.replica.sql`INSERT INTO replica_log (msg) VALUES (${entry})`;
        if (fail) throw new Error("replica-rb");
      }
    }

    @Injectable({ scope: Scope.TRANSIENT })
    class TransientSqlWriter {
      constructor(private readonly sql: SqlService) {}

      @Transactional()
      async write(val: string, fail = false): Promise<void> {
        expect(this.sql.isInTransaction()).toBe(true);
        await this.sql.sql`INSERT INTO journal (entry) VALUES (${val})`;
        if (fail) throw new Error("transient-sql-rb");
      }
    }

    @Injectable({ scope: Scope.REQUEST })
    class RequestSqlWriter {
      constructor(
        private readonly sql: SqlService,
        @Inject(REQUEST) private readonly req: { user: string },
      ) {}

      @Transactional()
      async write(action: string, fail = false): Promise<void> {
        expect(this.sql.isInTransaction()).toBe(true);
        await this.sql.sql`INSERT INTO journal (entry) VALUES (${`${this.req.user}:${action}`})`;
        if (fail) throw new Error("request-sql-rb");
      }
    }

    @Module({
      imports: [
        SqlModule.forRoot({
          url: "sqlite://:memory:",
          autoMigrate: true,
          migrations: [
            {
              id: "001_journal",
              up: "CREATE TABLE journal (id INTEGER PRIMARY KEY AUTOINCREMENT, entry TEXT NOT NULL)",
            },
          ],
        }),
        SqlModule.forRoot({
          name: "replica",
          url: "sqlite://:memory:",
          autoMigrate: true,
          migrations: [
            {
              id: "001_replica",
              up: "CREATE TABLE replica_log (id INTEGER PRIMARY KEY AUTOINCREMENT, msg TEXT NOT NULL)",
            },
          ],
        }),
      ],
      providers: [
        ChildTxService,
        JournalService,
        TransientSqlWriter,
        RequestSqlWriter,
      ],
    })
    class TxAppModule {}

    const ctx = await BunestFactory.createApplicationContext(TxAppModule, {
      logger: false,
    });
    try {
      const sql = ctx.get(SqlService);
      const journal = ctx.get(JournalService);

      // Partial nested savepoint rollback + outer commit
      await journal.recordFlow("a", true, false);
      // Full commit (outer + inner)
      await journal.recordFlow("b", false, false);
      // Full rollback on uncaught outer error
      await expect(journal.recordFlow("c", false, true)).rejects.toThrow(
        "outer-fail:c",
      );

      // TRANSIENT scope
      const tw1 = await ctx.resolve(TransientSqlWriter);
      const tw2 = await ctx.resolve(TransientSqlWriter);
      expect(tw1).not.toBe(tw2);
      await tw1.write("transient-ok");
      await expect(tw2.write("transient-bad", true)).rejects.toThrow(
        "transient-sql-rb",
      );

      // REQUEST scope
      const cid = ContextIdFactory.create();
      ctx.registerRequestByContextId({ user: "ada" }, cid);
      const rw = await ctx.resolve(RequestSqlWriter, cid);
      await rw.write("commit");
      await expect(rw.write("abort", true)).rejects.toThrow("request-sql-rb");

      const entries = (
        await sql.sql<{ entry: string }>`SELECT entry FROM journal ORDER BY id`
      ).map((r) => r.entry);
      expect(entries).toEqual([
        "outer:a",
        "done:a",
        "outer:b",
        "inner:b",
        "done:b",
        "transient-ok",
        "ada:commit",
      ]);

      // Named connection
      await journal.writeReplica("rep-ok");
      await expect(journal.writeReplica("rep-fail", true)).rejects.toThrow(
        "replica-rb",
      );
      const replicaSvc = ctx.get<SqlService>("bunest:sql:connection:replica");
      const repRows = (
        await replicaSvc.sql<{ msg: string }>`SELECT msg FROM replica_log`
      ).map((r) => r.msg);
      expect(repRows).toEqual(["rep-ok"]);
    } finally {
      await ctx.close();
    }
  });

  it("supports @Transactional() with DrizzleService and PrismaServiceBase adapters", async () => {
    const drizzleDb = new MockDrizzleDb("drz");
    const prismaClient = new MockPrismaClient("prs");

    @Injectable()
    class OrmService {
      constructor(
        @InjectDrizzle() private readonly drizzle: MockDrizzleDb,
        private readonly drizzleSvc: DrizzleService<MockDrizzleDb>,
        @InjectPrisma() private readonly prisma: MockPrismaClient,
        private readonly prismaSvc: PrismaServiceBase<MockPrismaClient>,
      ) {}

      @Transactional({ adapter: "drizzle" })
      async runDrizzle(val: string, fail = false): Promise<void> {
        expect(this.drizzleSvc.isInTransaction()).toBe(true);
        this.drizzle.insert(val);
        if (fail) throw new Error("drz-rollback");
      }

      @Transactional({ adapter: "prisma" })
      async runPrisma(val: string, fail = false): Promise<void> {
        expect(this.prismaSvc.isInTransaction()).toBe(true);
        this.prisma.write(val);
        if (fail) throw new Error("prs-rollback");
      }
    }

    const mod = await Test.createTestingModule({
      imports: [
        DrizzleModule.forRoot({ db: drizzleDb, transactionalProxy: true }),
        PrismaModule.forRoot({ client: prismaClient, transactionalProxy: true }),
      ],
      providers: [OrmService],
    }).compile();

    await mod.init();
    try {
      const orm = mod.get(OrmService);

      await orm.runDrizzle("kept");
      await expect(orm.runDrizzle("reverted", true)).rejects.toThrow(
        "drz-rollback",
      );
      expect(drizzleDb.all()).toEqual(["drz>tx:kept"]);

      await orm.runPrisma("kept");
      await expect(orm.runPrisma("reverted", true)).rejects.toThrow(
        "prs-rollback",
      );
      expect(prismaClient.rows).toEqual(["prs>tx:kept"]);
    } finally {
      await mod.close();
    }
  });
});

describe("@bunest/sql Declarative SQL Repository Engine", () => {
  it("executes CRUD, derived queries, @SqlQuery + @SqlParam + @Modifying, and @Transactional via SqlModule.forFeature", async () => {
    @Injectable()
    class AccountService {
      constructor(
        public readonly accounts: AccountRepository,
        @InjectSqlRepository(AccountRepository)
        public readonly accountsByToken: AccountRepository,
      ) {}

      @Transactional()
      async createPairAtomically(failSecond: boolean): Promise<void> {
        await this.accounts.save({
          name: "TxOne",
          email: "tx1@test.dev",
          role: "user",
          active: 1,
          age: 20,
        });
        if (failSecond) {
          throw new Error("tx-pair-abort");
        }
        await this.accounts.save({
          name: "TxTwo",
          email: "tx2@test.dev",
          role: "user",
          active: 1,
          age: 21,
        });
      }
    }

    const mod = await Test.createTestingModule({
      imports: [
        SqlModule.forRoot({
          url: "sqlite://:memory:",
          autoMigrate: true,
          migrations: [
            {
              id: "001_accounts",
              up: `
                CREATE TABLE accounts (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  name TEXT NOT NULL,
                  email TEXT UNIQUE NOT NULL,
                  role TEXT NOT NULL DEFAULT 'user',
                  active INTEGER NOT NULL DEFAULT 1,
                  age INTEGER NOT NULL DEFAULT 25,
                  bio TEXT,
                  created_at TEXT NOT NULL DEFAULT '2026-01-01 00:00:00'
                );
              `,
            },
          ],
        }),
        SqlModule.forFeature([AccountRepository]),
      ],
      providers: [AccountService],
    }).compile();

    await mod.init();
    try {
      const svc = mod.get(AccountService);
      const repo = svc.accounts;
      expect(repo).toBe(svc.accountsByToken);
      expect(repo).toBeInstanceOf(AccountRepository);
      expect(repo).toBeInstanceOf(SqlCrudRepository);

      const a1 = await repo.save({
        name: "Alice",
        email: "alice@bunest.dev",
        role: "admin",
        active: 1,
        age: 34,
        bio: "Lead",
        createdAt: "2026-01-10 00:00:00",
      });
      expect(a1).toBeInstanceOf(Account);
      expect(a1.id).toBe(1);
      expect(a1.createdAt).toBe("2026-01-10 00:00:00");

      const a2 = await repo.save({
        name: "Bob",
        email: "bob@bunest.dev",
        role: "admin",
        active: 1,
        age: 28,
        bio: null,
        createdAt: "2026-02-01 00:00:00",
      });
      const a3 = await repo.save({
        name: "Carol",
        email: "carol@partner.io",
        role: "user",
        active: 0,
        age: 41,
        bio: "Reviewer",
        createdAt: "2026-03-01 00:00:00",
      });

      // Partial update preserves NOT NULL email
      const updated = await repo.save({ id: a1.id, age: 35 });
      expect(updated.email).toBe("alice@bunest.dev");
      expect(updated.age).toBe(35);

      // Base CRUD
      expect((await repo.findById(a2.id))?.name).toBe("Bob");
      expect(await repo.findById(999)).toBeNull();
      expect(await repo.findAll()).toHaveLength(3);
      expect(await repo.count()).toBe(3);
      expect(await repo.existsById(a3.id)).toBe(true);
      expect(await repo.existsById(999)).toBe(false);

      // Derived finders
      expect((await repo.findByEmail("alice@bunest.dev"))?.id).toBe(a1.id);
      expect((await repo.findOneByEmail("carol@partner.io"))?.id).toBe(a3.id);
      expect(
        (await repo.findAllByRoleAndActiveOrderByIdDesc("admin", 1)).map(
          (a) => a.name,
        ),
      ).toEqual(["Bob", "Alice"]);
      expect(
        (await repo.findAllByNameContaining("li")).map((a) => a.name),
      ).toEqual(["Alice"]);
      expect(
        (await repo.findAllByEmailStartsWith("bob")).map((a) => a.name),
      ).toEqual(["Bob"]);
      expect(
        (await repo.findAllByEmailEndsWith("@partner.io")).map((a) => a.name),
      ).toEqual(["Carol"]);
      expect(
        (await repo.findAllByAgeGreaterThan(30)).map((a) => a.name).sort(),
      ).toEqual(["Alice", "Carol"]);
      expect(
        (await repo.findAllByAgeLessThan(30)).map((a) => a.name),
      ).toEqual(["Bob"]);
      expect(
        (await repo.findAllByIdIn([a1.id, a3.id])).map((a) => a.name).sort(),
      ).toEqual(["Alice", "Carol"]);
      expect(await repo.findAllByIdIn([])).toEqual([]);
      expect((await repo.findAllByBioIsNull()).map((a) => a.name)).toEqual([
        "Bob",
      ]);
      expect(
        (await repo.findAllByBioIsNotNull()).map((a) => a.name).sort(),
      ).toEqual(["Alice", "Carol"]);
      expect(
        (await repo.findAllByCreatedAtGreaterThan("2026-01-15 00:00:00")).length,
      ).toBe(2);
      expect(await repo.existsByEmail("bob@bunest.dev")).toBe(true);
      expect(await repo.existsByEmail("ghost@bunest.dev")).toBe(false);
      expect(await repo.countByRole("admin")).toBe(2);

      // @SqlQuery / @Query + @SqlParam + @Modifying
      expect((await repo.findOneCustomByEmail("alice@bunest.dev"))?.name).toBe(
        "Alice",
      );
      expect(
        (await repo.findAllByPositionalRole("admin")).map((a) => a.name),
      ).toEqual(["Alice", "Bob"]);
      expect(await repo.countActiveCustom(1)).toBe(2);

      expect(await repo.updateActive(a2.id, 0)).toBe(1);
      expect((await repo.findById(a2.id))?.active).toBe(0);

      const roleRes = await repo.updateRoleResult("owner", a1.id);
      expect(roleRes.rowCount).toBe(1);
      expect((await repo.findById(a1.id))?.role).toBe("owner");

      // @Transactional rollback & commit with SqlCrudRepository
      await expect(svc.createPairAtomically(true)).rejects.toThrow(
        "tx-pair-abort",
      );
      expect(await repo.findByEmail("tx1@test.dev")).toBeNull();

      await svc.createPairAtomically(false);
      expect(await repo.findByEmail("tx1@test.dev")).not.toBeNull();
      expect(await repo.findByEmail("tx2@test.dev")).not.toBeNull();

      // deleteByEmail & deleteById
      expect(await repo.deleteByEmail("tx1@test.dev")).toBe(1);
      await repo.deleteById(a3.id);
      expect(await repo.existsById(a3.id)).toBe(false);
    } finally {
      await mod.close();
    }
  });

  it("generates dialect-aware PostgreSQL ($1, ::cast safe, RETURNING *) and MySQL (backticks, ?, non-RETURNING save) SQL", async () => {
    @SqlEntity("org_members", "member_id")
    class OrgMember {
      memberId!: number;
      fullName!: string;
      email!: string;
    }

    @SqlRepository(OrgMember)
    abstract class OrgMemberRepository extends SqlCrudRepository<
      OrgMember,
      number
    > {
      abstract findAllByFullNameContainingAndEmailEndsWithOrderByMemberIdDesc(
        part: string,
        domain: string,
      ): Promise<OrgMember[]>;

      @SqlQuery(
        "SELECT * FROM org_members WHERE email = :email AND member_id::text = :idText",
        { single: true },
      )
      findWithPgCast(
        @SqlParam("idText") _idText: string,
        @SqlParam("email") _email: string,
      ): Promise<OrgMember | null> {
        return null as unknown as Promise<OrgMember | null>;
      }

      @SqlQuery("SELECT * FROM org_members WHERE email = ? AND full_name = ?", {
        mode: "one",
      })
      findWithQuestionMarks(
        _email: string,
        _name: string,
      ): Promise<OrgMember | null> {
        return null as unknown as Promise<OrgMember | null>;
      }
    }

    const runWithDialect = async (adapter: "postgres" | "mysql") => {
      const recorded: Array<{ sql: string; params: unknown }> = [];
      const mockClient = {
        options: { adapter },
        unsafe: (query: string, params?: unknown) => {
          recorded.push({ sql: query, params });
          if (query.startsWith("INSERT")) {
            const rows: any =
              adapter === "postgres"
                ? [{ member_id: 7, full_name: "Ada", email: "ada@dev" }]
                : [];
            rows.count = 1;
            rows.affectedRows = 1;
            rows.lastInsertRowid = 7;
            return Promise.resolve(rows);
          }
          if (query.startsWith("SELECT")) {
            const rows: any = [
              { member_id: 7, full_name: "Ada", email: "ada@dev" },
            ];
            rows.count = 1;
            return Promise.resolve(rows);
          }
          const empty: any = [];
          empty.count = 1;
          empty.affectedRows = 1;
          return Promise.resolve(empty);
        },
        close: async () => {},
      } as unknown as Bun.SQL;

      const mod = await Test.createTestingModule({
        imports: [
          SqlModule.forRoot({ client: mockClient }),
          SqlModule.forFeature([OrgMemberRepository]),
        ],
      }).compile();

      await mod.init();
      try {
        const repo = mod.get(OrgMemberRepository);
        const saved = await repo.save({ fullName: "Ada", email: "ada@dev" });
        expect(saved.memberId).toBe(7);
        expect(saved.fullName).toBe("Ada");

        await repo.findAllByFullNameContainingAndEmailEndsWithOrderByMemberIdDesc(
          "Ad",
          "@dev",
        );
        await repo.findWithPgCast("7", "ada@dev");
        await repo.findWithQuestionMarks("ada@dev", "Ada");
      } finally {
        await mod.close();
      }
      return recorded;
    };

    // PostgreSQL: $1/$2 placeholders, double quotes, RETURNING *, ::text preserved!
    const pgCalls = await runWithDialect("postgres");
    expect(pgCalls[0]!.sql).toBe(
      'INSERT INTO "org_members" ("full_name", "email") VALUES ($1, $2) RETURNING *',
    );
    expect(pgCalls[0]!.params).toEqual(["Ada", "ada@dev"]);
    expect(pgCalls[1]!.sql).toBe(
      'SELECT * FROM "org_members" WHERE "full_name" LIKE $1 ESCAPE \'!\' AND "email" LIKE $2 ESCAPE \'!\' ORDER BY "member_id" DESC',
    );
    expect(pgCalls[1]!.params).toEqual(["%Ad%", "%@dev"]);
    expect(pgCalls[2]!.sql).toBe(
      "SELECT * FROM org_members WHERE email = $1 AND member_id::text = $2",
    );
    expect(pgCalls[2]!.params).toEqual(["ada@dev", "7"]);
    expect(pgCalls[3]!.sql).toBe(
      "SELECT * FROM org_members WHERE email = $1 AND full_name = $2",
    );
    expect(pgCalls[3]!.params).toEqual(["ada@dev", "Ada"]);

    // MySQL: backticks, ? placeholders, no RETURNING *, follow-up SELECT by lastInsertRowid!
    const mysqlCalls = await runWithDialect("mysql");
    expect(mysqlCalls[0]!.sql).toBe(
      "INSERT INTO `org_members` (`full_name`, `email`) VALUES (?, ?)",
    );
    expect(mysqlCalls[1]!.sql).toBe(
      "SELECT * FROM `org_members` WHERE `member_id` = ? LIMIT 1",
    );
    expect(mysqlCalls[1]!.params).toEqual([7]);
    expect(mysqlCalls[2]!.sql).toBe(
      "SELECT * FROM `org_members` WHERE `full_name` LIKE ? ESCAPE '!' AND `email` LIKE ? ESCAPE '!' ORDER BY `member_id` DESC",
    );
    expect(mysqlCalls[3]!.sql).toBe(
      "SELECT * FROM org_members WHERE email = ? AND member_id::text = ?",
    );
  });
});
