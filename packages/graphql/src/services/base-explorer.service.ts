import type { ContextId } from "@bunest/core";
import { ContextIdFactory } from "@bunest/core";
import type { ExploredResolverMetadata } from "../interfaces/graphql.interface";

const CONTEXT_ID_SYMBOL = Symbol.for("bunest:graphql:context_id");

function isDerivedFrom(derived: Function, base: Function): boolean {
  if (derived === base) return false;
  let proto = Object.getPrototypeOf(derived.prototype);
  while (proto) {
    if (proto.constructor === base) {
      return true;
    }
    proto = Object.getPrototypeOf(proto);
  }
  return false;
}

export interface ExplorerModuleLike {
  readonly metatype?: Function;
  readonly moduleClass?: Function;
  readonly providers?: Map<unknown, unknown> | readonly unknown[];
  readonly imports?: ReadonlySet<ExplorerModuleLike> | readonly ExplorerModuleLike[];
  readonly isGlobal?: boolean;
}

/**
 * Base explorer helper mirroring `@nestjs/graphql` `BaseExplorerService` for
 * module filtering, flat-mapping providers, grouping resolver metadata with
 * inheritance precedence, and context-id extraction.
 */
export class BaseExplorerService {
  getModules<TKey = unknown, TModule = ExplorerModuleLike>(
    modulesContainer: ReadonlyMap<TKey, TModule> | undefined,
    include: Function[],
    skipGlobalImports = false,
  ): TModule[] {
    if (!modulesContainer) {
      return [];
    }
    if (!include || include.length === 0) {
      return [...modulesContainer.values()];
    }
    return this.includeWhitelisted(modulesContainer, include, skipGlobalImports);
  }

  includeWhitelisted<TKey = unknown, TModule = ExplorerModuleLike>(
    modulesContainer: ReadonlyMap<TKey, TModule>,
    include: Function[],
    skipGlobalImports = false,
  ): TModule[] {
    const allowed = new Set<Function>(include);
    const visited = new Set<TModule>();
    const result: TModule[] = [];

    const collect = (mod: TModule): void => {
      if (visited.has(mod)) return;
      visited.add(mod);
      result.push(mod);
      const moduleLike = mod as ExplorerModuleLike | null | undefined;
      const imports = moduleLike?.imports;
      if (imports) {
        for (const imported of imports) {
          if (skipGlobalImports && imported?.isGlobal) {
            continue;
          }
          collect(imported as unknown as TModule);
        }
      }
    };

    for (const mod of modulesContainer.values()) {
      const moduleLike = mod as ExplorerModuleLike | null | undefined;
      const metatype = moduleLike?.metatype ?? moduleLike?.moduleClass;
      if (metatype && allowed.has(metatype)) {
        collect(mod);
      }
    }
    return result;
  }

  flatMap<
    T = ExploredResolverMetadata,
    TModule extends ExplorerModuleLike = ExplorerModuleLike,
    TProvider = unknown,
  >(
    modules: readonly TModule[],
    callback: (instance: TProvider, moduleRef: TModule) => T | T[],
  ): T[] {
    const out: T[] = [];
    for (const mod of modules) {
      const providers: Iterable<unknown> =
        mod?.providers instanceof Map
          ? mod.providers.values()
          : Array.isArray(mod?.providers)
            ? mod.providers
            : [];
      for (const wrapper of providers) {
        const mapped = callback(wrapper as TProvider, mod);
        if (Array.isArray(mapped)) {
          for (const item of mapped) {
            if (item !== undefined && item !== null) out.push(item);
          }
        } else if (mapped !== undefined && mapped !== null) {
          out.push(mapped);
        }
      }
    }
    return out;
  }

  groupMetadata(
    resolvers: ExploredResolverMetadata[],
  ): Record<string, Record<string, Function | Record<string, unknown>>> {
    const grouped: Record<
      string,
      Record<
        string,
        {
          meta: ExploredResolverMetadata;
          value: Function | Record<string, unknown>;
        }
      >
    > = {};

    for (const resolver of resolvers) {
      const typeBucket = (grouped[resolver.type] ??= {});
      const existing = typeBucket[resolver.name];
      const value = resolver.callback ?? {};

      if (existing) {
        if (this.keepsPrecedence(existing.meta, resolver)) {
          continue;
        }
      }
      typeBucket[resolver.name] = { meta: resolver, value };
    }

    const result: Record<
      string,
      Record<string, Function | Record<string, unknown>>
    > = {};
    for (const [typeName, fields] of Object.entries(grouped)) {
      result[typeName] = {};
      for (const [fieldName, entry] of Object.entries(fields)) {
        result[typeName]![fieldName] = entry.value;
      }
    }
    return result;
  }

  getContextId(gqlContext: Record<string | symbol, unknown>): ContextId {
    if (gqlContext && gqlContext[CONTEXT_ID_SYMBOL]) {
      return gqlContext[CONTEXT_ID_SYMBOL] as ContextId;
    }
    const req = gqlContext?.req;
    const contextId = req
      ? ContextIdFactory.getByRequest(req)
      : ContextIdFactory.create();
    if (gqlContext && typeof gqlContext === "object") {
      gqlContext[CONTEXT_ID_SYMBOL] = contextId;
    }
    return contextId;
  }

  private keepsPrecedence(
    first: ExploredResolverMetadata,
    second: ExploredResolverMetadata,
  ): boolean {
    if (!first.target || !second.target) {
      return false;
    }
    if (first.declaredOn && second.declaredOn) {
      if (isDerivedFrom(first.declaredOn, second.declaredOn)) return true;
      if (isDerivedFrom(second.declaredOn, first.declaredOn)) return false;
    }
    if (isDerivedFrom(first.target, second.target)) return true;
    if (isDerivedFrom(second.target, first.target)) return false;
    if (first.target === second.target) {
      if (
        first.methodName &&
        second.methodName &&
        first.methodName !== second.methodName
      ) {
        throw new Error(
          `Duplicate resolver handler "${first.type}.${first.name}" registered by methods "${first.methodName}" and "${second.methodName}" on ${first.target.name}.`,
        );
      }
      return false;
    }
    if (
      first.declaredOn &&
      second.declaredOn &&
      first.declaredOn === second.declaredOn &&
      first.methodName &&
      first.methodName === second.methodName
    ) {
      return true;
    }
    throw new Error(
      `Duplicate resolver handler "${first.type}.${first.name}" registered by unrelated classes ${first.target.name} and ${second.target.name}.`,
    );
  }
}
