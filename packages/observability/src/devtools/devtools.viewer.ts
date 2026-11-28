import type { AgentErrorTrace } from "@bunest/core";
import {
  clamp,
  ensurePrefix,
  escapeHtml,
  isFiniteNumber,
  trimSuffix,
} from "@bunest/core/common";
import {
  detectGraphCycles,
  type DevtoolsDependencyCycle,
} from "./cycle-detector";
import type {
  DevtoolsApplicationGraph,
  DevtoolsControllerNode,
  DevtoolsModuleNode,
  DevtoolsProviderNode,
  DevtoolsRouteNode,
} from "./devtools.service";

export interface DevtoolsViewerOptions {
  readonly basePath?: string;
  readonly title?: string;
}

interface PositionedNode {
  readonly id: string;
  readonly kind: "module" | "controller" | "provider";
  readonly label: string;
  readonly subtitle: string;
  readonly moduleId: string;
  readonly moduleName: string;
  readonly scope?: string;
  readonly flags: readonly string[];
  readonly inCycle: boolean;
  readonly initTimeMs?: number;
  readonly details: Readonly<Record<string, unknown>>;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface PositionedEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly type:
    | "import"
    | "re-export"
    | "provides"
    | "controller"
    | "provider-dependency";
  readonly inCycle: boolean;
}

interface BootProfileEntry {
  readonly id: string;
  readonly kind: "module" | "controller" | "provider" | "other";
  readonly label: string;
  readonly moduleName: string;
  readonly initTimeMs: number;
}

const EDGE_MARKERS: Record<PositionedEdge["type"], string> = {
  import: "url(#arrow-import)",
  "re-export": "url(#arrow-reexport)",
  "provider-dependency": "url(#arrow-inject)",
  provides: "url(#arrow-owns)",
  controller: "url(#arrow-owns)",
};

const SCOPE_CLASSES: Record<string, string> = {
  REQUEST: " dg-scope-request",
  TRANSIENT: " dg-scope-transient",
};

