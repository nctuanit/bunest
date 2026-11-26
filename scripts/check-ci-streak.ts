/**
 * Verifies that the latest N GitHub Actions workflow runs on a branch (default `main`)
 * are consecutively green for a set of required jobs.
 *
 * Usage:
 *   bun run scripts/check-ci-streak.ts \
 *     --repo=owner/repo \
 *     --branch=main \
 *     --required=3 \
 *     --jobs=linux-bun-pinned,production-postgres-smoke \
 *     --output=ci-streak-report.json
 *
 * Authentication:
 *   Uses `GITHUB_TOKEN` (or `GH_TOKEN`) with `fetch`, falling back to `gh api`
 *   when no token is set in the environment.
 */

export interface WorkflowJobSummary {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url?: string;
}

export interface WorkflowRunSummary {
  id: number;
  head_sha: string;
  head_branch: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  created_at: string;
  run_number?: number;
  event?: string;
  jobs: WorkflowJobSummary[];
}

export interface StreakCheckOptions {
  required: number;
  requiredJobs: string[];
}

export interface JobEvaluation {
  job: string;
  matchedName: string | null;
  status: string;
  conclusion: string | null;
  passed: boolean;
}

export interface RunEvaluation {
  runId: number;
  runNumber?: number;
  commitSha: string;
  url: string;
  createdAt: string;
  status: string;
  conclusion: string | null;
  passed: boolean;
  jobResults: JobEvaluation[];
  reason?: string;
}

export interface StreakEvaluationResult {
  passed: boolean;
  required: number;
  consecutiveGreen: number;
  evaluatedRuns: RunEvaluation[];
  summary: string;
}

export interface CheckCiStreakCliOptions {
  repo?: string;
  branch: string;
  required: number;
  jobs: string[];
  workflow: string;
  outputPath?: string;
}

/**
 * Known YAML job-ID -> display-name token matchers for Bunest's CI workflow,
 * because the GitHub Actions Jobs API exposes the job's display `name` rather
 * than its YAML key when `name:` is configured.
 */
const KNOWN_JOB_MATCHERS: Record<string, readonly string[]> = {
  "linux-bun-pinned": ["linux", "bun", "required"],
  "production-postgres-smoke": ["postgresql", "smoke"],
  "redis-integration-smoke": ["redis", "smoke"],
};

export function parseCheckCiStreakArgs(argv: string[]): CheckCiStreakCliOptions {
  const map = new Map<string, string>();
  for (const arg of argv) {
    if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      if (eqIdx > 2) {
        const key = arg.slice(2, eqIdx);
        const value = arg.slice(eqIdx + 1);
        map.set(key, value);
      }
    }
  }

  const requiredRaw = map.get("required") ?? "3";
  const required = Number(requiredRaw);
  if (!Number.isInteger(required) || required < 1) {
    throw new Error(
      `Invalid --required value "${requiredRaw}". Must be a positive integer.`,
    );
  }

  const jobsRaw =
    map.get("jobs") ?? "linux-bun-pinned,production-postgres-smoke";
  const jobs = jobsRaw
    .split(",")
    .map((j) => j.trim())
    .filter((j) => j.length > 0);

  return {
    repo: map.get("repo") ?? Bun.env.GITHUB_REPOSITORY,
    branch: map.get("branch") ?? "main",
    required,
    jobs,
    workflow: map.get("workflow") ?? "ci.yml",
    outputPath: map.get("output"),
  };
}

export function matchesRequiredJob(
  jobName: string,
  requiredJob: string,
): boolean {
  const normalizedName = jobName.trim().toLowerCase();
  const normalizedReq = requiredJob.trim().toLowerCase();

  if (normalizedName === normalizedReq) {
    return true;
  }
  if (normalizedName.includes(normalizedReq)) {
    return true;
  }

  const tokens = KNOWN_JOB_MATCHERS[normalizedReq];
  if (tokens) {
    // Avoid matching postgres/redis smoke jobs when looking for linux-bun-pinned
    if (
      normalizedReq === "linux-bun-pinned" &&
      (normalizedName.includes("postgres") || normalizedName.includes("redis"))
    ) {
      return false;
    }
    return tokens.every((token) => normalizedName.includes(token));
  }

  return false;
}

