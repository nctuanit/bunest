import {
  BadRequestException,
  type CookieSerializeOptions,
  type CookiesOptions,
  type CorsOptions,
  type CsrfProtectionOptions,
  type ExceptionFilterLike,
  type GuardLike,
  type HttpSecurityHeadersOptions,
  type HttpsOptions,
  type InterceptorLike,
  Logger,
  type LoggerService,
  type LogLevel,
  MethodNotAllowedException,
  type MiddlewareFunction,
  type NestApplicationOptions,
  NotFoundException,
  type PipeLike,
  type RequestHandler,
  RequestMethod,
  type ResponseContext,
  type RouteConflictPolicy,
  type RouteDefinition,
  type RouteHttpMethod,
  type RouteInfo,
  type RouteMatchingOptions,
  type RouteResolutionStrategy,
  type SecurityRequestHook,
  ServiceUnavailableException,
  type StaticAssetsOptions,
  StreamableFile,
  type Type,
  VERSION_NEUTRAL,
  type VersioningOptions,
  VersioningType,
  type VersionValue,
  type ViewEngineRenderer,
} from "../../common/index";
import { RequestContext } from "../context/request-context";
import { HttpResponseContext } from "../context/response-context";
import type {
  BunHttpAdapterOptions,
  BunServerLike,
  CompiledMiddlewareConfig,
  GlobalPrefixOptions,
  HttpRuntimeBridge,
  ListeningServerInfo,
  ListenOptions,
  MultipartStorageOptions,
  WebSocketHandlerRegistration,
  WebSocketUpgradeHandler,
} from "../interfaces/http-bridge.interface";
import { DefaultExceptionFilter } from "../pipeline/exception-handler";
import {
  executeCompiledRoute,
  executeFallbackException,
  type MiddlewareEntry,
  runAdapterOnRequestHook,
} from "../pipeline/execution-pipeline";
import { mergeHeadersOntoNativeResponse } from "../pipeline/response-serializer";
import {
  type CompiledRouteTable,
  compileRoutes,
} from "../router/route-compiler";
import { scanControllers } from "../scanner/controller-scanner";
import {
  matchesGlobalPrefixExclude,
  matchesRouteInfo,
  normalizePath as normalizeRoutePath,
  type VersionedRouteRule,
} from "../scanner/path-normalizer";
import {
  extractRequestVersions,
  isRuntimeVersioning,
  normalizeVersionValue,
} from "../scanner/version-resolver";
import {
  CookieSigner,
  normalizeCookieSecrets,
  signCookieValue,
} from "../security/cookie";
import {
  createPreflightResponse,
  evaluateCors,
  isCorsPreflightRequest,
  mergeCorsHeaders,
  normalizeCorsOptions,
  type NormalizedCorsOptions,
} from "../security/cors";
import {
  compileCsrfProtection,
  type CompiledCsrfProtection,
} from "../security/csrf-protection";
import {
  applySecurityHeaders,
  compileSecurityHeaders,
  type CompiledSecurityHeaders,
} from "../security/security-headers";
import { isDangerousKey } from "../security/prototype-sanitizer";
import {
  createStaticAssetsMount,
  type ExtendedStaticAssetsOptions,
  type StaticAssetsMount,
  tryServeStaticAsset,
} from "../static/static-assets";
import { AbstractHttpAdapter } from "./abstract-http.adapter";

/**
 * Default standalone bridge used when `@bunest/core/http` runs without `@bunest/core`'s DI container.
 * Instantiates classes once (singleton cache) and passes through pre-instantiated enhancers.
 */
export class DefaultHttpRuntimeBridge implements HttpRuntimeBridge {
  private readonly instances = new Map<Function, object>();

  resolveController(controllerToken: Type<unknown>): object {
    let instance = this.instances.get(controllerToken);
    if (!instance) {
      instance = new controllerToken() as object;
      this.instances.set(controllerToken, instance);
    }
    return instance;
  }

  resolveEnhancer<T = unknown>(enhancer: Type<T> | T): T {
    if (typeof enhancer !== "function") {
      return enhancer;
    }
    const ctor = enhancer as Type<T>;
    let instance = this.instances.get(ctor);
    if (!instance) {
      instance = new ctor() as object;
      this.instances.set(ctor, instance);
    }
    return instance as T;
  }
}

interface RawRouteEntry {
  readonly method: RouteHttpMethod;
  readonly rawPath: string;
  readonly matchAllPaths: boolean;
  readonly segments: readonly string[];
  readonly hasTrailingWildcard: boolean;
  readonly handler: RequestHandler<Request, ResponseContext>;
}

const BYTE_LIMIT_RE = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i;

function parseBodyLimit(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const match = BYTE_LIMIT_RE.exec(value.trim());
  if (!match) {
    return undefined;
  }
  const num = Number(match[1]);
  if (!Number.isFinite(num)) return undefined;
  const unit = (match[2] ?? "b").toLowerCase();
  switch (unit) {
    case "kb":
      return Math.floor(num * 1024);
    case "mb":
      return Math.floor(num * 1024 * 1024);
    case "gb":
      return Math.floor(num * 1024 * 1024 * 1024);
    default:
      return Math.floor(num);
  }
}

function hasMalformedPercentEncoding(pathname: string): boolean {
  if (!pathname.includes("%")) {
    return false;
  }
  try {
    decodeURIComponent(pathname);
    return false;
  } catch {
    return true;
  }
}

function extractPathname(rawUrl: string): string {
  const schemeIdx = rawUrl.indexOf("://");
  const pathStart =
    schemeIdx === -1 ? rawUrl.indexOf("/") : rawUrl.indexOf("/", schemeIdx + 3);
  if (pathStart === -1) return "/";
  let endIdx = rawUrl.length;
  const queryIdx = rawUrl.indexOf("?", pathStart);
  if (queryIdx !== -1 && queryIdx < endIdx) {
    endIdx = queryIdx;
  }
  const hashIdx = rawUrl.indexOf("#", pathStart);
  if (hashIdx !== -1 && hashIdx < endIdx) {
    endIdx = hashIdx;
  }
  return rawUrl.slice(pathStart, endIdx);
}

function resolveLogger(option: BunHttpAdapterOptions["logger"]): LoggerService {
  if (option === false) {
    return new Logger("BunHttpAdapter", { levels: [] });
  }
  if (option === true || option === undefined) {
    return new Logger("BunHttpAdapter");
  }
  if (Array.isArray(option)) {
    return new Logger("BunHttpAdapter", { levels: option });
  }
  return option;
}

function routeMethodToRequestMethod(method: RouteHttpMethod): RequestMethod {
  switch (method) {
    case "GET":
      return RequestMethod.GET;
    case "POST":
      return RequestMethod.POST;
    case "PUT":
      return RequestMethod.PUT;
    case "DELETE":
      return RequestMethod.DELETE;
    case "PATCH":
      return RequestMethod.PATCH;
    case "OPTIONS":
      return RequestMethod.OPTIONS;
    case "HEAD":
      return RequestMethod.HEAD;
    case "SEARCH":
      return RequestMethod.SEARCH;
    case "PROPFIND":
      return RequestMethod.PROPFIND;
    case "PROPPATCH":
      return RequestMethod.PROPPATCH;
    case "MKCOL":
      return RequestMethod.MKCOL;
    case "COPY":
      return RequestMethod.COPY;
    case "MOVE":
      return RequestMethod.MOVE;
    case "LOCK":
      return RequestMethod.LOCK;
    case "UNLOCK":
      return RequestMethod.UNLOCK;
    case "QUERY":
      return RequestMethod.QUERY;
    default:
      return RequestMethod.ALL;
  }
}

function normalizeRawRoutePath(rawPath: string): {
  normalized: string;
  segments: string[];
  hasTrailingWildcard: boolean;
  matchAllPaths: boolean;
} {
  const trimmed = rawPath.trim();
  if (
    trimmed === "" ||
    trimmed === "*" ||
    trimmed === "/*" ||
    trimmed === "{*any}" ||
    trimmed === "/{*any}" ||
    trimmed === "(.*)" ||
    trimmed === "/(.*)"
  ) {
    return {
      normalized: "/*",
      segments: [],
      hasTrailingWildcard: true,
      matchAllPaths: true,
    };
  }
  // Translate Express v5 `{*splat}` / `(.*)` wildcards to `*`
  const translated = trimmed
    .replace(/\{\*[^}]+\}/g, "*")
    .replace(/\(\.\*\)/g, "*");
  const normalized = normalizeRoutePath(translated);
  if (normalized === "/") {
    return {
      normalized: "/",
      segments: [],
      hasTrailingWildcard: false,
      matchAllPaths: false,
    };
  }
  const segs = normalized.slice(1).split("/");
  const hasTrailingWildcard = segs[segs.length - 1] === "*";
  if (hasTrailingWildcard) {
    segs.pop();
  }
  return {
    normalized,
    segments: segs,
    hasTrailingWildcard,
    matchAllPaths: false,
  };
}

function matchRawRoutePath(
  entry: RawRouteEntry,
  pathname: string,
  ignoreTrailingSlash: boolean,
): Record<string, string> | null {
  if (entry.matchAllPaths) {
    return {};
  }
  const cleanPath =
    ignoreTrailingSlash && pathname.length > 1 && pathname.endsWith("/")
      ? pathname.replace(/\/+$/, "") || "/"
      : pathname;
  const reqSegs = cleanPath === "/" ? [] : cleanPath.slice(1).split("/");

  if (entry.hasTrailingWildcard) {
    if (reqSegs.length < entry.segments.length) {
      return null;
    }
  } else if (reqSegs.length !== entry.segments.length) {
    return null;
  }

  const params: Record<string, string> = {};
  for (let i = 0; i < entry.segments.length; i++) {
    const patternSeg = entry.segments[i]!;
    const actualSeg = reqSegs[i]!;
    if (patternSeg === "*") {
      continue;
    }
    if (patternSeg.startsWith(":")) {
      const name = patternSeg.slice(1);
      if (!isDangerousKey(name)) {
        try {
          params[name] = decodeURIComponent(actualSeg);
        } catch {
          params[name] = actualSeg;
        }
      }
      continue;
    }
    if (patternSeg !== actualSeg) {
      return null;
    }
  }
  if (entry.hasTrailingWildcard) {
    params["*"] = reqSegs.slice(entry.segments.length).join("/");
  }
  return params;
}

