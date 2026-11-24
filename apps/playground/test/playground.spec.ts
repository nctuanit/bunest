import { describe, expect, it } from "bun:test";
import { Test } from "@bunest/testing";
import {
  AppModule,
  configurePlaygroundApp,
  type TodoItem,
} from "../src/app.module";

describe("Bunest Playground App", () => {
  it("serves Todos CRUD, Swagger /docs, /health, /metrics, and /_devtools/graph", async () => {
    const mod = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    const app = mod.createBunestApplication();
    configurePlaygroundApp(app);
    const client = mod.createTestClient(app);
    await app.init();

    try {
      // 1. Seeded Todo list + CRUD create/update/delete
      const listRes = await client.get("/todos");
      expect(listRes.status).toBe(200);
      expect((await listRes.json()) as TodoItem[]).toHaveLength(1);

      const createRes = await client.post("/todos", {
        json: { title: "Benchmark Bun.serve" },
      });
      expect(createRes.status).toBe(201);
      const created = (await createRes.json()) as TodoItem;
      expect(created.title).toBe("Benchmark Bun.serve");
      expect(created.completed).toBe(false);

      const patchRes = await client.patch(`/todos/${created.id}`, {
        json: { completed: true },
      });
      expect(patchRes.status).toBe(200);
      expect(((await patchRes.json()) as TodoItem).completed).toBe(true);

      const delRes = await client.delete(`/todos/${created.id}`);
      expect(delRes.status).toBe(204);

      // 1b. @Entity validation & ParseIntPipe enforcement
      const invalidTitleRes = await client.post("/todos", {
        json: { title: "" },
      });
      expect(invalidTitleRes.status).toBe(400);

      const invalidIdRes = await client.get("/todos/not-a-number");
      expect(invalidIdRes.status).toBe(400);

      const seededRes = await client.get("/todos/1");
      expect(seededRes.status).toBe(200);
      expect(((await seededRes.json()) as TodoItem).title).toBe(
        "Try Bunest Playground",
      );

      // 2. OpenAPI Swagger UI & JSON (auto-generated @Entity schema + design:returntype)
      const docsJson = await client.get("/docs-json");
      expect(docsJson.status).toBe(200);
      const doc = (await docsJson.json()) as {
        openapi: string;
        paths: Record<string, any>;
        components?: { schemas?: Record<string, any> };
      };
      expect(doc.openapi).toBe("3.1.0");
      expect(doc.paths["/todos"]).toBeDefined();
      expect(doc.components?.schemas?.Todo?.properties?.title).toMatchObject({
        type: "string",
        minLength: 1,
      });
      expect(
        doc.components?.schemas?.Todo?.properties?.completed,
      ).toMatchObject({
        type: "boolean",
        default: false,
      });
      expect(doc.components?.schemas?.Todo?.required).toEqual(["title"]);
      expect(
        doc.paths["/todos/template"]?.get?.responses?.["200"]?.content?.[
          "application/json"
        ]?.schema,
      ).toEqual({ $ref: "#/components/schemas/Todo" });

      const docsHtml = await client.get("/docs");
      expect(docsHtml.status).toBe(200);
      expect(await docsHtml.text()).toContain("Bunest Interactive Playground");

      // 3. Health & Readiness
      const healthRes = await client.get("/health");
      expect(healthRes.status).toBe(200);
      expect(((await healthRes.json()) as { status: string }).status).toBe(
        "ok",
      );

      // 4. Prometheus Metrics
      const metricsRes = await client.get("/metrics");
      expect(metricsRes.status).toBe(200);
      expect(await metricsRes.text()).toContain("http_requests_total");

      // 5. Devtools Graph & Mermaid
      const graphRes = await client.get("/_devtools/graph");
      expect(graphRes.status).toBe(200);
      const graph = (await graphRes.json()) as {
        modules: unknown[];
        routes: unknown[];
      };
      expect(graph.modules.length).toBeGreaterThan(0);
      expect(graph.routes.length).toBeGreaterThan(0);

      const mermaidRes = await client.get("/_devtools/mermaid");
      expect(mermaidRes.status).toBe(200);
      expect(await mermaidRes.text()).toContain("flowchart LR");
    } finally {
      await app.close();
    }
  });
});
