import { describe, expect, it } from "bun:test";
import { Injectable, diagnosticsChannel } from "@bunest/core";
import { Test } from "@bunest/testing";
import type { SQL, TransactionSQL } from "bun";
import {
  BunSqlOrmDriver,
  Column,
  DataSource,
  Entity,
  InjectDataSource,
  InjectRepository,
  InvalidTenantIdentifierError,
  ORM_QUERY_CHANNEL,
  ORM_TRANSACTION_CHANNEL,
  OrmError,
  OrmModule,
  OrmRepository,
  PrimaryGeneratedColumn,
  TransactionPropagationError,
  Transactional,
  hasOrmQuerySubscribers,
  hasOrmTransactionSubscribers,
  onTransactionCommit,
  onTransactionRollback,
  runInTenantTransaction,
  type OrmQueryDiagnosticEvent,
  type OrmTransactionDiagnosticEvent,
} from "../src/index";

@Entity("tx_ledger")
class TxLedger {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  label!: string;

  @Column("integer")
  amount!: number;
}

interface MockPgRecorder {
  readonly statements: Array<{ sql: string; params: unknown[]; txId: number }>;
  readonly committedTxIds: number[];
  readonly rolledBackTxIds: number[];
  readonly savepoints: number[];
  readonly client: SQL;
}

function createMockBunSqlClient(opts?: {
  dialect?: "postgres" | "mysql";
  failOnSql?: (sql: string, attempt: number) => Error | undefined;
}): MockPgRecorder {
  const statements: Array<{ sql: string; params: unknown[]; txId: number }> = [];
  const committedTxIds: number[] = [];
  const rolledBackTxIds: number[] = [];
  const savepoints: number[] = [];
  let txSeq = 0;
  let spSeq = 0;
  let attemptCount = 0;

  const makeTx = (txId: number): TransactionSQL => {
    const tx = {
      unsafe: async (sql: string, params: unknown[] = []) => {
        statements.push({ sql, params: [...params], txId });
        const err = opts?.failOnSql?.(sql, attemptCount);
        if (err) throw err;
        return Object.assign([], { affectedRows: 1, count: 1 });
      },
      savepoint: async <T>(fn: (sp: TransactionSQL) => Promise<T>) => {
        const spId = ++spSeq;
        savepoints.push(spId);
        return await fn(makeTx(txId));
      },
    };
    return tx as unknown as TransactionSQL;
  };

  const client = {
    options: { adapter: opts?.dialect ?? "postgres" },
    connect: async () => {},
    close: async () => {},
    unsafe: async (sql: string, params: unknown[] = []) => {
      statements.push({ sql, params: [...params], txId: 0 });
      return Object.assign([], { affectedRows: 1, count: 1 });
    },
    begin: async <T>(
      modeOrFn: string | ((tx: TransactionSQL) => Promise<T>),
      maybeFn?: (tx: TransactionSQL) => Promise<T>,
    ) => {
      const fn = typeof modeOrFn === "function" ? modeOrFn : maybeFn!;
      const txId = ++txSeq;
      attemptCount += 1;
      const tx = makeTx(txId);
      try {
        const res = await fn(tx);
        committedTxIds.push(txId);
        return res;
      } catch (err) {
        rolledBackTxIds.push(txId);
        throw err;
      }
    },
    reserve: async () => {
      const reservedTxId = ++txSeq;
      return {
        unsafe: async (sql: string, params: unknown[] = []) => {
          statements.push({ sql, params: [...params], txId: reservedTxId });
          return Object.assign([], { affectedRows: 0, count: 0 });
        },
        begin: async <T>(fn: (tx: TransactionSQL) => Promise<T>) => {
          attemptCount += 1;
          const tx = makeTx(reservedTxId);
          try {
            const res = await fn(tx);
            committedTxIds.push(reservedTxId);
            return res;
          } catch (err) {
            rolledBackTxIds.push(reservedTxId);
            throw err;
          }
        },
        release: async () => {},
      };
    },
  } as unknown as SQL;

  return { statements, committedTxIds, rolledBackTxIds, savepoints, client };
}

