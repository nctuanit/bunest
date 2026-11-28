import { describe, expect, it } from "bun:test";
import { HttpClientValidationError } from "@bunest/core/client";
import { Test } from "@bunest/testing";
import { AppModule, configureFullstackContractApp } from "../src/app.module";
import { createTasksApiClient } from "../src/client/demo-client";
import { appContract } from "../src/shared/contract";
import { DEMO_API_KEY } from "../src/tasks/api-key.guard";

describe("Full-Stack Contract-First RPC (E2E)", () => {
  it("shares 1 contract across server validation, Guards, Auto OpenAPI 3.1, zero-socket test client, and live client", async () => {
    const mod = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    const app = mod.createBunestApplication();
    configureFullstackContractApp(app);
    await app.init();

    try {
      const client = mod.createContractClient(appContract, app, {
        headers: { "x-api-key": DEMO_API_KEY },
      });

      // 1. Typed GET list with query filter
      const initial = await client.tasks.list({ query: { completed: true } });
      expect(initial.status).toBe(200);
      expect(initial.data).toHaveLength(1);
      expect(initial.data[0]?.id).toBe("tsk_1");

      // 2. Typed POST create
      const created = await client.tasks.create({
        body: { title: "Ship typed client", priority: "high" },
      });
      expect(created.status).toBe(201);
      expect(created.data).toEqual({
        id: "tsk_2",
        title: "Ship typed client",
        priority: "high",
        completed: false,
      });

      // 3. Typed PATCH update
      const updated = await client.tasks.update({
        params: { id: "tsk_2" },
        body: { completed: true },
      });
      expect(updated.status).toBe(200);
      expect(updated.data.completed).toBe(true);

      // 4. Auth guard blocks unauthorized mutation
      const unauthRes = await app.fetch(
        new Request("http://localhost/api/tasks", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "Unauthorized" }),
        }),
      );
      expect(unauthRes.status).toBe(403);

      // 5. Client-side validation rejects invalid input before sending
      await expect(
        client.tasks.create({ body: { title: "x" } }),
      ).rejects.toBeInstanceOf(HttpClientValidationError);

      // 6. Typed DELETE remove
      const deleted = await client.tasks.remove({ params: { id: "tsk_2" } });
      expect(deleted.status).toBe(200);
      expect(deleted.data).toEqual({ deleted: true, id: "tsk_2" });

      // 7. Auto OpenAPI 3.1 reflects contract metadata without a single @Api* decorator
      const openApiRes = await app.fetch(
        new Request("http://localhost/docs-json"),
      );
      expect(openApiRes.status).toBe(200);
      const doc = (await openApiRes.json()) as {
        openapi: string;
        paths: Record<string, Record<string, {
          tags?: string[];
          operationId?: string;
          summary?: string;
          requestBody?: unknown;
          responses?: Record<string, { content?: Record<string, { schema?: unknown }> }>;
        }>>;
      };
      expect(doc.openapi).toBe("3.1.0");
      expect(doc.paths["/api/tasks"]?.post?.tags).toEqual(["tasks"]);
      expect(doc.paths["/api/tasks"]?.post?.operationId).toBe("tasks.create");
      expect(doc.paths["/api/tasks"]?.post?.summary).toBe("Create a new task");
      expect(doc.paths["/api/tasks"]?.post?.requestBody).toBeDefined();
      expect(
        doc.paths["/api/tasks"]?.post?.responses?.["201"]?.content?.[
          "application/json"
        ]?.schema,
      ).toMatchObject({ type: "object" });
      expect(doc.paths["/api/tasks/{id}"]?.delete?.requestBody).toBeUndefined();

      // 8. Browser-safe live client over real ephemeral HTTP port
      const server = await app.listen(0);
      const liveClient = createTasksApiClient(
        `http://127.0.0.1:${server.port}`,
        DEMO_API_KEY,
      );
      const liveList = await liveClient.tasks.list();
      expect(liveList.status).toBe(200);
      expect(liveList.data).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
});
