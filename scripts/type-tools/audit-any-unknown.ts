/**
 * audit-any-unknown.ts
 *
 * Uses Bunest's native zero-dependency TypeScript AST scanner to scan all
 * occurrences of `any` and `unknown` across the Bunest monorepo, classify them
 * by AST role, API visibility, and semantic pattern, and generate both JSON
 * and Markdown reports.
 *
 * Usage:
 *   bun run scripts/type-tools/audit-any-unknown.ts
 *   bun run scripts/type-tools/audit-any-unknown.ts --package mongoose
 *   bun run scripts/type-tools/audit-any-unknown.ts --src-only
 *   bun run scripts/type-tools/audit-any-unknown.ts --out-dir reports
 */

import {
  ensureDir,
  join,
  relative,
  resolve,
} from "../../packages/core/src/common/index";
import {
  collectGlobFiles,
  scanTypeScriptSource,
  type DetailedAstKind,
  type KeywordType,
  type TypeKeywordHit,
} from "./ts-scanner";

const SCRIPT_DIR = import.meta.dirname;
const ROOT = join(SCRIPT_DIR, "../..");

type FileScope =
  | "package-src"
  | "package-test"
  | "root-test"
  | "apps"
  | "examples"
  | "benchmarks"
  | "scripts"
  | "root";

type AstKind = DetailedAstKind;

type PatternTag =
  | "double-cast"
  | "cast-to-any"
  | "cast-to-unknown"
  | "record-string-any"
  | "record-string-unknown"
  | "variadic-constructor-or-fn"
  | "conditional-type-check"
  | "generic-default-any"
  | "generic-default-unknown"
  | "generic-constraint"
  | "error-or-catch"
  | "decorator-or-reflect"
  | "map-set-promise-container"
  | "index-signature"
  | "array-any-or-unknown"
  | "untyped-parameter"
  | "untyped-return"
  | "untyped-property"
  | "untyped-variable"
  | "other";

interface UsageEntry {
  keyword: KeywordType;
  file: string;
  package: string;
  scope: FileScope;
  line: number;
  col: number;
  astKind: AstKind;
  pattern: PatternTag;
  isPublicApi: boolean;
  enclosing: string;
  outerType: string;
  containerTypeName?: string;
  symbolName?: string;
  lineText: string;
}

interface PackageSummary {
  package: string;
  total: number;
  anyCount: number;
  unknownCount: number;
  publicApiAny: number;
  publicApiUnknown: number;
  srcAny: number;
  srcUnknown: number;
  testAny: number;
  testUnknown: number;
  fileCount: number;
  byPattern: Record<string, number>;
}

interface FileSummary {
  file: string;
  package: string;
  scope: FileScope;
  total: number;
  anyCount: number;
  unknownCount: number;
  publicApiCount: number;
  byPattern: Record<string, number>;
}

