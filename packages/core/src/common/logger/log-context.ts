export type LogContextProvider = () => Record<string, unknown> | undefined;

const LOG_CONTEXT_PROVIDERS_SYMBOL = Symbol.for(
  "bunest:logger:context-providers",
);

function getProvidersSet(): Set<LogContextProvider> {
  const g = globalThis as Record<PropertyKey, unknown>;
  let set = g[LOG_CONTEXT_PROVIDERS_SYMBOL] as
    | Set<LogContextProvider>
    | undefined;
  if (!set) {
    set = new Set<LogContextProvider>();
    g[LOG_CONTEXT_PROVIDERS_SYMBOL] = set;
  }
  return set;
}

/**
 * Registers an ambient context provider (e.g. HTTP `requestId` or `ClsService` store)
 * consumed automatically by `ConsoleLogger` and `Logger` in JSON mode.
 * Returns an unsubscribe function.
 */
export function registerLogContextProvider(
  provider: LogContextProvider,
): () => void {
  const set = getProvidersSet();
  set.add(provider);
  return () => {
    set.delete(provider);
  };
}

/**
 * Collects active log context fields from all registered providers.
 * Returns `undefined` when no provider yields any keys (zero-allocation fast path).
 */
export function getActiveLogContext(): Record<string, unknown> | undefined {
  const set = getProvidersSet();
  if (set.size === 0) return undefined;

  let merged: Record<string, unknown> | undefined;
  for (const provider of set) {
    let fields: Record<string, unknown> | undefined;
    try {
      fields = provider();
    } catch {
      continue;
    }
    if (!fields || typeof fields !== "object") continue;
    const keys = Object.keys(fields);
    if (keys.length === 0) continue;
    if (!merged) merged = {};
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i]!;
      const v = fields[k];
      if (v !== undefined) {
        merged[k] = v;
      }
    }
  }
  return merged;
}
