import { describe, expect, it } from "bun:test";
import { runStoreCli } from "@bunest/orm/store";
import {
  OutboxError,
  type OutboxMessage,
  OutboxStorage,
  OutboxTransactionRequiredError,
} from "../../src/outbox/index";
import {
  fromDrizzle as fromMySqlDrizzle,
  fromKysely as fromMySqlKysely,
  fromMysql2,
  fromPrisma as fromMySqlPrisma,
  fromTypeOrm as fromMySqlTypeOrm,
  MySqlOutboxStore,
  OutboxSchemaError as MySqlOutboxSchemaError,
  type SqlExecutor as MySqlSqlExecutor,
} from "../../src/outbox/mysql/index";
import {
  fromDrizzle as fromPgDrizzle,
  fromKysely as fromPgKysely,
  fromPg,
  fromPrisma as fromPgPrisma,
  fromTypeOrm as fromPgTypeOrm,
  OutboxSchemaError as PgOutboxSchemaError,
  PostgresOutboxStore,
  type SqlExecutor as PgSqlExecutor,
} from "../../src/outbox/postgres/index";
import { outboxSchemas } from "../../src/outbox/sql/outbox-schemas";

function createMockPgExecutor() {
  const calls: Array<{ sql: string; params?: readonly unknown[] }> = [];
  let migrated = false;

  const handleQuery = async (sql: string, params?: readonly unknown[]) => {
    calls.push({ sql, params });
    if (sql.includes("default_transaction_isolation")) {
      return [{ isolation: "read committed" }];
    }
    if (sql.includes("pg_catalog.pg_class")) {
      return [{ exists: migrated ? "true" : "false" }];
    }
    if (sql.includes("pg_catalog.pg_namespace")) {
      return [{ exists: migrated ? "true" : "false" }];
    }
    if (sql.includes("SELECT coalesce(max(version), 0)")) {
      return [{ version: migrated ? "1" : "0" }];
    }
    if (sql.includes("INSERT INTO") && sql.includes(".migrations")) {
      migrated = true;
      return [];
    }
    if (sql.includes("SELECT count(*)::text AS n FROM inserted")) {
      return [{ n: "1" }];
    }
    if (sql.includes("WITH moved AS") && sql.includes(".dead_letters")) {
      return [{ id: "m-1" }];
    }
    if (sql.includes("DELETE FROM") && sql.includes(".messages")) {
      return [{ id: "m-1" }];
    }
    if (sql.includes("UPDATE") && sql.includes("history = history ||")) {
      return [{ id: "m-1" }];
    }
    if (sql.includes("SET lease_owner = NULL, lease_until = NULL")) {
      return [{ id: "m-1" }];
    }
    if (sql.includes("AS oldest_due_at")) {
      return [
        {
          pending: "2",
          ready: "1",
          leased: "1",
          dead_letters: "0",
          oldest_due_at: "1000",
        },
      ];
    }
    if (sql.includes("WITH purged AS")) {
      return [{ n: "2" }];
    }
    if (sql.includes("WITH pruned AS")) {
      return [{ n: "3" }];
    }
    if (
      sql.includes("SELECT EXISTS (SELECT 1 FROM") &&
      sql.includes(".inbox")
    ) {
      return [{ found: "true" }];
    }
    if (sql.includes("ON CONFLICT (consumer, message_id) DO NOTHING")) {
      return [{ consumer: "c1" }];
    }
    if (sql.includes("SELECT count(*)::text AS n FROM inserted")) {
      return [{ n: "1" }];
    }
    return [];
  };

  const txObj = {
    query: handleQuery,
    execute: async (sql: string, params?: readonly unknown[]) => {
      await handleQuery(sql, params);
      return { affectedRows: 1 };
    },
  };

  const executor: PgSqlExecutor<"postgres"> = {
    dialect: "postgres",
    query: handleQuery as PgSqlExecutor<"postgres">["query"],
    execute: txObj.execute,
    transaction: async (work) => work(txObj as never),
    wrapTransaction: (tx: unknown) => {
      if (tx === "NOT_A_TX") {
        const err = new TypeError("expected a transaction handle");
        (err as unknown as Record<string, unknown>).code =
          "ERR_SQL_NOT_A_TRANSACTION";
        throw err;
      }
      return txObj as never;
    },
  };

  return { executor, calls, setMigrated: (v: boolean) => (migrated = v) };
}

