/**
 * Structural log redactor (NestJS v12 `createRedactor()` semantics).
 *
 * - A path is a key name (`"password"`, matched at any depth) or a dotted suffix
 *   (`"user.password"`, matched against the trailing object keys; array indices are skipped).
 *   Keys compare case-insensitively.
 * - Copy-on-write: untouched branches keep their identity; when nothing matches the input
 *   itself is returned. Copies keep prototypes and own-property descriptors (Errors stay Errors).
 * - Handles sparse arrays (only present indices are visited), Maps, Sets, Error `cause` /
 *   `AggregateError#errors`, own `"__proto__"` keys, circular references (`"[Circular]"`),
 *   and shared sub-graphs (memoized per dotted-path matching state, so DAGs are linear).
 * - Opaque values (Date, RegExp, ArrayBuffer, typed arrays/Buffers) are never traversed.
 * - If reading a value throws (e.g. a throwing getter) that value is replaced by the censor.
 */

const CIRCULAR = "[Circular]";

type Pattern = readonly string[];
type State = readonly (readonly number[])[]; // per pattern: matched prefix lengths

function parsePaths(paths: readonly string[]): Pattern[] {
  const out: Pattern[] = [];
  for (const raw of paths) {
    const segs = String(raw)
      .split(".")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (segs.length > 0) out.push(segs);
  }
  return out;
}

function isOpaque(value: object): boolean {
  return (
    value instanceof Date ||
    value instanceof RegExp ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value) ||
    value instanceof WeakMap ||
    value instanceof WeakSet ||
    value instanceof Promise
  );
}

export type Redactor = <T>(value: T) => T;

export function createRedactor(
  paths: readonly string[],
  censor: unknown = "[REDACTED]",
): Redactor {
  const patterns = parsePaths(paths);
  if (patterns.length === 0) return <T>(value: T) => value;

  const emptyState: State = patterns.map(() => []);
  const stateKey = (state: State): string =>
    state.map((s) => s.join(",")).join("|");

  /** Advances the matching state by one object key; reports whether the key is redacted. */
  const step = (state: State, rawKey: string): { matched: boolean; next: State } => {
    const key = rawKey.toLowerCase();
    let matched = false;
    const next: number[][] = [];
    for (let p = 0; p < patterns.length; p++) {
      const pattern = patterns[p]!;
      const last = pattern.length - 1;
      const lengths: number[] = [];
      if (pattern[last] === key && (last === 0 || state[p]!.includes(last))) {
        matched = true;
      }
      if (last > 0) {
        for (const k of state[p]!) {
          if (k < last && pattern[k] === key) lengths.push(k + 1);
        }
        if (pattern[0] === key && !lengths.includes(1)) lengths.push(1);
        lengths.sort((a, b) => a - b);
      }
      next.push(lengths);
    }
    return { matched, next };
  };

  return <T>(input: T): T => {
    const ancestors = new Set<object>();
    const memo = new Map<object, Map<string, unknown>>();

    const copyWith = (
      node: object,
      changes: Map<PropertyKey, unknown>,
    ): object => {
      const copy = Object.create(Object.getPrototypeOf(node)) as object;
      for (const key of Reflect.ownKeys(node)) {
        const desc = Object.getOwnPropertyDescriptor(node, key)!;
        if (changes.has(key)) {
          Object.defineProperty(copy, key, {
            value: changes.get(key),
            writable: true,
            enumerable: desc.enumerable,
            configurable: true,
          });
        } else {
          Object.defineProperty(copy, key, desc);
        }
      }
      return copy;
    };

    const walkArray = (node: unknown[], state: State): unknown[] => {
      const keys = Object.keys(node);
      const changes = new Map<string, unknown>();
      for (const key of keys) {
        const item = (node as unknown as Record<string, unknown>)[key];
        const next = walk(item, state);
        if (next !== item) changes.set(key, next);
      }
      if (changes.size === 0) return node;
      const out = new Array(node.length) as unknown[];
      const record = out as unknown as Record<string, unknown>;
      for (const key of keys) {
        const item = (node as unknown as Record<string, unknown>)[key];
        record[key] = changes.has(key) ? changes.get(key) : item;
      }
      return out;
    };

    const walkMap = (node: Map<unknown, unknown>, state: State): Map<unknown, unknown> => {
      let changed = false;
      const entries: [unknown, unknown][] = [];
      for (const [key, value] of node) {
        const nextKey = typeof key === "object" && key !== null ? walk(key, state) : key;
        let nextValue: unknown;
        if (typeof key === "string") {
          const { matched, next } = step(state, key);
          nextValue = matched ? censor : walk(value, next);
        } else {
          nextValue = walk(value, state);
        }
        if (nextKey !== key || nextValue !== value) changed = true;
        entries.push([nextKey, nextValue]);
      }
      return changed ? new Map(entries) : node;
    };

    const walkSet = (node: Set<unknown>, state: State): Set<unknown> => {
      let changed = false;
      const items: unknown[] = [];
      for (const item of node) {
        const next = walk(item, state);
        if (next !== item) changed = true;
        items.push(next);
      }
      return changed ? new Set(items) : node;
    };

    const walkObject = (node: object, state: State): object => {
      const record = node as Record<string, unknown>;
      const changes = new Map<PropertyKey, unknown>();
      const keys: string[] = Object.keys(node);
      if (node instanceof Error) {
        for (const extra of ["cause", "errors"]) {
          if (Object.prototype.hasOwnProperty.call(node, extra) && !keys.includes(extra)) {
            keys.push(extra);
          }
        }
      }
      for (const key of keys) {
        const { matched, next } = step(state, key);
        const value = record[key];
        if (matched) {
          if (value !== censor) changes.set(key, censor);
          continue;
        }
        const result = walk(value, next);
        if (result !== value) changes.set(key, result);
      }
      return changes.size === 0 ? node : copyWith(node, changes);
    };

    const walk = (node: unknown, state: State): unknown => {
      if (node === null || typeof node !== "object") return node;
      if (isOpaque(node)) return node;
      if (ancestors.has(node)) return CIRCULAR;

      const sKey = stateKey(state);
      const cached = memo.get(node)?.get(sKey);
      if (cached !== undefined || memo.get(node)?.has(sKey)) return cached;

      ancestors.add(node);
      let result: unknown;
      try {
        if (Array.isArray(node)) result = walkArray(node, state);
        else if (node instanceof Map) result = walkMap(node, state);
        else if (node instanceof Set) result = walkSet(node, state);
        else result = walkObject(node, state);
      } catch {
        result = censor;
      } finally {
        ancestors.delete(node);
      }

      let byState = memo.get(node);
      if (!byState) memo.set(node, (byState = new Map()));
      byState.set(sKey, result);
      return result;
    };

    return walk(input, emptyState) as T;
  };
}
