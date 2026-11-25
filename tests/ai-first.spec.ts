import { describe, expect, it } from "bun:test";
import {
  AmbiguousProviderException,
  BUNEST_ERROR_CATALOG,
  CircularDependencyException,
  CoreBootstrapException,
  DuplicateProviderException,
  Injectable,
  InvalidExportException,
  InvalidModuleException,
  Module,
  Scope,
  ScopeLeakException,
  UnknownDependencyException,
  formatBunestErrorForAgent,
  getErrorCatalogEntry,
  toBunestErrorReport,
} from "../packages/core/src";
import {
  DuplicateRouteException,
  InvalidControllerException,
  InvalidRouteException,
} from "../packages/core/src/http";
import {
  parseTestOutput,
  parseTypecheckOutput,
  runVerifyCommand,
  type VerifySpawn,
} from "../packages/cli/src";
import { buildProjectTemplateFiles } from "../packages/cli/src/templates/project.templates";
import { Test } from "../packages/testing/src";
import { REPO_ROOT, buildAllAiDocs } from "../scripts/ai-docs";

describe("AI-first: error catalog", () => {
  const samples: Array<[Error & { code?: string }, string]> = [
    [new UnknownDependencyException({ requester: "A", token: class B {}, moduleName: "M", index: 0 }), "BUNEST_E001"],
    [new CircularDependencyException({ chain: ["A", "B", "A"], kind: "provider" }), "BUNEST_E002"],
    [new ScopeLeakException([{ name: "A", scope: Scope.SINGLETON }, { name: "B", scope: Scope.REQUEST }]), "BUNEST_E003"],
    [new AmbiguousProviderException({ token: "T", moduleName: "M", conflictingModules: ["X", "Y"], source: "imports" }), "BUNEST_E004"],
    [new InvalidModuleException(class NotAModule {}), "BUNEST_E005"],
    [new DuplicateProviderException("T", "M"), "BUNEST_E006"],
    [new InvalidExportException("T", "M", "not provided"), "BUNEST_E007"],
    [
      new DuplicateRouteException({
        method: "GET",
        path: "/a",
        canonicalPath: "/a",
        existingPath: "/a",
        existingController: "C1",
        attemptedController: "C2",
      }),
      "BUNEST_E101",
    ],
    [new InvalidControllerException("C"), "BUNEST_E102"],
    [new InvalidRouteException("bad"), "BUNEST_E103"],
  ];

  it("every exception carries its stable code and the catalog names match", () => {
    for (const [err, code] of samples) {
      expect(err.code).toBe(code);
      expect(getErrorCatalogEntry(code)?.name).toBe(err.name);
    }
    expect(samples.map(([, c]) => c).sort()).toEqual(Object.keys(BUNEST_ERROR_CATALOG).sort());
  });

  it("produces a JSON-safe report with ordered fixes, docs link and details", () => {
    const err = samples[0]![0];
    const report = toBunestErrorReport(err)!;
    expect(report.code).toBe("BUNEST_E001");
    expect(report.fixes.length).toBeGreaterThan(1);
    expect(report.docs).toEndWith("docs/errors.md#bunest_e001");
    expect(report.details).toMatchObject({ requester: "A", moduleName: "M", token: "B", index: 0 });
    // toJSON → JSON.stringify works and round-trips
    expect(JSON.parse(JSON.stringify(err)).code).toBe("BUNEST_E001");
  });

  it("formats compact agent output and falls back for foreign errors", () => {
    const text = formatBunestErrorForAgent(samples[1]![0]);
    expect(text.split("\n")[0]).toStartWith("[BUNEST_E002] Circular dependency:");
    expect(text).toContain("fix 1:");
    expect(text).toContain("docs: ");
    expect(formatBunestErrorForAgent(new TypeError("boom"))).toBe("TypeError: boom");
    expect(toBunestErrorReport(new Error("x"))).toBeUndefined();
    expect(new CoreBootstrapException("legacy").code).toBeUndefined();
  });

  it("real bootstrap failure surfaces BUNEST_E001", async () => {
    class MissingDep {}
    @Injectable()
    class NeedsDep {
      constructor(readonly dep: MissingDep) {}
    }
    @Module({ providers: [NeedsDep] })
    class BrokenModule {}

    let caught: unknown;
    try {
      await Test.createTestingModule({ imports: [BrokenModule] }).compile();
    } catch (error) {
      caught = error;
    }
    expect((caught as { code?: string }).code).toBe("BUNEST_E001");
    expect(formatBunestErrorForAgent(caught)).toContain("[BUNEST_E001]");
  });
});

