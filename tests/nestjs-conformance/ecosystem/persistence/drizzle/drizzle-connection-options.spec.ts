import "reflect-metadata";
import { Database } from "bun:sqlite";
import { expect, it } from "bun:test";
import { Injectable, Module } from "../../../../../packages/common/src";
import {
  DrizzleModule,
  DrizzleService,
  InjectDrizzle,
  getDrizzleServiceToken,
  getDrizzleToken,
  type DrizzleClosableClient,
  type DrizzleDatabaseLike,
} from "../../../../../packages/sql/src";
import {
  Test,
  createSpy,
  describeConformance,
} from "../../../_helpers/index";

interface SqliteDrizzleTestDb extends DrizzleDatabaseLike<SqliteDrizzleTestDb> {
  readonly sqlite: Database;
  closed: boolean;
  insertNote(text: string): void;
  listNotes(): string[];
  close(): void;
}

function createSqliteDrizzleTestDb(): {
  db: SqliteDrizzleTestDb;
  client: DrizzleClosableClient & { closed: boolean };
} {
  const sqlite = new Database(":memory:");
  sqlite.run(
    "CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL)",
  );

  const state = { closed: false };

  const client: DrizzleClosableClient & { closed: boolean } = {
    get closed() {
      return state.closed;
    },
    set closed(v: boolean) {
      state.closed = v;
    },
    close() {
      if (!state.closed) {
        state.closed = true;
        sqlite.close(true);
      }
    },
    queryOne(sql: string) {
      return sqlite.prepare(sql).get();
    },
  };

  const makeWrapper = (prefix: string): SqliteDrizzleTestDb => ({
    sqlite,
    get closed() {
      return state.closed;
    },
    set closed(v: boolean) {
      state.closed = v;
    },
    insertNote(text: string) {
      sqlite.prepare("INSERT INTO notes (body) VALUES (?)").run(`${prefix}${text}`);
    },
    listNotes(): string[] {
      const rows = sqlite
        .prepare<{ body: string }, []>("SELECT body FROM notes ORDER BY id ASC")
        .all();
      return rows.map((r) => r.body);
    },
    transaction<T>(fn: (tx: SqliteDrizzleTestDb) => T): T {
      const txWrapper = makeWrapper(`${prefix}tx:`);
      sqlite.run("BEGIN");
      try {
        const result = fn(txWrapper);
        sqlite.run("COMMIT");
        return result;
      } catch (err) {
        sqlite.run("ROLLBACK");
        throw err;
      }
    },
    close() {
      client.close?.();
    },
  });

  return { db: makeWrapper(""), client };
}

