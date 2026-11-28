import {
  basename,
  dirname,
  ensureDir,
  existsSyncPath,
  getPlatform,
  join,
  relative,
  removePath,
  resolve,
  statPath,
} from "@bunest/core";
import { loadBunestConfig } from "../config/bunest-config.loader";
import {
  loadCliConfiguration,
  resolveEntryFile,
  resolveProjectConfiguration,
  type Asset,
} from "../config/configuration.loader";
import { createBunestPlugin } from "../plugins/bunest.plugin";
import type {
  BuildArtifactSummary,
  BuildProjectOptions,
  BuildProjectResult,
  CliIO,
  SpawnFn,
} from "../types";
import { resolveSafeChildPath } from "../utils/naming";

const VALID_TARGETS = new Set(["bun", "browser", "node"] as const);

const defaultSpawn: SpawnFn = async (cmd, options) => {
  const proc = Bun.spawn(cmd, {
    cwd: options.cwd,
    env: options.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;
  return { exitCode };
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(2)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function normalizeSourcemap(
  sourcemap: BuildProjectOptions["sourcemap"],
): "none" | "linked" | "inline" | "external" {
  if (sourcemap === true) {
    return "linked";
  }
  if (sourcemap === false || sourcemap === undefined) {
    return "none";
  }
  if (
    sourcemap === "none" ||
    sourcemap === "linked" ||
    sourcemap === "inline" ||
    sourcemap === "external"
  ) {
    return sourcemap;
  }
  throw new Error(
    `Invalid sourcemap mode "${String(sourcemap)}". Expected one of: none, linked, inline, external.`,
  );
}

async function copyConfiguredAssets(params: {
  readonly assets: readonly Asset[];
  readonly sourceRootDir: string;
  readonly outdir: string;
  readonly cwd: string;
}): Promise<void> {
  const { assets, sourceRootDir, outdir, cwd } = params;
  if (!existsSyncPath(sourceRootDir)) return;

  for (const asset of assets) {
    const rawInclude = typeof asset === "string" ? asset : asset.include;
    if (!rawInclude) continue;
    const rawExclude = typeof asset === "string" ? undefined : asset.exclude;
    const assetOutDir =
      typeof asset === "string" || !asset.outDir
        ? outdir
        : resolve(cwd, asset.outDir);

    let pattern = rawInclude.replace(/\\/g, "/").replace(/^\.\//, "");
    const hasGlobMagic = /[*?[\]{}]/.test(pattern);
    if (!hasGlobMagic) {
      const candidatePath = join(sourceRootDir, pattern);
      try {
        const info = await statPath(candidatePath);
        if (info.isDirectory()) {
          pattern = `${pattern.replace(/\/+$/, "")}/**/*`;
        }
      } catch {
        // treat as literal glob pattern
      }
    }

    const excludeGlob = rawExclude ? new Bun.Glob(rawExclude) : undefined;
    const glob = new Bun.Glob(pattern);
    for await (const relFile of glob.scan({
      cwd: sourceRootDir,
      dot: true,
      onlyFiles: true,
    })) {
      if (excludeGlob?.match(relFile)) continue;
      const srcPath = join(sourceRootDir, relFile);
      const destPath = join(assetOutDir, relFile);
      await ensureDir(dirname(destPath));
      await Bun.write(destPath, Bun.file(srcPath));
    }
  }
}

function resolveTscPath(cwd: string): string | undefined {
  for (const startDir of [cwd, import.meta.dir]) {
    let dir = resolve(startDir);
    while (true) {
      const candidate = join(dir, "node_modules", "typescript", "bin", "tsc");
      if (existsSyncPath(candidate)) return candidate;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return Bun.which("tsc") ?? undefined;
}

async function emitTypeDeclarations(params: {
  readonly cwd: string;
  readonly outdir: string;
  readonly sourceRootDir: string;
  readonly tsconfigPath: string;
}): Promise<void> {
  const tscPath = resolveTscPath(params.cwd);
  if (!tscPath) return;

  const relRootDir = relative(params.cwd, params.sourceRootDir) || ".";
  const relOutDir = relative(params.cwd, params.outdir) || "dist";
  const relTsconfig = relative(params.cwd, params.tsconfigPath) || "tsconfig.json";
  const args = [
    process.execPath,
    tscPath,
    ...(existsSyncPath(params.tsconfigPath)
      ? ["--project", relTsconfig]
      : []),
    "--declaration",
    "--emitDeclarationOnly",
    "--noEmit",
    "false",
    "--outDir",
    relOutDir,
    "--rootDir",
    relRootDir,
  ];
  const proc = Bun.spawn(args, {
    cwd: params.cwd,
    stdout: "ignore",
    stderr: "ignore",
  });
  await proc.exited;
}

function isWorkerTestFile(filePath: string): boolean {
  return /\.(?:spec|test)\.[cm]?[jt]sx?$/i.test(filePath);
}

async function resolveAuxEntrypoints(params: {
  readonly cwd: string;
  readonly sourceRootDir: string;
  readonly entry: string;
  readonly explicitEntries?: readonly string[];
  readonly autoDiscover: boolean;
  readonly autoDiscoverGlob: string;
}): Promise<string[]> {
  const {
    cwd,
    sourceRootDir,
    entry,
    explicitEntries,
    autoDiscover,
    autoDiscoverGlob,
  } = params;
  const resolvedEntry = resolve(entry);
  const found = new Set<string>();

  if (explicitEntries && explicitEntries.length > 0) {
    for (const rawSpec of explicitEntries) {
      const trimmed = rawSpec.trim();
      if (!trimmed) continue;
      const normalized = trimmed.replace(/\\/g, "/").replace(/^\.\//, "");
      const hasGlobMagic = /[*?[\]{}]/.test(normalized);
      if (hasGlobMagic) {
        const glob = new Bun.Glob(normalized);
        const scanBase = existsSyncPath(sourceRootDir) ? sourceRootDir : cwd;
        for await (const rel of glob.scan({ cwd: scanBase, onlyFiles: true })) {
          const full = resolve(scanBase, rel);
          if (full !== resolvedEntry && !isWorkerTestFile(full)) {
            found.add(full);
          }
        }
        if (scanBase !== cwd) {
          for await (const rel of glob.scan({ cwd, onlyFiles: true })) {
            const full = resolve(cwd, rel);
            if (full !== resolvedEntry && !isWorkerTestFile(full)) {
              found.add(full);
            }
          }
        }
      } else {
        const fromCwd = resolve(cwd, trimmed);
        const fromSrc = resolve(sourceRootDir, trimmed);
        const target = existsSyncPath(fromCwd)
          ? fromCwd
          : existsSyncPath(fromSrc)
            ? fromSrc
            : undefined;
        if (target && target !== resolvedEntry) {
          found.add(target);
        }
      }
    }
  }

  if (autoDiscover && existsSyncPath(sourceRootDir)) {
    const glob = new Bun.Glob(autoDiscoverGlob);
    for await (const rel of glob.scan({
      cwd: sourceRootDir,
      onlyFiles: true,
    })) {
      const full = resolve(sourceRootDir, rel);
      if (full !== resolvedEntry && !isWorkerTestFile(full)) {
        found.add(full);
      }
    }
  }

  return [...found].sort();
}

function isInsideDir(filePath: string, parentDir: string): boolean {
  const rel = relative(parentDir, filePath);
  return rel.length > 0 && !rel.startsWith("..") && !rel.startsWith("/");
}

async function archiveBuildOutput(
  outdir: string,
  cwd: string,
  archiveOption: boolean | string,
): Promise<string> {
  const archivePath =
    typeof archiveOption === "string" && archiveOption.trim().length > 0
      ? resolve(cwd, archiveOption.trim())
      : resolve(dirname(outdir), `${basename(outdir) || "dist"}.tar.gz`);

  const entries: Record<string, Uint8Array> = {};
  const glob = new Bun.Glob("**/*");
  for await (const rel of glob.scan({ cwd: outdir, dot: true, onlyFiles: true })) {
    const fullPath = join(outdir, rel);
    if (fullPath === archivePath) continue;
    const normalized = rel.replace(/\\/g, "/");
    entries[normalized] = await Bun.file(fullPath).bytes();
  }

  const ArchiveCtor = (
    Bun as unknown as {
      Archive: new (
        files: Record<string, Uint8Array>,
        options?: { compress?: "gzip" },
      ) => { bytes(): Promise<Uint8Array> };
    }
  ).Archive;
  const bytes = await new ArchiveCtor(entries, { compress: "gzip" }).bytes();
  await ensureDir(dirname(archivePath));
  await Bun.write(archivePath, bytes);
  return archivePath;
}

/**
 * Bundles a Bunest application using `Bun.build()` (or `bun build --compile`
 * standalone executable) with `bunest.json` / `nest-cli.json` integration.
 */
export async function buildProject(
  options: BuildProjectOptions = {},
  io?: CliIO,
): Promise<BuildProjectResult> {
  const cwd = options.cwd ?? io?.cwd ?? process.cwd();
  const { config } = await loadCliConfiguration(cwd, options.config);
  const project = resolveProjectConfiguration(config, options.project);

  const effectiveSourceRoot =
    options.sourceRoot ??
    project?.sourceRoot ??
    (project?.root ? join(project.root, "src") : undefined);
  const effectiveEntryFile = options.entryFile ?? project?.entryFile;

  const entry = await resolveEntryFile(cwd, config, {
    entry: options.entry,
    entryFile: effectiveEntryFile,
    sourceRoot: effectiveSourceRoot,
  });
  const defaultOutdir = project?.root ? join("dist", project.root) : "dist";
  const outdir = resolve(cwd, options.outdir ?? defaultOutdir);
  const target = options.target ?? "bun";
  const minify = options.minify ?? false;
  const sourcemap = normalizeSourcemap(options.sourcemap);
  const deleteOutDir =
    options.deleteOutDir ?? config.compilerOptions?.deleteOutDir ?? false;
  const silent = options.silent === true;

  if (!VALID_TARGETS.has(target)) {
    throw new Error(
      `Invalid build target "${String(target)}". Expected one of: bun, browser, node.`,
    );
  }

  try {
    const info = await statPath(entry);
    if (!info.isFile()) {
      throw new Error(`Build entry path is not a file: ${entry}`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Build entry path")) {
      throw err;
    }
    throw new Error(`Build entry file not found: ${entry}`);
  }

  if (deleteOutDir) {
    const allowOutsidePaths =
      (config.compilerOptions as { allowOutsidePaths?: boolean } | undefined)
        ?.allowOutsidePaths === true;
    const rawOutdir = options.outdir ?? "dist";
    const safeOutdir = allowOutsidePaths
      ? outdir
      : resolveSafeChildPath(cwd, rawOutdir);
    await removePath(safeOutdir, { recursive: true, force: true });

    // Also remove stale TypeScript incremental buildinfo if declared in tsconfig
    const tsconfigPath = resolve(cwd, options.path ?? "tsconfig.json");
    if (await Bun.file(tsconfigPath).exists()) {
      try {
        const rawTsconfig = await Bun.file(tsconfigPath).text();
        const parsed = Bun.JSONC.parse(rawTsconfig) as {
          compilerOptions?: { tsBuildInfoFile?: string };
        };
        const buildInfo = parsed?.compilerOptions?.tsBuildInfoFile;
        if (typeof buildInfo === "string" && buildInfo.trim().length > 0) {
          const infoTarget = allowOutsidePaths
            ? resolve(cwd, buildInfo)
            : resolveSafeChildPath(cwd, buildInfo);
          await removePath(infoTarget, { force: true });
        }
      } catch {
        // Ignore malformed tsconfig during buildinfo cleanup
      }
    }
  }

  const sourceRootDir = resolve(
    cwd,
    effectiveSourceRoot ?? config.sourceRoot ?? "src",
  );
  const configuredWorkers = [
    ...(config.compilerOptions?.workers ?? []),
    ...(project?.compilerOptions?.workers ?? []),
    ...(options.workers ?? []),
  ];
  const autoDiscoverWorkers =
    options.autoDiscoverWorkers ??
    project?.compilerOptions?.autoDiscoverWorkers ??
    config.compilerOptions?.autoDiscoverWorkers ??
    true;
  const workerEntries = await resolveAuxEntrypoints({
    cwd,
    sourceRootDir,
    entry,
    explicitEntries: configuredWorkers,
    autoDiscover: autoDiscoverWorkers,
    autoDiscoverGlob: "**/*.worker.{ts,js,mts,mjs}",
  });
  const configuredCrons = [
    ...(config.compilerOptions?.crons ?? []),
    ...(project?.compilerOptions?.crons ?? []),
    ...(options.crons ?? []),
  ];
  const autoDiscoverCrons =
    options.autoDiscoverCrons ??
    project?.compilerOptions?.autoDiscoverCrons ??
    config.compilerOptions?.autoDiscoverCrons ??
    true;
  const cronEntries = await resolveAuxEntrypoints({
    cwd,
    sourceRootDir,
    entry,
    explicitEntries: configuredCrons,
    autoDiscover: autoDiscoverCrons,
    autoDiscoverGlob: "**/*.cron.{ts,js,mts,mjs}",
  });
  const auxEntries = [...new Set([...workerEntries, ...cronEntries])];

  // Standalone single-file executable via `bun build --compile`
  if (options.compile) {
    const startMs = performance.now();
    await ensureDir(outdir);
    const baseName = basename(entry).replace(/\.[cm]?[jt]sx?$/i, "");
    const ext = getPlatform() === "win32" ? ".exe" : "";
    const outfile = join(outdir, `${baseName}${ext}`);

    const resolvedTsconfigPath = options.path
      ? resolve(cwd, options.path)
      : undefined;
    const { config: bunestConfig } = await loadBunestConfig(cwd);

    // When running real `bun build --compile` (no mocked spawn), pre-bundle through
    // `createBunestPlugin({ aotDiMetadata: true, ... })` so constructor DI metadata,
    // `@AutoModule` globs, Swagger metadata, and circular-safe ORM transforms survive compilation.
    let compileEntrypoints = [entry, ...auxEntries];
    let prebundleTmpDir: string | undefined;

    if (!options.spawn) {
      prebundleTmpDir = join(
        outdir,
        `.bunest-compile-${crypto.randomUUID().slice(0, 8)}`,
      );
      await ensureDir(prebundleTmpDir);
      const preserveRoot =
        auxEntries.length > 0 &&
        compileEntrypoints.every((ep) => isInsideDir(ep, sourceRootDir))
          ? sourceRootDir
          : undefined;

      const prebundle = await Bun.build({
        entrypoints: compileEntrypoints,
        ...(preserveRoot ? { root: preserveRoot } : {}),
        outdir: prebundleTmpDir,
        target: "bun",
        format: "esm",
        tsconfig: resolvedTsconfigPath,
        plugins: [
          createBunestPlugin({
            config: bunestConfig,
            classMacros: bunestConfig?.plugin?.classMacros ?? false,
            aotDiMetadata: bunestConfig?.plugin?.aotDiMetadata ?? true,
            expandAutoModuleGlobs: true,
          }),
        ],
      });

      if (!prebundle.success) {
        await removePath(prebundleTmpDir, { recursive: true, force: true });
        const durationMs = Math.round((performance.now() - startMs) * 100) / 100;
        const preLogs = prebundle.logs.map((l) => `[${l.level}] ${l.message}`);
        if (io && !silent) {
          io.stderr(`Build failed for ${entry}:\n  ${preLogs.join("\n  ")}`);
        }
        return {
          success: false,
          entry,
          outdir,
          outputs: [],
          durationMs,
          logs: preLogs,
          ...(workerEntries.length > 0 ? { workerEntries } : {}),
          ...(cronEntries.length > 0 ? { cronEntries } : {}),
        };
      }

      const prebundledEntries = prebundle.outputs
        .filter((artifact) => artifact.kind === "entry-point")
        .map((artifact) => artifact.path);
      if (prebundledEntries.length > 0) {
        compileEntrypoints = prebundledEntries;
      }
    }

    const compileArgs = [
      process.execPath,
      "build",
      "--compile",
      ...(options.bytecode ? ["--bytecode"] : []),
      ...(minify ? ["--minify"] : []),
      ...compileEntrypoints,
      "--outfile",
      outfile,
    ];
    const spawn = options.spawn ?? defaultSpawn;
    let exitCode: number;
    try {
      ({ exitCode } = await spawn(compileArgs, { cwd, env: Bun.env }));
    } finally {
      if (prebundleTmpDir) {
        await removePath(prebundleTmpDir, { recursive: true, force: true });
      }
    }
    const durationMs = Math.round((performance.now() - startMs) * 100) / 100;

    if (exitCode !== 0) {
      const msg = `[error] bun build --compile exited with code ${exitCode}`;
      if (io && !silent) {
        io.stderr(`Build failed for ${entry}:\n  ${msg}`);
      }
      return {
        success: false,
        entry,
        outdir,
        outputs: [],
        durationMs,
        logs: [msg],
        ...(workerEntries.length > 0 ? { workerEntries } : {}),
        ...(cronEntries.length > 0 ? { cronEntries } : {}),
      };
    }

    let size = 0;
    try {
      size = (await statPath(outfile)).size;
    } catch {
      // May be a mocked spawn in unit tests
    }

    const outputs: BuildArtifactSummary[] = [
      {
        path: outfile,
        relativePath: relative(cwd, outfile).replace(/\\/g, "/"),
        size,
        kind: "executable",
      },
    ];

    let archivePath: string | undefined;
    if (options.archive) {
      archivePath = await archiveBuildOutput(outdir, cwd, options.archive);
    }

    if (io && !silent) {
      io.stdout(
        `Compiled standalone executable in ${durationMs.toFixed(1)}ms: ${outputs[0]!.relativePath}`,
      );
      if (archivePath) {
        io.stdout(
          `Archived build output: ${relative(cwd, archivePath).replace(/\\/g, "/")}`,
        );
      }
    }

    return {
      success: true,
      entry,
      outdir,
      outputs,
      durationMs,
      logs: [],
      compiledExecutable: outfile,
      ...(archivePath ? { archivePath } : {}),
      ...(workerEntries.length > 0 ? { workerEntries } : {}),
      ...(cronEntries.length > 0 ? { cronEntries } : {}),
    };
  }

  const startMs = performance.now();
  let buildResult: Awaited<ReturnType<typeof Bun.build>>;
  let caughtErrors: unknown[] | undefined;

  const resolvedTsconfigPath = options.path
    ? resolve(cwd, options.path)
    : undefined;
  const { config: bunestConfig } = await loadBunestConfig(cwd);

  const entrypoints = [entry, ...auxEntries];
  const preserveRoot =
    auxEntries.length > 0 &&
    entrypoints.every((ep) => isInsideDir(ep, sourceRootDir))
      ? sourceRootDir
      : undefined;

  if (options.bytecode && io && !silent) {
    io.stderr(
      "Warning: --bytecode requires --compile for ESM bundles and was ignored for standard bundle output.",
    );
  }

  try {
    buildResult = await Bun.build({
      entrypoints,
      ...(preserveRoot ? { root: preserveRoot } : {}),
      outdir,
      target,
      format: "esm",
      minify,
      sourcemap,
      tsconfig: resolvedTsconfigPath,
      external: options.external ? [...options.external] : undefined,
      plugins: [
        createBunestPlugin({
          config: bunestConfig,
          classMacros: bunestConfig?.plugin?.classMacros ?? false,
          aotDiMetadata: bunestConfig?.plugin?.aotDiMetadata ?? true,
        }),
      ],
    });
  } catch (err) {
    caughtErrors =
      err instanceof AggregateError && Array.isArray(err.errors)
        ? err.errors
        : [err];
    buildResult = {
      success: false,
      outputs: [],
      logs: [],
    };
  }
  const durationMs = Math.round((performance.now() - startMs) * 100) / 100;

  const formatBuildMessage = (msg: unknown): string => {
    if (typeof msg === "object" && msg !== null && "message" in msg) {
      const m = msg as {
        level?: string;
        message: string;
        position?: { file?: string; line?: number; column?: number } | null;
      };
      const level = m.level ?? "error";
      const loc = m.position?.file
        ? `${m.position.file}:${m.position.line ?? 0}:${m.position.column ?? 0}`
        : "";
      return loc
        ? `[${level}] ${loc} - ${m.message}`
        : `[${level}] ${m.message}`;
    }
    return `[error] ${String(msg)}`;
  };

  const logs = [
    ...buildResult.logs.map((log) => formatBuildMessage(log)),
    ...(caughtErrors ?? []).map((err) => formatBuildMessage(err)),
  ];

  if (!buildResult.success) {
    if (io && !silent) {
      io.stderr(`Build failed for ${entry}:`);
      for (const line of logs) {
        io.stderr(`  ${line}`);
      }
    }
    return {
      success: false,
      entry,
      outdir,
      outputs: [],
      durationMs,
      logs,
    };
  }

  const assets = [
    ...(config.compilerOptions?.assets ?? []),
    ...(project?.compilerOptions?.assets ?? []),
  ];
  if (assets.length > 0) {
    await copyConfiguredAssets({
      assets,
      sourceRootDir,
      outdir,
      cwd,
    });
  }

  if (options.emitDeclarations) {
    await emitTypeDeclarations({
      cwd,
      outdir,
      sourceRootDir,
      tsconfigPath: resolve(cwd, options.path ?? "tsconfig.json"),
    });
  }

  const outputs: BuildArtifactSummary[] = buildResult.outputs.map(
    (artifact) => ({
      path: artifact.path,
      relativePath: relative(cwd, artifact.path).replace(/\\/g, "/"),
      size: artifact.size,
      kind: artifact.kind,
    }),
  );

  let archivePath: string | undefined;
  if (options.archive) {
    archivePath = await archiveBuildOutput(outdir, cwd, options.archive);
  }

  if (io && !silent) {
    io.stdout(
      `Built ${outputs.length} artifact(s) in ${durationMs.toFixed(1)}ms (target=${target}, minify=${minify}, sourcemap=${sourcemap}):`,
    );
    for (const out of outputs) {
      io.stdout(
        `  ${out.relativePath}  ${formatBytes(out.size)} (${out.kind})`,
      );
    }
    if (archivePath) {
      io.stdout(
        `  Archive: ${relative(cwd, archivePath).replace(/\\/g, "/")}`,
      );
    }
  }

  if (options.watch && options.spawn) {
    await options.spawn(
      [
        process.execPath,
        "build",
        "--watch",
        entry,
        "--outdir",
        outdir,
        "--target",
        target,
      ],
      { cwd, env: Bun.env },
    );
  }

  return {
    success: true,
    entry,
    outdir,
    outputs,
    durationMs,
    logs,
    ...(archivePath ? { archivePath } : {}),
    ...(workerEntries.length > 0 ? { workerEntries } : {}),
    ...(cronEntries.length > 0 ? { cronEntries } : {}),
  };
}
