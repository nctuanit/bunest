import { relative, resolve } from "@bunest/core";
import {
  BunestStaticAnalyzer,
  buildStaticModuleGraph,
  type ProviderScope,
  type StaticModuleGraph,
  type StaticModuleNode,
  type StaticProviderNode,
} from "../analyzer";
import { loadBunestConfig } from "../config/bunest-config.loader";
import { loadCliConfiguration } from "../config/configuration.loader";
import type { CliIO } from "../types";

export type GraphOutputFormat = "mermaid" | "dot" | "json" | "html";

export interface GraphCommandOptions {
  readonly cwd?: string;
  readonly sourceRoot?: string;
  readonly tsconfig?: string;
  readonly config?: string;
  readonly format?: GraphOutputFormat;
  readonly module?: string;
  readonly cyclesOnly?: boolean;
  readonly silent?: boolean;
}

export interface StaticGraphModuleSummary {
  readonly name: string;
  readonly sourceFile: string;
  readonly isGlobal: boolean;
  readonly isAutoModule: boolean;
  readonly autoDiscover: boolean;
  readonly imports: readonly string[];
  readonly controllers: readonly string[];
  readonly providers: readonly string[];
  readonly exports: readonly string[];
}

export interface StaticGraphProviderSummary {
  readonly name: string;
  readonly kind: "provider" | "controller" | "repository";
  readonly scope: ProviderScope;
  readonly sourceFile: string;
  readonly dependencies: readonly string[];
}

export interface StaticGraphRouteSummary {
  readonly method: string;
  readonly path: string;
  readonly controller: string;
  readonly handler: string;
  readonly sourceFile: string;
}

export type StaticGraphEdgeKind =
  | "import"
  | "re-export"
  | "provides"
  | "controller"
  | "exports"
  | "injects";

export interface StaticGraphEdge {
  readonly from: string;
  readonly to: string;
  readonly fromKind: "module" | "provider";
  readonly toKind: "module" | "provider";
  readonly kind: StaticGraphEdgeKind;
}

export interface StaticGraphJsonOutput {
  readonly schemaVersion: "1.0";
  readonly rootDir: string;
  readonly filterModule?: string;
  readonly cyclesOnly?: boolean;
  readonly modules: readonly StaticGraphModuleSummary[];
  readonly providers: readonly StaticGraphProviderSummary[];
  readonly routes?: readonly StaticGraphRouteSummary[];
  readonly edges: readonly StaticGraphEdge[];
  readonly cycles: readonly (readonly string[])[];
  readonly moduleCycles?: readonly (readonly string[])[];
}

export interface GraphCommandResult {
  readonly exitCode: number;
  readonly format: GraphOutputFormat;
  readonly output: string;
  readonly graph?: StaticGraphJsonOutput;
  readonly error?: string;
  readonly durationMs: number;
}

function toRelPosix(cwd: string, filePath: string): string {
  const rel = relative(cwd, filePath).replace(/\\/g, "/");
  return rel || filePath.replace(/\\/g, "/");
}

function sanitizeMermaidId(prefix: string, raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_]/g, "_");
  return `${prefix}_${cleaned || "node"}`;
}

function escapeMermaidLabel(label: string): string {
  return label.replace(/"/g, "'").replace(/[\r\n]+/g, " ");
}

function escapeDotString(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, "\\n");
}

function collectFilteredSubset(
  moduleGraph: StaticModuleGraph,
  filterModule: string,
): {
  readonly modules: readonly StaticModuleNode[];
  readonly providers: readonly StaticProviderNode[];
} {
  const root = moduleGraph.moduleByName.get(filterModule);
  if (!root) {
    const available = moduleGraph.modules.map((m) => m.name).sort();
    const hint =
      available.length > 0
        ? `Available modules: ${available.join(", ")}.`
        : "No @Module() or @AutoModule() classes were found in this workspace.";
    throw new Error(`Module "${filterModule}" not found. ${hint}`);
  }

  // BFS over transitive module imports starting from filterModule
  const selectedModuleNames = new Set<string>([root.name]);
  const modQueue: StaticModuleNode[] = [root];
  while (modQueue.length > 0) {
    const mod = modQueue.shift()!;
    for (const impName of mod.imports) {
      const targetMod = moduleGraph.moduleByName.get(impName);
      if (targetMod && !selectedModuleNames.has(targetMod.name)) {
        selectedModuleNames.add(targetMod.name);
        modQueue.push(targetMod);
      }
    }
  }

  // Collect providers/controllers/repositories owned by the selected modules
  const selectedProviderNames = new Set<string>();
  const provQueue: StaticProviderNode[] = [];

  const enqueueProvider = (name: string): void => {
    const prov = moduleGraph.providerByName.get(name);
    if (prov && !selectedProviderNames.has(prov.name)) {
      selectedProviderNames.add(prov.name);
      provQueue.push(prov);
    }
  };

  for (const modName of selectedModuleNames) {
    const mod = moduleGraph.moduleByName.get(modName);
    if (!mod) continue;
    for (const name of [
      ...mod.controllers,
      ...mod.providers,
      ...mod.exports,
      ...mod.imports,
    ]) {
      enqueueProvider(name);
    }
  }

  // Include transitive DI dependencies (e.g. providers from @Global() modules)
  while (provQueue.length > 0) {
    const prov = provQueue.shift()!;
    for (const dep of prov.dependencies) {
      const targetName =
        dep.isForwardRef && dep.token ? dep.token : (dep.token ?? dep.typeName);
      enqueueProvider(targetName);
      enqueueProvider(dep.typeName);
    }
  }

  const modules = moduleGraph.modules.filter((m) =>
    selectedModuleNames.has(m.name),
  );
  const providers = moduleGraph.providers.filter((p) =>
    selectedProviderNames.has(p.name),
  );

  return { modules, providers };
}

/**
 * Converts a `StaticModuleGraph` into a normalized, serializable graph payload
 * (optionally filtered to a single `--module <Name>` subgraph or `--cycles-only`).
 */
