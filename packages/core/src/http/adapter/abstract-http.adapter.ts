import {
  type CookieSerializeOptions,
  type CorsOptions,
  type HttpServer,
  type NestApplicationOptions,
  type RequestHandler,
  type RequestMethod,
  type RouteInfo,
  type SecurityRequestHook,
  type VersioningOptions,
  type VersionValue,
  type ViewEngineRenderer,
} from "../../common/index";
import { type CookieSigner, serializeCookie } from "../security/cookie";

type InstanceMethodMap = Record<
  string,
  ((...args: unknown[]) => unknown) | undefined
>;

/**
 * Clean Bun-native abstract base class implementing the NestJS v12 `HttpServer`
 * contract (ADR-001: zero Express, Fastify, or `node:http` dependencies).
 *
 * `BunHttpAdapter` extends this class, and third-party adapters or `instanceof
 * AbstractHttpAdapter` checks work identically to `@nestjs/core`.
 */
export abstract class AbstractHttpAdapter<
  TServer = any,
  TRequest = any,
  TResponse = any,
> implements HttpServer<TRequest, TResponse, TServer> {
  protected instance?: unknown;
  protected httpServer!: TServer;
  protected onRouteTriggered?: (
    requestMethod: RequestMethod,
    path: string,
  ) => void;
  protected cookieSigner?: CookieSigner;

  constructor(instance?: unknown) {
    this.instance = instance;
  }

  private invokeInstance(method: string, args: unknown[]): unknown {
    const fn = (this.instance as InstanceMethodMap | undefined)?.[method];
    return typeof fn === "function" ? fn.apply(this.instance, args) : undefined;
  }

  async init(): Promise<void> {
    // No-op async setup hook by default (idempotent override point)
  }

  use(...args: unknown[]): unknown {
    return this.invokeInstance("use", args);
  }

  get(handler: RequestHandler<TRequest, TResponse>): unknown;
  get(path: string, handler: RequestHandler<TRequest, TResponse>): unknown;
  get(...args: unknown[]): unknown {
    return this.invokeInstance("get", args);
  }

  post(handler: RequestHandler<TRequest, TResponse>): unknown;
  post(path: string, handler: RequestHandler<TRequest, TResponse>): unknown;
  post(...args: unknown[]): unknown {
    return this.invokeInstance("post", args);
  }

  head(handler: RequestHandler<TRequest, TResponse>): unknown;
  head(path: string, handler: RequestHandler<TRequest, TResponse>): unknown;
  head(...args: unknown[]): unknown {
    return this.invokeInstance("head", args);
  }

  delete(handler: RequestHandler<TRequest, TResponse>): unknown;
  delete(path: string, handler: RequestHandler<TRequest, TResponse>): unknown;
  delete(...args: unknown[]): unknown {
    return this.invokeInstance("delete", args);
  }

  put(handler: RequestHandler<TRequest, TResponse>): unknown;
  put(path: string, handler: RequestHandler<TRequest, TResponse>): unknown;
  put(...args: unknown[]): unknown {
    return this.invokeInstance("put", args);
  }

  patch(handler: RequestHandler<TRequest, TResponse>): unknown;
  patch(path: string, handler: RequestHandler<TRequest, TResponse>): unknown;
  patch(...args: unknown[]): unknown {
    return this.invokeInstance("patch", args);
  }

  propfind(handler: RequestHandler<TRequest, TResponse>): unknown;
  propfind(path: string, handler: RequestHandler<TRequest, TResponse>): unknown;
  propfind(...args: unknown[]): unknown {
    return this.invokeInstance("propfind", args);
  }

  proppatch(handler: RequestHandler<TRequest, TResponse>): unknown;
  proppatch(
    path: string,
    handler: RequestHandler<TRequest, TResponse>,
  ): unknown;
  proppatch(...args: unknown[]): unknown {
    return this.invokeInstance("proppatch", args);
  }

  mkcol(handler: RequestHandler<TRequest, TResponse>): unknown;
  mkcol(path: string, handler: RequestHandler<TRequest, TResponse>): unknown;
  mkcol(...args: unknown[]): unknown {
    return this.invokeInstance("mkcol", args);
  }

  copy(handler: RequestHandler<TRequest, TResponse>): unknown;
  copy(path: string, handler: RequestHandler<TRequest, TResponse>): unknown;
  copy(...args: unknown[]): unknown {
    return this.invokeInstance("copy", args);
  }

  move(handler: RequestHandler<TRequest, TResponse>): unknown;
  move(path: string, handler: RequestHandler<TRequest, TResponse>): unknown;
  move(...args: unknown[]): unknown {
    return this.invokeInstance("move", args);
  }

  lock(handler: RequestHandler<TRequest, TResponse>): unknown;
  lock(path: string, handler: RequestHandler<TRequest, TResponse>): unknown;
  lock(...args: unknown[]): unknown {
    return this.invokeInstance("lock", args);
  }

  unlock(handler: RequestHandler<TRequest, TResponse>): unknown;
  unlock(path: string, handler: RequestHandler<TRequest, TResponse>): unknown;
  unlock(...args: unknown[]): unknown {
    return this.invokeInstance("unlock", args);
  }

  all(handler: RequestHandler<TRequest, TResponse>): unknown;
  all(path: string, handler: RequestHandler<TRequest, TResponse>): unknown;
  all(...args: unknown[]): unknown {
    return this.invokeInstance("all", args);
  }

  search(handler: RequestHandler<TRequest, TResponse>): unknown;
  search(path: string, handler: RequestHandler<TRequest, TResponse>): unknown;
  search(...args: unknown[]): unknown {
    return this.invokeInstance("search", args);
  }

  query(handler: RequestHandler<TRequest, TResponse>): unknown;
  query(path: string, handler: RequestHandler<TRequest, TResponse>): unknown;
  query(...args: unknown[]): unknown {
    return this.invokeInstance("query", args);
  }

  options(handler: RequestHandler<TRequest, TResponse>): unknown;
  options(path: string, handler: RequestHandler<TRequest, TResponse>): unknown;
  options(...args: unknown[]): unknown {
    return this.invokeInstance("options", args);
  }

  listen(port: string | number, callback?: () => void): unknown;
  listen(
    port: string | number,
    hostname: string,
    callback?: () => void,
  ): unknown;
  listen(port: string | number, ...args: unknown[]): unknown {
    return this.invokeInstance("listen", [port, ...args]);
  }

  getHttpServer(): TServer {
    return this.httpServer;
  }

  setHttpServer(httpServer: TServer): void {
    this.httpServer = httpServer;
  }

  setInstance<T = any>(instance: T): void {
    this.instance = instance;
  }

  getInstance<T = any>(): T {
    return this.instance as T;
  }

  normalizePath(path: string): string {
    return path;
  }

  setOnRouteTriggered(
    onRouteTriggered: (requestMethod: RequestMethod, path: string) => void,
  ): void {
    this.onRouteTriggered = onRouteTriggered;
  }

  getOnRouteTriggered():
    ((requestMethod: RequestMethod, path: string) => void) | undefined {
    return this.onRouteTriggered;
  }

  setOnRequestHook(_onRequestHook: Function): void {
    // No-op by default; overridden by concrete adapters
  }

  setOnResponseHook(_onResponseHook: Function): void {
    // No-op by default; overridden by concrete adapters
  }

  beforeClose(): void {
    // No-op by default; overridden by concrete adapters
  }

  mapException(error: unknown): unknown {
    return error;
  }

  registerSecurityHook(hook: SecurityRequestHook<TRequest>): unknown {
    return this.use(
      (req: TRequest, res: TResponse, next: (err?: unknown) => unknown) => {
        const resLike = res as
          | {
              setHeader?: (n: string, v: string) => unknown;
              header?: (n: string, v: string) => unknown;
              removeHeader?: (n: string) => unknown;
            }
          | undefined;
        const rejection = hook(req, {
          setHeader: (name: string, value: string) => {
            if (typeof resLike?.setHeader === "function") {
              resLike.setHeader(name, value);
            } else if (typeof resLike?.header === "function") {
              resLike.header(name, value);
            } else {
              this.setHeader(res, name, value);
            }
          },
          removeHeader: (name: string) => {
            if (typeof resLike?.removeHeader === "function") {
              resLike.removeHeader(name);
            }
          },
        });
        if (rejection instanceof Error) {
          return next(rejection);
        }
        return next();
      },
    );
  }

  setCookie(
    response: TResponse,
    name: string,
    value: string,
    options?: CookieSerializeOptions,
  ): unknown {
    const opts: CookieSerializeOptions = {
      path: "/",
      ...options,
    };

    if (
      (opts.sameSite === "none" || opts.partitioned === true) &&
      !opts.secure
    ) {
      throw new TypeError(
        `Cookie "${name}" with sameSite="none" or partitioned=true requires secure=true.`,
      );
    }

    let finalValue = value;
    if (opts.signed) {
      if (!this.cookieSigner) {
        throw new Error(
          `Cannot sign cookie "${name}" because no cookieSigner (cookies.secret) is configured.`,
        );
      }
      finalValue = this.cookieSigner.sign(value);
    }

    const serialized = serializeCookie(name, finalValue, opts);
    return this.appendHeader(response, "Set-Cookie", serialized);
  }

  clearCookie(
    response: TResponse,
    name: string,
    options?: CookieSerializeOptions,
  ): unknown {
    const opts: CookieSerializeOptions = {
      path: "/",
      ...options,
      expires: new Date(0),
      maxAge: 0,
      signed: false,
    };
    const serialized = serializeCookie(name, "", opts);
    return this.appendHeader(response, "Set-Cookie", serialized);
  }

  setCookieSigner(signer: CookieSigner | undefined): void {
    this.cookieSigner = signer;
  }

  abstract close(): unknown;
  abstract initHttpServer(options: NestApplicationOptions): unknown;
  abstract useStaticAssets(...args: unknown[]): this;
  abstract setViewEngine(engine: string | ViewEngineRenderer): this;
  abstract getRequestHostname(request: TRequest): string;
  abstract getRequestMethod(request: TRequest): string;
  abstract getRequestUrl(request: TRequest): string;
  abstract status(response: TResponse, statusCode: number): unknown;
  abstract reply(
    response: TResponse,
    body: unknown,
    statusCode?: number,
  ): unknown;
  abstract end(response: TResponse, message?: string): unknown;
  abstract render(
    response: TResponse,
    view: string,
    options: Record<string, unknown>,
  ): unknown;
  abstract redirect(
    response: TResponse,
    statusCode: number,
    url: string,
  ): unknown;
  abstract setErrorHandler(handler: Function, prefix?: string): unknown;
  abstract setNotFoundHandler(
    handler: Function,
    prefix?: string,
    excludedRoutes?: RouteInfo[],
  ): unknown;
  abstract isHeadersSent(response: TResponse): boolean;
  abstract getHeader(response: TResponse, name: string): unknown;
  abstract setHeader(
    response: TResponse,
    name: string,
    value: string,
  ): unknown;
  abstract appendHeader(
    response: TResponse,
    name: string,
    value: string,
  ): unknown;
  abstract registerParserMiddleware(
    prefix?: string,
    rawBody?: boolean,
  ): unknown;
  abstract enableCors(
    options?: boolean | CorsOptions,
    prefix?: string,
  ): unknown;
  abstract createMiddlewareFactory(
    requestMethod: RequestMethod,
  ):
    | ((path: string, callback: Function) => unknown)
    | Promise<(path: string, callback: Function) => unknown>;
  abstract getType(): string;
  abstract applyVersionFilter(
    handler: Function,
    version: VersionValue,
    versioningOptions: VersioningOptions,
  ): (req: TRequest, res: TResponse, next: () => void) => Function;
}
