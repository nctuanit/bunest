import { describe, expect, it } from "bun:test";
import {
  evaluateCiStreak,
  formatStreakReport,
  matchesRequiredJob,
  parseCheckCiStreakArgs,
  type WorkflowJobSummary,
  type WorkflowRunSummary,
} from "../../scripts/check-ci-streak";

function makeJob(
  overrides: Partial<WorkflowJobSummary> & Pick<WorkflowJobSummary, "name">,
): WorkflowJobSummary {
  return {
    id: 1,
    status: "completed",
    conclusion: "success",
    ...overrides,
  };
}

function makeRun(
  overrides: Partial<WorkflowRunSummary> & Pick<WorkflowRunSummary, "id">,
): WorkflowRunSummary {
  return {
    head_sha: `sha${String(overrides.id).padStart(37, "0")}`,
    head_branch: "main",
    status: "completed",
    conclusion: "success",
    html_url: `https://github.com/acme/bunest/actions/runs/${overrides.id}`,
    created_at: `2026-11-20T10:00:0${overrides.id % 10}Z`,
    run_number: overrides.id,
    jobs: [
      makeJob({ id: 10, name: "Linux (Bun 1.3.11 — required)" }),
      makeJob({ id: 11, name: "PostgreSQL Production Smoke" }),
    ],
    ...overrides,
  };
}

