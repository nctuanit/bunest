import { toArray } from "@bunest/core/common";
import { resolve } from "@bunest/core";
import { loadBunestConfig } from "../config/bunest-config.loader";
import { loadCliConfiguration } from "../config/configuration.loader";
import {
  generateBunestTypes,
  startTypegenWatcher,
  type TypegenConfiguration,
  type TypegenIncludeTarget,
  type TypegenResult,
} from "../typegen";
import type {
  CliIO,
  TypegenCommandOptions,
  TypegenCommandResult,
} from "../types";

export function resolveTypegenConfig(
  rawConfig: boolean | TypegenConfiguration | undefined,
): { enabled: boolean; config: TypegenConfiguration } {
  if (rawConfig === false) {
    return { enabled: false, config: {} };
  }
  if (rawConfig === true || rawConfig === undefined) {
    return { enabled: true, config: {} };
  }
  return {
    enabled: rawConfig.enabled !== false,
    config: rawConfig,
  };
}

export interface RunTypegenCommandOptions extends TypegenCommandOptions {
  readonly clientTypes?: string;
}

/**
 * Runs `bunest typegen` — scans the project with the Bunest native TypeScript AST engine
 * and emits `.bunest/types/bunest.d.ts` (one-shot, `--check` for CI, or `--watch`),
 * plus optional standalone frontend-portable client route types via `--client-types`.
 */
export async function runTypegenCommand(
  options: RunTypegenCommandOptions = {},
  io?: CliIO,
): Promise<TypegenCommandResult> {
  const cwd = resolve(options.cwd ?? io?.cwd ?? process.cwd());
  const { config: cliConfig } = await loadCliConfiguration(cwd, options.config);
  const { config: bunestConfig } = await loadBunestConfig(cwd);
  const { config: typegenCfg } = resolveTypegenConfig(cliConfig.typegen);
  const bunestTypegen = bunestConfig.typegen as
    | (typeof bunestConfig.typegen & { readonly clientTypes?: string })
    | undefined;

  const sourceRoot =
    options.sourceRoot ??
    bunestTypegen?.sourceRoot ??
    cliConfig.sourceRoot ??
    "src";
  const outDir =
    options.outdir ?? bunestTypegen?.outDir ?? typegenCfg.outDir ?? ".bunest/types";
  const fileName =
    options.fileName ??
    bunestTypegen?.fileName ??
    typegenCfg.fileName ??
    "bunest.d.ts";
  const clientTypes =
    options.clientTypes ??
    bunestTypegen?.clientTypes ??
    typegenCfg.clientTypes;
  const tsconfigPath =
    options.tsconfig ??
    bunestTypegen?.tsconfigPath ??
    typegenCfg.tsconfigPath ??
    cliConfig.compilerOptions?.tsConfigPath;
  const envFiles = options.envFile
    ? toArray(options.envFile)
    : (bunestTypegen?.envFiles ?? typegenCfg.envFiles);
  const include =
    (options.include as readonly TypegenIncludeTarget[] | undefined) ??
    bunestTypegen?.include ??
    typegenCfg.include;
  const includeGlobalNamespace =
    options.includeGlobalNamespace ??
    bunestTypegen?.includeGlobalNamespace ??
    typegenCfg.includeGlobalNamespace ??
    true;
  const plugins = typegenCfg.plugins;

  if (options.watch) {
    const watcher = await startTypegenWatcher(
      {
        cwd,
        sourceRoot,
        outDir,
        fileName,
        clientTypes,
        tsconfigPath,
        envFiles,
        include,
        includeGlobalNamespace,
        plugins,
        bunestConfig,
        debounceMs: options.debounceMs ?? typegenCfg.debounceMs,
        silent: options.silent,
      },
      io,
    );

    if (io && !options.silent) {
      io.stdout(`[typegen] Watching ${sourceRoot}/ for changes...`);
    }

    await new Promise<void>((resolveWait) => {
      const finish = () => {
        process.off("SIGINT", finish);
        process.off("SIGTERM", finish);
        options.signal?.removeEventListener("abort", finish);
        resolveWait();
      };
      if (options.signal?.aborted) {
        finish();
        return;
      }
      process.once("SIGINT", finish);
      process.once("SIGTERM", finish);
      options.signal?.addEventListener("abort", finish, { once: true });
    });

    await watcher.close();

    return {
      exitCode: 0,
      watch: true,
      result: watcher.initialResult,
    };
  }

  const result: TypegenResult = await generateBunestTypes(
    {
      cwd,
      sourceRoot,
      outDir,
      fileName,
      clientTypes,
      tsconfigPath,
      envFiles,
      include,
      includeGlobalNamespace,
      plugins,
      bunestConfig,
      dryRun: options.dryRun,
      check: options.check,
      silent: options.silent,
    },
    io,
  );

  const exitCode = options.check && !result.upToDate ? 1 : 0;

  return {
    exitCode,
    watch: false,
    result,
  };
}
