import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { runStoreCli } from "@bunest/store-kit";
import { WebhooksError, WebhooksStorage } from "../src/index";
import {
  MySqlWebhookStore,
  WebhookSchemaError as MySqlWebhookSchemaError,
  fromDrizzle as mysqlFromDrizzle,
  fromKysely as mysqlFromKysely,
  fromMysql2,
  fromPrisma as mysqlFromPrisma,
  fromTypeOrm as mysqlFromTypeOrm,
  type SqlExecutor as MySqlExecutor,
} from "../src/mysql/index";
import { mysqlWebhookStoreSchema } from "../src/mysql/migrations/index";
import {
  PostgresWebhookStore,
  WebhookSchemaError as PgWebhookSchemaError,
  fromDrizzle as pgFromDrizzle,
  fromKysely as pgFromKysely,
  fromPg,
  fromPrisma as pgFromPrisma,
  fromTypeOrm as pgFromTypeOrm,
  type SqlExecutor as PgExecutor,
} from "../src/postgres/index";
import { webhookStoreSchema } from "../src/postgres/migrations/index";

function createMockPgExecutor(options: {
  version?: number;
  handler?: (sql: string, params: readonly unknown[]) => unknown[];
} = {}) {
  const queries: Array<{ sql: string; params: readonly unknown[] }> = [];
  let version = options.version ?? PostgresWebhookStore.schemaVersion;

  const run = async <Row = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<Row[]> => {
    queries.push({ sql, params });
    if (sql.includes("default_transaction_isolation")) {
      return [{ isolation: "read committed" }] as unknown as Row[];
    }
    if (sql.includes("pg_catalog.pg_class") && sql.includes("migrations")) {
      return [{ exists: version > 0 ? "true" : "false" }] as unknown as Row[];
    }
    if (sql.includes("pg_catalog.pg_namespace") && sql.includes("nspname")) {
      return [{ exists: version > 0 ? "true" : "false" }] as unknown as Row[];
    }
    if (sql.includes("coalesce(max(version)")) {
      return [{ version: String(version) }] as unknown as Row[];
    }
    if (sql.includes("pg_advisory_xact_lock")) {
      return [] as Row[];
    }
    if (sql.includes("INSERT INTO") && sql.includes(".migrations")) {
      version = PostgresWebhookStore.schemaVersion;
      return [] as Row[];
    }
    if (options.handler) {
      return options.handler(sql, params) as Row[];
    }
    return [] as Row[];
  };

  const executor: PgExecutor<"postgres"> = {
    dialect: "postgres",
    query: run,
    execute: async (sql, params) => {
      await run(sql, params);
      return { affectedRows: 1 };
    },
    transaction: async (fn) =>
      fn({
        query: run,
        execute: async (sql, params) => {
          await run(sql, params);
          return { affectedRows: 1 };
        },
        native: {},
      }),
    wrapTransaction: () => ({
      query: run,
      execute: async (sql, params) => {
        await run(sql, params);
        return { affectedRows: 1 };
      },
      native: {},
    }),
  };

  return { executor, queries };
}

