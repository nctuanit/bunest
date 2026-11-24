import {
  APP_GUARD,
  APP_INTERCEPTOR,
  APP_PIPE,
  type ArgumentMetadata,
  type BunestInterceptor,
  type CallHandler,
  type CanActivate,
  type ContextId,
  type ExceptionFilter,
  type ExceptionFilterLike,
  type GuardLike,
  HttpException,
  type INestApplicationContext,
  type InterceptorLike,
  Logger,
  type LoggerService,
  METADATA_KEYS,
  MetadataRegistry,
  type PipeLike,
  type PipeTransform,
  type Type,
  type WsMessageHandler,
} from "../../common/index";
import { ContextIdFactory } from "../../di/context-id.factory";
import type { DIContainer } from "../../di/di-container";
import type { RequestContainer } from "../../di/request-container";
import {
  type BunHttpAdapter,
  type BunServerLike,
  evaluateCors,
  extractFilterCatchTypes,
  type ListeningServerInfo,
  type ListenOptions,
  normalizeCorsOptions,
  type NormalizedCorsOptions,
  normalizePath,
} from "../../http/index";
import {
  buildGatewayAllTopic,
  BunWsClientImpl,
  BunWsServerImpl,
  type BunWsSocketData,
  parseWsFrame,
} from "../client/bun-ws-client";
import { WS_METADATA_KEYS } from "../constants";
import { WsExecutionContext } from "../context/ws-execution-context";
import {
  getGatewayMessageHandlers,
  getGatewayMethodParams,
  getGatewayServerProperties,
} from "../decorators/ws.decorators";
import { WsException } from "../exceptions/ws.exception";
import { BaseWsExceptionFilter } from "../filters/base-ws-exception.filter";
import type {
  BunServerWebSocketLike,
  MessageMappingProperties,
  OnGatewayAuthenticate,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  WebSocketGatewayOptions,
  WebSocketModuleOptions,
  WsAdapterOptions,
  WsAuthenticateFn,
  WsData,
  WsMessageParser,
  WsParamMetadata,
  WsResponse,
} from "../interfaces/ws.interface";
import { AbstractWsAdapter, type BaseWsInstance } from "./abstract-ws.adapter";

interface CompiledWsFilter {
  readonly filter: ExceptionFilter;
  readonly catchTypes: readonly Type<unknown>[];
}

interface CompiledWsHandler {
  readonly event: string;
  readonly handlerKey: string | symbol;
  readonly handlerFn: Function;
  readonly params: readonly WsParamMetadata[];
  readonly argCount: number;
  readonly guards: readonly CanActivate[];
  readonly interceptors: readonly BunestInterceptor[];
  readonly sharedPipes: readonly PipeTransform[];
  readonly paramPipes: readonly (readonly PipeTransform[])[];
  readonly filters: readonly CompiledWsFilter[];
  readonly guardLikes: readonly GuardLike[];
  readonly interceptorLikes: readonly InterceptorLike[];
  readonly sharedPipeLikes: readonly PipeLike[];
  readonly paramPipeLikes: readonly (readonly PipeLike[])[];
  readonly filterLikes: readonly ExceptionFilterLike[];
}

interface RegisteredGateway {
  readonly id: string;
  readonly path: string;
  readonly namespace: string;
  readonly gatewayClass: Type<unknown>;
  readonly instance?: object;
  readonly isRequestScoped: boolean;
  readonly moduleId?: string;
  readonly options: WebSocketGatewayOptions;
  readonly cors?: NormalizedCorsOptions;
  readonly server: BunWsServerImpl;
  readonly handlers: Map<string, CompiledWsHandler>;
  readonly wildcardHandler?: CompiledWsHandler;
  readonly binaryHandler?: CompiledWsHandler;
  readonly gatewayFilterLikes: readonly ExceptionFilterLike[];
}

interface GatewayConnectionLifecycle {
  connectionDone: boolean;
  disconnected: boolean;
  resolvePromise?: Promise<void>;
}

interface WsConnectionState {
  readonly contextId?: ContextId;
  readonly requestContainer?: RequestContainer;
  readonly enhancerCache: Map<unknown, unknown>;
  readonly gatewayInstances: Map<string, object>;
  readonly gatewayLifecycles: Map<string, GatewayConnectionLifecycle>;
  readonly disconnectPromises: Promise<void>[];
  openSyncLoopDone: boolean;
  pendingClose?: { readonly code: number; readonly reason: string };
}

export type EnhancerResolverFn = <T = unknown>(
  enhancer: Type<T> | T,
) => T | Promise<T>;

function defaultEnhancerResolver<T = unknown>(enhancer: Type<T> | T): T {
  if (typeof enhancer === "function") {
    return new (enhancer as Type<T>)();
  }
  return enhancer;
}

function isWsResponse(value: unknown): value is WsResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const rec = value as Record<string, unknown>;
  if (typeof rec.event !== "string" || !("data" in rec)) {
    return false;
  }
  const keys = Object.keys(rec);
  return keys.every((k) => k === "event" || k === "data" || k === "id");
}

function hasGatewayInit(value: object): value is OnGatewayInit {
  return typeof (value as Partial<OnGatewayInit>).afterInit === "function";
}

function hasGatewayConnection(value: object): value is OnGatewayConnection {
  return (
    typeof (value as Partial<OnGatewayConnection>).handleConnection ===
    "function"
  );
}

function hasGatewayDisconnect(value: object): value is OnGatewayDisconnect {
  return (
    typeof (value as Partial<OnGatewayDisconnect>).handleDisconnect ===
    "function"
  );
}

function hasGatewayAuthenticate(value: object): value is OnGatewayAuthenticate {
  return (
    typeof (value as Partial<OnGatewayAuthenticate>).authenticate === "function"
  );
}

function matchesExceptionFilter(
  error: unknown,
  catchTypes: readonly Type<unknown>[],
): boolean {
  if (catchTypes.length === 0) {
    return true;
  }
  return catchTypes.some(
    (ctor) => typeof ctor === "function" && error instanceof ctor,
  );
}

function defaultWsMessageParser(
  data: WsData,
): { event: string; data?: unknown; id?: string } | void {
  const text =
    typeof data === "string"
      ? data
      : Array.isArray(data)
        ? Buffer.concat(data).toString("utf8")
        : data instanceof ArrayBuffer
          ? new TextDecoder().decode(new Uint8Array(data))
          : Buffer.from(data).toString("utf8");
  const frame = parseWsFrame(text);
  if (!frame) return undefined;
  return { event: frame.event, data: frame.data, id: frame.id };
}

function isBunHttpAdapterLike(value: unknown): value is BunHttpAdapter {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Partial<BunHttpAdapter>).registerWebsocketHandler ===
      "function"
  );
}

/**
 * Native Bun.serve WebSocket adapter multiplexing one or more `@WebSocketGateway()`
 * instances over Bun's native `Bun.serve({ websocket })` + `server.upgrade()` + pub/sub.
 */