function getFileScope(relPath: string): FileScope {
  if (/^packages\/[^/]+\/src\//.test(relPath)) return "package-src";
  if (/^packages\/[^/]+\/(test|tests|__tests__)\//.test(relPath))
    return "package-test";
  if (/\.(spec|test)\.tsx?$/.test(relPath)) {
    return relPath.startsWith("packages/") ? "package-test" : "root-test";
  }
  if (relPath.startsWith("tests/")) return "root-test";
  if (relPath.startsWith("apps/")) return "apps";
  if (relPath.startsWith("examples/")) return "examples";
  if (relPath.startsWith("benchmarks/")) return "benchmarks";
  if (relPath.startsWith("scripts/")) return "scripts";
  return "root";
}

function getPackageName(relPath: string): string {
  const pkgMatch = relPath.match(/^packages\/([^/]+)\//);
  if (pkgMatch?.[1]) return `@bunest/${pkgMatch[1]}`;
  const appMatch = relPath.match(/^apps\/([^/]+)\//);
  if (appMatch?.[1]) return `apps/${appMatch[1]}`;
  const exMatch = relPath.match(/^examples\/([^/]+)\//);
  if (exMatch?.[1]) return `examples/${exMatch[1]}`;
  if (relPath.startsWith("tests/")) return "tests";
  if (relPath.startsWith("benchmarks/")) return "benchmarks";
  if (relPath.startsWith("scripts/")) return "scripts";
  return "root";
}

function classifyPattern(hit: TypeKeywordHit, lineText: string): PatternTag {
  const {
    keyword,
    astKind,
    outerType,
    containerTypeName,
    enclosing,
    symbolName,
  } = hit;

  if (astKind === "double-cast") return "double-cast";
  if (astKind === "type-assertion") {
    return keyword === "any" ? "cast-to-any" : "cast-to-unknown";
  }
  if (astKind === "conditional-extends") return "conditional-type-check";
  if (astKind === "record-value") {
    return keyword === "any" ? "record-string-any" : "record-string-unknown";
  }
  if (astKind === "index-signature") return "index-signature";
  if (astKind === "generic-default") {
    return keyword === "any"
      ? "generic-default-any"
      : "generic-default-unknown";
  }
  if (astKind === "generic-constraint") return "generic-constraint";

  // Catch/error handling
  if (astKind === "catch-clause") return "error-or-catch";
  const lowerSym = (symbolName ?? "").toLowerCase();
  const lowerLine = lineText.toLowerCase();
  if (
    lowerSym === "err" ||
    lowerSym === "error" ||
    lowerSym === "exception" ||
    lowerSym === "reason" ||
    lowerSym === "cause"
  ) {
    return "error-or-catch";
  }

  // Variadic constructor / function types like `new (...args: any[]) => T` or `(...args: any[]) => any`
  if (
    astKind === "constructor-type" ||
    astKind === "function-type" ||
    astKind === "rest-args" ||
    /\(\s*\.\.\.\w+:\s*(any|unknown)\[\]\s*\)\s*=>/.test(outerType)
  ) {
    return "variadic-constructor-or-fn";
  }

  // Decorator / Reflect metadata patterns
  if (
    lowerLine.includes("reflect.") ||
    lowerLine.includes("propertydescriptor") ||
    lowerLine.includes("decorator") ||
    enclosing.toLowerCase().includes("decorator") ||
    lowerSym === "target" ||
    lowerSym === "descriptor"
  ) {
    return "decorator-or-reflect";
  }

  if (astKind === "generic-arg") {
    if (
      containerTypeName &&
      [
        "Map",
        "Set",
        "WeakMap",
        "WeakSet",
        "Promise",
        "Observable",
        "Record",
        "Partial",
      ].includes(containerTypeName)
    ) {
      return "map-set-promise-container";
    }
  }

  if (astKind === "array-element") return "array-any-or-unknown";
  if (astKind === "parameter") return "untyped-parameter";
  if (astKind === "return-type") return "untyped-return";
  if (astKind === "property") return "untyped-property";
  if (astKind === "variable") return "untyped-variable";

  // Check if nested inside Record<..., ...> (e.g. Record<string, any[]>)
  if (hit.insideRecordAncestor) {
    return keyword === "any" ? "record-string-any" : "record-string-unknown";
  }

  return "other";
}

async function analyzeSourceFile(filePath: string): Promise<UsageEntry[]> {
  const relFile = relative(ROOT, filePath).replace(/\\/g, "/");
  const scope = getFileScope(relFile);
  const pkg = getPackageName(relFile);
  const source = await Bun.file(filePath).text();
  const { hits } = scanTypeScriptSource(source, filePath);

  const entries: UsageEntry[] = [];
  for (const hit of hits) {
    const lineText = hit.lineText.slice(0, 140);
    const pattern = classifyPattern(hit, lineText);
    entries.push({
      keyword: hit.keyword,
      file: relFile,
      package: pkg,
      scope,
      line: hit.line,
      col: hit.col,
      astKind: hit.astKind,
      pattern,
      isPublicApi: hit.isPublicApi,
      enclosing: hit.enclosing,
      outerType: hit.outerType,
      containerTypeName: hit.containerTypeName,
      symbolName: hit.symbolName,
      lineText,
    });
  }

  return entries;
}

function generateMarkdownReport(
  allEntries: UsageEntry[],
  srcEntries: UsageEntry[],
  pkgSummaries: PackageSummary[],
  srcFileSummaries: FileSummary[],
  scannedFileCount: number,
): string {
  const totalAny = allEntries.filter((e) => e.keyword === "any").length;
  const totalUnknown = allEntries.filter((e) => e.keyword === "unknown").length;
  const srcAny = srcEntries.filter((e) => e.keyword === "any").length;
  const srcUnknown = srcEntries.filter((e) => e.keyword === "unknown").length;
  const pubAny = srcEntries.filter(
    (e) => e.keyword === "any" && e.isPublicApi,
  ).length;
  const pubUnknown = srcEntries.filter(
    (e) => e.keyword === "unknown" && e.isPublicApi,
  ).length;

  const lines: string[] = [];
  lines.push("# Bunest `any` & `unknown` AST Audit Report");
  lines.push("");
  lines.push(`Generated at: ${new Date().toISOString()}`);
  lines.push(`Scanned files: **${scannedFileCount}**`);
  lines.push("");

  // 1. Overview
  lines.push("## 1. Executive Summary");
  lines.push("");
  lines.push("| Metric | `any` | `unknown` | Total |");
  lines.push("| --- | ---: | ---: | ---: |");
  lines.push(
    `| **All scanned files** | ${totalAny} | ${totalUnknown} | ${allEntries.length} |`,
  );
  lines.push(
    `| **Production (\`packages/*/src\`)** | ${srcAny} | ${srcUnknown} | ${srcEntries.length} |`,
  );
  lines.push(
    `| **Public API signatures (\`packages/*/src\`)** | ${pubAny} | ${pubUnknown} | ${pubAny + pubUnknown} |`,
  );
  lines.push(
    `| **Internal impl (\`packages/*/src\`)** | ${srcAny - pubAny} | ${srcUnknown - pubUnknown} | ${srcEntries.length - pubAny - pubUnknown} |`,
  );
  lines.push("");

  // 2. By Scope
  lines.push("## 2. Breakdown by Scope");
  lines.push("");
  const scopeCounts = new Map<
    FileScope,
    { any: number; unknown: number; files: Set<string> }
  >();
  for (const e of allEntries) {
    const curr = scopeCounts.get(e.scope) ?? {
      any: 0,
      unknown: 0,
      files: new Set(),
    };
    curr[e.keyword]++;
    curr.files.add(e.file);
    scopeCounts.set(e.scope, curr);
  }
  lines.push("| Scope | Files w/ hits | `any` | `unknown` | Total |");
  lines.push("| --- | ---: | ---: | ---: | ---: |");
  for (const [scope, data] of [...scopeCounts.entries()].sort(
    (a, b) => b[1].any + b[1].unknown - (a[1].any + a[1].unknown),
  )) {
    lines.push(
      `| \`${scope}\` | ${data.files.size} | ${data.any} | ${data.unknown} | ${data.any + data.unknown} |`,
    );
  }
  lines.push("");

  // 3. By Pattern (Production packages/*/src)
  lines.push("## 3. Production (`packages/*/src`) by Pattern");
  lines.push("");
  const patternMap = new Map<
    string,
    {
      any: number;
      unknown: number;
      pubAny: number;
      pubUnknown: number;
      examples: UsageEntry[];
    }
  >();
  for (const e of srcEntries) {
    const curr = patternMap.get(e.pattern) ?? {
      any: 0,
      unknown: 0,
      pubAny: 0,
      pubUnknown: 0,
      examples: [],
    };
    curr[e.keyword]++;
    if (e.isPublicApi) {
      if (e.keyword === "any") curr.pubAny++;
      else curr.pubUnknown++;
    }
    if (curr.examples.length < 3) curr.examples.push(e);
    patternMap.set(e.pattern, curr);
  }
  lines.push(
    "| Pattern | `any` (Public) | `unknown` (Public) | Total | Sample |",
  );
  lines.push("| --- | ---: | ---: | ---: | --- |");
  for (const [pattern, d] of [...patternMap.entries()].sort(
    (a, b) => b[1].any + b[1].unknown - (a[1].any + a[1].unknown),
  )) {
    const sample = d.examples[0]
      ? `\`${d.examples[0].file}:${d.examples[0].line}\` → \`${d.examples[0].outerType.replace(/\|/g, "\\|").slice(0, 60)}\``
      : "";
    lines.push(
      `| \`${pattern}\` | ${d.any} (${d.pubAny}) | ${d.unknown} (${d.pubUnknown}) | ${d.any + d.unknown} | ${sample} |`,
    );
  }
  lines.push("");

  // 4. By AST Kind (Production packages/*/src)
  lines.push("## 4. Production (`packages/*/src`) by AST Kind");
  lines.push("");
  const kindMap = new Map<
    string,
    { any: number; unknown: number; pub: number }
  >();
  for (const e of srcEntries) {
    const curr = kindMap.get(e.astKind) ?? { any: 0, unknown: 0, pub: 0 };
    curr[e.keyword]++;
    if (e.isPublicApi) curr.pub++;
    kindMap.set(e.astKind, curr);
  }
  lines.push("| AST Kind | `any` | `unknown` | Public API | Total |");
  lines.push("| --- | ---: | ---: | ---: | ---: |");
  for (const [kind, d] of [...kindMap.entries()].sort(
    (a, b) => b[1].any + b[1].unknown - (a[1].any + a[1].unknown),
  )) {
    lines.push(
      `| \`${kind}\` | ${d.any} | ${d.unknown} | ${d.pub} | ${d.any + d.unknown} |`,
    );
  }
  lines.push("");

  // 5. By Package (sorted by src total)
  lines.push("## 5. Breakdown by Package");
  lines.push("");
  lines.push(
    "| Package | src `any` | src `unknown` | Public API (`any`/`unknown`) | test `any` | test `unknown` | Total |",
  );
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
  const pkgSorted = [...pkgSummaries].sort(
    (a, b) =>
      b.srcAny + b.srcUnknown - (a.srcAny + a.srcUnknown) || b.total - a.total,
  );
  for (const p of pkgSorted) {
    lines.push(
      `| \`${p.package}\` | ${p.srcAny} | ${p.srcUnknown} | ${p.publicApiAny} / ${p.publicApiUnknown} | ${p.testAny} | ${p.testUnknown} | ${p.total} |`,
    );
  }
  lines.push("");

  // 6. Top Production Files
  lines.push("## 6. Top 40 Production Files (`packages/*/src`)");
  lines.push("");
  lines.push(
    "| File | `any` | `unknown` | Public API | Total | Top Patterns |",
  );
  lines.push("| --- | ---: | ---: | ---: | ---: | --- |");
  for (const f of srcFileSummaries.slice(0, 40)) {
    const topPats = Object.entries(f.byPattern)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([k, v]) => `${k}(${v})`)
      .join(", ");
    lines.push(
      `| \`${f.file}\` | ${f.anyCount} | ${f.unknownCount} | ${f.publicApiCount} | ${f.total} | ${topPats} |`,
    );
  }
  lines.push("");

  // 7. Generic Container breakdown (Promise<any>, Map<string, unknown>, etc.)
  lines.push("## 7. Container Generic Types (`packages/*/src`)");
  lines.push("");
  const containerMap = new Map<string, { any: number; unknown: number }>();
  for (const e of srcEntries) {
    if (!e.containerTypeName) continue;
    const curr = containerMap.get(e.containerTypeName) ?? {
      any: 0,
      unknown: 0,
    };
    curr[e.keyword]++;
    containerMap.set(e.containerTypeName, curr);
  }
  lines.push("| Container Type | `any` | `unknown` | Total |");
  lines.push("| --- | ---: | ---: | ---: |");
  for (const [name, d] of [...containerMap.entries()]
    .sort((a, b) => b[1].any + b[1].unknown - (a[1].any + a[1].unknown))
    .slice(0, 25)) {
    lines.push(
      `| \`${name}<...>\` | ${d.any} | ${d.unknown} | ${d.any + d.unknown} |`,
    );
  }
  lines.push("");

  // 8. All Production `any` Occurrences (detailed list if reasonable, or top packages)
  const srcAnyEntries = srcEntries.filter((e) => e.keyword === "any");
  lines.push(
    `## 8. Production \`any\` Occurrences (${srcAnyEntries.length} total)`,
  );
  lines.push("");
  if (srcAnyEntries.length <= 400) {
    for (const e of srcAnyEntries) {
      const apiTag = e.isPublicApi ? "[API]" : "[impl]";
      lines.push(
        `- \`${e.file}:${e.line}\` ${apiTag} \`${e.pattern}\` (${e.enclosing}) — \`${e.lineText.replace(/`/g, "'")}\``,
      );
    }
  } else {
    lines.push(
      `> ${srcAnyEntries.length} production \`any\` occurrences found — see \`any-unknown-report.json\` for the complete list. Showing first 150 Public API \`any\` occurrences:`,
    );
    lines.push("");
    for (const e of srcAnyEntries.filter((x) => x.isPublicApi).slice(0, 150)) {
      lines.push(
        `- \`${e.file}:${e.line}\` \`${e.pattern}\` (${e.enclosing}) — \`${e.lineText.replace(/`/g, "'")}\``,
      );
    }
  }
  lines.push("");

  return lines.join("\n");
}

