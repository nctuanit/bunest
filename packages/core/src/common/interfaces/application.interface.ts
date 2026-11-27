import type { Scope } from "../enums/scope.enum";
import type { LogLevel, LoggerService } from "../logger/logger.interface";
import type {
  CookieOptions,
  CookieSerializeOptions,
  CookiesOptions,
  RouteInfo,
} from "./pipeline.interface";

export type { CookieOptions, CookieSerializeOptions, CookiesOptions };

export type CorsOrigin =
  | boolean
  | string
  | RegExp
  | Array<string | RegExp>
  | ((
      origin: string | null,
      req: Request,
    ) => boolean | string | Promise<boolean | string>);

export interface CorsOptions {
  origin?: CorsOrigin;
  methods?: string | string[];
  allowedHeaders?: string | string[];
  exposedHeaders?: string | string[];
  credentials?: boolean;
  maxAge?: number;
  preflightContinue?: boolean;
  optionsSuccessStatus?: number;
}

export interface CsrfProtectionOptions<TRequest = Request> {
  /**
   * Additional origins permitted to send cross-origin state-changing requests
   * (e.g. `https://admin.example.com`). Normalized without default ports.
   */
  trustedOrigins?: string[];
  /**
   * Exact route list or synchronous predicate exempt from CSRF protection.
   */
  exclude?: Array<string | RouteInfo> | ((request: TRequest) => boolean);
}

export type ContentSecurityPolicyDirectiveValue =
  string | readonly string[] | boolean | null;

export interface ContentSecurityPolicyOptions {
  useDefaults?: boolean;
  directives?: Record<string, ContentSecurityPolicyDirectiveValue>;
  reportOnly?: boolean;
}

export type ReferrerPolicyToken =
  | ""
  | "no-referrer"
  | "no-referrer-when-downgrade"
  | "same-origin"
  | "origin"
  | "strict-origin"
  | "origin-when-cross-origin"
  | "strict-origin-when-cross-origin"
  | "unsafe-url";

/**
 * Helmet-8 / NestJS v12 `app.useSecurityHeaders()` options.
 */
export interface HttpSecurityHeadersOptions {
  contentSecurityPolicy?: boolean | ContentSecurityPolicyOptions;
  crossOriginEmbedderPolicy?:
    boolean | { policy?: "require-corp" | "credentialless" | "unsafe-none" };
  crossOriginOpenerPolicy?:
    | boolean
    | {
        policy?:
          | "same-origin"
          | "same-origin-allow-popups"
          | "noopener-allow-popups"
          | "unsafe-none";
      };
  crossOriginResourcePolicy?:
    boolean | { policy?: "same-origin" | "same-site" | "cross-origin" };
  originAgentCluster?: boolean;
  referrerPolicy?:
    boolean | { policy?: ReferrerPolicyToken | readonly ReferrerPolicyToken[] };
  strictTransportSecurity?:
    | boolean
    | {
        maxAge?: number;
        includeSubDomains?: boolean;
        preload?: boolean;
      };
  xContentTypeOptions?: boolean;
  xDnsPrefetchControl?: boolean | { allow?: boolean };
  xDownloadOptions?: boolean;
  xFrameOptions?: boolean | { action?: "deny" | "sameorigin" };
  xPermittedCrossDomainPolicies?:
    | boolean
    | {
        permittedPolicies?: "none" | "master-only" | "by-content-type" | "all";
      };
  xPoweredBy?: boolean;
  xXssProtection?: boolean;
}

export interface HttpsOptions {
  key?: string | Uint8Array | Array<string | Uint8Array>;
  cert?: string | Uint8Array | Array<string | Uint8Array>;
  ca?: string | Uint8Array | Array<string | Uint8Array>;
  passphrase?: string;
  serverName?: string;
  lowMemoryMode?: boolean;
}

export interface InstrumentOptions {
  /**
   * Hook called for every provider/controller instance created by the DI container.
   */
  instanceDecorator: (instance: unknown) => unknown;
}

export interface ScopeOptions {
  scope?: Scope;
  durable?: boolean;
}

export interface IntrospectionResult {
  scope: Scope;
}

export interface PreRequestHook<TContext = unknown> {
  (context: TContext): void | Promise<void>;
}

export type ValidationErrorFormat = "list" | "grouped" | "bunest";

