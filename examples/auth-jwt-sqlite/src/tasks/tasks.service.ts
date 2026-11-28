import { Injectable } from "@bunest/core";
import { Transactional } from "@bunest/orm";
import { UserRepository } from "../users/user.repository";
import { CreateTaskDto } from "./create-task.dto";
import type { TaskEntity } from "./task.entity";
import { TaskRepository } from "./task.repository";

@Injectable()
export class TasksService {
  constructor(
    private readonly users: UserRepository,
    private readonly tasks: TaskRepository,
  ) {}

  @Transactional()
  async createTransactional(userId: number, dto: CreateTaskDto) {
    const task = await this.tasks.save({
      userId,
      title: dto.title,
    });

    await this.tasks.recordAudit(task.id, "created");

    if (dto.failAfterInsert === "true") {
      throw new Error("Simulated transactional failure after insert");
    }

    return { id: task.id, userId, title: task.title };
  }

  listForUser(userId: number): Promise<TaskEntity[]> {
    return this.tasks.findAllForUser(userId);
  }

  async getAdminStats() {
    const [userCount, taskCount, auditCount] = await Promise.all([
      this.users.countRegisteredUsers(),
      this.tasks.count(),
      this.tasks.countAuditEntries(),
    ]);

    return { userCount, taskCount, auditCount };
  }
}