describe("check-ci-streak", () => {
  describe("parseCheckCiStreakArgs", () => {
    it("returns sensible defaults for empty argv", () => {
      const parsed = parseCheckCiStreakArgs([]);
      expect(parsed.repo).toBe(Bun.env.GITHUB_REPOSITORY);
      expect(parsed.branch).toBe("main");
      expect(parsed.required).toBe(3);
      expect(parsed.jobs).toEqual([
        "linux-bun-pinned",
        "production-postgres-smoke",
      ]);
      expect(parsed.workflow).toBe("ci.yml");
      expect(parsed.outputPath).toBeUndefined();
    });

    it("parses --repo, --branch, --required, --jobs, --workflow, and --output", () => {
      const parsed = parseCheckCiStreakArgs([
        "--repo=acme/bunest",
        "--branch=release/v1",
        "--required=5",
        "--jobs=linux-bun-pinned, redis-integration-smoke , ",
        "--workflow=nightly.yml",
        "--output=artifacts/ci-streak.json",
        "ignored-positional",
        "--flag-without-equals",
      ]);

      expect(parsed).toEqual({
        repo: "acme/bunest",
        branch: "release/v1",
        required: 5,
        jobs: ["linux-bun-pinned", "redis-integration-smoke"],
        workflow: "nightly.yml",
        outputPath: "artifacts/ci-streak.json",
      });
    });

    it("handles empty --jobs= by producing an empty jobs list", () => {
      const parsed = parseCheckCiStreakArgs(["--jobs="]);
      expect(parsed.jobs).toEqual([]);
    });

    it("throws on invalid --required values", () => {
      for (const bad of ["0", "-1", "2.5", "abc", ""]) {
        expect(() =>
          parseCheckCiStreakArgs([`--required=${bad}`]),
        ).toThrow(/Invalid --required value/);
      }
    });
  });

  describe("matchesRequiredJob", () => {
    it("matches exact job names case-insensitively with whitespace trimmed", () => {
      expect(matchesRequiredJob("linux-bun-pinned", "linux-bun-pinned")).toBe(
        true,
      );
      expect(
        matchesRequiredJob("  Linux-Bun-Pinned  ", "linux-bun-pinned"),
      ).toBe(true);
    });

    it("matches substrings and prefixes", () => {
      expect(
        matchesRequiredJob(
          "CI / production-postgres-smoke (ubuntu-latest)",
          "production-postgres-smoke",
        ),
      ).toBe(true);
      expect(matchesRequiredJob("build-linux-x64", "build-linux")).toBe(true);
    });

    it("matches known display-name token rules while excluding smoke jobs from linux-bun-pinned", () => {
      expect(
        matchesRequiredJob(
          "Linux (Bun 1.3.11 — required)",
          "linux-bun-pinned",
        ),
      ).toBe(true);
      expect(
        matchesRequiredJob(
          "Linux PostgreSQL Smoke (Bun 1.3.11 — required)",
          "linux-bun-pinned",
        ),
      ).toBe(false);
      expect(
        matchesRequiredJob(
          "Linux Redis Smoke (Bun 1.3.11 — required)",
          "linux-bun-pinned",
        ),
      ).toBe(false);
      expect(
        matchesRequiredJob(
          "PostgreSQL Production Smoke",
          "production-postgres-smoke",
        ),
      ).toBe(true);
      expect(
        matchesRequiredJob(
          "Redis Integration Smoke",
          "redis-integration-smoke",
        ),
      ).toBe(true);
    });

    it("returns false for unrelated jobs", () => {
      expect(matchesRequiredJob("macOS Unit Tests", "linux-bun-pinned")).toBe(
        false,
      );
      expect(
        matchesRequiredJob("Lint & Typecheck", "production-postgres-smoke"),
      ).toBe(false);
    });
  });

  describe("evaluateCiStreak", () => {
    const requiredJobs = ["linux-bun-pinned", "production-postgres-smoke"];

    it("passes when 3 consecutive latest runs are green (even if input is unsorted)", () => {
      const runs = [
        makeRun({ id: 101, created_at: "2026-11-20T08:00:00Z" }),
        makeRun({ id: 103, created_at: "2026-11-20T10:00:00Z" }),
        makeRun({ id: 102, created_at: "2026-11-20T09:00:00Z" }),
      ];

      const result = evaluateCiStreak(runs, { required: 3, requiredJobs });
      expect(result.passed).toBe(true);
      expect(result.consecutiveGreen).toBe(3);
      expect(result.required).toBe(3);
      expect(result.evaluatedRuns.map((r) => r.runId)).toEqual([103, 102, 101]);
      expect(result.summary).toContain("PASS: 3/3");
    });

    it("fails when 2 latest runs are green and the 3rd has a failed job", () => {
      const runs = [
        makeRun({ id: 203, created_at: "2026-11-20T10:00:00Z" }),
        makeRun({ id: 202, created_at: "2026-11-20T09:00:00Z" }),
        makeRun({
          id: 201,
          created_at: "2026-11-20T08:00:00Z",
          conclusion: "failure",
          jobs: [
            makeJob({ id: 10, name: "Linux (Bun 1.3.11 — required)" }),
            makeJob({
              id: 11,
              name: "PostgreSQL Production Smoke",
              conclusion: "failure",
            }),
          ],
        }),
      ];

      const result = evaluateCiStreak(runs, { required: 3, requiredJobs });
      expect(result.passed).toBe(false);
      expect(result.consecutiveGreen).toBe(2);
      expect(result.evaluatedRuns[2]!.passed).toBe(false);
      expect(result.evaluatedRuns[2]!.reason).toContain(
        "production-postgres-smoke:failure",
      );
      expect(result.summary).toContain("FAIL: 2/3");
    });

    it("fails with consecutiveGreen=0 when the latest run fails", () => {
      const runs = [
        makeRun({
          id: 303,
          created_at: "2026-11-20T10:00:00Z",
          status: "in_progress",
          conclusion: null,
        }),
        makeRun({ id: 302, created_at: "2026-11-20T09:00:00Z" }),
        makeRun({ id: 301, created_at: "2026-11-20T08:00:00Z" }),
      ];

      const result = evaluateCiStreak(runs, { required: 3, requiredJobs });
      expect(result.passed).toBe(false);
      expect(result.consecutiveGreen).toBe(0);
      expect(result.evaluatedRuns[0]!.reason).toContain("in_progress");
    });

    it("fails when fewer than required runs exist", () => {
      const runs = [
        makeRun({ id: 402, created_at: "2026-11-20T09:00:00Z" }),
        makeRun({ id: 401, created_at: "2026-11-20T08:00:00Z" }),
      ];

      const result = evaluateCiStreak(runs, { required: 3, requiredJobs });
      expect(result.passed).toBe(false);
      expect(result.consecutiveGreen).toBe(2);
      expect(result.evaluatedRuns).toHaveLength(2);
      expect(result.summary).toContain("Only 2 run(s) found");
    });

    it("fails when a required job is missing from a run", () => {
      const runs = [
        makeRun({
          id: 501,
          created_at: "2026-11-20T10:00:00Z",
          jobs: [makeJob({ id: 10, name: "Linux (Bun 1.3.11 — required)" })],
        }),
      ];

      const result = evaluateCiStreak(runs, { required: 1, requiredJobs });
      expect(result.passed).toBe(false);
      expect(result.consecutiveGreen).toBe(0);
      expect(result.evaluatedRuns[0]!.reason).toBe(
        "production-postgres-smoke:missing",
      );
      const missingJob = result.evaluatedRuns[0]!.jobResults.find(
        (j) => j.job === "production-postgres-smoke",
      );
      expect(missingJob).toEqual({
        job: "production-postgres-smoke",
        matchedName: null,
        status: "missing",
        conclusion: null,
        passed: false,
      });
    });

    it("falls back to overall run conclusion when requiredJobs is empty", () => {
      const runs = [
        makeRun({
          id: 601,
          created_at: "2026-11-20T10:00:00Z",
          conclusion: "success",
          jobs: [],
        }),
      ];

      const result = evaluateCiStreak(runs, { required: 1, requiredJobs: [] });
      expect(result.passed).toBe(true);
      expect(result.consecutiveGreen).toBe(1);
    });

    it("throws when required streak length is invalid", () => {
      expect(() =>
        evaluateCiStreak([], { required: 0, requiredJobs }),
      ).toThrow(/Invalid required streak length/);
    });
  });

  describe("formatStreakReport", () => {
    it("includes repo, branch, commit SHAs, run URLs, and PASS verdict", () => {
      const runs = [
        makeRun({
          id: 702,
          run_number: 42,
          head_sha: "abcdef1234567890abcdef1234567890abcdef12",
          html_url: "https://github.com/acme/bunest/actions/runs/702",
          created_at: "2026-11-20T10:00:00Z",
        }),
        makeRun({
          id: 701,
          run_number: 41,
          head_sha: "1234567890abcdef1234567890abcdef12345678",
          html_url: "https://github.com/acme/bunest/actions/runs/701",
          created_at: "2026-11-20T09:00:00Z",
        }),
      ];
      const requiredJobs = ["linux-bun-pinned", "production-postgres-smoke"];
      const result = evaluateCiStreak(runs, { required: 2, requiredJobs });
      const report = formatStreakReport(result, {
        repo: "acme/bunest",
        branch: "main",
        requiredJobs,
      });

      expect(report).toContain("acme/bunest (main)");
      expect(report).toContain("Result: PASS: 2/2");
      expect(report).toContain("[PASS] #42 sha=abcdef123456");
      expect(report).toContain("https://github.com/acme/bunest/actions/runs/702");
      expect(report).toContain("[PASS] #41 sha=1234567890ab");
      expect(report).toContain("https://github.com/acme/bunest/actions/runs/701");
    });

    it("includes FAIL verdict, run URL, commit SHA, and failure reason", () => {
      const runs = [
        makeRun({
          id: 801,
          run_number: undefined,
          head_sha: "deadbeef12349999999999999999999999999999",
          html_url: "https://github.com/acme/bunest/actions/runs/801",
          created_at: "2026-11-20T11:00:00Z",
          jobs: [makeJob({ id: 10, name: "Linux (Bun 1.3.11 — required)" })],
        }),
      ];
      const requiredJobs = ["linux-bun-pinned", "production-postgres-smoke"];
      const result = evaluateCiStreak(runs, { required: 1, requiredJobs });
      const report = formatStreakReport(result, {
        repo: "acme/bunest",
        branch: "main",
        requiredJobs,
      });

      expect(report).toContain("Result: FAIL:");
      expect(report).toContain("[FAIL] id=801 sha=deadbeef1234");
      expect(report).toContain("https://github.com/acme/bunest/actions/runs/801");
      expect(report).toContain("production-postgres-smoke:missing");
    });

    it("renders empty run notice when no runs were evaluated", () => {
      const result = evaluateCiStreak([], {
        required: 3,
        requiredJobs: [],
      });
      const report = formatStreakReport(result, {
        repo: "acme/bunest",
        branch: "main",
        requiredJobs: [],
      });

      expect(report).toContain("(overall workflow conclusion)");
      expect(report).toContain("Result: FAIL:");
      expect(report).toContain("(no workflow runs found)");
    });
  });
});
