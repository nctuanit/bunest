import {
  basename,
  dirname,
  existsSyncPath,
  extname,
  join,
  readDirSyncNames,
  readTextSync,
  relative,
  resolve,
  statSyncPath,
} from "@bunest/core";
import {
  lexTypeScript,
  Node,
  Project,
  SyntaxKind,
  type Decorator,
  type Expression,
  type SourceFile,
} from "../ast";
import { buildStaticModuleGraph } from "./module-graph";

export interface AffectedTestSelection {
  readonly file: string;
  readonly reasons: readonly string[];
}

export interface AffectedTestsPlan {
  readonly cwd: string;
  readonly changedFiles: readonly string[];
  readonly selectedTests: readonly AffectedTestSelection[];
  readonly allTestFiles: readonly string[];
  readonly skippedTestCount: number;
  readonly fallbackToFullSuite: boolean;
  readonly fallbackReason?: string;
}

export interface AffectedTestsOptions {
  readonly cwd: string;
  /** Explicit changed file list; when omitted, detected via git diff + untracked files. */
  readonly changedFiles?: readonly string[];
  /** Git base ref for diff detection (e.g. `origin/main`, `HEAD~1`). */
  readonly baseRef?: string;
  /** Explicit test file list; when omitted, auto-discovers `*.spec.ts` and `*.test.ts` files under `cwd`. */
  readonly testFiles?: readonly string[];
  /** Optional source root (unused for exclusion; kept for CLI consistency). */
  readonly sourceRoot?: string;
  /** Optional tsconfig path for path-alias resolution (defaults to `<cwd>/tsconfig.json`). */
  readonly tsconfigPath?: string;
}

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  ".bunest",
  "coverage",
  "build",
  "out",
  ".next",
  ".turbo",
]);

const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);
const ALL_SCRIPT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);
const TEST_FILE_RE = /\.(?:spec|test)\.(?:ts|tsx|mts|cts)$/i;

const GLOBAL_CONFIG_EXACT_NAMES = new Set([
  "package.json",
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "tsconfig.json",
  "bunfig.toml",
  "bunest.json",
  "nest-cli.json",
  "bunest.config.ts",
  "bunest.config.js",
  "bunest.config.mjs",
  "bunest.config.cjs",
  "preload.ts",
  "bunest.preload.ts",
]);

const PIPELINE_DECORATOR_KIND: Readonly<
  Record<string, "guard" | "pipe" | "interceptor" | "filter">
> = {
  UseGuards: "guard",
  UsePipes: "pipe",
  UseInterceptors: "interceptor",
  UseFilters: "filter",
};

const GLOBAL_PIPELINE_TOKEN_KIND: Readonly<
  Record<string, "guard" | "pipe" | "interceptor" | "filter">
> = {
  APP_GUARD: "guard",
  APP_PIPE: "pipe",
  APP_INTERCEPTOR: "interceptor",
  APP_FILTER: "filter",
};

const GLOBAL_USE_METHOD_KIND: Readonly<
  Record<string, "guard" | "pipe" | "interceptor" | "filter">
> = {
  useGlobalGuards: "guard",
  useGlobalPipes: "pipe",
  useGlobalInterceptors: "interceptor",
  useGlobalFilters: "filter",
};

