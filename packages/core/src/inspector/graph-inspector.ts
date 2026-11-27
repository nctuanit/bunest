import {
  DESIGN_METADATA_KEYS,
  METADATA_KEYS,
  MetadataRegistry,
  Scope,
  isForwardReference,
  type FactoryDependency,
  type InjectionToken,
  type InjectTokenMetadata,
  type OptionalFactoryDependency,
  type PropertyInjectMetadata,
} from "../common/index";
import type { InstanceWrapper } from "../discovery/discovery.service";
import { formatToken } from "../errors/token-formatter";
import type { ModuleNode } from "../module/module-node";
import { PartialGraphHost } from "./partial-graph.host";
import {
  SerializedGraph,
  type GraphEntrypoint,
  type GraphNodeDefinition,
  type OrphanedEnhancerDefinition,
} from "./serialized-graph";

export interface EnhancerMetadataCacheEntry {
  moduleToken: string;
  classRef: unknown;
  enhancerInstanceWrapper?: InstanceWrapper<any>;
  enhancerRef?: unknown;
  targetNodeId: string;
  methodKey?: string | symbol;
  subtype: "guard" | "interceptor" | "pipe" | "filter";
}

interface SerializedGraphCarrier {
  getSerializedGraph(): SerializedGraph;
  getModules?(): ReadonlyMap<string, ModuleNode>;
}

function isSerializedGraphCarrier(
  value: unknown,
): value is SerializedGraphCarrier {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { getSerializedGraph?: unknown }).getSerializedGraph ===
      "function"
  );
}

function isOptionalFactoryDep(
  dep: FactoryDependency,
): dep is OptionalFactoryDependency {
  return (
    typeof dep === "object" &&
    dep !== null &&
    "token" in dep &&
    "optional" in dep
  );
}

/**
 * Inspects a scanned module graph and builds a `SerializedGraph` snapshot,
 * matching NestJS v12 `GraphInspector` (8/8 public members).
 */
export class GraphInspector {
  private readonly graph: SerializedGraph;
  private readonly enhancersMetadataCache: EnhancerMetadataCacheEntry[] = [];
  private readonly knownModules = new Map<string, ModuleNode>();
  private readonly modulesSource?: () => ReadonlyMap<string, ModuleNode>;

  constructor(
    graphOrContainer:
      | SerializedGraph
      | SerializedGraphCarrier = new SerializedGraph(),
  ) {
    if (isSerializedGraphCarrier(graphOrContainer)) {
      this.graph = graphOrContainer.getSerializedGraph();
      const getModules = graphOrContainer.getModules;
      if (typeof getModules === "function") {
        const boundGetModules = () => getModules.call(graphOrContainer);
        this.modulesSource = boundGetModules;
        for (const [id, mod] of boundGetModules().entries()) {
          this.knownModules.set(id, mod);
        }
      }
    } else {
      this.graph = graphOrContainer;
    }
  }

  getSerializedGraph(): SerializedGraph {
    return this.graph;
  }

  inspectModules(
    modules: ReadonlyMap<string, ModuleNode> | Iterable<ModuleNode>,
  ): void {
    const list =
      modules instanceof Map
        ? [...modules.values()]
        : [...(modules as Iterable<ModuleNode>)];

    for (const mod of list) {
      this.knownModules.set(mod.id, mod);
    }

    for (const mod of list) {
      this.graph.insertNode({
        id: mod.id,
        label: mod.name,
        metadata: {
          type: "module",
          global: mod.isGlobal,
          dynamic: mod.isDynamic,
          internal: false,
        },
      });

      for (const provider of mod.providers.values()) {
        const nodeId = `${mod.id}:provider:${formatToken(provider.token)}`;
        this.graph.insertNode({
          id: nodeId,
          label: formatToken(provider.token),
          parent: mod.id,
          metadata: {
            type: "provider",
            sourceModuleName: mod.name,
            token: formatToken(provider.token),
            scope: provider.scope,
            durable: provider.durable === true,
            static: provider.scope === Scope.SINGLETON,
            transient: provider.scope === Scope.TRANSIENT,
            exported: mod.exportedTokens.has(provider.token),
          },
        });
      }

      for (const ctrl of mod.controllers) {
        const ctrlName = ctrl.name || "<AnonymousController>";
        const nodeId = `${mod.id}:controller:${ctrlName}`;
        this.graph.insertNode({
          id: nodeId,
          label: ctrlName,
          parent: mod.id,
          metadata: {
            type: "controller",
            sourceModuleName: mod.name,
            token: ctrlName,
          },
        });
      }
    }

    for (const mod of list) {
      for (const imported of mod.imports) {
        this.graph.insertEdge({
          source: mod.id,
          target: imported.id,
          metadata: {
            type: "module-to-module",
            sourceModuleName: mod.name,
            targetModuleName: imported.name,
          },
        });
      }
    }
  }

