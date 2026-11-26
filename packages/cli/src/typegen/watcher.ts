import {
  basename,
  existsSyncPath,
  join,
  readDirSyncNames,
  resolve,
  statSyncPath,
  watchPath,
  type FsWatcher,
} from "@bunest/core";
import { loadBunestConfig } from "../config/bunest-config.loader";
import type { CliIO } from "../types";
import { formatTypegenSummary, writeTypegenOutput } from "./emitter";
import { BunestTypegenScanner } from "./scanner";
import type {
  TypegenResult,
  TypegenScanResult,
  TypegenWatcherHandle,
  TypegenWatcherOptions,
} from "./types";

export interface TypegenWatcherHandleWithScan extends TypegenWatcherHandle {
  readonly initialScan?: TypegenScanResult;
}

const IGNORED_WATCH_SEGMENTS = new Set([
  "node_modules",
  "dist",
  ".git",
  ".bunest",
  "coverage",
]);

function collectWatchableDirectories(rootDir: string): string[] {
  if (!existsSyncPath(rootDir)) return [];
  const dirs = [rootDir];
  let entries: string[];
  try {
    entries = readDirSyncNames(rootDir);
  } catch {
    return dirs;
  }
  for (const entry of entries) {
    if (IGNORED_WATCH_SEGMENTS.has(entry)) continue;
    const full = join(rootDir, entry);
    try {
      if (statSyncPath(full).isDirectory()) {
        dirs.push(...collectWatchableDirectories(full));
      }
    } catch {
      // Ignore transient entries
    }
  }
  return dirs;
}

function shouldTriggerTypegen(
  filePath: string,
  outputPath: string,
  envFileBasenames: ReadonlySet<string>,
): boolean {
  const resolved = resolve(filePath);
  if (resolved === outputPath) return false;
  const parts = resolved.split(/[\\/]/);
  for (const seg of parts) {
    if (IGNORED_WATCH_SEGMENTS.has(seg)) return false;
  }
  const base = basename(resolved);
  if (envFileBasenames.has(base) || base.startsWith(".env")) {
    return true;
  }
  if (resolved.endsWith(".d.ts")) return false;
  if (/\.(?:spec|test)\.tsx?$/i.test(resolved)) return false;
  return resolved.endsWith(".ts") || resolved.endsWith(".tsx");
}

/**
 * Starts a persistent, incremental Bunest native TypeScript AST typegen watcher designed to run
 * seamlessly alongside `bun --watch` during `bunest dev` and `bunest start --watch`.
 *
 * - Runs an immediate initial generation pass before returning.
 * - Watches `sourceRoot` (and root `.env*` files) with debouncing and serialized updates.
 * - Incrementally refreshes only modified files in the persistent Bunest AST `Project`.
 * - Writes `.bunest/types/bunest.d.ts` only when emitted declarations actually change.
 */
