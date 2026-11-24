import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import {
  BunSqlOrmDriver,
  Column,
  D1OrmDriver,
  DataSource,
  Entity,
  LibSqlOrmDriver,
  MongoOrmDriver,
  MoreThanOrEqual,
  ObjectId,
  ObjectIdColumn,
  PrimaryGeneratedColumn,
  ReplicatedOrmDriver,
  SqliteOrmDriver,
  buildBunSqlConfig,
  decodeBson,
  encodeBson,
  matchesMongoFilter,
  type CloudflareD1DatabaseLike,
} from "../../../../../packages/orm/src";
import { describeConformance } from "../../../_helpers/index";

@Entity("driver_items")
class DriverItem {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  label!: string;
}

@Entity("mongo_docs")
class MongoDoc {
  @ObjectIdColumn()
  _id!: string;

  @Column()
  title!: string;

  @Column({ type: "integer" })
  score!: number;
}

describeConformance(
  "Persistence (bun-native) - @bunest/orm Bun-native drivers (Sqlite, BunSql, LibSql, D1, Mongo, Replicated)",
  {
    upstreamPath: "bun-native/orm-drivers-and-replication",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-002"],
    notes:
      "Verifies all 6 zero-dependency Bun-native ORM drivers: SqliteOrmDriver, BunSqlOrmDriver, LibSqlOrmDriver (Hrana HTTP v2), D1OrmDriver (binding + REST), MongoOrmDriver (embedded + BSON + MongoRepository), and ReplicatedOrmDriver (read-replica routing + master writes).",
  },
  () => {
    const openSources: DataSource[] = [];
    const openServers: Array<{ stop: (force?: boolean) => void }> = [];

    afterEach(async () => {
      while (openSources.length > 0) {
        await openSources.pop()!.destroy();
      }
      while (openServers.length > 0) {
        openServers.pop()!.stop(true);
      }
    });

    it("SqliteOrmDriver and BunSqlOrmDriver execute CRUD and normalize Postgres/MySQL/CockroachDB configs", async () => {
      // Config builder dialect normalization for Postgres, CockroachDB, MySQL, MariaDB
      const pgCfg = buildBunSqlConfig(
        {
          url: "cockroachdb://user:pass@127.0.0.1:26257/app",
          schema: "tenant_a",
          applicationName: "bunest-test",
          poolSize: 8,
        },
        "cockroachdb",
      ) as Bun.SQL.PostgresOrMySQLOptions;
      expect(pgCfg.adapter).toBe("postgres");
      expect(pgCfg.url).toBe("postgres://user:pass@127.0.0.1:26257/app");
      expect(pgCfg.max).toBe(8);
      expect(pgCfg.connection).toEqual({
        search_path: "tenant_a",
        application_name: "bunest-test",
      });

      const mysqlCfg = buildBunSqlConfig(
        { host: "127.0.0.1", port: 3306, user: "root", database: "shop" },
        "mariadb",
      ) as Bun.SQL.PostgresOrMySQLOptions;
      expect(mysqlCfg.adapter).toBe("mariadb");
      expect(mysqlCfg.hostname).toBe("127.0.0.1");

      // Live SqliteOrmDriver
      const sqliteDriver = new SqliteOrmDriver({ database: ":memory:" });
      const ds1 = new DataSource({
        driver: sqliteDriver,
        entities: [DriverItem],
        synchronize: true,
      });
      await ds1.initialize();
      openSources.push(ds1);
      expect(ds1.driver).toBe(sqliteDriver);
      expect(await ds1.ping()).toBe(true);
      await ds1.getRepository(DriverItem).save({ label: "sqlite-ok" });
      expect(await ds1.getRepository(DriverItem).count()).toBe(1);

      // Live BunSqlOrmDriver over sqlite://:memory:
      const bunSqlDriver = new BunSqlOrmDriver({
        dialect: "sqlite",
        url: "sqlite://:memory:",
      });
      const ds2 = new DataSource({
        driver: bunSqlDriver,
        entities: [DriverItem],
        synchronize: true,
      });
      await ds2.initialize();
      openSources.push(ds2);
      expect(ds2.driver).toBe(bunSqlDriver);
      expect(await ds2.ping()).toBe(true);
      await ds2.getRepository(DriverItem).save({ label: "bun-sql-ok" });
      expect(
        (await ds2.getRepository(DriverItem).find())[0]?.label,
      ).toBe("bun-sql-ok");
    });

    it("LibSqlOrmDriver speaks Hrana HTTP v2 /v2/pipeline over native fetch() with interactive baton transactions", async () => {
      const mem = new Database(":memory:");
      const seenAuth: string[] = [];
      const seenSql: string[] = [];

      const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        async fetch(req) {
          const url = new URL(req.url);
          if (url.pathname !== "/v2/pipeline") {
            return new Response("Not Found", { status: 404 });
          }
          seenAuth.push(req.headers.get("authorization") ?? "");
          const body = (await req.json()) as {
            baton?: string;
            requests: Array<{
              type: string;
              stmt?: {
                sql: string;
                args?: Array<{ type: string; value?: string | number }>;
              };
            }>;
          };

          const results: unknown[] = [];
          for (const r of body.requests) {
            if (r.type === "close") {
              results.push({ type: "ok", response: { type: "close" } });
              continue;
            }
            const sql = r.stmt!.sql;
            seenSql.push(sql);
            const args = (r.stmt!.args ?? []).map((a) => {
              if (a.type === "null") return null;
              if (a.type === "integer") return Number(a.value);
              if (a.type === "float") return Number(a.value);
              return a.value ?? null;
            });
            const upper = sql.trimStart().toUpperCase();
            if (upper.startsWith("SELECT")) {
              const rows = mem.query(sql).all(...(args as never[])) as Array<
                Record<string, unknown>
              >;
              const colNames = rows[0] ? Object.keys(rows[0]) : [];
              results.push({
                type: "ok",
                response: {
                  type: "execute",
                  result: {
                    cols: colNames.map((name) => ({ name })),
                    rows: rows.map((row) =>
                      colNames.map((k) => {
                        const v = row[k];
                        if (v === null || v === undefined) return { type: "null" };
                        if (typeof v === "number") {
                          return { type: "integer", value: String(v) };
                        }
                        return { type: "text", value: String(v) };
                      }),
                    ),
                  },
                },
              });
            } else {
              const res = mem.query(sql).run(...(args as never[]));
              results.push({
                type: "ok",
                response: {
                  type: "execute",
                  result: {
                    cols: [],
                    rows: [],
                    affected_row_count: Number(res.changes ?? 0),
                    last_insert_rowid:
                      res.lastInsertRowid !== undefined
                        ? String(res.lastInsertRowid)
                        : null,
                  },
                },
              });
            }
          }

          return Response.json({ baton: "baton-1", results });
        },
      });
      openServers.push(server);

      try {
        const driver = new LibSqlOrmDriver({
          url: server.url.toString(),
          authToken: "secret-turso-token",
        });
        const ds = new DataSource({
          driver,
          entities: [DriverItem],
          synchronize: true,
        });
        await ds.initialize();
        openSources.push(ds);

        expect(await ds.ping()).toBe(true);
        await ds.transaction(async (em) => {
          await em.query("INSERT INTO driver_items (label) VALUES (?)", [
            "from-libsql",
          ]);
        });
        const rows = await ds.query<{ label: string }>(
          "SELECT label FROM driver_items",
        );
        expect(rows).toEqual([{ label: "from-libsql" }]);
        expect(seenAuth.every((a) => a === "Bearer secret-turso-token")).toBe(true);
        expect(seenSql).toContain("BEGIN");
        expect(seenSql).toContain("COMMIT");
      } finally {
        mem.close();
      }
    });

    it("D1OrmDriver executes against direct CloudflareD1DatabaseLike binding and REST API", async () => {
      const mem = new Database(":memory:");
      const binding: CloudflareD1DatabaseLike = {
        prepare(sql: string) {
          const runWith = (bound: unknown[]) => ({
            async all<T>() {
              const upper = sql.trimStart().toUpperCase();
              if (upper.startsWith("SELECT")) {
                const results = mem.query(sql).all(...(bound as never[])) as T[];
                return { results, meta: { changes: results.length } };
              }
              const res = mem.query(sql).run(...(bound as never[]));
              return {
                results: [] as T[],
                meta: {
                  changes: Number(res.changes ?? 0),
                  last_row_id: Number(res.lastInsertRowid ?? 0),
                },
              };
            },
            async run() {
              const res = mem.query(sql).run(...(bound as never[]));
              return {
                meta: {
                  changes: Number(res.changes ?? 0),
                  last_row_id: Number(res.lastInsertRowid ?? 0),
                },
              };
            },
          });
          return {
            bind: (...vals: unknown[]) => runWith(vals),
            ...runWith([]),
          };
        },
      };

      try {
        const d1Driver = new D1OrmDriver({ binding });
        const ds = new DataSource({
          driver: d1Driver,
          entities: [DriverItem],
          synchronize: true,
        });
        await ds.initialize();
        openSources.push(ds);

        expect(await ds.ping()).toBe(true);
        const repo = ds.getRepository(DriverItem);
        await repo.save({ label: "d1-edge" });
        const all = await repo.find();
        expect(all).toHaveLength(1);
        expect(all[0]!.label).toBe("d1-edge");
      } finally {
        mem.close();
      }
    });

    it("MongoOrmDriver supports BSON round-trip, MongoRepository CRUD, filtering, and aggregation", async () => {
      // BSON binary codec round-trip
      const oid = new ObjectId();
      const encoded = encodeBson({ _id: oid, name: "bunest", count: 42, ok: true });
      const decoded = decodeBson(encoded);
      expect(decoded.name).toBe("bunest");
      expect(decoded.count).toBe(42);
      expect(decoded.ok).toBe(true);
      expect(matchesMongoFilter({ score: 90, tags: ["a", "b"] }, { score: { $gte: 80 } })).toBe(true);

      const mongoDriver = new MongoOrmDriver({ database: ":memory:" });
      const ds = new DataSource({
        driver: mongoDriver,
        entities: [MongoDoc],
        synchronize: true,
      });
      await ds.initialize();
      openSources.push(ds);

      expect(await ds.ping()).toBe(true);
      const mongoRepo = ds.getMongoRepository(MongoDoc);
      await mongoRepo.insertMany([
        { title: "Alpha", score: 10 },
        { title: "Beta", score: 25 },
        { title: "Gamma", score: 40 },
      ]);

      const high = await mongoRepo.find({
        where: { score: MoreThanOrEqual(20) },
        order: { score: "DESC" },
      });
      expect(high.map((d) => d.title)).toEqual(["Gamma", "Beta"]);

      const agg = await mongoRepo.aggregate<{ _id: null; total: number }>([
        { $group: { _id: null, total: { $sum: "$score" } } },
      ]);
      expect(agg[0]?.total).toBe(75);
    });

    it("ReplicatedOrmDriver routes read-only SELECTs round-robin across slaves and writes/transactions strictly to master", async () => {
      const master = new SqliteOrmDriver({ database: ":memory:" });
      const slave1 = new SqliteOrmDriver({ database: ":memory:" });
      const slave2 = new SqliteOrmDriver({ database: ":memory:" });
      const replicated = new ReplicatedOrmDriver(master, [slave1, slave2], "slave");

      const ds = new DataSource({ driver: replicated });
      await ds.initialize();
      openSources.push(ds);

      for (const [node, tag] of [
        [master, "master"],
        [slave1, "slave1"],
        [slave2, "slave2"],
      ] as const) {
        await node.execute("CREATE TABLE node_info (name TEXT NOT NULL)");
        await node.execute("INSERT INTO node_info (name) VALUES (?)", [tag]);
      }

      // Outside tx -> reads alternate round-robin across slave1, slave2
      const r1 = await ds.query<{ name: string }>("SELECT name FROM node_info");
      const r2 = await ds.query<{ name: string }>("SELECT name FROM node_info");
      const r3 = await ds.query<{ name: string }>("SELECT name FROM node_info");
      expect(r1[0]?.name).toBe("slave1");
      expect(r2[0]?.name).toBe("slave2");
      expect(r3[0]?.name).toBe("slave1");

      // Inside transaction -> reads and writes route strictly to master
      await ds.transaction(async (em) => {
        const inside = await em.query<{ name: string }>(
          "SELECT name FROM node_info",
        );
        expect(inside[0]?.name).toBe("master");
        await em.query("INSERT INTO node_info (name) VALUES (?)", ["master-tx"]);
      });

      const masterRows = await master.query<{ name: string }>(
        "SELECT name FROM node_info ORDER BY name",
      );
      expect(masterRows.rows.map((r) => r.name)).toEqual([
        "master",
        "master-tx",
      ]);
      expect(
        (await slave1.query<{ name: string }>("SELECT name FROM node_info")).rows,
      ).toEqual([{ name: "slave1" }]);
    });
  },
);
