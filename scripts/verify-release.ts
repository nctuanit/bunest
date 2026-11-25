import {
  dirname,
  ensureDir,
  existsSyncPath,
  join,
  readDirSyncNames,
  relative,
  removePath,
  resolve,
  statSyncPath,
} from "../packages/core/src/common/index";

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
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

interface ParsedImport {
  specifier: string;
  isTypeOnly: boolean;
}

const REPO_ROOT = resolve(import.meta.dirname, "..");
const PACKAGES_DIR = join(REPO_ROOT, "packages");
const APPS_DIR = join(REPO_ROOT, "apps");
const EXAMPLES_DIR = join(REPO_ROOT, "examples");
const SCRIPTS_DIR = join(REPO_ROOT, "scripts");
const TESTS_DIR = join(REPO_ROOT, "tests");
const BENCHMARKS_DIR = join(REPO_ROOT, "benchmarks");

const NODE_BUILTIN_ALLOWLIST = new Set([
  "packages/core/src/common/runtime/async-context.ts",
  "packages/core/src/common/runtime/fs-runtime.ts",
]);

const NESTJS_BENCH_BASELINE_RE =
  /^benchmarks\/nestjs-comparison\/src\/server-nestjs-.*\.ts$/;

const FORBIDDEN_EXTERNAL_PACKAGES = new Set([
  "reflect-metadata",
  "ts-morph",
  "magic-string",
  "graphql",
  "esbuild",
]);

const TS_TRANSPILER = new Bun.Transpiler({ loader: "ts" });
const TSX_TRANSPILER = new Bun.Transpiler({ loader: "tsx" });
const JS_TRANSPILER = new Bun.Transpiler({ loader: "js" });

