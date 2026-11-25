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
      "bunest_verify",
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
});