describe("@bunest/orm — Production @Transactional Options & Lifecycle Hooks", () => {
  it("supports SQLite isolationLevel, readOnly enforcement, propagation modes, and retries", async () => {
    const ds = new DataSource({
      name: "tx_sqlite",
      type: "sqlite",
      database: ":memory:",
      entities: [TxLedger],
      synchronize: true,
    });
    await ds.initialize();
    try {
      const repo = ds.getRepository(TxLedger);
      await repo.save({ label: "seed", amount: 10 });

      // 1. readOnly: true blocks SQLite writes cleanly and restores write mode afterward
      await expect(
        ds.transaction(
          async (em) => {
            await em.save(TxLedger, { label: "should-fail", amount: 1 });
          },
          { readOnly: true },
        ),
      ).rejects.toThrow(/readonly/i);

      // Writes work normally right after readOnly tx finishes
      const afterReadOnly = await repo.save({ label: "after-ro", amount: 20 });
      expect(afterReadOnly.id).toBeGreaterThan(0);

      // 2. isolationLevel: SERIALIZABLE / READ UNCOMMITTED execute cleanly on SQLite
      await ds.transaction(
        async (em) => {
          await em.save(TxLedger, { label: "serializable", amount: 30 });
        },
        { isolationLevel: "SERIALIZABLE" },
      );
      const countInReadUncommitted = await ds.transaction(
        async (em) => em.count(TxLedger),
        { isolationLevel: "READ UNCOMMITTED", readOnly: true },
      );
      expect(countInReadUncommitted).toBe(3);

      // Invalid isolation level throws immediately
      await expect(
        ds.transaction(async () => {}, {
          isolationLevel: "SERIALIZABLE; DROP TABLE tx_ledger" as never,
        }),
      ).rejects.toThrow(OrmError);

      // 3. Propagation: MANDATORY throws outside tx, succeeds inside tx
      await expect(
        ds.transaction(async () => "nope", { propagation: "MANDATORY" }),
      ).rejects.toThrow(TransactionPropagationError);

      const mandatoryResult = await ds.transaction(async (em) => {
        return await em.transaction(
          async (innerEm) => {
            await innerEm.save(TxLedger, { label: "mandatory-ok", amount: 40 });
            return "ok";
          },
          { propagation: "MANDATORY" },
        );
      });
      expect(mandatoryResult).toBe("ok");

      // 4. Propagation: NEVER succeeds outside tx, throws inside tx
      const neverOutside = await ds.transaction(
        async (em) => {
          expect(ds.driver.isInTransaction()).toBe(false);
          return await em.count(TxLedger);
        },
        { propagation: "NEVER" },
      );
      expect(neverOutside).toBe(4);

      await expect(
        ds.transaction(async (em) => {
          await em.transaction(async () => "nope", { propagation: "NEVER" });
        }),
      ).rejects.toThrow(TransactionPropagationError);

      // 5. Propagation: REQUIRED nested savepoint rollback isolates inner failure
      await ds.transaction(async (em) => {
        await em.save(TxLedger, { label: "outer-kept", amount: 50 });
        try {
          await em.transaction(
            async (inner) => {
              await inner.save(TxLedger, { label: "inner-rolled-back", amount: 99 });
              throw new Error("inner-boom");
            },
            { propagation: "REQUIRED" },
          );
        } catch (err) {
          expect((err as Error).message).toBe("inner-boom");
        }
      });
      expect(await repo.findOneBy({ label: "outer-kept" })).not.toBeNull();
      expect(await repo.findOneBy({ label: "inner-rolled-back" })).toBeNull();

      // 6. Retries with jittered backoff on transient SQLITE_BUSY / PG 40001 errors
      let attempts = 0;
      const hookCalls: string[] = [];
      const retryResult = await ds.transaction(
        async (em) => {
          attempts += 1;
          onTransactionCommit(() => {
            hookCalls.push(`commit-attempt-${attempts}`);
          });
          onTransactionRollback(() => {
            hookCalls.push(`rollback-attempt-${attempts}`);
          });
          await em.save(TxLedger, { label: `retry-${attempts}`, amount: attempts });
          if (attempts < 3) {
            const busyErr = Object.assign(new Error("SQLITE_BUSY: database is locked"), {
              code: "SQLITE_BUSY",
            });
            throw busyErr;
          }
          return attempts;
        },
        { retries: 3, retryDelayMs: 2 },
      );
      expect(retryResult).toBe(3);
      expect(attempts).toBe(3);
      // Only the winning attempt's commit hook fires (never duplicated or rolled back!)
      expect(hookCalls).toEqual(["commit-attempt-3"]);
      expect(await repo.findOneBy({ label: "retry-1" })).toBeNull();
      expect(await repo.findOneBy({ label: "retry-3" })).not.toBeNull();

      // Non-retryable error fails immediately without retrying & fires rollback hook
      let nonRetryAttempts = 0;
      const terminalHooks: string[] = [];
      await expect(
        ds.transaction(
          async () => {
            nonRetryAttempts += 1;
            onTransactionRollback(() => {
              terminalHooks.push("rolled-back");
            });
            throw new Error("domain-validation-error");
          },
          { retries: 3, retryDelayMs: 2 },
        ),
      ).rejects.toThrow("domain-validation-error");
      expect(nonRetryAttempts).toBe(1);
      expect(terminalHooks).toEqual(["rolled-back"]);
    } finally {
      await ds.destroy();
    }
  });

  it("fires onTransactionCommit / onTransactionRollback strictly after outermost commit/rollback and isolates REQUIRES_NEW", async () => {
    const ds = new DataSource({
      type: "sqlite",
      database: ":memory:",
      entities: [TxLedger],
      synchronize: true,
    });
    await ds.initialize();
    try {
      const repo = ds.getRepository(TxLedger);

      // Calling hooks outside a transaction throws OrmError
      expect(() => onTransactionCommit(() => {})).toThrow(OrmError);
      expect(() => onTransactionRollback(() => {})).toThrow(OrmError);

      // Nested savepoint commit hooks wait until OUTERMOST commit, and execute OUTSIDE the tx
      const events: string[] = [];
      await ds.transaction(async (em) => {
        onTransactionCommit(async () => {
          // Safely isolated from DB tx state: not in tx, row already committed, can open new tx!
          expect(ds.driver.isInTransaction()).toBe(false);
          const found = await repo.findOneBy({ label: "outer-tx" });
          expect(found).not.toBeNull();
          await ds.transaction(async (postEm) => {
            await postEm.save(TxLedger, { label: "from-commit-hook", amount: 1 });
          });
          events.push("outer-commit");
        });
        await em.save(TxLedger, { label: "outer-tx", amount: 10 });

        await em.transaction(async (inner) => {
          onTransactionCommit(() => {
            events.push("inner-commit");
          });
          await inner.save(TxLedger, { label: "inner-tx", amount: 20 });
        });

        // Inner savepoint released, but commit hooks MUST NOT have fired yet!
        expect(events).toEqual([]);

        // Rolled-back savepoint discards its commit hook and fires its rollback hook
        try {
          await em.transaction(async () => {
            onTransactionCommit(() => {
              events.push("rolled-back-inner-commit-SHOULD-NOT-FIRE");
            });
            onTransactionRollback(() => {
              events.push("rolled-back-inner-rollback");
            });
            throw new Error("abort-inner");
          });
        } catch {
          // caught
        }

        // REQUIRES_NEW runs with independent hook scope (fires immediately on inner commit)
        await em.transaction(
          async () => {
            onTransactionCommit(() => {
              events.push("requires-new-immediate-commit");
            });
          },
          { propagation: "REQUIRES_NEW" },
        );
        expect(events).toEqual([
          "rolled-back-inner-rollback",
          "requires-new-immediate-commit",
        ]);
      });

      expect(events).toEqual([
        "rolled-back-inner-rollback",
        "requires-new-immediate-commit",
        "outer-commit",
        "inner-commit",
      ]);
      expect(await repo.findOneBy({ label: "from-commit-hook" })).not.toBeNull();

      // When outermost transaction rolls back, merged inner + outer rollback hooks fire and ZERO commit hooks fire
      const rollbackEvents: string[] = [];
      await expect(
        ds.transaction(async (em) => {
          onTransactionCommit(() => {
            rollbackEvents.push("outer-commit-NO");
          });
          onTransactionRollback(() => {
            expect(ds.driver.isInTransaction()).toBe(false);
            rollbackEvents.push("outer-rollback");
          });

          await em.transaction(async () => {
            onTransactionCommit(() => {
              rollbackEvents.push("inner-commit-NO");
            });
            onTransactionRollback(() => {
              rollbackEvents.push("inner-rollback");
            });
          });

          throw new Error("outer-boom");
        }),
      ).rejects.toThrow("outer-boom");

      expect(rollbackEvents).toEqual(["outer-rollback", "inner-rollback"]);
    } finally {
      await ds.destroy();
    }
  });

  it("emits dialect-accurate PostgreSQL & MySQL isolation/readOnly SQL and true pooled REQUIRES_NEW via BunSqlOrmDriver", async () => {
    const pgMock = createMockBunSqlClient({ dialect: "postgres" });
    const pgDriver = new BunSqlOrmDriver({
      dialect: "postgres",
      client: pgMock.client,
      dataSourceName: "pg_main",
    });
    const pgDs = new DataSource({
      name: "pg_main",
      driver: pgDriver,
    });
    await pgDs.initialize();

    const hooksOrder: string[] = [];
    await expect(
      pgDs.transaction(
        async (em) => {
          await em.query("INSERT INTO audit VALUES ($1)", ["outer"]);
          onTransactionRollback(() => {
            hooksOrder.push("outer-rollback");
          });

          // REQUIRES_NEW opens an independent connection (txId = 2) and commits even though outer (txId = 1) fails!
          await em.transaction(
            async (innerEm) => {
              onTransactionCommit(async () => {
                // Must NOT leak suspended outer tx into REQUIRES_NEW commit hook!
                expect(pgDs.driver.isInTransaction()).toBe(false);
                await pgDs.query("INSERT INTO post_commit_outbox VALUES ($1)", ["after-requires-new"]);
                hooksOrder.push("requires-new-commit");
              });
              await innerEm.query("INSERT INTO audit VALUES ($1)", ["inner-new"]);
            },
            {
              propagation: "REQUIRES_NEW",
              isolationLevel: "REPEATABLE READ",
              readOnly: true,
            },
          );

          throw new Error("outer-pg-abort");
        },
        { isolationLevel: "SERIALIZABLE" },
      ),
    ).rejects.toThrow("outer-pg-abort");

    expect(pgMock.statements[0]).toEqual({
      sql: "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE",
      params: [],
      txId: 1,
    });
    expect(pgMock.statements[1]).toEqual({
      sql: "INSERT INTO audit VALUES ($1)",
      params: ["outer"],
      txId: 1,
    });
    expect(pgMock.statements[2]).toEqual({
      sql: "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY",
      params: [],
      txId: 2,
    });
    expect(pgMock.statements[3]).toEqual({
      sql: "INSERT INTO audit VALUES ($1)",
      params: ["inner-new"],
      txId: 2,
    });
    // Query executed inside REQUIRES_NEW commit hook ran on root pool (txId = 0), NOT outer txId = 1!
    expect(pgMock.statements[4]).toEqual({
      sql: "INSERT INTO post_commit_outbox VALUES ($1)",
      params: ["after-requires-new"],
      txId: 0,
    });
    expect(pgMock.committedTxIds).toEqual([2]);
    expect(pgMock.rolledBackTxIds).toEqual([1]);
    expect(hooksOrder).toEqual(["requires-new-commit", "outer-rollback"]);

    // BunSqlOrmDriver SQLite nested readOnly:true must NOT leak PRAGMA query_only = OFF to outer readOnly:true tx!
    const bunSqlSqliteDs = new DataSource({
      type: "sqlite",
      database: ":memory:",
      useBunSql: true,
      entities: [TxLedger],
      synchronize: true,
    });
    await bunSqlSqliteDs.initialize();
    try {
      await bunSqlSqliteDs.transaction(
        async (outerEm) => {
          await outerEm.transaction(
            async (innerEm) => {
              expect(await innerEm.count(TxLedger)).toBe(0);
            },
            { readOnly: true },
          );
          // Outer transaction MUST STILL enforce readOnly: true after inner readOnly savepoint exits!
          await expect(
            outerEm.save(TxLedger, { label: "must-stay-readonly", amount: 1 }),
          ).rejects.toThrow(/readonly/i);
        },
        { readOnly: true },
      );
      // After outer readOnly tx finishes, normal writes succeed again
      const savedAfter = await bunSqlSqliteDs
        .getRepository(TxLedger)
        .save({ label: "write-restored", amount: 5 });
      expect(savedAfter.id).toBeGreaterThan(0);
    } finally {
      await bunSqlSqliteDs.destroy();
    }

    // MySQL executes SET TRANSACTION on reserved connection BEFORE begin()
    const mysqlMock = createMockBunSqlClient({ dialect: "mysql" });
    const mysqlDriver = new BunSqlOrmDriver({
      dialect: "mysql",
      client: mysqlMock.client,
    });
    await mysqlDriver.connect();
    await mysqlDriver.transaction(
      async (exec) => {
        await exec.query("SELECT 1");
      },
      { isolationLevel: "READ COMMITTED", readOnly: true },
    );
    expect(mysqlMock.statements.map((s) => s.sql)).toEqual([
      "SET TRANSACTION ISOLATION LEVEL READ COMMITTED, READ ONLY",
      "SELECT 1",
    ]);

    // PostgreSQL serialization failure (SQLSTATE 40001) triggers automatic retry
    let failOnce = true;
    const retryMock = createMockBunSqlClient({
      dialect: "postgres",
      failOnSql: (sql) => {
        if (sql.startsWith("UPDATE") && failOnce) {
          failOnce = false;
          return Object.assign(new Error("could not serialize access due to concurrent update"), {
            errno: "40001",
          });
        }
        return undefined;
      },
    });
    const retryDriver = new BunSqlOrmDriver({
      dialect: "postgres",
      client: retryMock.client,
    });
    await retryDriver.connect();
    await retryDriver.transaction(
      async (exec) => {
        await exec.query("UPDATE accounts SET balance = balance - 10");
      },
      { isolationLevel: "SERIALIZABLE", retries: 2, retryDelayMs: 2 },
    );
    expect(retryMock.rolledBackTxIds).toEqual([1]);
    expect(retryMock.committedTxIds).toEqual([2]);
  });

  it("weaves @Transactional({ isolationLevel, propagation, readOnly, retries }) through Bunest DI AOP", async () => {
    const events: string[] = [];

    @Injectable()
    class LedgerService {
      public transientFailures = 2;

      constructor(
        @InjectRepository(TxLedger)
        public readonly repo: OrmRepository<TxLedger>,
        @InjectDataSource()
        public readonly ds: DataSource,
      ) {}

      @Transactional({ isolationLevel: "SERIALIZABLE", retries: 3, retryDelayMs: 2 })
      async recordWithRetry(label: string, amount: number): Promise<TxLedger> {
        onTransactionCommit(() => {
          events.push(`committed:${label}`);
        });
        const saved = await this.repo.save({ label, amount });
        if (this.transientFailures > 0) {
          this.transientFailures -= 1;
          throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
        }
        return saved;
      }

      @Transactional({ propagation: "MANDATORY" })
      async mustRunInsideTx(): Promise<boolean> {
        return this.ds.driver.isInTransaction();
      }

      @Transactional({ propagation: "NEVER" })
      async mustRunOutsideTx(): Promise<boolean> {
        return !this.ds.driver.isInTransaction();
      }

      @Transactional({ readOnly: true })
      async readOnlyWriteAttempt(): Promise<void> {
        await this.repo.save({ label: "blocked", amount: 0 });
      }
    }

    const mod = await Test.createTestingModule({
      imports: [
        OrmModule.forRoot({
          type: "sqlite",
          database: ":memory:",
          synchronize: true,
        }),
        OrmModule.forFeature([TxLedger]),
      ],
      providers: [LedgerService],
    }).compile();

    await mod.init();
    try {
      const svc = mod.get(LedgerService);

      const row = await svc.recordWithRetry("invoice-1", 250);
      expect(row.label).toBe("invoice-1");
      expect(events).toEqual(["committed:invoice-1"]);
      expect(await svc.repo.count()).toBe(1);

      await expect(svc.mustRunInsideTx()).rejects.toThrow(
        TransactionPropagationError,
      );
      expect(await svc.ds.transaction(() => svc.mustRunInsideTx())).toBe(true);

      expect(await svc.mustRunOutsideTx()).toBe(true);
      await expect(
        svc.ds.transaction(() => svc.mustRunOutsideTx()),
      ).rejects.toThrow(TransactionPropagationError);

      await expect(svc.readOnlyWriteAttempt()).rejects.toThrow(/readonly/i);
    } finally {
      await mod.close();
    }
  });
});

