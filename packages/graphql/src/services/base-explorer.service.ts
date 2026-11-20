import type { ContextId } from "@bunest/common";
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

/**
 * Base explorer helper mirroring `@nestjs/graphql` `BaseExplorerService` for
 * module filtering, flat-mapping providers, grouping resolver metadata with
 * inheritance precedence, and context-id extraction.
 */
export class BaseExplorerService {
  getModules(
    modulesContainer: Map<any, any> | undefined,
    include: Function[],
    _skipGlobalImports = false,
  ): any[] {
    if (!modulesContainer) {
      return [];
    }
    if (!include || include.length === 0) {
      return [...modulesContainer.values()];
    }
    return this.includeWhitelisted(modulesContainer, include);
  }

  includeWhitelisted(
    modulesContainer: Map<any, any>,
    include: Function[],
  ): any[] {
    const allowed = new Set<Function>(include);
    const result: any[] = [];
    for (const mod of modulesContainer.values()) {
      const metatype = mod?.metatype ?? mod?.moduleClass;
      if (metatype && allowed.has(metatype)) {
        result.push(mod);
      }
    }
    return result;
  }

  flatMap<T = ExploredResolverMetadata>(
    modules: any[],
    callback: (instance: any, moduleRef: any) => T | T[],
  ): T[] {
    const out: T[] = [];
    for (const mod of modules) {
      const providers: Iterable<any> =
        mod?.providers instanceof Map
          ? mod.providers.values()
          : Array.isArray(mod?.providers)
            ? mod.providers
            : [];
      for (const wrapper of providers) {
        const mapped = callback(wrapper, mod);
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
  ): Record<string, Record<string, Function | Record<string, any>>> {
    const grouped: Record<
      string,
      Record<string, { meta: ExploredResolverMetadata; value: Function | Record<string, any> }>
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
      Record<string, Function | Record<string, any>>
    > = {};
    for (const [typeName, fields] of Object.entries(grouped)) {
      result[typeName] = {};
      for (const [fieldName, entry] of Object.entries(fields)) {
        result[typeName]![fieldName] = entry.value;
      }
    }
    return result;
  }

  getContextId(gqlContext: Record<string | symbol, any>): ContextId {
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
    if (first.target === second.target) return false;
    throw new Error(
      `Duplicate resolver handler "${first.type}.${first.name}" registered by unrelated classes ${first.target.name} and ${second.target.name}.`,
    );
  }
}
