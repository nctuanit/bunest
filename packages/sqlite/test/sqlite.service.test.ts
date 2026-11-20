import "reflect-metadata";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
  BaseSqliteRepository,
  SqliteService,
  assertSafeSqlIdentifier,
} from "../src/index";

interface UserRow extends Record<string, unknown> {
  id: number;
  name: string;
  email: string;
  bio: string | null;
  active: number;
}

describe("SqliteService", () => {
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

  it("executes parameterized CRUD queries with positional, named, and binary bindings", () => {
    const db = track(new SqliteService({ filename: ":memory:" }));
    db.exec(`
      CREATE TABLE items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        payload BLOB,
        active INTEGER NOT NULL DEFAULT 1
      );
    `);

    const blob = new Uint8Array([10, 20, 30, 40]);
    const r1 = db.run(
      "INSERT INTO items (name, payload, active) VALUES (?, ?, ?)",
      ["alpha", blob, true],
    );
    expect(r1.changes).toBe(1);
    expect(r1.lastInsertRowid).toBe(1);

    const r2 = db.run(
      "INSERT INTO items (name, payload, active) VALUES ($name, $payload, $active)",
      { $name: "beta", $payload: null, $active: false },
    );
    expect(r2.changes).toBe(1);
    expect(r2.lastInsertRowid).toBe(2);

    const rows = db.query<{
      id: number;
      name: string;
      payload: Uint8Array | null;
      active: number;
    }>("SELECT id, name, payload, active FROM items ORDER BY id ASC");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.name).toBe("alpha");
    expect(Array.from(rows[0]!.payload!)).toEqual([10, 20, 30, 40]);
    expect(rows[0]!.active).toBe(1);
    expect(rows[1]!.name).toBe("beta");
    expect(rows[1]!.payload).toBeNull();
    expect(rows[1]!.active).toBe(0);

    const one = db.queryOne<{ id: number; name: string }>(
      "SELECT id, name FROM items WHERE name = :name",
      { ":name": "beta" },
    );
    expect(one).toEqual({ id: 2, name: "beta" });

    const missing = db.queryOne("SELECT * FROM items WHERE id = ?", [999]);
    expect(missing).toBeNull();

    const upd = db.run("UPDATE items SET name = ? WHERE id = ?", [
      "alpha-updated",
      1,
    ]);
    expect(upd.changes).toBe(1);

    const del = db.run("DELETE FROM items WHERE id = ?", [2]);
    expect(del.changes).toBe(1);
    expect(db.query("SELECT * FROM items")).toHaveLength(1);
  });

  it("caches prepared statements with bounded LRU eviction and supports disabling cache", () => {
    const db = track(
      new SqliteService({ filename: ":memory:", statementCacheSize: 2 }),
    );
    db.exec("CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT)");

    db.run("INSERT INTO kv (k, v) VALUES (?, ?)", ["a", "1"]);
    expect(db.getCachedStatementCount()).toBe(1);

    db.query("SELECT * FROM kv WHERE k = ?", ["a"]);
    expect(db.getCachedStatementCount()).toBe(2);

    // Hit first query again -> stays at capacity 2
    db.run("INSERT INTO kv (k, v) VALUES (?, ?)", ["b", "2"]);
    expect(db.getCachedStatementCount()).toBe(2);

    // Distinct 3rd SQL evicts LRU entry
    db.queryOne("SELECT v FROM kv WHERE k = ?", ["b"]);
    expect(db.getCachedStatementCount()).toBe(2);

    db.clearStatementCache();
    expect(db.getCachedStatementCount()).toBe(0);

    // Zero cache size disables caching
    const uncached = track(
      new SqliteService({ filename: ":memory:", statementCacheSize: 0 }),
    );
    uncached.exec("CREATE TABLE t (x INTEGER)");
    uncached.run("INSERT INTO t (x) VALUES (?)", [42]);
    expect(uncached.queryOne<{ x: number }>("SELECT x FROM t")).toEqual({
      x: 42,
    });
    expect(uncached.getCachedStatementCount()).toBe(0);
  });

  it("applies foreign_keys, busy_timeout, WAL mode on files, and readonly mode safely", () => {
    // Foreign keys enforced by default
    const fkDb = track(new SqliteService({ filename: ":memory:" }));
    fkDb.exec(`
      CREATE TABLE parents (id INTEGER PRIMARY KEY);
      CREATE TABLE children (
        id INTEGER PRIMARY KEY,
        parent_id INTEGER NOT NULL REFERENCES parents(id)
      );
    `);
    expect(() =>
      fkDb.run("INSERT INTO children (id, parent_id) VALUES (?, ?)", [1, 999]),
    ).toThrow();

    // File-backed DB enables WAL mode and releases handle on close so file can be removed
    const dir = mkdtempSync(join(tmpdir(), "bunest-sqlite-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "app.sqlite");

    const fileDb = new SqliteService({
      filename: dbPath,
      wal: true,
      busyTimeout: 2500,
      pragmas: { synchronous: "NORMAL" },
    });
    const modeRow = fileDb.queryOne<{ journal_mode: string }>(
      "PRAGMA journal_mode",
    );
    expect(modeRow?.journal_mode.toLowerCase()).toBe("wal");

    const timeoutRow = fileDb.queryOne<{ timeout: number }>(
      "PRAGMA busy_timeout",
    );
    expect(timeoutRow?.timeout).toBe(2500);

    fileDb.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)");
    fileDb.run("INSERT INTO notes (body) VALUES (?)", ["persisted"]);
    fileDb.close();

    // Reopen as readonly
    const roDb = new SqliteService({
      filename: dbPath,
      readonly: true,
    });
    expect(roDb.query<{ body: string }>("SELECT body FROM notes")).toEqual([
      { body: "persisted" },
    ]);
    expect(() =>
      roDb.run("INSERT INTO notes (body) VALUES (?)", ["blocked"]),
    ).toThrow();
    roDb.close();
  });

  it("reports healthCheck accurately and enforces idempotent close()", () => {
    const db = new SqliteService({ filename: ":memory:" });
    expect(db.isClosed).toBe(false);
    expect(db.healthCheck()).toBe(true);

    db.close();
    db.close(); // idempotent

    expect(db.isClosed).toBe(true);
    expect(db.healthCheck()).toBe(false);
    expect(() => db.query("SELECT 1")).toThrow(/closed/i);
  });

  it("validates PRAGMA keys and values against injection", () => {
    expect(() =>
      track(
        new SqliteService({
          filename: ":memory:",
          pragmas: { "foreign_keys; DROP TABLE x": "ON" },
        }),
      ),
    ).toThrow(/Invalid PRAGMA name/);

    expect(() =>
      track(
        new SqliteService({
          filename: ":memory:",
          pragmas: { synchronous: "NORMAL; DROP TABLE x" },
        }),
      ),
    ).toThrow(/disallowed characters/);
  });
});

