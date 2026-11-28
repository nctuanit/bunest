import { describe, expect, it } from "bun:test";
import {
  BunestFactory,
  FunctionalModule,
  defineRoutes,
  implementContract,
} from "@bunest/core";
import { defineContract, defineRoute } from "@bunest/core/client";
import { s } from "@bunest/validation/schema";
import { DocumentBuilder, SwaggerModule } from "../src/index";

describe("SwaggerModule Auto OpenAPI 3.1 for defineRoutes() & implementContract()", () => {
  it("generates complete OpenAPI 3.1 paths, parameters, requestBody, responses, tags, summary, and operationId from a shared contract", async () => {
    const TaskSchema = s.object({
      id: s.string(),
      title: s.string().min(2),
      done: s.boolean(),
    });

    const CreateTaskSchema = s.object({
      title: s.string().min(2),
    });

    const contract = defineContract(
      {
        tasks: {
          list: defineRoute({
            method: "GET",
            path: "/tasks",
            query: s.object({
              done: s.coerce.boolean().optional(),
            }),
            response: s.array(TaskSchema),
            summary: "List all tasks",
            description: "Returns filtered task records",
          }),
          create: defineRoute({
            method: "POST",
            path: "/tasks",
            body: CreateTaskSchema,
            response: TaskSchema,
            summary: "Create a task",
          }),
          remove: defineRoute({
            method: "DELETE",
            path: "/tasks/:id",
            params: s.object({ id: s.string().min(1) }),
            response: s.object({ deleted: s.boolean() }),
            summary: "Delete a task",
          }),
        },
      },
      { basePath: "/api" },
    );

    const extraRoutes = defineRoutes(
      { prefix: "/health", tags: ["ops"] },
      (r) => {
        r.get(
          "/",
          {
            summary: "Health probe",
            operationId: "ops.health",
            responseSchema: s.object({ ok: s.boolean() }),
          },
          () => ({ ok: true }),
        );
      },
    );

    const app = await BunestFactory.create(
      FunctionalModule.forRoutes([
        ...implementContract(contract, {
          tasks: {
            list: () => [{ id: "1", title: "Ship contract", done: false }],
            create: ({ body }) => ({ id: "2", title: body.title, done: false }),
            remove: () => ({ deleted: true }),
          },
        }),
        extraRoutes,
      ]),
      { logger: false },
    );

    try {
      const config = new DocumentBuilder()
        .setTitle("Contract API")
        .setVersion("1.0.0")
        .build();
      const doc = SwaggerModule.createDocument(app, config);

      // 1. Contract GET /api/tasks
      const listOp = doc.paths["/api/tasks"]?.get;
      expect(listOp).toBeDefined();
      expect(listOp?.tags).toEqual(["tasks"]);
      expect(listOp?.operationId).toBe("tasks.list");
      expect(listOp?.summary).toBe("List all tasks");
      expect(listOp?.description).toBe("Returns filtered task records");
      expect(listOp?.parameters?.some((p) => p.name === "done" && p.in === "query")).toBe(true);
      expect(
        listOp?.responses["200"]?.content?.["application/json"]?.schema,
      ).toMatchObject({ type: "array" });

      // 2. Contract POST /api/tasks
      const createOp = doc.paths["/api/tasks"]?.post;
      expect(createOp).toBeDefined();
      expect(createOp?.tags).toEqual(["tasks"]);
      expect(createOp?.operationId).toBe("tasks.create");
      expect(createOp?.summary).toBe("Create a task");
      expect(
        createOp?.requestBody?.content?.["application/json"]?.schema,
      ).toMatchObject({
        type: "object",
        properties: { title: { type: "string", minLength: 2 } },
      });
      expect(
        createOp?.responses["201"]?.content?.["application/json"]?.schema,
      ).toMatchObject({
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          done: { type: "boolean" },
        },
      });

      // 3. Contract DELETE /api/tasks/{id} has NO bogus requestBody when route.body is omitted
      const delOp = doc.paths["/api/tasks/{id}"]?.delete;
      expect(delOp).toBeDefined();
      expect(delOp?.operationId).toBe("tasks.remove");
      expect(delOp?.requestBody).toBeUndefined();
      expect(
        delOp?.parameters?.some((p) => p.name === "id" && p.in === "path"),
      ).toBe(true);

      // 4. Functional defineRoutes() with tags, summary, operationId, responseSchema
      const healthOp = doc.paths["/health"]?.get;
      expect(healthOp).toBeDefined();
      expect(healthOp?.tags).toEqual(["ops"]);
      expect(healthOp?.summary).toBe("Health probe");
      expect(healthOp?.operationId).toBe("ops.health");
      expect(
        healthOp?.responses["200"]?.content?.["application/json"]?.schema,
      ).toMatchObject({
        type: "object",
        properties: { ok: { type: "boolean" } },
      });
    } finally {
      await app.close();
    }
  });
});