export class BunWebSocketAdapter extends AbstractWsAdapter {
  private readonly gatewaysById = new Map<string, RegisteredGateway>();
  private readonly gatewaysByPath = new Map<string, RegisteredGateway>();
  private readonly gatewayGroupsByPath = new Map<string, RegisteredGateway[]>();
  private readonly registeredInstances = new WeakSet<object>();
  private readonly registeredClasses = new WeakSet<Function>();
  private readonly connectionStates = new WeakMap<
    BunWsClientImpl,
    WsConnectionState
  >();
  private container?: DIContainer;
  private globalGuardLikes: GuardLike[] = [];
  private globalPipeLikes: PipeLike[] = [];
  private globalInterceptorLikes: InterceptorLike[] = [];
  private readonly defaultFilter: BaseWsExceptionFilter;
  protected readonly logger: LoggerService;
  private readonly moduleOptions: WebSocketModuleOptions;
  protected messageParser: WsMessageParser;
  protected readonly maxConcurrentMessages: number;
  protected readonly maxSendBufferSize: number;
  protected readonly unclaimedUpgradeTimeout: number;
  protected readonly maxPayload: number;
  private readonly activeHandlersPerClient = new WeakMap<object, number>();
  private readonly pendingQueuesPerClient = new WeakMap<
    object,
    Array<() => Promise<void>>
  >();
  private readonly createdServers = new Set<BunWsServerImpl>();
  private readonly resolveEnhancer: EnhancerResolverFn;

  private httpAdapter?: BunHttpAdapter;
  private activeBunServer?: BunServerLike;
  private standaloneServer?: BunServerLike;
  private gatewayCounter = 0;

  constructor(
    options: WebSocketModuleOptions = {},
    resolveEnhancer: EnhancerResolverFn = defaultEnhancerResolver,
    logger?: LoggerService,
    appOrHttpServer?: INestApplicationContext | object,
  ) {
    super(appOrHttpServer ?? options.httpAdapter);
    this.moduleOptions = options;
    this.resolveEnhancer = resolveEnhancer;
    this.logger = logger ?? new Logger("BunWebSocketAdapter");
    this.defaultFilter = new BaseWsExceptionFilter(this.logger);
    this.messageParser = options.messageParser ?? defaultWsMessageParser;
    this.maxConcurrentMessages = options.maxConcurrentMessages ?? 1000;
    this.maxSendBufferSize = options.maxSendBufferSize ?? 128 * 1024 * 1024;
    this.unclaimedUpgradeTimeout = options.unclaimedUpgradeTimeout ?? 1000;
    this.maxPayload =
      options.maxPayload ?? options.maxPayloadLength ?? 1024 * 1024;

    if (options.httpAdapter) {
      this.httpAdapter = options.httpAdapter;
    }
  }

  /**
   * Standard NestJS `WebSocketAdapter.create()` hook.
   * When `options?.server` is provided, returns it; otherwise creates a Bun-native
   * `BunWsServerImpl` (or returns `this` when called with no path/options for legacy compatibility).
   */
  override create(
    port: number,
    options?: Record<string, unknown> & WebSocketGatewayOptions,
  ): unknown {
    if (options?.server) {
      return options.server;
    }
    if (
      options?.namespace !== undefined &&
      typeof options.namespace === "string" &&
      options.namespace.length > 0 &&
      !options.path
    ) {
      // Allow namespace lookup cleanly
    }
    if (port === 0 && !options) {
      return this;
    }
    const path = normalizePath(options?.path ?? "/ws");
    const namespace =
      typeof options?.namespace === "string"
        ? options.namespace
        : options?.namespace instanceof RegExp
          ? options.namespace.source
          : path;
    const existing = this.gatewaysByPath.get(path);
    if (existing) {
      return existing.server;
    }
    const server = new BunWsServerImpl(
      `ws_${++this.gatewayCounter}`,
      path,
      namespace,
      () =>
        this.activeBunServer ??
        this.httpAdapter?.getServer() ??
        this.standaloneServer,
    );
    this.createdServers.add(server);
    return server;
  }

  /**
   * Creates a non-listening WebSocket server handle (e.g. for standalone microservices
   * without an HTTP server, matching NestJS v12 `WsAdapter.createWithoutListener`).
   */
  override createWithoutListener(
    options?: Record<string, unknown> & WebSocketGatewayOptions,
  ): unknown {
    if (options?.server) {
      return options.server;
    }
    const path = normalizePath(options?.path ?? "/ws");
    const namespace =
      typeof options?.namespace === "string"
        ? options.namespace
        : options?.namespace instanceof RegExp
          ? options.namespace.source
          : path;
    const server = new BunWsServerImpl(
      `ws_nolisten_${++this.gatewayCounter}`,
      path,
      namespace,
      () => undefined,
    );
    this.createdServers.add(server);
    return server;
  }

  override bindClientConnect(server: unknown, callback: Function): void {
    const target = server as { on?: (event: string, cb: Function) => void };
    if (target && typeof target.on === "function") {
      target.on("connection", callback);
    }
  }

  override bindClientDisconnect(client: unknown, callback: Function): void {
    const target = client as { on?: (event: string, cb: Function) => void };
    if (target && typeof target.on === "function") {
      target.on("close", callback);
    }
  }

  override closeClient(client: unknown): void {
    const target = client as { close?: () => void };
    if (target && typeof target.close === "function") {
      target.close();
    }
  }

  bindErrorHandler<T>(server: T): T {
    const target = server as { on?: (event: string, cb: (err: unknown) => void) => void };
    if (target && typeof target.on === "function") {
      target.on("error", (err: unknown) => {
        this.logger.error(
          err instanceof Error ? err.message : String(err),
          err instanceof Error ? err.stack : undefined,
        );
      });
    }
    return server;
  }

  override bindMessageHandlers(
    client: unknown,
    handlers: Array<MessageMappingProperties | WsMessageHandler>,
    transform: (data: unknown) => unknown = (data) => data,
  ): void {
    const target = client as {
      on?: (event: string, cb: (buffer: unknown) => void) => void;
      send?: (payload: string) => void;
    };
    if (!target || typeof target.on !== "function") {
      return;
    }
    const handlersMap = new Map<string, MessageMappingProperties>();
    for (const h of handlers) {
      const key = String(h.message);
      handlersMap.set(key, {
        message: h.message,
        methodName: "methodName" in h ? h.methodName : key,
        callback: h.callback,
        isAckHandledManually: Boolean(h.isAckHandledManually),
      });
    }

    target.on("message", (buffer: unknown) => {
      void this.bindMessageHandler(buffer, handlersMap, transform)
        .then((response) => {
          if (response === undefined || response === null) {
            return;
          }
          if (!this.ensureSendBufferWithinLimit(client)) {
            return;
          }
          if (typeof target.send === "function") {
            const payload =
              typeof response === "string"
                ? response
                : JSON.stringify(response);
            target.send(payload);
          }
        })
        .catch((err) => {
          this.logger.error(
            err instanceof Error ? err.message : String(err),
            err instanceof Error ? err.stack : undefined,
          );
        });
    });
  }