describe("BaseSqliteRepository", () => {
  let db: SqliteService;
  let repo: BaseSqliteRepository<UserRow, number>;

  afterEach(() => {
    db?.close();
  });

  it("performs parameterized CRUD operations and blocks identifier injection", () => {
    db = new SqliteService({ filename: ":memory:" });
    db.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        bio TEXT,
        active INTEGER NOT NULL DEFAULT 1
      );
    `);
    repo = new BaseSqliteRepository<UserRow, number>(db, "users");

    const r1 = repo.insert({
      name: "Alice",
      email: "alice@example.com",
      bio: null,
      active: 1,
    });
    const r2 = repo.insert({
      name: "Bob'; DROP TABLE users; --",
      email: "bob@example.com",
      bio: "Engineer",
      active: 1,
    });
    const r3 = repo.insert({
      name: "Carol",
      email: "carol@example.com",
      bio: null,
      active: 0,
    });

    expect(r1.lastInsertRowid).toBe(1);
    expect(r2.lastInsertRowid).toBe(2);
    expect(r3.lastInsertRowid).toBe(3);

    // Value containing SQL injection payload is stored literally and table stays intact
    const bob = repo.findById(2);
    expect(bob?.name).toBe("Bob'; DROP TABLE users; --");
    expect(repo.count()).toBe(3);
    expect(repo.exists(2)).toBe(true);
    expect(repo.exists(999)).toBe(false);

    // NULL filtering generates IS NULL cleanly
    const noBio = repo.findWhere({ bio: null }, { orderBy: "id", order: "ASC" });
    expect(noBio.map((u) => u.name)).toEqual(["Alice", "Carol"]);

    // Pagination + ordering
    const page = repo.findAll({ orderBy: "id", order: "DESC", limit: 2, offset: 1 });
    expect(page.map((u) => u.id)).toEqual([2, 1]);

    // Update & findOneWhere
    repo.updateById(1, { bio: "Updated bio" });
    expect(repo.findOneWhere({ email: "alice@example.com" })?.bio).toBe(
      "Updated bio",
    );

    // Delete by ID & deleteWhere
    expect(repo.deleteById(3).changes).toBe(1);
    expect(repo.deleteWhere({ email: "bob@example.com" }).changes).toBe(1);
    expect(repo.count()).toBe(1);

    // Guard against accidental full-table wipe & unsafe identifiers
    expect(() => repo.deleteWhere({})).toThrow(/at least one filter/);
    expect(() => new BaseSqliteRepository(db, "users; DROP TABLE users")).toThrow(
      /Invalid table name/,
    );
    expect(() =>
      repo.findAll({ orderBy: "id; DROP TABLE users" }),
    ).toThrow(/Invalid orderBy column/);
    expect(() => assertSafeSqlIdentifier("bad-name")).toThrow();
  });
});