export function buildStaticGraphOutput(
  moduleGraph: StaticModuleGraph,
  options: {
    readonly cwd: string;
    readonly filterModule?: string;
    readonly cyclesOnly?: boolean;
    readonly routes?: readonly StaticGraphRouteSummary[];
  },
): StaticGraphJsonOutput {
  const { modules: rawModules, providers: rawProviders } = options.filterModule
    ? collectFilteredSubset(moduleGraph, options.filterModule)
    : { modules: moduleGraph.modules, providers: moduleGraph.providers };

  const moduleSet = new Set(rawModules.map((m) => m.name));
  const providerSet = new Set(rawProviders.map((p) => p.name));

  const sortedModules = [...rawModules].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const sortedProviders = [...rawProviders].sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  let modules: StaticGraphModuleSummary[] = sortedModules.map((m) => ({
    name: m.name,
    sourceFile: toRelPosix(options.cwd, m.sourceFile),
    isGlobal: m.isGlobal,
    isAutoModule: m.isAutoModule ?? m.autoDiscover,
    autoDiscover: m.autoDiscover,
    imports: [...m.imports],
    controllers: [...m.controllers],
    providers: [...m.providers],
    exports: [...m.exports],
  }));

  let providers: StaticGraphProviderSummary[] = sortedProviders.map((p) => {
    const deps = new Set<string>();
    for (const dep of p.dependencies) {
      const candidate =
        dep.isForwardRef && dep.token ? dep.token : (dep.token ?? dep.typeName);
      if (providerSet.has(candidate)) {
        deps.add(candidate);
      } else if (providerSet.has(dep.typeName)) {
        deps.add(dep.typeName);
      }
    }
    return {
      name: p.name,
      kind: p.kind,
      scope: p.scope,
      sourceFile: toRelPosix(options.cwd, p.sourceFile),
      dependencies: [...deps].sort(),
    };
  });

  let edges: StaticGraphEdge[] = [];
  const seenEdges = new Set<string>();
  const addEdge = (edge: StaticGraphEdge): void => {
    const key = `${edge.fromKind}:${edge.from}|${edge.kind}|${edge.toKind}:${edge.to}`;
    if (seenEdges.has(key)) return;
    seenEdges.add(key);
    edges.push(edge);
  };

  for (const mod of sortedModules) {
    for (const imp of mod.imports) {
      if (moduleSet.has(imp)) {
        addEdge({
          from: mod.name,
          to: imp,
          fromKind: "module",
          toKind: "module",
          kind: "import",
        });
      } else if (providerSet.has(imp)) {
        addEdge({
          from: mod.name,
          to: imp,
          fromKind: "module",
          toKind: "provider",
          kind: "provides",
        });
      }
    }

    for (const ctrl of mod.controllers) {
      if (providerSet.has(ctrl)) {
        addEdge({
          from: mod.name,
          to: ctrl,
          fromKind: "module",
          toKind: "provider",
          kind: "controller",
        });
      }
    }

    for (const provName of mod.providers) {
      if (providerSet.has(provName)) {
        addEdge({
          from: mod.name,
          to: provName,
          fromKind: "module",
          toKind: "provider",
          kind: "provides",
        });
      }
    }

    for (const exp of mod.exports) {
      if (moduleSet.has(exp)) {
        addEdge({
          from: mod.name,
          to: exp,
          fromKind: "module",
          toKind: "module",
          kind: "re-export",
        });
      } else if (providerSet.has(exp)) {
        addEdge({
          from: mod.name,
          to: exp,
          fromKind: "module",
          toKind: "provider",
          kind: "exports",
        });
      }
    }
  }

  for (const prov of providers) {
    for (const depName of prov.dependencies) {
      if (depName === prov.name) continue;
      addEdge({
        from: prov.name,
        to: depName,
        fromKind: "provider",
        toKind: "provider",
        kind: "injects",
      });
    }
  }

  const cycles = moduleGraph.cycles.filter((cycle) =>
    cycle.some((node) => providerSet.has(node)),
  );
  const moduleCycles = (moduleGraph.moduleCycles ?? []).filter((cycle) =>
    cycle.some((node) => moduleSet.has(node)),
  );

  let routes: StaticGraphRouteSummary[] | undefined = options.routes
    ? options.routes
        .filter((r) => providerSet.has(r.controller))
        .map((r) => ({
          method: r.method,
          path: r.path,
          controller: r.controller,
          handler: r.handler,
          sourceFile: toRelPosix(options.cwd, r.sourceFile),
        }))
    : undefined;

  if (options.cyclesOnly) {
    const cyclicProvNames = new Set<string>();
    const cyclicProvEdges = new Set<string>();
    for (const cycle of cycles) {
      for (let i = 0; i < cycle.length; i++) {
        cyclicProvNames.add(cycle[i]!);
        if (i + 1 < cycle.length) {
          cyclicProvEdges.add(`${cycle[i]!}->${cycle[i + 1]!}`);
        }
      }
    }

    const cyclicModNames = new Set<string>();
    const cyclicModEdges = new Set<string>();
    for (const cycle of moduleCycles) {
      for (let i = 0; i < cycle.length; i++) {
        cyclicModNames.add(cycle[i]!);
        if (i + 1 < cycle.length) {
          cyclicModEdges.add(`${cycle[i]!}->${cycle[i + 1]!}`);
        }
      }
    }

    modules = modules.filter((m) => cyclicModNames.has(m.name));
    providers = providers.filter((p) => cyclicProvNames.has(p.name));
    edges = edges.filter((e) => {
      if (e.fromKind === "provider" && e.toKind === "provider" && e.kind === "injects") {
        return cyclicProvEdges.has(`${e.from}->${e.to}`);
      }
      if (e.fromKind === "module" && e.toKind === "module" && e.kind === "import") {
        return cyclicModEdges.has(`${e.from}->${e.to}`);
      }
      return false;
    });
    if (routes) {
      routes = routes.filter((r) => cyclicProvNames.has(r.controller));
    }
  }

  return {
    schemaVersion: "1.0",
    rootDir: options.cwd.replace(/\\/g, "/"),
    ...(options.filterModule ? { filterModule: options.filterModule } : {}),
    ...(options.cyclesOnly ? { cyclesOnly: true } : {}),
    modules,
    providers,
    ...(routes && routes.length > 0 ? { routes } : {}),
    edges,
    cycles,
    moduleCycles,
  };
}

/**
 * Formats a `StaticGraphJsonOutput` as a Mermaid `flowchart LR` diagram.
 */
