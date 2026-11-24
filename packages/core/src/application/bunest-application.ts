import {
  APP_FILTER,
  APP_GUARD,
  APP_INTERCEPTOR,
  APP_PIPE,
  Logger,
  METADATA_KEYS,
  MetadataRegistry,
  VersioningType,
  type BunestModule,
  type ControllerMetadata,
  type CorsOptions,
  type CsrfProtectionOptions,
  type ExceptionFilter,
  type ExceptionFilterLike,
  type GuardLike,
  type HttpSecurityHeadersOptions,
  type InjectionToken,
  type InterceptorLike,
  type LogLevel,
  type LoggerService,
  type MicroserviceInstance,
  type NestHybridApplicationOptions,
  type PipeLike,
  type PipeTransform,
  type ResponseContext,
  type RouteDefinition,
  Scope,
  type StaticAssetsOptions,
  type Type,
  type VersioningOptions,
  type ViewEngineRenderer,
  type WebSocketAdapter,
} from "../common/index";
import {
  BunHttpAdapter,
  CookieSigner,
  type BunServerLike,
  type CompiledMiddlewareConfig,
  type EnhancerKind,
  type ExtendedStaticAssetsOptions,
  type GlobalPrefixOptions,
  type HttpRuntimeBridge,
  type ListenOptions,
  type ListeningServerInfo,
  type MiddlewareEntry,
  type RequestScopeContainer,
} from "../http/index";
import { DIContainer } from "../di/di-container";
import type {
  BunestApplicationContextOptions,
  InjectBody,
  InjectOptions,
  InjectResponse,
} from "../interfaces/core-types.interface";
import { CoreMiddlewareConsumer } from "../module/middleware-consumer";
import {
  joinRoutePaths,
  resolveRouterModulePrefixes,
} from "../router/router.module";
import { BunestApplicationContext } from "./bunest-application-context";

interface ExtendedHttpAdapter {
  enableVersioning?(options: VersioningOptions): unknown;
  useStaticAssets?(rootDir: string, options?: StaticAssetsOptions): unknown;
  setControllerPrefixes?(
    prefixes: ReadonlyMap<Type<unknown>, readonly string[]>,
  ): unknown;
}

function isConfigurableModule(value: unknown): value is BunestModule {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Partial<BunestModule>).configure === "function"
  );
}

function isBodyInitPassthrough(value: unknown): value is InjectBody {
  if (
    typeof value === "string" ||
    value instanceof Uint8Array ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value) ||
    value instanceof Blob ||
    value instanceof FormData ||
    value instanceof URLSearchParams ||
    value instanceof ReadableStream
  ) {
    return true;
  }
  return false;
}

function buildInjectRequest(input: string | InjectOptions): Request {
  const opts: InjectOptions =
    typeof input === "string" ? { url: input } : input;

  const method = (opts.method ?? "GET").toUpperCase();
  const rawUrl = opts.url || "/";
  const baseUrl =
    rawUrl.startsWith("http://") || rawUrl.startsWith("https://")
      ? new URL(rawUrl)
      : new URL(
          rawUrl.startsWith("/") ? rawUrl : `/${rawUrl}`,
          "http://localhost",
        );

  if (opts.query) {
    for (const [key, val] of Object.entries(opts.query)) {
      if (val === undefined) continue;
      if (Array.isArray(val)) {
        for (const item of val) {
          baseUrl.searchParams.append(key, String(item));
        }
      } else {
        baseUrl.searchParams.append(key, String(val));
      }
    }
  }

  const headers = new Headers();
  if (opts.headers) {
    for (const [key, val] of Object.entries(opts.headers)) {
      if (Array.isArray(val)) {
        for (const item of val) {
          headers.append(key, item);
        }
      } else {
        headers.set(key, val);
      }
    }
  }

  if (opts.cookies && Object.keys(opts.cookies).length > 0) {
    const cookieStr = Object.entries(opts.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
    const existing = headers.get("cookie");
    headers.set("cookie", existing ? `${existing}; ${cookieStr}` : cookieStr);
  }

  let body: InjectBody | undefined;
  if (opts.body !== undefined) {
    body = opts.body;
  } else if (opts.payload !== undefined) {
    if (isBodyInitPassthrough(opts.payload)) {
      body = opts.payload;
    } else {
      body = JSON.stringify(opts.payload);
      if (!headers.has("content-type")) {
        headers.set("content-type", "application/json");
      }
    }
  }

  const init: RequestInit = { method, headers };
  if (body !== undefined && method !== "GET" && method !== "HEAD") {
    init.body = body as RequestInit["body"];
  }

  return new Request(baseUrl.toString(), init);
}

function extractInjectHeaders(
  raw: Response,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  raw.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower === "set-cookie") {
      return;
    }
    out[lower] = value;
  });

  const setCookies =
    typeof raw.headers.getSetCookie === "function"
      ? raw.headers.getSetCookie()
      : [];
  if (setCookies.length === 1 && setCookies[0] !== undefined) {
    out["set-cookie"] = setCookies[0];
  } else if (setCookies.length > 1) {
    out["set-cookie"] = setCookies;
  } else {
    const single = raw.headers.get("set-cookie");
    if (single !== null) {
      out["set-cookie"] = single;
    }
  }

  return out;
}

