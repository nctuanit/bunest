import {
  APP_FILTER,
  APP_GUARD,
  APP_INTERCEPTOR,
  APP_PIPE,
  INQUIRER,
  METADATA_KEYS,
  MetadataRegistry,
  REQUEST,
  REQUEST_CONTEXT,
  Reflector,
  Scope,
  hasMethodAspects,
  isDynamicModule,
  isForwardReference,
  type Abstract,
  type ControllerMetadata,
  type DynamicModule,
  type FactoryDependency,
  type InjectionToken,
  type InstrumentOptions,
  type IntrospectionResult,
  type OnModuleInit,
  type OptionalFactoryDependency,
  type Provider,
  type ResponseContext,
  type Type,
} from "../common/index";
import {
  BUNEST_APPLICATION_CONFIG_TOKEN,
  BUNEST_HTTP_ADAPTER_HOST_TOKEN,
  getCurrentRequestContext,
  type AbstractHttpAdapter,
} from "../http/index";
import {
  AOP_POINTCUTS_TOKEN,
  getGlobalPointcuts,
  getGlobalPointcutsVersion,
  hasMatchingPointcuts,
  type PointcutRule,
} from "../aop/aop-pipeline";
import {
  collectClassAspectTokens,
  isMethodAspectClass,
  weaveInstanceMethodAspects,
  weaveProxyMethodAspects,
  type AspectResolverObject,
  type MethodAspectResolverHost,
  type ResolvedAspectEntry,
} from "../aop/method-aspect-weaver";
import { ApplicationConfig } from "../application/application-config";
import {
  DiscoveryService,
  type DiscoveryFilterOptions,
  type DiscoveryHost,
  type InstanceWrapper,
} from "../discovery/discovery.service";
import { MetadataScanner } from "../discovery/metadata-scanner";
import {
  CircularDependencyException,
  ScopeLeakException,
  UnknownDependencyException,
  type ScopeChainNode,
} from "../errors/core.exceptions";
import { formatToken } from "../errors/token-formatter";
import { ExternalContextCreator } from "../helpers/external-context-creator";
import { HttpAdapterHost } from "../helpers/http-adapter-host";
import { GraphInspector } from "../inspector/graph-inspector";
import { InitializeOnPreviewAllowlist } from "../inspector/initialize-on-preview.allowlist";
import { SerializedGraph } from "../inspector/serialized-graph";
import {
  ENHANCER_OVERRIDE_MARKER,
  isContextId,
  isEnhancerOverrideEntry,
  type BunestApplicationContextOptions,
  type ContainerOverrides,
  type ContextId,
  type EnhancerKind,
  type EnhancerOverrideEntry,
  type EnhancerOverrideValue,
  type MockFactory,
  type ModuleRefGetOptions,
  type ModuleRefHost,
  type NormalizedProvider,
  type RequestScopeContainer,
} from "../interfaces/core-types.interface";
import {
  LazyModuleLoader,
  type LazyModuleHost,
  type LazyModuleLoaderOptions,
} from "../module/lazy-module-loader";
import { ModuleNode } from "../module/module-node";
import {
  MULTI_PROVIDER_TOKENS,
  ModuleScanner,
  getInjectableScope,
  isInjectableDurable,
  normalizeProvider,
  type ScannedModuleGraph,
} from "../module/module-scanner";
import { ContextIdFactory } from "./context-id.factory";
import { ModuleRef } from "./module-ref";
import { ModulesContainer } from "./modules-container";
import { RequestContainer } from "./request-container";

const EMPTY_POINTCUTS: readonly PointcutRule[] = Object.freeze([]);

export interface DIContainerOptions {
  readonly preview?: boolean;
  readonly snapshot?: boolean;
  readonly instrument?: InstrumentOptions;
  readonly contextOptions?: BunestApplicationContextOptions;
}

interface DependencyDescriptor {
  readonly index?: number;
  readonly propertyKey?: string | symbol;
  readonly rawToken: unknown;
  readonly token?: InjectionToken;
  readonly optional: boolean;
  readonly isForwardRef: boolean;
}

interface DeferredProxyBox {
  target?: object;
  readonly name: string;
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

function unwrapToken(raw: unknown): {
  token?: InjectionToken;
  isForwardRef: boolean;
} {
  if (isForwardReference(raw)) {
    const resolved = raw.forwardRef();
    return {
      token: resolved as InjectionToken | undefined,
      isForwardRef: true,
    };
  }
  return {
    token: raw as InjectionToken | undefined,
    isForwardRef: false,
  };
}

function getControllerScope(controller: Type<unknown>): Scope {
  const ctrlMeta = MetadataRegistry.get<ControllerMetadata>(
    METADATA_KEYS.CONTROLLER,
    controller,
  );
  if (ctrlMeta?.scope) {
    return ctrlMeta.scope;
  }
  return getInjectableScope(controller);
}

function isControllerDurable(controller: Type<unknown>): boolean {
  const ctrlMeta = MetadataRegistry.get<ControllerMetadata>(
    METADATA_KEYS.CONTROLLER,
    controller,
  );
  if (ctrlMeta?.durable !== undefined) {
    return ctrlMeta.durable;
  }
  return isInjectableDurable(controller);
}

function isBuiltInRequestToken(token: InjectionToken): boolean {
  return token === REQUEST || token === REQUEST_CONTEXT;
}

function isBuiltInSingletonToken(token: InjectionToken): boolean {
  return (
    token === ModuleRef ||
    token === Reflector ||
    token === DiscoveryService ||
    token === MetadataScanner ||
    token === LazyModuleLoader ||
    token === HttpAdapterHost ||
    token === ApplicationConfig ||
    token === BUNEST_HTTP_ADAPTER_HOST_TOKEN ||
    token === BUNEST_APPLICATION_CONFIG_TOKEN ||
    token === ModulesContainer ||
    token === ExternalContextCreator ||
    token === SerializedGraph ||
    token === GraphInspector ||
    token === INQUIRER
  );
}

function hasOnModuleInit(value: unknown): value is OnModuleInit {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Partial<OnModuleInit>).onModuleInit === "function"
  );
}

function normalizeEnhancerOverride(
  raw: EnhancerOverrideValue,
): EnhancerOverrideEntry {
  if (isEnhancerOverrideEntry(raw)) {
    return raw;
  }
  if (typeof raw === "function") {
    return {
      [ENHANCER_OVERRIDE_MARKER]: true,
      kind: "class",
      useClass: raw as Type<unknown>,
    };
  }
  return {
    [ENHANCER_OVERRIDE_MARKER]: true,
    kind: "value",
    value: raw,
  };
}

function enhancerOverrideToNormalizedProvider(
  token: InjectionToken,
  entry: EnhancerOverrideEntry,
): NormalizedProvider {
  switch (entry.kind) {
    case "value":
      return normalizeProvider({
        provide: token,
        useValue: entry.value,
      });
    case "class":
      return normalizeProvider({
        provide: token,
        useClass: entry.useClass,
        scope: entry.scope,
      });
    case "factory":
      return normalizeProvider({
        provide: token,
        useFactory: entry.factory,
        inject: entry.inject ? [...entry.inject] : undefined,
        scope: entry.scope,
      });
    case "existing":
      return normalizeProvider({
        provide: token,
        useExisting: entry.useExisting,
      });
  }
}

/**
 * Full Bunest DI container supporting singleton, transient, and request scopes,
 * strict module visibility (ADR-007), forwardRef circular singletons,
 * fail-fast bootstrap cycle & scope-leak detection (ADR-012), and provider overrides.
 */
