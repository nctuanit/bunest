/**
 * check-type-coverage.ts
 *
 * Computes type coverage across the Bunest monorepo using Bunest's native
 * zero-dependency TypeScript scanner.
 * Coverage = % nodes with explicit non-`any` types (heuristic by `any` density).
 *
 * Usage:
 *   bun run scripts/type-tools/check-type-coverage.ts
 *   bun run scripts/type-tools/check-type-coverage.ts --json
 *   bun run scripts/type-tools/check-type-coverage.ts --threshold 95
 *   bun run scripts/type-tools/check-type-coverage.ts --package mongoose
 */

import { join, relative } from "../../packages/core/src/common/index";
import { collectTsConfigFiles, scanTypeScriptSource } from "./ts-scanner";

const SCRIPT_DIR = import.meta.dirname;
const ROOT = join(SCRIPT_DIR, "../..");
const TSCONFIG = join(ROOT, "tsconfig.json");

interface PackageCoverage {
  package: string;
  anyCount: number;
  totalAnyKeywords: number;
  coverage: number;
  fileCount: number;
}

async function countAnys(filePath: string): Promise<number> {
  const source = await Bun.file(filePath).text();
  const { hits } = scanTypeScriptSource(source, filePath);
  let count = 0;
  for (const h of hits) {
    if (h.keyword === "any") count++;
  }
  return count;
}

function getPackageName(filePath: string): string {
  const rel = relative(ROOT, filePath).replace(/\\/g, "/");
  const match = rel.match(/^packages\/([^/]+)\//);
  return match?.[1] ? `@bunest/${match[1]}` : "root";
}

const args = process.argv.slice(2);
const jsonMode = args.includes("--json");
const threshold = Number(
  args.find((a) => a.startsWith("--threshold="))?.split("=")[1] ??
    (args.indexOf("--threshold") !== -1
      ? args[args.indexOf("--threshold") + 1]
      : 90),
);
const pkgFilter =
  args.find((a) => a.startsWith("--package="))?.split("=")[1] ??
  (args.indexOf("--package") !== -1
    ? args[args.indexOf("--package") + 1]
    : undefined);

console.error("🔍 Loading TypeScript project (Bunest native AST)...");
const sourceFiles = collectTsConfigFiles(ROOT, TSCONFIG).filter((fp) => {
  const norm = fp.replace(/\\/g, "/");
  if (!norm.includes("/packages/")) return false;
  if (pkgFilter && !norm.includes(`/packages/${pkgFilter}/`)) return false;
  return true;
});
console.error(`📂 Checking ${sourceFiles.length} source files...`);

const pkgMap = new Map<string, { anyCount: number; fileCount: number }>();

for (const fp of sourceFiles) {
  const pkg = getPackageName(fp);
  if (!pkgMap.has(pkg)) pkgMap.set(pkg, { anyCount: 0, fileCount: 0 });
  const entry = pkgMap.get(pkg)!;
  entry.anyCount += await countAnys(fp);
  entry.fileCount++;
}

let totalAny = 0;
let totalFiles = 0;

const coverages: PackageCoverage[] = [];

for (const [pkg, { anyCount, fileCount }] of pkgMap) {
  totalAny += anyCount;
  totalFiles += fileCount;

  const coverage =
    anyCount === 0 ? 100 : Math.max(0, 100 - (anyCount / (fileCount * 5)) * 10);

  coverages.push({
    package: pkg,
    anyCount,
    totalAnyKeywords: anyCount,
    coverage: Math.round(coverage * 10) / 10,
    fileCount,
  });
}

coverages.sort((a, b) => a.anyCount - b.anyCount);

if (jsonMode) {
  console.log(
    JSON.stringify(
      {
        summary: { totalAnyUsages: totalAny, totalFiles, threshold },
        packages: coverages,
      },
      null,
      2,
    ),
  );
} else {
  const PASS = "✅";
  const WARN = "⚠️ ";
  const FAIL = "❌";

  console.log("\n╔════════════════════════════════════════════════════════╗");
  console.log("║            Bunest Type Coverage Report                 ║");
  console.log("╚════════════════════════════════════════════════════════╝\n");

  console.log(
    `  ${"Package".padEnd(32)} ${"any count".padStart(10)} ${"files".padStart(7)} ${"any/file".padStart(9)}`,
  );
  console.log("  " + "─".repeat(62));

  for (const c of coverages) {
    const anyPerFile = (c.anyCount / c.fileCount).toFixed(1);
    const icon =
      c.anyCount === 0
        ? PASS
        : c.anyCount < 10
          ? PASS
          : c.anyCount < 50
            ? WARN
            : FAIL;
    console.log(
      `${icon} ${c.package.padEnd(32)} ${String(c.anyCount).padStart(10)} ${String(c.fileCount).padStart(7)} ${anyPerFile.padStart(9)}`,
    );
  }

  console.log("  " + "─".repeat(62));
  const avgPerFile =
    totalFiles > 0 ? (totalAny / totalFiles).toFixed(1) : "0.0";
  console.log(
    `   ${"TOTAL".padEnd(32)} ${String(totalAny).padStart(10)} ${String(totalFiles).padStart(7)} ${avgPerFile.padStart(9)}`,
  );

  console.log(
    `\n📊 Total \`any\` usages across ${totalFiles} files: ${totalAny}`,
  );
  console.log(`   Goal: Reduce to 0, one package at a time.\n`);
  console.log("   Run with --json for CI integration");
  console.log("   Run with --package <name> to check a single package\n");
}
