import {
  DESIGN_METADATA_KEYS,
  METADATA_KEYS,
  MetadataRegistry,
  Scope,
  isForwardReference,
  type InjectionToken,
  type InjectTokenMetadata,
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

function isSerializedGraphCarrier(
  value: unknown,
): value is { getSerializedGraph(): SerializedGraph } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { getSerializedGraph?: unknown }).getSerializedGraph ===
      "function"
  );
}

/**
 * Inspects a scanned module graph and builds a `SerializedGraph` snapshot,
 * matching NestJS v12 `GraphInspector` (8/8 public members).
 */
export class GraphInspector {
  private readonly graph: SerializedGraph;
  private readonly enhancersMetadataCache: EnhancerMetadataCacheEntry[] = [];

  constructor(
    graphOrContainer:
      | SerializedGraph
      | { getSerializedGraph(): SerializedGraph } = new SerializedGraph(),
  ) {
    this.graph = isSerializedGraphCarrier(graphOrContainer)
      ? graphOrContainer.getSerializedGraph()
      : graphOrContainer;
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
    const metatype = source.metatype;
    if (typeof metatype !== "function") {
      return;
    }

    const sourceTokenLabel = formatToken(source.token);
    const sourceClassName = metatype.name || sourceTokenLabel;
    const sourceNodeId = this.graph.getNodeById(
      `${moduleRef.id}:controller:${sourceTokenLabel}`,
    )
      ? `${moduleRef.id}:controller:${sourceTokenLabel}`
      : `${moduleRef.id}:provider:${sourceTokenLabel}`;

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
        InjectionToken | undefined;
      if (!depToken) continue;
      const targetLabel = formatToken(depToken);
      const targetNodeId = `${moduleRef.id}:provider:${targetLabel}`;
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
          targetModuleName: moduleRef.name,
          injectionType: "constructor",
          keyOrIndex: index,
        },
      });
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
      const targetLabel = formatToken(propToken);
      const targetNodeId = `${moduleRef.id}:provider:${targetLabel}`;
      this.graph.insertEdge({
        source: sourceNodeId,
        target: targetNodeId,
        metadata: {
          type: "class-to-class",
          sourceClassName,
          targetClassName: targetLabel,
          sourceClassToken: source.token,
          targetClassToken: propToken,
          sourceModuleName: moduleRef.name,
          targetModuleName: moduleRef.name,
          injectionType: "property",
          keyOrIndex: prop.propertyKey,
        },
      });
    }
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
