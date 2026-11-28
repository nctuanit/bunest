import { afterEach, describe, expect, test } from "bun:test";
import {
  BUNEST_ERROR_CATALOG,
  getErrorDocsUrl,
  join,
  removePath,
} from "@bunest/core";
import {
  formatErrorExplainReport,
  runExplainErrorCommand,
  runExplainRouteCommand,
  type ErrorExplainFoundReport,
  type ErrorExplainNotFoundReport,
} from "../src/commands/explain";
import { handleMcpRequest } from "../src/commands/mcp";

const createdTempDirs: string[] = [];

async function createTempProject(
  files: Record<string, string>,
): Promise<string> {
  const dir = join(
    process.cwd(),
    ".tmp-explain-error-" +
      Date.now().toString(36) +
      "-" +
      Math.random().toString(36).slice(2, 8),
  );
  createdTempDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    await Bun.write(join(dir, rel), content);
  }
  return dir;
}

afterEach(async () => {
  while (createdTempDirs.length > 0) {
    const dir = createdTempDirs.pop()!;
    await removePath(dir, { recursive: true, force: true });
  }
});

describe("bunest explain error", () => {
  test("explains valid catalog code BUNEST_E001 in pretty, json, and agent formats (case-insensitive trim)", async () => {
    const entry = BUNEST_ERROR_CATALOG.BUNEST_E001;

    // Pretty format with lowercase + surrounding whitespace
    const stdoutPretty: string[] = [];
    const prettyRes = await runExplainErrorCommand(
      { code: "  bunest_e001  ", format: "pretty" },
      {
        stdout: (m) => stdoutPretty.push(m),
        stderr: () => {},
      },
    );

    expect(prettyRes.exitCode).toBe(0);
    expect(prettyRes.report.found).toBe(true);
    const found = prettyRes.report as ErrorExplainFoundReport;
    expect(found.code).toBe("BUNEST_E001");
    expect(found.name).toBe(entry.name);
    expect(found.title).toBe(entry.title);
    expect(found.category).toBe("di");
    expect(found.summary).toBe(entry.summary);
    expect(found.explanation).toBe(entry.summary);
    expect(found.firstAction).toBe(entry.fixes[0]!);
    expect(found.fixes).toEqual([...entry.fixes]);
    expect(found.example).toBe(entry.example);
    expect(found.docsPath).toBe("docs/errors.md#bunest_e001");
    expect(found.docsUrl).toBe(getErrorDocsUrl("BUNEST_E001"));

    expect(stdoutPretty).toEqual([prettyRes.formatted]);
    expect(prettyRes.formatted).toContain("[BUNEST_E001] UnknownDependencyException — Unknown dependency");
    expect(prettyRes.formatted).toContain("First action:");
    expect(prettyRes.formatted).toContain(entry.fixes[0]!);
    expect(prettyRes.formatted).toContain("Ordered fixes:");
    expect(prettyRes.formatted).toContain("Example:");
    expect(prettyRes.formatted).toContain("docs/errors.md#bunest_e001");
    expect(prettyRes.formatted).toContain(getErrorDocsUrl("BUNEST_E001"));

    // JSON format
    const jsonRes = await runExplainErrorCommand({
      code: "BUNEST_E001",
      format: "json",
      silent: true,
    });
    expect(jsonRes.exitCode).toBe(0);
    const parsed = JSON.parse(jsonRes.formatted) as ErrorExplainFoundReport;
    expect(parsed).toEqual(found);

    // Agent format
    const agentRes = await runExplainErrorCommand({
      code: "BUNEST_E001",
      format: "agent",
      silent: true,
    });
    expect(agentRes.exitCode).toBe(0);
    expect(agentRes.formatted).toContain("[BUNEST_E001] UnknownDependencyException — Unknown dependency (di)");
    expect(agentRes.formatted).toContain(`firstAction: ${entry.fixes[0]}`);
    expect(agentRes.formatted).toContain("docsPath: docs/errors.md#bunest_e001");
    expect(agentRes.formatted).toContain(`docsUrl: ${getErrorDocsUrl("BUNEST_E001")}`);
    expect(formatErrorExplainReport(found, "agent")).toBe(agentRes.formatted);
  });

  test("omits example when catalog entry has no example and infers routing category for BUNEST_E101", async () => {
    const res = await runExplainErrorCommand({
      code: "BUNEST_E101",
      format: "json",
      silent: true,
    });
    expect(res.exitCode).toBe(0);
    expect(res.report.found).toBe(true);
    const found = res.report as ErrorExplainFoundReport;
    expect(found.code).toBe("BUNEST_E101");
    expect(found.category).toBe("routing");
    expect(found.example).toBeUndefined();
    expect(found.docsPath).toBe("docs/errors.md#bunest_e101");

    const pretty = formatErrorExplainReport(found, "pretty");
    expect(pretty).not.toContain("Example:");
  });

  test("CLI JSON output matches MCP bunest_explain_error payload for the exact same code", async () => {
    for (const code of ["BUNEST_E001", "BUNEST_E101"] as const) {
      const cliRes = await runExplainErrorCommand({
        code,
        format: "json",
        silent: true,
      });
      expect(cliRes.exitCode).toBe(0);
      const cliJson = JSON.parse(cliRes.formatted) as ErrorExplainFoundReport;

      const mcpRes = await handleMcpRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "bunest_explain_error",
          arguments: { code },
        },
      });
      const mcpText = (
        mcpRes?.result as { content: Array<{ type: string; text: string }> }
      ).content[0]!.text;

      // Exact parity between CLI JSON fields and MCP text payload
      expect(mcpText).toContain(`[${cliJson.code}] ${cliJson.name} — ${cliJson.title}`);
      expect(mcpText).toContain(cliJson.summary);
      for (let i = 0; i < cliJson.fixes.length; i++) {
        expect(mcpText).toContain(`${i + 1}. ${cliJson.fixes[i]}`);
      }
      if (cliJson.example) {
        expect(mcpText).toContain(cliJson.example);
      }
      expect(mcpText).toContain(`Docs: ${cliJson.docsUrl}`);
    }
  });

  test("unknown error code BUNEST_E9999 returns exit code 1 with clear message and available codes", async () => {
    const stderrLines: string[] = [];
    const stdoutLines: string[] = [];

    const prettyRes = await runExplainErrorCommand(
      { code: "bunest_e9999", format: "pretty" },
      {
        stdout: (m) => stdoutLines.push(m),
        stderr: (m) => stderrLines.push(m),
      },
    );

    expect(prettyRes.exitCode).toBe(1);
    expect(prettyRes.report.found).toBe(false);
    const notFound = prettyRes.report as ErrorExplainNotFoundReport;
    expect(notFound.code).toBe("BUNEST_E9999");
    expect(notFound.error).toContain("BUNEST_E9999");
    expect(notFound.availableCodes).toEqual(Object.keys(BUNEST_ERROR_CATALOG));
    expect(notFound.availableRange).toBe("BUNEST_E001..BUNEST_E205");
    expect(stdoutLines).toEqual([]);
    expect(stderrLines).toEqual([prettyRes.formatted]);
    expect(prettyRes.formatted).toContain("BUNEST_E9999");
    expect(prettyRes.formatted).toContain("BUNEST_E001");

    // JSON format returns structured not-found report with exitCode 1
    const jsonStdout: string[] = [];
    const jsonRes = await runExplainErrorCommand(
      { code: "BUNEST_E9999", format: "json" },
      {
        stdout: (m) => jsonStdout.push(m),
        stderr: () => {},
      },
    );
    expect(jsonRes.exitCode).toBe(1);
    expect(jsonStdout).toEqual([jsonRes.formatted]);
    expect(JSON.parse(jsonRes.formatted)).toEqual(notFound);

    // Agent format
    const agentRes = await runExplainErrorCommand({
      code: "BUNEST_E9999",
      format: "agent",
      silent: true,
    });
    expect(agentRes.exitCode).toBe(1);
    expect(agentRes.formatted).toContain("error:");
    expect(agentRes.formatted).toContain("BUNEST_E9999");
    expect(agentRes.formatted).toContain("BUNEST_E001..BUNEST_E205");
  });

  test("runExplainRouteCommand continues to work cleanly alongside runExplainErrorCommand", async () => {
    const dir = await createTempProject({
      "src/health.controller.ts": `
        import { Controller, Get } from "@bunest/core";
        @Controller("health")
        export class HealthController {
          @Get()
          check() {
            return { ok: true };
          }
        }
      `,
      "src/app.module.ts": `
        import { Module } from "@bunest/core";
        import { HealthController } from "./health.controller";
        @Module({ controllers: [HealthController] })
        export class AppModule {}
      `,
    });

    const routeRes = await runExplainRouteCommand({
      cwd: dir,
      route: "GET /health",
      format: "json",
      silent: true,
    });
    expect(routeRes.exitCode).toBe(0);
    expect(routeRes.report.matches).toHaveLength(1);
    expect(routeRes.report.matches[0]!.controller.name).toBe("HealthController");

    const errorRes = await runExplainErrorCommand({
      code: "BUNEST_E002",
      format: "json",
      silent: true,
    });
    expect(errorRes.exitCode).toBe(0);
    expect(errorRes.report.found).toBe(true);
    expect((errorRes.report as ErrorExplainFoundReport).name).toBe(
      "CircularDependencyException",
    );
  });
});
