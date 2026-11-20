import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  CliIO,
  ReplCommandOptions,
  ReplCommandResult,
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
 * Launches a Bunest REPL entry script (e.g., `src/repl.ts` or custom `--entry`).
 */
export async function runReplCommand(
  options: ReplCommandOptions = {},
  io?: CliIO,
): Promise<ReplCommandResult> {
  const cwd = options.cwd ?? io?.cwd ?? process.cwd();
  const entry = resolve(cwd, options.entry ?? "src/repl.ts");

  try {
    const info = await stat(entry);
    if (!info.isFile()) {
      throw new Error(`REPL entry path is not a file: ${entry}`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("REPL entry path")) {
      throw err;
    }
    throw new Error(
      `REPL entry file not found: ${entry}. Create a repl entrypoint calling repl(AppModule) or pass --entry <file>.`,
    );
  }

  const command = ["bun", "run", entry];
  if (io) {
    io.stdout(`Starting Bunest REPL: bun run ${entry}`);
  }

  const spawn = options.spawn ?? defaultSpawn;
  const { exitCode } = await spawn([process.execPath, "run", entry], {
    cwd,
    env: { ...process.env, BUNEST_REPL: "1" },
  });

  return {
    exitCode,
    command,
    entry,
  };
}