function matchesSegmentPrefix(
  pathname: string,
  prefix: string | undefined,
): boolean {
  if (!prefix || prefix === "/") {
    return true;
  }
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function applyCorsHeadersToSentResponse(
  response: Response,
  ctx: RequestContext,
): Response {
  const hasCors = ctx.hasCorsHeaders();
  const isEmpty =
    response.status === 204 ||
    response.status === 205 ||
    response.status === 304 ||
    ctx.request.method === "HEAD";
  if (!hasCors && !isEmpty) {
    return response;
  }
  const merged = new Headers(response.headers);
  if (hasCors) {
    ctx.corsHeaders.forEach((value, key) => {
      if (key.toLowerCase() === "vary") {
        const existing = merged.get("vary");
        if (!existing) {
          merged.set("Vary", value);
        } else {
          const tokens = new Set(existing.split(",").map((s) => s.trim()));
          for (const t of value.split(",")) {
            const trimmed = t.trim();
            if (trimmed) tokens.add(trimmed);
          }
          merged.set("Vary", [...tokens].join(", "));
        }
      } else if (!merged.has(key)) {
        merged.set(key, value);
      }
    });
  }
  if (isEmpty) {
    if (response.body) {
      void response.body.cancel().catch(() => {});
    }
    return new Response(null, { status: response.status, headers: merged });
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: merged,
  });
}