  async bindMessageHandler(
    buffer: unknown,
    handlersMap: Map<string, MessageMappingProperties>,
    transform: (data: unknown) => unknown = (data) => data,
  ): Promise<unknown> {
    try {
      const rawData: WsData =
        buffer &&
        typeof buffer === "object" &&
        "data" in buffer &&
        !(buffer instanceof Uint8Array) &&
        !(buffer instanceof ArrayBuffer)
          ? (buffer as { data: WsData }).data
          : (buffer as WsData);
      const parsed = this.messageParser(rawData);
      if (!parsed || typeof parsed.event !== "string") {
        return undefined;
      }
      const handler = handlersMap.get(parsed.event);
      if (!handler) {
        return undefined;
      }
      const result = await handler.callback(parsed.data, parsed.event);
      return await Promise.resolve(transform(result));
    } catch {
      return undefined;
    }
  }

  protected ensureSendBufferWithinLimit(client: unknown): boolean {
    if (!this.maxSendBufferSize || this.maxSendBufferSize <= 0) {
      return true;
    }
    const candidate = client as
      | {
          bufferedAmount?: unknown;
          raw?: { getBufferedAmount?: () => number };
        }
      | null
      | undefined;
    const buffered =
      typeof candidate?.bufferedAmount === "number"
        ? candidate.bufferedAmount
        : typeof candidate?.raw?.getBufferedAmount === "function"
          ? candidate.raw.getBufferedAmount()
          : 0;
    if (buffered > this.maxSendBufferSize) {
      this.closeClient(client);
      return false;
    }
    return true;
  }

  setMessageParser(parser: WsMessageParser): void {
    this.messageParser = parser;
  }

  override async close(server?: unknown): Promise<void> {
    if (!server || server === this) {
      await this.closeAll();
      return;
    }
    if (server instanceof BunWsServerImpl) {
      server.disconnectAll(1001, "Server shutting down");
      this.createdServers.delete(server);
      return;
    }
    await super.close(server as BaseWsInstance);
  }

  override async dispose(): Promise<void> {
    for (const srv of this.createdServers) {
      srv.disconnectAll(1001, "Server shutting down");
    }
    this.createdServers.clear();
    await this.closeAll();
  }

  /**
   * Attaches the DI container so global `APP_GUARD`, `APP_PIPE`, `APP_INTERCEPTOR`
   * multi-providers and `Scope.REQUEST` gateways/enhancers can be resolved per connection.
   */
  setContainer(container: DIContainer): void {
    this.container = container;
    const collect = <T>(token: symbol): T[] => {
      const items: T[] = [];
      for (const entry of container.getMultiProviderEntries(token)) {
        if (entry.syntheticToken) {
          items.push(entry.syntheticToken as unknown as T);
        } else if (entry.instance !== undefined) {
          items.push(entry.instance as T);
        } else if (entry.provider.useClass) {
          container.registerEnhancerOwner(
            entry.provider.useClass,
            entry.module,
          );
          items.push(entry.provider.useClass as unknown as T);
        }
      }
      return items;
    };
    this.globalGuardLikes = collect<GuardLike>(APP_GUARD);
    this.globalPipeLikes = collect<PipeLike>(APP_PIPE);
    this.globalInterceptorLikes = collect<InterceptorLike>(APP_INTERCEPTOR);
  }

  /**
   * Attaches this WebSocket adapter to a `BunHttpAdapter` and registers
   * all already-discovered gateways onto it.
   */
  attachToHttpAdapter(httpAdapter: BunHttpAdapter): this {
    this.httpAdapter = httpAdapter;
    for (const gateway of this.gatewaysByPath.values()) {
      this.bindGatewayToHttpAdapter(httpAdapter, gateway);
    }
    return this;
  }

  getGateways(): ReadonlyArray<{
    readonly path: string;
    readonly namespace: string;
    readonly server: BunWsServerImpl;
  }> {
    return [...this.gatewaysById.values()].map((g) => ({
      path: g.path,
      namespace: g.namespace,
      server: g.server,
    }));
  }

  getServerByPath(path: string): BunWsServerImpl | undefined {
    return this.gatewaysByPath.get(normalizePath(path))?.server;
  }

  /**
   * Scans a `@WebSocketGateway()` instance, precompiles its `@SubscribeMessage()`
   * handlers/guards/pipes/interceptors/filters, injects `@WebSocketServer()`,
   * invokes `OnGatewayInit.afterInit(server)`, and binds to `BunHttpAdapter` if attached.
   */
  async registerGateway(
    instance: object,
    moduleId?: string,
  ): Promise<BunWsServerImpl | undefined> {
    if (this.registeredInstances.has(instance)) {
      const existing = [...this.gatewaysById.values()].find(
        (g) => g.instance === instance,
      );
      return existing?.server;
    }

    const gatewayClass = instance.constructor as Type<unknown>;
    return this.registerGatewayInternal(gatewayClass, instance, false, moduleId);
  }

  /**
   * Registers a `Scope.REQUEST` `@WebSocketGateway()` class whose instances are
   * resolved per WebSocket connection from the DI container.
   */
  async registerGatewayClass(
    gatewayClass: Type<unknown>,
    moduleId?: string,
  ): Promise<BunWsServerImpl | undefined> {
    if (this.registeredClasses.has(gatewayClass)) {
      const existing = [...this.gatewaysById.values()].find(
        (g) => g.gatewayClass === gatewayClass,
      );
      return existing?.server;
    }
    return this.registerGatewayInternal(gatewayClass, undefined, true, moduleId);
  }

