import {
  ForbiddenException,
  Inject,
  Injectable,
  METADATA_KEYS,
  MetadataRegistry,
  Optional,
  Scope,
  isForwardReference,
  type ControllerMetadata,
  type FactoryDependency,
  type InjectableMetadata,
  type InjectionToken,
  type ModuleImport,
  type OptionalFactoryDependency,
  type Provider,
  type RouteDefinition,
  type Type,
} from "@bunest/core";
import {
  BunestApplication,
  BunestApplicationContext,
  DIContainer,
  DiscoveryService,
  MetadataScanner,
  SerializedGraph,
  formatToken,
  type ModuleNode,
  type NormalizedProvider,
  type SerializedGraphJson,
} from "@bunest/core";

export const DEVTOOLS_OPTIONS = Symbol.for("bunest:observability:devtools");

export interface DevtoolsModuleOptions {
  /** Enable HTTP devtools endpoints (NestJS `@nestjs/devtools-integration` compatible) */
  http?: boolean;
  /** Optional port hint (NestJS `@nestjs/devtools-integration` compatible) */
  port?: number;
  /** Base path for devtools endpoints (default: "/_devtools") */
  path?: string;
  /** Expose `/_devtools/graph` and `/_devtools/routes` HTTP endpoints (default: true) */
  exposeEndpoints?: boolean;
  /**
   * Explicitly enable/disable endpoints.
   * Defaults to `process.env.NODE_ENV !== "production"` (security gate).
   */
  enabled?: boolean;
  /** Explicitly opt in to running devtools endpoints in production (default: false) */
  allowInProduction?: boolean;
  /** Optional explicit application or container reference */
  app?: BunestApplication | BunestApplicationContext;
  container?: DIContainer;
  global?: boolean;
}

export interface DevtoolsOptionsFactory {
  createDevtoolsOptions():
    Promise<DevtoolsModuleOptions> | DevtoolsModuleOptions;
}

export interface DevtoolsModuleAsyncOptions {
  imports?: ModuleImport[];
  useExisting?:
    Type<DevtoolsOptionsFactory> | InjectionToken<DevtoolsOptionsFactory>;
  useClass?: Type<DevtoolsOptionsFactory>;
  useFactory?: (
    ...args: any[]
  ) => Promise<DevtoolsModuleOptions> | DevtoolsModuleOptions;
  inject?: FactoryDependency[];
  extraProviders?: Provider[];
  /** Expose `/_devtools/*` HTTP endpoints (default: true; also respects `http`) */
  exposeEndpoints?: boolean;
  http?: boolean;
  path?: string;
  global?: boolean;
}

export interface DevtoolsModuleNode {
  readonly id: string;
  readonly name: string;
  readonly isGlobal: boolean;
  readonly isDynamic: boolean;
  readonly imports: readonly string[];
  readonly exports: readonly string[];
  readonly reExports: readonly string[];
  readonly controllers: readonly string[];
  readonly providers: readonly string[];
}

export interface DevtoolsGraphEdge {
  readonly from: string;
  readonly to: string;
  readonly type: "import" | "re-export" | "provider-dependency";
}

export interface DevtoolsProviderNode {
  readonly id: string;
  readonly moduleId: string;
  readonly moduleName: string;
  readonly token: string;
  readonly kind: NormalizedProvider["kind"];
  readonly scope: Scope;
  readonly isExported: boolean;
  readonly dependencies: readonly string[];
}

export interface DevtoolsControllerNode {
  readonly moduleId: string;
  readonly moduleName: string;
  readonly name: string;
  readonly path: string | readonly string[];
  readonly scope: Scope;
  readonly routeCount: number;
}

