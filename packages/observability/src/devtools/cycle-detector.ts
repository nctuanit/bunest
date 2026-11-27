import type { DevtoolsApplicationGraph } from "./devtools.service";

export interface DevtoolsDependencyCycle {
  readonly kind: "module" | "provider";
  /** Prefixed graph node IDs forming the closed cycle (e.g. `["mod:A", "mod:B", "mod:A"]`). */
  readonly nodes: readonly string[];
  /** Human-readable node names forming the closed cycle (e.g. `["ModA", "ModB", "ModA"]`). */
  readonly labels: readonly string[];
  /** Directed edges participating in this cycle. */
  readonly edges: ReadonlyArray<{
    readonly from: string;
    readonly to: string;
  }>;
}

const MAX_DETECTED_CYCLES = 50;

function canonicalizeCycle(nodes: readonly string[]): string {
  if (nodes.length === 0) return "";
  let minIdx = 0;
  for (let i = 1; i < nodes.length; i++) {
    if (nodes[i]! < nodes[minIdx]!) {
      minIdx = i;
    }
  }
  const rotated: string[] = [];
  for (let i = 0; i < nodes.length; i++) {
    rotated.push(nodes[(minIdx + i) % nodes.length]!);
  }
  return rotated.join("->");
}

function findDirectedCycles(
  adjacency: ReadonlyMap<string, readonly string[]>,
  labelById: ReadonlyMap<string, string>,
  kind: "module" | "provider",
  limit: number,
): DevtoolsDependencyCycle[] {
  const results: DevtoolsDependencyCycle[] = [];
  const seenKeys = new Set<string>();
  const allNodes = [...adjacency.keys()].sort();

  const state = new Map<string, 0 | 1 | 2>(); // 0 = unvisited, 1 = visiting, 2 = done
  const stack: string[] = [];
  const stackIndex = new Map<string, number>();

  const recordCycle = (rawCycle: string[]) => {
    if (results.length >= limit || rawCycle.length === 0) {
      return;
    }
    const key = canonicalizeCycle(rawCycle);
    if (seenKeys.has(key)) {
      return;
    }
    seenKeys.add(key);

    const closedNodes = [...rawCycle, rawCycle[0]!];
    const labels = closedNodes.map((id) => labelById.get(id) ?? id);
    const edges: Array<{ readonly from: string; readonly to: string }> = [];
    for (let i = 0; i < rawCycle.length; i++) {
      edges.push({
        from: closedNodes[i]!,
        to: closedNodes[i + 1]!,
      });
    }
    results.push({ kind, nodes: closedNodes, labels, edges });
  };

  const dfs = (node: string): void => {
    if (results.length >= limit) return;
    state.set(node, 1);
    stackIndex.set(node, stack.length);
    stack.push(node);

    const neighbors = adjacency.get(node) ?? [];
    for (let i = 0; i < neighbors.length; i++) {
      if (results.length >= limit) break;
      const next = neighbors[i]!;
      const nextState = state.get(next) ?? 0;
      if (nextState === 1) {
        const startIdx = stackIndex.get(next);
        if (startIdx !== undefined) {
          recordCycle(stack.slice(startIdx));
        }
      } else if (nextState === 0) {
        dfs(next);
      }
    }

    stack.pop();
    stackIndex.delete(node);
    state.set(node, 2);
  };

  for (const node of allNodes) {
    if (results.length >= limit) break;
    if ((state.get(node) ?? 0) === 0) {
      dfs(node);
    }
  }

  return results;
}

/**
 * Detects circular module (`import` / `re-export`) and provider (`provider-dependency`)
 * dependency cycles in a `DevtoolsApplicationGraph`.
 */
export function detectGraphCycles(
  graph: Pick<DevtoolsApplicationGraph, "modules" | "providers" | "edges">,
): DevtoolsDependencyCycle[] {
  const modAdj = new Map<string, string[]>();
  const modLabels = new Map<string, string>();
  const modIds = new Set<string>();

  for (const mod of graph.modules) {
    const id = `mod:${mod.id}`;
    modIds.add(id);
    modLabels.set(id, mod.name);
    modAdj.set(id, []);
  }

  const provAdj = new Map<string, string[]>();
  const provLabels = new Map<string, string>();
  const provIdByRawId = new Map<string, string>();
  const provIdByToken = new Map<string, string>();

  for (const prov of graph.providers) {
    const id = `prov:${prov.id}`;
    provIdByRawId.set(prov.id, id);
    if (!provIdByToken.has(prov.token)) {
      provIdByToken.set(prov.token, id);
    }
    provLabels.set(id, prov.token);
    provAdj.set(id, []);
  }

  for (const edge of graph.edges) {
    if (edge.type === "import" || edge.type === "re-export") {
      const from = `mod:${edge.from}`;
      const to = `mod:${edge.to}`;
      if (modIds.has(from) && modIds.has(to)) {
        const list = modAdj.get(from)!;
        if (!list.includes(to)) {
          list.push(to);
        }
      }
    } else if (edge.type === "provider-dependency") {
      const from = provIdByRawId.get(edge.from);
      const to =
        provIdByRawId.get(edge.to) ?? provIdByToken.get(edge.to);
      if (from && to && provAdj.has(from) && provAdj.has(to)) {
        const list = provAdj.get(from)!;
        if (!list.includes(to)) {
          list.push(to);
        }
      }
    }
  }

  const moduleCycles = findDirectedCycles(
    modAdj,
    modLabels,
    "module",
    MAX_DETECTED_CYCLES,
  );
  const remaining = Math.max(0, MAX_DETECTED_CYCLES - moduleCycles.length);
  const providerCycles =
    remaining > 0
      ? findDirectedCycles(provAdj, provLabels, "provider", remaining)
      : [];

  return [...moduleCycles, ...providerCycles];
}
