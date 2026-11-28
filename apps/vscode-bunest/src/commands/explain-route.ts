import { cond } from "@bunest/core/common";
import { relative } from "@bunest/core";
import * as vscode from "vscode";
import {
  explainRoute,
  type DiDependencyTrace,
  type RouteExplainMatch,
  type RouteExplainQuickFix,
  type RouteExplainReport,
} from "@bunest/cli/analyzer";
import type { ExtractedRouteEntry, SourceLocation } from "@bunest/cli";
import type {
  BunestWorkspaceIndex,
  WorkspaceFolderContext,
} from "../workspace/workspace-index";

export type ExplainRouteTarget =
  | ExtractedRouteEntry
  | { readonly route?: ExtractedRouteEntry }
  | undefined;

export function unwrapRouteTarget(
  target: ExplainRouteTarget,
): ExtractedRouteEntry | undefined {
  if (!target) return undefined;
  if ("path" in target && "method" in target) {
    return target;
  }
  return target.route;
}

/**
 * Collects file paths of currently dirty (unsaved) TypeScript documents in VS Code.
 */
export function collectDirtyBufferPaths(
  documents: readonly vscode.TextDocument[] = vscode.workspace.textDocuments ??
    [],
): string[] {
  const dirty: string[] = [];
  for (const doc of documents) {
    if (doc.isDirty && doc.uri?.scheme === "file" && doc.uri.fsPath) {
      dirty.push(doc.uri.fsPath);
    }
  }
  return dirty;
}

/**
 * Converts a deterministic `RouteExplainQuickFix` into a native `vscode.WorkspaceEdit`
 * so applying it participates in VS Code's native Undo/Redo stack.
 */
export function buildQuickFixWorkspaceEdit(
  quickFix: RouteExplainQuickFix,
  documents: readonly vscode.TextDocument[] = vscode.workspace.textDocuments ??
    [],
): vscode.WorkspaceEdit | undefined {
  if (quickFix.edits.length === 0) return undefined;
  const wsEdit = new vscode.WorkspaceEdit();
  for (const span of quickFix.edits) {
    const uri = vscode.Uri.file(span.filePath);
    const openDoc = documents.find(
      (d) => d.uri?.scheme === "file" && d.uri.fsPath === span.filePath,
    );
    const range = openDoc
      ? new vscode.Range(
          openDoc.positionAt(span.start),
          openDoc.positionAt(span.end),
        )
      : new vscode.Range(0, 0, Number.MAX_SAFE_INTEGER, 0);
    wsEdit.replace(uri, range, span.newText);
  }
  return wsEdit;
}