function createMockMySqlExecutor(options: {
  version?: number;
  queryHandler?: (sql: string, params: readonly unknown[]) => unknown[];
  execHandler?: (sql: string, params: readonly unknown[]) => number;
} = {}) {
  const queries: Array<{ sql: string; params: readonly unknown[] }> = [];
  let version = options.version ?? MySqlWebhookStore.schemaVersion;

  const query = async <Row = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<Row[]> => {
    queries.push({ sql, params });
    if (sql.includes("SELECT VERSION() AS version")) {
      return [{ version: "8.4.0" }] as unknown as Row[];
    }
    if (sql.includes("@@session.sql_mode")) {
      return [
        {
          sql_mode: "STRICT_TRANS_TABLES,NO_ZERO_DATE",
          current_database: "app",
        },
      ] as unknown as Row[];
    }
    if (sql.includes("information_schema.TABLES")) {
      return [{ found: version > 0 ? "1" : "0" }] as unknown as Row[];
    }
    if (sql.includes("COALESCE(MAX(version)")) {
      return [{ version: String(version) }] as unknown as Row[];
    }
    if (sql.includes("GET_LOCK")) {
      return [{ taken: "1", holder: null }] as unknown as Row[];
    }
    if (sql.includes("@@session.lock_wait_timeout")) {
      return [{ wait: "50" }] as unknown as Row[];
    }
    if (sql.includes("SELECT CAST(started AS CHAR)")) {
      return [{ started: "0", applied: "0" }] as unknown as Row[];
    }
    if (sql.includes("UPDATE") && sql.includes("_migrations") && sql.includes("applied_at = UNIX_TIMESTAMP()")) {
      version = MySqlWebhookStore.schemaVersion;
      return [] as Row[];
    }
    if (options.queryHandler) {
      return options.queryHandler(sql, params) as Row[];
    }
    return [] as Row[];
  };

  const execute = async (
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<{ affectedRows: number }> => {
    queries.push({ sql, params });
    const affectedRows = options.execHandler ? options.execHandler(sql, params) : 1;
    return { affectedRows };
  };

  const executor: MySqlExecutor<"mysql"> = {
    dialect: "mysql",
    query,
    execute,
    transaction: async (fn) =>
      fn({
        query,
        execute,
        native: {},
      }),
    wrapTransaction: () => ({
      query,
      execute,
      native: {},
    }),
  };

  return { executor, queries };
}

describe("@bunest/webhooks/postgres", () => {
  it("exports all store-kit PostgreSQL adapters and generates valid migration SQL", () => {
    expect(typeof fromPg).toBe("function");
    expect(typeof pgFromDrizzle).toBe("function");
    expect(typeof pgFromKysely).toBe("function");
    expect(typeof pgFromPrisma).toBe("function");
    expect(typeof pgFromTypeOrm).toBe("function");
    expect(PgWebhookSchemaError).toBe(MySqlWebhookSchemaError);

    expect(PostgresWebhookStore.schemaVersion).toBe(1);
    const sql = PostgresWebhookStore.migrationSql({
      schema: "custom_wh",
      statementBreakpoints: true,
    });
    expect(sql).toContain('CREATE SCHEMA IF NOT EXISTS "custom_wh"');
    expect(sql).toContain('CREATE TABLE "custom_wh".endpoints');
    expect(sql).toContain('CREATE TABLE "custom_wh".deliveries');
    expect(sql).toContain('CREATE TABLE "custom_wh".delivery_attempts');
    expect(sql).toContain("--> statement-breakpoint");
  });

  it("throws WebhookSchemaError when behind with migrate: false, migrates when asked, and executes store queries", async () => {
    const behind = createMockPgExecutor({ version: 0 });
    const behindStore = new PostgresWebhookStore({
      executor: behind.executor,
      migrate: false,
    });
    await expect(behindStore.onModuleInit()).rejects.toThrow(
      PgWebhookSchemaError,
    );

    const migratable = createMockPgExecutor({ version: 0 });
    const storage = new WebhooksStorage();
    const store = new PostgresWebhookStore(
      { executor: migratable.executor, schema: "wh_test", migrate: true },
      storage,
    );
    expect(storage.endpoints).toBe(store);
    expect(storage.deliveries).toBe(store);
    expect(await store.migrate()).toEqual([1]);

    // Execute CRUD + claim + recordAttempt (with NUL sanitization) + stats + prune
    const mock = createMockPgExecutor({
      handler: (sql) => {
        if (sql.includes("FROM \"wh_test\".endpoints") && sql.includes("WHERE id =")) {
          return [
            {
              id: "ep_1",
              tenant: "t1",
              url: "https://hooks.example.com",
              event_types: '["order.shipped"]',
              description: null,
              enabled: "true",
              disabled_reason: null,
              failing_since: null,
              secrets: '[{"secret":"whsec_1","createdAt":1000,"expiresAt":null}]',
              created_at: "1000",
              updated_at: "1000",
            },
          ];
        }
        if (sql.includes("SELECT count(*)::text AS pending")) {
          return [
            { pending: "2", due: "1", leased: "1", failed: "3", oldest_due_at: "500" },
          ];
        }
        if (sql.includes("WITH recorded AS")) {
          return [{ id: "dlv_1" }];
        }
        if (sql.includes("SELECT count(*)::text AS n FROM created")) {
          return [{ n: "1" }];
        }
        if (sql.includes("SELECT count(*)::text AS n FROM retried")) {
          return [{ n: "2" }];
        }
        if (sql.includes("SELECT count(*)::text AS n FROM pruned")) {
          return [{ n: "4" }];
        }
        return [];
      },
    });
    const pgStore = new PostgresWebhookStore({
      executor: mock.executor,
      schema: "wh_test",
      migrate: false,
    });

    const ep = await pgStore.getEndpoint("ep_1");
    expect(ep?.id).toBe("ep_1");
    expect(ep?.enabled).toBe(true);
    expect(ep?.eventTypes).toEqual(["order.shipped"]);

    const recorded = await pgStore.recordDeliveryAttempt("dlv_1", "owner-1", {
      status: "succeeded",
      attempts: 1,
      nextAttemptAt: null,
      failureReason: null,
      completedAt: 2000,
      attempt: {
        deliveryId: "dlv_1",
        attempt: 1,
        at: 1990,
        durationMs: 10,
        statusCode: 200,
        response: "ok\u0000bin",
        error: null,
      },
    });
    expect(recorded).toBe(true);
    // Verify NUL byte was replaced with U+FFFD before binding to PostgreSQL
    const recordQuery = mock.queries.find((q) =>
      q.sql.includes("WITH recorded AS"),
    );
    expect(recordQuery?.params).toContain("ok\uFFFDbin");

    const stats = await pgStore.deliveryStats(1000);
    expect(stats).toEqual({
      pending: 2,
      due: 1,
      leased: 1,
      failed: 3,
      oldestDueAt: 500,
    });
    expect(await pgStore.retryDeliveries({ all: true }, 1000)).toBe(2);
    expect(await pgStore.pruneDeliveries(1000)).toBe(4);
  });
});

describe("@bunest/webhooks/mysql", () => {
  it("exports all store-kit MySQL adapters and generates valid DDL statements", () => {
    expect(typeof fromMysql2).toBe("function");
    expect(typeof mysqlFromDrizzle).toBe("function");
    expect(typeof mysqlFromKysely).toBe("function");
    expect(typeof mysqlFromPrisma).toBe("function");
    expect(typeof mysqlFromTypeOrm).toBe("function");

    expect(MySqlWebhookStore.schemaVersion).toBe(1);
    const statements = MySqlWebhookStore.migrationStatements({
      schema: "app_wh",
    });
    expect(statements.length).toBeGreaterThanOrEqual(6);
    expect(statements.some((s) => s.includes("`app_wh_endpoints`"))).toBe(true);
    expect(statements.some((s) => s.includes("`app_wh_deliveries`"))).toBe(
      true,
    );

    const sql = MySqlWebhookStore.migrationSql({
      schema: "app_wh",
      statementBreakpoints: true,
    });
    expect(sql).toContain("--> statement-breakpoint");
  });

  it("enforces key column limits, checks schema readiness, and executes MySQL store operations", async () => {
    const behind = createMockMySqlExecutor({ version: 0 });
    const behindStore = new MySqlWebhookStore({
      executor: behind.executor,
      migrate: false,
    });
    await expect(behindStore.onModuleInit()).rejects.toThrow(
      MySqlWebhookSchemaError,
    );

    const mock = createMockMySqlExecutor({
      queryHandler: (sql) => {
        if (sql.includes("CAST(COUNT(*) AS CHAR) AS pending")) {
          return [
            { pending: "4", due: "2", leased: "1", failed: "1", oldest_due_at: "900" },
          ];
        }
        return [];
      },
      execHandler: (sql) => {
        if (sql.includes("DELETE FROM") && sql.includes("_endpoints")) {
          return 1;
        }
        return 1;
      },
    });
    const storage = new WebhooksStorage();
    const store = new MySqlWebhookStore(
      { executor: mock.executor, schema: "my_wh", migrate: false },
      storage,
    );
    expect(storage.endpoints).toBe(store);

    // Key length check refuses >255 char ids before hitting DB
    await expect(
      store.createEndpoint({
        id: "e".repeat(256),
        tenant: null,
        url: "https://hooks.example.com",
        eventTypes: ["*"],
        description: null,
        enabled: true,
        disabledReason: null,
        failingSince: null,
        createdAt: 1,
        updatedAt: 1,
        secrets: [],
      }),
    ).rejects.toThrow(RangeError);

    expect(await store.deleteEndpoint("ep_1")).toBe(true);
    expect(await store.deliveryStats(1000)).toEqual({
      pending: 4,
      due: 2,
      leased: 1,
      failed: 1,
      oldestDueAt: 900,
    });
    expect(await store.retryDeliveries({ status: "failed" }, 1000)).toBe(1);
    expect(await store.pruneDeliveries(1000)).toBe(0);
  });
});

describe("nest-webhooks CLI & dist/ cross-subpath interop", () => {
  it("runs runStoreCli for postgres and mysql SQL generation", async () => {
    let pgOut = "";
    const pgCode = await runStoreCli(
      [webhookStoreSchema, mysqlWebhookStoreSchema],
      ["sql", "--schema", "cli_pg"],
      {
        out: (t) => {
          pgOut += t;
        },
        err: () => {},
        env: {},
      },
    );
    expect(pgCode).toBe(0);
    expect(pgOut).toContain('CREATE TABLE "cli_pg".endpoints');

    let myOut = "";
    const myCode = await runStoreCli(
      [webhookStoreSchema, mysqlWebhookStoreSchema],
      ["sql", "--dialect", "mysql", "--schema", "cli_my"],
      {
        out: (t) => {
          myOut += t;
        },
        err: () => {},
        env: {},
      },
    );
    expect(myCode).toBe(0);
    expect(myOut).toContain("`cli_my_endpoints`");
  });

  it("shares identical class identities across built dist/ subpaths (--splitting) and runs dist/cli.js", async () => {
    const pkgRoot = resolve(import.meta.dir, "..");
    const distRoot = await import(resolve(pkgRoot, "dist/index.js"));
    const distPg = await import(resolve(pkgRoot, "dist/postgres/index.js"));
    const distMy = await import(resolve(pkgRoot, "dist/mysql/index.js"));
    const distTesting = await import(resolve(pkgRoot, "dist/testing/index.js"));

    // Shared class identity across subpaths (requires --splitting)
    expect(distPg.WebhookSchemaError).toBe(distMy.WebhookSchemaError);
    const schemaErr = new distPg.WebhookSchemaError("behind", {
      schema: "nest_webhooks",
      version: 0,
      requiredVersion: 1,
    });
    expect(schemaErr instanceof distRoot.WebhooksError).toBe(true);
    expect(typeof distTesting.signWebhook).toBe("function");

    // CLI binary executes cleanly and prints SQL
    const proc = Bun.spawnSync(
      ["bun", resolve(pkgRoot, "dist/cli.js"), "sql", "--dialect", "postgres"],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.toString()).toContain("CREATE TABLE");
    expect(new WebhookSchemaErrorShim(schemaErr) instanceof WebhooksError).toBe(
      false,
    );
  });
});

class WebhookSchemaErrorShim {
  constructor(readonly inner: unknown) {}
}
