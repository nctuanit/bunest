import { afterEach, describe, expect, it } from "bun:test";
import { DataSource } from "../../../../../packages/orm/src";
import { describeConformance } from "../../../_helpers/index";

describeConformance(
  "Persistence (bun-native) - @bunest/orm concurrent FIFO locking & cross-connection isolation",
  {
    upstreamPath: "bun-native/concurrent-isolation-and-locking",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Verifies FIFO top-level transaction serialization on SqliteOrmDriver, ACID counter integrity under concurrency, BunSqlOrmDriver transaction isolation, and cross-connection non-blocking parallelism.",
  },
  () => {
    const openSources: DataSource[] = [];

    const track = async (ds: DataSource): Promise<DataSource> => {
      await ds.initialize();
      openSources.push(ds);
      return ds;
    };

    afterEach(async () => {
      while (openSources.length > 0) {
        await openSources.pop()!.destroy();
      }
    });

    describe("FIFO top-level transaction serialization", () => {
      it("serializes concurrent Promise.all([ds.transaction(...)]) calls strictly in FIFO order with ACID rollback isolation", async () => {
        const ds = await track(
          new DataSource({ type: "sqlite", database: ":memory:" }),
        );
        await ds.driver.execute(
          "CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL)",
        );

        const trace: string[] = [];

        const results = await Promise.all([
          ds.transaction(async (em) => {
            trace.push("tx1:enter");
            await em.query("INSERT INTO events (label) VALUES (?)", ["tx1-a"]);
            await Bun.sleep(15);
            await em.query("INSERT INTO events (label) VALUES (?)", ["tx1-b"]);
            trace.push("tx1:exit");
            return "tx1";
          }),
          ds
            .transaction(async (em) => {
              trace.push("tx2:enter");
              await em.query("INSERT INTO events (label) VALUES (?)", [
                "tx2-aborted",
              ]);
              await Bun.sleep(5);
              trace.push("tx2:throw");
              throw new Error("tx2-fail");
            })
            .catch((e: Error) => e.message),
          ds.transaction(async (em) => {
            trace.push("tx3:enter");
            await em.query("INSERT INTO events (label) VALUES (?)", ["tx3-a"]);
            trace.push("tx3:exit");
            return "tx3";
          }),
        ]);

        expect(results).toEqual(["tx1", "tx2-fail", "tx3"]);
        expect(trace).toEqual([
          "tx1:enter",
          "tx1:exit",
          "tx2:enter",
          "tx2:throw",
          "tx3:enter",
          "tx3:exit",
        ]);
        const rows = await ds.query<{ label: string }>(
          "SELECT label FROM events ORDER BY id",
        );
        expect(rows.map((r) => r.label)).toEqual(["tx1-a", "tx1-b", "tx3-a"]);
      });

      it("maintains ACID counter integrity across 10 concurrent read-modify-write transactions", async () => {
        const ds = await track(
          new DataSource({ type: "sqlite", database: ":memory:" }),
        );
        await ds.driver.execute(
          "CREATE TABLE counter (id INTEGER PRIMARY KEY, val INTEGER NOT NULL)",
        );
        await ds.query("INSERT INTO counter (id, val) VALUES (1, 0)");

        await Promise.all(
          Array.from({ length: 10 }, (_, idx) =>
            ds.transaction(async (em) => {
              const rows = await em.query<{ val: number }>(
                "SELECT val FROM counter WHERE id = 1",
              );
              const current = rows[0]!.val;
              if (idx % 3 === 0) {
                await Bun.sleep(2);
              }
              await em.query("UPDATE counter SET val = ? WHERE id = 1", [
                current + 1,
              ]);
            }),
          ),
        );

        const finalRows = await ds.query<{ val: number }>(
          "SELECT val FROM counter WHERE id = 1",
        );
        expect(finalRows[0]?.val).toBe(10);
      });

      it("isolates BunSqlOrmDriver transactions cleanly on sqlite://:memory:", async () => {
        const ds = await track(
          new DataSource({
            type: "sqlite",
            url: "sqlite://:memory:",
            useBunSql: true,
          }),
        );
        await ds.driver.execute(
          "CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL)",
        );

        await ds.transaction(async (em) => {
          await em.query("INSERT INTO events (label) VALUES (?)", ["s1-a"]);
          await em.query("INSERT INTO events (label) VALUES (?)", ["s1-b"]);
        });

        await expect(
          ds.transaction(async (em) => {
            await em.query("INSERT INTO events (label) VALUES (?)", [
              "s2-aborted",
            ]);
            throw new Error("s2-fail");
          }),
        ).rejects.toThrow("s2-fail");

        await ds.transaction(async (em) => {
          await em.query("INSERT INTO events (label) VALUES (?)", ["s3-a"]);
        });

        const rows = await ds.query<{ label: string }>(
          "SELECT label FROM events ORDER BY id ASC",
        );
        expect(rows.map((r) => r.label)).toEqual(["s1-a", "s1-b", "s3-a"]);
      });
    });

    describe("cross-connection concurrency isolation", () => {
      it("runs concurrent transactions on two named DataSource instances in parallel with zero shared lock contention", async () => {
        const primary = await track(
          new DataSource({ name: "primary", type: "sqlite", database: ":memory:" }),
        );
        const secondary = await track(
          new DataSource({
            name: "secondary",
            type: "sqlite",
            database: ":memory:",
          }),
        );
        await primary.driver.execute("CREATE TABLE t (v TEXT)");
        await secondary.driver.execute("CREATE TABLE t (v TEXT)");

        let primaryEntered!: () => void;
        const primaryInside = new Promise<void>((r) => {
          primaryEntered = r;
        });
        let secondaryDone = false;

        const p1 = primary.transaction(async (em) => {
          await em.query("INSERT INTO t (v) VALUES (?)", ["p1"]);
          primaryEntered();
          const deadline = Date.now() + 2000;
          while (!secondaryDone && Date.now() < deadline) {
            await Bun.sleep(2);
          }
          expect(secondaryDone).toBe(true);
        });

        await primaryInside;

        const p2 = secondary.transaction(async (em) => {
          await em.query("INSERT INTO t (v) VALUES (?)", ["s1"]);
          secondaryDone = true;
        });

        await Promise.all([p1, p2]);
        expect(await primary.query<{ v: string }>("SELECT v FROM t")).toEqual([
          { v: "p1" },
        ]);
        expect(await secondary.query<{ v: string }>("SELECT v FROM t")).toEqual([
          { v: "s1" },
        ]);
      });
    });
  },
);
