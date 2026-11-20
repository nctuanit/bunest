import type { CompleteTraceEventNode } from "../interfaces/observe-types";

export const SPAN_COLLAPSED_TAG = "observe.collapsed";

export interface SpanCollapseSettings {
  threshold: number;
  keepSlowest: number;
}

export const DEFAULT_SPAN_COLLAPSE: SpanCollapseSettings = {
  threshold: 20,
  keepSlowest: 3,
};

export function collapseRepeatedSpans(
  nodes: CompleteTraceEventNode[],
  settings: SpanCollapseSettings | undefined,
): CompleteTraceEventNode[] {
  if (!settings || nodes.length === 0) {
    return nodes;
  }
  const processed = nodes.map((n) => ({
    ...n,
    children: collapseRepeatedSpans(n.children, settings),
  }));

  const groups = new Map<string, number[]>();
  processed.forEach((node, idx) => {
    const key = `${node.className}.${node.methodKey}`;
    const list = groups.get(key);
    if (list) list.push(idx);
    else groups.set(key, [idx]);
  });

  const result: CompleteTraceEventNode[] = [];
  const handled = new Set<number>();

  for (let i = 0; i < processed.length; i++) {
    if (handled.has(i)) continue;
    const node = processed[i]!;
    const key = `${node.className}.${node.methodKey}`;
    const indices = groups.get(key)!;
    if (indices.length <= settings.threshold) {
      handled.add(i);
      result.push(node);
      continue;
    }

    const groupNodes = indices.map((idx) => {
      handled.add(idx);
      return processed[idx]!;
    });

    const errored: CompleteTraceEventNode[] = [];
    const ok: CompleteTraceEventNode[] = [];
    for (const g of groupNodes) {
      if (g.error) errored.push(g);
      else ok.push(g);
    }

    const sortedOk = [...ok].sort((a, b) => b.duration - a.duration);
    const kept = sortedOk.slice(0, settings.keepSlowest);
    const collapsed = sortedOk.slice(settings.keepSlowest);

    for (const e of errored) result.push(e);
    for (const k of kept) result.push(k);

    if (collapsed.length > 0) {
      let totalDuration = 0;
      let earliestOffset: number | undefined;
      const mergedChildren: CompleteTraceEventNode[] = [];
      for (const c of collapsed) {
        totalDuration += c.duration;
        if (
          c.startOffset !== undefined &&
          (earliestOffset === undefined || c.startOffset < earliestOffset)
        ) {
          earliestOffset = c.startOffset;
        }
        mergedChildren.push(...c.children);
      }
      result.push({
        origin: node.origin,
        className: node.className,
        methodKey: node.methodKey,
        duration: totalDuration,
        ...(earliestOffset !== undefined ? { startOffset: earliestOffset } : {}),
        tags: {
          [SPAN_COLLAPSED_TAG]: collapsed.length,
        },
        children: mergedChildren,
      });
    }
  }

  return result;
}