function toPosix(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

function toRelPosix(cwd: string, filePath: string): string {
  const abs = resolve(cwd, filePath);
  const rel = toPosix(relative(cwd, abs));
  return rel.startsWith("..") ? toPosix(filePath) : rel;
}

function toCanonicalKey(absPath: string): string {
  const normalized = toPosix(resolve(absPath));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function stripCodeExtension(filePath: string): string {
  const normalized = toPosix(filePath);
  const ext = extname(normalized).toLowerCase();
  if (ALL_SCRIPT_EXTENSIONS.has(ext)) {
    return normalized.slice(0, -ext.length);
  }
  return normalized;
}

function toStemKeys(absPath: string): string[] {
  const canonical = toCanonicalKey(absPath);
  const stem = stripCodeExtension(canonical);
  const keys = [stem];
  if (stem.endsWith("/index")) {
    keys.push(stem.slice(0, -"/index".length));
  }
  return keys;
}

/**
 * Returns true if the given path refers to a global configuration, lockfile,
 * preload script, or environment file whose change invalidates targeted test selection.
 */
export function isGlobalConfigFile(filePath: string): boolean {
  const normalized = toPosix(filePath).trim();
  if (!normalized) return false;
  const base = basename(normalized).toLowerCase();
  if (GLOBAL_CONFIG_EXACT_NAMES.has(base)) return true;
  if (/^tsconfig\..+\.json$/i.test(base)) return true;
  if (/\.preload\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/i.test(base)) return true;
  if (base === ".env" || base.startsWith(".env.")) return true;
  return false;
}

function isTestFilePath(filePath: string): boolean {
  return TEST_FILE_RE.test(toPosix(filePath));
}

function collectProjectFiles(cwd: string): {
  sourceFiles: string[];
  testFiles: string[];
} {
  const sourceFiles: string[] = [];
  const testFiles: string[] = [];

  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readDirSyncNames(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry)) continue;
      const fullPath = join(dir, entry);
      let stat;
      try {
        stat = statSyncPath(fullPath);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!stat.isFile()) continue;
      const lower = entry.toLowerCase();
      if (lower.endsWith(".d.ts") || lower.endsWith(".d.mts") || lower.endsWith(".d.cts")) {
        continue;
      }
      const ext = extname(lower);
      if (!CODE_EXTENSIONS.has(ext)) continue;
      const abs = resolve(fullPath);
      sourceFiles.push(abs);
      if (isTestFilePath(abs)) {
        testFiles.push(abs);
      }
    }
  };

  walk(cwd);
  sourceFiles.sort((a, b) => toPosix(a).localeCompare(toPosix(b)));
  testFiles.sort((a, b) => toPosix(a).localeCompare(toPosix(b)));
  return { sourceFiles, testFiles };
}

async function runGitCommand(
  args: readonly string[],
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    const proc = Bun.spawn(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr };
  } catch (err) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
    };
  }
}

async function detectChangedFilesFromGit(
  cwd: string,
  baseRef?: string,
): Promise<{ files: string[]; error?: string }> {
  const topRes = await runGitCommand(["rev-parse", "--show-toplevel"], cwd);
  if (topRes.exitCode !== 0 || !topRes.stdout.trim()) {
    return {
      files: [],
      error:
        "Could not detect changed files from git (not a git repository or git unavailable).",
    };
  }
  const gitRoot = resolve(topRes.stdout.trim());
  const rawPaths = new Set<string>();

  const collectLines = (output: string): void => {
    for (const line of output.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed) rawPaths.add(trimmed);
    }
  };

  if (baseRef) {
    const diffRes = await runGitCommand(
      ["diff", "--name-only", baseRef],
      cwd,
    );
    if (diffRes.exitCode !== 0) {
      return {
        files: [],
        error: `Could not resolve git diff against base ref "${baseRef}": ${diffRes.stderr.trim() || "unknown git error"}.`,
      };
    }
    collectLines(diffRes.stdout);
  } else {
    const headDiff = await runGitCommand(["diff", "--name-only", "HEAD"], cwd);
    if (headDiff.exitCode === 0) {
      collectLines(headDiff.stdout);
    } else {
      // Repository may have no commits yet: fall back to unstaged + staged diffs
      const [unstaged, staged] = await Promise.all([
        runGitCommand(["diff", "--name-only"], cwd),
        runGitCommand(["diff", "--name-only", "--cached"], cwd),
      ]);
      if (unstaged.exitCode !== 0 && staged.exitCode !== 0) {
        return {
          files: [],
          error: `Could not compute git diff: ${headDiff.stderr.trim() || "unknown git error"}.`,
        };
      }
      collectLines(unstaged.stdout);
      collectLines(staged.stdout);
    }
  }

  const untracked = await runGitCommand(
    ["ls-files", "--others", "--exclude-standard"],
    cwd,
  );
  if (untracked.exitCode === 0) {
    collectLines(untracked.stdout);
  }

  const relFiles = new Set<string>();
  for (const p of rawPaths) {
    const abs = resolve(gitRoot, p);
    const rel = toPosix(relative(cwd, abs));
    if (!rel.startsWith("..") || isGlobalConfigFile(p)) {
      relFiles.add(rel.startsWith("..") ? toPosix(p) : rel);
    }
  }

  return { files: [...relFiles].sort() };
}

