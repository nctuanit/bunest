import { describe, expect, test } from "bun:test";
import {
  AgentErrorTraceStore,
  BunestFactory,
  Controller,
  Get,
  Module,
  buildAgentErrorTrace,
  join,
  removePath,
} from "@bunest/core";
import { BUNEST_MCP_TOOLS, handleMcpRequest } from "../src/commands/mcp";

@Controller("mcp-test")
class McpTestController {
  @Get("fail")
  fail() {
    throw new Error("MCP test failure");
  }
}

@Module({
  controllers: [McpTestController],
})
class McpTestModule {}

describe("bunest mcp stdio server", () => {
  test("handles initialize, ping, notifications, tools/list, and unknown methods", async () => {
    const initRes = await handleMcpRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
    });
    expect(initRes?.id).toBe(1);
    expect((initRes?.result as { serverInfo: { name: string } }).serverInfo.name).toBe(
      "bunest-mcp",
    );

    const notifRes = await handleMcpRequest({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    expect(notifRes).toBeNull();

    const listRes = await handleMcpRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    const tools = (listRes?.result as { tools: typeof BUNEST_MCP_TOOLS }).tools;
    expect(tools.map((t) => t.name)).toEqual([
      "bunest_explain_error",
      "bunest_recent_errors",
      "bunest_inspect_diagnostics",
      "bunest_explain_route",
      "bunest_verify",
      "bunest_graph",
    ]);

    const unknownRes = await handleMcpRequest({
      jsonrpc: "2.0",
      id: 3,
      method: "does/not/exist",
    });
    expect(unknownRes?.error?.code).toBe(-32601);
  });

  test("bunest_explain_error returns catalog entry, list, and handles unknown code", async () => {
    const single = await handleMcpRequest({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: {
        name: "bunest_explain_error",
        arguments: { code: "BUNEST_E001" },
      },
    });
    const text = (
      single?.result as { content: Array<{ text: string }> }
    ).content[0]!.text;
    expect(text).toContain("UnknownDependencyException");
    expect(text).toContain("Ordered fixes:");
    expect(text).toContain("https://nctuanit.github.io/bunest/faq/common-errors#bunest_e001");

    const all = await handleMcpRequest({
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: {
        name: "bunest_explain_error",
        arguments: {},
      },
    });
    expect(
      (all?.result as { content: Array<{ text: string }> }).content[0]!.text,
    ).toContain("BUNEST_E101");

    const bad = await handleMcpRequest({
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: {
        name: "bunest_explain_error",
        arguments: { code: "BUNEST_E999" },
      },
    });
    expect((bad?.result as { isError?: boolean }).isError).toBe(true);
  });

  test("bunest_recent_errors reads traces from .bunest/errors.jsonl", async () => {
    const tmpDir = join(
      Bun.env.TMPDIR ?? "/tmp",
      `bunest-mcp-test-${Date.now()}-${crypto.randomUUID()}`,
    );
    const traceFile = join(tmpDir, ".bunest", "errors.jsonl");
    try {
      const store = new AgentErrorTraceStore({ filePath: traceFile });
      store.record(
        buildAgentErrorTrace({
          id: "req_disk_1",
          method: "POST",
          path: "/users",
          statusCode: 500,
          stage: "handler",
          controller: "UsersController",
          handler: "create",
          error: new Error("DB connection lost"),
        }),
      );
      await store.flush();

      const res = await handleMcpRequest(
        {
          jsonrpc: "2.0",
          id: 20,
          method: "tools/call",
          params: {
            name: "bunest_recent_errors",
            arguments: { format: "agent", limit: 5 },
          },
        },
        { cwd: tmpDir },
      );
      const text = (
        res?.result as { content: Array<{ text: string }> }
      ).content[0]!.text;
      expect(text).toContain("[req_disk_1] 500 POST /users");
      expect(text).toContain("UsersController.create");
      expect(text).toContain("DB connection lost");
    } finally {
      await removePath(tmpDir, { recursive: true, force: true });
    }
  });

  test("bunest_recent_errors & bunest_inspect_diagnostics query live dev server", async () => {
    const app = await BunestFactory.create(McpTestModule, { logger: false });
    app.enableDevDiagnostics();
    await app.listen(0, "127.0.0.1");
    const serverUrl = app.getUrl()!;

    try {
      const failRes = await fetch(`${serverUrl}/mcp-test/fail`);
      expect(failRes.status).toBe(500);

      const errTool = await handleMcpRequest(
        {
          jsonrpc: "2.0",
          id: 30,
          method: "tools/call",
          params: {
            name: "bunest_recent_errors",
            arguments: { serverUrl, format: "agent" },
          },
        },
        {},
      );
      const errText = (
        errTool?.result as { content: Array<{ text: string }> }
      ).content[0]!.text;
      expect(errText).toContain("McpTestController.fail");
      expect(errText).toContain("MCP test failure");

      const routesTool = await handleMcpRequest({
        jsonrpc: "2.0",
        id: 31,
        method: "tools/call",
        params: {
          name: "bunest_inspect_diagnostics",
          arguments: { target: "routes", serverUrl },
        },
      });
      const routesText = (
        routesTool?.result as { content: Array<{ text: string }> }
      ).content[0]!.text;
      expect(routesText).toContain("/mcp-test/fail");

      const graphTool = await handleMcpRequest({
        jsonrpc: "2.0",
        id: 32,
        method: "tools/call",
        params: {
          name: "bunest_inspect_diagnostics",
          arguments: { target: "graph", serverUrl },
        },
      });
      const graphText = (
        graphTool?.result as { content: Array<{ text: string }> }
      ).content[0]!.text;
      expect(graphText).toContain("McpTestModule");
    } finally {
      await app.close();
    }
  });

  test("bunest_graph returns offline DI graph in json/mermaid/dot with module and cyclesOnly filters", async () => {
    const tmpDir = join(
      Bun.env.TMPDIR ?? Bun.env.TEMP ?? "/tmp",
      `bunest-mcp-graph-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
    );
    try {
      await Bun.write(
        join(tmpDir, "src/decorators.ts"),
        `export function Module(_o?: any): ClassDecorator { return () => {}; }
export function Injectable(): ClassDecorator { return () => {}; }
export function Controller(_p?: string): ClassDecorator { return () => {}; }
export function Get(_p?: string): MethodDecorator { return () => {}; }
`,
      );
      await Bun.write(
        join(tmpDir, "src/a.service.ts"),
        `import { Injectable } from "./decorators";
import { BService } from "./b.service";
@Injectable()
export class AService { constructor(private b: BService) {} }
`,
      );
      await Bun.write(
        join(tmpDir, "src/b.service.ts"),
        `import { Injectable } from "./decorators";
import { AService } from "./a.service";
@Injectable()
export class BService { constructor(private a: AService) {} }
`,
      );
      await Bun.write(
        join(tmpDir, "src/solo.service.ts"),
        `import { Injectable } from "./decorators";
@Injectable()
export class SoloService {}
`,
      );
      await Bun.write(
        join(tmpDir, "src/a.module.ts"),
        `import { Module } from "./decorators";
import { BModule } from "./b.module";
import { AService } from "./a.service";
@Module({ imports: [BModule], providers: [AService], exports: [AService] })
export class AModule {}
`,
      );
      await Bun.write(
        join(tmpDir, "src/b.module.ts"),
        `import { Module } from "./decorators";
import { AModule } from "./a.module";
import { BService } from "./b.service";
@Module({ imports: [AModule], providers: [BService], exports: [BService] })
export class BModule {}
`,
      );
      await Bun.write(
        join(tmpDir, "src/solo.module.ts"),
        `import { Module } from "./decorators";
import { SoloService } from "./solo.service";
@Module({ providers: [SoloService] })
export class SoloModule {}
`,
      );

      // JSON default format
      const jsonRes = await handleMcpRequest(
        {
          jsonrpc: "2.0",
          id: 40,
          method: "tools/call",
          params: {
            name: "bunest_graph",
            arguments: { format: "json" },
          },
        },
        { cwd: tmpDir },
      );
      const jsonText = (
        jsonRes?.result as { content: Array<{ text: string }>; isError?: boolean }
      ).content[0]!.text;
      expect((jsonRes?.result as { isError?: boolean }).isError).toBeUndefined();
      const parsed = JSON.parse(jsonText) as {
        modules: Array<{ name: string }>;
        providers: Array<{ name: string }>;
        cycles: string[][];
        moduleCycles: string[][];
      };
      expect(parsed.modules.map((m) => m.name)).toEqual([
        "AModule",
        "BModule",
        "SoloModule",
      ]);
      expect(parsed.cycles.length).toBeGreaterThanOrEqual(1);
      expect(parsed.moduleCycles.length).toBeGreaterThanOrEqual(1);

      // cyclesOnly: true filters out SoloModule and SoloService
      const cyclesRes = await handleMcpRequest(
        {
          jsonrpc: "2.0",
          id: 41,
          method: "tools/call",
          params: {
            name: "bunest_graph",
            arguments: { format: "json", cyclesOnly: true },
          },
        },
        { cwd: tmpDir },
      );
      const cyclesParsed = JSON.parse(
        (cyclesRes?.result as { content: Array<{ text: string }> }).content[0]!.text,
      ) as {
        modules: Array<{ name: string }>;
        providers: Array<{ name: string }>;
        cyclesOnly: boolean;
      };
      expect(cyclesParsed.cyclesOnly).toBe(true);
      expect(cyclesParsed.modules.map((m) => m.name)).toEqual(["AModule", "BModule"]);
      expect(cyclesParsed.providers.some((p) => p.name === "SoloService")).toBe(false);

      // Mermaid with module filter
      const mermaidRes = await handleMcpRequest(
        {
          jsonrpc: "2.0",
          id: 42,
          method: "tools/call",
          params: {
            name: "bunest_graph",
            arguments: { format: "mermaid", module: "SoloModule" },
          },
        },
        { cwd: tmpDir },
      );
      const mermaidText = (
        mermaidRes?.result as { content: Array<{ text: string }> }
      ).content[0]!.text;
      expect(mermaidText.startsWith("flowchart LR")).toBe(true);
      expect(mermaidText).toContain("SoloModule");
      expect(mermaidText).not.toContain("AModule");

      // DOT format
      const dotRes = await handleMcpRequest(
        {
          jsonrpc: "2.0",
          id: 43,
          method: "tools/call",
          params: {
            name: "bunest_graph",
            arguments: { format: "dot" },
          },
        },
        { cwd: tmpDir },
      );
      const dotText = (
        dotRes?.result as { content: Array<{ text: string }> }
      ).content[0]!.text;
      expect(dotText.startsWith("digraph BunestGraph {")).toBe(true);
      expect(dotText).toContain('"mod:AModule"');

      // Unknown module returns isError: true
      const badModRes = await handleMcpRequest(
        {
          jsonrpc: "2.0",
          id: 44,
          method: "tools/call",
          params: {
            name: "bunest_graph",
            arguments: { module: "DoesNotExistModule" },
          },
        },
        { cwd: tmpDir },
      );
      expect((badModRes?.result as { isError?: boolean }).isError).toBe(true);
      expect(
        (badModRes?.result as { content: Array<{ text: string }> }).content[0]!.text,
      ).toContain('Module "DoesNotExistModule" not found');
    } finally {
      await removePath(tmpDir, { recursive: true, force: true });
    }
  });
});
