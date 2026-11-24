import { join, resolve, statPath } from "@bunest/core";
import {
  loadCliConfiguration,
  resolveEntryFile,
  resolveProjectConfiguration,
} from "../config/configuration.loader";
import { startTypegenWatcher, type TypegenWatcherHandle } from "../typegen";
import type {
  CliIO,
  SpawnFn,
  StartCommandOptions,
  StartCommandResult,
} from "../types";
import { resolveTypegenConfig } from "./typegen";

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

/**
 * Starts a Bunest application (`bunest start`) with support for `--watch`,
 * `--debug [hostport]`, `--env-file`, `--entryFile`, `--sourceRoot`, `--config`,
 * `--preserveWatchOutput`, `--silent`, and `--exec`.
 */
export async function runStartCommand(
  options: StartCommandOptions = {},
  io?: CliIO,
): Promise<StartCommandResult> {
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

  if (
    options.port !== undefined &&
    (!Number.isInteger(options.port) ||
      options.port < 0 ||
      options.port > 65535)
  ) {
    throw new Error(
      `Invalid port "${String(options.port)}": expected an integer between 0 and 65535.`,
    );
  }

  try {
    const info = await statPath(entry);
    if (!info.isFile()) {
      throw new Error(`Start entry path is not a file: ${entry}`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Start entry path")) {
      throw err;
    }
    throw new Error(`Start entry file not found: ${entry}`);
  }

  const watch = options.watch === true;
  const debug = options.debug;
  const envFiles = options.envFile
    ? Array.isArray(options.envFile)
      ? [...options.envFile]
      : [options.envFile]
    : [];
  const execBinary = options.exec ?? config.exec;

  const args: string[] = [];
  if (!execBinary) {
    if (watch) {
      args.push("--watch");
    }
    if (debug === true) {
      args.push("--inspect");
    } else if (typeof debug === "string" && debug.length > 0) {
      args.push(`--inspect=${debug}`);
    }
    for (const envFilePath of envFiles) {
      args.push("--env-file", resolve(cwd, envFilePath));
    }
  } else {
    if (watch) {
      args.push("--watch");
    }
    if (debug === true) {
      args.push("--inspect");
    } else if (typeof debug === "string" && debug.length > 0) {
      args.push(`--inspect=${debug}`);
    }
  }
  args.push(entry);

  const displayCmd = [execBinary ?? "bun", ...args];
  const spawnCmd = [execBinary ?? process.execPath, ...args];
  const env: Record<string, string | undefined> = {
    ...Bun.env,
    ...(options.port !== undefined ? { PORT: String(options.port) } : {}),
    ...(options.preserveWatchOutput
      ? { BUNEST_PRESERVE_WATCH_OUTPUT: "1" }
      : {}),
  };

  const { enabled: configTypegenEnabled, config: typegenCfg } =
    resolveTypegenConfig(config.typegen);
  const typegenEnabled = watch
    ? options.typegen !== undefined
      ? options.typegen
      : configTypegenEnabled
    : options.typegen === true;

  let watcher: TypegenWatcherHandle | undefined;
  if (typegenEnabled) {
    watcher = await startTypegenWatcher(
      {
        cwd,
        sourceRoot: options.sourceRoot ?? config.sourceRoot ?? "src",
        outDir: options.typegenOutDir ?? typegenCfg.outDir ?? ".bunest/types",
        fileName: typegenCfg.fileName ?? "bunest.d.ts",
        tsconfigPath:
          typegenCfg.tsconfigPath ?? config.compilerOptions?.tsConfigPath,
        envFiles: envFiles.length > 0 ? envFiles : typegenCfg.envFiles,
        include: typegenCfg.include,
        includeGlobalNamespace: typegenCfg.includeGlobalNamespace,
        debounceMs: typegenCfg.debounceMs,
        silent: options.silent,
      },
      io,
    );
  }

  if (io && !options.silent) {
    io.stdout(`Starting Bunest application: ${displayCmd.join(" ")}`);
  }

  const spawn = options.spawn ?? defaultSpawn;
  try {
    const { exitCode } = await spawn(spawnCmd, { cwd, env });
    return {
      exitCode,
      command: displayCmd,
      entry,
      watch,
      debug,
      envFiles,
      ...(watcher ? { typegen: watcher.initialResult } : {}),
    };
  } finally {
    await watcher?.close();
  }
}
