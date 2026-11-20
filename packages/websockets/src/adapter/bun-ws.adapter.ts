import {
  type ArgumentMetadata,
  type BunestInterceptor,
  type CallHandler,
  type CanActivate,
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
} from "@bunest/common";
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
} from "@bunest/http";
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
import { AbstractWsAdapter } from "./abstract-ws.adapter";

interface CompiledWsFilter {
  readonly filter: ExceptionFilter;
  readonly catchTypes: readonly Type<any>[];
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
}

interface RegisteredGateway {
  readonly id: string;
  readonly path: string;
  readonly namespace: string;
  readonly gatewayClass: Type<unknown>;
  readonly instance: object;
  readonly options: WebSocketGatewayOptions;
  readonly cors?: NormalizedCorsOptions;
  readonly server: BunWsServerImpl;
  readonly handlers: Map<string, CompiledWsHandler>;
  readonly wildcardHandler?: CompiledWsHandler;
  readonly binaryHandler?: CompiledWsHandler;
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
  catchTypes: readonly Type<any>[],
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
): { event: string; data?: any; id?: string } | void {
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
  private readonly registeredInstances = new WeakSet<object>();
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
    options?: Record<string, any> & WebSocketGatewayOptions,
  ): any {
    if (options?.server) {
      return options.server;
    }
    if (options?.namespace !== undefined && typeof options.namespace === "string" && options.namespace.length > 0 && !options.path) {
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
    options?: Record<string, any> & WebSocketGatewayOptions,
  ): any {
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

  override bindClientConnect(server: any, callback: Function): void {
    if (server && typeof server.on === "function") {
      server.on("connection", callback);
    }
  }

  override bindClientDisconnect(client: any, callback: Function): void {
    if (client && typeof client.on === "function") {
      client.on("close", callback);
    }
  }

  override closeClient(client: any): void {
    if (client && typeof client.close === "function") {
      client.close();
    }
  }

  bindErrorHandler(server: any): any {
    if (server && typeof server.on === "function") {
      server.on("error", (err: unknown) => {
        this.logger.error(
          err instanceof Error ? err.message : String(err),
          err instanceof Error ? err.stack : undefined,
        );
      });
    }
    return server;
  }

  override bindMessageHandlers(
    client: any,
    handlers: Array<MessageMappingProperties | WsMessageHandler>,
    transform: (data: any) => unknown = (data) => data,
  ): void {
    if (!client || typeof client.on !== "function") {
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

    client.on("message", (buffer: unknown) => {
      void this.bindMessageHandler(buffer, handlersMap, transform)
        .then((response) => {
          if (response === undefined || response === null) {
            return;
          }
          if (!this.ensureSendBufferWithinLimit(client)) {
            return;
          }
          if (typeof client.send === "function") {
            const payload =
              typeof response === "string"
                ? response
                : JSON.stringify(response);
            client.send(payload);
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
    buffer: any,
    handlersMap: Map<string, MessageMappingProperties>,
    transform: (data: any) => unknown = (data) => data,
  ): Promise<unknown> {
    try {
      const rawData: WsData =
        buffer && typeof buffer === "object" && "data" in buffer && !(buffer instanceof Uint8Array) && !(buffer instanceof ArrayBuffer)
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

  protected ensureSendBufferWithinLimit(client: any): boolean {
    if (!this.maxSendBufferSize || this.maxSendBufferSize <= 0) {
      return true;
    }
    const buffered =
      typeof client?.bufferedAmount === "number"
        ? client.bufferedAmount
        : typeof client?.raw?.getBufferedAmount === "function"
          ? client.raw.getBufferedAmount()
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

  override async close(server?: any): Promise<void> {
    if (!server || server === this) {
      await this.closeAll();
      return;
    }
    if (server instanceof BunWsServerImpl) {
      server.disconnectAll(1001, "Server shutting down");
      this.createdServers.delete(server);
      return;
    }
    await super.close(server);
  }

  override async dispose(): Promise<void> {
    for (const srv of this.createdServers) {
      srv.disconnectAll(1001, "Server shutting down");
    }
    this.createdServers.clear();
    await this.closeAll();
  }

  /**
   * Attaches this WebSocket adapter to a `BunHttpAdapter` and registers
   * all already-discovered gateways onto it.
   */
  attachToHttpAdapter(httpAdapter: BunHttpAdapter): this {
    this.httpAdapter = httpAdapter;
    for (const gateway of this.gatewaysById.values()) {
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
  async registerGateway(instance: object): Promise<BunWsServerImpl | undefined> {
    if (this.registeredInstances.has(instance)) {
      const existing = [...this.gatewaysById.values()].find(
        (g) => g.instance === instance,
      );
      return existing?.server;
    }

    const gatewayClass = instance.constructor as Type<unknown>;
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
    if (this.gatewaysByPath.has(path)) {
      throw new Error(
        `Duplicate @WebSocketGateway() path "${path}" in ${gatewayClass.name}.`,
      );
    }

    const gatewayId = `gw_${++this.gatewayCounter}`;
    const wsServer = new BunWsServerImpl(
      gatewayId,
      path,
      namespace,
      () =>
        this.activeBunServer ??
        this.httpAdapter?.getServer() ??
        this.standaloneServer,
    );

    // Inject @WebSocketServer() properties before afterInit()
    const serverProps = getGatewayServerProperties(gatewayClass);
    for (const propKey of serverProps) {
      (instance as Record<string | symbol, unknown>)[propKey] = wsServer;
    }

    // Pre-compile gateway-level enhancers
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

      const resolvedGuards: CanActivate[] = [];
      for (const g of [...gatewayGuards, ...methodGuards]) {
        resolvedGuards.push(await this.resolveEnhancer<CanActivate>(g));
      }

      const resolvedInterceptors: BunestInterceptor[] = [];
      for (const ic of [...gatewayInterceptors, ...methodInterceptors]) {
        resolvedInterceptors.push(
          await this.resolveEnhancer<BunestInterceptor>(ic),
        );
      }

      const resolvedSharedPipes: PipeTransform[] = [];
      for (const p of [...gatewayPipes, ...methodPipes]) {
        resolvedSharedPipes.push(await this.resolveEnhancer<PipeTransform>(p));
      }

      const resolvedParamPipes: PipeTransform[][] = [];
      for (const param of params) {
        const list: PipeTransform[] = [];
        for (const p of param.pipes ?? []) {
          list.push(await this.resolveEnhancer<PipeTransform>(p));
        }
        resolvedParamPipes.push(list);
      }

      const resolvedFilters: CompiledWsFilter[] = [];
      for (const f of [...methodFilters, ...gatewayFilters]) {
        const filter = await this.resolveEnhancer<ExceptionFilter>(f);
        resolvedFilters.push({
          filter,
          catchTypes: extractFilterCatchTypes(f),
        });
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
      options: gatewayMeta,
      cors: normalizeCorsOptions(gatewayMeta.cors),
      server: wsServer,
      handlers,
      wildcardHandler,
      binaryHandler,
    };

    this.registeredInstances.add(instance);
    this.gatewaysById.set(gatewayId, registered);
    this.gatewaysByPath.set(path, registered);

    if (this.httpAdapter) {
      this.bindGatewayToHttpAdapter(this.httpAdapter, registered);
    }

    if (hasGatewayInit(instance)) {
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
      const gwMaxPayload =
        gw.options.maxPayloadLength ?? gw.options.maxPayload;
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
      (hasGatewayAuthenticate(gateway.instance)
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

  private async handleOpen(
    ws: BunServerWebSocketLike<BunWsSocketData>,
  ): Promise<void> {
    const socketData = ws.data;
    const gateway = this.gatewaysById.get(socketData.gatewayId);
    if (!gateway) {
      ws.close(1011, "Unknown gateway");
      return;
    }

    const client = new BunWsClientImpl(ws, socketData);
    socketData.client = client;

    // Subscribe to gateway-wide broadcast topic for server.emit() & client.broadcast()
    ws.subscribe(buildGatewayAllTopic(gateway.id));
    gateway.server.addClient(client);

    if (hasGatewayConnection(gateway.instance)) {
      try {
        await gateway.instance.handleConnection(client, socketData.request);
      } catch (err) {
        this.logger.error(
          `Error in ${gateway.gatewayClass.name}.handleConnection`,
          err,
        );
      }
    }
  }

  private async handleClose(
    ws: BunServerWebSocketLike<BunWsSocketData>,
    code: number,
    reason: string,
  ): Promise<void> {
    const socketData = ws.data;
    const gateway = this.gatewaysById.get(socketData.gatewayId);
    if (!gateway) return;

    const client =
      socketData.client ?? new BunWsClientImpl(ws, socketData);
    gateway.server.removeClient(client.id);

    try {
      if (hasGatewayDisconnect(gateway.instance)) {
        await gateway.instance.handleDisconnect(client, code, reason);
      }
    } catch (err) {
      this.logger.error(
        `Error in ${gateway.gatewayClass.name}.handleDisconnect`,
        err,
      );
    } finally {
      client.clearTrackedRooms();
    }
  }

  private async handleMessage(
    ws: BunServerWebSocketLike<BunWsSocketData>,
    rawMessage: string | Uint8Array | Buffer,
  ): Promise<void> {
    const socketData = ws.data;
    const gateway = this.gatewaysById.get(socketData.gatewayId);
    if (!gateway) return;

    const client = socketData.client ?? new BunWsClientImpl(ws, socketData);

    const maxConcurrent =
      gateway.options.maxConcurrentMessages ??
      this.moduleOptions.maxConcurrentMessages;

    const run = async (): Promise<void> => {
      // Binary message path
      if (typeof rawMessage !== "string") {
        const binaryBytes =
          rawMessage instanceof Uint8Array
            ? rawMessage
            : new Uint8Array(rawMessage);
        const handler = gateway.binaryHandler ?? gateway.wildcardHandler;
        if (!handler) {
          return;
        }
        await this.executeHandler(
          gateway,
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
              if (!parsed || typeof parsed.event !== "string" || !parsed.event) {
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

      const handler =
        gateway.handlers.get(frame.event) ?? gateway.wildcardHandler;
      if (!handler) {
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
        gateway,
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

    try {
      // 1. Guards (Gateway -> Method)
      for (let i = 0; i < handler.guards.length; i++) {
        const guard = handler.guards[i];
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

            // Gateway -> Method pipes
            for (let p = 0; p < handler.sharedPipes.length; p++) {
              const pipe = handler.sharedPipes[p];
              if (pipe) {
                value = await pipe.transform(value, argMeta);
              }
            }

            // Parameter-level pipes
            const paramPipes = handler.paramPipes[i];
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
          gateway.instance,
          args,
        );
      };

      let result: unknown;
      if (handler.interceptors.length === 0) {
        result = await executeInner();
      } else {
        let nextHandler: CallHandler = { handle: executeInner };
        for (let i = handler.interceptors.length - 1; i >= 0; i--) {
          const interceptor = handler.interceptors[i];
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
        handler.filters,
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
        this.defaultFilter.catch(filterError, executionContext, frameId);
        return;
      }
    }

    this.defaultFilter.catch(error, executionContext, frameId);
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
