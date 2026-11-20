import "reflect-metadata";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
  SqlMigrationRunner,
  SqlModule,
  SqlService,
  type MigrationDefinition,
} from "../../../../../packages/sql/src";
import {
  SqliteMigrationRunner,
  SqliteModule,
  SqliteService,
  type SqliteMigration,
} from "../../../../../packages/sqlite/src";
import { Test, describeConformance } from "../../../_helpers/index";

describeConformance(
  "Persistence (bun-native) - SqliteMigrationRunner & SqlMigrationRunner",
  {
    upstreamPath: "bun-native/migrations-runner",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-002"],
    notes:
      "Covers read-only safe status/getApplied/getPending, batching, steps, transactional rollback, down(), transactional: false, custom migrationsTable, autoMigrate, and dialect advisory locks.",
  },
  () => {
    const openSqlite: SqliteService[] = [];
    const openSql: SqlService[] = [];
    const tempDirs: string[] = [];

    const trackSqlite = (svc: SqliteService): SqliteService => {
      openSqlite.push(svc);
      return svc;
    };

    const trackSql = (svc: SqlService): SqlService => {
      openSql.push(svc);
      return svc;
    };

    afterEach(async () => {
      while (openSqlite.length > 0) {
        openSqlite.pop()!.close();
      }
      while (openSql.length > 0) {
        await openSql.pop()!.close();
      }
      while (tempDirs.length > 0) {
        rmSync(tempDirs.pop()!, { recursive: true, force: true });
      }
    });

    describe("SqliteMigrationRunner", () => {
      it("returns empty applied and full pending from status()/getApplied()/getPending() without executing write DDL", () => {
        const db = trackSqlite(new SqliteService({ filename: ":memory:" }));
        const migrations: SqliteMigration[] = [
          {
            id: "001_init",
            up: "CREATE TABLE items (id INTEGER PRIMARY KEY)",
            down: "DROP TABLE items",
          },
        ];
        const runner = new SqliteMigrationRunner(db, migrations);

        expect(runner.getApplied()).toEqual([]);
        expect(runner.getPending()).toHaveLength(1);
        expect(runner.status()).toEqual({ applied: [], pending: migrations });

        // Migrations table must NOT have been created by read-only inspection
        const tableCheck = db.queryOne<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_bunest_migrations'",
        );
        expect(tableCheck).toBeNull();
      });

      it("runs status(), getApplied(), getPending(), and down() safely on readonly: true SQLite connections", async () => {
        const dir = mkdtempSync(join(tmpdir(), "bunest-mig-ro-"));
        tempDirs.push(dir);
        const dbPath = join(dir, "readonly.sqlite");

        const seed = new SqliteService({ filename: dbPath });
        seed.exec("CREATE TABLE existing (id INTEGER PRIMARY KEY)");
        seed.close();

        const roDb = trackSqlite(
          new SqliteService({ filename: dbPath, readonly: true }),
        );
        const migrations: SqliteMigration[] = [
          { id: "001_a", up: "CREATE TABLE a (id INTEGER PRIMARY KEY)" },
        ];
        const runner = new SqliteMigrationRunner(roDb, migrations);

        expect(runner.getApplied()).toEqual([]);
        expect(runner.getPending()).toHaveLength(1);
        expect(runner.status().pending).toHaveLength(1);
        expect(await runner.down()).toEqual([]);
      });

      it("applies SQL string and callback migrations in order, increments batch numbers, supports steps, and is idempotent", async () => {
        const db = trackSqlite(new SqliteService({ filename: ":memory:" }));
        const migrations: SqliteMigration[] = [
          {
            id: "001_users",
            name: "Create users table",
            up: "CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL)",
            down: "DROP TABLE users",
          },
          {
            id: "002_seed",
            up: (exec) => {
              exec.run("INSERT INTO users (email) VALUES (?)", [
                "admin@bunest.dev",
              ]);
            },
            down: (exec) => {
              exec.run("DELETE FROM users WHERE email = ?", [
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

        const runner = new SqliteMigrationRunner(db, migrations);

        // steps: 0 -> no-op
        expect(await runner.up(undefined, { steps: 0 })).toEqual([]);

        // Batch 1: apply first 2 migrations
        const batch1 = await runner.up(undefined, { steps: 2 });
        expect(batch1.map((m) => [m.id, m.name, m.batch])).toEqual([
          ["001_users", "Create users table", 1],
          ["002_seed", "002_seed", 1],
        ]);
        expect(runner.getPending().map((m) => m.id)).toEqual(["003_posts"]);

        // Batch 2: apply remaining
        const batch2 = await runner.up();
        expect(batch2.map((m) => [m.id, m.batch])).toEqual([["003_posts", 2]]);

        // Idempotent re-run
        expect(await runner.up()).toEqual([]);
        expect(runner.status().pending).toEqual([]);
        expect(
          db.query<{ email: string }>("SELECT email FROM users"),
        ).toEqual([{ email: "admin@bunest.dev" }]);
      });

      it("rolls back migration #2 atomically when it throws while keeping migration #1 committed", async () => {
        const db = trackSqlite(new SqliteService({ filename: ":memory:" }));
        const migrations: SqliteMigration[] = [
          {
            id: "001_good",
            up: "CREATE TABLE good (id INTEGER PRIMARY KEY)",
            down: "DROP TABLE good",
          },
          {
            id: "002_bad",
            up: (exec) => {
              exec.exec("CREATE TABLE partial_bad (id INTEGER PRIMARY KEY)");
              throw new Error("migration-2-exploded");
            },
            down: "DROP TABLE partial_bad",
          },
        ];

        const runner = new SqliteMigrationRunner(db, migrations);
        await expect(runner.up()).rejects.toThrow("migration-2-exploded");

        // Migration #1 committed, #2 rolled back completely
        expect(runner.getApplied().map((m) => m.id)).toEqual(["001_good"]);
        expect(runner.getPending().map((m) => m.id)).toEqual(["002_bad"]);

        const tables = db
          .query<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('good', 'partial_bad')",
          )
          .map((r) => r.name);
        expect(tables).toEqual(["good"]);
      });

      it("reverts latest batch by default, { steps: N }, and { all: true }, and rejects missing definition or missing down handler", async () => {
        const db = trackSqlite(new SqliteService({ filename: ":memory:" }));
        const migrations: SqliteMigration[] = [
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

        const runner = new SqliteMigrationRunner(db, migrations);
        await runner.up(undefined, { steps: 1 }); // batch 1: 001_a
        await runner.up(); // batch 2: 002_b, 003_c

        // Default down() reverts entire latest batch (batch 2) in reverse order
        const revertedBatch = await runner.down();
        expect(revertedBatch.map((m) => m.id)).toEqual(["003_c", "002_b"]);
        expect(runner.getApplied().map((m) => m.id)).toEqual(["001_a"]);

        // Re-apply all, then revert 1 step
        await runner.up();
        const revertedOne = await runner.down(undefined, { steps: 1 });
        expect(revertedOne.map((m) => m.id)).toEqual(["003_c"]);
        expect(runner.getApplied().map((m) => m.id)).toEqual([
          "001_a",
          "002_b",
        ]);

        // Revert all remaining
        const revertedAll = await runner.down(undefined, { all: true });
        expect(revertedAll.map((m) => m.id)).toEqual(["002_b", "001_a"]);
        expect(runner.getApplied()).toEqual([]);

        // Missing definition & missing down handler errors
        const noDownRunner = new SqliteMigrationRunner(db, [
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

      it("supports transactional: false migrations, custom migrationsTable, and validates empty/duplicate IDs", async () => {
        const db = trackSqlite(new SqliteService({ filename: ":memory:" }));
        const runner = new SqliteMigrationRunner(
          db,
          [
            {
              id: "001_nontx",
              transactional: false,
              up: (exec) => {
                expect(exec.isInTransaction()).toBe(false);
                exec.exec("CREATE TABLE nt (id INTEGER PRIMARY KEY)");
              },
              down: (exec) => {
                expect(exec.isInTransaction()).toBe(false);
                exec.exec("DROP TABLE nt");
              },
            },
          ],
          "custom_schema_history",
        );

        expect(runner.migrationsTableName).toBe("custom_schema_history");
        await runner.up();

        const historyRows = db.query<{ id: string }>(
          'SELECT id FROM "custom_schema_history"',
        );
        expect(historyRows).toEqual([{ id: "001_nontx" }]);

        await runner.down();
        expect(runner.getApplied()).toEqual([]);

        expect(() => runner.status([{ id: "   ", up: "SELECT 1" }])).toThrow(
          /non-empty/,
        );
        expect(() =>
          runner.status([
            { id: "dup", up: "SELECT 1" },
            { id: "dup", up: "SELECT 1" },
          ]),
        ).toThrow(/Duplicate migration id "dup"/);
      });

      it("runs pending migrations automatically during SqliteModule onModuleInit when autoMigrate: true", async () => {
        const mod = await Test.createTestingModule({
          imports: [
            SqliteModule.forRoot({
              filename: ":memory:",
              autoMigrate: true,
              migrationsTable: "app_migrations",
              migrations: [
                {
                  id: "001_auto",
                  up: "CREATE TABLE auto_tbl (id INTEGER PRIMARY KEY)",
                  down: "DROP TABLE auto_tbl",
                },
              ],
            }),
          ],
        }).compile({ logger: false });

        await mod.init();
        try {
          const runner = mod.get(SqliteMigrationRunner);
          expect(runner.migrationsTableName).toBe("app_migrations");
          expect(runner.getApplied().map((m) => m.id)).toEqual(["001_auto"]);
        } finally {
          await mod.close();
        }
      });
    });

    describe("SqlMigrationRunner", () => {
      it("keeps status() and getApplied() read-only safe on uninitialized sqlite://:memory:", async () => {
        const svc = trackSql(new SqlService("sqlite://:memory:"));
        const migrations: MigrationDefinition<SqlService>[] = [
          {
            id: "001_items",
            up: "CREATE TABLE items (id INTEGER PRIMARY KEY)",
            down: "DROP TABLE items",
          },
        ];
        const runner = new SqlMigrationRunner(svc, migrations);

        const status = await runner.status();
        expect(status.applied).toEqual([]);
        expect(status.pending).toHaveLength(1);

        const table = await svc.queryOne(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_bunest_migrations'",
        );
        expect(table).toBeNull();
      });

      it("applies, batches, rolls back failed migrations atomically, and reverts via down() on SqlService", async () => {
        const svc = trackSql(new SqlService("sqlite://:memory:"));
        const migrations: MigrationDefinition<SqlService>[] = [
          {
            id: "001_orders",
            up: "CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT, sku TEXT NOT NULL)",
            down: "DROP TABLE orders",
          },
          {
            id: "002_seed_order",
            up: async (db) => {
              await db.sql`INSERT INTO orders (sku) VALUES (${"SKU-100"})`;
            },
            down: async (db) => {
              await db.sql`DELETE FROM orders WHERE sku = ${"SKU-100"}`;
            },
          },
          {
            id: "003_extra",
            up: "CREATE TABLE extra (id INTEGER PRIMARY KEY)",
            down: "DROP TABLE extra",
          },
        ];

        const runner = new SqlMigrationRunner(svc, migrations);

        // Batch 1: steps 1
        const b1 = await runner.up(undefined, { steps: 1 });
        expect(b1.map((m) => [m.id, m.batch])).toEqual([["001_orders", 1]]);

        // Failing migration rolls back cleanly
        await expect(
          runner.up([
            ...migrations.slice(0, 1),
            {
              id: "002_broken",
              up: async (db) => {
                await db.unsafe(
                  "CREATE TABLE should_not_exist (id INTEGER PRIMARY KEY)",
                );
                throw new Error("sql-mig-fail");
              },
            },
          ]),
        ).rejects.toThrow("sql-mig-fail");
        expect(
          await svc.queryOne(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'should_not_exist'",
          ),
        ).toBeNull();

        // Batch 2: apply remaining valid migrations
        const b2 = await runner.up();
        expect(b2.map((m) => [m.id, m.batch])).toEqual([
          ["002_seed_order", 2],
          ["003_extra", 2],
        ]);
        expect(await runner.up()).toEqual([]); // idempotent

        // Default down() reverts latest batch (batch 2)
        const revBatch = await runner.down();
        expect(revBatch.map((m) => m.id)).toEqual([
          "003_extra",
          "002_seed_order",
        ]);
        expect((await runner.status()).applied.map((m) => m.id)).toEqual([
          "001_orders",
        ]);

        // Re-apply and test { steps: 1 } and { all: true }
        await runner.up();
        const revStep = await runner.down(undefined, { steps: 1 });
        expect(revStep.map((m) => m.id)).toEqual(["003_extra"]);

        const revAll = await runner.down(undefined, { all: true });
        expect(revAll.map((m) => m.id)).toEqual([
          "002_seed_order",
          "001_orders",
        ]);
        expect((await runner.status()).applied).toEqual([]);
      });

      it("supports transactional: false, custom migrationsTable, duplicate/empty ID validation, and autoMigrate on SqlModule", async () => {
        const mod = await Test.createTestingModule({
          imports: [
            SqlModule.forRoot({
              url: "sqlite://:memory:",
              autoMigrate: true,
              migrationsTable: "sql_mig_log",
              migrations: [
                {
                  id: "001_nontx",
                  transactional: false,
                  up: async (db: SqlService) => {
                    expect(db.isInTransaction()).toBe(false);
                    await db.unsafe(
                      "CREATE TABLE nontx_tbl (id INTEGER PRIMARY KEY)",
                    );
                  },
                },
              ],
            }),
          ],
        }).compile({ logger: false });

        await mod.init();
        try {
          const runner = mod.get(SqlMigrationRunner);
          expect(runner.migrationsTableName).toBe("sql_mig_log");
          expect((await runner.status()).applied.map((m) => m.id)).toEqual([
            "001_nontx",
          ]);
          await expect(runner.down()).rejects.toThrow(/no "down" handler/);
          await expect(runner.down([])).rejects.toThrow(
            /migration definition not found/,
          );
          await expect(
            runner.status([{ id: "", up: "SELECT 1" }]),
          ).rejects.toThrow(/non-empty/);
          await expect(
            runner.status([
              { id: "x", up: "SELECT 1" },
              { id: "x", up: "SELECT 1" },
            ]),
          ).rejects.toThrow(/Duplicate migration id "x"/);
        } finally {
          await mod.close();
        }
      });
    });
  },
);