export function evaluateCiStreak(
  runs: readonly WorkflowRunSummary[],
  options: StreakCheckOptions,
): StreakEvaluationResult {
  const { required, requiredJobs } = options;
  if (!Number.isInteger(required) || required < 1) {
    throw new Error(`Invalid required streak length: ${required}`);
  }

  const sorted = [...runs].sort((a, b) => {
    const timeDiff = Date.parse(b.created_at) - Date.parse(a.created_at);
    if (!Number.isNaN(timeDiff) && timeDiff !== 0) {
      return timeDiff;
    }
    return b.id - a.id;
  });

  const targetRuns = sorted.slice(0, required);
  const evaluatedRuns: RunEvaluation[] = targetRuns.map((run) => {
    const jobResults: JobEvaluation[] = requiredJobs.map((reqJob) => {
      const matched = run.jobs.find((j) => matchesRequiredJob(j.name, reqJob));
      if (!matched) {
        return {
          job: reqJob,
          matchedName: null,
          status: "missing",
          conclusion: null,
          passed: false,
        };
      }
      const jobPassed =
        matched.status === "completed" && matched.conclusion === "success";
      return {
        job: reqJob,
        matchedName: matched.name,
        status: matched.status,
        conclusion: matched.conclusion,
        passed: jobPassed,
      };
    });

    let passed: boolean;
    let reason: string | undefined;

    if (run.status !== "completed") {
      passed = false;
      reason = `run status is "${run.status}" (expected "completed")`;
    } else if (requiredJobs.length === 0) {
      passed = run.conclusion === "success";
      if (!passed) {
        reason = `run conclusion is "${run.conclusion ?? "null"}"`;
      }
    } else {
      const failedJobs = jobResults.filter((j) => !j.passed);
      passed = failedJobs.length === 0;
      if (!passed) {
        reason = failedJobs
          .map((j) =>
            j.matchedName === null
              ? `${j.job}:missing`
              : `${j.job}:${j.conclusion ?? j.status}`,
          )
          .join(", ");
      }
    }

    return {
      runId: run.id,
      runNumber: run.run_number,
      commitSha: run.head_sha,
      url: run.html_url,
      createdAt: run.created_at,
      status: run.status,
      conclusion: run.conclusion,
      passed,
      jobResults,
      reason,
    };
  });

  let consecutiveGreen = 0;
  for (const evaluated of evaluatedRuns) {
    if (evaluated.passed) {
      consecutiveGreen++;
    } else {
      break;
    }
  }

  const passed =
    evaluatedRuns.length >= required && consecutiveGreen >= required;

  const summary = passed
    ? `PASS: ${consecutiveGreen}/${required} consecutive green CI runs verified.`
    : evaluatedRuns.length < required
      ? `FAIL: Only ${evaluatedRuns.length} run(s) found; ${required} consecutive green runs required (${consecutiveGreen} green).`
      : `FAIL: ${consecutiveGreen}/${required} consecutive green CI runs (streak broken).`;

  return {
    passed,
    required,
    consecutiveGreen,
    evaluatedRuns,
    summary,
  };
}

export function formatStreakReport(
  result: StreakEvaluationResult,
  meta: { repo: string; branch: string; requiredJobs: string[] },
): string {
  const lines: string[] = [
    `CI Streak Check — ${meta.repo} (${meta.branch})`,
    `Required jobs: ${meta.requiredJobs.join(", ") || "(overall workflow conclusion)"}`,
    `Result: ${result.summary}`,
    "",
  ];

  if (result.evaluatedRuns.length === 0) {
    lines.push("  (no workflow runs found)");
  } else {
    for (const run of result.evaluatedRuns) {
      const badge = run.passed ? "PASS" : "FAIL";
      const shortSha = run.commitSha.slice(0, 12);
      const runLabel =
        run.runNumber !== undefined ? `#${run.runNumber}` : `id=${run.runId}`;
      const detail = run.reason ? ` — ${run.reason}` : "";
      lines.push(
        `  [${badge}] ${runLabel} sha=${shortSha} (${run.createdAt}) ${run.url}${detail}`,
      );
    }
  }

  return lines.join("\n");
}

