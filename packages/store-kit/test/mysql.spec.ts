import { describe, expect, it } from "bun:test";
import {
  columns,
  ensureLockRows,
  fromBunSql,
  fromDrizzle,
  fromKysely,
  fromMysql2,
  fromPrisma,
  fromTypeOrm,
  isNotATransactionError,
  keyColumn,
  lockKeys,
  lockRowId,
  mysqlErrorCode,
  quoteIdentifier,
  quoteTable,
  retryOnDeadlock,
  type SqlExecutor,
  SqlParams,
  type SqlTransaction,
  StoreSchema,
} from "../src/mysql/index";

describe("@bunest/store-kit/mysql", () => {
  describe("SqlParams, columns, identifiers, keyColumn, mysqlErrorCode", () => {
    it("formats placeholders, handles floating-point JSON doubles via JSON_SET, and validates limits", () => {
      const p = new SqlParams();
      expect(p.text("hi")).toBe("?");
      expect(p.int(7)).toBe("CAST(? AS SIGNED)");
      expect(p.bigint(9007199254740991)).toBe("CAST(? AS SIGNED)");
      expect(p.bool(true)).toBe("CAST(? AS UNSIGNED)");
      expect(p.bool(false)).toBe("CAST(? AS UNSIGNED)");
      expect(p.json({ n: 1 })).toBe("JSON_EXTRACT(?, '$')");
      expect(p.json(null)).toBe("JSON_EXTRACT(?, '$')");
      expect(p.equals("k", null)).toBe("k IS NULL");
      expect(p.equals("k", "v")).toBe("k = ?");
      expect(p.in("id", [])).toBe("FALSE");
      expect(p.in("id", ["a", "b"])).toBe("id IN (?, ?)");
      expect(p.in("seq", [10, 20])).toBe(
        "seq IN (CAST(? AS SIGNED), CAST(? AS SIGNED))",
      );
      expect(p.limit(25)).toBe("25");

      // Doubles get replaced with 0 in text and set via JSON_SET + CAST(? AS DOUBLE)
      const dp = new SqlParams();
      const expr = dp.json({ a: 0.1 + 0.2, nested: [7e-30, 5] });
      expect(expr).toBe(
        "JSON_SET(JSON_EXTRACT(?, '$'), ?, CAST(? AS DOUBLE), ?, CAST(? AS DOUBLE))",
      );
      expect(dp.values[0]).toBe('{"a":0,"nested":[0,5]}');
      expect(dp.values[1]).toBe('$."a"');
      expect(dp.values[2]).toBe(String(0.1 + 0.2));
      expect(dp.values[3]).toBe('$."nested"[0]');
      expect(dp.values[4]).toBe(String(7e-30));

      expect(() => p.int(1.2)).toThrow(TypeError);
      expect(() => p.limit(-1)).toThrow(TypeError);
      expect(() => p.limit(1.5)).toThrow(TypeError);
    });

    it("formats columns, identifiers, tables, and keyColumn safely", () => {
      expect(columns(["id", "key"], "m")).toBe(
        "CAST(`m`.`id` AS CHAR) AS `id`, CAST(`m`.`key` AS CHAR) AS `key`",
      );
      expect(quoteIdentifier("key")).toBe("`key`");
      expect(() => quoteIdentifier("1bad")).toThrow(TypeError);

      expect(quoteTable("nest_outbox", "messages", "TestStore")).toBe(
        "`nest_outbox_messages`",
      );
      expect(() => quoteTable("nest_outbox", "migrations", "TestStore")).toThrow(
        /is taken/,
      );
      expect(() => quoteTable("nest_outbox", "locks", "TestStore")).toThrow(
        /is taken/,
      );
      expect(() => quoteTable("BadUpper", "messages", "TestStore")).toThrow(
        TypeError,
      );
      expect(() =>
        quoteTable("a".repeat(40), "b".repeat(25), "TestStore"),
      ).toThrow(/64/);

      expect(keyColumn(255)).toBe(
        "varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin",
      );
      expect(() => keyColumn(0)).toThrow(RangeError);
      expect(() => keyColumn(769)).toThrow(RangeError);
    });

    it("extracts mysqlErrorCode across drivers", () => {
      expect(mysqlErrorCode({ errno: 1062, sqlState: "23000" })).toBe(1062);
      expect(
        mysqlErrorCode({
          cause: { errno: 1213, sqlMessage: "Deadlock found" },
        }),
      ).toBe(1213);
      expect(
        mysqlErrorCode({
          driverError: { errno: 1205, sqlState: "HY000" },
        }),
      ).toBe(1205);
      expect(
        mysqlErrorCode({
          meta: { driverAdapterError: { cause: { originalCode: "1020" } } },
        }),
      ).toBe(1020);
      expect(mysqlErrorCode({ errno: -111 })).toBeUndefined();
      expect(mysqlErrorCode(new Error("generic"))).toBeUndefined();
    });
  });

  describe("lockKeys, ensureLockRows, lockRowId, retryOnDeadlock", () => {
    it("computes deterministic SHA-256 lock row IDs and acquires exclusive/shared locks in sorted order", async () => {
      const h1 = lockRowId("b");
      const h2 = lockRowId("a");
      expect(h1).toHaveLength(64);
      expect(h1).not.toBe(h2);

      const ops: Array<{ op: string; sql: string; params?: readonly unknown[] }> =
        [];
      const tx: SqlTransaction = {
        query: async (sql, params) => {
          ops.push({ op: "query", sql, params });
          return [];
        },
        execute: async (sql, params) => {
          ops.push({ op: "execute", sql, params });
          return { affectedRows: 1 };
        },
      };

      await lockKeys(tx, "nest_outbox", ["b", "a", "b"]);
      const sorted = [h1, h2].sort();
      expect(ops).toHaveLength(2);
      expect(ops[0]!.op).toBe("execute");
      expect(ops[0]!.sql).toContain("INSERT INTO `nest_outbox_locks`");
      expect(ops[0]!.params).toEqual(sorted);
      expect(ops[1]!.op).toBe("query");
      expect(ops[1]!.sql).toContain("ORDER BY id FOR UPDATE");
      expect(ops[1]!.params).toEqual(sorted);

      ops.length = 0;
      await lockKeys(tx, "nest_outbox", "only", { shared: true });
      // Missing row triggers LOCK IN SHARE MODE -> exclusive create
      expect(ops[0]!.sql).toContain("LOCK IN SHARE MODE");
      expect(ops[1]!.sql).toContain("INSERT INTO `nest_outbox_locks`");
    });

    it("ensureLockRows inserts only missing rows and retries on deadlock 1213", async () => {
      const existing = new Set<string>([lockRowId("k1")]);
      let deadlockOnce = true;

      const executor: SqlExecutor = {
        dialect: "mysql",
        query: async <R extends object>(_sql: string, params?: readonly unknown[]) => {
          return (params ?? [])
            .filter((id) => existing.has(String(id)))
            .map((id) => ({ id })) as R[];
        },
        execute: async () => ({ affectedRows: 0 }),
        transaction: async (work) => {
          if (deadlockOnce) {
            deadlockOnce = false;
            throw Object.assign(new Error("deadlock"), {
              errno: 1213,
              sqlState: "40001",
            });
          }
          return work({
            query: async () => [],
            execute: async (_sql, params) => {
              for (const id of params ?? []) existing.add(String(id));
              return { affectedRows: (params ?? []).length };
            },
          });
        },
        wrapTransaction: () => {
          throw new Error("unused");
        },
      };

      await ensureLockRows(executor, "nest_outbox", ["k1", "k2"]);
      expect(existing.has(lockRowId("k2"))).toBe(true);
      expect(deadlockOnce).toBe(false);

      await expect(
        retryOnDeadlock(executor, async () => "ok", { attempts: 0 }),
      ).rejects.toThrow(TypeError);
    });
  });

  describe("StoreSchema, server checks, MariaDB support, and resumable DDL", () => {
    class FakeMySqlSchemaError extends Error {
      constructor(
        message: string,
        readonly details: {
          schema: string;
          version: number;
          requiredVersion: number;
          cause?: unknown;
        },
      ) {
        super(message);
      }
    }

    it("rejects non-DDL migration statements eagerly in constructor", () => {
      expect(
        () =>
          new StoreSchema({
            packageName: "@bunest/outbox",
            storeName: "MySqlOutboxStore",
            command: "nest-outbox",
            defaultSchema: "nest_outbox",
            migrations: [
              {
                version: 1,
                name: "bad",
                up: () => ["INSERT INTO foo VALUES (1)"],
              },
            ],
            createError: (m, d) => new FakeMySqlSchemaError(m, d),
          }),
      ).toThrow(/isn't DDL/);
    });

    it("validates MySQL / MariaDB versions, runs GET_LOCK migrations, and reports readiness.server", async () => {
      const schema = new StoreSchema({
        packageName: "@bunest/outbox",
        storeName: "MySqlOutboxStore",
        command: "nest-outbox",
        defaultSchema: "nest_outbox",
        mariadb: true,
        migrations: [
          {
            version: 1,
            name: "initial",
            up: (t) => [
              `CREATE TABLE ${t("messages")} (id ${keyColumn(255)} NOT NULL PRIMARY KEY)`,
            ],
          },
        ],
        createError: (m, d) => new FakeMySqlSchemaError(m, d),
      });

      expect(schema.statements()).toHaveLength(4); // migrations + locks + messages + insert
      expect(schema.sql({ statementBreakpoints: true })).toContain(
        "--> statement-breakpoint",
      );

      let hasMigrationsTable = false;
      let started = 0;
      let applied = 0;
      let appliedAt: number | null = null;
      let serverVersion = "11.8.2-MariaDB";
      const logSql: string[] = [];

      const tx: SqlTransaction = {
        query: async <R extends object>(sql: string, params?: readonly unknown[]) => {
          logSql.push(sql);
          if (sql.includes("SELECT VERSION()")) {
            return [{ version: serverVersion }] as R[];
          }
          if (sql.includes("COLLATE utf8mb4_0900_bin")) {
            return [{ padded: "0" }] as R[];
          }
          if (sql.includes("@@session.sql_mode")) {
            return [
              {
                sql_mode: "STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION",
                current_database: "app_db",
              },
            ] as R[];
          }
          if (sql.includes("information_schema.TABLES")) {
            return [{ found: hasMigrationsTable ? "1" : "0" }] as R[];
          }
          if (sql.includes("GET_LOCK")) {
            return [{ taken: "1", holder: "42" }] as R[];
          }
          if (sql.includes("@@session.lock_wait_timeout")) {
            return [{ wait: "31536000" }] as R[];
          }
          if (sql.includes("COALESCE(MAX(version)")) {
            return [{ version: appliedAt ? "1" : "0" }] as R[];
          }
          if (sql.includes("CREATE TABLE IF NOT EXISTS `nest_outbox_migrations`")) {
            hasMigrationsTable = true;
            return [];
          }
          if (sql.includes("SELECT CAST(started AS CHAR)")) {
            return [{ started: String(started), applied: String(applied) }] as R[];
          }
          if (sql.includes("SET started =") && sql.includes("applied =")) {
            started = Number(params?.[0] ?? started);
            applied = Number(params?.[1] ?? applied);
            return [];
          }
          if (sql.includes("SET started =")) {
            started = Number(params?.[0] ?? started);
            return [];
          }
          if (sql.includes("SET applied_at =")) {
            appliedAt = Date.now();
            return [];
          }
          return [];
        },
        execute: async () => ({ affectedRows: 1 }),
      };

      const executor: SqlExecutor = {
        dialect: "mysql",
        query: tx.query,
        execute: tx.execute,
        transaction: async (work) => work(tx),
        wrapTransaction: () => tx,
      };

      const readiness = schema.readiness({
        executor,
        schema: "nest_outbox",
        migrate: true,
      });
      expect(readiness.server).toBeUndefined();
      await readiness.ready();
      expect(readiness.server).toBe("mariadb");
      expect(applied).toBe(1);
      expect(logSql.some((s) => s.includes("DO RELEASE_LOCK"))).toBe(true);
      expect(logSql.some((s) => s.includes("SET SESSION lock_wait_timeout = 31536000"))).toBe(true);

      // Refuses old MySQL (< 8.0.19)
      serverVersion = "8.0.18";
      await expect(schema.version(executor, "nest_outbox")).rejects.toThrow(
        /8\.0\.19/,
      );
    });
  });

  describe("MySQL executors (fromMysql2, fromDrizzle, fromKysely, fromPrisma, fromTypeOrm, fromBunSql)", () => {
    it("fromMysql2 validates placeholders, FOUND_ROWS, transactions, and DO 0 transaction check", async () => {
      let inTx = false;
      const conn = {
        escapeId: (s: string) => `\`${s}\``,
        format: (s: string) => s,
        release: () => {},
        destroy: () => {},
        execute: async () => [[], []] as [any, any],
        query: async (sql: string) => {
          if (sql === "START TRANSACTION") inTx = true;
          if (sql === "COMMIT" || sql === "ROLLBACK") inTx = false;
          if (sql === "DO 0") {
            return [{ serverStatus: inTx ? 1 : 0 }, []] as [any, any];
          }
          if (sql.startsWith("SELECT")) {
            return [[{ ok: "1" }], []] as [any, any];
          }
          return [{ affectedRows: 2 }, []] as [any, any];
        },
      };
      const pool = {
        ...conn,
        config: { connectionConfig: { clientFlags: 2 } },
        getConnection: async () => conn,
      };

      const exec = fromMysql2(pool);
      expect(exec.dialect).toBe("mysql");
      expect(await exec.query("SELECT ? AS ok", ["1"])).toEqual([{ ok: "1" }]);
      expect(await exec.execute("UPDATE t SET a = ?", ["1"])).toEqual({
        affectedRows: 2,
      });

      // Mismatched placeholders and ?? refused
      await expect(exec.query("SELECT ?", [])).rejects.toThrow(TypeError);
      await expect(exec.query("SELECT ??", ["a"])).rejects.toThrow(TypeError);

      // Missing FOUND_ROWS refused
      const noFoundRowsPool = {
        ...pool,
        config: { connectionConfig: { clientFlags: 0 } },
      };
      expect(() => fromMysql2(noFoundRowsPool)).toThrow(/FOUND_ROWS/);

      // wrapTransaction refuses connection outside transaction at first statement
      inTx = false;
      try {
        await exec.wrapTransaction(conn).query("SELECT 1");
        throw new Error("expected throw");
      } catch (err) {
        expect(isNotATransactionError(err)).toBe(true);
      }

      // Transaction succeeds and passes native
      const out = await exec.transaction(
        async (tx) => {
          expect(tx.native).toBe(conn);
          return tx.execute("UPDATE t SET a = ?", ["2"]);
        },
        { isolationLevel: "read committed" },
      );
      expect(out).toEqual({ affectedRows: 2 });
    });

    it("fromDrizzle, fromKysely, fromPrisma, fromTypeOrm, and fromBunSql wrap MySQL clients", async () => {
      // Drizzle MySQL
      const ENTITY_KIND = Symbol.for("drizzle:entityKind");
      class MySql2Database {
        static [ENTITY_KIND] = "MySql2Database";
        execute = async () => [[{ d: "1" }], []];
        transaction = async (w: any) => w(new MySql2Transaction());
      }
      class MySql2Transaction {
        static [ENTITY_KIND] = "MySql2Transaction";
        execute = async () => [{ affectedRows: 3 }, []];
        transaction = async (w: any) => w(this);
      }
      const dExec = fromDrizzle(new MySql2Database());
      expect(await dExec.query("SELECT ?", ["a"])).toEqual([{ d: "1" }]);
      expect(await dExec.transaction((tx) => tx.execute("UPDATE x SET a = ?", [1]))).toEqual({
        affectedRows: 3,
      });

      // Kysely MySQL
      const makeKysely = (isTransaction: boolean): any => ({
        isTransaction,
        withoutPlugins() {
          return this;
        },
        executeQuery: async () => ({ rows: [{ k: "1" }], numAffectedRows: 2n }),
        transaction: () => ({
          setIsolationLevel: () => ({ execute: (w: any) => w(makeKysely(true)) }),
          execute: (w: any) => w(makeKysely(true)),
        }),
      });
      const kExec = fromKysely(makeKysely(false));
      expect(await kExec.query("SELECT ?", [1])).toEqual([{ k: "1" }]);
      expect(await kExec.execute("DELETE FROM x WHERE id = ?", [1])).toEqual({
        affectedRows: 2,
      });

      // Prisma MySQL
      const pTx = {
        $queryRawUnsafe: async () => [{ p: "1" }],
        $executeRawUnsafe: async () => 5,
      };
      const pExec = fromPrisma({
        $connect: async () => {},
        $queryRawUnsafe: async () => [{ p: "root" }],
        $executeRawUnsafe: async () => 1,
        $transaction: async (w: any) => w(pTx),
      });
      expect(await pExec.transaction((tx) => tx.execute("UPDATE x SET a = ?", [1]))).toEqual({
        affectedRows: 5,
      });

      // TypeORM MySQL/MariaDB
      const DATA_SOURCE = Symbol.for("DataSource");
      const ENTITY_MANAGER = Symbol.for("EntityManager");
      const makeRunner = (active: boolean) => ({
        isTransactionActive: active,
        connection: { options: { type: "mariadb" } },
        startTransaction: async () => {},
        release: async () => {},
        query: async () => ({ records: [{ t: "1" }], affected: 6 }),
      });
      const ds = {
        "@instanceof": DATA_SOURCE,
        options: { type: "mariadb" },
        createQueryRunner: () => makeRunner(false),
        transaction: async (a: any, b?: any) => {
          const fn = typeof a === "function" ? a : b;
          return fn({
            "@instanceof": ENTITY_MANAGER,
            connection: ds,
            queryRunner: makeRunner(true),
          });
        },
      } as any;
      const tExec = fromTypeOrm(ds);
      expect(await tExec.execute("UPDATE x SET a = ?", [1])).toEqual({
        affectedRows: 6,
      });
      expect(() =>
        fromTypeOrm({
          ...ds,
          options: { type: "mysql", flags: "-FOUND_ROWS" },
        }),
      ).toThrow(/FOUND_ROWS/);

      // Bun.SQL MySQL with reserved connection isolation level
      const reservedCalls: string[] = [];
      let released = false;
      const reserved = {
        unsafe: async (sql: string) => {
          reservedCalls.push(sql);
          return Object.assign([], { affectedRows: 4 });
        },
        release: () => {
          released = true;
        },
      };
      const bunSql = {
        options: { adapter: "mysql" },
        unsafe: async () => Object.assign([{ m: "ok" }], { affectedRows: 1 }),
        reserve: async () => reserved,
        begin: async (a: any, b?: any) => (typeof a === "function" ? a(reserved) : b(reserved)),
      };
      const bExec = fromBunSql(bunSql);
      expect(bExec.dialect).toBe("mysql");
      expect(await bExec.query("SELECT ?", [1])).toEqual([{ m: "ok" }]);
      expect(
        await bExec.transaction(
          async (tx) => {
            expect(bExec.wrapTransaction(tx.native).native).toBe(tx.native);
            return tx.execute("UPDATE t SET a = ?", [1]);
          },
          { isolationLevel: "read committed" },
        ),
      ).toEqual({ affectedRows: 4 });
      expect(reservedCalls).toEqual([
        "SET TRANSACTION ISOLATION LEVEL READ COMMITTED",
        "START TRANSACTION",
        "UPDATE t SET a = ?",
        "COMMIT",
      ]);
      expect(released).toBe(true);
    });
  });
});
