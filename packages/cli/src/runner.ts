import { levenshteinDistance } from "./analyzer";
import { addLibrary } from "./commands/add";
import { buildProject } from "./commands/build";
import { runCheckCommand } from "./commands/check";
import { runCodemodCommand, runDelombokCommand } from "./commands/codemod";
import {
  runCronParseCommand,
  runCronRegisterCommand,
  runCronRemoveCommand,
  runCronRunCommand,
  type CronCommandOutputFormat,
} from "./commands/cron";
import { deployProject } from "./commands/deploy";
import { runDevServer } from "./commands/dev";
import {
  runExplainErrorCommand,
  runExplainRouteCommand,
  type ExplainErrorFormat,
  type ExplainRouteFormat,
} from "./commands/explain";
import { generateSchematic } from "./commands/generate";
import { generateRepositoryCommand } from "./commands/generate-repository";
import {
  runGraphCommand,
  type GraphOutputFormat,
} from "./commands/graph";
import {
  formatEnvironmentInfo,
  getEnvironmentInfo,
  type EnvironmentInfoFormat,
} from "./commands/info";
import { createProject } from "./commands/new";
import { runMcpServer } from "./commands/mcp";
import { runReplCommand } from "./commands/repl";
import {
  runRoutesDiffCommand,
  runRoutesSnapshotCommand,
  scanProjectRoutes,
  type RoutesDiffFormat,
} from "./commands/routes-diff";
import { runStartCommand } from "./commands/start";
import {
  runTestFromRequestCommand,
  type TestFromRequestOutputFormat,
} from "./commands/test-from-request";
import { runTypegenCommand } from "./commands/typegen";
import { upgradeProject } from "./commands/upgrade";
import { runVerifyCommand } from "./commands/verify";
import { parseCliArgs } from "./parser";
import type {
  CliFlagValue,
  CliIO,
  CliResult,
  ProjectPreset,
} from "./types";
import { CLI_VERSION } from "./version";

