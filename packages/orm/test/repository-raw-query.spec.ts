import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  Column,
  CrudRepository,
  DataSource,
  Entity,
  Repository,
  PrimaryGeneratedColumn,
} from "../src/index";

@Entity("task_audit")
class TaskAuditEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: "task_id", type: "integer" })
  taskId!: number;

  @Column({ type: "text" })
  action!: string;
}

@Repository(TaskAuditEntity)
abstract class TaskAuditRepository extends CrudRepository<
  TaskAuditEntity,
  number
> {
  async recordAudit(taskId: number, action: string): Promise<number> {
    const res = await this.execute(
      "INSERT INTO task_audit (task_id, action) VALUES (:taskId, :action)",
      { taskId, action },
    );
    return res.affectedRows;
  }

  async findExistsByTaskId(taskId: number): Promise<{ found: number } | null> {
    return this.queryOne<{ found: number }>(
      "SELECT 1 AS found FROM task_audit WHERE task_id = :taskId LIMIT 1",
      { taskId },
    );
  }

  async findAllByAction(
    action: string,
  ): Promise<Array<{ id: number; task_id: number; action: string }>> {
    return this.query<{ id: number; task_id: number; action: string }>(
      "SELECT id, task_id, action FROM task_audit WHERE action = :action ORDER BY id ASC",
      { action },
    );
  }

  async findPositional(
    taskId: number,
  ): Promise<Array<{ id: number; task_id: number; action: string }>> {
    return this.query<{ id: number; task_id: number; action: string }>(
      "SELECT id, task_id, action FROM task_audit WHERE task_id = $1",
      [taskId],
    );
  }

  async callMissingParam(): Promise<unknown[]> {
    return this.query(
      "SELECT * FROM task_audit WHERE task_id = :taskId AND action = :action",
      { taskId: 1 },
    );
  }
}

describe("CrudRepository — this.query() / this.queryOne() / this.execute()", () => {
  let ds: DataSource;
  let repo: TaskAuditRepository;

  beforeEach(async () => {
    ds = new DataSource({
      type: "sqlite",
      database: ":memory:",
      entities: [TaskAuditEntity],
      synchronize: true,
    });
    await ds.initialize();
    repo = ds.getDeclarativeRepository(TaskAuditRepository);
  });

  afterEach(async () => {
    await ds.destroy();
  });

  it("executes named :param queries and writes naturally inside repository methods", async () => {
    expect(await repo.recordAudit(10, "created")).toBe(1);
    expect(await repo.recordAudit(20, "created")).toBe(1);
    expect(await repo.recordAudit(10, "updated")).toBe(1);

    expect(await repo.findExistsByTaskId(10)).toEqual({ found: 1 });
    expect(await repo.findExistsByTaskId(999)).toBeNull();

    const created = await repo.findAllByAction("created");
    expect(created).toHaveLength(2);
    expect(created.map((r) => r.task_id)).toEqual([10, 20]);
  });

  it("supports positional ($1 / ?) array parameters", async () => {
    await repo.recordAudit(42, "archived");
    const rows = await repo.findPositional(42);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe("archived");
  });

  it("throws an actionable error when a named :param is missing", async () => {
    await expect(repo.callMissingParam()).rejects.toThrow(
      /missing named parameter "action"/,
    );
  });
});