function safeJsonEmbed(data: unknown): string {
  return JSON.stringify(data)
    .replace(/<\//g, "<\\/")
    .replace(/<!--/g, "<\\!--")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function formatMs(ms: number): string {
  if (ms >= 100) return `${ms.toFixed(1)}ms`;
  if (ms >= 1) return `${ms.toFixed(2)}ms`;
  return `${ms.toFixed(3)}ms`;
}

function truncateLabel(value: string, maxLen: number): string {
  if (value.length <= maxLen) return value;
  return `${value.slice(0, Math.max(1, maxLen - 1))}…`;
}

function normalizeBasePath(raw?: string): string {
  if (!raw) return "/_devtools";
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "/") return "";
  return trimSuffix(ensurePrefix(trimmed, "/"), "/");
}

function extractSerializedInitTime(
  graph: DevtoolsApplicationGraph,
  nodeId: string,
): number | undefined {
  const node = graph.serializedGraph?.nodes?.[nodeId];
  if (!node?.metadata) return undefined;
  const meta = node.metadata as { initTimeMs?: unknown; initTime?: unknown };
  if (typeof meta.initTimeMs === "number" && Number.isFinite(meta.initTimeMs)) {
    return meta.initTimeMs;
  }
  if (typeof meta.initTime === "number" && Number.isFinite(meta.initTime)) {
    return meta.initTime;
  }
  return undefined;
}

function resolveModuleInitTime(
  mod: DevtoolsModuleNode,
  graph: DevtoolsApplicationGraph,
): number | undefined {
  if (typeof mod.initTimeMs === "number" && Number.isFinite(mod.initTimeMs)) {
    return mod.initTimeMs;
  }
  return extractSerializedInitTime(graph, mod.id);
}

function resolveProviderInitTime(
  prov: DevtoolsProviderNode,
  graph: DevtoolsApplicationGraph,
): number | undefined {
  if (typeof prov.initTimeMs === "number" && Number.isFinite(prov.initTimeMs)) {
    return prov.initTimeMs;
  }
  return extractSerializedInitTime(
    graph,
    `${prov.moduleId}:provider:${prov.token}`,
  );
}

function resolveControllerInitTime(
  ctrl: DevtoolsControllerNode,
  graph: DevtoolsApplicationGraph,
): number | undefined {
  if (typeof ctrl.initTimeMs === "number" && Number.isFinite(ctrl.initTimeMs)) {
    return ctrl.initTimeMs;
  }
  return extractSerializedInitTime(
    graph,
    `${ctrl.moduleId}:controller:${ctrl.name}`,
  );
}

function buildLayout(
  graph: DevtoolsApplicationGraph,
  cycles: readonly DevtoolsDependencyCycle[],
): {
  readonly nodes: readonly PositionedNode[];
  readonly edges: readonly PositionedEdge[];
  readonly bootProfile: readonly BootProfileEntry[];
  readonly width: number;
  readonly height: number;
} {
  const nodes: PositionedNode[] = [];
  const edges: PositionedEdge[] = [];
  const nodeById = new Map<string, PositionedNode>();
  const bootProfile: BootProfileEntry[] = [];
  const seenProfileIds = new Set<string>();

  const cycleNodeIds = new Set<string>();
  const cycleEdgeKeys = new Set<string>();
  for (const cycle of cycles) {
    for (const nodeId of cycle.nodes) {
      cycleNodeIds.add(nodeId);
    }
    for (const edge of cycle.edges) {
      cycleEdgeKeys.add(`${edge.from}|${edge.to}`);
    }
  }

  const modW = 240;
  const ctrlW = 240;
  const provW = 260;
  const nodeH = 62;
  const gapY = 22;
  const startY = 48;

  const colX = {
    module: 40,
    controller: 360,
    provider: 680,
  };

  // Column 0: Modules
  graph.modules.forEach((mod, idx) => {
    const id = `mod:${mod.id}`;
    const inCycle = cycleNodeIds.has(id);
    const initTimeMs = resolveModuleInitTime(mod, graph);
    const flags: string[] = [];
    if (mod.isGlobal) flags.push("global");
    if (mod.isDynamic) flags.push("dynamic");
    if (inCycle) flags.push("cycle");
    const subParts: string[] = [
      flags.length > 0 ? flags.join(", ") : "module",
      `${mod.providers.length}p/${mod.controllers.length}c`,
    ];
    if (initTimeMs !== undefined) {
      subParts.push(formatMs(initTimeMs));
      bootProfile.push({
        id,
        kind: "module",
        label: mod.name,
        moduleName: mod.name,
        initTimeMs,
      });
      seenProfileIds.add(mod.id);
    }

    const node: PositionedNode = {
      id,
      kind: "module",
      label: mod.name,
      subtitle: subParts.join(" · "),
      moduleId: mod.id,
      moduleName: mod.name,
      flags,
      inCycle,
      initTimeMs,
      details: {
        moduleId: mod.id,
        isGlobal: mod.isGlobal,
        isDynamic: mod.isDynamic,
        imports: mod.imports,
        exports: mod.exports,
        reExports: mod.reExports,
        controllers: mod.controllers,
        providers: mod.providers,
      },
      x: colX.module,
      y: startY + idx * (nodeH + gapY),
      width: modW,
      height: nodeH,
    };
    nodes.push(node);
    nodeById.set(id, node);
  });

  // Column 1: Controllers
  graph.controllers.forEach((ctrl, idx) => {
    const id = `ctrl:${ctrl.moduleId}::${ctrl.name}`;
    const initTimeMs = resolveControllerInitTime(ctrl, graph);
    const pathText = Array.isArray(ctrl.path) ? ctrl.path.join(", ") : ctrl.path;
    const subParts: string[] = [
      String(ctrl.scope),
      `${ctrl.routeCount} route${ctrl.routeCount === 1 ? "" : "s"}`,
    ];
    if (initTimeMs !== undefined) {
      subParts.push(formatMs(initTimeMs));
      bootProfile.push({
        id,
        kind: "controller",
        label: ctrl.name,
        moduleName: ctrl.moduleName,
        initTimeMs,
      });
      seenProfileIds.add(`${ctrl.moduleId}:controller:${ctrl.name}`);
    }

    const node: PositionedNode = {
      id,
      kind: "controller",
      label: ctrl.name,
      subtitle: subParts.join(" · "),
      moduleId: ctrl.moduleId,
      moduleName: ctrl.moduleName,
      scope: String(ctrl.scope),
      flags: [],
      inCycle: false,
      initTimeMs,
      details: {
        moduleId: ctrl.moduleId,
        moduleName: ctrl.moduleName,
        path: pathText,
        scope: ctrl.scope,
        routeCount: ctrl.routeCount,
      },
      x: colX.controller,
      y: startY + idx * (nodeH + gapY),
      width: ctrlW,
      height: nodeH,
    };
    nodes.push(node);
    nodeById.set(id, node);
  });

  // Column 2: Providers
  const providerIdByRawId = new Map<string, string>();
  const providerIdByToken = new Map<string, string>();

  graph.providers.forEach((prov, idx) => {
    const id = `prov:${prov.id}`;
    const inCycle = cycleNodeIds.has(id);
    providerIdByRawId.set(prov.id, id);
    if (!providerIdByToken.has(prov.token)) {
      providerIdByToken.set(prov.token, id);
    }

    const initTimeMs = resolveProviderInitTime(prov, graph);
    const flags: string[] = [];
    if (prov.isExported) flags.push("exported");
    if (inCycle) flags.push("cycle");
    const subParts: string[] = [String(prov.scope), prov.kind];
    if (prov.isExported) subParts.push("exported");
    if (inCycle) subParts.push("cycle");
    if (initTimeMs !== undefined) {
      subParts.push(formatMs(initTimeMs));
      bootProfile.push({
        id,
        kind: "provider",
        label: prov.token,
        moduleName: prov.moduleName,
        initTimeMs,
      });
      seenProfileIds.add(`${prov.moduleId}:provider:${prov.token}`);
    }

    const node: PositionedNode = {
      id,
      kind: "provider",
      label: prov.token,
      subtitle: subParts.join(" · "),
      moduleId: prov.moduleId,
      moduleName: prov.moduleName,
      scope: String(prov.scope),
      flags,
      inCycle,
      initTimeMs,
      details: {
        id: prov.id,
        moduleId: prov.moduleId,
        moduleName: prov.moduleName,
        token: prov.token,
        kind: prov.kind,
        scope: prov.scope,
        isExported: prov.isExported,
        dependencies: prov.dependencies,
      },
      x: colX.provider,
      y: startY + idx * (nodeH + gapY),
      width: provW,
      height: nodeH,
    };
    nodes.push(node);
    nodeById.set(id, node);
  });

  // Collect any additional initTimeMs / initTime entries from serializedGraph
  if (graph.serializedGraph?.nodes) {
    for (const [rawId, sNode] of Object.entries(graph.serializedGraph.nodes)) {
      if (seenProfileIds.has(rawId)) continue;
      const meta = sNode.metadata as {
        type?: string;
        sourceModuleName?: string;
        initTimeMs?: unknown;
        initTime?: unknown;
      };
      const ms = [meta.initTimeMs, meta.initTime].find(isFiniteNumber);
      if (ms !== undefined) {
        const kind =
          meta.type === "module" ||
          meta.type === "controller" ||
          meta.type === "provider"
            ? meta.type
            : "other";
        bootProfile.push({
          id: rawId,
          kind,
          label: sNode.label,
          moduleName: meta.sourceModuleName ?? sNode.parent ?? "",
          initTimeMs: ms,
        });
        seenProfileIds.add(rawId);
      }
    }
  }

  bootProfile.sort((a, b) => b.initTimeMs - a.initTimeMs);

  // Build Edges
  const seenEdges = new Set<string>();
  let edgeSeq = 0;
  const pushEdge = (
    from: string,
    to: string,
    type: PositionedEdge["type"],
  ): void => {
    if (!nodeById.has(from) || !nodeById.has(to) || from === to) return;
    const key = `${from}|${type}|${to}`;
    if (seenEdges.has(key)) return;
    seenEdges.add(key);
    const inCycle =
      (type === "import" ||
        type === "re-export" ||
        type === "provider-dependency") &&
      cycleEdgeKeys.has(`${from}|${to}`);
    edges.push({ id: `e${edgeSeq++}`, from, to, type, inCycle });
  };

  for (const edge of graph.edges) {
    if (edge.type === "import" || edge.type === "re-export") {
      pushEdge(`mod:${edge.from}`, `mod:${edge.to}`, edge.type);
    } else if (edge.type === "provider-dependency") {
      const fromId = providerIdByRawId.get(edge.from);
      const toId =
        providerIdByRawId.get(edge.to) ?? providerIdByToken.get(edge.to);
      if (fromId && toId) {
        pushEdge(fromId, toId, "provider-dependency");
      }
    }
  }

  for (const ctrl of graph.controllers) {
    pushEdge(`mod:${ctrl.moduleId}`, `ctrl:${ctrl.moduleId}::${ctrl.name}`, "controller");
  }

  for (const prov of graph.providers) {
    pushEdge(`mod:${prov.moduleId}`, `prov:${prov.id}`, "provides");
  }

  // Add class-to-class edges from serializedGraph (e.g. controller -> provider)
  if (graph.serializedGraph?.edges) {
    for (const sEdge of Object.values(graph.serializedGraph.edges)) {
      if (sEdge.metadata.type !== "class-to-class") continue;
      const srcNode = graph.serializedGraph.nodes[sEdge.source];
      const tgtNode = graph.serializedGraph.nodes[sEdge.target];
      if (!srcNode || !tgtNode) continue;

      let srcId: string | undefined;
      if (srcNode.parent) {
        srcId =
          srcNode.metadata.type === "controller"
            ? `ctrl:${srcNode.parent}::${srcNode.label}`
            : `prov:${srcNode.parent}::${srcNode.metadata.token ?? srcNode.label}`;
      }
      const tgtToken = tgtNode.metadata.token ?? tgtNode.label;
      const tgtId =
        (tgtNode.parent ? `prov:${tgtNode.parent}::${tgtToken}` : undefined) ??
        providerIdByToken.get(tgtToken);
      if (srcId && tgtId) {
        pushEdge(srcId, tgtId, "provider-dependency");
      }
    }
  }

  const maxRows = Math.max(
    graph.modules.length,
    graph.controllers.length,
    graph.providers.length,
    1,
  );
  const width = 1000;
  const height = Math.max(460, startY + maxRows * (nodeH + gapY) + 48);

  return { nodes, edges, bootProfile, width, height };
}

function buildEdgePath(from: PositionedNode, to: PositionedNode): string {
  if (from.x === to.x) {
    // Same-column arc (e.g. module -> module or provider -> provider)
    const isLeftCol = from.kind === "module";
    const x = isLeftCol ? from.x : from.x + from.width;
    const y1 = from.y + from.height / 2;
    const y2 = to.y + to.height / 2;
    const dy = Math.abs(y2 - y1);
    const bulge = Math.min(110, 34 + dy * 0.22);
    const cx = isLeftCol ? x - bulge : x + bulge;
    return `M ${x} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x} ${y2}`;
  }

  const leftToRight = from.x < to.x;
  const x1 = leftToRight ? from.x + from.width : from.x;
  const y1 = from.y + from.height / 2;
  const x2 = leftToRight ? to.x : to.x + to.width;
  const y2 = to.y + to.height / 2;
  const dx = Math.abs(x2 - x1);
  const offset = Math.max(44, dx * 0.45);
  const cx1 = leftToRight ? x1 + offset : x1 - offset;
  const cx2 = leftToRight ? x2 - offset : x2 + offset;
  return `M ${x1} ${y1} C ${cx1} ${y1}, ${cx2} ${y2}, ${x2} ${y2}`;
}

function renderRoutesRows(routes: readonly DevtoolsRouteNode[]): string {
  if (routes.length === 0) {
    return `<tr><td colspan="6" class="empty-cell">No HTTP routes registered.</td></tr>`;
  }

  return routes
    .map((r) => {
      const methodLower = r.method.toLowerCase();
      const params =
        r.parameters.length > 0
          ? r.parameters
              .map(
                (p) =>
                  `@${p.source}(${p.key ?? ""})${p.metatype ? `: ${p.metatype}` : ""}`,
              )
              .join(", ")
          : "—";
      const enhancers = [
        ...r.guards.map((g) => `Guard:${g}`),
        ...r.pipes.map((p) => `Pipe:${p}`),
        ...r.interceptors.map((i) => `Interceptor:${i}`),
        ...r.filters.map((f) => `Filter:${f}`),
      ];
      const enhancerHtml =
        enhancers.length > 0
          ? enhancers
              .map((e) => `<span class="chip">${escapeHtml(e)}</span>`)
              .join(" ")
          : `<span class="muted">—</span>`;
      const metaBadges = [
        r.httpCode !== undefined ? `HTTP ${r.httpCode}` : "",
        r.isSse ? "SSE" : "",
      ]
        .filter(Boolean)
        .map((b) => `<span class="chip chip-meta">${escapeHtml(b)}</span>`)
        .join(" ");
      const searchKey = escapeHtml(
        `${r.method} ${r.fullPath} ${r.controller} ${r.handler} ${enhancers.join(" ")}`.toLowerCase(),
      );

      return `<tr class="route-row" data-search="${searchKey}">
        <td><span class="method-badge method-${escapeHtml(methodLower)}">${escapeHtml(r.method)}</span></td>
        <td class="mono">${escapeHtml(r.fullPath)}</td>
        <td class="mono">${escapeHtml(r.controller)}#${escapeHtml(r.handler)}</td>
        <td class="mono small">${escapeHtml(params)}</td>
        <td>${enhancerHtml}</td>
        <td>${metaBadges || '<span class="muted">—</span>'}</td>
      </tr>`;
    })
    .join("\n");
}

function renderBootProfileSection(
  entries: readonly BootProfileEntry[],
): string {
  if (entries.length === 0) {
    return `<div class="empty-card">
      <h3>No boot-profile timings recorded</h3>
      <p>Start your app with <code>BunestFactory.create(AppModule, { snapshot: true })</code> or set <code>BUNEST_BOOT_PROFILE=1</code> to record per-module and per-provider <code>initTimeMs</code> timings.</p>
    </div>`;
  }

  const totalMs = entries.reduce((sum, e) => sum + e.initTimeMs, 0);
  const maxMs = Math.max(...entries.map((e) => e.initTimeMs), 0.001);
  const slowest = entries[0]!;

  const rows = entries
    .map((entry) => {
      const pct = clamp((entry.initTimeMs / maxMs) * 100, 2, 100);
      return `<tr>
        <td><span class="kind-pill kind-${escapeHtml(entry.kind)}">${escapeHtml(entry.kind)}</span></td>
        <td class="mono">${escapeHtml(entry.label)}</td>
        <td class="mono muted">${escapeHtml(entry.moduleName || "—")}</td>
        <td class="mono num">${escapeHtml(formatMs(entry.initTimeMs))}</td>
        <td class="bar-cell"><div class="bar-track"><div class="bar-fill kind-${escapeHtml(entry.kind)}" style="width:${pct.toFixed(1)}%"></div></div></td>
      </tr>`;
    })
    .join("\n");

  return `<div class="profile-summary">
      <div class="kpi"><span class="kpi-label">Measured Nodes</span><strong class="kpi-val">${entries.length}</strong></div>
      <div class="kpi"><span class="kpi-label">Cumulative Init Time</span><strong class="kpi-val">${escapeHtml(formatMs(totalMs))}</strong></div>
      <div class="kpi"><span class="kpi-label">Slowest Node</span><strong class="kpi-val mono">${escapeHtml(slowest.label)} (${escapeHtml(formatMs(slowest.initTimeMs))})</strong></div>
    </div>
    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr><th>Kind</th><th>Node</th><th>Module</th><th>Init Time (initTimeMs)</th><th>Relative Duration</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function renderErrorsSection(errors: readonly AgentErrorTrace[]): string {
  if (errors.length === 0) {
    return `<div class="empty-card">
      <h3>No runtime error traces recorded</h3>
      <p>Call <code>app.enableDevDiagnostics()</code> or register an <code>AgentErrorTraceStore</code> in DI to stream structured <code>BUNEST_E*</code> error traces, routes, and suggested fixes here.</p>
    </div>`;
  }

  const rows = errors
    .map((trace) => {
      const methodLower = trace.method.toLowerCase();
      const target =
        trace.controller && trace.handler
          ? `${trace.controller}#${trace.handler}`
          : trace.controller || "—";
      const codeHtml = trace.code
        ? `<span class="error-code mono">${escapeHtml(trace.code)}</span>`
        : `<span class="chip mono">${escapeHtml(trace.name)}</span>`;
      const fixesHtml =
        trace.fixes && trace.fixes.length > 0
          ? `<ul class="error-fixes">${trace.fixes
              .map((fix) => `<li>${escapeHtml(fix)}</li>`)
              .join("")}</ul>`
          : `<span class="muted">—</span>`;
      const framesHtml =
        trace.appFrames && trace.appFrames.length > 0
          ? `<div class="small muted mono">${trace.appFrames
              .slice(0, 3)
              .map(
                (f) =>
                  `${escapeHtml(f.file)}:${f.line}:${f.column}${f.fn ? ` (${escapeHtml(f.fn)})` : ""}`,
              )
              .join("<br />")}</div>`
          : "";
      const searchKey = escapeHtml(
        `${trace.code ?? ""} ${trace.name} ${trace.message} ${trace.method} ${trace.path} ${trace.stage} ${target} ${(trace.fixes ?? []).join(" ")}`.toLowerCase(),
      );

      return `<tr class="error-row" data-search="${searchKey}">
        <td>
          ${codeHtml}
          <div class="small muted mono">HTTP ${trace.statusCode} · ${escapeHtml(trace.stage)}</div>
        </td>
        <td>
          <span class="method-badge method-${escapeHtml(methodLower)}">${escapeHtml(trace.method)}</span>
          <span class="mono">${escapeHtml(trace.path)}</span>
          <div class="small muted mono">${escapeHtml(target)}</div>
        </td>
        <td>
          <div><strong>${escapeHtml(trace.name)}</strong>: ${escapeHtml(trace.message)}</div>
          ${framesHtml}
        </td>
        <td>${fixesHtml}</td>
        <td class="mono small muted">${escapeHtml(trace.timestamp)}</td>
      </tr>`;
    })
    .join("\n");

  return `<div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr><th>Code / Status</th><th>Route</th><th>Error Message</th><th>Suggested Fixes</th><th>Timestamp</th></tr>
        </thead>
        <tbody id="errors-tbody">${rows}</tbody>
      </table>
    </div>`;
}

