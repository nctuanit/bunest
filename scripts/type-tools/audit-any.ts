/**
 * audit-any.ts
 *
 * Uses Bunest's native zero-dependency TypeScript scanner to scan the monorepo,
 * count, and classify all `any` type usages across files and packages.
 *
 * Usage:
 *   bun run scripts/type-tools/audit-any.ts
 *   bun run scripts/type-tools/audit-any.ts --json          # JSON output
 *   bun run scripts/type-tools/audit-any.ts --package mongoose  # filter by package
 */

import { join, relative } from "../../packages/core/src/common/index";
import {
  collectTsConfigFiles,
  scanTypeScriptSource,
  type SimpleAnyKind,
} from "./ts-scanner";

const SCRIPT_DIR = import.meta.dirname;
const ROOT = join(SCRIPT_DIR, "../..");
const TSCONFIG = join(ROOT, "tsconfig.json");

type AnyKind = SimpleAnyKind;

interface AnyUsage {
  file: string;
  package: string;
  line: number;
  col: number;
  context: string;
  kind: AnyKind;
}

interface FileReport {
  file: string;
  package: string;
  total: number;
  byKind: Partial<Record<AnyKind, number>>;
  usages: AnyUsage[];
}

interface PackageReport {
  package: string;
  total: number;
  fileCount: number;
  files: FileReport[];
}

function getPackageName(filePath: string): string {
  const rel = relative(ROOT, filePath).replace(/\\/g, "/");
  const match = rel.match(/^packages\/([^/]+)\//);
  return match?.[1] ? `@bunest/${match[1]}` : "root";
}

async function analyzeFile(filePath: string): Promise<FileReport> {
  const relFile = relative(ROOT, filePath).replace(/\\/g, "/");
  const pkg = getPackageName(filePath);
  const source = await Bun.file(filePath).text();
  const { hits } = scanTypeScriptSource(source, filePath);

  const usages: AnyUsage[] = [];
  for (const hit of hits) {
    if (hit.keyword !== "any") continue;
    usages.push({
      file: relFile,
      package: pkg,
      line: hit.line,
      col: hit.lineStartOffset,
      context: hit.lineText.slice(0, 80),
      kind: hit.simpleKind,
    });
  }

  const byKind: Partial<Record<AnyKind, number>> = {};
  for (const u of usages) {
    byKind[u.kind] = (byKind[u.kind] ?? 0) + 1;
  }

  return {
    file: relFile,
    package: pkg,
    total: usages.length,
    byKind,
    usages,
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const jsonMode = args.includes("--json");
const pkgFilter =
  args.find((a) => a.startsWith("--package="))?.split("=")[1] ??
  (args.indexOf("--package") !== -1
    ? args[args.indexOf("--package") + 1]
    : undefined);

console.error("🔍 Loading TypeScript project (Bunest native AST)...");
const allFiles = collectTsConfigFiles(ROOT, TSCONFIG);
console.error(`📂 Analysing ${allFiles.length} source files...`);

const fileReports: FileReport[] = [];

for (const fp of allFiles) {
  const normFp = fp.replace(/\\/g, "/");
  if (pkgFilter && !normFp.includes(`/packages/${pkgFilter}/`)) continue;
  const report = await analyzeFile(fp);
  if (report.total > 0) fileReports.push(report);
}

fileReports.sort((a, b) => b.total - a.total);

// Group by package
const pkgMap = new Map<string, PackageReport>();
for (const fr of fileReports) {
  if (!pkgMap.has(fr.package)) {
    pkgMap.set(fr.package, {
      package: fr.package,
      total: 0,
      fileCount: 0,
      files: [],
    });
  }
  const pr = pkgMap.get(fr.package)!;
  pr.total += fr.total;
  pr.fileCount++;
  pr.files.push(fr);
}

const pkgReports = [...pkgMap.values()].sort((a, b) => b.total - a.total);
const grandTotal = pkgReports.reduce((s, p) => s + p.total, 0);

if (jsonMode) {
  console.log(JSON.stringify({ grandTotal, packages: pkgReports }, null, 2));
} else {
  // ─── Pretty Table Output ───────────────────────────────────────────────────
  console.log("\n╔══════════════════════════════════════════════════════╗");
  console.log("║           Bunest `any` Usage Audit Report            ║");
  console.log("╚══════════════════════════════════════════════════════╝\n");

  console.log("📦 BY PACKAGE");
  console.log("─".repeat(60));
  for (const pr of pkgReports) {
    const bar = "█".repeat(Math.min(Math.round(pr.total / 2), 30));
    console.log(
      `  ${pr.package.padEnd(35)} ${String(pr.total).padStart(4)} ${bar}`,
    );
  }
  console.log("─".repeat(60));
  console.log(`  ${"TOTAL".padEnd(35)} ${String(grandTotal).padStart(4)}\n`);

  console.log("📄 TOP FILES");
  console.log("─".repeat(60));
  for (const fr of fileReports.slice(0, 20)) {
    console.log(`  ${String(fr.total).padStart(4)}  ${fr.file}`);
  }

  if (fileReports.length > 20) {
    console.log(`  ... and ${fileReports.length - 20} more files\n`);
  }

  console.log("\n🏷️  BY KIND (totals across all packages)");
  console.log("─".repeat(60));
  const kindTotals: Partial<Record<AnyKind, number>> = {};
  for (const fr of fileReports) {
    for (const [k, v] of Object.entries(fr.byKind)) {
      kindTotals[k as AnyKind] = (kindTotals[k as AnyKind] ?? 0) + (v ?? 0);
    }
  }
  for (const [kind, count] of Object.entries(kindTotals).sort(
    ([, a], [, b]) => (b ?? 0) - (a ?? 0),
  )) {
    console.log(`  ${kind.padEnd(20)} ${String(count).padStart(4)}`);
  }

  console.log("\n✅ Run with --json for machine-readable output");
  console.log("   Run with --package <name> to filter to one package\n");
}
