import {
  registerMappedTypeMetadataHook,
  type MappedTypeMetadataHook,
} from "@bunest/core/common";

export const BUNEST_PROP_DOC_STORAGE_SYMBOL = Symbol.for(
  "bunest:dto:prop:doc-storage",
);

const PROP_DOC_HOOK_INSTALLED_SYMBOL = Symbol.for(
  "bunest:dto:prop:mapped-types-hook",
);

/**
 * OpenAPI / documentation metadata recorded by `@Prop(...)` on DTO properties.
 * Consumed by `@bunest/swagger`'s `SchemaExplorer` via `globalThis` with zero
 * runtime package coupling between `@bunest/validation` and `@bunest/swagger`.
 */
export interface PropDocMetadata {
  readonly description?: string;
  readonly example?: unknown;
  readonly examples?: readonly unknown[] | Record<string, unknown>;
  readonly deprecated?: boolean;
  readonly format?: string;
  readonly title?: string;
  readonly default?: unknown;
  readonly readOnly?: boolean;
  readonly writeOnly?: boolean;
  readonly nullable?: boolean;
  readonly hide?: boolean;
}

export class PropDocMetadataStorage {
  private readonly _byClass = new WeakMap<
    Function,
    Map<string, PropDocMetadata>
  >();

  set(target: Function, propertyName: string, meta: PropDocMetadata): void {
    let map = this._byClass.get(target);
    if (!map) {
      map = new Map();
      this._byClass.set(target, map);
    }
    const existing = map.get(propertyName);
    map.set(propertyName, existing ? { ...existing, ...meta } : { ...meta });
  }

  getOwn(target: Function): ReadonlyMap<string, PropDocMetadata> | undefined {
    return this._byClass.get(target);
  }

  /**
   * Collects `PropDocMetadata` across the full prototype chain (subclass overrides superclass).
   */
  getForClass(target: Function): Map<string, PropDocMetadata> {
    const chain: Function[] = [];
    let current: Function | null = target;
    while (
      current &&
      current !== Object &&
      current !== Function.prototype &&
      typeof current === "function"
    ) {
      chain.push(current);
      const proto = Object.getPrototypeOf(current);
      if (!proto || proto === current || typeof proto !== "function") {
        break;
      }
      current = proto;
    }

    const merged = new Map<string, PropDocMetadata>();
    for (let i = chain.length - 1; i >= 0; i--) {
      const own = this._byClass.get(chain[i]!);
      if (!own) continue;
      for (const [prop, meta] of own.entries()) {
        const prev = merged.get(prop);
        merged.set(prop, prev ? { ...prev, ...meta } : { ...meta });
      }
    }
    return merged;
  }

  cloneClassMetadata(
    source: Function,
    target: Function,
    propertyFilter?: (propertyName: string) => boolean,
  ): void {
    const sourceMeta = this.getForClass(source);
    for (const [prop, meta] of sourceMeta.entries()) {
      if (propertyFilter && !propertyFilter(prop)) continue;
      this.set(target, prop, meta);
    }
  }
}

export function getPropDocMetadataStorage(): PropDocMetadataStorage {
  const g = globalThis as Record<PropertyKey, unknown>;
  let storage = g[BUNEST_PROP_DOC_STORAGE_SYMBOL] as
    | PropDocMetadataStorage
    | undefined;
  if (!storage) {
    storage = new PropDocMetadataStorage();
    g[BUNEST_PROP_DOC_STORAGE_SYMBOL] = storage;
  }
  return storage;
}

export function getPropDocMetadata(
  target: Function,
): Map<string, PropDocMetadata> {
  return getPropDocMetadataStorage().getForClass(target);
}

const propDocMappedTypeHook: MappedTypeMetadataHook = ({
  source,
  target,
  propertyFilter,
}) => {
  getPropDocMetadataStorage().cloneClassMetadata(
    source,
    target,
    propertyFilter,
  );
};

function installPropDocMappedTypeHook(): void {
  const g = globalThis as Record<PropertyKey, unknown>;
  if (g[PROP_DOC_HOOK_INSTALLED_SYMBOL]) {
    return;
  }
  g[PROP_DOC_HOOK_INSTALLED_SYMBOL] = true;
  registerMappedTypeMetadataHook(propDocMappedTypeHook);
}

installPropDocMappedTypeHook();
