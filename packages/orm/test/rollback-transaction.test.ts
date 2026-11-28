import { describe, expect, it } from "bun:test";
import {
  Column,
  DataSource,
  Entity,
  PrimaryGeneratedColumn,
  runInRollbackTransaction,
} from "../src/index";

@Entity("rb_accounts")
class RbAccount {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar" })
  email!: string;
}

describe("runInRollbackTransaction()", () => {
  it("rolls back all writes (including nested transactions / savepoints) and returns callback result", async () => {
    const ds = new DataSource({
      type: "sqlite",
      database: ":memory:",
      entities: [RbAccount],
      synchronize: true,
    });
    await ds.initialize();

    try {
      const repo = ds.getRepository(RbAccount);
      await repo.save({ email: "persisted@bunest.dev" });

      const returned = await runInRollbackTransaction(ds, async (em) => {
        const txRepo = em.getRepository(RbAccount);
        await txRepo.save({ email: "outer@bunest.dev" });

        // Nested transaction (savepoint)
        await ds.transaction(async (nestedEm) => {
          await nestedEm.getRepository(RbAccount).save({
            email: "nested@bunest.dev",
          });
        });

        const visibleInsideTx = await txRepo.find();
        expect(visibleInsideTx).toHaveLength(3);
        return "tx-return-value";
      });

      expect(returned).toBe("tx-return-value");

      // After rollback, only the pre-existing row remains
      const afterRollback = await repo.find();
      expect(afterRollback).toHaveLength(1);
      expect(afterRollback[0]!.email).toBe("persisted@bunest.dev");
    } finally {
      await ds.destroy();
    }
  });

  it("rethrows errors from callback and still rolls back", async () => {
    const ds = new DataSource({
      type: "sqlite",
      database: ":memory:",
      entities: [RbAccount],
      synchronize: true,
    });
    await ds.initialize();

    try {
      const repo = ds.getRepository(RbAccount);

      await expect(
        runInRollbackTransaction(ds, async (em) => {
          await em.getRepository(RbAccount).save({ email: "failed@bunest.dev" });
          throw new Error("boom-in-test");
        }),
      ).rejects.toThrow("boom-in-test");

      expect(await repo.find()).toHaveLength(0);
    } finally {
      await ds.destroy();
    }
  });
});