// ─── Main ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const srcOnly = args.includes("--src-only");
const pkgFilter =
  args.find((a) => a.startsWith("--package="))?.split("=")[1] ??
  (args.indexOf("--package") !== -1
    ? args[args.indexOf("--package") + 1]
    : undefined);
const outDirArg =
  args.find((a) => a.startsWith("--out-dir="))?.split("=")[1] ??
  (args.indexOf("--out-dir") !== -1
    ? args[args.indexOf("--out-dir") + 1]
    : undefined);

const outDir = outDirArg
  ? resolve(ROOT, outDirArg)
  : join(SCRIPT_DIR, "reports");

console.error("🔍 Initializing Bunest native TypeScript scanner...");

const globs = pkgFilter
  ? srcOnly
    ? [
        `packages/${pkgFilter}/src/**/*.ts`,
        "!**/node_modules/**",
        "!**/dist/**",
        "!**/*.d.ts",
      ]
    : [
        `packages/${pkgFilter}/src/**/*.ts`,
        `packages/${pkgFilter}/test/**/*.ts`,
        "!**/node_modules/**",
        "!**/dist/**",
        "!**/*.d.ts",
      ]
  : srcOnly
    ? [
        "packages/*/src/**/*.ts",
        "!**/node_modules/**",
        "!**/dist/**",
        "!**/*.d.ts",
      ]
    : [
        "packages/*/src/**/*.ts",
        "packages/*/test/**/*.ts",
        "tests/**/*.ts",
        "apps/**/*.ts",
        "apps/**/*.tsx",
        "examples/**/*.ts",
        "benchmarks/**/*.ts",
        "!**/node_modules/**",
        "!**/dist/**",
        "!**/*.d.ts",
      ];

