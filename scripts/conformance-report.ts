/**
 * Generates `tests/nestjs-conformance/CONFORMANCE_REPORT.md` and updates the
 * `verification` section of `tests/nestjs-conformance/inventory.json` from a live
 * `bun test tests/nestjs-conformance --reporter=junit` run.
 *
 *   bun run conformance:report
 */
import { parseJunitByBucket, sumStats, type BucketStats } from "./conformance-gate";

const REPO = `${import.meta.dir}/..`;
const SUITE = "tests/nestjs-conformance";
const REPORT_PATH = `${REPO}/${SUITE}/CONFORMANCE_REPORT.md`;
const INVENTORY_PATH = `${REPO}/${SUITE}/inventory.json`;

async function runSuiteAndCaptureJunit(): Promise<{
  buckets: Record<string, BucketStats>;
  totals: BucketStats;
  exitCode: number;
  elapsedMs: number;
}> {
  const tmpFile = `${REPO}/.conformance-report-junit.xml`;
  const start = performance.now();
  const proc = Bun.spawn(
    [
      "bun",
      "test",
      SUITE,
      "--reporter=junit",
      `--reporter-outfile=${tmpFile}`,
    ],
    { cwd: REPO, stdout: "pipe", stderr: "pipe" },
  );
  const exitCode = await proc.exited;
  const elapsedMs = Math.round(performance.now() - start);
  const xml = await Bun.file(tmpFile).text();
  await Bun.file(tmpFile).delete();
  const buckets = parseJunitByBucket(xml);
  const totals = sumStats(buckets);
  return { buckets, totals, exitCode, elapsedMs };
}

function renderReportMarkdown(
  buckets: Record<string, BucketStats>,
  totals: BucketStats,
  elapsedMs: number,
): string {
  const generatedAt = new Date().toISOString();
  const passRate =
    totals.tests > 0
      ? ((totals.pass / totals.tests) * 100).toFixed(2)
      : "0.00";
  const sortedNames = Object.keys(buckets).sort();

  const rows = sortedNames.map((name) => {
    const s = buckets[name]!;
    const rate = s.tests > 0 ? ((s.pass / s.tests) * 100).toFixed(1) : "0.0";
    return `| \`${name}\` | ${s.files} | ${s.tests} | ${s.pass} | ${s.skip} | ${s.fail} | ${s.assertions} | ${rate}% |`;
  });

  return [
    "# NestJS v12 Conformance Report (Auto-Generated)",
    "",
    "> Generated automatically by `bun run conformance:report` (`scripts/conformance-report.ts`). Do not hand-edit numbers.",
    "",
    `- **Generated at**: \`${generatedAt}\``,
    `- **Bun runtime**: \`${Bun.version}\``,
    `- **Duration**: \`${(elapsedMs / 1000).toFixed(2)}s\``,
    `- **Totals**: **${totals.pass} pass / ${totals.skip} skip / ${totals.fail} fail** across **${totals.files} files** (${totals.tests} tests, ${totals.assertions.toLocaleString()} assertions, **${passRate}% pass rate**)`,
    "",
    "## Per-Bucket Results",
    "",
    "| Bucket | Files | Tests | Pass | Skip | Fail | Assertions | Pass % |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...rows,
    `| **TOTAL** | **${totals.files}** | **${totals.tests}** | **${totals.pass}** | **${totals.skip}** | **${totals.fail}** | **${totals.assertions}** | **${passRate}%** |`,
    "",
  ].join("\n");
}

async function main(): Promise<void> {
  const { buckets, totals, exitCode, elapsedMs } =
    await runSuiteAndCaptureJunit();

  const md = renderReportMarkdown(buckets, totals, elapsedMs);
  await Bun.write(REPORT_PATH, md);

  const invFile = Bun.file(INVENTORY_PATH);
  if (await invFile.exists()) {
    const inventory = (await invFile.json()) as Record<string, unknown>;
    inventory.verification = {
      generatedAt: new Date().toISOString(),
      bunVersion: Bun.version,
      elapsedMs,
      totals,
      buckets,
    };
    await Bun.write(INVENTORY_PATH, `${JSON.stringify(inventory, null, 2)}\n`);
  }

  console.log(
    `Conformance report updated: ${totals.pass} pass, ${totals.skip} skip, ${totals.fail} fail (${totals.files} files, ${totals.assertions} assertions) in ${(elapsedMs / 1000).toFixed(2)}s`,
  );
  if (exitCode !== 0 || totals.fail > 0) {
    process.exit(1);
  }
}

await main();
