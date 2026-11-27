import {
  APP_FILTER,
  APP_GUARD,
  APP_INTERCEPTOR,
  APP_PIPE,
  Inject,
  Injectable,
  METADATA_KEYS,
  MODULE_FILTER,
  MODULE_GUARD,
  MODULE_INTERCEPTOR,
  MODULE_PIPE,
  MetadataRegistry,
  Optional,
  Scope,
  getInjectableScope,
  type ArgumentMetadata,
  type BunestInterceptor,
  type CanActivate,
  type ContextId,
  type ExceptionFilter,
  type ExceptionFilterLike,
  type GuardLike,
  type InjectionToken,
  type InterceptorLike,
  type LogLevel,
  type LoggerService,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  type ParameterMetadata,
  type PipeLike,
  type PipeTransform,
  type PreRequestHook,
  type RequestContainer,
  type Type,
  type WebSocketAdapter,
} from "@bunest/core";
import {
  ClsService,
  DiscoveryService,
  MetadataScanner,
  ModuleRef,
} from "@bunest/core";
import type { ClientProxy } from "./client-proxy";
import { ClientProxyFactory } from "./client-proxy-factory";
import { RpcException } from "./exceptions";
import type {
  ClientOptions,
  GrpcMethodMetadata,
  MessageHandler,
  MicroserviceDeadLetterHandler,
  PatternHandlerMetadata,
  RpcContext,
  RpcParamMetadata,
} from "./interfaces";
import { RpcExecutionContext } from "./rpc-context";
import type { MicroserviceTransportServer } from "./server";
import {
  CLIENT_CONFIGURATION_METADATA,
  CLIENT_METADATA,
  EVENT_PATTERN_METADATA,
  GRPC_METHOD_METADATA,
  MESSAGE_PATTERN_METADATA,
  MICROSERVICE_SERVER,
  RPC_PARAM_METADATA,
} from "./tokens";

function collectMergedClassArray<T>(
  key: symbol | string,
  target: Function,
): T[] {
  const chain: Function[] = [];
  let cursor: Function | null = target;
  while (cursor && cursor !== Function.prototype && cursor !== Object) {
    chain.push(cursor);
    const parent = Object.getPrototypeOf(cursor);
    cursor = typeof parent === "function" ? parent : null;
  }
  chain.reverse();

  const merged: T[] = [];
  for (const ctor of chain) {
    const own = MetadataRegistry.getOwn<readonly T[]>(key, ctor);
    if (own) {
      merged.push(...own);
    }
  }
  return merged;
}

interface DiscoveredRpcTarget {
  readonly ctor: Type<unknown>;
  readonly instance?: object;
  readonly moduleId?: string;
  readonly isRequestScoped: boolean;
  readonly staticEnhancerCache: Map<unknown, unknown>;
}

interface ScopedEnhancerSpec<T> {
  readonly spec: T;
  readonly owningModule?: unknown;
}

type RpcEnhancerKind = "guard" | "pipe" | "interceptor" | "filter";

interface MicroserviceContainerLike {
  createRequestContainer(
    request: Request,
    responseContext?: unknown,
    requestContext?: unknown,
  ): RequestContainer;
  resolveEnhancer<T = unknown>(
    enhancer: Type<T> | T,
    requestContainer?: RequestContainer,
    owningModule?: unknown,
    kind?: RpcEnhancerKind,
  ): Promise<T>;
  requiresEnhancerRequestScope?(
    enhancer: unknown,
    kind?: RpcEnhancerKind,
    controllerToken?: Type<unknown>,
  ): boolean;
  getMultiProviderEntries?(token: InjectionToken): ReadonlyArray<{
    module: unknown;
    provider: { useClass?: Type<unknown>; scope?: Scope };
    instance?: unknown;
    syntheticToken?: Type<unknown>;
  }>;
  getModuleMultiProviderEntries?(
    token: InjectionToken,
    moduleIdOrNode: string | unknown,
  ): ReadonlyArray<{
    module: unknown;
    provider: { useClass?: Type<unknown>; scope?: Scope };
    instance?: unknown;
    syntheticToken?: Type<unknown>;
  }>;
  getModuleByKey?(moduleKey: string): unknown;
  resolveAsync<T = unknown>(
    token: InjectionToken<T>,
    moduleId: string,
    contextIdOrContainer?: ContextId | RequestContainer,
    options?: { strict?: boolean },
  ): Promise<T>;
  getGraph?(): { root: { id: string } };
}