export interface DevtoolsRouteNode {
  readonly method: string;
  readonly path: string;
  readonly fullPath: string;
  readonly controller: string;
  readonly handler: string;
  readonly parameters: ReadonlyArray<{
    index: number;
    source: string;
    key?: string;
    metatype?: string;
  }>;
  readonly guards: readonly string[];
  readonly pipes: readonly string[];
  readonly interceptors: readonly string[];
  readonly filters: readonly string[];
  readonly httpCode?: number;
  readonly isSse: boolean;
}

export interface DevtoolsApplicationGraph {
  readonly generatedAt: string;
  readonly modules: readonly DevtoolsModuleNode[];
  readonly edges: readonly DevtoolsGraphEdge[];
  readonly providers: readonly DevtoolsProviderNode[];
  readonly controllers: readonly DevtoolsControllerNode[];
  readonly routes: readonly DevtoolsRouteNode[];
  readonly serializedGraph?: SerializedGraphJson;
}

export type DevtoolsTarget =
  BunestApplication | BunestApplicationContext | DIContainer;

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

function formatEnhancerName(item: unknown): string {
  if (typeof item === "function") {
    return item.name || "<anonymous>";
  }
  if (typeof item === "object" && item !== null) {
    return item.constructor?.name || "<instance>";
  }
  return String(item);
}

function extractProviderDependencies(provider: NormalizedProvider): string[] {
  const deps: string[] = [];

  if (provider.kind === "existing" && provider.useExisting !== undefined) {
    deps.push(formatToken(provider.useExisting));
    return deps;
  }

  if (provider.inject && provider.inject.length > 0) {
    for (const entry of provider.inject) {
      const raw = isOptionalFactoryDep(entry) ? entry.token : entry;
      const unwrapped = isForwardReference(raw) ? raw.forwardRef() : raw;
      deps.push(formatToken(unwrapped));
    }
    return deps;
  }

  if (provider.kind === "class" && provider.useClass) {
    const paramTypes = MetadataRegistry.getParamTypes(provider.useClass) ?? [];
    const injectTokens = MetadataRegistry.getInjectTokens(provider.useClass);
    const injectMap = new Map<number, unknown>();
    for (const item of injectTokens) {
      injectMap.set(item.index, item.token);
    }

    const maxIdx = Math.max(
      paramTypes.length - 1,
      ...injectTokens.map((t) => t.index),
      -1,
    );

    for (let i = 0; i <= maxIdx; i++) {
      const raw = injectMap.has(i) ? injectMap.get(i) : paramTypes[i];
      const unwrapped = isForwardReference(raw) ? raw.forwardRef() : raw;
      if (unwrapped !== undefined) {
        deps.push(formatToken(unwrapped));
      }
    }
  }

  return deps;
}

function sanitizeMermaidId(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_]/g, "_");
  return /^[a-zA-Z_]/.test(cleaned) ? cleaned : `n_${cleaned}`;
}

