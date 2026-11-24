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
import {
  loadCliConfiguration,
  resolveEntryFile,
  resolveProjectConfiguration,
  type Asset,
} from "../config/configuration.loader";
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

  // Standalone single-file executable via `bun build --compile`
  if (options.compile) {
    const startMs = performance.now();
    await ensureDir(outdir);
    const baseName = basename(entry).replace(/\.[cm]?[jt]sx?$/i, "");
    const ext = getPlatform() === "win32" ? ".exe" : "";
    const outfile = join(outdir, `${baseName}${ext}`);
    const compileArgs = [
      process.execPath,
      "build",
      "--compile",
      ...(minify ? ["--minify"] : []),
      entry,
      "--outfile",
      outfile,
    ];
    const spawn = options.spawn ?? defaultSpawn;
    const { exitCode } = await spawn(compileArgs, { cwd, env: Bun.env });
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

    if (io && !silent) {
      io.stdout(
        `Compiled standalone executable in ${durationMs.toFixed(1)}ms: ${outputs[0]!.relativePath}`,
      );
    }

    return {
      success: true,
      entry,
      outdir,
      outputs,
      durationMs,
      logs: [],
      compiledExecutable: outfile,
    };
  }

  const startMs = performance.now();
  let buildResult: Awaited<ReturnType<typeof Bun.build>>;
  let caughtErrors: unknown[] | undefined;

  const resolvedTsconfigPath = options.path
    ? resolve(cwd, options.path)
    : undefined;

  try {
    buildResult = await Bun.build({
      entrypoints: [entry],
      outdir,
      target,
      format: "esm",
      minify,
      sourcemap,
      tsconfig: resolvedTsconfigPath,
      external: options.external ? [...options.external] : undefined,
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

  const sourceRootDir = resolve(
    cwd,
    effectiveSourceRoot ?? config.sourceRoot ?? "src",
  );
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

  if (io && !silent) {
    io.stdout(
      `Built ${outputs.length} artifact(s) in ${durationMs.toFixed(1)}ms (target=${target}, minify=${minify}, sourcemap=${sourcemap}):`,
    );
    for (const out of outputs) {
      io.stdout(
        `  ${out.relativePath}  ${formatBytes(out.size)} (${out.kind})`,
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
  };
}
