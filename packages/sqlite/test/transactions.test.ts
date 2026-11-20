import "reflect-metadata";
import { afterEach, describe, expect, it } from "bun:test";
import { SqliteService } from "../src/index";

describe("SqliteService Transactions & AsyncLocalStorage", () => {
  const dbs: SqliteService[] = [];
  const createDb = (name?: string): SqliteService => {
    const db = new SqliteService({ filename: ":memory:", name });
    db.exec(
      "CREATE TABLE ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, entry TEXT NOT NULL)",
    );
    dbs.push(db);
    return db;
  };

  afterEach(() => {
    while (dbs.length > 0) {
      dbs.pop()!.close();
    }
  });

  it("commits on success and propagates transaction context via AsyncLocalStorage", async () => {
    const db = createDb();

    const insertEntry = async (entry: string) => {
      await Bun.sleep(2);
      expect(db.isInTransaction()).toBe(true);
      expect(db.getCurrentTransaction()?.depth).toBe(0);
      db.run("INSERT INTO ledger (entry) VALUES (?)", [entry]);
    };

    expect(db.isInTransaction()).toBe(false);
    expect(db.getCurrentTransaction()).toBeUndefined();

    const result = await db.transaction(async (tx) => {
      expect(tx.depth).toBe(0);
      expect(tx.isNested).toBe(false);
      expect(db.getCurrentTransaction()).toBe(tx);
      await insertEntry("first");
      await insertEntry("second");
      return "committed";
    });

    expect(result).toBe("committed");
    expect(db.isInTransaction()).toBe(false);
    expect(db.inDatabaseTransaction).toBe(false);
    expect(
      db.query<{ entry: string }>("SELECT entry FROM ledger ORDER BY id"),
    ).toEqual([{ entry: "first" }, { entry: "second" }]);
  });

  it("rolls back completely when callback throws", async () => {
    const db = createDb();
    db.run("INSERT INTO ledger (entry) VALUES (?)", ["baseline"]);

    await expect(
      db.transaction(async () => {
        db.run("INSERT INTO ledger (entry) VALUES (?)", ["transient"]);
        await Bun.sleep(2);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(db.isInTransaction()).toBe(false);
    expect(db.inDatabaseTransaction).toBe(false);
    expect(
      db.query<{ entry: string }>("SELECT entry FROM ledger ORDER BY id"),
    ).toEqual([{ entry: "baseline" }]);
  });

  it("supports nested SAVEPOINT partial rollback while committing outer work", async () => {
    const db = createDb();

    await db.transaction(async (outerTx) => {
      expect(outerTx.depth).toBe(0);
      db.run("INSERT INTO ledger (entry) VALUES (?)", ["outer-before"]);

      // Inner savepoint #1 fails and is caught by outer
      let caught = false;
      try {
        await db.transaction(
          async (innerTx) => {
            expect(innerTx.depth).toBe(1);
            expect(innerTx.isNested).toBe(true);
            expect(innerTx.savepointName).toMatch(/^step_a_/);
            expect(db.getCurrentTransaction()).toBe(innerTx);

            db.run("INSERT INTO ledger (entry) VALUES (?)", ["inner-aborted"]);
            await Bun.sleep(2);
            throw new Error("savepoint-failure");
          },
          { savepointName: "step_a" },
        );
      } catch (err) {
        caught = (err as Error).message === "savepoint-failure";
      }
      expect(caught).toBe(true);
      expect(db.getCurrentTransaction()).toBe(outerTx);

      // Inner savepoint #2 succeeds, containing a deeper level-2 savepoint that rolls back
      await db.transaction(async (lvl1) => {
        expect(lvl1.depth).toBe(1);
        db.run("INSERT INTO ledger (entry) VALUES (?)", ["lvl1-kept"]);

        try {
          await db.transaction(async (lvl2) => {
            expect(lvl2.depth).toBe(2);
            db.run("INSERT INTO ledger (entry) VALUES (?)", ["lvl2-rolled-back"]);
            throw new Error("lvl2-fail");
          });
        } catch {
          // swallow lvl2 failure
        }
      });

      db.run("INSERT INTO ledger (entry) VALUES (?)", ["outer-after"]);
    });

    expect(db.inDatabaseTransaction).toBe(false);
    expect(
      db.query<{ entry: string }>("SELECT entry FROM ledger ORDER BY id"),
    ).toEqual([
      { entry: "outer-before" },
      { entry: "lvl1-kept" },
      { entry: "outer-after" },
    ]);
  });

  it("rolls back outer transaction if nested savepoint error propagates uncaught", async () => {
    const db = createDb();

    await expect(
      db.transaction(async () => {
        db.run("INSERT INTO ledger (entry) VALUES (?)", ["outer-1"]);
        await db.transaction(async () => {
          db.run("INSERT INTO ledger (entry) VALUES (?)", ["inner-1"]);
          throw new Error("fatal-nested");
        });
      }),
    ).rejects.toThrow("fatal-nested");

    expect(db.inDatabaseTransaction).toBe(false);
    expect(db.query("SELECT * FROM ledger")).toEqual([]);
  });

  it("isolates concurrent async transactions cleanly via FIFO lock and AsyncLocalStorage", async () => {
    const db = createDb();
    const seenIds: Record<string, string[]> = { a: [], b: [], c: [] };

    const txA = db.transaction(async (tx) => {
      seenIds.a!.push(tx.id);
      db.run("INSERT INTO ledger (entry) VALUES (?)", ["A1"]);
      await Bun.sleep(15);
      expect(db.getCurrentTransaction()?.id).toBe(tx.id);
      seenIds.a!.push(db.getCurrentTransaction()!.id);
      db.run("INSERT INTO ledger (entry) VALUES (?)", ["A2"]);
      return "A";
    });

    // Branch B fails and rolls back — must NOT affect A or C!
    const txB = db
      .transaction(async (tx) => {
        seenIds.b!.push(tx.id);
        db.run("INSERT INTO ledger (entry) VALUES (?)", ["B_SHOULD_ROLLBACK"]);
        await Bun.sleep(10);
        expect(db.getCurrentTransaction()?.id).toBe(tx.id);
        throw new Error("B-failed");
      })
      .catch((err: Error) => err.message);

    const txC = db.transaction(async (tx) => {
      seenIds.c!.push(tx.id);
      db.run("INSERT INTO ledger (entry) VALUES (?)", ["C1"]);
      await Bun.sleep(5);
      expect(db.getCurrentTransaction()?.id).toBe(tx.id);
      return "C";
    });

    const [resA, resB, resC] = await Promise.all([txA, txB, txC]);
    expect(resA).toBe("A");
    expect(resB).toBe("B-failed");
    expect(resC).toBe("C");

    // Every branch received a distinct transaction ID and preserved it across awaits
    expect(seenIds.a![0]).toBe(seenIds.a![1]);
    expect(new Set([seenIds.a![0], seenIds.b![0], seenIds.c![0]]).size).toBe(3);

    // Only committed entries A1, A2, C1 exist
    expect(
      db.query<{ entry: string }>("SELECT entry FROM ledger ORDER BY id"),
    ).toEqual([{ entry: "A1" }, { entry: "A2" }, { entry: "C1" }]);
  });

  it("keeps ALS transaction contexts isolated across distinct SqliteService connections", async () => {
    const db1 = createDb("primary");
    const db2 = createDb("secondary");

    await db1.transaction(async (tx1) => {
      expect(db1.getCurrentTransaction()).toBe(tx1);
      expect(db2.getCurrentTransaction()).toBeUndefined();

      await db2.transaction(async (tx2) => {
        expect(db1.getCurrentTransaction()).toBe(tx1);
        expect(db2.getCurrentTransaction()).toBe(tx2);
        expect(tx1.connectionName).toBe("primary");
        expect(tx2.connectionName).toBe("secondary");
      });

      expect(db1.getCurrentTransaction()).toBe(tx1);
      expect(db2.getCurrentTransaction()).toBeUndefined();
    });
  });

  it("supports synchronous transactionSync with nested savepoints", () => {
    const db = createDb();

    const total = db.transactionSync(
      () => {
        db.run("INSERT INTO ledger (entry) VALUES (?)", ["sync-outer"]);
        try {
          db.transactionSync(() => {
            db.run("INSERT INTO ledger (entry) VALUES (?)", ["sync-inner-fail"]);
            throw new Error("abort-inner");
          });
        } catch {
          // caught
        }
        return db.query("SELECT * FROM ledger").length;
      },
      { mode: "IMMEDIATE" },
    );

    expect(total).toBe(1);
    expect(
      db.query<{ entry: string }>("SELECT entry FROM ledger"),
    ).toEqual([{ entry: "sync-outer" }]);
  });
});
