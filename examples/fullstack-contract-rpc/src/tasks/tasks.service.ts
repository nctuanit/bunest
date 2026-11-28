import { Injectable, NotFoundException } from "@bunest/core";
import type { InferOutput } from "@bunest/validation/schema";
import type {
  CreateTaskBodySchema,
  ListTasksQuerySchema,
  TaskSchema,
  UpdateTaskBodySchema,
} from "../shared/contract";

export type TaskRecord = InferOutput<typeof TaskSchema>;
export type CreateTaskInput = InferOutput<typeof CreateTaskBodySchema>;
export type UpdateTaskInput = InferOutput<typeof UpdateTaskBodySchema>;
export type ListTasksFilter = InferOutput<typeof ListTasksQuerySchema>;

@Injectable()
export class TasksService {
  private readonly store = new Map<string, TaskRecord>([
    [
      "tsk_1",
      {
        id: "tsk_1",
        title: "Eliminate DTO + Swagger duplication",
        priority: "high",
        completed: true,
      },
    ],
  ]);
  private seq = 2;

  list(filter: ListTasksFilter): TaskRecord[] {
    let items = [...this.store.values()];
    if (filter.priority !== undefined) {
      items = items.filter((t) => t.priority === filter.priority);
    }
    if (filter.completed !== undefined) {
      items = items.filter((t) => t.completed === filter.completed);
    }
    return items;
  }

  getById(id: string): TaskRecord {
    const task = this.store.get(id);
    if (!task) {
      throw new NotFoundException(`Task "${id}" not found`);
    }
    return task;
  }

  create(input: CreateTaskInput): TaskRecord {
    const record: TaskRecord = {
      id: `tsk_${this.seq++}`,
      title: input.title,
      priority: input.priority ?? "medium",
      completed: false,
    };
    this.store.set(record.id, record);
    return record;
  }

  update(id: string, input: UpdateTaskInput): TaskRecord {
    const current = this.getById(id);
    const updated: TaskRecord = {
      ...current,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(input.completed !== undefined ? { completed: input.completed } : {}),
    };
    this.store.set(id, updated);
    return updated;
  }

  remove(id: string): { deleted: boolean; id: string } {
    this.getById(id);
    this.store.delete(id);
    return { deleted: true, id };
  }
}