interface DynamicImportInspection {
  readonly staticSpecifiers: readonly string[];
  readonly unresolvedDynamicImports: readonly {
    readonly kind: "import" | "require";
    readonly snippet: string;
  }[];
}

function stripQuotes(raw: string): string {
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'")) ||
    (raw.startsWith("`") && raw.endsWith("`"))
  ) {
    return raw.slice(1, -1);
  }
  return raw;
}

function inspectDynamicImports(text: string): DynamicImportInspection {
  const { tokens } = lexTypeScript(text);
  const staticSpecifiers: string[] = [];
  const unresolvedDynamicImports: Array<{
    kind: "import" | "require";
    snippet: string;
  }> = [];

  for (let i = 0; i < tokens.length - 1; i++) {
    const tok = tokens[i]!;
    const prev = i > 0 ? tokens[i - 1] : undefined;
    const next = tokens[i + 1]!;

    const isDynamicImport =
      tok.kind === SyntaxKind.ImportKeyword &&
      next.kind === SyntaxKind.OpenParenToken &&
      prev?.kind !== SyntaxKind.DotToken;

    const isRequireCall =
      tok.kind === SyntaxKind.Identifier &&
      tok.text === "require" &&
      next.kind === SyntaxKind.OpenParenToken &&
      prev?.kind !== SyntaxKind.DotToken &&
      prev?.kind !== SyntaxKind.FunctionKeyword;

    if (!isDynamicImport && !isRequireCall) continue;

    let depth = 0;
    let closeIdx = -1;
    for (let j = i + 1; j < tokens.length; j++) {
      const k = tokens[j]!.kind;
      if (k === SyntaxKind.OpenParenToken) depth++;
      else if (k === SyntaxKind.CloseParenToken) {
        depth--;
        if (depth === 0) {
          closeIdx = j;
          break;
        }
      }
    }
    if (closeIdx === -1) continue;

    const inner = tokens.slice(i + 2, closeIdx);
    if (
      inner.length === 1 &&
      (inner[0]!.kind === SyntaxKind.StringLiteral ||
        inner[0]!.kind === SyntaxKind.NoSubstitutionTemplateLiteral)
    ) {
      staticSpecifiers.push(stripQuotes(inner[0]!.text));
    } else if (inner.length > 0) {
      unresolvedDynamicImports.push({
        kind: isDynamicImport ? "import" : "require",
        snippet: text.slice(tok.start, tokens[closeIdx]!.end).trim(),
      });
    }
  }

  return { staticSpecifiers, unresolvedDynamicImports };
}

function getDecoratorShortName(dec: Decorator): string {
  const n = dec.getName();
  const idx = n.lastIndexOf(".");
  return idx !== -1 ? n.slice(idx + 1) : n;
}

function collectIdentifiersFromExpr(expr: Expression | undefined, out: Set<string>): void {
  if (!expr) return;
  if (Node.isIdentifier(expr)) {
    out.add(expr.getText());
    return;
  }
  if (Node.isNewExpression(expr)) {
    const target = expr.getExpression();
    if (Node.isIdentifier(target)) out.add(target.getText());
    return;
  }
  if (Node.isArrayLiteralExpression(expr)) {
    for (const el of expr.getElements()) {
      collectIdentifiersFromExpr(el, out);
    }
    return;
  }
  if (Node.isCallExpression(expr)) {
    for (const arg of expr.getArguments()) {
      collectIdentifiersFromExpr(arg as Expression, out);
    }
  }
}

interface PipelineConsumerEdge {
  readonly kind: "guard" | "pipe" | "interceptor" | "filter";
  readonly consumerClass: string;
  readonly consumerFileKey: string;
}

