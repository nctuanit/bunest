import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  CliIO,
  DevServerOptions,
  DevServerResult,
  SpawnFn,
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
 * Starts the Bunest development server in Bun's native watch mode
 * (`bun --watch <entry>`).
 */
export async function runDevServer(
  options: DevServerOptions = {},
  io?: CliIO,
): Promise<DevServerResult> {
  const cwd = options.cwd ?? io?.cwd ?? process.cwd();
  const entry = resolve(cwd, options.entry ?? "src/main.ts");
  const port = options.port;

  if (
    port !== undefined &&
    (!Number.isInteger(port) || port < 0 || port > 65535)
  ) {
    throw new Error(
      `Invalid port "${String(port)}": expected an integer between 0 and 65535.`,
    );
  }

  try {
    const info = await stat(entry);
    if (!info.isFile()) {
      throw new Error(`Dev entry path is not a file: ${entry}`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Dev entry path")) {
      throw err;
    }
    throw new Error(`Dev entry file not found: ${entry}`);
  }

  const command = ["bun", "--watch", entry];
  const env: Record<string, string | undefined> = {
    ...process.env,
    ...(port !== undefined ? { PORT: String(port) } : {}),
  };

  if (io) {
    const portMsg = port !== undefined ? ` (PORT=${port})` : "";
    io.stdout(`Starting Bunest dev server: bun --watch ${entry}${portMsg}`);
  }

  const spawn = options.spawn ?? defaultSpawn;
  const spawnCmd = [process.execPath, "--watch", entry];
  const { exitCode } = await spawn(spawnCmd, { cwd, env });

  return {
    exitCode,
    command,
    entry,
    port,
  };
}