describe("@bunest/orm — PostgreSQL RLS & Schema-per-Tenant Multi-Tenancy", () => {
  it("executes parameterized set_config($1, $2, true) in RLS mode and rejects unsafe settingName", async () => {
    const pgMock = createMockBunSqlClient({ dialect: "postgres" });
    const ds = new DataSource({
      name: "pg_rls",
      driver: new BunSqlOrmDriver({
        dialect: "postgres",
        client: pgMock.client,
        dataSourceName: "pg_rls",
      }),
    });
    await ds.initialize();

    const tenantUuid = "550e8400-e29b-41d4-a716-446655440000";
    const res = await runInTenantTransaction(
      ds,
      tenantUuid,
      async (em) => {
        await em.query("SELECT * FROM invoices");
        return "rls-ok";
      },
      { mode: "rls", isolationLevel: "REPEATABLE READ" },
    );

    expect(res).toBe("rls-ok");
    expect(pgMock.statements).toEqual([
      {
        sql: "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ",
        params: [],
        txId: 1,
      },
      {
        sql: "SELECT set_config($1, $2, true)",
        params: ["app.current_tenant_id", tenantUuid],
        txId: 1,
      },
      {
        sql: "SELECT * FROM invoices",
        params: [],
        txId: 1,
      },
    ]);
    expect(pgMock.committedTxIds).toEqual([1]);

    // Custom valid settingName works
    await runInTenantTransaction(ds, "org_42", async () => {}, {
      mode: "rls",
      settingName: "tenant.org_id",
    });
    expect(pgMock.statements[3]).toEqual({
      sql: "SELECT set_config($1, $2, true)",
      params: ["tenant.org_id", "org_42"],
      txId: 2,
    });

    // Rejects SQL injection in settingName and empty tenantId
    await expect(
      runInTenantTransaction(ds, "acme", async () => {}, {
        mode: "rls",
        settingName: "app.tenant; DROP TABLE users--",
      }),
    ).rejects.toThrow(InvalidTenantIdentifierError);

    await expect(
      runInTenantTransaction(ds, "   ", async () => {}, { mode: "rls" }),
    ).rejects.toThrow(InvalidTenantIdentifierError);
  });

  it("executes validated SET LOCAL search_path in schema mode and blocks all SQL injection payloads", async () => {
    const pgMock = createMockBunSqlClient({ dialect: "postgres" });
    const ds = new DataSource({
      name: "pg_schema",
      driver: new BunSqlOrmDriver({
        dialect: "postgres",
        client: pgMock.client,
      }),
    });
    await ds.initialize();

    await runInTenantTransaction(
      ds,
      "acme_corp",
      async (em) => {
        await em.query("SELECT * FROM orders");
      },
      { mode: "schema", schemaPrefix: "tenant_" },
    );

    expect(pgMock.statements).toEqual([
      {
        sql: 'SET LOCAL search_path TO "tenant_acme_corp"',
        params: [],
        txId: 1,
      },
      {
        sql: "SELECT * FROM orders",
        params: [],
        txId: 1,
      },
    ]);

    // Optional fallbackSchema appends validated quoted schema
    await runInTenantTransaction(ds, "beta", async () => {}, {
      mode: "schema",
      schemaPrefix: "t_",
      fallbackSchema: "public",
    });
    expect(pgMock.statements[2]?.sql).toBe(
      'SET LOCAL search_path TO "t_beta", "public"',
    );

    // Numeric suffix allowed ONLY with valid schemaPrefix
    await runInTenantTransaction(ds, "42", async () => {}, {
      mode: "schema",
      schemaPrefix: "tenant_",
    });
    expect(pgMock.statements[3]?.sql).toBe(
      'SET LOCAL search_path TO "tenant_42"',
    );

    // Strictly rejects SQL injection attempts
    const badPayloads = [
      'acme"; DROP TABLE users; --',
      "acme; SET ROLE postgres",
      "acme, public",
      "tenant-with-dash",
      "123_starts_with_digit",
      "space in name",
      "a".repeat(64),
    ];
    for (const payload of badPayloads) {
      await expect(
        runInTenantTransaction(ds, payload, async () => {}, { mode: "schema" }),
      ).rejects.toThrow(InvalidTenantIdentifierError);
    }

    await expect(
      runInTenantTransaction(ds, "acme", async () => {}, {
        mode: "schema",
        schemaPrefix: "bad;prefix",
      }),
    ).rejects.toThrow(InvalidTenantIdentifierError);

    await expect(
      runInTenantTransaction(ds, "acme", async () => {}, {
        mode: "schema",
        fallbackSchema: "public; DROP SCHEMA public",
      }),
    ).rejects.toThrow(InvalidTenantIdentifierError);

    // Rejects propagation: "NEVER" and non-Postgres dialects
    await expect(
      runInTenantTransaction(ds, "acme", async () => {}, {
        mode: "rls",
        propagation: "NEVER",
      }),
    ).rejects.toThrow(OrmError);

    const sqliteDs = new DataSource({ type: "sqlite", database: ":memory:" });
    await sqliteDs.initialize();
    try {
      await expect(
        runInTenantTransaction(sqliteDs, "acme", async () => {}, {
          mode: "rls",
        }),
      ).rejects.toThrow(OrmError);
    } finally {
      await sqliteDs.destroy();
    }
  });
});