function escapeMermaidLabel(label: string): string {
  return label.replace(/"/g, "'");
}

function joinPaths(prefix: string, suffix: string): string {
  const combined = `/${prefix}/${suffix}`.replace(/\/+/g, "/");
  return combined.length > 1 && combined.endsWith("/")
    ? combined.slice(0, -1)
    : combined;
}

/**
 * Introspects a Bunest `DIContainer` / `BunestApplication` to emit a structured
 * machine-readable application graph, route manifest, and Mermaid `flowchart LR`.
 */
@Injectable()
export class DevtoolsService {
  private attachedApp?: BunestApplication | BunestApplicationContext;
  private attachedContainer?: DIContainer;

  constructor(
    @Optional()
    @Inject(DEVTOOLS_OPTIONS)
    private readonly options: DevtoolsModuleOptions = {},
    @Optional()
    private readonly discoveryService?: DiscoveryService,
    @Optional()
    private readonly metadataScanner?: MetadataScanner,
    @Optional()
    private readonly serializedGraph?: SerializedGraph,
  ) {
    this.attachedApp = options.app;
    this.attachedContainer = options.container;
  }

  getSerializedGraph(target?: DevtoolsTarget): SerializedGraphJson | undefined {
    if (target instanceof DIContainer) {
      return target.getSerializedGraph().toJSON();
    }
    if (
      target instanceof BunestApplication ||
      target instanceof BunestApplicationContext
    ) {
      return target.getModuleContainer().getSerializedGraph().toJSON();
    }
    if (this.attachedContainer) {
      return this.attachedContainer.getSerializedGraph().toJSON();
    }
    return this.serializedGraph?.toJSON();
  }

  attachApplication(app: BunestApplication | BunestApplicationContext): void {
    this.attachedApp = app;
    this.attachedContainer = app.getModuleContainer();
  }

  attachContainer(container: DIContainer): void {
    this.attachedContainer = container;
  }

  isEndpointsEnabled(): boolean {
    if (this.options.enabled !== undefined) {
      return this.options.enabled;
    }
    if (this.options.allowInProduction === true) {
      return true;
    }
    return Reflect.get(process.env, "NODE_ENV") !== "production";
  }

  assertEndpointsEnabled(): void {
    if (!this.isEndpointsEnabled()) {
      throw new ForbiddenException(
        "Devtools endpoints are disabled in production (set allowInProduction: true to override)",
      );
    }
  }

  getGraph(target?: DevtoolsTarget): DevtoolsApplicationGraph {
    const { modules: scannedModules, app } = this.resolveTarget(target);

    const modules: DevtoolsModuleNode[] = [];
    const edges: DevtoolsGraphEdge[] = [];
    const providers: DevtoolsProviderNode[] = [];
    const controllers: DevtoolsControllerNode[] = [];

    for (const mod of scannedModules) {
      modules.push({
        id: mod.id,
        name: mod.name,
        isGlobal: mod.isGlobal,
        isDynamic: mod.isDynamic,
        imports: mod.imports.map((m) => m.id),
        exports: [...mod.exportedTokens].map((t) => formatToken(t)),
        reExports: mod.reExportedModules.map((m) => m.id),
        controllers: mod.controllers.map((c) => c.name || "<Controller>"),
        providers: [...mod.providers.keys()].map((t) => formatToken(t)),
      });

      for (const imp of mod.imports) {
        edges.push({ from: mod.id, to: imp.id, type: "import" });
      }
      for (const reExp of mod.reExportedModules) {
        edges.push({ from: mod.id, to: reExp.id, type: "re-export" });
      }

      for (const [token, provider] of mod.providers.entries()) {
        const tokenLabel = formatToken(token);
        const providerId = `${mod.id}::${tokenLabel}`;
        const deps = extractProviderDependencies(provider);

        providers.push({
          id: providerId,
          moduleId: mod.id,
          moduleName: mod.name,
          token: tokenLabel,
          kind: provider.kind,
          scope: provider.scope,
          isExported: mod.exportedTokens.has(token),
          dependencies: deps,
        });

        for (const dep of deps) {
          edges.push({
            from: providerId,
            to: dep,
            type: "provider-dependency",
          });
        }
      }

      for (const ctrl of mod.controllers) {
        const ctrlMeta = MetadataRegistry.get<ControllerMetadata>(
          METADATA_KEYS.CONTROLLER,
          ctrl,
        );
        const injMeta = MetadataRegistry.get<InjectableMetadata>(
          METADATA_KEYS.INJECTABLE,
          ctrl,
        );
        const routeMethods = MetadataRegistry.getControllerRoutes(ctrl);

        controllers.push({
          moduleId: mod.id,
          moduleName: mod.name,
          name: ctrl.name || "<Controller>",
          path: ctrlMeta?.path ?? "/",
          scope: ctrlMeta?.scope ?? injMeta?.scope ?? Scope.SINGLETON,
          routeCount: routeMethods.length,
        });
      }
    }

    const routes = this.extractRoutes(scannedModules, app);
    const snapshot = this.getSerializedGraph(target);

    return {
      generatedAt: new Date().toISOString(),
      modules,
      edges,
      providers,
      controllers,
      routes,
      ...(snapshot && Object.keys(snapshot.nodes).length > 0
        ? { serializedGraph: snapshot }
        : {}),
    };
  }

  getRoutes(target?: DevtoolsTarget): readonly DevtoolsRouteNode[] {
    return this.getGraph(target).routes;
  }

  /**
   * Renders the scanned module graph & provider dependencies as a Mermaid `flowchart LR`.
   */
  toMermaidGraph(target?: DevtoolsTarget): string {
    const graph = this.getGraph(target);
    const lines: string[] = ["flowchart LR"];

    const modIdMap = new Map<string, string>();
    for (let i = 0; i < graph.modules.length; i++) {
      const mod = graph.modules[i]!;
      const nodeId = `M${i}_${sanitizeMermaidId(mod.name)}`;
      modIdMap.set(mod.id, nodeId);
      const flags = [
        mod.isGlobal ? "global" : "",
        mod.isDynamic ? "dynamic" : "",
      ]
        .filter(Boolean)
        .join(", ");
      const label = flags ? `${mod.name} (${flags})` : mod.name;
      lines.push(`  ${nodeId}["${escapeMermaidLabel(label)}"]`);
    }

    for (const edge of graph.edges) {
      if (edge.type === "import") {
        const fromId = modIdMap.get(edge.from);
        const toId = modIdMap.get(edge.to);
        if (fromId && toId) {
          lines.push(`  ${fromId} --> ${toId}`);
        }
      } else if (edge.type === "re-export") {
        const fromId = modIdMap.get(edge.from);
        const toId = modIdMap.get(edge.to);
        if (fromId && toId) {
          lines.push(`  ${fromId} -.->|re-export| ${toId}`);
        }
      }
    }

    // Add provider dependency edges within module subgraphs for readability
    const providerIdMap = new Map<string, string>();
    for (let i = 0; i < graph.providers.length; i++) {
      const p = graph.providers[i]!;
      const pId = `P${i}_${sanitizeMermaidId(p.token)}`;
      providerIdMap.set(p.id, pId);
      if (!providerIdMap.has(p.token)) {
        providerIdMap.set(p.token, pId);
      }
      const modNodeId = modIdMap.get(p.moduleId);
      if (modNodeId) {
        lines.push(
          `  ${pId}["${escapeMermaidLabel(`${p.token} (${p.scope})`)}"]`,
        );
        lines.push(`  ${modNodeId} -.->|provides| ${pId}`);
      }
    }

    for (const edge of graph.edges) {
      if (edge.type === "provider-dependency") {
        const fromId = providerIdMap.get(edge.from);
        const toId = providerIdMap.get(edge.to);
        if (fromId && toId && fromId !== toId) {
          lines.push(`  ${fromId} -->|injects| ${toId}`);
        }
      }
    }

    return lines.join("\n");
  }

  private resolveTarget(target?: DevtoolsTarget): {
    modules: readonly ModuleNode[];
    app?: BunestApplication;
  } {
    if (target instanceof DIContainer) {
      return { modules: target.getGraph().topologicalOrder };
    }
    if (target instanceof BunestApplication) {
      return {
        modules: target.getModuleContainer().getGraph().topologicalOrder,
        app: target,
      };
    }
    if (target instanceof BunestApplicationContext) {
      return {
        modules: target.getModuleContainer().getGraph().topologicalOrder,
      };
    }

    if (this.attachedApp) {
      return {
        modules: this.attachedApp.getModuleContainer().getGraph()
          .topologicalOrder,
        app:
          this.attachedApp instanceof BunestApplication
            ? this.attachedApp
            : undefined,
      };
    }

    if (this.attachedContainer) {
      return { modules: this.attachedContainer.getGraph().topologicalOrder };
    }

    if (this.discoveryService) {
      return { modules: this.discoveryService.getModules() };
    }

    throw new Error(
      "DevtoolsService has no attached BunestApplication, DIContainer, or DiscoveryService. Call devtools.attachApplication(app) or pass target to getGraph(app).",
    );
  }

  private extractRoutes(
    modules: readonly ModuleNode[],
    app?: BunestApplication,
  ): DevtoolsRouteNode[] {
    if (app) {
      const compiled: readonly RouteDefinition[] = app.getRoutes();
      if (compiled.length > 0) {
        return compiled.map((route) => this.buildRouteNode(route));
      }
    }

    const result: DevtoolsRouteNode[] = [];
    const seenControllers = new Set<Type<unknown>>();

    for (const mod of modules) {
      for (const ctrl of mod.controllers) {
        if (seenControllers.has(ctrl)) continue;
        seenControllers.add(ctrl);

        const ctrlMeta = MetadataRegistry.get<ControllerMetadata>(
          METADATA_KEYS.CONTROLLER,
          ctrl,
        );
        const prefixes = ctrlMeta
          ? Array.isArray(ctrlMeta.path)
            ? ctrlMeta.path
            : [ctrlMeta.path]
          : ["/"];
        const routeMethods = MetadataRegistry.getControllerRoutes(ctrl);

        for (const prefix of prefixes) {
          for (const methodMeta of routeMethods) {
            const subPaths = Array.isArray(methodMeta.path)
              ? methodMeta.path
              : [methodMeta.path];
            for (const subPath of subPaths) {
              const fullPath = joinPaths(prefix, subPath);
              const params = MetadataRegistry.getRouteParameters(
                ctrl,
                methodMeta.handlerKey,
              );
              const handler = (
                ctrl.prototype as Record<string | symbol, unknown>
              )?.[methodMeta.handlerKey];
              const httpCode =
                typeof handler === "function"
                  ? MetadataRegistry.get<number>(
                      METADATA_KEYS.HTTP_CODE,
                      handler,
                    )
                  : undefined;

              result.push(
                this.buildRouteNode({
                  method: methodMeta.method,
                  path: subPath,
                  fullPath,
                  controller: ctrl,
                  handlerKey: methodMeta.handlerKey,
                  parameters: params,
                  httpCode,
                  isSse: methodMeta.isSse,
                }),
              );
            }
          }
        }
      }
    }

    return result;
  }

  private buildRouteNode(route: RouteDefinition): DevtoolsRouteNode {
    const ctrl = route.controller;
    const handler = (ctrl.prototype as Record<string | symbol, unknown>)?.[
      route.handlerKey
    ];

    const collectEnhancers = (key: InjectionToken | symbol): string[] => {
      const classItems = MetadataRegistry.getMergedClassArray<unknown>(
        key as symbol,
        ctrl,
      );
      const methodItems =
        typeof handler === "function"
          ? (MetadataRegistry.get<readonly unknown[]>(key as symbol, handler) ??
            [])
          : [];
      return [...classItems, ...methodItems].map(formatEnhancerName);
    };

    return {
      method: route.method,
      path: route.path,
      fullPath: route.fullPath,
      controller: ctrl.name || "<Controller>",
      handler: String(route.handlerKey),
      parameters: route.parameters.map((p) => ({
        index: p.index,
        source: p.source,
        ...(p.key !== undefined ? { key: p.key } : {}),
        ...(p.metatype ? { metatype: p.metatype.name || "<anonymous>" } : {}),
      })),
      guards: collectEnhancers(METADATA_KEYS.GUARDS),
      pipes: collectEnhancers(METADATA_KEYS.PIPES),
      interceptors: collectEnhancers(METADATA_KEYS.INTERCEPTORS),
      filters: collectEnhancers(METADATA_KEYS.EXCEPTION_FILTERS),
      ...(route.httpCode !== undefined ? { httpCode: route.httpCode } : {}),
      isSse: Boolean(route.isSse),
    };
  }
}
