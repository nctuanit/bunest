import { describe, expect, test } from "bun:test";
import { resolve } from "@bunest/core";
import { runStoreCli, type StoreCliIo } from "@bunest/orm/store";
import { WorkflowError } from "../src/errors/workflow.error";
import type { WorkflowJournalEntry } from "../src/interfaces/workflow-instance.interface";
import type {
  NewWorkflowInstance,
  NewWorkflowSignal,
  WorkflowClaimRequest,
  WorkflowKeyKind,
  WorkflowScheduleSave,
} from "../src/interfaces/workflow-store.interface";
import * as mysqlEntry from "../src/mysql/index";
import {
  fromDrizzle as fromMySqlDrizzle,
  fromKysely as fromMySqlKysely,
  fromMysql2,
  fromPrisma as fromMySqlPrisma,
  fromTypeOrm as fromMySqlTypeOrm,
  MySqlWorkflowStore,
  type SqlExecutor as MySqlExecutor,
  type SqlTransaction as MySqlTransaction,
  WorkflowSchemaError as MySqlWorkflowSchemaError,
} from "../src/mysql/index";
import { checkKey, MYSQL_KEY_LIMITS } from "../src/mysql/key-limits";
import { mysqlWorkflowStoreSchema } from "../src/mysql/migrations/index";
import * as postgresEntry from "../src/postgres/index";
import {
  fromDrizzle as fromPgDrizzle,
  fromKysely as fromPgKysely,
  fromPg,
  fromPrisma as fromPgPrisma,
  fromTypeOrm as fromPgTypeOrm,
  PostgresWorkflowStore,
  type SqlExecutor as PgExecutor,
  type SqlTransaction as PgTransaction,
  WorkflowSchemaError,
} from "../src/postgres/index";
import { workflowStoreSchema } from "../src/postgres/migrations/index";
import { RateWindowClaim } from "../src/sql/rate-windows";
import {
  CANCELLABLE_STATUSES,
  INSTANCE_COLUMNS,
  RUNNABLE_STATUSES,
  type Row,
  SCHEDULE_COLUMNS,
  SIGNAL_COLUMNS,
  toInstance,
  toSchedule,
} from "../src/sql/workflow-rows";
import { WorkflowStorage } from "../src/storage/workflow.storage";

// ---------------------------------------------------------------------------
// Helpers & Mock Executors
// ---------------------------------------------------------------------------

interface RecordedCall {
  kind: "query" | "execute";
  sql: string;
  params: readonly unknown[];
  inTx: boolean;
}

type QueryResponder = (
  sql: string,
  params: readonly unknown[],
  inTx: boolean,
) => unknown[] | Promise<unknown[]>;

type ExecuteResponder = (
  sql: string,
  params: readonly unknown[],
  inTx: boolean,
) => { affectedRows: number } | Promise<{ affectedRows: number }>;

function sampleInstanceRow(overrides: Partial<Row> = {}): Row {
  return {
    id: "wf-1",
    workflow: "order",
    version: "1",
    parent_id: null,
    parent_close: null,
    concurrency_key: null,
    rate_limit_key: null,
    priority: "0",
    schedule_id: null,
    scheduled_at: null,
    status: "pending",
    input: '{"orderId":42}',
    output: null,
    error: null,
    wake_at: "1000",
    lease_owner: null,
    lease_until: null,
    cancel_requested: "false",
    terminate_requested: "false",
    cancel_reason: null,
    deadline: null,
    custom_status: null,
    signal_cursor: "0",
    runs: "0",
    created_at: "1000",
    updated_at: "1000",
    ...overrides,
  };
}

function sampleScheduleRow(overrides: Partial<Row> = {}): Row {
  return {
    id: "daily-report",
    workflow: "report",
    declared: "true",
    spec: '{"cron":"0 0 * * *"}',
    input: '{"tz":"UTC"}',
    paused: "false",
    wake_at: "2000",
    state: '{"lastRun":null}',
    revision: "1",
    lease_owner: null,
    lease_until: null,
    created_at: "1000",
    updated_at: "1000",
    ...overrides,
  };
}

function createMockPgExecutor(
  options: {
    defaultIsolation?: string;
    txIsolation?: string;
    schemaVersion?: number;
    schemaExists?: boolean;
    onQuery?: QueryResponder;
  } = {},
) {
  const calls: RecordedCall[] = [];
  let currentVersion = options.schemaVersion ?? 1;
  let schemaExists = options.schemaExists ?? currentVersion > 0;
  const defaultIsolation = options.defaultIsolation ?? "read committed";
  const txIsolation = options.txIsolation ?? "read committed";

  const handleQuery = async <R extends object>(
    sql: string,
    params: readonly unknown[] = [],
    inTx = false,
  ): Promise<R[]> => {
    calls.push({ kind: "query", sql, params: [...params], inTx });

    if (sql.includes("current_setting('default_transaction_isolation')")) {
      return [{ isolation: defaultIsolation } as unknown as R];
    }
    if (sql.includes("current_setting('transaction_isolation')")) {
      return [{ isolation: txIsolation } as unknown as R];
    }
    if (sql.includes("pg_catalog.pg_class")) {
      return [
        { exists: currentVersion > 0 ? "true" : "false" } as unknown as R,
      ];
    }
    if (sql.includes("pg_catalog.pg_namespace")) {
      return [{ exists: schemaExists ? "true" : "false" } as unknown as R];
    }
    if (sql.includes("coalesce(max(version), 0)::text AS version")) {
      return [{ version: String(currentVersion) } as unknown as R];
    }
    if (sql.startsWith("CREATE SCHEMA IF NOT EXISTS")) {
      schemaExists = true;
      return [];
    }
    if (
      sql.startsWith("INSERT INTO") &&
      sql.includes(".migrations (version, name)")
    ) {
      currentVersion = 1;
      return [];
    }
    if (sql.includes("pg_advisory_xact_lock")) {
      return [{ locked: "" } as unknown as R];
    }
    if (options.onQuery) {
      return (await options.onQuery(sql, params, inTx)) as R[];
    }
    return [];
  };

  const makeTx = (native?: unknown): PgTransaction => ({
    query: (sql, params) => handleQuery(sql, params, true),
    native,
  });

  const validNativeTx = { __mockPgTx: true };

  const executor: PgExecutor<"postgres"> = {
    dialect: "postgres",
    query: (sql, params) => handleQuery(sql, params, false),
    transaction: async (work) => work(makeTx()),
    wrapTransaction: (tx) => {
      if (tx === validNativeTx) {
        return makeTx(tx);
      }
      const err = new TypeError("Not a transaction") as TypeError & {
        code?: string;
      };
      err.code = "ERR_SQL_NOT_A_TRANSACTION";
      throw err;
    },
  };

  return {
    executor,
    calls,
    validNativeTx,
    setVersion: (v: number) => {
      currentVersion = v;
    },
  };
}

