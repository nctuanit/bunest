import * as vscode from "vscode";
import type { StaticModuleGraph } from "@bunest/cli";
import {
  sourceLocationToVscodeLocation,
  type BunestWorkspaceIndex,
} from "../workspace/workspace-index";

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildDiGraphHtml(graph: StaticModuleGraph): string {
  const nodes = [
    ...graph.modules.map((m, i) => ({
      id: `mod:${m.name}`,
      label: m.name,
      kind: m.isGlobal ? "global-module" : "module",
      badge: m.isGlobal ? "@Global" : m.autoDiscover ? "@AutoModule" : "@Module",
      x: 100 + (i % 4) * 230,
      y: 70 + Math.floor(i / 4) * 140,
      filePath: m.location.filePath,
      line: m.location.line,
    })),
    ...graph.providers.map((p, i) => ({
      id: `prov:${p.name}`,
      label: p.name,
      kind: p.kind,
      badge: p.scope !== "SINGLETON" ? `${p.kind} · ${p.scope}` : p.kind,
      x: 100 + (i % 4) * 230,
      y: 260 + Math.floor(i / 4) * 115,
      filePath: p.location.filePath,
      line: p.location.line,
    })),
  ];

  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const cycleEdges = new Set<string>();
  for (const cycle of graph.cycles) {
    for (let i = 0; i < cycle.length - 1; i++) {
      cycleEdges.add(`prov:${cycle[i]}->prov:${cycle[i + 1]}`);
    }
  }

  const edges: Array<{
    from: string;
    to: string;
    isCycle: boolean;
    label: string;
  }> = [];

  for (const m of graph.modules) {
    for (const imp of m.imports) {
      if (nodeMap.has(`mod:${imp}`)) {
        edges.push({ from: `mod:${m.name}`, to: `mod:${imp}`, isCycle: false, label: "imports" });
      }
    }
    for (const p of [...m.providers, ...m.controllers]) {
      if (nodeMap.has(`prov:${p}`)) {
        edges.push({ from: `mod:${m.name}`, to: `prov:${p}`, isCycle: false, label: "provides" });
      }
    }
  }
  for (const p of graph.providers) {
    for (const dep of p.dependencies) {
      if (nodeMap.has(`prov:${dep.typeName}`)) {
        const key = `prov:${p.name}->prov:${dep.typeName}`;
        edges.push({
          from: `prov:${p.name}`,
          to: `prov:${dep.typeName}`,
          isCycle: cycleEdges.has(key),
          label: "injects",
        });
      }
    }
  }

  const height = Math.max(520, ...nodes.map((n) => n.y + 120));
  const width = Math.max(960, ...nodes.map((n) => n.x + 240));

  const svgEdges = edges
    .map((e) => {
      const a = nodeMap.get(e.from);
      const b = nodeMap.get(e.to);
      if (!a || !b) return "";
      const stroke = e.isCycle ? "#ef4444" : "#64748b";
      const dash = e.label === "imports" ? 'stroke-dasharray="5,4"' : "";
      return `<line x1="${a.x + 85}" y1="${a.y + 24}" x2="${b.x + 85}" y2="${b.y + 24}" stroke="${stroke}" stroke-width="${e.isCycle ? 2.5 : 1.4}" ${dash} marker-end="url(#arrow)" />`;
    })
    .join("\n");

  const svgNodes = nodes
    .map((n) => {
      const fill =
        n.kind === "global-module"
          ? "#7c3aed"
          : n.kind === "module"
            ? "#2563eb"
            : n.kind === "controller"
              ? "#0891b2"
              : n.kind === "repository"
                ? "#059669"
                : "#475569";
      return `<g class="node" data-label="${escapeHtml(n.label.toLowerCase())}" onclick="openNode(${JSON.stringify(n.filePath)}, ${n.line})" style="cursor:pointer">
        <rect x="${n.x}" y="${n.y}" width="175" height="48" rx="8" fill="${fill}" opacity="0.92" />
        <text x="${n.x + 12}" y="${n.y + 21}" fill="#fff" font-size="12" font-weight="700">${escapeHtml(n.label)}</text>
        <text x="${n.x + 12}" y="${n.y + 38}" fill="#e2e8f0" font-size="10">${escapeHtml(n.badge)}</text>
      </g>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<style>
  body { margin: 0; font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
  .toolbar { display: flex; gap: 10px; align-items: center; padding: 10px 14px; border-bottom: 1px solid var(--vscode-panel-border); }
  input { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 4px 8px; border-radius: 4px; width: 240px; }
  .warn { color: #ef4444; font-weight: 600; }
  .canvas { overflow: auto; width: 100vw; height: calc(100vh - 48px); }
</style>
</head>
<body>
  <div class="toolbar">
    <strong>Bunest DI Graph</strong>
    <input id="filter" placeholder="Filter modules or providers..." oninput="applyFilter(this.value)" />
    <span>${graph.modules.length} modules · ${graph.providers.length} providers</span>
    ${graph.cycles.length > 0 ? `<span class="warn">⚠ ${graph.cycles.length} circular cycle(s)</span>` : ""}
  </div>
  <div class="canvas">
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <defs>
        <marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
          <path d="M0,0 L0,6 L7,3 z" fill="#64748b" />
        </marker>
      </defs>
      ${svgEdges}
      ${svgNodes}
    </svg>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    function openNode(filePath, line) {
      vscode.postMessage({ type: 'openFile', filePath, line });
    }
    function applyFilter(q) {
      const needle = q.trim().toLowerCase();
      document.querySelectorAll('.node').forEach((el) => {
        const label = el.getAttribute('data-label') || '';
        el.style.opacity = !needle || label.includes(needle) ? '1' : '0.18';
      });
    }
  </script>
</body>
</html>`;
}

export class BunestDiGraphPanel {
  private static current?: BunestDiGraphPanel;
  private readonly panel: vscode.WebviewPanel;
  private readonly subscription: vscode.Disposable;

  private constructor(private readonly index: BunestWorkspaceIndex) {
    this.panel = vscode.window.createWebviewPanel(
      "bunestDiGraph",
      "Bunest: Interactive DI Module Graph",
      vscode.ViewColumn.One,
      { enableScripts: true },
    );

    this.panel.webview.onDidReceiveMessage(
      async (msg: { type?: string; filePath?: string; line?: number }) => {
        if (msg.type === "openFile" && msg.filePath) {
          const loc = sourceLocationToVscodeLocation({
            filePath: msg.filePath,
            line: msg.line ?? 1,
            column: 1,
            endLine: msg.line ?? 1,
            endColumn: 1,
            start: 0,
            end: 0,
          });
          const doc = await vscode.workspace.openTextDocument(loc.uri);
          await vscode.window.showTextDocument(doc, { selection: loc.range });
        }
      },
    );

    this.subscription = index.onDidUpdate(() => this.render());
    this.panel.onDidDispose(() => {
      this.subscription.dispose();
      BunestDiGraphPanel.current = undefined;
    });

    this.render();
  }

  static show(index: BunestWorkspaceIndex): void {
    if (BunestDiGraphPanel.current) {
      BunestDiGraphPanel.current.panel.reveal(vscode.ViewColumn.One);
      BunestDiGraphPanel.current.render();
      return;
    }
    BunestDiGraphPanel.current = new BunestDiGraphPanel(index);
  }

  private render(): void {
    const snaps = this.index.getAllSnapshots();
    const merged: StaticModuleGraph = {
      modules: snaps.flatMap((s) => s.moduleGraph.modules),
      providers: snaps.flatMap((s) => s.moduleGraph.providers),
      providerByName: new Map(
        snaps.flatMap((s) => [...s.moduleGraph.providerByName.entries()]),
      ),
      moduleByName: new Map(
        snaps.flatMap((s) => [...s.moduleGraph.moduleByName.entries()]),
      ),
      cycles: snaps.flatMap((s) => s.moduleGraph.cycles),
    };
    this.panel.webview.html = buildDiGraphHtml(merged);
  }
}
