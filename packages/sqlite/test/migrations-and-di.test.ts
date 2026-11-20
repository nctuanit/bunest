import "reflect-metadata";
import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { Body, Controller, Get, Injectable, Module, Post } from "@bunest/common";
import { Test } from "@bunest/testing";
import {
  InjectSqlite,
  InjectSqliteMigrations,
  SqliteMigrationRunner,
  SqliteModule,
  SqliteService,
  type SqliteMigration,
  type SqliteModuleOptions,
  type SqliteOptionsFactory,
} from "../src/index";

const SAMPLE_MIGRATIONS: readonly SqliteMigration[] = [
  {
    id: "001_create_users",
    name: "create users table",
    up: `
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL
      );
    `,
    down: "DROP TABLE users;",
  },
  {
    id: "002_create_posts",
    name: "create posts table",
    up: (db) => {
      db.exec(`
        CREATE TABLE posts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id),
          title TEXT NOT NULL
        );
      `);
    },
    down: (db) => {
      db.exec("DROP TABLE posts;");
    },
  },
];

describe("SqliteMigrationRunner", () => {
  let db: SqliteService;

  afterEach(() => {
    db?.close();
  });

  it("tracks status, applies migrations idempotently, and rolls back by batch/steps/all", async () => {
    db = new SqliteService({ filename: ":memory:" });
    const runner = new SqliteMigrationRunner(db, SAMPLE_MIGRATIONS);

    const initial = runner.status();
    expect(initial.applied).toHaveLength(0);
    expect(initial.pending).toHaveLength(2);

    // Apply first migration only -> batch 1
    const batch1 = await runner.up(undefined, { steps: 1 });
    expect(batch1).toHaveLength(1);
    expect(batch1[0]!.id).toBe("001_create_users");
    expect(batch1[0]!.batch).toBe(1);

    // Apply remaining -> batch 2
    const batch2 = await runner.up();
    expect(batch2).toHaveLength(1);
    expect(batch2[0]!.id).toBe("002_create_posts");
    expect(batch2[0]!.batch).toBe(2);

    // Idempotent re-run applies nothing
    const noop = await runner.up();
    expect(noop).toHaveLength(0);
    expect(runner.status().pending).toHaveLength(0);
    expect(runner.status().applied).toHaveLength(2);

    // Verify tables exist
    db.run("INSERT INTO users (name) VALUES (?)", ["Ada"]);
    db.run("INSERT INTO posts (user_id, title) VALUES (?, ?)", [1, "Notes"]);

    // Default down() reverts latest batch (batch 2 -> posts table dropped, users remains)
    const revertedLatest = await runner.down();
    expect(revertedLatest.map((m) => m.id)).toEqual(["002_create_posts"]);
    expect(runner.status().applied.map((m) => m.id)).toEqual([
      "001_create_users",
    ]);
    expect(() => db.query("SELECT * FROM posts")).toThrow();
    expect(db.query("SELECT * FROM users")).toHaveLength(1);

    // Re-apply and revert all
    await runner.up();
    const revertedAll = await runner.down(undefined, { all: true });
    expect(revertedAll.map((m) => m.id)).toEqual([
      "002_create_posts",
      "001_create_users",
    ]);
    expect(runner.status().applied).toHaveLength(0);
    expect(runner.status().pending).toHaveLength(2);
  });

  it("rolls back failed migrations atomically without marking them applied", async () => {
    db = new SqliteService({ filename: ":memory:" });
    const failingMigrations: SqliteMigration[] = [
      {
        id: "001_partial_fail",
        up: (execDb) => {
          execDb.exec("CREATE TABLE ephemeral (id INTEGER PRIMARY KEY)");
          execDb.run("INSERT INTO ephemeral (id) VALUES (?)", [1]);
          throw new Error("migration-crashed");
        },
        down: "DROP TABLE ephemeral;",
      },
    ];

    const runner = new SqliteMigrationRunner(db, failingMigrations);
    await expect(runner.up()).rejects.toThrow("migration-crashed");

    expect(runner.status().applied).toHaveLength(0);
    expect(runner.status().pending).toHaveLength(1);
    expect(() => db.query("SELECT * FROM ephemeral")).toThrow();
  });
});

