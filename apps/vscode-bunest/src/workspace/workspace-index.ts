import {
  basename,
  dirname,
  ensureDir,
  existsSyncPath,
  join,
  readTextSync,
  realpathSyncOf,
  relative,
  resolve,
  writeTextSync,
} from "@bunest/core";
import * as vscode from "vscode";
import {
  BUNEST_CONFIG_FILES,
  BunestStaticAnalyzer,
  buildTypegenSummary,
  emitBunestDeclaration,
  findBunestConfigPath,
  formatTypegenSummary,
  loadBunestConfig,
  loadCliConfiguration,
  resolveTypegenConfig,
  validateGeneratedDeclaration,
  type BunestConfigLike,
  type BunestWorkspaceSnapshot,
  type SourceLocation,
} from "@bunest/cli";

const SENSITIVE_ENV_KEY_RE =
  /(?:SECRET|PASSWORD|PASSWD|TOKEN|KEY|AUTH|CREDENTIAL|DSN|PRIVATE|JWT|BEARER|COOKIE)/i;

const DEFAULT_ENV_FILES = [
  ".env.local",
  ".env.development",
  ".env",
  ".env.example",
] as const;

export interface WorkspaceFolderContext {
  readonly folder: vscode.WorkspaceFolder;
  readonly cwd: string;
  sourceRoot: string;
  analyzer: BunestStaticAnalyzer;
  bunestConfig?: BunestConfigLike;
  bunestConfigPath?: string | null;
  isConfirmedBunest: boolean;
  typegenEnabled: boolean;
  typegenOutputPath: string;
  includeGlobalNamespace: boolean;
  lastTypegenContent?: string;
  lastTypegenSummary?: string;
  snapshot?: BunestWorkspaceSnapshot;
}

const BUNEST_CONFIG_FILE_SET = new Set<string>(BUNEST_CONFIG_FILES);

export function isBunestConfigFile(filePath: string): boolean {
  return BUNEST_CONFIG_FILE_SET.has(basename(filePath));
}

export function isSensitiveEnvKey(key: string): boolean {
  return SENSITIVE_ENV_KEY_RE.test(key);
}

function isEnvFilePath(filePath: string): boolean {
  return basename(filePath).startsWith(".env");
}

function isEditableTsFilePath(filePath: string): boolean {
  return (
    (filePath.endsWith(".ts") || filePath.endsWith(".tsx")) &&
    !filePath.endsWith(".d.ts")
  );
}

function isInsideBunestDir(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return normalized.includes("/.bunest/") || normalized.endsWith("/.bunest");
}

export function sourceLocationToVscodeLocation(
  loc: SourceLocation,
): vscode.Location {
  const uri = vscode.Uri.file(loc.filePath);
  const startLine = Math.max(0, loc.line - 1);
  const startCol = Math.max(0, loc.column - 1);
  const endLine = Math.max(startLine, loc.endLine - 1);
  const endCol = Math.max(0, loc.endColumn - 1);
  return new vscode.Location(
    uri,
    new vscode.Range(startLine, startCol, endLine, endCol),
  );
}

export function sourceLocationToVscodeRange(loc: SourceLocation): vscode.Range {
  const startLine = Math.max(0, loc.line - 1);
  const startCol = Math.max(0, loc.column - 1);
  const endLine = Math.max(startLine, loc.endLine - 1);
  const endCol = Math.max(0, loc.endColumn - 1);
  return new vscode.Range(startLine, startCol, endLine, endCol);
}

function isConfirmedBunestProject(cwd: string): boolean {
  if (existsSyncPath(join(cwd, "bunest.json"))) return true;
  if (findBunestConfigPath(cwd) !== null) return true;
  if (existsSyncPath(join(cwd, ".bunest", "types"))) return true;
  const pkgPath = join(cwd, "package.json");
  if (existsSyncPath(pkgPath)) {
    try {
      const raw = readTextSync(pkgPath);
      if (raw.includes("@bunest/") && existsSyncPath(join(cwd, "src"))) {
        return true;
      }
    } catch {
      // ignore
    }
  }
  return false;
}