describe("@bunest/orm — Zero-Overhead diagnosticsChannel Emission", () => {
  it("guards query & transaction emission with hasSubscribers and publishes rich telemetry when subscribed", async () => {
    const queryCh = diagnosticsChannel(ORM_QUERY_CHANNEL);
    const txCh = diagnosticsChannel(ORM_TRANSACTION_CHANNEL);

    expect(hasOrmQuerySubscribers()).toBe(false);
    expect(hasOrmTransactionSubscribers()).toBe(false);

    const queryEvents: OrmQueryDiagnosticEvent[] = [];
    const txEvents: OrmTransactionDiagnosticEvent[] = [];

    const onQuery = (msg: unknown) => {
      queryEvents.push(msg as OrmQueryDiagnosticEvent);
    };
    const onTx = (msg: unknown) => {
      txEvents.push(msg as OrmTransactionDiagnosticEvent);
    };

    const ds = new DataSource({
      name: "telemetry_ds",
      type: "sqlite",
      database: ":memory:",
      entities: [TxLedger],
      synchronize: true,
    });
    await ds.initialize();

    try {
      // Unsubscribed: zero events captured
      await ds.getRepository(TxLedger).save({ label: "silent", amount: 1 });
      expect(queryEvents.length).toBe(0);
      expect(txEvents.length).toBe(0);

      // Subscribe and verify query + transaction events
      queryCh.subscribe(onQuery);
      txCh.subscribe(onTx);
      expect(hasOrmQuerySubscribers()).toBe(true);
      expect(hasOrmTransactionSubscribers()).toBe(true);

      await ds.transaction(
        async (em) => {
          await em.save(TxLedger, { label: "tracked", amount: 42 });
          const all = await em.find(TxLedger);
          expect(all.length).toBe(2);
        },
        { isolationLevel: "SERIALIZABLE" },
      );

      expect(queryEvents.length).toBeGreaterThanOrEqual(2);
      const selectEvent = queryEvents.find((e) => e.sql.startsWith("SELECT"));
      expect(selectEvent).toBeDefined();
      expect(selectEvent?.dialect).toBe("sqlite");
      expect(selectEvent?.dataSource).toBe("telemetry_ds");
      expect(selectEvent?.rowCount).toBe(2);
      expect(typeof selectEvent?.durationMs).toBe("number");

      expect(txEvents.map((e) => e.phase)).toEqual(["begin", "commit"]);
      expect(txEvents[0]?.isolationLevel).toBe("SERIALIZABLE");
      expect(txEvents[0]?.propagation).toBe("REQUIRED");
      expect(txEvents[0]?.dataSource).toBe("telemetry_ds");
      expect(typeof txEvents[1]?.durationMs).toBe("number");

      // Rollback + failed query emit error fields
      txEvents.length = 0;
      queryEvents.length = 0;
      await expect(
        ds.transaction(async (em) => {
          await em.query("SELECT * FROM nonexistent_table_xyz");
        }),
      ).rejects.toThrow();

      expect(queryEvents.length).toBe(1);
      expect(queryEvents[0]?.error).toBeInstanceOf(Error);
      expect(txEvents.map((e) => e.phase)).toEqual(["begin", "rollback"]);
      expect(txEvents[1]?.error).toBeInstanceOf(Error);
    } finally {
      queryCh.unsubscribe(onQuery);
      txCh.unsubscribe(onTx);
      await ds.destroy();
    }

    expect(hasOrmQuerySubscribers()).toBe(false);
    expect(hasOrmTransactionSubscribers()).toBe(false);
  });
});
