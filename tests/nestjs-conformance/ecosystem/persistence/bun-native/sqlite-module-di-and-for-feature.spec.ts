import "reflect-metadata";
import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "bun:test";
import { Injectable, Module } from "../../../../../packages/common/src";
import {
  BaseSqliteRepository,
  DuplicateSqliteConnectionException,
  InjectSqlite,
  InjectSqliteMigrations,
  InjectSqliteRepository,
  SqliteEntity,
  SqliteMigrationRunner,
  SqliteModule,
  SqliteService,
  getSqliteConnectionToken,
  getSqliteMigrationRunnerToken,
  getSqliteOptionsToken,
  getSqliteRepositoryToken,
  type SqliteModuleOptions,
  type SqliteOptionsFactory,
  type SqliteQueryEvent,
} from "../../../../../packages/sqlite/src";
import { Test, describeConformance } from "../../../_helpers/index";

interface ItemRow extends Record<string, unknown> {
  id: number;
  code: string;
  label: string;
}

describeConformance(
  "Persistence (bun-native) - SqliteModule DI, forFeature, PRAGMAs & native power features",
  {
    upstreamPath: "bun-native/sqlite-module-di-and-for-feature",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-002", "ADR-007"],
    notes:
      "Bun-native conformance for @bunest/sqlite module registration, forRootMultiple, forFeature target forms, PRAGMA enforcement, handle safety, and adapter bridge.",
  },
  () => {
    const openServices: SqliteService[] = [];
    const tempDirs: string[] = [];

    const track = (svc: SqliteService): SqliteService => {
      openServices.push(svc);
      return svc;
    };

    const makeTempDir = (prefix: string): string => {
      const dir = mkdtempSync(join(tmpdir(), prefix));
      tempDirs.push(dir);
      return dir;
    };

    afterEach(() => {
      while (openServices.length > 0) {
        openServices.pop()!.close();
      }
      while (tempDirs.length > 0) {
        rmSync(tempDirs.pop()!, { recursive: true, force: true });
      }
    });

    it("derives deterministic DI tokens for connection, options, migration runner, and repositories", () => {
      class UserEntity {}

      expect(getSqliteConnectionToken()).toBe(
        "bunest:sqlite:connection:default",
      );
      expect(getSqliteConnectionToken("read")).toBe(
        "bunest:sqlite:connection:read",
      );
      expect(getSqliteOptionsToken()).toBe("bunest:sqlite:options:default");
      expect(getSqliteOptionsToken("read")).toBe("bunest:sqlite:options:read");
      expect(getSqliteMigrationRunnerToken()).toBe(
        "bunest:sqlite:migrations:default",
      );
      expect(getSqliteMigrationRunnerToken("read")).toBe(
        "bunest:sqlite:migrations:read",
      );
      expect(getSqliteRepositoryToken("users")).toBe(
        "bunest:sqlite:repository:default:users",
      );
      expect(getSqliteRepositoryToken(UserEntity, "read")).toBe(
        "bunest:sqlite:repository:read:UserEntity",
      );
    });

    it("registers default SqliteService & SqliteMigrationRunner globally via SqliteModule.forRoot()", async () => {
      @Injectable()
      class Consumer {
        constructor(
          readonly sqlite: SqliteService,
          readonly migrations: SqliteMigrationRunner,
        ) {}
      }

      @Module({
        providers: [Consumer],
        exports: [Consumer],
      })
      class ConsumerModule {}

      const mod = await Test.createTestingModule({
        imports: [SqliteModule.forRoot({ filename: ":memory:" }), ConsumerModule],
      }).compile({ logger: false });
      await mod.init();

      try {
        const consumer = mod.get(Consumer);
        expect(consumer.sqlite.healthCheck()).toBe(true);
        expect(consumer.migrations).toBeInstanceOf(SqliteMigrationRunner);
      } finally {
        await mod.close();
      }
    });

    it("respects global: false opt-out on SqliteModule.forRoot()", async () => {
      @Injectable()
      class IsolatedConsumer {
        constructor(readonly sqlite: SqliteService) {}
      }

      @Module({
        providers: [IsolatedConsumer],
        exports: [IsolatedConsumer],
      })
      class IsolatedModule {}

      await expect(
        Test.createTestingModule({
          imports: [
            SqliteModule.forRoot({ filename: ":memory:", global: false }),
            IsolatedModule,
          ],
        }).compile({ logger: false }),
      ).rejects.toThrow();
    });

    it("registers multiple named connections via SqliteModule.forRootMultiple()", async () => {
      @Injectable()
      class MultiConsumer {
        constructor(
          @InjectSqlite() readonly primary: SqliteService,
          @InjectSqlite("analytics") readonly analytics: SqliteService,
          @InjectSqliteMigrations("analytics")
          readonly analyticsMigrations: SqliteMigrationRunner,
        ) {}
      }

      const mod = await Test.createTestingModule({
        imports: [
          SqliteModule.forRootMultiple([
            { filename: ":memory:" },
            { name: "analytics", filename: ":memory:" },
          ]),
        ],
        providers: [MultiConsumer],
      }).compile({ logger: false });
      await mod.init();

      try {
        const consumer = mod.get(MultiConsumer);
        expect(consumer.primary.connectionName).toBe("default");
        expect(consumer.analytics.connectionName).toBe("analytics");
        expect(consumer.primary).not.toBe(consumer.analytics);
        expect(consumer.analyticsMigrations).toBeInstanceOf(
          SqliteMigrationRunner,
        );
      } finally {
        await mod.close();
      }
    });

    it("rejects duplicate connection names in SqliteModule.forRootMultiple() with DuplicateSqliteConnectionException", () => {
      expect(() =>
        SqliteModule.forRootMultiple([
          { name: "dup", filename: ":memory:" },
          { name: "dup", filename: ":memory:" },
        ]),
      ).toThrow(DuplicateSqliteConnectionException);

      // Implicit "default" duplicate
      try {
        SqliteModule.forRootMultiple([
          { filename: ":memory:" },
          { name: "default", filename: ":memory:" },
        ]);
        throw new Error("Expected DuplicateSqliteConnectionException");
      } catch (err) {
        expect(err).toBeInstanceOf(DuplicateSqliteConnectionException);
        expect((err as DuplicateSqliteConnectionException).connectionName).toBe(
          "default",
        );
      }
    });

    it("supports SqliteModule.forRootAsync() with useFactory, useClass, useExisting, and extraProviders", async () => {
      const PATH_TOKEN = "SQLITE_PATH";

      // 1. useFactory + extraProviders
      const modFactory = await Test.createTestingModule({
        imports: [
          SqliteModule.forRootAsync({
            extraProviders: [{ provide: PATH_TOKEN, useValue: ":memory:" }],
            inject: [PATH_TOKEN],
            useFactory: async (filename: string) => ({ filename }),
          }),
        ],
      }).compile({ logger: false });
      await modFactory.init();
      expect(modFactory.get(SqliteService).healthCheck()).toBe(true);
      await modFactory.close();

      // 2. useClass
      @Injectable()
      class MySqliteOptionsFactory implements SqliteOptionsFactory {
        createSqliteOptions(): SqliteModuleOptions {
          return { filename: ":memory:", busyTimeout: 1234 };
        }
      }

      const modClass = await Test.createTestingModule({
        imports: [
          SqliteModule.forRootAsync({ useClass: MySqliteOptionsFactory }),
        ],
      }).compile({ logger: false });
      await modClass.init();
      const timeoutRow = modClass
        .get(SqliteService)
        .queryOne<{ timeout: number }>("PRAGMA busy_timeout");
      expect(timeoutRow?.timeout).toBe(1234);
      await modClass.close();

      // 3. useExisting
      @Module({
        providers: [MySqliteOptionsFactory],
        exports: [MySqliteOptionsFactory],
      })
      class FactoryModule {}

      const modExisting = await Test.createTestingModule({
        imports: [
          SqliteModule.forRootAsync({
            imports: [FactoryModule],
            useExisting: MySqliteOptionsFactory,
          }),
        ],
      }).compile({ logger: false });
      await modExisting.init();
      expect(modExisting.get(SqliteService).healthCheck()).toBe(true);
      await modExisting.close();
    });

    it("rejects missing strategy or conflicting connection name in SqliteModule.forRootAsync()", async () => {
      expect(() => SqliteModule.forRootAsync({})).toThrow(
        /requires one of "useFactory", "useClass", or "useExisting"/,
      );

      await expect(
        Test.createTestingModule({
          imports: [
            SqliteModule.forRootAsync({
              name: "primary",
              useFactory: () => ({ name: "wrong", filename: ":memory:" }),
            }),
          ],
        }).compile({ logger: false }),
      ).rejects.toThrow(/conflicting connection name "wrong"/);
    });

    it("registers all 4 SqliteModule.forFeature() target forms: string, @SqliteEntity(), BaseSqliteRepository subclass, and config object", async () => {
      @SqliteEntity("items", "code")
      class ItemEntity {}

      class PlainEntity {}

      class CustomItemsRepo extends BaseSqliteRepository<ItemRow, number> {
        constructor(sqlite: SqliteService) {
          super(sqlite, "items");
        }

        findByCode(code: string): ItemRow | null {
          return this.findOneWhere({ code });
        }
      }

      const CUSTOM_CONFIG_TOKEN = "CUSTOM_ITEMS_REPO_TOKEN";

      @Injectable()
      class FeatureConsumer {
        constructor(
          @InjectSqliteRepository("items")
          readonly byTable: BaseSqliteRepository<ItemRow, number>,
          @InjectSqliteRepository(ItemEntity)
          readonly byEntity: BaseSqliteRepository<ItemRow, string>,
          @InjectSqliteRepository(PlainEntity)
          readonly byPlain: BaseSqliteRepository<Record<string, unknown>, number>,
          readonly bySubclassDirect: CustomItemsRepo,
          @InjectSqliteRepository(CustomItemsRepo)
          readonly bySubclassToken: CustomItemsRepo,
          @InjectSqliteRepository("items", "secondary")
          readonly secondaryTable: BaseSqliteRepository<ItemRow, number>,
        ) {}
      }

      const mod = await Test.createTestingModule({
        imports: [
          SqliteModule.forRootMultiple([
            {
              filename: ":memory:",
              autoMigrate: true,
              migrations: [
                {
                  id: "001_schema",
                  up: `
                    CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE NOT NULL, label TEXT NOT NULL);
                    CREATE TABLE plainentity (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL);
                  `,
                },
              ],
            },
            {
              name: "secondary",
              filename: ":memory:",
              autoMigrate: true,
              migrations: [
                {
                  id: "001_secondary",
                  up: "CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE NOT NULL, label TEXT NOT NULL)",
                },
              ],
            },
          ]),
          SqliteModule.forFeature([
            "items",
            ItemEntity,
            PlainEntity,
            CustomItemsRepo,
            {
              table: "items",
              idColumn: "code",
              token: CUSTOM_CONFIG_TOKEN,
            },
          ]),
          SqliteModule.forFeature(["items"], "secondary"),
        ],
        providers: [FeatureConsumer],
      }).compile({ logger: false });
      await mod.init();

      try {
        const consumer = mod.get(FeatureConsumer);
        expect(consumer.bySubclassDirect).toBe(consumer.bySubclassToken);
        expect(consumer.byEntity.primaryKeyColumn).toBe("code");
        expect(consumer.byPlain.table).toBe("plainentity");

        const customTokenRepo = mod.get<BaseSqliteRepository<ItemRow, string>>(
          CUSTOM_CONFIG_TOKEN,
        );
        expect(customTokenRepo.primaryKeyColumn).toBe("code");

        consumer.byTable.insert({ code: "A1", label: "Alpha" });
        expect(consumer.byEntity.findById("A1")?.label).toBe("Alpha");
        expect(consumer.bySubclassDirect.findByCode("A1")?.label).toBe("Alpha");
        expect(customTokenRepo.findById("A1")?.label).toBe("Alpha");

        // Secondary connection is isolated
        expect(consumer.secondaryTable.count()).toBe(0);
        consumer.secondaryTable.insert({ code: "S1", label: "Secondary" });
        expect(consumer.secondaryTable.count()).toBe(1);
        expect(consumer.byTable.count()).toBe(1);
      } finally {
        await mod.close();
      }
    });

    it("rejects duplicate feature repository tokens within a single SqliteModule.forFeature() call", () => {
      expect(() => SqliteModule.forFeature(["items", "items"])).toThrow(
        /Duplicate SQLite feature repository token/,
      );
    });

    it("applies busyTimeout, foreignKeys (enforced), WAL on file DB, and custom PRAGMAs", () => {
      const dir = makeTempDir("bunest-sqlite-pragmas-");
      const dbPath = join(dir, "app.sqlite");

      const db = track(
        new SqliteService({
          filename: dbPath,
          busyTimeout: 3200,
          foreignKeys: true,
          wal: true,
          pragmas: {
            synchronous: "NORMAL",
            cache_size: -2000,
            temp_store: 2,
          },
        }),
      );

      expect(db.queryValue<number>("PRAGMA busy_timeout")).toBe(3200);
      expect(db.queryValue<number>("PRAGMA foreign_keys")).toBe(1);
      expect(
        String(db.queryValue<string>("PRAGMA journal_mode")).toLowerCase(),
      ).toBe("wal");
      expect(db.queryValue<number>("PRAGMA cache_size")).toBe(-2000);
      expect(db.queryValue<number>("PRAGMA temp_store")).toBe(2);

      // Verify foreign key constraint enforcement actually blocks orphan inserts
      db.exec(`
        CREATE TABLE parents (id INTEGER PRIMARY KEY);
        CREATE TABLE children (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parents(id));
      `);
      expect(() =>
        db.run("INSERT INTO children (id, parent_id) VALUES (?, ?)", [1, 999]),
      ).toThrow(/FOREIGN KEY/i);

      // foreignKeys: false disables enforcement
      const noFk = track(
        new SqliteService({ filename: ":memory:", foreignKeys: false }),
      );
      expect(noFk.queryValue<number>("PRAGMA foreign_keys")).toBe(0);
    });

    it("rejects readonly: true combined with autoMigrate: true", () => {
      expect(
        () =>
          new SqliteService({
            filename: ":memory:",
            readonly: true,
            autoMigrate: true,
            migrations: [{ id: "001", up: "CREATE TABLE t (id INTEGER)" }],
          }),
      ).toThrow(/cannot enable "autoMigrate" when "readonly" is true/);
    });

    it("closes file handles cleanly without leaks when PRAGMA or busyTimeout validation fails in constructor", () => {
      const dir = makeTempDir("bunest-sqlite-noleak-");
      const dbPath = join(dir, "bad-pragma.sqlite");

      expect(
        () =>
          new SqliteService({
            filename: dbPath,
            pragmas: { journal_mode: "WAL; DROP TABLE x" },
          }),
      ).toThrow(/disallowed characters/);

      if (existsSync(dbPath)) {
        unlinkSync(dbPath);
      }
      expect(existsSync(dbPath)).toBe(false);

      expect(
        () =>
          new SqliteService({
            filename: dbPath,
            busyTimeout: -1,
          }),
      ).toThrow(/Invalid busyTimeout/);

      if (existsSync(dbPath)) {
        unlinkSync(dbPath);
      }
      expect(existsSync(dbPath)).toBe(false);
    });

    it("bridges SqliteService.toDatabaseAdapter() structurally to DatabaseAdapter contract", async () => {
      const db = track(
        new SqliteService({ name: "bridge", filename: ":memory:" }),
      );
      db.exec(
        "CREATE TABLE logs (id INTEGER PRIMARY KEY AUTOINCREMENT, msg TEXT NOT NULL)",
      );

      const adapter = db.toDatabaseAdapter();
      expect(adapter.connectionName).toBe("bridge");
      expect(adapter.isClosed).toBe(false);
      expect(adapter.healthCheck()).toBe(true);

      const ins = adapter.query("INSERT INTO logs (msg) VALUES (?)", ["hello"]);
      expect(ins.affectedRows).toBe(1);
      expect(ins.rowCount).toBe(1);
      expect(ins.lastInsertRowid).toBe(1);
      expect(ins.command).toBe("INSERT");

      const ret = adapter.query<{ id: number; msg: string }>(
        "INSERT INTO logs (msg) VALUES (?) RETURNING id, msg",
        ["world"],
      );
      expect(ret.rows).toEqual([{ id: 2, msg: "world" }]);
      expect(ret.rowCount).toBe(1);

      const sel = adapter.query<{ msg: string }>(
        "SELECT msg FROM logs ORDER BY id ASC",
      );
      expect(sel.rows).toEqual([{ msg: "hello" }, { msg: "world" }]);
      expect(sel.rowCount).toBe(2);
      expect(sel.command).toBe("SELECT");

      await adapter.transaction(async (tx) => {
        expect(tx.connectionName).toBe("bridge");
        expect(tx.depth).toBe(0);
        expect(tx.client).toBe(db.raw);
        expect(adapter.getCurrentTransaction()?.id).toBe(tx.id);
        adapter.query("INSERT INTO logs (msg) VALUES (?)", ["in-tx"]);
      });
      expect(adapter.getCurrentTransaction()).toBeUndefined();
      expect(
        adapter.query("SELECT * FROM logs").rowCount,
      ).toBe(3);

      adapter.close();
      expect(adapter.isClosed).toBe(true);
      expect(db.isClosed).toBe(true);
      expect(adapter.healthCheck()).toBe(false);
    });

    it("exports an in-memory Uint8Array snapshot via serialize() that can be deserialized", () => {
      const db = track(new SqliteService({ filename: ":memory:" }));
      db.exec("CREATE TABLE snap (id INTEGER PRIMARY KEY, val TEXT)");
      db.run("INSERT INTO snap (id, val) VALUES (?, ?)", [1, "persisted"]);

      const bytes = db.serialize();
      expect(bytes).toBeInstanceOf(Uint8Array);
      expect(bytes.byteLength).toBeGreaterThan(0);
      // Standard SQLite file header magic: "SQLite format 3\0"
      const header = new TextDecoder().decode(bytes.subarray(0, 15));
      expect(header).toBe("SQLite format 3");
    });

    it("supports native bun:sqlite power features: values(), queryValue(), prepare(), safeIntegers, strict, onQuery, and Symbol.dispose", () => {
      const events: SqliteQueryEvent[] = [];
      const db = track(
        new SqliteService({
          name: "native",
          filename: ":memory:",
          safeIntegers: true,
          strict: true,
          onQuery: (e) => events.push(e),
        }),
      );

      db.exec("CREATE TABLE metrics (id INTEGER PRIMARY KEY, big INTEGER)");
      db.run("INSERT INTO metrics (id, big) VALUES ($id, $big)", {
        id: 1n,
        big: 9007199254740995n,
      });

      expect(
        db.values<[bigint, bigint]>("SELECT id, big FROM metrics"),
      ).toEqual([[1n, 9007199254740995n]]);
      expect(
        db.queryValue<bigint>("SELECT big FROM metrics WHERE id = $id", {
          id: 1n,
        }),
      ).toBe(9007199254740995n);
      expect(
        db.queryValue<bigint>("SELECT big FROM metrics WHERE id = $id", {
          id: 99n,
        }),
      ).toBeNull();

      // strict: true throws on missing named parameter
      expect(() =>
        db.queryOne("SELECT big FROM metrics WHERE id = $missing", {}),
      ).toThrow();

      // prepare()
      const stmt = db.prepare<{ big: bigint }>(
        "SELECT big FROM metrics WHERE id = $id",
      );
      expect(stmt.get({ id: 1n })).toEqual({ big: 9007199254740995n });
      stmt.finalize();

      expect(events.length).toBeGreaterThanOrEqual(4);
      expect(events.every((e) => e.connectionName === "native")).toBe(true);

      // Symbol.dispose
      let disposed!: SqliteService;
      {
        using scoped = new SqliteService({ filename: ":memory:" });
        disposed = scoped;
        expect(scoped.isClosed).toBe(false);
      }
      expect(disposed.isClosed).toBe(true);
    });
  },
);
