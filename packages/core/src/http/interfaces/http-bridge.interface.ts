import type {
  BunestApplicationOptions,
  BunestMiddleware,
  ExceptionFilter,
  ExceptionFilterLike,
  GuardLike,
  InjectionToken,
  InterceptorLike,
  MiddlewareFunction,
  PipeLike,
  ResponseContext,
  RouteInfo,
  Type,
  UploadedFileInfo,
} from "../../common/index";

export type EnhancerKind = "guard" | "pipe" | "interceptor" | "filter";

/**
 * Per-request DI scope container bridged from `@bunest/core` (ADR-012).
 */
export interface RequestScopeContainer {
  resolve<T = unknown>(token: InjectionToken<T>): Promise<T> | T;
  registerRequestValue<T = unknown>(token: InjectionToken<T>, value: T): void;
  destroy(): Promise<void>;
}

/**
 * Runtime bridge decoupling `@bunest/core/http` from `@bunest/core`'s DI container.
 */
export interface HttpRuntimeBridge {
  resolveController(
    controllerToken: Type<unknown>,
    requestContainer?: RequestScopeContainer,
  ): Promise<object> | object;
  resolveEnhancer<T = unknown>(
    enhancer: Type<T> | T,
    requestContainer?: RequestScopeContainer,
    kind?: EnhancerKind,
    controllerToken?: Type<unknown>,
  ): Promise<T> | T;
  createRequestContainer?(
    request: Request,
    responseContext: ResponseContext,
  ): RequestScopeContainer;
  requiresRequestScope?(
    controllerToken: Type<unknown>,
    enhancerTokens: readonly InjectionToken[],
  ): boolean;
  requiresEnhancerRequestScope?(
    enhancer: unknown,
    kind?: EnhancerKind,
    controllerToken?: Type<unknown>,
  ): boolean;
  resolveFilterCatchTypes?(
    filterSpec: ExceptionFilterLike,
    resolvedInstance?: ExceptionFilter,
  ): readonly Type<any>[] | undefined;
  getModuleEnhancersForController?(controllerToken: Type<unknown>):
    | {
        readonly guards: readonly GuardLike[];
        readonly pipes: readonly PipeLike[];
        readonly interceptors: readonly InterceptorLike[];
        readonly filters: readonly ExceptionFilterLike[];
      }
    | undefined;
  resolveMiddlewareOverride?(
    middleware: MiddlewareFunction | Type<BunestMiddleware> | BunestMiddleware,
  ):
    | MiddlewareFunction
    | Type<BunestMiddleware>
    | BunestMiddleware
    | null
    | undefined;
}

/**
 * Module-scoped middleware configuration compiled by `@bunest/core`
 * from `BunestModule.configure(MiddlewareConsumer)`.
 */
export interface CompiledMiddlewareConfig {
  middleware: MiddlewareFunction | Type<BunestMiddleware> | BunestMiddleware;
  include?: RouteInfo[];
  exclude?: RouteInfo[];
}

export interface ListenOptions {
  port?: number;
  hostname?: string;
  /**
   * Optional Unix domain socket path forwarded directly to `Bun.serve({ unix })`.
   * When set, `port` and `hostname` are omitted so Bun binds the Unix socket cleanly.
   */
  unix?: string;
  development?: boolean;
  maxRequestBodySize?: number;
  idleTimeout?: number;
  tls?: unknown;
  /**
   * Enable OS-level `SO_REUSEPORT` socket sharing across multiple Bun Worker
   * threads or processes listening on the same port (recommended on Linux).
   */
  reusePort?: boolean;
}

export interface ListeningServerInfo {
  port: number;
  hostname: string;
  url: string;
}

export interface GlobalPrefixOptions {
  exclude?: Array<string | RouteInfo>;
}

export interface BunSocketAddress {
  address: string;
  family: string;
  port: number;
}

export interface BunServerLike {
  readonly port?: number;
  readonly hostname?: string;
  readonly url: URL;
  readonly pendingRequests?: number;
  readonly pendingWebSockets?: number;
  stop(closeActiveConnections?: boolean): void | Promise<void>;
  closeIdleConnections?(): void;
  timeout?(req: Request, seconds: number): void;
  reload?(options: Record<string, unknown>): void;
  requestIP?(req: Request): BunSocketAddress | null;
  upgrade?(
    req: Request,
    options?: {
      data?: unknown;
      headers?: Headers | Record<string, string> | Array<[string, string]>;
    },
  ): boolean;
  publish?(
    topic: string,
    data: string | ArrayBufferView | ArrayBuffer,
    compress?: boolean,
  ): number;
  subscriberCount?(topic: string): number;
}

export type WebSocketUpgradeHandler = (
  req: Request,
  server: BunServerLike,
) => Response | undefined | Promise<Response | undefined>;

export interface WebSocketHandlerRegistration {
  path: string;
  upgrade: WebSocketUpgradeHandler;
  websocket?: unknown;
}

/**
 * Configuration for multipart/form-data file uploads, including optional
 * streaming disk storage to avoid buffering large uploads into RAM.
 */
export interface MultipartStorageOptions {
  /**
   * Directory where uploaded files are streamed directly to disk instead of
   * buffering into RAM (`UploadedFileInfo.path` will contain the written file path).
   */
  readonly diskStorageDir?: string;
  /**
   * Maximum allowed size in bytes for a single uploaded file.
   */
  readonly maxFileSize?: number;
  /**
   * Maximum number of uploaded files permitted in a single multipart request.
   */
  readonly maxFiles?: number;
}

/**
 * Extended `UploadedFileInfo` returned when multipart streaming disk storage is enabled.
 */
export interface DiskUploadedFileInfo extends UploadedFileInfo {
  /**
   * Absolute path on disk where the uploaded file was streamed (set when `diskStorageDir` is configured).
   */
  readonly path?: string;
  /**
   * Generated safe filename stored inside `destination`.
   */
  readonly filename?: string;
  /**
   * Resolved destination directory where the uploaded file was stored.
   */
  readonly destination?: string;
}

export type BunHttpAdapterOptions = Pick<
  BunestApplicationOptions,
  | "logger"
  | "cors"
  | "bodyLimit"
  | "bodyParser"
  | "rawBody"
  | "globalPrefix"
  | "ignoreTrailingSlash"
  | "trustProxy"
  | "abortOnError"
  | "development"
  | "routeConflictPolicy"
  | "routeResolutionStrategy"
  | "cookies"
  | "httpsOptions"
  | "forceCloseConnections"
  | "return503OnClosing"
> & {
  readonly multipart?: MultipartStorageOptions;
};