  private async registerGatewayInternal(
    gatewayClass: Type<unknown>,
    instance: object | undefined,
    isRequestScoped: boolean,
    moduleId?: string,
  ): Promise<BunWsServerImpl | undefined> {
    const gatewayMeta = MetadataRegistry.get<WebSocketGatewayOptions>(
      WS_METADATA_KEYS.GATEWAY,
      gatewayClass,
    );
    if (!gatewayMeta) {
      return undefined;
    }

    const path = normalizePath(gatewayMeta.path ?? "/ws");
    const namespace =
      typeof gatewayMeta.namespace === "string"
        ? gatewayMeta.namespace
        : gatewayMeta.namespace instanceof RegExp
          ? gatewayMeta.namespace.source
          : path;

    const existingPrimary = this.gatewaysByPath.get(path);
    const hasNewAuthenticate =
      gatewayMeta.authenticate !== undefined ||
      (instance !== undefined && hasGatewayAuthenticate(instance));

    if (existingPrimary) {
      const hasPrimaryAuthenticate =
        existingPrimary.options.authenticate !== undefined ||
        (existingPrimary.instance !== undefined &&
          hasGatewayAuthenticate(existingPrimary.instance));
      if (!hasPrimaryAuthenticate && hasNewAuthenticate) {
        throw new Error(
          `Duplicate @WebSocketGateway() path "${path}" in ${gatewayClass.name}.`,
        );
      }
    }

    const gatewayId = `gw_${++this.gatewayCounter}`;
    const wsServer =
      existingPrimary?.server ??
      new BunWsServerImpl(
        gatewayId,
        path,
        namespace,
        () =>
          this.activeBunServer ??
          this.httpAdapter?.getServer() ??
          this.standaloneServer,
      );

    // Inject @WebSocketServer() properties before afterInit()
    if (instance) {
      const serverProps = getGatewayServerProperties(gatewayClass);
      for (const propKey of serverProps) {
        (instance as Record<string | symbol, unknown>)[propKey] = wsServer;
      }
    }

    // Collect gateway-level enhancer metadata
    const gatewayGuards = MetadataRegistry.getMergedClassArray<GuardLike>(
      METADATA_KEYS.GUARDS,
      gatewayClass,
    );
    const gatewayPipes = MetadataRegistry.getMergedClassArray<PipeLike>(
      METADATA_KEYS.PIPES,
      gatewayClass,
    );
    const gatewayInterceptors =
      MetadataRegistry.getMergedClassArray<InterceptorLike>(
        METADATA_KEYS.INTERCEPTORS,
        gatewayClass,
      );
    const gatewayFilters =
      MetadataRegistry.getMergedClassArray<ExceptionFilterLike>(
        METADATA_KEYS.EXCEPTION_FILTERS,
        gatewayClass,
      );

    const handlerMetas = getGatewayMessageHandlers(gatewayClass);
    const handlers = new Map<string, CompiledWsHandler>();
    let wildcardHandler: CompiledWsHandler | undefined;
    let binaryHandler: CompiledWsHandler | undefined;

    for (const meta of handlerMetas) {
      const fn = (gatewayClass.prototype as Record<string | symbol, unknown>)[
        meta.handlerKey
      ];
      if (typeof fn !== "function") continue;

      const params = getGatewayMethodParams(gatewayClass, meta.handlerKey);
      const argCount =
        params.length > 0 ? Math.max(...params.map((p) => p.index)) + 1 : 0;

      const methodGuards =
        MetadataRegistry.get<readonly GuardLike[]>(METADATA_KEYS.GUARDS, fn) ??
        [];
      const methodPipes =
        MetadataRegistry.get<readonly PipeLike[]>(METADATA_KEYS.PIPES, fn) ??
        [];
      const methodInterceptors =
        MetadataRegistry.get<readonly InterceptorLike[]>(
          METADATA_KEYS.INTERCEPTORS,
          fn,
        ) ?? [];
      const methodFilters =
        MetadataRegistry.get<readonly ExceptionFilterLike[]>(
          METADATA_KEYS.EXCEPTION_FILTERS,
          fn,
        ) ?? [];

      const guardLikes = [...gatewayGuards, ...methodGuards];
      const interceptorLikes = [...gatewayInterceptors, ...methodInterceptors];
      const sharedPipeLikes = [...gatewayPipes, ...methodPipes];
      const paramPipeLikes = params.map((p) => [...(p.pipes ?? [])]);
      const filterLikes = [...methodFilters, ...gatewayFilters];

      const resolvedGuards: CanActivate[] = [];
      const resolvedInterceptors: BunestInterceptor[] = [];
      const resolvedSharedPipes: PipeTransform[] = [];
      const resolvedParamPipes: PipeTransform[][] = [];
      const resolvedFilters: CompiledWsFilter[] = [];

      // Pre-resolve enhancers only when operating standalone without a DI container
      // (with a DI container, enhancers are resolved per connection with RequestContainer + caching)
      if (!this.container) {
        for (const g of guardLikes) {
          resolvedGuards.push(await this.resolveEnhancer<CanActivate>(g));
        }
        for (const ic of interceptorLikes) {
          resolvedInterceptors.push(
            await this.resolveEnhancer<BunestInterceptor>(ic),
          );
        }
        for (const p of sharedPipeLikes) {
          resolvedSharedPipes.push(
            await this.resolveEnhancer<PipeTransform>(p),
          );
        }
        for (const paramPipes of paramPipeLikes) {
          const list: PipeTransform[] = [];
          for (const p of paramPipes) {
            list.push(await this.resolveEnhancer<PipeTransform>(p));
          }
          resolvedParamPipes.push(list);
        }
        for (const f of filterLikes) {
          const filter = await this.resolveEnhancer<ExceptionFilter>(f);
          resolvedFilters.push({
            filter,
            catchTypes: extractFilterCatchTypes(f),
          });
        }
      }

      const compiled: CompiledWsHandler = {
        event: meta.event,
        handlerKey: meta.handlerKey,
        handlerFn: fn,
        params,
        argCount,
        guards: resolvedGuards,
        interceptors: resolvedInterceptors,
        sharedPipes: resolvedSharedPipes,
        paramPipes: resolvedParamPipes,
        filters: resolvedFilters,
        guardLikes,
        interceptorLikes,
        sharedPipeLikes,
        paramPipeLikes,
        filterLikes,
      };

      if (meta.event === "*") {
        wildcardHandler = compiled;
      } else if (meta.event === "binary") {
        binaryHandler = compiled;
      } else {
        handlers.set(meta.event, compiled);
      }
    }

    const registered: RegisteredGateway = {
      id: gatewayId,
      path,
      namespace,
      gatewayClass,
      instance,
      isRequestScoped,
      moduleId,
      options: gatewayMeta,
      cors: normalizeCorsOptions(gatewayMeta.cors),
      server: wsServer,
      handlers,
      wildcardHandler,
      binaryHandler,
      gatewayFilterLikes: gatewayFilters,
    };

    if (instance) {
      this.registeredInstances.add(instance);
    }
    this.registeredClasses.add(gatewayClass);
    this.gatewaysById.set(gatewayId, registered);

    if (!existingPrimary) {
      this.gatewaysByPath.set(path, registered);
      this.gatewayGroupsByPath.set(path, [registered]);
      if (this.httpAdapter) {
        this.bindGatewayToHttpAdapter(this.httpAdapter, registered);
      }
    } else {
      const group = this.gatewayGroupsByPath.get(path)!;
      group.push(registered);
    }

    if (instance && hasGatewayInit(instance)) {
      await instance.afterInit(wsServer);
    }

    return wsServer;
  }

  /**
   * Builds the unified Bun `websocket` handler object suitable for `Bun.serve({ websocket })`.
   */
  createBunWebSocketHandler(): Record<string, unknown> {
    let maxPayloadLength =
      this.moduleOptions.maxPayloadLength ?? this.moduleOptions.maxPayload;
    let idleTimeout = this.moduleOptions.idleTimeout;
    let perMessageDeflate = this.moduleOptions.perMessageDeflate;

    for (const gw of this.gatewaysById.values()) {
      const gwMaxPayload = gw.options.maxPayloadLength ?? gw.options.maxPayload;
      if (gwMaxPayload !== undefined) {
        maxPayloadLength =
          maxPayloadLength === undefined
            ? gwMaxPayload
            : Math.max(maxPayloadLength, gwMaxPayload);
      }
      if (gw.options.idleTimeout !== undefined) {
        idleTimeout =
          idleTimeout === undefined
            ? gw.options.idleTimeout
            : Math.max(idleTimeout, gw.options.idleTimeout);
      }
      if (gw.options.perMessageDeflate !== undefined) {
        perMessageDeflate = gw.options.perMessageDeflate;
      }
    }

    const handler: Record<string, unknown> = {
      open: (ws: BunServerWebSocketLike<BunWsSocketData>) => {
        void this.handleOpen(ws);
      },
      message: (
        ws: BunServerWebSocketLike<BunWsSocketData>,
        message: string | Uint8Array | Buffer,
      ) => {
        void this.handleMessage(ws, message);
      },
      close: (
        ws: BunServerWebSocketLike<BunWsSocketData>,
        code: number,
        reason: string,
      ) => {
        void this.handleClose(ws, code, reason);
      },
    };

    if (maxPayloadLength !== undefined) {
      handler.maxPayloadLength = maxPayloadLength;
    }
    if (idleTimeout !== undefined) {
      handler.idleTimeout = idleTimeout;
    }
    if (perMessageDeflate !== undefined) {
      handler.perMessageDeflate = perMessageDeflate;
    }

    return handler;
  }

