import {
  existsSyncPath,
  join,
  relative,
  removePath,
  resolve,
  statPath,
} from "@bunest/core";
import {
  loadCliConfiguration,
  resolveEntryFile,
} from "../config/configuration.loader";
import { startTypegenWatcher, type ExtractedRouteEntry } from "../typegen";
import type {
  CliIO,
  DevServerOptions,
  DevServerResult,
} from "../types";
import { resolveTypegenConfig } from "./typegen";

export interface DevReadyEvent {
  readonly sessionId: string;
  readonly pid: number;
  readonly url: string;
  readonly port: number;
  readonly timestamp: number;
}

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
      lines.push(`[dev] Target URL (pending bind): http://localhost:${params.port}`);
    }
  }

  if (params.routes && params.routes.length > 0) {
    lines.push(`[dev] Discovered routes [static] (${params.routes.length}):`);
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

function parseDevReadyLine(
  line: string,
  expectedSessionId: string,
): DevReadyEvent | null {
  try {
    const parsed = JSON.parse(line) as Partial<DevReadyEvent>;
    if (
      parsed.sessionId !== expectedSessionId ||
      typeof parsed.url !== "string" ||
      parsed.url.length === 0 ||
      typeof parsed.port !== "number" ||
      !Number.isFinite(parsed.port)
    ) {
      return null;
    }
    return {
      sessionId: parsed.sessionId,
      pid: typeof parsed.pid === "number" ? parsed.pid : 0,
      url: parsed.url,
      port: parsed.port,
      timestamp:
        typeof parsed.timestamp === "number" ? parsed.timestamp : Date.now(),
    };
  } catch {
    return null;
  }
}

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
    } else if (candidatePort === 0) {
      resolvedPort = 0;
    }
  }

  const command = ["bun", "--watch", entry];
  const spawnCmd = [process.execPath, "--watch", entry];
  const baseEnv: Record<string, string | undefined> = {
    ...Bun.env,
    ...(resolvedPort !== undefined ? { PORT: String(resolvedPort) } : {}),
  };

  if (io && !options.silent) {
    const targetPortMsg =
      resolvedPort !== undefined
        ? resolvedPort === 0
          ? " (target port: ephemeral)"
          : fellBackFromPort !== undefined
            ? ` (target port: ${resolvedPort}; port ${fellBackFromPort} in use)`
            : ` (target port: ${resolvedPort})`
        : "";
    io.stdout(`Starting Bunest dev server: bun --watch ${entry}${targetPortMsg}`);
    const sampleHttpFiles = await discoverSampleHttpFiles(
      cwd,
      resolvedSourceRoot,
    );
    const startupLines = formatDevStartupInfo({
      // Only include target URL in custom/mocked spawn mode; real dev servers
      // announce the actual bound URL after the child confirms listen().
      ...(options.spawn ? { port: resolvedPort, fellBackFromPort } : {}),
      routes: watcher?.initialScan?.routes,
      sampleHttpFiles,
      cwd,
    });
    for (const line of startupLines) {
      io.stdout(line);
    }
  }

  if (options.spawn) {
    try {
      const { exitCode } = await options.spawn(spawnCmd, { cwd, env: baseEnv });
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

  const sessionId = crypto.randomUUID();
  const tmpDir = Bun.env.TMPDIR ?? Bun.env.TEMP ?? "/tmp";
  const readyFilePath = join(tmpDir, `bunest-dev-ready-${sessionId}.jsonl`);
  const env: Record<string, string | undefined> = {
    ...baseEnv,
    BUNEST_DEV_SESSION_ID: sessionId,
    BUNEST_DEV_READY_FILE: readyFilePath,
  };

  let consumedLines = 0;
  let bootCount = 0;
  let lastBoundPort = resolvedPort;
  let polling = false;

  const pollReadyFile = async (): Promise<void> => {
    if (polling) return;
    polling = true;
    try {
      const file = Bun.file(readyFilePath);
      if (!(await file.exists())) {
        return;
      }
      const text = await file.text();
      if (!text) return;
      const lines = text.split("\n");
      const completeCount = lines.length - 1;
      for (let i = consumedLines; i < completeCount; i++) {
        consumedLines = i + 1;
        const raw = lines[i]?.trim();
        if (!raw) continue;
        const event = parseDevReadyLine(raw, sessionId);
        if (!event) continue;
        bootCount += 1;
        lastBoundPort = event.port;
        if (io && !options.silent) {
          io.stdout(`[dev] Ready [boot #${bootCount}]: ${event.url}`);
        }
      }
    } catch {
      // Ignore transient read errors while child is writing or exiting
    } finally {
      polling = false;
    }
  };

  const proc = Bun.spawn(spawnCmd, {
    cwd,
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });

  const terminateChild = (signal?: NodeJS.Signals) => {
    try {
      if (signal) {
        proc.kill(signal);
      } else {
        proc.kill();
      }
    } catch {
      // Child already exited
    }
  };

  const onSigInt = () => terminateChild("SIGINT");
  const onSigTerm = () => terminateChild("SIGTERM");
  const onExit = () => terminateChild();
  process.on("SIGINT", onSigInt);
  process.on("SIGTERM", onSigTerm);
  process.on("exit", onExit);

  const pollTimer = setInterval(() => {
    void pollReadyFile();
  }, 25);

  try {
    const exitCode = await proc.exited;
    await pollReadyFile();
    return {
      exitCode,
      command,
      entry,
      port: lastBoundPort,
      ...(watcher ? { typegen: watcher.initialResult } : {}),
    };
  } finally {
    clearInterval(pollTimer);
    process.off("SIGINT", onSigInt);
    process.off("SIGTERM", onSigTerm);
    process.off("exit", onExit);
    await removePath(readyFilePath, { force: true }).catch(() => {});
    await watcher?.close();
  }
}