  insertClassNode(
    moduleRef: ModuleNode,
    wrapper: InstanceWrapper<any>,
    type: Exclude<GraphNodeDefinition["metadata"]["type"], "module">,
  ): void {
    this.knownModules.set(moduleRef.id, moduleRef);
    const tokenLabel = formatToken(wrapper.token);
    const nodeId = `${moduleRef.id}:${type}:${tokenLabel}`;
    const providerEntry = moduleRef.providers.get(wrapper.token);
    const scope = providerEntry?.scope ?? wrapper.scope ?? Scope.SINGLETON;
    const label =
      typeof wrapper.metatype === "function" && wrapper.metatype.name
        ? wrapper.metatype.name
        : tokenLabel;

    this.graph.insertNode({
      id: nodeId,
      label,
      parent: moduleRef.id,
      metadata: {
        type,
        sourceModuleName: moduleRef.name,
        token: tokenLabel,
        scope,
        durable: providerEntry?.durable === true,
        static: scope === Scope.SINGLETON,
        transient: scope === Scope.TRANSIENT,
        exported: moduleRef.exportedTokens.has(wrapper.token),
      },
    });
  }

  insertEnhancerMetadataCache(entry: EnhancerMetadataCacheEntry): void {
    this.enhancersMetadataCache.push(entry);
    if (entry.enhancerInstanceWrapper) {
      const nodeId = `${entry.moduleToken}:injectable:${formatToken(entry.enhancerInstanceWrapper.token)}`;
      this.graph.insertAttachedEnhancer(nodeId);
    } else if (entry.enhancerRef !== undefined) {
      this.graph.insertOrphanedEnhancer({
        subtype: entry.subtype,
        ref: entry.enhancerRef,
      });
    }
  }

  inspectInstanceWrapper<T = any>(
    source: InstanceWrapper<T>,
    moduleRef: ModuleNode,
  ): void {
    this.knownModules.set(moduleRef.id, moduleRef);
    const metatype = source.metatype;
    const sourceTokenLabel = formatToken(source.token);
    const sourceNodeId = this.graph.getNodeById(
      `${moduleRef.id}:controller:${sourceTokenLabel}`,
    )
      ? `${moduleRef.id}:controller:${sourceTokenLabel}`
      : `${moduleRef.id}:provider:${sourceTokenLabel}`;

    const insertDependencyEdge = (
      depToken: InjectionToken,
      sourceClassName: string,
      injectionType: "constructor" | "property" | "decorator",
      keyOrIndex: string | number | symbol,
    ): void => {
      const targetLabel = formatToken(depToken);
      const targetOwner = this.resolveDependencyOwner(moduleRef, depToken);
      const targetNodeId = `${targetOwner.id}:provider:${targetLabel}`;
      this.graph.insertEdge({
        source: sourceNodeId,
        target: targetNodeId,
        metadata: {
          type: "class-to-class",
          sourceClassName,
          targetClassName: targetLabel,
          sourceClassToken: source.token,
          targetClassToken: depToken,
          sourceModuleName: moduleRef.name,
          targetModuleName: targetOwner.name,
          injectionType,
          keyOrIndex,
        },
      });
    };

    if (typeof metatype !== "function") {
      const providerDef = moduleRef.providers.get(source.token);
      if (!providerDef) {
        return;
      }
      if (providerDef.kind === "existing" && providerDef.useExisting !== undefined) {
        const depToken = isForwardReference(providerDef.useExisting)
          ? (providerDef.useExisting.forwardRef() as InjectionToken)
          : providerDef.useExisting;
        insertDependencyEdge(depToken, sourceTokenLabel, "constructor", 0);
        return;
      }
      if (providerDef.inject && providerDef.inject.length > 0) {
        for (let index = 0; index < providerDef.inject.length; index++) {
          const entry = providerDef.inject[index];
          if (entry === undefined) continue;
          const raw = isOptionalFactoryDep(entry) ? entry.token : entry;
          const depToken = isForwardReference(raw)
            ? (raw.forwardRef() as InjectionToken)
            : (raw as InjectionToken);
          if (!depToken) continue;
          insertDependencyEdge(depToken, sourceTokenLabel, "constructor", index);
        }
      }
      return;
    }

    const sourceClassName = metatype.name || sourceTokenLabel;

    const paramTypes =
      MetadataRegistry.get<unknown[]>(DESIGN_METADATA_KEYS.PARAMTYPES, metatype) ??
      [];
    const injectTokens =
      MetadataRegistry.get<readonly InjectTokenMetadata[]>(
        METADATA_KEYS.INJECT_TOKENS,
        metatype,
      ) ?? [];
    const injectByIndex = new Map<number, InjectionToken>();
    for (const entry of injectTokens) {
      const resolvedTok = isForwardReference(entry.token)
        ? (entry.token.forwardRef() as InjectionToken)
        : entry.token;
      injectByIndex.set(entry.index, resolvedTok);
    }

    const maxArgs = Math.max(
      paramTypes.length,
      ...injectTokens.map((i) => i.index + 1),
      0,
    );

    for (let index = 0; index < maxArgs; index++) {
      const depToken = (injectByIndex.get(index) ?? paramTypes[index]) as
        | InjectionToken
        | undefined;
      if (!depToken) continue;
      insertDependencyEdge(depToken, sourceClassName, "constructor", index);
    }

    const propInjects =
      MetadataRegistry.get<readonly PropertyInjectMetadata[]>(
        METADATA_KEYS.PROPERTY_INJECT_TOKENS,
        metatype,
      ) ?? [];
    for (const prop of propInjects) {
      const propToken = isForwardReference(prop.token)
        ? (prop.token.forwardRef() as InjectionToken)
        : prop.token;
      if (!propToken) continue;
      insertDependencyEdge(
        propToken,
        sourceClassName,
        "property",
        prop.propertyKey,
      );
    }
  }

