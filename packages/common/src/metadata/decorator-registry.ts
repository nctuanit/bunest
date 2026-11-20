import type { Abstract, Type } from "../interfaces/type.interface";

export type BuiltInDecoratorKind = "controller" | "injectable" | "entity";
export type DecoratorKind = BuiltInDecoratorKind | (string & {});

export interface DecoratorRegistryEntry<TMeta = unknown> {
  readonly kind: string;
  readonly target: Type<any> | Abstract<any>;
  readonly meta?: TMeta;
}

export interface DecoratorRegistrySnapshot {
  readonly controllers: readonly Type<unknown>[];
  readonly injectables: readonly Type<unknown>[];
  readonly entities: readonly (Type<unknown> | Abstract<unknown>)[];
  readonly byKind: Readonly<Record<string, readonly DecoratorRegistryEntry[]>>;
}

interface DecoratorRegistryStore {
  readonly kinds: Map<string, Map<Function, DecoratorRegistryEntry>>;
  readonly internals: WeakSet<Function>;
}

const REGISTRY_SYMBOL = Symbol.for("bunest:decorator_registry:v1");

function getStore(): DecoratorRegistryStore {
  const g = globalThis as Record<PropertyKey, unknown>;
  let store = g[REGISTRY_SYMBOL] as DecoratorRegistryStore | undefined;
  if (!store) {
    store = {
      kinds: new Map<string, Map<Function, DecoratorRegistryEntry>>(),
      internals: new WeakSet<Function>(),
    };
    g[REGISTRY_SYMBOL] = store;
  }
  return store;
}

function getOrCreateKindMap(
  store: DecoratorRegistryStore,
  kind: string,
): Map<Function, DecoratorRegistryEntry> {
  let map = store.kinds.get(kind);
  if (!map) {
    map = new Map<Function, DecoratorRegistryEntry>();
    store.kinds.set(kind, map);
  }
  return map;
}

/**
 * Class-evaluation-time decorator registry where `@Controller`, `@Injectable`,
 * `@Entity`, and custom kinds (`"repository"`, etc.) self-register automatically.
 *
 * Backed by a `Symbol.for`-namespaced singleton store so all workspace packages
 * share one consistent registry, with `snapshot()`, `restore()`, and `clear()`
 * helpers for deterministic test isolation.
 */
export class DecoratorRegistry {
  static register<TMeta = unknown>(
    kind: DecoratorKind,
    cls: Function,
    meta?: TMeta,
  ): void {
    const store = getStore();
    if (
      (kind === "controller" || kind === "injectable") &&
      store.internals.has(cls)
    ) {
      return;
    }
    const map = getOrCreateKindMap(store, kind);
    const entry: DecoratorRegistryEntry<TMeta> =
      meta !== undefined
        ? { kind, target: cls as Type<any> | Abstract<any>, meta }
        : { kind, target: cls as Type<any> | Abstract<any> };
    map.set(cls, entry);
  }

  static registerController(cls: Function, meta?: unknown): void {
    DecoratorRegistry.register("controller", cls, meta);
  }

  static registerInjectable(cls: Function, meta?: unknown): void {
    DecoratorRegistry.register("injectable", cls, meta);
  }

  static registerEntity(cls: Function, meta?: unknown): void {
    DecoratorRegistry.register("entity", cls, meta);
  }

  static unregister(kind: DecoratorKind, cls: Function): boolean {
    const map = getStore().kinds.get(kind);
    if (!map) {
      return false;
    }
    return map.delete(cls);
  }

  static has(kind: DecoratorKind, cls: Function): boolean {
    return getStore().kinds.get(kind)?.has(cls) ?? false;
  }

  static getControllers(): Type<unknown>[] {
    const map = getStore().kinds.get("controller");
    if (!map || map.size === 0) {
      return [];
    }
    return [...map.keys()] as Type<unknown>[];
  }

  static getInjectables(): Type<unknown>[] {
    const map = getStore().kinds.get("injectable");
    if (!map || map.size === 0) {
      return [];
    }
    return [...map.keys()] as Type<unknown>[];
  }

  static getEntities(): Array<Type<unknown> | Abstract<unknown>> {
    const map = getStore().kinds.get("entity");
    if (!map || map.size === 0) {
      return [];
    }
    return [...map.keys()] as Array<Type<unknown> | Abstract<unknown>>;
  }

  static getByKind<TMeta = unknown>(
    kind: DecoratorKind,
  ): DecoratorRegistryEntry<TMeta>[] {
    const map = getStore().kinds.get(kind);
    if (!map || map.size === 0) {
      return [];
    }
    const result: DecoratorRegistryEntry<TMeta>[] = [];
    for (const entry of map.values()) {
      result.push({ ...entry } as DecoratorRegistryEntry<TMeta>);
    }
    return result;
  }

  static getTargetsByKind<T extends Function = Type<unknown>>(
    kind: DecoratorKind,
  ): T[] {
    const map = getStore().kinds.get(kind);
    if (!map || map.size === 0) {
      return [];
    }
    return [...map.keys()] as T[];
  }

  static getMeta<TMeta = unknown>(
    kind: DecoratorKind,
    cls: Function,
  ): TMeta | undefined {
    return getStore().kinds.get(kind)?.get(cls)?.meta as TMeta | undefined;
  }

  /**
   * Marks one or more internal framework classes so they are excluded from
   * user auto-discovery (`@AutoModule` / `BunestFactory.createAuto()`).
   */
  static markInternal(...classes: Function[]): void {
    const store = getStore();
    const ctrlMap = store.kinds.get("controller");
    const injMap = store.kinds.get("injectable");
    for (let i = 0; i < classes.length; i++) {
      const cls = classes[i];
      if (typeof cls !== "function") {
        continue;
      }
      store.internals.add(cls);
      ctrlMap?.delete(cls);
      injMap?.delete(cls);
    }
  }

  static isInternal(cls: Function): boolean {
    return getStore().internals.has(cls);
  }

  /**
   * Captures an immutable point-in-time snapshot of all registered decorator kinds.
   */
  static snapshot(): DecoratorRegistrySnapshot {
    const store = getStore();
    const byKind: Record<string, readonly DecoratorRegistryEntry[]> = {};
    for (const [kind, map] of store.kinds.entries()) {
      if (map.size > 0) {
        const entries: DecoratorRegistryEntry[] = [];
        for (const entry of map.values()) {
          entries.push({ ...entry });
        }
        byKind[kind] = entries;
      }
    }
    return {
      controllers: DecoratorRegistry.getControllers(),
      injectables: DecoratorRegistry.getInjectables(),
      entities: DecoratorRegistry.getEntities(),
      byKind,
    };
  }

  /**
   * Restores the registry to a previously captured snapshot (ideal for test isolation).
   */
  static restore(snapshot: DecoratorRegistrySnapshot): void {
    const store = getStore();
    store.kinds.clear();
    for (const [kind, entries] of Object.entries(snapshot.byKind)) {
      if (!entries || entries.length === 0) {
        continue;
      }
      const map = getOrCreateKindMap(store, kind);
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]!;
        map.set(entry.target, { ...entry });
      }
    }
  }

  /**
   * Clears either a single `kind` or the entire registry (for clean test isolation).
   */
  static clear(kind?: DecoratorKind): void {
    const store = getStore();
    if (kind !== undefined) {
      store.kinds.delete(kind);
      return;
    }
    store.kinds.clear();
  }
}
