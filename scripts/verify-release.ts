import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

interface PackageJson {
  name?: string;
  version?: string;
  license?: string;
  type?: string;
  engines?: Record<string, string>;
  repository?: { type?: string; url?: string; directory?: string } | string;
  files?: string[];
  exports?: Record<
    string,
    string | { types?: string; bun?: string; import?: string; default?: string }
  >;
  bin?: Record<string, string> | string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

interface ParsedImport {
  specifier: string;
  isTypeOnly: boolean;
}

const REPO_ROOT = resolve(import.meta.dir, "..");
const PACKAGES_DIR = join(REPO_ROOT, "packages");

function walkTsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      results.push(...walkTsFiles(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Strips single-line comments, block comments, and string contents selectively?
 * We strip comments so commented-out imports are never scanned, while preserving
 * import/export statement strings.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:\\])\/\/[^\n]*/g, "$1");
}

/**
 * Extracts relative ESM import/export edges, distinguishing runtime value edges
 * from pure TypeScript type-only edges (`import type`, `export type`, or
 * named lists where every specifier is prefixed with `type `).
 */
function parseRelativeImports(source: string): ParsedImport[] {
  const clean = stripComments(source);
  const results: ParsedImport[] = [];

  // 1. Bare side-effect imports: `import "./foo"`
  const sideEffectRegex = /^\s*import\s+["'](\.[^"']+)["']\s*;?/gm;
  for (const match of clean.matchAll(sideEffectRegex)) {
    results.push({ specifier: match[1]!, isTypeOnly: false });
  }

  // 2. Standard import / re-export statements with `from "./..."`
  const fromRegex =
    /(?:^|;|\n)\s*(import|export)\s+(type\s+)?([\s\S]*?)\s+from\s+["'](\.[^"']+)["']/g;

  for (const match of clean.matchAll(fromRegex)) {
    const typeKeyword = match[2];
    const clause = (match[3] ?? "").trim();
    const specifier = match[4]!;

    if (typeKeyword) {
      results.push({ specifier, isTypeOnly: true });
      continue;
    }

    // Check if named import/export block contains ONLY `type ...` specifiers:
    // e.g. `import { type Foo, type Bar as Baz } from "./x"`
    if (clause.startsWith("{") && clause.endsWith("}")) {
      const inner = clause.slice(1, -1).trim();
      const items = inner
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const allType =
        items.length > 0 && items.every((item) => /^type\s+/.test(item));
      results.push({ specifier, isTypeOnly: allType });
      continue;
    }

    results.push({ specifier, isTypeOnly: false });
  }

  return results;
}

