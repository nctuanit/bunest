import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { Injectable } from "@bunest/core";
import { Test } from "@bunest/testing";
import {
  Column,
  DataSource,
  Embedded,
  Entity,
  ILike,
  InjectRepository,
  JoinColumn,
  JoinTable,
  ManyToMany,
  ManyToOne,
  MongoRepository,
  MoreThan,
  ObjectId,
  ObjectIdColumn,
  OneToMany,
  OrmDriverRegistry,
  OrmModule,
  PrimaryGeneratedColumn,
  ReplicatedOrmDriver,
  SqliteOrmDriver,
  buildBunSqlConfig,
  compileMetadataGraph,
  decodeBson,
  decodeOpMsg,
  encodeBson,
  encodeOpMsg,
  generateSchemaPlan,
  getDialectProfile,
  getSupportedDialects,
  normalizeDialect,
  type CloudflareD1DatabaseLike,
  type OrmDialect,
  type OrmDriver,
  type OrmQueryExecutor,
  type OrmQueryResult,
} from "../src/index";

class MultiGeo {
  @Column("real")
  lat!: number;

  @Column("real")
  lng!: number;

  label(): string {
    return `${this.lat},${this.lng}`;
  }
}

@Entity("multi_users")
class MultiUser {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ unique: true })
  email!: string;

  @Column("integer")
  age!: number;

  @Column({ type: "boolean", default: true })
  active!: boolean;

  @Embedded(() => MultiGeo)
  geo?: MultiGeo;

  @OneToMany(() => MultiPost, (p) => p.author, { cascade: true })
  posts!: MultiPost[];
}

@Entity("multi_tags")
class MultiTag {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ unique: true })
  slug!: string;

  @ManyToMany(() => MultiPost, (p) => p.tags)
  posts!: MultiPost[];
}

@Entity("multi_posts")
class MultiPost {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  title!: string;

  @ManyToOne(() => MultiUser, (u) => u.posts, { onDelete: "CASCADE" })
  @JoinColumn({ name: "author_id" })
  author!: MultiUser;

  @ManyToMany(() => MultiTag, (t) => t.posts, { cascade: true })
  @JoinTable({ name: "multi_post_tags" })
  tags!: MultiTag[];
}

@Entity("mongo_products")
class MongoProduct {
  @ObjectIdColumn()
  _id!: string;

  @Column()
  name!: string;

  @Column()
  category!: string;

  @Column("real")
  price!: number;

  @Embedded(() => MultiGeo)
  origin?: MultiGeo;
}

afterEach(() => {
  OrmDriverRegistry.clear();
});