function walkTsFiles(dir: string): string[] {
  if (!existsSyncPath(dir)) return [];
  const results: string[] = [];
  for (const entry of readDirSyncNames(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    const stat = statSyncPath(full);
    if (stat.isDirectory()) {
      results.push(...walkTsFiles(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      results.push(full);
    }
  }
  return results;
}

function walkSourceFiles(dir: string): string[] {
  if (!existsSyncPath(dir)) return [];
  const results: string[] = [];
  for (const entry of readDirSyncNames(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    const stat = statSyncPath(full);
    if (stat.isDirectory()) {
      results.push(...walkSourceFiles(full));
    } else if (
      (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) ||
      entry.endsWith(".tsx") ||
      entry.endsWith(".js") ||
      entry.endsWith(".mjs") ||
      entry.endsWith(".cjs")
    ) {
      results.push(full);
    }
  }
  return results;
}

function parseImportSpecifiers(source: string, filePath: string): string[] {
  const withoutShebang = source.startsWith("#!")
    ? source.replace(/^#!.*\r?\n/, "\n")
    : source;
  const transpiler = filePath.endsWith(".tsx")
    ? TSX_TRANSPILER
    : filePath.endsWith(".ts")
      ? TS_TRANSPILER
      : JS_TRANSPILER;

  const specifiers = new Set<string>();
  for (const imp of transpiler.scanImports(withoutShebang)) {
    specifiers.add(imp.path);
  }

  // Bun.Transpiler erases type-only imports; catch top-level `import/export type ... from "..."` too.
  const clean = stripComments(withoutShebang);
  const typeImportRegex =
    /^(?:import|export)\s+type\s+(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+["']([^"']+)["']/gm;
  for (const match of clean.matchAll(typeImportRegex)) {
    specifiers.add(match[1]!);
  }

  return [...specifiers];
}

function isForbiddenExternalPackage(specifier: string): boolean {
  if (FORBIDDEN_EXTERNAL_PACKAGES.has(specifier)) {
    return true;
  }
  for (const pkg of FORBIDDEN_EXTERNAL_PACKAGES) {
    if (specifier.startsWith(`${pkg}/`)) {
      return true;
    }
  }
  return false;
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
    if (existsSyncPath(candidate) && statSyncPath(candidate).isFile()) {
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
  if (!existsSyncPath(cliBin)) {
    errors.push(`CLI smoke test skipped: missing built binary ${cliBin}`);
    return "FAIL (missing dist/cli.js)";
  }

  const baseTmp = Bun.env.TMPDIR ?? Bun.env.TEMP ?? "/tmp";
  const tmpRoot = join(baseTmp, `bunest-release-smoke-${crypto.randomUUID()}`);
  await ensureDir(tmpRoot);
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
      "AGENTS.md",
    ];
    for (const rel of expectedNewFiles) {
      if (!existsSyncPath(join(appDir, rel))) {
        errors.push(`CLI smoke test missing scaffolded file: smoke-app/${rel}`);
      }
    }

    // Verify generated package.json uses @bunest/validation (no class-validator/class-transformer) & Bun >=1.4.5
    const scaffoldPkgPath = join(appDir, "package.json");
    if (existsSyncPath(scaffoldPkgPath)) {
      const scaffoldPkg = (await Bun.file(scaffoldPkgPath).json()) as PackageJson;
      if (!scaffoldPkg.dependencies?.["@bunest/validation"]) {
        errors.push(
          'CLI smoke test generated package.json missing "@bunest/validation" dependency',
        );
      }
      if (
        scaffoldPkg.dependencies?.["class-validator"] ||
        scaffoldPkg.devDependencies?.["class-validator"] ||
        scaffoldPkg.dependencies?.["class-transformer"] ||
        scaffoldPkg.devDependencies?.["class-transformer"]
      ) {
        errors.push(
          'CLI smoke test generated package.json must not include legacy "class-validator" or "class-transformer"',
        );
      }
      if (scaffoldPkg.engines?.bun !== ">=1.4.5") {
        errors.push(
          `CLI smoke test generated package.json expected engines.bun ">=1.4.5", found ${JSON.stringify(scaffoldPkg.engines?.bun)}`,
        );
      }
    }

    // Verify generated tsconfig enables legacy decorators + verbatimModuleSyntax
    const tsconfigPath = join(appDir, "tsconfig.json");
    if (existsSyncPath(tsconfigPath)) {
      const tsconfigText = await Bun.file(tsconfigPath).text();
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

    const createDtoPath = join(genDir, "todos", "dto", "create-todos.dto.ts");
    if (!existsSyncPath(createDtoPath)) {
      errors.push(
        "CLI smoke test missing generated DTO: src/todos/dto/create-todos.dto.ts",
      );
    } else {
      const createDtoText = await Bun.file(createDtoPath).text();
      if (!createDtoText.includes('from "@bunest/validation/validator"')) {
        errors.push(
          'CLI smoke test src/todos/dto/create-todos.dto.ts must import from "@bunest/validation/validator"',
        );
      }
      if (createDtoText.includes('from "class-validator"')) {
        errors.push(
          'CLI smoke test src/todos/dto/create-todos.dto.ts must not import from "class-validator"',
        );
      }
    }

    return `PASS (scaffolded ${expectedNewFiles.length} base files + ${generatedFiles.length} resource files)`;
  } finally {
    await removePath(tmpRoot, { recursive: true, force: true });
  }
}

async function main() {
  const errors: string[] = [];
  const warnings: string[] = [];

  const packageDirs = readDirSyncNames(PACKAGES_DIR)
    .filter((name) => {
      const p = join(PACKAGES_DIR, name);
      return statSyncPath(p).isDirectory() && existsSyncPath(join(p, "package.json"));
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
    const pkg = (await Bun.file(pkgPath).json()) as PackageJson;
    pkgMetaList.push({ dir, pkg });
    if (pkg.name) {
      knownPkgNames.add(pkg.name);
    }
  }

  let totalSrcFiles = 0;
  let totalQuarantineFiles = 0;
  let totalSetImmediateCalls = 0;
  let totalRuntimeCycles = 0;
  let totalTypeOnlyCycles = 0;
  let zeroExternalDepPackages = 0;
  const quarantinedAdaptersSeen = new Set<string>();

  for (const { dir, pkg } of pkgMetaList) {
    const pkgDir = join(PACKAGES_DIR, dir);
    const label = pkg.name ?? `packages/${dir}`;

    // 0. Zero External Runtime Dependencies Gate + Forbidden DevDeps Gate (ADR-017)
    const externalRuntimeDeps = Object.keys(pkg.dependencies ?? {}).filter(
      (dep) => !dep.startsWith("@bunest/"),
    );
    if (externalRuntimeDeps.length === 0) {
      zeroExternalDepPackages++;
    } else {
      errors.push(
        `${label}: forbidden external runtime dependency in package.json: ${externalRuntimeDeps.join(", ")} (ADR-017 requires 0 external runtime deps)`,
      );
    }
    for (const devDep of Object.keys(pkg.devDependencies ?? {})) {
      if (isForbiddenExternalPackage(devDep)) {
        errors.push(
          `${label}: forbidden external devDependency "${devDep}" in package.json (ADR-017)`,
        );
      }
    }

    // 1. Required publish metadata checks
    if (!pkg.name || !pkg.name.startsWith("@bunest/")) {
      errors.push(`${label}: invalid or missing scoped "name"`);
    }
    if (!pkg.version) {
      errors.push(`${label}: missing "version"`);
    }
    if (pkg.license !== "MIT") {
      errors.push(
        `${label}: expected license "MIT", found ${JSON.stringify(pkg.license)}`,
      );
    }
    if (pkg.type !== "module") {
      errors.push(
        `${label}: expected type "module", found ${JSON.stringify(pkg.type)}`,
      );
    }
    if (!pkg.engines?.bun || !pkg.engines.bun.includes("1.4.5")) {
      errors.push(`${label}: missing engines.bun (>=1.4.5)`);
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
    }

    // 2. Verify ALL conditional subpath exports declare types/bun/import and non-empty dist/ artifacts
    if (pkg.exports && typeof pkg.exports === "object") {
      for (const [subpath, entry] of Object.entries(pkg.exports)) {
        if (subpath === "./package.json" || typeof entry === "string") continue;
        if (!entry || typeof entry !== "object") {
          errors.push(`${label}: invalid export entry for "${subpath}"`);
          continue;
        }
        if (!entry.types || !entry.bun || !entry.import) {
          errors.push(
            `${label}: exports["${subpath}"] must declare "types", "bun", and "import"`,
          );
        }
        if (entry.import) {
          const distFile = resolve(pkgDir, entry.import);
          if (!existsSyncPath(distFile) || statSyncPath(distFile).size === 0) {
            errors.push(
              `${label}: missing or empty build artifact ${relative(REPO_ROOT, distFile)} for "${subpath}"`,
            );
          }
        }
      }
    }

    // Verify bin artifacts (e.g. @bunest/cli)
    if (pkg.bin) {
      const bins = typeof pkg.bin === "string" ? { [dir]: pkg.bin } : pkg.bin;
      for (const [binName, binRel] of Object.entries(bins)) {
        const binAbs = resolve(pkgDir, binRel);
        if (!existsSyncPath(binAbs) || statSyncPath(binAbs).size === 0) {
          errors.push(
            `${label}: missing bin "${binName}" artifact at ${relative(REPO_ROOT, binAbs)}`,
          );
        } else {
          const firstLine =
            (await Bun.file(binAbs).text()).split(/\r?\n/)[0] ?? "";
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

    // 4. Intra-package circular import scan (runtime vs type-only) + Node/external/setImmediate quarantine (ADR-017)
    const srcFiles = walkTsFiles(join(pkgDir, "src"));
    totalSrcFiles += srcFiles.length;

    const allPkgSourceFiles = walkSourceFiles(join(pkgDir, "src"));
    totalQuarantineFiles += allPkgSourceFiles.length;
    for (const file of allPkgSourceFiles) {
      const relPath = relative(REPO_ROOT, file).replace(/\\/g, "/");
      const source = await Bun.file(file).text();
      const specifiers = parseImportSpecifiers(source, file);
      for (const spec of specifiers) {
        if (spec.startsWith("node:")) {
          if (NODE_BUILTIN_ALLOWLIST.has(relPath)) {
            quarantinedAdaptersSeen.add(relPath);
          } else {
            errors.push(
              `${relPath}: forbidden Node built-in import "${spec}" (only ${[...NODE_BUILTIN_ALLOWLIST].join(", ")} may import node:* per ADR-017)`,
            );
          }
        } else if (isForbiddenExternalPackage(spec)) {
          errors.push(
            `${relPath}: forbidden external package import "${spec}" (ADR-017)`,
          );
        }
      }

      const cleanSource = stripComments(source);
      const setImmediateMatches = cleanSource.match(/\bsetImmediate\s*\(/g);
      if (setImmediateMatches && setImmediateMatches.length > 0) {
        totalSetImmediateCalls += setImmediateMatches.length;
        errors.push(
          `${relPath}: forbidden Node setImmediate() call (${setImmediateMatches.length} occurrence(s) — use queueMicrotask or setTimeout(..., 0))`,
        );
      }
    }

    // 4b. Scan packages/*/test/** for forbidden node:* and external package imports (ADR-017)
    const pkgTestDir = join(pkgDir, "test");
    if (existsSyncPath(pkgTestDir) && statSyncPath(pkgTestDir).isDirectory()) {
      const pkgTestFiles = walkSourceFiles(pkgTestDir);
      totalQuarantineFiles += pkgTestFiles.length;
      for (const file of pkgTestFiles) {
        const relPath = relative(REPO_ROOT, file).replace(/\\/g, "/");
        const source = await Bun.file(file).text();
        for (const spec of parseImportSpecifiers(source, file)) {
          if (spec.startsWith("node:")) {
            errors.push(
              `${relPath}: forbidden Node built-in import "${spec}" (packages/*/test must have 0 node:* imports per ADR-017)`,
            );
          } else if (isForbiddenExternalPackage(spec)) {
            errors.push(
              `${relPath}: forbidden external package import "${spec}" (ADR-017)`,
            );
          }
        }
      }
    }

    const runtimeGraph = new Map<string, string[]>();
    const fullGraph = new Map<string, string[]>();

    for (const file of srcFiles) {
      const source = await Bun.file(file).text();
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

  // 5b. Scan apps/**, examples/**, scripts/**, tests/**, and Bun benchmark harnesses for forbidden Node/external imports (ADR-017)
  const quarantineScopes: Array<{
    files: string[];
    label: string;
    checkForbiddenExternal: boolean;
  }> = [];

  if (existsSyncPath(APPS_DIR)) {
    for (const appName of readDirSyncNames(APPS_DIR).sort()) {
      const appDir = join(APPS_DIR, appName);
      if (!statSyncPath(appDir).isDirectory()) continue;

      const appPkgPath = join(appDir, "package.json");
      if (existsSyncPath(appPkgPath)) {
        const appPkg = (await Bun.file(appPkgPath).json()) as PackageJson;
        const allAppDeps = [
          ...Object.keys(appPkg.dependencies ?? {}),
          ...Object.keys(appPkg.devDependencies ?? {}),
        ];
        for (const dep of allAppDeps) {
          if (isForbiddenExternalPackage(dep)) {
            errors.push(
              `apps/${appName}/package.json: forbidden external package "${dep}" (ADR-017)`,
            );
          }
        }
      }

      const appFiles = walkSourceFiles(appDir);
      if (appFiles.length > 0) {
        quarantineScopes.push({
          files: appFiles,
          label: `apps/${appName}`,
          checkForbiddenExternal: true,
        });
      }
    }
  }

  if (existsSyncPath(EXAMPLES_DIR)) {
    for (const exName of readDirSyncNames(EXAMPLES_DIR).sort()) {
      const exDir = join(EXAMPLES_DIR, exName);
      if (!statSyncPath(exDir).isDirectory()) continue;
      const exFiles = walkSourceFiles(exDir);
      if (exFiles.length > 0) {
        quarantineScopes.push({
          files: exFiles,
          label: `examples/${exName}`,
          checkForbiddenExternal: true,
        });
      }
    }
  }

  if (existsSyncPath(SCRIPTS_DIR)) {
    quarantineScopes.push({
      files: walkSourceFiles(SCRIPTS_DIR),
      label: "scripts",
      checkForbiddenExternal: true,
    });
  }

  if (existsSyncPath(TESTS_DIR)) {
    quarantineScopes.push({
      files: walkSourceFiles(TESTS_DIR),
      label: "tests",
      checkForbiddenExternal: true,
    });
  }

  if (existsSyncPath(BENCHMARKS_DIR)) {
    const benchFiles = walkSourceFiles(BENCHMARKS_DIR).filter((file) => {
      const relPath = relative(REPO_ROOT, file).replace(/\\/g, "/");
      return !NESTJS_BENCH_BASELINE_RE.test(relPath);
    });
    quarantineScopes.push({
      files: benchFiles,
      label: "benchmarks",
      checkForbiddenExternal: false,
    });
  }

  for (const { files, label: scopeLabel, checkForbiddenExternal } of quarantineScopes) {
    totalQuarantineFiles += files.length;
    for (const file of files) {
      const relPath = relative(REPO_ROOT, file).replace(/\\/g, "/");
      const source = await Bun.file(file).text();
      for (const spec of parseImportSpecifiers(source, file)) {
        if (spec.startsWith("node:")) {
          errors.push(
            `${relPath}: forbidden Node built-in import "${spec}" (${scopeLabel} must have 0 node:* imports per ADR-017)`,
          );
        } else if (checkForbiddenExternal && isForbiddenExternalPackage(spec)) {
          errors.push(
            `${relPath}: forbidden external package import "${spec}" (ADR-017)`,
          );
        }
      }
    }
  }

  // 5c. Verify VS Code extension Bun-built CJS bundle artifact exists and is non-empty
  const vscodeBundlePath = join(
    APPS_DIR,
    "vscode-bunest",
    "dist",
    "extension.js",
  );
  let vscodeBundleStatus = "FAIL (missing)";
  if (
    !existsSyncPath(vscodeBundlePath) ||
    statSyncPath(vscodeBundlePath).size === 0
  ) {
    errors.push(
      `apps/vscode-bunest: missing or empty bundle artifact ${relative(REPO_ROOT, vscodeBundlePath)}`,
    );
  } else {
    const sizeKb = (statSyncPath(vscodeBundlePath).size / 1024).toFixed(1);
    vscodeBundleStatus = `PASS (${sizeKb} KB)`;
  }

  // 6. Clean-project CLI smoke test
  const cliSmokeStatus = await runCliSmokeTest(errors);

  // Summary output
  console.log("=== Bunest Release Verification ===");
  console.log(`Packages verified:         ${pkgMetaList.length}`);
  console.log(
    `Zero-external-dep packages: ${zeroExternalDepPackages}/${pkgMetaList.length}`,
  );
  console.log(
    `Quarantined node:* adapters: ${quarantinedAdaptersSeen.size}/${NODE_BUILTIN_ALLOWLIST.size}`,
  );
  console.log(`Quarantine files scanned:  ${totalQuarantineFiles}`);
  console.log(`Package src files scanned: ${totalSrcFiles}`);
  console.log(`setImmediate() in pkg src: ${totalSetImmediateCalls}`);
  console.log(`Runtime src cycles:        ${totalRuntimeCycles}`);
  console.log(`Type-only src cycles:      ${totalTypeOnlyCycles}`);
  console.log(`Cross-package DAG cycles:  ${pkgCycles.length}`);
  console.log(`VS Code extension bundle:  ${vscodeBundleStatus}`);
  console.log(`CLI clean-project smoke:   ${cliSmokeStatus}`);

  if (warnings.length > 0) {
    console.log("\nWarnings (non-blocking type-only cycles):");
    for (const w of warnings) {
      console.log(`  - ${w}`);
    }
  }

  if (errors.length > 0) {
    console.error(
      `\nRelease verification FAILED with ${errors.length} error(s):`,
    );
    for (const err of errors) {
      console.error(`  x ${err}`);
    }
    process.exit(1);
  }

  console.log("\n✓ All release verification gates passed!");
}

await main();
