import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import {
  loadCliConfiguration,
  resolveEntryFile,
} from "../config/configuration.loader";
import type {
  CliIO,
  SpawnFn,
  StartCommandOptions,
  StartCommandResult,
} from "../types";

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
  const entry = await resolveEntryFile(cwd, config, {
    entry: options.entry,
    entryFile: options.entryFile,
    sourceRoot: options.sourceRoot,
  });

  if (
    options.port !== undefined &&
    (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)
  ) {
    throw new Error(
      `Invalid port "${String(options.port)}": expected an integer between 0 and 65535.`,
    );
  }

  try {
    const info = await stat(entry);
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
    ? (Array.isArray(options.envFile) ? [...options.envFile] : [options.envFile])
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
    ...process.env,
    ...(options.port !== undefined ? { PORT: String(options.port) } : {}),
    ...(options.preserveWatchOutput ? { BUNEST_PRESERVE_WATCH_OUTPUT: "1" } : {}),
  };

  if (io && !options.silent) {
    io.stdout(`Starting Bunest application: ${displayCmd.join(" ")}`);
  }

  const spawn = options.spawn ?? defaultSpawn;
  const { exitCode } = await spawn(spawnCmd, { cwd, env });

  return {
    exitCode,
    command: displayCmd,
    entry,
    watch,
    debug,
    envFiles,
  };
}