function createMockMySqlExecutor() {
  const calls: Array<{ sql: string; params?: readonly unknown[] }> = [];
  let migrated = false;

  const handleQuery = async (sql: string, params?: readonly unknown[]) => {
    calls.push({ sql, params });
    if (sql.includes("SELECT VERSION()")) {
      return [{ version: "8.4.0" }];
    }
    if (sql.includes("@@session.sql_mode")) {
      return [
        {
          sql_mode: "STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION",
          current_database: "app_db",
        },
      ];
    }
    if (sql.includes("information_schema.TABLES")) {
      return [{ found: migrated ? "1" : "0" }];
    }
    if (sql.includes("MAX(version)")) {
      return [{ version: migrated ? "1" : "0" }];
    }
    if (sql.includes("GET_LOCK")) {
      return [{ taken: "1", holder: null }];
    }
    if (sql.includes("@@session.lock_wait_timeout")) {
      return [{ wait: "50" }];
    }
    if (sql.includes("SELECT CAST(started AS CHAR)")) {
      return [{ started: "0", applied: "0" }];
    }
    if (sql.includes("SET applied_at = UNIX_TIMESTAMP()")) {
      migrated = true;
      return [];
    }
    if (sql.includes("FROM `nest_outbox_locks` WHERE id IN")) {
      // Return all queried lock IDs as already present so ensureLockRows is fast!
      return (params ?? []).map((id) => ({ id }));
    }
    if (sql.includes("AS oldest_due_at")) {
      return [
        {
          pending: "3",
          ready: "2",
          leased: "1",
          dead_letters: "1",
          oldest_due_at: "2000",
        },
      ];
    }
    if (sql.includes("AS found FROM") && sql.includes("inbox")) {
      return [{ found: "1" }];
    }
    if (sql.includes("FOR UPDATE") && sql.includes("messages")) {
      return [{ seq: "1" }];
    }
    return [];
  };

  const handleExecute = async (sql: string, params?: readonly unknown[]) => {
    calls.push({ sql, params });
    return { affectedRows: 1 };
  };

  const txObj = {
    query: handleQuery,
    execute: handleExecute,
  };

  const executor: MySqlSqlExecutor = {
    dialect: "mysql",
    query: handleQuery as MySqlSqlExecutor["query"],
    execute: handleExecute,
    transaction: async (work) => work(txObj as never),
    wrapTransaction: (tx: unknown) => {
      if (tx === "NOT_A_TX") {
        const err = new TypeError("expected a transaction handle");
        (err as unknown as Record<string, unknown>).code =
          "ERR_SQL_NOT_A_TRANSACTION";
        throw err;
      }
      return txObj as never;
    },
  };

  return { executor, calls, setMigrated: (v: boolean) => (migrated = v) };
}

const sampleMessage: OutboxMessage = {
  id: "msg-1",
  topic: "orders.created",
  payload: { amount: 100 },
  headers: { "x-req": "1" },
  key: "order-1",
  createdAt: 1000,
  availableAt: 1000,
  attempts: 0,
  lastError: null,
};

