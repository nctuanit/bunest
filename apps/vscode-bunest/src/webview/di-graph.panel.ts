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
      group: "module",
      badge: m.isGlobal ? "@Global" : m.autoDiscover ? "@AutoModule" : "@Module",
      x: 80 + (i % 4) * 235,
      y: 70 + Math.floor(i / 4) * 130,
      filePath: m.location.filePath,
      line: m.location.line,
    })),
    ...graph.providers.map((p, i) => ({
      id: `prov:${p.name}`,
      label: p.name,
      kind: p.kind,
      group: p.kind,
      badge: p.scope !== "SINGLETON" ? `${p.kind} · ${p.scope}` : p.kind,
      x: 80 + (i % 4) * 235,
      y: 250 + Math.floor(i / 4) * 115,
      filePath: p.location.filePath,
      line: p.location.line,
    })),
  ];

  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const cycleNodeIds = new Set<string>();
  const cycleEdges = new Set<string>();
  for (const cycle of graph.cycles) {
    for (let i = 0; i < cycle.length; i++) {
      cycleNodeIds.add(`prov:${cycle[i]}`);
      if (i < cycle.length - 1) {
        cycleEdges.add(`prov:${cycle[i]}->prov:${cycle[i + 1]}`);
      }
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
        edges.push({
          from: `mod:${m.name}`,
          to: `mod:${imp}`,
          isCycle: false,
          label: "imports",
        });
      }
    }
    for (const p of [...m.providers, ...m.controllers]) {
      if (nodeMap.has(`prov:${p}`)) {
        edges.push({
          from: `mod:${m.name}`,
          to: `prov:${p}`,
          isCycle: false,
          label: "provides",
        });
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

  const height = Math.max(540, ...nodes.map((n) => n.y + 120));
  const width = Math.max(980, ...nodes.map((n) => n.x + 250));

  const svgEdges = edges
    .map((e) => {
      const a = nodeMap.get(e.from);
      const b = nodeMap.get(e.to);
      if (!a || !b) return "";
      const stroke = e.isCycle ? "#ef4444" : "var(--vscode-editorLineNumber-foreground, #64748b)";
      const dash = e.label === "imports" ? 'stroke-dasharray="5,4"' : "";
      return `<line class="edge${e.isCycle ? " cycle" : ""}" data-from="${escapeHtml(e.from)}" data-to="${escapeHtml(e.to)}" x1="${a.x + 90}" y1="${a.y + 24}" x2="${b.x + 90}" y2="${b.y + 24}" stroke="${stroke}" stroke-width="${e.isCycle ? 2.5 : 1.3}" ${dash} marker-end="${e.isCycle ? "url(#arrow-red)" : "url(#arrow)"}" />`;
    })
    .join("\n");

  const svgNodes = nodes
    .map((n) => {
      const isCycle = cycleNodeIds.has(n.id);
      const fill = isCycle
        ? "#dc2626"
        : n.kind === "global-module"
          ? "#7c3aed"
          : n.kind === "module"
            ? "#2563eb"
            : n.kind === "controller"
              ? "#0891b2"
              : n.kind === "repository"
                ? "#059669"
                : "#475569";
      return `<g class="node" data-id="${escapeHtml(n.id)}" data-group="${escapeHtml(n.group)}" data-cycle="${isCycle ? "1" : "0"}" data-label="${escapeHtml(n.label.toLowerCase())}" onmouseenter="highlightPath('${escapeHtml(n.id)}')" onmouseleave="clearHighlight()" ondblclick="openNode(${JSON.stringify(n.filePath)}, ${n.line})" onclick="selectNode('${escapeHtml(n.id)}')" style="cursor:pointer">
        <rect x="${n.x}" y="${n.y}" width="180" height="50" rx="8" fill="${fill}" opacity="0.93" stroke="${isCycle ? "#fca5a5" : "transparent"}" stroke-width="2" />
        <text x="${n.x + 12}" y="${n.y + 22}" fill="#fff" font-size="12" font-weight="700">${escapeHtml(n.label)}</text>
        <text x="${n.x + 12}" y="${n.y + 39}" fill="#e2e8f0" font-size="10">${escapeHtml(n.badge)}</text>
      </g>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); display: flex; flex-direction: column; height: 100vh; }
  .toolbar { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-sideBar-background); flex-wrap: wrap; }
  input { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 4px; padding: 5px 8px; font-size: 12px; width: 210px; }
  input:focus { outline: 1px solid var(--vscode-focusBorder); }
  .chip { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: 1px solid transparent; padding: 4px 9px; border-radius: 999px; font-size: 11px; cursor: pointer; font-weight: 600; }
  .chip.active { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-color: var(--vscode-focusBorder); }
  .warn-banner { background: rgba(239, 68, 68, 0.14); border-bottom: 1px solid #ef4444; color: #fca5a5; padding: 8px 14px; font-size: 12px; font-weight: 600; }
  .canvas { flex: 1; overflow: auto; }
  .dim { opacity: 0.16; transition: opacity 120ms ease; }
  .edge.hi { stroke: var(--vscode-focusBorder, #38bdf8) !important; stroke-width: 2.5 !important; opacity: 1 !important; }
  .muted { color: var(--vscode-descriptionForeground); font-size: 11px; margin-left: auto; }
</style>
</head>
<body>
  <div class="toolbar">
    <input id="search" type="search" placeholder="Search module / provider..." oninput="applyFilters()" />
    <button class="chip active" onclick="setFilter('all', this)">All (${nodes.length})</button>
    <button class="chip" onclick="setFilter('module', this)">Modules (${graph.modules.length})</button>
    <button class="chip" onclick="setFilter('controller', this)">Controllers</button>
    <button class="chip" onclick="setFilter('repository', this)">Repositories</button>
    <button class="chip" onclick="setFilter('cycle', this)">Cycles (${graph.cycles.length})</button>
    <button class="chip" onclick="zoomBy(1.15)">Zoom +</button>
    <button class="chip" onclick="zoomBy(0.87)">Zoom -</button>
    <button class="chip" onclick="resetZoom()">Reset</button>
    <span class="muted">Hover: trace dependencies · Double-click: open source</span>
  </div>
  ${
    graph.cycles.length > 0
      ? `<div class="warn-banner">Circular DI detected (${graph.cycles.length}): ${graph.cycles.map((c) => escapeHtml(c.join(" → "))).join(" | ")}</div>`
      : ""
  }
  <div class="canvas">
    <svg id="graphSvg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <defs>
        <marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
          <path d="M0,0 L0,6 L7,3 z" fill="#64748b" />
        </marker>
        <marker id="arrow-red" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
          <path d="M0,0 L0,6 L7,3 z" fill="#ef4444" />
        </marker>
      </defs>
      <g id="viewport">
        ${svgEdges}
        ${svgNodes}
      </g>
    </svg>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    let activeFilter = "all";
    let scale = 1;
    let lockedNodeId = null;

    function openNode(filePath, line) {
      vscode.postMessage({ type: "open", filePath, line });
    }

    function setFilter(kind, btn) {
      activeFilter = kind;
      document.querySelectorAll(".toolbar .chip").forEach((c) => c.classList.remove("active"));
      btn.classList.add("active");
      applyFilters();
    }

    function applyFilters() {
      const q = document.getElementById("search").value.trim().toLowerCase();
      document.querySelectorAll(".node").forEach((n) => {
        const label = n.getAttribute("data-label") || "";
        const group = n.getAttribute("data-group") || "";
        const isCycle = n.getAttribute("data-cycle") === "1";
        const matchesSearch = !q || label.includes(q);
        const matchesKind =
          activeFilter === "all" ||
          (activeFilter === "cycle" ? isCycle : group === activeFilter);
        n.classList.toggle("dim", !(matchesSearch && matchesKind));
      });
    }

    function highlightPath(nodeId) {
      if (lockedNodeId && lockedNodeId !== nodeId) return;
      const connected = new Set([nodeId]);
      document.querySelectorAll(".edge").forEach((e) => {
        const f = e.getAttribute("data-from");
        const t = e.getAttribute("data-to");
        const hit = f === nodeId || t === nodeId;
        e.classList.toggle("hi", hit);
        e.classList.toggle("dim", !hit);
        if (hit) { connected.add(f); connected.add(t); }
      });
      document.querySelectorAll(".node").forEach((n) => {
        n.classList.toggle("dim", !connected.has(n.getAttribute("data-id")));
      });
    }

    function selectNode(nodeId) {
      lockedNodeId = lockedNodeId === nodeId ? null : nodeId;
      if (lockedNodeId) highlightPath(lockedNodeId);
      else clearHighlight();
    }

    function clearHighlight() {
      if (lockedNodeId) return;
      document.querySelectorAll(".edge").forEach((e) => { e.classList.remove("hi", "dim"); });
      applyFilters();
    }

    function zoomBy(factor) {
      scale = Math.min(2.2, Math.max(0.45, scale * factor));
      document.getElementById("viewport").setAttribute("transform", "scale(" + scale.toFixed(2) + ")");
    }

    function resetZoom() {
      scale = 1;
      document.getElementById("viewport").removeAttribute("transform");
    }
  </script>
</body>
</html>`;
}

export class BunestDiGraphPanel {
  private static current: vscode.WebviewPanel | undefined;

  static show(index: BunestWorkspaceIndex): void {
    const snapshots = index.getAllSnapshots();
    const modules = snapshots.flatMap((s) => s.moduleGraph.modules);
    const providers = snapshots.flatMap((s) => s.moduleGraph.providers);
    const merged: StaticModuleGraph = {
      modules,
      providers,
      moduleByName: new Map(modules.map((m) => [m.name, m])),
      providerByName: new Map(providers.map((p) => [p.name, p])),
      cycles: snapshots.flatMap((s) => s.moduleGraph.cycles),
    };

    if (this.current) {
      this.current.webview.html = buildDiGraphHtml(merged);
      this.current.reveal(vscode.ViewColumn.Beside);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "bunestDiGraph",
      "Bunest Interactive DI Graph",
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.current = panel;
    panel.webview.html = buildDiGraphHtml(merged);

    panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === "open" && typeof msg.filePath === "string") {
        const loc = sourceLocationToVscodeLocation({
          filePath: msg.filePath,
          start: 0,
          end: 0,
          line: Number(msg.line ?? 1),
          column: 1,
          endLine: Number(msg.line ?? 1),
          endColumn: 1,
        });
        const doc = await vscode.workspace.openTextDocument(loc.uri);
        const editor = await vscode.window.showTextDocument(doc);
        editor.selection = new vscode.Selection(
          loc.range.start,
          loc.range.start,
        );
        editor.revealRange(loc.range, vscode.TextEditorRevealType.InCenter);
      }
    });

    panel.onDidDispose(() => {
      this.current = undefined;
    });
  }
}
