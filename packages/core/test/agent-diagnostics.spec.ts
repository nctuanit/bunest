import { describe, expect, test } from "bun:test";
import {
  AgentErrorTraceStore,
  BunestFactory,
  Controller,
  Get,
  Injectable,
  Module,
  UseGuards,
  buildAgentErrorTrace,
  extractAppStackFrames,
  formatAgentErrorTrace,
  join,
  readAgentErrorTracesFromFile,
  removePath,
  type CanActivate,
} from "../src/index";

@Injectable()
class DenyGuard implements CanActivate {
  canActivate(): boolean {
    return false;
  }
}

@Controller("diag-demo")
class DiagDemoController {
  @Get("boom")
  boom() {
    throw new Error("Simulated handler failure");
  }

  @Get("secret")
  @UseGuards(DenyGuard)
  secret() {
    return { ok: true };
  }

  @Get("ok")
  ok() {
    return { ok: true };
  }
}

@Module({
  controllers: [DiagDemoController],
  providers: [DenyGuard],
})
class DiagDemoModule {}

describe("Agent Error Tracing & Dev Diagnostics", () => {
  test("extractAppStackFrames strips internal runtime/framework frames", () => {
    const fakeStack = [
      "Error: boom",
      "    at createOrder (/app/src/orders/orders.service.ts:42:17)",
      "    at executeCompiledRoute (/app/packages/core/src/http/pipeline/execution-pipeline.ts:1044:12)",
      "    at Bun.serve (bun:http:12:3)",
      "    at /app/node_modules/some-lib/index.js:5:1",
      "    at /app/src/orders/orders.controller.ts:18:9",
    ].join("\n");

    const frames = extractAppStackFrames(fakeStack, "/app");
    expect(frames).toEqual([
      {
        file: "src/orders/orders.service.ts",
        line: 42,
        column: 17,
        fn: "createOrder",
      },
      {
        file: "src/orders/orders.controller.ts",
        line: 18,
        column: 9,
      },
    ]);
  });

  test("AgentErrorTraceStore persists JSONL and respects ring-buffer maxEntries", async () => {
    const tmpDir = Bun.env.TMPDIR ?? "/tmp";
    const filePath = join(
      tmpDir,
      `bunest-agent-trace-${Date.now()}-${crypto.randomUUID()}`,
      "errors.jsonl",
    );
    try {
      const store = new AgentErrorTraceStore({
        maxEntries: 2,
        filePath,
      });

      store.record(
        buildAgentErrorTrace({
          id: "req_1",
          method: "GET",
          path: "/a",
          statusCode: 500,
          stage: "handler",
          error: new Error("first"),
        }),
      );
      store.record(
        buildAgentErrorTrace({
          id: "req_2",
          method: "POST",
          path: "/b",
          statusCode: 400,
          stage: "pipe",
          error: new Error("second"),
        }),
      );
      store.record(
        buildAgentErrorTrace({
          id: "req_3",
          method: "DELETE",
          path: "/c",
          statusCode: 403,
          stage: "guard",
          error: new Error("third"),
        }),
      );

      await store.flush();

      expect(store.list().map((t) => t.id)).toEqual(["req_3", "req_2"]);
      expect(store.getById("req_2")?.message).toBe("second");

      const fromDisk = await readAgentErrorTracesFromFile(filePath, 10);
      expect(fromDisk.map((t) => t.id)).toEqual(["req_3", "req_2"]);
      expect(formatAgentErrorTrace(fromDisk[0]!)).toContain(
        "[req_3] 403 DELETE /c (stage=guard)",
      );
    } finally {
      await removePath(join(filePath, ".."), { recursive: true, force: true });
    }
  });

  test("enableDevDiagnostics records stage, controller, X-Request-Id, and serves /__bunest/* endpoints", async () => {
    const app = await BunestFactory.create(DiagDemoModule, { logger: false });
    app.enableDevDiagnostics();
    await app.init();

    try {
      // 1. Handler exception (500)
      const boomRes = await app.inject({ method: "GET", url: "/diag-demo/boom" });
      expect(boomRes.statusCode).toBe(500);
      const boomReqId = boomRes.headers["x-request-id"] as string;
      expect(boomReqId).toMatch(/^req_/);

      // 2. Guard rejection (403)
      const secretRes = await app.inject({
        method: "GET",
        url: "/diag-demo/secret",
      });
      expect(secretRes.statusCode).toBe(403);
      const secretReqId = secretRes.headers["x-request-id"] as string;
      expect(secretReqId).toMatch(/^req_/);

      // 3. Routing 404
      const notFoundRes = await app.inject({
        method: "GET",
        url: "/does-not-exist",
      });
      expect(notFoundRes.statusCode).toBe(404);

      // 4. Inspect /__bunest/errors (JSON)
      const errorsRes = await app.inject({
        method: "GET",
        url: "/__bunest/errors?limit=10",
      });
      expect(errorsRes.statusCode).toBe(200);
      const errorsBody = errorsRes.json() as {
        count: number;
        errors: Array<{
          id: string;
          stage: string;
          statusCode: number;
          controller?: string;
          handler?: string;
        }>;
      };
      expect(errorsBody.count).toBe(3);

      const byId = new Map(errorsBody.errors.map((e) => [e.id, e]));
      expect(byId.get(boomReqId)?.stage).toBe("handler");
      expect(byId.get(boomReqId)?.controller).toBe("DiagDemoController");
      expect(byId.get(boomReqId)?.handler).toBe("boom");

      expect(byId.get(secretReqId)?.stage).toBe("guard");
      expect(byId.get(secretReqId)?.controller).toBe("DiagDemoController");
      expect(byId.get(secretReqId)?.handler).toBe("secret");

      // 5. Inspect /__bunest/errors?format=agent
      const agentRes = await app.inject({
        method: "GET",
        url: "/__bunest/errors?format=agent",
      });
      expect(agentRes.statusCode).toBe(200);
      expect(agentRes.body).toContain("DiagDemoController.boom");
      expect(agentRes.body).toContain("stage=guard");

      // 6. Inspect /__bunest/errors?id=<reqId>
      const singleRes = await app.inject({
        method: "GET",
        url: `/__bunest/errors?id=${boomReqId}`,
      });
      expect(singleRes.statusCode).toBe(200);
      expect((singleRes.json() as { id: string }).id).toBe(boomReqId);

      // 7. Inspect /__bunest/routes
      const routesRes = await app.inject({
        method: "GET",
        url: "/__bunest/routes",
      });
      expect(routesRes.statusCode).toBe(200);
      const routesBody = routesRes.json() as {
        count: number;
        routes: Array<{ method: string; path: string; controller: string }>;
      };
      expect(routesBody.count).toBeGreaterThanOrEqual(3);
      expect(routesBody.routes.some((r) => r.path === "/diag-demo/boom")).toBe(
        true,
      );

      // 8. Inspect /__bunest/graph
      const graphRes = await app.inject({
        method: "GET",
        url: "/__bunest/graph",
      });
      expect(graphRes.statusCode).toBe(200);
      const graphBody = graphRes.json() as {
        count: number;
        modules: Array<{ name: string; controllers: string[] }>;
      };
      expect(graphBody.modules.some((m) => m.name === "DiagDemoModule")).toBe(
        true,
      );
    } finally {
      await app.close();
    }
  });

  test("enableDevDiagnostics is a no-op when NODE_ENV=production unless allowInProduction is true", async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const app = await BunestFactory.create(DiagDemoModule, { logger: false });
      app.enableDevDiagnostics();
      expect(app.getDevDiagnosticsStore()).toBeUndefined();
      await app.close();
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});
