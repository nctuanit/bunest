import { existsSyncPath, relative, resolve, statPath } from "@bunest/core";
import {
  loadCliConfiguration,
  resolveEntryFile,
} from "../config/configuration.loader";
import { startTypegenWatcher, type ExtractedRouteEntry } from "../typegen";
import type {
  CliIO,
  DevServerOptions,
  DevServerResult,
  SpawnFn,
} from "../types";
import { resolveTypegenConfig } from "./typegen";

export interface ResolvedDevPort {
  readonly port: number;
  readonly preferredPort: number;
  readonly fellBack: boolean;
}

/**
 * Probes `preferredPort` on loopback and falls back to the next available port
 * (or an OS-assigned ephemeral port) when the candidate port is already in use.
 */
export async function resolveAvailableDevPort(
  preferredPort: number,
  maxAttempts = 20,
): Promise<ResolvedDevPort> {
  const attempts = Math.max(1, maxAttempts);
  for (let offset = 0; offset < attempts; offset++) {
    const candidate = preferredPort + offset;
    if (candidate > 65535) break;
    try {
      const server = Bun.serve({
        port: candidate,
        hostname: "127.0.0.1",
        fetch: () => new Response(),
      });
      const boundPort = server.port ?? candidate;
      await server.stop(true);
      return {
        port: boundPort,
        preferredPort,
        fellBack: offset > 0 || boundPort !== preferredPort,
      };
    } catch {
      // Port is occupied; try next candidate
    }
  }

  const ephemeral = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => new Response(),
  });
  const boundPort = ephemeral.port ?? preferredPort;
  await ephemeral.stop(true);
  return {
    port: boundPort,
    preferredPort,
    fellBack: boundPort !== preferredPort,
  };
}

/**
 * Discovers `*.http` sample request files under `sourceRoot` and `requests/`.
 */
export async function discoverSampleHttpFiles(
  cwd: string,
  sourceRoot = "src",
): Promise<string[]> {
  const found = new Set<string>();
  const dirsToScan = [resolve(cwd, sourceRoot), resolve(cwd, "requests")];
  const glob = new Bun.Glob("**/*.http");

  for (const dir of dirsToScan) {
    if (!existsSyncPath(dir)) continue;
    try {
      for await (const match of glob.scan({ cwd: dir, onlyFiles: true })) {
        const abs = resolve(dir, match);
        const rel = relative(cwd, abs).replace(/\\/g, "/");
        found.add(rel);
      }
    } catch {
      // Ignore unreadable directories
    }
  }

  return [...found].sort();
}

export function formatDevStartupInfo(params: {
  readonly port?: number;
  readonly fellBackFromPort?: number;
  readonly routes?: readonly ExtractedRouteEntry[];
  readonly sampleHttpFiles?: readonly string[];
  readonly cwd: string;
}): string[] {
  const lines: string[] = [];

  if (params.port !== undefined) {
    if (params.fellBackFromPort !== undefined) {
      lines.push(
        `[dev] Port ${params.fellBackFromPort} is in use; using http://localhost:${params.port}`,
      );
    } else {
      lines.push(`[dev] Listening URL: http://localhost:${params.port}`);
    }
  }

  if (params.routes && params.routes.length > 0) {
    lines.push(`[dev] Discovered routes (${params.routes.length}):`);
    for (const route of params.routes) {
      const relFile = relative(params.cwd, route.sourceFile).replace(/\\/g, "/");
      const loc =
        route.location?.line !== undefined ? `:${route.location.line}` : "";
      lines.push(
        `  ${route.method.toUpperCase()} ${route.path} -> ${relFile}${loc}`,
      );
    }
  }

  if (params.sampleHttpFiles && params.sampleHttpFiles.length > 0) {
    lines.push(`[dev] Sample requests (${params.sampleHttpFiles.length}):`);
    for (const httpFile of params.sampleHttpFiles) {
      lines.push(`  ${httpFile}`);
    }
  }

  return lines;
}

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
  const explicitPort = options.port;

  if (
    explicitPort !== undefined &&
    (!Number.isInteger(explicitPort) || explicitPort < 0 || explicitPort > 65535)
  ) {
    throw new Error(
      `Invalid port "${String(explicitPort)}": expected an integer between 0 and 65535.`,
    );
  }

  const { config } = await loadCliConfiguration(cwd, options.config);
  const resolvedSourceRoot = options.sourceRoot ?? config.sourceRoot ?? "src";
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

  let watcher: Awaited<ReturnType<typeof startTypegenWatcher>> | undefined;
  if (typegenEnabled) {
    watcher = await startTypegenWatcher(
      {
        cwd,
        sourceRoot: resolvedSourceRoot,
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

  let resolvedPort = explicitPort;
  let fellBackFromPort: number | undefined;
  if (resolvedPort === undefined && !options.spawn) {
    const candidatePort = Number(Bun.env.PORT ?? 3000);
    if (
      Number.isInteger(candidatePort) &&
      candidatePort > 0 &&
      candidatePort <= 65535
    ) {
      const probed = await resolveAvailableDevPort(candidatePort);
      resolvedPort = probed.port;
      if (probed.fellBack) {
        fellBackFromPort = probed.preferredPort;
      }
    }
  }

  const command = ["bun", "--watch", entry];
  const env: Record<string, string | undefined> = {
    ...Bun.env,
    ...(resolvedPort !== undefined ? { PORT: String(resolvedPort) } : {}),
  };

  if (io && !options.silent) {
    const portMsg = resolvedPort !== undefined ? ` (PORT=${resolvedPort})` : "";
    io.stdout(`Starting Bunest dev server: bun --watch ${entry}${portMsg}`);
    const sampleHttpFiles = await discoverSampleHttpFiles(
      cwd,
      resolvedSourceRoot,
    );
    const startupLines = formatDevStartupInfo({
      port: resolvedPort,
      fellBackFromPort,
      routes: watcher?.initialScan?.routes,
      sampleHttpFiles,
      cwd,
    });
    for (const line of startupLines) {
      io.stdout(line);
    }
  }

  const spawn = options.spawn ?? defaultSpawn;
  const spawnCmd = [process.execPath, "--watch", entry];
  try {
    const { exitCode } = await spawn(spawnCmd, { cwd, env });
    return {
      exitCode,
      command,
      entry,
      port: resolvedPort,
      ...(watcher ? { typegen: watcher.initialResult } : {}),
    };
  } finally {
    await watcher?.close();
  }
}
