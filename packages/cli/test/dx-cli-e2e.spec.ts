import { afterAll, describe, expect, test } from "bun:test";
import { existsSyncPath, join, removePath } from "@bunest/core";
import {
  runCli,
  type CliIO,
  type CreateProjectResult,
  type GenerateSchematicResult,
  type RouteExplainReport,
} from "../src";

function createCapturedIO(cwd?: string): {
  io: CliIO;
  stdout: string[];
  stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      cwd,
      stdout: (msg) => stdout.push(msg),
      stderr: (msg) => stderr.push(msg),
    },
  };
}

describe("P0 DX CLI E2E workflows (new --preset, generate --with-scenario, explain route, test-from-request)", () => {
  const tmpRoot = join(
    Bun.env.TMPDIR ?? "/tmp",
    `bunest-dx-e2e-${Date.now()}-${crypto.randomUUID()}`,
  );
  const projectDir = join(tmpRoot, "orders-api");

  afterAll(async () => {
    await removePath(tmpRoot, { recursive: true, force: true });
  });

  test("new --preset rest-sqlite scaffolds starter project and rejects unknown presets", async () => {
    const okCap = createCapturedIO(tmpRoot);
    const okRes = await runCli(
      [
        "new",
        "orders-api",
        "--preset",
        "rest-sqlite",
        "--skip-install",
        "--skip-git",
        "--dir",
        projectDir,
      ],
      okCap.io,
    );
    expect(okRes.exitCode).toBe(0);
    const created = okRes.output as CreateProjectResult;
    expect(created.preset).toBe("rest-sqlite");
    expect(existsSyncPath(join(projectDir, "src", "main.ts"))).toBe(true);
    expect(existsSyncPath(join(projectDir, "src", "app.module.ts"))).toBe(true);
    expect(existsSyncPath(join(projectDir, "bunest.json"))).toBe(true);

    const badCap = createCapturedIO(tmpRoot);
    const badRes = await runCli(
      [
        "new",
        "bad-api",
        "--preset",
        "unknown-preset",
        "--skip-install",
        "--dir",
        join(tmpRoot, "bad-api"),
      ],
      badCap.io,
    );
    expect(badRes.exitCode).toBe(1);
    expect(badCap.stderr.join("\n")).toContain('Invalid --preset "unknown-preset"');
    expect(existsSyncPath(join(tmpRoot, "bad-api"))).toBe(false);
  });

  test("generate resource orders --with-scenario supports dry-run preview and real write", async () => {
    const dryCap = createCapturedIO(projectDir);
    const dryRes = await runCli(
      ["generate", "resource", "orders", "--with-scenario", "--dry-run"],
      dryCap.io,
    );
    expect(dryRes.exitCode).toBe(0);
    const dryOut = dryRes.output as GenerateSchematicResult;
    expect(dryOut.dryRun).toBe(true);

    const dryPaths = dryOut.files.map((f) => f.relativePath.replace(/\\/g, "/"));
    expect(dryPaths.some((p) => p.endsWith(".http"))).toBe(true);
    expect(dryPaths.some((p) => p.endsWith(".spec.ts"))).toBe(true);
    expect(
      (dryOut.plannedUpdates ?? []).some((u) => u.includes("app.module.ts")),
    ).toBe(true);
    expect(existsSyncPath(join(projectDir, "src", "orders"))).toBe(false);

    const writeCap = createCapturedIO(projectDir);
    const writeRes = await runCli(
      ["generate", "resource", "orders", "--with-scenario"],
      writeCap.io,
    );
    expect(writeRes.exitCode).toBe(0);
    const writeOut = writeRes.output as GenerateSchematicResult;
    expect(writeOut.dryRun).toBe(false);

    const httpFile = writeOut.files.find((f) =>
      f.relativePath.replace(/\\/g, "/").endsWith(".http"),
    );
    const specFile = writeOut.files.find((f) =>
      f.relativePath.replace(/\\/g, "/").endsWith(".spec.ts"),
    );
    expect(httpFile).toBeDefined();
    expect(specFile).toBeDefined();
    expect(existsSyncPath(httpFile!.path)).toBe(true);
    expect(existsSyncPath(specFile!.path)).toBe(true);

    const appModuleText = await Bun.file(
      join(projectDir, "src", "app.module.ts"),
    ).text();
    expect(appModuleText).toContain("OrdersModule");
  });

  test('explain route "POST /orders" --format json returns schemaVersion 1.0 report', async () => {
    const jsonCap = createCapturedIO(projectDir);
    const jsonRes = await runCli(
      ["explain", "route", "POST /orders", "--format", "json"],
      jsonCap.io,
    );
    expect(jsonRes.exitCode).toBe(0);

    const report = JSON.parse(jsonCap.stdout.join("\n")) as RouteExplainReport;
    expect(report.schemaVersion).toBe("1.0");
    expect(report.matches.length).toBeGreaterThanOrEqual(1);
    expect(report.matches[0]!.method).toBe("POST");
    expect(report.matches[0]!.path).toBe("/orders");
    expect(report.matches[0]!.controller.name).toBe("OrdersController");

    const agentCap = createCapturedIO(projectDir);
    const agentRes = await runCli(
      ["explain", "route", "POST /orders", "--format", "agent", "--version", "1"],
      agentCap.io,
    );
    expect(agentRes.exitCode).toBe(0);
    expect(agentCap.stdout.join("\n")).toContain("POST /orders");
  });

  test("test-from-request <orders.http> --dry-run --format json returns sanitized plan with zero disk writes", async () => {
    const customHttpPath = join(projectDir, "src", "orders", "orders-auth.http");
    await Bun.write(
      customHttpPath,
      [
        "### Create order with auth (201)",
        "POST http://localhost:3000/orders",
        "Content-Type: application/json",
        "Authorization: Bearer super-secret-live-token",
        "",
        '{"item": "widget", "quantity": 2}',
        "",
      ].join("\n"),
    );

    const plannedOutPath = "test/orders-auth.regression.spec.ts";
    const cap = createCapturedIO(projectDir);
    const res = await runCli(
      [
        "test-from-request",
        "src/orders/orders-auth.http",
        "--dry-run",
        "--format",
        "json",
        "--out",
        plannedOutPath,
      ],
      cap.io,
    );
    expect(res.exitCode).toBe(0);

    const parsed = JSON.parse(cap.stdout.join("\n")) as {
      schemaVersion: string;
      dryRun: boolean;
      files: Array<{ relativePath: string; action: string }>;
      sanitized: Array<{ location: string; path: string; replacement: string }>;
    };
    expect(parsed.schemaVersion).toBe("1.0");
    expect(parsed.dryRun).toBe(true);
    expect(parsed.files[0]?.relativePath).toBe(plannedOutPath);
    expect(parsed.sanitized.length).toBeGreaterThanOrEqual(1);
    expect(
      parsed.sanitized.some((s) => s.path.toLowerCase() === "authorization"),
    ).toBe(true);
    expect(existsSyncPath(join(projectDir, plannedOutPath))).toBe(false);

    const diffCap = createCapturedIO(projectDir);
    const diffRes = await runCli(
      [
        "test-from-request",
        "src/orders/orders-auth.http",
        "--dry-run",
        "--format",
        "diff",
      ],
      diffCap.io,
    );
    expect(diffRes.exitCode).toBe(0);
    expect(diffCap.stdout.join("\n")).toContain("FIXTURE_AUTH_TOKEN");
    expect(diffCap.stdout.join("\n")).not.toContain("super-secret-live-token");
  });
});