function inferRepoFromGitRemote(): string | undefined {
  try {
    const proc = Bun.spawnSync(["git", "remote", "get-url", "origin"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) return undefined;
    const raw = new TextDecoder().decode(proc.stdout).trim();
    const match = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/i.exec(raw);
    return match?.[1];
  } catch {
    return undefined;
  }
}

async function fetchGitHubJson<T>(path: string, token?: string): Promise<T> {
  if (token) {
    const res = await fetch(`https://api.github.com${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "bunest-check-ci-streak",
      },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(
        `GitHub API request failed (${res.status} ${res.statusText}) for ${path}: ${body.slice(0, 300)}`,
      );
    }
    return (await res.json()) as T;
  }

  // Fallback to `gh api` when GITHUB_TOKEN is not set
  try {
    const proc = Bun.spawn(["gh", "api", path], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode === 0) {
      return JSON.parse(stdout) as T;
    }
    // If gh failed (e.g. not logged in), try unauthenticated fetch for public repos
    const unauthRes = await fetch(`https://api.github.com${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "bunest-check-ci-streak",
      },
    });
    if (unauthRes.ok) {
      return (await unauthRes.json()) as T;
    }
    throw new Error(
      `Failed to query GitHub API (${path}). Set GITHUB_TOKEN or authenticate with 'gh auth login'. gh stderr: ${stderr.trim()}`,
    );
  } catch (err) {
    if (err instanceof Error && err.message.includes("Failed to query GitHub API")) {
      throw err;
    }
    const unauthRes = await fetch(`https://api.github.com${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "bunest-check-ci-streak",
      },
    });
    if (!unauthRes.ok) {
      throw new Error(
        `GitHub API request failed (${unauthRes.status}) for ${path}. Set GITHUB_TOKEN or install/authenticate GitHub CLI ('gh').`,
      );
    }
    return (await unauthRes.json()) as T;
  }
}

interface GitHubRunsResponse {
  workflow_runs: Array<{
    id: number;
    head_sha: string;
    head_branch: string;
    status: string;
    conclusion: string | null;
    html_url: string;
    created_at: string;
    run_number?: number;
    event?: string;
  }>;
}

interface GitHubJobsResponse {
  jobs: WorkflowJobSummary[];
}

async function main(): Promise<void> {
  const opts = parseCheckCiStreakArgs(Bun.argv.slice(2));
  const repo = opts.repo ?? inferRepoFromGitRemote();
  if (!repo) {
    throw new Error(
      "Missing --repo=owner/repo (and could not infer from GITHUB_REPOSITORY or git origin remote).",
    );
  }

  const token = Bun.env.GITHUB_TOKEN ?? Bun.env.GH_TOKEN;
  const perPage = Math.max(opts.required * 3, 10);
  const runsPath =
    opts.workflow === "all"
      ? `/repos/${repo}/actions/runs?branch=${encodeURIComponent(opts.branch)}&per_page=${perPage}`
      : `/repos/${repo}/actions/workflows/${encodeURIComponent(opts.workflow)}/runs?branch=${encodeURIComponent(opts.branch)}&per_page=${perPage}`;

  const runsPayload = await fetchGitHubJson<GitHubRunsResponse>(runsPath, token);
  const latestRuns = (runsPayload.workflow_runs ?? []).slice(0, opts.required);

  const runsWithJobs: WorkflowRunSummary[] = await Promise.all(
    latestRuns.map(async (run) => {
      const jobsPayload = await fetchGitHubJson<GitHubJobsResponse>(
        `/repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`,
        token,
      );
      return {
        ...run,
        jobs: jobsPayload.jobs ?? [],
      };
    }),
  );

  const result = evaluateCiStreak(runsWithJobs, {
    required: opts.required,
    requiredJobs: opts.jobs,
  });

  const reportText = formatStreakReport(result, {
    repo,
    branch: opts.branch,
    requiredJobs: opts.jobs,
  });
  console.log(reportText);

  if (opts.outputPath) {
    const jsonReport = {
      generatedAt: new Date().toISOString(),
      repo,
      branch: opts.branch,
      workflow: opts.workflow,
      requiredJobs: opts.jobs,
      ...result,
    };
    await Bun.write(opts.outputPath, JSON.stringify(jsonReport, null, 2) + "\n");
  }

  if (!result.passed) {
    process.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
