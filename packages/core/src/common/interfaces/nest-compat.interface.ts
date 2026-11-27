import type { RequestMethod } from "../enums/scope.enum";
import type { ShutdownSignal } from "../enums/shutdown-signal.enum";
import type { LogLevel, LoggerService } from "../logger/logger.interface";
import type {
  BunestApplicationOptions,
  CookieSerializeOptions,
  CorsOptions,
  CsrfProtectionOptions,
  HttpSecurityHeadersOptions,
  PreRequestHook,
  ShutdownHooksOptions,
  StaticAssetsOptions,
  ViewEngineRenderer,
} from "./application.interface";
import type { ContextId } from "./durable-context.interface";
import type { PipeLike } from "./http.interface";
import type { MicroserviceInstance } from "./microservice.interface";
import type { DynamicModule } from "./module.interface";
import type {
  ArgumentsHost,
  BunestInterceptor,
  BunestMiddleware,
  BunestModule,
  CanActivate,
  ExceptionFilter,
  MiddlewareFunction,
  ResponseContext,
  RouteInfo,
} from "./pipeline.interface";
import type { InjectionToken, Type } from "./type.interface";
import type { ValidationError } from "./validation.interface";
import type { VersionValue, VersioningOptions } from "./versioning.interface";

export type { ValidationError };

/**
 * NestJS-compatible interface aliases (1:1 migration compatibility).
 */
export type NestInterceptor<T = any, R = any> = BunestInterceptor<T, R>;
export type NestMiddleware = BunestMiddleware;
export type NestModule = BunestModule;
export type NestApplicationOptions = BunestApplicationOptions;
export type SecurityHeadersOptions = HttpSecurityHeadersOptions;

export interface NestHybridApplicationOptions {
  /**
   * When `true`, the connected microservice inherits global pipes, guards,
   * interceptors, and exception filters from the parent HTTP application.
   * @default false
   */
  inheritAppConfig?: boolean;
  /**
   * When `true`, defers microservice initialization until explicitly started
   * (NestJS v12 deferred microservice startup).
   * @default false
   */
  deferInitialization?: boolean;
}

export interface RpcExceptionFilter<T = any, R = any> {
  catch(exception: T, host: ArgumentsHost): R | Promise<R>;
}

export interface WsExceptionFilter<T = any> {
  catch(exception: T, host: ArgumentsHost): unknown | Promise<unknown>;
}

export interface WsMessageHandler<T = string> {
  message: T;
  callback: (...args: any[]) => unknown | Promise<unknown>;
  isAckHandledManually?: boolean;
}

export interface WebSocketAdapter<
  TServer = any,
  TClient = any,
  TOptions = any,
> {
  create(port: number, options?: TOptions): TServer;
  bindClientConnect(server: TServer, callback: Function): unknown;
  bindClientDisconnect?(client: TClient, callback: Function): unknown;
  bindMessageHandlers(
    client: TClient,
    handlers: WsMessageHandler[],
    transform?: (data: any) => unknown,
  ): unknown;
  close(server: TServer): unknown;
  closeClient?(client: TClient): unknown;
  attachToHttpAdapter?(httpAdapter: unknown): void;
}

export type ErrorHandler<TRequest = any, TResponse = any> = (
  error: unknown,
  req: TRequest,
  res: TResponse,
  next?: Function,
) => unknown;

export type RequestHandler<TRequest = any, TResponse = any> = (
  req: TRequest,
  res: TResponse,
  next?: Function,
) => unknown;

export type SecurityRequestHook<TRequest = any> = (
  request: TRequest,
  response: {
    setHeader(name: string, value: string): unknown;
    removeHeader(name: string): unknown;
  },
) => Error | undefined;

export interface RouteMatchingOptions {
  caseSensitive: boolean;
  ignoreTrailingSlash: boolean;
  removesTrailingSlash?: boolean;
  maxParamLength?: number;
  useSemicolonDelimiter?: boolean;
  caseSensitiveParamSuffix?: boolean;
}

export interface HttpServer<
  TRequest = Request,
  TResponse = ResponseContext,
  ServerInstance = any,