class CoreHttpBridge implements HttpRuntimeBridge {
  constructor(private readonly container: DIContainer) {}

  resolveController(
    controllerToken: Type<unknown>,
    requestContainer?: RequestScopeContainer,
  ): Promise<object> {
    return this.container.resolveController(controllerToken, requestContainer);
  }

  resolveEnhancer<T = unknown>(
    enhancer: Type<T> | T,
    requestContainer?: RequestScopeContainer,
    kind?: EnhancerKind,
    controllerToken?: Type<unknown>,
  ): Promise<T> {
    const owningModule = controllerToken
      ? this.container.getControllerOwner(controllerToken)
      : undefined;
    return this.container.resolveEnhancer<T>(
      enhancer,
      requestContainer,
      owningModule,
      kind,
    );
  }

  createRequestContainer(
    request: Request,
    responseContext: ResponseContext,
  ): RequestScopeContainer {
    return this.container.createRequestContainer(request, responseContext);
  }

  requiresRequestScope(
    controllerToken: Type<unknown>,
    enhancerTokens: readonly InjectionToken[],
  ): boolean {
    return this.container.requiresRequestScope(controllerToken, enhancerTokens);
  }

  requiresEnhancerRequestScope(
    enhancer: unknown,
    kind?: EnhancerKind,
    controllerToken?: Type<unknown>,
  ): boolean {
    return this.container.requiresEnhancerRequestScope(
      enhancer,
      kind,
      controllerToken,
    );
  }

  resolveFilterCatchTypes(
    filterSpec: ExceptionFilterLike,
    resolvedInstance?: ExceptionFilter,
  ): readonly Type<any>[] | undefined {
    return this.container.resolveFilterCatchTypes(filterSpec, resolvedInstance);
  }
}

/**
 * Full Bunest HTTP application uniting `@bunest/core`'s DI/Module/Lifecycle engine
 * with `@bunest/core/http`'s native `BunHttpAdapter`.
 */
export class BunestApplication extends BunestApplicationContext {
  private readonly httpAdapter: BunHttpAdapter;
  private readonly controllers: Type<unknown>[] = [];
  private readonly pendingGlobalEnhancerClasses: Array<{
    cls: Type<unknown>;
    kind?: EnhancerKind;
  }> = [];
  private versioningOptions?: VersioningOptions;
  private readonly staticAssetsConfigs: Array<{
    readonly rootDir: string;
    readonly options?: StaticAssetsOptions;
  }> = [];
  private readonly microservices: MicroserviceInstance[] = [];
  private readonly startedMicroservices = new WeakSet<MicroserviceInstance>();
  private readonly inheritedConfigMicroservices =
    new Set<MicroserviceInstance>();
  private wsAdapter?: WebSocketAdapter;
  private isWsModuleRegistered = false;
  private routesDirty = true;
  private moduleMiddlewaresConfigured = false;
  private diEnhancersWired = false;

  constructor(
    container: DIContainer,
    options: BunestApplicationContextOptions = {},
    adapter?: BunHttpAdapter,
  ) {
    super(container, options);
    if (options.cookies?.secret !== undefined) {
      const secret = options.cookies.secret;
      if (
        (typeof secret === "string" && secret.length === 0) ||
        (Array.isArray(secret) &&
          (secret.length === 0 ||
            secret.some((s) => typeof s !== "string" || s.length === 0)))
      ) {
        throw new TypeError(
          "Cookie secret must be a non-empty string or a non-empty array of non-empty strings.",
        );
      }
    }
    if (adapter) {
      this.httpAdapter = adapter;
      if (options.logger !== undefined || options.bufferLogs) {
        this.httpAdapter.setLogger(this.logger);
      }
    } else {
      this.httpAdapter = new BunHttpAdapter({
        ...options,
        logger: this.logger,
      });
    }
    this.httpAdapter.setBridge(new CoreHttpBridge(container));
    container.getHttpAdapterHost().httpAdapter = this.httpAdapter;
    this.applyOptions();

    // Collect all controllers in deterministic topological module order
    const seen = new Set<Type<unknown>>();
    for (const mod of container.getGraph().topologicalOrder) {
      for (const ctrl of mod.controllers) {
        if (!seen.has(ctrl)) {
          seen.add(ctrl);
          this.controllers.push(ctrl);
        }
      }
    }
  }

