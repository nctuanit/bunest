import "reflect-metadata";
import { afterEach, describe, expect, it } from "bun:test";
import { SqlService } from "../../../../../packages/sql/src";
import { SqliteService } from "../../../../../packages/sqlite/src";
import { describeConformance } from "../../../_helpers/index";

describeConformance(
  "Persistence (bun-native) - concurrent FIFO locking, savepoint serialization & LRU statement cache",
  {
    upstreamPath: "bun-native/concurrent-isolation-and-locking",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Verifies FIFO top-level transaction serialization, per-parent nested SAVEPOINT locking without deadlocks, bounded LRU statement cache eviction & DDL invalidation, and cross-connection concurrency.",
  },
  () => {
    const openSqlite: SqliteService[] = [];
    const openSql: SqlService[] = [];

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
    });

    describe("FIFO top-level transaction serialization", () => {
      it("serializes concurrent Promise.all([sqlite.transaction(...)]) calls strictly in FIFO order with ACID rollback isolation", async () => {
        const db = trackSqlite(new SqliteService({ filename: ":memory:" }));
        db.exec(
          "CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL)",
        );

        const trace: string[] = [];

        const results = await Promise.all([
          db.transaction(async () => {
            trace.push("tx1:enter");
            db.run("INSERT INTO events (label) VALUES (?)", ["tx1-a"]);
            await Bun.sleep(15);
            db.run("INSERT INTO events (label) VALUES (?)", ["tx1-b"]);
            trace.push("tx1:exit");
            return "tx1";
          }),
          db
            .transaction(async () => {
              trace.push("tx2:enter");
              db.run("INSERT INTO events (label) VALUES (?)", ["tx2-aborted"]);
              await Bun.sleep(5);
              trace.push("tx2:throw");
              throw new Error("tx2-fail");
            })
            .catch((e: Error) => e.message),
          db.transaction(async () => {
            trace.push("tx3:enter");
            db.run("INSERT INTO events (label) VALUES (?)", ["tx3-a"]);
            trace.push("tx3:exit");
            return "tx3";
          }),
        ]);

        expect(results).toEqual(["tx1", "tx2-fail", "tx3"]);
        // Zero interleaving: strict FIFO enter/exit pairs
        expect(trace).toEqual([
          "tx1:enter",
          "tx1:exit",
          "tx2:enter",
          "tx2:throw",
          "tx3:enter",
          "tx3:exit",
        ]);
        expect(
          db
            .query<{ label: string }>("SELECT label FROM events ORDER BY id")
            .map((r) => r.label),
        ).toEqual(["tx1-a", "tx1-b", "tx3-a"]);
      });

      it("serializes concurrent Promise.all([sqlService.transaction(...)]) calls on sqlite://:memory: without interleaving", async () => {
        const svc = trackSql(new SqlService("sqlite://:memory:"));
        await svc.sql`CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL)`;

        const trace: string[] = [];

        const results = await Promise.all([
          svc.transaction(async (tx) => {
            trace.push("s1:enter");
            await svc.sql`INSERT INTO events (label) VALUES (${"s1-a"})`;
            await Bun.sleep(15);
            expect(svc.getCurrentTransaction()?.id).toBe(tx.id);
            await svc.sql`INSERT INTO events (label) VALUES (${"s1-b"})`;
            trace.push("s1:exit");
            return "s1";
          }),
          svc
            .transaction(async (tx) => {
              trace.push("s2:enter");
              await svc.sql`INSERT INTO events (label) VALUES (${"s2-aborted"})`;
              await Bun.sleep(5);
              expect(svc.getCurrentTransaction()?.id).toBe(tx.id);
              trace.push("s2:throw");
              throw new Error("s2-fail");
            })
            .catch((e: Error) => e.message),
          svc.transaction(async (tx) => {
            trace.push("s3:enter");
            await svc.sql`INSERT INTO events (label) VALUES (${"s3-a"})`;
            expect(svc.getCurrentTransaction()?.id).toBe(tx.id);
            trace.push("s3:exit");
            return "s3";
          }),
        ]);

        expect(results).toEqual(["s1", "s2-fail", "s3"]);
        expect(trace).toEqual([
          "s1:enter",
          "s1:exit",
          "s2:enter",
          "s2:throw",
          "s3:enter",
          "s3:exit",
        ]);
        const rows = await svc.sql<{ label: string }>`
          SELECT label FROM events ORDER BY id ASC
        `;
        expect([...rows].map((r) => r.label)).toEqual([
          "s1-a",
          "s1-b",
          "s3-a",
        ]);
      });

      it("maintains ACID counter integrity across 10 concurrent read-modify-write transactions", async () => {
        const db = trackSqlite(new SqliteService({ filename: ":memory:" }));
        db.exec("CREATE TABLE counter (id INTEGER PRIMARY KEY, val INTEGER NOT NULL)");
        db.run("INSERT INTO counter (id, val) VALUES (1, 0)");

        await Promise.all(
          Array.from({ length: 10 }, (_, idx) =>
            db.transaction(async () => {
              const current = db.queryValue<number>(
                "SELECT val FROM counter WHERE id = 1",
              )!;
              if (idx % 3 === 0) {
                await Bun.sleep(2);
              }
              db.run("UPDATE counter SET val = ? WHERE id = 1", [current + 1]);
            }),
          ),
        );

        expect(
          db.queryValue<number>("SELECT val FROM counter WHERE id = 1"),
        ).toBe(10);
      });
    });

    describe("concurrent sibling nested SAVEPOINT serialization", () => {
      it("prevents savepoint stack corruption on SqliteService when sibling spA fails while spB (with deeper nesting) and spC succeed", async () => {
        const db = trackSqlite(new SqliteService({ filename: ":memory:" }));
        db.exec(
          "CREATE TABLE log (id INTEGER PRIMARY KEY AUTOINCREMENT, msg TEXT NOT NULL)",
        );

        await db.transaction(async () => {
          db.run("INSERT INTO log (msg) VALUES (?)", ["outer-start"]);

          const [rA, rB, rC] = await Promise.all([
            db
              .transaction(async () => {
                db.run("INSERT INTO log (msg) VALUES (?)", ["spA-rollback"]);
                await Bun.sleep(15);
                throw new Error("spA-boom");
              })
              .catch((e: Error) => e.message),

            db.transaction(async () => {
              db.run("INSERT INTO log (msg) VALUES (?)", ["spB-outer"]);
              await Bun.sleep(5);
              await db.transaction(async () => {
                db.run("INSERT INTO log (msg) VALUES (?)", ["spB-deeper"]);
              });
              return "spB-ok";
            }),

            db.transaction(async () => {
              db.run("INSERT INTO log (msg) VALUES (?)", ["spC-ok"]);
              return "spC-ok";
            }),
          ]);

          expect(rA).toBe("spA-boom");
          expect(rB).toBe("spB-ok");
          expect(rC).toBe("spC-ok");

          db.run("INSERT INTO log (msg) VALUES (?)", ["outer-end"]);
        });

        expect(
          db
            .query<{ msg: string }>("SELECT msg FROM log ORDER BY id")
            .map((r) => r.msg),
        ).toEqual([
          "outer-start",
          "spB-outer",
          "spB-deeper",
          "spC-ok",
          "outer-end",
        ]);
      });

      it("prevents savepoint stack corruption on SqlService when sibling savepoints run concurrently via Promise.all", async () => {
        const svc = trackSql(new SqlService("sqlite://:memory:"));
        await svc.sql`CREATE TABLE log (id INTEGER PRIMARY KEY AUTOINCREMENT, msg TEXT NOT NULL)`;

        await svc.transaction(async () => {
          await svc.sql`INSERT INTO log (msg) VALUES (${"outer-start"})`;

          const [rA, rB, rC] = await Promise.all([
            svc
              .transaction(async () => {
                await svc.sql`INSERT INTO log (msg) VALUES (${"spA-rollback"})`;
                await Bun.sleep(15);
                throw new Error("spA-sql-boom");
              })
              .catch((e: Error) => e.message),

            svc.transaction(async () => {
              await svc.sql`INSERT INTO log (msg) VALUES (${"spB-outer"})`;
              await Bun.sleep(5);
              await svc.transaction(async () => {
                await svc.sql`INSERT INTO log (msg) VALUES (${"spB-deeper"})`;
              });
              return "spB-ok";
            }),

            svc.transaction(async () => {
              await svc.sql`INSERT INTO log (msg) VALUES (${"spC-ok"})`;
              return "spC-ok";
            }),
          ]);

          expect(rA).toBe("spA-sql-boom");
          expect(rB).toBe("spB-ok");
          expect(rC).toBe("spC-ok");
        });

        const rows = await svc.sql<{ msg: string }>`
          SELECT msg FROM log ORDER BY id ASC
        `;
        expect([...rows].map((r) => r.msg)).toEqual([
          "outer-start",
          "spB-outer",
          "spB-deeper",
          "spC-ok",
        ]);
      });
    });

    describe("bounded LRU prepared statement cache & DDL invalidation", () => {
      it("enforces statementCacheSize bound and evicts least-recently-used statements", () => {
        const db = trackSqlite(
          new SqliteService({ filename: ":memory:", statementCacheSize: 2 }),
        );
        db.exec("CREATE TABLE nums (n INTEGER PRIMARY KEY)");
        db.run("INSERT INTO nums (n) VALUES (?)", [1]);
        expect(db.getCachedStatementCount()).toBe(1);

        db.query("SELECT n FROM nums WHERE n = ?", [1]);
        expect(db.getCachedStatementCount()).toBe(2);

        // Refresh the INSERT statement so SELECT becomes oldest
        db.run("INSERT INTO nums (n) VALUES (?)", [2]);
        expect(db.getCachedStatementCount()).toBe(2);

        // Third distinct SQL evicts oldest, keeping cache bounded at 2
        db.queryOne("SELECT COUNT(*) AS cnt FROM nums");
        expect(db.getCachedStatementCount()).toBe(2);

        // Manual clear empties cache completely
        db.clearStatementCache();
        expect(db.getCachedStatementCount()).toBe(0);
      });

      it("disables statement caching and finalizes immediately when statementCacheSize is 0 (including iterate)", () => {
        const db = trackSqlite(
          new SqliteService({ filename: ":memory:", statementCacheSize: 0 }),
        );
        db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)");
        db.run("INSERT INTO items (id, name) VALUES (?, ?)", [1, "one"]);
        db.run("INSERT INTO items (id, name) VALUES (?, ?)", [2, "two"]);

        expect(db.getCachedStatementCount()).toBe(0);
        expect(db.query<{ name: string }>("SELECT name FROM items")).toHaveLength(
          2,
        );
        expect(db.getCachedStatementCount()).toBe(0);

        const iterated = [
          ...db.iterate<{ name: string }>("SELECT name FROM items ORDER BY id"),
        ];
        expect(iterated).toEqual([{ name: "one" }, { name: "two" }]);
        expect(db.getCachedStatementCount()).toBe(0);
      });

      it("automatically invalidates cached prepared statements on DDL exec() statements", () => {
        const db = trackSqlite(new SqliteService({ filename: ":memory:" }));
        db.exec("CREATE TABLE docs (id INTEGER PRIMARY KEY, title TEXT)");
        db.run("INSERT INTO docs (id, title) VALUES (?, ?)", [1, "doc-1"]);
        expect(db.getCachedStatementCount()).toBe(1);

        // ALTER TABLE invalidates cache
        db.exec("ALTER TABLE docs ADD COLUMN status TEXT DEFAULT 'draft'");
        expect(db.getCachedStatementCount()).toBe(0);

        // Freshly cached query sees new column cleanly
        expect(
          db.queryOne<{ title: string; status: string }>(
            "SELECT title, status FROM docs WHERE id = ?",
            [1],
          ),
        ).toEqual({ title: "doc-1", status: "draft" });
        expect(db.getCachedStatementCount()).toBe(1);

        // DROP TABLE also invalidates cache
        db.exec("CREATE TABLE temp_tbl (id INTEGER)");
        expect(db.getCachedStatementCount()).toBe(0);
        db.query("SELECT * FROM temp_tbl");
        expect(db.getCachedStatementCount()).toBe(1);
        db.exec("DROP TABLE temp_tbl");
        expect(db.getCachedStatementCount()).toBe(0);
      });
    });

    describe("cross-connection concurrency isolation", () => {
      it("runs concurrent transactions on two named SQLite connections in parallel with zero shared lock contention", async () => {
        const primary = trackSqlite(
          new SqliteService({ name: "primary", filename: ":memory:" }),
        );
        const secondary = trackSqlite(
          new SqliteService({ name: "secondary", filename: ":memory:" }),
        );
        primary.exec("CREATE TABLE t (v TEXT)");
        secondary.exec("CREATE TABLE t (v TEXT)");

        let primaryEntered!: () => void;
        const primaryInside = new Promise<void>((r) => {
          primaryEntered = r;
        });
        let secondaryDone = false;

        const p1 = primary.transaction(async () => {
          primary.run("INSERT INTO t (v) VALUES (?)", ["p1"]);
          primaryEntered();
          // Wait until secondary finishes while primary still holds its own tx lock!
          const deadline = Date.now() + 2000;
          while (!secondaryDone && Date.now() < deadline) {
            await Bun.sleep(2);
          }
          expect(secondaryDone).toBe(true);
        });

        await primaryInside;

        const p2 = secondary.transaction(async () => {
          secondary.run("INSERT INTO t (v) VALUES (?)", ["s1"]);
          secondaryDone = true;
        });

        await Promise.all([p1, p2]);
        expect(primary.query<{ v: string }>("SELECT v FROM t")).toEqual([
          { v: "p1" },
        ]);
        expect(secondary.query<{ v: string }>("SELECT v FROM t")).toEqual([
          { v: "s1" },
        ]);
      });
    });
  },
);