  /**
   * Starts a standalone `Bun.serve()` WebSocket server when using `BunWebSocketAdapter`
   * independently without a `BunHttpAdapter`.
   */
  async listen(
    portOrOptions: number | ListenOptions = 3000,
    hostname?: string,
  ): Promise<ListeningServerInfo> {
    if (this.standaloneServer) {
      await this.closeAll();
    }

    const opts: ListenOptions =
      typeof portOrOptions === "number"
        ? { port: portOrOptions, hostname }
        : portOrOptions;

    const serveOptions: Record<string, unknown> = {
      port: opts.port ?? 3000,
      fetch: async (req: Request, server: BunServerLike) => {
        const pathname = normalizePath(new URL(req.url).pathname);
        const gateway = this.gatewaysByPath.get(pathname);
        if (!gateway) {
          return new Response("Not Found", { status: 404 });
        }
        return this.handleUpgrade(gateway, req, server);
      },
      websocket: this.createBunWebSocketHandler(),
    };

    if (opts.hostname !== undefined) {
      serveOptions.hostname = opts.hostname;
    }

    const started = Bun.serve(
      serveOptions as unknown as Parameters<typeof Bun.serve>[0],
    ) as unknown as BunServerLike;
    this.standaloneServer = started;
    this.activeBunServer = started;

    return {
      port: started.port ?? opts.port ?? 0,
      hostname: started.hostname ?? opts.hostname ?? "localhost",
      url: started.url.toString(),
    };
  }

  /**
   * Disconnects every open WebSocket client across all gateways and stops
   * any standalone server cleanly.
   */
  async closeAll(code = 1001, reason = "Server shutting down"): Promise<void> {
    for (const gateway of this.gatewaysById.values()) {
      gateway.server.disconnectAll(code, reason);
    }
    if (this.standaloneServer) {
      const s = this.standaloneServer;
      this.standaloneServer = undefined;
      await s.stop(true);
    }
    this.activeBunServer = undefined;
  }

  private bindGatewayToHttpAdapter(
    httpAdapter: BunHttpAdapter,
    gateway: RegisteredGateway,
  ): void {
    const wsHandler = this.createBunWebSocketHandler();
    httpAdapter.registerWebsocketHandler(
      gateway.path,
      (req, server) => this.handleUpgrade(gateway, req, server),
      wsHandler,
    );
  }

  /**
   * Executes CORS origin verification and handshake authentication BEFORE calling
   * `server.upgrade(req)` so unauthorized clients receive an HTTP 401/403 response.
   */
  private async handleUpgrade(
    gateway: RegisteredGateway,
    req: Request,
    server: BunServerLike,
  ): Promise<Response | undefined> {
    this.activeBunServer = server;

    // 1. Optional CORS origin check for cross-origin WebSocket upgrades
    if (gateway.cors && req.headers.has("origin")) {
      const corsResult = await evaluateCors(req, gateway.cors);
      if (!corsResult.originAllowed) {
        return new Response(
          JSON.stringify({
            statusCode: 403,
            error: "Forbidden",
            message: "WebSocket origin not allowed",
          }),
          {
            status: 403,
            headers: { "Content-Type": "application/json; charset=utf-8" },
          },
        );
      }
    }

    // 2. Handshake authentication hook (gateway option -> gateway method -> module default)
    const authFn: WsAuthenticateFn | undefined =
      gateway.options.authenticate ??
      (gateway.instance && hasGatewayAuthenticate(gateway.instance)
        ? (r: Request) =>
            (gateway.instance as OnGatewayAuthenticate).authenticate(r)
        : this.moduleOptions.authenticate);

    let handshakeData: Record<string, unknown> = {};

    if (authFn) {
      try {
        const decision = await authFn(req);
        if (decision instanceof Response) {
          return decision;
        }
        if (decision === false) {
          return new Response(
            JSON.stringify({
              statusCode: 401,
              error: "Unauthorized",
              message: "WebSocket authentication failed",
            }),
            {
              status: 401,
              headers: { "Content-Type": "application/json; charset=utf-8" },
            },
          );
        }
        if (
          typeof decision === "object" &&
          decision !== null &&
          !Array.isArray(decision)
        ) {
          handshakeData = { ...decision };
        }
      } catch (err) {
        if (err instanceof HttpException) {
          return new Response(JSON.stringify(err.toJSON()), {
            status: err.getStatus(),
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              ...(err.getHeaders() ?? {}),
            },
          });
        }
        return new Response(
          JSON.stringify({
            statusCode: 401,
            error: "Unauthorized",
            message:
              err instanceof Error
                ? err.message
                : "WebSocket authentication failed",
          }),
          {
            status: 401,
            headers: { "Content-Type": "application/json; charset=utf-8" },
          },
        );
      }
    }

    const socketData: BunWsSocketData = {
      gatewayId: gateway.id,
      clientId: crypto.randomUUID(),
      request: req,
      path: gateway.path,
      namespace: gateway.namespace,
      handshakeData,
    };

    const upgraded = server.upgrade?.(req, { data: socketData }) ?? false;
    if (upgraded) {
      return undefined;
    }