export function formatStaticGraphMermaid(graph: StaticGraphJsonOutput): string {
  const lines: string[] = ["flowchart LR"];

  const modIds = new Map<string, string>();
  const provIds = new Map<string, string>();

  for (const mod of graph.modules) {
    const id = sanitizeMermaidId("M", mod.name);
    modIds.set(mod.name, id);
    const badges: string[] = [];
    if (mod.isGlobal) badges.push("global");
    if (mod.isAutoModule) badges.push("auto");
    const label = badges.length > 0 ? `${mod.name} (${badges.join(", ")})` : mod.name;
    lines.push(`  ${id}[["${escapeMermaidLabel(label)}"]]:::module`);
  }

  for (const prov of graph.providers) {
    const prefix =
      prov.kind === "controller"
        ? "C"
        : prov.kind === "repository"
          ? "R"
          : "P";
    const id = sanitizeMermaidId(prefix, prov.name);
    provIds.set(prov.name, id);
    const scopeLabel = prov.scope;
    const styleClass =
      prov.scope === "REQUEST"
        ? "request"
        : prov.kind === "controller"
          ? "controller"
          : prov.kind === "repository"
            ? "repository"
            : "provider";
    if (prov.kind === "controller") {
      lines.push(
        `  ${id}(["${escapeMermaidLabel(`${prov.name} (controller, ${scopeLabel})`)}"]):::${styleClass}`,
      );
    } else if (prov.kind === "repository") {
      lines.push(
        `  ${id}[("${escapeMermaidLabel(`${prov.name} (repository, ${scopeLabel})`)}")]:::${styleClass}`,
      );
    } else {
      lines.push(
        `  ${id}["${escapeMermaidLabel(`${prov.name} (${scopeLabel})`)}"]:::${styleClass}`,
      );
    }
  }

  for (const edge of graph.edges) {
    const fromId =
      edge.fromKind === "module" ? modIds.get(edge.from) : provIds.get(edge.from);
    const toId =
      edge.toKind === "module" ? modIds.get(edge.to) : provIds.get(edge.to);
    if (!fromId || !toId) continue;

    switch (edge.kind) {
      case "import":
        lines.push(`  ${fromId} -->|imports| ${toId}`);
        break;
      case "re-export":
        lines.push(`  ${fromId} -.->|re-exports| ${toId}`);
        break;
      case "controller":
        lines.push(`  ${fromId} -.->|controller| ${toId}`);
        break;
      case "provides":
        lines.push(`  ${fromId} -.->|provides| ${toId}`);
        break;
      case "exports":
        lines.push(`  ${fromId} -.->|exports| ${toId}`);
        break;
      case "injects":
        lines.push(`  ${fromId} -->|injects| ${toId}`);
        break;
    }
  }

  if (graph.modules.length > 0 || graph.providers.length > 0) {
    lines.push("  classDef module fill:#e0e7ff,stroke:#4f46e5,color:#1e1b4b");
    lines.push("  classDef controller fill:#dcfce7,stroke:#16a34a,color:#14532d");
    lines.push("  classDef provider fill:#f1f5f9,stroke:#64748b,color:#0f172a");
    lines.push("  classDef repository fill:#fce7f3,stroke:#db2777,color:#831843");
    lines.push("  classDef request fill:#fef3c7,stroke:#d97706,color:#78350f");
  }

  return lines.join("\n");
}

/**
 * Formats a `StaticGraphJsonOutput` as a Graphviz DOT `digraph`.
 */
export function formatStaticGraphDot(graph: StaticGraphJsonOutput): string {
  const lines: string[] = [
    "digraph BunestGraph {",
    "  rankdir=LR;",
    '  node [fontname="Helvetica", fontsize=11];',
    '  edge [fontname="Helvetica", fontsize=9];',
  ];

  for (const mod of graph.modules) {
    const badges: string[] = [];
    if (mod.isGlobal) badges.push("global");
    if (mod.isAutoModule) badges.push("auto");
    const label = badges.length > 0 ? `${mod.name}\n(${badges.join(", ")})` : mod.name;
    lines.push(
      `  "mod:${escapeDotString(mod.name)}" [label="${escapeDotString(label)}", shape=folder, style=filled, fillcolor="#e0e7ff", color="#4f46e5"];`,
    );
  }

  for (const prov of graph.providers) {
    const shape =
      prov.kind === "controller"
        ? "component"
        : prov.kind === "repository"
          ? "cylinder"
          : "box";
    const fill =
      prov.scope === "REQUEST"
        ? "#fef3c7"
        : prov.kind === "controller"
          ? "#dcfce7"
          : prov.kind === "repository"
            ? "#fce7f3"
            : "#f1f5f9";
    const stroke =
      prov.scope === "REQUEST"
        ? "#d97706"
        : prov.kind === "controller"
          ? "#16a34a"
          : prov.kind === "repository"
            ? "#db2777"
            : "#64748b";
    const label = `${prov.name}\n(${prov.kind}, ${prov.scope})`;
    lines.push(
      `  "prov:${escapeDotString(prov.name)}" [label="${escapeDotString(label)}", shape=${shape}, style=filled, fillcolor="${fill}", color="${stroke}"];`,
    );
  }

  for (const edge of graph.edges) {
    const fromId = `${edge.fromKind === "module" ? "mod" : "prov"}:${escapeDotString(edge.from)}`;
    const toId = `${edge.toKind === "module" ? "mod" : "prov"}:${escapeDotString(edge.to)}`;
    const dashed =
      edge.kind === "provides" ||
      edge.kind === "controller" ||
      edge.kind === "exports" ||
      edge.kind === "re-export";
    const attrs = dashed
      ? `label="${edge.kind}", style=dashed`
      : `label="${edge.kind}"`;
    lines.push(`  "${fromId}" -> "${toId}" [${attrs}];`);
  }

  lines.push("}");
  return lines.join("\n");
}

/**
 * Formats a `StaticGraphJsonOutput` as pretty-printed JSON.
 */