  /**
   * Resolves the actual owning `ModuleNode` for `token` requested from `requestingModule`,
   * honoring ADR-007 precedence: local provider > direct/re-exported imports > `@Global()` modules > known modules.
   */
  private resolveDependencyOwner(
    requestingModule: ModuleNode,
    token: InjectionToken,
  ): ModuleNode {
    // 1. Local provider in requesting module
    if (requestingModule.providers.has(token)) {
      return requestingModule;
    }

    // 2. Direct non-global imports (including transitive re-exports)
    for (const imported of requestingModule.imports) {
      if (imported.isGlobal) {
        continue;
      }
      const owners = imported.getEffectiveExports().get(token);
      if (owners && owners.size > 0) {
        const [firstOwner] = owners;
        if (firstOwner) {
          return firstOwner;
        }
      }
    }

    // Sync any newly added modules from container if attached
    if (this.modulesSource) {
      for (const [id, mod] of this.modulesSource().entries()) {
        if (!this.knownModules.has(id)) {
          this.knownModules.set(id, mod);
        }
      }
    }

    // 3. @Global() modules (exported tokens first, then direct provider match)
    const globalCandidates = new Set<ModuleNode>();
    for (const imported of requestingModule.imports) {
      if (imported.isGlobal) {
        globalCandidates.add(imported);
      }
    }
    for (const mod of this.knownModules.values()) {
      if (mod.isGlobal) {
        globalCandidates.add(mod);
      }
    }
    for (const globalMod of globalCandidates) {
      const owners = globalMod.getEffectiveExports().get(token);
      if (owners && owners.size > 0) {
        const [firstOwner] = owners;
        if (firstOwner) {
          return firstOwner;
        }
      }
    }
    for (const globalMod of globalCandidates) {
      if (globalMod.providers.has(token)) {
        return globalMod;
      }
    }

    // 4. Fallback: any known module declaring the provider
    for (const mod of this.knownModules.values()) {
      if (mod.providers.has(token)) {
        return mod;
      }
    }

    return requestingModule;
  }

  insertEntrypointDefinition<T = Record<string, unknown>>(
    definition: GraphEntrypoint<T>,
    parentId: string,
  ): void {
    this.graph.insertEntrypoint(definition, parentId);
  }

  insertOrphanedEnhancer(entry: OrphanedEnhancerDefinition): void {
    this.graph.insertOrphanedEnhancer(entry);
  }

  insertAttachedEnhancer(nodeId: string | InstanceWrapper<any>): void {
    const id = typeof nodeId === "string" ? nodeId : formatToken(nodeId.token);
    this.graph.insertAttachedEnhancer(id);
  }

  registerPartial(error: unknown): void {
    this.graph.status = "partial";
    this.graph.metadata = {
      cause: {
        type: error instanceof Error ? error.name : "unknown",
        error: error instanceof Error ? error.message : String(error),
      },
    };
    PartialGraphHost.register(this.graph);
  }
}