function createMockMySqlExecutor(
  options: {
    serverVersion?: string;
    database?: string;
    schemaVersion?: number;
    existingLocks?: string[];
    onQuery?: QueryResponder;
    onExecute?: ExecuteResponder;
  } = {},
) {
  const calls: RecordedCall[] = [];
  let currentVersion = options.schemaVersion ?? 1;
  const serverVersion = options.serverVersion ?? "8.4.3";
  const database = options.database ?? "app_db";
  const knownLocks = new Set(options.existingLocks ?? []);
  const migrationProgress = new Map<
    number,
    { started: number; applied: number }
  >();

  const handleQuery = async <R extends object>(
    sql: string,
    params: readonly unknown[] = [],
    inTx = false,
  ): Promise<R[]> => {
    calls.push({ kind: "query", sql, params: [...params], inTx });

    if (sql === "SELECT VERSION() AS version") {
      return [{ version: serverVersion } as unknown as R];
    }
    if (sql.includes("@@session.sql_mode")) {
      return [
        {
          sql_mode: "STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION",
          current_database: database,
        } as unknown as R,
      ];
    }
    if (sql.includes("information_schema.TABLES")) {
      return [{ found: currentVersion > 0 ? "1" : "0" } as unknown as R];
    }
    if (sql.includes("COALESCE(MAX(version), 0)")) {
      return [{ version: String(currentVersion) } as unknown as R];
    }
    if (sql.includes("GET_LOCK")) {
      return [{ taken: "1", holder: null } as unknown as R];
    }
    if (sql.includes("@@session.lock_wait_timeout")) {
      return [{ wait: "31536000" } as unknown as R];
    }
    if (
      sql === "COMMIT" ||
      sql.startsWith("SET SESSION lock_wait_timeout") ||
      sql.startsWith("DO RELEASE_LOCK")
    ) {
      return [];
    }
    if (
      sql.includes("_migrations") &&
      sql.includes("SELECT CAST(started AS CHAR)")
    ) {
      const p = migrationProgress.get(Number(params[0])) ?? {
        started: 0,
        applied: 0,
      };
      return [
        {
          started: String(p.started),
          applied: String(p.applied),
        } as unknown as R,
      ];
    }
    if (
      sql.includes("_migrations") &&
      sql.startsWith("UPDATE") &&
      sql.includes("applied_at = UNIX_TIMESTAMP()")
    ) {
      currentVersion = Number(params[0]);
      return [];
    }
    if (sql.includes("_migrations") && sql.startsWith("UPDATE")) {
      const version = Number(params.at(-1));
      const prev = migrationProgress.get(version) ?? { started: 0, applied: 0 };
      if (sql.includes("applied =")) {
        migrationProgress.set(version, {
          started: Number(params[0]),
          applied: Number(params[1]),
        });
      } else {
        migrationProgress.set(version, {
          started: Number(params[0]),
          applied: prev.applied,
        });
      }
      return [];
    }
    if (sql.includes("_locks` WHERE id IN") && !sql.includes("FOR UPDATE")) {
      return [...params]
        .filter((id) => knownLocks.has(String(id)))
        .map((id) => ({ id: String(id) }) as unknown as R);
    }
    if (sql.includes("_locks` WHERE id = ? LOCK IN SHARE MODE")) {
      const id = String(params[0]);
      return knownLocks.has(id) ? ([{ id }] as unknown as R[]) : [];
    }
    if (sql.includes("_locks` WHERE id IN") && sql.includes("FOR UPDATE")) {
      return [...params].map((id) => ({ id: String(id) }) as unknown as R);
    }

    if (options.onQuery) {
      return (await options.onQuery(sql, params, inTx)) as R[];
    }
    return [];
  };

  const handleExecute = async (
    sql: string,
    params: readonly unknown[] = [],
    inTx = false,
  ): Promise<{ affectedRows: number }> => {
    calls.push({ kind: "execute", sql, params: [...params], inTx });
    if (sql.includes("_locks` (id) VALUES")) {
      for (const id of params) {
        knownLocks.add(String(id));
      }
      return { affectedRows: params.length };
    }
    if (options.onExecute) {
      return options.onExecute(sql, params, inTx);
    }
    return { affectedRows: 1 };
  };

  const makeTx = (native?: unknown): MySqlTransaction => ({
    query: (sql, params) => handleQuery(sql, params, true),
    execute: (sql, params) => handleExecute(sql, params, true),
    native,
  });

  const validNativeTx = { __mockMySqlTx: true };

  const executor: MySqlExecutor<"mysql"> = {
    dialect: "mysql",
    query: (sql, params) => handleQuery(sql, params, false),
    execute: (sql, params) => handleExecute(sql, params, false),
    transaction: async (work) => work(makeTx()),
    wrapTransaction: (tx) => {
      if (tx === validNativeTx) {
        return makeTx(tx);
      }
      const err = new TypeError("Not a transaction") as TypeError & {
        code?: string;
      };
      err.code = "ERR_SQL_NOT_A_TRANSACTION";
      throw err;
    },
  };

  return { executor, calls, validNativeTx, knownLocks };
}

function makeNewInstance(
  overrides: Partial<NewWorkflowInstance> = {},
): NewWorkflowInstance {
  return {
    id: "wf-1",
    workflow: "order",
    version: 1,
    input: { orderId: 42 },
    deadline: null,
    now: 1000,
    ...overrides,
  };
}

function makeSignal(
  overrides: Partial<NewWorkflowSignal> = {},
): NewWorkflowSignal {
  return {
    name: "payment.received",
    key: "order-42",
    dedupeId: "evt-1",
    payload: { paid: true },
    now: 1500,
    ...overrides,
  };
}

