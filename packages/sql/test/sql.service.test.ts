import "reflect-metadata";
import { afterEach, describe, expect, it } from "bun:test";
import { Injectable, Module } from "@bunest/common";
import { Test } from "@bunest/testing";
import {
  InjectSql,
  SqlMigrationRunner,
  SqlModule,
  SqlService,
  type DatabaseAdapter,
  type MigrationDefinition,
  type SqlModuleForRootInput,
  type SqlOptionsFactory,
} from "../src/index";

describe("SqlService (Bun.SQL sqlite://:memory:)", () => {
  const openServices: SqlService[] = [];

  const createService = async (name?: string): Promise<SqlService> => {
    const svc = new SqlService({ url: "sqlite://:memory:", name });
    openServices.push(svc);
    await svc.sql`CREATE TABLE items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      qty INTEGER NOT NULL DEFAULT 1
    )`;
    return svc;
  };

  afterEach(async () => {
    while (openServices.length > 0) {
      await openServices.pop()!.close();
    }
  });

  it("executes tagged template queries, parameterized unsafe(), and DatabaseAdapter query()", async () => {
    const svc = await createService();

    // Verify structural conformance to unified DatabaseAdapter contract
    const adapter: DatabaseAdapter = svc;
    expect(adapter.connectionName).toBe("default");
    expect(await adapter.healthCheck()).toBe(true);

    // Tagged template with safe parameter interpolation
    const malicious = "widget'; DROP TABLE items; --";
    await svc.sql`INSERT INTO items (name, qty) VALUES (${malicious}, ${5})`;
    await svc.sql`INSERT INTO items (name, qty) VALUES (${"gadget"}, ${10})`;

    const rows = await svc.sql<{ id: number; name: string; qty: number }>`
      SELECT id, name, qty FROM items ORDER BY id ASC
    `;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.name).toBe(malicious);
    expect(rows[1]!.qty).toBe(10);

    // Parameterized unsafe() with positional (?, $1) and named (:name) parameters
    const unsafePos = await svc.unsafe<{ name: string; qty: number }>(
      "SELECT name, qty FROM items WHERE qty >= ?",
      [10],
    );
    expect([...unsafePos]).toEqual([{ name: "gadget", qty: 10 }]);

    const unsafeDollarPos = await svc.unsafe<{ name: string }>(
      "SELECT name FROM items WHERE qty = $1",
      [10],
    );
    expect([...unsafeDollarPos]).toEqual([{ name: "gadget" }]);

    const unsafeNamed = await svc.unsafe<{ name: string }>(
      "SELECT name FROM items WHERE name = :name",
      { ":name": "gadget" },
    );
    expect([...unsafeNamed]).toEqual([{ name: "gadget" }]);

    // Unified query() and queryOne()
    const qr = await svc.query<{ id: number; name: string }>(
      "SELECT id, name FROM items ORDER BY id ASC",
    );
    expect(qr.rows).toHaveLength(2);
    expect(qr.rowCount).toBe(2);
    expect(qr.command).toBe("SELECT");

    const one = await svc.queryOne<{ name: string }>(
      "SELECT name FROM items WHERE id = ?",
      [2],
    );
    expect(one).toEqual({ name: "gadget" });
    expect(
      await svc.queryOne("SELECT name FROM items WHERE id = ?", [999]),
    ).toBeNull();
  });

  it("propagates transactions and nested SAVEPOINTs via AsyncLocalStorage", async () => {
    const svc = await createService();

    // Helper using svc.sql directly (NOT passing tx!) automatically participates in active tx/savepoint
    const insertViaService = async (name: string, qty: number) => {
      await Bun.sleep(2);
      await svc.sql`INSERT INTO items (name, qty) VALUES (${name}, ${qty})`;
    };

    expect(svc.isInTransaction()).toBe(false);
    expect(svc.getCurrentTransaction()).toBeUndefined();

    // Commit with nested savepoint partial rollback
    const total = await svc.transaction(async (outerTx) => {
      expect(outerTx.depth).toBe(0);
      expect(outerTx.isNested).toBe(false);
      expect(svc.getCurrentTransaction()).toBe(outerTx);

      await insertViaService("outer-keep", 1);

      let caught = false;
      try {
        await svc.transaction(
          async (innerTx) => {
            expect(innerTx.depth).toBe(1);
            expect(innerTx.isNested).toBe(true);
            expect(innerTx.savepointName).toMatch(/^sp_fail_/);
            expect(svc.getCurrentTransaction()).toBe(innerTx);

            await insertViaService("inner-rollback", 99);
            throw new Error("rollback-inner");
          },
          { savepointName: "sp_fail" },
        );
      } catch (err) {
        caught = (err as Error).message === "rollback-inner";
      }
      expect(caught).toBe(true);
      expect(svc.getCurrentTransaction()).toBe(outerTx);

      await svc.unsafe("INSERT INTO items (name, qty) VALUES (?, ?)", [
        "outer-after",
        2,
      ]);

      const countRows = await svc.sql<{ cnt: number }>`SELECT COUNT(*) AS cnt FROM items`;
      return countRows[0]!.cnt;
    });

    expect(total).toBe(2);
    expect(svc.isInTransaction()).toBe(false);
    const names = (await svc.sql<{ name: string }>`SELECT name FROM items ORDER BY id`).map(
      (r) => r.name,
    );
    expect(names).toEqual(["outer-keep", "outer-after"]);

    // Full rollback on uncaught error
    await expect(
      svc.transaction(async () => {
        await insertViaService("should-not-persist", 7);
        throw new Error("abort-all");
      }),
    ).rejects.toThrow("abort-all");

    expect(svc.isInTransaction()).toBe(false);
    const afterRollback = await svc.sql<{ name: string }>`SELECT name FROM items ORDER BY id`;
    expect(afterRollback.map((r) => r.name)).toEqual([
      "outer-keep",
      "outer-after",
    ]);
  });

  it("serializes concurrent SQLite transactions safely with isolated ALS contexts", async () => {
    const svc = await createService();

    const [a, b, c] = await Promise.all([
      svc.transaction(async (tx) => {
        await svc.sql`INSERT INTO items (name, qty) VALUES (${"t1"}, ${1})`;
        await Bun.sleep(15);
        expect(svc.getCurrentTransaction()?.id).toBe(tx.id);
        return tx.id;
      }),
      svc
        .transaction(async (tx) => {
          await svc.sql`INSERT INTO items (name, qty) VALUES (${"t2_fail"}, ${2})`;
          await Bun.sleep(5);
          expect(svc.getCurrentTransaction()?.id).toBe(tx.id);
          throw new Error("t2-err");
        })
        .catch((err: Error) => err.message),
      svc.transaction(async (tx) => {
        await svc.sql`INSERT INTO items (name, qty) VALUES (${"t3"}, ${3})`;
        expect(svc.getCurrentTransaction()?.id).toBe(tx.id);
        return tx.id;
      }),
    ]);

    expect(b).toBe("t2-err");
    expect(a).not.toBe(c);

    const rows = await svc.sql<{ name: string }>`SELECT name FROM items ORDER BY id`;
    expect(rows.map((r) => r.name)).toEqual(["t1", "t3"]);
  });

  it("returns false from healthCheck() and throws on queries after close()", async () => {
    const svc = new SqlService("sqlite://:memory:");
    expect(await svc.healthCheck()).toBe(true);
    expect(svc.isClosed).toBe(false);

    await svc.close();
    await svc.close(); // idempotent

    expect(svc.isClosed).toBe(true);
    expect(await svc.healthCheck()).toBe(false);
    expect(() => svc.unsafe("SELECT 1")).toThrow(/closed/i);
  });

  it("runs dialect-agnostic migrations via SqlMigrationRunner", async () => {
    const svc = new SqlService("sqlite://:memory:");
    openServices.push(svc);

    const migrations: MigrationDefinition<SqlService>[] = [
      {
        id: "001_accounts",
        up: "CREATE TABLE accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL)",
        down: "DROP TABLE accounts",
      },
      {
        id: "002_seed_admin",
        up: async (db) => {
          await db.sql`INSERT INTO accounts (email) VALUES (${"admin@bunest.dev"})`;
        },
        down: async (db) => {
          await db.sql`DELETE FROM accounts WHERE email = ${"admin@bunest.dev"}`;
        },
      },
    ];

    const runner = new SqlMigrationRunner(svc, migrations);
    expect((await runner.status()).pending).toHaveLength(2);

    const applied = await runner.up();
    expect(applied.map((m) => m.id)).toEqual(["001_accounts", "002_seed_admin"]);
    expect(await runner.up()).toEqual([]); // idempotent

    const accounts = await svc.sql<{ email: string }>`SELECT email FROM accounts`;
    expect([...accounts]).toEqual([{ email: "admin@bunest.dev" }]);

    const reverted = await runner.down(undefined, { steps: 1 });
    expect(reverted.map((m) => m.id)).toEqual(["002_seed_admin"]);
    expect(await svc.sql`SELECT * FROM accounts`).toHaveLength(0);

    await runner.down(undefined, { all: true });
    expect((await runner.status()).applied).toHaveLength(0);
  });

  it("uses dialect-safe DDL quoting, VARCHAR(255) PK, and tagged templates for MySQL/MariaDB and PostgreSQL", async () => {
    const inspectDialect = async (adapter: "mysql" | "mariadb" | "postgres") => {
      const unsafeCalls: string[] = [];
      const identifierCalls: string[] = [];
      const taggedSqlTexts: string[] = [];

      const createMockClient = (): Bun.SQL => {
        const fn = ((first: unknown, ..._rest: unknown[]) => {
          if (typeof first === "string") {
            identifierCalls.push(first);
            return { identifier: first };
          }
          if (Array.isArray(first)) {
            const sqlText = (first as readonly string[]).join("?");
            taggedSqlTexts.push(sqlText);
            if (sqlText.includes("MAX(batch)")) {
              return Promise.resolve([{ max_batch: null }]);
            }
            return Promise.resolve([]);
          }
          return { value: first };
        }) as unknown as Bun.SQL;

        Object.defineProperty(fn, "options", {
          value: { adapter },
          configurable: true,
        });
        fn.unsafe = ((query: string) => {
          unsafeCalls.push(query);
          return Promise.resolve([]);
        }) as unknown as Bun.SQL["unsafe"];
        fn.begin = (async (cbOrOpts: unknown, maybeCb?: unknown) => {
          const cb =
            typeof cbOrOpts === "function"
              ? (cbOrOpts as (tx: Bun.SQL) => Promise<unknown>)
              : (maybeCb as (tx: Bun.SQL) => Promise<unknown>);
          return await cb(fn);
        }) as unknown as Bun.SQL["begin"];
        fn.close = (async () => {}) as unknown as Bun.SQL["close"];
        return fn;
      };

      const svc = new SqlService({ client: createMockClient() });
      const runner = new SqlMigrationRunner(svc, [
        {
          id: "001_init",
          up: async () => {},
          down: async () => {},
        },
      ]);

      await runner.up();
      await svc.close();

      return { unsafeCalls, identifierCalls, taggedSqlTexts };
    };

    // MySQL: backticks in DDL, VARCHAR(255) PRIMARY KEY, no double-quoted table names anywhere
    const mysql = await inspectDialect("mysql");
    expect(mysql.unsafeCalls.length).toBeGreaterThan(0);
    for (const q of mysql.unsafeCalls) {
      expect(q).toContain("CREATE TABLE IF NOT EXISTS `_bunest_migrations`");
      expect(q).toContain("id VARCHAR(255) PRIMARY KEY");
      expect(q).not.toContain('"_bunest_migrations"');
      expect(q).not.toContain("id TEXT PRIMARY KEY");
    }
    expect(mysql.taggedSqlTexts.some((t) => t.includes("SELECT id, name, batch, applied_at"))).toBe(true);
    expect(mysql.taggedSqlTexts.some((t) => t.includes("SELECT MAX(batch)"))).toBe(true);
    expect(mysql.taggedSqlTexts.some((t) => t.includes("INSERT INTO"))).toBe(true);
    expect(mysql.identifierCalls).toContain("_bunest_migrations");

    // MariaDB: backticks in DDL as well
    const mariadb = await inspectDialect("mariadb");
    expect(mariadb.unsafeCalls[0]).toContain("CREATE TABLE IF NOT EXISTS `_bunest_migrations`");
    expect(mariadb.unsafeCalls[0]).toContain("id VARCHAR(255) PRIMARY KEY");

    // PostgreSQL: double quotes in DDL, VARCHAR(255) PRIMARY KEY, tagged templates for queries
    const postgres = await inspectDialect("postgres");
    expect(postgres.unsafeCalls[0]).toContain('CREATE TABLE IF NOT EXISTS "_bunest_migrations"');
    expect(postgres.unsafeCalls[0]).toContain("id VARCHAR(255) PRIMARY KEY");
    expect(postgres.taggedSqlTexts.some((t) => t.includes("SELECT MAX(batch)"))).toBe(true);
  });
});

