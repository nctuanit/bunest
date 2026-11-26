import { afterAll, describe, expect, test } from "bun:test";
import { join, removePath } from "@bunest/core";
import {
  formatVerifyResult,
  parseCliArgs,
  runCli,
  runVerifyCommand,
  selectAffectedTests,
  type CliIO,
  type VerifyCommandResult,
} from "../src";

function createCapturedIO(cwd: string): {
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

async function writeFixtureFiles(
  rootDir: string,
  files: Readonly<Record<string, string>>,
): Promise<void> {
  for (const [relPath, content] of Object.entries(files)) {
    const abs = join(rootDir, relPath);
    await Bun.write(abs, content);
  }
}

describe("bunest verify --affected", () => {
  const tmpRoot = join(
    Bun.env.TMPDIR ?? "/tmp",
    `bunest-verify-affected-${Date.now()}-${crypto.randomUUID()}`,
  );

  afterAll(async () => {
    await removePath(tmpRoot, { recursive: true, force: true });
  });

  test("parser recognizes --affected, --base, and --files flags", () => {
    const parsed = parseCliArgs([
      "verify",
      "--affected",
      "--base",
      "origin/main",
      "--files",
      "src/auth/auth.guard.ts,src/orders/orders.service.ts",
      "--reporter=json",
    ]);
    expect(parsed.command).toBe("verify");
    expect(parsed.flags.affected).toBe(true);
    expect(parsed.flags.base).toBe("origin/main");
    expect(parsed.flags.files).toBe(
      "src/auth/auth.guard.ts,src/orders/orders.service.ts",
    );
    expect(parsed.flags.reporter).toBe("json");
  });

  test("editing a shared guard selects tests of ALL consumer modules and skips unrelated module tests", async () => {
    const projectDir = join(tmpRoot, "shared-guard-app");
    await writeFixtureFiles(projectDir, {
      "src/auth/auth.guard.ts": `
export function Injectable() { return () => {}; }
@Injectable()
export class AuthGuard {
  canActivate() { return true; }
}
`,
      "src/orders/orders.controller.ts": `
import { AuthGuard } from "../auth/auth.guard";
function Controller(_p: string) { return () => {}; }
function UseGuards(..._g: unknown[]) { return () => {}; }

@Controller("orders")
@UseGuards(AuthGuard)
export class OrdersController {
  list() { return ["o1"]; }
}
`,
      "src/orders/orders.module.ts": `
import { OrdersController } from "./orders.controller";
function Module(_m: unknown) { return () => {}; }

@Module({ controllers: [OrdersController] })
export class OrdersModule {}
`,
      "src/users/users.controller.ts": `
import { AuthGuard } from "../auth/auth.guard";
function Controller(_p: string) { return () => {}; }
function UseGuards(..._g: unknown[]) { return () => {}; }

@Controller("users")
export class UsersController {
  @UseGuards(AuthGuard)
  profile() { return { id: 1 }; }
}
`,
      "src/users/users.module.ts": `
import { UsersController } from "./users.controller";
function Module(_m: unknown) { return () => {}; }

@Module({ controllers: [UsersController] })
export class UsersModule {}
`,
      "src/health/health.controller.ts": `
function Controller(_p: string) { return () => {}; }

@Controller("health")
export class HealthController {
  ping() { return "ok"; }
}
`,
      "src/health/health.module.ts": `
import { HealthController } from "./health.controller";
function Module(_m: unknown) { return () => {}; }

@Module({ controllers: [HealthController] })
export class HealthModule {}
`,
      "test/orders.spec.ts": `
import { describe, expect, test } from "bun:test";
import { OrdersModule } from "../src/orders/orders.module";
describe("OrdersModule", () => {
  test("defined", () => { expect(OrdersModule).toBeDefined(); });
});
`,
      "test/users.spec.ts": `
import { describe, expect, test } from "bun:test";
import { UsersModule } from "../src/users/users.module";
describe("UsersModule", () => {
  test("defined", () => { expect(UsersModule).toBeDefined(); });
});
`,
      "test/health.spec.ts": `
import { describe, expect, test } from "bun:test";
import { HealthModule } from "../src/health/health.module";
describe("HealthModule", () => {
  test("defined", () => { expect(HealthModule).toBeDefined(); });
});
`,
    });

    const plan = await selectAffectedTests({
      cwd: projectDir,
      changedFiles: ["src/auth/auth.guard.ts"],
    });

    expect(plan.fallbackToFullSuite).toBe(false);
    expect(plan.fallbackReason).toBeUndefined();
    expect(plan.selectedTests.map((t) => t.file)).toEqual([
      "test/orders.spec.ts",
      "test/users.spec.ts",
    ]);
    expect(plan.skippedTestCount).toBe(1);

    const ordersSel = plan.selectedTests.find(
      (t) => t.file === "test/orders.spec.ts",
    )!;
    expect(
      ordersSel.reasons.some(
        (r) => r.includes("AuthGuard") && r.includes("OrdersModule"),
      ),
    ).toBe(true);

    const usersSel = plan.selectedTests.find(
      (t) => t.file === "test/users.spec.ts",
    )!;
    expect(
      usersSel.reasons.some(
        (r) => r.includes("AuthGuard") && r.includes("UsersModule"),
      ),
    ).toBe(true);
  });

  test("deleted/renamed file selects matching reverse importers or falls back safely when unresolvable", async () => {
    const projectDir = join(tmpRoot, "deleted-file-app");
    await writeFixtureFiles(projectDir, {
      "src/orders/orders.service.ts": `
import { legacyDiscount } from "../pricing/old-discount";
export class OrdersService {
  calc(v: number) { return legacyDiscount(v); }
}
`,
      "test/orders.spec.ts": `
import { describe, expect, test } from "bun:test";
import { OrdersService } from "../src/orders/orders.service";
describe("orders", () => {
  test("ok", () => { expect(OrdersService).toBeDefined(); });
});
`,
      "test/health.spec.ts": `
import { describe, expect, test } from "bun:test";
describe("health", () => {
  test("ok", () => { expect(true).toBe(true); });
});
`,
    });

    // Case 1: Deleted file is still imported by relative stem -> selects related test
    const matchedPlan = await selectAffectedTests({
      cwd: projectDir,
      changedFiles: ["src/pricing/old-discount.ts"],
    });
    expect(matchedPlan.fallbackToFullSuite).toBe(false);
    expect(matchedPlan.selectedTests.map((t) => t.file)).toEqual([
      "test/orders.spec.ts",
    ]);
    expect(matchedPlan.skippedTestCount).toBe(1);
    expect(
      matchedPlan.selectedTests[0]!.reasons.some((r) =>
        r.includes("deleted/renamed file src/pricing/old-discount.ts"),
      ),
    ).toBe(true);

    // Case 2: Deleted source file has no resolvable reverse importers -> safe fallback
    const unresolvablePlan = await selectAffectedTests({
      cwd: projectDir,
      changedFiles: ["src/orphan/removed-helper.ts"],
    });
    expect(unresolvablePlan.fallbackToFullSuite).toBe(true);
    expect(unresolvablePlan.fallbackReason).toContain(
      "src/orphan/removed-helper.ts",
    );
    expect(unresolvablePlan.skippedTestCount).toBe(0);
    expect(unresolvablePlan.selectedTests.length).toBe(2);
  });

  test("global config changes and dynamic import(expr) trigger full-suite fallback with explicit reason", async () => {
    const projectDir = join(tmpRoot, "fallback-app");
    await writeFixtureFiles(projectDir, {
      "tsconfig.json": `{"compilerOptions":{"strict":true}}`,
      "bunfig.toml": `[test]\npreload = ["./bunest.preload.ts"]\n`,
      "package.json": `{"name":"fallback-app","version":"0.1.0"}`,
      "src/dynamic-loader.ts": `
export async function loadPlugin(name: string) {
  return import(\`./plugins/\${name}.ts\`);
}
`,
      "test/a.spec.ts": `
import { expect, test } from "bun:test";
test("a", () => { expect(1).toBe(1); });
`,
      "test/b.spec.ts": `
import { expect, test } from "bun:test";
test("b", () => { expect(2).toBe(2); });
`,
    });

    for (const cfgFile of ["tsconfig.json", "bunfig.toml", "package.json"]) {
      const plan = await selectAffectedTests({
        cwd: projectDir,
        changedFiles: [cfgFile],
      });
      expect(plan.fallbackToFullSuite).toBe(true);
      expect(plan.fallbackReason).toContain(cfgFile);
      expect(plan.skippedTestCount).toBe(0);
      expect(plan.selectedTests.length).toBe(2);
    }

    const dynPlan = await selectAffectedTests({
      cwd: projectDir,
      changedFiles: ["src/dynamic-loader.ts"],
    });
    expect(dynPlan.fallbackToFullSuite).toBe(true);
    expect(dynPlan.fallbackReason).toContain("dynamic import");
    expect(dynPlan.fallbackReason).toContain("src/dynamic-loader.ts");
    expect(dynPlan.skippedTestCount).toBe(0);

    // Non-git directory without --files also triggers safe fallback
    const noGitPlan = await selectAffectedTests({
      cwd: projectDir,
    });
    expect(noGitPlan.fallbackToFullSuite).toBe(true);
    expect(noGitPlan.fallbackReason).toContain("git");
  });

  test("end-to-end runCli verify --affected --files produces JSON/pretty output with reasons and runs only selected tests", async () => {
    const projectDir = join(tmpRoot, "e2e-verify-app");
    await writeFixtureFiles(projectDir, {
      "src/math.ts": `export function add(a: number, b: number) { return a + b; }\n`,
      "src/strings.ts": `export function upper(s: string) { return s.toUpperCase(); }\n`,
      "test/math.spec.ts": `
import { expect, test } from "bun:test";
import { add } from "../src/math";
test("add works", () => { expect(add(2, 3)).toBe(5); });
`,
      "test/strings.spec.ts": `
import { expect, test } from "bun:test";
import { upper } from "../src/strings";
test("upper works", () => { expect(upper("hi")).toBe("HI"); });
`,
    });

    // 1. JSON reporter via runCli
    const jsonCap = createCapturedIO(projectDir);
    const jsonCli = await runCli(
      [
        "verify",
        "--affected",
        "--files",
        "src/math.ts",
        "--skip-typecheck",
        "--skip-check",
        "--reporter",
        "json",
      ],
      jsonCap.io,
    );
    expect(jsonCli.exitCode).toBe(0);
    const parsedJson = JSON.parse(
      jsonCap.stdout.join("\n"),
    ) as VerifyCommandResult;
    expect(parsedJson.ok).toBe(true);
    expect(parsedJson.affected).toBeDefined();
    expect(parsedJson.affected!.fallbackToFullSuite).toBe(false);
    expect(parsedJson.affected!.selectedTests.map((t) => t.file)).toEqual([
      "test/math.spec.ts",
    ]);
    expect(parsedJson.affected!.skippedTestCount).toBe(1);
    const testStep = parsedJson.steps.find((s) => s.name === "test")!;
    expect(testStep.status).toBe("pass");
    expect(testStep.summary).toContain("1 pass, 0 fail");

    // 2. Pretty reporter via runCli
    const prettyCap = createCapturedIO(projectDir);
    const prettyCli = await runCli(
      [
        "verify",
        "--affected",
        "--files",
        "src/math.ts",
        "--skip-typecheck",
        "--skip-check",
        "--reporter",
        "pretty",
      ],
      prettyCap.io,
    );
    expect(prettyCli.exitCode).toBe(0);
    const prettyText = prettyCap.stdout.join("\n");
    expect(prettyText).toContain("affected");
    expect(prettyText).toContain("test/math.spec.ts");
    expect(prettyText).toContain("imports changed file src/math.ts");
    expect(prettyText).not.toContain("test/strings.spec.ts");

    // 3. Agent reporter formatting on fallback + default verify without --affected unchanged
    const spawnCalls: string[][] = [];
    const fallbackRes = await runVerifyCommand({
      cwd: projectDir,
      affected: true,
      files: ["package.json"],
      skipTypecheck: true,
      skipCheck: true,
      spawn: async (cmd) => {
        spawnCalls.push(cmd);
        return { exitCode: 0, stdout: " 2 pass\n 0 fail\n", stderr: "" };
      },
    });
    expect(fallbackRes.ok).toBe(true);
    expect(fallbackRes.affected?.fallbackToFullSuite).toBe(true);
    // Full suite fallback invokes `bun test` with no restricted file args
    expect(spawnCalls[0]!.slice(1)).toEqual(["test"]);
    const agentText = formatVerifyResult(fallbackRes, "agent");
    expect(agentText).toContain("[affected] FALLBACK full suite");
    expect(agentText).toContain("package.json");

    // Default verify (without --affected) omits affected metadata
    const defaultRes = await runVerifyCommand({
      cwd: projectDir,
      skipTypecheck: true,
      skipCheck: true,
      spawn: async () => ({
        exitCode: 0,
        stdout: " 2 pass\n 0 fail\n",
        stderr: "",
      }),
    });
    expect(defaultRes.affected).toBeUndefined();
  });
});
