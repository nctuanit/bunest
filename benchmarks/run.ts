import { resolve } from "../packages/core/src";
import {
  renderResultsMarkdown,
  runAllBenchmarks,
  type RunBenchmarkOptions,
} from "./http-benchmark";

function parseNumberArg(
  argv: readonly string[],
  flag: string,
): number | undefined {
  const idx = argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= argv.length) {
    return undefined;
  }
  const parsed = Number.parseInt(argv[idx + 1]!, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const quick = argv.includes("--quick");

  const options: RunBenchmarkOptions = {
    liveRequests: parseNumberArg(argv, "--requests") ?? (quick ? 1000 : 4000),
    liveWarmup: parseNumberArg(argv, "--warmup") ?? (quick ? 100 : 400),
    concurrency: parseNumberArg(argv, "--concurrency") ?? 32,
    inProcessIterations:
      parseNumberArg(argv, "--iterations") ?? (quick ? 2000 : 10_000),
    inProcessWarmup: quick ? 200 : 1_000,
    diIterations: parseNumberArg(argv, "--di-iterations") ?? 10_000,
    coldBootstrapIterations: quick ? 20 : 50,
  };

  console.log("Running Bunest benchmark suite...");
  const report = await runAllBenchmarks(options);
  const markdown = renderResultsMarkdown(report);

  const outputPath = resolve(import.meta.dir, "RESULTS.md");
  await Bun.write(outputPath, markdown);

  console.log(`\nWrote results to ${outputPath}\n`);
  console.log(markdown);
}

if (import.meta.main) {
  await main();
}
