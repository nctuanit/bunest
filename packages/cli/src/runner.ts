import { addLibrary } from "./commands/add";
import { buildProject } from "./commands/build";
import { deployProject } from "./commands/deploy";
import { runDevServer } from "./commands/dev";
import { generateSchematic } from "./commands/generate";
import { formatEnvironmentInfo, getEnvironmentInfo } from "./commands/info";
import { createProject } from "./commands/new";
import { runReplCommand } from "./commands/repl";
import { runStartCommand } from "./commands/start";
import { upgradeProject } from "./commands/upgrade";
import { parseCliArgs } from "./parser";
import type { CliFlagValue, CliIO, CliResult } from "./types";
import { CLI_VERSION } from "./version";

export const HELP_TEXT = `Bunest CLI v${CLI_VERSION}

Usage:
  bunest <command> [arguments] [options]

Commands:
  new <project-name>                Scaffold a new Bunest application
    --dir <path>                    Target directory (defaults to <project-name>)
    --strict / --no-strict          Enable strict TypeScript compiler options (default: true)
    -g, --skip-git                  Skip initializing a git repository
    --package-manager <pm>          Package manager: bun|npm|yarn|pnpm (default: bun)
    --skip-install                  Skip running dependency installation
    --dry-run                       Preview generated files without writing
    --force                         Overwrite existing files

  generate, g <schematic> <name>    Generate a Bunest schematic
    Schematics:
      application, class (cl), configuration (config), controller (co),
      decorator (d), dto, endpoint (ep), filter (f), gateway (ga),
      guard (gu), interceptor (itc, in), interface (itf), library (lib),
      middleware (mi), module (mo), pipe (pi), provider (pr),
      resolver (r), resource (res), service (s), sub-app (app)
    --dir <path>                    Base output directory (default: src)
    --sourceRoot <path>             Override source root directory
    -p, --project <name>            Target monorepo project from bunest.json
    --spec-file-suffix <suffix>     Custom test file suffix (default: spec)
    --flat                          Generate files without a nested folder
    --no-spec                       Skip generating .spec.ts test files
    --dry-run                       Preview generated files without writing
    --force                         Overwrite existing files

  start                             Run Bunest application
    -w, --watch                     Run in watch mode ("bun --watch")
    -d, --debug [hostport]          Enable Bun inspector ("bun --inspect")
    --entryFile, --entry <file>     Entrypoint file (default: src/main.ts)
    --sourceRoot <path>             Source root directory (default: src)
    -c, --config <path>             Path to bunest.json / nest-cli.json
    --env-file <path>               Load environment file (repeatable)
    --preserveWatchOutput           Keep terminal output across restarts
    --silent                        Suppress CLI banner output
    -e, --exec <binary>             Custom runtime executable

  dev                               Run development server via "bun --watch"
    --entry <file>                  Entrypoint file (default: src/main.ts)
    --port <n>                      Override PORT environment variable

  build                             Bundle application using Bun.build()
    --entryFile, --entry <file>     Entrypoint file (default: src/main.ts)
    --sourceRoot <path>             Source root directory
    --outdir <dir>                  Output directory (default: dist)
    -c, --config <path>             Path to bunest.json / nest-cli.json
    --target <bun|browser|node>     Build target (default: bun)
    --minify                        Minify output bundle
    --sourcemap [mode]              Emit sourcemap (linked|inline|external|none)
    --deleteOutDir                  Remove output directory before building
    --compile                       Compile standalone native executable
    -w, --watch                     Rebuild on file changes
    --silent                        Suppress build output logs

  add <library>                     Install a @bunest/* or ecosystem package
    -d, --dry-run                   Preview command without installing
    -s, --skip-install              Skip running package install
    -p, --project <name>            Target monorepo project

  upgrade, update                   Upgrade @bunest/* project dependencies
    -d, --dry-run                   Preview packages without upgrading
    -s, --skip-install              Skip running package update
    -t, --tag <tag>                 Target dist-tag (e.g. latest, next)

  deploy                            Build/compile or execute deploy hook
    -c, --config <path>             Path to bunest.json / nest-cli.json
    --compile                       Compile standalone native executable
    -d, --dry-run                   Preview deploy steps without executing

  repl                              Start interactive Bunest REPL
    --entry <file>                  REPL entrypoint file (default: src/repl.ts)

  info                              Display Bunest, Bun, OS, CPU, and RAM info

Global Options:
  -h, --help                        Show this help message
  -v, --version                     Show CLI version
`;

const defaultIO: CliIO = {
  stdout: (msg: string) => console.log(msg),
  stderr: (msg: string) => console.error(msg),
};