function formatLocationLabel(
  loc: SourceLocation | undefined,
  cwd?: string,
): string {
  if (!loc) return "<unknown>";
  const file = cwd
    ? relative(cwd, loc.filePath).replace(/\\/g, "/")
    : loc.filePath.replace(/\\/g, "/");
  return `${file}:${loc.line}:${loc.column}`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderLocationLinkHtml(
  loc: SourceLocation | undefined,
  cwd: string | undefined,
  locations: SourceLocation[],
): string {
  if (!loc) return '<span class="muted">&lt;unknown&gt;</span>';
  const idx = locations.length;
  locations.push(loc);
  const label = formatLocationLabel(loc, cwd);
  return `<a href="#" class="loc-link" data-loc="${idx}" title="Reveal ${escapeHtml(label)}">${escapeHtml(label)}</a>`;
}

const DEP_STATUS_CLASS: Readonly<Record<string, string>> = {
  resolved: "ok",
  "unknown-dynamic": "warn",
};

const CONFIRMATION_STATUS_CLASS: Readonly<Record<string, string>> = {
  "runtime-confirmed": "ok",
  mismatch: "err",
};

function renderDepTreeHtml(
  deps: readonly DiDependencyTrace[],
  cwd: string | undefined,
  locations: SourceLocation[],
): string {
  if (deps.length === 0) {
    return '<div class="muted">No constructor dependencies.</div>';
  }
  const items = deps.map((dep) => {
    const statusClass = DEP_STATUS_CLASS[dep.status] ?? "err";
    const locHtml = dep.location
      ? ` ${renderLocationLinkHtml(dep.location, cwd, locations)}`
      : "";
    const ownersHtml =
      dep.ownerModules.length > 0
        ? `<div class="owners">Owners: ${dep.ownerModules
            .map((o) => {
              const expLoc = o.exportsLocation
                ? ` (${renderLocationLinkHtml(o.exportsLocation, cwd, locations)})`
                : "";
              return `<code>${escapeHtml(o.name)}</code> [exported=${o.exported}, imported=${o.importedByConsumer}]${expLoc}`;
            })
            .join(", ")}</div>`
        : "";
    const childrenHtml =
      dep.children && dep.children.length > 0
        ? renderDepTreeHtml(dep.children, cwd, locations)
        : "";
    return `<li>
      <span class="badge ${statusClass}">${escapeHtml(dep.status)}</span>
      <code>${escapeHtml(dep.paramName)}: ${escapeHtml(dep.token)}</code>${locHtml}
      ${ownersHtml}
      ${childrenHtml}
    </li>`;
  });
  return `<ul class="dep-tree">${items.join("")}</ul>`;
}

/**
 * Formats a `RouteExplainReport` into readable Markdown with file:line spans.
 */
export function formatExplainReportMarkdown(
  report: RouteExplainReport,
  cwd?: string,
): string {
  const lines: string[] = [];
  const routeTitle = `${report.query.method ? `${report.query.method} ` : ""}${report.query.path}${report.query.version ? ` (v${report.query.version})` : ""}`;
  lines.push(`# Route Explain: \`${routeTitle}\` [${report.confirmationStatus}]`);
  lines.push("");

  if (report.runtime.attempted) {
    const buildSuffix = report.runtime.buildVersion
      ? ` (build ${report.runtime.buildVersion})`
      : "";
    const state = cond(
      [
        [
          !report.runtime.reachable,
          `unreachable (${report.runtime.error ?? "connection failed"}) — fell back to static-only`,
        ],
        [
          Boolean(report.runtime.bootstrapFailed),
          `bootstrap failed (${report.runtime.error ?? "unknown error"}) — fell back to static-only`,
        ],
      ],
      `reachable${buildSuffix}`,
    );
    lines.push(`- **Runtime**: \`${report.runtime.serverUrl ?? ""}\` — ${state}`);
  } else {
    lines.push("- **Runtime**: not queried (`static-only`)");
  }

  if (report.dirtyBuffers && report.dirtyBuffers.length > 0) {
    lines.push(`- **Dirty buffers**: ${report.dirtyBuffers.join(", ")}`);
  }

  lines.push("");
  if (report.matches.length === 0) {
    lines.push("_No matching route found._");
  } else {
    for (const m of report.matches) {
      lines.push(
        `## ${m.method} ${m.path}${m.version ? ` (v${m.version})` : ""} — \`${m.confirmationStatus}\``,
      );
      if (m.module) {
        lines.push(
          `- **Module**: \`${m.module.name}\` (${formatLocationLabel(m.module.location, cwd)})`,
        );
      }
      lines.push(
        `- **Controller**: \`${m.controller.name}.${m.controller.handlerName}()\` (${formatLocationLabel(m.controller.handlerLocation, cwd)})`,
      );
      if (m.pipeline.length > 0) {
        lines.push(
          `- **Pipeline**: ${m.pipeline.map((p) => `${p.stage}:${p.name}(${p.scope}/${p.source})`).join(" -> ")}`,
        );
      }
      if (m.dependencies.length > 0) {
        lines.push("- **DI Dependencies**:");
        const pushDeps = (deps: readonly DiDependencyTrace[], indent: string) => {
          for (const d of deps) {
            lines.push(
              `${indent}- [${d.status}] \`${d.paramName}: ${d.token}\` (${formatLocationLabel(d.location, cwd)})`,
            );
            if (d.children?.length) {
              pushDeps(d.children, `${indent}  `);
            }
          }
        };
        pushDeps(m.dependencies, "  ");
      }
      if (m.diagnostics.length > 0) {
        lines.push("- **Diagnostics**:");
        for (const diag of m.diagnostics) {
          lines.push(
            `  - \`${diag.code}\` (${formatLocationLabel(diag.location, cwd)}): ${diag.message}`,
          );
        }
      }
      lines.push("");
    }
  }

  if (report.unknowns.length > 0) {
    lines.push("## Unknowns");
    for (const u of report.unknowns) {
      lines.push(
        `- [${u.kind}] ${u.reason} (${formatLocationLabel(u.location, cwd)})`,
      );
    }
    lines.push("");
  }

  if (report.quickFixes.length > 0) {
    lines.push("## Deterministic Quick Fixes");
    for (const qf of report.quickFixes) {
      lines.push(
        `- [${qf.kind}] ${qf.title} (${formatLocationLabel(qf.location, cwd)})`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Builds an interactive HTML report for the `Bunest: Explain Route & DI` webview panel
 * with clickable `file:line` location links (`bunest.revealLocation`) and 1-click
 * deterministic Quick Fix buttons.
 */
export function buildExplainReportHtml(
  report: RouteExplainReport,
  cwd?: string,
): { readonly html: string; readonly locations: readonly SourceLocation[] } {
  const locations: SourceLocation[] = [];
  const routeTitle = `${report.query.method ? `${report.query.method} ` : ""}${report.query.path}${report.query.version ? ` (v${report.query.version})` : ""}`;
  const statusClass =
    CONFIRMATION_STATUS_CLASS[report.confirmationStatus] ?? "warn";

  const runtimeBuildSuffix = report.runtime.buildVersion
    ? ` · build ${report.runtime.buildVersion}`
    : "";
  const runtimeSummary = cond(
    [
      [!report.runtime.attempted, "Not queried (static-only)"],
      [
        !report.runtime.reachable,
        `Unreachable (${report.runtime.serverUrl ?? ""}: ${report.runtime.error ?? "connection failed"}) — static-only fallback`,
      ],
      [
        Boolean(report.runtime.bootstrapFailed),
        `Bootstrap failed (${report.runtime.error ?? "unknown error"}) — static-only fallback`,
      ],
    ],
    `Reachable (${report.runtime.serverUrl ?? ""})${runtimeBuildSuffix}`,
  );

  const renderMatch = (m: RouteExplainMatch): string => {
    const exportsHtml = m.module?.exportsLocation
      ? ` · exports ${renderLocationLinkHtml(m.module.exportsLocation, cwd, locations)}`
      : "";
    const modHtml = m.module
      ? `<div><strong>Module:</strong> <code>${escapeHtml(m.module.name)}</code> ${renderLocationLinkHtml(m.module.location, cwd, locations)}${exportsHtml}</div>`
      : `<div><strong>Module:</strong> <span class="muted">Not declared in any static @Module</span></div>`;

    const pipelineHtml =
      m.pipeline.length > 0
        ? `<ol class="pipeline">${m.pipeline
            .map(
              (p) =>
                `<li><span class="badge neutral">${escapeHtml(p.stage)}</span> <code>${escapeHtml(p.name)}</code> <span class="muted">(${escapeHtml(p.scope)} / ${escapeHtml(p.source)})</span> ${p.location ? renderLocationLinkHtml(p.location, cwd, locations) : ""}</li>`,
            )
            .join("")}</ol>`
        : '<div class="muted">No guards, pipes, interceptors, middleware, or filters detected.</div>';

    const diagsHtml =
      m.diagnostics.length > 0
        ? `<ul class="diag-list">${m.diagnostics
            .map(
              (d) =>
                `<li><span class="badge err">${escapeHtml(d.code)}</span> ${escapeHtml(d.message)} ${renderLocationLinkHtml(d.location, cwd, locations)}</li>`,
            )
            .join("")}</ul>`
        : "";

    const matchBadgeClass =
      CONFIRMATION_STATUS_CLASS[m.confirmationStatus] ?? "warn";
    return `<section class="card">
      <h3><code>${escapeHtml(m.method)} ${escapeHtml(m.path)}</code> <span class="badge ${matchBadgeClass}">${escapeHtml(m.confirmationStatus)}</span></h3>
      ${modHtml}
      <div><strong>Controller:</strong> <code>${escapeHtml(m.controller.name)}.${escapeHtml(m.controller.handlerName)}()</code> ${renderLocationLinkHtml(m.controller.handlerLocation ?? m.controller.location, cwd, locations)}</div>
      <h4>Execution Pipeline</h4>
      ${pipelineHtml}
      <h4>DI Dependency Trace</h4>
      ${renderDepTreeHtml(m.dependencies, cwd, locations)}
      ${diagsHtml ? `<h4>Diagnostics</h4>${diagsHtml}` : ""}
    </section>`;
  };

  const unknownsHtml =
    report.unknowns.length > 0
      ? `<section class="card"><h3>Unknowns / Dynamic Registrations</h3><ul>${report.unknowns
          .map(
            (u) =>
              `<li><span class="badge warn">${escapeHtml(u.kind)}</span> ${escapeHtml(u.reason)} ${u.location ? renderLocationLinkHtml(u.location, cwd, locations) : ""}</li>`,
          )
          .join("")}</ul></section>`
      : "";

  const quickFixesHtml =
    report.quickFixes.length > 0
      ? `<section class="card"><h3>Deterministic Quick Fixes</h3><div class="qf-list">${report.quickFixes
          .map(
            (qf) =>
              `<div class="qf-row">
                <div><strong>${escapeHtml(qf.title)}</strong> <span class="muted">(${escapeHtml(qf.kind)})</span> ${renderLocationLinkHtml(qf.location, cwd, locations)}</div>
                <button class="apply-fix" data-fix-id="${escapeHtml(qf.id)}">Apply Fix (Undoable)</button>
              </div>`,
          )
          .join("")}</div></section>`
      : "";

  const dirtyHtml =
    report.dirtyBuffers && report.dirtyBuffers.length > 0
      ? `<div class="banner">Unsaved editor buffers included in static analysis: <code>${escapeHtml(report.dirtyBuffers.join(", "))}</code></div>`
      : "";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 16px; line-height: 1.5; }
  h2 { margin: 0 0 8px; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  h3 { margin: 0 0 8px; font-size: 14px; }
  h4 { margin: 12px 0 6px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--vscode-descriptionForeground); }
  code { font-family: var(--vscode-editor-font-family, monospace); }
  .muted { color: var(--vscode-descriptionForeground); font-size: 12px; }
  .card { border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25)); border-radius: 6px; padding: 12px 14px; margin: 12px 0; background: var(--vscode-sideBar-background, transparent); }
  .banner { padding: 8px 12px; border-radius: 6px; margin: 10px 0; background: rgba(234, 179, 8, 0.14); border: 1px solid rgba(234, 179, 8, 0.4); font-size: 12px; }
  .badge { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 11px; font-weight: 700; color: #fff; }
  .badge.ok { background: #16a34a; }
  .badge.warn { background: #ca8a04; }
  .badge.err { background: #dc2626; }
  .badge.neutral { background: #475569; }
  .loc-link { color: var(--vscode-textLink-foreground); text-decoration: none; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; }
  .loc-link:hover { text-decoration: underline; }
  .dep-tree, .pipeline, .diag-list { margin: 4px 0; padding-left: 20px; }
  .dep-tree li { margin: 4px 0; }
  .owners { font-size: 12px; margin-left: 8px; color: var(--vscode-descriptionForeground); }
  .qf-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 6px 0; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.18)); }
  .qf-row:last-child { border-bottom: none; }
  button.apply-fix { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 4px; padding: 5px 10px; font-weight: 600; cursor: pointer; }
  button.apply-fix:hover { background: var(--vscode-button-hoverBackground); }
</style>
</head>
<body>
  <h2><span>Explain Route: <code>${escapeHtml(routeTitle)}</code></span><span class="badge ${statusClass}">${escapeHtml(report.confirmationStatus)}</span></h2>
  <div class="muted">Runtime: ${escapeHtml(runtimeSummary)}</div>
  ${dirtyHtml}
  ${report.matches.length > 0 ? report.matches.map(renderMatch).join("") : '<section class="card"><div class="muted">No route matched this query.</div></section>'}
  ${unknownsHtml}
  ${quickFixesHtml}
  <script>
    const vscode = acquireVsCodeApi();
    document.querySelectorAll('.loc-link').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        const idx = Number(el.getAttribute('data-loc'));
        vscode.postMessage({ type: 'reveal', index: idx });
      });
    });
    document.querySelectorAll('.apply-fix').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-fix-id');
        vscode.postMessage({ type: 'applyQuickFix', id });
      });
    });
  </script>