const sourceFiles = collectGlobFiles(ROOT, globs);
console.error(`📂 Scanning ${sourceFiles.length} TypeScript files...`);

const allEntries: UsageEntry[] = [];
for (const fp of sourceFiles) {
  const entries = await analyzeSourceFile(fp);
  if (entries.length > 0) {
    allEntries.push(...entries);
  }
}

const srcEntries = allEntries.filter((e) => e.scope === "package-src");

// Package summaries
const pkgMap = new Map<string, PackageSummary & { _files: Set<string> }>();
for (const e of allEntries) {
  let summary = pkgMap.get(e.package);
  if (!summary) {
    summary = {
      package: e.package,
      total: 0,
      anyCount: 0,
      unknownCount: 0,
      publicApiAny: 0,
      publicApiUnknown: 0,
      srcAny: 0,
      srcUnknown: 0,
      testAny: 0,
      testUnknown: 0,
      fileCount: 0,
      byPattern: {},
      _files: new Set<string>(),
    };
    pkgMap.set(e.package, summary);
  }
  summary.total++;
  summary._files.add(e.file);
  if (e.keyword === "any") summary.anyCount++;
  else summary.unknownCount++;

  if (e.scope === "package-src") {
    if (e.keyword === "any") summary.srcAny++;
    else summary.srcUnknown++;
    if (e.isPublicApi) {
      if (e.keyword === "any") summary.publicApiAny++;
      else summary.publicApiUnknown++;
    }
  } else if (e.scope === "package-test" || e.scope === "root-test") {
    if (e.keyword === "any") summary.testAny++;
    else summary.testUnknown++;
  }
  summary.byPattern[e.pattern] = (summary.byPattern[e.pattern] ?? 0) + 1;
}

