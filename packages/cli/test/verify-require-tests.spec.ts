import { afterAll, describe, expect, test } from "bun:test";
import { join, removePath } from "@bunest/core";
import {
  formatVerifyResult,
  parseTestOutput,
  quoteShellArg,
  runVerifyCommand,
  type VerifyCommandResult,
} from "../src/commands/verify";
import type { CliIO } from "../src/types";

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

describe("bunest verify --require-tests & agent rerun commands", () => {
  const tmpRoot = join(
    Bun.env.TMPDIR ?? "/tmp",
    `bunest-verify-require-${Date.now()}-${crypto.randomUUID()}`,
  );

  afterAll(async () => {
    await removePath(tmpRoot, { recursive: true, force: true });
  });

  test("matching filter with requireTests: true runs tests and exits 0 with passed outcome", async () => {
    const projectDir = join(tmpRoot, "matching-filter-app");
    await writeFixtureFiles(projectDir, {
      "test/orders.spec.ts": `
import { describe, expect, test } from "bun:test";
describe("Orders", () => {
  test("creates order", () => { expect(1 + 1).toBe(2); });
});
`,
    });

    const cap = createCapturedIO(projectDir);
    const res = await runVerifyCommand(
      {
        cwd: projectDir,
        skipTypecheck: true,
        skipCheck: true,
        requireTests: true,
        testFilter: ["orders"],
        reporter: "agent",
      },
      cap.io,
    );

    expect(res.exitCode).toBe(0);
    expect(res.ok).toBe(true);
    const testStep = res.steps.find((s) => s.name === "test")!;
    expect(testStep.status).toBe("pass");
    expect(testStep.outcome).toBe("passed");
    expect(testStep.summary).toContain("1 pass, 0 fail");
    expect(cap.stdout.join("\n")).toContain("VERIFY PASS");
    expect(cap.stdout.join("\n")).toContain("[test] PASS 1 pass, 0 fail");
  });

  test("typo filter with requireTests: true fails consistently across pretty, json, and agent reporters", async () => {
    const projectDir = join(tmpRoot, "typo-filter-app");
    await writeFixtureFiles(projectDir, {
      "test/orders.spec.ts": `
import { expect, test } from "bun:test";
test("orders works", () => { expect(true).toBe(true); });
`,
    });

    for (const reporter of ["pretty", "json", "agent"] as const) {
      const cap = createCapturedIO(projectDir);
      const res = await runVerifyCommand(
        {
          cwd: projectDir,
          skipTypecheck: true,
          skipCheck: true,
          requireTests: true,
          testFilter: ["ordrs"],
          reporter,
        },
        cap.io,
      );

      expect(res.exitCode).toBe(1);
      expect(res.ok).toBe(false);
      const testStep = res.steps.find((s) => s.name === "test")!;
      expect(testStep.status).toBe("fail");
      expect(testStep.outcome).toBe("no-matching-tests");
      expect(testStep.summary.toLowerCase()).toContain("no matching tests found");
      expect(testStep.issues[0]?.code).toBe("VERIFY_NO_TESTS");

      const output = cap.stdout.join("\n");
      if (reporter === "json") {
        const parsed = JSON.parse(output) as VerifyCommandResult;
        expect(parsed.exitCode).toBe(1);
        expect(parsed.ok).toBe(false);
        const jsonTestStep = parsed.steps.find((s) => s.name === "test")!;
        expect(jsonTestStep.status).toBe("fail");
        expect(jsonTestStep.outcome).toBe("no-matching-tests");
        expect(jsonTestStep.summary.toLowerCase()).toContain("no matching tests found");
      } else if (reporter === "agent") {
        expect(output).toContain("VERIFY FAIL");
        expect(output).toContain("[test] FAIL no matching tests found");
        expect(output).toContain("VERIFY_NO_TESTS");
      } else {
        expect(output).toContain("✗ test");
        expect(output.toLowerCase()).toContain("no matching tests found");
        expect(output).toContain("Verification failed: test.");
      }
    }
  });

  test("distinguishes runner/bootstrap errors from no-matching-tests", async () => {
    const projectDir = join(tmpRoot, "runner-error-app");
    await writeFixtureFiles(projectDir, {
      "test/broken.spec.ts": `
import { missing } from "./does-not-exist";
console.log(missing);
`,
    });

    // 1. Real broken import in test file
    const brokenRes = await runVerifyCommand({
      cwd: projectDir,
      skipTypecheck: true,
      skipCheck: true,
      requireTests: true,
      testFilter: ["broken"],
    });
    expect(brokenRes.exitCode).toBe(1);
    expect(brokenRes.ok).toBe(false);
    const brokenStep = brokenRes.steps.find((s) => s.name === "test")!;
    expect(brokenStep.status).toBe("fail");
    expect(brokenStep.outcome).toBe("runner-error");
    expect(brokenStep.summary).toContain("runner/bootstrap error");
    expect(brokenStep.issues[0]?.code).toBe("VERIFY_RUNNER_ERROR");

    // 2. Simulated preload / runner bootstrap crash (0 pass, 0 fail, non-zero exit)
    const preloadRes = await runVerifyCommand({
      cwd: projectDir,
      skipTypecheck: true,
      skipCheck: true,
      requireTests: true,
      spawn: async () => ({
        exitCode: 1,
        stdout: "",
        stderr: 'error: Preload not found "./missing.preload.ts"\n',
      }),
    });
    expect(preloadRes.exitCode).toBe(1);
    const preloadStep = preloadRes.steps.find((s) => s.name === "test")!;
    expect(preloadStep.status).toBe("fail");
    expect(preloadStep.outcome).toBe("runner-error");
    expect(preloadStep.summary).toContain("runner/bootstrap error");
    expect(preloadStep.issues[0]?.message).toContain("Preload not found");
  });

  test("requireTests: true + skipTests: true returns conflict error across all reporters without spawning", async () => {
    let spawnCount = 0;

    for (const reporter of ["pretty", "json", "agent"] as const) {
      const cap = createCapturedIO(tmpRoot);
      const res = await runVerifyCommand(
        {
          cwd: tmpRoot,
          requireTests: true,
          skipTests: true,
          reporter,
          spawn: async () => {
            spawnCount++;
            return { exitCode: 0, stdout: "", stderr: "" };
          },
        },
        cap.io,
      );

      expect(res.exitCode).toBe(1);
      expect(res.ok).toBe(false);
      expect(res.steps.length).toBe(1);
      expect(res.steps[0]!.status).toBe("fail");
      expect(res.steps[0]!.outcome).toBe("config-error");
      expect(res.steps[0]!.issues[0]?.code).toBe("VERIFY_CONFLICTING_FLAGS");

      const output = cap.stdout.join("\n");
      if (reporter === "json") {
        const parsed = JSON.parse(output) as VerifyCommandResult;
        expect(parsed.exitCode).toBe(1);
        expect(parsed.steps[0]!.outcome).toBe("config-error");
      } else if (reporter === "agent") {
        expect(output).toContain("VERIFY FAIL");
        expect(output).toContain("--require-tests");
        expect(output).toContain("--skip-tests");
      } else {
        expect(output).toContain("✗ test");
        expect(output).toContain("--require-tests");
        expect(output).toContain("--skip-tests");
      }
    }

    expect(spawnCount).toBe(0);
  });

  test("default behavior (requireTests omitted) preserves backward compatibility", async () => {
    const projectDir = join(tmpRoot, "default-compat-app");
    await writeFixtureFiles(projectDir, {
      "test/orders.spec.ts": `
import { expect, test } from "bun:test";
test("orders", () => { expect(1).toBe(1); });
`,
    });

    // Typo filter without requireTests -> skip + exit 0
    const typoRes = await runVerifyCommand({
      cwd: projectDir,
      skipTypecheck: true,
      skipCheck: true,
      testFilter: ["ordrs"],
    });
    expect(typoRes.exitCode).toBe(0);
    expect(typoRes.ok).toBe(true);
    const typoStep = typoRes.steps.find((s) => s.name === "test")!;
    expect(typoStep.status).toBe("skip");
    expect(typoStep.summary).toBe("no tests found");

    // Empty "No tests found" output without requireTests -> skip + exit 0
    const emptyRes = await runVerifyCommand({
      cwd: projectDir,
      skipTypecheck: true,
      skipCheck: true,
      spawn: async () => ({
        exitCode: 1,
        stdout: "No tests found!\n",
        stderr: "",
      }),
    });
    expect(emptyRes.exitCode).toBe(0);
    expect(emptyRes.ok).toBe(true);
    expect(emptyRes.steps.find((s) => s.name === "test")!.status).toBe("skip");
  });

  test("agent reporter emits properly quoted copyable rerun command for failing test with spaces in path", async () => {
    const projectDir = join(tmpRoot, "rerun-spaces-app");
    await writeFixtureFiles(projectDir, {
      "my tests/order flow.spec.ts": `
import { describe, expect, test } from "bun:test";
describe("OrderFlow", () => {
  test("creates order", () => { expect(1).toBe(2); });
});
`,
    });

    const cap = createCapturedIO(projectDir);
    const res = await runVerifyCommand(
      {
        cwd: projectDir,
        skipTypecheck: true,
        skipCheck: true,
        reporter: "agent",
      },
      cap.io,
    );

    expect(res.exitCode).toBe(1);
    expect(res.ok).toBe(false);
    const testStep = res.steps.find((s) => s.name === "test")!;
    expect(testStep.status).toBe("fail");
    expect(testStep.outcome).toBe("failed");
    expect(testStep.rerunCommand).toBe('bun test "my tests/order flow.spec.ts"');
    expect(testStep.rerunReason).toBeUndefined();

    const agentOut = cap.stdout.join("\n");
    expect(agentOut).toContain('  rerun: bun test "my tests/order flow.spec.ts"');
  });

  test("agent reporter emits broader rerun command with explicit reason when only case name is known", async () => {
    const res = await runVerifyCommand({
      cwd: tmpRoot,
      skipTypecheck: true,
      skipCheck: true,
      spawn: async () => ({
        exitCode: 1,
        stdout: [
          "error: expect(received).toBe(expected)",
          "Expected: 2",
          "Received: 1",
          "(fail) OrderFlow > creates order [0.31ms]",
          " 0 pass",
          " 1 fail",
        ].join("\n"),
        stderr: "",
      }),
    });

    expect(res.exitCode).toBe(1);
    const testStep = res.steps.find((s) => s.name === "test")!;
    expect(testStep.rerunCommand).toBe('bun test -t "OrderFlow > creates order"');
    expect(testStep.rerunReason).toBeDefined();
    expect(testStep.rerunReason).toContain("broader scope");

    const agentOut = formatVerifyResult(res, "agent");
    expect(agentOut).toContain('  rerun: bun test -t "OrderFlow > creates order"');
    expect(agentOut).toContain("could not be uniquely identified");
  });

  test("parseTestOutput and quoteShellArg handle multiple files and special characters safely", () => {
    expect(quoteShellArg("test/orders.spec.ts")).toBe("test/orders.spec.ts");
    expect(quoteShellArg("my tests/order flow.spec.ts")).toBe(
      '"my tests/order flow.spec.ts"',
    );
    expect(quoteShellArg("test/user's order.spec.ts")).toBe(
      '"test/user\'s order.spec.ts"',
    );
    expect(quoteShellArg("test/$cost/order.spec.ts")).toBe(
      "'test/$cost/order.spec.ts'",
    );

    const parsed = parseTestOutput(
      [
        "test/orders.spec.ts:",
        "(fail) Orders > a [1ms]",
        "my tests\\order flow.spec.ts:",
        "(fail) OrderFlow > b [1ms]",
        " 0 pass",
        " 2 fail",
      ].join("\n"),
      tmpRoot,
    );
    expect(parsed.failedFiles).toEqual([
      "test/orders.spec.ts",
      "my tests/order flow.spec.ts",
    ]);
    expect(parsed.hasUnidentifiedFailureFile).toBe(false);
  });
});