export function formatStaticGraphJson(graph: StaticGraphJsonOutput): string {
  return JSON.stringify(graph, null, 2);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeJsonEmbed(data: unknown): string {
  return JSON.stringify(data)
    .replace(/<\//g, "<\\/")
    .replace(/<!--/g, "<\\!--")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function truncateLabel(value: string, maxLen: number): string {
  if (value.length <= maxLen) return value;
  return `${value.slice(0, Math.max(1, maxLen - 1))}…`;
}

interface HtmlGraphNode {
  readonly id: string;
  readonly name: string;
  readonly kind: "module" | "controller" | "provider" | "repository";
  readonly subtitle: string;
  readonly scope?: string;
  readonly sourceFile: string;
  readonly modules: readonly string[];
  readonly isCyclic: boolean;
  readonly cycleCodes: readonly string[];
  readonly details: Readonly<Record<string, unknown>>;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface HtmlGraphEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly kind: StaticGraphEdgeKind;
  readonly isCyclic: boolean;
}

function buildHtmlEdgePath(from: HtmlGraphNode, to: HtmlGraphNode): string {
  if (from.x === to.x) {
    const isLeftCol = from.kind === "module";
    const x = isLeftCol ? from.x : from.x + from.width;
    const y1 = from.y + from.height / 2;
    const y2 = to.y + to.height / 2;
    const dy = Math.abs(y2 - y1);
    const bulge = Math.min(120, 38 + dy * 0.24);
    const cx = isLeftCol ? x - bulge : x + bulge;
    return `M ${x} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x} ${y2}`;
  }
  const leftToRight = from.x < to.x;
  const x1 = leftToRight ? from.x + from.width : from.x;
  const y1 = from.y + from.height / 2;
  const x2 = leftToRight ? to.x : to.x + to.width;
  const y2 = to.y + to.height / 2;
  const dx = Math.abs(x2 - x1);
  const offset = Math.max(46, dx * 0.44);
  const cx1 = leftToRight ? x1 + offset : x1 - offset;
  const cx2 = leftToRight ? x2 - offset : x2 + offset;
  return `M ${x1} ${y1} C ${cx1} ${y1}, ${cx2} ${y2}, ${x2} ${y2}`;
}

/**
 * Formats a `StaticGraphJsonOutput` as a completely self-contained, zero-CDN,
 * offline interactive HTML/SVG DI graph viewer with pan/zoom, search/filter,
 * click-to-inspect details, and red highlighting of circular cycles (BUNEST002 / BUNEST010).
 */
export function formatStaticGraphHtml(graph: StaticGraphJsonOutput): string {
  const providerCycles = graph.cycles ?? [];
  const moduleCycles = graph.moduleCycles ?? [];
  const routes = graph.routes ?? [];

  const cyclicModNames = new Set<string>();
  const cyclicModEdges = new Set<string>();
  for (const cycle of moduleCycles) {
    for (let i = 0; i < cycle.length; i++) {
      cyclicModNames.add(cycle[i]!);
      if (i + 1 < cycle.length) {
        cyclicModEdges.add(`${cycle[i]!}->${cycle[i + 1]!}`);
      }
    }
  }

  const cyclicProvNames = new Set<string>();
  const cyclicProvEdges = new Set<string>();
  for (const cycle of providerCycles) {
    for (let i = 0; i < cycle.length; i++) {
      cyclicProvNames.add(cycle[i]!);
      if (i + 1 < cycle.length) {
        cyclicProvEdges.add(`${cycle[i]!}->${cycle[i + 1]!}`);
      }
    }
  }

  // Map provider/controller -> declaring modules & routes
  const ownersByProv = new Map<string, string[]>();
  for (const mod of graph.modules) {
    for (const member of [...mod.controllers, ...mod.providers]) {
      const list = ownersByProv.get(member) ?? [];
      if (!list.includes(mod.name)) list.push(mod.name);
      ownersByProv.set(member, list);
    }
  }

  const routesByCtrl = new Map<string, StaticGraphRouteSummary[]>();
  for (const r of routes) {
    const list = routesByCtrl.get(r.controller) ?? [];
    list.push(r);
    routesByCtrl.set(r.controller, list);
  }

  const dependentsByProv = new Map<string, string[]>();
  for (const p of graph.providers) {
    for (const dep of p.dependencies) {
      const list = dependentsByProv.get(dep) ?? [];
      if (!list.includes(p.name)) list.push(p.name);
      dependentsByProv.set(dep, list);
    }
  }

  const controllers = graph.providers.filter((p) => p.kind === "controller");
  const serviceProviders = graph.providers.filter((p) => p.kind !== "controller");

  const modW = 248;
  const ctrlW = 248;
  const provW = 264;
  const nodeH = 66;
  const gapY = 22;
  const startY = 56;
  const colX = {
    module: 96,
    controller: 428,
    provider: 760,
  };

  const nodes: HtmlGraphNode[] = [];
  const nodeById = new Map<string, HtmlGraphNode>();

  graph.modules.forEach((mod, idx) => {
    const id = `mod:${mod.name}`;
    const isCyclic = cyclicModNames.has(mod.name);
    const flags: string[] = [];
    if (mod.isGlobal) flags.push("global");
    if (mod.isAutoModule) flags.push("auto");
    if (isCyclic) flags.push("CYCLE");
    const modRoutes = mod.controllers.flatMap((c) => routesByCtrl.get(c) ?? []);
    const subtitle = [
      flags.length > 0 ? flags.join(", ") : "module",
      `${mod.providers.length}p/${mod.controllers.length}c`,
      ...(modRoutes.length > 0 ? [`${modRoutes.length}r`] : []),
    ].join(" · ");

    const relatedCycles = moduleCycles
      .filter((c) => c.includes(mod.name))
      .map((c) => `BUNEST010: ${c.join(" -> ")}`);

    const node: HtmlGraphNode = {
      id,
      name: mod.name,
      kind: "module",
      subtitle,
      sourceFile: mod.sourceFile,
      modules: [mod.name],
      isCyclic,
      cycleCodes: isCyclic ? ["BUNEST010"] : [],
      details: {
        sourceFile: mod.sourceFile,
        isGlobal: mod.isGlobal,
        isAutoModule: mod.isAutoModule,
        imports: mod.imports,
        exports: mod.exports,
        providers: mod.providers,
        controllers: mod.controllers,
        routes: modRoutes.map((r) => `${r.method} ${r.path} (${r.controller}#${r.handler})`),
        cycles: relatedCycles,
      },
      x: colX.module,
      y: startY + idx * (nodeH + gapY),
      width: modW,
      height: nodeH,
    };
    nodes.push(node);
    nodeById.set(id, node);
  });

  controllers.forEach((ctrl, idx) => {
    const id = `prov:${ctrl.name}`;
    const isCyclic = cyclicProvNames.has(ctrl.name);
    const ctrlRoutes = routesByCtrl.get(ctrl.name) ?? [];
    const owners = ownersByProv.get(ctrl.name) ?? [];
    const subtitle = [
      ctrl.scope,
      `${ctrlRoutes.length} route${ctrlRoutes.length === 1 ? "" : "s"}`,
      ...(isCyclic ? ["CYCLE"] : []),
    ].join(" · ");
    const relatedCycles = providerCycles
      .filter((c) => c.includes(ctrl.name))
      .map((c) => `BUNEST002: ${c.join(" -> ")}`);

    const node: HtmlGraphNode = {
      id,
      name: ctrl.name,
      kind: "controller",
      subtitle,
      scope: ctrl.scope,
      sourceFile: ctrl.sourceFile,
      modules: owners,
      isCyclic,
      cycleCodes: isCyclic ? ["BUNEST002"] : [],
      details: {
        sourceFile: ctrl.sourceFile,
        scope: ctrl.scope,
        modules: owners,
        dependencies: ctrl.dependencies,
        routes: ctrlRoutes.map((r) => `${r.method} ${r.path} -> ${r.handler}()`),
        cycles: relatedCycles,
      },
      x: colX.controller,
      y: startY + idx * (nodeH + gapY),
      width: ctrlW,
      height: nodeH,
    };
    nodes.push(node);
    nodeById.set(id, node);
  });

  serviceProviders.forEach((prov, idx) => {
    const id = `prov:${prov.name}`;
    const isCyclic = cyclicProvNames.has(prov.name);
    const owners = ownersByProv.get(prov.name) ?? [];
    const dependents = dependentsByProv.get(prov.name) ?? [];
    const subtitle = [
      prov.kind,
      prov.scope,
      ...(isCyclic ? ["CYCLE"] : []),
    ].join(" · ");
    const relatedCycles = providerCycles
      .filter((c) => c.includes(prov.name))
      .map((c) => `BUNEST002: ${c.join(" -> ")}`);

    const node: HtmlGraphNode = {
      id,
      name: prov.name,
      kind: prov.kind,
      subtitle,
      scope: prov.scope,
      sourceFile: prov.sourceFile,
      modules: owners,
      isCyclic,
      cycleCodes: isCyclic ? ["BUNEST002"] : [],
      details: {
        sourceFile: prov.sourceFile,
        kind: prov.kind,
        scope: prov.scope,
        modules: owners,
        dependencies: prov.dependencies,
        dependedOnBy: dependents,
        cycles: relatedCycles,
      },
      x: colX.provider,
      y: startY + idx * (nodeH + gapY),
      width: provW,
      height: nodeH,
    };
    nodes.push(node);
    nodeById.set(id, node);
  });

  const htmlEdges: HtmlGraphEdge[] = [];
  graph.edges.forEach((edge, idx) => {
    const fromId = `${edge.fromKind === "module" ? "mod" : "prov"}:${edge.from}`;
    const toId = `${edge.toKind === "module" ? "mod" : "prov"}:${edge.to}`;
    if (!nodeById.has(fromId) || !nodeById.has(toId)) return;
    const isCyclic =
      (edge.fromKind === "module" &&
        edge.toKind === "module" &&
        edge.kind === "import" &&
        cyclicModEdges.has(`${edge.from}->${edge.to}`)) ||
      (edge.fromKind === "provider" &&
        edge.toKind === "provider" &&
        edge.kind === "injects" &&
        cyclicProvEdges.has(`${edge.from}->${edge.to}`));
    htmlEdges.push({
      id: `e${idx}`,
      from: fromId,
      to: toId,
      kind: edge.kind,
      isCyclic,
    });
  });

  const maxRows = Math.max(
    graph.modules.length,
    controllers.length,
    serviceProviders.length,
    1,
  );
  const svgWidth = 1160;
  const svgHeight = Math.max(460, startY + maxRows * (nodeH + gapY) + 56);
  const totalCycles = providerCycles.length + moduleCycles.length;

  const svgEdgesMarkup = htmlEdges
    .map((edge) => {
      const from = nodeById.get(edge.from)!;
      const to = nodeById.get(edge.to)!;
      const d = buildHtmlEdgePath(from, to);
      const marker = edge.isCyclic
        ? "url(#arrow-cycle)"
        : edge.kind === "import"
          ? "url(#arrow-import)"
          : edge.kind === "re-export"
            ? "url(#arrow-reexport)"
            : edge.kind === "injects"
              ? "url(#arrow-inject)"
              : "url(#arrow-owns)";
      const cycleCls = edge.isCyclic ? " dg-edge-cycle" : "";
      return `<path class="dg-edge dg-edge-${escapeHtml(edge.kind)}${cycleCls}" data-edge-id="${escapeHtml(edge.id)}" data-edge-kind="${escapeHtml(edge.kind)}" data-from="${escapeHtml(edge.from)}" data-to="${escapeHtml(edge.to)}" data-cyclic="${edge.isCyclic ? "true" : "false"}" d="${d}" marker-end="${marker}" />`;
    })
    .join("\n");

  const svgNodesMarkup = nodes
    .map((node) => {
      const scopeCls =
        node.scope === "REQUEST"
          ? " dg-scope-request"
          : node.scope === "TRANSIENT"
            ? " dg-scope-transient"
            : "";
      const cycleCls = node.isCyclic ? " dg-cycle-node" : "";
      const cycleBadge = node.isCyclic
        ? `<rect class="dg-cycle-badge" x="${node.width - 56}" y="8" width="46" height="16" rx="4" /><text class="dg-cycle-badge-text" x="${node.width - 33}" y="19" text-anchor="middle">CYCLE</text>`
        : "";
      return `<g class="dg-node dg-kind-${escapeHtml(node.kind)}${scopeCls}${cycleCls}" data-node-id="${escapeHtml(node.id)}" data-kind="${escapeHtml(node.kind)}" data-name="${escapeHtml(node.name)}" data-modules="${escapeHtml(node.modules.join(","))}" data-cyclic="${node.isCyclic ? "true" : "false"}" transform="translate(${node.x}, ${node.y})" tabindex="0" role="button" aria-label="${escapeHtml(`${node.kind} ${node.name}`)}">
        <rect class="dg-node-box" width="${node.width}" height="${node.height}" rx="10" ry="10" />
        ${cycleBadge}
        <text class="dg-node-title" x="14" y="27">${escapeHtml(truncateLabel(node.name, node.isCyclic ? 20 : 27))}</text>
        <text class="dg-node-sub" x="14" y="48">${escapeHtml(truncateLabel(node.subtitle, 34))}</text>
      </g>`;
    })
    .join("\n");

  const moduleOptionsMarkup = graph.modules
    .map(
      (m) =>
        `<option value="${escapeHtml(m.name)}">${escapeHtml(m.name)}</option>`,
    )
    .join("");

  const cycleItemsMarkup = [
    ...moduleCycles.map(
      (c) =>
        `<button type="button" class="cycle-chip" data-cycle-nodes="${escapeHtml(c.map((n) => `mod:${n}`).join(","))}"><strong>BUNEST010</strong> Module cycle: <span class="mono">${escapeHtml(c.join(" -> "))}</span></button>`,
    ),
    ...providerCycles.map(
      (c) =>
        `<button type="button" class="cycle-chip" data-cycle-nodes="${escapeHtml(c.map((n) => `prov:${n}`).join(","))}"><strong>BUNEST002</strong> DI cycle: <span class="mono">${escapeHtml(c.join(" -> "))}</span></button>`,
    ),
  ].join("\n");

  const cycleBannerMarkup =
    totalCycles > 0
      ? `<section class="cycle-banner" role="alert" aria-label="Circular dependencies detected">
          <div class="cycle-banner-title">Circular dependencies detected (${totalCycles})</div>
          <div class="cycle-list">${cycleItemsMarkup}</div>
        </section>`
      : "";

  const embeddedData = safeJsonEmbed({
    rootDir: graph.rootDir,
    filterModule: graph.filterModule ?? null,
    nodes,
    edges: htmlEdges,
    cycles: providerCycles,
    moduleCycles,
    routes,
  });

  const title = graph.filterModule
    ? `Bunest DI Graph — ${graph.filterModule}`
    : "Bunest Static DI Graph";

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
      --repo-bg: #fdf2f8;
      --repo-stroke: #db2777;
      --req-bg: #fffbeb;
      --req-stroke: #d97706;
      --cycle-bg: #fef2f2;
      --cycle-stroke: #dc2626;
      --cycle-text: #991b1b;
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
        --repo-bg: #500724;
        --repo-stroke: #f472b6;
        --req-bg: #451a03;
        --req-stroke: #fbbf24;
        --cycle-bg: #450a0a;
        --cycle-stroke: #ef4444;
        --cycle-text: #fecaca;
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
      --repo-bg: #500724;
      --repo-stroke: #f472b6;
      --req-bg: #451a03;
      --req-stroke: #fbbf24;
      --cycle-bg: #450a0a;
      --cycle-stroke: #ef4444;
      --cycle-text: #fecaca;
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
    .pill-cycle {
      background: var(--cycle-bg);
      border-color: var(--cycle-stroke);
      color: var(--cycle-text);
      font-weight: 700;
    }
    .toolbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 10px 20px;
      background: var(--surface);
      border-bottom: 1px solid var(--border);
    }
    .filters, .zoom-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
    input[type="search"], select {
      padding: 6px 10px;
      font-size: 13px;
      background: var(--bg);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 7px;
    }
    .btn {
      padding: 6px 10px;
      font-size: 12px;
      font-weight: 600;
      color: var(--text);
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: 7px;
      cursor: pointer;
    }
    .btn:hover { border-color: var(--accent); }
    .check-label { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; cursor: pointer; }
    .cycle-banner {
      margin: 12px 20px 0;
      padding: 10px 14px;
      background: var(--cycle-bg);
      border: 1px solid var(--cycle-stroke);
      border-radius: 10px;
      color: var(--cycle-text);
    }
    .cycle-banner-title { font-weight: 700; font-size: 13px; margin-bottom: 6px; }
    .cycle-list { display: flex; flex-wrap: wrap; gap: 6px; }
    .cycle-chip {
      background: var(--surface);
      color: var(--cycle-text);
      border: 1px solid var(--cycle-stroke);
      border-radius: 6px;
      padding: 4px 8px;
      font-size: 12px;
      cursor: pointer;
    }
    .cycle-chip:hover { opacity: 0.9; }
    main {
      padding: 16px 20px;
      display: grid;
      grid-template-columns: minmax(0, 1fr) 340px;
      gap: 16px;
      align-items: start;
    }
    @media (max-width: 960px) { main { grid-template-columns: 1fr; } }
    .canvas-card, .inspector-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      box-shadow: var(--shadow);
    }
    .canvas-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 12px;
      border-bottom: 1px solid var(--border);
      font-size: 12px;
      color: var(--muted);
    }
    .legend { display: flex; flex-wrap: wrap; gap: 10px; }
    .legend-item { display: inline-flex; align-items: center; gap: 5px; }
    .dot { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }
    .canvas-wrap {
      width: 100%;
      height: 70vh;
      min-height: 440px;
      overflow: hidden;
      cursor: grab;
      user-select: none;
      position: relative;
    }
    .canvas-wrap.panning { cursor: grabbing; }
    svg#di-svg { width: 100%; height: 100%; display: block; }
    .col-heading {
      fill: var(--muted);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .dg-node { cursor: pointer; transition: opacity 0.15s ease; }
    .dg-node-box { stroke-width: 1.8; }
    .dg-kind-module .dg-node-box { fill: var(--mod-bg); stroke: var(--mod-stroke); }
    .dg-kind-controller .dg-node-box { fill: var(--ctrl-bg); stroke: var(--ctrl-stroke); }
    .dg-kind-provider .dg-node-box { fill: var(--prov-bg); stroke: var(--prov-stroke); }
    .dg-kind-repository .dg-node-box { fill: var(--repo-bg); stroke: var(--repo-stroke); }
    .dg-scope-request .dg-node-box { fill: var(--req-bg); stroke: var(--req-stroke); }
    .dg-cycle-node .dg-node-box {
      fill: var(--cycle-bg);
      stroke: var(--cycle-stroke);
      stroke-width: 2.6;
    }
    .dg-node.selected .dg-node-box { stroke-width: 3.2; filter: drop-shadow(0 0 6px rgba(79, 70, 229, 0.35)); }
    .dg-node.dimmed { opacity: 0.16; }
    .dg-node-title { fill: var(--text); font-size: 13px; font-weight: 700; }
    .dg-node-sub { fill: var(--muted); font-size: 11px; }
    .dg-cycle-badge { fill: var(--cycle-stroke); }
    .dg-cycle-badge-text { fill: #ffffff; font-size: 9px; font-weight: 700; letter-spacing: 0.05em; }
    .dg-edge { fill: none; stroke-width: 1.6; opacity: 0.72; transition: opacity 0.15s ease; }
    .dg-edge-import { stroke: var(--edge-import); }
    .dg-edge-re-export { stroke: var(--edge-reexport); stroke-dasharray: 5 4; }
    .dg-edge-provides, .dg-edge-controller, .dg-edge-exports { stroke: var(--edge-owns); stroke-dasharray: 4 3; }
    .dg-edge-injects { stroke: var(--edge-inject); }
    .dg-edge-cycle {
      stroke: var(--edge-cycle);
      stroke-width: 2.8;
      opacity: 0.98;
      stroke-dasharray: 7 4;
    }
    .dg-edge.highlighted { opacity: 1; stroke-width: 2.6; }
    .dg-edge.dimmed { opacity: 0.08; }
    .inspector-card { padding: 14px; max-height: 76vh; overflow-y: auto; }
    .inspector-card h2 { margin: 0 0 8px; font-size: 15px; }
    .detail-group { margin-top: 12px; }
    .detail-label { font-size: 11px; font-weight: 700; text-transform: uppercase; color: var(--muted); margin-bottom: 4px; }
    .detail-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
    .detail-item {
      font-size: 12px;
      padding: 4px 8px;
      background: var(--surface-2);
      border-radius: 6px;
      word-break: break-word;
    }
    .detail-item.cycle-item {
      background: var(--cycle-bg);
      color: var(--cycle-text);
      border: 1px solid var(--cycle-stroke);
    }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <h1>${escapeHtml(title)}</h1>
      <span class="pill mono">offline</span>
    </div>
    <div class="stats">
      <span class="pill">${graph.modules.length} module${graph.modules.length === 1 ? "" : "s"}</span>
      <span class="pill">${controllers.length} controller${controllers.length === 1 ? "" : "s"}</span>
      <span class="pill">${serviceProviders.length} provider${serviceProviders.length === 1 ? "" : "s"}</span>
      <span class="pill">${routes.length} route${routes.length === 1 ? "" : "s"}</span>
      ${totalCycles > 0 ? `<span class="pill pill-cycle">${totalCycles} cycle${totalCycles === 1 ? "" : "s"}</span>` : '<span class="pill">0 cycles</span>'}
    </div>
  </header>

  <div class="toolbar">
    <div class="filters">
      <input id="graph-search" type="search" placeholder="Search modules, providers, routes..." aria-label="Search DI graph" />
      <select id="module-filter" aria-label="Filter by module">
        <option value="">All modules</option>
        ${moduleOptionsMarkup}
      </select>
      <label class="check-label"><input id="cycles-only-toggle" type="checkbox" /> Cycles only</label>
      <label class="check-label"><input class="kind-filter" type="checkbox" value="module" checked /> Modules</label>
      <label class="check-label"><input class="kind-filter" type="checkbox" value="controller" checked /> Controllers</label>
      <label class="check-label"><input class="kind-filter" type="checkbox" value="provider" checked /> Providers</label>
      <label class="check-label"><input class="kind-filter" type="checkbox" value="repository" checked /> Repositories</label>
    </div>
    <div class="zoom-controls">
      <button id="zoom-in" type="button" class="btn" title="Zoom in">+</button>
      <button id="zoom-out" type="button" class="btn" title="Zoom out">-</button>
      <button id="zoom-reset" type="button" class="btn" title="Reset pan and zoom">Reset</button>
      <button id="theme-toggle" type="button" class="btn" title="Toggle light/dark theme">Theme</button>
    </div>
  </div>

  ${cycleBannerMarkup}

  <main>
    <section class="canvas-card">
      <div class="canvas-head">
        <span>Drag to pan · Scroll to zoom · Click a node to inspect</span>
        <div class="legend">
          <span class="legend-item"><span class="dot" style="background:var(--mod-stroke)"></span>Module</span>
          <span class="legend-item"><span class="dot" style="background:var(--ctrl-stroke)"></span>Controller</span>
          <span class="legend-item"><span class="dot" style="background:var(--prov-stroke)"></span>Provider</span>
          <span class="legend-item"><span class="dot" style="background:var(--req-stroke)"></span>REQUEST</span>
          <span class="legend-item"><span class="dot" style="background:var(--cycle-stroke)"></span>Cycle</span>
        </div>
      </div>
      <div id="canvas-wrap" class="canvas-wrap">
        <svg id="di-svg" viewBox="0 0 ${svgWidth} ${svgHeight}" role="img" aria-label="Bunest Dependency Injection Graph">
          <defs>
            <marker id="arrow-import" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 1 L 10 5 L 0 9 z" fill="var(--edge-import)" />
            </marker>
            <marker id="arrow-reexport" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 1 L 10 5 L 0 9 z" fill="var(--edge-reexport)" />
            </marker>
            <marker id="arrow-owns" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
              <path d="M 0 1 L 10 5 L 0 9 z" fill="var(--edge-owns)" />
            </marker>
            <marker id="arrow-inject" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 1 L 10 5 L 0 9 z" fill="var(--edge-inject)" />
            </marker>
            <marker id="arrow-cycle" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 1 L 10 5 L 0 9 z" fill="var(--edge-cycle)" />
            </marker>
          </defs>
          <g id="viewport">
            <text class="col-heading" x="${colX.module}" y="32">Modules (${graph.modules.length})</text>
            <text class="col-heading" x="${colX.controller}" y="32">Controllers (${controllers.length})</text>
            <text class="col-heading" x="${colX.provider}" y="32">Providers &amp; Repos (${serviceProviders.length})</text>
            <g id="edges-layer">${svgEdgesMarkup}</g>
            <g id="nodes-layer">${svgNodesMarkup}</g>
          </g>
        </svg>
      </div>
    </section>

    <aside id="inspector" class="inspector-card" aria-live="polite">
      <h2>Inspector</h2>
      <p class="muted" style="font-size:13px">Click any module, controller, provider, or repository node to inspect its providers, exports, dependencies, routes, and cycle diagnostics.</p>
    </aside>
  </main>

  <script id="bunest-graph-data" type="application/json">${embeddedData}</script>
  <script>
    (function () {
      var dataEl = document.getElementById("bunest-graph-data");
      var data = JSON.parse(dataEl ? dataEl.textContent || "{}" : "{}");
      var nodes = Array.isArray(data.nodes) ? data.nodes : [];
      var edges = Array.isArray(data.edges) ? data.edges : [];
      var nodeMap = {};
      for (var i = 0; i < nodes.length; i++) nodeMap[nodes[i].id] = nodes[i];

      var wrap = document.getElementById("canvas-wrap");
      var viewport = document.getElementById("viewport");
      var inspector = document.getElementById("inspector");
      var searchInput = document.getElementById("graph-search");
      var moduleSelect = document.getElementById("module-filter");
      var cyclesOnlyToggle = document.getElementById("cycles-only-toggle");
      var kindCheckboxes = document.querySelectorAll(".kind-filter");

      var tx = 0, ty = 0, scale = 1;
      var dragging = false, startX = 0, startY = 0;
      var selectedNodeId = null;

      function applyTransform() {
        if (viewport) {
          viewport.setAttribute("transform", "translate(" + tx + "," + ty + ") scale(" + scale + ")");
        }
      }

      if (wrap) {
        wrap.addEventListener("mousedown", function (e) {
          if (e.target && e.target.closest && e.target.closest(".dg-node")) return;
          dragging = true;
          startX = e.clientX - tx;
          startY = e.clientY - ty;
          wrap.classList.add("panning");
        });
        window.addEventListener("mousemove", function (e) {
          if (!dragging) return;
          tx = e.clientX - startX;
          ty = e.clientY - startY;
          applyTransform();
        });
        window.addEventListener("mouseup", function () {
          dragging = false;
          if (wrap) wrap.classList.remove("panning");
        });
        wrap.addEventListener("wheel", function (e) {
          e.preventDefault();
          var factor = e.deltaY < 0 ? 1.12 : 0.89;
          scale = Math.max(0.25, Math.min(3.5, scale * factor));
          applyTransform();
        }, { passive: false });
      }

      var zoomInBtn = document.getElementById("zoom-in");
      var zoomOutBtn = document.getElementById("zoom-out");
      var zoomResetBtn = document.getElementById("zoom-reset");
      var themeToggleBtn = document.getElementById("theme-toggle");

      if (zoomInBtn) zoomInBtn.addEventListener("click", function () { scale = Math.min(3.5, scale * 1.2); applyTransform(); });
      if (zoomOutBtn) zoomOutBtn.addEventListener("click", function () { scale = Math.max(0.25, scale / 1.2); applyTransform(); });
      if (zoomResetBtn) zoomResetBtn.addEventListener("click", function () { tx = 0; ty = 0; scale = 1; applyTransform(); });
      if (themeToggleBtn) {
        themeToggleBtn.addEventListener("click", function () {
          var root = document.documentElement;
          var cur = root.getAttribute("data-theme");
          root.setAttribute("data-theme", cur === "dark" ? "light" : "dark");
        });
      }

      function esc(str) {
        return String(str)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;");
      }

      function renderSection(title, items, isCycle) {
        if (!items || !items.length) return "";
        var cls = isCycle ? "detail-item mono cycle-item" : "detail-item mono";
        var html = '<div class="detail-group"><div class="detail-label">' + esc(title) + ' (' + items.length + ')</div><ul class="detail-list">';
        for (var j = 0; j < items.length; j++) {
          html += '<li class="' + cls + '">' + esc(items[j]) + '</li>';
        }
        return html + '</ul></div>';
      }

      function inspectNode(nodeId) {
        selectedNodeId = nodeId;
        var node = nodeMap[nodeId];
        if (!node || !inspector) return;

        var d = node.details || {};
        var html = '<h2>' + esc(node.name) + '</h2>';
        html += '<div class="stats" style="margin-bottom:8px">';
        html += '<span class="pill">' + esc(node.kind) + '</span>';
        if (node.scope) html += '<span class="pill">' + esc(node.scope) + '</span>';
        if (node.isCyclic) html += '<span class="pill pill-cycle">CYCLE</span>';
        html += '</div>';
        html += '<div class="detail-label">Source File</div><div class="detail-item mono">' + esc(node.sourceFile || "") + '</div>';

        if (d.cycles && d.cycles.length) html += renderSection("Circular Dependencies", d.cycles, true);
        if (node.kind === "module") {
          html += renderSection("Imports", d.imports, false);
          html += renderSection("Exports", d.exports, false);
          html += renderSection("Providers", d.providers, false);
          html += renderSection("Controllers", d.controllers, false);
          html += renderSection("Routes", d.routes, false);
        } else {
          html += renderSection("Declaring Modules", d.modules, false);
          html += renderSection("Dependencies", d.dependencies, false);
          html += renderSection("Depended On By", d.dependedOnBy, false);
          html += renderSection("Routes", d.routes, false);
        }
        inspector.innerHTML = html;
        updateFilters();
      }

      function updateFilters() {
        var query = (searchInput ? searchInput.value : "").trim().toLowerCase();
        var modFilter = moduleSelect ? moduleSelect.value : "";
        var cyclesOnly = cyclesOnlyToggle ? cyclesOnlyToggle.checked : false;
        var enabledKinds = {};
        for (var k = 0; k < kindCheckboxes.length; k++) {
          var cb = kindCheckboxes[k];
          if (cb.checked) enabledKinds[cb.value] = true;
        }

        var visibleIds = {};
        var nodeEls = document.querySelectorAll(".dg-node");
        for (var i = 0; i < nodeEls.length; i++) {
          var el = nodeEls[i];
          var id = el.getAttribute("data-node-id");
          var n = nodeMap[id];
          if (!n) continue;
          var matchKind = !!enabledKinds[n.kind];
          var matchCycle = !cyclesOnly || n.isCyclic;
          var matchMod = !modFilter || (n.modules && n.modules.indexOf(modFilter) !== -1);
          var haystack = (n.name + " " + n.sourceFile + " " + JSON.stringify(n.details || {})).toLowerCase();
          var matchSearch = !query || haystack.indexOf(query) !== -1;
          var ok = matchKind && matchCycle && matchMod && matchSearch;
          if (ok) visibleIds[id] = true;
        }

        var connected = {};
        if (selectedNodeId) {
          connected[selectedNodeId] = true;
          for (var eIdx = 0; eIdx < edges.length; eIdx++) {
            var edge = edges[eIdx];
            if (edge.from === selectedNodeId || edge.to === selectedNodeId) {
              connected[edge.from] = true;
              connected[edge.to] = true;
            }
          }
        }

        for (var j = 0; j < nodeEls.length; j++) {
          var nel = nodeEls[j];
          var nid = nel.getAttribute("data-node-id");
          var isVisible = !!visibleIds[nid] && (!selectedNodeId || !!connected[nid]);
          nel.classList.toggle("dimmed", !isVisible);
          nel.classList.toggle("selected", nid === selectedNodeId);
        }

        var edgeEls = document.querySelectorAll(".dg-edge");
        for (var m = 0; m < edgeEls.length; m++) {
          var eel = edgeEls[m];
          var from = eel.getAttribute("data-from");
          var to = eel.getAttribute("data-to");
          var isCyclicEdge = eel.getAttribute("data-cyclic") === "true";
          var bothVis = !!visibleIds[from] && !!visibleIds[to] && (!cyclesOnly || isCyclicEdge);
          var touched = !selectedNodeId || from === selectedNodeId || to === selectedNodeId;
          eel.classList.toggle("dimmed", !(bothVis && touched));
          eel.classList.toggle("highlighted", !!(selectedNodeId && bothVis && touched));
        }
      }

      var nodeEls = document.querySelectorAll(".dg-node");
      for (var nIdx = 0; nIdx < nodeEls.length; nIdx++) {
        (function (el) {
          var nid = el.getAttribute("data-node-id");
          el.addEventListener("click", function () {
            if (selectedNodeId === nid) {
              selectedNodeId = null;
              updateFilters();
            } else {
              inspectNode(nid);
            }
          });
          el.addEventListener("keydown", function (e) {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              inspectNode(nid);
            }
          });
        })(nodeEls[nIdx]);
      }

      var cycleChips = document.querySelectorAll(".cycle-chip");
      for (var cIdx = 0; cIdx < cycleChips.length; cIdx++) {
        cycleChips[cIdx].addEventListener("click", function () {
          var list = (this.getAttribute("data-cycle-nodes") || "").split(",");
          if (cyclesOnlyToggle) cyclesOnlyToggle.checked = true;
          if (list[0]) inspectNode(list[0]);
          else updateFilters();
        });
      }

      if (searchInput) searchInput.addEventListener("input", updateFilters);
      if (moduleSelect) moduleSelect.addEventListener("change", updateFilters);
      if (cyclesOnlyToggle) cyclesOnlyToggle.addEventListener("change", updateFilters);
      for (var kIdx = 0; kIdx < kindCheckboxes.length; kIdx++) {
        kindCheckboxes[kIdx].addEventListener("change", updateFilters);
      }
    })();
  </script>
</body>
</html>`;
}

/**
 * Runs `bunest graph [--format mermaid|dot|json|html] [--module <Name>] [--cycles-only] [--cwd <dir>]`
 * offline using `BunestStaticAnalyzer` + `StaticModuleGraph` without booting the app.
 */
export async function runGraphCommand(
  options: GraphCommandOptions = {},
  io?: CliIO,
): Promise<GraphCommandResult> {
  const start = performance.now();
  const format: GraphOutputFormat = options.format ?? "mermaid";
  const cwd = resolve(options.cwd ?? io?.cwd ?? process.cwd());

  const loaded = await loadCliConfiguration(cwd, options.config);
  const bunestConfig = (await loadBunestConfig(cwd)).config;
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
    include: ["routes"],
  });

  const scanner = analyzer.getScanner();
  const sourceFiles = scanner.getTrackedSourceFiles();
  const staticGraph = buildStaticModuleGraph(sourceFiles);
  const scannedRoutes = scanner.scan().routes.map((r) => ({
    method: r.method,
    path: r.path,
    controller: r.controllerName,
    handler: r.handlerName,
    sourceFile: r.sourceFile,
  }));

  let graphOutput: StaticGraphJsonOutput;
  try {
    graphOutput = buildStaticGraphOutput(staticGraph, {
      cwd,
      filterModule: options.module,
      cyclesOnly: options.cyclesOnly,
      routes: scannedRoutes,
    });
  } catch (error) {
    const durationMs = Math.round((performance.now() - start) * 100) / 100;
    const message = error instanceof Error ? error.message : String(error);
    if (io && !options.silent) {
      io.stderr(`Error: ${message}`);
    }
    return {
      exitCode: 1,
      format,
      output: "",
      error: message,
      durationMs,
    };
  }

  const output =
    format === "json"
      ? formatStaticGraphJson(graphOutput)
      : format === "dot"
        ? formatStaticGraphDot(graphOutput)
        : format === "html"
          ? formatStaticGraphHtml(graphOutput)
          : formatStaticGraphMermaid(graphOutput);

  const durationMs = Math.round((performance.now() - start) * 100) / 100;

  if (io && !options.silent) {
    io.stdout(output);
  }

  return {
    exitCode: 0,
    format,
    output,
    graph: graphOutput,
    durationMs,
  };
}