describe("@bunest/orm — Multi-Database Compatibility (100% Bun Native APIs)", () => {
  it("1. Native Bun.SQL engine (`useBunSql: true`): live CRUD, nested classes, cyclic relations, and nested savepoint transactions", async () => {
    const ds = new DataSource({
      type: "sqlite",
      database: ":memory:",
      useBunSql: true,
      entities: [MultiUser, MultiPost, MultiTag],
      synchronize: true,
    });
    await ds.initialize();

    try {
      expect(ds.driver.driverKind).toBe("bun-sql");
      expect(await ds.ping()).toBe(true);

      const userRepo = ds.getRepository(MultiUser);
      const user = new MultiUser();
      user.email = "bunsql@example.com";
      user.age = 29;
      user.geo = Object.assign(new MultiGeo(), { lat: 10.77, lng: 106.7 });
      const post = new MultiPost();
      post.title = "Powered by Bun.SQL";
      post.author = user;
      user.posts = [post];

      await userRepo.save(user);

      const loaded = await userRepo.findOneOrFail({
        where: { id: user.id },
        relations: { posts: { author: true } },
      });
      expect(loaded.geo).toBeInstanceOf(MultiGeo);
      expect(loaded.geo?.label()).toBe("10.77,106.7");
      expect(loaded.posts[0]?.author).toBe(loaded);
      expect(() => JSON.stringify(loaded)).not.toThrow();

      // Nested savepoint transaction on Bun.SQL
      await ds.transaction(async (em) => {
        await em.save(MultiUser, { email: "tx-outer@example.com", age: 30 });
        await expect(
          em.transaction(async (inner) => {
            await inner.save(MultiUser, { email: "tx-inner@example.com", age: 20 });
            throw new Error("rollback-inner");
          }),
        ).rejects.toThrow("rollback-inner");
      });

      expect(await userRepo.existsBy({ email: "tx-outer@example.com" })).toBe(true);
      expect(await userRepo.existsBy({ email: "tx-inner@example.com" })).toBe(false);
    } finally {
      await ds.destroy();
    }
  });

  it("2. TypeORM option mapping to native Bun.SQL for PostgreSQL, CockroachDB, Aurora-Postgres, MySQL, MariaDB, Aurora-MySQL", () => {
    expect(normalizeDialect("postgresql")).toBe("postgres");
    expect(normalizeDialect("aurora-postgres")).toBe("postgres");
    expect(normalizeDialect("cockroachdb")).toBe("cockroachdb");
    expect(normalizeDialect("aurora-mysql")).toBe("mysql");
    expect(normalizeDialect("mariadb")).toBe("mariadb");
    expect(normalizeDialect("better-sqlite3")).toBe("sqlite");
    expect(normalizeDialect("turso")).toBe("libsql");
    expect(normalizeDialect("sqlserver")).toBe("mssql");
    expect(normalizeDialect("mongo")).toBe("mongodb");

    const pgCfg = buildBunSqlConfig(
      {
        host: "db.internal",
        port: 5432,
        username: "app",
        password: "secret",
        database: "prod",
        schema: "tenant_a",
        applicationName: "bunest-api",
        ssl: "require",
        poolSize: 25,
        connectTimeoutMS: 5000,
        idleTimeout: 60,
        prepare: true,
      },
      "postgres",
    ) as Bun.SQL.PostgresOrMySQLOptions;

    expect(pgCfg.adapter).toBe("postgres");
    expect(pgCfg.hostname).toBe("db.internal");
    expect(pgCfg.port).toBe(5432);
    expect(pgCfg.username).toBe("app");
    expect(pgCfg.database).toBe("prod");
    expect(pgCfg.tls).toBe("require");
    expect(pgCfg.max).toBe(25);
    expect(pgCfg.connectionTimeout).toBe(5);
    expect(pgCfg.idleTimeout).toBe(60);
    expect(pgCfg.connection).toEqual({
      search_path: "tenant_a",
      application_name: "bunest-api",
    });

    // CockroachDB maps seamlessly onto Bun.SQL postgres wire protocol!
    const crdbCfg = buildBunSqlConfig(
      { url: "cockroachdb://root@localhost:26257/defaultdb?sslmode=disable" },
      "cockroachdb",
    ) as Bun.SQL.PostgresOrMySQLOptions;
    expect(crdbCfg.adapter).toBe("postgres");
    expect(crdbCfg.url).toBe("postgres://root@localhost:26257/defaultdb?sslmode=disable");

    const mariaCfg = buildBunSqlConfig(
      { host: "127.0.0.1", port: 3306, user: "root", database: "shop", ssl: true },
      "mariadb",
    ) as Bun.SQL.PostgresOrMySQLOptions;
    expect(mariaCfg.adapter).toBe("mariadb");
    expect(mariaCfg.hostname).toBe("127.0.0.1");
    expect(mariaCfg.username).toBe("root");
    expect(mariaCfg.tls).toBe(true);
  });

  it("3. All 12 TypeORM dialects: accurate DDL, quoting, placeholders, returning, pagination, ILIKE, JSON extract, and join-table upserts", () => {
    const dialects = getSupportedDialects();
    expect(dialects).toHaveLength(12);

    const graph = compileMetadataGraph({
      entities: [MultiUser, MultiPost, MultiTag],
    });

    // PostgreSQL
    const pgPlan = generateSchemaPlan(graph, "postgres");
    expect(pgPlan.tableSqls.some((s) => s.includes("SERIAL PRIMARY KEY"))).toBe(true);
    expect(pgPlan.tableSqls.some((s) => s.includes("UUID PRIMARY KEY"))).toBe(true);
    expect(getDialectProfile("postgres").formatILike('"u"."email"', "$1")).toBe('"u"."email" ILIKE $1');

    // CockroachDB
    const crdbPlan = generateSchemaPlan(graph, "cockroachdb");
    expect(crdbPlan.tableSqls.some((s) => s.includes("INT8 GENERATED BY DEFAULT AS IDENTITY"))).toBe(true);

    // MySQL & MariaDB
    const mysqlPlan = generateSchemaPlan(graph, "mysql");
    expect(mysqlPlan.tableSqls.some((s) => s.includes("`multi_users`"))).toBe(true);
    expect(mysqlPlan.tableSqls.some((s) => s.includes("AUTO_INCREMENT PRIMARY KEY"))).toBe(true);
    expect(getDialectProfile("mysql").returningStyle).toBe("none");
    expect(getDialectProfile("mariadb").returningStyle).toBe("returning");

    // MSSQL (T-SQL)
    const mssqlPlan = generateSchemaPlan(graph, "mssql");
    expect(mssqlPlan.tableSqls.some((s) => s.includes("[multi_users]"))).toBe(true);
    expect(mssqlPlan.tableSqls.some((s) => s.includes("IDENTITY(1,1) PRIMARY KEY"))).toBe(true);
    expect(mssqlPlan.tableSqls.some((s) => s.includes("UNIQUEIDENTIFIER PRIMARY KEY"))).toBe(true);
    expect(getDialectProfile("mssql").formatPlaceholder(2)).toBe("@p2");
    expect(getDialectProfile("mssql").returningStyle).toBe("output");
    expect(getDialectProfile("mssql").formatLimitOffset(10, 20, false)).toBe(
      " ORDER BY (SELECT NULL) OFFSET 20 ROWS FETCH NEXT 10 ROWS ONLY",
    );

    // Oracle
    const oraclePlan = generateSchemaPlan(graph, "oracle");
    expect(oraclePlan.tableSqls.some((s) => s.includes("NUMBER(10) GENERATED BY DEFAULT AS IDENTITY"))).toBe(true);
    expect(getDialectProfile("oracle").formatPlaceholder(3)).toBe(":3");
    expect(getDialectProfile("oracle").formatLimitOffset(5, 15, true)).toBe(
      " OFFSET 15 ROWS FETCH NEXT 5 ROWS ONLY",
    );
    expect(
      getDialectProfile("oracle").formatInsertIgnoreJoinRow('"jt"', '"a"', '"b"', ":1", ":2"),
    ).toContain("MERGE INTO");

    // SAP HANA
    const sapPlan = generateSchemaPlan(graph, "sap");
    expect(sapPlan.tableSqls.some((s) => s.includes("CREATE COLUMN TABLE IF NOT EXISTS"))).toBe(true);
    expect(getDialectProfile("sap").formatInsertIgnoreJoinRow('"jt"', '"a"', '"b"', "?", "?")).toContain(
      "UPSERT",
    );

    // Google Cloud Spanner
    const spannerPlan = generateSchemaPlan(graph, "spanner");
    expect(spannerPlan.tableSqls.some((s) => s.includes("INT64 NOT NULL GENERATED BY DEFAULT AS IDENTITY"))).toBe(true);
    expect(spannerPlan.tableSqls.some((s) => s.includes(") PRIMARY KEY (`id`)"))).toBe(true);
    expect(getDialectProfile("spanner").returningStyle).toBe("then-return");
    expect(getDialectProfile("spanner").formatPlaceholder(1)).toBe("@p1");
  });

  it("4. LibSQL / Turso (`type: 'libsql'`): real end-to-end Hrana HTTP v2 `/v2/pipeline` over Bun native `fetch()`", async () => {
    const backingDb = new Database(":memory:");
    let receivedAuth = "";
    let batonSeq = 0;

    // Spin up a real local Hrana v2 HTTP server via Bun.serve()!
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname !== "/v2/pipeline") {
          return new Response("Not Found", { status: 404 });
        }
        receivedAuth = req.headers.get("authorization") ?? "";
        const body = (await req.json()) as {
          baton?: string;
          requests: Array<{
            type: "execute" | "close";
            stmt?: {
              sql: string;
              args?: Array<{ type: string; value?: string | number; base64?: string }>;
            };
          }>;
        };

        const results: unknown[] = [];
        let closed = false;

        for (const r of body.requests) {
          if (r.type === "close") {
            closed = true;
            results.push({ type: "ok", response: { type: "close" } });
            continue;
          }
          const sql = r.stmt!.sql;
          const args = (r.stmt!.args ?? []).map((a) => {
            if (a.type === "null") return null;
            if (a.type === "integer") return Number(a.value);
            if (a.type === "float") return Number(a.value);
            if (a.type === "blob") return Buffer.from(a.base64 ?? "", "base64");
            return a.value ?? null;
          });

          try {
            const upper = sql.trimStart().toUpperCase();
            if (
              upper.startsWith("SELECT") ||
              upper.startsWith("PRAGMA") ||
              /\bRETURNING\b/i.test(upper)
            ) {
              const stmt = backingDb.query(sql);
              const rows = stmt.all(...(args as Parameters<typeof stmt.all>)) as Array<
                Record<string, unknown>
              >;
              const colNames = rows.length > 0 ? Object.keys(rows[0]!) : [];
              results.push({
                type: "ok",
                response: {
                  type: "execute",
                  result: {
                    cols: colNames.map((name) => ({ name })),
                    rows: rows.map((row) =>
                      colNames.map((c) => {
                        const v = row[c];
                        if (v === null || v === undefined) return { type: "null" };
                        if (typeof v === "number") {
                          return Number.isInteger(v)
                            ? { type: "integer", value: String(v) }
                            : { type: "float", value: v };
                        }
                        return { type: "text", value: String(v) };
                      }),
                    ),
                    affected_row_count: rows.length,
                  },
                },
              });
            } else {
              const res =
                args.length > 0
                  ? backingDb.query(sql).run(...(args as Parameters<ReturnType<Database["query"]>["run"]>))
                  : backingDb.run(sql);
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
          } catch (err) {
            results.push({
              type: "error",
              error: { message: err instanceof Error ? err.message : String(err) },
            });
          }
        }

        return Response.json({
          baton: closed ? null : (body.baton ?? `baton_${++batonSeq}`),
          results,
        });
      },
    });

    const ds = new DataSource({
      type: "libsql",
      url: `http://127.0.0.1:${server.port}`,
      authToken: "turso-secret-jwt",
      entities: [MultiUser, MultiPost, MultiTag],
      synchronize: true,
    });

    try {
      await ds.initialize();
      expect(ds.driver.driverKind).toBe("libsql-http");
      expect(await ds.ping()).toBe(true);
      expect(receivedAuth).toBe("Bearer turso-secret-jwt");

      const userRepo = ds.getRepository(MultiUser);
      const saved = await userRepo.save({
        email: "turso@example.com",
        age: 26,
        geo: { lat: 21.02, lng: 105.85 },
        posts: [{ title: "Edge SQL via Bun fetch" }],
      });

      const found = await userRepo.findOneOrFail({
        where: { id: saved.id },
        relations: ["posts"],
      });
      expect(found.email).toBe("turso@example.com");
      expect(found.geo).toBeInstanceOf(MultiGeo);
      expect(found.posts).toHaveLength(1);
      expect(found.posts[0]?.title).toBe("Edge SQL via Bun fetch");

      // Interactive baton transaction rollback over Hrana HTTP!
      await expect(
        ds.transaction(async (em) => {
          await em.save(MultiUser, { email: "rollback@turso.io", age: 20 });
          throw new Error("abort-hrana-tx");
        }),
      ).rejects.toThrow("abort-hrana-tx");
      expect(await userRepo.existsBy({ email: "rollback@turso.io" })).toBe(false);
    } finally {
      await ds.destroy();
      server.stop(true);
      backingDb.close();
    }
  });

  it("5. Cloudflare D1 (`type: 'd1'`): works with BOTH direct `d1Binding` AND remote D1 REST API via Bun `fetch()`", async () => {
    const db1 = new Database(":memory:");
    const mockBinding: CloudflareD1DatabaseLike = {
      prepare(sql: string) {
        const execAll = async <T>(params: unknown[]) => {
          const upper = sql.trimStart().toUpperCase();
          if (upper.startsWith("SELECT") || /\bRETURNING\b/i.test(upper)) {
            const stmt = db1.query(sql);
            const results = stmt.all(...(params as Parameters<typeof stmt.all>)) as T[];
            return { results, meta: { changes: results.length } };
          }
          const res =
            params.length > 0
              ? db1.query(sql).run(...(params as Parameters<ReturnType<Database["query"]>["run"]>))
              : db1.run(sql);
          return {
            results: [] as T[],
            meta: {
              changes: Number(res.changes ?? 0),
              last_row_id: Number(res.lastInsertRowid ?? 0),
            },
          };
        };
        return {
          bind: (...values: unknown[]) => ({
            all: <T>() => execAll<T>(values),
            run: async () => ({ meta: (await execAll(values)).meta }),
          }),
          all: <T>() => execAll<T>([]),
          run: async () => ({ meta: (await execAll([])).meta }),
        };
      },
    };

    const dsBinding = new DataSource({
      type: "d1",
      d1Binding: mockBinding,
      entities: [MultiUser, MultiPost, MultiTag],
      synchronize: true,
    });
    await dsBinding.initialize();
    try {
      const repo = dsBinding.getRepository(MultiUser);
      const u = await repo.save({ email: "d1-binding@cf.dev", age: 31 });
      expect((await repo.findOneByOrFail({ id: u.id })).email).toBe("d1-binding@cf.dev");
    } finally {
      await dsBinding.destroy();
      db1.close();
    }

    // Remote D1 REST API over Bun.fetch()
    const db2 = new Database(":memory:");
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const { sql, params } = (await req.json()) as {
          sql: string;
          params: unknown[];
        };
        const upper = sql.trimStart().toUpperCase();
        if (upper.startsWith("SELECT") || /\bRETURNING\b/i.test(upper)) {
          const stmt = db2.query(sql);
          const rows = stmt.all(...(params as Parameters<typeof stmt.all>));
          return Response.json({
            success: true,
            result: [{ success: true, results: rows, meta: { changes: rows.length } }],
          });
        }
        const res =
          params.length > 0
            ? db2.query(sql).run(...(params as Parameters<ReturnType<Database["query"]>["run"]>))
            : db2.run(sql);
        return Response.json({
          success: true,
          result: [
            {
              success: true,
              results: [],
              meta: {
                changes: Number(res.changes ?? 0),
                last_row_id: Number(res.lastInsertRowid ?? 0),
              },
            },
          ],
        });
      },
    });

    const dsHttp = new DataSource({
      type: "d1",
      url: `http://127.0.0.1:${server.port}`,
      accountId: "acc_123",
      databaseId: "db_456",
      apiToken: "cf_token",
      entities: [MultiUser, MultiPost, MultiTag],
      synchronize: true,
    });
    await dsHttp.initialize();
    try {
      const repo = dsHttp.getRepository(MultiUser);
      const u = await repo.save({ email: "d1-rest@cf.dev", age: 28 });
      expect((await repo.findOneByOrFail({ id: u.id })).email).toBe("d1-rest@cf.dev");
    } finally {
      await dsHttp.destroy();
      server.stop(true);
      db2.close();
    }
  });

  it("6. MongoDB: pure BSON codec + REAL Bun.connect() TCP Wire Protocol OP_MSG + embedded MongoRepository & DI", async () => {
    // 6a. Pure BSON binary codec round-trip (all types + cycle safety!)
    const oid = new ObjectId();
    const now = new Date("2026-11-22T12:00:00.000Z");
    const bin = new Uint8Array([1, 2, 3, 255]);
    const cyclicDoc: Record<string, unknown> = {
      _id: oid,
      title: "Xin chào Bunest ORM 🚀",
      count: 42,
      big: 9007199254740993n,
      ratio: 3.14159,
      active: true,
      nothing: null,
      createdAt: now,
      raw: bin,
      pattern: /^bunest/i,
      tags: ["orm", "bson", 123],
      nested: { city: "Hanoi" },
    };
    cyclicDoc.self = cyclicDoc; // Circular ref must NOT blow up BSON encoder!

    const encoded = encodeBson(cyclicDoc);
    const decoded = decodeBson(encoded);
    expect((decoded._id as ObjectId).toHexString()).toBe(oid.toHexString());
    expect(decoded.title).toBe("Xin chào Bunest ORM 🚀");
    expect(decoded.count).toBe(42);
    expect(decoded.big).toBe(9007199254740993n);
    expect(decoded.ratio).toBeCloseTo(3.14159);
    expect(decoded.active).toBe(true);
    expect(decoded.nothing).toBeNull();
    expect((decoded.createdAt as Date).toISOString()).toBe(now.toISOString());
    expect(Array.from(decoded.raw as Uint8Array)).toEqual([1, 2, 3, 255]);
    expect((decoded.pattern as RegExp).source).toBe("^bunest");
    expect(decoded.tags).toEqual(["orm", "bson", 123]);
    expect(decoded.nested).toEqual({ city: "Hanoi" });
    expect(decoded.self).toBeUndefined();

    // 6b. REAL Bun.listen() + Bun.connect() MongoDB OP_MSG TCP wire protocol test!
    const wireStore = new Map<string, Array<Record<string, unknown>>>();
    const tcpServer = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(socket, chunk) {
          const decodedReq = decodeOpMsg(
            new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength),
          );
          const cmd = decodedReq.document;
          let reply: Record<string, unknown> = { ok: 1 };

          if (cmd.ping) {
            reply = { ok: 1 };
          } else if (typeof cmd.insert === "string") {
            const coll = wireStore.get(cmd.insert) ?? [];
            const docs = (cmd.documents as Array<Record<string, unknown>>) ?? [];
            coll.push(...docs);
            wireStore.set(cmd.insert, coll);
            reply = { ok: 1, n: docs.length };
          } else if (typeof cmd.find === "string") {
            const coll = wireStore.get(cmd.find) ?? [];
            const filter = (cmd.filter as Record<string, unknown>) ?? {};
            const matched = coll.filter((d) =>
              Object.entries(filter).every(([k, v]) => d[k] === v),
            );
            reply = { ok: 1, cursor: { id: 0n, firstBatch: matched } };
          } else if (typeof cmd.count === "string") {
            const coll = wireStore.get(cmd.count) ?? [];
            reply = { ok: 1, n: coll.length };
          } else if (typeof cmd.delete === "string") {
            wireStore.set(cmd.delete, []);
            reply = { ok: 1, n: 1 };
          }

          socket.write(encodeOpMsg(decodedReq.requestId + 1000, reply, decodedReq.requestId));
        },
      },
    });

    const dsWire = new DataSource({
      type: "mongodb",
      url: `mongodb://127.0.0.1:${tcpServer.port}/wire_db`,
      entities: [MongoProduct],
    });
    try {
      await dsWire.initialize();
      expect(dsWire.driver.driverKind).toBe("mongodb-wire");
      expect(await dsWire.ping()).toBe(true);

      const mongoRepo = dsWire.getMongoRepository(MongoProduct);
      const ins = await mongoRepo.insertOne({
        name: "MacBook Pro",
        category: "laptop",
        price: 2500,
        origin: { lat: 37.33, lng: -122.01 },
      });
      expect(ObjectId.isValid(ins.insertedId)).toBe(true);

      const found = await mongoRepo.findOneByFilter({ name: "MacBook Pro" });
      expect(found).toBeInstanceOf(MongoProduct);
      expect(found?.origin).toBeInstanceOf(MultiGeo);
      expect(found?.origin?.label()).toBe("37.33,-122.01");
      expect(await mongoRepo.countDocuments()).toBe(1);
    } finally {
      await dsWire.destroy();
      tcpServer.stop(true);
    }

    // 6c. Embedded local MongoDB mode + MongoRepository operators + Aggregation + DI auto-MongoRepository!
    @Injectable()
    class ProductsService {
      constructor(
        @InjectRepository(MongoProduct)
        public readonly products: MongoRepository<MongoProduct>,
      ) {}
    }

    const mod = await Test.createTestingModule({
      imports: [
        OrmModule.forRoot({
          type: "mongodb",
          database: ":memory:",
          synchronize: true,
        }),
        OrmModule.forFeature([MongoProduct]),
      ],
      providers: [ProductsService],
    }).compile();
    await mod.init();
    try {
      const svc = mod.get(ProductsService);
      expect(svc.products).toBeInstanceOf(MongoRepository);

      await svc.products.insertMany([
        { name: "iPhone", category: "phone", price: 1000, origin: { lat: 21, lng: 105 } },
        { name: "Pixel", category: "phone", price: 800, origin: { lat: 37, lng: -122 } },
        { name: "ThinkPad", category: "laptop", price: 1500 },
      ]);

      // Mongo filter operators ($gte, $regex, $or)
      const expensivePhones = await svc.products.findByFilter({
        category: "phone",
        price: { $gte: 900 },
      });
      expect(expensivePhones).toHaveLength(1);
      expect(expensivePhones[0]?.name).toBe("iPhone");
      expect(expensivePhones[0]?.origin).toBeInstanceOf(MultiGeo);

      // Standard TypeORM FindOperators ALSO work on MongoDB!
      const viaTypeOrm = await svc.products.find({
        where: { price: MoreThan(900), name: ILike("%p%") },
        order: { price: "DESC" },
      });
      expect(viaTypeOrm.map((p) => p.name)).toEqual(["ThinkPad", "iPhone"]);

      // findOneAndUpdate with $inc
      const updated = await svc.products.findOneAndUpdate(
        { name: "Pixel" },
        { $inc: { price: 150 } },
        { returnDocument: "after" },
      );
      expect(updated?.price).toBe(950);

      // distinct & aggregate pipeline ($group + $sum + $avg)
      expect((await svc.products.distinct("category")).sort()).toEqual([
        "laptop",
        "phone",
      ]);
      const stats = await svc.products.aggregate<{ _id: string; total: number; avgPrice: number }>([
        { $group: { _id: "$category", total: { $sum: "$price" }, avgPrice: { $avg: "$price" } } },
        { $sort: { total: -1 } },
      ]);
      expect(stats[0]).toEqual({ _id: "phone", total: 1950, avgPrice: 975 });
    } finally {
      await mod.close();
    }
  });

  it("7. Master / Read-Replica Replication (`ReplicatedOrmDriver`): routes SELECT to slaves, writes & transactions to master", async () => {
    const master = new SqliteOrmDriver({ database: ":memory:" });
    const slave1 = new SqliteOrmDriver({ database: ":memory:" });
    const slave2 = new SqliteOrmDriver({ database: ":memory:" });

    let masterQueries = 0;
    let slave1Queries = 0;
    let slave2Queries = 0;

    const wrapCounter = (drv: SqliteOrmDriver, onQuery: () => void): OrmDriver => ({
      dialect: drv.dialect,
      driverKind: drv.driverKind,
      get isConnected() {
        return drv.isConnected;
      },
      connect: () => drv.connect(),
      close: () => drv.close(),
      isInTransaction: () => drv.isInTransaction(),
      setForeignKeysEnabled: (e) => drv.setForeignKeysEnabled(e),
      transaction: (fn) => drv.transaction(fn),
      query: async (sql, params) => {
        onQuery();
        return drv.query(sql, params);
      },
      execute: async (sql, params) => {
        onQuery();
        return drv.execute(sql, params);
      },
    });

    const replicated = new ReplicatedOrmDriver(
      wrapCounter(master, () => masterQueries++),
      [
        wrapCounter(slave1, () => slave1Queries++),
        wrapCounter(slave2, () => slave2Queries++),
      ],
      "slave",
    );

    const ds = new DataSource({
      type: "sqlite",
      driver: replicated,
      entities: [MultiUser, MultiPost, MultiTag],
      synchronize: true,
    });
    await ds.initialize();
    try {
      // Ensure slaves have table for independent read check
      const plan = ds.getSchemaPlan();
      for (const s of [slave1, slave2]) {
        for (const sql of plan.tableSqls) await s.execute(sql);
      }

      const repo = ds.getRepository(MultiUser);
      const writesBefore = masterQueries;
      await repo.save({ email: "master@rep.dev", age: 40 });
      expect(masterQueries).toBeGreaterThan(writesBefore);

      // 4 SELECTs outside transaction -> distributed evenly across slave1 & slave2!
      await repo.find();
      await repo.find();
      await repo.find();
      await repo.find();
      expect(slave1Queries).toBe(2);
      expect(slave2Queries).toBe(2);

      // SELECT inside transaction() MUST route to master, NOT slaves!
      const s1Before = slave1Queries;
      const s2Before = slave2Queries;
      await ds.transaction(async (em) => {
        const users = await em.find(MultiUser);
        expect(users).toHaveLength(1);
      });
      expect(slave1Queries).toBe(s1Before);
      expect(slave2Queries).toBe(s2Before);
    } finally {
      await ds.destroy();
    }
  });

  it("8. Extensible OrmDriverRegistry: register custom enterprise dialect driver (`mssql`) & verify emitted T-SQL", async () => {
    const capturedSql: string[] = [];

    OrmDriverRegistry.register("mssql", () => {
      let connected = false;
      const customDriver: OrmDriver = {
        dialect: "mssql",
        driverKind: "custom-mssql-bridge",
        get isConnected() {
          return connected;
        },
        async connect() {
          connected = true;
        },
        async close() {
          connected = false;
        },
        isInTransaction: () => false,
        async query<T = Record<string, unknown>>(
          sql: string,
        ): Promise<OrmQueryResult<T>> {
          capturedSql.push(sql);
          return { rows: [], affectedRows: 0 };
        },
        async execute(sql: string): Promise<OrmQueryResult> {
          capturedSql.push(sql);
          return { rows: [], affectedRows: 0 };
        },
        async transaction<T>(fn: (e: OrmQueryExecutor) => Promise<T> | T) {
          return fn(customDriver);
        },
      };
      return customDriver;
    });

    const ds = new DataSource({
      type: "mssql",
      entities: [MultiUser, MultiPost, MultiTag],
    });
    await ds.initialize();
    try {
      expect(ds.dialect).toBe("mssql");
      expect(ds.driver.driverKind).toBe("custom-mssql-bridge");

      const qb = ds
        .getRepository(MultiUser)
        .createQueryBuilder("u")
        .where("u.age > :minAge", { minAge: 21 })
        .orderBy("u.id", "DESC")
        .skip(10)
        .take(5);

      const [sql, params] = qb.getQueryAndParameters();
      expect(sql).toContain("[multi_users] [u]");
      expect(sql).toContain("@p1");
      expect(sql).toContain("OFFSET 10 ROWS FETCH NEXT 5 ROWS ONLY");
      expect(params).toEqual([21]);

      await qb.getMany();
      expect(capturedSql).toHaveLength(1);
    } finally {
      await ds.destroy();
    }
  });
});
