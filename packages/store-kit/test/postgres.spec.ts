import { describe, expect, it } from "bun:test";
import {
  advisoryLock,
  assertReadCommittedTransaction,
  columns,
  fromBunSql,
  fromDrizzle,
  fromKysely,
  fromPg,
  fromPrisma,
  fromTypeOrm,
  isNotATransactionError,
  quoteSchema,
  type SqlExecutor,
  SqlParams,
  type SqlTransaction,
  StoreSchema,
} from "../src/postgres/index";

describe("@bunest/store-kit/postgres", () => {
  describe("SqlParams, columns, quoteSchema, advisoryLock, isolation", () => {
    it("formats placeholders and validates values", () => {
      const p = new SqlParams();
      expect(p.text("abc")).toBe("$1::text");
      expect(p.text(null)).toBe("$2::text");
      expect(p.int(42)).toBe("$3::text::integer");
      expect(p.int(null)).toBe("$4::text::integer");
      expect(p.bigint(9007199254740991)).toBe("$5::text::bigint");
      expect(p.bool(true)).toBe("$6::text::boolean");
      expect(p.json({ ok: true })).toBe("$7::text::jsonb");
      expect(p.json(undefined)).toBe("$8::text::jsonb");
      expect(p.equals("k", null)).toBe("k IS NULL");
      expect(p.equals("k", "v")).toBe("k = $9::text");
      expect(p.in("id", [])).toBe("FALSE");
      expect(p.in("id", ["a", "b"])).toBe("id IN ($10::text, $11::text)");
      expect(p.in("seq", [1, 2])).toBe(
        "seq IN ($12::text::bigint, $13::text::bigint)",
      );

      expect(p.values).toEqual([
        "abc",
        null,
        "42",
        null,
        "9007199254740991",
        "true",
        '{"ok":true}',
        null,
        "v",
        "a",
        "b",
        "1",
        "2",
      ]);

      expect(() => p.int(1.5)).toThrow(TypeError);
      expect(() => p.bigint(Number.MAX_SAFE_INTEGER + 1)).toThrow(TypeError);
      expect(() => p.in("x", ["a", 1] as any)).toThrow(TypeError);
      expect(() => p.in("x", [1.5])).toThrow(TypeError);
    });

    it("formats column casts and validates schema identifiers", () => {
      expect(columns(["id", "created_at"])).toBe(
        "id::text AS id, created_at::text AS created_at",
      );
      expect(columns(["id", "data"], "j")).toBe(
        "j.id::text AS id, j.data::text AS data",
      );

      expect(quoteSchema("nest_outbox", "TestStore")).toBe('"nest_outbox"');
      expect(() => quoteSchema("1bad", "TestStore")).toThrow(TypeError);
      expect(() => quoteSchema("bad-name", "TestStore")).toThrow(TypeError);
      expect(() => quoteSchema("a".repeat(64), "TestStore")).toThrow(TypeError);
    });

    it("issues correct advisoryLock queries for single, multi, shared, and namespaced locks", async () => {
      const queries: Array<{ text: string; params?: readonly unknown[] }> = [];
      const tx: SqlTransaction = {
        query: async (text, params) => {
          queries.push({ text, params });
          return [];
        },
      };

      await advisoryLock(tx, []);
      expect(queries).toHaveLength(0);

      await advisoryLock(tx, "k1");
      expect(queries[0]!.text).toContain("pg_advisory_xact_lock(hashtext($1::text))");
      expect(queries[0]!.params).toEqual(["k1"]);

      await advisoryLock(tx, "k1", { shared: true, namespace: "ns" });
      expect(queries[1]!.text).toContain(
        "pg_advisory_xact_lock_shared(hashtext($1::text), hashtext($2::text))",
      );
      expect(queries[1]!.params).toEqual(["ns", "k1"]);

      await advisoryLock(tx, ["b", "a", "b"], { namespace: "ns" });
      expect(queries[2]!.text).toContain("ORDER BY k.h");
      expect(queries[2]!.params).toEqual(['["b","a"]', "ns"]);

      await expect(
        advisoryLock(tx, "k1", { namespace: 123 as any }),
      ).rejects.toThrow(TypeError);
    });

    it("checks READ COMMITTED in assertReadCommittedTransaction", async () => {
      const rcTx: SqlTransaction = {
        query: async () => [{ isolation: "read committed" }] as any,
      };
      await expect(
        assertReadCommittedTransaction(rcTx, {
          operation: "signal()",
          reason: "snapshot staleness",
        }),
      ).resolves.toBeUndefined();

      const rrTx: SqlTransaction = {
        query: async () => [{ isolation: "repeatable read" }] as any,
      };
      await expect(
        assertReadCommittedTransaction(rrTx, {
          operation: "signal()",
          reason: "snapshot staleness",
        }),
      ).rejects.toThrow(TypeError);
    });
  });

  describe("StoreSchema & readiness", () => {
    class FakeSchemaError extends Error {
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

    const schema = new StoreSchema({
      packageName: "@bunest/outbox",
      storeName: "PostgresOutboxStore",
      command: "nest-outbox",
      defaultSchema: "nest_outbox",
      migrations: [
        {
          version: 1,
          name: "initial",
          up: (s) => [`CREATE TABLE ${s}.messages (id text PRIMARY KEY)`],
        },
        {
          version: 2,
          name: "add_key",
          up: (s) => [`ALTER TABLE ${s}.messages ADD COLUMN key text`],
        },
      ],
      createError: (msg, details) => new FakeSchemaError(msg, details),
    });

    it("generates statements and SQL scripts and rejects invalid ranges", () => {
      expect(schema.latest).toBe(2);
      const stmts = schema.statements();
      expect(stmts[0]).toBe('CREATE SCHEMA IF NOT EXISTS "nest_outbox"');
      expect(stmts[1]).toContain('CREATE TABLE IF NOT EXISTS "nest_outbox".migrations');
      expect(stmts.at(-1)).toBe(
        `INSERT INTO "nest_outbox".migrations (version, name) VALUES (2, 'add_key')`,
      );

      const script = schema.sql({ from: 1, statementBreakpoints: true });
      expect(script).toContain("from version 1 to 2");
      expect(script).toContain("--> statement-breakpoint");

      expect(() => schema.statements({ from: 2, to: 1 })).toThrow(RangeError);
      expect(() => schema.statements({ to: 99 })).toThrow(RangeError);
    });

    it("migrates, verifies readiness, deduplicates concurrent ready(), and refuses readyIn() behind", async () => {
      let currentVersion = 0;
      let schemaExists = false;
      const executed: string[] = [];

      const makeTx = (): SqlTransaction => ({
        query: async <R extends object>(text: string): Promise<R[]> => {
          executed.push(text);
          if (text.includes("default_transaction_isolation")) {
            return [{ isolation: "read committed" }] as R[];
          }
          if (text.includes("pg_catalog.pg_class")) {
            return [{ exists: currentVersion > 0 ? "true" : "false" }] as R[];
          }
          if (text.includes("pg_catalog.pg_namespace")) {
            return [{ exists: schemaExists ? "true" : "false" }] as R[];
          }
          if (text.includes("coalesce(max(version)")) {
            return [{ version: String(currentVersion) }] as R[];
          }
          if (text.startsWith("CREATE SCHEMA")) {
            schemaExists = true;
          }
          const insertMatch = /VALUES \((\d+),/.exec(text);
          if (insertMatch) {
            currentVersion = Number(insertMatch[1]);
          }
          return [];
        },
      });

      const tx = makeTx();
      const executor: SqlExecutor = {
        dialect: "postgres",
        query: tx.query,
        transaction: async (work) => work(tx),
        wrapTransaction: () => tx,
      };

      const resolved = schema.resolveOptions({ executor, migrate: false });
      expect(resolved.schema).toBe("nest_outbox");
      expect(resolved.migrate).toBe(false);

      // Refuses readyIn when schema is behind
      const rBehind = schema.readiness(resolved);
      await expect(rBehind.readyIn(tx)).rejects.toBeInstanceOf(FakeSchemaError);

      // Migrates via readiness with migrate: true
      const logs: string[] = [];
      const rMigrate = schema.readiness({
        executor,
        schema: "nest_outbox",
        migrate: true,
        logger: { log: (m) => logs.push(m) },
      });
      await Promise.all([rMigrate.ready(), rMigrate.ready()]);
      expect(currentVersion).toBe(2);
      expect(logs).toEqual([
        'PostgresOutboxStore: migrated schema "nest_outbox" to version 2.',
      ]);

      // Subsequent migrate is a no-op
      expect(await schema.migrate(executor, "nest_outbox")).toEqual([]);
      // readyIn now succeeds
      await expect(rBehind.readyIn(tx)).resolves.toBeUndefined();
    });

    it("rejects wrong-dialect executor in resolveOptions", () => {
      const mysqlExec = {
        dialect: "mysql",
        query: async () => [],
        execute: async () => ({ affectedRows: 0 }),
        transaction: async (w: any) => w({}),
        wrapTransaction: () => ({}),
      } as any;
      expect(() => schema.resolveOptions({ executor: mysqlExec })).toThrow(
        /runs on PostgreSQL/,
      );
    });
  });

  describe("PostgreSQL executors (fromPg, fromDrizzle, fromKysely, fromPrisma, fromTypeOrm, fromBunSql)", () => {
    it("fromPg handles Pool, Client, transaction commit/rollback, aborted tx detection, and wrapTransaction", async () => {
      const log: string[] = [];
      let status: "I" | "T" | "E" = "I";
      const fakeClient = {
        connect: async () => fakeClient,
        on: () => fakeClient,
        removeListener: () => fakeClient,
        release: () => {},
        getTransactionStatus: () => status,
        query: async (text: string) => {
          log.push(text);
          if (text.startsWith("BEGIN")) {
            status = "T";
            return { rows: [], rowCount: 0, command: "BEGIN" };
          }
          if (text === "COMMIT") {
            const cmd = status === "E" ? "ROLLBACK" : "COMMIT";
            status = "I";
            return { rows: [], rowCount: 0, command: cmd };
          }
          if (text === "ROLLBACK") {
            status = "I";
            return { rows: [], rowCount: 0, command: "ROLLBACK" };
          }
          if (text === "FAIL") {
            status = "E";
            throw new Error("boom");
          }
          return { rows: [{ ok: "1" }], rowCount: 1, command: "SELECT" };
        },
      };

      const fakePool = {
        totalCount: 1,
        query: fakeClient.query,
        connect: ((cb?: any) => {
          if (cb) {
            cb(undefined, fakeClient);
            return;
          }
          return Promise.resolve(fakeClient);
        }) as any,
      };

      const exec = fromPg(fakePool);
      expect(exec.dialect).toBe("postgres");
      expect(await exec.query("SELECT 1")).toEqual([{ ok: "1" }]);
      expect(await exec.execute!("UPDATE t SET a = 1")).toEqual({
        affectedRows: 1,
      });

      const res = await exec.transaction(
        async (tx) => {
          expect(tx.native).toBe(fakeClient);
          expect(exec.wrapTransaction(tx.native).native).toBe(fakeClient);
          return tx.query("SELECT 1");
        },
        { isolationLevel: "serializable" },
      );
      expect(res).toEqual([{ ok: "1" }]);
      expect(log).toContain("BEGIN ISOLATION LEVEL SERIALIZABLE");

      // Aborted transaction caught by work still rejects
      await expect(
        exec.transaction(async (tx) => {
          await tx.query("FAIL").catch(() => undefined);
          return "swallowed";
        }),
      ).rejects.toThrow(/rolled back/);

      // Rejects pool and idle client in wrapTransaction
      status = "I";
      for (const bad of [fakePool, fakeClient, null, {}]) {
        try {
          exec.wrapTransaction(bad);
          throw new Error("expected throw");
        } catch (err) {
          expect(isNotATransactionError(err)).toBe(true);
        }
      }

      // Single Client executor works too
      const clientExec = fromPg(fakeClient);
      expect(await clientExec.query("SELECT 1")).toEqual([{ ok: "1" }]);
    });

    it("fromDrizzle, fromKysely, fromPrisma, fromTypeOrm, and fromBunSql wrap clients cleanly", async () => {
      // Drizzle mock
      const ENTITY_KIND = Symbol.for("drizzle:entityKind");
      class PgDatabase {
        static [ENTITY_KIND] = "PgDatabase";
        execute = async () => ({ rows: [{ v: "1" }], rowCount: 1 });
        transaction = async (work: (tx: any) => Promise<any>) =>
          work(new PgTransaction());
      }
      class PgTransaction {
        static [ENTITY_KIND] = "PgTransaction";
        execute = async () => ({ rows: [{ v: "tx" }], rowCount: 2 });
        transaction = async (work: (tx: any) => Promise<any>) => work(this);
      }
      const drizzleDb = new PgDatabase();
      const drizzleExec = fromDrizzle(drizzleDb);
      expect(await drizzleExec.query("SELECT $1::text", ["a"])).toEqual([
        { v: "1" },
      ]);
      expect(
        await drizzleExec.transaction(async (tx) => {
          expect(drizzleExec.wrapTransaction(tx.native).native).toBe(tx.native);
          return tx.execute!("UPDATE x");
        }),
      ).toEqual({ affectedRows: 2 });
      expect(() => drizzleExec.wrapTransaction(drizzleDb)).toThrow(TypeError);

      // Kysely mock
      const makeKysely = (isTransaction: boolean): any => ({
        isTransaction,
        withoutPlugins() {
          return this;
        },
        executeQuery: async () => ({ rows: [{ k: "ok" }], numAffectedRows: 3n }),
        transaction: () => ({
          setIsolationLevel: () => ({
            execute: (w: any) => w(makeKysely(true)),
          }),
          execute: (w: any) => w(makeKysely(true)),
        }),
      });
      const kyselyDb = makeKysely(false);
      const kyselyExec = fromKysely(kyselyDb);
      expect(await kyselyExec.query("SELECT 1")).toEqual([{ k: "ok" }]);
      expect(await kyselyExec.execute!("DELETE FROM x")).toEqual({
        affectedRows: 3,
      });
      expect(
        await kyselyExec.transaction(
          async (tx) => kyselyExec.wrapTransaction(tx.native).query("SELECT 1"),
          { isolationLevel: "read committed" },
        ),
      ).toEqual([{ k: "ok" }]);

      // Prisma mock
      let lastTxOpts: any;
      const prismaTx = {
        $queryRawUnsafe: async () => [{ p: "tx" }],
        $executeRawUnsafe: async () => 4,
      };
      const prismaClient = {
        $connect: async () => {},
        $queryRawUnsafe: async () => [{ p: "root" }],
        $executeRawUnsafe: async () => 1,
        $transaction: async (w: any, opts: any) => {
          lastTxOpts = opts;
          return w(prismaTx);
        },
      };
      const prismaExec = fromPrisma(prismaClient, {
        maxWait: "5s",
        timeout: "30s",
      });
      expect(await prismaExec.query("SELECT 1")).toEqual([{ p: "root" }]);
      expect(
        await prismaExec.transaction(async (tx) => tx.execute!("UPDATE x"), {
          isolationLevel: "repeatable read",
        }),
      ).toEqual({ affectedRows: 4 });
      expect(lastTxOpts).toEqual({
        maxWait: 5000,
        timeout: 30000,
        isolationLevel: "RepeatableRead",
      });
      expect(() => prismaExec.wrapTransaction(prismaClient)).toThrow(TypeError);

      // TypeORM mock
      const DATA_SOURCE = Symbol.for("DataSource");
      const ENTITY_MANAGER = Symbol.for("EntityManager");
      const makeRunner = (active: boolean) => ({
        isTransactionActive: active,
        connection: { options: { type: "postgres" } },
        startTransaction: async () => {},
        release: async () => {},
        query: async () => ({ records: [{ t: "ok" }], affected: 5 }),
      });
      const ds = {
        "@instanceof": DATA_SOURCE,
        options: { type: "postgres" },
        createQueryRunner: () => makeRunner(false),
        transaction: async (a: any, b?: any) => {
          const fn = typeof a === "function" ? a : b;
          const mgr = {
            "@instanceof": ENTITY_MANAGER,
            connection: ds,
            queryRunner: makeRunner(true),
          };
          return fn(mgr);
        },
      } as any;
      const typeormExec = fromTypeOrm(ds);
      expect(await typeormExec.query("SELECT 1")).toEqual([{ t: "ok" }]);
      expect(
        await typeormExec.transaction(async (tx) => {
          expect(typeormExec.wrapTransaction(tx.native).native).toBe(tx.native);
          return tx.execute!("UPDATE x");
        }),
      ).toEqual({ affectedRows: 5 });

      // Bun.SQL mock
      let beginIso: string | undefined;
      const bunTx = {
        unsafe: async () => Object.assign([{ b: "tx" }], { count: 2 }),
        savepoint: async (fn: any) => fn(bunTx),
      };
      const bunSql = {
        options: { adapter: "postgres" },
        unsafe: async () => Object.assign([{ b: "root" }], { count: 1 }),
        begin: async (a: any, b?: any) => {
          if (typeof a === "string") {
            beginIso = a;
            return b(bunTx);
          }
          return a(bunTx);
        },
      };
      const bunExec = fromBunSql(bunSql);
      expect(bunExec.dialect).toBe("postgres");
      expect(await bunExec.query("SELECT 1")).toEqual([{ b: "root" }]);
      expect(
        await bunExec.transaction(
          async (tx) => {
            expect(bunExec.wrapTransaction(tx.native).native).toBe(tx.native);
            return tx.execute!("DELETE FROM x");
          },
          { isolationLevel: "serializable" },
        ),
      ).toEqual({ affectedRows: 2 });
      expect(beginIso).toBe("ISOLATION LEVEL SERIALIZABLE");
      expect(() => bunExec.wrapTransaction(bunSql)).toThrow(TypeError);
    });
  });
});
