import "reflect-metadata";
import { afterEach, describe, expect, it } from "bun:test";
import { Injectable } from "../../../../../packages/common/src";
import { SqlModule, SqlService } from "../../../../../packages/sql/src";
import {
  BaseSqliteRepository,
  InjectSqliteRepository,
  SqliteEntity,
  SqliteModule,
  SqliteService,
} from "../../../../../packages/sqlite/src";
import { Test, describeConformance } from "../../../_helpers/index";

interface AccountRow extends Record<string, unknown> {
  id: number;
  owner: string;
  balance: number;
}

@SqliteEntity("accounts")
class Account {}

describeConformance(
  "Persistence (bun-native) - transactions, nested SAVEPOINTs & ALS propagation",
  {
    upstreamPath: "bun-native/transactions-savepoints-als",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-002"],
    notes:
      "Verifies top-level commit/rollback, multi-level nested SAVEPOINTs, AsyncLocalStorage propagation across injected services/repositories, and transactionSync() modes & guards.",
  },
  () => {
    const openSqlite: SqliteService[] = [];
    const openSql: SqlService[] = [];

    const createSqlite = (): SqliteService => {
      const db = new SqliteService({ filename: ":memory:" });
      openSqlite.push(db);
      db.exec(
        "CREATE TABLE ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, entry TEXT NOT NULL)",
      );
      return db;
    };

    const createSql = async (): Promise<SqlService> => {
      const svc = new SqlService("sqlite://:memory:");
      openSql.push(svc);
      await svc.sql`CREATE TABLE ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, entry TEXT NOT NULL)`;
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

    describe("SqliteService transactions & SAVEPOINTs", () => {
      it("commits top-level async transaction() and exposes metadata", async () => {
        const db = createSqlite();
        expect(db.isInTransaction()).toBe(false);
        expect(db.getCurrentTransaction()).toBeUndefined();

        const txId = await db.transaction(async (tx) => {
          expect(tx.depth).toBe(0);
          expect(tx.isNested).toBe(false);
          expect(tx.savepointName).toBeUndefined();
          expect(tx.connectionName).toBe("default");
          expect(tx.database).toBe(db.raw);
          expect(db.isInTransaction()).toBe(true);
          expect(db.inDatabaseTransaction).toBe(true);
          expect(db.getCurrentTransaction()).toBe(tx);

          db.run("INSERT INTO ledger (entry) VALUES (?)", ["committed"]);
          await Bun.sleep(2);
          expect(db.getCurrentTransaction()).toBe(tx);
          return tx.id;
        });

        expect(txId).toMatch(/^tx_\d+$/);
        expect(db.isInTransaction()).toBe(false);
        expect(db.inDatabaseTransaction).toBe(false);
        expect(db.getCurrentTransaction()).toBeUndefined();
        expect(
          db.query<{ entry: string }>("SELECT entry FROM ledger"),
        ).toEqual([{ entry: "committed" }]);
      });

      it("rolls back top-level async transaction() automatically when callback throws", async () => {
        const db = createSqlite();
        db.run("INSERT INTO ledger (entry) VALUES (?)", ["baseline"]);

        await expect(
          db.transaction(async () => {
            db.run("INSERT INTO ledger (entry) VALUES (?)", ["uncommitted"]);
            await Bun.sleep(2);
            throw new Error("tx-abort");
          }),
        ).rejects.toThrow("tx-abort");

        expect(db.isInTransaction()).toBe(false);
        expect(db.inDatabaseTransaction).toBe(false);
        expect(
          db.query<{ entry: string }>("SELECT entry FROM ledger"),
        ).toEqual([{ entry: "baseline" }]);
      });

      it("creates nested SAVEPOINTs (depth 0 -> 1 -> 2) and rolls back only inner savepoint when caught", async () => {
        const db = createSqlite();

        await db.transaction(async (tx0) => {
          expect(tx0.depth).toBe(0);
          expect(tx0.isNested).toBe(false);
          db.run("INSERT INTO ledger (entry) VALUES (?)", ["d0-before"]);

          await db.transaction(
            async (tx1) => {
              expect(tx1.depth).toBe(1);
              expect(tx1.isNested).toBe(true);
              expect(tx1.savepointName).toMatch(/^level_one_\d+$/);
              expect(tx1.id).toBe(`${tx0.id}.${tx1.savepointName}`);
              db.run("INSERT INTO ledger (entry) VALUES (?)", ["d1-keep"]);

              await expect(
                db.transaction(
                  async (tx2) => {
                    expect(tx2.depth).toBe(2);
                    expect(tx2.isNested).toBe(true);
                    expect(tx2.savepointName).toMatch(/^level_two_\d+$/);
                    expect(db.getCurrentTransaction()).toBe(tx2);
                    db.run("INSERT INTO ledger (entry) VALUES (?)", [
                      "d2-rolled-back",
                    ]);
                    throw new Error("depth-2-fail");
                  },
                  { savepointName: "level_two" },
                ),
              ).rejects.toThrow("depth-2-fail");

              expect(db.getCurrentTransaction()).toBe(tx1);
              db.run("INSERT INTO ledger (entry) VALUES (?)", ["d1-after"]);
            },
            { savepointName: "level_one" },
          );

          expect(db.getCurrentTransaction()).toBe(tx0);
          db.run("INSERT INTO ledger (entry) VALUES (?)", ["d0-after"]);
        });

        expect(
          db
            .query<{ entry: string }>("SELECT entry FROM ledger ORDER BY id")
            .map((r) => r.entry),
        ).toEqual(["d0-before", "d1-keep", "d1-after", "d0-after"]);
      });

      it("undoes previously released inner SAVEPOINTs when outer transaction rolls back", async () => {
        const db = createSqlite();

        await expect(
          db.transaction(async () => {
            db.run("INSERT INTO ledger (entry) VALUES (?)", ["outer"]);
            await db.transaction(async () => {
              db.run("INSERT INTO ledger (entry) VALUES (?)", [
                "inner-released",
              ]);
            });
            // Inner savepoint succeeded & released, now outer aborts
            throw new Error("outer-failure");
          }),
        ).rejects.toThrow("outer-failure");

        expect(db.query("SELECT * FROM ledger")).toHaveLength(0);
      });

      it("propagates ALS transaction context implicitly across injected NestJS services & BaseSqliteRepository", async () => {
        @Injectable()
        class LedgerWriter {
          constructor(
            @InjectSqliteRepository(Account)
            private readonly accounts: BaseSqliteRepository<AccountRow, number>,
          ) {}

          credit(owner: string, amount: number): void {
            const existing = this.accounts.findOneWhere({ owner });
            if (!existing) {
              this.accounts.insert({ owner, balance: amount });
            } else {
              this.accounts.updateById(existing.id, {
                balance: existing.balance + amount,
              });
            }
          }
        }

        @Injectable()
        class TransferService {
          constructor(
            private readonly sqlite: SqliteService,
            private readonly writer: LedgerWriter,
            @InjectSqliteRepository(Account)
            readonly accounts: BaseSqliteRepository<AccountRow, number>,
          ) {}

          async transfer(
            from: string,
            to: string,
            amount: number,
            failAfterDebit = false,
          ): Promise<void> {
            await this.sqlite.transaction(async () => {
              this.writer.credit(from, -amount);
              await Bun.sleep(2);
              if (failAfterDebit) {
                throw new Error("transfer-aborted");
              }
              this.writer.credit(to, amount);
            });
          }
        }

        const mod = await Test.createTestingModule({
          imports: [
            SqliteModule.forRoot({
              filename: ":memory:",
              autoMigrate: true,
              migrations: [
                {
                  id: "001_accounts",
                  up: "CREATE TABLE accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT UNIQUE NOT NULL, balance INTEGER NOT NULL)",
                },
              ],
            }),
            SqliteModule.forFeature([Account]),
          ],
          providers: [LedgerWriter, TransferService],
        }).compile({ logger: false });
        await mod.init();

        try {
          const transfers = mod.get(TransferService);
          transfers.accounts.insert({ owner: "alice", balance: 100 });
          transfers.accounts.insert({ owner: "bob", balance: 50 });

          // Failed transfer rolls back debit performed in separate injected LedgerWriter
          await expect(
            transfers.transfer("alice", "bob", 40, true),
          ).rejects.toThrow("transfer-aborted");
          expect(
            transfers.accounts.findOneWhere({ owner: "alice" })?.balance,
          ).toBe(100);
          expect(
            transfers.accounts.findOneWhere({ owner: "bob" })?.balance,
          ).toBe(50);

          // Successful transfer commits atomically
          await transfers.transfer("alice", "bob", 40, false);
          expect(
            transfers.accounts.findOneWhere({ owner: "alice" })?.balance,
          ).toBe(60);
          expect(
            transfers.accounts.findOneWhere({ owner: "bob" })?.balance,
          ).toBe(90);
        } finally {
          await mod.close();
        }
      });

      it("supports transactionSync() with DEFERRED, IMMEDIATE, and EXCLUSIVE modes plus invalid mode guard", () => {
        const db = createSqlite();

        for (const mode of ["DEFERRED", "IMMEDIATE", "EXCLUSIVE"] as const) {
          const val = db.transactionSync(
            (tx) => {
              expect(tx.depth).toBe(0);
              expect(tx.isNested).toBe(false);
              expect(db.isInTransaction()).toBe(true);
              db.run("INSERT INTO ledger (entry) VALUES (?)", [mode]);
              return mode;
            },
            { mode },
          );
          expect(val).toBe(mode);
          expect(db.isInTransaction()).toBe(false);
        }

        expect(
          db
            .query<{ entry: string }>("SELECT entry FROM ledger ORDER BY id")
            .map((r) => r.entry),
        ).toEqual(["DEFERRED", "IMMEDIATE", "EXCLUSIVE"]);

        expect(() =>
          db.transactionSync(() => 1, { mode: "SERIALIZABLE" as any }),
        ).toThrow(/Invalid SQLite transaction mode/);
      });

      it("supports nested transactionSync() savepoints and rollback isolation", () => {
        const db = createSqlite();

        const res = db.transactionSync((outer) => {
          expect(outer.depth).toBe(0);
          db.run("INSERT INTO ledger (entry) VALUES (?)", ["sync-outer"]);

          expect(() =>
            db.transactionSync((inner) => {
              expect(inner.depth).toBe(1);
              expect(inner.isNested).toBe(true);
              expect(db.getCurrentTransaction()).toBe(inner);
              db.run("INSERT INTO ledger (entry) VALUES (?)", [
                "sync-inner-fail",
              ]);
              throw new Error("sync-inner-boom");
            }),
          ).toThrow("sync-inner-boom");

          expect(db.getCurrentTransaction()).toBe(outer);
          db.run("INSERT INTO ledger (entry) VALUES (?)", ["sync-after"]);
          return db
            .query<{ entry: string }>("SELECT entry FROM ledger ORDER BY id")
            .map((r) => r.entry);
        });

        expect(res).toEqual(["sync-outer", "sync-after"]);
      });

      it("allows nested transactionSync() inside an active async transaction(), while rejecting competing top-level transactionSync()", async () => {
        const db = createSqlite();

        // 1. Nested inside async transaction() -> works as a savepoint!
        await db.transaction(async (outer) => {
          db.run("INSERT INTO ledger (entry) VALUES (?)", ["async-outer"]);
          db.transactionSync((inner) => {
            expect(inner.depth).toBe(1);
            expect(inner.isNested).toBe(true);
            expect(inner.id.startsWith(`${outer.id}.`)).toBe(true);
            db.run("INSERT INTO ledger (entry) VALUES (?)", ["sync-child"]);
          });
        });
        expect(
          db
            .query<{ entry: string }>("SELECT entry FROM ledger ORDER BY id")
            .map((r) => r.entry),
        ).toEqual(["async-outer", "sync-child"]);

        // 2. Competing top-level transactionSync() outside the async ALS chain -> throws!
        let signalInside!: () => void;
        const insideReady = new Promise<void>((r) => {
          signalInside = r;
        });
        let releaseTx!: () => void;
        const gate = new Promise<void>((r) => {
          releaseTx = r;
        });

        const activeTx = db.transaction(async () => {
          signalInside();
          await gate;
        });

        await insideReady;
        expect(() => db.transactionSync(() => "conflict")).toThrow(
          /while another transaction is active/,
        );

        releaseTx();
        await activeTx;
      });
    });

    describe("SqlService transactions, SAVEPOINTs & ALS propagation", () => {
      it("commits top-level SqlService.transaction() and restores ALS after completion", async () => {
        const svc = await createSql();
        expect(svc.isInTransaction()).toBe(false);
        expect(svc.getCurrentTransaction()).toBeUndefined();

        const txId = await svc.transaction(async (tx) => {
          expect(tx.depth).toBe(0);
          expect(tx.isNested).toBe(false);
          expect(tx.connectionName).toBe("default");
          expect(svc.isInTransaction()).toBe(true);
          expect(svc.getCurrentTransaction()).toBe(tx);

          await svc.sql`INSERT INTO ledger (entry) VALUES (${"sql-commit"})`;
          return tx.id;
        });

        expect(txId).toMatch(/^sql_tx_\d+$/);
        expect(svc.isInTransaction()).toBe(false);
        expect(svc.getCurrentTransaction()).toBeUndefined();
        const rows = await svc.sql<{ entry: string }>`SELECT entry FROM ledger`;
        expect([...rows]).toEqual([{ entry: "sql-commit" }]);
      });

      it("rolls back top-level SqlService.transaction() when an error is thrown", async () => {
        const svc = await createSql();
        await svc.sql`INSERT INTO ledger (entry) VALUES (${"initial"})`;

        await expect(
          svc.transaction(async () => {
            await svc.sql`INSERT INTO ledger (entry) VALUES (${"should-rollback"})`;
            throw new Error("sql-abort");
          }),
        ).rejects.toThrow("sql-abort");

        expect(svc.isInTransaction()).toBe(false);
        const rows = await svc.sql<{ entry: string }>`SELECT entry FROM ledger`;
        expect([...rows]).toEqual([{ entry: "initial" }]);
      });

      it("creates nested SAVEPOINTs (depth 0 -> 1 -> 2) on SqlService with partial inner rollback", async () => {
        const svc = await createSql();

        await svc.transaction(async (tx0) => {
          expect(tx0.depth).toBe(0);
          await svc.sql`INSERT INTO ledger (entry) VALUES (${"d0-start"})`;

          await svc.transaction(
            async (tx1) => {
              expect(tx1.depth).toBe(1);
              expect(tx1.isNested).toBe(true);
              expect(tx1.savepointName).toMatch(/^sp_a_\d+$/);
              await svc.sql`INSERT INTO ledger (entry) VALUES (${"d1-keep"})`;

              await expect(
                svc.transaction(
                  async (tx2) => {
                    expect(tx2.depth).toBe(2);
                    expect(tx2.isNested).toBe(true);
                    expect(svc.getCurrentTransaction()).toBe(tx2);
                    await svc.unsafe("INSERT INTO ledger (entry) VALUES (?)", [
                      "d2-discard",
                    ]);
                    throw new Error("d2-boom");
                  },
                  { savepointName: "sp_b" },
                ),
              ).rejects.toThrow("d2-boom");

              expect(svc.getCurrentTransaction()).toBe(tx1);
              await svc.query("INSERT INTO ledger (entry) VALUES (?)", [
                "d1-end",
              ]);
            },
            { savepointName: "sp_a" },
          );

          expect(svc.getCurrentTransaction()).toBe(tx0);
          await svc.sql`INSERT INTO ledger (entry) VALUES (${"d0-end"})`;
        });

        const rows = await svc.sql<{ entry: string }>`
          SELECT entry FROM ledger ORDER BY id ASC
        `;
        expect([...rows].map((r) => r.entry)).toEqual([
          "d0-start",
          "d1-keep",
          "d1-end",
          "d0-end",
        ]);
      });

      it("undoes previously released inner SAVEPOINTs when outer SqlService transaction rolls back", async () => {
        const svc = await createSql();

        await expect(
          svc.transaction(async () => {
            await svc.sql`INSERT INTO ledger (entry) VALUES (${"outer"})`;
            await svc.transaction(async () => {
              await svc.sql`INSERT INTO ledger (entry) VALUES (${"inner-released"})`;
            });
            throw new Error("outer-sql-abort");
          }),
        ).rejects.toThrow("outer-sql-abort");

        expect(await svc.queryScalar<number>("SELECT COUNT(*) FROM ledger")).toBe(
          0,
        );
      });

      it("propagates SqlService ALS transaction implicitly across separate injected NestJS services", async () => {
        @Injectable()
        class AuditRepo {
          constructor(private readonly sql: SqlService) {}

          async record(entry: string): Promise<void> {
            await this.sql.sql`INSERT INTO ledger (entry) VALUES (${entry})`;
          }
        }

        @Injectable()
        class WorkflowService {
          constructor(
            private readonly sql: SqlService,
            private readonly audit: AuditRepo,
          ) {}

          async runWorkflow(shouldFail: boolean): Promise<void> {
            await this.sql.transaction(async () => {
              await this.audit.record("step-1");
              await Bun.sleep(2);
              await this.audit.record("step-2");
              if (shouldFail) {
                throw new Error("workflow-failed");
              }
            });
          }
        }

        const mod = await Test.createTestingModule({
          imports: [
            SqlModule.forRoot({
              url: "sqlite://:memory:",
              autoMigrate: true,
              migrations: [
                {
                  id: "001_ledger",
                  up: "CREATE TABLE ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, entry TEXT NOT NULL)",
                },
              ],
            }),
          ],
          providers: [AuditRepo, WorkflowService],
        }).compile({ logger: false });
        await mod.init();

        try {
          const workflow = mod.get(WorkflowService);
          const sql = mod.get(SqlService);

          await expect(workflow.runWorkflow(true)).rejects.toThrow(
            "workflow-failed",
          );
          expect(
            await sql.queryScalar<number>("SELECT COUNT(*) FROM ledger"),
          ).toBe(0);

          await workflow.runWorkflow(false);
          const rows = await sql.sql<{ entry: string }>`
            SELECT entry FROM ledger ORDER BY id ASC
          `;
          expect([...rows].map((r) => r.entry)).toEqual(["step-1", "step-2"]);
        } finally {
          await mod.close();
        }
      });
    });
  },
);