describeConformance(
  "Persistence (drizzle) - connection options, isolation, transactionalProxy & healthCheck",
  {
    upstreamPath: "drizzle/tests/e2e/drizzle-connection-options.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-002"],
    notes:
      "Adapts per-app isolation, autoClose, and option wiring to @bunest/sql DrizzleModule with in-memory bun:sqlite, plus Bunest transactionalProxy and healthCheck probes.",
  },
  () => {
    it("should create an isolated database for every application and close only its own client on shutdown", async () => {
      @Module({
        imports: [
          DrizzleModule.forRootAsync({
            useFactory: () => {
              const { db, client } = createSqliteDrizzleTestDb();
              return { db, client };
            },
          }),
        ],
      })
      class AppModule {}

      const boot = async () => {
        const mod = await Test.createTestingModule({
          imports: [AppModule],
        }).compile({ logger: false });
        await mod.init();
        return mod;
      };

      const first = await boot();
      const firstDb = first.get<SqliteDrizzleTestDb>(getDrizzleToken());
      const second = await boot();
      const secondDb = second.get<SqliteDrizzleTestDb>(getDrizzleToken());

      expect(secondDb).not.toBe(firstDb);
      firstDb.insertNote("only-first");
      expect(firstDb.listNotes()).toEqual(["only-first"]);
      expect(secondDb.listNotes()).toEqual([]);

      await first.close();
      expect(firstDb.closed).toBe(true);
      expect(secondDb.closed).toBe(false);

      await second.close();
      expect(secondDb.closed).toBe(true);
    });

    it("should register a named connection and auto-close its client on shutdown", async () => {
      const closeSpy = createSpy();
      const db: DrizzleDatabaseLike = {};

      @Module({
        imports: [
          DrizzleModule.forRoot({
            name: "analytics",
            db,
            client: { close: closeSpy },
            autoClose: true,
          }),
        ],
      })
      class AppModule {}

      const moduleRef = await Test.createTestingModule({
        imports: [AppModule],
      }).compile({ logger: false });
      await moduleRef.init();

      expect(moduleRef.get(getDrizzleToken("analytics"))).toBe(db);
      expect(
        moduleRef.get<DrizzleService>(getDrizzleServiceToken("analytics"))
          .connectionName,
      ).toBe("analytics");

      await moduleRef.close();
      expect(closeSpy.calledOnce).toBe(true);
    });

    it("should not close the client when autoClose is false", async () => {
      const { db, client } = createSqliteDrizzleTestDb();

      @Module({
        imports: [
          DrizzleModule.forRoot({
            db,
            client,
            autoClose: false,
          }),
        ],
      })
      class AppModule {}

      const moduleRef = await Test.createTestingModule({
        imports: [AppModule],
      }).compile({ logger: false });
      await moduleRef.init();

      await moduleRef.close();
      expect(client.closed).toBe(false);
      // Clean up manually since autoClose was disabled
      client.close?.();
      expect(client.closed).toBe(true);
    });

    it("should route @InjectDrizzle() calls through ALS when transactionalProxy is true", async () => {
      const { db, client } = createSqliteDrizzleTestDb();

      @Injectable()
      class NotesRepo {
        constructor(
          @InjectDrizzle() readonly proxiedDb: SqliteDrizzleTestDb,
          readonly drizzleService: DrizzleService<SqliteDrizzleTestDb>,
        ) {}
      }

      const moduleRef = await Test.createTestingModule({
        imports: [
          DrizzleModule.forRoot({
            db,
            client,
            transactionalProxy: true,
          }),
        ],
        providers: [NotesRepo],
      }).compile({ logger: false });
      await moduleRef.init();

      try {
        const repo = moduleRef.get(NotesRepo);
        expect(repo.proxiedDb).not.toBe(db);

        repo.proxiedDb.insertNote("root");
        repo.drizzleService.transactionSync(() => {
          repo.proxiedDb.insertNote("inside");
        });

        expect(repo.proxiedDb.listNotes()).toEqual(["root", "tx:inside"]);
      } finally {
        await moduleRef.close();
      }
    });

    it("should probe connectivity across DrizzleService.healthCheck() strategies and report false on error/closed", async () => {
      // 1. Custom healthCheck hook
      const customSvc = new DrizzleService({
        db: {},
        healthCheck: async () => true,
      });
      expect(await customSvc.healthCheck()).toBe(true);
      await customSvc.close();
      expect(await customSvc.healthCheck()).toBe(false);

      // 2. client.healthCheck()
      const clientHc = new DrizzleService({
        db: {},
        client: { healthCheck: () => false },
      });
      expect(await clientHc.healthCheck()).toBe(false);
      await clientHc.close();

      // 3. client.queryOne() against live bun:sqlite
      const { db, client } = createSqliteDrizzleTestDb();
      const sqliteSvc = new DrizzleService({ db, client });
      expect(await sqliteSvc.healthCheck()).toBe(true);
      await sqliteSvc.close();
      expect(await sqliteSvc.healthCheck()).toBe(false);

      // 4. db.execute() failing returns false
      const failingSvc = new DrizzleService({
        db: {
          execute: async () => {
            throw new Error("connection lost");
          },
        },
      });
      expect(await failingSvc.healthCheck()).toBe(false);
      await failingSvc.close();
    });
  },
);