> {
  use?(...args: any[]): unknown;
  useBodyParser?(...args: any[]): unknown;
  get?: {
    (handler: RequestHandler<TRequest, TResponse>): unknown;
    (path: string, handler: RequestHandler<TRequest, TResponse>): unknown;
  };
  post?: {
    (handler: RequestHandler<TRequest, TResponse>): unknown;
    (path: string, handler: RequestHandler<TRequest, TResponse>): unknown;
  };
  head?: {
    (handler: RequestHandler<TRequest, TResponse>): unknown;
    (path: string, handler: RequestHandler<TRequest, TResponse>): unknown;
  };
  delete?: {
    (handler: RequestHandler<TRequest, TResponse>): unknown;
    (path: string, handler: RequestHandler<TRequest, TResponse>): unknown;
  };
  put?: {
    (handler: RequestHandler<TRequest, TResponse>): unknown;
    (path: string, handler: RequestHandler<TRequest, TResponse>): unknown;
  };
  patch?: {
    (handler: RequestHandler<TRequest, TResponse>): unknown;
    (path: string, handler: RequestHandler<TRequest, TResponse>): unknown;
  };
  propfind?: {
    (handler: RequestHandler<TRequest, TResponse>): unknown;
    (path: string, handler: RequestHandler<TRequest, TResponse>): unknown;
  };
  proppatch?: {
    (handler: RequestHandler<TRequest, TResponse>): unknown;
    (path: string, handler: RequestHandler<TRequest, TResponse>): unknown;
  };
  mkcol?: {
    (handler: RequestHandler<TRequest, TResponse>): unknown;
    (path: string, handler: RequestHandler<TRequest, TResponse>): unknown;
  };
  copy?: {
    (handler: RequestHandler<TRequest, TResponse>): unknown;
    (path: string, handler: RequestHandler<TRequest, TResponse>): unknown;
  };
  move?: {
    (handler: RequestHandler<TRequest, TResponse>): unknown;
    (path: string, handler: RequestHandler<TRequest, TResponse>): unknown;
  };
  lock?: {
    (handler: RequestHandler<TRequest, TResponse>): unknown;
    (path: string, handler: RequestHandler<TRequest, TResponse>): unknown;
  };
  unlock?: {
    (handler: RequestHandler<TRequest, TResponse>): unknown;
    (path: string, handler: RequestHandler<TRequest, TResponse>): unknown;
  };
  all?: {
    (path: string, handler: RequestHandler<TRequest, TResponse>): unknown;
    (handler: RequestHandler<TRequest, TResponse>): unknown;
  };
  options?: {
    (handler: RequestHandler<TRequest, TResponse>): unknown;
    (path: string, handler: RequestHandler<TRequest, TResponse>): unknown;
  };
  search?: {
    (handler: RequestHandler<TRequest, TResponse>): unknown;
    (path: string, handler: RequestHandler<TRequest, TResponse>): unknown;
  };
  query?: {
    (handler: RequestHandler<TRequest, TResponse>): unknown;
    (path: string, handler: RequestHandler<TRequest, TResponse>): unknown;
  };
  listen?(port: string | number, ...args: any[]): unknown;
  reply?(response: TResponse, body: unknown, statusCode?: number): unknown;
  status?(response: TResponse, statusCode: number): unknown;
  end?(response: TResponse, message?: string): unknown;
  render?(
    response: TResponse,
    view: string,
    options: Record<string, unknown>,
  ): unknown;
  redirect?(response: TResponse, statusCode: number, url: string): unknown;
  isHeadersSent?(response: TResponse): boolean;
  setHeader?(response: TResponse, name: string, value: string): unknown;
  appendHeader?(response: TResponse, name: string, value: string): unknown;
  setCookie?(
    response: TResponse,
    name: string,
    value: string,
    options?: CookieSerializeOptions,
  ): unknown;
  clearCookie?(
    response: TResponse,
    name: string,
    options?: CookieSerializeOptions,
  ): unknown;
  setErrorHandler?(handler: Function, prefix?: string): unknown;
  setNotFoundHandler?(
    handler: Function,
    prefix?: string,
    excludedRoutes?: RouteInfo[],
  ): unknown;
  useStaticAssets?(...args: any[]): this;
  setBaseViewsDir?(path: string | string[]): this;
  setViewEngine?(engineOrOptions: string | ViewEngineRenderer): this;
  createMiddlewareFactory?(
    method: RequestMethod,
  ):
    | ((path: string, callback: Function) => unknown)
    | Promise<(path: string, callback: Function) => unknown>;
  getRequestHostname?(request: TRequest): string;
  getRequestMethod?(request: TRequest): string;
  getRequestUrl?(request: TRequest): string;
  getInstance?(): ServerInstance;
  registerParserMiddleware?(...args: any[]): unknown;
  enableCors?(options: boolean | CorsOptions): unknown;
  registerSecurityHook?(hook: SecurityRequestHook<TRequest>): unknown;
  getHttpServer?(): ServerInstance;
  initHttpServer?(options: NestApplicationOptions): void;
  close(): unknown;
  beforeClose?(): unknown;
  getType?(): string;
  init?(): Promise<void>;
  applyVersionFilter?(
    handler: Function,
    version: VersionValue,
    versioningOptions: VersioningOptions,
  ): (req: TRequest, res: TResponse, next: () => void) => Function;
  normalizePath?(path: string): string;
  isRouteOrderSensitive?(): boolean;
  getRouteMatchingOptions?(): RouteMatchingOptions;
}