const pkgSummaries: PackageSummary[] = [...pkgMap.values()].map(
  ({ _files, ...rest }) => ({
    ...rest,
    fileCount: _files.size,
  }),
);

// File summaries (production)
const fileMap = new Map<string, FileSummary>();
for (const e of srcEntries) {
  let fs = fileMap.get(e.file);
  if (!fs) {
    fs = {
      file: e.file,
      package: e.package,
      scope: e.scope,
      total: 0,
      anyCount: 0,
      unknownCount: 0,
      publicApiCount: 0,
      byPattern: {},
    };
    fileMap.set(e.file, fs);
  }
  fs.total++;
  if (e.keyword === "any") fs.anyCount++;
  else fs.unknownCount++;
  if (e.isPublicApi) fs.publicApiCount++;
  fs.byPattern[e.pattern] = (fs.byPattern[e.pattern] ?? 0) + 1;
}

const srcFileSummaries = [...fileMap.values()].sort(
  (a, b) => b.total - a.total,
);

await ensureDir(outDir);

const jsonPath = join(outDir, "any-unknown-report.json");
const mdPath = join(outDir, "any-unknown-report.md");

const jsonPayload = {
  generatedAt: new Date().toISOString(),
  scannedFileCount: sourceFiles.length,
  summary: {
    all: {
      total: allEntries.length,
      any: allEntries.filter((e) => e.keyword === "any").length,
      unknown: allEntries.filter((e) => e.keyword === "unknown").length,
    },
    packageSrc: {
      total: srcEntries.length,
      any: srcEntries.filter((e) => e.keyword === "any").length,
      unknown: srcEntries.filter((e) => e.keyword === "unknown").length,
      publicApiAny: srcEntries.filter(
        (e) => e.keyword === "any" && e.isPublicApi,
      ).length,
      publicApiUnknown: srcEntries.filter(
        (e) => e.keyword === "unknown" && e.isPublicApi,
      ).length,
    },
  },
  packages: pkgSummaries.sort(
    (a, b) =>
      b.srcAny + b.srcUnknown - (a.srcAny + a.srcUnknown) || b.total - a.total,
  ),
  topSrcFiles: srcFileSummaries.slice(0, 100),
  entries: allEntries,
};

await Bun.write(jsonPath, JSON.stringify(jsonPayload, null, 2));
await Bun.write(
  mdPath,
  generateMarkdownReport(
    allEntries,
    srcEntries,
    pkgSummaries,
    srcFileSummaries,
    sourceFiles.length,
  ),
);

console.error(`✅ Reports generated:`);
console.error(`   - ${relative(ROOT, mdPath)}`);
console.error(`   - ${relative(ROOT, jsonPath)}`);
console.error(
  `📊 Total: ${jsonPayload.summary.all.total} (any: ${jsonPayload.summary.all.any}, unknown: ${jsonPayload.summary.all.unknown}) | package-src: ${jsonPayload.summary.packageSrc.total} (any: ${jsonPayload.summary.packageSrc.any}, unknown: ${jsonPayload.summary.packageSrc.unknown})`,
);
