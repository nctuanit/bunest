import { Repository } from "@bunest/orm";
import type { TaskEntity } from "./task.entity";

@Repository<TaskEntity, number>()
export abstract class TaskRepository {
  async findAllForUser(userId: number): Promise<TaskEntity[]> {
    return this.query<TaskEntity>(
      "SELECT id, user_id AS userId, title, created_at AS createdAt FROM tasks WHERE user_id = :userId ORDER BY id ASC",
      { userId },
    );
  }

  async recordAudit(taskId: number, action: string): Promise<number> {
    const res = await this.execute(
      "INSERT INTO task_audit (task_id, action) VALUES (:taskId, :action)",
      { taskId, action },
    );
    return res.affectedRows;
  }

  async countAuditEntries(): Promise<number> {
    const row = await this.queryOne<{ count: number }>(
      "SELECT COUNT(*) AS count FROM task_audit",
    );
    return Number(row?.count ?? 0);
  }
}