function attachParamsToRequest(
  req: Request,
  params: Record<string, string>,
): void {
  try {
    Object.defineProperty(req, "params", {
      value: params,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  } catch {
    // Ignore if Request object is frozen
  }
}

/**
 * Native Bun.serve HTTP adapter extending `AbstractHttpAdapter` (ADR-001: Bun-only)
 * implementing hybrid routing (ADR-011), the 11-stage execution pipeline (ADR-008),
 * native Response serialization (ADR-010), imperative raw route registration,
 * API Versioning, `RouterModule` prefixes, `rawBody`, `StreamableFile`,
 * `useStaticAssets`, `ServeStaticModule`, and streaming multipart disk storage.
 */
export class BunHttpAdapter extends AbstractHttpAdapter<
  BunServerLike | undefined,
  Request,
  ResponseContext
> {
  private bridge: HttpRuntimeBridge = new DefaultHttpRuntimeBridge();
  private globalPrefix?: string | readonly string[];
  private globalPrefixOptions?: GlobalPrefixOptions;
  private controllerPrefixes?: Map<Type<unknown>, readonly string[]>;
  private versioningOptions?: VersioningOptions;
  private routeConflictPolicy?: RouteConflictPolicy;
  private routeResolutionStrategy?: RouteResolutionStrategy;
  private corsOptions?: NormalizedCorsOptions;
  private csrfOptions?: CsrfProtectionOptions<Request>;
  private csrfProtection?: CompiledCsrfProtection;
  private securityHeaders?: CompiledSecurityHeaders;
  private cookieSecrets?: readonly string[];
  private bodyLimit?: number;
  private bodyParserEnabled: boolean;
  private rawBodyEnabled: boolean;
  private multipartOptions?: MultipartStorageOptions;
  private ignoreTrailingSlash: boolean;
  private trustProxy?: boolean | number | string[];
  private abortOnError: boolean;
  private development?: boolean;
  private httpsOptions?: HttpsOptions;
  private forceCloseConnections: boolean;
  private return503OnClosing: boolean;
  private isClosing = false;
  private inFlightRequests = 0;
  private drainResolvers: Array<() => void> = [];
  private readonly beforeCloseHooks: Array<() => void> = [];
  private baseViewsDir?: string;
  private viewRenderer?: ViewEngineRenderer;
  private logger: LoggerService;

  private readonly staticAssetsMounts: StaticAssetsMount[] = [];
  private readonly globalMiddlewares: MiddlewareEntry[] = [];
  private readonly moduleMiddlewares: CompiledMiddlewareConfig[] = [];
  private readonly rawRoutes: RawRouteEntry[] = [];
  private readonly securityHooks: SecurityRequestHook<Request>[] = [];
  private onRequestHookFn?: Function;
  private onResponseHookFn?: Function;
  private customErrorHandler?: {
    readonly handler: Function;
    readonly prefix?: string;
  };
  private customNotFoundHandler?: {
    readonly handler: Function;
    readonly prefix?: string;
    readonly excludedRoutes?: RouteInfo[];
  };

  private diGlobalGuards: GuardLike[] = [];
  private diGlobalPipes: PipeLike[] = [];
  private diGlobalInterceptors: InterceptorLike[] = [];
  private diGlobalFilters: ExceptionFilterLike[] = [];
  private readonly globalGuards: GuardLike[] = [];
  private readonly globalPipes: PipeLike[] = [];
  private readonly globalInterceptors: InterceptorLike[] = [];
  private readonly globalFilters: ExceptionFilterLike[] = [];

  private readonly websocketRegistrations = new Map<
    string,
    WebSocketHandlerRegistration
  >();
  private websocketConfig?: unknown;

  private registeredControllers: Type<unknown>[] = [];
  private compiledTable?: CompiledRouteTable;

  constructor(options: BunHttpAdapterOptions = {}) {
    super(undefined);
    this.instance = this;
    this.httpServer = undefined;
    this.logger = resolveLogger(options.logger);
    this.corsOptions = normalizeCorsOptions(options.cors);
    this.bodyLimit = options.bodyLimit;
    this.bodyParserEnabled = options.bodyParser !== false;
    this.rawBodyEnabled = options.rawBody === true;
    this.multipartOptions = options.multipart
      ? { ...options.multipart }
      : undefined;
    this.globalPrefix = options.globalPrefix;
    this.routeConflictPolicy = options.routeConflictPolicy;
    this.routeResolutionStrategy = options.routeResolutionStrategy;
    this.ignoreTrailingSlash = options.ignoreTrailingSlash ?? false;
    this.trustProxy = options.trustProxy;
    this.abortOnError = options.abortOnError ?? true;
    this.development = options.development;
    this.httpsOptions = options.httpsOptions;
    this.forceCloseConnections = options.forceCloseConnections ?? false;
    this.return503OnClosing = options.return503OnClosing === true;
    if (options.cookies?.secret !== undefined) {
      this.cookieSecrets = normalizeCookieSecrets(options.cookies.secret);
      this.cookieSigner = new CookieSigner(options.cookies.secret);
    }
  }

  override async init(): Promise<void> {
    // Idempotent async setup hook (matches AbstractHttpAdapter.init)
  }

  initHttpServer(options: NestApplicationOptions = {}): void {
    if (options.httpsOptions !== undefined) {
      this.httpsOptions = options.httpsOptions;
    }
    if (options.forceCloseConnections !== undefined) {
      this.forceCloseConnections = options.forceCloseConnections;
    }
    if (options.return503OnClosing !== undefined) {
      this.return503OnClosing = options.return503OnClosing;
    }
    if (options.bodyParser !== undefined) {
      this.bodyParserEnabled = options.bodyParser;
    }
    if (options.rawBody !== undefined) {
      this.rawBodyEnabled = options.rawBody;
    }
    if (options.bodyLimit !== undefined) {
      this.bodyLimit = options.bodyLimit;
    }
    if (options.ignoreTrailingSlash !== undefined) {
      this.ignoreTrailingSlash = options.ignoreTrailingSlash;
    }
    if (options.trustProxy !== undefined) {
      this.trustProxy = options.trustProxy;
    }
    if (options.development !== undefined) {
      this.development = options.development;
    }
    if (options.routeConflictPolicy !== undefined) {
      this.routeConflictPolicy = options.routeConflictPolicy;
    }
    if (options.routeResolutionStrategy !== undefined) {
      this.routeResolutionStrategy = options.routeResolutionStrategy;
    }
    if (options.cors !== undefined) {
      this.corsOptions = normalizeCorsOptions(options.cors);
    }
    if (options.cookies?.secret !== undefined) {
      this.setCookiesOptions(options.cookies);
    }
  }

  onBeforeClose(hook: () => void): void {
    this.beforeCloseHooks.push(hook);
  }

  override beforeClose(): void {
    this.isClosing = true;
    for (const hook of this.beforeCloseHooks.splice(0)) {
      try {
        hook();
      } catch {
        // Ignore teardown hook errors during close preparation
      }
    }
  }

  setBridge(bridge: HttpRuntimeBridge): this {
    this.bridge = bridge;
    return this;
  }

  getBridge(): HttpRuntimeBridge {
    return this.bridge;
  }

  setGlobalPrefix(
    prefix: string | readonly string[],
    options?: GlobalPrefixOptions,
  ): this {
    this.globalPrefix = Array.isArray(prefix) ? [...prefix] : prefix;
    this.globalPrefixOptions = options;
    return this;
  }

  getGlobalPrefix(): string | readonly string[] | undefined {
    return this.globalPrefix;
  }

  getGlobalPrefixOptions(): GlobalPrefixOptions | undefined {
    return this.globalPrefixOptions;
  }

  setRouteConflictPolicy(policy: RouteConflictPolicy): this {
    this.routeConflictPolicy = policy;
    return this;
  }

  setRouteResolutionStrategy(strategy: RouteResolutionStrategy): this {
    this.routeResolutionStrategy = strategy;
    return this;
  }

  enableCsrfProtection(options: CsrfProtectionOptions<Request> = {}): this {
    this.csrfOptions = options;
    const prefix = Array.isArray(this.globalPrefix)
      ? this.globalPrefix[0]
      : typeof this.globalPrefix === "string"
        ? this.globalPrefix
        : undefined;
    this.csrfProtection = compileCsrfProtection(options, prefix);
    return this;
  }

  useSecurityHeaders(options: HttpSecurityHeadersOptions = {}): this {
    this.securityHeaders = compileSecurityHeaders(options);
    return this;
  }

  setCookiesOptions(options: CookiesOptions): this {
    this.cookieSecrets = normalizeCookieSecrets(options.secret);
    this.cookieSigner =
      options.secret !== undefined
        ? new CookieSigner(options.secret)
        : undefined;
    return this;
  }

  override setCookieSigner(signer: CookieSigner | undefined): void {
    this.cookieSigner = signer;
    this.cookieSecrets = signer ? signer.getSecrets() : undefined;
  }

  setBodyParser(enabled: boolean): this {
    this.bodyParserEnabled = enabled;
    return this;
  }

  registerParserMiddleware(_prefix?: string, rawBody?: boolean): this {
    this.bodyParserEnabled = true;
    if (rawBody !== undefined) {
      this.rawBodyEnabled = rawBody;
    }
    return this;
  }

  useBodyParser(
    typeOrOptions?: string | Record<string, unknown>,
    options?: Record<string, unknown>,
  ): this {
    this.bodyParserEnabled = true;
    const opts =
      typeof typeOrOptions === "object" && typeOrOptions !== null
        ? typeOrOptions
        : options;
    if (opts) {
      const parsedLimit = parseBodyLimit(opts.limit);
      if (parsedLimit !== undefined) {
        this.bodyLimit = parsedLimit;
      }
      if (typeof opts.rawBody === "boolean") {
        this.rawBodyEnabled = opts.rawBody;
      }
    }
    return this;
  }

  setReturn503OnClosing(enabled: boolean): this {
    this.return503OnClosing = enabled;
    return this;
  }

  setForceCloseConnections(enabled: boolean): this {
    this.forceCloseConnections = enabled;
    return this;
  }

  setHttpsOptions(options: HttpsOptions | undefined): this {
    this.httpsOptions = options;
    return this;
  }

  setBaseViewsDir(dir: string | string[]): this {
    this.baseViewsDir = Array.isArray(dir) ? dir[0] : dir;
    return this;
  }

  setViewEngine(engine: string | ViewEngineRenderer): this {
    if (typeof engine === "function") {
      this.viewRenderer = engine;
    } else {
      // Lightweight default interpolation renderer for named templates (e.g. "html")
      this.viewRenderer = async (template, data, ctx) => {
        const base = ctx?.baseViewsDir ?? this.baseViewsDir ?? ".";
        const filePath = template.includes(".")
          ? `${base}/${template}`
          : `${base}/${template}.${engine}`;
        const content = await Bun.file(filePath).text();
        return content.replace(
          /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g,
          (_m, key) => {
            const val = (data as Record<string, unknown>)[key];
            return val !== undefined && val !== null ? String(val) : "";
          },
        );
      };
    }
    return this;
  }

  // =========================================================================
  // NestJS AbstractHttpAdapter / HttpServer Imperative Verb Registration (17)
  // =========================================================================

  private registerRawRoute(
    method: RouteHttpMethod,
    pathOrHandler: string | RequestHandler<Request, ResponseContext>,
    maybeHandler?: RequestHandler<Request, ResponseContext>,
  ): this {
    let rawPath: string;
    let handler: RequestHandler<Request, ResponseContext>;

    if (typeof pathOrHandler === "function") {
      rawPath = "*";
      handler = pathOrHandler;
    } else {
      rawPath = String(pathOrHandler);
      handler = maybeHandler!;
    }

    if (typeof handler !== "function") {
      throw new TypeError(
        `BunHttpAdapter.${method.toLowerCase()}() requires a RequestHandler function.`,
      );
    }

    const parsed = normalizeRawRoutePath(rawPath);
    this.rawRoutes.push({
      method,
      rawPath: parsed.normalized,
      matchAllPaths: parsed.matchAllPaths,
      segments: parsed.segments,
      hasTrailingWildcard: parsed.hasTrailingWildcard,
      handler,
    });
    return this;
  }

  override get(handler: RequestHandler<Request, ResponseContext>): this;
  override get(
    path: string,
    handler: RequestHandler<Request, ResponseContext>,
  ): this;
  override get(
    pathOrHandler: string | RequestHandler<Request, ResponseContext>,
    handler?: RequestHandler<Request, ResponseContext>,
  ): this {
    return this.registerRawRoute("GET", pathOrHandler, handler);
  }

  override post(handler: RequestHandler<Request, ResponseContext>): this;
  override post(
    path: string,
    handler: RequestHandler<Request, ResponseContext>,
  ): this;
  override post(
    pathOrHandler: string | RequestHandler<Request, ResponseContext>,
    handler?: RequestHandler<Request, ResponseContext>,
  ): this {
    return this.registerRawRoute("POST", pathOrHandler, handler);
  }

  override put(handler: RequestHandler<Request, ResponseContext>): this;
  override put(
    path: string,
    handler: RequestHandler<Request, ResponseContext>,
  ): this;
  override put(
    pathOrHandler: string | RequestHandler<Request, ResponseContext>,
    handler?: RequestHandler<Request, ResponseContext>,
  ): this {
    return this.registerRawRoute("PUT", pathOrHandler, handler);
  }

  override patch(handler: RequestHandler<Request, ResponseContext>): this;
  override patch(
    path: string,
    handler: RequestHandler<Request, ResponseContext>,
  ): this;
  override patch(
    pathOrHandler: string | RequestHandler<Request, ResponseContext>,
    handler?: RequestHandler<Request, ResponseContext>,
  ): this {
    return this.registerRawRoute("PATCH", pathOrHandler, handler);
  }

  override delete(handler: RequestHandler<Request, ResponseContext>): this;
  override delete(
    path: string,
    handler: RequestHandler<Request, ResponseContext>,
  ): this;
  override delete(
    pathOrHandler: string | RequestHandler<Request, ResponseContext>,
    handler?: RequestHandler<Request, ResponseContext>,
  ): this {
    return this.registerRawRoute("DELETE", pathOrHandler, handler);
  }

  override options(handler: RequestHandler<Request, ResponseContext>): this;
  override options(
    path: string,
    handler: RequestHandler<Request, ResponseContext>,
  ): this;
  override options(
    pathOrHandler: string | RequestHandler<Request, ResponseContext>,
    handler?: RequestHandler<Request, ResponseContext>,
  ): this {
    return this.registerRawRoute("OPTIONS", pathOrHandler, handler);
  }

  override head(handler: RequestHandler<Request, ResponseContext>): this;
  override head(
    path: string,
    handler: RequestHandler<Request, ResponseContext>,
  ): this;
  override head(
    pathOrHandler: string | RequestHandler<Request, ResponseContext>,
    handler?: RequestHandler<Request, ResponseContext>,
  ): this {
    return this.registerRawRoute("HEAD", pathOrHandler, handler);
  }

  override all(handler: RequestHandler<Request, ResponseContext>): this;
  override all(
    path: string,
    handler: RequestHandler<Request, ResponseContext>,
  ): this;
  override all(
    pathOrHandler: string | RequestHandler<Request, ResponseContext>,
    handler?: RequestHandler<Request, ResponseContext>,
  ): this {
    return this.registerRawRoute("ALL", pathOrHandler, handler);
  }

  override search(handler: RequestHandler<Request, ResponseContext>): this;
  override search(
    path: string,
    handler: RequestHandler<Request, ResponseContext>,
  ): this;
  override search(
    pathOrHandler: string | RequestHandler<Request, ResponseContext>,
    handler?: RequestHandler<Request, ResponseContext>,
  ): this {
    return this.registerRawRoute("SEARCH", pathOrHandler, handler);
  }

  override propfind(handler: RequestHandler<Request, ResponseContext>): this;
  override propfind(
    path: string,
    handler: RequestHandler<Request, ResponseContext>,
  ): this;
  override propfind(
    pathOrHandler: string | RequestHandler<Request, ResponseContext>,
    handler?: RequestHandler<Request, ResponseContext>,
  ): this {
    return this.registerRawRoute("PROPFIND", pathOrHandler, handler);
  }

  override proppatch(handler: RequestHandler<Request, ResponseContext>): this;
  override proppatch(
    path: string,
    handler: RequestHandler<Request, ResponseContext>,
  ): this;
  override proppatch(
    pathOrHandler: string | RequestHandler<Request, ResponseContext>,
    handler?: RequestHandler<Request, ResponseContext>,
  ): this {
    return this.registerRawRoute("PROPPATCH", pathOrHandler, handler);
  }

  override mkcol(handler: RequestHandler<Request, ResponseContext>): this;
  override mkcol(
    path: string,
    handler: RequestHandler<Request, ResponseContext>,
  ): this;
  override mkcol(
    pathOrHandler: string | RequestHandler<Request, ResponseContext>,
    handler?: RequestHandler<Request, ResponseContext>,
  ): this {
    return this.registerRawRoute("MKCOL", pathOrHandler, handler);
  }

  override copy(handler: RequestHandler<Request, ResponseContext>): this;
  override copy(
    path: string,
    handler: RequestHandler<Request, ResponseContext>,
  ): this;
  override copy(
    pathOrHandler: string | RequestHandler<Request, ResponseContext>,
    handler?: RequestHandler<Request, ResponseContext>,
  ): this {
    return this.registerRawRoute("COPY", pathOrHandler, handler);
  }

  override move(handler: RequestHandler<Request, ResponseContext>): this;
  override move(
    path: string,
    handler: RequestHandler<Request, ResponseContext>,
  ): this;
  override move(
    pathOrHandler: string | RequestHandler<Request, ResponseContext>,
    handler?: RequestHandler<Request, ResponseContext>,
  ): this {
    return this.registerRawRoute("MOVE", pathOrHandler, handler);
  }

  override lock(handler: RequestHandler<Request, ResponseContext>): this;
  override lock(
    path: string,
    handler: RequestHandler<Request, ResponseContext>,
  ): this;
  override lock(
    pathOrHandler: string | RequestHandler<Request, ResponseContext>,
    handler?: RequestHandler<Request, ResponseContext>,
  ): this {
    return this.registerRawRoute("LOCK", pathOrHandler, handler);
  }

  override unlock(handler: RequestHandler<Request, ResponseContext>): this;
  override unlock(
    path: string,
    handler: RequestHandler<Request, ResponseContext>,
  ): this;
  override unlock(
    pathOrHandler: string | RequestHandler<Request, ResponseContext>,
    handler?: RequestHandler<Request, ResponseContext>,
  ): this {
    return this.registerRawRoute("UNLOCK", pathOrHandler, handler);
  }

  override query(handler: RequestHandler<Request, ResponseContext>): this;
  override query(
    path: string,
    handler: RequestHandler<Request, ResponseContext>,
  ): this;
  override query(
    pathOrHandler: string | RequestHandler<Request, ResponseContext>,
    handler?: RequestHandler<Request, ResponseContext>,
  ): this {
    return this.registerRawRoute("QUERY", pathOrHandler, handler);
  }

  // =========================================================================
  // NestJS HttpServer / AbstractHttpAdapter Compatibility Helpers
  // =========================================================================

  getType(): string {
    return "bun";
  }

  override getHttpServer(): BunServerLike | undefined {
    return this.httpServer;
  }

  override setHttpServer(httpServer: BunServerLike | undefined): void {
    this.httpServer = httpServer;
  }

  override getInstance<T = any>(): T {
    return (this.instance ?? this) as unknown as T;
  }

  override normalizePath(path: string): string {
    const translated = path.replace(/\{\*[^}]+\}/g, "*");
    return normalizeRoutePath(translated);
  }

  isRouteOrderSensitive(): boolean {
    return this.routeResolutionStrategy !== "specificity";
  }

  getRouteMatchingOptions(): RouteMatchingOptions {
    return {
      caseSensitive: true,
      ignoreTrailingSlash: this.ignoreTrailingSlash,
      removesTrailingSlash: this.ignoreTrailingSlash,
    };
  }

  override setOnRequestHook(onRequestHook: Function): void {
    this.onRequestHookFn = onRequestHook;
    this.compiledTable = undefined;
  }

  override setOnResponseHook(onResponseHook: Function): void {
    this.onResponseHookFn = onResponseHook;
    this.compiledTable = undefined;
  }

  override registerSecurityHook(hook: SecurityRequestHook<Request>): this {
    this.securityHooks.push(hook);
    return this;
  }

  setErrorHandler(handler: Function, prefix?: string): this {
    this.customErrorHandler = {
      handler,
      prefix: prefix ? normalizeRoutePath(prefix) : undefined,
    };
    return this;
  }

  setNotFoundHandler(
    handler: Function,
    prefix?: string,
    excludedRoutes?: RouteInfo[],
  ): this {
    this.customNotFoundHandler = {
      handler,
      prefix: prefix ? normalizeRoutePath(prefix) : undefined,
      excludedRoutes,
    };
    return this;
  }

  override mapException(error: unknown): unknown {
    if (error instanceof SyntaxError) {
      return new BadRequestException(error.message);
    }
    return error;
  }

  createMiddlewareFactory(
    requestMethod: RequestMethod,
  ): (path: string, callback: Function) => this {
    return (path: string, callback: Function) => {
      this.registerModuleMiddlewares([
        {
          middleware: callback as MiddlewareFunction,
          include: [{ path, method: requestMethod }],
        },
      ]);
      return this;
    };
  }

  applyVersionFilter(
    handler: Function,
    version: VersionValue,
    versioningOptions: VersioningOptions,
  ): (req: Request, res: ResponseContext, next: () => void) => Function {
    const allowedVersions = normalizeVersionValue(version) ?? [];
    const hasNeutral = allowedVersions.includes(VERSION_NEUTRAL);

    return (req: Request, res: ResponseContext, next: () => void) => {
      if (hasNeutral && versioningOptions.type === VersioningType.URI) {
        return handler(req, res, next);
      }
      const requested = extractRequestVersions(req, versioningOptions);
      for (let i = 0; i < requested.length; i++) {
        if (allowedVersions.includes(requested[i]!)) {
          return handler(req, res, next);
        }
      }
      if (hasNeutral && requested.length === 0) {
        return handler(req, res, next);
      }
      return next() as unknown as Function;
    };
  }

  getRequestMethod(request: Request): string {
    return request.method;
  }

  getRequestUrl(request: Request): string {
    return request.url;
  }

  getRequestHostname(request: Request): string {
    return request.headers.get("host") ?? new URL(request.url).hostname;
  }

  status(response: ResponseContext, statusCode: number): ResponseContext {
    return response.status(statusCode);
  }

  getHeader(response: unknown, name: string): string | undefined {
    if (!response || typeof response !== "object") return undefined;
    if (response instanceof HttpResponseContext) {
      return response.getHeader(name);
    }
    const resObj = response as {
      getHeader?: (n: string) => string | undefined | null;
      getHeaders?: () => Headers | Record<string, string | undefined>;
    };
    if (typeof resObj.getHeader === "function") {
      return resObj.getHeader(name) ?? undefined;
    }
    if (typeof resObj.getHeaders === "function") {
      const headers = resObj.getHeaders();
      if (headers instanceof Headers) {
        return headers.get(name) ?? undefined;
      }
      if (headers && typeof headers === "object") {
        return headers[name.toLowerCase()] ?? headers[name];
      }
    }
    return undefined;
  }

  isHeadersSent(response: unknown): boolean {
    if (!response || typeof response !== "object") return false;
    if (response instanceof HttpResponseContext) {
      return response.isHeadersSent();
    }
    const resObj = response as {
      isHeadersSent?: () => boolean;
      headersSent?: unknown;
    };
    if (typeof resObj.isHeadersSent === "function") {
      return Boolean(resObj.isHeadersSent());
    }
    return Boolean(resObj.headersSent);
  }

  setHeader(
    response: ResponseContext,
    name: string,
    value: string,
  ): ResponseContext {
    return response.header(name, value);
  }

  appendHeader(
    response: ResponseContext,
    name: string,
    value: string,
  ): ResponseContext {
    return response.appendHeader(name, value);
  }

  override setCookie(
    response: ResponseContext,
    name: string,
    value: string,
    options?: CookieSerializeOptions,
  ): ResponseContext {
    return super.setCookie(
      response,
      name,
      value,
      options,
    ) as ResponseContext;
  }

  override clearCookie(
    response: ResponseContext,
    name: string,
    options?: CookieSerializeOptions,
  ): ResponseContext {
    return super.clearCookie(response, name, options) as ResponseContext;
  }

  private buildHeadersFromResponse(
    response: ResponseContext | undefined,
  ): Headers {
    const headers = new Headers();
    if (!response) {
      return headers;
    }
    const rawHeaders =
      response instanceof HttpResponseContext
        ? response.getHeadersIfInitialized()
        : response.getHeaders();
    if (rawHeaders) {
      rawHeaders.forEach((value, key) => {
        if (key.toLowerCase() === "set-cookie") return;
        headers.set(key, value);
      });
    }
    const maybeWithCookies = response as unknown as {
      getSetCookies?: () => readonly string[];
    };
    const setCookies =
      response instanceof HttpResponseContext
        ? response.getSetCookies()
        : typeof maybeWithCookies.getSetCookies === "function"
          ? maybeWithCookies.getSetCookies()
          : [];
    for (const cookie of setCookies) {
      headers.append("Set-Cookie", cookie);
    }
    return headers;
  }

  reply(
    response: ResponseContext | undefined,
    body: unknown,
    statusCode?: number,
  ): Response {
    const status = statusCode ?? response?.getStatus() ?? 200;
    const headers = this.buildHeadersFromResponse(response);

    let finalResponse: Response;
    if (body instanceof Response) {
      finalResponse = body;
    } else if (body instanceof StreamableFile) {
      const fileHeaders = body.getHeaders();
      if (fileHeaders.type && !headers.has("content-type")) {
        headers.set("Content-Type", fileHeaders.type);
      }
      if (fileHeaders.disposition && !headers.has("content-disposition")) {
        headers.set("Content-Disposition", fileHeaders.disposition);
      }
      if (fileHeaders.length !== undefined && !headers.has("content-length")) {
        headers.set("Content-Length", String(fileHeaders.length));
      }
      finalResponse = new Response(body.getStream(), { status, headers });
    } else if (body instanceof ReadableStream) {
      if (!headers.has("content-type")) {
        headers.set("Content-Type", "application/octet-stream");
      }
      finalResponse = new Response(body, { status, headers });
    } else if (body instanceof Blob) {
      if (!headers.has("content-type")) {
        headers.set("Content-Type", body.type || "application/octet-stream");
      }
      finalResponse = new Response(body, { status, headers });
    } else if (
      body instanceof Uint8Array ||
      body instanceof ArrayBuffer ||
      ArrayBuffer.isView(body)
    ) {
      if (!headers.has("content-type")) {
        headers.set("Content-Type", "application/octet-stream");
      }
      const binaryBody =
        body instanceof Uint8Array || body instanceof ArrayBuffer
          ? body
          : new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
      finalResponse = new Response(binaryBody, { status, headers });
    } else if (body === null || body === undefined) {
      finalResponse = new Response(null, { status, headers });
    } else if (typeof body === "string") {
      if (!headers.has("content-type")) {
        headers.set("Content-Type", "text/plain; charset=utf-8");
      }
      finalResponse = new Response(body, { status, headers });
    } else {
      if (!headers.has("content-type")) {
        headers.set("Content-Type", "application/json; charset=utf-8");
      }
      finalResponse = new Response(JSON.stringify(body), { status, headers });
    }

    if (response instanceof HttpResponseContext) {
      response.markHeadersSent(finalResponse);
    }
    return finalResponse;
  }

  end(response: ResponseContext | undefined, message?: string): Response {
    const status = response?.getStatus() ?? 200;
    const headers = this.buildHeadersFromResponse(response);
    const finalResponse = new Response(message ?? null, { status, headers });
    if (response instanceof HttpResponseContext) {
      response.markHeadersSent(finalResponse);
    }
    return finalResponse;
  }

  redirect(
    response: ResponseContext | undefined,
    statusCode: number,
    url: string,
  ): Response {
    if (response) {
      response.status(statusCode);
      response.header("Location", url);
    }
    const headers = this.buildHeadersFromResponse(response);
    headers.set("Location", url);
    const finalResponse = new Response(null, { status: statusCode, headers });
    if (response instanceof HttpResponseContext) {
      response.markHeadersSent(finalResponse);
    }
    return finalResponse;
  }

  async render(
    response: ResponseContext | undefined,
    view: string,
    options: Record<string, unknown> = {},
  ): Promise<Response> {
    if (!this.viewRenderer) {
      throw new Error(
        `Cannot render view "${view}": no view engine configured. Call setViewEngine() first.`,
      );
    }
    const html = await this.viewRenderer(view, options ?? {}, {
      baseViewsDir: this.baseViewsDir,
    });
    if (response) {
      response.header("Content-Type", "text/html; charset=utf-8");
    }
    const status = response?.getStatus() ?? 200;
    const headers = this.buildHeadersFromResponse(response);
    headers.set("Content-Type", "text/html; charset=utf-8");
    const finalResponse = new Response(html, { status, headers });
    if (response instanceof HttpResponseContext) {
      response.markHeadersSent(finalResponse);
    }
    return finalResponse;
  }

  setControllerPrefixes(
    prefixMap: ReadonlyMap<Type<unknown>, string | readonly string[]>,
  ): this {
    const normalized = new Map<Type<unknown>, readonly string[]>();
    for (const [ctrl, entry] of prefixMap.entries()) {
      if (Array.isArray(entry)) {
        normalized.set(ctrl, [...entry]);
      } else if (typeof entry === "string") {
        normalized.set(ctrl, [entry]);
      }
    }
    this.controllerPrefixes = normalized;
    return this;
  }

  enableVersioning(
    options: VersioningOptions = { type: VersioningType.URI },
  ): this {
    this.versioningOptions = options;
    return this;
  }

  getVersioningOptions(): VersioningOptions | undefined {
    return this.versioningOptions;
  }

  useStaticAssets(
    rootDirOrOptions: string | ExtendedStaticAssetsOptions,
    options?: StaticAssetsOptions | ExtendedStaticAssetsOptions,
  ): this {
    if (typeof rootDirOrOptions === "string") {
      this.staticAssetsMounts.push(
        createStaticAssetsMount(rootDirOrOptions, options),
      );
    } else if (rootDirOrOptions && typeof rootDirOrOptions === "object") {
      const rootDir =
        ((rootDirOrOptions as Record<string, unknown>).root as string) ??
        ((rootDirOrOptions as Record<string, unknown>).rootPath as string) ??
        ".";
      this.staticAssetsMounts.push(
        createStaticAssetsMount(rootDir, rootDirOrOptions),
      );
    }
    return this;
  }

  addStaticAssetsMount(mount: StaticAssetsMount): this {
    this.staticAssetsMounts.push(mount);
    return this;
  }

  getStaticAssetsMounts(): readonly StaticAssetsMount[] {
    return [...this.staticAssetsMounts];
  }

  enableCors(options: boolean | CorsOptions = true, _prefix?: string): this {
    this.corsOptions = normalizeCorsOptions(options);
    return this;
  }

  setBodyLimit(bytes: number | undefined): this {
    this.bodyLimit = bytes;
    return this;
  }

  setRawBody(enabled: boolean): this {
    this.rawBodyEnabled = enabled;
    return this;
  }

  getRawBodyEnabled(): boolean {
    return this.rawBodyEnabled;
  }

  setMultipartOptions(options: MultipartStorageOptions | undefined): this {
    this.multipartOptions = options ? { ...options } : undefined;
    return this;
  }

  setTrustProxy(trustProxy: boolean | number | string[]): this {
    this.trustProxy = trustProxy;
    return this;
  }

  setIgnoreTrailingSlash(ignore: boolean): this {
    this.ignoreTrailingSlash = ignore;
    return this;
  }

  setAbortOnError(abortOnError: boolean): this {
    this.abortOnError = abortOnError;
    return this;
  }

  setLogger(logger: LoggerService | LogLevel[] | boolean): this {
    this.logger = resolveLogger(logger);
    return this;
  }

  getLogger(): LoggerService {
    return this.logger;
  }

  setDiGlobalEnhancers(enhancers: {
    guards?: readonly GuardLike[];
    pipes?: readonly PipeLike[];
    interceptors?: readonly InterceptorLike[];
    filters?: readonly ExceptionFilterLike[];
  }): this {
    if (enhancers.guards !== undefined) {
      this.diGlobalGuards = [...enhancers.guards];
    }
    if (enhancers.pipes !== undefined) {
      this.diGlobalPipes = [...enhancers.pipes];
    }
    if (enhancers.interceptors !== undefined) {
      this.diGlobalInterceptors = [...enhancers.interceptors];
    }
    if (enhancers.filters !== undefined) {
      this.diGlobalFilters = [...enhancers.filters];
    }
    return this;
  }

  override use(...middlewares: MiddlewareEntry[]): this {
    this.globalMiddlewares.push(...middlewares);
    return this;
  }

  registerModuleMiddlewares(
    configs: readonly CompiledMiddlewareConfig[],
  ): this {
    this.moduleMiddlewares.push(...configs);
    return this;
  }

  useGlobalGuards(...guards: GuardLike[]): this {
    this.globalGuards.push(...guards);
    return this;
  }

  useGlobalPipes(...pipes: PipeLike[]): this {
    this.globalPipes.push(...pipes);
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

  registerWebsocketHandler(
    path: string,
    upgrade: WebSocketUpgradeHandler,
    websocket?: unknown,
  ): this {
    const normalized = normalizeRoutePath(path);
    this.websocketRegistrations.set(normalized, {
      path: normalized,
      upgrade,
      websocket,
    });
    if (websocket !== undefined) {
      this.websocketConfig = websocket;
    }
    return this;
  }

  async compileControllers(
    controllers: readonly Type<unknown>[],
  ): Promise<readonly RouteDefinition[]> {
    this.registeredControllers = [...controllers];

    const scannedRoutes = scanControllers(this.registeredControllers, {
      globalPrefix: this.globalPrefix,
      globalPrefixOptions: this.globalPrefixOptions,
      controllerPrefixes: this.controllerPrefixes,
      versioning: this.versioningOptions,
      routeConflictPolicy: this.routeConflictPolicy,
      routeResolutionStrategy: this.routeResolutionStrategy,
      logger: this.logger,
    });

    if (this.csrfOptions) {
      const prefix = Array.isArray(this.globalPrefix)
        ? this.globalPrefix[0]
        : typeof this.globalPrefix === "string"
          ? this.globalPrefix
          : undefined;
      this.csrfProtection = compileCsrfProtection(
        this.csrfOptions,
        prefix,
        this.globalPrefixOptions?.exclude,
        this.versioningOptions,
      );
    }

    const defaultFilter = new DefaultExceptionFilter({
      development: () => this.development,
      logger: () => this.logger,
    });

    this.compiledTable = await compileRoutes({
      scannedRoutes,
      bridge: this.bridge,
      globalMiddlewares: this.globalMiddlewares,
      moduleMiddlewares: this.moduleMiddlewares,
      globalGuards: [...this.diGlobalGuards, ...this.globalGuards],
      globalPipes: [...this.diGlobalPipes, ...this.globalPipes],
      globalInterceptors: [
        ...this.diGlobalInterceptors,
        ...this.globalInterceptors,
      ],
      globalFilters: [...this.diGlobalFilters, ...this.globalFilters],
      cors: this.corsOptions,
      csrfProtection: this.csrfProtection,
      securityHeaders: this.securityHeaders,
      cookieSecrets: this.cookieSecrets,
      bodyLimit: this.bodyLimit,
      bodyParser: this.bodyParserEnabled,
      rawBody: this.rawBodyEnabled,
      multipart: this.multipartOptions,
      versioning: this.versioningOptions,
      trustProxy: this.trustProxy,
      viewRenderer: this.viewRenderer,
      baseViewsDir: this.baseViewsDir,
      defaultFilter,
      onRequestHook: this.onRequestHookFn,
      onResponseHook: this.onResponseHookFn,
      onVersionNotFound:
        this.moduleMiddlewares.length > 0
          ? async (req, server, pathname) => {
              const tbl = await this.ensureCompiled();
              return this.tryDispatchStandaloneModuleMiddlewares(
                tbl,
                pathname,
                req,
                server,
              );
            }
          : undefined,
      onRouteTriggered: this.onRouteTriggered,
      securityHooks: this.securityHooks,
      mapException: (err) => this.mapException(err),
      customErrorHandler: this.customErrorHandler,
    });

    return this.compiledTable.routes;
  }

  getCompiledRoutes(): readonly RouteDefinition[] {
    return this.compiledTable?.routes ?? [];
  }

  getServer(): BunServerLike | undefined {
    return this.httpServer;
  }

  getUrl(): string | undefined {
    const raw = this.httpServer?.url.toString();
    if (!raw) return undefined;
    return raw.replace(/^(https?:\/\/)0\.0\.0\.0(?::|\/|$)/, (m, proto) =>
      m.replace(`${proto}0.0.0.0`, `${proto}127.0.0.1`),
    );
  }

  private async ensureCompiled(): Promise<CompiledRouteTable> {
    if (!this.compiledTable) {
      await this.compileControllers(this.registeredControllers);
    }
    return this.compiledTable!;
  }

  private create503ClosingResponse(): Response {
    const err = new ServiceUnavailableException("Server is shutting down");
    const base = new Response(JSON.stringify(err.toJSON()), {
      status: 503,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Connection: "close",
      },
    });
    return this.securityHeaders
      ? applySecurityHeaders(base, this.securityHeaders)
      : base;
  }

  private trackInFlight<T>(fn: () => T | Promise<T>): Promise<T> {
    this.inFlightRequests += 1;
    return Promise.resolve()
      .then(fn)
      .finally(() => {
        this.inFlightRequests -= 1;
        if (this.inFlightRequests <= 0 && this.drainResolvers.length > 0) {
          const pending = this.drainResolvers.splice(
            0,
            this.drainResolvers.length,
          );
          for (const resolve of pending) {
            resolve();
          }
        }
      });
  }

  private createResponseContextForRaw(): HttpResponseContext {
    const signerFn = this.cookieSigner
      ? (val: string) => this.cookieSigner!.sign(val)
      : this.cookieSecrets && this.cookieSecrets[0]
        ? (val: string) => signCookieValue(val, this.cookieSecrets![0]!)
        : undefined;
    return new HttpResponseContext(signerFn);
  }

  private async tryDispatchRawRoutes(
    table: CompiledRouteTable,
    pathname: string,
    req: Request,
    server: BunServerLike | undefined,
  ): Promise<Response | null> {
    if (this.rawRoutes.length === 0) {
      return null;
    }
    const reqMethod = req.method.toUpperCase();
    let resCtx: HttpResponseContext | undefined;
    let ctx: RequestContext | undefined;
    let requestHooksRan = false;

    for (let i = 0; i < this.rawRoutes.length; i++) {
      const entry = this.rawRoutes[i]!;
      const methodMatches =
        entry.method === "ALL" ||
        entry.method === reqMethod ||
        (reqMethod === "HEAD" && entry.method === "GET");
      if (!methodMatches) {
        continue;
      }

      const params = matchRawRoutePath(
        entry,
        pathname,
        this.ignoreTrailingSlash,
      );
      if (params === null) {
        continue;
      }

      attachParamsToRequest(req, params);

      if (!resCtx || !ctx) {
        resCtx = this.createResponseContextForRaw();
        ctx = new RequestContext({
          request: req,
          server,
          params,
          paramsPreSanitized: true,
          pathname,
          trustProxy: this.trustProxy,
          maxBodyBytes: this.bodyLimit,
          bodyParser: this.bodyParserEnabled,
          captureRawBody: this.rawBodyEnabled,
          multipart: this.multipartOptions,
          cookieSecrets: this.cookieSecrets,
          responseContext: resCtx,
        });
      }

      try {
        if (!requestHooksRan) {
          requestHooksRan = true;

          if (this.onRequestHookFn) {
            await runAdapterOnRequestHook(this.onRequestHookFn, req, resCtx);
            const early = resCtx.getSentResponse();
            if (early) {
              const secured = this.securityHeaders
                ? applySecurityHeaders(early, this.securityHeaders)
                : early;
              if (this.onResponseHookFn)
                await this.onResponseHookFn(req, resCtx);
              return secured;
            }
          }

          if (table.runtime.cors) {
            const corsResult = await evaluateCors(req, table.runtime.cors);
            mergeCorsHeaders(ctx.corsHeaders, corsResult.headers);
          }

          if (this.securityHooks.length > 0) {
            const headerBridge = {
              setHeader: (name: string, value: string) =>
                resCtx!.header(name, value),
              removeHeader: (name: string) => resCtx!.removeHeader(name),
            };
            for (const hook of this.securityHooks) {
              const rejection = hook(req, headerBridge);
              if (rejection instanceof Error) {
                throw rejection;
              }
            }
          }
        }

        if (this.onRouteTriggered) {
          this.onRouteTriggered(
            routeMethodToRequestMethod(entry.method),
            entry.rawPath,
          );
        }

        let nextCalled = false;
        let nextError: unknown;
        const next = (err?: unknown) => {
          nextCalled = true;
          if (err !== undefined) {
            nextError = err;
          }
        };

        const result = await entry.handler(req, resCtx, next);

        if (nextError !== undefined) {
          throw nextError;
        }

        const sent = resCtx.getSentResponse();
        let response: Response | undefined;
        if (result instanceof Response) {
          response =
            result === sent
              ? applyCorsHeadersToSentResponse(result, ctx)
              : mergeHeadersOntoNativeResponse(result, ctx);
        } else if (sent) {
          response = applyCorsHeadersToSentResponse(sent, ctx);
        } else if (nextCalled) {
          continue;
        } else if (result !== undefined) {
          response = applyCorsHeadersToSentResponse(
            this.reply(resCtx, result),
            ctx,
          );
        } else {
          response = applyCorsHeadersToSentResponse(this.end(resCtx), ctx);
        }

        const finalRes = this.securityHeaders
          ? applySecurityHeaders(response, this.securityHeaders)
          : response;
        if (this.onResponseHookFn) {
          await this.onResponseHookFn(req, resCtx);
        }
        return finalRes;
      } catch (err) {
        const mapped = this.mapException(err);
        if (this.customErrorHandler) {
          const customRes = await this.invokeCustomErrorHandlerForRaw(
            mapped,
            ctx,
          );
          if (customRes) {
            const finalCustom = this.securityHeaders
              ? applySecurityHeaders(customRes, this.securityHeaders)
              : customRes;
            if (this.onResponseHookFn) await this.onResponseHookFn(req, resCtx);
            return finalCustom;
          }
        }
        const errRes = await executeFallbackException(
          mapped,
          ctx,
          table.runtime,
        );
        if (this.onResponseHookFn) {
          await this.onResponseHookFn(req, resCtx);
        }
        return errRes;
      }
    }

    return null;
  }

  private async invokeCustomErrorHandlerForRaw(
    error: unknown,
    ctx: RequestContext,
  ): Promise<Response | undefined> {
    if (!this.customErrorHandler) return undefined;
    if (!matchesSegmentPrefix(ctx.pathname, this.customErrorHandler.prefix)) {
      return undefined;
    }
    const resCtx = ctx.responseContext;
    let nextCalled = false;
    const result = await this.customErrorHandler.handler(
      error,
      ctx.request,
      resCtx,
      () => {
        nextCalled = true;
      },
    );
    const sent = resCtx.getSentResponse();
    if (result instanceof Response) {
      return result === sent
        ? applyCorsHeadersToSentResponse(result, ctx)
        : mergeHeadersOntoNativeResponse(result, ctx);
    }
    if (sent) {
      return applyCorsHeadersToSentResponse(sent, ctx);
    }
    if (!nextCalled && result !== undefined) {
      return applyCorsHeadersToSentResponse(
        this.reply(resCtx, result, resCtx.getStatus() ?? 500),
        ctx,
      );
    }
    return undefined;
  }

  /**
   * Executes a Request in-memory through the exact same compiled router,
   * native route closures, fallback radix router, imperative raw routes,
   * static asset handler, and 11-stage pipeline used by live `Bun.serve()`.
   */
  async fetch(req: Request, server?: BunServerLike): Promise<Response> {
    if (this.return503OnClosing && this.isClosing) {
      return this.create503ClosingResponse();
    }
    const execute = async (): Promise<Response> => {
      const table = await this.ensureCompiled();
      const pathname = extractPathname(req.url);

      if (hasMalformedPercentEncoding(pathname)) {
        const ctx = new RequestContext({
          request: req,
          server,
          pathname,
          trustProxy: this.trustProxy,
          maxBodyBytes: this.bodyLimit,
          bodyParser: this.bodyParserEnabled,
          captureRawBody: this.rawBodyEnabled,
          multipart: this.multipartOptions,
          cookieSecrets: this.cookieSecrets,
        });
        return executeFallbackException(
          new BadRequestException("Failed to decode param"),
          ctx,
          table.runtime,
        );
      }

      // 1. WebSocket upgrade check (when server is available)
      if (server && this.websocketRegistrations.size > 0) {
        const wsResult = await this.tryWebSocketUpgrade(pathname, req, server);
        if (wsResult.handled) {
          return wsResult.response as Response;
        }
      }

      // 2. Native path table match (exact Bun.serve({ routes }) precedence;
      //    when ignoreTrailingSlash is enabled, try trimmed path first so catch-all `/*` does not shadow `/foo/`)
      const nativeLookupPath =
        this.ignoreTrailingSlash && pathname.length > 1 && pathname.endsWith("/")
          ? pathname.replace(/\/+$/, "") || "/"
          : pathname;
      const nativeHit =
        table.nativeMatcher.match(nativeLookupPath) ??
        (nativeLookupPath !== pathname
          ? table.nativeMatcher.match(pathname)
          : null);
      if (nativeHit) {
        const res = await nativeHit.target(req, server, nativeHit.params);
        if (res.status === 405 && this.rawRoutes.length > 0) {
          const rawRes = await this.tryDispatchRawRoutes(
            table,
            pathname,
            req,
            server,
          );
          if (rawRes !== null) {
            return rawRes;
          }
        }
        return res;
      }

      // 3. Fallback pipeline (trailing-slash normalization, FallbackRadixRouter, raw routes, static assets, CORS preflight, 404)
      return this.dispatchFallback(table, pathname, req, server);
    };
    return this.return503OnClosing ? this.trackInFlight(execute) : execute();
  }

  /**
   * Controlled fallback dispatcher invoked by `Bun.serve({ fetch })` for
   * requests not handled directly by Bun's native `routes` table (ADR-011 §3).
   */
  private async handleBunFallbackFetch(
    req: Request,
    server: BunServerLike,
  ): Promise<Response | undefined> {
    const table = await this.ensureCompiled();
    const pathname = extractPathname(req.url);

    if (hasMalformedPercentEncoding(pathname)) {
      const ctx = new RequestContext({
        request: req,
        server,
        pathname,
        trustProxy: this.trustProxy,
        maxBodyBytes: this.bodyLimit,
        bodyParser: this.bodyParserEnabled,
        captureRawBody: this.rawBodyEnabled,
        multipart: this.multipartOptions,
        cookieSecrets: this.cookieSecrets,
      });
      return executeFallbackException(
        new BadRequestException("Failed to decode param"),
        ctx,
        table.runtime,
      );
    }

    // 1. WebSocket upgrade check
    if (this.websocketRegistrations.size > 0) {
      const wsResult = await this.tryWebSocketUpgrade(pathname, req, server);
      if (wsResult.handled) {
        return wsResult.response;
      }
    }

    return this.dispatchFallback(table, pathname, req, server);
  }

  private async tryWebSocketUpgrade(
    pathname: string,
    req: Request,
    server: BunServerLike | undefined,
  ): Promise<{ handled: boolean; response?: Response }> {
    if (!server || this.websocketRegistrations.size === 0) {
      return { handled: false };
    }
    const upgradeHeader = req.headers.get("upgrade");
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
      return { handled: false };
    }

    const normalized = normalizeRoutePath(pathname);
    const registration =
      this.websocketRegistrations.get(pathname) ??
      this.websocketRegistrations.get(normalized);
    if (!registration) {
      return { handled: false };
    }

    const response = await registration.upgrade(req, server);
    return { handled: true, response };
  }

  private async tryDispatchStandaloneModuleMiddlewares(
    table: CompiledRouteTable,
    pathname: string,
    req: Request,
    server: BunServerLike | undefined,
  ): Promise<Response | null> {
    const reqMethod = req.method.toUpperCase() as RouteHttpMethod;
    const normPath =
      !this.ignoreTrailingSlash && pathname.length > 1 && pathname.endsWith("/")
        ? pathname
        : normalizeRoutePath(pathname);
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(normPath);
    } catch {
      decodedPath = normPath;
    }

    const globalPrefixes =
      this.globalPrefix === undefined
        ? []
        : (Array.isArray(this.globalPrefix)
            ? this.globalPrefix
            : [this.globalPrefix]
          )
            .map((p) => normalizeRoutePath(p))
            .filter((p) => p !== "/");

    const candidates: string[] = [normPath];
    for (const gp of globalPrefixes) {
      if (normPath === gp) {
        candidates.push("/");
      } else if (normPath.startsWith(`${gp}/`)) {
        candidates.push(normPath.slice(gp.length) || "/");
      }
    }

    const runtimeVer = isRuntimeVersioning(this.versioningOptions);
    const reqVersions =
      runtimeVer && this.versioningOptions
        ? extractRequestVersions(req, this.versioningOptions)
        : undefined;

    const matchingMiddlewares: Array<CompiledMiddlewareConfig["middleware"]> = [];
    for (let i = 0; i < this.moduleMiddlewares.length; i++) {
      const cfg = this.moduleMiddlewares[i];
      if (!cfg) continue;

      if (cfg.include && cfg.include.length > 0) {
        const included = cfg.include.some((rule) => {
          // If global prefix is configured and this rule is NOT excluded from global prefix,
          // only match prefixed path unless rule itself is wildcard or matches unprefixed excluded path.
          const rulePath = typeof rule === "string" ? rule : rule.path;
          const ruleNorm = normalizeRoutePath(rulePath);
          const isWild =
            rulePath.trim() === "*" ||
            rulePath.trim() === "/*" ||
            rulePath.trim().startsWith("{*");
          const isExcludedFromPrefix =
            globalPrefixes.length === 0 ||
            isWild ||
            matchesGlobalPrefixExclude(
              reqMethod,
              ruleNorm,
              this.globalPrefixOptions?.exclude,
            );
          const matchTargets =
            globalPrefixes.length > 0 && !isWild
              ? isExcludedFromPrefix
                ? [normPath]
                : candidates.slice(1)
              : candidates;
          if (matchTargets.length === 0) return false;
          if (
            !this.ignoreTrailingSlash &&
            pathname.length > 1 &&
            pathname.endsWith("/") &&
            !rulePath.endsWith("/") &&
            !isWild &&
            !rulePath.includes("*") &&
            !rulePath.includes("{") &&
            !(
              typeof rule === "string" ||
              (rule as { _fromString?: boolean })._fromString === true
            )
          ) {
            return false;
          }
          return matchesRouteInfo(
            rule as string | VersionedRouteRule,
            reqMethod,
            matchTargets,
            reqVersions && reqVersions.length > 0 ? reqVersions : undefined,
            { allowStringPrefixMount: true },
          );
        });
        if (!included) continue;
      }

      if (cfg.exclude && cfg.exclude.length > 0) {
        const hasLineTerm = /[\r\n\u2028\u2029]/.test(decodedPath);
        if (!hasLineTerm) {
          const excluded = cfg.exclude.some((rule) =>
            matchesRouteInfo(
              rule as string | VersionedRouteRule,
              reqMethod,
              candidates,
              reqVersions,
            ),
          );
          if (excluded) continue;
        }
      }

      matchingMiddlewares.push(cfg.middleware);
    }

    if (matchingMiddlewares.length === 0) {
      return null;
    }

    const resCtx = this.createResponseContextForRaw();
    const ctx = new RequestContext({
      request: req,
      server,
      pathname,
      trustProxy: this.trustProxy,
      maxBodyBytes: this.bodyLimit,
      bodyParser: this.bodyParserEnabled,
      captureRawBody: this.rawBodyEnabled,
      multipart: this.multipartOptions,
      cookieSecrets: this.cookieSecrets,
      responseContext: resCtx,
    });

    const invokeMiddleware = async (index: number): Promise<Response | null> => {
      if (index >= matchingMiddlewares.length) {
        return null;
      }
      const entry = matchingMiddlewares[index]!;
      let resolvedFn:
        | ((
            r: Request,
            res: HttpResponseContext,
            next: () => Promise<Response>,
          ) => unknown)
        | undefined;
      if (typeof entry === "function") {
        const isClassCtor =
          entry.prototype !== undefined &&
          typeof (entry.prototype as { use?: unknown }).use === "function";
        if (isClassCtor) {
          const instance = await this.bridge.resolveEnhancer<{
            use: (
              r: Request,
              res: HttpResponseContext,
              n: () => Promise<Response>,
            ) => unknown;
          }>(entry as unknown as new (...args: unknown[]) => {
            use: (
              r: Request,
              res: HttpResponseContext,
              n: () => Promise<Response>,
            ) => unknown;
          });
          resolvedFn = (r, res, n) => instance.use(r, res, n);
        } else {
          resolvedFn = entry as (
            r: Request,
            res: HttpResponseContext,
            next: () => Promise<Response>,
          ) => unknown;
        }
      } else if (entry && typeof entry === "object" && "use" in entry) {
        const inst = entry as { use: Function };
        resolvedFn = (r, res, n) => inst.use(r, res, n);
      }

      if (!resolvedFn) {
        return invokeMiddleware(index + 1);
      }

      let nextResult: Response | null = null;
      let nextCalled = false;
      const result = await resolvedFn(req, resCtx, async () => {
        nextCalled = true;
        nextResult = await invokeMiddleware(index + 1);
        return nextResult ?? new Response(null, { status: 404 });
      });

      const sent = resCtx.getSentResponse();
      if (nextCalled && nextResult === null && !sent) {
        return null;
      }
      if (result instanceof Response) {
        return mergeHeadersOntoNativeResponse(result, ctx);
      }
      if (sent) {
        return mergeHeadersOntoNativeResponse(sent, ctx);
      }
      if (nextCalled) {
        return nextResult;
      }
      return null;
    };

    try {
      return await invokeMiddleware(0);
    } catch (err) {
      return executeFallbackException(err, ctx, table.runtime);
    }
  }

  private async dispatchFallback(
    table: CompiledRouteTable,
    pathname: string,
    req: Request,
    server: BunServerLike | undefined,
  ): Promise<Response> {
    const hasTrailingSlash = pathname.length > 1 && pathname.endsWith("/");
    const trimmedPath = hasTrailingSlash
      ? pathname.replace(/\/+$/, "") || "/"
      : pathname;

    // 2. Opt-in trailing-slash normalization against native path table (ADR-011 §3.2)
    if (this.ignoreTrailingSlash && hasTrailingSlash) {
      const normalizedHit = table.nativeMatcher.match(trimmedPath);
      if (normalizedHit) {
        const res = await normalizedHit.target(
          req,
          server,
          normalizedHit.params,
        );
        if (res.status === 405 && this.rawRoutes.length > 0) {
          const rawRes = await this.tryDispatchRawRoutes(
            table,
            pathname,
            req,
            server,
          );
          if (rawRes !== null) {
            return rawRes;
          }
        }
        return res;
      }
    }

    // 3. Fallback Radix Router match (host-constrained, mid-wildcard, optional/regex params)
    let fallbackHit = table.fallbackRouter.match(pathname, req);
    if (
      fallbackHit.kind === "not-found" &&
      this.ignoreTrailingSlash &&
      hasTrailingSlash
    ) {
      fallbackHit = table.fallbackRouter.match(trimmedPath, req);
    }

    if (fallbackHit.kind === "matched") {
      const ctx = new RequestContext({
        request: req,
        server,
        params: fallbackHit.params,
        hostParams: fallbackHit.hostParams,
        pathname,
        trustProxy: this.trustProxy,
        maxBodyBytes: this.bodyLimit,
        bodyParser: this.bodyParserEnabled,
        captureRawBody: this.rawBodyEnabled,
        multipart: this.multipartOptions,
        cookieSecrets: this.cookieSecrets,
      });
      return executeCompiledRoute(
        fallbackHit.route,
        ctx,
        table.runtime,
        fallbackHit.allowHeader,
      );
    }

    // 3.5. Imperative raw routes (`httpAdapter.get/post/put/...`)
    if (this.rawRoutes.length > 0) {
      const rawResponse = await this.tryDispatchRawRoutes(
        table,
        pathname,
        req,
        server,
      );
      if (rawResponse !== null) {
        return rawResponse;
      }
    }

    if (fallbackHit.kind === "method-not-allowed") {
      const reqMethod = req.method.toUpperCase();
      if (
        reqMethod === "OPTIONS" &&
        table.runtime.cors &&
        isCorsPreflightRequest(req)
      ) {
        const corsResult = await evaluateCors(
          req,
          table.runtime.cors,
          fallbackHit.allowHeader,
        );
        if (!table.runtime.cors.preflightContinue) {
          return createPreflightResponse(corsResult, table.runtime.cors);
        }
      }

      const ctx = new RequestContext({
        request: req,
        server,
        hostParams: fallbackHit.hostParams,
        pathname,
        trustProxy: this.trustProxy,
        maxBodyBytes: this.bodyLimit,
        bodyParser: this.bodyParserEnabled,
        captureRawBody: this.rawBodyEnabled,
        multipart: this.multipartOptions,
        cookieSecrets: this.cookieSecrets,
      });
      return executeFallbackException(
        new MethodNotAllowedException(
          `Method ${reqMethod} not allowed for ${pathname}`,
          { headers: { Allow: fallbackHit.allowHeader } },
        ),
        ctx,
        table.runtime,
        fallbackHit.allowHeader,
      );
    }

    // 4. Static assets serving (`useStaticAssets` / `ServeStaticModule` via Bun.file())
    if (this.staticAssetsMounts.length > 0) {
      const staticResponse = await tryServeStaticAsset(
        this.staticAssetsMounts,
        pathname,
        req,
        table.runtime.cors,
      );
      if (staticResponse !== null) {
        return this.securityHeaders
          ? applySecurityHeaders(staticResponse, this.securityHeaders)
          : staticResponse;
      }
    }

    // 5. Unmatched CORS Preflight Check (ADR-011 §3.4)
    if (
      table.runtime.cors &&
      isCorsPreflightRequest(req) &&
      !table.runtime.cors.preflightContinue
    ) {
      const corsResult = await evaluateCors(req, table.runtime.cors);
      const preflight = createPreflightResponse(corsResult, table.runtime.cors);
      return this.securityHeaders
        ? applySecurityHeaders(preflight, this.securityHeaders)
        : preflight;
    }

    // 5.2. Standalone module middleware on unmatched paths (e.g. forRoutes('shop/admin'), forRoutes('*'), forRoutes({ path: 'middleware', method: GET }))
    if (this.moduleMiddlewares.length > 0) {
      const standaloneRes = await this.tryDispatchStandaloneModuleMiddlewares(
        table,
        pathname,
        req,
        server,
      );
      if (standaloneRes !== null) {
        return this.securityHeaders
          ? applySecurityHeaders(standaloneRes, this.securityHeaders)
          : standaloneRes;
      }
    }

    // 5.5. Custom NotFoundHandler (`httpAdapter.setNotFoundHandler`)
    if (this.customNotFoundHandler) {
      const { handler, prefix, excludedRoutes } = this.customNotFoundHandler;
      const prefixMatches = matchesSegmentPrefix(pathname, prefix);
      const isExcluded =
        excludedRoutes && excludedRoutes.length > 0
          ? excludedRoutes.some((rule) =>
              matchesRouteInfo(
                rule,
                req.method.toUpperCase() as RouteHttpMethod,
                [pathname],
              ),
            )
          : false;
      if (prefixMatches && !isExcluded) {
        const resCtx = this.createResponseContextForRaw();
        const ctx = new RequestContext({
          request: req,
          server,
          pathname,
          trustProxy: this.trustProxy,
          maxBodyBytes: this.bodyLimit,
          bodyParser: this.bodyParserEnabled,
          captureRawBody: this.rawBodyEnabled,
          multipart: this.multipartOptions,
          cookieSecrets: this.cookieSecrets,
          responseContext: resCtx,
        });
        let nextCalled = false;
        const result = await handler(req, resCtx, () => {
          nextCalled = true;
        });
        const sent = resCtx.getSentResponse();
        if (result instanceof Response) {
          const merged =
            result === sent
              ? applyCorsHeadersToSentResponse(result, ctx)
              : mergeHeadersOntoNativeResponse(result, ctx);
          return this.securityHeaders
            ? applySecurityHeaders(merged, this.securityHeaders)
            : merged;
        }
        if (sent) {
          const merged = applyCorsHeadersToSentResponse(sent, ctx);
          return this.securityHeaders
            ? applySecurityHeaders(merged, this.securityHeaders)
            : merged;
        }
        if (!nextCalled && result !== undefined) {
          const replied = applyCorsHeadersToSentResponse(
            this.reply(resCtx, result, resCtx.getStatus() ?? 404),
            ctx,
          );
          return this.securityHeaders
            ? applySecurityHeaders(replied, this.securityHeaders)
            : replied;
        }
      }
    }

    // 6. 404 Not Found through Global Exception Filters with CORS headers (ADR-011 §3.5)
    const ctx = new RequestContext({
      request: req,
      server,
      pathname,
      trustProxy: this.trustProxy,
      maxBodyBytes: this.bodyLimit,
      bodyParser: this.bodyParserEnabled,
      captureRawBody: this.rawBodyEnabled,
      multipart: this.multipartOptions,
      cookieSecrets: this.cookieSecrets,
    });
    if (this.csrfProtection) {
      try {
        this.csrfProtection.evaluate(req, pathname);
      } catch (csrfError) {
        return executeFallbackException(csrfError, ctx, table.runtime);
      }
    }
    return executeFallbackException(
      new NotFoundException(`Cannot ${req.method} ${pathname}`),
      ctx,
      table.runtime,
    );
  }

  override async listen(
    portOrOptions: number | string | ListenOptions = 3000,
    hostnameOrCallback?: string | (() => void),
    callback?: () => void,
  ): Promise<ListeningServerInfo> {
    if (this.httpServer) {
      await this.close();
    }
    this.isClosing = false;

    const hostname =
      typeof hostnameOrCallback === "string" ? hostnameOrCallback : undefined;
    const onListen =
      typeof hostnameOrCallback === "function" ? hostnameOrCallback : callback;

    const opts: ListenOptions =
      typeof portOrOptions === "number" || typeof portOrOptions === "string"
        ? { port: Number(portOrOptions), hostname }
        : portOrOptions;

    if (opts.development !== undefined) {
      this.development = opts.development;
    }

    const table = await this.ensureCompiled();

    // Wrap native routes that share a path with a WebSocket handler so WS upgrades succeed
    const serveRoutes: Record<
      string,
      (
        req: Request,
        server: BunServerLike,
      ) => Response | undefined | Promise<Response | undefined>
    > = {};

    const wrapForClosing = (
      fn: (
        req: Request,
        server: BunServerLike,
      ) => Response | undefined | Promise<Response | undefined>,
    ) => {
      if (!this.return503OnClosing) {
        return fn;
      }
      return (req: Request, server: BunServerLike) => {
        if (this.isClosing) {
          return this.create503ClosingResponse();
        }
        return this.trackInFlight(() => fn(req, server));
      };
    };

    for (const [path, handler] of Object.entries(table.bunRoutes)) {
      const safeHandler = async (req: Request, server: BunServerLike) => {
        if (req.url.includes("#") || req.url.includes("%")) {
          const pathname = extractPathname(req.url);
          if (req.url.includes("#") || hasMalformedPercentEncoding(pathname)) {
            return this.fetch(req, server);
          }
        }
        return handler(req, server);
      };
      const wrappedHandler =
        this.rawRoutes.length > 0
          ? async (req: Request, server: BunServerLike) => {
              const res = await safeHandler(req, server);
              if (res && res.status === 405 && this.rawRoutes.length > 0) {
                const rawRes = await this.tryDispatchRawRoutes(
                  table,
                  extractPathname(req.url),
                  req,
                  server,
                );
                if (rawRes !== null) {
                  return rawRes;
                }
              }
              return res;
            }
          : safeHandler;

      if (this.websocketRegistrations.has(path)) {
        serveRoutes[path] = wrapForClosing(async (req, server) => {
          const wsResult = await this.tryWebSocketUpgrade(path, req, server);
          if (wsResult.handled) {
            return wsResult.response;
          }
          return wrappedHandler(req, server);
        });
      } else {
        serveRoutes[path] = wrapForClosing(wrappedHandler);
      }
    }

    // Ensure every registered WebSocket path has an explicit static entry in `routes`
    // so native `:param` or catch-all `/*` HTTP routes never shadow WS upgrades.
    for (const wsPath of this.websocketRegistrations.keys()) {
      if (serveRoutes[wsPath] !== undefined) {
        continue;
      }
      serveRoutes[wsPath] = wrapForClosing(async (req, server) => {
        const wsResult = await this.tryWebSocketUpgrade(wsPath, req, server);
        if (wsResult.handled) {
          return wsResult.response;
        }
        const nativeHit = table.nativeMatcher.match(wsPath);
        if (nativeHit) {
          return nativeHit.target(req, server, nativeHit.params);
        }
        return this.dispatchFallback(table, wsPath, req, server);
      });
    }

    const fallbackHandler = wrapForClosing(
      (req: Request, server: BunServerLike) =>
        this.handleBunFallbackFetch(req, server),
    );

    const serveOptions: Record<string, unknown> = {
      port: opts.port ?? 3000,
      fetch: fallbackHandler,
    };

    if (opts.hostname !== undefined) {
      serveOptions.hostname = opts.hostname;
    }
    if (opts.development !== undefined) {
      serveOptions.development = opts.development;
    }
    if (opts.maxRequestBodySize !== undefined) {
      serveOptions.maxRequestBodySize = opts.maxRequestBodySize;
    }
    if (opts.idleTimeout !== undefined) {
      serveOptions.idleTimeout = opts.idleTimeout;
    }
    if (opts.tls !== undefined) {
      serveOptions.tls = opts.tls;
    } else if (this.httpsOptions !== undefined) {
      serveOptions.tls = this.httpsOptions;
    }
    if (Object.keys(serveRoutes).length > 0) {
      serveOptions.routes = serveRoutes;
    }
    if (this.websocketConfig !== undefined) {
      serveOptions.websocket = this.websocketConfig;
    }

    try {
      const started = Bun.serve(
        serveOptions as unknown as Parameters<typeof Bun.serve>[0],
      ) as unknown as BunServerLike;
      this.httpServer = started;

      const boundPort = started.port ?? opts.port ?? 0;
      const boundHost = started.hostname ?? opts.hostname ?? "localhost";
      const url = started.url.toString();

      if (onListen) {
        onListen();
      }

      return {
        port: boundPort,
        hostname: boundHost,
        url,
      };
    } catch (err) {
      if (!this.abortOnError) {
        this.logger.error("Failed to start Bun HTTP server", err);
      }
      throw err;
    }
  }

  async close(force?: boolean): Promise<void> {
    this.isClosing = true;
    const shouldForce = force ?? this.forceCloseConnections;
    if ((this.return503OnClosing || !shouldForce) && this.inFlightRequests > 0) {
      await new Promise<void>((resolve) => {
        if (this.inFlightRequests <= 0) {
          resolve();
          return;
        }
        this.drainResolvers.push(resolve);
      });
    }
    if (!this.httpServer) {
      return;
    }
    const active = this.httpServer;
    this.httpServer = undefined;
    await active.stop(shouldForce);
  }
}