export interface ITransportServer<TOptions = unknown> {
  listen(callback?: (...args: any[]) => void): unknown;
  close(): unknown;
  unwrap?<T>(): T;
  readonly options?: TOptions;
}

export interface INestApplicationContext {
  select<T>(
    moduleType: Type<T> | DynamicModule,
    options?: { abortOnError?: boolean },
  ): INestApplicationContext;
  get<TInput = any, TResult = TInput>(
    typeOrToken: InjectionToken<TInput>,
    options: { strict?: boolean; each: true },
  ): TResult[];
  get<TInput = any, TResult = TInput>(
    typeOrToken: InjectionToken<TInput>,
    options?: { strict?: boolean; each?: false },
  ): TResult;
  resolve<TInput = any, TResult = TInput>(
    typeOrToken: InjectionToken<TInput>,
    contextId: ContextId | undefined,
    options: { strict?: boolean; each: true },
  ): Promise<TResult[]>;
  resolve<TInput = any, TResult = TInput>(
    typeOrToken: InjectionToken<TInput>,
    contextId?: ContextId,
    options?: { strict?: boolean; each?: false },
  ): Promise<TResult>;
  registerRequestByContextId<T = any>(request: T, contextId: ContextId): void;
  close(): Promise<void>;
  useLogger(logger: LoggerService | LogLevel[] | false): any;
  flushLogs(): void;
  enableShutdownHooks(
    signals?: readonly (ShutdownSignal | NodeJS.Signals | string)[],
    options?: ShutdownHooksOptions,
  ): this;
  init(): Promise<this>;
}

export interface INestMicroservice extends INestApplicationContext {
  useGlobalFilters(
    ...filters: Array<ExceptionFilter | Type<ExceptionFilter>>
  ): this;
  useGlobalPipes(...pipes: PipeLike[]): this;
  useGlobalInterceptors(
    ...interceptors: Array<NestInterceptor | Type<NestInterceptor>>
  ): this;
  useGlobalGuards(...guards: Array<CanActivate | Type<CanActivate>>): this;
  registerPreRequestHook(...hooks: PreRequestHook[]): this;
  useWebSocketAdapter?(adapter: WebSocketAdapter): this;
  listen(): Promise<any>;
  status?: unknown;
  on<
    EventsMap extends Record<string, Function> = Record<string, Function>,
    EventKey extends keyof EventsMap = keyof EventsMap,
    EventCallback extends EventsMap[EventKey] = EventsMap[EventKey],
  >(
    event: EventKey,
    callback: EventCallback,
  ): void;
  unwrap?<T>(): T;
  getTransportServer(): ITransportServer;
}

export interface INestApplication<
  TServer = any,
> extends INestApplicationContext {
  use(...args: Array<Type<NestMiddleware> | MiddlewareFunction | any>): this;
  enableCors(options?: boolean | CorsOptions): any;
  enableCsrfProtection(options?: CsrfProtectionOptions): this;
  useSecurityHeaders(options?: HttpSecurityHeadersOptions): this;
  enableVersioning(options?: VersioningOptions): this;
  useStaticAssets?(rootDir: string, options?: StaticAssetsOptions): this;
  setBaseViewsDir?(path: string): this;
  setViewEngine?(engine: string | ViewEngineRenderer): this;
  listen(port: number | string | any, ...args: any[]): Promise<any>;
  getUrl(): any;
  setGlobalPrefix(prefix: string | readonly string[], options?: any): this;
  useWebSocketAdapter(adapter: WebSocketAdapter): this;
  connectMicroservice<T extends MicroserviceInstance | object = any>(
    optionsOrServer: T,
    hybridOptions?: NestHybridApplicationOptions,
  ): any;
  getMicroservices(): readonly any[];
  getHttpServer(): TServer;
  getHttpAdapter(): any;
  startAllMicroservices(): Promise<any>;
  useGlobalFilters(
    ...filters: Array<ExceptionFilter | Type<ExceptionFilter>>
  ): this;
  useGlobalPipes(...pipes: PipeLike[]): this;
  useGlobalInterceptors(
    ...interceptors: Array<NestInterceptor | Type<NestInterceptor>>
  ): this;
  useGlobalGuards(...guards: Array<CanActivate | Type<CanActivate>>): this;
  close(): Promise<void>;
}
