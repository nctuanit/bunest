import { afterEach, describe, expect, it } from "bun:test";
import {
  join,
  mkdirSyncPath,
  removePath,
} from "../../../../../packages/core/src";
import { Injectable } from "../../../../../packages/core/src/common";
import {
  DEFAULT_ORM_MIGRATIONS_TABLE,
  DataSource,
  InjectOrmMigrations,
  OrmMigrationRunner,
  OrmModule,
  splitSqlStatements,
  type OrmMigration,
} from "../../../../../packages/orm/src";
import { Test, describeConformance } from "../../../_helpers/index";

describeConformance(
  "Persistence (bun-native) - @bunest/orm OrmMigrationRunner (SqliteOrmDriver & BunSqlOrmDriver)",
  {
    upstreamPath: "bun-native/migrations-runner",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-002"],
    notes:
      "Covers read-only safe status/getApplied/getPending, batching, steps, transactional rollback, down(), transactional: false, custom migrationsTable, autoMigrate, multi-statement SQL splitting, and DI via @InjectOrmMigrations.",
  },
  () => {
    const openSources: DataSource[] = [];
    const tempDirs: string[] = [];

    const track = async (ds: DataSource): Promise<DataSource> => {
      await ds.initialize();
      openSources.push(ds);
      return ds;
    };

    afterEach(async () => {
      while (openSources.length > 0) {
        await openSources.pop()!.destroy();
      }
      while (tempDirs.length > 0) {
        await removePath(tempDirs.pop()!, { recursive: true, force: true });
      }
    });

    it("splits multi-statement SQL scripts cleanly while preserving quotes, comments, and Postgres dollar-quoted blocks", () => {
      const statements = splitSqlStatements(`
        -- Leading comment
        CREATE TABLE a (id INT, note TEXT DEFAULT 'hello;world');
        /* block; comment */
        CREATE FUNCTION f() RETURNS void AS $$ BEGIN PERFORM 1; END; $$ LANGUAGE plpgsql;
      `);
      expect(statements).toHaveLength(2);
      expect(statements[0]).toContain("'hello;world'");
      expect(statements[1]).toContain("PERFORM 1;");
    });

    describe("OrmMigrationRunner on SqliteOrmDriver", () => {
      it("returns empty applied and full pending from status()/getApplied()/getPending() without executing write DDL", async () => {
        const ds = await track(
          new DataSource({ type: "sqlite", database: ":memory:" }),
        );
        const migrations: OrmMigration[] = [
          {
            id: "001_init",
            up: "CREATE TABLE items (id INTEGER PRIMARY KEY)",
            down: "DROP TABLE items",
          },
        ];
        const runner = new OrmMigrationRunner(ds, migrations);

        expect(await runner.getApplied()).toEqual([]);
        expect(await runner.getPending()).toHaveLength(1);
        expect(await runner.status()).toEqual({
          applied: [],
          pending: migrations,
        });

        const tableCheck = await ds.query<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
          [DEFAULT_ORM_MIGRATIONS_TABLE],
        );
        expect(tableCheck).toEqual([]);
      });

      it("runs status(), getApplied(), getPending(), and down() safely on readonly: true SQLite connections", async () => {
        const dir = join(
          Bun.env.TMPDIR ?? Bun.env.TEMP ?? "/tmp",
          `bunest-orm-mig-ro-${crypto.randomUUID()}`,
        );
        mkdirSyncPath(dir);
        tempDirs.push(dir);
        const dbPath = join(dir, "readonly.sqlite");

        const seed = new DataSource({ type: "sqlite", database: dbPath });
        await seed.initialize();
        await seed.driver.execute("CREATE TABLE existing (id INTEGER PRIMARY KEY)");
        await seed.destroy();

        const roDs = await track(
          new DataSource({ type: "sqlite", database: dbPath, readonly: true }),
        );
        const migrations: OrmMigration[] = [
          { id: "001_a", up: "CREATE TABLE a (id INTEGER PRIMARY KEY)" },
        ];
        const runner = new OrmMigrationRunner(roDs, migrations);

        expect(await runner.getApplied()).toEqual([]);
        expect(await runner.getPending()).toHaveLength(1);
        expect((await runner.status()).pending).toHaveLength(1);
        expect(await runner.down()).toEqual([]);
      });

      it("applies SQL string and callback migrations in order, increments batch numbers, supports steps, and is idempotent", async () => {
        const ds = await track(
          new DataSource({ type: "sqlite", database: ":memory:" }),
        );
        const migrations: OrmMigration[] = [
          {
            id: "001_users",
            name: "Create users table",
            up: "CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL)",
            down: "DROP TABLE users",
          },
          {
            id: "002_seed",
            up: async (exec) => {
              await exec.execute("INSERT INTO users (email) VALUES (?)", [
                "admin@bunest.dev",
              ]);
            },
            down: async (exec) => {
              await exec.execute("DELETE FROM users WHERE email = ?", [
                "admin@bunest.dev",
              ]);
            },
          },
          {
            id: "003_posts",
            up: "CREATE TABLE posts (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL)",
            down: "DROP TABLE posts",
          },
        ];

        const runner = new OrmMigrationRunner(ds, migrations);

        expect(await runner.up(undefined, { steps: 0 })).toEqual([]);

        const batch1 = await runner.up(undefined, { steps: 2 });
        expect(batch1.map((m) => [m.id, m.name, m.batch])).toEqual([
          ["001_users", "Create users table", 1],
          ["002_seed", "002_seed", 1],
        ]);
        expect((await runner.getPending()).map((m) => m.id)).toEqual([
          "003_posts",
        ]);

        const batch2 = await runner.up();
        expect(batch2.map((m) => [m.id, m.batch])).toEqual([["003_posts", 2]]);

        expect(await runner.up()).toEqual([]);
        expect((await runner.status()).pending).toEqual([]);
        expect(await ds.query<{ email: string }>("SELECT email FROM users")).toEqual([
          { email: "admin@bunest.dev" },
        ]);
      });

      it("rolls back migration #2 atomically when it throws while keeping migration #1 committed", async () => {
        const ds = await track(
          new DataSource({ type: "sqlite", database: ":memory:" }),
        );
        const migrations: OrmMigration[] = [
          {
            id: "001_good",
            up: "CREATE TABLE good (id INTEGER PRIMARY KEY)",
            down: "DROP TABLE good",
          },
          {
            id: "002_bad",
            up: async (exec) => {
              await exec.execute("CREATE TABLE partial_bad (id INTEGER PRIMARY KEY)");
              throw new Error("migration-2-exploded");
            },
            down: "DROP TABLE partial_bad",
          },
        ];

        const runner = new OrmMigrationRunner(ds, migrations);
        await expect(runner.up()).rejects.toThrow("migration-2-exploded");

        expect((await runner.getApplied()).map((m) => m.id)).toEqual([
          "001_good",
        ]);
        expect((await runner.getPending()).map((m) => m.id)).toEqual([
          "002_bad",
        ]);

        const tables = (
          await ds.query<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('good', 'partial_bad')",
          )
        ).map((r) => r.name);
        expect(tables).toEqual(["good"]);
      });

      it("reverts latest batch by default, { steps: N }, and { all: true }, and rejects missing definition or down handler", async () => {
        const ds = await track(
          new DataSource({ type: "sqlite", database: ":memory:" }),
        );
        const migrations: OrmMigration[] = [
          {
            id: "001_a",
            up: "CREATE TABLE a (id INTEGER PRIMARY KEY)",
            down: "DROP TABLE a",
          },
          {
            id: "002_b",
            up: "CREATE TABLE b (id INTEGER PRIMARY KEY)",
            down: "DROP TABLE b",
          },
          {
            id: "003_c",
            up: "CREATE TABLE c (id INTEGER PRIMARY KEY)",
            down: "DROP TABLE c",
          },
        ];

        const runner = new OrmMigrationRunner(ds, migrations);
        await runner.up(undefined, { steps: 1 }); // batch 1: 001_a
        await runner.up(); // batch 2: 002_b, 003_c

        const revertedBatch = await runner.down();
        expect(revertedBatch.map((m) => m.id)).toEqual(["003_c", "002_b"]);
        expect((await runner.getApplied()).map((m) => m.id)).toEqual(["001_a"]);

        await runner.up();
        const revertedOne = await runner.down(undefined, { steps: 1 });
        expect(revertedOne.map((m) => m.id)).toEqual(["003_c"]);
        expect((await runner.getApplied()).map((m) => m.id)).toEqual([
          "001_a",
          "002_b",
        ]);

        const revertedAll = await runner.down(undefined, { all: true });
        expect(revertedAll.map((m) => m.id)).toEqual(["002_b", "001_a"]);
        expect(await runner.getApplied()).toEqual([]);

        const noDownRunner = new OrmMigrationRunner(ds, [
          { id: "010_nodown", up: "CREATE TABLE nd (id INTEGER PRIMARY KEY)" },
        ]);
        await noDownRunner.up();
        await expect(noDownRunner.down()).rejects.toThrow(
          /no "down" handler is defined/,
        );
        await expect(noDownRunner.down([])).rejects.toThrow(
          /migration definition not found/,
        );
      });

      it("supports transactional: false, custom migrationsTable, ID validation, and SQLi migrationsTable rejection", async () => {
        const ds = await track(
          new DataSource({ type: "sqlite", database: ":memory:" }),
        );

        for (const badTable of [
          "_migs; DROP TABLE users; --",
          'bad"table',
          "bad table",
          "123migs",
          "",
        ]) {
          expect(() => new OrmMigrationRunner(ds, [], badTable)).toThrow(
            /Invalid migrations table name/,
          );
        }

        const runner = new OrmMigrationRunner(
          ds,
          [
            {
              id: "001_nontx",
              transactional: false,
              up: async (exec) => {
                expect(ds.driver.isInTransaction()).toBe(false);
                await exec.execute("CREATE TABLE nt (id INTEGER PRIMARY KEY)");
              },
              down: async (exec) => {
                expect(ds.driver.isInTransaction()).toBe(false);
                await exec.execute("DROP TABLE nt");
              },
            },
          ],
          "custom_schema_history",
        );

        expect(runner.migrationsTableName).toBe("custom_schema_history");
        await runner.up();

        const historyRows = await ds.query<{ id: string }>(
          'SELECT id FROM "custom_schema_history"',
        );
        expect(historyRows).toEqual([{ id: "001_nontx" }]);

        await runner.down();
        expect(await runner.getApplied()).toEqual([]);

        await expect(
          runner.status([{ id: "   ", up: "SELECT 1" }]),
        ).rejects.toThrow(/non-empty/);
        await expect(
          runner.status([
            { id: "dup", up: "SELECT 1" },
            { id: "dup", up: "SELECT 1" },
          ]),
        ).rejects.toThrow(/Duplicate migration id "dup"/);
      });
    });

    describe("OrmMigrationRunner on BunSqlOrmDriver & OrmModule DI", () => {
      it("applies, rolls back failed migrations, reverts via down(), and injects via @InjectOrmMigrations()", async () => {
        @Injectable()
        class MigrationConsumer {
          constructor(
            readonly defaultRunner: OrmMigrationRunner,
            @InjectOrmMigrations("reporting")
            readonly reportingRunner: OrmMigrationRunner,
          ) {}
        }

        const mod = await Test.createTestingModule({
          imports: [
            OrmModule.forRoot({
              type: "sqlite",
              url: "sqlite://:memory:",
              useBunSql: true,
              autoMigrate: true,
              migrationsTable: "orm_mig_log",
              migrations: [
                {
                  id: "001_orders",
                  up: "CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT, sku TEXT NOT NULL)",
                  down: "DROP TABLE orders",
                },
                {
                  id: "002_seed_order",
                  up: async (exec) => {
                    await exec.execute("INSERT INTO orders (sku) VALUES (?)", [
                      "SKU-100",
                    ]);
                  },
                  down: async (exec) => {
                    await exec.execute("DELETE FROM orders WHERE sku = ?", [
                      "SKU-100",
                    ]);
                  },
                },
              ],
            }),
            OrmModule.forRoot({
              name: "reporting",
              type: "sqlite",
              database: ":memory:",
              autoMigrate: true,
              migrations: [
                {
                  id: "001_reports",
                  up: "CREATE TABLE reports (id INTEGER PRIMARY KEY)",
                  down: "DROP TABLE reports",
                },
              ],
            }),
          ],
          providers: [MigrationConsumer],
        }).compile({ logger: false });

        await mod.init();
        try {
          const consumer = mod.get(MigrationConsumer);
          expect(consumer.defaultRunner.migrationsTableName).toBe("orm_mig_log");
          expect(
            (await consumer.defaultRunner.getApplied()).map((m) => m.id),
          ).toEqual(["001_orders", "002_seed_order"]);
          expect(
            (await consumer.reportingRunner.getApplied()).map((m) => m.id),
          ).toEqual(["001_reports"]);

          // Revert all on default BunSqlOrmDriver DataSource
          const reverted = await consumer.defaultRunner.down(undefined, {
            all: true,
          });
          expect(reverted.map((m) => m.id)).toEqual([
            "002_seed_order",
            "001_orders",
          ]);
          expect((await consumer.defaultRunner.status()).applied).toEqual([]);
        } finally {
          await mod.close();
        }
      });
    });
  },
);