describe("AI-first: generated docs", () => {
  it("docs/errors.md, llms.txt and llms-full.txt are up to date (run `bun run ai:docs`)", async () => {
    const outputs = await buildAllAiDocs();
    for (const [rel, content] of Object.entries(outputs)) {
      const actual = (await Bun.file(`${REPO_ROOT}/${rel}`).text()).replace(
        /\r\n/g,
        "\n",
      );
      expect({ rel, fresh: actual === content }).toEqual({ rel, fresh: true });
    }
    for (const code of Object.keys(BUNEST_ERROR_CATALOG)) {
      expect(outputs["docs/errors.md"]).toContain(`## ${code}`);
    }
    expect(outputs["llms-full.txt"]).toContain("### `@bunest/core`");
    expect(outputs["llms-full.txt"]).toContain("BunestFactory");
  });

  it("scaffolded projects ship an AGENTS.md and a verify script", () => {
    const files = buildProjectTemplateFiles("demo");
    const agents = files.find((f) => f.relativePath === "AGENTS.md");
    expect(agents?.content).toContain("bunest verify --reporter=agent");
    const pkg = JSON.parse(files.find((f) => f.relativePath === "package.json")!.content);
    expect(pkg.scripts.verify).toBe("bunest verify --reporter=agent");
  });
});

describe("AI-first: bunest verify", () => {
  const cwd = "/proj";

  it("parses tsc-style and pretty `bun check` output", () => {
    const issues = parseTypecheckOutput(
      [
        "src/a.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.",
        "error: TS2304: Cannot find name 'foo'.",
        "    at /proj/src/b.ts:3:5",
        "Found 2 errors",
      ].join("\n"),
      cwd,
    );
    expect(issues).toEqual([
      { file: "src/a.ts", line: 1, column: 14, code: "TS2322", severity: "error", message: "Type 'string' is not assignable to type 'number'." },
      { file: "src/b.ts", line: 3, column: 5, code: "TS2304", severity: "error", message: "Cannot find name 'foo'." },
    ]);
  });

  it("parses `bun test` failures with expected/received and location", () => {
    const parsed = parseTestOutput(
      [
        "test/app.spec.ts:",
        "(pass) ok [0.10ms]",
        "error: expect(received).toBe(expected)",
        "",
        "Expected: 3",
        "Received: 2",
        "",
        "      at <anonymous> (/proj/test/app.spec.ts:2:32)",
        "(fail) math > adds [0.20ms]",
        "",
        " 1 pass",
        " 1 fail",
      ].join("\n"),
      cwd,
    );
    expect(parsed.pass).toBe(1);
    expect(parsed.fail).toBe(1);
    expect(parsed.failures).toEqual([
      {
        severity: "error",
        message: "math > adds — expect(received).toBe(expected); expected: 3; received: 2",
        file: "test/app.spec.ts",
        line: 2,
        column: 32,
      },
    ]);
  });

  it("runs steps via injected spawn and renders a compact agent report", async () => {
    const calls: string[][] = [];
    const spawn: VerifySpawn = async (cmd) => {
      calls.push(cmd.slice(1));
      if (cmd[1] === "check") {
        return { exitCode: 1, stdout: "src/a.ts(2,3): error TS2322: Bad.\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "(pass) a\n 3 pass\n 0 fail\n" };
    };
    const lines: string[] = [];
    const result = await runVerifyCommand(
      { cwd, reporter: "agent", skipCheck: true, testFilter: ["test/a.spec.ts"], spawn },
      { cwd, stdout: (m) => lines.push(m), stderr: (m) => lines.push(m) },
    );

    expect(calls).toEqual([["check"], ["test", "test/a.spec.ts"]]);
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.steps.map((s) => [s.name, s.status])).toEqual([
      ["typecheck", "fail"],
      ["check", "skip"],
      ["test", "pass"],
    ]);
    const out = lines.join("\n");
    expect(out).toStartWith("VERIFY FAIL");
    expect(out).toContain("  src/a.ts:2:3 [TS2322] Bad.");
    expect(out).toContain("[test] PASS 3 pass, 0 fail");
    expect(out).toContain("NEXT: fix [typecheck] first");
  });

  it("treats `No tests found` as skip, not failure", async () => {
    const spawn: VerifySpawn = async (cmd) =>
      cmd[1] === "check"
        ? { exitCode: 0, stdout: "", stderr: "" }
        : { exitCode: 1, stdout: "", stderr: "No tests found!\n" };
    const result = await runVerifyCommand({ cwd, skipCheck: true, spawn });
    expect(result.ok).toBe(true);
    expect(result.steps[2]?.status).toBe("skip");
  });
});