function getStringFlag(
  flags: Readonly<Record<string, CliFlagValue>>,
  key: string,
): string | undefined {
  const val = flags[key];
  return typeof val === "string" ? val : undefined;
}

function getStringArrayFlag(
  flags: Readonly<Record<string, CliFlagValue>>,
  key: string,
): string[] | undefined {
  const val = flags[key];
  if (typeof val === "string") return [val];
  if (Array.isArray(val)) return [...val];
  return undefined;
}

function getBoolFlag(
  flags: Readonly<Record<string, CliFlagValue>>,
  key: string,
): boolean | undefined {
  const val = flags[key];
  return typeof val === "boolean" ? val : undefined;
}

function parseOptionalPort(rawPort: string | undefined): number | undefined {
  if (rawPort === undefined) return undefined;
  if (!/^\d+$/.test(rawPort)) {
    throw new Error(
      `Invalid --port value "${rawPort}": expected a non-negative integer.`,
    );
  }
  return Number.parseInt(rawPort, 10);
}

/**
 * Programmatic CLI dispatcher executing all `bunest` commands without calling
 * `process.exit()`, enabling deterministic in-process testing.
 */
export async function runCli(
  argv: readonly string[],
  io: CliIO = defaultIO,
): Promise<CliResult> {
  try {
    const parsed = parseCliArgs(argv);
    const { command, positionals, flags } = parsed;

    if (flags.version === true && !command) {
      io.stdout(`v${CLI_VERSION}`);
      return { exitCode: 0, output: CLI_VERSION };
    }

    if (flags.help === true || !command || command === "help") {
      io.stdout(HELP_TEXT);
      return { exitCode: 0, output: HELP_TEXT };
    }

    switch (command) {
      case "new": {
        const projectName = positionals[0];
        if (!projectName) {
          io.stderr(
            'Missing required argument: <project-name>.\nUsage: bunest new <project-name> [--dir <path>] [--strict] [--skip-git] [--package-manager <pm>] [--skip-install] [--dry-run]',
          );
          return { exitCode: 1 };
        }
        const strictFlag = getBoolFlag(flags, "strict");
        const noStrictFlag = getBoolFlag(flags, "no-strict");
        const strict = noStrictFlag === true ? false : (strictFlag ?? true);

        const result = await createProject(
          {
            projectName,
            dir: getStringFlag(flags, "dir"),
            cwd: io.cwd,
            strict,
            skipGit: getBoolFlag(flags, "skip-git"),
            packageManager: getStringFlag(flags, "package-manager"),
            skipInstall: getBoolFlag(flags, "skip-install") ?? false,
            dryRun: getBoolFlag(flags, "dry-run") ?? false,
            force: getBoolFlag(flags, "force") ?? false,
          },
          io,
        );
        return { exitCode: 0, output: result };
      }

      case "generate":
      case "g": {
        const schematic = positionals[0];
        const rawName = positionals[1];
        const isConfigSchematic =
          schematic !== undefined &&
          ["config", "configuration"].includes(schematic.trim().toLowerCase());
        const name = rawName ?? (isConfigSchematic ? "bunest" : undefined);

        if (!schematic || !name) {
          io.stderr(
            'Missing required arguments: <schematic> <name>.\nUsage: bunest generate <schematic> <name> [--dir <path>] [--sourceRoot <path>] [--project <name>] [--spec-file-suffix <suffix>] [--flat] [--no-spec] [--dry-run] [--force]',
          );
          return { exitCode: 1 };
        }
        const specFlag = getBoolFlag(flags, "spec");
        const noSpecFlag = getBoolFlag(flags, "no-spec");
        const spec =
          noSpecFlag === true
            ? false
            : specFlag !== undefined
              ? specFlag
              : undefined;

        const result = await generateSchematic(
          {
            schematic,
            name,
            dir: getStringFlag(flags, "dir"),
            sourceRoot: getStringFlag(flags, "sourceRoot"),
            project: getStringFlag(flags, "project"),
            config: getStringFlag(flags, "config"),
            specFileSuffix: getStringFlag(flags, "spec-file-suffix"),
            cwd: io.cwd,
            flat: getBoolFlag(flags, "flat"),
            spec,
            dryRun: getBoolFlag(flags, "dry-run") ?? false,
            force: getBoolFlag(flags, "force") ?? false,
          },
          io,
        );
        return { exitCode: 0, output: result };
      }

      case "start": {
        const rawDebug = flags.debug;
        const debug =
          typeof rawDebug === "boolean" || typeof rawDebug === "string"
            ? rawDebug
            : undefined;
        const result = await runStartCommand(
          {
            entry: getStringFlag(flags, "entry"),
            entryFile: getStringFlag(flags, "entryFile"),
            sourceRoot: getStringFlag(flags, "sourceRoot"),
            config: getStringFlag(flags, "config"),
            path: getStringFlag(flags, "path"),
            watch: getBoolFlag(flags, "watch") ?? false,
            debug,
            envFile: getStringArrayFlag(flags, "env-file"),
            preserveWatchOutput:
              getBoolFlag(flags, "preserveWatchOutput") ?? false,
            silent: getBoolFlag(flags, "silent") ?? false,
            exec: getStringFlag(flags, "exec"),
            port: parseOptionalPort(getStringFlag(flags, "port")),
            cwd: io.cwd,
          },
          io,
        );
        return { exitCode: result.exitCode, output: result };
      }

      case "dev": {
        const port = parseOptionalPort(getStringFlag(flags, "port"));
        const result = await runDevServer(
          {
            entry: getStringFlag(flags, "entry"),
            port,
            cwd: io.cwd,
          },
          io,
        );
        return { exitCode: result.exitCode, output: result };
      }

      case "build": {
        const target = getStringFlag(flags, "target") as
          | "bun"
          | "browser"
          | "node"
          | undefined;
        const rawSourcemap = flags.sourcemap;
        const sourcemap =
          rawSourcemap === undefined
            ? undefined
            : (rawSourcemap as
                | "none"
                | "linked"
                | "inline"
                | "external"
                | boolean);

        const result = await buildProject(
          {
            entry: getStringFlag(flags, "entry"),
            entryFile: getStringFlag(flags, "entryFile"),
            sourceRoot: getStringFlag(flags, "sourceRoot"),
            outdir: getStringFlag(flags, "outdir"),
            config: getStringFlag(flags, "config"),
            path: getStringFlag(flags, "path"),
            cwd: io.cwd,
            target,
            minify: getBoolFlag(flags, "minify") ?? false,
            sourcemap,
            watch: getBoolFlag(flags, "watch") ?? false,
            watchAssets: getBoolFlag(flags, "watchAssets") ?? false,
            deleteOutDir: getBoolFlag(flags, "deleteOutDir"),
            emitDeclarations: getBoolFlag(flags, "emit-declarations") ?? false,
            compile: getBoolFlag(flags, "compile") ?? false,
            silent: getBoolFlag(flags, "silent") ?? false,
          },
          io,
        );
        return { exitCode: result.success ? 0 : 1, output: result };
      }

      case "add": {
        const library = positionals[0];
        if (!library) {
          io.stderr(
            'Missing required argument: <library>.\nUsage: bunest add <library> [--dry-run] [--skip-install] [--project <name>]',
          );
          return { exitCode: 1 };
        }
        const result = await addLibrary(
          {
            library,
            dryRun: getBoolFlag(flags, "dry-run") ?? false,
            skipInstall: getBoolFlag(flags, "skip-install") ?? false,
            project: getStringFlag(flags, "project"),
            cwd: io.cwd,
          },
          io,
        );
        return { exitCode: result.exitCode, output: result };
      }

      case "upgrade":
      case "update": {
        const result = await upgradeProject(
          {
            dryRun: getBoolFlag(flags, "dry-run") ?? false,
            skipInstall: getBoolFlag(flags, "skip-install") ?? false,
            tag: getStringFlag(flags, "tag"),
            observe: getBoolFlag(flags, "observe"),
            collection: getStringFlag(flags, "collection"),
            cwd: io.cwd,
          },
          io,
        );
        return { exitCode: result.exitCode, output: result };
      }

      case "deploy": {
        const result = await deployProject(
          {
            entry: getStringFlag(flags, "entry"),
            entryFile: getStringFlag(flags, "entryFile"),
            outdir: getStringFlag(flags, "outdir"),
            config: getStringFlag(flags, "config"),
            compile: getBoolFlag(flags, "compile"),
            dryRun: getBoolFlag(flags, "dry-run") ?? false,
            silent: getBoolFlag(flags, "silent") ?? false,
            cwd: io.cwd,
          },
          io,
        );
        return { exitCode: result.exitCode, output: result };
      }

      case "repl": {
        const result = await runReplCommand(
          {
            entry: getStringFlag(flags, "entry"),
            cwd: io.cwd,
          },
          io,
        );
        return { exitCode: result.exitCode, output: result };
      }

      case "info": {
        const info = getEnvironmentInfo();
        io.stdout(formatEnvironmentInfo(info));
        return { exitCode: 0, output: info };
      }

      default: {
        io.stderr(
          `Unknown command "${command}". Run "bunest --help" to see available commands.`,
        );
        return { exitCode: 1 };
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(`Error: ${message}`);
    return { exitCode: 1 };
  }
}