export interface SseMessageEvent<T = unknown> {
  data: string | object | T;
  id?: string;
  type?: string;
  retry?: number;
  comment?: string;
}

export type MessageEvent<T = unknown> = SseMessageEvent<T>;

export interface StaticAssetsOptions {
  prefix?: string;
  index?: string | false;
  cacheControl?: string;
  dotfiles?: "allow" | "deny" | "ignore";
  /**
   * Enable ETag generation and `If-None-Match` -> `304 Not Modified` handling.
   * @default true
   */
  etag?: boolean;
  /**
   * Fallback file (relative to `rootDir`, or `true` for `"index.html"`) served
   * for unmatched SPA client routes (when path has no file extension).
   */
  spaFallback?: boolean | string;
  /**
   * Convenience `max-age` in seconds when `cacheControl` is not explicitly provided.
   */
  maxAge?: number;
  /**
   * Appends `, immutable` when `maxAge` is configured.
   */
  immutable?: boolean;
}

export type RouteConflictPolicyLevel = "off" | "warn" | "error";

export interface RouteConflictPolicyObject {
  duplicate?: RouteConflictPolicyLevel;
  shadow?: RouteConflictPolicyLevel;
}

export type RouteConflictPolicy =
  "throw" | "warn" | "allow" | RouteConflictPolicyObject;

export type RouteResolutionStrategy = "declaration" | "specificity";

export type ViewEngineRenderer = (
  template: string,
  data: Record<string, unknown>,
  context?: { baseViewsDir?: string },
) => string | Promise<string>;

export interface ShutdownHooksOptions {
  /**
   * When `true`, invokes `process.exit(0)` (or `process.exit(1)` if `close()`
   * rejects) after graceful shutdown completes on a process signal. Useful for
   * apps with open async handles such as async loggers or OTLP exporters.
   * @default false
   */
  useProcessExit?: boolean;
}

export interface ProcessErrorShutdownOptions {
  /**
   * Exit code passed to `process.exit()` once graceful shutdown completes or times out.
   * @default 1
   */
  exitCode?: number;
  /**
   * Maximum duration in milliseconds to wait for `close()` before forcing exit.
   * @default 5000
   */
  timeout?: number;
}

export type ProcessErrorOrigin = "unhandledRejection" | "uncaughtException";

export interface ProcessErrorHandlerContext {
  readonly origin: ProcessErrorOrigin;
  shutdown(options?: ProcessErrorShutdownOptions): Promise<void>;
}

export type ProcessErrorHandler = (
  error: unknown,
  context: ProcessErrorHandlerContext,
) => void | Promise<void>;

export interface ProcessErrorHandlersOptions {
  /**
   * Custom handler for `process.on("unhandledRejection")`, or `false` to disable.
   */
  unhandledRejection?: ProcessErrorHandler | false;
  /**
   * Custom handler for `process.on("uncaughtException")`, or `false` to disable.
   */
  uncaughtException?: ProcessErrorHandler | false;
}

export interface BunestApplicationOptions {
  logger?: boolean | LogLevel[] | LoggerService;
  cors?: boolean | CorsOptions;
  bodyLimit?: number;
  bodyParser?: boolean;
  rawBody?: boolean;
  globalPrefix?: string | string[];
  ignoreTrailingSlash?: boolean;
  trustProxy?: boolean | number | string[];
  abortOnError?: boolean;
  shutdownHooks?: boolean;
  development?: boolean;
  bufferLogs?: boolean;
  autoFlushLogs?: boolean;
  preview?: boolean;
  snapshot?: boolean;
  moduleIdGeneratorAlgorithm?: "deep-hash" | "reference";
  instrument?: InstrumentOptions;
  forceConsole?: boolean;
  httpsOptions?: HttpsOptions;
  forceCloseConnections?: boolean;
  return503OnClosing?: boolean;
  cookies?: CookiesOptions;
  /**
   * Controls how duplicate / shadowed route collisions are handled at bootstrap.
   * Supports Bunest string policies (`"throw" | "warn" | "allow"`) and NestJS v12
   * per-kind policy objects (`{ duplicate, shadow }`).
   * @default "throw"
   */
  routeConflictPolicy?: RouteConflictPolicy;
  /**
   * Order in which routes are registered (`"declaration"` or `"specificity"`).
   * @default "declaration"
   */
  routeResolutionStrategy?: RouteResolutionStrategy;
}
