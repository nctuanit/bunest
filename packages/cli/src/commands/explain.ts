import { relative, resolve } from "@bunest/core";
import {
  BunestStaticAnalyzer,
  explainRoute,
  type DiDependencyTrace,
  type RouteExplainReport,
} from "../analyzer";
import {
  loadBunestConfig,
  type BunestConfigLike,
} from "../config/bunest-config.loader";
import { loadCliConfiguration } from "../config/configuration.loader";
import type { CliIO } from "../types";
import type { SourceLocation } from "../typegen/types";

export type ExplainRouteFormat = "pretty" | "json" | "agent";

export interface ExplainRouteCommandOptions {
  readonly route: string;
  readonly cwd?: string;
  readonly sourceRoot?: string;
  readonly tsconfig?: string;
  readonly config?: string;
  readonly bunestConfig?: BunestConfigLike;
  readonly serverUrl?: string;
  readonly version?: string;
  readonly format?: ExplainRouteFormat;
  readonly dirtyBuffers?: readonly string[];
  readonly silent?: boolean;
  readonly fetch?: typeof fetch;
}

export interface ExplainRouteCommandResult {
  readonly exitCode: number;
  readonly report: RouteExplainReport;
  readonly formatted: string;
}

function fmtLoc(loc: SourceLocation | undefined, cwd?: string): string {
  if (!loc) return "<unknown>";
  const file = cwd
    ? relative(cwd, loc.filePath).replace(/\\/g, "/")
    : loc.filePath.replace(/\\/g, "/");
  return `${file}:${loc.line}:${loc.column}`;
}

function formatDependencyLines(
  deps: readonly DiDependencyTrace[],
  indent: string,
  cwd: string | undefined,
  compact: boolean,
): string[] {
  const lines: string[] = [];
  for (const dep of deps) {
    const loc = dep.location ? ` (${fmtLoc(dep.location, cwd)})` : "";
    const owners =
      dep.ownerModules.length > 0
        ? ` owners=[${dep.ownerModules
            .map((o) => {
              const expLoc = o.exportsLocation
                ? `@${fmtLoc(o.exportsLocation, cwd)}`
                : "";
              return `${o.name}(exported=${o.exported},imported=${o.importedByConsumer}${expLoc})`;
            })
            .join(", ")}]`
        : "";
    lines.push(
      `${indent}- [${dep.status}] ${dep.paramName}: ${dep.token}${compact ? "" : loc}${owners}`,
    );
    if (dep.children && dep.children.length > 0) {
      lines.push(
        ...formatDependencyLines(dep.children, `${indent}  `, cwd, compact),
      );
    }
  }
  return lines;
}

/**
 * Formats a `RouteExplainReport` (`schemaVersion: "1.0"`) for terminal (`pretty`),
 * machine consumers (`json`), or compact AI-agent output (`agent`).
 */