</body>
</html>`;

  return { html, locations };
}

export interface ExplainRouteExecutionResult {
  readonly report: RouteExplainReport;
  readonly cwd: string;
}

/**
 * Core execution helper for `bunest.explainRoute` (also directly unit-testable).
 */
export async function executeExplainRouteForEntry(
  ctx: WorkspaceFolderContext,
  route: ExtractedRouteEntry,
  options?: {
    readonly serverUrl?: string;
    readonly dirtyBuffers?: readonly string[];
    readonly fetch?: typeof fetch;
  },
): Promise<RouteExplainReport> {
  const snap = ctx.snapshot ?? ctx.analyzer.analyze();
  const query = `${route.method} ${route.path}`;
  return explainRoute({
    query,
    sourceFiles: ctx.analyzer.getScanner().getTrackedSourceFiles(),
    moduleGraph: snap.moduleGraph,
    diagnostics: snap.diagnostics,
    serverUrl: options?.serverUrl,
    dirtyBuffers: options?.dirtyBuffers,
    fetch: options?.fetch,
  });
}

let activeExplainPanel: vscode.WebviewPanel | undefined;
let activeExplainListener: vscode.Disposable | undefined;

/**
 * VS Code command handler for `bunest.explainRoute`.
 */
export async function runExplainRouteCommand(
  index: BunestWorkspaceIndex,
  routeOrItem?: ExplainRouteTarget,
  options?: {
    readonly fetch?: typeof fetch;
  },
): Promise<RouteExplainReport | undefined> {
  let route = unwrapRouteTarget(routeOrItem);

  if (!route) {
    const allRoutes = index
      .getAllSnapshots()
      .flatMap((s) => s.scan.routes);
    if (allRoutes.length === 0) {
      vscode.window.showInformationMessage(
        "No Bunest HTTP routes found in this workspace.",
      );
      return undefined;
    }

    const picked = await vscode.window.showQuickPick(
      allRoutes.map((r) => ({
        label: `${r.method} ${r.path}`,
        description: `${r.controllerName}.${r.handlerName}()`,
        detail: r.location
          ? `${r.location.filePath}:${r.location.line}`
          : undefined,
        route: r,
      })),
      {
        title: "Bunest: Explain Route & DI",
        placeHolder: "Select a route to inspect its pipeline, DI trace, and quick fixes...",
      },
    );
    if (!picked) return undefined;
    route = picked.route;
  }

  const ctx =
    (route.location?.filePath
      ? index.getContextForFile(route.location.filePath)
      : undefined) ?? index.getAllContexts()[0];

  if (!ctx) {
    vscode.window.showWarningMessage(
      "Could not resolve a Bunest workspace context for the selected route.",
    );
    return undefined;
  }

  const dirtyBuffers = collectDirtyBufferPaths();
  const configuredBaseUrl = vscode.workspace
    .getConfiguration("bunest")
    .get<string>("http.baseUrl")
    ?.trim();
  const serverUrl = configuredBaseUrl ? configuredBaseUrl : undefined;

  const report = await executeExplainRouteForEntry(ctx, route, {
    serverUrl,
    dirtyBuffers: dirtyBuffers.length > 0 ? dirtyBuffers : undefined,
    fetch: options?.fetch,
  });

  // Also log compact readable report to the Bunest output channel
  index.outputChannel.appendLine(
    `\n${formatExplainReportMarkdown(report, ctx.cwd)}`,
  );

  const { html, locations } = buildExplainReportHtml(report, ctx.cwd);

  if (typeof vscode.window.createWebviewPanel === "function") {
    if (activeExplainPanel) {
      activeExplainPanel.reveal(vscode.ViewColumn.Beside);
    } else {
      activeExplainPanel = vscode.window.createWebviewPanel(
        "bunestExplainRoute",
        `Explain: ${route.method} ${route.path}`,
        vscode.ViewColumn.Beside,
        { enableScripts: true, retainContextWhenHidden: true },
      );
      activeExplainPanel.onDidDispose(() => {
        activeExplainListener?.dispose();
        activeExplainListener = undefined;
        activeExplainPanel = undefined;
      });
    }

    activeExplainPanel.title = `Explain: ${route.method} ${route.path}`;
    activeExplainPanel.webview.html = html;
    activeExplainListener?.dispose();
    activeExplainListener = activeExplainPanel.webview.onDidReceiveMessage(async (msg) => {
      if (msg?.type === "reveal" && typeof msg.index === "number") {
        const loc = locations[msg.index];
        if (loc) {
          await vscode.commands.executeCommand("bunest.revealLocation", loc);
        }
        return;
      }
      if (msg?.type === "applyQuickFix" && typeof msg.id === "string") {
        const qf = report.quickFixes.find((f) => f.id === msg.id);
        if (!qf) return;
        const wsEdit = buildQuickFixWorkspaceEdit(qf);
        if (!wsEdit) return;
        const applied = await vscode.workspace.applyEdit(wsEdit);
        if (applied) {
          vscode.window.showInformationMessage(`Applied quick fix: ${qf.title}`);
        }
      }
    });
  }

  // Offer applying deterministic quick fixes directly via notification if any exist
  if (report.quickFixes.length > 0) {
    const applyLabel =
      report.quickFixes.length === 1
        ? `Apply Fix: ${report.quickFixes[0]!.title}`
        : `Apply Quick Fix (${report.quickFixes.length} available)`;
    const choice = await vscode.window.showInformationMessage(
      `Explain ${route.method} ${route.path} [${report.confirmationStatus}]: ${report.quickFixes.length} deterministic quick fix(es) available.`,
      applyLabel,
    );
    if (choice === applyLabel) {
      let chosenFix: RouteExplainQuickFix | undefined = report.quickFixes[0];
      if (report.quickFixes.length > 1) {
        const pickedFix = await vscode.window.showQuickPick(
          report.quickFixes.map((qf) => ({
            label: qf.title,
            description: qf.kind,
            detail: formatLocationLabel(qf.location, ctx.cwd),
            qf,
          })),
          { title: "Apply Deterministic Bunest Quick Fix" },
        );
        chosenFix = pickedFix?.qf;
      }
      if (chosenFix) {
        const wsEdit = buildQuickFixWorkspaceEdit(chosenFix);
        if (wsEdit) {
          await vscode.workspace.applyEdit(wsEdit);
          vscode.window.showInformationMessage(
            `Applied quick fix: ${chosenFix.title}`,
          );
        }
      }
    }
  }

  return report;
}