  /**
   * Applies `BunestApplicationOptions` (`cookies`, `routeConflictPolicy`,
   * `routeResolutionStrategy`, `cors`, `bodyParser`, `rawBody`) onto `ApplicationConfig`
   * and the underlying `BunHttpAdapter` (matching NestJS `NestApplication.applyOptions`).
   */
  applyOptions(): void {
    const config = this.container.getApplicationConfig();
    if (this.options.routeConflictPolicy !== undefined) {
      config.setRouteConflictPolicy(this.options.routeConflictPolicy);
      this.httpAdapter.setRouteConflictPolicy(this.options.routeConflictPolicy);
    }
    if (this.options.routeResolutionStrategy !== undefined) {
      config.setRouteResolutionStrategy(this.options.routeResolutionStrategy);
      this.httpAdapter.setRouteResolutionStrategy(
        this.options.routeResolutionStrategy,
      );
    }
    if (this.options.cookies?.secret !== undefined) {
      const secret = this.options.cookies.secret;
      if (
        (typeof secret === "string" && secret.length === 0) ||
        (Array.isArray(secret) &&
          (secret.length === 0 ||
            secret.some((s) => typeof s !== "string" || s.length === 0)))
      ) {
        throw new TypeError(
          "Cookie secret must be a non-empty string or a non-empty array of non-empty strings.",
        );
      }
      const signer = new CookieSigner(secret);
      config.setCookieSigner(signer);
      this.httpAdapter.setCookieSigner(signer);
    }
    if (this.options.globalPrefix !== undefined) {
      const primaryPrefix = Array.isArray(this.options.globalPrefix)
        ? (this.options.globalPrefix[0] ?? "")
        : this.options.globalPrefix;
      config.setGlobalPrefix(primaryPrefix);
    }
  }

  registerHttpServer(): void {
    this.container.getHttpAdapterHost().httpAdapter = this.httpAdapter;
    this.createServer();
  }

  createServer<T = BunServerLike | undefined>(): T {
    this.httpAdapter.initHttpServer(this.options);
    return this.httpAdapter.getHttpServer() as unknown as T;
  }

  getUnderlyingHttpServer<T = BunServerLike | undefined>(): T {
    return this.getHttpServer() as unknown as T;
  }

  async registerModules(): Promise<void> {
    this.wireDiGlobalEnhancers();
    await this.configureModuleMiddlewares();
    await this.registerWsModule();
  }

  async registerWsModule(): Promise<void> {
    if (this.isWsModuleRegistered) {
      return;
    }
    if (
      this.wsAdapter &&
      typeof this.wsAdapter.attachToHttpAdapter === "function"
    ) {
      this.wsAdapter.attachToHttpAdapter(this.httpAdapter);
      this.isWsModuleRegistered = true;
    }
  }

  registerParserMiddleware(): void {
    if (this.options.bodyParser !== false) {
      this.httpAdapter.registerParserMiddleware(
        this.container.getApplicationConfig().getGlobalPrefix(),
        this.options.rawBody,
      );
    }
  }

  async registerRouter(): Promise<void> {
    await this.recompileRoutesIfNeeded();
  }

  async registerRouterHooks(): Promise<void> {
    // BunHttpAdapter wires 404/error handling natively inside compiled dispatchers
  }

  async preloadLazyPackages(): Promise<void> {
    // Bun-native runtime has no lazy Express/Fastify npm packages to preload (ADR-001)
  }

  /**
   * Configures body parser options (e.g. `app.useBodyParser("json", { limit: "10mb" })`).
   */
  useBodyParser(...args: [any, any?]): this {
    this.httpAdapter.useBodyParser(args[0], args[1]);
    this.routesDirty = true;
    return this;
  }

  /**
   * Wires DI multi-providers (`APP_GUARD`, `APP_PIPE`, `APP_INTERCEPTOR`, `APP_FILTER`),
   * executes `BunestModule.configure(MiddlewareConsumer)` across modules,
   * and compiles routes once so route collisions fail fast at creation time.
   */
  async prepareHttpPipeline(): Promise<void> {
    this.wireDiGlobalEnhancers();
    await this.configureModuleMiddlewares();
    await this.recompileRoutesIfNeeded();
  }

