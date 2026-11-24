import {
  basename,
  ensureDir,
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
} from "../config/configuration.loader";
import type {
  BuildArtifactSummary,
  BuildProjectOptions,
  BuildProjectResult,
  CliIO,
  SpawnFn,
} from "../types";

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

  const entry = await resolveEntryFile(cwd, config, {
    entry: options.entry,
    entryFile: options.entryFile,
    sourceRoot: options.sourceRoot,
  });
  const outdir = resolve(cwd, options.outdir ?? "dist");
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
    await removePath(outdir, { recursive: true, force: true });
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

  try {
    buildResult = await Bun.build({
      entrypoints: [entry],
      outdir,
      target,
      format: "esm",
      minify,
      sourcemap,
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
