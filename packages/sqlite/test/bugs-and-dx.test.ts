import "reflect-metadata";
import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { Injectable } from "@bunest/common";
import { Test } from "@bunest/testing";
import {
  BaseSqliteRepository,
  DuplicateSqliteConnectionException,
  InjectSqliteRepository,
  SqliteEntity,
  SqliteEntityNotFoundException,
  SqliteMigrationRunner,
  SqliteModule,
  SqliteService,
  getSqliteRepositoryToken,
  type SqliteMigration,
  type SqliteQueryEvent,
} from "../src/index";

interface ProductRow extends Record<string, unknown> {
  id: number;
  sku: string;
  name: string;
  price: number;
  category: string;
}

describe("@bunest/sqlite Audited Bug Fixes & DX Completeness", () => {
  const openServices: SqliteService[] = [];
  const tempDirs: string[] = [];

  const track = (svc: SqliteService): SqliteService => {
    openServices.push(svc);
    return svc;
  };

  afterEach(() => {
    while (openServices.length > 0) {
      openServices.pop()!.close();
    }
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("BUG-1: closes SQLite file handle cleanly when constructor PRAGMA validation fails (no Windows EBUSY leak)", () => {
    const dir = mkdtempSync(join(tmpdir(), "bunest-sqlite-bug1-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "leak-check.sqlite");

    expect(
      () =>
        new SqliteService({
          filename: dbPath,
          pragmas: { synchronous: "NORMAL; DROP TABLE x" },
        }),
    ).toThrow(/disallowed characters/);

    // File must not remain locked by a leaked handle!
    if (existsSync(dbPath)) {
      unlinkSync(dbPath);
    }
    expect(existsSync(dbPath)).toBe(false);

    expect(
      () =>
        new SqliteService({
          filename: dbPath,
          busyTimeout: -10,
        }),
    ).toThrow(/Invalid busyTimeout/);

    if (existsSync(dbPath)) {
      unlinkSync(dbPath);
    }
    expect(existsSync(dbPath)).toBe(false);
  });

  it("BUG-2: serializes concurrent nested SAVEPOINT transactions via Promise.all without corrupting sibling work or deadlocking", async () => {
    const db = track(new SqliteService({ filename: ":memory:" }));
    db.exec("CREATE TABLE log (id INTEGER PRIMARY KEY AUTOINCREMENT, msg TEXT NOT NULL)");

    await db.transaction(async () => {
      db.run("INSERT INTO log (msg) VALUES (?)", ["outer-start"]);

      const [resA, resB, resC] = await Promise.all([
        // Branch A fails and rolls back its savepoint after an async pause
        db
          .transaction(async () => {
            db.run("INSERT INTO log (msg) VALUES (?)", ["branch-a-rolled-back"]);
            await Bun.sleep(15);
            throw new Error("branch-a-fail");
          })
          .catch((e: Error) => e.message),

        // Branch B succeeds and ALSO creates a deeper level-2 savepoint (verifies zero deadlock!)
        db.transaction(async () => {
          db.run("INSERT INTO log (msg) VALUES (?)", ["branch-b-ok"]);
          await Bun.sleep(5);
          await db.transaction(async () => {
            db.run("INSERT INTO log (msg) VALUES (?)", ["branch-b-nested-ok"]);
          });
          return "B-ok";
        }),

        // Branch C succeeds concurrently
        db.transaction(async () => {
          db.run("INSERT INTO log (msg) VALUES (?)", ["branch-c-ok"]);
          return "C-ok";
        }),
      ]);

      expect(resA).toBe("branch-a-fail");
      expect(resB).toBe("B-ok");
      expect(resC).toBe("C-ok");

      db.run("INSERT INTO log (msg) VALUES (?)", ["outer-end"]);
    });

    const rows = db.query<{ msg: string }>("SELECT msg FROM log ORDER BY id");
    expect(rows.map((r) => r.msg)).toEqual([
      "outer-start",
      "branch-b-ok",
      "branch-b-nested-ok",
      "branch-c-ok",
      "outer-end",
    ]);
  });

  it("BUG-3: SqliteMigrationRunner.status() and getApplied() work on readonly: true connections without executing write DDL", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bunest-sqlite-bug3-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "ro.sqlite");

    // Create an empty file DB with no migrations table yet
    const initDb = new SqliteService({ filename: dbPath });
    initDb.exec("CREATE TABLE seed (id INTEGER PRIMARY KEY)");
    initDb.close();

    const migrations: SqliteMigration[] = [
      { id: "001_init", up: "CREATE TABLE t (id INTEGER PRIMARY KEY)", down: "DROP TABLE t" },
    ];

    const roDb = track(new SqliteService({ filename: dbPath, readonly: true }));
    const runner = new SqliteMigrationRunner(roDb, migrations);

    // Must NOT crash with SQLITE_READONLY!
    expect(runner.getApplied()).toEqual([]);
    const status = runner.status();
    expect(status.applied).toEqual([]);
    expect(status.pending).toHaveLength(1);
    expect(await runner.down()).toEqual([]);
  });

  it("BUG-4: invalidates statement cache across DDL in exec() and migrations", async () => {
    const db = track(new SqliteService({ filename: ":memory:" }));
    db.exec("CREATE TABLE docs (id INTEGER PRIMARY KEY, title TEXT)");
    db.run("INSERT INTO docs (title) VALUES (?)", ["v1"]);
    expect(db.getCachedStatementCount()).toBe(1);

    // ALTER TABLE via exec() clears stale statements
    db.exec("ALTER TABLE docs ADD COLUMN tag TEXT DEFAULT 'general'");
    expect(db.getCachedStatementCount()).toBe(0);

    const row = db.queryOne<{ title: string; tag: string }>(
      "SELECT title, tag FROM docs WHERE id = ?",
      [1],
    );
    expect(row).toEqual({ title: "v1", tag: "general" });
    expect(db.getCachedStatementCount()).toBe(1);

    // Migration runner up() clears statement cache after DDL migration
    const runner = new SqliteMigrationRunner(db, [
      {
        id: "001_add_notes",
        up: "ALTER TABLE docs ADD COLUMN notes TEXT DEFAULT ''",
        down: "SELECT 1",
      },
    ]);
    await runner.up();
    expect(db.getCachedStatementCount()).toBe(0);
  });

  it("BUG-5: BaseSqliteRepository.findWhere({ col: undefined }) throws by default unless strictWhere: false", () => {
    const db = track(new SqliteService({ filename: ":memory:" }));
    db.exec(
      "CREATE TABLE products (id INTEGER PRIMARY KEY AUTOINCREMENT, sku TEXT UNIQUE, name TEXT, price INTEGER, category TEXT)",
    );
    const repo = new BaseSqliteRepository<ProductRow, number>(db, "products");
    repo.insert({ sku: "A1", name: "Widget", price: 100, category: "tools" });

    // Footgun prevented by default!
    expect(() => repo.findWhere({ sku: undefined })).toThrow(
      /Refusing to execute unfiltered query/,
    );
    expect(() => repo.count({ sku: undefined })).toThrow(
      /Refusing to execute unfiltered query/,
    );

    // Explicit opt-out works
    expect(
      repo.findWhere({ sku: undefined }, { strictWhere: false }),
    ).toHaveLength(1);
    // Empty `{}` has 0 keys and remains allowed for findWhere({})
    expect(repo.findWhere({})).toHaveLength(1);
  });

  it("BUG-6: fails fast in constructor when readonly: true and autoMigrate: true are combined", () => {
    expect(
      () =>
        new SqliteService({
          filename: ":memory:",
          readonly: true,
          autoMigrate: true,
          migrations: [{ id: "001", up: "CREATE TABLE a (id INT)" }],
        }),
    ).toThrow(/cannot enable "autoMigrate" when "readonly" is true/);
  });

  it("BUG-7: SqliteModule.forRootAsync() rejects mismatched connection name returned by options factory", async () => {
    await expect(
      Test.createTestingModule({
        imports: [
          SqliteModule.forRootAsync({
            useFactory: () => ({
              name: "analytics",
              filename: ":memory:",
            }),
          }),
        ],
      }).compile(),
    ).rejects.toThrow(/conflicting connection name "analytics"/);
  });

  it("supports SqliteModule.forFeature(), @InjectSqliteRepository(), @SqliteEntity(), getSqliteRepositoryToken(), and DuplicateSqliteConnectionException", async () => {
    @SqliteEntity("products")
    class ProductEntity {}

    class CustomProductsRepo extends BaseSqliteRepository<ProductRow, number> {
      constructor(sqlite: SqliteService) {
        super(sqlite, "products");
      }

      findBySku(sku: string): ProductRow | null {
        return this.findOneWhere({ sku });
      }
    }

    @Injectable()
    class CatalogService {
      constructor(
        @InjectSqliteRepository("products")
        public readonly byTable: BaseSqliteRepository<ProductRow, number>,
        @InjectSqliteRepository(ProductEntity)
        public readonly byEntity: BaseSqliteRepository<ProductRow, number>,
        public readonly customRepo: CustomProductsRepo,
        @InjectSqliteRepository("audit_logs", "audit")
        public readonly auditRepo: BaseSqliteRepository<
          Record<string, unknown>,
          number
        >,
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
                id: "001_products",
                up: "CREATE TABLE products (id INTEGER PRIMARY KEY AUTOINCREMENT, sku TEXT UNIQUE NOT NULL, name TEXT NOT NULL, price INTEGER NOT NULL, category TEXT NOT NULL)",
              },
            ],
          },
          {
            name: "audit",
            filename: ":memory:",
            autoMigrate: true,
            migrations: [
              {
                id: "001_audit",
                up: "CREATE TABLE audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT NOT NULL)",
              },
            ],
          },
        ]),
        SqliteModule.forFeature(["products", ProductEntity, CustomProductsRepo]),
        SqliteModule.forFeature(["audit_logs"], "audit"),
      ],
      providers: [CatalogService],
    }).compile();

    await mod.init();
    try {
      const catalog = mod.get(CatalogService);
      expect(getSqliteRepositoryToken("products")).toBe(
        "bunest:sqlite:repository:default:products",
      );
      expect(getSqliteRepositoryToken(ProductEntity)).toBe(
        "bunest:sqlite:repository:default:ProductEntity",
      );

      const inserted = catalog.byTable.insertReturning({
        sku: "SKU-1",
        name: "Keyboard",
        price: 120,
        category: "peripherals",
      });
      expect(inserted.id).toBe(1);
      expect(inserted.sku).toBe("SKU-1");
      expect(catalog.byEntity.findById(1)?.name).toBe("Keyboard");
      expect(catalog.customRepo.findBySku("SKU-1")?.price).toBe(120);

      catalog.auditRepo.insert({ event: "product_created" });
      expect(catalog.auditRepo.count()).toBe(1);
    } finally {
      await mod.close();
    }

    // Duplicate connection names rejected by forRootMultiple
    expect(() =>
      SqliteModule.forRootMultiple([
        { name: "dup", filename: ":memory:" },
        { name: "dup", filename: ":memory:" },
      ]),
    ).toThrow(DuplicateSqliteConnectionException);
  });

  it("supports BaseSqliteRepository CRUD DX (insertReturning, insertMany, upsert, updateWhere, findAndCount, findByIdOrFail, iterate, select, multi-column orderBy)", () => {
    const db = track(new SqliteService({ filename: ":memory:" }));
    db.exec(`
      CREATE TABLE products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sku TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        price INTEGER NOT NULL,
        category TEXT NOT NULL
      );
    `);

    const repo = new BaseSqliteRepository<ProductRow, number>(db, "products");
    expect(repo.executor).toBe(db);
    expect(repo.table).toBe("products");
    expect(repo.primaryKeyColumn).toBe("id");

    // insertMany transactional batch
    const batchRes = repo.insertMany([
      { sku: "P1", name: "Mouse", price: 40, category: "hardware" },
      { sku: "P2", name: "Monitor", price: 300, category: "hardware" },
      { sku: "P3", name: "Book", price: 25, category: "books" },
    ]);
    expect(batchRes.changes).toBe(3);
    expect(repo.insertMany([]).changes).toBe(0);

    // insertReturning
    const created = repo.insertReturning({
      sku: "P4",
      name: "Cable",
      price: 15,
      category: "hardware",
    });
    expect(created).toEqual({
      id: 4,
      sku: "P4",
      name: "Cable",
      price: 15,
      category: "hardware",
    });

    // upsert (conflict update + DO NOTHING)
    repo.upsert(
      { sku: "P1", name: "Gaming Mouse", price: 65, category: "hardware" },
      "sku",
    );
    expect(repo.findOneWhereOrFail({ sku: "P1" }).name).toBe("Gaming Mouse");
    expect(repo.findOneWhereOrFail({ sku: "P1" }).price).toBe(65);

    repo.upsert(
      { sku: "P1", name: "Ignored", price: 999, category: "hardware" },
      ["sku"],
      [], // DO NOTHING
    );
    expect(repo.findOneWhereOrFail({ sku: "P1" }).price).toBe(65);

    // updateWhere + existsWhere
    expect(repo.existsWhere({ category: "books" })).toBe(true);
    const upd = repo.updateWhere({ category: "books" }, { price: 30 });
    expect(upd.changes).toBe(1);
    expect(() => repo.updateWhere({}, { price: 1 })).toThrow(/at least one filter/);

    // findAndCount with select projection and multi-column orderBy
    const [hardwarePage, hardwareTotal] = repo.findAndCount(
      { category: "hardware" },
      {
        select: ["sku", "price"],
        orderBy: [
          { column: "price", order: "DESC" },
          { column: "sku", order: "ASC" },
        ],
        limit: 2,
        offset: 0,
      },
    );
    expect(hardwareTotal).toBe(3);
    expect(hardwarePage as unknown as Array<{ sku: string; price: number }>).toEqual([
      { sku: "P2", price: 300 },
      { sku: "P1", price: 65 },
    ]);

    // iterate cursor streaming
    const streamedSkus = [...repo.iterate(undefined, { orderBy: "sku" })].map(
      (r) => r.sku,
    );
    expect(streamedSkus).toEqual(["P1", "P2", "P3", "P4"]);

    // findByIdOrFail / findOneWhereOrFail
    expect(repo.findByIdOrFail(1).sku).toBe("P1");
    expect(() => repo.findByIdOrFail(9999)).toThrow(SqliteEntityNotFoundException);
    expect(() => repo.findOneWhereOrFail({ sku: "MISSING" })).toThrow(
      SqliteEntityNotFoundException,
    );

    // Edge cases: empty insert/update, offset without limit, invalid order/limit/offset
    expect(() => repo.insert({})).toThrow(/empty object/);
    expect(() => repo.updateById(1, {})).toThrow(/empty object/);
    expect(repo.findAll({ orderBy: "id", offset: 2 })).toHaveLength(2);
    expect(() =>
      repo.findAll({ orderBy: "id", order: "SIDEWAYS" as any }),
    ).toThrow(/Invalid sort direction/);
    expect(() => repo.findAll({ limit: -1 })).toThrow(/Invalid limit/);
    expect(() => repo.findAll({ offset: 1.5 })).toThrow(/Invalid offset/);
  });

  it("supports native bun:sqlite power features (iterate, values, queryValue, prepare, serialize, toDatabaseAdapter, onQuery, safeIntegers, strict, Symbol.dispose) and edge-case coverage", async () => {
    const events: SqliteQueryEvent[] = [];
    const db = track(
      new SqliteService({
        filename: ":memory:",
        onQuery: (e) => events.push(e),
      }),
    );

    db.exec("CREATE TABLE nums (id INTEGER PRIMARY KEY, val INTEGER)");
    db.run("INSERT INTO nums (id, val) VALUES (?, ?)", [1, 10]);
    db.run("INSERT INTO nums (id, val) VALUES (?, ?)", [2, 20]);

    expect(db.values<[number, number]>("SELECT id, val FROM nums ORDER BY id")).toEqual([
      [1, 10],
      [2, 20],
    ]);
    expect(db.queryValue<number>("SELECT SUM(val) FROM nums")).toBe(30);
    expect(db.queryValue<number>("SELECT val FROM nums WHERE id = ?", [999])).toBeNull();
    expect([...db.iterate<{ id: number }>("SELECT id FROM nums ORDER BY id")]).toEqual([
      { id: 1 },
      { id: 2 },
    ]);

    const prepared = db.prepare<{ val: number }>("SELECT val FROM nums WHERE id = ?");
    expect(prepared.get(2)).toEqual({ val: 20 });
    prepared.finalize();

    const snapshot = db.serialize();
    expect(snapshot).toBeInstanceOf(Uint8Array);
    expect(snapshot.byteLength).toBeGreaterThan(0);

    // toDatabaseAdapter bridge
    const adapter = db.toDatabaseAdapter();
    expect(adapter.healthCheck()).toBe(true);
    const qRes = adapter.query<{ id: number }>("SELECT id FROM nums ORDER BY id");
    expect(qRes.rowCount).toBe(2);
    const wRes = adapter.query("INSERT INTO nums (id, val) VALUES (?, ?)", [3, 30]);
    expect(wRes.affectedRows).toBe(1);
    expect(events.length).toBeGreaterThanOrEqual(5);

    // transactionSync rejects while a competing async transaction holds the lock
    let releaseInside!: () => void;
    const insideStarted = new Promise<void>((resolve) => {
      releaseInside = resolve;
    });
    let allowFinish!: () => void;
    const finishGate = new Promise<void>((resolve) => {
      allowFinish = resolve;
    });

    const asyncTxPromise = db.transaction(async () => {
      releaseInside();
      await finishGate;
    });

    await insideStarted;
    expect(() => db.transactionSync(() => 1)).toThrow(
      /while another transaction is active/,
    );
    allowFinish();
    await asyncTxPromise;

    // safeIntegers (bigint) + strict named params
    const strictDb = track(
      new SqliteService({
        filename: ":memory:",
        safeIntegers: true,
        strict: true,
      }),
    );
    strictDb.exec("CREATE TABLE big (id INTEGER PRIMARY KEY, n INTEGER)");
    strictDb.run("INSERT INTO big (id, n) VALUES ($id, $n)", {
      id: 1n,
      n: 9007199254740993n,
    });
    expect(
      strictDb.queryOne<{ n: bigint }>("SELECT n FROM big WHERE id = $id", {
        id: 1n,
      })?.n,
    ).toBe(9007199254740993n);
    expect(() =>
      strictDb.queryOne("SELECT n FROM big WHERE id = $missing", {}),
    ).toThrow();

    // Symbol.dispose
    let disposedRef!: SqliteService;
    {
      using scoped = new SqliteService({ filename: ":memory:" });
      disposedRef = scoped;
      expect(scoped.isClosed).toBe(false);
    }
    expect(disposedRef.isClosed).toBe(true);

    // SqliteMigrationRunner edge cases
    const migDb = track(new SqliteService({ filename: ":memory:" }));
    const runner = new SqliteMigrationRunner(migDb);
    expect(() => runner.status([{ id: "", up: "SELECT 1" }])).toThrow(/non-empty/);
    expect(() =>
      runner.status([
        { id: "001", up: "SELECT 1" },
        { id: "001", up: "SELECT 1" },
      ]),
    ).toThrow(/Duplicate migration id/);

    await runner.up([
      {
        id: "001_nontx",
        up: "CREATE TABLE nt (id INTEGER PRIMARY KEY)",
        transactional: false,
      },
      {
        id: "002_with_down",
        up: "CREATE TABLE wd (id INTEGER PRIMARY KEY)",
        down: "DROP TABLE wd",
      },
    ]);
    const stepDown = await runner.down(
      [
        { id: "001_nontx", up: "SELECT 1" },
        { id: "002_with_down", up: "SELECT 1", down: "DROP TABLE wd" },
      ],
      { steps: 1 },
    );
    expect(stepDown.map((r) => r.id)).toEqual(["002_with_down"]);

    await expect(
      runner.down([{ id: "001_nontx", up: "SELECT 1" }]),
    ).rejects.toThrow(/no "down" handler/);

    await expect(runner.down([])).rejects.toThrow(/definition not found/);

    // SqliteModule.forRootAsync validation & extraProviders
    expect(() => SqliteModule.forRootAsync({} as any)).toThrow(
      /requires one of "useFactory", "useClass", or "useExisting"/,
    );

    const EXTRA_TOKEN = "EXTRA_SQLITE_DEP";
    const asyncWithExtra = await Test.createTestingModule({
      imports: [
        SqliteModule.forRootAsync({
          extraProviders: [{ provide: EXTRA_TOKEN, useValue: ":memory:" }],
          inject: [EXTRA_TOKEN],
          useFactory: (filename: string) => ({ filename }),
        }),
      ],
    }).compile();
    await asyncWithExtra.init();
    expect(asyncWithExtra.get(SqliteService).healthCheck()).toBe(true);
    await asyncWithExtra.close();
  });
});