    return new Response("WebSocket upgrade failed", { status: 400 });
  }

  private getGatewayGroup(
    socketData: BunWsSocketData,
  ): readonly RegisteredGateway[] {
    const byPath = this.gatewayGroupsByPath.get(socketData.path);
    if (byPath && byPath.length > 0) {
      return byPath;
    }
    const single = this.gatewaysById.get(socketData.gatewayId);
    return single ? [single] : [];
  }

  private getOrCreateConnectionState(
    client: BunWsClientImpl,
  ): WsConnectionState {
    let state = this.connectionStates.get(client);
    if (!state) {
      let contextId: ContextId | undefined;
      let requestContainer: RequestContainer | undefined;
      if (this.container) {
        contextId = ContextIdFactory.getByRequest(client);
        this.container.registerRequestByContextId(client, contextId);
        requestContainer = this.container.getOrCreateContextContainer(contextId);
      }
      state = {
        contextId,
        requestContainer,
        enhancerCache: new Map(),
        gatewayInstances: new Map(),
        gatewayLifecycles: new Map(),
        disconnectPromises: [],
        openSyncLoopDone: false,
      };
      this.connectionStates.set(client, state);
    }
    return state;
  }

  private async resolveGatewayInstance(
    gateway: RegisteredGateway,
    connState: WsConnectionState,
  ): Promise<object> {
    if (!gateway.isRequestScoped && gateway.instance) {
      return gateway.instance;
    }
    const cached = connState.gatewayInstances.get(gateway.id);
    if (cached) {
      return cached;
    }
    if (!this.container) {
      throw new Error(
        `Request-scoped gateway "${gateway.gatewayClass.name}" requires a DIContainer.`,
      );
    }
    const resolved = await this.container.resolveAsync(
      gateway.gatewayClass,
      gateway.moduleId ?? this.container.getGraph().root.id,
      connState.requestContainer,
      { strict: false },
    );
    if (!resolved || typeof resolved !== "object") {
      throw new Error(
        `Failed to resolve request-scoped gateway "${gateway.gatewayClass.name}".`,
      );
    }
    const serverProps = getGatewayServerProperties(gateway.gatewayClass);
    for (const propKey of serverProps) {
      (resolved as Record<string | symbol, unknown>)[propKey] = gateway.server;
    }
    connState.gatewayInstances.set(gateway.id, resolved as object);
    return resolved as object;
  }

  private async resolveEnhancerForConnection<T>(
    enhancer: Type<T> | T,
    connState: WsConnectionState,
    kind?: "guard" | "pipe" | "interceptor" | "filter",
  ): Promise<T> {
    if (typeof enhancer !== "function") {
      return enhancer;
    }
    if (connState.enhancerCache.has(enhancer)) {
      return connState.enhancerCache.get(enhancer) as T;
    }
    let resolved: T;
    if (this.container) {
      resolved = await this.container.resolveEnhancer<T>(
        enhancer,
        connState.requestContainer,
        undefined,
        kind,
      );
    } else {
      resolved = await this.resolveEnhancer<T>(enhancer);
    }
    connState.enhancerCache.set(enhancer, resolved);
    return resolved;
  }

  private async handleConnectionException(
    gateway: RegisteredGateway,
    error: unknown,
    client: BunWsClientImpl,
    connState: WsConnectionState,
  ): Promise<void> {
    const protoFn = (
      gateway.gatewayClass.prototype as Record<string, unknown> | undefined
    )?.handleConnection;
    const executionContext = new WsExecutionContext(
      client,
      undefined,
      "connection",
      gateway.gatewayClass,
      typeof protoFn === "function" ? protoFn : () => {},
      "handleConnection",
    );

    const resolvedFilters: CompiledWsFilter[] = [];
    for (const f of gateway.gatewayFilterLikes) {
      try {
        const filter = await this.resolveEnhancerForConnection<ExceptionFilter>(
          f,
          connState,
          "filter",
        );
        resolvedFilters.push({
          filter,
          catchTypes: extractFilterCatchTypes(f),
        });
      } catch (filterResolveError) {
        this.logger.error(
          `Error resolving filter for ${gateway.gatewayClass.name}.handleConnection`,
          filterResolveError,
        );
      }
    }

    await this.handleException(
      error,
      resolvedFilters,
      executionContext,
      client,
      undefined,
    );
  }

  private onGatewayConnectionFinished(
    gateway: RegisteredGateway,
    group: readonly RegisteredGateway[],
    client: BunWsClientImpl,
    connState: WsConnectionState,
  ): void {
    const lifecycle = connState.gatewayLifecycles.get(gateway.id);
    if (lifecycle) {
      lifecycle.connectionDone = true;
    }
    if (connState.openSyncLoopDone && connState.pendingClose) {
      this.runGatewayDisconnect(
        gateway,
        group,
        client,
        connState,
        connState.pendingClose.code,
        connState.pendingClose.reason,
      );
    }
  }

  private runGatewayDisconnect(
    gateway: RegisteredGateway,
    group: readonly RegisteredGateway[],
    client: BunWsClientImpl,
    connState: WsConnectionState,
    code: number,
    reason: string,
  ): void {
    let lifecycle = connState.gatewayLifecycles.get(gateway.id);
    if (!lifecycle) {
      lifecycle = { connectionDone: true, disconnected: false };
      connState.gatewayLifecycles.set(gateway.id, lifecycle);
    }
    if (lifecycle.disconnected) {
      return;
    }
    lifecycle.disconnected = true;

    const instance = gateway.isRequestScoped
      ? connState.gatewayInstances.get(gateway.id)
      : gateway.instance;

    if (instance && hasGatewayDisconnect(instance)) {
      const p = Promise.resolve()
        .then(() => instance.handleDisconnect(client, code, reason))
        .catch((err) => {
          this.logger.error(
            `Error in ${gateway.gatewayClass.name}.handleDisconnect`,
            err,
          );
        });
      connState.disconnectPromises.push(p);
    }

    const allDisconnected = group.every(
      (g) => connState.gatewayLifecycles.get(g.id)?.disconnected === true,
    );
    if (allDisconnected) {
      void Promise.allSettled(connState.disconnectPromises).finally(() => {
        client.clearTrackedRooms();
      });
    }
  }

  private flushPendingDisconnects(
    group: readonly RegisteredGateway[],
    client: BunWsClientImpl,
    connState: WsConnectionState,
  ): void {
    const pending = connState.pendingClose;
    if (!pending) return;
    for (const gw of group) {
      const lifecycle = connState.gatewayLifecycles.get(gw.id);
      if (lifecycle?.connectionDone && !lifecycle.disconnected) {
        this.runGatewayDisconnect(
          gw,
          group,
          client,
          connState,
          pending.code,
          pending.reason,
        );
      }
    }
  }

  private handleOpen(ws: BunServerWebSocketLike<BunWsSocketData>): void {
    const socketData = ws.data;
    const group = this.getGatewayGroup(socketData);
    const primary = group[0];
    if (!primary) {
      ws.close(1011, "Unknown gateway");
      return;
    }

    const client = new BunWsClientImpl(ws, socketData);
    socketData.client = client;
    const connState = this.getOrCreateConnectionState(client);

    // Subscribe to gateway-wide broadcast topic for server.emit() & client.broadcast()
    ws.subscribe(buildGatewayAllTopic(primary.id));
    primary.server.addClient(client);

    for (const gw of group) {
      const lifecycle: GatewayConnectionLifecycle = {
        connectionDone: false,
        disconnected: false,
      };
      connState.gatewayLifecycles.set(gw.id, lifecycle);

      if (!gw.isRequestScoped && gw.instance) {
        if (hasGatewayConnection(gw.instance)) {
          try {
            const maybePromise = gw.instance.handleConnection(
              client,
              socketData.request,
            );
            if (
              maybePromise !== null &&
              maybePromise !== undefined &&
              typeof (maybePromise as PromiseLike<unknown>).then === "function"
            ) {
              lifecycle.resolvePromise = Promise.resolve(maybePromise)
                .catch((err) =>
                  this.handleConnectionException(gw, err, client, connState),
                )
                .finally(() =>
                  this.onGatewayConnectionFinished(gw, group, client, connState),
                );
            } else {
              lifecycle.connectionDone = true;
            }
          } catch (err) {
            lifecycle.resolvePromise = this.handleConnectionException(
              gw,
              err,
              client,
              connState,
            ).finally(() =>
              this.onGatewayConnectionFinished(gw, group, client, connState),
            );
          }
        } else {
          lifecycle.connectionDone = true;
        }
      } else {
        lifecycle.resolvePromise = (async () => {
          try {
            const instance = await this.resolveGatewayInstance(gw, connState);
            if (hasGatewayConnection(instance)) {
              await instance.handleConnection(client, socketData.request);
            }
          } catch (err) {
            await this.handleConnectionException(gw, err, client, connState);
          } finally {
            this.onGatewayConnectionFinished(gw, group, client, connState);
          }
        })();
      }
    }

    connState.openSyncLoopDone = true;
    if (connState.pendingClose) {
      this.flushPendingDisconnects(group, client, connState);
    }
  }

  private handleClose(
    ws: BunServerWebSocketLike<BunWsSocketData>,
    code: number,
    reason: string,
  ): void {
    const socketData = ws.data;
    const group = this.getGatewayGroup(socketData);
    const primary = group[0];
    if (!primary) return;

    const client = socketData.client ?? new BunWsClientImpl(ws, socketData);
    const connState = this.getOrCreateConnectionState(client);
    primary.server.removeClient(client.id);
    connState.pendingClose = { code, reason };

    if (connState.openSyncLoopDone) {
      this.flushPendingDisconnects(group, client, connState);
    }
  }

  private async handleMessage(
    ws: BunServerWebSocketLike<BunWsSocketData>,
    rawMessage: string | Uint8Array | Buffer,
  ): Promise<void> {
    const socketData = ws.data;
    const group = this.getGatewayGroup(socketData);
    const primary = group[0];
    if (!primary) return;

    const client = socketData.client ?? new BunWsClientImpl(ws, socketData);

    const maxConcurrent =
      primary.options.maxConcurrentMessages ??
      this.moduleOptions.maxConcurrentMessages;

    const run = async (): Promise<void> => {
      // Binary message path
      if (typeof rawMessage !== "string") {
        const binaryBytes =
          rawMessage instanceof Uint8Array
            ? rawMessage
            : new Uint8Array(rawMessage);
        let targetGw: RegisteredGateway | undefined;
        let handler: CompiledWsHandler | undefined;
        for (const gw of group) {
          const candidate = gw.binaryHandler ?? gw.wildcardHandler;
          if (candidate) {
            targetGw = gw;
            handler = candidate;
            break;
          }
        }
        if (!targetGw || !handler) {
          return;
        }
        await this.executeHandler(
          targetGw,
          handler,
          client,
          "binary",
          binaryBytes,
          undefined,
        );
        return;
      }

      // Framed text message (default JSON `{ event, data?, id? }` or custom `messageParser`)
      const frame =
        this.messageParser === defaultWsMessageParser
          ? parseWsFrame(rawMessage)
          : (() => {
              const parsed = this.messageParser(rawMessage);
              if (
                !parsed ||
                typeof parsed.event !== "string" ||
                !parsed.event
              ) {
                return null;
              }
              return {
                event: parsed.event,
                data: parsed.data,
                id: parsed.id,
              };
            })();
      if (!frame) {
        client.emit("error", {
          status: "error",
          message:
            "Invalid WebSocket message frame; expected JSON { event, data? }",
        });
        return;
      }

      let targetGw: RegisteredGateway | undefined;
      let handler: CompiledWsHandler | undefined;
      for (const gw of group) {
        const candidate = gw.handlers.get(frame.event);
        if (candidate) {
          targetGw = gw;
          handler = candidate;
          break;
        }
      }
      if (!targetGw || !handler) {
        for (const gw of group) {
          if (gw.wildcardHandler) {
            targetGw = gw;
            handler = gw.wildcardHandler;
            break;
          }
        }
      }

      if (!targetGw || !handler) {
        if (frame.id !== undefined) {
          client.emit(
            "error",
            {
              status: "error",
              message: `No handler registered for event "${frame.event}"`,
            },
            frame.id,
          );
        }
        return;
      }

      await this.executeHandler(
        targetGw,
        handler,
        client,
        frame.event,
        frame.data,
        frame.id,
      );
    };

    if (maxConcurrent !== undefined && maxConcurrent > 0) {
      const active = this.activeHandlersPerClient.get(client) ?? 0;
      if (active >= maxConcurrent) {
        let queue = this.pendingQueuesPerClient.get(client);
        if (!queue) {
          queue = [];
          this.pendingQueuesPerClient.set(client, queue);
        }
        await new Promise<void>((resolve) => {
          queue!.push(async () => {
            try {
              await run();
            } finally {
              resolve();
            }
          });
        });
        return;
      }

      this.activeHandlersPerClient.set(client, active + 1);
      try {
        await run();
      } finally {
        const remaining = (this.activeHandlersPerClient.get(client) ?? 1) - 1;
        this.activeHandlersPerClient.set(client, Math.max(0, remaining));
        const queue = this.pendingQueuesPerClient.get(client);
        if (queue && queue.length > 0 && remaining < maxConcurrent) {
          const nextTask = queue.shift()!;
          void this.runQueuedTask(client, nextTask, maxConcurrent);
        }
      }
      return;
    }

    await run();
  }

  private async runQueuedTask(
    client: BunWsClientImpl,
    task: () => Promise<void>,
    maxConcurrent: number,
  ): Promise<void> {
    const active = this.activeHandlersPerClient.get(client) ?? 0;
    this.activeHandlersPerClient.set(client, active + 1);
    try {
      await task();
    } finally {
      const remaining = (this.activeHandlersPerClient.get(client) ?? 1) - 1;
      this.activeHandlersPerClient.set(client, Math.max(0, remaining));
      const queue = this.pendingQueuesPerClient.get(client);
      if (queue && queue.length > 0 && remaining < maxConcurrent) {
        const nextTask = queue.shift()!;
        void this.runQueuedTask(client, nextTask, maxConcurrent);
      }
    }
  }

  private async executeHandler(
    gateway: RegisteredGateway,
    handler: CompiledWsHandler,
    client: BunWsClientImpl,
    event: string,
    payload: unknown,
    frameId: string | undefined,
  ): Promise<void> {
    const executionContext = new WsExecutionContext(
      client,
      payload,
      event,
      gateway.gatewayClass,
      handler.handlerFn,
      handler.handlerKey,
    );
    const connState = this.getOrCreateConnectionState(client);

    // Resolve per-connection filters up front if needed for catch block
    let resolvedFilters: readonly CompiledWsFilter[] = handler.filters;

    try {
      // Wait for in-flight request-scoped gateway connection resolution if any
      const lifecycle = connState.gatewayLifecycles.get(gateway.id);
      if (lifecycle?.resolvePromise) {
        await lifecycle.resolvePromise;
      }

      const gatewayInstance = await this.resolveGatewayInstance(
        gateway,
        connState,
      );

      let guards: readonly CanActivate[];
      let interceptors: readonly BunestInterceptor[];
      let sharedPipes: readonly PipeTransform[];
      let paramPipesList: readonly (readonly PipeTransform[])[];

      if (this.container) {
        const filtersAcc: CompiledWsFilter[] = [];
        for (const f of handler.filterLikes) {
          const filter =
            await this.resolveEnhancerForConnection<ExceptionFilter>(
              f,
              connState,
              "filter",
            );
          filtersAcc.push({
            filter,
            catchTypes: extractFilterCatchTypes(f),
          });
        }
        resolvedFilters = filtersAcc;

        const guardsAcc: CanActivate[] = [];
        for (const g of [...this.globalGuardLikes, ...handler.guardLikes]) {
          guardsAcc.push(
            await this.resolveEnhancerForConnection<CanActivate>(
              g,
              connState,
              "guard",
            ),
          );
        }
        guards = guardsAcc;

        const interceptorsAcc: BunestInterceptor[] = [];
        for (const ic of [
          ...this.globalInterceptorLikes,
          ...handler.interceptorLikes,
        ]) {
          interceptorsAcc.push(
            await this.resolveEnhancerForConnection<BunestInterceptor>(
              ic,
              connState,
              "interceptor",
            ),
          );
        }
        interceptors = interceptorsAcc;

        const sharedPipesAcc: PipeTransform[] = [];
        for (const p of [...this.globalPipeLikes, ...handler.sharedPipeLikes]) {
          sharedPipesAcc.push(
            await this.resolveEnhancerForConnection<PipeTransform>(
              p,
              connState,
              "pipe",
            ),
          );
        }
        sharedPipes = sharedPipesAcc;

        const paramPipesAcc: PipeTransform[][] = [];
        for (const list of handler.paramPipeLikes) {
          const resolvedList: PipeTransform[] = [];
          for (const p of list) {
            resolvedList.push(
              await this.resolveEnhancerForConnection<PipeTransform>(
                p,
                connState,
                "pipe",
              ),
            );
          }
          paramPipesAcc.push(resolvedList);
        }
        paramPipesList = paramPipesAcc;
      } else {
        guards = handler.guards;
        interceptors = handler.interceptors;
        sharedPipes = handler.sharedPipes;
        paramPipesList = handler.paramPipes;
      }

      // 1. Guards (Global -> Gateway -> Method)
      for (let i = 0; i < guards.length; i++) {
        const guard = guards[i];
        if (!guard) continue;
        const allowed = await guard.canActivate(executionContext);
        if (!allowed) {
          throw new WsException({
            code: "FORBIDDEN",
            message: "Forbidden WebSocket resource",
          });
        }
      }

      let ackHandledManually = false;
      const ackFn = (...ackArgs: unknown[]): void => {
        ackHandledManually = true;
        const ackPayload = ackArgs.length <= 1 ? ackArgs[0] : ackArgs;
        client.emit(event, ackPayload, frameId);
      };

      // 2. Interceptors wrapping Parameter Extraction -> Pipes -> Handler
      const executeInner = async (): Promise<unknown> => {
        let args: unknown[];

        if (handler.params.length === 0) {
          // NestJS undecorated fallback signature: (client, data)
          args = [client, payload];
        } else {
          args = new Array<unknown>(handler.argCount);
          for (let i = 0; i < handler.params.length; i++) {
            const param = handler.params[i];
            if (!param) continue;

            if (param.source === "client") {
              args[param.index] = client;
              continue;
            }
            if (param.source === "ack") {
              args[param.index] = ackFn;
              continue;
            }

            let value =
              param.key !== undefined
                ? payload !== null && typeof payload === "object"
                  ? (payload as Record<string, unknown>)[param.key]
                  : undefined
                : payload;

            const argMeta: ArgumentMetadata = {
              type: "body",
              metatype: param.metatype,
              data: param.key,
            };

            // Global -> Gateway -> Method pipes
            for (let p = 0; p < sharedPipes.length; p++) {
              const pipe = sharedPipes[p];
              if (pipe) {
                value = await pipe.transform(value, argMeta);
              }
            }

            // Parameter-level pipes
            const paramPipes = paramPipesList[i];
            if (paramPipes) {
              for (let p = 0; p < paramPipes.length; p++) {
                const pipe = paramPipes[p];
                if (pipe) {
                  value = await pipe.transform(value, argMeta);
                }
              }
            }

            args[param.index] = value;
          }
        }

        return await (handler.handlerFn as (...a: unknown[]) => unknown).apply(
          gatewayInstance,
          args,
        );
      };

      let result: unknown;
      if (interceptors.length === 0) {
        result = await executeInner();
      } else {
        let nextHandler: CallHandler = { handle: executeInner };
        for (let i = interceptors.length - 1; i >= 0; i--) {
          const interceptor = interceptors[i];
          if (!interceptor) continue;
          const currentNext = nextHandler;
          nextHandler = {
            handle: () =>
              Promise.resolve(
                interceptor.intercept(executionContext, currentNext),
              ),
          };
        }
        result = await nextHandler.handle();
      }

      // 3. Emit response / acknowledgement frame when handler returns a value
      if (result !== undefined && !ackHandledManually) {
        if (isWsResponse(result)) {
          client.emit(result.event, result.data, result.id ?? frameId);
        } else {
          client.emit(event, result, frameId);
        }
      }
    } catch (error) {
      await this.handleException(
        error,
        resolvedFilters,
        executionContext,
        client,
        frameId,
      );
    }
  }

  private async handleException(
    error: unknown,
    filters: readonly CompiledWsFilter[],
    executionContext: WsExecutionContext,
    client: BunWsClientImpl,
    frameId: string | undefined,
  ): Promise<void> {
    for (let i = 0; i < filters.length; i++) {
      const entry = filters[i];
      if (!entry || !matchesExceptionFilter(error, entry.catchTypes)) {
        continue;
      }

      try {
        const res = await entry.filter.catch(error, executionContext);
        if (res !== undefined) {
          if (isWsResponse(res)) {
            client.emit(res.event, res.data, res.id ?? frameId);
          } else {
            client.emit("error", res, frameId);
          }
        }
        return;
      } catch (filterError) {
        try {
          this.defaultFilter.catch(filterError, executionContext, frameId);
        } catch (emitError) {
          this.logger.error(
            "Failed to emit WebSocket filter error frame",
            emitError,
          );
        }
        return;
      }
    }

    try {
      this.defaultFilter.catch(error, executionContext, frameId);
    } catch (emitError) {
      this.logger.error("Failed to emit WebSocket error frame", emitError);
    }
  }
}