  override async init(): Promise<this> {
    if (this.isInitialized && this.lifecycle.getIsInitialized()) {
      return this;
    }
    await this.prepareHttpPipeline();
    for (const route of this.getRoutes()) {
      this.logger.log(
        `Mapped {${route.path}, ${route.method}} route`,
        "RouterExplorer",
      );
    }
    await super.init();
    this.container.getHttpAdapterHost().markInitialized();
    this.logger.log("Nest application successfully started", "NestApplication");
    return this;
  }

  override useLogger(logger: LoggerService | LogLevel[] | false): this {
    super.useLogger(logger);
    this.httpAdapter.setLogger(this.logger);
    return this;
  }

  getHttpAdapter(): BunHttpAdapter {
    return this.httpAdapter;
  }

  /**
   * Returns the active `BunServerLike` instance once `listen()` has been called,
   * or `undefined` when operating in zero-socket in-memory mode.
   */
  getHttpServer(): BunServerLike | undefined {
    return this.httpAdapter.getServer();
  }

  getRoutes(): readonly RouteDefinition[] {
    return this.httpAdapter.getCompiledRoutes();
  }

  getUrl(): string | undefined {
    return this.httpAdapter.getUrl();
  }

  useGlobalPipes(...pipes: PipeLike[]): this {
    const appConfig = this.container.getApplicationConfig();
    for (const p of pipes) {
      if (typeof p === "function") {
        this.pendingGlobalEnhancerClasses.push({
          cls: p as Type<unknown>,
          kind: "pipe",
        });
        appConfig.addGlobalPipe(p);
      } else {
        appConfig.useGlobalPipes(p);
      }
    }
    this.httpAdapter.useGlobalPipes(...pipes);
    this.routesDirty = true;
    return this;
  }

  useGlobalGuards(...guards: GuardLike[]): this {
    const appConfig = this.container.getApplicationConfig();
    for (const g of guards) {
      if (typeof g === "function") {
        this.pendingGlobalEnhancerClasses.push({
          cls: g as Type<unknown>,
          kind: "guard",
        });
        appConfig.addGlobalGuard(g);
      } else {
        appConfig.useGlobalGuards(g);
      }
    }
    this.httpAdapter.useGlobalGuards(...guards);
    this.routesDirty = true;
    return this;
  }

  useGlobalInterceptors(...interceptors: InterceptorLike[]): this {
    const appConfig = this.container.getApplicationConfig();
    for (const ic of interceptors) {
      if (typeof ic === "function") {
        this.pendingGlobalEnhancerClasses.push({
          cls: ic as Type<unknown>,
          kind: "interceptor",
        });
        appConfig.addGlobalInterceptor(ic);
      } else {
        appConfig.useGlobalInterceptors(ic);
      }
    }
    this.httpAdapter.useGlobalInterceptors(...interceptors);
    this.routesDirty = true;
    return this;
  }

  useGlobalFilters(...filters: ExceptionFilterLike[]): this {
    const appConfig = this.container.getApplicationConfig();
    for (const f of filters) {
      if (typeof f === "function") {
        this.pendingGlobalEnhancerClasses.push({
          cls: f as Type<unknown>,
          kind: "filter",
        });
        appConfig.addGlobalFilter(f);
      } else {
        appConfig.useGlobalFilters(f);
      }
    }
    this.httpAdapter.useGlobalFilters(...filters);
    this.routesDirty = true;
    return this;
  }

  use(...middlewares: MiddlewareEntry[]): this {
    const decorator = this.options.instrument?.instanceDecorator;
    const processed: MiddlewareEntry[] = [];
    for (const mw of middlewares) {
      if (
        typeof mw === "function" &&
        typeof (mw as { prototype?: { use?: unknown } }).prototype?.use ===
          "function"
      ) {
        this.pendingGlobalEnhancerClasses.push({
          cls: mw as Type<unknown>,
        });
        processed.push(mw);
      } else if (typeof mw === "function" && decorator) {
        processed.push(decorator(mw) as MiddlewareEntry);
      } else {
        processed.push(mw);
      }
    }
    this.httpAdapter.use(...processed);
    this.routesDirty = true;
    return this;
  }

  enableCors(options: boolean | CorsOptions = true): this {
    this.httpAdapter.enableCors(options);
    this.routesDirty = true;
    return this;
  }

  /**
   * Enables built-in NestJS v12 Fetch-Metadata CSRF protection (`Sec-Fetch-Site`
   * with `Origin`/`Host` fallback).
   */
  private csrfEnabled = false;
  private securityHeadersEnabled = false;