describe("SqlModule DI & Lifecycle", () => {
  it("supports forRoot, named connections, forRootAsync (useFactory/useClass/useExisting), and graceful shutdown", async () => {
    @Injectable()
    class ReportingService {
      constructor(
        private readonly primary: SqlService,
        @InjectSql("reporting") private readonly reporting: SqlService,
      ) {}

      async checkBoth() {
        return {
          primary: await this.primary.healthCheck(),
          reporting: await this.reporting.healthCheck(),
          primaryName: this.primary.connectionName,
          reportingName: this.reporting.connectionName,
        };
      }
    }

    const mod = await Test.createTestingModule({
      imports: [
        SqlModule.forRoot("sqlite://:memory:"),
        SqlModule.forRoot({ name: "reporting", url: "sqlite://:memory:" }),
      ],
      providers: [ReportingService],
    }).compile();

    await mod.init();
    const service = mod.get(ReportingService);
    expect(await service.checkBoth()).toEqual({
      primary: true,
      reporting: true,
      primaryName: "default",
      reportingName: "reporting",
    });

    const primary = mod.get(SqlService);
    await mod.close();
    expect(primary.isClosed).toBe(true);

    // forRootAsync with useFactory + global: true
    const URL_TOKEN = "SQL_URL";
    @Module({
      providers: [{ provide: URL_TOKEN, useValue: "sqlite://:memory:" }],
      exports: [URL_TOKEN],
    })
    class EnvModule {}

    @Injectable()
    class GlobalConsumer {
      constructor(@InjectSql() public readonly sql: SqlService) {}
    }

    @Module({
      providers: [GlobalConsumer],
      exports: [GlobalConsumer],
    })
    class ConsumerModule {}

    const asyncMod = await Test.createTestingModule({
      imports: [
        SqlModule.forRootAsync({
          global: true,
          imports: [EnvModule],
          inject: [URL_TOKEN],
          useFactory: async (url: string) => ({ url }),
        }),
        ConsumerModule,
      ],
    }).compile();

    await asyncMod.init();
    const consumer = asyncMod.get(GlobalConsumer);
    expect(await consumer.sql.healthCheck()).toBe(true);
    await asyncMod.close();
    expect(consumer.sql.isClosed).toBe(true);

    // forRootAsync with useClass
    @Injectable()
    class CustomSqlFactory implements SqlOptionsFactory {
      createSqlOptions(): SqlModuleForRootInput {
        return "sqlite://:memory:";
      }
    }

    const classMod = await Test.createTestingModule({
      imports: [SqlModule.forRootAsync({ useClass: CustomSqlFactory })],
    }).compile();
    await classMod.init();
    expect(await classMod.get(SqlService).healthCheck()).toBe(true);
    await classMod.close();

    // forRootAsync with useExisting
    @Module({
      providers: [CustomSqlFactory],
      exports: [CustomSqlFactory],
    })
    class FactoryHostModule {}

    const existingMod = await Test.createTestingModule({
      imports: [
        SqlModule.forRootAsync({
          imports: [FactoryHostModule],
          useExisting: CustomSqlFactory,
        }),
      ],
    }).compile();
    await existingMod.init();
    expect(await existingMod.get(SqlService).healthCheck()).toBe(true);
    await existingMod.close();
  });
});
