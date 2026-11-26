import { relative, resolve } from "@bunest/core";
import {
  selectAffectedTests,
  type AffectedTestsPlan,
} from "../analyzer/affected-tests";
import type { CliIO } from "../types";
import { runCheckCommand } from "./check";

/**
 * `bunest verify` — one command that runs the full self-verification loop a
 * coding agent needs after editing code: typecheck → static diagnostics → tests.
 *
 * The `agent` reporter prints only actionable lines (file:line:col + message +
 * hint) and caps output so it stays cheap in an LLM context window.
 */

export type VerifyReporter = "agent" | "pretty" | "json";
export type VerifyStepName = "typecheck" | "check" | "test";
export type VerifyStepStatus = "pass" | "fail" | "skip";
export type VerifyTestOutcome =
  | "passed"
  | "failed"
  | "no-matching-tests"
  | "runner-error"
  | "skipped"
  | "config-error";

export interface VerifyIssue {
  readonly file?: string;
  readonly line?: number;
  readonly column?: number;
  readonly code?: string;
  readonly severity: "error" | "warning" | "info";
  readonly message: string;
  readonly hint?: string;
}

export interface VerifyStepResult {
  readonly name: VerifyStepName;
  readonly status: VerifyStepStatus;
  readonly summary: string;
  readonly issues: readonly VerifyIssue[];
  readonly durationMs: number;
  /** Structured outcome for the `test` step (distinguishes no-matching-tests vs passed vs runner-error). */
  readonly outcome?: VerifyTestOutcome;
  /** Copyable rerun command for failing tests (when tests fail). */
  readonly rerunCommand?: string;
  /** Reason a broader rerun command was emitted instead of a single file. */
  readonly rerunReason?: string;
}

export interface VerifyCommandResult {
  readonly exitCode: number;
  readonly ok: boolean;
  readonly steps: readonly VerifyStepResult[];
  readonly durationMs: number;
  readonly affected?: AffectedTestsPlan;
}