  enableCsrfProtection(options?: CsrfProtectionOptions<Request>): this {
    if (this.isInitialized) {
      throw new Error("enableCsrfProtection() must be called before app.init().");
    }
    if (this.csrfEnabled) {
      throw new Error("enableCsrfProtection() can only be called once.");
    }
    this.httpAdapter.enableCsrfProtection(options);
    this.csrfEnabled = true;
    this.routesDirty = true;
    return this;
  }

  /**
   * Sets NestJS v12 / Helmet-8 security headers on every response (including
   * `404`s and error responses) and removes `X-Powered-By`.
   */
  useSecurityHeaders(options?: HttpSecurityHeadersOptions): this {
    if (this.isInitialized) {
      throw new Error("useSecurityHeaders() must be called before app.init().");
    }
    if (this.securityHeadersEnabled) {
      throw new Error("useSecurityHeaders() can only be called once.");
    }
    this.httpAdapter.useSecurityHeaders(options);
    this.securityHeadersEnabled = true;
    this.routesDirty = true;
    return this;
  }

  /**
   * Registers a WebSocket adapter for gateway integration (matching NestJS `useWebSocketAdapter`).
   */
  useWebSocketAdapter(adapter: WebSocketAdapter): this {
    this.wsAdapter = adapter;
    this.container.getApplicationConfig().setIoAdapter(adapter);
    if (typeof adapter.attachToHttpAdapter === "function") {
      adapter.attachToHttpAdapter(this.httpAdapter);
    }
    return this;
  }

  getWebSocketAdapter(): WebSocketAdapter | undefined {
    return this.wsAdapter;
  }

  /**
   * Sets the base directory for view templates rendered via `@Render()`.
   */
  setBaseViewsDir(dir: string | string[]): this {
    this.httpAdapter.setBaseViewsDir(dir);
    this.routesDirty = true;
    return this;
  }

  /**
   * Sets the template engine name or pluggable render function used by `@Render()`.
   */
  setViewEngine(engine: string | ViewEngineRenderer): this {
    this.httpAdapter.setViewEngine(engine);
    this.routesDirty = true;
    return this;
  }

  setGlobalPrefix(
    prefix: string | readonly string[],
    options?: GlobalPrefixOptions,
  ): this {
    this.container
      .getApplicationConfig()
      .setGlobalPrefix(Array.isArray(prefix) ? (prefix[0] ?? "") : prefix);
    if (options) {
      this.container.getApplicationConfig().setGlobalPrefixOptions(options);
    }
    this.httpAdapter.setGlobalPrefix(prefix, options);
    this.routesDirty = true;
    return this;
  }

  /**
   * Enables HTTP API versioning (`URI`, `HEADER`, `MEDIA_TYPE`, or `CUSTOM`).
   */
  enableVersioning(
    options: VersioningOptions = { type: VersioningType.URI },
  ): this {
    this.versioningOptions = options;
    this.container.getApplicationConfig().enableVersioning(options);
    const adapterExt = this.httpAdapter as unknown as ExtendedHttpAdapter;
    adapterExt.enableVersioning?.(options);
    this.routesDirty = true;
    return this;
  }

  getVersioningOptions(): VersioningOptions | undefined {
    return this.versioningOptions;
  }

  /**
   * Configures static asset serving from `rootDir` (forwarded to `BunHttpAdapter`).
   */
  useStaticAssets(
    rootDir: string,
    options?: StaticAssetsOptions | ExtendedStaticAssetsOptions,
  ): this;
  useStaticAssets(
    options: ExtendedStaticAssetsOptions & { root?: string; rootPath?: string },
  ): this;
  useStaticAssets(
    rootDirOrOptions:
      | string
      | (ExtendedStaticAssetsOptions & { root?: string; rootPath?: string }),
    options?: StaticAssetsOptions | ExtendedStaticAssetsOptions,
  ): this {
    const rootDir =
      typeof rootDirOrOptions === "string"
        ? rootDirOrOptions
        : (rootDirOrOptions.root ?? rootDirOrOptions.rootPath ?? ".");
    const resolvedOptions =
      typeof rootDirOrOptions === "string" ? options : rootDirOrOptions;
    const entry = {
      rootDir,
      options: resolvedOptions ? { ...resolvedOptions } : undefined,
    };
    this.staticAssetsConfigs.push(
      entry as {
        readonly rootDir: string;
        readonly options?: StaticAssetsOptions;
      },
    );
    const adapterExt = this.httpAdapter as unknown as ExtendedHttpAdapter;
    adapterExt.useStaticAssets?.(rootDir, entry.options as StaticAssetsOptions);
    this.routesDirty = true;
    return this;
  }

