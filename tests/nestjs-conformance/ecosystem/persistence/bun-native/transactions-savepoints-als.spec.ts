import { afterEach, describe, expect, it } from "bun:test";
import { Injectable } from "../../../../../packages/core/src/common";
import {
  Column,
  DataSource,
  Entity,
  InjectRepository,
  OrmModule,
  PrimaryGeneratedColumn,
  Transactional,
  type Repository,
} from "../../../../../packages/orm/src";
import { Test, describeConformance } from "../../../_helpers/index";

@Entity("accounts")
class Account {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ unique: true })
  owner!: string;

  @Column({ type: "integer" })
  balance!: number;
}

describeConformance(
  "Persistence (bun-native) - @bunest/orm transactions, nested SAVEPOINTs & ALS propagation",
  {
    upstreamPath: "bun-native/transactions-savepoints-als",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-002"],
    notes:
      "Verifies top-level commit/rollback, multi-level nested SAVEPOINTs, AsyncLocalStorage propagation across injected services/repositories, and declarative @Transactional() across SqliteOrmDriver and BunSqlOrmDriver.",
  },
  () => {
    const openSources: DataSource[] = [];

    const createSqliteDataSource = async (): Promise<DataSource> => {
      const ds = new DataSource({ type: "sqlite", database: ":memory:" });
      await ds.initialize();
      openSources.push(ds);
      await ds.driver.execute(
        "CREATE TABLE ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, entry TEXT NOT NULL)",
      );
      return ds;
    };

    const createBunSqlDataSource = async (): Promise<DataSource> => {
      const ds = new DataSource({
        type: "sqlite",
        url: "sqlite://:memory:",
        useBunSql: true,
      });
      await ds.initialize();
      openSources.push(ds);
      await ds.driver.execute(
        "CREATE TABLE ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, entry TEXT NOT NULL)",
      );
      return ds;
    };

    afterEach(async () => {
      while (openSources.length > 0) {
        await openSources.pop()!.destroy();
      }
    });

    describe("SqliteOrmDriver transactions & SAVEPOINTs", () => {
      it("commits top-level DataSource.transaction() and restores driver.isInTransaction()", async () => {
        const ds = await createSqliteDataSource();
        expect(ds.driver.isInTransaction()).toBe(false);

        const result = await ds.transaction(async (em) => {
          expect(ds.driver.isInTransaction()).toBe(true);
          await em.query("INSERT INTO ledger (entry) VALUES (?)", ["committed"]);
          await Bun.sleep(2);
          expect(ds.driver.isInTransaction()).toBe(true);
          return "ok";
        });

        expect(result).toBe("ok");
        expect(ds.driver.isInTransaction()).toBe(false);
        expect(await ds.query<{ entry: string }>("SELECT entry FROM ledger")).toEqual([
          { entry: "committed" },
        ]);
      });

      it("rolls back top-level DataSource.transaction() automatically when callback throws", async () => {
        const ds = await createSqliteDataSource();
        await ds.query("INSERT INTO ledger (entry) VALUES (?)", ["baseline"]);

        await expect(
          ds.transaction(async (em) => {
            await em.query("INSERT INTO ledger (entry) VALUES (?)", ["uncommitted"]);
            await Bun.sleep(2);
            throw new Error("tx-abort");
          }),
        ).rejects.toThrow("tx-abort");

        expect(ds.driver.isInTransaction()).toBe(false);
        expect(await ds.query<{ entry: string }>("SELECT entry FROM ledger")).toEqual([
          { entry: "baseline" },
        ]);
      });

      it("creates nested SAVEPOINTs (depth 0 -> 1 -> 2) and rolls back only inner savepoint when caught", async () => {
        const ds = await createSqliteDataSource();

        await ds.transaction(async (em0) => {
          await em0.query("INSERT INTO ledger (entry) VALUES (?)", ["d0-before"]);

          await ds.transaction(async (em1) => {
            expect(ds.driver.isInTransaction()).toBe(true);
            await em1.query("INSERT INTO ledger (entry) VALUES (?)", ["d1-keep"]);

            await expect(
              ds.transaction(async (em2) => {
                expect(ds.driver.isInTransaction()).toBe(true);
                await em2.query("INSERT INTO ledger (entry) VALUES (?)", [
                  "d2-rolled-back",
                ]);
                throw new Error("depth-2-fail");
              }),
            ).rejects.toThrow("depth-2-fail");

            expect(ds.driver.isInTransaction()).toBe(true);
            await em1.query("INSERT INTO ledger (entry) VALUES (?)", ["d1-after"]);
          });

          expect(ds.driver.isInTransaction()).toBe(true);
          await em0.query("INSERT INTO ledger (entry) VALUES (?)", ["d0-after"]);
        });

        expect(ds.driver.isInTransaction()).toBe(false);
        const rows = await ds.query<{ entry: string }>(
          "SELECT entry FROM ledger ORDER BY id",
        );
        expect(rows.map((r) => r.entry)).toEqual([
          "d0-before",
          "d1-keep",
          "d1-after",
          "d0-after",
        ]);
      });

      it("undoes previously released inner SAVEPOINTs when outer transaction rolls back", async () => {
        const ds = await createSqliteDataSource();

        await expect(
          ds.transaction(async (em) => {
            await em.query("INSERT INTO ledger (entry) VALUES (?)", ["outer"]);
            await ds.transaction(async (inner) => {
              await inner.query("INSERT INTO ledger (entry) VALUES (?)", [
                "inner-released",
              ]);
            });
            throw new Error("outer-failure");
          }),
        ).rejects.toThrow("outer-failure");

        expect(await ds.query("SELECT * FROM ledger")).toHaveLength(0);
      });

      it("propagates ALS transaction context via @Transactional() across injected services & Repository<Account>", async () => {
        @Injectable()
        class LedgerWriter {
          constructor(
            @InjectRepository(Account)
            private readonly accounts: Repository<Account>,
          ) {}

          async credit(owner: string, amount: number): Promise<void> {
            const existing = await this.accounts.findOneBy({ owner });
            if (!existing) {
              await this.accounts.save({ owner, balance: amount });
            } else {
              existing.balance += amount;
              await this.accounts.save(existing);
            }
          }
        }

        @Injectable()
        class TransferService {
          constructor(
            private readonly writer: LedgerWriter,
            @InjectRepository(Account)
            readonly accounts: Repository<Account>,
          ) {}

          @Transactional()
          async transfer(
            from: string,
            to: string,
            amount: number,
            failAfterDebit = false,
          ): Promise<void> {
            await this.writer.credit(from, -amount);
            await Bun.sleep(2);
            if (failAfterDebit) {
              throw new Error("transfer-aborted");
            }
            await this.writer.credit(to, amount);
          }
        }

        const mod = await Test.createTestingModule({
          imports: [
            OrmModule.forRoot({
              type: "sqlite",
              database: ":memory:",
              entities: [Account],
              synchronize: true,
            }),
            OrmModule.forFeature([Account]),
          ],
          providers: [LedgerWriter, TransferService],
        }).compile({ logger: false });
        await mod.init();

        try {
          const transfers = mod.get(TransferService);
          await transfers.accounts.save({ owner: "alice", balance: 100 });
          await transfers.accounts.save({ owner: "bob", balance: 50 });

          // Failed @Transactional() transfer rolls back debit performed in separate injected LedgerWriter
          await expect(
            transfers.transfer("alice", "bob", 40, true),
          ).rejects.toThrow("transfer-aborted");
          expect(
            (await transfers.accounts.findOneBy({ owner: "alice" }))?.balance,
          ).toBe(100);
          expect(
            (await transfers.accounts.findOneBy({ owner: "bob" }))?.balance,
          ).toBe(50);

          // Successful @Transactional() transfer commits atomically
          await transfers.transfer("alice", "bob", 40, false);
          expect(
            (await transfers.accounts.findOneBy({ owner: "alice" }))?.balance,
          ).toBe(60);
          expect(
            (await transfers.accounts.findOneBy({ owner: "bob" }))?.balance,
          ).toBe(90);
        } finally {
          await mod.close();
        }
      });
    });

    describe("BunSqlOrmDriver transactions, SAVEPOINTs & ALS propagation", () => {
      it("commits top-level BunSqlOrmDriver transaction and restores ALS after completion", async () => {
        const ds = await createBunSqlDataSource();
        expect(ds.driver.isInTransaction()).toBe(false);

        const out = await ds.transaction(async (em) => {
          expect(ds.driver.isInTransaction()).toBe(true);
          await em.query("INSERT INTO ledger (entry) VALUES (?)", ["sql-commit"]);
          return "done";
        });

        expect(out).toBe("done");
        expect(ds.driver.isInTransaction()).toBe(false);
        expect(await ds.query<{ entry: string }>("SELECT entry FROM ledger")).toEqual([
          { entry: "sql-commit" },
        ]);
      });

      it("rolls back top-level BunSqlOrmDriver transaction when an error is thrown", async () => {
        const ds = await createBunSqlDataSource();
        await ds.query("INSERT INTO ledger (entry) VALUES (?)", ["initial"]);

        await expect(
          ds.transaction(async (em) => {
            await em.query("INSERT INTO ledger (entry) VALUES (?)", [
              "should-rollback",
            ]);
            throw new Error("sql-abort");
          }),
        ).rejects.toThrow("sql-abort");

        expect(ds.driver.isInTransaction()).toBe(false);
        expect(await ds.query<{ entry: string }>("SELECT entry FROM ledger")).toEqual([
          { entry: "initial" },
        ]);
      });

      it("creates nested SAVEPOINTs (depth 0 -> 1 -> 2) on BunSqlOrmDriver with partial inner rollback", async () => {
        const ds = await createBunSqlDataSource();

        await ds.transaction(async (em0) => {
          await em0.query("INSERT INTO ledger (entry) VALUES (?)", ["d0-start"]);

          await ds.transaction(async (em1) => {
            await em1.query("INSERT INTO ledger (entry) VALUES (?)", ["d1-keep"]);

            await expect(
              ds.transaction(async (em2) => {
                await em2.query("INSERT INTO ledger (entry) VALUES (?)", [
                  "d2-discard",
                ]);
                throw new Error("d2-boom");
              }),
            ).rejects.toThrow("d2-boom");

            await em1.query("INSERT INTO ledger (entry) VALUES (?)", ["d1-end"]);
          });

          await em0.query("INSERT INTO ledger (entry) VALUES (?)", ["d0-end"]);
        });

        const rows = await ds.query<{ entry: string }>(
          "SELECT entry FROM ledger ORDER BY id ASC",
        );
        expect(rows.map((r) => r.entry)).toEqual([
          "d0-start",
          "d1-keep",
          "d1-end",
          "d0-end",
        ]);
      });

      it("undoes previously released inner SAVEPOINTs when outer BunSqlOrmDriver transaction rolls back", async () => {
        const ds = await createBunSqlDataSource();

        await expect(
          ds.transaction(async (em) => {
            await em.query("INSERT INTO ledger (entry) VALUES (?)", ["outer"]);
            await ds.transaction(async (inner) => {
              await inner.query("INSERT INTO ledger (entry) VALUES (?)", [
                "inner-released",
              ]);
            });
            throw new Error("outer-sql-abort");
          }),
        ).rejects.toThrow("outer-sql-abort");

        const cnt = await ds.query<{ cnt: number }>(
          "SELECT COUNT(*) AS cnt FROM ledger",
        );
        expect(Number(cnt[0]?.cnt)).toBe(0);
      });

      it("propagates BunSqlOrmDriver ALS transaction implicitly across separate injected services via @Transactional()", async () => {
        @Injectable()
        class AuditRepo {
          constructor(private readonly ds: DataSource) {}

          async record(entry: string): Promise<void> {
            await this.ds.query("INSERT INTO ledger (entry) VALUES (?)", [entry]);
          }
        }

        @Injectable()
        class WorkflowService {
          constructor(private readonly audit: AuditRepo) {}

          @Transactional()
          async runWorkflow(shouldFail: boolean): Promise<void> {
            await this.audit.record("step-1");
            await Bun.sleep(2);
            await this.audit.record("step-2");
            if (shouldFail) {
              throw new Error("workflow-failed");
            }
          }
        }

        const mod = await Test.createTestingModule({
          imports: [
            OrmModule.forRoot({
              type: "sqlite",
              url: "sqlite://:memory:",
              useBunSql: true,
              migrationsRun: true,
              migrations: [
                {
                  id: "001_ledger",
                  async up(runner) {
                    await runner.execute(
                      "CREATE TABLE ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, entry TEXT NOT NULL)",
                    );
                  },
                },
              ],
            }),
          ],
          providers: [AuditRepo, WorkflowService],
        }).compile({ logger: false });
        await mod.init();

        try {
          const workflow = mod.get(WorkflowService);
          const ds = mod.get(DataSource);

          await expect(workflow.runWorkflow(true)).rejects.toThrow(
            "workflow-failed",
          );
          const cnt = await ds.query<{ cnt: number }>(
            "SELECT COUNT(*) AS cnt FROM ledger",
          );
          expect(Number(cnt[0]?.cnt)).toBe(0);

          await workflow.runWorkflow(false);
          const rows = await ds.query<{ entry: string }>(
            "SELECT entry FROM ledger ORDER BY id ASC",
          );
          expect(rows.map((r) => r.entry)).toEqual(["step-1", "step-2"]);
        } finally {
          await mod.close();
        }
      });
    });
  },
);