function resolveTsTarget(fromFile: string, specifier: string): string | null {
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

function findCycles(graph: Map<string, string[]>): string[][] {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cycles: string[][] = [];
  const seenSignatures = new Set<string>();

  function dfs(node: string, stack: string[]) {
    if (visiting.has(node)) {
      const start = stack.indexOf(node);
      const cycle = [...stack.slice(start), node];
      const canonical = [...cycle.slice(0, -1)].sort().join("|");
      if (!seenSignatures.has(canonical)) {
        seenSignatures.add(canonical);
        cycles.push(cycle);
      }
      return;
    }
    if (visited.has(node)) return;

    visiting.add(node);
    for (const dep of graph.get(node) ?? []) {
      dfs(dep, [...stack, node]);
    }
    visiting.delete(node);
    visited.add(node);
  }

  for (const node of graph.keys()) {
    dfs(node, []);
  }
  return cycles;
}

async function runCliSmokeTest(errors: string[]): Promise<string> {
  const cliBin = join(PACKAGES_DIR, "cli", "dist", "cli.js");
  if (!existsSync(cliBin)) {
    errors.push(`CLI smoke test skipped: missing built binary ${cliBin}`);
    return "FAIL (missing dist/cli.js)";
  }

  const tmpRoot = await mkdtemp(join(tmpdir(), "bunest-release-smoke-"));
  const appDir = join(tmpRoot, "smoke-app");
  try {
    // 1. `bunest new smoke-app --dir <appDir> --skip-install`
    const newProc = Bun.spawnSync(
      ["bun", cliBin, "new", "smoke-app", "--dir", appDir, "--skip-install"],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (newProc.exitCode !== 0) {
      errors.push(
        `CLI smoke test 'bunest new' failed (exit ${newProc.exitCode}): ${newProc.stderr.toString() || newProc.stdout.toString()}`,
      );
      return "FAIL (bunest new)";
    }

    const expectedNewFiles = [
      "package.json",
      "tsconfig.json",
      "src/main.ts",
      "src/app.module.ts",
      "src/app.controller.ts",
      "src/app.service.ts",
      "test/app.spec.ts",
    ];
    for (const rel of expectedNewFiles) {
      if (!existsSync(join(appDir, rel))) {
        errors.push(`CLI smoke test missing scaffolded file: smoke-app/${rel}`);
      }
    }

    // Verify generated tsconfig enables legacy decorators + verbatimModuleSyntax
    const tsconfigPath = join(appDir, "tsconfig.json");
    if (existsSync(tsconfigPath)) {
      const tsconfigText = readFileSync(tsconfigPath, "utf8");
      if (
        !tsconfigText.includes("experimentalDecorators") ||
        !tsconfigText.includes("emitDecoratorMetadata")
      ) {
        errors.push(
          "CLI smoke test generated tsconfig.json missing legacy decorator flags",
        );
      }
    }

    // 2. `bunest generate resource todos --dir <appDir>/src`
    const genDir = join(appDir, "src");
    const genProc = Bun.spawnSync(
      ["bun", cliBin, "generate", "resource", "todos", "--dir", genDir],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (genProc.exitCode !== 0) {
      errors.push(
        `CLI smoke test 'bunest generate resource todos' failed (exit ${genProc.exitCode}): ${genProc.stderr.toString() || genProc.stdout.toString()}`,
      );
      return "FAIL (bunest generate)";
    }

    const generatedFiles = walkTsFiles(join(genDir, "todos"));
    if (generatedFiles.length < 5) {
      errors.push(
        `CLI smoke test expected >=5 generated resource files in src/todos, found ${generatedFiles.length}`,
      );
      return "FAIL (incomplete resource)";
    }

    return `PASS (scaffolded ${expectedNewFiles.length} base files + ${generatedFiles.length} resource files)`;
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
}

async function main() {
  const errors: string[] = [];
  const warnings: string[] = [];

  const packageDirs = readdirSync(PACKAGES_DIR)
    .filter((name) => {
      const p = join(PACKAGES_DIR, name);
      return statSync(p).isDirectory() && existsSync(join(p, "package.json"));
    })
    .sort();

  if (packageDirs.length === 0) {
    console.error("No packages found under packages/");
    process.exit(1);
  }

  const pkgGraph = new Map<string, string[]>();
  const knownPkgNames = new Set<string>();
  const pkgMetaList: Array<{ dir: string; pkg: PackageJson }> = [];

  for (const dir of packageDirs) {
    const pkgPath = join(PACKAGES_DIR, dir, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as PackageJson;
    pkgMetaList.push({ dir, pkg });
    if (pkg.name) {
      knownPkgNames.add(pkg.name);
    }
  }

  let totalSrcFiles = 0;
  let totalRuntimeCycles = 0;
  let totalTypeOnlyCycles = 0;

  for (const { dir, pkg } of pkgMetaList) {
    const pkgDir = join(PACKAGES_DIR, dir);
    const label = pkg.name ?? `packages/${dir}`;

    // 1. Required publish metadata checks
    if (!pkg.name || !pkg.name.startsWith("@bunest/")) {
      errors.push(`${label}: invalid or missing scoped "name"`);
    }
    if (!pkg.version) {
      errors.push(`${label}: missing "version"`);
    }
    if (pkg.license !== "MIT") {
      errors.push(`${label}: expected license "MIT", found ${JSON.stringify(pkg.license)}`);
    }
    if (pkg.type !== "module") {
      errors.push(`${label}: expected type "module", found ${JSON.stringify(pkg.type)}`);
    }
    if (!pkg.engines?.bun || !pkg.engines.bun.includes("1.4.3")) {
      errors.push(`${label}: missing engines.bun (>=1.4.3)`);
    }
    if (
      !pkg.repository ||
      typeof pkg.repository !== "object" ||
      !pkg.repository.url ||
      pkg.repository.directory !== `packages/${dir}`
    ) {
      errors.push(`${label}: missing or mismatched repository metadata`);
    }
    if (
      !Array.isArray(pkg.files) ||
      !pkg.files.includes("dist") ||
      !pkg.files.includes("src")
    ) {
      errors.push(`${label}: "files" must include "dist" and "src"`);
    }

    const rootExport = pkg.exports?.["."];
    if (!rootExport || typeof rootExport !== "object") {
      errors.push(`${label}: missing conditional exports["."]`);
    } else {
      if (!rootExport.types || !rootExport.bun || !rootExport.import) {
        errors.push(
          `${label}: exports["."] must declare "types", "bun", and "import"`,
        );
      }

      // 2. Verify built dist/ artifact exists and is non-empty
      if (rootExport.import) {
        const distFile = resolve(pkgDir, rootExport.import);
        if (!existsSync(distFile) || statSync(distFile).size === 0) {
          errors.push(
            `${label}: missing or empty build artifact ${relative(REPO_ROOT, distFile)}`,
          );
        }
      }
    }

    // Verify bin artifacts (e.g. @bunest/cli)
    if (pkg.bin) {
      const bins =
        typeof pkg.bin === "string"
          ? { [dir]: pkg.bin }
          : pkg.bin;
      for (const [binName, binRel] of Object.entries(bins)) {
        const binAbs = resolve(pkgDir, binRel);
        if (!existsSync(binAbs) || statSync(binAbs).size === 0) {
          errors.push(
            `${label}: missing bin "${binName}" artifact at ${relative(REPO_ROOT, binAbs)}`,
          );
        } else {
          const firstLine = readFileSync(binAbs, "utf8").split(/\r?\n/)[0] ?? "";
          if (!firstLine.startsWith("#!/usr/bin/env bun")) {
            errors.push(
              `${label}: bin "${binName}" missing #!/usr/bin/env bun shebang`,
            );
          }
        }
      }
    }

    // 3. Collect cross-package DAG edges
    if (pkg.name) {
      const deps: string[] = [];
      const allDeps = {
        ...(pkg.dependencies ?? {}),
        ...(pkg.peerDependencies ?? {}),
      };
      for (const depName of Object.keys(allDeps)) {
        if (knownPkgNames.has(depName)) {
          deps.push(depName);
        }
      }
      pkgGraph.set(pkg.name, deps);
    }

    // 4. Intra-package circular import scan (runtime vs type-only)
    const srcFiles = walkTsFiles(join(pkgDir, "src"));
    totalSrcFiles += srcFiles.length;

    const runtimeGraph = new Map<string, string[]>();
    const fullGraph = new Map<string, string[]>();

    for (const file of srcFiles) {
      const source = readFileSync(file, "utf8");
      const parsed = parseRelativeImports(source);
      const runtimeDeps: string[] = [];
      const allRelDeps: string[] = [];

      for (const imp of parsed) {
        const resolved = resolveTsTarget(file, imp.specifier);
        if (!resolved) continue;
        allRelDeps.push(resolved);
        if (!imp.isTypeOnly) {
          runtimeDeps.push(resolved);
        }
      }

      runtimeGraph.set(file, runtimeDeps);
      fullGraph.set(file, allRelDeps);
    }

    const runtimeCycles = findCycles(runtimeGraph);
    const allCycles = findCycles(fullGraph);
    const typeOnlyCycles = allCycles.filter((cyc) => {
      const sig = [...cyc.slice(0, -1)].sort().join("|");
      return !runtimeCycles.some(
        (rc) => [...rc.slice(0, -1)].sort().join("|") === sig,
      );
    });

    totalRuntimeCycles += runtimeCycles.length;
    totalTypeOnlyCycles += typeOnlyCycles.length;

    for (const cycle of runtimeCycles) {
      const formatted = cycle.map((f) => relative(pkgDir, f)).join(" -> ");
      errors.push(`${label}: RUNTIME circular dependency: ${formatted}`);
    }
    for (const cycle of typeOnlyCycles) {
      const formatted = cycle.map((f) => relative(pkgDir, f)).join(" -> ");
      warnings.push(`${label}: type-only circular import: ${formatted}`);
    }
  }

  // 5. Cross-package DAG acyclicity check
  const pkgCycles = findCycles(pkgGraph);
  for (const cycle of pkgCycles) {
    errors.push(`Workspace package DAG cycle detected: ${cycle.join(" -> ")}`);
  }

  // 6. Clean-project CLI smoke test
  const cliSmokeStatus = await runCliSmokeTest(errors);

  // Summary output
  console.log("=== Bunest Release Verification ===");
  console.log(`Packages verified:         ${pkgMetaList.length}`);
  console.log(`Source files scanned:      ${totalSrcFiles}`);
  console.log(`Runtime src cycles:        ${totalRuntimeCycles}`);
  console.log(`Type-only src cycles:      ${totalTypeOnlyCycles}`);
  console.log(`Cross-package DAG cycles:  ${pkgCycles.length}`);
  console.log(`CLI clean-project smoke:   ${cliSmokeStatus}`);

  if (warnings.length > 0) {
    console.log("\nWarnings (non-blocking type-only cycles):");
    for (const w of warnings) {
      console.log(`  - ${w}`);
    }
  }

  if (errors.length > 0) {
    console.error(`\nRelease verification FAILED with ${errors.length} error(s):`);
    for (const err of errors) {
      console.error(`  x ${err}`);
    }
    process.exit(1);
  }

  console.log("\n✓ All release verification gates passed!");
}

await main();