describe("SqliteModule DI, Lifecycle & HTTP Integration", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("supports forRoot with autoMigrate, named connections, and TestingModule HTTP lifecycle", async () => {
    @Injectable()
    class UsersService {
      constructor(
        private readonly db: SqliteService,
        @InjectSqlite("analytics") private readonly analytics: SqliteService,
        @InjectSqliteMigrations()
        public readonly migrations: SqliteMigrationRunner,
      ) {}

      createUser(name: string) {
        return this.db.transaction(() => {
          const res = this.db.run("INSERT INTO users (name) VALUES (?)", [name]);
          this.analytics.run("INSERT INTO events (kind) VALUES (?)", [
            `created:${name}`,
          ]);
          return { id: Number(res.lastInsertRowid), name };
        });
      }

      listUsers() {
        return this.db.query<{ id: number; name: string }>(
          "SELECT id, name FROM users ORDER BY id",
        );
      }

      listEvents() {
        return this.analytics.query<{ kind: string }>("SELECT kind FROM events");
      }
    }

    @Controller("/users")
    class UsersController {
      constructor(private readonly users: UsersService) {}

      @Post()
      async create(@Body() body: { name: string }) {
        return await this.users.createUser(body.name);
      }

      @Get()
      list() {
        return this.users.listUsers();
      }
    }

    const analyticsMigrations: SqliteMigration[] = [
      {
        id: "001_events",
        up: "CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL);",
        down: "DROP TABLE events;",
      },
    ];

    const moduleRef = await Test.createTestingModule({
      imports: [
        SqliteModule.forRoot({
          filename: ":memory:",
          migrations: SAMPLE_MIGRATIONS,
          autoMigrate: true,
        }),
        SqliteModule.forRoot({
          name: "analytics",
          filename: ":memory:",
          migrations: analyticsMigrations,
          autoMigrate: true,
        }),
      ],
      controllers: [UsersController],
      providers: [UsersService],
    }).compile();

    const app = moduleRef.createBunestApplication();
    const client = moduleRef.createTestClient(app);
    await app.init();

    const usersService = moduleRef.get(UsersService);
    expect(usersService.migrations.status().applied).toHaveLength(2);

    const createRes = await client.post("/users", {
      json: { name: "Grace" },
    });
    expect(createRes.status).toBe(201);
    expect(await createRes.json()).toEqual({ id: 1, name: "Grace" });

    const listRes = await client.get("/users");
    expect(listRes.status).toBe(200);
    expect(await listRes.json()).toEqual([{ id: 1, name: "Grace" }]);
    expect(usersService.listEvents()).toEqual([{ kind: "created:Grace" }]);

    const defaultDb = moduleRef.get(SqliteService);
    expect(defaultDb.isClosed).toBe(false);

    await moduleRef.close();
    expect(defaultDb.isClosed).toBe(true);
  });

  it("supports forRootAsync (useFactory, useClass, useExisting) and global modules", async () => {
    const CONFIG_TOKEN = "DB_CONFIG";

    @Module({
      providers: [{ provide: CONFIG_TOKEN, useValue: { filename: ":memory:" } }],
      exports: [CONFIG_TOKEN],
    })
    class ConfigModule {}

    @Injectable()
    class ChildConsumer {
      constructor(@InjectSqlite() public readonly db: SqliteService) {}
    }

    @Module({
      providers: [ChildConsumer],
      exports: [ChildConsumer],
    })
    class ChildModule {}

    // 1. useFactory + global: true
    const factoryMod = await Test.createTestingModule({
      imports: [
        SqliteModule.forRootAsync({
          global: true,
          imports: [ConfigModule],
          inject: [CONFIG_TOKEN],
          useFactory: async (cfg: { filename: string }) => ({
            filename: cfg.filename,
          }),
        }),
        ChildModule,
      ],
    }).compile();
    await factoryMod.init();
    const consumer = factoryMod.get(ChildConsumer);
    expect(consumer.db.healthCheck()).toBe(true);
    await factoryMod.close();
    expect(consumer.db.isClosed).toBe(true);

    // 2. useClass
    @Injectable()
    class MySqliteOptionsFactory implements SqliteOptionsFactory {
      createSqliteOptions(): SqliteModuleOptions {
        return { filename: ":memory:" };
      }
    }

    const classMod = await Test.createTestingModule({
      imports: [
        SqliteModule.forRootAsync({
          useClass: MySqliteOptionsFactory,
        }),
      ],
    }).compile();
    await classMod.init();
    const classDb = classMod.get(SqliteService);
    expect(classDb.healthCheck()).toBe(true);
    await classMod.close();
    expect(classDb.isClosed).toBe(true);

    // 3. useExisting
    @Module({
      providers: [MySqliteOptionsFactory],
      exports: [MySqliteOptionsFactory],
    })
    class FactoryExportModule {}

    const existingMod = await Test.createTestingModule({
      imports: [
        SqliteModule.forRootAsync({
          imports: [FactoryExportModule],
          useExisting: MySqliteOptionsFactory,
        }),
      ],
    }).compile();
    await existingMod.init();
    const existingDb = existingMod.get(SqliteService);
    expect(existingDb.healthCheck()).toBe(true);
    await existingMod.close();
    expect(existingDb.isClosed).toBe(true);
  });

  it("gracefully closes file-backed SQLite handles on app.close() without leaking file locks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bunest-sqlite-close-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "test.sqlite");

    const moduleRef = await Test.createTestingModule({
      imports: [
        SqliteModule.forRoot({
          filename: dbPath,
          wal: true,
        }),
      ],
    }).compile();

    const app = moduleRef.createBunestApplication();
    await app.init();

    const sqlite = moduleRef.get(SqliteService);
    sqlite.exec("CREATE TABLE ping (v TEXT)");
    sqlite.run("INSERT INTO ping (v) VALUES (?)", ["pong"]);
    expect(existsSync(dbPath)).toBe(true);

    await app.close();
    expect(sqlite.isClosed).toBe(true);

    // On Windows, unlinking an open SQLite handle throws EBUSY; this verifies leak-free release!
    unlinkSync(dbPath);
    expect(existsSync(dbPath)).toBe(false);
  });
});