function collectDiscoveredTargets(
  discoveryService: DiscoveryService | undefined,
): DiscoveredRpcTarget[] {
  if (!discoveryService) {
    return [];
  }
  const seenInstances = new Set<object>();
  const seenScoped = new Set<string>();
  const targets: DiscoveredRpcTarget[] = [];
  for (const wrapper of [
    ...discoveryService.getControllers(),
    ...discoveryService.getProviders(),
  ]) {
    const instance =
      wrapper.instance && typeof wrapper.instance === "object"
        ? (wrapper.instance as object)
        : undefined;
    const ctor = (wrapper.metatype ??
      (instance ? instance.constructor : undefined)) as
      | Type<unknown>
      | undefined;
    if (typeof ctor !== "function") {
      continue;
    }

    const isRequestScoped =
      wrapper.scope === Scope.REQUEST || instance === undefined;

    if (instance) {
      if (seenInstances.has(instance)) {
        continue;
      }
      seenInstances.add(instance);
    } else {
      const key = `${wrapper.moduleId}:${ctor.name}`;
      if (seenScoped.has(key)) {
        continue;
      }
      seenScoped.add(key);
    }

    targets.push({
      ctor,
      instance,
      moduleId: wrapper.moduleId,
      isRequestScoped,
      staticEnhancerCache: new Map(),
    });
  }
  return targets;
}

/**
 * Discovers `@MessagePattern()`, `@EventPattern()`, `@GrpcMethod()`, and
 * `@GrpcStreamMethod()` handlers across loaded controllers & providers via
 * `@bunest/core`'s public `DiscoveryService` & `MetadataScanner`, compiles full
 * RPC guard/pipe/interceptor/filter pipelines with `ExecutionContext.switchToRpc()`,
 * binds them to the transport server(s), and manages start/stop lifecycle hooks.
 */