function buildFallbackPlan(
  cwd: string,
  changedFiles: readonly string[],
  allTestRelFiles: readonly string[],
  fallbackReason: string,
): AffectedTestsPlan {
  return {
    cwd,
    changedFiles,
    selectedTests: allTestRelFiles.map((file) => ({
      file,
      reasons: [fallbackReason],
    })),
    allTestFiles: allTestRelFiles,
    skippedTestCount: 0,
    fallbackToFullSuite: true,
    fallbackReason,
  };
}

function addReason(
  map: Map<string, Set<string>>,
  key: string,
  reason: string,
): boolean {
  let set = map.get(key);
  if (!set) {
    set = new Set<string>();
    map.set(key, set);
  }
  if (set.has(reason)) return false;
  set.add(reason);
  return true;
}

/**
 * Selects the minimal set of test files affected by changed files with explicit
 * human-readable reasons, combining reverse import graph tracing with Bunest's
 * static module/provider/guard/pipe/interceptor consumer graph.
 *
 * Falls back to the full test suite with an explicit `fallbackReason` when:
 * - global configuration files change (`package.json`, `tsconfig*.json`, `bunfig.toml`,
 *   `bunest.json`, `preload.ts`, `bunest.preload.ts`, `.env*`, lockfiles)
 * - changed files cannot be determined (e.g. not a git repo and no `--files`)
 * - a changed source file contains unresolved dynamic `import(expr)` / `require(expr)`
 * - a deleted/renamed non-test source file cannot be matched to any reverse importer
 */
