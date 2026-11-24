import { resolve, statPath } from "@bunest/core";
import {
  loadCliConfiguration,
  resolveEntryFile,
} from "../config/configuration.loader";
import { startTypegenWatcher, type TypegenWatcherHandle } from "../typegen";
import type {
  CliIO,
  DevServerOptions,
  DevServerResult,
  SpawnFn,
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
 * Starts the Bunest development server in Bun's native watch mode
 * (`bun --watch <entry>`) with built-in live global type generation powered by
 * the Bunest native TypeScript AST engine (`.bunest/types/bunest.d.ts`).
 */
export async function runDevServer(
  options: DevServerOptions = {},
  io?: CliIO,
): Promise<DevServerResult> {
  const cwd = options.cwd ?? io?.cwd ?? process.cwd();
  const port = options.port;

  if (
    port !== undefined &&
    (!Number.isInteger(port) || port < 0 || port > 65535)
  ) {
    throw new Error(
      `Invalid port "${String(port)}": expected an integer between 0 and 65535.`,
    );
  }

  const { config } = await loadCliConfiguration(cwd, options.config);
  const entry = options.entry
    ? resolve(cwd, options.entry)
    : await resolveEntryFile(cwd, config, {
        sourceRoot: options.sourceRoot,
      });

  try {
    const info = await statPath(entry);
    if (!info.isFile()) {
      throw new Error(`Dev entry path is not a file: ${entry}`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Dev entry path")) {
      throw err;
    }
    throw new Error(`Dev entry file not found: ${entry}`);
  }

  const { enabled: configTypegenEnabled, config: typegenCfg } =
    resolveTypegenConfig(config.typegen);
  const typegenEnabled =
    options.typegen !== undefined ? options.typegen : configTypegenEnabled;

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
        envFiles: typegenCfg.envFiles,
        include: typegenCfg.include,
        includeGlobalNamespace: typegenCfg.includeGlobalNamespace,
        debounceMs: typegenCfg.debounceMs,
        silent: options.silent,
      },
      io,
    );
  }

  const command = ["bun", "--watch", entry];
  const env: Record<string, string | undefined> = {
    ...Bun.env,
    ...(port !== undefined ? { PORT: String(port) } : {}),
  };

  if (io && !options.silent) {
    const portMsg = port !== undefined ? ` (PORT=${port})` : "";
    io.stdout(`Starting Bunest dev server: bun --watch ${entry}${portMsg}`);
  }

  const spawn = options.spawn ?? defaultSpawn;
  const spawnCmd = [process.execPath, "--watch", entry];
  try {
    const { exitCode } = await spawn(spawnCmd, { cwd, env });
    return {
      exitCode,
      command,
      entry,
      port,
      ...(watcher ? { typegen: watcher.initialResult } : {}),
    };
  } finally {
    await watcher?.close();
  }
}