@Injectable()
export class MicroserviceHost
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly servers: MicroserviceTransportServer[] = [];
  private readonly managedClients: ClientProxy[] = [];
  private readonly globalPipes: PipeLike[] = [];
  private readonly globalGuards: GuardLike[] = [];
  private readonly globalInterceptors: InterceptorLike[] = [];
  private readonly globalFilters: ExceptionFilterLike[] = [];
  private discovered = false;
  private isInitializedFlag = false;
  private isTerminatedFlag = false;
  private wasInitHookCalledFlag = false;
  private isConnectedToAppFlag = false;
  private loggerOverride?: LoggerService | LogLevel[] | false;
  private wsAdapter?: WebSocketAdapter;
  private deadLetterHandler?: MicroserviceDeadLetterHandler;

  constructor(
    private readonly moduleRef: ModuleRef,
    @Optional()
    @Inject(MICROSERVICE_SERVER)
    primaryServer?: MicroserviceTransportServer,
    @Optional()
    private readonly discoveryService?: DiscoveryService,
    @Optional()
    private readonly metadataScanner?: MetadataScanner,
    @Optional()
    private readonly clsService?: ClsService,
  ) {
    if (primaryServer) {
      this.addServer(primaryServer);
    }
  }

  get status(): string {
    return this.servers[0]?.status ?? "disconnected";
  }

  useGlobalPipes(...pipes: PipeLike[]): this {
    this.globalPipes.push(...pipes);
    return this;
  }

  useGlobalGuards(...guards: GuardLike[]): this {
    this.globalGuards.push(...guards);
    return this;
  }

  useGlobalInterceptors(...interceptors: InterceptorLike[]): this {
    this.globalInterceptors.push(...interceptors);
    return this;
  }

  useGlobalFilters(...filters: ExceptionFilterLike[]): this {
    this.globalFilters.push(...filters);
    return this;
  }

  useWebSocketAdapter(adapter: WebSocketAdapter): this {
    this.wsAdapter = adapter;
    return this;
  }

  registerPreRequestHook(...hooks: PreRequestHook<any>[]): this {
    for (const server of this.servers) {
      if (hooks.length === 1) {
        server.setPreRequestHook(hooks[0]);
      } else if (hooks.length > 1) {
        server.setPreRequestHook(async (ctx) => {
          for (const hook of hooks) {
            await hook(ctx);
          }
        });
      }
    }
    return this;
  }

  /**
   * Registers a poison-message dead-letter handler across all transport servers
   * managed by this `MicroserviceHost` for failed `@EventPattern()` invocations.
   */
  setDeadLetterHandler(
    handler: MicroserviceDeadLetterHandler | undefined,
  ): this {
    this.deadLetterHandler = handler;
    for (const server of this.servers) {
      server.setDeadLetterHandler(handler);
    }
    return this;
  }

  useLogger(logger: LoggerService | LogLevel[] | false): this {
    this.loggerOverride = logger;
    return this;
  }

  flushLogs(): void {
    // No-op in Bunest synchronous logger pipeline
  }

  flushLogsOnOverride(): void {
    if (this.loggerOverride) {
      this.flushLogs();
    }
  }

  enableShutdownHooks(_signals?: readonly NodeJS.Signals[]): this {
    return this;
  }

  get<TInput = unknown, TResult = TInput>(
    typeOrToken: InjectionToken<TInput>,
    options?: { strict?: boolean; each?: boolean },
  ): TResult {
    if (options?.each === true) {
      return this.moduleRef.get<TInput, TResult>(typeOrToken, {
        strict: options.strict,
        each: true,
      }) as unknown as TResult;
    }
    return this.moduleRef.get<TInput, TResult>(typeOrToken, {
      strict: options?.strict,
      each: false,
    });
  }

  async resolve<TInput = unknown, TResult = TInput>(
    typeOrToken: InjectionToken<TInput>,
    contextId?: ContextId,
    options?: { strict?: boolean; each?: boolean },
  ): Promise<TResult> {
    if (options?.each === true) {
      return (await this.moduleRef.resolve<TInput, TResult>(
        typeOrToken,
        contextId,
        { strict: options.strict, each: true },
      )) as unknown as TResult;
    }
    return await this.moduleRef.resolve<TInput, TResult>(
      typeOrToken,
      contextId,
      { strict: options?.strict, each: false },
    );
  }

  select(_moduleType: Type<unknown>): this {
    return this;
  }

  selectContextModule(): void {
    // Handled by ModuleRef container in Bunest
  }

  registerRequestByContextId<T = any>(request: T, contextId: ContextId): void {
    this.moduleRef.registerRequestByContextId(request, contextId);
  }

  setIsInitialized(isInitialized: boolean): void {
    this.isInitializedFlag = isInitialized;
  }

  setIsTerminated(isTerminated: boolean): void {
    this.isTerminatedFlag = isTerminated;
  }

  setIsInitHookCalled(isInitHookCalled: boolean): void {
    this.wasInitHookCalledFlag = isInitHookCalled;
  }

  setIsConnectedToApplication(isConnectedToApplication: boolean): void {
    this.isConnectedToAppFlag = isConnectedToApplication;
  }

  createServer(server: MicroserviceTransportServer): void {
    this.addServer(server);
  }

  async registerModules(): Promise<void> {
    this.discoverAndBindHandlers();
  }

  registerListeners(): void {
    this.discoverAndBindHandlers();
  }

  on(event: string | number | symbol, callback: Function): this {
    for (const server of this.servers) {
      server.on(event, callback);
    }
    return this;
  }

  unwrap<T = unknown>(): T {
    if (this.servers.length === 1) {
      return this.servers[0]!.unwrap<T>();
    }
    return this.servers as unknown as T;
  }

  getTransportServer(): MicroserviceTransportServer | undefined {
    return this.servers[0];
  }

  async init(): Promise<this> {
    if (!this.isInitializedFlag) {
      this.discoverAndBindHandlers();
      this.isInitializedFlag = true;
      this.wasInitHookCalledFlag = true;
    }
    return this;
  }

  addServer(server: MicroserviceTransportServer): void {
    if (!this.servers.includes(server)) {
      if (this.clsService) {
        server.setClsService(this.clsService);
      }
      if (this.deadLetterHandler) {
        server.setDeadLetterHandler(this.deadLetterHandler);
      }
      this.servers.push(server);
    }
  }

  getServers(): readonly MicroserviceTransportServer[] {
    return this.servers;
  }

  async listen(): Promise<void> {
    await this.onApplicationBootstrap();
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.init();
    for (const server of this.servers) {
      if (!server.isListening) {
        await server.listen();
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }

  async close(): Promise<void> {
    this.isTerminatedFlag = true;
    for (const client of this.managedClients.splice(0)) {
      await client.close();
    }
    for (const server of this.servers) {
      await server.close();
    }
  }

  /**
   * Scans all loaded providers and controllers for `@MessagePattern` / `@EventPattern` /
   * `@GrpcMethod` / `@Client` decorators and binds them onto every registered transport server.
   */
  discoverAndBindHandlers(): void {
    if (this.discovered) {
      return;
    }
    this.discovered = true;

    const targets = collectDiscoveredTargets(this.discoveryService);
    for (const target of targets) {
      this.bindTarget(target);
    }
  }

  /**
   * Explicitly binds a single handler instance onto all registered transport servers
   * and instantiates any `@Client()` decorated properties.
   */
  bindInstance(instance: object): void {
    const ctor = (instance as { constructor?: Type<unknown> }).constructor;
    if (!ctor) return;
    this.bindTarget({
      ctor,
      instance,
      isRequestScoped: false,
      staticEnhancerCache: new Map(),
    });
  }

  private getContainer(): MicroserviceContainerLike | undefined {
    const host = (
      this.moduleRef as unknown as { host?: MicroserviceContainerLike }
    ).host;
    if (host && typeof host.resolveEnhancer === "function") {
      return host;
    }
    return undefined;
  }

  private collectDiGlobalEnhancers<T>(
    token: InjectionToken,
  ): ScopedEnhancerSpec<T>[] {
    const container = this.getContainer();
    const entries = container?.getMultiProviderEntries?.(token) ?? [];
    return this.entriesToScopedEnhancers<T>(entries);
  }

  private collectDiModuleEnhancers<T>(
    token: InjectionToken,
    moduleId: string | undefined,
  ): ScopedEnhancerSpec<T>[] {
    if (!moduleId) {
      return [];
    }
    const container = this.getContainer();
    if (!container) {
      return [];
    }
    const entries = container.getModuleMultiProviderEntries
      ? container.getModuleMultiProviderEntries(token, moduleId)
      : (container.getMultiProviderEntries?.(token) ?? []).filter(
          (entry) => (entry.module as { id?: string } | undefined)?.id === moduleId,
        );
    return this.entriesToScopedEnhancers<T>(entries);
  }

  private entriesToScopedEnhancers<T>(
    entries: ReadonlyArray<{
      module: unknown;
      provider: { useClass?: Type<unknown>; scope?: Scope };
      instance?: unknown;
      syntheticToken?: Type<unknown>;
    }>,
  ): ScopedEnhancerSpec<T>[] {
    const out: ScopedEnhancerSpec<T>[] = [];
    for (const entry of entries) {
      if (entry.syntheticToken) {
        out.push({
          spec: entry.syntheticToken as unknown as T,
          owningModule: entry.module,
        });
      } else if (entry.instance !== undefined) {
        out.push({
          spec: entry.instance as T,
          owningModule: entry.module,
        });
      } else if (entry.provider.useClass) {
        out.push({
          spec: entry.provider.useClass as unknown as T,
          owningModule: entry.module,
        });
      }
    }
    return out;
  }

  private bindTarget(target: DiscoveredRpcTarget): void {
    const { ctor, instance } = target;

    // Bind `@Client(...)` property decorators on static instances
    if (instance) {
      const clientKeys = collectMergedClassArray<string | symbol>(
        CLIENT_METADATA,
        ctor,
      );
      const seenClientKeys = new Set<string | symbol>();
      for (const key of clientKeys) {
        if (seenClientKeys.has(key)) continue;
        seenClientKeys.add(key);
        const currentVal = (instance as Record<string | symbol, unknown>)[key];
        if (currentVal !== null && currentVal !== undefined) {
          continue;
        }
        const clientOpts = MetadataRegistry.get<ClientOptions>(
          CLIENT_CONFIGURATION_METADATA,
          ctor.prototype as object,
          key,
        );
        const proxy = ClientProxyFactory.create(clientOpts as ClientOptions);
        this.managedClients.push(proxy);
        Reflect.set(instance, key, proxy);
      }
    }

    if (this.servers.length === 0) {
      return;
    }

    const messageMetas = collectMergedClassArray<PatternHandlerMetadata>(
      MESSAGE_PATTERN_METADATA,
      ctor,
    );
    const eventMetas = collectMergedClassArray<PatternHandlerMetadata>(
      EVENT_PATTERN_METADATA,
      ctor,
    );
    const grpcMetas = collectMergedClassArray<GrpcMethodMetadata>(
      GRPC_METHOD_METADATA,
      ctor,
    );

    const proto = ctor.prototype as Record<string | symbol, unknown>;

    for (const meta of [...messageMetas, ...eventMetas]) {
      const fn = instance
        ? (instance as Record<string | symbol, unknown>)[meta.methodName]
        : proto[meta.methodName];
      if (typeof fn !== "function") continue;

      const compiled: MessageHandler = this.compileHandler(
        target,
        meta.methodName,
        fn as Function,
      );
      if (meta.extras !== undefined) {
        compiled.extras = { ...meta.extras };
      }

      for (const server of this.servers) {
        if (meta.isEventHandler) {
          server.addEventHandler(meta.pattern, compiled);
        } else {
          server.addMessageHandler(meta.pattern, compiled);
        }
      }
    }

    for (const meta of grpcMetas) {
      const fn = instance
        ? (instance as Record<string | symbol, unknown>)[meta.methodName]
        : proto[meta.methodName];
      if (typeof fn !== "function") continue;

      const compiled = this.compileHandler(
        target,
        meta.methodName,
        fn as Function,
      );

      for (const server of this.servers) {
        const grpcAware = server as MicroserviceTransportServer & {
          addGrpcHandler?: (
            service: string,
            method: string,
            handler: MessageHandler,
            options?: { readonly streaming?: boolean },
          ) => void;
        };
        if (typeof grpcAware.addGrpcHandler === "function") {
          grpcAware.addGrpcHandler(meta.service, meta.method, compiled, {
            streaming: meta.streaming,
          });
        } else {
          server.addMessageHandler(`/${meta.service}/${meta.method}`, compiled);
        }
      }
    }
  }

  private compileHandler(
    target: DiscoveredRpcTarget,
    methodName: string | symbol,
    handlerFn: Function,
  ): (data: unknown, ctx: RpcContext) => Promise<unknown> {
    const targetClass = target.ctor;
    const container = this.getContainer();
    const targetModule =
      target.moduleId && container?.getModuleByKey
        ? container.getModuleByKey(target.moduleId)
        : undefined;

    const classGuards = MetadataRegistry.getMergedClassArray<GuardLike>(
      METADATA_KEYS.GUARDS,
      targetClass,
    );
    const methodGuards =
      MetadataRegistry.get<readonly GuardLike[]>(
        METADATA_KEYS.GUARDS,
        handlerFn,
      ) ?? [];
    const localGuards: ScopedEnhancerSpec<GuardLike>[] = [
      ...classGuards,
      ...methodGuards,
    ].map((spec) => ({ spec, owningModule: targetModule }));

    const classPipes = MetadataRegistry.getMergedClassArray<PipeLike>(
      METADATA_KEYS.PIPES,
      targetClass,
    );
    const methodPipes =
      MetadataRegistry.get<readonly PipeLike[]>(
        METADATA_KEYS.PIPES,
        handlerFn,
      ) ?? [];
    const localPipes: ScopedEnhancerSpec<PipeLike>[] = [
      ...classPipes,
      ...methodPipes,
    ].map((spec) => ({ spec, owningModule: targetModule }));

    const classInterceptors =
      MetadataRegistry.getMergedClassArray<InterceptorLike>(
        METADATA_KEYS.INTERCEPTORS,
        targetClass,
      );
    const methodInterceptors =
      MetadataRegistry.get<readonly InterceptorLike[]>(
        METADATA_KEYS.INTERCEPTORS,
        handlerFn,
      ) ?? [];
    const localInterceptors: ScopedEnhancerSpec<InterceptorLike>[] = [
      ...classInterceptors,
      ...methodInterceptors,
    ].map((spec) => ({ spec, owningModule: targetModule }));

    const classFilters =
      MetadataRegistry.getMergedClassArray<ExceptionFilterLike>(
        METADATA_KEYS.EXCEPTION_FILTERS,
        targetClass,
      );
    const methodFilters =
      MetadataRegistry.get<readonly ExceptionFilterLike[]>(
        METADATA_KEYS.EXCEPTION_FILTERS,
        handlerFn,
      ) ?? [];
    // Method filters take precedence over class filters
    const localFilters: ScopedEnhancerSpec<ExceptionFilterLike>[] = [
      ...methodFilters,
      ...classFilters,
    ].map((spec) => ({ spec, owningModule: targetModule }));

    const paramMetas =
      MetadataRegistry.get<readonly RpcParamMetadata[]>(
        RPC_PARAM_METADATA,
        targetClass.prototype as object,
        methodName,
      ) ?? [];
    const customParamMetas = (
      MetadataRegistry.get<readonly ParameterMetadata[]>(
        METADATA_KEYS.ROUTE_PARAMS,
        targetClass.prototype as object,
        methodName,
      ) ?? []
    ).filter(
      (p) => p.source === "custom" && typeof p.factory === "function",
    );
    const paramTypes =
      MetadataRegistry.getParamTypes(
        targetClass.prototype as object,
        methodName,
      ) ?? [];

    return async (data: unknown, rpcCtx: RpcContext): Promise<unknown> => {
      const execCtx = new RpcExecutionContext(
        targetClass,
        handlerFn,
        methodName,
        data,
        rpcCtx,
      );
      const rpcRequest = {
        data,
        context: rpcCtx,
        pattern: rpcCtx.pattern,
        getData: () => data,
        getContext: () => rpcCtx,
        getPattern: () => rpcCtx.pattern,
      };
      const activeContainer = this.getContainer();
      const reqContainer = activeContainer?.createRequestContainer(
        rpcRequest as unknown as Request,
      );

      try {
        // 1. Guards (DI global -> imperative global -> module -> class -> method)
        const allGuards: ScopedEnhancerSpec<GuardLike>[] = [
          ...this.collectDiGlobalEnhancers<GuardLike>(APP_GUARD),
          ...this.globalGuards.map((spec) => ({ spec })),
          ...this.collectDiModuleEnhancers<GuardLike>(
            MODULE_GUARD,
            target.moduleId,
          ),
          ...localGuards,
        ];
        for (const guardEntry of allGuards) {
          const guard = await this.resolveEnhancer<CanActivate>(
            guardEntry.spec,
            reqContainer,
            guardEntry.owningModule,
            "guard",
            target,
          );
          const allowed = await guard.canActivate(execCtx);
          if (!allowed) {
            throw new RpcException({
              status: 403,
              message: "Forbidden resource",
            });
          }
        }

        // Resolve controller/provider instance (for Scope.REQUEST, resolve per message)
        let activeInstance: object;
        if (!target.isRequestScoped && target.instance) {
          activeInstance = target.instance;
        } else if (activeContainer) {
          const modId =
            target.moduleId ?? activeContainer.getGraph?.().root.id ?? "";
          activeInstance = (await activeContainer.resolveAsync(
            targetClass,
            modId,
            reqContainer,
            { strict: false },
          )) as object;
        } else {
          activeInstance = (await this.moduleRef.resolve(
            targetClass,
            undefined,
            { strict: false },
          )) as object;
        }

        // 2. Interceptors + Parameter resolution + Pipes + Handler invocation
        const allPipes: ScopedEnhancerSpec<PipeLike>[] = [
          ...this.collectDiGlobalEnhancers<PipeLike>(APP_PIPE),
          ...this.globalPipes.map((spec) => ({ spec })),
          ...this.collectDiModuleEnhancers<PipeLike>(
            MODULE_PIPE,
            target.moduleId,
          ),
          ...localPipes,
        ];
        const invokeCore = async (): Promise<unknown> => {
          const args = await this.resolveArgs(
            data,
            rpcCtx,
            execCtx,
            paramMetas,
            customParamMetas,
            paramTypes,
            allPipes,
            reqContainer,
            targetModule,
            target,
          );
          const boundFn =
            (activeInstance as Record<string | symbol, unknown>)[methodName];
          const fnToCall =
            typeof boundFn === "function" ? (boundFn as Function) : handlerFn;
          return await fnToCall.apply(activeInstance, args);
        };

        const allInterceptors: ScopedEnhancerSpec<InterceptorLike>[] = [
          ...this.collectDiGlobalEnhancers<InterceptorLike>(APP_INTERCEPTOR),
          ...this.globalInterceptors.map((spec) => ({ spec })),
          ...this.collectDiModuleEnhancers<InterceptorLike>(
            MODULE_INTERCEPTOR,
            target.moduleId,
          ),
          ...localInterceptors,
        ];
        let nextFn: () => Promise<unknown> = invokeCore;
        for (let i = allInterceptors.length - 1; i >= 0; i--) {
          const interceptorEntry = allInterceptors[i]!;
          const downstream = nextFn;
          nextFn = async () => {
            const interceptor = await this.resolveEnhancer<BunestInterceptor>(
              interceptorEntry.spec,
              reqContainer,
              interceptorEntry.owningModule,
              "interceptor",
              target,
            );
            return await interceptor.intercept(execCtx, {
              handle: downstream,
            });
          };
        }

        return await nextFn();
      } catch (err) {
        const allFilters: ScopedEnhancerSpec<ExceptionFilterLike>[] = [
          ...localFilters,
          ...this.collectDiModuleEnhancers<ExceptionFilterLike>(
            MODULE_FILTER,
            target.moduleId,
          ),
          ...this.globalFilters.map((spec) => ({ spec })),
          ...this.collectDiGlobalEnhancers<ExceptionFilterLike>(APP_FILTER),
        ];
        if (allFilters.length > 0) {
          for (const filterEntry of allFilters) {
            if (!this.filterMatches(filterEntry.spec, err)) {
              continue;
            }
            let filter: ExceptionFilter;
            try {
              filter = await this.resolveEnhancer<ExceptionFilter>(
                filterEntry.spec,
                reqContainer,
                filterEntry.owningModule,
                "filter",
                target,
              );
            } catch {
              // If the exception filter itself fails to resolve (e.g. depends on
              // the same failing request-scoped provider), skip it and let the
              // next filter or default RPC filter handle the original error.
              continue;
            }
            return await filter.catch(err, execCtx);
          }
        }
        throw err;
      } finally {
        await reqContainer?.destroy();
      }
    };
  }

  private async resolveArgs(
    data: unknown,
    rpcCtx: RpcContext,
    execCtx: RpcExecutionContext,
    paramMetas: readonly RpcParamMetadata[],
    customParamMetas: readonly ParameterMetadata[],
    paramTypes: readonly unknown[],
    sharedPipes: readonly ScopedEnhancerSpec<PipeLike>[],
    reqContainer: RequestContainer | undefined,
    targetModule: unknown,
    target: DiscoveredRpcTarget,
  ): Promise<unknown[]> {
    if (paramMetas.length === 0 && customParamMetas.length === 0) {
      let transformed = data;
      const meta: ArgumentMetadata = {
        type: "custom",
        metatype:
          typeof paramTypes[0] === "function"
            ? (paramTypes[0] as Type<unknown>)
            : undefined,
      };
      for (const pipeEntry of sharedPipes) {
        const pipe = await this.resolveEnhancer<PipeTransform>(
          pipeEntry.spec,
          reqContainer,
          pipeEntry.owningModule,
          "pipe",
          target,
        );
        transformed = await pipe.transform(transformed, meta);
      }
      return [transformed, rpcCtx];
    }

    const maxIndex = Math.max(
      ...paramMetas.map((p) => p.index),
      ...customParamMetas.map((p) => p.index),
    );
    const args: unknown[] = new Array(maxIndex + 1).fill(undefined);

    for (const param of paramMetas) {
      if (param.kind === "ctx") {
        args[param.index] = rpcCtx;
        continue;
      }

      let value: unknown =
        param.property !== undefined
          ? data !== null && typeof data === "object"
            ? (data as Record<string, unknown>)[param.property]
            : undefined
          : data;

      const argMeta: ArgumentMetadata = {
        type: "custom",
        metatype:
          typeof paramTypes[param.index] === "function"
            ? (paramTypes[param.index] as Type<unknown>)
            : undefined,
        data: param.property,
      };

      const pipes: ScopedEnhancerSpec<PipeLike>[] = [
        ...sharedPipes,
        ...(param.pipes ?? []).map((spec) => ({
          spec,
          owningModule: targetModule,
        })),
      ];
      for (const pipeEntry of pipes) {
        const pipe = await this.resolveEnhancer<PipeTransform>(
          pipeEntry.spec,
          reqContainer,
          pipeEntry.owningModule,
          "pipe",
          target,
        );
        value = await pipe.transform(value, argMeta);
      }
      args[param.index] = value;
    }

    for (const customParam of customParamMetas) {
      let value: unknown = await customParam.factory!(
        customParam.data,
        execCtx,
      );

      const argMeta: ArgumentMetadata = {
        type: "custom",
        metatype:
          typeof paramTypes[customParam.index] === "function"
            ? (paramTypes[customParam.index] as Type<unknown>)
            : undefined,
        data: customParam.key,
      };

      const pipes: ScopedEnhancerSpec<PipeLike>[] = [
        ...sharedPipes,
        ...(customParam.pipes ?? []).map((spec) => ({
          spec,
          owningModule: targetModule,
        })),
      ];
      for (const pipeEntry of pipes) {
        const pipe = await this.resolveEnhancer<PipeTransform>(
          pipeEntry.spec,
          reqContainer,
          pipeEntry.owningModule,
          "pipe",
          target,
        );
        value = await pipe.transform(value, argMeta);
      }
      args[customParam.index] = value;
    }

    return args;
  }

  private filterMatches(
    filterLike: ExceptionFilterLike,
    exception: unknown,
  ): boolean {
    const ctor =
      typeof filterLike === "function"
        ? filterLike
        : (filterLike as { constructor?: Function }).constructor;
    if (!ctor) return true;

    const catchTypes = MetadataRegistry.get<readonly Type<unknown>[]>(
      METADATA_KEYS.CATCH_EXCEPTIONS,
      ctor,
    );
    if (!catchTypes || catchTypes.length === 0) {
      return true;
    }
    return catchTypes.some(
      (exceptionType) => exception instanceof exceptionType,
    );
  }

  private async resolveEnhancer<T>(
    enhancer: Type<T> | T,
    reqContainer?: RequestContainer,
    owningModule?: unknown,
    kind?: RpcEnhancerKind,
    target?: DiscoveredRpcTarget,
  ): Promise<T> {
    if (typeof enhancer !== "function") {
      return enhancer;
    }
    const cls = enhancer as Type<T>;
    const container = this.getContainer();
    if (container) {
      const isReqScoped =
        container.requiresEnhancerRequestScope?.(cls, kind, target?.ctor) ??
        getInjectableScope(cls) === Scope.REQUEST;
      const useStaticTargetCache =
        target !== undefined && !target.isRequestScoped && !isReqScoped;

      if (useStaticTargetCache && target.staticEnhancerCache.has(cls)) {
        return target.staticEnhancerCache.get(cls) as T;
      }

      const resolved = await container.resolveEnhancer<T>(
        cls,
        reqContainer,
        owningModule,
        kind,
      );

      if (useStaticTargetCache) {
        target.staticEnhancerCache.set(cls, resolved);
      }
      return resolved;
    }

    try {
      return this.moduleRef.get(cls, { strict: false });
    } catch {
      return await this.moduleRef.create(cls);
    }
  }
}

export { MicroserviceHost as NestMicroservice };
