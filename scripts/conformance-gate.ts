/**
 * NestJS conformance ratchet gate.
 *
 *   bun run conformance:gate            # fail if skips/failures regress vs skip-budget.json
 *   bun run conformance:gate --update   # lower the budget to the current (never raises it)
 *   bun run conformance:gate --stale    # list skipped tests that already pass when un-skipped
 *
 * Invariants enforced:
 *   - 0 failing tests.
 *   - Per-bucket skip count <= budget (budget only ever goes down).
 *   - Per-bucket test count and assertion count >= budget floor (prevents deleting/weakening tests).
 *   - Every `.skip` site is immediately preceded by a `// BUNEST_BUG:` comment.
 */

const REPO = `${import.meta.dir}/..`;
const SUITE = "tests/nestjs-conformance";
const BUDGET_PATH = `${REPO}/${SUITE}/skip-budget.json`;
const SKIP_SITE_RE = /\b(it|test|describe)\.skip\b/;
/** A real skip call site (code, not prose inside strings/comments). */
const SKIP_CALL_RE = /^\s*(it|test|describe)\.skip(\.each\b[^(]*)?\s*\(/;

export interface BucketStats {
  files: number;
  tests: number;
  pass: number;
  skip: number;
  fail: number;
  assertions: number;
}

export interface SkipBudget {
  readonly note: string;
  readonly totals: BucketStats;
  readonly buckets: Record<string, BucketStats>;
}

export function bucketOf(fileRel: string): string {
  const rel = fileRel.replace(/\\/g, "/").replace(/^.*nestjs-conformance\//, "");
  const parts = rel.split("/");
  return parts[0] === "ecosystem" ? `ecosystem/${parts[1]}` : parts[0]!;
}

function emptyStats(): BucketStats {
  return { files: 0, tests: 0, pass: 0, skip: 0, fail: 0, assertions: 0 };
}

function attr(tag: string, name: string): string | undefined {
  return new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
}

/** Aggregates top-level (per-file) `<testsuite>` elements of a bun JUnit report. */
export function parseJunitByBucket(xml: string): Record<string, BucketStats> {
  const buckets: Record<string, BucketStats> = {};
  const seen = new Set<string>();
  for (const line of xml.split(/\r?\n/)) {
    if (!line.startsWith("  <testsuite ")) continue; // depth-1 suites = files
    const file = attr(line, "file") ?? attr(line, "name") ?? "";
    if (!file.includes("nestjs-conformance") || seen.has(file)) continue;
    seen.add(file);
    const s = (buckets[bucketOf(file)] ??= emptyStats());
    const tests = Number(attr(line, "tests") ?? 0);
    const skip = Number(attr(line, "skipped") ?? 0);
    const fail = Number(attr(line, "failures") ?? 0) + Number(attr(line, "errors") ?? 0);
    s.files++;
    s.tests += tests;
    s.skip += skip;
    s.fail += fail;
    s.pass += tests - skip - fail;
    s.assertions += Number(attr(line, "assertions") ?? 0);
  }
  return buckets;
}

export function sumStats(buckets: Record<string, BucketStats>): BucketStats {
  const t = emptyStats();
  for (const s of Object.values(buckets)) {
    for (const k of Object.keys(t) as (keyof BucketStats)[]) t[k] += s[k];
  }
  return t;
}

/** Returns `.skip` sites that lack an immediately preceding `// BUNEST_BUG:` comment. */
export async function findUnannotatedSkips(): Promise<string[]> {
  const problems: string[] = [];
  for await (const rel of new Bun.Glob(`${SUITE}/**/*.ts`).scan(REPO)) {
    const lines = (await Bun.file(`${REPO}/${rel}`).text()).split(/\r?\n/);
    lines.forEach((line, i) => {
      if (!SKIP_CALL_RE.test(line)) return;
      // Accept a BUNEST_BUG comment within the 6 preceding lines (multi-line comments).
      const window = lines.slice(Math.max(0, i - 6), i).join("\n");
      if (!window.includes("BUNEST_BUG:")) problems.push(`${rel}:${i + 1}`);
    });
  }
  return problems.sort();
}

async function runSuite(extraArgs: string[] = []): Promise<string> {
  const tmp = `${Bun.env.TMPDIR ?? "/tmp"}/bunest-conformance-${crypto.randomUUID()}.xml`;
  const proc = Bun.spawn(
    ["bun", "test", SUITE, "--reporter=junit", `--reporter-outfile=${tmp}`, ...extraArgs],
    { cwd: REPO, stdout: "ignore", stderr: "ignore" },
  );
  await proc.exited;
  const file = Bun.file(tmp);
  if (!(await file.exists())) throw new Error(`bun test produced no JUnit report (exit ${proc.exitCode})`);
  const xml = await file.text();
  await Bun.$`rm -f ${tmp}`.quiet();
  return xml;
}

export function compareToBudget(
  current: Record<string, BucketStats>,
  budget: SkipBudget,
): string[] {
  const errors: string[] = [];
  for (const [name, b] of Object.entries(budget.buckets)) {
    const c = current[name];
    if (!c) {
      errors.push(`${name}: bucket disappeared (budget had ${b.tests} tests)`);
      continue;
    }
    if (c.skip > b.skip) errors.push(`${name}: skips increased ${b.skip} -> ${c.skip}`);
    if (c.tests < b.tests) errors.push(`${name}: test count decreased ${b.tests} -> ${c.tests}`);
    if (c.assertions < b.assertions) {
      errors.push(`${name}: assertion count decreased ${b.assertions} -> ${c.assertions}`);
    }
  }
  for (const [name, c] of Object.entries(current)) {
    if (c.fail > 0) errors.push(`${name}: ${c.fail} failing test(s)`);
    if (!budget.buckets[name] && c.skip > 0) errors.push(`${name}: new bucket must have 0 skips (has ${c.skip})`);
  }
  return errors;
}

function formatTable(buckets: Record<string, BucketStats>, budget?: SkipBudget): string {
  const rows = Object.entries(buckets).sort(([a], [b]) => a.localeCompare(b));
  const out = ["bucket                         tests   pass   skip  budget  fail"];
  for (const [name, s] of rows) {
    const b = budget?.buckets[name]?.skip;
    out.push(
      `${name.padEnd(30)} ${String(s.tests).padStart(6)} ${String(s.pass).padStart(6)} ${String(s.skip).padStart(6)} ${String(b ?? "-").padStart(7)} ${String(s.fail).padStart(5)}`,
    );
  }
  const t = sumStats(buckets);
  out.push(
    `${"TOTAL".padEnd(30)} ${String(t.tests).padStart(6)} ${String(t.pass).padStart(6)} ${String(t.skip).padStart(6)} ${String(budget?.totals.skip ?? "-").padStart(7)} ${String(t.fail).padStart(5)}`,
  );
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// --stale: un-skip each file in a temp copy and report skipped tests that pass
// ---------------------------------------------------------------------------

interface StaleResult {
  file: string;
  nowPass: string[];
  stillFail: number;
  error?: string;
}

function parseCases(xml: string): Map<string, "pass" | "fail" | "skip"> {
  const out = new Map<string, "pass" | "fail" | "skip">();
  const re = /<testcase name="([^"]*)" classname="([^"]*)"[^>]*?(\/>|>([\s\S]*?)<\/testcase>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const body = m[4] ?? "";
    out.set(
      `${m[2]} > ${m[1]}`,
      body.includes("<skipped") ? "skip" : body.includes("<failure") || body.includes("<error") ? "fail" : "pass",
    );
  }
  return out;
}

async function runFileJunit(rel: string, timeoutMs: number): Promise<{ xml?: string; timedOut: boolean }> {
  const tmp = `${Bun.env.TMPDIR ?? "/tmp"}/bunest-stale-${crypto.randomUUID()}.xml`;
  const proc = Bun.spawn(
    ["bun", "test", "--timeout", "10000", "--reporter=junit", `--reporter-outfile=${tmp}`, `./${rel}`],
    { cwd: REPO, stdout: "ignore", stderr: "ignore" },
  );
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill(9);
  }, timeoutMs);
  await proc.exited;
  clearTimeout(timer);
  const f = Bun.file(tmp);
  const xml = (await f.exists()) ? await f.text() : undefined;
  await Bun.$`rm -f ${tmp}`.quiet();
  return { xml, timedOut };
}

export async function findStaleSkips(filter?: string, concurrency = 8): Promise<StaleResult[]> {
  const targets: string[] = [];
  for await (const rel of new Bun.Glob(`${SUITE}/**/*.spec.ts`).scan(REPO)) {
    if (filter && !rel.includes(filter)) continue;
    if (rel.includes("__unskip__")) continue;
    if (SKIP_SITE_RE.test(await Bun.file(`${REPO}/${rel}`).text())) targets.push(rel);
  }
  targets.sort();
  const results: StaleResult[] = [];
  const queue = [...targets];
  const worker = async () => {
    while (queue.length) {
      const rel = queue.shift()!;
      const dir = rel.slice(0, rel.lastIndexOf("/"));
      const tmpRel = `${dir}/__unskip__${rel.slice(rel.lastIndexOf("/") + 1)}`;
      try {
        const base = await runFileJunit(rel, 60_000);
        const baseCases = base.xml ? parseCases(base.xml) : new Map();
        const src = await Bun.file(`${REPO}/${rel}`).text();
        await Bun.write(`${REPO}/${tmpRel}`, src.replace(/\b(it|test|describe)\.skip\b/g, "$1"));
        const un = await runFileJunit(tmpRel, 45_000);
        if (!un.xml) {
          results.push({ file: rel, nowPass: [], stillFail: 0, error: un.timedOut ? "timeout" : "crashed" });
          continue;
        }
        const nowPass: string[] = [];
        let stillFail = 0;
        for (const [key, status] of parseCases(un.xml)) {
          if (baseCases.get(key) !== "skip") continue;
          if (status === "pass") nowPass.push(key);
          else stillFail++;
        }
        results.push({ file: rel, nowPass, stillFail });
      } finally {
        await Bun.$`rm -f ${REPO}/${tmpRel}`.quiet();
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results.sort((a, b) => b.nowPass.length - a.nowPass.length || a.file.localeCompare(b.file));
}

// ---------------------------------------------------------------------------

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const flag = (name: string) => args.includes(`--${name}`);
  const valueOf = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };

  if (flag("stale")) {
    const results = await findStaleSkips(valueOf("filter"));
    const stale = results.reduce((s, r) => s + r.nowPass.length, 0);
    const still = results.reduce((s, r) => s + r.stillFail, 0);
    if (flag("json")) {
      console.log(JSON.stringify(results, null, 2));
    } else {
      for (const r of results) {
        if (r.error) console.log(`! ${r.error}: ${r.file}`);
        for (const t of r.nowPass) console.log(`STALE ${r.file} :: ${t}`);
      }
      console.log(`\n[conformance] stale skips (pass when un-skipped): ${stale}; still failing: ${still}; files errored: ${results.filter((r) => r.error).length}`);
    }
    process.exit(0);
  }

  const unannotated = await findUnannotatedSkips();
  const current = parseJunitByBucket(await runSuite());
  const budgetFile = Bun.file(BUDGET_PATH);
  const budget = (await budgetFile.exists()) ? ((await budgetFile.json()) as SkipBudget) : undefined;

  console.log(formatTable(current, budget));

  if (flag("update")) {
    if (budget) {
      const regressions = compareToBudget(current, budget);
      if (regressions.length > 0) {
        console.error(`\n[conformance] refusing to update budget; regressions:\n  - ${regressions.join("\n  - ")}`);
        process.exit(1);
      }
    }
    const next: SkipBudget = {
      note: "Ratchet baseline for `bun run conformance:gate`. Skips may only go DOWN; tests/assertions may only go UP. Update with `bun run conformance:gate --update`.",
      totals: sumStats(current),
      buckets: Object.fromEntries(Object.entries(current).sort(([a], [b]) => a.localeCompare(b))),
    };
    await Bun.write(BUDGET_PATH, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`\n[conformance] budget updated: ${next.totals.skip} skips, ${next.totals.tests} tests.`);
    process.exit(0);
  }

  const errors: string[] = [];
  if (!budget) errors.push(`missing ${SUITE}/skip-budget.json (run with --update to create)`);
  else errors.push(...compareToBudget(current, budget));
  if (unannotated.length > 0) {
    errors.push(`${unannotated.length} .skip site(s) without a preceding // BUNEST_BUG: comment:\n    ${unannotated.join("\n    ")}`);
  }

  if (errors.length > 0) {
    console.error(`\n[conformance] FAILED:\n  - ${errors.join("\n  - ")}`);
    process.exit(1);
  }
  const t = sumStats(current);
  const lowered = budget && t.skip < budget.totals.skip;
  console.log(
    `\n[conformance] OK: ${t.pass}/${t.tests} pass, ${t.skip} skip (budget ${budget!.totals.skip}), 0 fail.` +
      (lowered ? " Skips decreased — run `bun run conformance:gate --update` to lock in progress." : ""),
  );
  process.exit(0);
}