export const HELP_TEXT = `Bunest CLI v${CLI_VERSION}

Usage:
  bunest <command> [arguments] [options]

Commands:
  new <project-name>                Scaffold a new Bunest application
    --dir <path>                    Target directory (defaults to <project-name>)
    --preset <default|rest-sqlite>  Starter preset (default: default)
    --strict / --no-strict          Enable strict TypeScript compiler options (default: true)
    -g, --skip-git                  Skip initializing a git repository
    --package-manager <pm>          Package manager: bun|npm|yarn|pnpm (default: bun)
    --skip-install                  Skip running dependency installation
    --dry-run                       Preview generated files without writing
    --force                         Overwrite existing files

  generate, g <schematic> <name>    Generate a Bunest schematic
    Schematics:
      application, class (cl), configuration (config), controller (co),
      cron (cr), decorator (d), dto, endpoint (ep), filter (f), gateway (ga),
      guard (gu), interceptor (itc, in), interface (itf), library (lib),
      middleware (mi), module (mo), pipe (pi), provider (pr),
      resolver (r), resource (res), service (s), sub-app (app), worker (w)
    --dir <path>                    Base output directory (default: src)
    --sourceRoot <path>             Override source root directory
    -p, --project <name>            Target monorepo project from bunest.json
    --spec-file-suffix <suffix>     Custom test file suffix (default: spec)
    --flat                          Generate files without a nested folder
    --no-spec                       Skip generating .spec.ts test files
    --with-scenario                 Generate .http request scenarios & regression spec (for resource)
    --dry-run                       Preview generated files without writing
    --force                         Overwrite existing files

  start                             Run Bunest application
    -w, --watch                     Run in watch mode ("bun --watch" + live typegen)
    -d, --debug [hostport]          Enable Bun inspector ("bun --inspect")
    --entryFile, --entry <file>     Entrypoint file (default: src/main.ts)
    --sourceRoot <path>             Source root directory (default: src)
    -c, --config <path>             Path to bunest.json / nest-cli.json
    --env-file <path>               Load environment file (repeatable)
    --preserveWatchOutput           Keep terminal output across restarts
    --no-typegen                    Disable automatic global typegen in watch mode
    --typegen-dir <dir>             Output directory for generated types (default: .bunest/types)
    --silent                        Suppress CLI banner output
    -e, --exec <binary>             Custom runtime executable

  dev                               Run development server ("bun --watch") with live global typegen
    --entry <file>                  Entrypoint file (default: src/main.ts)
    --sourceRoot <path>             Source root directory (default: src)
    -c, --config <path>             Path to bunest.json / nest-cli.json
    --port <n>                      Override PORT environment variable
    --no-typegen                    Disable automatic global typegen watcher
    --typegen-dir <dir>             Output directory for generated types (default: .bunest/types)
    --silent                        Suppress CLI output

  typegen, tg                       Generate global DX type declarations (.bunest/types/bunest.d.ts)
    -w, --watch                     Watch source & .env files and regenerate incrementally
    --check                         Verify generated types are up-to-date (exits 1 if stale)
    -o, --outdir <dir>              Output directory (default: .bunest/types)
    --sourceRoot <path>             Source root directory (default: src)
    --tsconfig <path>               Explicit path to tsconfig.json
    -c, --config <path>             Path to bunest.json / nest-cli.json
    --env-file <path>               Env file(s) to scan for config keys (repeatable)
    -d, --dry-run                   Scan without writing files
    --client-types <path>           Emit standalone frontend-portable route types (no @bunest/core imports)
    --no-global                     Omit \`declare global { namespace Bunest }\` aliases
    --silent                        Suppress output logs

  graph                             Render static module/provider/controller DI graph offline
    --format <mermaid|dot|json|html> Output format (default: mermaid)
    --module <Name>                 Filter graph to a specific module and its dependencies
    --cycles-only                   Include only nodes and edges in circular dependencies
    --cwd <dir>                     Project root directory (default: current working directory)
    --sourceRoot <path>             Source root directory (default: src)
    --tsconfig <path>               Explicit path to tsconfig.json
    -c, --config <path>             Path to bunest.json / nest-cli.json

  check, doctor                     Run all Bunest static diagnostics (DI BUNEST001-011, Repositories, Class Macros)
    --fix                           Auto-apply safe AST fixes
    --format <pretty|json>          Output format (default: pretty)
    --strict                        Fail with exit code 1 on warnings as well as errors
    --sourceRoot <path>             Source root directory (default: src)
    --tsconfig <path>               Explicit path to tsconfig.json
    --dry-run                       Preview --fix changes without writing files

  verify [test-filter...]           Typecheck + static diagnostics + tests in one AI-friendly report
    --reporter <agent|pretty|json>  Output format (default: pretty; "agent" = compact, token-cheap)
    --affected                      Select and run only tests affected by changed files with explicit reasons
    --base <ref>                    Git base ref for --affected diff detection (e.g. origin/main, HEAD~1)
    --files <a,b>                   Comma-separated changed file paths for --affected
    --skip-typecheck                Skip "bun check"
    --skip-check                    Skip Bunest static diagnostics
    --skip-tests                    Skip "bun test"
    --require-tests                 Fail when no matching tests are executed
    --strict                        Treat diagnostic warnings as failures
    --max-issues <n>                Max issues printed per step (default: 20)
    --sourceRoot <path>             Source root directory (default: src)

  explain route "<METHOD /path>"    Trace a route's owning module, pipeline, DI graph, and quick fixes
    --format <pretty|json|agent>    Output format (default: pretty)
    --server-url <url>              Optional running dev server URL for runtime confirmation
    --version <ver>                 Optional route version filter (e.g. 1)
    --open                          Open the primary matched handler in your editor (Bun.openInEditor)
    --sourceRoot <path>             Source root directory (default: src)
    --tsconfig <path>               Explicit path to tsconfig.json
    -c, --config <path>             Path to bunest.json / nest-cli.json

  explain error <CODE>              Explain a BUNEST_E* error code with ordered fixes and docs link
    --format <pretty|json|agent|ansi> Output format (default: pretty; "ansi" renders terminal Markdown)

  routes [snapshot|diff]            List HTTP routes, snapshot manifests, or diff route & body contracts
    snapshot                        Emit a JSON route manifest (stdout or --out <file>)
      --out <file>                  Write route snapshot JSON to a file
      --body                        Include static @Body() DTO validation contracts
      --commit <sha>                Attach commit SHA metadata to the snapshot
    diff [<base> <head> | --base]   Diff two manifests or diff --base against current project
      --base <manifest>             Base route manifest JSON file (scans current project as head)
      --body                        Compare @Body() DTO validation constraints & breaking candidates
      --evidence <file.json>        Attach replay evidence JSON for verified HTTP status transitions
      --format <pretty|json>        Output format (default: pretty)
    --sourceRoot <path>             Source root directory (default: src)
    --tsconfig <path>               Explicit path to tsconfig.json
    -c, --config <path>             Path to bunest.json / nest-cli.json

  test-from-request <file>          Generate sanitized regression tests from a .http or scenario JSON file
    --out <file>                    Output test file path
    --assert-fields <a,b>           Comma-separated response fields to assert explicitly
    --format <pretty|diff|json>     Output format (default: pretty)
    --save-binary-fixture           Also write binary/stream response fixture file
    --dry-run                       Preview generated files without writing
    --force                         Overwrite existing files

  delombok, expand <target>         Expand Class Macro decorators (@Data/@Builder/@WithLogger/...) to explicit TS
    --decorator <Name>              Expand only one specific decorator
    --class <ClassName>             Target class name when file has multiple classes
    --dry-run                       Print expanded result without writing

  codemod <action> <file>           Run surgical AST codemods
    Actions: derived-to-query | collapse-logger | sync-di | add-provider
    --method <name>                 Target method name (for derived-to-query)
    --class <name>                  Target class name
    --module <name>                 Target @Module class (for add-provider)
    --symbol <name>                 Provider/Controller symbol (for add-provider)
    --kind <providers|controllers|exports|imports>
    --from <specifier>              Import specifier (for add-provider)
    --dry-run                       Preview without writing

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
    --bytecode                      Emit bytecode snapshot for faster cold start (with --compile)
    --archive [path]                Pack build output into a .tar.gz archive via Bun.Archive
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
    --bytecode                      Emit bytecode snapshot for faster cold start
    --archive [path]                Pack deploy build output into a .tar.gz archive via Bun.Archive
    -d, --dry-run                   Preview deploy steps without executing

  repl                              Start interactive Bunest REPL
    --entry <file>                  REPL entrypoint file (default: src/repl.ts)

  cron <parse|register|remove|run>  Manage and preview Bun-native cron schedules & OS cron jobs
    parse "<expr>"                  Preview next fire times via Bun.cron.parse()
      --tz <IANA>                   IANA time zone (e.g. UTC, Asia/Ho_Chi_Minh)
      --from <ISO|ms>               Starting timestamp (default: now)
      --count <n>                   Number of upcoming occurrences (default: 5)
      --format <pretty|json>        Output format (default: pretty)
    register <file> "<expr>" <title> Register persistent OS-level cron job (crontab/launchd/Task Scheduler)
      --dry-run                     Validate without registering with the OS scheduler
      --format <pretty|json>        Output format (default: pretty)
    remove <title>                  Remove an OS-level cron job via Bun.cron.remove()
      --dry-run                     Validate without removing from the OS scheduler
      --format <pretty|json>        Output format (default: pretty)
    run <file>                      Invoke a cron module's default.scheduled(controller) locally
      --schedule "<expr>"           Cron expression passed to controller.cron (default: "* * * * *")
      --time <ISO|ms>               Scheduled timestamp passed to controller.scheduledTime
      --format <pretty|json>        Output format (default: pretty)

  mcp                               Start stdio MCP server for AI coding agents (verify, errors, routes, DI)
    --trace-file <path>             Path to runtime error JSONL file (default: .bunest/errors.jsonl)
    --server-url <url>              Running dev server URL (e.g. http://127.0.0.1:3000)

  info                              Display Bunest, Bun, OS, CPU, RAM, and resolved package info
    --format <pretty|json|table>    Output format (default: pretty; "table" uses Bun.inspect.table)

Global Options:
  -h, --help                        Show this help message
  -v, --version                     Show CLI version
`;

