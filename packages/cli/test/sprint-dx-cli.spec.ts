import {
  BUNEST_ERROR_CATALOG,
  join,
  mkdirSyncPath,
  removePath,
  writeTextSync,
} from "@bunest/core";
import { afterEach, describe, expect, it } from "bun:test";
import {
  diffRouteManifests,
  runCli,
  type CliIO,
  type ErrorExplainFoundReport,
  type ExtendedEnvironmentInfo,
  type RouteDiffReport,
} from "../src";

const TMP_DIR = Bun.env.TMPDIR ?? Bun.env.TEMP ?? "/tmp";
const tempDirs: string[] = [];

function makeTempProject(prefix: string): string {
  const dir = join(
    TMP_DIR,
    `bunest-sprint-dx-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSyncPath(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

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

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      await removePath(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors on Windows
    }
  }
});

describe("Sprint DX CLI Integration (Wave B)", () => {
  it("verify --require-tests fails on typo filter (exit 1) and passes on valid filter (exit 0)", async () => {
    const dir = makeTempProject("verify");
    mkdirSyncPath(join(dir, "test"), { recursive: true });
    writeTextSync(
      join(dir, "test", "orders.spec.ts"),
      `import { expect, test } from "bun:test";
test("orders smoke", () => {
  expect(1 + 1).toBe(2);
});
`,
    );

    const typoCap = createCapturedIO(dir);
    const typoRes = await runCli(
      [
        "verify",
        "nonexistent-typo-filter",
        "--require-tests",
        "--skip-typecheck",
        "--skip-check",
        "--reporter",
        "json",
      ],
      typoCap.io,
    );
    expect(typoRes.exitCode).toBe(1);
    const typoJson = JSON.parse(typoCap.stdout.join("\n")) as {
      ok: boolean;
      steps: Array<{ name: string; status: string; outcome?: string }>;
    };
    expect(typoJson.ok).toBe(false);
    const typoTestStep = typoJson.steps.find((s) => s.name === "test");
    expect(typoTestStep?.status).toBe("fail");
    expect(typoTestStep?.outcome).toBe("no-matching-tests");

    const validCap = createCapturedIO(dir);
    const validRes = await runCli(
      [
        "verify",
        "orders.spec.ts",
        "--require-tests",
        "--skip-typecheck",
        "--skip-check",
        "--reporter",
        "json",
      ],
      validCap.io,
    );
    expect(validRes.exitCode).toBe(0);
    const validJson = JSON.parse(validCap.stdout.join("\n")) as {
      ok: boolean;
      steps: Array<{ name: string; status: string; outcome?: string }>;
    };
    expect(validJson.ok).toBe(true);
    const validTestStep = validJson.steps.find((s) => s.name === "test");
    expect(validTestStep?.status).toBe("pass");
    expect(validTestStep?.outcome).toBe("passed");
  });

  it("explain error BUNEST_E001 --format json matches catalog and BUNEST_E9999 exits 1", async () => {
    const okCap = createCapturedIO();
    const okRes = await runCli(
      ["explain", "error", "BUNEST_E001", "--format", "json"],
      okCap.io,
    );
    expect(okRes.exitCode).toBe(0);
    const parsed = JSON.parse(okCap.stdout.join("\n")) as ErrorExplainFoundReport;
    const expected = BUNEST_ERROR_CATALOG.BUNEST_E001;
    expect(parsed.found).toBe(true);
    expect(parsed.code).toBe(expected.code);
    expect(parsed.name).toBe(expected.name);
    expect(parsed.title).toBe(expected.title);
    expect(parsed.fixes).toEqual([...expected.fixes]);
    expect(parsed.firstAction).toBe(expected.fixes[0]);

    const badCap = createCapturedIO();
    const badRes = await runCli(
      ["explain", "error", "BUNEST_E9999"],
      badCap.io,
    );
    expect(badRes.exitCode).toBe(1);
    expect(badCap.stderr.join("\n")).toContain("BUNEST_E9999");
  });

  it("info --format json includes resolvedPackages", async () => {
    const dir = makeTempProject("info");
    mkdirSyncPath(join(dir, "node_modules", "@bunest", "core"), {
      recursive: true,
    });
    writeTextSync(
      join(dir, "package.json"),
      JSON.stringify(
        {
          name: "demo-app",
          dependencies: {
            "@bunest/core": "^0.1.0",
            "@bunest/missing-pkg": "^0.1.0",
          },
        },
        null,
        2,
      ),
    );
    writeTextSync(
      join(dir, "node_modules", "@bunest", "core", "package.json"),
      JSON.stringify({ name: "@bunest/core", version: "0.1.9" }, null, 2),
    );

    const cap = createCapturedIO(dir);
    const res = await runCli(["info", "--format", "json"], cap.io);
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(cap.stdout.join("\n")) as ExtendedEnvironmentInfo;
    expect(Array.isArray(parsed.resolvedPackages)).toBe(true);
    const core = parsed.resolvedPackages?.find((p) => p.name === "@bunest/core");
    expect(core?.resolved).toBe("0.1.9");
    expect(core?.declared).toBe("^0.1.0");
    expect(core?.status).toBe("installed");

    const missing = parsed.resolvedPackages?.find(
      (p) => p.name === "@bunest/missing-pkg",
    );
    expect(missing?.resolved).toBeNull();
    expect(missing?.status).toBe("missing");
  });

  it("routes diff --base <manifest> detects added, removed, paramRenamed (:id -> :orderId), versionChanged, and unknowns", async () => {
    const dir = makeTempProject("routes-diff");
    mkdirSyncPath(join(dir, "src"), { recursive: true });
    writeTextSync(
      join(dir, "src", "orders.controller.ts"),
      `const DYNAMIC_PATH = "/dynamic";

function Controller(_path?: string) { return (_t: any) => {}; }
function Get(_path?: string) { return (_t: any, _k: any) => {}; }
function Post(_path?: string) { return (_t: any, _k: any) => {}; }
function Version(_v: string) { return (_t: any, _k?: any) => {}; }

@Controller("orders")
export class OrdersController {
  @Get(":orderId")
  findOne() {}

  @Post()
  create() {}

  @Version("2")
  @Get("stats")
  stats() {}

  @Get(DYNAMIC_PATH)
  dynamicEndpoint() {}
}
`,
    );

    const baseManifest = {
      routes: [
        { method: "GET", path: "/orders/:id" },
        { method: "DELETE", path: "/orders/:id" },
        { method: "GET", path: "/orders/stats", version: "1" },
      ],
    };
    const manifestPath = join(dir, "base-routes.json");
    writeTextSync(manifestPath, JSON.stringify(baseManifest, null, 2));

    const cap = createCapturedIO(dir);
    const res = await runCli(
      ["routes", "diff", "--base", "base-routes.json", "--format", "json"],
      cap.io,
    );
    expect(res.exitCode).toBe(0);
    const report = JSON.parse(cap.stdout.join("\n")) as RouteDiffReport;
    expect(report.hasChanges).toBe(true);
    expect(report.added.some((r) => r.method === "POST" && r.path === "/orders")).toBe(true);
    expect(
      report.removed.some((r) => r.method === "DELETE" && r.path === "/orders/:id"),
    ).toBe(true);
    expect(report.paramRenamed).toHaveLength(1);
    expect(report.paramRenamed[0]?.fromPath).toBe("/orders/:id");
    expect(report.paramRenamed[0]?.toPath).toBe("/orders/:orderId");
    expect(report.paramRenamed[0]?.paramRenames).toEqual([
      { segmentIndex: 1, from: "id", to: "orderId" },
    ]);
    expect(report.versionChanged).toHaveLength(1);
    expect(report.versionChanged[0]?.fromVersion).toBe("1");
    expect(report.versionChanged[0]?.toVersion).toBe("2");
    expect(report.unknowns.length).toBeGreaterThanOrEqual(1);

    // Direct programmatic diffRouteManifests check
    const direct = diffRouteManifests(
      [{ method: "GET", path: "/orders/:id" }],
      [{ method: "GET", path: "/orders/:orderId" }],
    );
    expect(direct.paramRenamed).toHaveLength(1);
    expect(direct.added).toHaveLength(0);
    expect(direct.removed).toHaveLength(0);
  });

  it("suggests closest command on typo without auto-executing, and prints help hint on ambiguous/distant input", async () => {
    const typoCap = createCapturedIO();
    const typoRes = await runCli(["verfiy"], typoCap.io);
    expect(typoRes.exitCode).toBe(1);
    expect(typoCap.stdout).toEqual([]);
    expect(typoCap.stderr.join("\n")).toBe(
      'Unknown command "verfiy". Did you mean "bunest verify"?',
    );

    const randomCap = createCapturedIO();
    const randomRes = await runCli(["completely-bogus-xyz"], randomCap.io);
    expect(randomRes.exitCode).toBe(1);
    expect(randomCap.stderr.join("\n")).toContain('Run "bunest --help"');
    expect(randomCap.stderr.join("\n")).not.toContain("Did you mean");

    // Ambiguous 2-char input ("gg" is distance 1 from both "g" and "tg")
    const ambigCap = createCapturedIO();
    const ambigRes = await runCli(["gg"], ambigCap.io);
    expect(ambigRes.exitCode).toBe(1);
    expect(ambigCap.stderr.join("\n")).toContain('Run "bunest --help"');
    expect(ambigCap.stderr.join("\n")).not.toContain("Did you mean");
  });
});