export async function selectAffectedTests(
  options: AffectedTestsOptions,
): Promise<AffectedTestsPlan> {
  const cwd = resolve(options.cwd);
  const discovered = collectProjectFiles(cwd);

  const allTestAbsFiles = options.testFiles
    ? options.testFiles.map((f) => resolve(cwd, f))
    : discovered.testFiles;
  const allTestRelByKey = new Map<string, string>();
  const allTestRelFiles: string[] = [];
  for (const abs of allTestAbsFiles) {
    const key = toCanonicalKey(abs);
    if (allTestRelByKey.has(key)) continue;
    const rel = toRelPosix(cwd, abs);
    allTestRelByKey.set(key, rel);
    allTestRelFiles.push(rel);
  }
  allTestRelFiles.sort();

  // 1. Resolve changed files
  let changedRelFiles: string[];
  if (options.changedFiles !== undefined) {
    changedRelFiles = [
      ...new Set(
        options.changedFiles
          .map((f) => f.trim())
          .filter((f) => f.length > 0)
          .map((f) => toRelPosix(cwd, f)),
      ),
    ].sort();
  } else {
    const gitRes = await detectChangedFilesFromGit(cwd, options.baseRef);
    if (gitRes.error) {
      return buildFallbackPlan(
        cwd,
        [],
        allTestRelFiles,
        `${gitRes.error} Running full test suite.`,
      );
    }
    changedRelFiles = gitRes.files;
  }

  if (changedRelFiles.length === 0) {
    return {
      cwd,
      changedFiles: [],
      selectedTests: [],
      allTestFiles: allTestRelFiles,
      skippedTestCount: allTestRelFiles.length,
      fallbackToFullSuite: false,
    };
  }

  // 2. Global configuration file fallback
  const globalConfigChanges = changedRelFiles.filter(isGlobalConfigFile);
  if (globalConfigChanges.length > 0) {
    return buildFallbackPlan(
      cwd,
      changedRelFiles,
      allTestRelFiles,
      `Global configuration changed (${globalConfigChanges.join(", ")}); running full test suite.`,
    );
  }

  // 3. Inspect changed source files for unresolved dynamic import()/require()
  for (const rel of changedRelFiles) {
    const abs = resolve(cwd, rel);
    const ext = extname(abs).toLowerCase();
    if (!ALL_SCRIPT_EXTENSIONS.has(ext) || !existsSyncPath(abs)) continue;
    let text: string;
    try {
      text = readTextSync(abs);
    } catch {
      continue;
    }
    const inspected = inspectDynamicImports(text);
    if (inspected.unresolvedDynamicImports.length > 0) {
      const first = inspected.unresolvedDynamicImports[0]!;
      return buildFallbackPlan(
        cwd,
        changedRelFiles,
        allTestRelFiles,
        `Changed file "${rel}" contains unresolved dynamic ${first.kind} (${first.snippet}); running full test suite.`,
      );
    }
  }

  // 4. Parse all project TypeScript files (including any explicit test files)
  const tsconfigPath =
    options.tsconfigPath ??
    (existsSyncPath(join(cwd, "tsconfig.json"))
      ? join(cwd, "tsconfig.json")
      : undefined);
  const project = new Project({
    tsConfigFilePath: tsconfigPath,
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
  });

  const allSourceAbs = new Set<string>(discovered.sourceFiles);
  for (const abs of allTestAbsFiles) {
    if (existsSyncPath(abs)) allSourceAbs.add(abs);
  }
  for (const rel of changedRelFiles) {
    const abs = resolve(cwd, rel);
    if (CODE_EXTENSIONS.has(extname(abs).toLowerCase()) && existsSyncPath(abs)) {
      allSourceAbs.add(abs);
    }
  }

  const sourceFiles: SourceFile[] = [];
  const fileRelByKey = new Map<string, string>();
  const sourceFileByKey = new Map<string, SourceFile>();
  for (const abs of allSourceAbs) {
    const sf = project.addSourceFileAtPathIfExists(abs);
    if (!sf) continue;
    const key = toCanonicalKey(sf.getFilePath());
    sourceFiles.push(sf);
    fileRelByKey.set(key, toRelPosix(cwd, sf.getFilePath()));
    sourceFileByKey.set(key, sf);
  }

  // 5. Build reverse import graph + unresolved relative specifier stem index (for deleted/renamed files)
  const reverseImporters = new Map<string, Set<string>>();
  const stemToImporters = new Map<string, Set<string>>();

  const recordImport = (fromKey: string, fromAbs: string, specifier: string): void => {
    if (!specifier) return;
    const resolved = project.resolveModulePath(fromAbs, specifier);
    if (resolved) {
      const targetKey = toCanonicalKey(resolved);
      let set = reverseImporters.get(targetKey);
      if (!set) {
        set = new Set<string>();
        reverseImporters.set(targetKey, set);
      }
      set.add(fromKey);
      for (const stemKey of toStemKeys(resolved)) {
        let stemSet = stemToImporters.get(stemKey);
        if (!stemSet) {
          stemSet = new Set<string>();
          stemToImporters.set(stemKey, stemSet);
        }
        stemSet.add(fromKey);
      }
      return;
    }

    // Unresolved specifier (e.g. target file was deleted or renamed)
    if (specifier.startsWith(".") || specifier.startsWith("/")) {
      const candidateAbs = specifier.startsWith("/")
        ? specifier
        : resolve(dirname(fromAbs), specifier);
      for (const stemKey of toStemKeys(candidateAbs)) {
        let stemSet = stemToImporters.get(stemKey);
        if (!stemSet) {
          stemSet = new Set<string>();
          stemToImporters.set(stemKey, stemSet);
        }
        stemSet.add(fromKey);
      }
    }
  };

  for (const sf of sourceFiles) {
    const fromAbs = sf.getFilePath();
    const fromKey = toCanonicalKey(fromAbs);
    for (const imp of sf.getImportDeclarations()) {
      recordImport(fromKey, fromAbs, imp.getModuleSpecifierValue());
    }
    for (const exp of sf.getExportDeclarations()) {
      const modSpec = exp.getModuleSpecifierValue();
      if (modSpec) recordImport(fromKey, fromAbs, modSpec);
    }
    const { staticSpecifiers } = inspectDynamicImports(sf.getFullText());
    for (const spec of staticSpecifiers) {
      recordImport(fromKey, fromAbs, spec);
    }
  }

  // 6. Build Bunest static module + provider + guard/pipe/interceptor/filter consumer graph
  const moduleGraph = buildStaticModuleGraph(sourceFiles);
  const classNamesByFileKey = new Map<string, Set<string>>();
  const pipelineConsumersBySymbol = new Map<string, PipelineConsumerEdge[]>();
  const globalPipelineSymbols = new Map<
    string,
    "guard" | "pipe" | "interceptor" | "filter"
  >();

  for (const sf of sourceFiles) {
    const fileKey = toCanonicalKey(sf.getFilePath());
    const classNames = new Set<string>();
    classNamesByFileKey.set(fileKey, classNames);

    for (const cls of sf.getClasses()) {
      const clsName = cls.getName();
      if (!clsName) continue;
      classNames.add(clsName);

      const inspectDecorators = (decs: readonly Decorator[]): void => {
        for (const dec of decs) {
          const short = getDecoratorShortName(dec);
          const kind = PIPELINE_DECORATOR_KIND[short];
          if (!kind) continue;
          const refs = new Set<string>();
          for (const arg of dec.getArguments()) {
            collectIdentifiersFromExpr(arg as Expression, refs);
          }
          for (const ref of refs) {
            const list = pipelineConsumersBySymbol.get(ref) ?? [];
            list.push({ kind, consumerClass: clsName, consumerFileKey: fileKey });
            pipelineConsumersBySymbol.set(ref, list);
          }
        }
      };

      inspectDecorators(cls.getDecorators());
      for (const method of cls.getMethods()) {
        inspectDecorators(method.getDecorators());
      }
    }

    // Detect global APP_GUARD/APP_PIPE/APP_INTERCEPTOR/APP_FILTER object literals
    for (const obj of sf.getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression)) {
      const provideProp = obj.getProperty("provide");
      const useClassProp = obj.getProperty("useClass");
      if (
        provideProp &&
        Node.isPropertyAssignment(provideProp) &&
        useClassProp &&
        Node.isPropertyAssignment(useClassProp)
      ) {
        const provideText = provideProp.getInitializer()?.getText().trim() ?? "";
        const useClassText = useClassProp.getInitializer()?.getText().trim() ?? "";
        const globalKind = GLOBAL_PIPELINE_TOKEN_KIND[provideText];
        if (globalKind && useClassText) {
          globalPipelineSymbols.set(useClassText, globalKind);
        }
      }
    }

    // Detect app.useGlobalGuards/Pipes/Interceptors/Filters(...)
    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression();
      if (!Node.isPropertyAccessExpression(callee)) continue;
      const globalKind = GLOBAL_USE_METHOD_KIND[callee.getName()];
      if (!globalKind) continue;
      const refs = new Set<string>();
      for (const arg of call.getArguments()) {
        collectIdentifiersFromExpr(arg as Expression, refs);
      }
      for (const ref of refs) {
        globalPipelineSymbols.set(ref, globalKind);
      }
    }
  }

  // Index module ownership & module import edges
  const ownerModulesBySymbol = new Map<string, Set<string>>();
  const exportedModulesBySymbol = new Map<string, Set<string>>();
  const importingModulesByModule = new Map<string, Set<string>>();
  const moduleFileKeyByName = new Map<string, string>();

  for (const mod of moduleGraph.modules) {
    moduleFileKeyByName.set(mod.name, toCanonicalKey(mod.sourceFile));
    for (const sym of [...mod.providers, ...mod.controllers, ...mod.exports]) {
      let set = ownerModulesBySymbol.get(sym);
      if (!set) {
        set = new Set<string>();
        ownerModulesBySymbol.set(sym, set);
      }
      set.add(mod.name);
    }
    for (const sym of mod.exports) {
      let set = exportedModulesBySymbol.get(sym);
      if (!set) {
        set = new Set<string>();
        exportedModulesBySymbol.set(sym, set);
      }
      set.add(mod.name);
    }
    for (const importedMod of mod.imports) {
      let set = importingModulesByModule.get(importedMod);
      if (!set) {
        set = new Set<string>();
        importingModulesByModule.set(importedMod, set);
      }
      set.add(mod.name);
    }
  }

  // Index constructor DI consumers: depSymbol -> StaticProviderNode[]
  const diConsumersBySymbol = new Map<
    string,
    Array<{ consumerClass: string; consumerFileKey: string }>
  >();
  for (const prov of moduleGraph.providers) {
    const consumerFileKey = toCanonicalKey(prov.sourceFile);
    for (const dep of prov.dependencies) {
      for (const target of new Set([dep.typeName, dep.token].filter(Boolean) as string[])) {
        const list = diConsumersBySymbol.get(target) ?? [];
        list.push({ consumerClass: prov.name, consumerFileKey });
        diConsumersBySymbol.set(target, list);
      }
    }
  }

  // 7. Seed affected files & propagate through reverse imports + Bunest consumer graph
  const affectedReasonsByFileKey = new Map<string, Set<string>>();
  const bfsQueue: Array<{ fileKey: string; reason: string }> = [];
  const propagatedPairs = new Set<string>();

  const enqueueFile = (fileKey: string, reason: string): void => {
    addReason(affectedReasonsByFileKey, fileKey, reason);
    const pair = `${fileKey}\0${reason}`;
    if (!propagatedPairs.has(pair)) {
      propagatedPairs.add(pair);
      bfsQueue.push({ fileKey, reason });
    }
  };

  for (const rel of changedRelFiles) {
    const abs = resolve(cwd, rel);
    const key = toCanonicalKey(abs);
    const exists = existsSyncPath(abs);

    if (exists) {
      if (allTestRelByKey.has(key)) {
        enqueueFile(key, "direct test change");
      } else {
        enqueueFile(key, `imports changed file ${rel}`);
      }
      continue;
    }

    // Deleted or renamed file: match reverse importers by relative stem/module path
    if (isTestFilePath(rel)) {
      // A deleted test file itself cannot be run and does not invalidate unrelated tests
      continue;
    }

    const matchedImporters = new Set<string>();
    for (const stemKey of toStemKeys(abs)) {
      const importers = stemToImporters.get(stemKey);
      if (importers) {
        for (const imp of importers) matchedImporters.add(imp);
      }
    }

    // Also match sibling spec/test file with same stem (e.g. foo.service.ts -> foo.service.spec.ts)
    const deletedStem = stripCodeExtension(rel).toLowerCase();
    for (const [testKey, testRel] of allTestRelByKey.entries()) {
      const testStem = testRel
        .toLowerCase()
        .replace(/\.(?:spec|test)\.(?:ts|tsx|mts|cts)$/i, "");
      if (testStem === deletedStem) {
        matchedImporters.add(testKey);
      }
    }

    if (matchedImporters.size > 0) {
      for (const impKey of matchedImporters) {
        enqueueFile(impKey, `references deleted/renamed file ${rel}`);
      }
    } else if (ALL_SCRIPT_EXTENSIONS.has(extname(abs).toLowerCase())) {
      return buildFallbackPlan(
        cwd,
        changedRelFiles,
        allTestRelFiles,
        `Changed file "${rel}" no longer exists on disk and no reverse importers could be resolved statically; running full test suite.`,
      );
    }
  }

  // Track which symbols have already been expanded for consumer tracing
  const expandedSymbols = new Set<string>();
  const expandedGlobalModules = new Set<string>();

  const expandSymbolConsumers = (sym: string): void => {
    if (expandedSymbols.has(sym)) return;
    expandedSymbols.add(sym);

    // a) Global pipeline registration (APP_GUARD / useGlobalGuards / etc.)
    const globalKind = globalPipelineSymbols.get(sym);
    if (globalKind) {
      for (const mod of moduleGraph.modules) {
        const modKey = toCanonicalKey(mod.sourceFile);
        enqueueFile(
          modKey,
          `consumes global ${globalKind} ${sym} via ${mod.name}`,
        );
      }
      for (const prov of moduleGraph.providers) {
        if (prov.kind === "controller") {
          enqueueFile(
            toCanonicalKey(prov.sourceFile),
            `consumes global ${globalKind} ${sym} via ${prov.name}`,
          );
        }
      }
    }

    // b) Direct pipeline decorator consumers (@UseGuards/@UsePipes/@UseInterceptors/@UseFilters)
    const pipelineEdges = pipelineConsumersBySymbol.get(sym) ?? [];
    for (const edge of pipelineEdges) {
      const ownerMods = ownerModulesBySymbol.get(edge.consumerClass);
      if (ownerMods && ownerMods.size > 0) {
        for (const modName of ownerMods) {
          const reason = `consumes shared ${edge.kind} ${sym} via ${modName}`;
          enqueueFile(edge.consumerFileKey, reason);
          const modKey = moduleFileKeyByName.get(modName);
          if (modKey) enqueueFile(modKey, reason);
        }
      } else {
        enqueueFile(
          edge.consumerFileKey,
          `consumes shared ${edge.kind} ${sym} via ${edge.consumerClass}`,
        );
      }
    }

    // c) Constructor DI consumers
    const diEdges = diConsumersBySymbol.get(sym) ?? [];
    for (const edge of diEdges) {
      const ownerMods = ownerModulesBySymbol.get(edge.consumerClass);
      if (ownerMods && ownerMods.size > 0) {
        for (const modName of ownerMods) {
          const reason = `consumes provider ${sym} via ${modName}`;
          enqueueFile(edge.consumerFileKey, reason);
          const modKey = moduleFileKeyByName.get(modName);
          if (modKey) enqueueFile(modKey, reason);
        }
      } else {
        enqueueFile(
          edge.consumerFileKey,
          `consumes provider ${sym} via ${edge.consumerClass}`,
        );
      }
    }

    // d) Module exports & @Global() module consumers
    const exportingMods = exportedModulesBySymbol.get(sym);
    if (exportingMods) {
      for (const modName of exportingMods) {
        const modNode = moduleGraph.moduleByName.get(modName);
        if (!modNode) continue;
        if (modNode.isGlobal && !expandedGlobalModules.has(modName)) {
          expandedGlobalModules.add(modName);
          for (const otherMod of moduleGraph.modules) {
            if (otherMod.name === modName) continue;
            enqueueFile(
              toCanonicalKey(otherMod.sourceFile),
              `consumes @Global() module ${modName} (${sym}) via ${otherMod.name}`,
            );
          }
        }
        const importers = importingModulesByModule.get(modName);
        if (importers) {
          for (const importerModName of importers) {
            const importerKey = moduleFileKeyByName.get(importerModName);
            if (importerKey) {
              enqueueFile(
                importerKey,
                `consumes exported provider ${sym} from ${modName} via ${importerModName}`,
              );
            }
          }
        }
      }
    }
  };

  // Fixed-point propagation: reverse imports + Bunest module/guard/provider consumer graph
  while (bfsQueue.length > 0) {
    const { fileKey, reason } = bfsQueue.shift()!;

    // Expand Bunest symbols declared in this affected file
    const declaredClasses = classNamesByFileKey.get(fileKey);
    if (declaredClasses) {
      for (const clsName of declaredClasses) {
        expandSymbolConsumers(clsName);
      }
    }

    // Propagate along reverse imports
    const importers = reverseImporters.get(fileKey);
    if (importers) {
      for (const importerKey of importers) {
        enqueueFile(importerKey, reason);
      }
    }
  }

  // 8. Collect selected test files with clean, deterministic reasons
  const selectedTests: AffectedTestSelection[] = [];
  for (const testRel of allTestRelFiles) {
    const testKey = toCanonicalKey(resolve(cwd, testRel));
    const reasonsSet = affectedReasonsByFileKey.get(testKey);
    if (!reasonsSet || reasonsSet.size === 0) continue;

    // Prioritize semantic consumer reasons and direct test changes
    const sortedReasons = [...reasonsSet].sort((a, b) => {
      const rank = (r: string): number => {
        if (r === "direct test change") return 0;
        if (r.startsWith("consumes ")) return 1;
        if (r.startsWith("references deleted/renamed")) return 2;
        return 3;
      };
      const diff = rank(a) - rank(b);
      return diff !== 0 ? diff : a.localeCompare(b);
    });

    selectedTests.push({
      file: testRel,
      reasons: sortedReasons,
    });
  }

  return {
    cwd,
    changedFiles: changedRelFiles,
    selectedTests,
    allTestFiles: allTestRelFiles,
    skippedTestCount: Math.max(0, allTestRelFiles.length - selectedTests.length),
    fallbackToFullSuite: false,
  };
}