function makeScheduleSave(
  overrides: Partial<WorkflowScheduleSave> = {},
): WorkflowScheduleSave {
  return {
    id: "daily-report",
    workflow: "report",
    declared: true,
    spec: { cron: "0 0 * * *" },
    input: { tz: "UTC" },
    paused: false,
    wakeAt: 2000,
    state: { lastRun: null },
    expectRevision: null,
    releaseLease: false,
    now: 1000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Shared SQL Helpers
// ---------------------------------------------------------------------------

describe("Shared SQL helpers", () => {
  test("WorkflowSchemaError extends WorkflowError and preserves details and cause", () => {
    const cause = new Error("connection failed");
    const err = new WorkflowSchemaError("schema behind", {
      schema: "custom_wf",
      version: 0,
      requiredVersion: 1,
      cause,
    });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(WorkflowError);
    expect(err).toBeInstanceOf(WorkflowSchemaError);
    expect(err.name).toBe("WorkflowSchemaError");
    expect(err.message).toBe("schema behind");
    expect(err.schema).toBe("custom_wf");
    expect(err.version).toBe(0);
    expect(err.requiredVersion).toBe(1);
    expect(err.cause).toBe(cause);
    expect(WorkflowSchemaError).toBe(MySqlWorkflowSchemaError);
  });

  test("workflow-rows constants and toInstance / toSchedule mapping work for both Postgres and MySQL text encodings", () => {
    expect(RUNNABLE_STATUSES).toEqual([
      "pending",
      "running",
      "suspended",
      "compensating",
    ]);
    expect(CANCELLABLE_STATUSES).toEqual(["pending", "running", "suspended"]);
    expect(INSTANCE_COLUMNS.length).toBe(26);
    expect(SCHEDULE_COLUMNS.length).toBe(13);
    expect(SIGNAL_COLUMNS).toEqual([
      "id",
      "name",
      "key",
      "payload",
      "created_at",
    ]);

    const pgInstance = toInstance(
      sampleInstanceRow({
        parent_id: "parent-1",
        parent_close: "cancel",
        concurrency_key: "ck-1",
        rate_limit_key: "rk-1",
        priority: "5",
        schedule_id: "sched-1",
        scheduled_at: "900",
        status: "running",
        output: '{"ok":true}',
        error: '{"name":"Error","message":"boom"}',
        lease_owner: "worker-1",
        lease_until: "5000",
        cancel_requested: "true",
        terminate_requested: "false",
        cancel_reason: "user cancel",
        deadline: "9000",
        custom_status: '{"stage":"ship"}',
        signal_cursor: "7",
        runs: "3",
      }),
    );
    expect(pgInstance).toEqual({
      id: "wf-1",
      workflow: "order",
      version: 1,
      parentId: "parent-1",
      parentClose: "cancel",
      concurrencyKey: "ck-1",
      rateLimitKey: "rk-1",
      priority: 5,
      scheduleId: "sched-1",
      scheduledAt: 900,
      status: "running",
      input: { orderId: 42 },
      output: { ok: true },
      error: { name: "Error", message: "boom" },
      wakeAt: 1000,
      leaseOwner: "worker-1",
      leaseUntil: 5000,
      cancelRequested: true,
      terminateRequested: false,
      cancelReason: "user cancel",
      deadline: 9000,
      customStatus: { stage: "ship" },
      signalCursor: 7,
      runs: 3,
      createdAt: 1000,
      updatedAt: 1000,
    });

    const mysqlInstance = toInstance(
      sampleInstanceRow({
        cancel_requested: "1",
        terminate_requested: "1",
      }),
    );
    expect(mysqlInstance.cancelRequested).toBe(true);
    expect(mysqlInstance.terminateRequested).toBe(true);

    const schedule = toSchedule(
      sampleScheduleRow({ declared: "1", paused: "0", revision: "4" }),
    );
    expect(schedule).toEqual({
      id: "daily-report",
      workflow: "report",
      declared: true,
      spec: { cron: "0 0 * * *" },
      input: { tz: "UTC" },
      paused: false,
      wakeAt: 2000,
      state: { lastRun: null },
      revision: 4,
      leaseOwner: null,
      leaseUntil: null,
      createdAt: 1000,
      updatedAt: 1000,
    });
  });

  test("RateWindowClaim deduplicates/sorts windows and enforces active vs expired windows", () => {
    const request: WorkflowClaimRequest = {
      owner: "w1",
      token: "tok",
      now: 10_000,
      leaseUntil: 20_000,
      limit: 10,
      workflows: [
        { name: "alpha", version: 1 },
        { name: "beta", version: 1 },
      ],
      rateLimits: [
        {
          workflow: "alpha",
          limit: { max: 2, duration: 5_000 },
          perKey: { max: 1, duration: 1_000 },
        },
        {
          workflow: "beta",
          limit: { max: 1, duration: 2_000 },
          perKey: null,
        },
      ],
    };

    const claim = new RateWindowClaim(request, [
      { id: "b1", workflow: "beta", rateLimitKey: null },
      { id: "a1", workflow: "alpha", rateLimitKey: "tenant-b" },
      { id: "a2", workflow: "alpha", rateLimitKey: "tenant-b" },
      { id: "a3", workflow: "alpha", rateLimitKey: "tenant-a" },
      { id: "a4", workflow: "alpha", rateLimitKey: null },
    ]);

    expect(claim.windows).toEqual([
      { workflow: "alpha", key: "" },
      { workflow: "alpha", key: "tenant-a" },
      { workflow: "alpha", key: "tenant-b" },
      { workflow: "beta", key: "" },
    ]);

    const result = claim.grant([
      // expired window (windowEnd <= now) resets to 0
      { workflow: "alpha", key: "", windowEnd: 9_000, count: 99 },
      { workflow: "alpha", key: "tenant-a", windowEnd: 0, count: 0 },
      { workflow: "alpha", key: "tenant-b", windowEnd: 0, count: 0 },
      // active window already full
      { workflow: "beta", key: "", windowEnd: 15_000, count: 1 },
    ]);

    // b1 rejected (beta full); a1 granted (alpha 1/2, tenant-b 1/1); a2 rejected (tenant-b 1/1);
    // a3 granted (alpha 2/2, tenant-a 1/1); a4 rejected (alpha 2/2)
    expect(result.granted).toEqual(["a1", "a3"]);
    expect(result.changed).toEqual([
      { workflow: "alpha", key: "", windowEnd: 15_000, count: 2 },
      { workflow: "alpha", key: "tenant-b", windowEnd: 11_000, count: 1 },
      { workflow: "alpha", key: "tenant-a", windowEnd: 11_000, count: 1 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 2. PostgreSQL Store & Exports
// ---------------------------------------------------------------------------

describe("PostgresWorkflowStore & ./postgres entry", () => {
  test("exports exact runtime surface matching upstream ./postgres", () => {
    expect(Object.keys(postgresEntry).sort()).toEqual([
      "PostgresWorkflowStore",
      "WorkflowSchemaError",
      "fromDrizzle",
      "fromKysely",
      "fromPg",
      "fromPrisma",
      "fromTypeOrm",
    ]);
  });

  test("static schemaVersion and migrationSql()", () => {
    expect(PostgresWorkflowStore.schemaVersion).toBe(1);

    const sql = PostgresWorkflowStore.migrationSql();
    expect(sql).toContain(
      '@bunest/workflows: PostgresWorkflowStore\'s schema "nest_workflows"',
    );
    expect(sql).toContain('CREATE SCHEMA IF NOT EXISTS "nest_workflows"');
    expect(sql).toContain('CREATE TABLE "nest_workflows".instances');
    expect(sql).toContain('CREATE TABLE "nest_workflows".journal');
    expect(sql).toContain('CREATE TABLE "nest_workflows".waits');
    expect(sql).toContain('CREATE TABLE "nest_workflows".signals');
    expect(sql).toContain('CREATE TABLE "nest_workflows".schedules');
    expect(sql).toContain('CREATE TABLE "nest_workflows".rate_limits');
    expect(sql).toContain('INSERT INTO "nest_workflows".migrations');

    const bpSql = PostgresWorkflowStore.migrationSql({
      schema: "custom_pg",
      statementBreakpoints: true,
    });
    expect(bpSql).toContain('CREATE SCHEMA IF NOT EXISTS "custom_pg"');
    expect(bpSql).toContain("--> statement-breakpoint");

    expect(
      PostgresWorkflowStore.migrationSql({ from: 1, to: 1 }),
    ).not.toContain("CREATE TABLE");
  });

  test("constructor registers itself on WorkflowStorage and rejects invalid options", () => {
    const { executor } = createMockPgExecutor();
    const storage = new WorkflowStorage();
    const store = new PostgresWorkflowStore({ executor }, storage);
    expect(storage.source).toBe(store);

    expect(() => new PostgresWorkflowStore({ executor }, storage)).toThrow(
      /registered after WorkflowsModule initialized/,
    );

    expect(
      () =>
        new PostgresWorkflowStore({
          executor,
          schema: "1bad-schema",
        }),
    ).toThrow(TypeError);
  });

  test("readiness, migrate: false -> WorkflowSchemaError, migrate: true -> applies migration 1", async () => {
    const behind = createMockPgExecutor({ schemaVersion: 0 });
    const strictStore = new PostgresWorkflowStore({
      executor: behind.executor,
      migrate: false,
    });
    await expect(strictStore.onModuleInit()).rejects.toBeInstanceOf(
      WorkflowSchemaError,
    );
    try {
      await strictStore.onModuleInit();
    } catch (err) {
      const schemaErr = err as WorkflowSchemaError;
      expect(schemaErr.schema).toBe("nest_workflows");
      expect(schemaErr.version).toBe(0);
      expect(schemaErr.requiredVersion).toBe(1);
    }

    const autoMigrate = createMockPgExecutor({ schemaVersion: 0 });
    const store = new PostgresWorkflowStore({
      executor: autoMigrate.executor,
      migrate: true,
    });
    const applied = await store.migrate();
    expect(applied).toEqual([1]);
    expect(
      autoMigrate.calls.some((c) =>
        c.sql.includes('CREATE TABLE "nest_workflows".instances'),
      ),
    ).toBe(true);
    expect(await store.migrate()).toEqual([]);

    const badIso = createMockPgExecutor({
      defaultIsolation: "repeatable read",
    });
    const badIsoStore = new PostgresWorkflowStore({
      executor: badIso.executor,
    });
    await expect(badIsoStore.onModuleInit()).rejects.toThrow(/READ COMMITTED/);
  });

  test("unstorableText refuses U+0000 in text/json and lone surrogates in json only", () => {
    const { executor } = createMockPgExecutor();
    const store = new PostgresWorkflowStore({ executor });

    expect(store.unstorableText("a\u0000b", "text")).toBe("U+0000");
    expect(store.unstorableText("a\u0000b", "json")).toBe("U+0000");
    expect(store.unstorableText("hi\uD800", "json")).toBe(
      "a lone UTF-16 surrogate",
    );
    expect(store.unstorableText("hi\uD800", "text")).toBeUndefined();
    expect(store.unstorableText("hello 🚀", "json")).toBeUndefined();
    expect(store.unstorableText("hello 🚀", "text")).toBeUndefined();
  });

  test("create, createInTransaction, get, list, requestCancel, reopen, delete", async () => {
    let createMode: "new" | "conflict" | "vanish" = "new";
    const mock = createMockPgExecutor({
      onQuery: (sql) => {
        if (sql.startsWith('INSERT INTO "nest_workflows".instances')) {
          return createMode === "new" ? [sampleInstanceRow()] : [];
        }
        if (
          sql.includes('FROM "nest_workflows".instances WHERE id =') &&
          !sql.includes("DELETE")
        ) {
          return createMode === "conflict" ? [sampleInstanceRow()] : [];
        }
        if (sql.includes("AS waits") && sql.includes("AS journal")) {
          return [
            sampleInstanceRow({
              waits: '[{"signal":"approved","key":"k1"}]',
              journal:
                '[{"name":"step-1","kind":"step","status":"completed","attempts":1}]',
            }),
          ];
        }
        if (sql.includes("AS waits")) {
          return [
            sampleInstanceRow({
              waits: '[{"signal":"approved","key":null}]',
            }),
          ];
        }
        if (sql.includes('FROM "nest_workflows".instances i')) {
          return [
            sampleInstanceRow({ id: "wf-1" }),
            sampleInstanceRow({ id: "wf-2" }),
          ];
        }
        if (sql.startsWith('UPDATE "nest_workflows".instances')) {
          return [{ id: "wf-1" }];
        }
        if (sql.startsWith('DELETE FROM "nest_workflows".instances')) {
          return [{ id: "wf-1" }];
        }
        return [];
      },
    });
    const store = new PostgresWorkflowStore({ executor: mock.executor });

    // create (new)
    const created = await store.create(makeNewInstance());
    expect(created.created).toBe(true);
    expect(created.instance.id).toBe("wf-1");

    // create (conflict -> returns existing)
    createMode = "conflict";
    const existing = await store.create(makeNewInstance());
    expect(existing.created).toBe(false);
    expect(existing.instance.id).toBe("wf-1");

    // create (repeatedly deleted -> throws after 3 attempts)
    createMode = "vanish";
    await expect(store.create(makeNewInstance())).rejects.toThrow(
      /was deleted each time its creation met it/,
    );

    // createInTransaction
    createMode = "new";
    const inTx = await store.createInTransaction(
      mock.validNativeTx,
      makeNewInstance(),
    );
    expect(inTx.created).toBe(true);

    // get without & with journal
    const details = await store.get("wf-1");
    expect(details?.waits).toEqual([{ signal: "approved", key: null }]);
    expect(details?.journal).toBeUndefined();

    const withJournal = await store.get("wf-1", { journal: true });
    expect(withJournal?.waits).toEqual([{ signal: "approved", key: "k1" }]);
    expect(withJournal?.journal).toHaveLength(1);
    expect(withJournal?.journal?.[0]?.name).toBe("step-1");

    // list with filters
    const listed = await store.list({
      status: ["pending", "running"],
      workflow: "order",
      version: 1,
      parentId: "p-1",
      scheduleId: "s-1",
      limit: 20,
      offset: 5,
    });
    expect(listed.map((i) => i.id)).toEqual(["wf-1", "wf-2"]);
    const listCall = mock.calls.find((c) =>
      c.sql.includes("ORDER BY i.created_at, i.id LIMIT"),
    );
    expect(listCall?.sql).toContain("status IN ($1::text, $2::text)");
    expect(listCall?.sql).toContain("workflow = $3::text");
    expect(listCall?.sql).toContain("parent_id = $5::text");
    expect(listCall?.sql).toContain("schedule_id = $6::text");

    // requestCancel (cancel vs terminate)
    expect(
      await store.requestCancel("wf-1", {
        reason: "bye",
        now: 2000,
        terminate: false,
      }),
    ).toBe(true);
    expect(
      await store.requestCancel("wf-1", {
        reason: "kill",
        now: 2100,
        terminate: true,
      }),
    ).toBe(true);
    const termCall = mock.calls.at(-1);
    expect(termCall?.sql).toContain("terminate_requested = true");

    // reopen with journal entries
    const entry: WorkflowJournalEntry = {
      name: "$retry:1",
      kind: "retry",
      status: "completed",
      attempts: 1,
    };
    expect(
      await store.reopen("wf-1", {
        expect: { status: "failed", runs: 2 },
        status: "pending",
        error: null,
        deadline: 9000,
        entries: [entry],
        now: 3000,
      }),
    ).toBe(true);
    expect(
      mock.calls.some((c) =>
        c.sql.includes('INSERT INTO "nest_workflows".journal'),
      ),
    ).toBe(true);

    // delete
    expect(await store.delete("wf-1", ["completed", "failed"])).toBe(true);
  });

  test("signal, signalInTransaction (READ COMMITTED check), signals, purge", async () => {
    let dedupeHit = false;
    const mock = createMockPgExecutor({
      onQuery: (sql) => {
        if (sql.startsWith('INSERT INTO "nest_workflows".signals')) {
          return dedupeHit ? [] : [{ id: "10" }];
        }
        if (
          sql.includes(
            'SELECT id::text AS id, key FROM "nest_workflows".signals',
          )
        ) {
          return [{ id: "7", key: "order-42" }];
        }
        if (sql.includes("WITH woken AS")) {
          return [{ n: "2" }];
        }
        if (sql.includes('FROM "nest_workflows".signals s')) {
          return [
            {
              id: "10",
              name: "payment.received",
              key: null,
              payload: '{"paid":true}',
              created_at: "1500",
            },
          ];
        }
        if (sql.includes("WITH purged AS")) return [{ n: "3" }];
        if (sql.includes("WITH pruned AS")) return [{ n: "5" }];
        if (sql.includes("WITH ended AS")) return [{ n: "4" }];
        return [];
      },
    });
    const store = new PostgresWorkflowStore({ executor: mock.executor });

    const sig1 = await store.signal(makeSignal());
    expect(sig1).toEqual({ id: 10, woken: 2, created: true, key: "order-42" });

    dedupeHit = true;
    const sigDup = await store.signal(makeSignal());
    expect(sigDup).toEqual({
      id: 7,
      woken: 0,
      created: false,
      key: "order-42",
    });

    dedupeHit = false;
    const sigTx = await store.signalInTransaction(
      mock.validNativeTx,
      makeSignal(),
    );
    expect(sigTx.created).toBe(true);

    // Non-READ COMMITTED transaction must be rejected
    const rrMock = createMockPgExecutor({ txIsolation: "repeatable read" });
    const rrStore = new PostgresWorkflowStore({ executor: rrMock.executor });
    await expect(
      rrStore.signalInTransaction(rrMock.validNativeTx, makeSignal()),
    ).rejects.toThrow(/READ COMMITTED/);

    const list = await store.signals({
      name: "payment.received",
      key: null,
      afterId: 0,
      upToId: 20,
    });
    expect(list).toEqual([
      {
        id: 10,
        name: "payment.received",
        key: null,
        payload: { paid: true },
        createdAt: 1500,
      },
    ]);
    const sigListCall = mock.calls.find((c) =>
      c.sql.includes("AND key IS NULL"),
    );
    expect(sigListCall).toBeDefined();

    const purged = await store.purge({
      statuses: ["completed"],
      before: 5000,
      limit: 100,
    });
    expect(purged).toEqual({ instances: 3, signals: 5, rateLimits: 4 });
  });

  test("schedules lifecycle and worker claim / claimWithin / renew / write", async () => {
    const mock = createMockPgExecutor({
      onQuery: (sql) => {
        if (sql.includes('INTO "nest_workflows".schedules')) {
          return [sampleScheduleRow()];
        }
        if (
          sql.startsWith('UPDATE "nest_workflows".schedules') &&
          sql.includes("RETURNING")
        ) {
          return [sampleScheduleRow({ revision: "2" })];
        }
        if (sql.includes('FROM "nest_workflows".schedules')) {
          return [sampleScheduleRow()];
        }
        if (sql.startsWith('DELETE FROM "nest_workflows".schedules')) {
          return [{ id: "daily-report" }];
        }
        if (sql.includes("WITH claimed AS") && sql.includes(".schedules")) {
          return [
            sampleScheduleRow({ lease_owner: "w1", lease_until: "9000" }),
          ];
        }
        if (sql.includes("WITH claimed AS") && sql.includes(".instances")) {
          return [
            sampleInstanceRow({
              status: "running",
              lease_owner: "w1",
              lease_until: "9000",
              runs: "1",
            }),
          ];
        }
        if (sql.includes("SELECT coalesce(max(id), 0)::text AS id")) {
          return [{ id: "12" }];
        }
        if (sql.includes("WITH limits AS")) {
          return [{ id: "wf-1" }];
        }
        if (sql.includes("SELECT i.id, i.workflow, i.rate_limit_key")) {
          return [{ id: "wf-1", workflow: "order", rate_limit_key: "t1" }];
        }
        if (sql.includes('INSERT INTO "nest_workflows".rate_limits')) {
          return [
            { workflow: "order", key: "", window_end: "0", count: "0" },
            { workflow: "order", key: "t1", window_end: "0", count: "0" },
          ];
        }
        if (sql.includes("RETURNING cancel_requested::text")) {
          return [{ cancel_requested: "true", terminate_requested: "false" }];
        }
        if (sql.includes("SELECT cancel_requested::text AS cancel_requested")) {
          return [{ cancel_requested: "false" }];
        }
        if (
          sql.includes('SELECT id::text AS id FROM "nest_workflows".signals')
        ) {
          return [];
        }
        return [];
      },
    });
    const store = new PostgresWorkflowStore({ executor: mock.executor });

    // Schedules
    const createdSched = await store.saveSchedule(makeScheduleSave());
    expect(createdSched?.id).toBe("daily-report");

    const updatedSched = await store.saveSchedule(
      makeScheduleSave({ expectRevision: 1, releaseLease: true }),
    );
    expect(updatedSched?.revision).toBe(2);

    expect((await store.getSchedule("daily-report"))?.workflow).toBe("report");
    expect(
      (
        await store.listSchedules({
          workflow: "report",
          declared: true,
          limit: 10,
          offset: 0,
        })
      ).length,
    ).toBe(1);
    expect(await store.deleteSchedule("daily-report", 2)).toBe(true);

    const claimedScheds = await store.claimSchedules({
      owner: "w1",
      token: "tok-1",
      now: 2500,
      leaseUntil: 9000,
      limit: 5,
      workflows: ["report"],
    });
    expect(claimedScheds).toHaveLength(1);
    expect(
      await store.writeSchedule("daily-report", "tok-1", {
        now: 2600,
        state: { lastRun: 2500 },
        wakeAt: 86_400_000,
        release: true,
      }),
    ).toBe(true);

    // Plain claim
    const plainClaim = await store.claim({
      owner: "w1",
      token: "tok-1",
      now: 1000,
      leaseUntil: 9000,
      limit: 5,
      workflows: [{ name: "order", version: 1 }],
    });
    expect(plainClaim.instances).toHaveLength(1);
    expect(plainClaim.lastSignalId).toBe(12);

    // Concurrency + rate-limited claim (claimWithin + takeRoom)
    const limitedClaim = await store.claim({
      owner: "w1",
      token: "tok-2",
      now: 1000,
      leaseUntil: 9000,
      limit: 5,
      workflows: [{ name: "order", version: 1 }],
      limits: [{ workflow: "order", limit: 10, perKey: 2 }],
      rateLimits: [
        {
          workflow: "order",
          limit: { max: 5, duration: 1000 },
          perKey: { max: 2, duration: 1000 },
        },
      ],
    });
    expect(limitedClaim.instances).toHaveLength(1);
    expect(
      mock.calls.some((c) =>
        c.sql.includes('UPDATE "nest_workflows".rate_limits rl SET window_end'),
      ),
    ).toBe(true);

    // renew
    const renewed = await store.renew("wf-1", "tok-1", 12_000);
    expect(renewed).toEqual({
      cancelRequested: true,
      terminateRequested: false,
    });

    // write with entries + waits + release
    const wrote = await store.write("wf-1", "tok-1", {
      now: 2000,
      entries: [
        {
          name: "s1",
          kind: "step",
          status: "completed",
          attempts: 1,
          result: 7,
        },
      ],
      status: "suspended",
      customStatus: { step: "waiting" },
      release: {
        wakeAt: 5000,
        waits: [{ signal: "approved", key: "k1" }],
        signalCursor: 12,
      },
    });
    expect(wrote).toBe(true);
    expect(
      mock.calls.some((c) => c.sql.includes("pg_advisory_xact_lock_shared")),
    ).toBe(true);
    expect(
      mock.calls.some((c) =>
        c.sql.includes('INSERT INTO "nest_workflows".waits'),
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. MySQL Store, Key Limits & Exports
// ---------------------------------------------------------------------------

describe("MySqlWorkflowStore & ./mysql entry", () => {
  test("exports exact runtime surface matching upstream ./mysql", () => {
    expect(Object.keys(mysqlEntry).sort()).toEqual([
      "MySqlWorkflowStore",
      "WorkflowSchemaError",
      "fromDrizzle",
      "fromKysely",
      "fromMysql2",
      "fromPrisma",
      "fromTypeOrm",
    ]);
  });

  test("static schemaVersion, migrationSql(), and migrationStatements()", () => {
    expect(MySqlWorkflowStore.schemaVersion).toBe(1);

    const statements = MySqlWorkflowStore.migrationStatements();
    // 2 bookkeeping tables + 6 workflow tables + 1 INSERT into migrations = 9
    expect(statements).toHaveLength(9);
    expect(statements[0]).toContain("`nest_workflows_migrations`");
    expect(statements[1]).toContain("`nest_workflows_locks`");
    expect(statements[2]).toContain("CREATE TABLE `nest_workflows_instances`");
    expect(statements[3]).toContain("CREATE TABLE `nest_workflows_journal`");
    expect(statements[4]).toContain("CREATE TABLE `nest_workflows_waits`");
    expect(statements[5]).toContain("CREATE TABLE `nest_workflows_signals`");
    expect(statements[6]).toContain("CREATE TABLE `nest_workflows_schedules`");
    expect(statements[7]).toContain(
      "CREATE TABLE `nest_workflows_rate_limits`",
    );
    expect(statements[8]).toContain("INSERT INTO `nest_workflows_migrations`");

    const sql = MySqlWorkflowStore.migrationSql({
      schema: "custom_my",
      statementBreakpoints: true,
    });
    expect(sql).toContain("CREATE TABLE `custom_my_instances`");
    expect(sql).toContain("--> statement-breakpoint");
  });

  test("MYSQL_KEY_LIMITS and checkKey count code points and enforce bounds", () => {
    expect(MYSQL_KEY_LIMITS.instanceId).toBe(255);
    expect(MYSQL_KEY_LIMITS.scheduleId).toBe(230);
    expect(MYSQL_KEY_LIMITS.journalName).toBe(512);

    // 255 4-byte emoji (UTF-16 length 510, code points 255) MUST PASS!
    const exactEmoji = "🚀".repeat(255);
    expect(exactEmoji.length).toBe(510);
    expect(() => checkKey("an instance id", exactEmoji, 255)).not.toThrow();

    // 256 emoji MUST THROW RangeError with preview ellipsis
    const tooManyEmoji = "🚀".repeat(256);
    expect(() => checkKey("an instance id", tooManyEmoji, 255)).toThrow(
      RangeError,
    );
    expect(() => checkKey("an instance id", tooManyEmoji, 255)).toThrow(
      /holds at most 255 characters on MySQL/,
    );
    expect(() => checkKey("an instance id", tooManyEmoji, 255)).toThrow(/…/);

    const { executor } = createMockMySqlExecutor();
    const store = new MySqlWorkflowStore({ executor });
    const kinds: WorkflowKeyKind[] = [
      "instanceId",
      "workflow",
      "concurrencyKey",
      "rateLimitKey",
      "journalName",
      "signal",
      "signalKey",
    ];
    for (const kind of kinds) {
      const limit = MYSQL_KEY_LIMITS[kind];
      expect(() => store.checkKey(kind, "a".repeat(limit))).not.toThrow();
      expect(() => store.checkKey(kind, "a".repeat(limit + 1))).toThrow(
        RangeError,
      );
    }
  });

  test("unstorableText refuses lone surrogates in json only (allows U+0000)", () => {
    const { executor } = createMockMySqlExecutor();
    const store = new MySqlWorkflowStore({ executor });

    expect(store.unstorableText("a\u0000b", "text")).toBeUndefined();
    expect(store.unstorableText("a\u0000b", "json")).toBeUndefined();
    expect(store.unstorableText("bad\uD800", "json")).toBe(
      "a lone UTF-16 surrogate",
    );
    expect(store.unstorableText("bad\uD800", "text")).toBeUndefined();
  });

  test("constructor registers on WorkflowStorage, readiness checks server/schema and creates signals lock row", async () => {
    const storage = new WorkflowStorage();
    const mock = createMockMySqlExecutor({ schemaVersion: 0 });
    const store = new MySqlWorkflowStore(
      { executor: mock.executor, migrate: false },
      storage,
    );
    expect(storage.source).toBe(store);
    await expect(store.onModuleInit()).rejects.toBeInstanceOf(
      WorkflowSchemaError,
    );

    const autoMock = createMockMySqlExecutor({ schemaVersion: 0 });
    const autoStore = new MySqlWorkflowStore({
      executor: autoMock.executor,
      migrate: true,
    });
    await autoStore.onModuleInit();
    expect(autoMock.knownLocks.size).toBe(1);
    expect(await autoStore.migrate()).toEqual([]);
  });

  test("create (with ER_DUP_ENTRY & key check), createInTransaction, get (sorts waits & journal), list, requestCancel, reopen, delete", async () => {
    let dupOnInsert = false;
    const mock = createMockMySqlExecutor({
      onExecute: (sql) => {
        if (
          sql.startsWith("INSERT INTO `nest_workflows_instances`") &&
          dupOnInsert
        ) {
          const err = new Error("Duplicate entry") as Error & {
            errno?: number;
            sqlState?: string;
          };
          err.errno = 1062;
          err.sqlState = "23000";
          throw err;
        }
        return { affectedRows: 1 };
      },
      onQuery: (sql) => {
        if (sql.includes("AS waits") && sql.includes("AS journal")) {
          return [
            sampleInstanceRow({
              cancel_requested: "0",
              terminate_requested: "0",
              waits: JSON.stringify([
                { position: 1, signal: "second", key: "k2" },
                { position: 0, signal: "first", key: "k1" },
              ]),
              journal: JSON.stringify([
                {
                  seq: 2,
                  entry: {
                    name: "b",
                    kind: "step",
                    status: "completed",
                    attempts: 1,
                  },
                },
                {
                  seq: 1,
                  entry: {
                    name: "a",
                    kind: "step",
                    status: "completed",
                    attempts: 1,
                  },
                },
              ]),
            }),
          ];
        }
        if (sql.includes("FROM `nest_workflows_instances` i WHERE i.id =")) {
          return [sampleInstanceRow()];
        }
        if (sql.includes("FROM `nest_workflows_instances` i")) {
          return [sampleInstanceRow()];
        }
        if (sql.includes("COALESCE(MAX(s.id), 0)")) {
          return [{ id: "5" }];
        }
        return [];
      },
    });
    const store = new MySqlWorkflowStore({ executor: mock.executor });

    // Oversized key rejected before SQL
    await expect(
      store.create(makeNewInstance({ id: "x".repeat(256) })),
    ).rejects.toThrow(RangeError);

    // Normal create
    const created = await store.create(makeNewInstance());
    expect(created.created).toBe(true);
    expect(created.instance.id).toBe("wf-1");

    // Duplicate key 1062 -> FOR SHARE read returns created: false
    dupOnInsert = true;
    const dup = await store.create(makeNewInstance());
    expect(dup.created).toBe(false);
    expect(
      mock.calls.some((c) => c.sql.includes("WHERE i.id = ? FOR SHARE")),
    ).toBe(true);

    // createInTransaction
    dupOnInsert = false;
    const inTx = await store.createInTransaction(
      mock.validNativeTx,
      makeNewInstance(),
    );
    expect(inTx.created).toBe(true);

    // get sorts waits by position and journal by seq
    const details = await store.get("wf-1", { journal: true });
    expect(details?.waits).toEqual([
      { signal: "first", key: "k1" },
      { signal: "second", key: "k2" },
    ]);
    expect(details?.journal?.map((e) => e.name)).toEqual(["a", "b"]);

    // list
    const listed = await store.list({
      status: ["pending"],
      workflow: "order",
      limit: 10,
      offset: 0,
    });
    expect(listed).toHaveLength(1);

    // requestCancel
    expect(
      await store.requestCancel("wf-1", {
        reason: "stop",
        now: 2000,
        terminate: false,
      }),
    ).toBe(true);

    // reopen
    expect(
      await store.reopen("wf-1", {
        expect: { status: "failed", runs: 1 },
        status: "pending",
        error: null,
        entries: [
          { name: "$retry:1", kind: "retry", status: "completed", attempts: 1 },
        ],
        now: 3000,
      }),
    ).toBe(true);
    expect(
      mock.calls.some((c) =>
        c.sql.includes("AS v ON DUPLICATE KEY UPDATE entry = v.entry"),
      ),
    ).toBe(true);

    // delete removes instance + journal + waits
    expect(await store.delete("wf-1", ["completed"])).toBe(true);
    expect(
      mock.calls.some((c) =>
        c.sql.startsWith("DELETE FROM `nest_workflows_journal`"),
      ),
    ).toBe(true);
    expect(
      mock.calls.some((c) =>
        c.sql.startsWith("DELETE FROM `nest_workflows_waits`"),
      ),
    ).toBe(true);
  });

  test("signal, signalInTransaction, signals, purge, schedules, claim, claimWithin, renew, write & deadlock retry", async () => {
    let dupSignal = false;
    let deadlockOnce = true;
    const mock = createMockMySqlExecutor({
      onExecute: (sql) => {
        if (
          sql.startsWith("INSERT INTO `nest_workflows_signals`") &&
          dupSignal
        ) {
          const err = new Error("Dup") as Error & {
            errno?: number;
            sqlState?: string;
          };
          err.errno = 1062;
          err.sqlState = "23000";
          throw err;
        }
        if (
          sql.startsWith(
            "UPDATE `nest_workflows_instances` FORCE INDEX (PRIMARY) SET wake_at",
          )
        ) {
          return { affectedRows: 2 };
        }
        if (sql.startsWith("DELETE FROM `nest_workflows_signals`")) {
          return { affectedRows: 4 };
        }
        if (sql.startsWith("DELETE FROM `nest_workflows_rate_limits`")) {
          return { affectedRows: 2 };
        }
        return { affectedRows: 1 };
      },
      onQuery: (sql) => {
        if (sql === "SELECT CAST(LAST_INSERT_ID() AS CHAR) AS id") {
          return [{ id: "15" }];
        }
        if (
          sql.includes(
            "FROM `nest_workflows_waits` wt FORCE INDEX (waits_signal)",
          )
        ) {
          return [{ id: "wf-1" }, { id: "wf-2" }];
        }
        if (
          sql.includes(
            "FROM `nest_workflows_signals` s WHERE s.name = ? AND s.dedupe_id",
          )
        ) {
          return [{ id: "9", key: "order-42" }];
        }
        if (
          sql.includes("FROM `nest_workflows_signals` s") &&
          sql.includes("s.id >")
        ) {
          return [
            {
              id: "15",
              name: "payment.received",
              key: "order-42",
              payload: '{"paid":true}',
              created_at: "1500",
            },
          ];
        }
        if (sql.includes("CAST(MAX(s.id) AS CHAR) AS newest")) {
          return [{ newest: "20", lowest: "10" }];
        }
        if (
          sql.includes(
            "SELECT CAST(s.id AS CHAR) AS id FROM `nest_workflows_signals`",
          )
        ) {
          return [{ id: "1" }, { id: "2" }];
        }
        if (
          sql.includes("FROM `nest_workflows_rate_limits` rl") &&
          sql.includes("window_end <")
        ) {
          return [{ workflow: "order", key: "" }];
        }
        if (
          sql.includes("FROM `nest_workflows_rate_limits` rl") &&
          sql.includes("window_end")
        ) {
          return [{ workflow: "order", key: "", window_end: "0", count: "0" }];
        }
        if (
          sql.includes("FROM `nest_workflows_schedules` s") &&
          sql.includes("CAST(s.id AS CHAR)")
        ) {
          return [{ id: "daily-report" }];
        }
        if (sql.includes("FROM `nest_workflows_schedules` s")) {
          return [sampleScheduleRow({ declared: "1", paused: "0" })];
        }
        if (sql.includes("WITH limits AS")) {
          return [{ id: "wf-1" }];
        }
        if (
          sql.includes("`rate_limit_key`") &&
          sql.includes("FOR UPDATE SKIP LOCKED")
        ) {
          return [{ id: "wf-1", workflow: "order", rate_limit_key: null }];
        }
        if (
          sql.includes(
            "SELECT CAST(i.id AS CHAR) AS id FROM `nest_workflows_instances`",
          )
        ) {
          return [{ id: "wf-1" }];
        }
        if (sql.includes("FROM `nest_workflows_instances` i WHERE")) {
          return [sampleInstanceRow({ status: "running", runs: "1" })];
        }
        if (sql.includes("COALESCE(MAX(s.id), 0)")) {
          return [{ id: "15" }];
        }
        if (
          sql.includes(
            "CAST(`cancel_requested` AS CHAR) AS `cancel_requested`, CAST(`terminate_requested`",
          )
        ) {
          return [{ cancel_requested: "0", terminate_requested: "1" }];
        }
        if (
          sql.includes(
            "CAST(`cancel_requested` AS CHAR) AS `cancel_requested`",
          ) &&
          sql.includes("FOR UPDATE")
        ) {
          if (deadlockOnce) {
            deadlockOnce = false;
            const err = new Error("Deadlock") as Error & {
              errno?: number;
              sqlState?: string;
            };
            err.errno = 1213;
            err.sqlState = "40001";
            throw err;
          }
          return [{ cancel_requested: "1" }];
        }
        return [];
      },
    });
    const store = new MySqlWorkflowStore({ executor: mock.executor });

    // signal (new + deduped + inTransaction)
    expect(await store.signal(makeSignal())).toEqual({
      id: 15,
      woken: 2,
      created: true,
      key: "order-42",
    });
    dupSignal = true;
    expect(await store.signal(makeSignal())).toEqual({
      id: 9,
      woken: 0,
      created: false,
      key: "order-42",
    });
    dupSignal = false;
    expect(
      (await store.signalInTransaction(mock.validNativeTx, makeSignal()))
        .created,
    ).toBe(true);

    // signals query
    const sigs = await store.signals({
      name: "payment.received",
      key: "order-42",
      afterId: 0,
      upToId: 20,
    });
    expect(sigs).toHaveLength(1);

    // purge
    expect(
      await store.purge({ statuses: ["completed"], before: 5000, limit: 10 }),
    ).toEqual({ instances: 1, signals: 4, rateLimits: 2 });

    // schedules (rejects scheduleId > 230)
    await expect(
      store.saveSchedule(makeScheduleSave({ id: "s".repeat(231) })),
    ).rejects.toThrow(RangeError);
    expect((await store.saveSchedule(makeScheduleSave()))?.id).toBe(
      "daily-report",
    );
    expect((await store.getSchedule("daily-report"))?.id).toBe("daily-report");
    expect((await store.listSchedules({ limit: 10, offset: 0 })).length).toBe(
      1,
    );
    expect(await store.deleteSchedule("daily-report", 1)).toBe(true);
    expect(
      (
        await store.claimSchedules({
          owner: "w1",
          token: "tok",
          now: 2500,
          leaseUntil: 9000,
          limit: 5,
          workflows: ["report"],
        })
      ).length,
    ).toBe(1);
    expect(
      await store.writeSchedule("daily-report", "tok", {
        now: 2600,
        state: {},
        wakeAt: null,
        release: true,
      }),
    ).toBe(true);

    // plain claim + claimWithin (limits & rateLimits)
    const plain = await store.claim({
      owner: "w1",
      token: "tok-1",
      now: 1000,
      leaseUntil: 9000,
      limit: 5,
      workflows: [{ name: "order", version: 1 }],
    });
    expect(plain.instances).toHaveLength(1);
    expect(plain.lastSignalId).toBe(15);

    const limited = await store.claim({
      owner: "w1",
      token: "tok-2",
      now: 1000,
      leaseUntil: 9000,
      limit: 5,
      workflows: [{ name: "order", version: 1 }],
      limits: [{ workflow: "order", limit: 3, perKey: null }],
      rateLimits: [
        { workflow: "order", limit: { max: 5, duration: 1000 }, perKey: null },
      ],
    });
    expect(limited.instances).toHaveLength(1);
    expect(mock.calls.some((c) => c.sql.includes("JSON_TABLE"))).toBe(true);

    // renew
    expect(await store.renew("wf-1", "tok-1", 12_000)).toEqual({
      cancelRequested: false,
      terminateRequested: true,
    });

    // write retries automatically on deadlock 1213 and sets wake_at = now because cancel_requested is 1
    expect(
      await store.write("wf-1", "tok-1", {
        now: 3000,
        entries: [
          { name: "step-1", kind: "step", status: "completed", attempts: 1 },
        ],
        status: "suspended",
        release: {
          wakeAt: 99_000,
          waits: [{ signal: "approved", key: null }],
          signalCursor: 15,
        },
      }),
    ).toBe(true);
    const finalUpdate = mock.calls
      .filter(
        (c) =>
          c.kind === "execute" &&
          c.sql.startsWith("UPDATE `nest_workflows_instances` SET status ="),
      )
      .at(-1);
    expect(finalUpdate?.params).toContain("3000");
  });
});

// ---------------------------------------------------------------------------
// 4. Re-exported Executor Adapters & CLI
// ---------------------------------------------------------------------------

describe("Re-exported adapters & CLI", () => {
  test("Postgres and MySQL adapter factories return typed SqlExecutors", () => {
    const pgPool = {
      query: async () => ({ rows: [] }),
      connect: async () => ({
        query: async () => ({ rows: [] }),
        release: () => undefined,
      }),
    };
    expect(fromPg(pgPool).dialect).toBe("postgres");
    expect(typeof fromPgDrizzle).toBe("function");
    expect(typeof fromPgKysely).toBe("function");
    expect(typeof fromPgPrisma).toBe("function");
    expect(typeof fromPgTypeOrm).toBe("function");

    const mysqlPool = {
      execute: async () => [[], []] as [unknown[], unknown],
      query: async () => [[], []] as [unknown[], unknown],
      escapeId: (id: string) => `\`${id}\``,
      format: (sql: string) => sql,
      getConnection: async () => ({
        execute: async () => [[], []] as [unknown[], unknown],
        query: async () => [[], []] as [unknown[], unknown],
        escapeId: (id: string) => `\`${id}\``,
        format: (sql: string) => sql,
        release: () => undefined,
        destroy: () => undefined,
      }),
    };
    expect(fromMysql2(mysqlPool).dialect).toBe("mysql");
    expect(typeof fromMySqlDrizzle).toBe("function");
    expect(typeof fromMySqlKysely).toBe("function");
    expect(typeof fromMySqlPrisma).toBe("function");
    expect(typeof fromMySqlTypeOrm).toBe("function");
  });

  test("src/cli.ts starts with #!/usr/bin/env bun and runStoreCli prints Postgres/MySQL SQL and help", async () => {
    const cliPath = resolve(import.meta.dir, "../src/cli.ts");
    const firstLine = (await Bun.file(cliPath).text()).split(/\r?\n/)[0];
    expect(firstLine).toBe("#!/usr/bin/env bun");

    const capture = async (argv: string[]) => {
      let out = "";
      let err = "";
      const io: StoreCliIo = {
        out: (t) => {
          out += t;
        },
        err: (t) => {
          err += t;
        },
        env: {},
      };
      const code = await runStoreCli(
        [workflowStoreSchema, mysqlWorkflowStoreSchema],
        argv,
        io,
      );
      return { code, out, err };
    };

    const help = await capture(["--help"]);
    expect(help.code).toBe(0);
    expect(help.out).toContain("@bunest/workflows");
    expect(help.out).toContain("PostgresWorkflowStore");
    expect(help.out).toContain("MySqlWorkflowStore");

    const pgSql = await capture(["sql"]);
    expect(pgSql.code).toBe(0);
    expect(pgSql.out).toContain('CREATE TABLE "nest_workflows".instances');

    const mySql = await capture([
      "sql",
      "--dialect",
      "mysql",
      "--schema",
      "my_wf",
      "--statement-breakpoints",
    ]);
    expect(mySql.code).toBe(0);
    expect(mySql.out).toContain("CREATE TABLE `my_wf_instances`");
    expect(mySql.out).toContain("--> statement-breakpoint");

    const unknown = await capture(["bogus"]);
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain('Unknown command "bogus"');
  });
});