export interface CapturedProcess {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type VerifySpawn = (
  cmd: string[],
  options: { cwd: string },
) => Promise<CapturedProcess>;

export interface VerifyCommandOptions {
  readonly cwd?: string;
  readonly reporter?: VerifyReporter;
  readonly skipTypecheck?: boolean;
  readonly skipCheck?: boolean;
  readonly skipTests?: boolean;
  /** Fail when no matching tests are executed (e.g. typo in test filter or empty suite). */
  readonly requireTests?: boolean;
  /** Passed through to `bun test` as a path/name filter. */
  readonly testFilter?: readonly string[];
  /** Select only tests affected by changed files (with explicit reasons). */
  readonly affected?: boolean;
  /** Git base ref used with `--affected` (e.g. `origin/main`, `HEAD~1`). */
  readonly base?: string;
  /** Explicit changed file list used with `--affected` (skips git diff). */
  readonly files?: readonly string[];
  readonly sourceRoot?: string;
  readonly config?: string;
  /** Treat static-analysis warnings as failures. */
  readonly strict?: boolean;
  /** Max issues printed per step by the agent reporter (default 20). */
  readonly maxIssues?: number;
  readonly spawn?: VerifySpawn;
}

const defaultSpawn: VerifySpawn = async (cmd, { cwd }) => {
  const proc = Bun.spawn(cmd, {
    cwd,
    env: { ...Bun.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
};

const ANSI_RE = /\u001b\[[0-9;]*m/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

function toRel(cwd: string, file: string): string {
  const abs = resolve(cwd, file);
  const rel = relative(cwd, abs).replace(/\\/g, "/");
  return rel.startsWith("..") ? file.replace(/\\/g, "/") : rel;
}

/**
 * Parses `bun check` output:
 * ```
 * error: TS2322: Type 'string' is not assignable to type 'number'.
 *     at /abs/file.ts:1:7
 * ```
 */
export function parseTypecheckOutput(output: string, cwd: string): VerifyIssue[] {
  const lines = stripAnsi(output).split(/\r?\n/);
  const issues: VerifyIssue[] = [];
  for (let i = 0; i < lines.length; i++) {
    // Non-TTY (tsc-style): `src/a.ts(1,14): error TS2322: message`
    const tsc = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/.exec(
      lines[i]!.trim(),
    );
    if (tsc) {
      issues.push({
        file: toRel(cwd, tsc[1]!),
        line: Number(tsc[2]),
        column: Number(tsc[3]),
        code: tsc[5],
        severity: tsc[4] === "warning" ? "warning" : "error",
        message: tsc[6]!.trim(),
      });
      continue;
    }
    // TTY (pretty): `error: TS2322: message` followed by `    at /abs/file.ts:1:7`
    const m = /^(error|warning): (?:(TS\d+): )?(.*)$/.exec(lines[i]!.trim());
    if (!m) continue;
    let file: string | undefined;
    let line: number | undefined;
    let column: number | undefined;
    for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
      const at = /^\s*at (.+):(\d+):(\d+)\s*$/.exec(lines[j]!);
      if (at) {
        file = toRel(cwd, at[1]!);
        line = Number(at[2]);
        column = Number(at[3]);
        break;
      }
    }
    issues.push({
      file,
      line,
      column,
      code: m[2],
      severity: m[1] === "warning" ? "warning" : "error",
      message: m[3]!.trim(),
    });
  }
  return issues;
}

export interface ParsedTestOutput {
  readonly pass: number;
  readonly fail: number;
  readonly skip: number;
  readonly noTests: boolean;
  readonly failures: readonly VerifyIssue[];
  readonly failedFiles: readonly string[];
  readonly failedCases: readonly string[];
  readonly hasUnidentifiedFailureFile: boolean;
}

const TEST_FILE_HEADER_RE =
  /^([^\s].*(?:\.(?:test|spec)|_(?:test|spec)_)\.[cm]?[jt]sx?):\s*$/i;
const TEST_FILE_PATH_RE =
  /(?:\.(?:test|spec)|_(?:test|spec)_)\.[cm]?[jt]sx?$/i;
const AT_PAREN_RE =
  /^\s*at .*?\(((?:[A-Za-z]:[\\/]|\/|\.)?[^():]+\.(?:[cm]?[jt]sx?)):(\d+):(\d+)\)\s*$/;
const AT_BARE_RE =
  /^\s*at ((?:[A-Za-z]:[\\/]|\/|\.)[^():]+\.(?:[cm]?[jt]sx?)):(\d+):(\d+)\s*$/;

function parseTestFileHeader(line: string, cwd: string): string | undefined {
  if (
    /^(?:error|Error|TypeError|ReferenceError|AssertionError|Expected|Received|at |\(pass\)|\(fail\)|\(skip\)|#|\d+\s*\|)/.test(
      line,
    )
  ) {
    return undefined;
  }
  const m = TEST_FILE_HEADER_RE.exec(line);
  if (!m) return undefined;
  return toRel(cwd, m[1]!);
}

/**
 * Quotes a CLI argument so it can be safely copy-pasted into both POSIX shells
 * (`sh`/`bash`/`zsh`) and PowerShell (and `cmd.exe` when free of `$`/`"`/`\``).
 */
export function quoteShellArg(arg: string): string {
  if (arg.length === 0) return '""';
  if (/^[A-Za-z0-9_./:@+-]+$/.test(arg)) return arg;
  if (!/["$`\\]/.test(arg)) return `"${arg}"`;
  if (!arg.includes("'")) return `'${arg}'`;
  return `"${arg.replace(/([\\"`$])/g, "\\$1")}"`;
}

/** Parses `bun test` summary + `(fail)` lines and nearest `at file:line:col`. */
export function parseTestOutput(output: string, cwd: string): ParsedTestOutput {
  const text = stripAnsi(output);
  const lines = text.split(/\r?\n/);
  const count = (label: string) => {
    const m = new RegExp(`^\\s*(\\d+) ${label}\\b`, "m").exec(text);
    return m ? Number(m[1]) : 0;
  };

  const failures: VerifyIssue[] = [];
  const failedFileSet = new Set<string>();
  const failedCases: string[] = [];
  let hasUnidentifiedFailureFile = false;
  let currentTestFile: string | undefined;
  let pendingError: string | undefined;
  let pendingAt: { file: string; line: number; column: number } | undefined;
  for (const raw of lines) {
    const line = raw.trimEnd();
    const headerFile = parseTestFileHeader(line, cwd);
    if (headerFile) {
      currentTestFile = headerFile;
      pendingError = undefined;
      pendingAt = undefined;
      continue;
    }
    const err = /^\s*(?:error|Error|TypeError|ReferenceError|AssertionError)[^:]*: (.+)$/.exec(line);
    if (err && !pendingError) pendingError = err[1]!.trim();
    const diff = /^\s*(Expected|Received)(?: [\w ]+)?: (.+)$/.exec(line);
    if (diff && pendingError && pendingError.length < 300) {
      pendingError += `; ${diff[1]!.toLowerCase()}: ${diff[2]!.trim()}`;
    }
    const at = AT_PAREN_RE.exec(line) ?? AT_BARE_RE.exec(line);
    if (at && !pendingAt && !/node_modules/.test(at[1]!)) {
      pendingAt = { file: toRel(cwd, at[1]!), line: Number(at[2]), column: Number(at[3]) };
    }
    const fail = /^\s*\(fail\) (.+?)(?: \[[\d.]+m?s\])?$/.exec(line);
    if (fail) {
      const caseName = fail[1]!.trim();
      failedCases.push(caseName);
      const failureTestFile =
        currentTestFile ??
        (pendingAt?.file && TEST_FILE_PATH_RE.test(pendingAt.file)
          ? pendingAt.file
          : undefined);
      if (failureTestFile) {
        failedFileSet.add(failureTestFile);
      } else {
        hasUnidentifiedFailureFile = true;
      }
      failures.push({
        severity: "error",
        message: pendingError ? `${caseName} — ${pendingError}` : caseName,
        file: pendingAt?.file ?? failureTestFile,
        line: pendingAt?.line,
        column: pendingAt?.column,
      });
      pendingError = undefined;
      pendingAt = undefined;
    } else if (/^\s*\(pass\) /.test(line)) {
      pendingError = undefined;
      pendingAt = undefined;
    }
  }

  const pass = count("pass");
  const fail = count("fail");
  const skip = count("skip");
  const hasNoTestsMessage =
    /No tests found/i.test(text) ||
    /The following filters did not match any test files/i.test(text);
  const hasZeroTestsRan =
    pass === 0 &&
    fail === 0 &&
    skip === 0 &&
    /\bRan 0 tests?\b/i.test(text) &&
    !/Unhandled error|SyntaxError|Cannot find module/i.test(text);

  return {
    pass,
    fail,
    skip,
    noTests: hasNoTestsMessage || hasZeroTestsRan,
    failures,
    failedFiles: [...failedFileSet],
    failedCases,
    hasUnidentifiedFailureFile,
  };
}

function buildTestRerunPlan(
  parsed: ParsedTestOutput,
  testArgs: readonly string[],
): { rerunCommand?: string; rerunReason?: string } {
  if (parsed.failedFiles.length > 0 && !parsed.hasUnidentifiedFailureFile) {
    return {
      rerunCommand: `bun test ${parsed.failedFiles.map(quoteShellArg).join(" ")}`,
    };
  }
  if (parsed.failedCases.length === 1 && parsed.failedFiles.length === 0) {
    const scopePrefix =
      testArgs.length > 0 ? ` ${testArgs.map(quoteShellArg).join(" ")}` : "";
    return {
      rerunCommand: `bun test${scopePrefix} -t ${quoteShellArg(parsed.failedCases[0]!)}`,
      rerunReason:
        "failing test file could not be uniquely identified from runner output; re-running matching test name across a broader scope",
    };
  }
  if (parsed.failedCases.length > 0 || parsed.failedFiles.length > 0) {
    const scopePrefix =
      testArgs.length > 0 ? ` ${testArgs.map(quoteShellArg).join(" ")}` : "";
    return {
      rerunCommand: `bun test${scopePrefix}`,
      rerunReason:
        "failing test file(s) could not be uniquely identified from runner output; re-running broader test scope",
    };
  }
  return {};
}

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const start = performance.now();
  const value = await fn();
  return [value, performance.now() - start];
}

function tailLines(text: string, n: number): string {
  return stripAnsi(text).trim().split(/\r?\n/).slice(-n).join("\n");
}

export async function runVerifyCommand(
  options: VerifyCommandOptions = {},
  io?: CliIO,
): Promise<VerifyCommandResult> {
  const cwd = resolve(options.cwd ?? io?.cwd ?? process.cwd());
  const spawn = options.spawn ?? defaultSpawn;
  const reporter = options.reporter ?? "pretty";
  const steps: VerifyStepResult[] = [];
  const startAll = performance.now();

  if (options.requireTests && options.skipTests) {
    steps.push({
      name: "test",
      status: "fail",
      outcome: "config-error",
      summary: "conflicting options: --require-tests cannot be used with --skip-tests",
      issues: [
        {
          severity: "error",
          code: "VERIFY_CONFLICTING_FLAGS",
          message: "Cannot combine --require-tests with --skip-tests.",
          hint: "Remove --skip-tests to require at least one test to run, or remove --require-tests to skip tests.",
        },
      ],
      durationMs: 0,
    });
    const conflictResult: VerifyCommandResult = {
      exitCode: 1,
      ok: false,
      steps,
      durationMs: performance.now() - startAll,
    };
    if (io) io.stdout(formatVerifyResult(conflictResult, reporter, options.maxIssues));
    return conflictResult;
  }

  // 1. Typecheck
  if (options.skipTypecheck) {
    steps.push({ name: "typecheck", status: "skip", summary: "skipped", issues: [], durationMs: 0 });
  } else {
    const [proc, ms] = await timed(() => spawn([process.execPath, "check"], { cwd }));
    const combined = `${proc.stdout}\n${proc.stderr}`;
    const issues = parseTypecheckOutput(combined, cwd);
    const failed = proc.exitCode !== 0;
    if (failed && issues.length === 0) {
      issues.push({ severity: "error", message: tailLines(combined, 15) || `bun check exited with ${proc.exitCode}` });
    }
    steps.push({
      name: "typecheck",
      status: failed ? "fail" : "pass",
      summary: failed ? `${issues.length} type error(s)` : "no type errors",
      issues,
      durationMs: ms,
    });
  }

  // 2. Bunest static diagnostics
  if (options.skipCheck) {
    steps.push({ name: "check", status: "skip", summary: "skipped", issues: [], durationMs: 0 });
  } else {
    const [res, ms] = await timed(() =>
      runCheckCommand({
        cwd,
        sourceRoot: options.sourceRoot,
        config: options.config,
        strict: options.strict,
        silent: true,
      }),
    );
    const issues: VerifyIssue[] = res.diagnostics.map((d) => ({
      file: toRel(cwd, d.location.filePath),
      line: d.location.line,
      column: d.location.column,
      code: d.code,
      severity: d.severity,
      message: d.message,
      hint: d.fixData ? "auto-fixable: run `bunest check --fix`" : undefined,
    }));
    steps.push({
      name: "check",
      status: res.exitCode === 0 ? "pass" : "fail",
      summary: `${res.errors} error(s), ${res.warnings} warning(s)`,
      issues: issues.filter((i) => i.severity !== "info"),
      durationMs: ms,
    });
  }

  // 3. Tests
  let affectedPlan: AffectedTestsPlan | undefined;
  if (options.skipTests) {
    steps.push({
      name: "test",
      status: "skip",
      outcome: "skipped",
      summary: "skipped",
      issues: [],
      durationMs: 0,
    });
  } else {
    let testArgs: readonly string[] = options.testFilter ?? [];
    let skipBecauseNoAffected = false;
    if (options.affected) {
      affectedPlan = await selectAffectedTests({
        cwd,
        changedFiles: options.files,
        baseRef: options.base,
        sourceRoot: options.sourceRoot,
      });
      if (!affectedPlan.fallbackToFullSuite) {
        if (affectedPlan.selectedTests.length === 0) {
          skipBecauseNoAffected = true;
        } else {
          testArgs = [
            ...affectedPlan.selectedTests.map((t) => t.file),
            ...(options.testFilter ?? []),
          ];
        }
      }
    }

    if (skipBecauseNoAffected && affectedPlan) {
      if (options.requireTests) {
        steps.push({
          name: "test",
          status: "fail",
          outcome: "no-matching-tests",
          summary: `no matching tests found (0 affected test(s), ${affectedPlan.skippedTestCount} skipped)`,
          issues: [
            {
              severity: "error",
              code: "VERIFY_NO_TESTS",
              message: `No matching tests found (0 affected tests selected; ${affectedPlan.skippedTestCount} skipped) while --require-tests is enabled.`,
              hint: "Check --files/--base or run without --affected to execute the full test suite.",
            },
          ],
          durationMs: 0,
        });
      } else {
        steps.push({
          name: "test",
          status: "skip",
          outcome: "skipped",
          summary: `0 affected test(s) (${affectedPlan.skippedTestCount} skipped)`,
          issues: [],
          durationMs: 0,
        });
      }
    } else {
      const [proc, ms] = await timed(() =>
        spawn([process.execPath, "test", ...testArgs], { cwd }),
      );
      const combined = `${proc.stdout}\n${proc.stderr}`;
      const parsed = parseTestOutput(combined, cwd);
      const zeroExecutedTests =
        parsed.pass === 0 && parsed.fail === 0 && parsed.skip === 0;
      if (parsed.noTests && parsed.pass === 0 && parsed.fail === 0) {
        if (options.requireTests) {
          const filterLabel =
            testArgs.length > 0 ? ` for filter "${testArgs.join(" ")}"` : "";
          steps.push({
            name: "test",
            status: "fail",
            outcome: "no-matching-tests",
            summary: `no matching tests found${filterLabel}`,
            issues: [
              {
                severity: "error",
                code: "VERIFY_NO_TESTS",
                message: `No matching tests found${filterLabel} (--require-tests is enabled).`,
                hint:
                  testArgs.length > 0
                    ? "Check the test filter spelling or run `bunest verify` without a filter to run all tests."
                    : "Add at least one *.spec.ts or *.test.ts file, or run without --require-tests.",
              },
            ],
            durationMs: ms,
          });
        } else {
          steps.push({
            name: "test",
            status: "skip",
            outcome: "no-matching-tests",
            summary: "no tests found",
            issues: [],
            durationMs: ms,
          });
        }
      } else if (proc.exitCode === 0 && zeroExecutedTests && options.requireTests) {
        const filterLabel =
          testArgs.length > 0 ? ` for filter "${testArgs.join(" ")}"` : "";
        steps.push({
          name: "test",
          status: "fail",
          outcome: "no-matching-tests",
          summary: `no matching tests found${filterLabel}`,
          issues: [
            {
              severity: "error",
              code: "VERIFY_NO_TESTS",
              message: `No matching tests were executed${filterLabel} (--require-tests is enabled).`,
              hint:
                testArgs.length > 0
                  ? "Check the test filter spelling or run `bunest verify` without a filter."
                  : "Ensure your test files define at least one test case.",
            },
          ],
          durationMs: ms,
        });
      } else {
        const failed = proc.exitCode !== 0 || parsed.fail > 0;
        const isRunnerError =
          failed &&
          parsed.failures.length === 0 &&
          parsed.pass === 0 &&
          (parsed.fail === 0 || /Unhandled error between tests/i.test(combined));
        const issues = [...parsed.failures];
        if (failed && issues.length === 0) {
          issues.push({
            severity: "error",
            code: isRunnerError ? "VERIFY_RUNNER_ERROR" : undefined,
            message:
              tailLines(combined, 15) || `bun test exited with ${proc.exitCode}`,
            hint: isRunnerError
              ? "Fix the test runner/bootstrap error above before re-running tests."
              : undefined,
          });
        }
        const rerun = failed ? buildTestRerunPlan(parsed, testArgs) : {};
        steps.push({
          name: "test",
          status: failed ? "fail" : "pass",
          outcome: failed ? (isRunnerError ? "runner-error" : "failed") : "passed",
          summary: isRunnerError
            ? `runner/bootstrap error (exit ${proc.exitCode})`
            : `${parsed.pass} pass, ${parsed.fail} fail${parsed.skip ? `, ${parsed.skip} skip` : ""}`,
          issues,
          durationMs: ms,
          ...(rerun.rerunCommand ? { rerunCommand: rerun.rerunCommand } : {}),
          ...(rerun.rerunReason ? { rerunReason: rerun.rerunReason } : {}),
        });
      }
    }
  }

  const ok = steps.every((s) => s.status !== "fail");
  const result: VerifyCommandResult = affectedPlan
    ? {
        exitCode: ok ? 0 : 1,
        ok,
        steps,
        durationMs: performance.now() - startAll,
        affected: affectedPlan,
      }
    : {
        exitCode: ok ? 0 : 1,
        ok,
        steps,
        durationMs: performance.now() - startAll,
      };

  if (io) io.stdout(formatVerifyResult(result, reporter, options.maxIssues));
  return result;
}

function formatIssue(issue: VerifyIssue): string {
  const loc = issue.file
    ? `${issue.file}${issue.line !== undefined ? `:${issue.line}:${issue.column ?? 1}` : ""} `
    : "";
  const code = issue.code ? `[${issue.code}] ` : "";
  const msg = issue.message.includes("\n")
    ? issue.message.split("\n").map((l, i) => (i === 0 ? l : `      ${l}`)).join("\n")
    : issue.message;
  const hint = issue.hint ? `\n      hint: ${issue.hint}` : "";
  return `  ${loc}${code}${msg}${hint}`;
}

export function formatVerifyResult(
  result: VerifyCommandResult,
  reporter: VerifyReporter,
  maxIssues = 20,
): string {
  if (reporter === "json") return JSON.stringify(result, null, 2);

  const out: string[] = [];
  const failing = result.steps.filter((s) => s.status === "fail");
  if (reporter === "agent") {
    out.push(
      `VERIFY ${result.ok ? "PASS" : "FAIL"} (${(result.durationMs / 1000).toFixed(1)}s)`,
    );
    if (result.affected) {
      if (result.affected.fallbackToFullSuite) {
        out.push(
          `[affected] FALLBACK full suite — ${result.affected.fallbackReason ?? "graph incomplete"}`,
        );
      } else {
        out.push(
          `[affected] ${result.affected.selectedTests.length} selected, ${result.affected.skippedTestCount} skipped`,
        );
        for (const sel of result.affected.selectedTests) {
          out.push(`  + ${sel.file}: ${sel.reasons.join("; ")}`);
        }
      }
    }
    for (const step of result.steps) {
      out.push(`[${step.name}] ${step.status.toUpperCase()} ${step.summary}`);
      if (step.status !== "fail" && step.name !== "check") continue;
      const shown = step.issues.slice(0, maxIssues);
      for (const issue of shown) out.push(formatIssue(issue));
      if (step.issues.length > shown.length) {
        out.push(`  … ${step.issues.length - shown.length} more`);
      }
      if (step.status === "fail" && step.rerunCommand) {
        out.push(
          step.rerunReason
            ? `  rerun: ${step.rerunCommand} (${step.rerunReason})`
            : `  rerun: ${step.rerunCommand}`,
        );
      }
    }
    if (!result.ok) {
      out.push(
        `NEXT: fix [${failing[0]!.name}] first, then re-run \`bunest verify --reporter=agent\`.`,
      );
    }
    return out.join("\n");
  }

  if (result.affected) {
    if (result.affected.fallbackToFullSuite) {
      out.push(
        `! affected  full suite fallback: ${result.affected.fallbackReason ?? "graph incomplete"}`,
      );
    } else {
      out.push(
        `• affected  ${result.affected.selectedTests.length} selected, ${result.affected.skippedTestCount} skipped`,
      );
      for (const sel of result.affected.selectedTests) {
        out.push(`  + ${sel.file} — ${sel.reasons.join("; ")}`);
      }
    }
  }
  for (const step of result.steps) {
    const icon = step.status === "pass" ? "✓" : step.status === "fail" ? "✗" : "-";
    out.push(`${icon} ${step.name.padEnd(9)} ${step.summary} (${step.durationMs.toFixed(0)}ms)`);
    for (const issue of step.issues.slice(0, maxIssues)) out.push(formatIssue(issue));
  }
  out.push(
    result.ok
      ? `\nVerification passed in ${(result.durationMs / 1000).toFixed(1)}s.`
      : `\nVerification failed: ${failing.map((s) => s.name).join(", ")}.`,
  );
  return out.join("\n");
}
