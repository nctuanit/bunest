import { defineContract, defineRoute } from "@bunest/core/client";
import { s } from "@bunest/validation/schema";

export const TaskPrioritySchema = s.enum(["low", "medium", "high"] as const);

export const TaskSchema = s.object({
  id: s.string(),
  title: s.string().min(2),
  priority: TaskPrioritySchema,
  completed: s.boolean(),
});

export const CreateTaskBodySchema = s.object({
  title: s.string().min(2),
  priority: TaskPrioritySchema.optional(),
});

export const UpdateTaskBodySchema = s.object({
  title: s.string().min(2).optional(),
  priority: TaskPrioritySchema.optional(),
  completed: s.boolean().optional(),
});

export const TaskIdParamsSchema = s.object({
  id: s.string().min(1),
});

export const ListTasksQuerySchema = s.object({
  priority: TaskPrioritySchema.optional(),
  completed: s.coerce.boolean().optional(),
});

export const appContract = defineContract(
  {
    tasks: {
      list: defineRoute({
        method: "GET",
        path: "/tasks",
        query: ListTasksQuerySchema,
        response: s.array(TaskSchema),
        summary: "List tasks",
        description: "Filter tasks by priority or completion status",
      }),
      getById: defineRoute({
        method: "GET",
        path: "/tasks/:id",
        params: TaskIdParamsSchema,
        response: TaskSchema,
        summary: "Get task by ID",
      }),
      create: defineRoute({
        method: "POST",
        path: "/tasks",
        body: CreateTaskBodySchema,
        response: TaskSchema,
        summary: "Create a new task",
      }),
      update: defineRoute({
        method: "PATCH",
        path: "/tasks/:id",
        params: TaskIdParamsSchema,
        body: UpdateTaskBodySchema,
        response: TaskSchema,
        summary: "Update an existing task",
      }),
      remove: defineRoute({
        method: "DELETE",
        path: "/tasks/:id",
        params: TaskIdParamsSchema,
        response: s.object({ deleted: s.boolean(), id: s.string() }),
        summary: "Delete a task",
      }),
    },
  },
  { basePath: "/api" },
);