/**
 * NestJS `@nestjs/platform-ws`-compatible `WsAdapter` powered natively by
 * `Bun.serve({ websocket })` via `BunWebSocketAdapter` (0 external dependencies).
 */
export class WsAdapter extends BunWebSocketAdapter {
  constructor(
    appOrHttpServer?: INestApplicationContext | object,
    options?: WsAdapterOptions,
  ) {
    let httpAdapter: BunHttpAdapter | undefined;
    if (isBunHttpAdapterLike(appOrHttpServer)) {
      httpAdapter = appOrHttpServer;
    } else if (
      appOrHttpServer &&
      typeof appOrHttpServer === "object" &&
      typeof (appOrHttpServer as { getHttpAdapter?: () => unknown })
        .getHttpAdapter === "function"
    ) {
      const candidate = (
        appOrHttpServer as { getHttpAdapter: () => unknown }
      ).getHttpAdapter();
      if (isBunHttpAdapterLike(candidate)) {
        httpAdapter = candidate;
      }
    }

    super(
      {
        httpAdapter,
        messageParser: options?.messageParser,
        maxConcurrentMessages: options?.maxConcurrentMessages,
        maxSendBufferSize: options?.maxSendBufferSize,
        unclaimedUpgradeTimeout: options?.unclaimedUpgradeTimeout,
        maxPayload: options?.maxPayload,
        maxPayloadLength: options?.maxPayload,
      },
      defaultEnhancerResolver,
      new Logger("WsAdapter"),
      appOrHttpServer,
    );
  }
}
