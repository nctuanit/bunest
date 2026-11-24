import {
  Inject,
  Injectable,
  METADATA_KEYS,
  MetadataRegistry,
  Optional,
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
  type PipeLike,
  type PipeTransform,
  type PreRequestHook,
  type Type,
  type WebSocketAdapter,
} from "@bunest/core";
import { DiscoveryService, MetadataScanner, ModuleRef } from "@bunest/core";
import type { ClientProxy } from "./client-proxy";
import { ClientProxyFactory } from "./client-proxy-factory";
import { RpcException } from "./exceptions";
import type {
  ClientOptions,
  GrpcMethodMetadata,
  MessageHandler,
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

function collectLoadedInstances(
  discoveryService: DiscoveryService | undefined,
): object[] {
  if (!discoveryService) {
    return [];
  }
  const seen = new Set<object>();
  const instances: object[] = [];
  for (const wrapper of [
    ...discoveryService.getControllers(),
    ...discoveryService.getProviders(),
  ]) {
    const instance = wrapper.instance;
    if (instance && typeof instance === "object" && !seen.has(instance)) {
      seen.add(instance);
      instances.push(instance);
    }
  }
  return instances;
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

  constructor(
    private readonly moduleRef: ModuleRef,
    @Optional()
    @Inject(MICROSERVICE_SERVER)
    primaryServer?: MicroserviceTransportServer,
    @Optional()
    private readonly discoveryService?: DiscoveryService,
    @Optional()
    private readonly metadataScanner?: MetadataScanner,
  ) {
    if (primaryServer) {
      this.servers.push(primaryServer);
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

    const instances = collectLoadedInstances(this.discoveryService);
    for (const instance of instances) {
      this.bindInstance(instance);
    }
  }

  /**
   * Explicitly binds a single handler instance onto all registered transport servers
   * and instantiates any `@Client()` decorated properties.
   */
  bindInstance(instance: object): void {
    const ctor = (instance as { constructor?: Type<unknown> }).constructor;
    if (!ctor) return;

    // Bind `@Client(...)` property decorators
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

    for (const meta of [...messageMetas, ...eventMetas]) {
      const fn = (instance as Record<string | symbol, unknown>)[
        meta.methodName
      ];
      if (typeof fn !== "function") continue;

      const compiled = this.compileHandler(
        ctor,
        instance,
        meta.methodName,
        fn as Function,
      );

      for (const server of this.servers) {
        if (meta.isEventHandler) {
          server.addEventHandler(meta.pattern, compiled);
        } else {
          server.addMessageHandler(meta.pattern, compiled);
        }
      }
    }

    for (const meta of grpcMetas) {
      const fn = (instance as Record<string | symbol, unknown>)[
        meta.methodName
      ];
      if (typeof fn !== "function") continue;

      const compiled = this.compileHandler(
        ctor,
        instance,
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
    targetClass: Type<unknown>,
    instance: object,
    methodName: string | symbol,
    handlerFn: Function,
  ): (data: unknown, ctx: RpcContext) => Promise<unknown> {
    const classGuards = MetadataRegistry.getMergedClassArray<GuardLike>(
      METADATA_KEYS.GUARDS,
      targetClass,
    );
    const methodGuards =
      MetadataRegistry.get<readonly GuardLike[]>(
        METADATA_KEYS.GUARDS,
        handlerFn,
      ) ?? [];
    const guards = [...classGuards, ...methodGuards];

    const classPipes = MetadataRegistry.getMergedClassArray<PipeLike>(
      METADATA_KEYS.PIPES,
      targetClass,
    );
    const methodPipes =
      MetadataRegistry.get<readonly PipeLike[]>(
        METADATA_KEYS.PIPES,
        handlerFn,
      ) ?? [];
    const sharedPipes = [...classPipes, ...methodPipes];

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
    const interceptors = [...classInterceptors, ...methodInterceptors];

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
    const filters = [...methodFilters, ...classFilters];

    const paramMetas =
      MetadataRegistry.get<readonly RpcParamMetadata[]>(
        RPC_PARAM_METADATA,
        targetClass.prototype as object,
        methodName,
      ) ?? [];
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

      try {
        // 1. Guards (global -> class -> method)
        const allGuards =
          this.globalGuards.length > 0
            ? [...this.globalGuards, ...guards]
            : guards;
        for (const guardLike of allGuards) {
          const guard = await this.resolveEnhancer<CanActivate>(guardLike);
          const allowed = await guard.canActivate(execCtx);
          if (!allowed) {
            throw new RpcException({
              status: 403,
              message: "Forbidden resource",
            });
          }
        }

        // 2. Interceptors + Parameter resolution + Pipes + Handler invocation
        const allPipes =
          this.globalPipes.length > 0
            ? [...this.globalPipes, ...sharedPipes]
            : sharedPipes;
        const invokeCore = async (): Promise<unknown> => {
          const args = await this.resolveArgs(
            data,
            rpcCtx,
            paramMetas,
            paramTypes,
            allPipes,
          );
          return await handlerFn.apply(instance, args);
        };

        const allInterceptors =
          this.globalInterceptors.length > 0
            ? [...this.globalInterceptors, ...interceptors]
            : interceptors;
        let nextFn: () => Promise<unknown> = invokeCore;
        for (let i = allInterceptors.length - 1; i >= 0; i--) {
          const interceptorLike = allInterceptors[i]!;
          const downstream = nextFn;
          nextFn = async () => {
            const interceptor =
              await this.resolveEnhancer<BunestInterceptor>(interceptorLike);
            return await interceptor.intercept(execCtx, {
              handle: downstream,
            });
          };
        }

        return await nextFn();
      } catch (err) {
        const allFilters =
          this.globalFilters.length > 0
            ? [...filters, ...this.globalFilters]
            : filters;
        if (allFilters.length > 0) {
          for (const filterLike of allFilters) {
            if (!this.filterMatches(filterLike, err)) {
              continue;
            }
            const filter =
              await this.resolveEnhancer<ExceptionFilter>(filterLike);
            return await filter.catch(err, execCtx);
          }
        }
        throw err;
      }
    };
  }

  private async resolveArgs(
    data: unknown,
    rpcCtx: RpcContext,
    paramMetas: readonly RpcParamMetadata[],
    paramTypes: readonly unknown[],
    sharedPipes: readonly PipeLike[],
  ): Promise<unknown[]> {
    if (paramMetas.length === 0) {
      let transformed = data;
      const meta: ArgumentMetadata = {
        type: "custom",
        metatype:
          typeof paramTypes[0] === "function"
            ? (paramTypes[0] as Type<unknown>)
            : undefined,
      };
      for (const pipeLike of sharedPipes) {
        const pipe = await this.resolveEnhancer<PipeTransform>(pipeLike);
        transformed = await pipe.transform(transformed, meta);
      }
      return [transformed, rpcCtx];
    }

    const maxIndex = Math.max(...paramMetas.map((p) => p.index));
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

      const pipes = [...sharedPipes, ...(param.pipes ?? [])];
      for (const pipeLike of pipes) {
        const pipe = await this.resolveEnhancer<PipeTransform>(pipeLike);
        value = await pipe.transform(value, argMeta);
      }
      args[param.index] = value;
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

  private async resolveEnhancer<T>(enhancer: Type<T> | T): Promise<T> {
    if (typeof enhancer !== "function") {
      return enhancer;
    }
    const cls = enhancer as Type<T>;
    try {
      return this.moduleRef.get(cls, { strict: false });
    } catch {
      return await this.moduleRef.create(cls);
    }
  }
}

export { MicroserviceHost as NestMicroservice };