const KNOWN_TOP_LEVEL_COMMANDS = [
  "new",
  "generate",
  "g",
  "start",
  "dev",
  "typegen",
  "tg",
  "graph",
  "check",
  "doctor",
  "verify",
  "explain",
  "routes",
  "test-from-request",
  "delombok",
  "expand",
  "codemod",
  "build",
  "add",
  "upgrade",
  "update",
  "deploy",
  "repl",
  "cron",
  "mcp",
  "info",
  "help",
] as const;

function suggestClosestCommand(unknown: string): string | undefined {
  const normalized = unknown.trim().toLowerCase();
  if (!normalized) return undefined;

  let bestDistance = Number.POSITIVE_INFINITY;
  let bestMatches: string[] = [];

  for (const candidate of KNOWN_TOP_LEVEL_COMMANDS) {
    const dist = levenshteinDistance(normalized, candidate);
    if (dist < bestDistance) {
      bestDistance = dist;
      bestMatches = [candidate];
    } else if (dist === bestDistance) {
      bestMatches.push(candidate);
    }
  }

  if (
    bestDistance > 0 &&
    bestDistance <= 2 &&
    bestDistance < normalized.length &&
    bestMatches.length === 1
  ) {
    return bestMatches[0];
  }
  return undefined;
}

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