  getStaticAssetsConfigs(): ReadonlyArray<{
    readonly rootDir: string;
    readonly options?: StaticAssetsOptions;
  }> {
    return [...this.staticAssetsConfigs];
  }

  /**
   * Attaches a microservice transport server to create a hybrid HTTP + Microservice application.
   * Connected microservices are started via `startAllMicroservices()` and stopped automatically on `close()`.
   */
  connectMicroservice<T extends MicroserviceInstance>(
    server: T,
    hybridOptions?: NestHybridApplicationOptions,
  ): T {
    if (
      !server ||
      typeof server.listen !== "function" ||
      typeof server.close !== "function"
    ) {
      throw new TypeError(
        "connectMicroservice() expects an object implementing MicroserviceInstance ({ listen(), close() }).",
      );
    }
    if (!this.microservices.includes(server)) {
      this.microservices.push(server);
    }
    if (hybridOptions?.inheritAppConfig) {
      this.inheritedConfigMicroservices.add(server);
    }
    return server;
  }

  /**
   * Initializes the application (if not already initialized) and starts all connected
   * microservice transport servers.
   */
  async startAllMicroservices(): Promise<this> {
    if (!this.isInitialized) {
      await this.init();
    }
    const appCfg = this.container.getApplicationConfig();
    for (const ms of this.microservices) {
      if (this.startedMicroservices.has(ms)) {
        continue;
      }
      if (this.inheritedConfigMicroservices.has(ms)) {
        const configurable = ms as MicroserviceInstance & {
          useGlobalPipes?: (...pipes: PipeLike[]) => unknown;
          useGlobalGuards?: (...guards: GuardLike[]) => unknown;
          useGlobalInterceptors?: (
            ...interceptors: InterceptorLike[]
          ) => unknown;
          useGlobalFilters?: (...filters: ExceptionFilterLike[]) => unknown;
        };
        const pipes = appCfg.getGlobalPipes();
        if (
          pipes.length > 0 &&
          typeof configurable.useGlobalPipes === "function"
        ) {
          configurable.useGlobalPipes(...pipes);
        }
        const guards = appCfg.getGlobalGuards();
        if (
          guards.length > 0 &&
          typeof configurable.useGlobalGuards === "function"
        ) {
          configurable.useGlobalGuards(...guards);
        }
        const interceptors = appCfg.getGlobalInterceptors();
        if (
          interceptors.length > 0 &&
          typeof configurable.useGlobalInterceptors === "function"
        ) {
          configurable.useGlobalInterceptors(...interceptors);
        }
        const filters = appCfg.getGlobalFilters();
        if (
          filters.length > 0 &&
          typeof configurable.useGlobalFilters === "function"
        ) {
          configurable.useGlobalFilters(...filters);
        }
      }
      await ms.listen();
      this.startedMicroservices.add(ms);
    }
    return this;
  }

  getMicroservices(): readonly MicroserviceInstance[] {
    return [...this.microservices];
  }

  async fetch(req: Request): Promise<Response> {
    if (!this.isInitialized) {
      await this.init();
    } else {
      await this.recompileRoutesIfNeeded();
    }
    return this.httpAdapter.fetch(req);
  }

  /**
   * Executes a NestJS/Fastify-style in-memory HTTP request directly against
   * `this.fetch()` without binding a network socket.
   */
  async inject(input: string | InjectOptions): Promise<InjectResponse> {
    const req = buildInjectRequest(input);
    const raw = await this.fetch(req);
    const rawPayload = new Uint8Array(await raw.arrayBuffer());
    const body = new TextDecoder().decode(rawPayload);
    const headers = extractInjectHeaders(raw);

    return {
      statusCode: raw.status,
      statusMessage: raw.statusText,
      headers,
      body,
      rawPayload,
      raw,
      json<T = unknown>(): T {
        return JSON.parse(body) as T;
      },
    };
  }

  async listen(
    portOrOptions: number | string | ListenOptions = 3000,
    hostnameOrCallback?: string | (() => void),
    callback?: () => void,
  ): Promise<ListeningServerInfo> {
    // Runs route recompilation + onModuleInit + onApplicationBootstrap BEFORE accepting traffic (ADR-007 §7)
    await this.init();
    const info = await this.httpAdapter.listen(
      portOrOptions,
      hostnameOrCallback,
      callback,
    );
    this.container.getHttpAdapterHost().listening = true;
    return info;
  }

