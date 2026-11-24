/**
 * audit-generic-defaults.ts
 *
 * Uses Bunest's native zero-dependency TypeScript scanner to find all
 * TypeParameters with default = `any`, inspect context, and suggest safer
 * replacements.
 *
 * Usage:
 *   bun run scripts/type-tools/audit-generic-defaults.ts
 *   bun run scripts/type-tools/audit-generic-defaults.ts --json
 */

import { join, relative } from "../../packages/core/src/common/index";
import { collectTsConfigFiles, scanTypeScriptSource } from "./ts-scanner";

const SCRIPT_DIR = import.meta.dirname;
const ROOT = join(SCRIPT_DIR, "../..");
const TSCONFIG = join(ROOT, "tsconfig.json");

interface GenericDefaultIssue {
  file: string;
  line: number;
  typeName: string; // e.g. "MongooseQuery"
  paramName: string; // e.g. "TResult"
  currentDefault: string; // "any"
  suggestion: string; // "unknown" | "void" | "object"
  context: string;
}

function getSuggestion(paramName: string, typeName: string): string {
  const lowerParam = paramName.toLowerCase();
  const lowerType = typeName.toLowerCase();

  // Result types → unknown is safer than any
  if (lowerParam.includes("result") || lowerParam.includes("return"))
    return "unknown";
  // Event/command/query base types → keep specific base interfaces
  if (lowerType.includes("handler")) return "void";
  // Data shapes → object
  if (lowerParam.startsWith("t") && lowerParam.length <= 3) return "unknown";
  return "unknown";
}

console.error("🔍 Loading TypeScript project (Bunest native AST)...");
const sourceFiles = collectTsConfigFiles(ROOT, TSCONFIG);
console.error(`📂 Analysing ${sourceFiles.length} files...`);

const args = process.argv.slice(2);
const jsonMode = args.includes("--json");

const issues: GenericDefaultIssue[] = [];

for (const fp of sourceFiles) {
  const normFp = fp.replace(/\\/g, "/");
  if (!normFp.includes("/packages/")) continue;

  const relFile = relative(ROOT, fp).replace(/\\/g, "/");
  const source = await Bun.file(fp).text();
  const { genericDefaults } = scanTypeScriptSource(source, fp);

  for (const hit of genericDefaults) {
    issues.push({
      file: relFile,
      line: hit.line,
      typeName: hit.typeName,
      paramName: hit.paramName,
      currentDefault: hit.currentDefault,
      suggestion: getSuggestion(hit.paramName, hit.typeName),
      context: hit.context,
    });
  }
}

issues.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

if (jsonMode) {
  console.log(JSON.stringify(issues, null, 2));
} else {
  console.log("\n╔════════════════════════════════════════════════════════╗");
  console.log("║     Generic Defaults `= any` Audit Report             ║");
  console.log("╚════════════════════════════════════════════════════════╝\n");
  console.log(`Found ${issues.length} generic parameters with default = any\n`);

  let currentFile = "";
  for (const issue of issues) {
    if (issue.file !== currentFile) {
      console.log(`\n📄 ${issue.file}`);
      currentFile = issue.file;
    }
    console.log(
      `   L${issue.line}  ${issue.typeName}<${issue.paramName} = any>  →  suggest: = ${issue.suggestion}`,
    );
    console.log(`         ${issue.context}`);
  }

  console.log("\n✅ Run with --json for machine-readable output");
  console.log(
    "   These can be changed gradually; unknown is safer than any.\n",
  );
}