function isBunestWorkspace(cwd: string): boolean {
  if (isConfirmedBunestProject(cwd)) return true;
  const pkgPath = join(cwd, "package.json");
  if (existsSyncPath(pkgPath)) {
    try {
      const raw = readTextSync(pkgPath);
      if (raw.includes("@bunest/")) return true;
    } catch {
      // ignore
    }
  }
  return existsSyncPath(join(cwd, "src"));
}

function findNearestBunestProjectRoot(
  filePath: string,
  stopDir: string,
): string | undefined {
  const boundary = resolve(stopDir);
  let current = dirname(resolve(filePath));
  while (true) {
    if (isConfirmedBunestProject(current)) {
      return current;
    }
    if (current === boundary) {
      break;
    }
    const parent = dirname(current);
    if (parent === current || !parent.startsWith(boundary)) {
      break;
    }
    current = parent;
  }
  return undefined;
}

function extractEnvPreviewFromContent(
  relFile: string,
  content: string,
  key: string,
  revealSecrets: boolean,
):
  | { readonly file: string; readonly value: string; readonly redacted: boolean }
  | undefined {
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const cleaned = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eqIdx = cleaned.indexOf("=");
    if (eqIdx <= 0) continue;
    const k = cleaned.slice(0, eqIdx).trim();
    if (k !== key) continue;
    const rawVal = cleaned
      .slice(eqIdx + 1)
      .trim()
      .replace(/^(['"])(.*)\1$/, "$2");
    const redacted = !revealSecrets && isSensitiveEnvKey(key);
    return {
      file: relFile,
      value: redacted ? "[REDACTED]" : rawVal,
      redacted,
    };
  }
  return undefined;
}

/**
 * Live in-memory AST workspace index & zero-save typegen engine for VS Code / Antigravity IDE.
 *
 * Updates the persistent `@bunest/cli` AST index on every editor keystroke and
 * automatically syncs `.bunest/types/bunest.d.ts` from unsaved buffers (with
 * lexical syntax validation so mid-keystroke partial edits never break TS).
 */
export class BunestWorkspaceIndex implements vscode.Disposable {
  private readonly folders = new Map<string, WorkspaceFolderContext>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pendingDiskRefreshes = new Map<string, Set<string>>();
  private readonly refreshSequence = new Map<string, number>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly onDidUpdateEmitter = new vscode.EventEmitter<
    readonly BunestWorkspaceSnapshot[]
  >();
  private readonly statusBarItem: vscode.StatusBarItem;
  readonly outputChannel: vscode.OutputChannel;

  readonly onDidUpdate = this.onDidUpdateEmitter.event;

  constructor() {
    this.outputChannel = vscode.window.createOutputChannel("Bunest");
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100,
    );
    this.statusBarItem.command = "bunest.regenerateTypes";
    this.statusBarItem.text = "$(sync~spin) Bunest: Indexing...";
    this.statusBarItem.tooltip =
      "Bunest Live AST & Typegen Index (auto-updates .bunest/types/bunest.d.ts as you type; click to force CLI typegen).";
    this.statusBarItem.show();
    this.disposables.push(
      this.outputChannel,
      this.statusBarItem,
      this.onDidUpdateEmitter,
    );
  }

  async initialize(): Promise<void> {
    const wsFolders = vscode.workspace.workspaceFolders ?? [];
    for (const folder of wsFolders) {
      await this.registerFolder(folder);
    }

    // Lazily discover nested Bunest projects (e.g. monorepo apps/examples) for
    // already-open documents and sync any unsaved dirty buffers immediately.
    const openDocs = vscode.workspace.textDocuments ?? [];
    for (const doc of openDocs) {
      if (doc.uri?.scheme && doc.uri.scheme !== "file") continue;
      const fp = doc.uri.fsPath;
      if (!fp || isInsideBunestDir(fp)) continue;
      const ctx = await this.ensureContextForFile(fp);
      if (!ctx) continue;
      if (doc.isDirty) {
        if (isEditableTsFilePath(fp) && !isBunestConfigFile(fp)) {
          ctx.analyzer.updateFileContent(fp, doc.getText());
        } else if (isEnvFilePath(fp)) {
          ctx.analyzer.updateEnvFileContent(fp, doc.getText());
        }
      }
    }

    const configWatcher =
      typeof vscode.workspace.createFileSystemWatcher === "function"
        ? vscode.workspace.createFileSystemWatcher(
            "**/{bunest.config.{ts,mts,js,mjs},bunest.json}",
          )
        : undefined;

    if (configWatcher) {
      const onConfigFsChange = (uri: vscode.Uri): void => {
        const ctx = this.getContextForFile(uri.fsPath);
        if (ctx) {
          void this.reloadConfigForFolder(ctx);
        }
      };
      this.disposables.push(
        configWatcher,
        configWatcher.onDidChange(onConfigFsChange),
        configWatcher.onDidCreate(onConfigFsChange),
        configWatcher.onDidDelete(onConfigFsChange),
      );
    }

    if (typeof vscode.workspace.onDidOpenTextDocument === "function") {
      this.disposables.push(
        vscode.workspace.onDidOpenTextDocument((doc) => {
          if (doc.uri?.scheme && doc.uri.scheme !== "file") return;
          const fp = doc.uri.fsPath;
          if (!fp || isInsideBunestDir(fp)) return;
          if (isEditableTsFilePath(fp) || isEnvFilePath(fp)) {
            void this.ensureContextForFile(fp).then((ctx) => {
              if (ctx && !ctx.snapshot) {
                void this.refreshFolder(ctx, undefined, false);
              }
            });
          }
        }),
      );
    }

    if (typeof vscode.workspace.onDidCloseTextDocument === "function") {
      this.disposables.push(
        vscode.workspace.onDidCloseTextDocument((doc) => {
          if (doc.uri?.scheme && doc.uri.scheme !== "file") return;
          const fp = doc.uri.fsPath;
          if (!fp || isInsideBunestDir(fp) || isBunestConfigFile(fp)) return;
          const ctx = this.getContextForFile(fp);
          if (!ctx) return;
          // If an edited file was closed without saving, revert its in-memory
          // AST / .env override back to disk so discarded edits don't linger.
          if (isEditableTsFilePath(fp)) {
            ctx.analyzer.refreshFile(fp);
            this.scheduleRefresh(fp, true);
          } else if (isEnvFilePath(fp)) {
            ctx.analyzer.clearEnvFileOverride(fp);
            this.scheduleRefresh(fp, true);
          }
        }),
      );
    }

    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (doc.uri?.scheme && doc.uri.scheme !== "file") return;
        const fp = doc.uri.fsPath;
        if (!fp || isInsideBunestDir(fp)) return;
        if (isBunestConfigFile(fp) || basename(fp) === "bunest.json") {
          const ctx = this.getContextForFile(fp);
          if (ctx) {
            void this.reloadConfigForFolder(ctx);
          }
          return;
        }
        if (isEnvFilePath(fp)) {
          const ctx = this.getContextForFile(fp);
          ctx?.analyzer.clearEnvFileOverride(fp);
          this.scheduleRefresh(fp, true);
          return;
        }
        if (isEditableTsFilePath(fp)) {
          this.scheduleRefresh(fp, true);
        }
      }),
      vscode.workspace.onDidChangeTextDocument((evt) => {
        if (evt.document.uri?.scheme && evt.document.uri.scheme !== "file") {
          return;
        }
        if (
          Array.isArray(evt.contentChanges) &&
          evt.contentChanges.length === 0
        ) {
          return;
        }
        const fp = evt.document.uri.fsPath;
        if (
          !fp ||
          isInsideBunestDir(fp) ||
          isBunestConfigFile(fp) ||
          basename(fp) === "bunest.json"
        ) {
          return;
        }
        if (!isEditableTsFilePath(fp) && !isEnvFilePath(fp)) {
          return;
        }

        const applyChange = (ctx: WorkspaceFolderContext): void => {
          if (isEditableTsFilePath(fp)) {
            ctx.analyzer.updateFileContent(fp, evt.document.getText());
          } else if (isEnvFilePath(fp)) {
            ctx.analyzer.updateEnvFileContent(fp, evt.document.getText());
          }
          this.scheduleRefresh(fp, false);
        };

        const existing = this.getContextForFile(fp);
        if (existing) {
          applyChange(existing);
        } else {
          void this.ensureContextForFile(fp).then((ctx) => {
            if (ctx) applyChange(ctx);
          });
        }
      }),
      vscode.workspace.onDidCreateFiles((evt) => {
        for (const u of evt.files) {
          const fp = u.fsPath;
          if (!fp || isInsideBunestDir(fp)) continue;
          if (isBunestConfigFile(fp) || basename(fp) === "bunest.json") {
            const ctx = this.getContextForFile(fp);
            if (ctx) void this.reloadConfigForFolder(ctx);
            continue;
          }
          this.scheduleRefresh(fp, true);
        }
      }),
      vscode.workspace.onDidDeleteFiles((evt) => {
        for (const u of evt.files) {
          const fp = u.fsPath;
          if (!fp || isInsideBunestDir(fp)) continue;
          if (isBunestConfigFile(fp) || basename(fp) === "bunest.json") {
            const ctx = this.getContextForFile(fp);
            if (ctx) void this.reloadConfigForFolder(ctx);
            continue;
          }
          if (isEnvFilePath(fp)) {
            const ctx = this.getContextForFile(fp);
            ctx?.analyzer.clearEnvFileOverride(fp);
          }
          this.scheduleRefresh(fp, true);
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(async (evt) => {
        for (const removed of evt.removed) {
          const removedRoot = resolve(removed.uri.fsPath);
          for (const key of [...this.folders.keys()]) {
            if (key === removedRoot || key.startsWith(`${removedRoot}/`)) {
              this.folders.delete(key);
            }
          }
        }
        for (const added of evt.added) {
          await this.registerFolder(added);
        }
        this.emitUpdate();
      }),
    );

    await this.refreshAll();
  }

  private isLiveTypegenSettingEnabled(): boolean {
    return (
      vscode.workspace
        .getConfiguration("bunest")
        .get<boolean>("typegen.live") ?? true
    );
  }

  private getDebounceMs(): number {
    const cfg = vscode.workspace.getConfiguration("bunest");
    const liveMs = cfg.get<number>("typegen.debounceMs");
    if (typeof liveMs === "number" && Number.isFinite(liveMs) && liveMs >= 0) {
      return liveMs;
    }
    const indexMs = cfg.get<number>("index.debounceMs");
    if (
      typeof indexMs === "number" &&
      Number.isFinite(indexMs) &&
      indexMs >= 0
    ) {
      return indexMs;
    }
    return 120;
  }

  private async loadWorkspaceBunestConfig(cwd: string): Promise<{
    readonly config: BunestConfigLike;
    readonly configPath: string | null;
  }> {
    const detected = findBunestConfigPath(cwd);
    if (!detected) {
      return { config: {}, configPath: null };
    }
    try {
      const loaded = await loadBunestConfig(cwd);
      if (loaded.configPath) {
        this.outputChannel.appendLine(
          `[bunest] Loaded workspace config: ${loaded.configPath}`,
        );
      }
      return loaded;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.outputChannel.appendLine(
        `[bunest] Warning: Failed to load ${detected}: ${msg}`,
      );
      return { config: {}, configPath: detected };
    }
  }

  private async resolveFolderSettings(cwd: string): Promise<{
    readonly sourceRoot: string;
    readonly bunestConfig: BunestConfigLike;
    readonly bunestConfigPath: string | null;
    readonly isConfirmedBunest: boolean;
    readonly typegenEnabled: boolean;
    readonly typegenOutputPath: string;
    readonly includeGlobalNamespace: boolean;
    readonly tsconfigPath?: string;
    readonly envFiles?: readonly string[];
    readonly include?: BunestConfigLike["typegen"] extends infer T
      ? T extends { include?: infer I }
        ? I
        : undefined
      : undefined;
  }> {
    let cliConfig: Awaited<ReturnType<typeof loadCliConfiguration>>["config"] | undefined;
    try {
      const loadedCli = await loadCliConfiguration(cwd);
      cliConfig = loadedCli.config;
    } catch {
      // default configuration
    }

    const { config: bunestConfig, configPath: bunestConfigPath } =
      await this.loadWorkspaceBunestConfig(cwd);

    const cliTypegen = resolveTypegenConfig(cliConfig?.typegen);
    const cfgTypegen = bunestConfig.typegen;
    const isConfirmedBunest = isConfirmedBunestProject(cwd);
    const sourceRoot =
      cfgTypegen?.sourceRoot ?? cliConfig?.sourceRoot ?? "src";
    const outDir = cfgTypegen?.outDir ?? cliTypegen.config.outDir ?? ".bunest/types";
    const fileName =
      cfgTypegen?.fileName ?? cliTypegen.config.fileName ?? "bunest.d.ts";
    const typegenOutputPath = resolve(cwd, outDir, fileName);
    const includeGlobalNamespace =
      cfgTypegen?.includeGlobalNamespace ??
      cliTypegen.config.includeGlobalNamespace ??
      true;
    const typegenEnabled = isConfirmedBunest && cliTypegen.enabled;

    return {
      sourceRoot,
      bunestConfig,
      bunestConfigPath,
      isConfirmedBunest,
      typegenEnabled,
      typegenOutputPath,
      includeGlobalNamespace,
      tsconfigPath:
        cfgTypegen?.tsconfigPath ??
        cliTypegen.config.tsconfigPath ??
        cliConfig?.compilerOptions?.tsConfigPath,
      envFiles: cfgTypegen?.envFiles ?? cliTypegen.config.envFiles,
      include: cfgTypegen?.include ?? cliTypegen.config.include,
    };
  }

  private async registerProjectRoot(
    cwd: string,
    folder: vscode.WorkspaceFolder,
  ): Promise<WorkspaceFolderContext> {
    const resolvedCwd = resolve(cwd);
    const existing = this.folders.get(resolvedCwd);
    if (existing) return existing;

    const settings = await this.resolveFolderSettings(resolvedCwd);
    const analyzer = new BunestStaticAnalyzer({
      cwd: resolvedCwd,
      sourceRoot: settings.sourceRoot,
      tsconfigPath: settings.tsconfigPath,
      envFiles: settings.envFiles,
      include: settings.include,
      bunestConfig: settings.bunestConfig,
    });

    const ctx: WorkspaceFolderContext = {
      folder,
      cwd: resolvedCwd,
      sourceRoot: settings.sourceRoot,
      analyzer,
      bunestConfig: settings.bunestConfig,
      bunestConfigPath: settings.bunestConfigPath,
      isConfirmedBunest: settings.isConfirmedBunest,
      typegenEnabled: settings.typegenEnabled,
      typegenOutputPath: settings.typegenOutputPath,
      includeGlobalNamespace: settings.includeGlobalNamespace,
    };

    this.folders.set(resolvedCwd, ctx);
    return ctx;
  }

  private async registerFolder(folder: vscode.WorkspaceFolder): Promise<void> {
    const cwd = resolve(folder.uri.fsPath);
    if (!isBunestWorkspace(cwd)) return;
    await this.registerProjectRoot(cwd, folder);
  }

  private async ensureContextForFile(
    filePath: string,
  ): Promise<WorkspaceFolderContext | undefined> {
    const abs = resolve(filePath);
    const wsFolders = vscode.workspace.workspaceFolders ?? [];

    let containingFolder: vscode.WorkspaceFolder | undefined;
    for (const folder of wsFolders) {
      const fRoot = resolve(folder.uri.fsPath);
      if (abs === fRoot || abs.startsWith(`${fRoot}/`) || abs.startsWith(`${fRoot}\\`)) {
        if (
          !containingFolder ||
          fRoot.length > resolve(containingFolder.uri.fsPath).length
        ) {
          containingFolder = folder;
        }
      }
    }

    if (containingFolder) {
      const nearest = findNearestBunestProjectRoot(
        abs,
        containingFolder.uri.fsPath,
      );
      if (nearest) {
        const existing = this.folders.get(nearest);
        if (existing) return existing;
        return this.registerProjectRoot(nearest, containingFolder);
      }
    }

    return this.getContextForFile(abs);
  }

  private evictConfigModuleCache(configPath: string | null | undefined): void {
    if (!configPath) return;
    if (typeof require === "undefined" || !require.cache) return;
    const candidates = new Set<string>([configPath]);
    try {
      candidates.add(realpathSyncOf(configPath));
    } catch {
      // Ignore if file was deleted
    }
    for (const key of candidates) {
      delete require.cache[key];
    }
  }

  async reloadConfigForFolder(
    ctx: WorkspaceFolderContext,
  ): Promise<BunestWorkspaceSnapshot> {
    this.evictConfigModuleCache(ctx.bunestConfigPath);
    this.evictConfigModuleCache(findBunestConfigPath(ctx.cwd));

    const settings = await this.resolveFolderSettings(ctx.cwd);
    ctx.bunestConfig = settings.bunestConfig;
    ctx.bunestConfigPath = settings.bunestConfigPath;
    ctx.sourceRoot = settings.sourceRoot;
    ctx.isConfirmedBunest = settings.isConfirmedBunest;
    ctx.typegenEnabled = settings.typegenEnabled;
    ctx.typegenOutputPath = settings.typegenOutputPath;
    ctx.includeGlobalNamespace = settings.includeGlobalNamespace;
    ctx.lastTypegenContent = undefined;
    ctx.analyzer = new BunestStaticAnalyzer({
      cwd: ctx.cwd,
      sourceRoot: ctx.sourceRoot,
      tsconfigPath: settings.tsconfigPath,
      envFiles: settings.envFiles,
      include: settings.include,
      bunestConfig: ctx.bunestConfig,
    });

    // Preserve any currently unsaved open documents after config reload
    for (const doc of vscode.workspace.textDocuments ?? []) {
      if (doc.uri?.scheme && doc.uri.scheme !== "file") continue;
      if (!doc.isDirty) continue;
      const fp = doc.uri.fsPath;
      if (!fp || !resolve(fp).startsWith(ctx.cwd) || isInsideBunestDir(fp)) {
        continue;
      }
      if (isEditableTsFilePath(fp) && !isBunestConfigFile(fp)) {
        ctx.analyzer.updateFileContent(fp, doc.getText());
      } else if (isEnvFilePath(fp)) {
        ctx.analyzer.updateEnvFileContent(fp, doc.getText());
      }
    }

    return this.refreshFolder(ctx, undefined, true);
  }

  private scheduleRefresh(filePath: string, reloadFromDisk: boolean): void {
    const ctx = this.getContextForFile(filePath);
    if (!ctx) return;

    if (reloadFromDisk) {
      let pending = this.pendingDiskRefreshes.get(ctx.cwd);
      if (!pending) {
        pending = new Set<string>();
        this.pendingDiskRefreshes.set(ctx.cwd, pending);
      }
      pending.add(resolve(filePath));
    }

    const existing = this.timers.get(ctx.cwd);
    if (existing) clearTimeout(existing);

    const debounceMs = this.getDebounceMs();

    const timer = setTimeout(() => {
      this.timers.delete(ctx.cwd);
      const diskFiles = this.pendingDiskRefreshes.get(ctx.cwd);
      this.pendingDiskRefreshes.delete(ctx.cwd);
      if (diskFiles && diskFiles.size > 0) {
        for (const df of diskFiles) {
          if (isEditableTsFilePath(df)) {
            ctx.analyzer.refreshFile(df);
          }
        }
      }
      void this.refreshFolder(ctx, filePath, false);
    }, debounceMs);
    this.timers.set(ctx.cwd, timer);
  }

  private async emitLiveTypegenIfNeeded(
    ctx: WorkspaceFolderContext,
    snapshot: BunestWorkspaceSnapshot,
    seq: number,
  ): Promise<void> {
    if (
      !this.isLiveTypegenSettingEnabled() ||
      !ctx.typegenEnabled ||
      !ctx.isConfirmedBunest
    ) {
      return;
    }

    // Abort if a newer refresh has already started for this folder
    if (this.refreshSequence.get(ctx.cwd) !== seq) {
      return;
    }

    const content = emitBunestDeclaration(snapshot.scan, {
      cwd: ctx.cwd,
      outputPath: ctx.typegenOutputPath,
      includeGlobalNamespace: ctx.includeGlobalNamespace,
    });

    if (content === ctx.lastTypegenContent) {
      return;
    }

    // Never overwrite a valid `.d.ts` with syntactically broken intermediate text
    if (!validateGeneratedDeclaration(content)) {
      this.outputChannel.appendLine(
        "[typegen:live] Skipped intermediate write due to incomplete syntax while editing.",
      );
      return;
    }

    // On first pass, compare against disk so we avoid redundant writes if already up to date
    if (ctx.lastTypegenContent === undefined && existsSyncPath(ctx.typegenOutputPath)) {
      try {
        const diskContent = readTextSync(ctx.typegenOutputPath);
        if (diskContent === content) {
          ctx.lastTypegenContent = content;
          ctx.lastTypegenSummary = formatTypegenSummary(
            buildTypegenSummary(snapshot.scan),
          );
          return;
        }
      } catch {
        // Proceed to write
      }
    }

    if (this.refreshSequence.get(ctx.cwd) !== seq) {
      return;
    }

    try {
      await ensureDir(dirname(ctx.typegenOutputPath));
      if (this.refreshSequence.get(ctx.cwd) !== seq) {
        return;
      }
      writeTextSync(ctx.typegenOutputPath, content);
      ctx.lastTypegenContent = content;
      const summaryText = formatTypegenSummary(
        buildTypegenSummary(snapshot.scan),
      );
      ctx.lastTypegenSummary = summaryText;
      const relOut = relative(ctx.cwd, ctx.typegenOutputPath).replace(
        /\\/g,
        "/",
      );
      this.outputChannel.appendLine(
        `[typegen:live] Updated ${relOut} (${summaryText}) in ${snapshot.durationMs.toFixed(1)}ms`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.outputChannel.appendLine(
        `[typegen:live] Warning: failed to update ${ctx.typegenOutputPath}: ${msg}`,
      );
    }
  }

  async refreshFolder(
    ctx: WorkspaceFolderContext,
    changedFile?: string,
    reloadFromDisk = false,
  ): Promise<BunestWorkspaceSnapshot> {
    const seq = (this.refreshSequence.get(ctx.cwd) ?? 0) + 1;
    this.refreshSequence.set(ctx.cwd, seq);

    if (changedFile && isEditableTsFilePath(changedFile) && reloadFromDisk) {
      ctx.analyzer.refreshFile(changedFile);
    } else if (!changedFile) {
      ctx.analyzer.syncAllFiles();
    }

    const snapshot = await ctx.analyzer.analyzeAsync({
      outputPath: ctx.typegenOutputPath,
      includeGlobalNamespace: ctx.includeGlobalNamespace,
    });

    if (this.refreshSequence.get(ctx.cwd) !== seq) {
      return ctx.snapshot ?? snapshot;
    }

    ctx.snapshot = snapshot;
    await this.emitLiveTypegenIfNeeded(ctx, snapshot, seq);

    this.updateStatusBar();
    this.emitUpdate();
    return snapshot;
  }

  async refreshAll(): Promise<void> {
    for (const ctx of this.folders.values()) {
      await this.refreshFolder(ctx, undefined, true);
    }
    this.updateStatusBar();
  }

  getContextForFile(filePath: string): WorkspaceFolderContext | undefined {
    const abs = resolve(filePath);
    let best: WorkspaceFolderContext | undefined;
    for (const ctx of this.folders.values()) {
      if (
        abs === ctx.cwd ||
        abs.startsWith(`${ctx.cwd}/`) ||
        abs.startsWith(`${ctx.cwd}\\`)
      ) {
        if (!best || ctx.cwd.length > best.cwd.length) {
          best = ctx;
        }
      }
    }
    return best;
  }

  getSnapshotForFile(filePath: string): BunestWorkspaceSnapshot | undefined {
    return this.getContextForFile(filePath)?.snapshot;
  }

  getAllContexts(): WorkspaceFolderContext[] {
    return [...this.folders.values()];
  }

  getAllSnapshots(): BunestWorkspaceSnapshot[] {
    const out: BunestWorkspaceSnapshot[] = [];
    for (const ctx of this.folders.values()) {
      if (ctx.snapshot) out.push(ctx.snapshot);
    }
    return out;
  }

  /**
   * Reads a key from open unsaved `.env` buffers or workspace `.env` files,
   * automatically redacting sensitive keys unless `bunest.hover.revealSecrets` is enabled.
   */
  readEnvPreview(
    cwd: string,
    key: string,
  ):
    | { readonly file: string; readonly value: string; readonly redacted: boolean }
    | undefined {
    const revealSecrets =
      vscode.workspace
        .getConfiguration("bunest")
        .get<boolean>("hover.revealSecrets") ?? false;

    const openDocsByPath = new Map<string, string>();
    for (const doc of vscode.workspace.textDocuments ?? []) {
      if (doc.uri?.scheme && doc.uri.scheme !== "file") continue;
      if (doc.uri?.fsPath && isEnvFilePath(doc.uri.fsPath)) {
        openDocsByPath.set(resolve(doc.uri.fsPath), doc.getText());
      }
    }

    for (const rel of DEFAULT_ENV_FILES) {
      const abs = resolve(join(cwd, rel));
      const inMemory = openDocsByPath.get(abs);
      if (inMemory !== undefined) {
        const found = extractEnvPreviewFromContent(
          rel,
          inMemory,
          key,
          revealSecrets,
        );
        if (found) return found;
        continue;
      }
      if (!existsSyncPath(abs)) continue;
      let content: string;
      try {
        content = readTextSync(abs);
      } catch {
        continue;
      }
      const found = extractEnvPreviewFromContent(
        rel,
        content,
        key,
        revealSecrets,
      );
      if (found) return found;
    }
    return undefined;
  }

  private updateStatusBar(): void {
    const snaps = this.getAllSnapshots();
    if (snaps.length === 0) {
      this.statusBarItem.text = "$(plug) Bunest";
      this.statusBarItem.tooltip = "No Bunest workspace folders detected";
      return;
    }

    let routes = 0;
    let repos = 0;
    let macros = 0;
    let errors = 0;
    for (const s of snaps) {
      routes += s.scan.routes.length;
      repos += s.repositories.length;
      macros += s.scan.classMacros.length;
      errors += s.diagnostics.filter((d) => d.severity === "error").length;
    }

    const liveOn = this.isLiveTypegenSettingEnabled();
    const icon = errors > 0 ? "$(warning)" : "$(check)";
    this.statusBarItem.text = `${icon} Bunest: ${routes} routes · ${repos} repos · ${macros} macros`;
    this.statusBarItem.tooltip = liveOn
      ? `Bunest Live Typegen Active (${errors} error${errors === 1 ? "" : "s"}). Auto-syncs .bunest/types/bunest.d.ts as you type (no save required) — click to force CLI typegen.`
      : `Bunest AST Index (${errors} error${errors === 1 ? "" : "s"}). Live typegen disabled — click to run \`bunest typegen\` via CLI.`;
  }

  private emitUpdate(): void {
    this.onDidUpdateEmitter.fire(this.getAllSnapshots());
  }

  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.pendingDiskRefreshes.clear();
    for (const d of this.disposables) d.dispose();
  }
}