describe("@bunest/messaging/outbox/postgres", () => {
  it("re-exports @bunest/orm/postgres adapters and shares OutboxSchemaError with mysql subpath", () => {
    expect(typeof fromPg).toBe("function");
    expect(typeof fromPgDrizzle).toBe("function");
    expect(typeof fromPgKysely).toBe("function");
    expect(typeof fromPgPrisma).toBe("function");
    expect(typeof fromPgTypeOrm).toBe("function");
    expect(PgOutboxSchemaError).toBe(MySqlOutboxSchemaError);
    expect(PostgresOutboxStore.schemaVersion).toBe(1);

    const sql = PostgresOutboxStore.migrationSql({
      schema: "custom_outbox",
      statementBreakpoints: true,
    });
    expect(sql).toContain('CREATE SCHEMA IF NOT EXISTS "custom_outbox"');
    expect(sql).toContain('CREATE TABLE "custom_outbox".messages');
    expect(sql).toContain("--> statement-breakpoint");
  });

  it("migrates, registers with OutboxStorage, and runs CRUD/inbox/dead-letter queries", async () => {
    const mock = createMockPgExecutor();
    const storage = new OutboxStorage();
    const store = new PostgresOutboxStore(
      { executor: mock.executor, migrate: true },
      storage,
    );

    expect(storage.messages).toBe(store);
    expect(storage.inbox).toBe(store);

    await store.onModuleInit();
    await store.add({ tx: true }, [sampleMessage]);
    expect(
      await store.claim({ owner: "r1", now: 2000, leaseMs: 5000, limit: 10 }),
    ).toEqual([]);
    expect(await store.markPublished("m-1", "r1")).toBe(true);
    expect(
      await store.reschedule("m-1", "r1", {
        attempts: 1,
        availableAt: 3000,
        error: { attempt: 1, at: 2000, error: "err" },
      }),
    ).toBe(true);
    expect(
      await store.deadLetter("m-1", "r1", {
        attempts: 2,
        reason: "exhausted",
        failedAt: 4000,
        error: { attempt: 2, at: 4000, error: "err" },
      }),
    ).toBe(true);
    expect(await store.release(["m-1"], "r1")).toBe(1);
    expect(await store.stats(2000)).toEqual({
      pending: 2,
      ready: 1,
      leased: 1,
      deadLetters: 0,
      oldestDueAt: 1000,
    });
    expect(await store.listDeadLetters({ topic: "orders.created" })).toEqual(
      [],
    );
    expect(await store.getDeadLetter("m-1")).toBeUndefined();
    expect(await store.requeueDeadLetters({ all: true }, 5000)).toBe(1);
    expect(await store.purgeDeadLetters({ all: true })).toBe(2);
    expect(await store.recordInbox(undefined, "c1", "m-1", 1000)).toBe(true);
    expect(await store.hasInbox("c1", "m-1")).toBe(true);
    expect(await store.pruneInbox(5000)).toBe(3);

    await expect(store.add("NOT_A_TX", [sampleMessage])).rejects.toThrow(
      OutboxTransactionRequiredError,
    );
  });

  it("throws OutboxSchemaError when migrate is false and schema is behind", async () => {
    const mock = createMockPgExecutor();
    const store = new PostgresOutboxStore({
      executor: mock.executor,
      migrate: false,
    });
    try {
      await store.onModuleInit();
      expect.unreachable("should throw OutboxSchemaError");
    } catch (err) {
      expect(err).toBeInstanceOf(PgOutboxSchemaError);
      expect(err).toBeInstanceOf(OutboxError);
      expect((err as PgOutboxSchemaError).version).toBe(0);
      expect((err as PgOutboxSchemaError).requiredVersion).toBe(1);
    }
  });
});