  protected override async prepareClose(): Promise<void> {
    this.httpAdapter.beforeClose();
  }

  protected override async stopTransport(): Promise<void> {
    const errors: unknown[] = [];
    this.container.getHttpAdapterHost().listening = false;

    try {
      await this.httpAdapter.close();
    } catch (err) {
      errors.push(err);
    }

    for (const ms of this.microservices) {
      try {
        await ms.close();
      } catch (err) {
        errors.push(err);
      } finally {
        this.startedMicroservices.delete(ms);
      }
    }

    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(
        errors,
        "Multiple errors occurred while stopping HTTP and microservice transports",
      );
    }
  }

  private wireDiGlobalEnhancers(): void {
    if (this.diEnhancersWired) {
      return;
    }
    this.diEnhancersWired = true;

    const appConfig = this.container.getApplicationConfig();
    const enhancerLogger = new Logger("ApplicationConfig");
    const describeProviderValue = (val: unknown): string => {
      if (typeof val === "function") {
        return `class ${val.name || "anonymous"}`;
      }
      if (Array.isArray(val)) return "an array";
      if (typeof val === "object" && val !== null) return "an object";
      return String(val);
    };

    const collectToken = <T>(
      token: InjectionToken,
      tokenLabel: string,
      methodName: string,
      warnOnly: boolean,
      onRequestScoped?: (wrapper: {
        readonly token: InjectionToken<unknown>;
        readonly metatype: Type<unknown> | Function | undefined;
        readonly instance: unknown;
        readonly moduleRef: ReturnType<DIContainer["getModuleRef"]>;
        readonly moduleId: string;
        readonly scope: Scope;
        readonly isDependencyTreeStatic: boolean;
      }) => void,
    ): T[] => {
      const items: T[] = [];
      for (const entry of this.container.getMultiProviderEntries(token)) {
        if (entry.provider.scope === Scope.REQUEST && onRequestScoped) {
          onRequestScoped({
            token: entry.provider.useClass ?? entry.provider.token,
            metatype: entry.provider.useClass,
            instance: entry.instance,
            moduleRef: this.container.getModuleRef(entry.module.id),
            moduleId: entry.module.id,
            scope: entry.provider.scope,
            isDependencyTreeStatic: false,
          });
        }
        if (entry.syntheticToken) {
          items.push(entry.syntheticToken as unknown as T);
        } else if (entry.instance !== undefined) {
          if (
            entry.provider.kind === "value" &&
            typeof (entry.instance as Record<string, unknown> | null)?.[
              methodName
            ] !== "function"
          ) {
            const valDesc = describeProviderValue(entry.instance);
            const enhancerType =
              tokenLabel === "APP_FILTER"
                ? "exception filter"
                : tokenLabel === "APP_GUARD"
                  ? "guard"
                  : tokenLabel === "APP_PIPE"
                    ? "pipe"
                    : "interceptor";
            const msg = `The ${enhancerType} (${tokenLabel} provider (useValue) gives ${valDesc}) doesn't provide the "${methodName}" method.`;
            if (warnOnly) {
              enhancerLogger.warn(msg);
            } else {
              throw new Error(msg);
            }
          }
          items.push(entry.instance as T);
        } else if (entry.provider.useClass) {
          this.container.registerEnhancerOwner(
            entry.provider.useClass,
            entry.module,
          );
          items.push(entry.provider.useClass as unknown as T);
        }
      }
      return items;
    };

    // Always place DI multi-providers ahead of imperative app.useGlobal*() enhancers
    // consistently in both BunestFactory.create() and TestingModule.createBunestApplication().
    this.httpAdapter.setDiGlobalEnhancers({
      guards: collectToken<GuardLike>(
        APP_GUARD,
        "APP_GUARD",
        "canActivate",
        false,
        (w) => appConfig.addGlobalRequestGuard(w as any),
      ),
      pipes: collectToken<PipeLike>(
        APP_PIPE,
        "APP_PIPE",
        "transform",
        false,
        (w) => appConfig.addGlobalRequestPipe(w as any),
      ),
      interceptors: collectToken<InterceptorLike>(
        APP_INTERCEPTOR,
        "APP_INTERCEPTOR",
        "intercept",
        false,
        (w) => appConfig.addGlobalRequestInterceptor(w as any),
      ),
      filters: collectToken<ExceptionFilterLike>(
        APP_FILTER,
        "APP_FILTER",
        "catch",
        true,
        (w) => appConfig.addGlobalRequestFilter(w as any),
      ),
    });
  }

  private async configureModuleMiddlewares(): Promise<void> {
    if (this.moduleMiddlewaresConfigured) {
      return;
    }
    this.moduleMiddlewaresConfigured = true;

    const compiledConfigs: CompiledMiddlewareConfig[] = [];
    const controllerPrefixes = resolveRouterModulePrefixes(
      this.container.getGraph(),
    );

    for (const mod of this.container.getGraph().topologicalOrder) {
      if (!isConfigurableModule(mod.instance)) {
        continue;
      }

      const consumer = new CoreMiddlewareConsumer(
        mod.id,
        this.httpAdapter,
        undefined,
        controllerPrefixes,
      );
      await mod.instance.configure(consumer);

      for (const cfg of consumer.getConfigs()) {
        if (
          typeof cfg.middleware === "function" &&
          typeof (cfg.middleware as { prototype?: { use?: unknown } }).prototype
            ?.use === "function"
        ) {
          this.container.validateEnhancerClass(
            cfg.middleware as Type<unknown>,
            mod,
          );
        }
        compiledConfigs.push({
          middleware: cfg.middleware,
          include: cfg.include,
          exclude: cfg.exclude,
        });
      }
    }

    if (compiledConfigs.length > 0) {
      this.httpAdapter.registerModuleMiddlewares(compiledConfigs);
      this.routesDirty = true;
    }
  }

  private async recompileRoutesIfNeeded(): Promise<void> {
    if (!this.routesDirty) {
      return;
    }
    for (const entry of this.pendingGlobalEnhancerClasses) {
      this.container.validateEnhancerClass(entry.cls, entry.kind);
    }
    this.pendingGlobalEnhancerClasses.length = 0;

    const controllerPrefixes = resolveRouterModulePrefixes(
      this.container.getGraph(),
    );
    const adapterExt = this.httpAdapter as unknown as ExtendedHttpAdapter;

    if (
      controllerPrefixes.size > 0 &&
      typeof adapterExt.setControllerPrefixes === "function"
    ) {
      adapterExt.setControllerPrefixes(controllerPrefixes);
      await this.httpAdapter.compileControllers(this.controllers);
      this.routesDirty = false;
      return;
    }

    if (controllerPrefixes.size === 0) {
      await this.httpAdapter.compileControllers(this.controllers);
      this.routesDirty = false;
      return;
    }

    // Fallback prefix scoping when the HTTP adapter does not yet implement `setControllerPrefixes`:
    // temporarily apply combined paths for `scanControllers()` and restore exact own metadata in `finally`.
    const snapshots: Array<{
      ctrl: Type<unknown>;
      hadOwn: boolean;
      prevOwn: ControllerMetadata | undefined;
    }> = [];

    try {
      for (const ctrl of this.controllers) {
        const prefixes = controllerPrefixes.get(ctrl);
        if (!prefixes || prefixes.length === 0) {
          continue;
        }
        const effective = MetadataRegistry.get<ControllerMetadata>(
          METADATA_KEYS.CONTROLLER,
          ctrl,
        );
        if (!effective) {
          continue;
        }

        const hadOwn = MetadataRegistry.hasOwn(METADATA_KEYS.CONTROLLER, ctrl);
        const prevOwn = hadOwn
          ? MetadataRegistry.getOwn<ControllerMetadata>(
              METADATA_KEYS.CONTROLLER,
              ctrl,
            )
          : undefined;
        snapshots.push({ ctrl, hadOwn, prevOwn });

        const ctrlPaths = Array.isArray(effective.path)
          ? effective.path.length > 0
            ? effective.path
            : [""]
          : [effective.path];

        const combined: string[] = [];
        for (const prefix of prefixes) {
          for (const ctrlPath of ctrlPaths) {
            const joined = joinRoutePaths(prefix, ctrlPath);
            if (!combined.includes(joined)) {
              combined.push(joined);
            }
          }
        }

        const nextMeta: ControllerMetadata = {
          ...effective,
          path: combined.length === 1 ? combined[0]! : combined,
        };
        MetadataRegistry.define(METADATA_KEYS.CONTROLLER, nextMeta, ctrl);
      }

      await this.httpAdapter.compileControllers(this.controllers);
    } finally {
      for (const snap of snapshots) {
        if (snap.hadOwn && snap.prevOwn !== undefined) {
          MetadataRegistry.define(
            METADATA_KEYS.CONTROLLER,
            snap.prevOwn,
            snap.ctrl,
          );
        } else {
          MetadataRegistry.delete(METADATA_KEYS.CONTROLLER, snap.ctrl);
        }
      }
    }

    this.routesDirty = false;
  }
}