function renderCyclesBanner(cycles: readonly DevtoolsDependencyCycle[]): string {
  if (cycles.length === 0) {
    return "";
  }
  const items = cycles
    .map(
      (c) =>
        `<li><span class="chip chip-danger">${escapeHtml(c.kind)}</span> <span class="mono">${escapeHtml(c.labels.join(" → "))}</span></li>`,
    )
    .join("");
  return `<div class="cycle-banner" role="alert">
      <strong>Circular dependencies detected (${cycles.length}):</strong>
      <ul>${items}</ul>
    </div>`;
}

/**
 * Renders a self-contained, zero-dependency, CSP-safe interactive HTML/SVG
 * viewer for a `DevtoolsApplicationGraph`.
 */
export function renderDevtoolsHtml(
  graph: DevtoolsApplicationGraph,
  options: DevtoolsViewerOptions = {},
): string {
  const basePath = normalizeBasePath(options.basePath);
  const title = options.title ?? "Bunest Devtools";
  const cycles = graph.cycles ?? detectGraphCycles(graph);
  const errors = graph.errors ?? [];
  const layout = buildLayout(graph, cycles);
  const nodeMap = new Map(layout.nodes.map((n) => [n.id, n]));

  const totalBootMs = layout.bootProfile.reduce(
    (sum, e) => sum + e.initTimeMs,
    0,
  );

  const svgEdges = layout.edges
    .map((edge) => {
      const from = nodeMap.get(edge.from);
      const to = nodeMap.get(edge.to);
      if (!from || !to) return "";
      const d = buildEdgePath(from, to);
      const marker = edge.inCycle
        ? "url(#arrow-cycle)"
        : EDGE_MARKERS[edge.type];
      const cycleClass = edge.inCycle ? " dg-edge-cycle" : "";
      const cycleAttr = edge.inCycle ? ' data-cycle="true"' : "";
      return `<path class="dg-edge dg-edge-${escapeHtml(edge.type)}${cycleClass}" data-edge-id="${escapeHtml(edge.id)}" data-edge-type="${escapeHtml(edge.type)}" data-from="${escapeHtml(edge.from)}" data-to="${escapeHtml(edge.to)}"${cycleAttr} d="${d}" marker-end="${marker}" />`;
    })
    .join("\n");

  const svgNodes = layout.nodes
    .map((node) => {
      const scopeClass = (node.scope && SCOPE_CLASSES[node.scope]) || "";
      const cycleClass = node.inCycle ? " dg-cycle" : "";
      const cycleAttr = node.inCycle ? ' data-cycle="true"' : "";
      const initAttr =
        node.initTimeMs !== undefined
          ? ` data-init-ms="${escapeHtml(String(node.initTimeMs))}"`
          : "";
      return `<g class="dg-node dg-kind-${escapeHtml(node.kind)}${scopeClass}${cycleClass}" data-node-id="${escapeHtml(node.id)}" data-kind="${escapeHtml(node.kind)}" data-module="${escapeHtml(node.moduleName)}" data-scope="${escapeHtml(node.scope ?? "")}" data-label="${escapeHtml(node.label)}"${initAttr}${cycleAttr} transform="translate(${node.x}, ${node.y})" tabindex="0" role="button" aria-label="${escapeHtml(`${node.kind} ${node.label}`)}">
        <rect class="dg-node-box" width="${node.width}" height="${node.height}" rx="10" ry="10" />
        <text class="dg-node-title" x="14" y="25">${escapeHtml(truncateLabel(node.label, 27))}</text>
        <text class="dg-node-sub" x="14" y="46">${escapeHtml(truncateLabel(node.subtitle, 34))}</text>
      </g>`;
    })
    .join("\n");

  const moduleFilterOptions = graph.modules
    .map(
      (m) =>
        `<option value="${escapeHtml(m.name)}">${escapeHtml(m.name)}</option>`,
    )
    .join("");

  const embeddedPayload = safeJsonEmbed({
    generatedAt: graph.generatedAt,
    basePath,
    nodes: layout.nodes,
    edges: layout.edges,
    cycles,
    routesCount: graph.routes.length,
    errorsCount: errors.length,
    bootProfileCount: layout.bootProfile.length,
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      --bg: #f8fafc;
      --surface: #ffffff;
      --surface-2: #f1f5f9;
      --border: #cbd5e1;
      --text: #0f172a;
      --muted: #475569;
      --accent: #4f46e5;
      --mod-bg: #eef2ff;
      --mod-stroke: #4f46e5;
      --ctrl-bg: #ecfdf5;
      --ctrl-stroke: #16a34a;
      --prov-bg: #f8fafc;
      --prov-stroke: #64748b;
      --req-bg: #fffbeb;
      --req-stroke: #d97706;
      --cycle-bg: #fef2f2;
      --cycle-stroke: #dc2626;
      --edge-import: #4f46e5;
      --edge-reexport: #7c3aed;
      --edge-owns: #94a3b8;
      --edge-inject: #0284c7;
      --edge-cycle: #dc2626;
      --shadow: 0 1px 3px rgba(15, 23, 42, 0.08);
    }
    @media (prefers-color-scheme: dark) {
      :root:not([data-theme="light"]) {
        --bg: #0b1120;
        --surface: #111827;
        --surface-2: #1e293b;
        --border: #334155;
        --text: #f1f5f9;
        --muted: #94a3b8;
        --accent: #818cf8;
        --mod-bg: #1e1b4b;
        --mod-stroke: #818cf8;
        --ctrl-bg: #052e16;
        --ctrl-stroke: #4ade80;
        --prov-bg: #1e293b;
        --prov-stroke: #94a3b8;
        --req-bg: #451a03;
        --req-stroke: #fbbf24;
        --cycle-bg: #450a0a;
        --cycle-stroke: #f87171;
        --edge-import: #818cf8;
        --edge-reexport: #c084fc;
        --edge-owns: #64748b;
        --edge-inject: #38bdf8;
        --edge-cycle: #ef4444;
        --shadow: 0 1px 4px rgba(0, 0, 0, 0.45);
      }
    }
    :root[data-theme="dark"] {
      --bg: #0b1120;
      --surface: #111827;
      --surface-2: #1e293b;
      --border: #334155;
      --text: #f1f5f9;
      --muted: #94a3b8;
      --accent: #818cf8;
      --mod-bg: #1e1b4b;
      --mod-stroke: #818cf8;
      --ctrl-bg: #052e16;
      --ctrl-stroke: #4ade80;
      --prov-bg: #1e293b;
      --prov-stroke: #94a3b8;
      --req-bg: #451a03;
      --req-stroke: #fbbf24;
      --cycle-bg: #450a0a;
      --cycle-stroke: #f87171;
      --edge-import: #818cf8;
      --edge-reexport: #c084fc;
      --edge-owns: #64748b;
      --edge-inject: #38bdf8;
      --edge-cycle: #ef4444;
      --shadow: 0 1px 4px rgba(0, 0, 0, 0.45);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.45;
    }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
    .small { font-size: 12px; }
    .muted { color: var(--muted); }
    header {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 12px 20px;
      background: var(--surface);
      border-bottom: 1px solid var(--border);
    }
    .brand { display: flex; align-items: center; gap: 10px; }
    .brand h1 { font-size: 17px; margin: 0; font-weight: 700; }
    .stats { display: flex; flex-wrap: wrap; gap: 8px; }
    .pill {
      font-size: 12px;
      padding: 3px 9px;
      border-radius: 999px;
      background: var(--surface-2);
      border: 1px solid var(--border);
    }
    .header-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
    .btn, a.btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 11px;
      font-size: 12px;
      font-weight: 600;
      color: var(--text);
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: 7px;
      text-decoration: none;
      cursor: pointer;
    }
    .btn:hover, a.btn:hover { border-color: var(--accent); }
    .toolbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 10px 20px;
      background: var(--surface);
      border-bottom: 1px solid var(--border);
    }
    .tabs { display: flex; gap: 6px; }
    .tab {
      padding: 6px 12px;
      font-size: 13px;
      font-weight: 600;
      border: 1px solid var(--border);
      background: transparent;
      color: var(--muted);
      border-radius: 8px;
      cursor: pointer;
    }
    .tab.active {
      background: var(--accent);
      border-color: var(--accent);
      color: #ffffff;
    }
    .filters { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
    input[type="search"], select {
      padding: 6px 10px;
      font-size: 13px;
      background: var(--bg);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 7px;
    }
    .check-label { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; cursor: pointer; }
    main { padding: 16px 20px; }
    .panel { display: none; }
    .panel.active { display: block; }
    .graph-grid {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 320px;
      gap: 16px;
      align-items: start;
    }
    @media (max-width: 960px) { .graph-grid { grid-template-columns: 1fr; } }
    .canvas-card, .details-card, .empty-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      box-shadow: var(--shadow);
    }
    .canvas-bar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 8px 12px;
      border-bottom: 1px solid var(--border);
      font-size: 12px;
    }
    .legend { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
    .legend-dot {
      display: inline-block;
      width: 10px;
      height: 10px;
      border-radius: 3px;
      margin-right: 4px;
      vertical-align: middle;
    }
    .svg-wrap {
      width: 100%;
      height: 620px;
      overflow: hidden;
      cursor: grab;
      user-select: none;
      background: var(--bg);
      border-radius: 0 0 12px 12px;
    }
    .svg-wrap.dragging { cursor: grabbing; }
    svg#devtools-svg { width: 100%; height: 100%; display: block; }
    .dg-col-hdr { fill: var(--muted); font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; }
    .dg-node { cursor: pointer; transition: opacity 0.15s ease; }
    .dg-node:focus { outline: none; }
    .dg-node-box { stroke-width: 1.8; }
    .dg-kind-module .dg-node-box { fill: var(--mod-bg); stroke: var(--mod-stroke); }
    .dg-kind-controller .dg-node-box { fill: var(--ctrl-bg); stroke: var(--ctrl-stroke); }
    .dg-kind-provider .dg-node-box { fill: var(--prov-bg); stroke: var(--prov-stroke); }
    .dg-scope-request .dg-node-box { fill: var(--req-bg); stroke: var(--req-stroke); stroke-width: 2.2; }
    .dg-cycle .dg-node-box { fill: var(--cycle-bg); stroke: var(--cycle-stroke); stroke-width: 2.6; }
    .dg-node.selected .dg-node-box { stroke-width: 3.2; filter: drop-shadow(0 0 6px rgba(79, 70, 229, 0.35)); }
    .dg-node.dimmed { opacity: 0.18; }
    .dg-node-title { fill: var(--text); font-size: 13px; font-weight: 700; }
    .dg-node-sub { fill: var(--muted); font-size: 11px; }
    .dg-edge { fill: none; stroke-width: 1.6; opacity: 0.72; transition: opacity 0.15s ease; }
    .dg-edge-import { stroke: var(--edge-import); }
    .dg-edge-re-export { stroke: var(--edge-reexport); stroke-dasharray: 5 4; }
    .dg-edge-provides, .dg-edge-controller { stroke: var(--edge-owns); stroke-dasharray: 4 3; }
    .dg-edge-provider-dependency { stroke: var(--edge-inject); }
    .dg-edge-cycle { stroke: var(--edge-cycle); stroke-width: 2.6; opacity: 1; }
    .dg-edge.dimmed { opacity: 0.08; }
    .dg-edge.highlighted { opacity: 1; stroke-width: 2.6; }
    .pill-danger { background: var(--cycle-bg); border-color: var(--cycle-stroke); color: var(--cycle-stroke); font-weight: 700; }
    .chip-danger { background: var(--cycle-bg); border-color: var(--cycle-stroke); color: var(--cycle-stroke); font-weight: 700; }
    .cycle-banner {
      margin-bottom: 12px;
      padding: 10px 14px;
      border-radius: 10px;
      background: var(--cycle-bg);
      border: 1px solid var(--cycle-stroke);
      color: var(--text);
      font-size: 13px;
    }
    .cycle-banner ul { margin: 6px 0 0; padding-left: 18px; }
    .cycle-banner li { margin: 3px 0; }
    .error-code {
      display: inline-block;
      padding: 2px 7px;
      border-radius: 6px;
      font-size: 11px;
      font-weight: 700;
      background: var(--cycle-bg);
      border: 1px solid var(--cycle-stroke);
      color: var(--cycle-stroke);
    }
    .error-fixes { margin: 0; padding-left: 16px; font-size: 12px; }
    .error-fixes li { margin: 2px 0; }
    .details-card { padding: 14px 16px; min-height: 280px; }
    .details-card h2 { margin: 0 0 10px; font-size: 15px; }
    .kv { margin: 8px 0; font-size: 13px; }
    .kv-label { display: block; font-size: 11px; font-weight: 700; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
    .chip-list { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 4px; }
    .chip {
      display: inline-block;
      padding: 2px 7px;
      font-size: 11px;
      border-radius: 6px;
      background: var(--surface-2);
      border: 1px solid var(--border);
    }
    .chip-meta { border-color: var(--accent); color: var(--accent); }
    .table-wrap {
      overflow-x: auto;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      box-shadow: var(--shadow);
    }
    .data-table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .data-table th, .data-table td { padding: 10px 12px; border-bottom: 1px solid var(--border); text-align: left; }
    .data-table th { background: var(--surface-2); font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); }
    .data-table tr:last-child td { border-bottom: none; }
    .empty-cell { text-align: center; color: var(--muted); padding: 24px; }
    .method-badge {
      display: inline-block;
      min-width: 54px;
      text-align: center;
      padding: 2px 7px;
      border-radius: 6px;
      font-size: 11px;
      font-weight: 700;
      color: #ffffff;
      background: #475569;
    }
    .method-get { background: #16a34a; }
    .method-post { background: #2563eb; }
    .method-put { background: #d97706; }
    .method-patch { background: #7c3aed; }
    .method-delete { background: #dc2626; }
    .profile-summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin-bottom: 16px; }
    .kpi { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; }
    .kpi-label { display: block; font-size: 11px; text-transform: uppercase; color: var(--muted); font-weight: 700; }
    .kpi-val { font-size: 16px; }
    .kind-pill {
      display: inline-block;
      padding: 2px 7px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 600;
      border: 1px solid var(--border);
    }
    .kind-module { background: var(--mod-bg); border-color: var(--mod-stroke); }
    .kind-controller { background: var(--ctrl-bg); border-color: var(--ctrl-stroke); }
    .kind-provider { background: var(--prov-bg); border-color: var(--prov-stroke); }
    .num { text-align: right; white-space: nowrap; }
    .bar-cell { width: 32%; min-width: 140px; }
    .bar-track { height: 10px; background: var(--surface-2); border-radius: 999px; overflow: hidden; }
    .bar-fill { height: 100%; background: var(--accent); border-radius: 999px; }
    .empty-card { padding: 24px; }
    .empty-card h3 { margin: 0 0 8px; font-size: 15px; }
    .empty-card p { margin: 0; font-size: 13px; color: var(--muted); }
    .hidden { display: none !important; }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <h1>${escapeHtml(title)}</h1>
      <div class="stats">
        <span class="pill">${graph.modules.length} module${graph.modules.length === 1 ? "" : "s"}</span>
        <span class="pill">${graph.controllers.length} controller${graph.controllers.length === 1 ? "" : "s"}</span>
        <span class="pill">${graph.providers.length} provider${graph.providers.length === 1 ? "" : "s"}</span>
        <span class="pill">${graph.routes.length} route${graph.routes.length === 1 ? "" : "s"}</span>
        ${cycles.length > 0 ? `<span class="pill pill-danger">${cycles.length} cycle${cycles.length === 1 ? "" : "s"}</span>` : ""}
        ${errors.length > 0 ? `<span class="pill pill-danger">${errors.length} error${errors.length === 1 ? "" : "s"}</span>` : ""}
        ${layout.bootProfile.length > 0 ? `<span class="pill">boot: ${escapeHtml(formatMs(totalBootMs))}</span>` : ""}
      </div>
    </div>
    <div class="header-actions">
      <a class="btn" href="${escapeHtml(`${basePath}/graph`)}" target="_blank" rel="noopener">Graph JSON</a>
      <a class="btn" href="${escapeHtml(`${basePath}/routes`)}" target="_blank" rel="noopener">Routes JSON</a>
      <a class="btn" href="${escapeHtml(`${basePath}/errors`)}" target="_blank" rel="noopener">Errors JSON</a>
      <a class="btn" href="${escapeHtml(`${basePath}/mermaid`)}" target="_blank" rel="noopener">Mermaid</a>
      <button type="button" class="btn" id="btn-theme">Toggle Theme</button>
    </div>
  </header>

  <div class="toolbar">
    <div class="tabs" role="tablist">
      <button type="button" class="tab active" data-tab="graph" role="tab" aria-selected="true">Dependency Graph</button>
      <button type="button" class="tab" data-tab="routes" role="tab" aria-selected="false">Routes (${graph.routes.length})</button>
      <button type="button" class="tab" data-tab="errors" role="tab" aria-selected="false">Errors (${errors.length})</button>
      <button type="button" class="tab" data-tab="profile" role="tab" aria-selected="false">Boot Profile (${layout.bootProfile.length})</button>
    </div>
    <div class="filters">
      <input type="search" id="search-input" placeholder="Filter nodes or routes…" aria-label="Filter nodes or routes" />
      <select id="module-filter" aria-label="Filter by module">
        <option value="">All modules</option>
        ${moduleFilterOptions}
      </select>
      <label class="check-label"><input type="checkbox" id="flt-module" checked /> Modules</label>
      <label class="check-label"><input type="checkbox" id="flt-controller" checked /> Controllers</label>
      <label class="check-label"><input type="checkbox" id="flt-provider" checked /> Providers</label>
      <label class="check-label"><input type="checkbox" id="flt-request-only" /> REQUEST only</label>
    </div>
  </div>

  <main>
    <section id="panel-graph" class="panel active">
      ${renderCyclesBanner(cycles)}
      <div class="graph-grid">
        <div class="canvas-card">
          <div class="canvas-bar">
            <div class="legend">
              <span><span class="legend-dot" style="background:var(--mod-stroke)"></span>Module</span>
              <span><span class="legend-dot" style="background:var(--ctrl-stroke)"></span>Controller</span>
              <span><span class="legend-dot" style="background:var(--prov-stroke)"></span>Provider</span>
              <span><span class="legend-dot" style="background:var(--req-stroke)"></span>REQUEST scope</span>
              <span><span class="legend-dot" style="background:var(--cycle-stroke)"></span>Cycle</span>
            </div>
            <div>
              <button type="button" class="btn" id="btn-zoom-in" title="Zoom in">+</button>
              <button type="button" class="btn" id="btn-zoom-out" title="Zoom out">−</button>
              <button type="button" class="btn" id="btn-zoom-reset" title="Reset view">Reset</button>
              <button type="button" class="btn" id="btn-download-svg" title="Download SVG">SVG</button>
            </div>
          </div>
          <div class="svg-wrap" id="svg-wrap">
            <svg id="devtools-svg" viewBox="0 0 ${layout.width} ${layout.height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Bunest application dependency graph">
              <defs>
                <marker id="arrow-import" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                  <path d="M 0 1 L 10 5 L 0 9 z" fill="var(--edge-import)" />
                </marker>
                <marker id="arrow-reexport" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                  <path d="M 0 1 L 10 5 L 0 9 z" fill="var(--edge-reexport)" />
                </marker>
                <marker id="arrow-owns" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                  <path d="M 0 1 L 10 5 L 0 9 z" fill="var(--edge-owns)" />
                </marker>
                <marker id="arrow-inject" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                  <path d="M 0 1 L 10 5 L 0 9 z" fill="var(--edge-inject)" />
                </marker>
                <marker id="arrow-cycle" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                  <path d="M 0 1 L 10 5 L 0 9 z" fill="var(--edge-cycle)" />
                </marker>
              </defs>
              <g id="dg-viewport">
                <text class="dg-col-hdr" x="40" y="28">Modules (${graph.modules.length})</text>
                <text class="dg-col-hdr" x="360" y="28">Controllers (${graph.controllers.length})</text>
                <text class="dg-col-hdr" x="680" y="28">Providers (${graph.providers.length})</text>
                <g id="dg-edges">${svgEdges}</g>
                <g id="dg-nodes">${svgNodes}</g>
              </g>
            </svg>
          </div>
        </div>

        <aside class="details-card" id="node-details">
          <h2>Node Details</h2>
          <p class="muted small">Click any module, controller, or provider node to inspect its scope, boot timing, and edges. Drag canvas to pan; scroll to zoom.</p>
        </aside>
      </div>
    </section>

    <section id="panel-routes" class="panel">
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr><th>Method</th><th>Path</th><th>Controller#Handler</th><th>Parameters</th><th>Enhancers</th><th>Meta</th></tr>
          </thead>
          <tbody id="routes-tbody">
            ${renderRoutesRows(graph.routes)}
          </tbody>
        </table>
      </div>
    </section>

    <section id="panel-errors" class="panel">
      ${renderErrorsSection(errors)}
    </section>

    <section id="panel-profile" class="panel">
      ${renderBootProfileSection(layout.bootProfile)}
    </section>
  </main>

  <script id="devtools-graph-data" type="application/json">${embeddedPayload}</script>
  <script>
    (function () {
      var dataEl = document.getElementById("devtools-graph-data");
      if (!dataEl) return;
      var payload = JSON.parse(dataEl.textContent || "{}");
      var nodes = Array.isArray(payload.nodes) ? payload.nodes : [];
      var edges = Array.isArray(payload.edges) ? payload.edges : [];
      var nodeMap = Object.create(null);
      for (var i = 0; i < nodes.length; i++) nodeMap[nodes[i].id] = nodes[i];

      var root = document.documentElement;
      var btnTheme = document.getElementById("btn-theme");
      if (btnTheme) {
        btnTheme.addEventListener("click", function () {
          var current = root.getAttribute("data-theme");
          var prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
          var next = current ? (current === "dark" ? "light" : "dark") : (prefersDark ? "light" : "dark");
          root.setAttribute("data-theme", next);
        });
      }

      var tabs = document.querySelectorAll(".tab");
      var panels = {
        graph: document.getElementById("panel-graph"),
        routes: document.getElementById("panel-routes"),
        errors: document.getElementById("panel-errors"),
        profile: document.getElementById("panel-profile")
      };
      tabs.forEach(function (tab) {
        tab.addEventListener("click", function () {
          var target = tab.getAttribute("data-tab");
          tabs.forEach(function (t) {
            var active = t === tab;
            t.classList.toggle("active", active);
            t.setAttribute("aria-selected", active ? "true" : "false");
          });
          Object.keys(panels).forEach(function (key) {
            if (panels[key]) panels[key].classList.toggle("active", key === target);
          });
        });
      });

      var viewport = document.getElementById("dg-viewport");
      var svgWrap = document.getElementById("svg-wrap");
      var svgEl = document.getElementById("devtools-svg");
      var scale = 1, panX = 0, panY = 0;
      var dragging = false, dragStartX = 0, dragStartY = 0;

      function applyTransform() {
        if (viewport) {
          viewport.setAttribute("transform", "translate(" + panX.toFixed(1) + "," + panY.toFixed(1) + ") scale(" + scale.toFixed(3) + ")");
        }
      }

      if (svgWrap) {
        svgWrap.addEventListener("pointerdown", function (ev) {
          if (ev.target && ev.target.closest && ev.target.closest(".dg-node")) return;
          dragging = true;
          dragStartX = ev.clientX - panX;
          dragStartY = ev.clientY - panY;
          svgWrap.classList.add("dragging");
        });
        window.addEventListener("pointermove", function (ev) {
          if (!dragging) return;
          panX = ev.clientX - dragStartX;
          panY = ev.clientY - dragStartY;
          applyTransform();
        });
        window.addEventListener("pointerup", function () {
          if (!dragging) return;
          dragging = false;
          svgWrap.classList.remove("dragging");
        });
        svgWrap.addEventListener("wheel", function (ev) {
          ev.preventDefault();
          var factor = ev.deltaY < 0 ? 1.12 : 0.89;
          scale = Math.max(0.25, Math.min(3.5, scale * factor));
          applyTransform();
        }, { passive: false });
      }

      var zoomIn = document.getElementById("btn-zoom-in");
      var zoomOut = document.getElementById("btn-zoom-out");
      var zoomReset = document.getElementById("btn-zoom-reset");
      if (zoomIn) zoomIn.addEventListener("click", function () { scale = Math.min(3.5, scale * 1.2); applyTransform(); });
      if (zoomOut) zoomOut.addEventListener("click", function () { scale = Math.max(0.25, scale / 1.2); applyTransform(); });
      if (zoomReset) zoomReset.addEventListener("click", function () { scale = 1; panX = 0; panY = 0; applyTransform(); });

      var downloadSvg = document.getElementById("btn-download-svg");
      if (downloadSvg && svgEl) {
        downloadSvg.addEventListener("click", function () {
          var blob = new Blob([svgEl.outerHTML], { type: "image/svg+xml;charset=utf-8" });
          var url = URL.createObjectURL(blob);
          var a = document.createElement("a");
          a.href = url;
          a.download = "bunest-devtools-graph.svg";
          document.body.appendChild(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(url);
        });
      }

      var detailsEl = document.getElementById("node-details");
      var nodeEls = document.querySelectorAll(".dg-node");
      var edgeEls = document.querySelectorAll(".dg-edge");
      var selectedId = null;

      function clearNode(el) {
        while (el.firstChild) el.removeChild(el.firstChild);
      }

      function appendKv(parent, label, value) {
        var box = document.createElement("div");
        box.className = "kv";
        var lbl = document.createElement("span");
        lbl.className = "kv-label";
        lbl.textContent = label;
        var val = document.createElement("div");
        val.className = "mono small";
        val.textContent = value;
        box.appendChild(lbl);
        box.appendChild(val);
        parent.appendChild(box);
      }

      function appendChips(parent, label, items) {
        if (!items || items.length === 0) return;
        var box = document.createElement("div");
        box.className = "kv";
        var lbl = document.createElement("span");
        lbl.className = "kv-label";
        lbl.textContent = label + " (" + items.length + ")";
        var list = document.createElement("div");
        list.className = "chip-list";
        for (var j = 0; j < items.length; j++) {
          var chip = document.createElement("span");
          chip.className = "chip mono";
          chip.textContent = items[j];
          list.appendChild(chip);
        }
        box.appendChild(lbl);
        box.appendChild(list);
        parent.appendChild(box);
      }

      function selectNode(id) {
        selectedId = selectedId === id ? null : id;
        var connected = Object.create(null);
        var outgoing = [];
        var incoming = [];

        if (selectedId) {
          connected[selectedId] = true;
          for (var eIdx = 0; eIdx < edges.length; eIdx++) {
            var e = edges[eIdx];
            if (e.from === selectedId) {
              connected[e.to] = true;
              outgoing.push((nodeMap[e.to] ? nodeMap[e.to].label : e.to) + " (" + e.type + ")");
            } else if (e.to === selectedId) {
              connected[e.from] = true;
              incoming.push((nodeMap[e.from] ? nodeMap[e.from].label : e.from) + " (" + e.type + ")");
            }
          }
        }

        nodeEls.forEach(function (el) {
          var nid = el.getAttribute("data-node-id");
          el.classList.toggle("selected", nid === selectedId);
          el.classList.toggle("dimmed", Boolean(selectedId && !connected[nid]));
        });
        edgeEls.forEach(function (el) {
          var f = el.getAttribute("data-from");
          var t = el.getAttribute("data-to");
          var hit = Boolean(selectedId && (f === selectedId || t === selectedId));
          el.classList.toggle("highlighted", hit);
          el.classList.toggle("dimmed", Boolean(selectedId && !hit));
        });

        if (!detailsEl) return;
        clearNode(detailsEl);
        var heading = document.createElement("h2");
        if (!selectedId || !nodeMap[selectedId]) {
          heading.textContent = "Node Details";
          detailsEl.appendChild(heading);
          var hint = document.createElement("p");
          hint.className = "muted small";
          hint.textContent = "Click any module, controller, or provider node to inspect its scope, boot timing, and edges.";
          detailsEl.appendChild(hint);
          return;
        }

        var n = nodeMap[selectedId];
        heading.textContent = n.label;
        detailsEl.appendChild(heading);
        appendKv(detailsEl, "Kind", n.kind);
        appendKv(detailsEl, "Module", n.moduleName || n.label);
        if (n.scope) appendKv(detailsEl, "Scope", n.scope);
        if (typeof n.initTimeMs === "number") appendKv(detailsEl, "Init Time (initTimeMs)", n.initTimeMs.toFixed(3) + " ms");
        if (n.flags && n.flags.length) appendChips(detailsEl, "Flags", n.flags);
        appendChips(detailsEl, "Outgoing", outgoing);
        appendChips(detailsEl, "Incoming", incoming);
      }

      nodeEls.forEach(function (el) {
        var nid = el.getAttribute("data-node-id");
        el.addEventListener("click", function () { if (nid) selectNode(nid); });
        el.addEventListener("keydown", function (ev) {
          if (ev.key === "Enter" || ev.key === " ") {
            ev.preventDefault();
            if (nid) selectNode(nid);
          }
        });
      });

      var searchInput = document.getElementById("search-input");
      var moduleSelect = document.getElementById("module-filter");
      var fltMod = document.getElementById("flt-module");
      var fltCtrl = document.getElementById("flt-controller");
      var fltProv = document.getElementById("flt-provider");
      var fltReq = document.getElementById("flt-request-only");
      var routeRows = document.querySelectorAll(".route-row");
      var errorRows = document.querySelectorAll(".error-row");

      function applyFilters() {
        var q = (searchInput && searchInput.value ? searchInput.value.trim().toLowerCase() : "");
        var modName = moduleSelect ? moduleSelect.value : "";
        var showKind = {
          module: !fltMod || fltMod.checked,
          controller: !fltCtrl || fltCtrl.checked,
          provider: !fltProv || fltProv.checked
        };
        var reqOnly = Boolean(fltReq && fltReq.checked);
        var visibleIds = Object.create(null);

        nodeEls.forEach(function (el) {
          var id = el.getAttribute("data-node-id") || "";
          var kind = el.getAttribute("data-kind") || "";
          var mod = el.getAttribute("data-module") || "";
          var label = (el.getAttribute("data-label") || "").toLowerCase();
          var scope = (el.getAttribute("data-scope") || "").toUpperCase();

          var visible = Boolean(showKind[kind]);
          if (visible && modName && mod !== modName) visible = false;
          if (visible && reqOnly && scope !== "REQUEST") visible = false;
          if (visible && q && label.indexOf(q) === -1 && mod.toLowerCase().indexOf(q) === -1 && scope.toLowerCase().indexOf(q) === -1) {
            visible = false;
          }
          el.classList.toggle("hidden", !visible);
          if (visible) visibleIds[id] = true;
        });

        edgeEls.forEach(function (el) {
          var f = el.getAttribute("data-from") || "";
          var t = el.getAttribute("data-to") || "";
          el.classList.toggle("hidden", !(visibleIds[f] && visibleIds[t]));
        });

        routeRows.forEach(function (row) {
          var hay = row.getAttribute("data-search") || "";
          row.classList.toggle("hidden", Boolean(q && hay.indexOf(q) === -1));
        });

        errorRows.forEach(function (row) {
          var hay = row.getAttribute("data-search") || "";
          row.classList.toggle("hidden", Boolean(q && hay.indexOf(q) === -1));
        });
      }

      [searchInput, moduleSelect, fltMod, fltCtrl, fltProv, fltReq].forEach(function (ctrl) {
        if (!ctrl) return;
        ctrl.addEventListener("input", applyFilters);
        ctrl.addEventListener("change", applyFilters);
      });
    })();
  </script>
</body>
</html>`;
}