export async function startTypegenWatcher(
  options: TypegenWatcherOptions = {},
  io?: CliIO,
): Promise<TypegenWatcherHandleWithScan> {
  const cwd = resolve(options.cwd ?? io?.cwd ?? process.cwd());
  const bunestConfig =
    options.bunestConfig ??
    (options.loadBunestConfig === false
      ? {}
      : (
          await loadBunestConfig(cwd, {
            configPath: options.bunestConfigPath,
          })
        ).config);
  const cfgTypegen = bunestConfig.typegen;
  const sourceRoot = options.sourceRoot ?? cfgTypegen?.sourceRoot ?? "src";
  const outDir = options.outDir ?? cfgTypegen?.outDir ?? ".bunest/types";
  const fileName = options.fileName ?? cfgTypegen?.fileName ?? "bunest.d.ts";
  const outputPath = resolve(cwd, outDir, fileName);
  const includeGlobalNamespace =
    options.includeGlobalNamespace ?? cfgTypegen?.includeGlobalNamespace ?? true;
  const debounceMs = Math.max(20, options.debounceMs ?? 120);
  const envFiles = options.envFiles ??
    cfgTypegen?.envFiles ?? [
      ".env.example",
      ".env",
      ".env.development",
      ".env.local",
    ];
  const envFileBasenames = new Set(envFiles.map((f) => basename(f)));

  const scanner = new BunestTypegenScanner({
    cwd,
    sourceRoot,
    tsconfigPath: options.tsconfigPath ?? cfgTypegen?.tsconfigPath,
    envFiles,
    include: options.include ?? cfgTypegen?.include,
    plugins: options.plugins,
    macroDefaults: options.macroDefaults,
    macroPresets: options.macroPresets,
    customMacros: options.customMacros,
    bunestConfig,
  });

  let latestScan: TypegenScanResult | undefined;

  const runRegenerate = async (
    changedPaths?: readonly string[],
  ): Promise<TypegenResult> => {
    if (changedPaths && changedPaths.length > 0) {
      let touchedTs = false;
      for (const p of changedPaths) {
        if (scanner.refreshFile(p)) {
          touchedTs = true;
        }
      }
      if (!touchedTs) {
        // Directory rename/add/env change: ensure file list is synced
        scanner.syncAllSourceFiles();
      }
    } else {
      scanner.syncAllSourceFiles();
    }

    const scan = await scanner.scanAsync({
      outputPath,
      includeGlobalNamespace,
    });
    latestScan = scan;
    return await writeTypegenOutput(scan, {
      cwd,
      outputPath,
      includeGlobalNamespace,
      dryRun: options.dryRun,
      check: options.check,
    });
  };

  // Initial pass before returning so IDE types are ready immediately on dev start
  const initialResult = await runRegenerate();
  const initialScan = latestScan;
  if (io && !options.silent) {
    const verb = initialResult.changed ? "Generated" : "Up-to-date";
    io.stdout(
      `[typegen] ${verb} ${initialResult.relativePath} (${formatTypegenSummary(initialResult.summary)}) in ${initialResult.durationMs.toFixed(1)}ms`,
    );
  }

  const watchers: FsWatcher[] = [];
  const pendingPaths = new Set<string>();
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let rerunQueued = false;
  let closed = false;

  const flush = async (): Promise<void> => {
    if (closed) return;
    if (running) {
      rerunQueued = true;
      return;
    }
    running = true;
    try {
      do {
        rerunQueued = false;
        const batch = [...pendingPaths];
        pendingPaths.clear();
        const result = await runRegenerate(batch);
        if (result.changed) {
          if (io && !options.silent) {
            io.stdout(
              `[typegen] Updated ${result.relativePath} (${formatTypegenSummary(result.summary)}) in ${result.durationMs.toFixed(1)}ms`,
            );
          }
          options.onUpdate?.(result);
        }
      } while (rerunQueued && !closed);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (options.onError) {
        options.onError(error);
      } else if (io && !options.silent) {
        io.stderr(`[typegen] Warning: ${error.message}`);
      }
    } finally {
      running = false;
    }
  };

  const schedulePath = (absPath: string): void => {
    if (closed) return;
    if (!shouldTriggerTypegen(absPath, outputPath, envFileBasenames)) {
      return;
    }
    pendingPaths.add(absPath);
    if (debounceTimer !== undefined) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      void flush();
    }, debounceMs);
    if (typeof (debounceTimer as { unref?: () => void }).unref === "function") {
      (debounceTimer as { unref: () => void }).unref();
    }
  };

  const sourceRootDir = resolve(cwd, sourceRoot);
  if (existsSyncPath(sourceRootDir)) {
    try {
      const w = watchPath(
        sourceRootDir,
        { recursive: true },
        (_event, filename) => {
          if (typeof filename === "string" && filename.length > 0) {
            schedulePath(join(sourceRootDir, filename));
          }
        },
      );
      w.on("error", () => {
        // Ignore transient OS watcher errors during rapid folder renames
      });
      watchers.push(w);
    } catch {
      // Fallback for platforms without recursive fs.watch (e.g. older Linux kernels)
      for (const dir of collectWatchableDirectories(sourceRootDir)) {
        try {
          const w = watchPath(dir, (_event, filename) => {
            if (typeof filename === "string" && filename.length > 0) {
              schedulePath(join(dir, filename));
            }
          });
          w.on("error", () => {});
          watchers.push(w);
        } catch {
          // Skip unwatched directories
        }
      }
    }
  }

  // Watch project root (non-recursively) for `.env*` changes
  if (existsSyncPath(cwd)) {
    try {
      const rootWatcher = watchPath(cwd, (_event, filename) => {
        if (typeof filename === "string" && filename.startsWith(".env")) {
          schedulePath(join(cwd, filename));
        }
      });
      rootWatcher.on("error", () => {});
      watchers.push(rootWatcher);
    } catch {
      // Ignore if root cannot be watched
    }
  }

  return {
    initialResult,
    initialScan,
    outputPath,
    regenerate: runRegenerate,
    close: async () => {
      if (closed) return;
      closed = true;
      if (debounceTimer !== undefined) {
        clearTimeout(debounceTimer);
        debounceTimer = undefined;
      }
      for (const w of watchers) {
        try {
          w.close();
        } catch {
          // Ignore close errors
        }
      }
      watchers.length = 0;
    },
  };
}
