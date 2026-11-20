import "reflect-metadata";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "bun:test";
import { SQL } from "bun";
import { Injectable, Module } from "../../../../../packages/common/src";
import {
  InjectSql,
  InjectSqlMigrations,
  SqlMigrationRunner,
  SqlModule,
  SqlService,
  getSqlConnectionToken,
  getSqlMigrationRunnerToken,
  getSqlOptionsToken,
  type DatabaseAdapter,
  type MigrationDefinition,
  type SqlModuleForRootInput,
  type SqlOptionsFactory,
  type SqlQueryEvent,
} from "../../../../../packages/sql/src";
import { Test, describeConformance } from "../../../_helpers/index";

describeConformance(
  "Persistence (bun-native) - SqlModule DI, multi-connection & query surface",
  {
    upstreamPath: "bun-native/sql-module-di-and-multi-connection",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-002", "ADR-007"],
    notes:
      "Bun-native persistence conformance for @bunest/sql SqlModule, SqlService, DI tokens, telemetry, and lifecycle.",
  },
  () => {
    const openServices: SqlService[] = [];
    const tempDirs: string[] = [];

    const track = (svc: SqlService): SqlService => {
      openServices.push(svc);
      return svc;
    };

    afterEach(async () => {
      while (openServices.length > 0) {
        await openServices.pop()!.close();
      }
      while (tempDirs.length > 0) {
        rmSync(tempDirs.pop()!, { recursive: true, force: true });
      }
    });

    it("supports SqlModule.forRoot() with a URL string shorthand", async () => {
      const mod = await Test.createTestingModule({
        imports: [SqlModule.forRoot("sqlite://:memory:")],
      }).compile({ logger: false });
      await mod.init();

      try {
        const svc = mod.get(SqlService);
        expect(svc.connectionName).toBe("default");
        expect(svc.adapter).toBe("sqlite");
        expect(await svc.healthCheck()).toBe(true);
        expect(mod.get(getSqlConnectionToken())).toBe(svc);
      } finally {
        await mod.close();
      }
    });

    it("supports SqlModule.forRoot() with a URL instance", async () => {
      const dir = mkdtempSync(join(tmpdir(), "bunest-sql-url-"));
      tempDirs.push(dir);
      const dbUrl = pathToFileURL(join(dir, "url-shorthand.sqlite"));

      const mod = await Test.createTestingModule({
        imports: [SqlModule.forRoot(dbUrl)],
      }).compile({ logger: false });
      await mod.init();

      try {
        const svc = mod.get(SqlService);
        expect(svc.adapter).toBe("sqlite");
        expect(await svc.healthCheck()).toBe(true);
      } finally {
        await mod.close();
      }
    });

    it("supports SqlModule.forRoot() with an options object and pre-constructed Bun.SQL client", async () => {
      const rawClient = new SQL("sqlite://:memory:");
      const mod = await Test.createTestingModule({
        imports: [SqlModule.forRoot({ client: rawClient })],
      }).compile({ logger: false });
      await mod.init();

      try {
        const svc = mod.get(SqlService);
        expect(svc.raw).toBe(rawClient);
        expect(await svc.healthCheck()).toBe(true);
      } finally {
        await mod.close();
      }
    });

    it("exposes exports globally by default and enforces module encapsulation when global is false", async () => {
      @Injectable()
      class Consumer {
        constructor(@InjectSql() readonly sql: SqlService) {}
      }

      @Module({
        providers: [Consumer],
        exports: [Consumer],
      })
      class ConsumerModule {}

      // Explicit global: false -> ConsumerModule cannot resolve SqlService without importing SqlModule
      await expect(
        Test.createTestingModule({
          imports: [
            SqlModule.forRoot({ url: "sqlite://:memory:", global: false }),
            ConsumerModule,
          ],
        }).compile({ logger: false }),
      ).rejects.toThrow();

      // Default global: true (matches SqliteModule) -> ConsumerModule resolves SqlService cleanly
      const globalMod = await Test.createTestingModule({
        imports: [
          SqlModule.forRoot("sqlite://:memory:"),
          ConsumerModule,
        ],
      }).compile({ logger: false });
      await globalMod.init();
      try {
        expect(await globalMod.get(Consumer).sql.healthCheck()).toBe(true);
      } finally {
        await globalMod.close();
      }
    });

    it("supports SqlModule.forRootAsync() with useFactory, imports, inject, and extraProviders", async () => {
      const URL_TOKEN = "DB_URL";
      const TAG_TOKEN = "DB_TAG";
      const seenTags: string[] = [];

      @Module({
        providers: [{ provide: URL_TOKEN, useValue: "sqlite://:memory:" }],
        exports: [URL_TOKEN],
      })
      class EnvModule {}

      const mod = await Test.createTestingModule({
        imports: [
          SqlModule.forRootAsync({
            imports: [EnvModule],
            extraProviders: [{ provide: TAG_TOKEN, useValue: "extra-ok" }],
            inject: [URL_TOKEN, TAG_TOKEN],
            useFactory: async (url: string, tag: string) => {
              seenTags.push(tag);
              return { url };
            },
          }),
        ],
      }).compile({ logger: false });
      await mod.init();

      try {
        expect(seenTags).toEqual(["extra-ok"]);
        expect(await mod.get(SqlService).healthCheck()).toBe(true);
      } finally {
        await mod.close();
      }
    });

    it("supports SqlModule.forRootAsync() with useClass implementing SqlOptionsFactory", async () => {
      @Injectable()
      class MySqlOptionsFactory implements SqlOptionsFactory {
        createSqlOptions(): SqlModuleForRootInput {
          return { url: "sqlite://:memory:" };
        }
      }

      const mod = await Test.createTestingModule({
        imports: [SqlModule.forRootAsync({ useClass: MySqlOptionsFactory })],
      }).compile({ logger: false });
      await mod.init();

      try {
        expect(await mod.get(SqlService).healthCheck()).toBe(true);
      } finally {
        await mod.close();
      }
    });

    it("supports SqlModule.forRootAsync() with useExisting from an imported module", async () => {
      @Injectable()
      class SharedSqlFactory implements SqlOptionsFactory {
        createSqlOptions(): SqlModuleForRootInput {
          return "sqlite://:memory:";
        }
      }

      @Module({
        providers: [SharedSqlFactory],
        exports: [SharedSqlFactory],
      })
      class SharedConfigModule {}

      const mod = await Test.createTestingModule({
        imports: [
          SqlModule.forRootAsync({
            imports: [SharedConfigModule],
            useExisting: SharedSqlFactory,
          }),
        ],
      }).compile({ logger: false });
      await mod.init();

      try {
        expect(await mod.get(SqlService).healthCheck()).toBe(true);
      } finally {
        await mod.close();
      }
    });

    it("throws a descriptive error when SqlModule.forRootAsync() omits all strategies", () => {
      expect(() => SqlModule.forRootAsync({})).toThrow(
        'SqlModule.forRootAsync("default") requires one of "useFactory", "useClass", or "useExisting".',
      );
      expect(() => SqlModule.forRootAsync({ name: "analytics" })).toThrow(
        'SqlModule.forRootAsync("analytics") requires one of "useFactory", "useClass", or "useExisting".',
      );
    });

    it("derives deterministic DI tokens for connections, options, and migration runners", () => {
      expect(getSqlConnectionToken()).toBe("bunest:sql:connection:default");
      expect(getSqlConnectionToken("analytics")).toBe(
        "bunest:sql:connection:analytics",
      );
      expect(getSqlOptionsToken()).toBe("bunest:sql:options:default");
      expect(getSqlOptionsToken("analytics")).toBe(
        "bunest:sql:options:analytics",
      );
      expect(getSqlMigrationRunnerToken()).toBe(
        "bunest:sql:migrations:default",
      );
      expect(getSqlMigrationRunnerToken("analytics")).toBe(
        "bunest:sql:migrations:analytics",
      );
    });

    it("wires multiple named connections with @InjectSql and @InjectSqlMigrations without cross-contamination", async () => {
      @Injectable()
      class MultiDbConsumer {
        constructor(
          @InjectSql() readonly primary: SqlService,
          @InjectSql("analytics") readonly analytics: SqlService,
          @InjectSqlMigrations() readonly primaryMigrations: SqlMigrationRunner,
          @InjectSqlMigrations("analytics")
          readonly analyticsMigrations: SqlMigrationRunner,
        ) {}
      }

      const mod = await Test.createTestingModule({
        imports: [
          SqlModule.forRoot("sqlite://:memory:"),
          SqlModule.forRoot({ name: "analytics", url: "sqlite://:memory:" }),
        ],
        providers: [MultiDbConsumer],
      }).compile({ logger: false });
      await mod.init();

      try {
        const consumer = mod.get(MultiDbConsumer);
        expect(consumer.primary.connectionName).toBe("default");
        expect(consumer.analytics.connectionName).toBe("analytics");
        expect(consumer.primary).not.toBe(consumer.analytics);
        expect(consumer.primaryMigrations).not.toBe(
          consumer.analyticsMigrations,
        );

        await consumer.primary.sql`CREATE TABLE primary_only (id INTEGER PRIMARY KEY)`;
        await expect(
          (async () => {
            await consumer.analytics.sql`SELECT * FROM primary_only`;
          })(),
        ).rejects.toThrow(/no such table/i);
      } finally {
        await mod.close();
      }
    });

    it("registers SqlService and SqlMigrationRunner class aliases ONLY for the default connection", async () => {
      const mod = await Test.createTestingModule({
        imports: [
          SqlModule.forRoot({ name: "analytics", url: "sqlite://:memory:" }),
        ],
      }).compile({ logger: false });
      await mod.init();

      try {
        const analytics = mod.get<SqlService>(
          getSqlConnectionToken("analytics"),
        );
        expect(analytics.connectionName).toBe("analytics");
        expect(() => mod.get(SqlService)).toThrow();
        expect(() => mod.get(SqlMigrationRunner)).toThrow();
      } finally {
        await mod.close();
      }
    });

    it("executes tagged templates, unsafe() (positional & named), simple(), query(), queryOne(), and queryScalar()", async () => {
      const svc = track(new SqlService("sqlite://:memory:"));
      const adapter: DatabaseAdapter = svc;
      expect(adapter.connectionName).toBe("default");

      await svc.simple(`
        CREATE TABLE products (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          price INTEGER NOT NULL
        );
        INSERT INTO products (name, price) VALUES ('alpha', 100);
        INSERT INTO products (name, price) VALUES ('beta', 250);
      `);

      // Tagged template insert & select
      await svc.sql`INSERT INTO products (name, price) VALUES (${"gamma"}, ${400})`;
      const tagged = await svc.sql<{ name: string; price: number }>`
        SELECT name, price FROM products WHERE price >= ${200} ORDER BY price ASC
      `;
      expect([...tagged]).toEqual([
        { name: "beta", price: 250 },
        { name: "gamma", price: 400 },
      ]);

      // unsafe() positional ?, $1, and named :name
      const byQ = await svc.unsafe<{ name: string }>(
        "SELECT name FROM products WHERE price = ?",
        [100],
      );
      expect([...byQ]).toEqual([{ name: "alpha" }]);

      const byDollar = await svc.unsafe<{ name: string }>(
        "SELECT name FROM products WHERE price = $1",
        [250],
      );
      expect([...byDollar]).toEqual([{ name: "beta" }]);

      const byNamed = await svc.unsafe<{ price: number }>(
        "SELECT price FROM products WHERE name = :name",
        { ":name": "gamma" },
      );
      expect([...byNamed]).toEqual([{ price: 400 }]);

      // query()
      const qr = await svc.query<{ name: string }>(
        "SELECT name FROM products ORDER BY id ASC",
      );
      expect(qr.rows).toHaveLength(3);
      expect(qr.rowCount).toBe(3);

      // queryOne()
      expect(
        await svc.queryOne<{ name: string }>(
          "SELECT name FROM products WHERE id = ?",
          [2],
        ),
      ).toEqual({ name: "beta" });
      expect(
        await svc.queryOne("SELECT name FROM products WHERE id = ?", [999]),
      ).toBeNull();

      // queryScalar()
      expect(
        await svc.queryScalar<number>("SELECT SUM(price) AS total FROM products"),
      ).toBe(750);
      expect(
        await svc.queryScalar<string>(
          "SELECT name FROM products WHERE id = ?",
          [999],
        ),
      ).toBeNull();
    });

    it("executes external SQL files via sqlService.file()", async () => {
      const svc = track(new SqlService("sqlite://:memory:"));
      await svc.sql`CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)`;
      await svc.sql`INSERT INTO kv (k, v) VALUES (${"env"}, ${"test"})`;

      const dir = mkdtempSync(join(tmpdir(), "bunest-sql-conformance-"));
      tempDirs.push(dir);
      const filePath = join(dir, "select-kv.sql");
      writeFileSync(filePath, "SELECT k, v FROM kv WHERE k = $1", "utf8");

      const rows = await svc.file<{ k: string; v: string }>(filePath, ["env"]);
      expect([...rows]).toEqual([{ k: "env", v: "test" }]);
    });

    it("invokes onQuery telemetry hook with sql, durationMs, inTransaction, and connectionName", async () => {
      const events: SqlQueryEvent[] = [];
      const svc = track(
        new SqlService({
          name: "telemetry",
          url: "sqlite://:memory:",
          onQuery: (e) => events.push(e),
        }),
      );

      await svc.simple("CREATE TABLE t (id INTEGER PRIMARY KEY)");
      await svc.query("INSERT INTO t (id) VALUES (?)", [1]);
      await svc.transaction(async () => {
        await svc.queryScalar("SELECT COUNT(*) FROM t");
      });

      expect(events).toHaveLength(3);
      expect(events[0]!.connectionName).toBe("telemetry");
      expect(events[0]!.inTransaction).toBe(false);
      expect(events[0]!.durationMs).toBeGreaterThanOrEqual(0);
      expect(events[1]!.inTransaction).toBe(false);
      expect(events[2]!.inTransaction).toBe(true);
      expect(events[2]!.sql).toContain("SELECT COUNT(*)");
    });

    it("executes connectOnInit and autoMigrate during onModuleInit()", async () => {
      const migrations: MigrationDefinition<SqlService>[] = [
        {
          id: "001_init_users",
          up: "CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL)",
          down: "DROP TABLE users",
        },
      ];

      const mod = await Test.createTestingModule({
        imports: [
          SqlModule.forRoot({
            url: "sqlite://:memory:",
            connectOnInit: true,
            autoMigrate: true,
            migrations,
          }),
        ],
      }).compile({ logger: false });

      await mod.init();
      try {
        const svc = mod.get(SqlService);
        const runner = mod.get(SqlMigrationRunner);
        expect((await runner.status()).applied.map((m) => m.id)).toEqual([
          "001_init_users",
        ]);
        await svc.sql`INSERT INTO users (email) VALUES (${"alice@bunest.dev"})`;
        expect(
          await svc.queryScalar<number>("SELECT COUNT(*) FROM users"),
        ).toBe(1);
      } finally {
        await mod.close();
      }
    });

    it("closes idempotently via onModuleDestroy and rejects post-close operations", async () => {
      const mod = await Test.createTestingModule({
        imports: [SqlModule.forRoot("sqlite://:memory:")],
      }).compile({ logger: false });
      await mod.init();

      const svc = mod.get(SqlService);
      expect(svc.isClosed).toBe(false);
      expect(await svc.healthCheck()).toBe(true);

      await mod.close();
      await svc.close(); // idempotent

      expect(svc.isClosed).toBe(true);
      expect(await svc.healthCheck()).toBe(false);
      expect(() => svc.raw).toThrow(/closed/i);
      expect(() => svc.unsafe("SELECT 1")).toThrow(/closed/i);
      await expect(svc.query("SELECT 1")).rejects.toThrow(/closed/i);
      await expect(svc.connect()).rejects.toThrow(/closed/i);
      await expect(svc.reserve()).rejects.toThrow(/closed/i);
    });

    it("supports Symbol.asyncDispose via await using", async () => {
      let ref!: SqlService;
      {
        await using svc = new SqlService("sqlite://:memory:");
        ref = svc;
        expect(await svc.healthCheck()).toBe(true);
      }
      expect(ref.isClosed).toBe(true);
      expect(await ref.healthCheck()).toBe(false);
    });

    it("throws descriptive errors when calling Postgres-only json()/array() helpers on SQLite adapter", async () => {
      const svc = track(new SqlService("sqlite://:memory:"));
      expect(() => svc.json({ ok: true })).toThrow(/does not support sql\.json/i);
      expect(() => svc.array([1, 2, 3])).toThrow(
        /does not support sql\.array|doesn't support arrays/i,
      );
    });
  },
);