export class DIContainer
  implements
    ModuleRefHost,
    DiscoveryHost,
    LazyModuleHost,
    MethodAspectResolverHost
{
  private readonly graph: ScannedModuleGraph;
  private readonly modulesMap: Map<string, ModuleNode>;
  private readonly topologicalModules: ModuleNode[];
  private readonly globalModulesList: ModuleNode[];
  private readonly staticModuleNodes: Map<Type<unknown>, ModuleNode>;
  private readonly dynamicModuleNodes: Map<DynamicModule, ModuleNode>;

  private readonly singletons = new Map<string, unknown>();
  private readonly controllerSingletons = new Map<Type<unknown>, object>();
  private readonly controllerOwner = new Map<Type<unknown>, ModuleNode>();
  private readonly enhancerOwner = new Map<Type<unknown>, ModuleNode>();
  private readonly controllerEnhancerUsages: Array<{
    cls: Type<unknown>;
    mod: ModuleNode;
    kind?: EnhancerKind;
  }> = [];
  private readonly syntheticEnhancers = new Map<
    Type<unknown>,
    {
      module: ModuleNode;
      provider: NormalizedProvider;
      scope: Scope;
      cacheKey: string;
      precomputedInstance?: unknown;
      allowRootFallback?: boolean;
    }
  >();
  private readonly multiProviderInstances = new Map<
    InjectionToken,
    Array<{
      module: ModuleNode;
      provider: NormalizedProvider;
      instance?: unknown;
      syntheticToken?: Type<unknown>;
    }>
  >();
  private readonly moduleRefs = new Map<string, ModuleRef>();
  private readonly reflector = new Reflector();
  private readonly metadataScanner = new MetadataScanner();
  private readonly discoveryService: DiscoveryService;
  private readonly lazyModuleLoader: LazyModuleLoader;
  private readonly httpAdapterHost = new HttpAdapterHost();
  private readonly _applicationConfig = new ApplicationConfig();
  private readonly _contextOptions: BunestApplicationContextOptions;
  private readonly modulesContainer = new ModulesContainer();
  private readonly externalContextCreator: ExternalContextCreator;
  private readonly _serializedGraph = new SerializedGraph();
  private readonly graphInspector: GraphInspector;
  private readonly dynamicModulesMetadata = new Map<
    string,
    Partial<DynamicModule>
  >();
  private internalCoreModule?: ModuleNode;
  private readonly previewMode: boolean;
  private readonly snapshotEnabled: boolean;
  private readonly instanceDecorator?: (instance: unknown) => unknown;
  private readonly deferredBoxes = new Map<string, DeferredProxyBox>();
  private readonly tokenKeyIds = new Map<InjectionToken, number>();
  private readonly requestScopeCache = new Map<string, boolean>();
  private aspectPresenceCache = new WeakMap<Function, boolean>();
  private dynamicAspectPresenceCache = new WeakMap<Function, boolean>();
  private moduleAspectPresenceCache = new WeakMap<
    ModuleNode,
    WeakMap<Function, boolean>
  >();
  private moduleDynamicAspectPresenceCache = new WeakMap<
    ModuleNode,
    WeakMap<Function, boolean>
  >();
  private cachedGlobalPointcutsVersion = getGlobalPointcutsVersion();
  private readonly resolvedPointcutProviders = new Map<
    ModuleNode,
    readonly PointcutRule[]
  >();
  private ownerPointcutsCache = new WeakMap<
    ModuleNode,
    readonly PointcutRule[]
  >();
  private containerGlobalPointcuts: readonly PointcutRule[] = [];
  private hasModuleScopedPointcuts = false;
  private pointcutsIndexed = false;
  private readonly wovenInstances = new WeakSet<object>();
  private tokenIdCounter = 0;
  private syntheticCounter = 0;
  private lazyCounter = 0;

  private readonly providerOverrides = new Map<InjectionToken, Provider>();
  private readonly guardOverrides = new Map<
    Type<unknown>,
    EnhancerOverrideEntry
  >();
  private readonly pipeOverrides = new Map<
    Type<unknown>,
    EnhancerOverrideEntry
  >();
  private readonly interceptorOverrides = new Map<
    Type<unknown>,
    EnhancerOverrideEntry
  >();
  private readonly filterOverrides = new Map<
    Type<unknown>,
    EnhancerOverrideEntry
  >();
  private readonly overriddenFilterOriginalClass = new WeakMap<
    NormalizedProvider,
    Type<unknown>
  >();
  private readonly overriddenProviderKeys = new Set<string>();
  private readonly overriddenMultiProviders = new WeakSet<NormalizedProvider>();

  private mocker?: MockFactory;
  private readonly autoMocks = new Map<InjectionToken, unknown>();
  private readonly contextContainers = new Map<
    number | symbol,
    RequestContainer
  >();
  private readonly durableContainers = new Map<
    number | symbol,
    RequestContainer
  >();
  private readonly pendingLazyLoads = new Map<object, Promise<ModuleRef>>();
  private readonly pendingModuleInits = new Map<string, Promise<void>>();
  private readonly inFlightNodeHolders = new Map<string, Set<symbol>>();
  private readonly committedLazyNodes = new Set<string>();
  private readonly moduleOverrides = new Map<
    Type<unknown> | DynamicModule,
    Type<unknown> | DynamicModule
  >();
  private onLazyModuleLoaded?: (
    groups: Array<{ module: ModuleNode; instances: object[] }>,
  ) => Promise<void>;

  private validated = false;
  private initialized = false;

  constructor(
    initialGraph: ScannedModuleGraph,
    options: DIContainerOptions = {},
  ) {
    this.previewMode = options.preview === true;
    this.snapshotEnabled = options.snapshot === true || this.previewMode;
    this.instanceDecorator = options.instrument?.instanceDecorator;
    this._contextOptions = options.contextOptions ?? {
      preview: options.preview,
      snapshot: options.snapshot,
      instrument: options.instrument,
    };

    this.modulesMap = new Map(initialGraph.modules);
    for (const [id, mod] of this.modulesMap.entries()) {
      this.modulesContainer.set(id, mod);
    }
    this.topologicalModules = [...initialGraph.topologicalOrder];
    this.globalModulesList = [...initialGraph.globalModules];
    this.staticModuleNodes = new Map(initialGraph.staticModuleMap ?? []);
    if (this.staticModuleNodes.size === 0) {
      for (const mod of this.topologicalModules) {
        if (!mod.isDynamic) {
          this.staticModuleNodes.set(mod.metatype, mod);
        }
      }
    }
    this.dynamicModuleNodes = new Map(initialGraph.dynamicModuleMap ?? []);
    this.graph = {
      root: initialGraph.root,
      modules: this.modulesMap,
      topologicalOrder: this.topologicalModules,
      globalModules: this.globalModulesList,
      staticModuleMap: this.staticModuleNodes,
      dynamicModuleMap: this.dynamicModuleNodes,
    };

    this.discoveryService = new DiscoveryService(this);
    this.lazyModuleLoader = new LazyModuleLoader(this);
    this.graphInspector = new GraphInspector(this._serializedGraph);
    this.externalContextCreator = ExternalContextCreator.fromContainer(this);

    for (const mod of this.topologicalModules) {
      this.moduleRefs.set(mod.id, new ModuleRef(this, mod.id));
      for (const ctrl of mod.controllers) {
        this.controllerOwner.set(ctrl, mod);
        this.indexControllerEnhancers(ctrl, mod);
      }
    }
  }

  get applicationConfig(): ApplicationConfig {
    return this._applicationConfig;
  }

  get contextOptions(): BunestApplicationContextOptions {
    return this._contextOptions;
  }

  get serializedGraph(): SerializedGraph {
    return this._serializedGraph;
  }

  getHttpAdapterHost(): HttpAdapterHost {
    return this.httpAdapterHost;
  }

  getApplicationConfig(): ApplicationConfig {
    return this._applicationConfig;
  }

  getModulesContainer(): ModulesContainer {
    return this.modulesContainer;
  }

  getSerializedGraph(): SerializedGraph {
    return this._serializedGraph;
  }

  getGraphInspector(): GraphInspector {
    return this.graphInspector;
  }

  // =========================================================================
  // NestJS `NestContainer` Compatibility Facade (31/31 public members)
  // =========================================================================

  getModules(): ModulesContainer {
    return this.modulesContainer;
  }

  getModuleByKey(moduleKey: string): ModuleNode | undefined {
    return this.modulesMap.get(moduleKey);
  }

  getHttpAdapterRef(): AbstractHttpAdapter {
    return this.httpAdapterHost.httpAdapter as unknown as AbstractHttpAdapter;
  }

  getHttpAdapterHostRef(): HttpAdapterHost {
    return this.httpAdapterHost;
  }

  setHttpAdapter(httpAdapter: unknown): void {
    this.httpAdapterHost.httpAdapter = httpAdapter as HttpAdapterHost["httpAdapter"];
  }

  registerCoreModuleRef(moduleRef: ModuleNode): void {
    this.internalCoreModule = moduleRef;
  }

  getInternalCoreModuleRef(): ModuleNode | undefined {
    return this.internalCoreModule;
  }

  registerRequestProvider<T = any>(request: T, contextId: ContextId): void {
    this.registerRequestByContextId(request, contextId);
  }

  isGlobalModule(
    metatype: Type<any>,
    dynamicMetadata?: Partial<DynamicModule>,
  ): boolean {
    if (dynamicMetadata?.global === true) {
      return true;
    }
    return (
      MetadataRegistry.get<boolean>(METADATA_KEYS.GLOBAL_MODULE, metatype) ===
      true
    );
  }

  addGlobalModule(module: ModuleNode): void {
    if (!this.globalModulesList.includes(module)) {
      this.globalModulesList.push(module);
    }
  }

  bindGlobalModuleToModule(target: ModuleNode, globalModule: ModuleNode): void {
    if (target === globalModule) {
      return;
    }
    if (!target.imports.includes(globalModule)) {
      target.imports.push(globalModule);
    }
  }

  bindGlobalsToImports(moduleRef: ModuleNode): void {
    for (const globalMod of this.globalModulesList) {
      this.bindGlobalModuleToModule(moduleRef, globalMod);
    }
  }

  bindGlobalScope(): void {
    for (const mod of this.modulesMap.values()) {
      this.bindGlobalsToImports(mod);
    }
  }

  getModuleTokenFactory(): {
    create(
      metatype: Type<any>,
      dynamicModuleMetadata?: Partial<DynamicModule>,
    ): string;
  } {
    return {
      create: (
        metatype: Type<any>,
        dynamicModuleMetadata?: Partial<DynamicModule>,
      ): string => {
        const base = metatype.name || "AnonymousModule";
        if (dynamicModuleMetadata) {
          return `${base}:dynamic:${++this.lazyCounter}`;
        }
        const existing = this.staticModuleNodes.get(metatype);
        return existing ? existing.id : `${base}:${++this.lazyCounter}`;
      },
    };
  }

  getModuleCompiler(): {
    compile(
      metatype: Type<any> | DynamicModule | Promise<DynamicModule>,
    ): Promise<{
      type: Type<any>;
      dynamicMetadata?: Partial<DynamicModule>;
      token: string;
    }>;
  } {
    const tokenFactory = this.getModuleTokenFactory();
    return {
      compile: async (
        metatype: Type<any> | DynamicModule | Promise<DynamicModule>,
      ) => {
        const resolved = await metatype;
        if (isDynamicModule(resolved)) {
          const { module: modType, ...dynamicMetadata } = resolved;
          return {
            type: modType,
            dynamicMetadata,
            token: tokenFactory.create(modType, dynamicMetadata),
          };
        }
        return {
          type: resolved,
          token: tokenFactory.create(resolved),
        };
      },
    };
  }

  async addModule(
    metatype: Type<any> | DynamicModule | Promise<DynamicModule>,
    _scope: Type<any>[] = [],
    insertedModules?: ModuleNode[],
  ): Promise<{ moduleRef: ModuleNode; inserted: boolean } | undefined> {
    if (!metatype) {
      return undefined;
    }
    const resolved = await metatype;
    const isDyn = isDynamicModule(resolved);
    const modType = isDyn ? resolved.module : resolved;

    if (!isDyn) {
      const existing = this.staticModuleNodes.get(modType);
      if (existing) {
        return { moduleRef: existing, inserted: false };
      }
    } else {
      const existingDyn = this.dynamicModuleNodes.get(resolved);
      if (existingDyn) {
        return { moduleRef: existingDyn, inserted: false };
      }
    }

    const dynamicMeta = isDyn ? resolved : undefined;
    const token = this.getModuleTokenFactory().create(modType, dynamicMeta);
    const isGlobal = this.isGlobalModule(modType, dynamicMeta);
    const moduleRef = new ModuleNode(token, modType, isGlobal, isDyn);

    this.modulesMap.set(token, moduleRef);
    this.modulesContainer.set(token, moduleRef);
    this.topologicalModules.push(moduleRef);
    this.moduleRefs.set(token, new ModuleRef(this, token));
    if (isDyn) {
      this.dynamicModuleNodes.set(resolved, moduleRef);
      this.dynamicModulesMetadata.set(token, resolved);
    } else {
      this.staticModuleNodes.set(modType, moduleRef);
    }
    if (isGlobal) {
      this.addGlobalModule(moduleRef);
    }
    if (insertedModules) {
      insertedModules.push(moduleRef);
    }
    return { moduleRef, inserted: true };
  }

  async replaceModule(
    metatypeToReplace: Type<any> | DynamicModule | Promise<DynamicModule>,
    newMetatype: Type<any> | DynamicModule | Promise<DynamicModule>,
    scope: Type<any>[] = [],
    insertedModules?: ModuleNode[],
  ): Promise<{ moduleRef: ModuleNode; inserted: boolean } | undefined> {
    const resolvedOld = await metatypeToReplace;
    const oldNode = isDynamicModule(resolvedOld)
      ? this.dynamicModuleNodes.get(resolvedOld)
      : this.staticModuleNodes.get(resolvedOld);
    if (oldNode) {
      this.removeModules([oldNode]);
    }
    return this.addModule(newMetatype, scope, insertedModules);
  }

  async addDynamicMetadata(
    token: string,
    dynamicModuleMetadata: Partial<DynamicModule>,
    _scope: Type<any>[] = [],
    _insertedModules?: ModuleNode[],
  ): Promise<void> {
    if (!dynamicModuleMetadata) return;
    this.dynamicModulesMetadata.set(token, {
      ...(this.dynamicModulesMetadata.get(token) ?? {}),
      ...dynamicModuleMetadata,
    });
  }

  async addDynamicModules(
    modules: any[],
    scope: Type<any>[] = [],
    insertedModules?: ModuleNode[],
  ): Promise<void> {
    if (!modules || modules.length === 0) return;
    for (const mod of modules) {
      await this.addModule(mod, scope, insertedModules);
    }
  }

  getDynamicMetadataByToken(token: string): Partial<DynamicModule>;
  getDynamicMetadataByToken<
    K extends Exclude<keyof DynamicModule, "global" | "module">,
  >(token: string, metadataKey: K): DynamicModule[K];
  getDynamicMetadataByToken(
    token: string,
    metadataKey?: Exclude<keyof DynamicModule, "global" | "module">,
  ): any {
    const meta = this.dynamicModulesMetadata.get(token);
    if (metadataKey !== undefined) {
      return meta ? meta[metadataKey] : undefined;
    }
    return meta ?? {};
  }

  async addImport(
    relatedModule: Type<any> | DynamicModule,
    token: string,
  ): Promise<void> {
    const owner = this.modulesMap.get(token);
    if (!owner) return;
    const added = await this.addModule(relatedModule);
    if (added && !owner.imports.includes(added.moduleRef)) {
      owner.imports.push(added.moduleRef);
    }
  }

  addProvider(
    provider: Provider,
    token: string,
    _enhancerSubtype?: EnhancerKind,
  ): InjectionToken {
    const mod = this.modulesMap.get(token);
    const normalized = normalizeProvider(provider);
    if (mod) {
      if (normalized.isMulti) {
        const list = mod.multiProviders.get(normalized.token) ?? [];
        list.push(normalized);
        mod.multiProviders.set(normalized.token, list);
      } else {
        mod.providers.set(normalized.token, normalized);
      }
      if (normalized.token === AOP_POINTCUTS_TOKEN) {
        this.invalidatePointcutCaches();
      }
    }
    return normalized.token;
  }

  addInjectable(
    injectable: Provider,
    token: string,
    enhancerSubtype: EnhancerKind,
    _host?: InjectionToken,
  ): InjectionToken {
    const resolvedToken = this.addProvider(injectable, token, enhancerSubtype);
    const mod = this.modulesMap.get(token);
    if (mod && typeof resolvedToken === "function") {
      this.registerEnhancerOwner(resolvedToken as Type<unknown>, mod);
    }
    return resolvedToken;
  }

  addExportedProviderOrModule(
    toExport: InjectionToken | DynamicModule,
    token: string,
  ): void {
    const mod = this.modulesMap.get(token);
    if (!mod) return;
    if (isDynamicModule(toExport)) {
      const sub = this.dynamicModuleNodes.get(toExport);
      if (sub && !mod.reExportedModules.includes(sub)) {
        mod.reExportedModules.push(sub);
      }
      return;
    }
    const staticMod =
      typeof toExport === "function"
        ? this.staticModuleNodes.get(toExport as Type<unknown>)
        : undefined;
    if (staticMod && !mod.reExportedModules.includes(staticMod)) {
      mod.reExportedModules.push(staticMod);
      return;
    }
    mod.exportedTokens.add(toExport);
  }

  addController(controller: Type<any>, token: string): void {
    const mod = this.modulesMap.get(token);
    if (!mod) return;
    if (!mod.controllers.includes(controller)) {
      mod.controllers.push(controller);
    }
    this.controllerOwner.set(controller, mod);
    this.indexControllerEnhancers(controller, mod);
  }

  replace(toReplace: unknown, options: { scope: unknown[] | null }): void {
    if (
      !toReplace ||
      typeof toReplace !== "object" ||
      !("provide" in toReplace)
    ) {
      return;
    }
    const normalized = normalizeProvider(toReplace as Provider);
    const targetScopes = options.scope;
    for (const mod of this.modulesMap.values()) {
      if (targetScopes === null || targetScopes.includes(mod.metatype)) {
        if (mod.providers.has(normalized.token)) {
          mod.providers.set(normalized.token, normalized);
          this.singletons.delete(this.makeInstanceKey(mod, normalized.token));
        }
      }
    }
  }

  removeModules(modules: Iterable<ModuleNode>): void {
    const toRemove = new Set(modules);
    for (const mod of toRemove) {
      this.modulesMap.delete(mod.id);
      this.modulesContainer.delete(mod.id);
      this.moduleRefs.delete(mod.id);
      this.dynamicModulesMetadata.delete(mod.id);
      if (this.staticModuleNodes.get(mod.metatype) === mod) {
        this.staticModuleNodes.delete(mod.metatype);
      }
      for (const [dynKey, dynVal] of this.dynamicModuleNodes.entries()) {
        if (dynVal === mod) {
          this.dynamicModuleNodes.delete(dynKey);
        }
      }
      const topoIdx = this.topologicalModules.indexOf(mod);
      if (topoIdx !== -1) {
        this.topologicalModules.splice(topoIdx, 1);
      }
      const globIdx = this.globalModulesList.indexOf(mod);
      if (globIdx !== -1) {
        this.globalModulesList.splice(globIdx, 1);
      }
    }
  }

  clear(): void {
    this.modulesMap.clear();
    this.modulesContainer.clear();
    this.topologicalModules.length = 0;
    this.globalModulesList.length = 0;
    this.staticModuleNodes.clear();
    this.dynamicModuleNodes.clear();
    this.dynamicModulesMetadata.clear();
    this.moduleRefs.clear();
    this.singletons.clear();
    this.controllerSingletons.clear();
    this.controllerOwner.clear();
    this.enhancerOwner.clear();
    this.multiProviderInstances.clear();
    this.contextContainers.clear();
    this.durableContainers.clear();
    this.requestScopeCache.clear();
  }

  private applyInstrumentation<T>(value: T): T {
    if (
      this.instanceDecorator &&
      value !== null &&
      (typeof value === "object" || typeof value === "function")
    ) {
      return this.instanceDecorator(value) as T;
    }
    return value;
  }

  private invalidatePointcutCaches(): void {
    this.pointcutsIndexed = false;
    this.aspectPresenceCache = new WeakMap<Function, boolean>();
    this.dynamicAspectPresenceCache = new WeakMap<Function, boolean>();
    this.moduleAspectPresenceCache = new WeakMap<
      ModuleNode,
      WeakMap<Function, boolean>
    >();
    this.moduleDynamicAspectPresenceCache = new WeakMap<
      ModuleNode,
      WeakMap<Function, boolean>
    >();
    this.ownerPointcutsCache = new WeakMap<
      ModuleNode,
      readonly PointcutRule[]
    >();
  }

  private extractPointcutRules(value: unknown): PointcutRule[] {
    if (!Array.isArray(value)) {
      return [];
    }
    const rules: PointcutRule[] = [];
    for (let i = 0; i < value.length; i++) {
      const item = value[i];
      if (
        typeof item === "object" &&
        item !== null &&
        "match" in item &&
        "aspects" in item &&
        Array.isArray((item as PointcutRule).aspects)
      ) {
        rules.push(item as PointcutRule);
      }
    }
    return rules;
  }

  private rebuildPointcutSummary(): void {
    const globalList: PointcutRule[] = [];
    let hasScoped = false;

    for (const [mod, rules] of this.resolvedPointcutProviders.entries()) {
      if (rules.length === 0) {
        continue;
      }
      if (mod.isGlobal) {
        globalList.push(...rules);
      } else {
        hasScoped = true;
      }
    }

    this.containerGlobalPointcuts = globalList;
    this.hasModuleScopedPointcuts = hasScoped;
    this.aspectPresenceCache = new WeakMap<Function, boolean>();
    this.dynamicAspectPresenceCache = new WeakMap<Function, boolean>();
    this.moduleAspectPresenceCache = new WeakMap<
      ModuleNode,
      WeakMap<Function, boolean>
    >();
    this.moduleDynamicAspectPresenceCache = new WeakMap<
      ModuleNode,
      WeakMap<Function, boolean>
    >();
    this.ownerPointcutsCache = new WeakMap<
      ModuleNode,
      readonly PointcutRule[]
    >();
  }

  private indexValuePointcutsIfNeeded(): void {
    if (this.pointcutsIndexed) {
      return;
    }
    this.pointcutsIndexed = true;
    for (const mod of this.graph.topologicalOrder) {
      if (this.resolvedPointcutProviders.has(mod)) {
        continue;
      }
      const provider = mod.providers.get(AOP_POINTCUTS_TOKEN);
      if (provider && provider.kind === "value") {
        const rules = this.extractPointcutRules(provider.useValue);
        if (rules.length > 0) {
          this.resolvedPointcutProviders.set(mod, rules);
        }
      }
    }
    this.rebuildPointcutSummary();
  }

  private async preloadAopPointcuts(): Promise<void> {
    this.resolvedPointcutProviders.clear();
    for (const mod of this.graph.topologicalOrder) {
      const provider = mod.providers.get(AOP_POINTCUTS_TOKEN);
      if (!provider) {
        continue;
      }
      const rawValue =
        provider.kind === "value"
          ? provider.useValue
          : await this.resolveNormalizedProvider(
              mod,
              provider,
              undefined,
              new Set(),
            );
      const rules = this.extractPointcutRules(rawValue);
      if (rules.length > 0) {
        this.resolvedPointcutProviders.set(mod, rules);
      }
    }
    this.pointcutsIndexed = true;
    this.rebuildPointcutSummary();
  }

  private syncGlobalPointcutsCache(): void {
    const currentVer = getGlobalPointcutsVersion();
    if (currentVer !== this.cachedGlobalPointcutsVersion) {
      this.cachedGlobalPointcutsVersion = currentVer;
      this.aspectPresenceCache = new WeakMap<Function, boolean>();
      this.dynamicAspectPresenceCache = new WeakMap<Function, boolean>();
      this.moduleAspectPresenceCache = new WeakMap<
        ModuleNode,
        WeakMap<Function, boolean>
      >();
      this.moduleDynamicAspectPresenceCache = new WeakMap<
        ModuleNode,
        WeakMap<Function, boolean>
      >();
      this.ownerPointcutsCache = new WeakMap<
        ModuleNode,
        readonly PointcutRule[]
      >();
    }
  }

  /**
   * Resolves all active declarative `PointcutRule`s applicable to classes owned
   * by `owner` (combining global registry pointcuts, `@Global()` `AopModule`
   * pointcuts, and module-scoped `AOP_POINTCUTS_TOKEN` pointcuts visible to `owner`).
   */
  getActivePointcuts(owner?: ModuleNode): readonly PointcutRule[] {
    this.syncGlobalPointcutsCache();
    this.indexValuePointcutsIfNeeded();

    const globalRules = getGlobalPointcuts();
    if (!this.hasModuleScopedPointcuts || !owner) {
      if (
        globalRules.length === 0 &&
        this.containerGlobalPointcuts.length === 0
      ) {
        return EMPTY_POINTCUTS;
      }
      if (globalRules.length === 0) {
        return this.containerGlobalPointcuts;
      }
      if (this.containerGlobalPointcuts.length === 0) {
        return globalRules;
      }
      return [...globalRules, ...this.containerGlobalPointcuts];
    }

    const cached = this.ownerPointcutsCache.get(owner);
    if (cached !== undefined) {
      return cached;
    }

    const combined: PointcutRule[] = [];
    if (globalRules.length > 0) {
      combined.push(...globalRules);
    }
    if (this.containerGlobalPointcuts.length > 0) {
      combined.push(...this.containerGlobalPointcuts);
    }

    const seenScopedOwners = new Set<ModuleNode>();
    if (!owner.isGlobal) {
      const localRules = this.resolvedPointcutProviders.get(owner);
      if (localRules && localRules.length > 0) {
        seenScopedOwners.add(owner);
        combined.push(...localRules);
      }
    }

    for (let i = 0; i < owner.imports.length; i++) {
      const imp = owner.imports[i]!;
      if (imp.isGlobal) {
        continue;
      }
      const exportedOwners = imp.getEffectiveExports().get(AOP_POINTCUTS_TOKEN);
      if (!exportedOwners) {
        continue;
      }
      for (const exportOwner of exportedOwners) {
        if (exportOwner.isGlobal || seenScopedOwners.has(exportOwner)) {
          continue;
        }
        seenScopedOwners.add(exportOwner);
        const rules = this.resolvedPointcutProviders.get(exportOwner);
        if (rules && rules.length > 0) {
          combined.push(...rules);
        }
      }
    }

    const frozen = combined.length === 0 ? EMPTY_POINTCUTS : combined;
    this.ownerPointcutsCache.set(owner, frozen);
    return frozen;
  }

  /**
   * O(1) WeakMap-cached check for whether `cls` (or any ancestor) declares
   * method aspects or matches active declarative pointcuts — guarantees zero
   * hot-path overhead for plain classes.
   */
  private hasAspectsForClass(
    cls: Function,
    owner?: ModuleNode,
    includeDynamicMethods = false,
  ): boolean {
    this.syncGlobalPointcutsCache();
    this.indexValuePointcutsIfNeeded();

    if (!this.hasModuleScopedPointcuts || !owner) {
      const cache = includeDynamicMethods
        ? this.dynamicAspectPresenceCache
        : this.aspectPresenceCache;
      const cached = cache.get(cls);
      if (cached !== undefined) {
        return cached;
      }
      const pointcuts = this.getActivePointcuts(owner);
      const present =
        hasMethodAspects(cls) ||
        hasMatchingPointcuts(
          cls,
          pointcuts,
          includeDynamicMethods ? { includeDynamicMethods: true } : undefined,
        );
      cache.set(cls, present);
      return present;
    }

    const outer = includeDynamicMethods
      ? this.moduleDynamicAspectPresenceCache
      : this.moduleAspectPresenceCache;
    let modCache = outer.get(owner);
    if (!modCache) {
      modCache = new WeakMap<Function, boolean>();
      outer.set(owner, modCache);
    }
    const cached = modCache.get(cls);
    if (cached !== undefined) {
      return cached;
    }
    const pointcuts = this.getActivePointcuts(owner);
    const present =
      hasMethodAspects(cls) ||
      hasMatchingPointcuts(
        cls,
        pointcuts,
        includeDynamicMethods ? { includeDynamicMethods: true } : undefined,
      );
    modCache.set(cls, present);
    return present;
  }

  private async weaveMethodAspectsIfNeeded(
    instance: unknown,
    owner: ModuleNode,
    requestContainer: RequestContainer | undefined,
    activeInstantiations: Set<string>,
  ): Promise<void> {
    if (
      instance === null ||
      typeof instance !== "object" ||
      this.wovenInstances.has(instance as object)
    ) {
      return;
    }
    const ctor = (instance as object).constructor;
    if (typeof ctor !== "function" || !this.hasAspectsForClass(ctor, owner)) {
      return;
    }
    this.wovenInstances.add(instance as object);
    const pointcuts = this.getActivePointcuts(owner);
    await weaveInstanceMethodAspects(
      instance as object,
      ctor as Type<unknown>,
      owner,
      this,
      requestContainer,
      activeInstantiations,
      pointcuts,
    );
  }

  private async createPrewarmedAspectResolver(
    targetClass: Abstract<unknown>,
    owner: ModuleNode,
    requestContainer: RequestContainer | undefined,
    activeInstantiations: Set<string>,
    pointcuts?: readonly PointcutRule[],
  ): Promise<AspectResolverObject> {
    const prewarmed = new Map<InjectionToken, ResolvedAspectEntry>();
    const tokens = collectClassAspectTokens(targetClass, pointcuts);

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]!;
      const resolved = await this.resolveAspectToken(
        token,
        owner,
        requestContainer,
        activeInstantiations,
        false,
      );
      if (
        resolved.found &&
        !resolved.deferred &&
        resolved.cacheable !== false
      ) {
        prewarmed.set(token, resolved);
      }
    }

    return {
      container: this,
      resolve: (token, isLazyCall = true) => {
        const cached = prewarmed.get(token);
        if (cached) {
          return cached;
        }
        return this.resolveAspectToken(
          token,
          owner,
          requestContainer,
          new Set(),
          isLazyCall,
        );
      },
    };
  }

  async resolveAspectToken(
    token: InjectionToken,
    owner: ModuleNode,
    requestContainer: RequestContainer | undefined,
    activeInstantiations: Set<string>,
    isLazyCall = false,
  ): Promise<ResolvedAspectEntry> {
    const activeReqContainer =
      requestContainer ??
      (isLazyCall
        ? (getCurrentRequestContext()?.container as
            RequestContainer | undefined)
        : undefined);

    // 1. Check module-visible provider (owner, imports, globals)
    let loc = ModuleScanner.resolveProviderLocation(
      owner,
      token,
      this.graph.globalModules,
    );

    // 2. Fallback: search across all modules for registered provider
    if (!loc) {
      for (const candidateMod of this.graph.topologicalOrder) {
        const found = candidateMod.providers.get(token);
        if (found) {
          loc = { owner: candidateMod, provider: found };
          break;
        }
      }
    }

    if (loc) {
      const instanceKey = this.makeInstanceKey(loc.owner, loc.provider.token);
      if (activeInstantiations.has(instanceKey)) {
        return { found: true, deferred: true };
      }

      const effectiveScope = this.getEffectiveProviderScope(
        loc.owner,
        loc.provider,
      );
      const needsRequest =
        effectiveScope === Scope.REQUEST ||
        this.providerDependsOnRequestScope(loc.owner, loc.provider, new Set());

      if (needsRequest && !activeReqContainer) {
        if (!isLazyCall) {
          return { found: true, deferred: true, cacheable: false };
        }
        return {
          found: false,
          error: new Error(
            `Cannot resolve REQUEST-scoped method aspect handler ${formatToken(token)} outside an active request context.`,
          ),
        };
      }

      try {
        const handler = await this.resolveNormalizedProvider(
          loc.owner,
          loc.provider,
          activeReqContainer,
          new Set(activeInstantiations),
        );
        return {
          found: true,
          handler,
          cacheable: effectiveScope === Scope.SINGLETON && !needsRequest,
        };
      } catch (err) {
        if (!isLazyCall && err instanceof UnknownDependencyException) {
          return { found: true, deferred: true, error: err };
        }
        if (isLazyCall) {
          return { found: false, error: err };
        }
        throw err;
      }
    }

    // 3. Ad-hoc DI instantiation for class implementing MethodAspectHandler or @Injectable()
    if (typeof token === "function" && isMethodAspectClass(token)) {
      const cls = token as Type<unknown>;
      const scope = getInjectableScope(cls);
      const needsRequest =
        scope === Scope.REQUEST ||
        this.classDependsOnRequestScope(cls, owner, new Set());

      if (needsRequest && !activeReqContainer) {
        if (!isLazyCall) {
          return { found: true, deferred: true, cacheable: false };
        }
        return {
          found: false,
          error: new Error(
            `Cannot resolve REQUEST-scoped method aspect handler ${formatToken(cls)} outside an active request context.`,
          ),
        };
      }

      const cacheKey = `aspect:${this.getTokenId(cls)}`;
      if (
        scope === Scope.SINGLETON &&
        !needsRequest &&
        this.singletons.has(cacheKey)
      ) {
        return {
          found: true,
          handler: this.singletons.get(cacheKey),
          cacheable: true,
        };
      }

      try {
        if (needsRequest && activeReqContainer) {
          const handler = await activeReqContainer.getOrCreateScopedInstance(
            cacheKey,
            async () =>
              await this.instantiateClass(
                cls,
                owner,
                activeReqContainer,
                new Set(activeInstantiations),
                true,
              ),
          );
          return { found: true, handler, cacheable: false };
        }

        const handler = await this.instantiateClass(
          cls,
          owner,
          activeReqContainer,
          new Set(activeInstantiations),
          true,
        );
        if (scope === Scope.SINGLETON && !needsRequest) {
          this.singletons.set(cacheKey, handler);
        }
        return {
          found: true,
          handler,
          cacheable: scope === Scope.SINGLETON && !needsRequest,
        };
      } catch (err) {
        if (!isLazyCall && err instanceof UnknownDependencyException) {
          return { found: true, deferred: true, error: err };
        }
        if (isLazyCall) {
          return { found: false, error: err };
        }
        throw err;
      }
    }

    // 4. Direct interceptor function (MethodAspectFn)
    if (typeof token === "function") {
      return { found: true, handler: token, cacheable: true };
    }

    return { found: false };
  }

  /**
   * Associates a class-based enhancer or middleware with its owning module
   * so DI resolution sees module-local providers and validates scope leaks.
   */
  registerEnhancerOwner(cls: Type<unknown>, moduleNode: ModuleNode): void {
    if (!this.enhancerOwner.has(cls)) {
      this.enhancerOwner.set(cls, moduleNode);
    }
  }

  getControllerOwner(ctrl: Type<unknown>): ModuleNode | undefined {
    return this.controllerOwner.get(ctrl);
  }

  private indexControllerEnhancers(ctrl: Type<unknown>, mod: ModuleNode): void {
    const enhancerKeys: ReadonlyArray<[symbol, EnhancerKind]> = [
      [METADATA_KEYS.GUARDS, "guard"],
      [METADATA_KEYS.PIPES, "pipe"],
      [METADATA_KEYS.INTERCEPTORS, "interceptor"],
      [METADATA_KEYS.EXCEPTION_FILTERS, "filter"],
    ];

    for (const [key, kind] of enhancerKeys) {
      const classEnhancers = MetadataRegistry.getMergedClassArray<unknown>(
        key,
        ctrl,
      );
      for (const item of classEnhancers) {
        if (typeof item === "function") {
          const cls = item as Type<unknown>;
          this.registerEnhancerOwner(cls, mod);
          this.controllerEnhancerUsages.push({ cls, mod, kind });
        }
      }
    }

    const classMiddlewares = MetadataRegistry.getMergedClassArray<unknown>(
      METADATA_KEYS.MIDDLEWARES,
      ctrl,
    );
    for (const item of classMiddlewares) {
      if (
        typeof item === "function" &&
        typeof (item as { prototype?: { use?: unknown } }).prototype?.use ===
          "function"
      ) {
        const cls = item as Type<unknown>;
        this.registerEnhancerOwner(cls, mod);
        this.controllerEnhancerUsages.push({ cls, mod });
      }
    }

    const routes = MetadataRegistry.getControllerRoutes(ctrl);
    const chain = MetadataRegistry.getPrototypeChain(ctrl);
    for (const route of routes) {
      for (const ctor of chain) {
        const ctorProto = ctor.prototype as
          Record<string | symbol, unknown> | undefined;
        if (
          !ctorProto ||
          !Object.prototype.hasOwnProperty.call(ctorProto, route.handlerKey)
        ) {
          continue;
        }
        const handler = ctorProto[route.handlerKey];
        if (typeof handler !== "function") {
          continue;
        }
        for (const [key, kind] of enhancerKeys) {
          const methodEnhancers =
            MetadataRegistry.getOwn<readonly unknown[]>(key, handler) ?? [];
          for (const item of methodEnhancers) {
            if (typeof item === "function") {
              const cls = item as Type<unknown>;
              this.registerEnhancerOwner(cls, mod);
              this.controllerEnhancerUsages.push({ cls, mod, kind });
            }
          }
        }
        const methodMiddlewares =
          MetadataRegistry.getOwn<readonly unknown[]>(
            METADATA_KEYS.MIDDLEWARES,
            handler,
          ) ?? [];
        for (const item of methodMiddlewares) {
          if (
            typeof item === "function" &&
            typeof (item as { prototype?: { use?: unknown } }).prototype
              ?.use === "function"
          ) {
            const cls = item as Type<unknown>;
            this.registerEnhancerOwner(cls, mod);
            this.controllerEnhancerUsages.push({ cls, mod });
          }
        }
      }
      const params = MetadataRegistry.getRouteParameters(
        ctrl,
        route.handlerKey,
      );
      for (const param of params) {
        if (param.pipes) {
          for (const pipe of param.pipes) {
            if (typeof pipe === "function") {
              const cls = pipe as Type<unknown>;
              this.registerEnhancerOwner(cls, mod);
              this.controllerEnhancerUsages.push({ cls, mod, kind: "pipe" });
            }
          }
        }
      }
    }
  }

  getGraph(): ScannedModuleGraph {
    return this.graph;
  }

  getReflector(): Reflector {
    return this.reflector;
  }

  getDiscoveryService(): DiscoveryService {
    return this.discoveryService;
  }

  getMetadataScanner(): MetadataScanner {
    return this.metadataScanner;
  }

  getLazyModuleLoader(): LazyModuleLoader {
    return this.lazyModuleLoader;
  }

  setOnLazyModuleLoaded(
    hook: (
      groups: Array<{ module: ModuleNode; instances: object[] }>,
    ) => Promise<void>,
  ): void {
    this.onLazyModuleLoaded = hook;
  }

  getModuleRef(moduleId: string): ModuleRef {
    const ref = this.moduleRefs.get(moduleId);
    if (!ref) {
      throw new Error(`ModuleRef not found for module id "${moduleId}".`);
    }
    return ref;
  }

  /**
   * Registers pre-bootstrap overrides (used by `@bunest/testing`).
   * Must be called before `initialize()`.
   */
  applyOverrides(overrides: ContainerOverrides): void {
    if (this.initialized) {
      throw new Error(
        "Cannot apply DI overrides after container initialization.",
      );
    }

    if (overrides.mocker !== undefined) {
      this.mocker = overrides.mocker;
    }
    if (overrides.modules) {
      for (const [target, replacement] of overrides.modules.entries()) {
        this.moduleOverrides.set(target, replacement);
      }
    }
    if (overrides.providers) {
      for (const [token, provider] of overrides.providers.entries()) {
        this.providerOverrides.set(token, provider);
      }
    }
    if (overrides.guards) {
      for (const [target, replacement] of overrides.guards.entries()) {
        this.guardOverrides.set(target, normalizeEnhancerOverride(replacement));
      }
    }
    if (overrides.pipes) {
      for (const [target, replacement] of overrides.pipes.entries()) {
        this.pipeOverrides.set(target, normalizeEnhancerOverride(replacement));
      }
    }
    if (overrides.interceptors) {
      for (const [target, replacement] of overrides.interceptors.entries()) {
        this.interceptorOverrides.set(
          target,
          normalizeEnhancerOverride(replacement),
        );
      }
    }
    if (overrides.filters) {
      for (const [target, replacement] of overrides.filters.entries()) {
        this.filterOverrides.set(
          target,
          normalizeEnhancerOverride(replacement),
        );
      }
    }

    // Apply provider overrides onto owning modules in the scanned graph
    for (const [token, rawProvider] of this.providerOverrides.entries()) {
      const normalized = normalizeProvider(rawProvider);
      let applied = false;
      for (const mod of this.graph.topologicalOrder) {
        if (mod.providers.has(token)) {
          mod.providers.set(token, normalized);
          this.overriddenProviderKeys.add(this.makeInstanceKey(mod, token));
          applied = true;
        }
      }
      // If token wasn't previously declared, register on root module so tests can inject it
      if (!applied) {
        this.graph.root.providers.set(token, normalized);
        this.overriddenProviderKeys.add(
          this.makeInstanceKey(this.graph.root, token),
        );
      }
    }

    // Apply enhancer overrides onto matching APP_GUARD/APP_PIPE/APP_INTERCEPTOR/APP_FILTER multi-providers
    const multiOverridePairs: ReadonlyArray<
      [InjectionToken, Map<Type<unknown>, EnhancerOverrideEntry>]
    > = [
      [APP_GUARD, this.guardOverrides],
      [APP_PIPE, this.pipeOverrides],
      [APP_INTERCEPTOR, this.interceptorOverrides],
      [APP_FILTER, this.filterOverrides],
    ];

    for (const mod of this.graph.topologicalOrder) {
      for (const [multiToken, overrideMap] of multiOverridePairs) {
        if (overrideMap.size === 0) continue;
        const list = mod.multiProviders.get(multiToken);
        if (!list) continue;
        for (let i = 0; i < list.length; i++) {
          const entry = list[i];
          if (!entry) continue;
          const matchTarget =
            entry.useClass ??
            (typeof entry.useExisting === "function"
              ? (entry.useExisting as Type<unknown>)
              : entry.kind === "value" &&
                  typeof entry.useValue === "object" &&
                  entry.useValue !== null &&
                  typeof (entry.useValue as object).constructor ===
                    "function" &&
                  (entry.useValue as object).constructor !== Object
                ? ((entry.useValue as object).constructor as Type<unknown>)
                : undefined);
          if (!matchTarget || !overrideMap.has(matchTarget)) {
            continue;
          }
          const override = overrideMap.get(matchTarget)!;
          const replacement = enhancerOverrideToNormalizedProvider(
            multiToken,
            override,
          );
          this.overriddenMultiProviders.add(replacement);
          if (multiToken === APP_FILTER && override.kind !== "class") {
            this.overriddenFilterOriginalClass.set(replacement, matchTarget);
          }
          list[i] = replacement;
        }
      }
    }
  }

  /**
   * Validates the complete dependency graph (visibility, cycles, scope leaks)
   * and instantiates all singleton modules, providers, multi-providers, and controllers
   * in bottom-up topological module order.
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    if (this.snapshotEnabled) {
      this.graphInspector.inspectModules(this.modulesMap);
    }

    try {
      // Phase 1: Fail-fast bootstrap validation before any instantiation
      this.validateAllDependenciesAndCycles();
      this.validateScopeLeaks();
      this.validated = true;

      // Phase 1.5: Preload declarative AOP pointcuts (value or factory providers)
      await this.preloadAopPointcuts();

      // Phase 2: Instantiate module classes, singleton providers, multi-providers, and controllers
      for (const mod of this.graph.topologicalOrder) {
        await this.instantiateModuleSingletons(mod);
      }

      if (this.snapshotEnabled) {
        this._serializedGraph.status = "complete";
      }

      this.initialized = true;
    } catch (err) {
      if (this.snapshotEnabled) {
        this.graphInspector.registerPartial(err);
      }
      throw err;
    }
  }

  private async instantiateModuleSingletons(mod: ModuleNode): Promise<void> {
    const moduleAllowedInPreview =
      !this.previewMode || InitializeOnPreviewAllowlist.get(mod.metatype);

    // Instantiate singleton providers first so module constructor/hooks can inject them
    for (const provider of mod.providers.values()) {
      if (
        !moduleAllowedInPreview &&
        !InitializeOnPreviewAllowlist.get(provider.token) &&
        !(
          provider.useClass &&
          InitializeOnPreviewAllowlist.get(provider.useClass)
        )
      ) {
        continue;
      }
      const allowRoot = this.overriddenProviderKeys.has(
        this.makeInstanceKey(mod, provider.token),
      );
      const effectiveScope = this.getEffectiveProviderScope(
        mod,
        provider,
        new Set(),
        allowRoot,
      );
      if (effectiveScope === Scope.SINGLETON) {
        await this.resolveNormalizedProvider(
          mod,
          provider,
          undefined,
          new Set(),
        );
      }
    }

    if (!moduleAllowedInPreview) {
      return;
    }

    // Instantiate multi-providers (APP_GUARD, APP_PIPE, APP_INTERCEPTOR, APP_FILTER)
    for (const [token, providers] of mod.multiProviders.entries()) {
      const bucket = this.multiProviderInstances.get(token) ?? [];
      for (const provider of providers) {
        const allowRoot = this.overriddenMultiProviders.has(provider);
        const effectiveScope = this.getEffectiveProviderScope(
          mod,
          provider,
          new Set(),
          allowRoot,
        );
        if (effectiveScope === Scope.SINGLETON) {
          const instance =
            provider.kind === "existing" && provider.useExisting !== undefined
              ? await this.resolveDependencyToken(
                  mod,
                  {
                    rawToken: provider.useExisting,
                    token: provider.useExisting,
                    optional: false,
                    isForwardRef: false,
                  },
                  formatToken(provider.token),
                  undefined,
                  new Set(),
                  allowRoot,
                )
              : await this.instantiateProvider(
                  mod,
                  provider,
                  undefined,
                  new Set(),
                  allowRoot,
                );

          // Preserve original @Catch(...) metadata for overridden APP_FILTER value/factory/existing
          // unless the replacement itself defines @Catch(...)
          let syntheticToken: Type<unknown> | undefined;
          if (
            token === APP_FILTER &&
            this.overriddenFilterOriginalClass.has(provider)
          ) {
            const origClass = this.overriddenFilterOriginalClass.get(provider)!;
            const instCtor =
              typeof instance === "object" && instance !== null
                ? (instance as object).constructor
                : undefined;
            const replacementDefinesCatch =
              (typeof instCtor === "function" &&
                MetadataRegistry.has(
                  METADATA_KEYS.CATCH_EXCEPTIONS,
                  instCtor,
                )) ||
              (provider.kind === "existing" &&
                typeof provider.useExisting === "function" &&
                MetadataRegistry.has(
                  METADATA_KEYS.CATCH_EXCEPTIONS,
                  provider.useExisting,
                ));

            if (!replacementDefinesCatch) {
              const origCatch = MetadataRegistry.get<readonly Type<unknown>[]>(
                METADATA_KEYS.CATCH_EXCEPTIONS,
                origClass,
              );
              if (origCatch !== undefined) {
                syntheticToken = this.createSyntheticEnhancerToken(
                  mod,
                  provider,
                  Scope.SINGLETON,
                  origCatch,
                  instance,
                  allowRoot,
                );
              }
            }
          }

          bucket.push({ module: mod, provider, instance, syntheticToken });
        } else {
          // Non-singleton (REQUEST / TRANSIENT) multi-provider (useClass, useFactory, or useExisting):
          // Bind a unique synthetic token so HttpRuntimeBridge detects scope and resolves per-request/transient.
          const syntheticToken = this.createSyntheticEnhancerToken(
            mod,
            provider,
            effectiveScope,
            undefined,
            undefined,
            allowRoot,
          );
          bucket.push({ module: mod, provider, syntheticToken });
        }
      }
      this.multiProviderInstances.set(token, bucket);
    }

    // Instantiate module class itself (supports DI in module constructors!)
    mod.instance = (await this.instantiateClass(
      mod.metatype,
      mod,
      undefined,
      new Set(),
    )) as object;

    // Instantiate singleton controllers (REQUEST-scoped controllers stay lazy per ADR-012)
    for (const ctrl of mod.controllers) {
      const ctrlScope = getControllerScope(ctrl);
      if (ctrlScope === Scope.SINGLETON) {
        const instance = (await this.instantiateClass(
          ctrl,
          mod,
          undefined,
          new Set(),
        )) as object;
        this.controllerSingletons.set(ctrl, instance);
      }
    }
  }

  /**
   * Validates dependencies and scope-leak invariants for a dynamically registered
   * class-based enhancer or module middleware (e.g., from `configure()` or `useGlobal*()`).
   * Consults kind-specific test overrides BEFORE validating the original class.
   */
  validateEnhancerClass(
    cls: Type<unknown>,
    ownerModOrKind?: ModuleNode | EnhancerKind,
    kindArg?: EnhancerKind,
  ): void {
    const ownerMod =
      ownerModOrKind instanceof ModuleNode ? ownerModOrKind : undefined;
    const kind = typeof ownerModOrKind === "string" ? ownerModOrKind : kindArg;

    const mod = ownerMod ?? this.enhancerOwner.get(cls) ?? this.graph.root;
    this.registerEnhancerOwner(cls, mod);

    const override = this.getEnhancerOverride(cls, kind);
    if (override) {
      if (override.kind === "value") {
        // Value override has no dependencies and cannot leak REQUEST scope
        return;
      }
      const overrideProvider = enhancerOverrideToNormalizedProvider(
        cls,
        override,
      );
      const label =
        override.kind === "class"
          ? override.useClass.name || cls.name || "<Enhancer>"
          : cls.name || "<Enhancer>";
      const deps = this.getProviderDependencies(overrideProvider);
      this.validateDependencyList(deps, mod, label, true);

      const effectiveScope = this.getEffectiveProviderScope(
        mod,
        overrideProvider,
        new Set(),
        true,
      );
      if (effectiveScope === Scope.SINGLETON) {
        this.checkDependenciesForScopeLeak(
          mod,
          deps,
          [{ name: label, scope: Scope.SINGLETON }],
          new Set(),
          true,
        );
      }
      return;
    }

    const label = cls.name || "<Enhancer>";
    const deps = this.getClassDependencies(cls);

    // 1. Validate all required dependencies exist in module visibility (or auto-mocker)
    this.validateDependencyList(deps, mod, label, false);

    // 2. Enforce ADR-012 §3: singleton enhancer/middleware MUST NOT depend on REQUEST scope
    const scope = getInjectableScope(cls);
    if (scope === Scope.SINGLETON) {
      this.checkDependenciesForScopeLeak(
        mod,
        deps,
        [{ name: label, scope: Scope.SINGLETON }],
        new Set(),
        false,
      );
    }
  }

  private validateDependencyList(
    deps: readonly DependencyDescriptor[],
    mod: ModuleNode,
    label: string,
    allowRootFallback: boolean,
  ): void {
    for (const dep of deps) {
      if (dep.token === undefined) {
        if (dep.optional) continue;
        throw new UnknownDependencyException({
          requester: label,
          token: dep.rawToken,
          index: dep.index,
          propertyKey: dep.propertyKey,
          moduleName: mod.name,
          resolutionPath: [label],
        });
      }
      if (
        isBuiltInSingletonToken(dep.token) ||
        isBuiltInRequestToken(dep.token)
      ) {
        continue;
      }
      const loc = this.resolveProviderLocationForMod(
        mod,
        dep.token,
        allowRootFallback,
      );
      if (!loc && !dep.optional) {
        if (this.tryResolveAutoMock(dep.token).found) {
          continue;
        }
        throw new UnknownDependencyException({
          requester: label,
          token: dep.token,
          index: dep.index,
          propertyKey: dep.propertyKey,
          moduleName: mod.name,
          resolutionPath: [label, formatToken(dep.token)],
        });
      }
    }
  }

  // --- Runtime & Bridge APIs ---

  getOrCreateContextContainer(contextId: ContextId): RequestContainer {
    let container = this.contextContainers.get(contextId.id);
    if (!container) {
      container = new RequestContainer(
        (token, reqContainer) =>
          this.resolveAsync(token, this.graph.root.id, reqContainer, {
            strict: false,
          }),
        { contextId },
      );
      this.contextContainers.set(contextId.id, container);
    } else if (!container.getContextId()) {
      container.setContextId(contextId);
    }
    return container;
  }

  registerRequestByContextId<T = unknown>(
    request: T,
    contextId: ContextId,
  ): void {
    const container = this.getOrCreateContextContainer(contextId);
    container.registerRequestValue(REQUEST, request);
  }

  /**
   * Returns IDs of all currently cached durable DI sub-tree containers.
   */
  getDurableContextIds(): readonly (number | symbol)[] {
    return [...this.durableContainers.keys()];
  }

  /**
   * Destroys a single cached durable DI sub-tree container and triggers
   * `onRequestDestroy` / `Symbol.asyncDispose` / `Symbol.dispose` cleanup.
   */
  async destroyDurableContext(
    contextIdOrId: ContextId | number | symbol,
  ): Promise<void> {
    const id =
      typeof contextIdOrId === "object" && contextIdOrId !== null
        ? contextIdOrId.id
        : contextIdOrId;
    const container = this.durableContainers.get(id);
    if (!container) {
      return;
    }
    this.durableContainers.delete(id);
    await container.destroy();
  }

  async destroyContextContainers(): Promise<void> {
    const toDestroy: RequestContainer[] = [];
    if (this.contextContainers.size > 0) {
      toDestroy.push(...this.contextContainers.values());
      this.contextContainers.clear();
    }
    if (this.durableContainers.size > 0) {
      toDestroy.push(...this.durableContainers.values());
      this.durableContainers.clear();
    }
    for (const rc of toDestroy) {
      await rc.destroy().catch(() => {});
    }
  }

  private resolveDurableContainerFor(
    target: Type<unknown> | InjectionToken,
    isDurable: boolean,
    reqContainer: RequestContainer | undefined,
    token: InjectionToken = target,
  ): RequestContainer | undefined {
    if (!isDurable || !reqContainer || reqContainer.isDurable()) {
      return reqContainer;
    }

    const ctxId = reqContainer.getContextId();
    if (!ctxId || !ctxId.getParent) {
      return reqContainer;
    }

    const parentCtxId = ctxId.getParent({
      host: target,
      token,
      isTreeDurable: true,
    });
    if (!parentCtxId || parentCtxId.id === ctxId.id) {
      return reqContainer;
    }

    const payload =
      ctxId.payload !== undefined
        ? ctxId.payload
        : parentCtxId.payload !== undefined
          ? parentCtxId.payload
          : reqContainer.getRequestValue(REQUEST);

    let durable = this.durableContainers.get(parentCtxId.id);
    if (!durable) {
      durable = new RequestContainer(
        (tok, rc) =>
          this.resolveAsync(tok, this.graph.root.id, rc, {
            strict: false,
          }),
        { contextId: parentCtxId, durable: true },
      );
      if (payload !== undefined) {
        durable.registerRequestValue(REQUEST, payload);
      }
      this.durableContainers.set(parentCtxId.id, durable);
    } else if (payload !== undefined) {
      // Refresh REQUEST payload for any durable providers not yet constructed
      // (e.g. after an earlier construction threw an error with a failing payload).
      durable.registerRequestValue(REQUEST, payload);
    }

    return durable;
  }

  private evictEmptyDurableContainer(container: RequestContainer): void {
    if (!container.isDurable() || container.hasAnyScopedInstance()) {
      return;
    }
    const ctxId = container.getContextId();
    if (ctxId && this.durableContainers.get(ctxId.id) === container) {
      this.durableContainers.delete(ctxId.id);
    }
  }

  private getEnhancerOverride(
    cls: Type<unknown>,
    kind?: EnhancerKind,
  ): EnhancerOverrideEntry | undefined {
    switch (kind) {
      case "guard":
        return this.guardOverrides.get(cls);
      case "pipe":
        return this.pipeOverrides.get(cls);
      case "interceptor":
        return this.interceptorOverrides.get(cls);
      case "filter":
        return this.filterOverrides.get(cls);
      default:
        return (
          this.guardOverrides.get(cls) ??
          this.pipeOverrides.get(cls) ??
          this.interceptorOverrides.get(cls) ??
          this.filterOverrides.get(cls)
        );
    }
  }

  private resolveProviderLocationForMod(
    mod: ModuleNode,
    token: InjectionToken,
    allowRootFallback = false,
  ): { owner: ModuleNode; provider: NormalizedProvider } | undefined {
    const direct = ModuleScanner.resolveProviderLocation(
      mod,
      token,
      this.graph.globalModules,
    );
    if (direct || !allowRootFallback || mod === this.graph.root) {
      return direct;
    }
    return ModuleScanner.resolveProviderLocation(
      this.graph.root,
      token,
      this.graph.globalModules,
    );
  }

  private tryResolveAutoMock(
    token: InjectionToken,
  ): { found: true; value: unknown } | { found: false } {
    if (this.autoMocks.has(token)) {
      return { found: true, value: this.autoMocks.get(token) };
    }
    if (!this.mocker) {
      return { found: false };
    }
    if (isBuiltInRequestToken(token) || isBuiltInSingletonToken(token)) {
      return { found: false };
    }
    const mocked = this.mocker(token);
    if (mocked !== undefined && mocked !== null) {
      this.autoMocks.set(token, mocked);
      return { found: true, value: mocked };
    }
    return { found: false };
  }

  createRequestContainer(
    request: Request,
    _responseContext?: ResponseContext,
    requestContext?: unknown,
  ): RequestContainer {
    const contextId = ContextIdFactory.getStrategy()
      ? ContextIdFactory.getByRequest(request)
      : undefined;
    const container = new RequestContainer(
      (token, reqContainer) =>
        this.resolveAsync(token, this.graph.root.id, reqContainer, {
          strict: false,
        }),
      { contextId },
    );
    container.registerRequestValue(REQUEST, request);
    if (requestContext !== undefined) {
      container.registerRequestValue(REQUEST_CONTEXT, requestContext);
    }
    return container;
  }

  /**
   * Statically determines if a specific enhancer (taking kind-specific test overrides
   * into account) requires a per-request DI container.
   */
  requiresEnhancerRequestScope(
    enhancer: unknown,
    kind?: EnhancerKind,
    controllerToken?: Type<unknown>,
  ): boolean {
    if (typeof enhancer !== "function") {
      return false;
    }

    const cls = enhancer as Type<unknown>;
    const ownerMod =
      (controllerToken
        ? this.controllerOwner.get(controllerToken)
        : undefined) ??
      this.enhancerOwner.get(cls) ??
      this.graph.root;

    // 1. Synthetic multi-provider enhancer
    const synth = this.syntheticEnhancers.get(cls);
    if (synth) {
      if (synth.precomputedInstance !== undefined) {
        return false;
      }
      return (
        synth.scope === Scope.REQUEST ||
        this.providerDependsOnRequestScope(
          synth.module,
          synth.provider,
          new Set(),
          synth.allowRootFallback,
        )
      );
    }

    // 2. Kind-specific enhancer override (checked before original class metadata!)
    const override = this.getEnhancerOverride(cls, kind);
    if (override) {
      if (override.kind === "value") {
        return false;
      }
      const provider = enhancerOverrideToNormalizedProvider(cls, override);
      const effectiveScope = this.getEffectiveProviderScope(
        ownerMod,
        provider,
        new Set(),
        true,
      );
      return (
        effectiveScope === Scope.REQUEST ||
        this.providerDependsOnRequestScope(ownerMod, provider, new Set(), true)
      );
    }

    // 3. Registered provider (skip when kind-separated providerOverrides replaced this token)
    if (!(kind !== undefined && this.providerOverrides.has(cls))) {
      const loc = ModuleScanner.resolveProviderLocation(
        ownerMod,
        cls,
        this.graph.globalModules,
      );
      if (loc) {
        const allowRoot = this.overriddenProviderKeys.has(
          this.makeInstanceKey(loc.owner, loc.provider.token),
        );
        return (
          this.getEffectiveProviderScope(
            loc.owner,
            loc.provider,
            new Set(),
            allowRoot,
          ) === Scope.REQUEST ||
          this.providerDependsOnRequestScope(
            loc.owner,
            loc.provider,
            new Set(),
            allowRoot,
          )
        );
      }
    }

    return (
      getInjectableScope(cls) === Scope.REQUEST ||
      this.classDependsOnRequestScope(cls, ownerMod, new Set())
    );
  }

  /**
   * Resolves effective `@Catch(...)` exception types for a filter token,
   * respecting `overrideFilter` (`useClass` uses replacement's `@Catch`, while
   * `useValue`/`useFactory`/`useExisting` preserve original `@Catch` unless
   * the replacement defines its own `@Catch`).
   */
  resolveFilterCatchTypes(
    filterSpec: unknown,
    resolvedInstance?: unknown,
  ): readonly Type<any>[] | undefined {
    if (typeof filterSpec !== "function") {
      return undefined;
    }

    const cls = filterSpec as Type<unknown>;

    if (this.syntheticEnhancers.has(cls)) {
      const resolvedCtor =
        typeof resolvedInstance === "object" && resolvedInstance !== null
          ? (resolvedInstance as object).constructor
          : undefined;
      if (
        typeof resolvedCtor === "function" &&
        MetadataRegistry.has(METADATA_KEYS.CATCH_EXCEPTIONS, resolvedCtor)
      ) {
        const instTypes = MetadataRegistry.get<readonly Type<any>[]>(
          METADATA_KEYS.CATCH_EXCEPTIONS,
          resolvedCtor,
        );
        return instTypes ? [...instTypes] : [];
      }

      const types = MetadataRegistry.get<readonly Type<any>[]>(
        METADATA_KEYS.CATCH_EXCEPTIONS,
        cls,
      );
      return types ? [...types] : [];
    }

    const override = this.filterOverrides.get(cls);
    if (!override) {
      return undefined;
    }

    if (override.kind === "class") {
      const newTypes = MetadataRegistry.get<readonly Type<any>[]>(
        METADATA_KEYS.CATCH_EXCEPTIONS,
        override.useClass,
      );
      return newTypes ? [...newTypes] : [];
    }

    const candidateObj =
      override.kind === "value" ? override.value : resolvedInstance;
    const candidateCtor =
      typeof candidateObj === "object" && candidateObj !== null
        ? (candidateObj as object).constructor
        : undefined;

    if (
      typeof candidateCtor === "function" &&
      MetadataRegistry.has(METADATA_KEYS.CATCH_EXCEPTIONS, candidateCtor)
    ) {
      const types = MetadataRegistry.get<readonly Type<any>[]>(
        METADATA_KEYS.CATCH_EXCEPTIONS,
        candidateCtor,
      );
      return types ? [...types] : [];
    }

    if (
      override.kind === "existing" &&
      typeof override.useExisting === "function" &&
      MetadataRegistry.has(METADATA_KEYS.CATCH_EXCEPTIONS, override.useExisting)
    ) {
      const types = MetadataRegistry.get<readonly Type<any>[]>(
        METADATA_KEYS.CATCH_EXCEPTIONS,
        override.useExisting,
      );
      return types ? [...types] : [];
    }

    const origTypes = MetadataRegistry.get<readonly Type<any>[]>(
      METADATA_KEYS.CATCH_EXCEPTIONS,
      cls,
    );
    return origTypes ? [...origTypes] : [];
  }

  /**
   * Statically determines if a route (its controller or any of its enhancer tokens)
   * requires a per-request DI container (ADR-012 §2.3 zero-overhead fast path).
   */
  requiresRequestScope(
    controllerToken: Type<unknown>,
    enhancerTokens: readonly InjectionToken[] = [],
  ): boolean {
    const cacheKey = [
      this.getTokenId(controllerToken),
      ...enhancerTokens.map((t) => this.getTokenId(t)),
    ].join("|");

    const cached = this.requestScopeCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    const ownerMod =
      this.controllerOwner.get(controllerToken) ?? this.graph.root;
    let requires = false;

    if (
      getControllerScope(controllerToken) === Scope.REQUEST ||
      this.classDependsOnRequestScope(controllerToken, ownerMod, new Set())
    ) {
      requires = true;
    }

    if (!requires) {
      for (const token of enhancerTokens) {
        if (isBuiltInRequestToken(token)) {
          requires = true;
          break;
        }
        if (typeof token === "function") {
          const synth = this.syntheticEnhancers.get(token as Type<unknown>);
          if (synth) {
            if (
              synth.scope === Scope.REQUEST ||
              this.providerDependsOnRequestScope(
                synth.module,
                synth.provider,
                new Set(),
              )
            ) {
              requires = true;
              break;
            }
            continue;
          }
        }
        const loc = ModuleScanner.resolveProviderLocation(
          ownerMod,
          token,
          this.graph.globalModules,
        );
        if (loc) {
          if (
            this.getEffectiveProviderScope(loc.owner, loc.provider) ===
              Scope.REQUEST ||
            this.providerDependsOnRequestScope(
              loc.owner,
              loc.provider,
              new Set(),
            )
          ) {
            requires = true;
            break;
          }
        } else if (typeof token === "function") {
          const cls = token as Type<unknown>;
          const clsOwner = this.enhancerOwner.get(cls) ?? ownerMod;
          if (
            getInjectableScope(cls) === Scope.REQUEST ||
            this.classDependsOnRequestScope(cls, clsOwner, new Set())
          ) {
            requires = true;
            break;
          }
        }
      }
    }

    this.requestScopeCache.set(cacheKey, requires);
    return requires;
  }

  async resolveController(
    controllerToken: Type<unknown>,
    requestContainer?: RequestScopeContainer,
  ): Promise<object> {
    const existing = this.controllerSingletons.get(controllerToken);
    if (existing) {
      return existing;
    }

    const ownerMod = this.controllerOwner.get(controllerToken);
    if (!ownerMod) {
      throw new UnknownDependencyException({
        requester: "BunHttpAdapter",
        token: controllerToken,
        moduleName: this.graph.root.name,
      });
    }

    const scope = getControllerScope(controllerToken);
    const reqContainer =
      requestContainer instanceof RequestContainer
        ? requestContainer
        : undefined;

    if (scope === Scope.REQUEST) {
      if (!reqContainer) {
        throw new Error(
          `Cannot resolve REQUEST-scoped controller "${controllerToken.name}" without a RequestContainer.`,
        );
      }
      const targetContainer =
        this.resolveDurableContainerFor(
          controllerToken,
          isControllerDurable(controllerToken),
          reqContainer,
          controllerToken,
        ) ?? reqContainer;
      const key = `ctrl:${ownerMod.id}:${this.getTokenId(controllerToken)}`;
      try {
        return await targetContainer.getOrCreateScopedInstance<object>(
          key,
          async () =>
            (await this.instantiateClass(
              controllerToken,
              ownerMod,
              targetContainer,
              new Set(),
            )) as object,
        );
      } catch (err) {
        this.evictEmptyDurableContainer(targetContainer);
        throw err;
      }
    }

    // Transient controller
    const instance = (await this.instantiateClass(
      controllerToken,
      ownerMod,
      reqContainer,
      new Set(),
    )) as object;
    if (scope === Scope.SINGLETON) {
      this.controllerSingletons.set(controllerToken, instance);
    }
    return instance;
  }

  async resolveEnhancer<T = unknown>(
    enhancer: Type<T> | T,
    requestContainer?: RequestScopeContainer,
    owningModule?: ModuleNode,
    kind?: EnhancerKind,
  ): Promise<T> {
    if (typeof enhancer !== "function") {
      return enhancer;
    }

    const cls = enhancer as Type<T>;

    // Synthetic multi-provider enhancer (APP_GUARD/PIPE/INTERCEPTOR/FILTER)
    const synth = this.syntheticEnhancers.get(cls);
    if (synth) {
      if (synth.precomputedInstance !== undefined) {
        return synth.precomputedInstance as T;
      }
      const reqContainer =
        requestContainer instanceof RequestContainer
          ? requestContainer
          : undefined;
      return (await this.resolveSyntheticEnhancer(synth, reqContainer)) as T;
    }

    const mod = owningModule ?? this.enhancerOwner.get(cls) ?? this.graph.root;
    const reqContainer =
      requestContainer instanceof RequestContainer
        ? requestContainer
        : undefined;

    // Check kind-specific enhancer override BEFORE provider lookups so
    // overrideProvider(X) and overrideGuard/Pipe/Interceptor/Filter(X) never clobber each other
    const override = this.getEnhancerOverride(cls, kind);
    if (override !== undefined) {
      if (override.kind === "value") {
        return override.value as T;
      }

      const overrideProvider = enhancerOverrideToNormalizedProvider(
        cls,
        override,
      );
      const effectiveScope = this.getEffectiveProviderScope(
        mod,
        overrideProvider,
        new Set(),
        true,
      );
      const cacheKey = `enhancer-override:${kind ?? "any"}:${mod.id}:${this.getTokenId(cls)}`;

      if (
        overrideProvider.kind === "existing" &&
        overrideProvider.useExisting !== undefined
      ) {
        return (await this.resolveDependencyToken(
          mod,
          {
            rawToken: overrideProvider.useExisting,
            token: overrideProvider.useExisting,
            optional: false,
            isForwardRef: false,
          },
          formatToken(cls),
          reqContainer,
          new Set(),
          true,
        )) as T;
      }

      if (effectiveScope === Scope.SINGLETON) {
        if (this.singletons.has(cacheKey)) {
          return this.singletons.get(cacheKey) as T;
        }
        const instance = (await this.instantiateProvider(
          mod,
          overrideProvider,
          reqContainer,
          new Set(),
          true,
        )) as T;
        this.singletons.set(cacheKey, instance);
        return instance;
      }

      if (effectiveScope === Scope.REQUEST) {
        if (!reqContainer) {
          throw new Error(
            `Cannot resolve REQUEST-scoped enhancer override for ${formatToken(cls)} without an active RequestContainer.`,
          );
        }
        return reqContainer.getOrCreateScopedInstance<T>(
          cacheKey,
          async () =>
            (await this.instantiateProvider(
              mod,
              overrideProvider,
              reqContainer,
              new Set(),
              true,
            )) as T,
        );
      }

      // Scope.TRANSIENT
      const instance = (await this.instantiateProvider(
        mod,
        overrideProvider,
        reqContainer,
        new Set(),
        true,
      )) as T;
      if (reqContainer) {
        reqContainer.trackInstance(instance);
      }
      return instance;
    }

    // Separate provider overrides from enhancer resolution: if `cls` was overridden via
    // overrideProvider(cls) without a matching enhancer override, instantiate `cls` directly
    // as an enhancer instead of returning the provider mock!
    const skipProviderLookup =
      kind !== undefined && this.providerOverrides.has(cls);

    if (!skipProviderLookup) {
      // 1. Try resolving as a registered provider in module visibility
      const loc = ModuleScanner.resolveProviderLocation(
        mod,
        cls,
        this.graph.globalModules,
      );
      if (loc) {
        return (await this.resolveNormalizedProvider(
          loc.owner,
          loc.provider,
          reqContainer,
          new Set(),
        )) as T;
      }

      // 2. Fallback: search across all modules for registered provider
      for (const candidateMod of this.graph.topologicalOrder) {
        const found = candidateMod.providers.get(cls);
        if (found) {
          return (await this.resolveNormalizedProvider(
            candidateMod,
            found,
            reqContainer,
            new Set(),
          )) as T;
        }
      }
    }

    // 3. Ad-hoc DI instantiation (cached if singleton)
    const scope = getInjectableScope(cls);
    const cacheKey = `enhancer:${kind ?? "any"}:${this.getTokenId(cls)}`;
    if (scope === Scope.SINGLETON && this.singletons.has(cacheKey)) {
      return this.singletons.get(cacheKey) as T;
    }
    if (scope === Scope.REQUEST && reqContainer) {
      return reqContainer.getOrCreateScopedInstance<T>(
        cacheKey,
        async () =>
          (await this.instantiateClass(cls, mod, reqContainer, new Set())) as T,
      );
    }

    const instance = (await this.instantiateClass(
      cls,
      mod,
      reqContainer,
      new Set(),
    )) as T;

    if (scope === Scope.SINGLETON) {
      this.singletons.set(cacheKey, instance);
    }

    return instance;
  }

  getMultiProviderEntries(token: InjectionToken): ReadonlyArray<{
    module: ModuleNode;
    provider: NormalizedProvider;
    instance?: unknown;
    syntheticToken?: Type<unknown>;
  }> {
    return this.multiProviderInstances.get(token) ?? [];
  }

  private createSyntheticEnhancerToken(
    mod: ModuleNode,
    provider: NormalizedProvider,
    scope: Scope,
    explicitCatchTypes?: readonly Type<unknown>[],
    precomputedInstance?: unknown,
    allowRootFallback = false,
  ): Type<unknown> {
    const id = ++this.syntheticCounter;
    class SyntheticMultiEnhancer {}
    Object.defineProperty(SyntheticMultiEnhancer, "name", {
      value: `SyntheticMultiEnhancer#${id}(${formatToken(provider.useClass ?? provider.token)})`,
    });

    // Preserve @Catch(...) metadata when the multi-provider is an APP_FILTER
    if (explicitCatchTypes !== undefined) {
      MetadataRegistry.define(
        METADATA_KEYS.CATCH_EXCEPTIONS,
        [...explicitCatchTypes],
        SyntheticMultiEnhancer,
      );
    } else {
      const catchTarget =
        provider.useClass ??
        (typeof provider.useExisting === "function"
          ? (provider.useExisting as Type<unknown>)
          : undefined);
      let catchTypes: readonly Type<unknown>[] | undefined;
      if (
        catchTarget &&
        MetadataRegistry.has(METADATA_KEYS.CATCH_EXCEPTIONS, catchTarget)
      ) {
        catchTypes = MetadataRegistry.get<readonly Type<unknown>[]>(
          METADATA_KEYS.CATCH_EXCEPTIONS,
          catchTarget,
        );
      } else if (this.overriddenFilterOriginalClass.has(provider)) {
        const origClass = this.overriddenFilterOriginalClass.get(provider)!;
        catchTypes = MetadataRegistry.get<readonly Type<unknown>[]>(
          METADATA_KEYS.CATCH_EXCEPTIONS,
          origClass,
        );
      }
      if (catchTypes !== undefined) {
        MetadataRegistry.define(
          METADATA_KEYS.CATCH_EXCEPTIONS,
          [...catchTypes],
          SyntheticMultiEnhancer,
        );
      }
    }

    this.syntheticEnhancers.set(SyntheticMultiEnhancer, {
      module: mod,
      provider,
      scope,
      cacheKey: `synth:${mod.id}:${id}`,
      precomputedInstance,
      allowRootFallback,
    });
    return SyntheticMultiEnhancer;
  }

  private async resolveSyntheticEnhancer(
    synth: {
      module: ModuleNode;
      provider: NormalizedProvider;
      scope: Scope;
      cacheKey: string;
      precomputedInstance?: unknown;
      allowRootFallback?: boolean;
    },
    reqContainer: RequestContainer | undefined,
  ): Promise<unknown> {
    if (synth.precomputedInstance !== undefined) {
      return synth.precomputedInstance;
    }

    const { module: mod, provider, scope, cacheKey, allowRootFallback } = synth;

    if (provider.kind === "existing" && provider.useExisting !== undefined) {
      return this.resolveDependencyToken(
        mod,
        {
          rawToken: provider.useExisting,
          token: provider.useExisting,
          optional: false,
          isForwardRef: false,
        },
        formatToken(provider.token),
        reqContainer,
        new Set(),
        Boolean(allowRootFallback),
      );
    }

    if (scope === Scope.REQUEST) {
      if (!reqContainer) {
        throw new Error(
          `Cannot resolve REQUEST-scoped multi-provider ${formatToken(provider.token)} without an active RequestContainer.`,
        );
      }
      const isDurable =
        provider.durable === true ||
        (provider.useClass ? isInjectableDurable(provider.useClass) : false);
      const targetContainer =
        this.resolveDurableContainerFor(
          provider.useClass ?? provider.token,
          isDurable,
          reqContainer,
          provider.token,
        ) ?? reqContainer;
      try {
        return await targetContainer.getOrCreateScopedInstance(cacheKey, () =>
          this.instantiateProvider(
            mod,
            provider,
            targetContainer,
            new Set(),
            Boolean(allowRootFallback),
          ),
        );
      } catch (err) {
        this.evictEmptyDurableContainer(targetContainer);
        throw err;
      }
    }

    // Scope.TRANSIENT
    const instance = await this.instantiateProvider(
      mod,
      provider,
      reqContainer,
      new Set(),
      Boolean(allowRootFallback),
    );
    if (reqContainer) {
      reqContainer.trackInstance(instance);
    }
    return instance;
  }

  /**
   * Returns all singleton instances per module in bottom-up topological order
   * for lifecycle hooks (providers, multi-providers, controllers, and module class).
   */
  getSingletonInstancesByModule(): Array<{
    module: ModuleNode;
    instances: object[];
  }> {
    // Order modules bottom-up with global modules (and their imports) ahead of
    // non-global modules that may implicitly inject global tokens.
    const ordered: ModuleNode[] = [];
    const visited = new Set<ModuleNode>();
    const visitMod = (mod: ModuleNode) => {
      if (visited.has(mod)) return;
      visited.add(mod);
      for (const imp of mod.imports) {
        visitMod(imp);
      }
      ordered.push(mod);
    };
    for (const globalMod of this.graph.globalModules) {
      visitMod(globalMod);
    }
    for (const mod of this.graph.topologicalOrder) {
      visitMod(mod);
    }
    return this.collectSingletonGroups(ordered);
  }

  private collectSingletonGroups(
    modules: readonly ModuleNode[],
  ): Array<{ module: ModuleNode; instances: object[] }> {
    const result: Array<{ module: ModuleNode; instances: object[] }> = [];

    for (const mod of modules) {
      const seen = new Set<object>();
      const instances: object[] = [];
      const add = (val: unknown) => {
        if (typeof val === "object" && val !== null && !seen.has(val)) {
          seen.add(val);
          instances.push(val);
        }
      };

      // Sort intra-module providers by constructor & property (@Inject) dependency hierarchy
      // so dependencies run onModuleInit/onApplicationBootstrap first and shutdown hooks last.
      const orderedProviders: NormalizedProvider[] = [];
      const visitedProviders = new Set<InjectionToken>();
      const visitingProviders = new Set<InjectionToken>();
      const visitProvider = (provider: NormalizedProvider) => {
        if (
          visitedProviders.has(provider.token) ||
          visitingProviders.has(provider.token)
        ) {
          return;
        }
        visitingProviders.add(provider.token);
        const deps = this.getProviderDependencies(provider);
        for (const dep of deps) {
          if (dep.token === undefined) continue;
          const localDep = mod.providers.get(dep.token);
          if (localDep && localDep !== provider) {
            visitProvider(localDep);
          }
        }
        visitingProviders.delete(provider.token);
        visitedProviders.add(provider.token);
        orderedProviders.push(provider);
      };
      for (const provider of mod.providers.values()) {
        visitProvider(provider);
      }

      for (const provider of orderedProviders) {
        if (provider.kind === "existing") continue;
        const key = this.makeInstanceKey(mod, provider.token);
        if (this.singletons.has(key)) {
          add(this.singletons.get(key));
        }
      }

      for (const entries of this.multiProviderInstances.values()) {
        for (const entry of entries) {
          if (entry.module === mod && entry.instance !== undefined) {
            add(entry.instance);
          }
        }
      }

      for (const ctrl of mod.controllers) {
        const ctrlInst = this.controllerSingletons.get(ctrl);
        if (ctrlInst) {
          add(ctrlInst);
        }
      }

      if (mod.instance) {
        add(mod.instance);
      }

      result.push({ module: mod, instances });
    }

    return result;
  }

  // --- DiscoveryHost implementation ---

  private filterModulesForDiscovery(
    options?: DiscoveryFilterOptions,
  ): readonly ModuleNode[] {
    if (options?.include === undefined) {
      return this.graph.topologicalOrder;
    }
    if (options.include.length === 0) {
      return [];
    }
    const allowed = new Set<Type<unknown> | ModuleNode>(options.include);
    return this.graph.topologicalOrder.filter(
      (mod) => allowed.has(mod) || allowed.has(mod.metatype),
    );
  }

  private buildProviderWrapper<T = unknown>(
    mod: ModuleNode,
    provider: NormalizedProvider<T>,
  ): InstanceWrapper<T> {
    const key = this.makeInstanceKey(mod, provider.token);
    const allowRoot = this.overriddenProviderKeys.has(key);
    const scope = this.getEffectiveProviderScope(
      mod,
      provider,
      new Set(),
      allowRoot,
    );
    const isStatic =
      scope === Scope.SINGLETON &&
      !this.providerDependsOnRequestScope(mod, provider, new Set(), allowRoot);

    let instance: T | undefined;
    if (scope === Scope.SINGLETON) {
      if (provider.kind === "existing" && provider.useExisting !== undefined) {
        try {
          instance = this.readSingletonProviderSync<T>(mod, provider);
        } catch {
          instance = undefined;
        }
      } else {
        instance = this.singletons.get(key) as T | undefined;
      }
    }

    const metatype: Type<T> | Function | undefined =
      provider.useClass ??
      (typeof provider.token === "function"
        ? (provider.token as Type<T>)
        : typeof instance === "object" &&
            instance !== null &&
            typeof (instance as object).constructor === "function" &&
            (instance as object).constructor !== Object
          ? ((instance as object).constructor as Type<T>)
          : undefined);

    return {
      token: provider.token,
      instance,
      metatype,
      moduleRef: this.getModuleRef(mod.id),
      moduleId: mod.id,
      scope,
      isDependencyTreeStatic: isStatic,
    };
  }

  private buildControllerWrapper(
    mod: ModuleNode,
    ctrl: Type<unknown>,
  ): InstanceWrapper {
    const scope = getControllerScope(ctrl);
    const isStatic =
      scope === Scope.SINGLETON &&
      !this.classDependsOnRequestScope(ctrl, mod, new Set());
    return {
      token: ctrl,
      instance: this.controllerSingletons.get(ctrl),
      metatype: ctrl,
      moduleRef: this.getModuleRef(mod.id),
      moduleId: mod.id,
      scope,
      isDependencyTreeStatic: isStatic,
    };
  }

  discoverProviders(options?: DiscoveryFilterOptions): InstanceWrapper[] {
    const wrappers: InstanceWrapper[] = [];
    for (const mod of this.filterModulesForDiscovery(options)) {
      for (const provider of mod.providers.values()) {
        if (provider.kind === "existing") {
          continue;
        }
        wrappers.push(this.buildProviderWrapper(mod, provider));
      }
    }
    return wrappers;
  }

  discoverControllers(options?: DiscoveryFilterOptions): InstanceWrapper[] {
    const wrappers: InstanceWrapper[] = [];
    for (const mod of this.filterModulesForDiscovery(options)) {
      for (const ctrl of mod.controllers) {
        wrappers.push(this.buildControllerWrapper(mod, ctrl));
      }
    }
    return wrappers;
  }

  discoverModules(options?: DiscoveryFilterOptions): readonly ModuleNode[] {
    return [...this.filterModulesForDiscovery(options)];
  }

  discoverProviderByToken<T = unknown>(
    token: InjectionToken<T>,
  ): InstanceWrapper<T> | undefined {
    for (const mod of this.graph.topologicalOrder) {
      const provider = mod.providers.get(token);
      if (provider) {
        return this.buildProviderWrapper<T>(
          mod,
          provider as NormalizedProvider<T>,
        );
      }
    }

    if (typeof token === "function") {
      const ctrlOwner = this.controllerOwner.get(token as Type<unknown>);
      if (ctrlOwner) {
        return this.buildControllerWrapper(
          ctrlOwner,
          token as Type<unknown>,
        ) as InstanceWrapper<T>;
      }
    }

    const builtIn = this.resolveBuiltInSingleton(token, this.graph.root);
    if (builtIn.found) {
      return {
        token,
        instance: builtIn.value as T,
        metatype: typeof token === "function" ? (token as Type<T>) : undefined,
        moduleRef: this.getModuleRef(this.graph.root.id),
        moduleId: this.graph.root.id,
        scope: Scope.SINGLETON,
        isDependencyTreeStatic: true,
      };
    }

    return undefined;
  }

  // --- LazyModuleHost implementation ---

  async loadLazyModule(
    loaderFn: () =>
      Promise<Type<unknown> | DynamicModule> | Type<unknown> | DynamicModule,
    _options?: LazyModuleLoaderOptions,
  ): Promise<ModuleRef> {
    const rawLoaded = await loaderFn();
    if (
      !rawLoaded ||
      (typeof rawLoaded !== "function" && !isDynamicModule(rawLoaded))
    ) {
      throw new Error(
        "LazyModuleLoader.load() expects a loader returning a @Module() class or DynamicModule.",
      );
    }

    const loaded = this.moduleOverrides.get(rawLoaded) ?? rawLoaded;

    // 1. Check already-registered or currently-initializing module
    const existingNode = isDynamicModule(loaded)
      ? this.dynamicModuleNodes.get(loaded)
      : this.staticModuleNodes.get(loaded);
    if (existingNode) {
      const pendingInit = this.pendingModuleInits.get(existingNode.id);
      if (pendingInit) {
        try {
          await pendingInit;
          if (this.modulesMap.has(existingNode.id)) {
            return this.getModuleRef(existingNode.id);
          }
        } catch {
          // Prior concurrent load failed and rolled back; fall through if caller is a fresh load
          // Wait: if caller specifically requested the same root loadKey, let's check pendingLazyLoads below
        }
      } else if (this.modulesMap.has(existingNode.id)) {
        return this.getModuleRef(existingNode.id);
      }
    }

    // 2. Deduplicate concurrent loads of the same module reference
    const loadKey = loaded as object;
    const inFlight = this.pendingLazyLoads.get(loadKey);
    if (inFlight) {
      return inFlight;
    }

    const opId = Symbol("lazy-load-op");

    const loadPromise = (async (): Promise<ModuleRef> => {
      const scanner = new ModuleScanner();
      const subGraph = await scanner.scan(loaded, {
        existingStaticNodes: this.staticModuleNodes,
        existingDynamicNodes: this.dynamicModuleNodes,
        ...(this.moduleOverrides.size > 0
          ? { moduleOverrides: this.moduleOverrides }
          : {}),
        idPrefix: `lazy${++this.lazyCounter}:`,
      });

      // Reconcile scanned nodes against any modules that were registered concurrently
      // while scanner.scan() was awaiting async dynamic imports.
      const replacedNodes = new Map<ModuleNode, ModuleNode>();
      for (const node of subGraph.topologicalOrder) {
        if (this.modulesMap.has(node.id)) {
          continue;
        }
        if (!node.isDynamic) {
          const existing = this.staticModuleNodes.get(node.metatype);
          if (existing && existing !== node) {
            replacedNodes.set(node, existing);
          }
        } else if (subGraph.dynamicModuleMap) {
          for (const [dynKey, dynNode] of subGraph.dynamicModuleMap.entries()) {
            if (dynNode === node) {
              const existing = this.dynamicModuleNodes.get(dynKey);
              if (existing && existing !== node) {
                replacedNodes.set(node, existing);
              }
              break;
            }
          }
        }
      }

      if (replacedNodes.size > 0) {
        for (const node of subGraph.topologicalOrder) {
          if (replacedNodes.has(node)) continue;
          for (let i = 0; i < node.imports.length; i++) {
            const rep = replacedNodes.get(node.imports[i]!);
            if (rep) {
              node.imports[i] = rep;
            }
          }
          for (let i = 0; i < node.reExportedModules.length; i++) {
            const rep = replacedNodes.get(node.reExportedModules[i]!);
            if (rep) {
              node.reExportedModules[i] = rep;
            }
          }
        }
      }

      const effectiveRoot = replacedNodes.get(subGraph.root) ?? subGraph.root;

      const newNodes: ModuleNode[] = [];
      const reusedNodes: ModuleNode[] = [];
      for (const rawNode of subGraph.topologicalOrder) {
        const node = replacedNodes.get(rawNode) ?? rawNode;
        if (this.modulesMap.has(node.id)) {
          if (!reusedNodes.includes(node)) {
            reusedNodes.push(node);
          }
        } else if (!newNodes.includes(node)) {
          newNodes.push(node);
        }
      }

      // Register opId as a holder on all reused nodes that are still in-flight
      for (const reused of reusedNodes) {
        const holders = this.inFlightNodeHolders.get(reused.id);
        if (holders) {
          holders.add(opId);
        }
      }

      // Track per-node deferred init promises for newNodes so concurrent loads can await them
      const nodeDeferreds = new Map<
        string,
        {
          resolve: () => void;
          reject: (err: unknown) => void;
          settled: boolean;
        }
      >();

      const addedStaticKeys: Array<{ key: Type<unknown>; node: ModuleNode }> =
        [];
      const addedDynamicKeys: Array<{ key: DynamicModule; node: ModuleNode }> =
        [];
      const addedControllers: Array<{ ctrl: Type<unknown>; node: ModuleNode }> =
        [];

      const releaseHolders = (commit: boolean) => {
        for (const reused of reusedNodes) {
          const holders = this.inFlightNodeHolders.get(reused.id);
          if (holders) {
            holders.delete(opId);
            if (commit) {
              this.committedLazyNodes.add(reused.id);
            }
            if (holders.size === 0) {
              this.inFlightNodeHolders.delete(reused.id);
            }
          }
        }
        for (const node of newNodes) {
          const holders = this.inFlightNodeHolders.get(node.id);
          if (holders) {
            holders.delete(opId);
            if (commit) {
              this.committedLazyNodes.add(node.id);
            }
            if (holders.size === 0) {
              this.inFlightNodeHolders.delete(node.id);
            }
          }
        }
      };

      const settleRemainingDeferredsWithError = (err: unknown) => {
        for (const [nodeId, def] of nodeDeferreds.entries()) {
          if (!def.settled) {
            def.settled = true;
            this.pendingModuleInits.delete(nodeId);
            def.reject(err);
          }
        }
      };

      const evictNode = (node: ModuleNode) => {
        this.modulesMap.delete(node.id);
        this.modulesContainer.delete(node.id);
        this.moduleRefs.delete(node.id);
        const topoIdx = this.topologicalModules.indexOf(node);
        if (topoIdx !== -1) {
          this.topologicalModules.splice(topoIdx, 1);
        }
        const globIdx = this.globalModulesList.indexOf(node);
        if (globIdx !== -1) {
          this.globalModulesList.splice(globIdx, 1);
        }
        for (const provider of node.providers.values()) {
          this.singletons.delete(this.makeInstanceKey(node, provider.token));
        }
        for (const { key, node: addedNode } of addedStaticKeys) {
          if (addedNode === node && this.staticModuleNodes.get(key) === node) {
            this.staticModuleNodes.delete(key);
          }
        }
        for (const { key, node: addedNode } of addedDynamicKeys) {
          if (addedNode === node && this.dynamicModuleNodes.get(key) === node) {
            this.dynamicModuleNodes.delete(key);
          }
        }
        for (const { ctrl, node: addedNode } of addedControllers) {
          if (addedNode === node && this.controllerOwner.get(ctrl) === node) {
            this.controllerOwner.delete(ctrl);
            this.controllerSingletons.delete(ctrl);
          }
        }
      };

      try {
        if (newNodes.length === 0) {
          // Wait for any reused nodes that are still initializing in another concurrent load
          for (const reused of reusedNodes) {
            const pendingInit = this.pendingModuleInits.get(reused.id);
            if (pendingInit) {
              await pendingInit;
            }
          }
          releaseHolders(true);
          return this.getModuleRef(effectiveRoot.id);
        }

        // Attach new nodes synchronously and create per-node pendingModuleInits
        for (const node of newNodes) {
          let holders = this.inFlightNodeHolders.get(node.id);
          if (!holders) {
            holders = new Set<symbol>();
            this.inFlightNodeHolders.set(node.id, holders);
          }
          holders.add(opId);

          let resolveFn!: () => void;
          let rejectFn!: (err: unknown) => void;
          const initPromise = new Promise<void>((resolve, reject) => {
            resolveFn = resolve;
            rejectFn = reject;
          });
          // Prevent unhandledRejection if no external caller awaits this deferred
          initPromise.catch(() => {});
          this.pendingModuleInits.set(node.id, initPromise);
          nodeDeferreds.set(node.id, {
            resolve: resolveFn,
            reject: rejectFn,
            settled: false,
          });

          this.modulesMap.set(node.id, node);
          this.modulesContainer.set(node.id, node);
          this.topologicalModules.push(node);
          if (node.providers.has(AOP_POINTCUTS_TOKEN)) {
            this.invalidatePointcutCaches();
          }
          if (node.isGlobal) {
            this.globalModulesList.push(node);
          }
          if (!node.isDynamic && !this.staticModuleNodes.has(node.metatype)) {
            this.staticModuleNodes.set(node.metatype, node);
            addedStaticKeys.push({ key: node.metatype, node });
          }
          this.moduleRefs.set(node.id, new ModuleRef(this, node.id));
          for (const ctrl of node.controllers) {
            if (!this.controllerOwner.has(ctrl)) {
              this.controllerOwner.set(ctrl, node);
              addedControllers.push({ ctrl, node });
            }
            this.indexControllerEnhancers(ctrl, node);
          }
        }
        if (subGraph.dynamicModuleMap) {
          for (const [dynKey, rawNode] of subGraph.dynamicModuleMap.entries()) {
            const node = replacedNodes.get(rawNode) ?? rawNode;
            if (
              newNodes.includes(node) &&
              !this.dynamicModuleNodes.has(dynKey)
            ) {
              this.dynamicModuleNodes.set(dynKey, node);
              addedDynamicKeys.push({ key: dynKey, node });
            }
          }
        }

        // Validate DI visibility, cycles, and ADR-012 scope leaks
        this.validateAllDependenciesAndCycles();
        this.validateScopeLeaks();

        // Wait for any reused imported modules AND instantiate newNodes.
        // If a reused import is still initializing concurrently, await both so an
        // in-flight sibling load settles cleanly before propagating the error.
        const reusedInits: Promise<void>[] = [];
        for (const reused of reusedNodes) {
          const pendingInit = this.pendingModuleInits.get(reused.id);
          if (pendingInit) {
            reusedInits.push(pendingInit);
          }
        }

        const initNewNodes = async (): Promise<void> => {
          const seenInitInstances = new Set<object>();
          for (const node of newNodes) {
            await this.instantiateModuleSingletons(node);
            const nodeGroups = this.collectSingletonGroups([node]);
            if (this.onLazyModuleLoaded) {
              await this.onLazyModuleLoaded(nodeGroups);
            } else {
              for (const group of nodeGroups) {
                for (const inst of group.instances) {
                  if (seenInitInstances.has(inst)) continue;
                  seenInitInstances.add(inst);
                  if (hasOnModuleInit(inst)) {
                    await inst.onModuleInit();
                  }
                }
              }
            }
            const def = nodeDeferreds.get(node.id);
            if (def && !def.settled) {
              def.settled = true;
              this.pendingModuleInits.delete(node.id);
              def.resolve();
            }
          }
        };

        if (reusedInits.length > 0) {
          // Check whether any newNode directly injects a provider from an in-flight reused node
          const needsReusedFirst = newNodes.some((node) =>
            node.providers.size > 0 &&
            [...node.providers.values()].some((p) =>
              this.getProviderDependencies(p).some((dep) =>
                reusedNodes.some(
                  (r) =>
                    this.pendingModuleInits.has(r.id) &&
                    dep.token !== undefined &&
                    r.providers.has(dep.token),
                ),
              ),
            ),
          );
          if (needsReusedFirst) {
            await Promise.all(reusedInits);
            await initNewNodes();
          } else {
            const results = await Promise.allSettled([
              ...reusedInits,
              initNewNodes(),
            ]);
            for (const res of results) {
              if (res.status === "rejected") {
                throw res.reason;
              }
            }
          }
        } else {
          await initNewNodes();
        }

        releaseHolders(true);
        return this.getModuleRef(effectiveRoot.id);
      } catch (err) {
        // Release our hold first, then evict newNodes:
        // - Any node that itself did NOT finish initializing (def.settled === false)
        //   MUST be evicted unconditionally so retries start fresh.
        // - A node that DID finish initializing (e.g. a shared import) is kept if
        //   another concurrent load still holds it or it was already committed.
        releaseHolders(false);
        for (const node of newNodes) {
          const def = nodeDeferreds.get(node.id);
          const nodeFinishedInit = def?.settled === true;
          const stillHeld =
            (this.inFlightNodeHolders.get(node.id)?.size ?? 0) > 0;
          const alreadyCommitted = this.committedLazyNodes.has(node.id);
          if (!nodeFinishedInit || (!stillHeld && !alreadyCommitted)) {
            evictNode(node);
          }
        }
        settleRemainingDeferredsWithError(err);
        throw err;
      }
    })();

    this.pendingLazyLoads.set(loadKey, loadPromise);
    try {
      return await loadPromise;
    } finally {
      this.pendingLazyLoads.delete(loadKey);
    }
  }

  private resolveBuiltInSingleton(
    token: InjectionToken<unknown>,
    mod: ModuleNode,
  ): { found: true; value: unknown } | { found: false } {
    if (Object.is(token, ModuleRef)) {
      return { found: true, value: this.getModuleRef(mod.id) };
    }
    if (Object.is(token, Reflector)) {
      return { found: true, value: this.reflector };
    }
    if (Object.is(token, DiscoveryService)) {
      return { found: true, value: this.discoveryService };
    }
    if (Object.is(token, MetadataScanner)) {
      return { found: true, value: this.metadataScanner };
    }
    if (Object.is(token, LazyModuleLoader)) {
      return { found: true, value: this.lazyModuleLoader };
    }
    if (
      Object.is(token, HttpAdapterHost) ||
      token === BUNEST_HTTP_ADAPTER_HOST_TOKEN
    ) {
      return { found: true, value: this.httpAdapterHost };
    }
    if (
      Object.is(token, ApplicationConfig) ||
      token === BUNEST_APPLICATION_CONFIG_TOKEN
    ) {
      return { found: true, value: this._applicationConfig };
    }
    if (Object.is(token, ModulesContainer)) {
      return { found: true, value: this.modulesContainer };
    }
    if (Object.is(token, ExternalContextCreator)) {
      return { found: true, value: this.externalContextCreator };
    }
    if (Object.is(token, SerializedGraph)) {
      return { found: true, value: this._serializedGraph };
    }
    if (Object.is(token, GraphInspector)) {
      return { found: true, value: this.graphInspector };
    }
    return { found: false };
  }

  introspectToken<T = unknown>(
    token: InjectionToken<T>,
    moduleId: string,
  ): IntrospectionResult {
    if (isBuiltInRequestToken(token)) {
      return { scope: Scope.REQUEST };
    }
    if (isBuiltInSingletonToken(token)) {
      return { scope: Scope.SINGLETON };
    }
    const mod = this.graph.modules.get(moduleId) ?? this.graph.root;
    if (
      typeof token === "function" &&
      this.controllerOwner.has(token as Type<unknown>)
    ) {
      return { scope: getControllerScope(token as Type<unknown>) };
    }
    const loc = this.locateTokenForModuleRef(mod, token, false);
    if (loc) {
      const scope = this.getEffectiveProviderScope(
        loc.owner,
        loc.provider,
        new Set(),
      );
      return { scope };
    }
    throw new UnknownDependencyException({
      requester: "ModuleRef.introspect",
      token,
      moduleName: mod.name,
    });
  }

  // --- ModuleRefHost implementation ---

  getSync<T = unknown>(
    token: InjectionToken<T>,
    moduleId: string,
    options?: { strict?: boolean; each?: false },
  ): T;
  getSync<T = unknown>(
    token: InjectionToken<T>,
    moduleId: string,
    options: { strict?: boolean; each: true },
  ): T[];
  getSync<T = unknown>(
    token: InjectionToken<T>,
    moduleId: string,
    options?: ModuleRefGetOptions,
  ): T | T[];
  getSync<T = unknown>(
    token: InjectionToken<T>,
    moduleId: string,
    options?: ModuleRefGetOptions,
  ): T | T[] {
    const strict = options?.strict ?? true;
    const each = options?.each === true;
    const mod = this.graph.modules.get(moduleId) ?? this.graph.root;

    const builtIn = this.resolveBuiltInSingleton(token, mod);
    if (builtIn.found) {
      return each ? [builtIn.value as T] : (builtIn.value as T);
    }

    if (each) {
      const results: T[] = [];

      if (typeof token === "function") {
        const ctrl = this.controllerSingletons.get(token as Type<unknown>);
        if (ctrl) {
          const owner = this.controllerOwner.get(token as Type<unknown>);
          if (!strict || owner === mod) {
            results.push(ctrl as unknown as T);
          }
        }
        for (const m of this.graph.modules.values()) {
          if (m.metatype === token && m.instance !== undefined) {
            if (!strict || m === mod) {
              results.push(m.instance as unknown as T);
            }
          }
        }
      }

      if (MULTI_PROVIDER_TOKENS.has(token)) {
        for (const entry of this.getMultiProviderEntries(token)) {
          if (strict && entry.module !== mod) continue;
          if (entry.instance === undefined) {
            const allowRoot = this.overriddenMultiProviders.has(entry.provider);
            const scope = this.getEffectiveProviderScope(
              entry.module,
              entry.provider,
              new Set(),
              allowRoot,
            );
            throw new Error(
              `Provider ${formatToken(token)} is ${scope}-scoped and cannot be retrieved synchronously with get(). Use resolve() instead.`,
            );
          }
          results.push(entry.instance as T);
        }
      }

      const locs = this.locateAllTokensForModuleRef(mod, token, strict);
      for (const loc of locs) {
        results.push(
          this.readSingletonProviderSync<T>(loc.owner, loc.provider),
        );
      }

      if (results.length === 0 && this.autoMocks.has(token)) {
        results.push(this.autoMocks.get(token) as T);
      }

      if (results.length === 0) {
        throw new UnknownDependencyException({
          requester: "ModuleRef.get",
          token,
          moduleName: mod.name,
        });
      }

      return results;
    }

    // Check controller singletons and module class instances first
    if (typeof token === "function") {
      const ctrlOwner = this.controllerOwner.get(token as Type<unknown>);
      if (ctrlOwner && (!strict || ctrlOwner === mod)) {
        const ctrl = this.controllerSingletons.get(token as Type<unknown>);
        if (ctrl) {
          return ctrl as unknown as T;
        }
        const ctrlScope = getControllerScope(token as Type<unknown>);
        if (ctrlScope !== Scope.SINGLETON) {
          throw new ScopeLeakException([
            { name: "ModuleRef.get", scope: Scope.SINGLETON },
            { name: token.name || "<Controller>", scope: ctrlScope },
          ]);
        }
      }
      if (mod.metatype === token && mod.instance !== undefined) {
        return mod.instance as unknown as T;
      }
      if (!strict) {
        for (const m of this.graph.modules.values()) {
          if (m.metatype === token && m.instance !== undefined) {
            return m.instance as unknown as T;
          }
        }
      }
    }

    const loc = this.locateTokenForModuleRef(mod, token, strict);
    if (!loc) {
      if (this.autoMocks.has(token)) {
        return this.autoMocks.get(token) as T;
      }
      throw new UnknownDependencyException({
        requester: "ModuleRef.get",
        token,
        moduleName: mod.name,
      });
    }

    return this.readSingletonProviderSync<T>(loc.owner, loc.provider);
  }

  private readSingletonProviderSync<T>(
    owner: ModuleNode,
    provider: NormalizedProvider,
  ): T {
    const allowRoot = this.overriddenProviderKeys.has(
      this.makeInstanceKey(owner, provider.token),
    );
    const scope = this.getEffectiveProviderScope(
      owner,
      provider,
      new Set(),
      allowRoot,
    );
    if (scope !== Scope.SINGLETON) {
      throw new Error(
        `Provider ${formatToken(provider.token)} is ${scope}-scoped and cannot be retrieved synchronously with get(). Use resolve() instead.`,
      );
    }

    // Follow useExisting chains to underlying singleton
    if (provider.kind === "existing" && provider.useExisting !== undefined) {
      return this.getSync<T>(
        provider.useExisting as InjectionToken<T>,
        owner.id,
        { strict: !allowRoot },
      );
    }

    const key = this.makeInstanceKey(owner, provider.token);
    if (!this.singletons.has(key)) {
      throw new Error(
        `Singleton provider ${formatToken(provider.token)} in module "${owner.name}" has not been initialized yet.`,
      );
    }
    return this.singletons.get(key) as T;
  }

  private unwrapRequestContainer(
    contextIdOrContainer?: ContextId | RequestScopeContainer,
  ): RequestContainer | undefined {
    if (contextIdOrContainer instanceof RequestContainer) {
      return contextIdOrContainer;
    }
    if (isContextId(contextIdOrContainer)) {
      return this.getOrCreateContextContainer(contextIdOrContainer);
    }
    return undefined;
  }

  private createEphemeralRequestContainer(): RequestContainer {
    return new RequestContainer((tok, rc) =>
      this.resolveAsync(tok, this.graph.root.id, rc, { strict: false }),
    );
  }

  resolveAsync<T = unknown>(
    token: InjectionToken<T>,
    moduleId: string,
    contextIdOrContainer?: ContextId | RequestScopeContainer,
    options?: { strict?: boolean; each?: false },
  ): Promise<T>;
  resolveAsync<T = unknown>(
    token: InjectionToken<T>,
    moduleId: string,
    contextIdOrContainer: ContextId | RequestScopeContainer | undefined,
    options: { strict?: boolean; each: true },
  ): Promise<T[]>;
  resolveAsync<T = unknown>(
    token: InjectionToken<T>,
    moduleId: string,
    contextIdOrContainer?: ContextId | RequestScopeContainer,
    options?: ModuleRefGetOptions,
  ): Promise<T | T[]>;
  async resolveAsync<T = unknown>(
    token: InjectionToken<T>,
    moduleId: string,
    contextIdOrContainer?: ContextId | RequestScopeContainer,
    options?: ModuleRefGetOptions,
  ): Promise<T | T[]> {
    const strict = options?.strict ?? true;
    const each = options?.each === true;
    const mod = this.graph.modules.get(moduleId) ?? this.graph.root;
    const reqContainer = this.unwrapRequestContainer(contextIdOrContainer);

    const builtIn = this.resolveBuiltInSingleton(token, mod);
    if (builtIn.found) {
      return each ? [builtIn.value as T] : (builtIn.value as T);
    }
    if (isBuiltInRequestToken(token)) {
      if (reqContainer?.hasRequestValue(token)) {
        const val = reqContainer.getRequestValue<T>(token)!;
        return each ? [val] : val;
      }
      throw new Error(
        `Request-scoped token ${formatToken(token)} requires an active RequestContainer or registered request via registerRequestByContextId().`,
      );
    }

    if (each) {
      const results: T[] = [];
      let ephemeralContainer: RequestContainer | undefined;
      const getEffectiveContainer = (needsReq: boolean) => {
        if (reqContainer) return reqContainer;
        if (!needsReq) return undefined;
        ephemeralContainer ??= this.createEphemeralRequestContainer();
        return ephemeralContainer;
      };

      if (typeof token === "function") {
        const owner = this.controllerOwner.get(token as Type<unknown>);
        if (owner && (!strict || owner === mod)) {
          const ctrlScope = getControllerScope(token as Type<unknown>);
          const resolved = await this.resolveController(
            token as Type<unknown>,
            getEffectiveContainer(ctrlScope === Scope.REQUEST),
          );
          results.push(resolved as unknown as T);
        }
      }

      if (MULTI_PROVIDER_TOKENS.has(token)) {
        for (const entry of this.getMultiProviderEntries(token)) {
          if (strict && entry.module !== mod) continue;
          if (entry.instance !== undefined) {
            results.push(entry.instance as T);
          } else if (entry.syntheticToken) {
            const synth = this.syntheticEnhancers.get(entry.syntheticToken);
            const resolved = synth
              ? await this.resolveSyntheticEnhancer(
                  synth,
                  getEffectiveContainer(synth.scope === Scope.REQUEST),
                )
              : undefined;
            if (resolved !== undefined) {
              results.push(resolved as T);
            }
          }
        }
      }

      const locs = this.locateAllTokensForModuleRef(mod, token, strict);
      for (const loc of locs) {
        const allowRoot = this.overriddenProviderKeys.has(
          this.makeInstanceKey(loc.owner, loc.provider.token),
        );
        const effScope = this.getEffectiveProviderScope(
          loc.owner,
          loc.provider,
          new Set(),
          allowRoot,
        );
        const needsReq =
          effScope === Scope.REQUEST ||
          this.providerDependsOnRequestScope(
            loc.owner,
            loc.provider,
            new Set(),
            allowRoot,
          );
        const resolved = await this.resolveNormalizedProvider(
          loc.owner,
          loc.provider,
          getEffectiveContainer(needsReq),
          new Set(),
        );
        results.push(resolved as T);
      }

      if (results.length === 0 && this.autoMocks.has(token)) {
        results.push(this.autoMocks.get(token) as T);
      }

      if (results.length === 0) {
        throw new UnknownDependencyException({
          requester: "ModuleRef.resolve",
          token,
          moduleName: mod.name,
        });
      }

      return results;
    }

    if (typeof token === "function") {
      const owner = this.controllerOwner.get(token as Type<unknown>);
      if (owner && (!strict || owner === mod)) {
        const ctrlScope = getControllerScope(token as Type<unknown>);
        const effectiveContainer =
          reqContainer ??
          (ctrlScope === Scope.REQUEST
            ? this.createEphemeralRequestContainer()
            : undefined);
        return (await this.resolveController(
          token as Type<unknown>,
          effectiveContainer,
        )) as unknown as T;
      }
    }

    const loc = this.locateTokenForModuleRef(mod, token, strict);
    if (!loc) {
      if (this.autoMocks.has(token)) {
        return this.autoMocks.get(token) as T;
      }
      throw new UnknownDependencyException({
        requester: "ModuleRef.resolve",
        token,
        moduleName: mod.name,
      });
    }

    const allowRoot = this.overriddenProviderKeys.has(
      this.makeInstanceKey(loc.owner, loc.provider.token),
    );
    const effScope = this.getEffectiveProviderScope(
      loc.owner,
      loc.provider,
      new Set(),
      allowRoot,
    );
    const needsReq =
      effScope === Scope.REQUEST ||
      this.providerDependsOnRequestScope(
        loc.owner,
        loc.provider,
        new Set(),
        allowRoot,
      );
    const effectiveContainer =
      reqContainer ??
      (needsReq ? this.createEphemeralRequestContainer() : undefined);

    // NestJS parity: when an explicit ContextId/RequestContainer is provided,
    // Scope.TRANSIENT providers resolved via ModuleRef.resolve(token, contextId)
    // are cached per contextId so repeated resolve(token, sameContextId) calls
    // (including via useExisting aliases) return the same instance.
    if (reqContainer && effScope === Scope.TRANSIENT) {
      let targetOwner = loc.owner;
      let targetProvider = loc.provider;
      const visitedAliases = new Set<string>();
      while (
        targetProvider.kind === "existing" &&
        targetProvider.useExisting !== undefined
      ) {
        const aliasKey = this.makeInstanceKey(targetOwner, targetProvider.token);
        if (visitedAliases.has(aliasKey)) break;
        visitedAliases.add(aliasKey);
        const nextLoc = this.locateTokenForModuleRef(
          targetOwner,
          targetProvider.useExisting,
          false,
        );
        if (!nextLoc) break;
        targetOwner = nextLoc.owner;
        targetProvider = nextLoc.provider;
      }
      const transientKey = `transient-resolve:${this.makeInstanceKey(targetOwner, targetProvider.token)}`;
      return await reqContainer.getOrCreateScopedInstance<T>(
        transientKey,
        async () =>
          (await this.resolveNormalizedProvider(
            targetOwner,
            targetProvider,
            reqContainer,
            new Set(),
          )) as T,
      );
    }

    return (await this.resolveNormalizedProvider(
      loc.owner,
      loc.provider,
      effectiveContainer,
      new Set(),
    )) as T;
  }

  async createInstance<T = unknown>(
    type: Type<T>,
    moduleId: string,
    contextIdOrContainer?: ContextId | RequestScopeContainer,
  ): Promise<T> {
    const mod = this.graph.modules.get(moduleId) ?? this.graph.root;
    const reqContainer = this.unwrapRequestContainer(contextIdOrContainer);
    return (await this.instantiateClass(
      type,
      mod,
      reqContainer,
      new Set(),
    )) as T;
  }

  // --- Internal validation & resolution ---

  private locateAllTokensForModuleRef(
    mod: ModuleNode,
    token: InjectionToken,
    strict: boolean,
  ): Array<{ owner: ModuleNode; provider: NormalizedProvider }> {
    if (strict) {
      const visible = ModuleScanner.resolveProviderLocation(
        mod,
        token,
        this.graph.globalModules,
      );
      return visible ? [visible] : [];
    }

    const matches: Array<{ owner: ModuleNode; provider: NormalizedProvider }> =
      [];
    for (const candidate of this.graph.topologicalOrder) {
      const provider = candidate.providers.get(token);
      if (provider) {
        matches.push({ owner: candidate, provider });
      }
    }
    return matches;
  }

  private locateTokenForModuleRef(
    mod: ModuleNode,
    token: InjectionToken,
    strict: boolean,
  ): { owner: ModuleNode; provider: NormalizedProvider } | undefined {
    const visible = ModuleScanner.resolveProviderLocation(
      mod,
      token,
      this.graph.globalModules,
    );
    if (visible || strict) {
      return visible;
    }

    // Non-strict fallback: search across all modules
    for (const candidate of this.graph.topologicalOrder) {
      const provider = candidate.providers.get(token);
      if (provider) {
        return { owner: candidate, provider };
      }
    }
    return undefined;
  }

  private getClassDependencies(target: Type<unknown>): DependencyDescriptor[] {
    const deps: DependencyDescriptor[] = [];
    const paramTypes = MetadataRegistry.getParamTypes(target) ?? [];
    const injectTokens = MetadataRegistry.getInjectTokens(target);
    const optionalIndices = new Set(MetadataRegistry.getOptionalDeps(target));

    const injectMap = new Map<number, unknown>();
    for (const entry of injectTokens) {
      injectMap.set(entry.index, entry.token);
    }

    const maxIndex = Math.max(
      paramTypes.length - 1,
      ...injectTokens.map((i) => i.index),
      ...optionalIndices,
      -1,
    );

    for (let i = 0; i <= maxIndex; i++) {
      const hasInject = injectMap.has(i);
      const raw = hasInject ? injectMap.get(i) : paramTypes[i];
      const { token, isForwardRef } = unwrapToken(raw);
      deps.push({
        index: i,
        rawToken: raw,
        token,
        optional: optionalIndices.has(i),
        isForwardRef,
      });
    }

    // Property injections
    const propTokens = MetadataRegistry.getPropertyInjectTokens(target);
    const optionalProps = new Set(
      MetadataRegistry.getOptionalPropertyDeps(target),
    );
    for (const prop of propTokens) {
      const { token, isForwardRef } = unwrapToken(prop.token);
      deps.push({
        propertyKey: prop.propertyKey,
        rawToken: prop.token,
        token,
        optional: optionalProps.has(prop.propertyKey),
        isForwardRef,
      });
    }

    return deps;
  }

  private getProviderDependencies(
    provider: NormalizedProvider,
  ): DependencyDescriptor[] {
    if (provider.kind === "value") {
      return [];
    }

    if (provider.kind === "existing") {
      return [
        {
          rawToken: provider.useExisting,
          token: provider.useExisting,
          optional: false,
          isForwardRef: false,
        },
      ];
    }

    if (provider.kind === "factory") {
      const injectList = provider.inject ?? [];
      return injectList.map((dep, index) => {
        if (isOptionalFactoryDep(dep)) {
          const { token, isForwardRef } = unwrapToken(dep.token);
          return {
            index,
            rawToken: dep.token,
            token,
            optional: dep.optional,
            isForwardRef,
          };
        }
        const { token, isForwardRef } = unwrapToken(dep);
        return {
          index,
          rawToken: dep,
          token,
          optional: false,
          isForwardRef,
        };
      });
    }

    // ClassProvider
    if (provider.inject) {
      return provider.inject.map((dep, index) => {
        if (isOptionalFactoryDep(dep)) {
          const { token, isForwardRef } = unwrapToken(dep.token);
          return {
            index,
            rawToken: dep.token,
            token,
            optional: dep.optional,
            isForwardRef,
          };
        }
        const { token, isForwardRef } = unwrapToken(dep);
        return {
          index,
          rawToken: dep,
          token,
          optional: false,
          isForwardRef,
        };
      });
    }

    if (!provider.useClass) {
      return [];
    }

    return this.getClassDependencies(provider.useClass);
  }

  private validateAllDependenciesAndCycles(): void {
    const validatedProviders = new Set<string>();

    const visitProvider = (
      mod: ModuleNode,
      provider: NormalizedProvider,
      stack: Array<{
        key: string;
        name: string;
        kind: NormalizedProvider["kind"];
        scope: Scope;
        edgeForwardRef: boolean;
      }>,
    ) => {
      const key = this.makeInstanceKey(mod, provider.token);
      if (validatedProviders.has(key)) {
        return;
      }

      const providerName = formatToken(provider.token);
      const deps = this.getProviderDependencies(provider);
      const allowRoot = this.overriddenProviderKeys.has(key);

      for (const dep of deps) {
        if (dep.token === undefined) {
          if (dep.optional) continue;
          throw new UnknownDependencyException({
            requester: providerName,
            token: dep.rawToken,
            index: dep.index,
            propertyKey: dep.propertyKey,
            moduleName: mod.name,
            resolutionPath: stack.map((s) => s.name),
          });
        }

        if (
          isBuiltInSingletonToken(dep.token) ||
          isBuiltInRequestToken(dep.token)
        ) {
          continue;
        }

        const loc = this.resolveProviderLocationForMod(
          mod,
          dep.token,
          allowRoot,
        );
        if (!loc) {
          if (dep.optional) continue;
          if (this.tryResolveAutoMock(dep.token).found) continue;
          throw new UnknownDependencyException({
            requester: providerName,
            token: dep.token,
            index: dep.index,
            propertyKey: dep.propertyKey,
            moduleName: mod.name,
            resolutionPath: [
              ...stack.map((s) => s.name),
              formatToken(dep.token),
            ],
          });
        }

        const depKey = this.makeInstanceKey(loc.owner, loc.provider.token);
        const cycleIdx = stack.findIndex((item) => item.key === depKey);

        if (cycleIdx !== -1) {
          const cycleNodes = stack.slice(cycleIdx);
          const hasForwardRefInCycle =
            dep.isForwardRef ||
            cycleNodes.slice(1).some((n) => n.edgeForwardRef);

          const chain = [
            ...cycleNodes.map((n) => n.name),
            formatToken(loc.provider.token),
          ];

          if (!hasForwardRefInCycle) {
            throw new CircularDependencyException({
              chain,
              kind: "provider",
            });
          }

          // ADR-007 §6: circular factories or non-singleton scopes cannot use forwardRef
          const invalidNode = cycleNodes.find(
            (n) => n.kind === "factory" || n.scope !== Scope.SINGLETON,
          );
          if (invalidNode) {
            throw new CircularDependencyException({
              chain,
              kind: "provider",
              reason:
                invalidNode.kind === "factory"
                  ? `factory provider ${invalidNode.name} cannot participate in a forwardRef cycle`
                  : `${invalidNode.scope}-scoped provider ${invalidNode.name} cannot participate in a forwardRef cycle`,
            });
          }

          // Valid forwardRef cycle among singleton class/existing providers
          continue;
        }

        visitProvider(loc.owner, loc.provider, [
          ...stack,
          {
            key: depKey,
            name: formatToken(loc.provider.token),
            kind: loc.provider.kind,
            scope: loc.provider.scope,
            edgeForwardRef: dep.isForwardRef,
          },
        ]);
      }

      validatedProviders.add(key);
    };

    const validateClassDeps = (
      target: Type<unknown>,
      mod: ModuleNode,
      label: string,
    ) => {
      const deps = this.getClassDependencies(target);
      for (const dep of deps) {
        if (dep.token === undefined) {
          if (dep.optional) continue;
          throw new UnknownDependencyException({
            requester: label,
            token: dep.rawToken,
            index: dep.index,
            propertyKey: dep.propertyKey,
            moduleName: mod.name,
            resolutionPath: [label],
          });
        }
        if (
          isBuiltInSingletonToken(dep.token) ||
          isBuiltInRequestToken(dep.token)
        ) {
          continue;
        }
        const loc = ModuleScanner.resolveProviderLocation(
          mod,
          dep.token,
          this.graph.globalModules,
        );
        if (!loc) {
          if (dep.optional) continue;
          if (this.tryResolveAutoMock(dep.token).found) continue;
          throw new UnknownDependencyException({
            requester: label,
            token: dep.token,
            index: dep.index,
            propertyKey: dep.propertyKey,
            moduleName: mod.name,
            resolutionPath: [label, formatToken(dep.token)],
          });
        }
      }
    };

    for (const mod of this.graph.topologicalOrder) {
      for (const provider of mod.providers.values()) {
        visitProvider(mod, provider, [
          {
            key: this.makeInstanceKey(mod, provider.token),
            name: formatToken(provider.token),
            kind: provider.kind,
            scope: provider.scope,
            edgeForwardRef: false,
          },
        ]);
      }

      for (const providers of mod.multiProviders.values()) {
        for (const provider of providers) {
          // Validate dependencies of each multi-provider
          const deps = this.getProviderDependencies(provider);
          const label = formatToken(provider.useClass ?? provider.token);
          const allowRoot = this.overriddenMultiProviders.has(provider);
          for (const dep of deps) {
            if (dep.token === undefined) {
              if (dep.optional) continue;
              throw new UnknownDependencyException({
                requester: label,
                token: dep.rawToken,
                index: dep.index,
                propertyKey: dep.propertyKey,
                moduleName: mod.name,
                resolutionPath: [label],
              });
            }
            if (
              isBuiltInSingletonToken(dep.token) ||
              isBuiltInRequestToken(dep.token)
            ) {
              continue;
            }
            const loc = this.resolveProviderLocationForMod(
              mod,
              dep.token,
              allowRoot,
            );
            if (!loc && !dep.optional) {
              if (this.tryResolveAutoMock(dep.token).found) continue;
              throw new UnknownDependencyException({
                requester: label,
                token: dep.token,
                index: dep.index,
                propertyKey: dep.propertyKey,
                moduleName: mod.name,
                resolutionPath: [label, formatToken(dep.token)],
              });
            }
          }
        }
      }

      validateClassDeps(mod.metatype, mod, mod.name);

      for (const ctrl of mod.controllers) {
        validateClassDeps(ctrl, mod, ctrl.name || "<Controller>");
      }
    }
  }

  /**
   * Enforces ADR-012 §3: a SINGLETON consumer MUST NEVER depend (directly or
   * transitively, including through TRANSIENT providers) on a REQUEST-scoped provider.
   */
  private checkDependenciesForScopeLeak(
    mod: ModuleNode,
    deps: readonly DependencyDescriptor[],
    chain: ScopeChainNode[],
    visitedKeys: Set<string>,
    allowRootFallback = false,
  ): void {
    for (const dep of deps) {
      if (dep.token === undefined || isBuiltInSingletonToken(dep.token)) {
        continue;
      }

      if (isBuiltInRequestToken(dep.token)) {
        throw new ScopeLeakException([
          ...chain,
          { name: formatToken(dep.token), scope: Scope.REQUEST },
        ]);
      }

      const loc = this.resolveProviderLocationForMod(
        mod,
        dep.token,
        allowRootFallback,
      );
      if (!loc) {
        continue;
      }

      const depAllowRoot = this.overriddenProviderKeys.has(
        this.makeInstanceKey(loc.owner, loc.provider.token),
      );
      const depScope = this.getEffectiveProviderScope(
        loc.owner,
        loc.provider,
        new Set(),
        depAllowRoot,
      );
      const depName = formatToken(loc.provider.token);

      if (depScope === Scope.REQUEST) {
        throw new ScopeLeakException([
          ...chain,
          { name: depName, scope: Scope.REQUEST },
        ]);
      }

      const key = this.makeInstanceKey(loc.owner, loc.provider.token);
      if (visitedKeys.has(key)) {
        continue;
      }
      visitedKeys.add(key);

      this.checkDependenciesForScopeLeak(
        loc.owner,
        this.getProviderDependencies(loc.provider),
        [...chain, { name: depName, scope: depScope }],
        visitedKeys,
        depAllowRoot,
      );
    }
  }

  private validateScopeLeaks(): void {
    for (const mod of this.graph.topologicalOrder) {
      // Check module class (always singleton)
      this.checkDependenciesForScopeLeak(
        mod,
        this.getClassDependencies(mod.metatype),
        [{ name: mod.name, scope: Scope.SINGLETON }],
        new Set(),
      );

      // Check singleton providers
      for (const provider of mod.providers.values()) {
        const key = this.makeInstanceKey(mod, provider.token);
        const allowRoot = this.overriddenProviderKeys.has(key);
        const scope = this.getEffectiveProviderScope(
          mod,
          provider,
          new Set(),
          allowRoot,
        );
        if (scope === Scope.SINGLETON) {
          this.checkDependenciesForScopeLeak(
            mod,
            this.getProviderDependencies(provider),
            [{ name: formatToken(provider.token), scope: Scope.SINGLETON }],
            new Set([key]),
            allowRoot,
          );
        }
      }

      // Check singleton multi-providers (APP_GUARD, APP_PIPE, etc.)
      for (const providers of mod.multiProviders.values()) {
        for (const provider of providers) {
          const allowRoot = this.overriddenMultiProviders.has(provider);
          const scope = this.getEffectiveProviderScope(
            mod,
            provider,
            new Set(),
            allowRoot,
          );
          if (scope === Scope.SINGLETON) {
            this.checkDependenciesForScopeLeak(
              mod,
              this.getProviderDependencies(provider),
              [
                {
                  name: formatToken(provider.useClass ?? provider.token),
                  scope: Scope.SINGLETON,
                },
              ],
              new Set(),
              allowRoot,
            );
          }
        }
      }

      // Check singleton controllers
      for (const ctrl of mod.controllers) {
        const ctrlScope = getControllerScope(ctrl);
        if (ctrlScope === Scope.SINGLETON) {
          this.checkDependenciesForScopeLeak(
            mod,
            this.getClassDependencies(ctrl),
            [{ name: ctrl.name || "<Controller>", scope: Scope.SINGLETON }],
            new Set(),
          );
        }
      }
    }

    // Check singleton class-based enhancers & middleware (ADR-012 §3), respecting kind-specific overrides
    const validatedUsages = new Set<string>();
    for (const { cls, mod: ownerMod, kind } of this.controllerEnhancerUsages) {
      const usageKey = `${ownerMod.id}:${kind ?? "middleware"}:${this.getTokenId(cls)}`;
      if (validatedUsages.has(usageKey)) continue;
      validatedUsages.add(usageKey);

      const override = kind ? this.getEnhancerOverride(cls, kind) : undefined;
      if (override) {
        if (override.kind === "value") continue;
        const overrideProvider = enhancerOverrideToNormalizedProvider(
          cls,
          override,
        );
        const effectiveScope = this.getEffectiveProviderScope(
          ownerMod,
          overrideProvider,
          new Set(),
          true,
        );
        if (effectiveScope === Scope.SINGLETON) {
          const label =
            override.kind === "class"
              ? override.useClass.name || cls.name || "<Enhancer>"
              : cls.name || "<Enhancer>";
          this.checkDependenciesForScopeLeak(
            ownerMod,
            this.getProviderDependencies(overrideProvider),
            [{ name: label, scope: Scope.SINGLETON }],
            new Set(),
            true,
          );
        }
        continue;
      }

      const scope = getInjectableScope(cls);
      if (scope === Scope.SINGLETON) {
        this.checkDependenciesForScopeLeak(
          ownerMod,
          this.getClassDependencies(cls),
          [{ name: cls.name || "<Enhancer>", scope: Scope.SINGLETON }],
          new Set(),
        );
      }
    }
  }

  private getEffectiveProviderScope(
    mod: ModuleNode,
    provider: NormalizedProvider,
    visited = new Set<string>(),
    allowRootFallback = false,
  ): Scope {
    if (provider.kind !== "existing" || provider.useExisting === undefined) {
      return provider.scope;
    }

    const key = this.makeInstanceKey(mod, provider.token);
    if (visited.has(key)) {
      return Scope.SINGLETON;
    }
    visited.add(key);

    if (isBuiltInRequestToken(provider.useExisting)) {
      return Scope.REQUEST;
    }
    if (isBuiltInSingletonToken(provider.useExisting)) {
      return Scope.SINGLETON;
    }

    const loc = this.resolveProviderLocationForMod(
      mod,
      provider.useExisting,
      allowRootFallback,
    );
    if (!loc) {
      return Scope.SINGLETON;
    }
    const nextAllowRoot = this.overriddenProviderKeys.has(
      this.makeInstanceKey(loc.owner, loc.provider.token),
    );
    return this.getEffectiveProviderScope(
      loc.owner,
      loc.provider,
      visited,
      nextAllowRoot,
    );
  }

  private classDependsOnRequestScope(
    target: Type<unknown>,
    mod: ModuleNode,
    visited: Set<string>,
    allowRootFallback = false,
  ): boolean {
    const deps = this.getClassDependencies(target);
    for (const dep of deps) {
      if (dep.token === undefined || isBuiltInSingletonToken(dep.token)) {
        continue;
      }
      if (isBuiltInRequestToken(dep.token)) {
        return true;
      }
      const loc = this.resolveProviderLocationForMod(
        mod,
        dep.token,
        allowRootFallback,
      );
      if (
        loc &&
        this.providerDependsOnRequestScope(
          loc.owner,
          loc.provider,
          visited,
          this.overriddenProviderKeys.has(
            this.makeInstanceKey(loc.owner, loc.provider.token),
          ),
        )
      ) {
        return true;
      }
    }
    return false;
  }

  private providerDependsOnRequestScope(
    mod: ModuleNode,
    provider: NormalizedProvider,
    visited: Set<string>,
    allowRootFallback = false,
  ): boolean {
    if (
      this.getEffectiveProviderScope(
        mod,
        provider,
        new Set(),
        allowRootFallback,
      ) === Scope.REQUEST
    ) {
      return true;
    }
    const key = this.makeInstanceKey(mod, provider.token);
    if (visited.has(key)) {
      return false;
    }
    visited.add(key);

    for (const dep of this.getProviderDependencies(provider)) {
      if (dep.token === undefined || isBuiltInSingletonToken(dep.token)) {
        continue;
      }
      if (isBuiltInRequestToken(dep.token)) {
        return true;
      }
      const loc = this.resolveProviderLocationForMod(
        mod,
        dep.token,
        allowRootFallback,
      );
      if (
        loc &&
        this.providerDependsOnRequestScope(
          loc.owner,
          loc.provider,
          visited,
          this.overriddenProviderKeys.has(
            this.makeInstanceKey(loc.owner, loc.provider.token),
          ),
        )
      ) {
        return true;
      }
    }
    return false;
  }

  private async resolveNormalizedProvider(
    owner: ModuleNode,
    provider: NormalizedProvider,
    requestContainer: RequestContainer | undefined,
    activeInstantiations: Set<string>,
    inquirer?: unknown,
  ): Promise<unknown> {
    const key = this.makeInstanceKey(owner, provider.token);
    const allowRoot = this.overriddenProviderKeys.has(key);

    // Follow useExisting alias directly to target provider
    if (provider.kind === "existing" && provider.useExisting !== undefined) {
      return this.resolveDependencyToken(
        owner,
        {
          rawToken: provider.useExisting,
          token: provider.useExisting,
          optional: false,
          isForwardRef: false,
        },
        formatToken(provider.token),
        requestContainer,
        activeInstantiations,
        allowRoot,
        inquirer ?? provider.token,
      );
    }

    const scope = this.getEffectiveProviderScope(
      owner,
      provider,
      new Set(),
      allowRoot,
    );

    if (scope === Scope.SINGLETON) {
      if (this.singletons.has(key)) {
        return this.singletons.get(key);
      }

      activeInstantiations.add(key);
      try {
        const instance = await this.instantiateProvider(
          owner,
          provider,
          requestContainer,
          activeInstantiations,
          allowRoot,
          inquirer,
        );
        this.singletons.set(key, instance);
        const box = this.deferredBoxes.get(key);
        if (box && typeof instance === "object" && instance !== null) {
          box.target = instance;
          this.deferredBoxes.delete(key);
        }
        return instance;
      } finally {
        activeInstantiations.delete(key);
      }
    }

    if (scope === Scope.REQUEST) {
      if (!requestContainer) {
        throw new Error(
          `Cannot resolve REQUEST-scoped provider ${formatToken(provider.token)} without an active RequestContainer.`,
        );
      }
      const isDurable =
        provider.durable === true ||
        (provider.useClass ? isInjectableDurable(provider.useClass) : false);
      const targetContainer =
        this.resolveDurableContainerFor(
          provider.useClass ?? provider.token,
          isDurable,
          requestContainer,
          provider.token,
        ) ?? requestContainer;
      try {
        return await targetContainer.getOrCreateScopedInstance(key, () =>
          this.instantiateProvider(
            owner,
            provider,
            targetContainer,
            activeInstantiations,
            allowRoot,
            inquirer,
          ),
        );
      } catch (err) {
        this.evictEmptyDurableContainer(targetContainer);
        throw err;
      }
    }

    // Scope.TRANSIENT -> new instance per resolution
    const instance = await this.instantiateProvider(
      owner,
      provider,
      requestContainer,
      activeInstantiations,
      allowRoot,
      inquirer,
    );
    if (requestContainer) {
      requestContainer.trackInstance(instance);
    }
    return instance;
  }

  private async instantiateProvider(
    owner: ModuleNode,
    provider: NormalizedProvider,
    requestContainer: RequestContainer | undefined,
    activeInstantiations: Set<string>,
    allowRootFallback = false,
    inquirer?: unknown,
  ): Promise<unknown> {
    if (provider.kind === "value") {
      return provider.useValue;
    }

    if (provider.kind === "factory") {
      if (!provider.useFactory) {
        throw new Error(
          `Factory provider ${formatToken(provider.token)} is missing useFactory.`,
        );
      }
      const deps = this.getProviderDependencies(provider);
      const args: unknown[] = [];
      for (const dep of deps) {
        args.push(
          await this.resolveDependencyToken(
            owner,
            dep,
            formatToken(provider.token),
            requestContainer,
            activeInstantiations,
            allowRootFallback,
            dep.token === INQUIRER ? inquirer : provider.token,
          ),
        );
      }
      let created = await provider.useFactory(...args);
      if (
        created !== null &&
        typeof created === "object" &&
        !this.wovenInstances.has(created as object)
      ) {
        const tokenClass =
          typeof provider.token === "function" &&
          this.hasAspectsForClass(provider.token, owner, true)
            ? (provider.token as Abstract<object>)
            : undefined;
        const ctorCandidate = (created as object).constructor;
        const ctorClass =
          !tokenClass &&
          typeof ctorCandidate === "function" &&
          this.hasAspectsForClass(ctorCandidate, owner, true)
            ? (ctorCandidate as Abstract<object>)
            : undefined;
        const aspectTargetClass = tokenClass ?? ctorClass;

        if (aspectTargetClass) {
          const pointcuts = this.getActivePointcuts(owner);
          const resolver = await this.createPrewarmedAspectResolver(
            aspectTargetClass,
            owner,
            requestContainer,
            activeInstantiations,
            pointcuts,
          );
          const woven = weaveProxyMethodAspects(
            created as object,
            aspectTargetClass,
            resolver,
            pointcuts,
          );
          this.wovenInstances.add(created as object);
          this.wovenInstances.add(woven);
          created = woven;
        }
      }
      return this.applyInstrumentation(created);
    }

    if (provider.kind === "class") {
      if (!provider.useClass) {
        throw new Error(
          `Class provider ${formatToken(provider.token)} is missing useClass.`,
        );
      }
      if (provider.inject) {
        const deps = this.getProviderDependencies(provider);
        const inquirerObj = Object.create(provider.useClass.prototype) as object;
        const args: unknown[] = [];
        for (const dep of deps) {
          args.push(
            await this.resolveDependencyToken(
              owner,
              dep,
              provider.useClass.name || formatToken(provider.token),
              requestContainer,
              activeInstantiations,
              allowRootFallback,
              dep.token === INQUIRER ? inquirer : inquirerObj,
            ),
          );
        }
        const instance = new provider.useClass(...args) as Record<
          string | symbol,
          unknown
        >;
        await this.injectProperties(
          provider.useClass,
          instance,
          owner,
          requestContainer,
          activeInstantiations,
          allowRootFallback,
          inquirer,
        );
        if (this.hasAspectsForClass(provider.useClass, owner)) {
          await this.weaveMethodAspectsIfNeeded(
            instance,
            owner,
            requestContainer,
            activeInstantiations,
          );
        }
        return this.applyInstrumentation(instance);
      }

      return this.instantiateClass(
        provider.useClass,
        owner,
        requestContainer,
        activeInstantiations,
        allowRootFallback,
        inquirer,
      );
    }

    throw new Error(
      `Unsupported provider kind "${provider.kind}" for ${formatToken(provider.token)}.`,
    );
  }

  private async instantiateClass(
    target: Type<unknown>,
    owner: ModuleNode,
    requestContainer: RequestContainer | undefined,
    activeInstantiations: Set<string>,
    allowRootFallback = false,
    inquirer?: unknown,
  ): Promise<unknown> {
    const allDeps = this.getClassDependencies(target);
    const ctorDeps = allDeps.filter((d) => d.index !== undefined);
    const inquirerObj = Object.create(target.prototype) as object;
    const args: unknown[] = [];

    for (const dep of ctorDeps) {
      args.push(
        await this.resolveDependencyToken(
          owner,
          dep,
          target.name || "<anonymous>",
          requestContainer,
          activeInstantiations,
          allowRootFallback,
          dep.token === INQUIRER ? inquirer : inquirerObj,
        ),
      );
    }

    const instance = new target(...args) as Record<string | symbol, unknown>;
    await this.injectProperties(
      target,
      instance,
      owner,
      requestContainer,
      activeInstantiations,
      allowRootFallback,
      inquirer,
    );
    if (this.hasAspectsForClass(target, owner)) {
      await this.weaveMethodAspectsIfNeeded(
        instance,
        owner,
        requestContainer,
        activeInstantiations,
      );
    }
    return this.applyInstrumentation(instance);
  }

  private async injectProperties(
    target: Type<unknown>,
    instance: Record<string | symbol, unknown>,
    owner: ModuleNode,
    requestContainer: RequestContainer | undefined,
    activeInstantiations: Set<string>,
    allowRootFallback = false,
    inquirer?: unknown,
  ): Promise<void> {
    const propDeps = this.getClassDependencies(target).filter(
      (d) => d.propertyKey !== undefined,
    );
    for (const dep of propDeps) {
      const value = await this.resolveDependencyToken(
        owner,
        dep,
        target.name || "<anonymous>",
        requestContainer,
        activeInstantiations,
        allowRootFallback,
        dep.token === INQUIRER ? inquirer : instance,
      );
      if (
        dep.propertyKey !== undefined &&
        (!dep.optional || value !== undefined)
      ) {
        instance[dep.propertyKey] = value;
      }
    }
  }

  private async resolveDependencyToken(
    requestingModule: ModuleNode,
    dep: DependencyDescriptor,
    requesterName: string,
    requestContainer: RequestContainer | undefined,
    activeInstantiations: Set<string>,
    allowRootFallback = false,
    inquirer?: unknown,
  ): Promise<unknown> {
    if (dep.token === undefined) {
      if (dep.optional) {
        return undefined;
      }
      throw new UnknownDependencyException({
        requester: requesterName,
        token: dep.rawToken,
        index: dep.index,
        propertyKey: dep.propertyKey,
        moduleName: requestingModule.name,
      });
    }

    if (dep.token === INQUIRER) {
      return inquirer;
    }

    const builtIn = this.resolveBuiltInSingleton(dep.token, requestingModule);
    if (builtIn.found) {
      return builtIn.value;
    }
    if (isBuiltInRequestToken(dep.token)) {
      if (requestContainer) {
        return requestContainer.getRequestValue(dep.token);
      }
      if (dep.optional) {
        return undefined;
      }
      throw new Error(
        `Request-scoped token ${formatToken(dep.token)} requested by "${requesterName}" requires an active RequestContainer or registered request via registerRequestByContextId().`,
      );
    }

    const loc = this.resolveProviderLocationForMod(
      requestingModule,
      dep.token,
      allowRootFallback,
    );
    if (!loc) {
      if (dep.optional) {
        return undefined;
      }
      const autoMock = this.tryResolveAutoMock(dep.token);
      if (autoMock.found) {
        return autoMock.value;
      }
      throw new UnknownDependencyException({
        requester: requesterName,
        token: dep.token,
        index: dep.index,
        propertyKey: dep.propertyKey,
        moduleName: requestingModule.name,
      });
    }

    const targetKey = this.makeInstanceKey(loc.owner, loc.provider.token);

    if (activeInstantiations.has(targetKey)) {
      if (!this.validated && !dep.isForwardRef) {
        throw new CircularDependencyException({
          chain: [requesterName, formatToken(loc.provider.token)],
          kind: "provider",
        });
      }
      return this.getOrCreateDeferredProxy(
        targetKey,
        formatToken(loc.provider.token),
        loc.provider.useClass,
      );
    }

    try {
      return await this.resolveNormalizedProvider(
        loc.owner,
        loc.provider,
        requestContainer,
        activeInstantiations,
        inquirer,
      );
    } catch (err) {
      if (dep.optional && !requestContainer) {
        const depScope = this.getEffectiveProviderScope(
          loc.owner,
          loc.provider,
          new Set(),
          allowRootFallback,
        );
        if (depScope === Scope.TRANSIENT) {
          return undefined;
        }
      }
      throw err;
    }
  }

  private getOrCreateDeferredProxy(
    key: string,
    name: string,
    targetClass?: Type<unknown>,
  ): object {
    let box = this.deferredBoxes.get(key);
    if (!box) {
      box = { target: undefined, name };
      this.deferredBoxes.set(key, box);
    }

    const ensureReady = (): object => {
      if (!box.target) {
        throw new CircularDependencyException({
          chain: [box.name],
          kind: "provider",
          reason: `cannot access uninitialized forwardRef dependency "${box.name}" eagerly inside a constructor`,
        });
      }
      return box.target;
    };

    return new Proxy(
      {},
      {
        get(_t, prop) {
          // Crucial: never appear as a Promise/thenable to `await` while uninitialized
          if (prop === "then" && !box.target) {
            return undefined;
          }
          const target = ensureReady();
          const value = Reflect.get(target, prop, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
        set(_t, prop, value) {
          const target = ensureReady();
          return Reflect.set(target, prop, value, target);
        },
        has(_t, prop) {
          return Reflect.has(ensureReady(), prop);
        },
        ownKeys() {
          return Reflect.ownKeys(ensureReady());
        },
        getOwnPropertyDescriptor(_t, prop) {
          return Reflect.getOwnPropertyDescriptor(ensureReady(), prop);
        },
        getPrototypeOf() {
          if (box.target) {
            return Object.getPrototypeOf(box.target);
          }
          return targetClass ? targetClass.prototype : Object.prototype;
        },
      },
    );
  }

  private getTokenId(token: InjectionToken): number {
    let id = this.tokenKeyIds.get(token);
    if (id === undefined) {
      id = ++this.tokenIdCounter;
      this.tokenKeyIds.set(token, id);
    }
    return id;
  }

  private makeInstanceKey(mod: ModuleNode, token: InjectionToken): string {
    return `${mod.id}::${this.getTokenId(token)}`;
  }
}