describe("@bunest/messaging/outbox/mysql", () => {
  it("re-exports @bunest/orm/mysql adapters and generates MySQL migration SQL/statements", () => {
    expect(typeof fromMysql2).toBe("function");
    expect(typeof fromMySqlDrizzle).toBe("function");
    expect(typeof fromMySqlKysely).toBe("function");
    expect(typeof fromMySqlPrisma).toBe("function");
    expect(typeof fromMySqlTypeOrm).toBe("function");
    expect(MySqlOutboxStore.schemaVersion).toBe(1);

    const stmts = MySqlOutboxStore.migrationStatements({ schema: "my_outbox" });
    expect(stmts.length).toBeGreaterThan(3);
    expect(stmts.some((s) => s.includes("`my_outbox_messages`"))).toBe(true);
    const sql = MySqlOutboxStore.migrationSql({ schema: "my_outbox" });
    expect(sql).toContain("`my_outbox_dead_letters`");
    expect(sql).toContain("`my_outbox_inbox`");
  });

  it("migrates, enforces key lengths, wraps non-tx errors, and executes operations", async () => {
    const mock = createMockMySqlExecutor();
    const storage = new OutboxStorage();
    const store = new MySqlOutboxStore(
      { executor: mock.executor, migrate: true },
      storage,
    );

    await store.onModuleInit();
    await store.add({ tx: true }, [sampleMessage]);
    expect(await store.markPublished("m-1", "r1")).toBe(true);
    expect(
      await store.reschedule("m-1", "r1", {
        attempts: 1,
        availableAt: 3000,
        error: { attempt: 1, at: 2000, error: "err" },
      }),
    ).toBe(true);
    expect(
      await store.deadLetter("m-1", "r1", {
        attempts: 2,
        reason: "exhausted",
        failedAt: 4000,
        error: { attempt: 2, at: 4000, error: "err" },
      }),
    ).toBe(true);
    expect(await store.release(["m-1"], "r1")).toBe(1);
    expect(await store.stats(2000)).toEqual({
      pending: 3,
      ready: 2,
      leased: 1,
      deadLetters: 1,
      oldestDueAt: 2000,
    });
    expect(await store.purgeDeadLetters({ all: true })).toBe(1);
    expect(await store.recordInbox(undefined, "c1", "m-1", 1000)).toBe(true);
    expect(await store.hasInbox("c1", "m-1")).toBe(true);
    expect(await store.pruneInbox(5000)).toBe(1);

    await expect(store.add("NOT_A_TX", [sampleMessage])).rejects.toThrow(
      OutboxTransactionRequiredError,
    );

    const tooLong = "x".repeat(256);
    await expect(
      store.add({ tx: true }, [{ ...sampleMessage, id: tooLong }]),
    ).rejects.toThrow(RangeError);
  });
});

describe("@bunest/outbox CLI & dist subpath interoperability", () => {
  it("prints SQL for both postgres and mysql dialects via runStoreCli", async () => {
    let pgOut = "";
    const pgCode = await runStoreCli(
      outboxSchemas,
      ["sql", "--dialect", "postgres"],
      {
        out: (s) => (pgOut += s),
        err: () => {},
        env: {},
      },
    );
    expect(pgCode).toBe(0);
    expect(pgOut).toContain("CREATE TABLE");
    expect(pgOut).toContain("nest_outbox");

    let myOut = "";
    const myCode = await runStoreCli(
      outboxSchemas,
      ["sql", "--dialect", "mysql"],
      {
        out: (s) => (myOut += s),
        err: () => {},
        env: {},
      },
    );
    expect(myCode).toBe(0);
    expect(myOut).toContain("`nest_outbox_messages`");
  });

  it("shares identical runtime class references across built dist/ subpaths", async () => {
    const loadDist = (rel: string): Promise<Record<string, any>> =>
      import(new URL(rel, import.meta.url).href);
    const rootDist = await loadDist("../../dist/outbox/index.js");
    const pgDist = await loadDist("../../dist/outbox/postgres/index.js");
    const mysqlDist = await loadDist("../../dist/outbox/mysql/index.js");
    const testingDist = await loadDist("../../dist/outbox/testing/index.js");

    expect(pgDist.OutboxSchemaError).toBe(mysqlDist.OutboxSchemaError);
    expect(
      new pgDist.OutboxSchemaError("behind", {
        schema: "s",
        version: 0,
        requiredVersion: 1,
      }) instanceof rootDist.OutboxError,
    ).toBe(true);
    expect(typeof testingDist.outboxStoreContract).toBe("function");
  });
});
