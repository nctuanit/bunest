import { resolve } from "@bunest/core";
import { loadCliConfiguration } from "../config/configuration.loader";
import type {
  CliIO,
  DeployProjectOptions,
  DeployProjectResult,
  SpawnFn,
} from "../types";
import { buildProject } from "./build";

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
 * Prepares or executes a production deployment (`bunest deploy`) using
 * `bunest.json` `deploy` config, `bun build --compile` single-executable output,
 * or a minified production bundle.
 */
export async function deployProject(
  options: DeployProjectOptions = {},
  io?: CliIO,
): Promise<DeployProjectResult> {
  const cwd = options.cwd ?? io?.cwd ?? process.cwd();
  const { config } = await loadCliConfiguration(cwd, options.config);
  const deployCfg = config.deploy;
  const outdir = resolve(cwd, options.outdir ?? deployCfg?.outdir ?? "dist");
  const dryRun = options.dryRun === true;
  const useCompile = options.compile ?? deployCfg?.compile ?? false;

  // 1. Custom deploy command configured in `bunest.json`
  if (deployCfg?.command && deployCfg.command.length > 0) {
    const cmd = [...deployCfg.command];
    if (dryRun) {
      if (io && !options.silent) {
        io.stdout(`[dry-run] Would execute deploy command: ${cmd.join(" ")}`);
      }
      return {
        success: true,
        dryRun: true,
        target: "custom",
        command: cmd,
        outdir,
        exitCode: 0,
      };
    }

    if (io && !options.silent) {
      io.stdout(`Running deploy command: ${cmd.join(" ")}`);
    }
    const spawn = options.spawn ?? defaultSpawn;
    const { exitCode } = await spawn(cmd, { cwd, env: Bun.env });
    return {
      success: exitCode === 0,
      dryRun: false,
      target: "custom",
      command: cmd,
      outdir,
      exitCode,
    };
  }

  // 2. Standalone compile or production bundle target
  if (dryRun) {
    const target = useCompile ? "compile" : "bundle";
    if (io && !options.silent) {
      io.stdout(
        `[dry-run] Would deploy Bunest app (mode=${target}, outdir=${outdir}).`,
      );
    }
    return {
      success: true,
      dryRun: true,
      target,
      outdir,
      exitCode: 0,
    };
  }

  const buildResult = await buildProject(
    {
      entry: options.entry,
      entryFile: options.entryFile ?? deployCfg?.entryFile,
      outdir,
      config: options.config,
      cwd,
      minify: true,
      compile: useCompile,
      silent: options.silent,
      spawn: options.spawn,
    },
    io,
  );

  if (io && !options.silent && buildResult.success) {
    io.stdout(
      `Deploy build ready in ${outdir} (${useCompile ? "standalone executable" : "production bundle"}).`,
    );
  }

  return {
    success: buildResult.success,
    dryRun: false,
    target: useCompile ? "compile" : "bundle",
    outdir,
    exitCode: buildResult.success ? 0 : 1,
  };
}