function extractRawFlagValue(
  argv: readonly string[],
  flagName: string,
): string | undefined {
  const longForm = `--${flagName}`;
  const prefix = `${longForm}=`;
  let found: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === "--") break;
    if (token.startsWith(prefix)) {
      found = token.slice(prefix.length);
    } else if (token === longForm) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        found = next;
        i += 1;
      } else {
        found = "";
      }
    }
  }
  return found;
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
            "Missing required argument: <project-name>.\nUsage: bunest new <project-name> [--dir <path>] [--preset <default|rest-sqlite>] [--strict] [--skip-git] [--package-manager <pm>] [--skip-install] [--dry-run]",
          );
          return { exitCode: 1 };
        }
        const rawPreset = getStringFlag(flags, "preset");
        if (
          rawPreset !== undefined &&
          rawPreset !== "default" &&
          rawPreset !== "rest-sqlite"
        ) {
          io.stderr(
            `Invalid --preset "${rawPreset}". Expected one of: default, rest-sqlite.`,
          );
          return { exitCode: 1 };
        }
        const preset: ProjectPreset | undefined = rawPreset;
        const strictFlag = getBoolFlag(flags, "strict");
        const noStrictFlag = getBoolFlag(flags, "no-strict");
        const strict = noStrictFlag === true ? false : (strictFlag ?? true);

        const result = await createProject(
          {
            projectName,
            dir: getStringFlag(flags, "dir") ?? getStringFlag(flags, "directory"),
            cwd: io.cwd,
            preset,
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

        if (
          schematic &&
          ["repository", "repo"].includes(schematic.trim().toLowerCase())
        ) {
          if (!rawName) {
            io.stderr(
              "Missing required argument: <EntityNameOrFile>.\nUsage: bunest generate repository <EntityName> [--dialect sqlite|postgres|mysql] [--dir <path>] [--dry-run] [--force]",
            );
            return { exitCode: 1 };
          }
          const dialectRaw = getStringFlag(flags, "dialect");
          const dialect =
            dialectRaw === "postgres" ||
            dialectRaw === "mysql" ||
            dialectRaw === "sqlite"
              ? dialectRaw
              : "sqlite";
          const result = await generateRepositoryCommand(
            {
              target: rawName,
              dialect,
              dir: getStringFlag(flags, "dir"),
              sourceRoot: getStringFlag(flags, "sourceRoot"),
              config: getStringFlag(flags, "config"),
              cwd: io.cwd,
              dryRun: getBoolFlag(flags, "dry-run") ?? false,
              force: getBoolFlag(flags, "force") ?? false,
            },
            io,
          );
          return { exitCode: 0, output: result };
        }

        const isConfigSchematic =
          schematic !== undefined &&
          ["config", "configuration"].includes(schematic.trim().toLowerCase());
        const baseName = rawName ?? (isConfigSchematic ? "bunest" : undefined);
        const extraPath = positionals[2]?.trim();
        const name =
          baseName && extraPath
            ? `${extraPath.replace(/\/+$/, "")}/${baseName}`
            : baseName;

        if (!schematic || !name) {
          io.stderr(
            "Missing required arguments: <schematic> <name>.\nUsage: bunest generate <schematic> <name> [--dir <path>] [--sourceRoot <path>] [--project <name>] [--spec-file-suffix <suffix>] [--flat] [--no-spec] [--dry-run] [--force]",
          );
          return { exitCode: 1 };
        }
        const specFlag = getBoolFlag(flags, "spec");
        const noSpecFlag = getBoolFlag(flags, "no-spec");
        const spec = noSpecFlag === true ? false : specFlag;
        const flatFlag = getBoolFlag(flags, "flat");
        const noFlatFlag = getBoolFlag(flags, "no-flat");
        const flat = noFlatFlag === true ? false : flatFlag;

        const crudFlag = getBoolFlag(flags, "crud");
        const noCrudFlag = getBoolFlag(flags, "no-crud");
        const crud = noCrudFlag === true ? false : crudFlag;
        const rawType = getStringFlag(flags, "type");
        const resourceType =
          rawType === "rest" ||
          rawType === "microservice" ||
          rawType === "ws" ||
          rawType === "graphql-code-first" ||
          rawType === "graphql-schema-first"
            ? rawType
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
            language: getStringFlag(flags, "language"),
            collection: getStringFlag(flags, "collection"),
            type: resourceType,
            crud,
            rootDir: getStringFlag(flags, "root-dir"),
            prefix: getStringFlag(flags, "prefix"),
            skipImport: getBoolFlag(flags, "skip-import"),
            module: getStringFlag(flags, "module"),
            cwd: io.cwd,
            flat,
            spec,
            withScenario: getBoolFlag(flags, "with-scenario") ?? false,
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
        const noTypegen = getBoolFlag(flags, "no-typegen");
        const typegenFlag = getBoolFlag(flags, "typegen");
        const typegen = noTypegen === true ? false : typegenFlag;
        const result = await runStartCommand(
          {
            entry: getStringFlag(flags, "entry"),
            entryFile: getStringFlag(flags, "entryFile"),
            sourceRoot: getStringFlag(flags, "sourceRoot"),
            project: getStringFlag(flags, "project") ?? positionals[0],
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
            typegen,
            typegenOutDir: getStringFlag(flags, "typegen-dir"),
            cwd: io.cwd,
          },
          io,
        );
        return { exitCode: result.exitCode, output: result };
      }

      case "dev": {
        const port = parseOptionalPort(getStringFlag(flags, "port"));
        const noTypegen = getBoolFlag(flags, "no-typegen");
        const typegenFlag = getBoolFlag(flags, "typegen");
        const typegen = noTypegen === true ? false : typegenFlag;
        const result = await runDevServer(
          {
            entry: getStringFlag(flags, "entry"),
            sourceRoot: getStringFlag(flags, "sourceRoot"),
            config: getStringFlag(flags, "config"),
            port,
            typegen,
            typegenOutDir: getStringFlag(flags, "typegen-dir"),
            clientTypes: getStringFlag(flags, "client-types"),
            silent: getBoolFlag(flags, "silent") ?? false,
            cwd: io.cwd,
          },
          io,
        );
        return { exitCode: result.exitCode, output: result };
      }

      case "typegen":
      case "tg": {
        const noGlobal = getBoolFlag(flags, "no-global");
        const typegenOptions: Parameters<typeof runTypegenCommand>[0] & {
          readonly clientTypes?: string;
        } = {
          cwd: io.cwd,
          sourceRoot: getStringFlag(flags, "sourceRoot"),
          outdir:
            getStringFlag(flags, "outdir") ??
            getStringFlag(flags, "typegen-dir"),
          tsconfig: getStringFlag(flags, "tsconfig"),
          config: getStringFlag(flags, "config"),
          envFile: getStringArrayFlag(flags, "env-file"),
          watch: getBoolFlag(flags, "watch") ?? false,
          check: getBoolFlag(flags, "check") ?? false,
          dryRun: getBoolFlag(flags, "dry-run") ?? false,
          includeGlobalNamespace: noGlobal === true ? false : undefined,
          clientTypes: getStringFlag(flags, "client-types"),
          silent: getBoolFlag(flags, "silent") ?? false,
        };
        const result = await runTypegenCommand(typegenOptions, io);
        return { exitCode: result.exitCode, output: result };
      }

      case "graph": {
        let fmtRaw = getStringFlag(flags, "format");
        if (fmtRaw === undefined && flags.format === true) {
          const rawFromArgv = extractRawFlagValue(argv, "format");
          if (rawFromArgv === "") {
            io.stderr(
              'Flag "--format" requires a value. Expected one of: mermaid, dot, json, html.',
            );
            return { exitCode: 1 };
          }
          fmtRaw = rawFromArgv;
        }
        if (
          fmtRaw !== undefined &&
          fmtRaw !== "mermaid" &&
          fmtRaw !== "dot" &&
          fmtRaw !== "json" &&
          fmtRaw !== "html"
        ) {
          io.stderr(
            `Invalid --format "${fmtRaw}". Expected one of: mermaid, dot, json, html.`,
          );
          return { exitCode: 1 };
        }
        if (flags.cwd === true) {
          io.stderr('Flag "--cwd" requires a directory path.');
          return { exitCode: 1 };
        }
        const format: GraphOutputFormat = fmtRaw ?? "mermaid";
        const result = await runGraphCommand(
          {
            cwd: getStringFlag(flags, "cwd") ?? io.cwd,
            sourceRoot: getStringFlag(flags, "sourceRoot"),
            tsconfig: getStringFlag(flags, "tsconfig"),
            config: getStringFlag(flags, "config"),
            format,
            module: getStringFlag(flags, "module"),
            cyclesOnly: getBoolFlag(flags, "cycles-only") ?? false,
            silent: getBoolFlag(flags, "silent") ?? false,
          },
          io,
        );
        return { exitCode: result.exitCode, output: result };
      }

      case "check":
      case "doctor": {
        const fmt = getStringFlag(flags, "format");
        const result = await runCheckCommand(
          {
            cwd: io.cwd,
            sourceRoot: getStringFlag(flags, "sourceRoot"),
            tsconfig: getStringFlag(flags, "tsconfig"),
            config: getStringFlag(flags, "config"),
            format: fmt === "json" ? "json" : "pretty",
            strict: getBoolFlag(flags, "strict") ?? false,
            fix: getBoolFlag(flags, "fix") ?? false,
            dryRun: getBoolFlag(flags, "dry-run") ?? false,
            silent: getBoolFlag(flags, "silent") ?? false,
          },
          io,
        );
        return { exitCode: result.exitCode, output: result };
      }

      case "verify": {
        const reporterRaw = getStringFlag(flags, "reporter");
        if (
          reporterRaw !== undefined &&
          reporterRaw !== "agent" &&
          reporterRaw !== "pretty" &&
          reporterRaw !== "json"
        ) {
          io.stderr(
            `Invalid --reporter "${reporterRaw}". Expected one of: agent, pretty, json.`,
          );
          return { exitCode: 1 };
        }
        const maxIssuesRaw = getStringFlag(flags, "max-issues");
        const maxIssues =
          maxIssuesRaw !== undefined && /^\d+$/.test(maxIssuesRaw)
            ? Number.parseInt(maxIssuesRaw, 10)
            : undefined;
        const filesRaw = getStringFlag(flags, "files");
        const files = filesRaw
          ? filesRaw
              .split(",")
              .map((file) => file.trim())
              .filter((file) => file.length > 0)
          : undefined;
        const result = await runVerifyCommand(
          {
            cwd: io.cwd,
            reporter: reporterRaw,
            skipTypecheck: getBoolFlag(flags, "skip-typecheck") ?? false,
            skipCheck: getBoolFlag(flags, "skip-check") ?? false,
            skipTests: getBoolFlag(flags, "skip-tests") ?? false,
            requireTests: getBoolFlag(flags, "require-tests") ?? false,
            strict: getBoolFlag(flags, "strict") ?? false,
            affected: getBoolFlag(flags, "affected") ?? false,
            base: getStringFlag(flags, "base"),
            files,
            testFilter: positionals.length > 0 ? positionals : undefined,
            sourceRoot: getStringFlag(flags, "sourceRoot"),
            config: getStringFlag(flags, "config"),
            maxIssues,
          },
          io,
        );
        return { exitCode: result.exitCode, output: result };
      }

      case "explain": {
        const subcommand = positionals[0];
        if (subcommand === "error") {
          const code = positionals[1] ?? "";
          const fmtRaw = getStringFlag(flags, "format");
          if (
            fmtRaw !== undefined &&
            fmtRaw !== "pretty" &&
            fmtRaw !== "json" &&
            fmtRaw !== "agent" &&
            fmtRaw !== "ansi"
          ) {
            io.stderr(
              `Invalid --format "${fmtRaw}". Expected one of: pretty, json, agent, ansi.`,
            );
            return { exitCode: 1 };
          }
          const format: ExplainErrorFormat | undefined = fmtRaw;
          const result = await runExplainErrorCommand(
            {
              code,
              format,
              silent: getBoolFlag(flags, "silent") ?? false,
            },
            io,
          );
          return { exitCode: result.exitCode, output: result };
        }
        if (subcommand !== "route") {
          io.stderr(
            'Missing or unknown explain subcommand.\nUsage:\n  bunest explain route "<METHOD /path>" [--format pretty|json|agent] [--open] [--server-url <url>] [--sourceRoot <dir>] [--tsconfig <path>] [--config <path>] [--version <ver>]\n  bunest explain error <CODE> [--format pretty|json|agent|ansi]',
          );
          return { exitCode: 1 };
        }
        const route = positionals.slice(1).join(" ").trim();
        if (!route) {
          io.stderr(
            'Missing required argument: "<METHOD /path>".\nUsage: bunest explain route "<METHOD /path>" [--format pretty|json|agent] [--open] [--server-url <url>] [--sourceRoot <dir>] [--tsconfig <path>] [--config <path>] [--version <ver>]',
          );
          return { exitCode: 1 };
        }
        const fmtRaw = getStringFlag(flags, "format");
        if (
          fmtRaw !== undefined &&
          fmtRaw !== "pretty" &&
          fmtRaw !== "json" &&
          fmtRaw !== "agent"
        ) {
          io.stderr(
            `Invalid --format "${fmtRaw}". Expected one of: pretty, json, agent.`,
          );
          return { exitCode: 1 };
        }
        const format: ExplainRouteFormat | undefined = fmtRaw;
        const result = await runExplainRouteCommand(
          {
            route,
            cwd: io.cwd,
            sourceRoot: getStringFlag(flags, "sourceRoot"),
            tsconfig: getStringFlag(flags, "tsconfig"),
            config: getStringFlag(flags, "config"),
            serverUrl: getStringFlag(flags, "server-url"),
            version: getStringFlag(flags, "version"),
            format,
            open: getBoolFlag(flags, "open") ?? false,
            silent: getBoolFlag(flags, "silent") ?? false,
          },
          io,
        );
        return { exitCode: result.exitCode, output: result };
      }

      case "routes": {
        const subcommand = positionals[0];
        const fmtRaw = getStringFlag(flags, "format");
        if (fmtRaw !== undefined && fmtRaw !== "pretty" && fmtRaw !== "json") {
          io.stderr(
            `Invalid --format "${fmtRaw}". Expected one of: pretty, json.`,
          );
          return { exitCode: 1 };
        }
        const format: RoutesDiffFormat = fmtRaw ?? "pretty";

        if (subcommand === "snapshot") {
          const result = await runRoutesSnapshotCommand(
            {
              cwd: io.cwd,
              out: getStringFlag(flags, "out"),
              body: getBoolFlag(flags, "body") ?? false,
              commit: getStringFlag(flags, "commit"),
              sourceRoot: getStringFlag(flags, "sourceRoot"),
              tsconfig: getStringFlag(flags, "tsconfig"),
              config: getStringFlag(flags, "config"),
              silent: getBoolFlag(flags, "silent") ?? false,
            },
            io,
          );
          return { exitCode: result.exitCode, output: result };
        }

        if (subcommand === "diff") {
          const baseFlag = getStringFlag(flags, "base");
          const base = baseFlag ?? positionals[1];
          const head = baseFlag ? positionals[1] : positionals[2];
          if (!base) {
            io.stderr(
              "Missing base route manifest.\nUsage:\n  bunest routes diff <base.json> <head.json> [--body] [--evidence <file.json>] [--format pretty|json]\n  bunest routes diff --base <manifest> [--body] [--evidence <file.json>] [--format pretty|json] [--sourceRoot <dir>]",
            );
            return { exitCode: 1 };
          }
          const result = await runRoutesDiffCommand(
            {
              base,
              head,
              body: getBoolFlag(flags, "body") ?? false,
              evidence: getStringFlag(flags, "evidence"),
              cwd: io.cwd,
              sourceRoot: getStringFlag(flags, "sourceRoot"),
              tsconfig: getStringFlag(flags, "tsconfig"),
              config: getStringFlag(flags, "config"),
              format,
              silent: getBoolFlag(flags, "silent") ?? false,
            },
            io,
          );
          return { exitCode: result.exitCode, output: result };
        }

        if (subcommand !== undefined) {
          io.stderr(
            `Unknown routes subcommand "${subcommand}".\nUsage:\n  bunest routes [--format pretty|json] [--sourceRoot <dir>]\n  bunest routes snapshot [--out <file>] [--body] [--commit <sha>] [--sourceRoot <dir>]\n  bunest routes diff [<base.json> <head.json> | --base <manifest>] [--body] [--evidence <file.json>] [--format pretty|json]`,
          );
          return { exitCode: 1 };
        }

        const scanned = await scanProjectRoutes({
          cwd: io.cwd,
          sourceRoot: getStringFlag(flags, "sourceRoot"),
          tsconfig: getStringFlag(flags, "tsconfig"),
          config: getStringFlag(flags, "config"),
        });
        let formatted: string;
        if (format === "json") {
          formatted = JSON.stringify(scanned, null, 2);
        } else if (scanned.routes.length === 0) {
          formatted = "No HTTP routes found.";
        } else {
          formatted = scanned.routes
            .map(
              (r) =>
                `${r.method.padEnd(7)} ${r.path}${r.version ? ` (v${r.version})` : ""}`,
            )
            .join("\n");
        }
        if (!getBoolFlag(flags, "silent")) {
          io.stdout(formatted);
        }
        return { exitCode: 0, output: scanned };
      }

      case "test-from-request": {
        const inputPath = positionals[0];
        if (!inputPath) {
          io.stderr(
            "Missing required argument: <scenario.json|file.http>.\nUsage: bunest test-from-request <scenario.json|file.http> [--dry-run] [--format pretty|diff|json] [--out <file>] [--assert-fields a,b] [--save-binary-fixture] [--force]",
          );
          return { exitCode: 1 };
        }
        const fmtRaw = getStringFlag(flags, "format");
        if (
          fmtRaw !== undefined &&
          fmtRaw !== "pretty" &&
          fmtRaw !== "diff" &&
          fmtRaw !== "json"
        ) {
          io.stderr(
            `Invalid --format "${fmtRaw}". Expected one of: pretty, diff, json.`,
          );
          return { exitCode: 1 };
        }
        const format: TestFromRequestOutputFormat | undefined = fmtRaw;
        const assertFieldsRaw = getStringFlag(flags, "assert-fields");
        const assertFields = assertFieldsRaw
          ? assertFieldsRaw
              .split(",")
              .map((field) => field.trim())
              .filter((field) => field.length > 0)
          : undefined;
        const result = await runTestFromRequestCommand(
          {
            inputPath,
            cwd: io.cwd,
            dryRun: getBoolFlag(flags, "dry-run") ?? false,
            force: getBoolFlag(flags, "force") ?? false,
            format,
            out: getStringFlag(flags, "out"),
            assertFields,
            saveBinaryFixture:
              getBoolFlag(flags, "save-binary-fixture") ?? false,
          },
          io,
        );
        return { exitCode: result.exitCode, output: result };
      }

      case "delombok":
      case "expand": {
        const target = positionals[0];
        if (!target) {
          io.stderr(
            "Missing required argument: <fileOrClass>.\nUsage: bunest delombok <fileOrClass> [--decorator <Name>] [--class <ClassName>] [--dry-run]",
          );
          return { exitCode: 1 };
        }
        const result = await runDelombokCommand(
          {
            target,
            decorator: getStringFlag(flags, "decorator"),
            className: getStringFlag(flags, "class"),
            sourceRoot: getStringFlag(flags, "sourceRoot"),
            tsconfig: getStringFlag(flags, "tsconfig"),
            config: getStringFlag(flags, "config"),
            cwd: io.cwd,
            dryRun: getBoolFlag(flags, "dry-run") ?? false,
            silent: getBoolFlag(flags, "silent") ?? false,
          },
          io,
        );
        return { exitCode: result.exitCode, output: result };
      }

      case "codemod": {
        const action = positionals[0];
        const targetFile = positionals[1];
        if (!action || !targetFile) {
          io.stderr(
            "Missing required arguments: <action> <file>.\nUsage: bunest codemod <derived-to-query|collapse-logger|sync-di|add-provider> <file> [--dry-run]",
          );
          return { exitCode: 1 };
        }
        const kindRaw = getStringFlag(flags, "kind");
        const arrayProperty =
          kindRaw === "controllers" ||
          kindRaw === "exports" ||
          kindRaw === "imports"
            ? kindRaw
            : "providers";
        const result = await runCodemodCommand(
          {
            action,
            targetFile,
            className: getStringFlag(flags, "class"),
            methodName: getStringFlag(flags, "method"),
            moduleName: getStringFlag(flags, "module"),
            symbolName: getStringFlag(flags, "symbol"),
            arrayProperty,
            importSpecifier: getStringFlag(flags, "from"),
            sourceRoot: getStringFlag(flags, "sourceRoot"),
            tsconfig: getStringFlag(flags, "tsconfig"),
            config: getStringFlag(flags, "config"),
            cwd: io.cwd,
            dryRun: getBoolFlag(flags, "dry-run") ?? false,
            silent: getBoolFlag(flags, "silent") ?? false,
          },
          io,
        );
        return { exitCode: result.exitCode, output: result };
      }

      case "build": {
        const target = getStringFlag(flags, "target") as
          "bun" | "browser" | "node" | undefined;
        const rawSourcemap = flags.sourcemap;
        const sourcemap =
          rawSourcemap === undefined
            ? undefined
            : (rawSourcemap as
                "none" | "linked" | "inline" | "external" | boolean);

        const result = await buildProject(
          {
            entry: getStringFlag(flags, "entry"),
            entryFile: getStringFlag(flags, "entryFile"),
            sourceRoot: getStringFlag(flags, "sourceRoot"),
            project: getStringFlag(flags, "project") ?? positionals[0],
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
            bytecode: getBoolFlag(flags, "bytecode") ?? false,
            archive:
              getStringFlag(flags, "archive") ??
              (getBoolFlag(flags, "archive") === true ? true : undefined),
            workers: getStringArrayFlag(flags, "worker"),
            autoDiscoverWorkers:
              getBoolFlag(flags, "no-workers") === true ? false : undefined,
            crons: getStringArrayFlag(flags, "cron"),
            autoDiscoverCrons:
              getBoolFlag(flags, "no-crons") === true ? false : undefined,
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
            "Missing required argument: <library>.\nUsage: bunest add <library> [--dry-run] [--skip-install] [--project <name>]",
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
            bytecode: getBoolFlag(flags, "bytecode") ?? false,
            archive:
              getStringFlag(flags, "archive") ??
              (getBoolFlag(flags, "archive") === true ? true : undefined),
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

      case "cron": {
        const subcommand = positionals[0];
        const fmtRaw = getStringFlag(flags, "format");
        if (fmtRaw !== undefined && fmtRaw !== "pretty" && fmtRaw !== "json") {
          io.stderr(
            `Invalid --format "${fmtRaw}". Expected one of: pretty, json.`,
          );
          return { exitCode: 1 };
        }
        const format: CronCommandOutputFormat = fmtRaw ?? "pretty";
        const silent = getBoolFlag(flags, "silent") ?? false;

        if (subcommand === "parse") {
          const expression = positionals[1];
          if (!expression) {
            io.stderr(
              'Missing required argument: "<expression>".\nUsage: bunest cron parse "<expression>" [--tz <IANA>] [--from <ISO|ms>] [--count <n>] [--format pretty|json]',
            );
            return { exitCode: 1 };
          }
          const rawCount = getStringFlag(flags, "count");
          let count: number | undefined;
          if (rawCount !== undefined) {
            if (!/^\d+$/.test(rawCount)) {
              io.stderr(
                `Invalid --count value "${rawCount}": expected a positive integer.`,
              );
              return { exitCode: 1 };
            }
            count = Number.parseInt(rawCount, 10);
          }
          const result = await runCronParseCommand(
            {
              expression,
              tz: getStringFlag(flags, "tz"),
              from: getStringFlag(flags, "from"),
              count,
              format,
              silent,
            },
            io,
          );
          return { exitCode: result.exitCode, output: result };
        }

        if (subcommand === "register") {
          const file = positionals[1];
          const schedule = positionals[2];
          const title = positionals[3];
          if (!file || !schedule || !title) {
            io.stderr(
              'Missing required arguments: <file> "<schedule>" <title>.\nUsage: bunest cron register <file> "<schedule>" <title> [--dry-run] [--format pretty|json]',
            );
            return { exitCode: 1 };
          }
          const result = await runCronRegisterCommand(
            {
              file,
              schedule,
              title,
              cwd: io.cwd,
              dryRun: getBoolFlag(flags, "dry-run") ?? false,
              format,
              silent,
            },
            io,
          );
          return { exitCode: result.exitCode, output: result };
        }

        if (subcommand === "remove") {
          const title = positionals[1];
          if (!title) {
            io.stderr(
              "Missing required argument: <title>.\nUsage: bunest cron remove <title> [--dry-run] [--format pretty|json]",
            );
            return { exitCode: 1 };
          }
          const result = await runCronRemoveCommand(
            {
              title,
              dryRun: getBoolFlag(flags, "dry-run") ?? false,
              format,
              silent,
            },
            io,
          );
          return { exitCode: result.exitCode, output: result };
        }

        if (subcommand === "run") {
          const file = positionals[1];
          if (!file) {
            io.stderr(
              'Missing required argument: <file>.\nUsage: bunest cron run <file> [--schedule "<expr>"] [--time <ISO|ms>] [--format pretty|json]',
            );
            return { exitCode: 1 };
          }
          const result = await runCronRunCommand(
            {
              file,
              schedule: getStringFlag(flags, "schedule"),
              scheduledTime: getStringFlag(flags, "time"),
              cwd: io.cwd,
              format,
              silent,
            },
            io,
          );
          return { exitCode: result.exitCode, output: result };
        }

        io.stderr(
          `Missing or unknown cron subcommand${subcommand ? ` "${subcommand}"` : ""}.\nUsage:\n  bunest cron parse "<expression>" [--tz <IANA>] [--from <ISO|ms>] [--count <n>] [--format pretty|json]\n  bunest cron register <file> "<schedule>" <title> [--dry-run] [--format pretty|json]\n  bunest cron remove <title> [--dry-run] [--format pretty|json]\n  bunest cron run <file> [--schedule "<expr>"] [--time <ISO|ms>] [--format pretty|json]`,
        );
        return { exitCode: 1 };
      }

      case "mcp": {
        const result = await runMcpServer(
          {
            cwd: io.cwd,
            traceFile: getStringFlag(flags, "trace-file"),
            serverUrl: getStringFlag(flags, "server-url"),
          },
          io,
        );
        return { exitCode: result.exitCode };
      }

      case "info": {
        const fmtRaw = getStringFlag(flags, "format");
        if (
          fmtRaw !== undefined &&
          fmtRaw !== "pretty" &&
          fmtRaw !== "json" &&
          fmtRaw !== "table"
        ) {
          io.stderr(
            `Invalid --format "${fmtRaw}". Expected one of: pretty, json, table.`,
          );
          return { exitCode: 1 };
        }
        const format: EnvironmentInfoFormat | undefined = fmtRaw;
        const info = getEnvironmentInfo(io.cwd ?? process.cwd());
        io.stdout(formatEnvironmentInfo(info, format ? { format } : undefined));
        return { exitCode: 0, output: info };
      }

      default: {
        const suggestion = suggestClosestCommand(command);
        if (suggestion) {
          io.stderr(
            `Unknown command "${command}". Did you mean "bunest ${suggestion}"?`,
          );
        } else {
          io.stderr(
            `Unknown command "${command}". Run "bunest --help" to see available commands.`,
          );
        }
        return { exitCode: 1 };
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(`Error: ${message}`);
    return { exitCode: 1 };
  }
}