export function formatRouteExplainReport(
  report: RouteExplainReport,
  format: ExplainRouteFormat = "pretty",
  cwd?: string,
): string {
  if (format === "json") {
    return JSON.stringify(report, null, 2);
  }

  const lines: string[] = [];
  const compact = format === "agent";

  lines.push(
    `route: ${report.query.method ? `${report.query.method} ` : ""}${report.query.path}${report.query.version ? ` (v${report.query.version})` : ""} [${report.confirmationStatus}]`,
  );

  if (report.runtime.attempted) {
    const rtState = report.runtime.reachable
      ? report.runtime.bootstrapFailed
        ? `bootstrap-failed (${report.runtime.error ?? "unknown error"})`
        : `reachable${report.runtime.buildVersion ? ` build=${report.runtime.buildVersion}` : ""}`
      : `unreachable (${report.runtime.error ?? "connection failed"})`;
    lines.push(`runtime: ${report.runtime.serverUrl ?? ""} -> ${rtState}`);
  } else if (!compact) {
    lines.push("runtime: not queried (static-only)");
  }

  if (report.dirtyBuffers && report.dirtyBuffers.length > 0) {
    lines.push(`dirtyBuffers: ${report.dirtyBuffers.join(", ")}`);
  }

  if (report.matches.length === 0) {
    lines.push("matches: 0 (no route matched query)");
  } else {
    for (let i = 0; i < report.matches.length; i++) {
      const m = report.matches[i]!;
      const src =
        m.source.static && m.source.runtime
          ? "static+runtime"
          : m.source.runtime
            ? "runtime"
            : "static";
      lines.push(
        `match[${i + 1}]: ${m.method} ${m.path}${m.version ? ` v${m.version}` : ""} (${m.confirmationStatus}, ${src})`,
      );
      if (m.module) {
        const modLoc = m.module.location
          ? ` ${fmtLoc(m.module.location, cwd)}`
          : "";
        const expLoc = m.module.exportsLocation
          ? ` exports=${fmtLoc(m.module.exportsLocation, cwd)}`
          : "";
        lines.push(`  module: ${m.module.name}${modLoc}${expLoc}`);
      }
      const handlerLoc = m.controller.handlerLocation
        ? ` ${fmtLoc(m.controller.handlerLocation, cwd)}`
        : "";
      lines.push(
        `  controller: ${m.controller.name}.${m.controller.handlerName}${handlerLoc}`,
      );
      if (m.pipeline.length > 0) {
        const pipeSummary = m.pipeline
          .map((p) => `${p.stage}:${p.name}(${p.scope}/${p.source})`)
          .join(" -> ");
        lines.push(`  pipeline: ${pipeSummary}`);
      }
      if (m.dependencies.length > 0) {
        lines.push("  dependencies:");
        lines.push(...formatDependencyLines(m.dependencies, "    ", cwd, compact));
      }
      if (m.diagnostics.length > 0) {
        lines.push("  diagnostics:");
        for (const d of m.diagnostics) {
          lines.push(
            `    - [${d.code}] ${fmtLoc(d.location, cwd)} ${d.message}`,
          );
        }
      }
    }
  }

  if (report.unknowns.length > 0) {
    lines.push("unknowns:");
    for (const u of report.unknowns) {
      const loc = u.location ? ` (${fmtLoc(u.location, cwd)})` : "";
      lines.push(`  - [${u.kind}] ${u.reason}${loc}`);
    }
  }

  if (report.quickFixes.length > 0) {
    lines.push("quickFixes:");
    for (const qf of report.quickFixes) {
      lines.push(
        `  - [${qf.kind}] ${qf.title} (${fmtLoc(qf.location, cwd)})`,
      );
    }
  }

  return lines.join("\n");
}

/**
 * Runs `bunest explain route "<METHOD /path>"` statically and optionally confirms
 * against a running dev server (`--server-url`), falling back cleanly to
 * `static-only` when the server is unreachable or bootstrap failed.
 */
export async function runExplainRouteCommand(
  options: ExplainRouteCommandOptions,
  io?: CliIO,
): Promise<ExplainRouteCommandResult> {
  const cwd = resolve(options.cwd ?? io?.cwd ?? process.cwd());
  const loaded = await loadCliConfiguration(cwd, options.config);
  const bunestConfig =
    options.bunestConfig ?? (await loadBunestConfig(cwd)).config;
  const sourceRoot =
    options.sourceRoot ??
    bunestConfig.typegen?.sourceRoot ??
    loaded.config.sourceRoot ??
    "src";

  const analyzer = new BunestStaticAnalyzer({
    cwd,
    sourceRoot,
    tsconfigPath: options.tsconfig,
    bunestConfig,
  });

  const snapshot = analyzer.analyze();
  const report = await explainRoute({
    query: options.route,
    version: options.version,
    sourceFiles: analyzer.getScanner().getTrackedSourceFiles(),
    moduleGraph: snapshot.moduleGraph,
    diagnostics: snapshot.diagnostics,
    serverUrl: options.serverUrl,
    dirtyBuffers: options.dirtyBuffers,
    fetch: options.fetch,
  });

  const format = options.format ?? "pretty";
  const formatted = formatRouteExplainReport(report, format, cwd);

  if (io && !options.silent) {
    io.stdout(formatted);
  }

  return {
    exitCode: 0,
    report,
    formatted,
  };
}
