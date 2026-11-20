import {
  type CookieSerializeOptions,
  type HttpServer,
  type NestApplicationOptions,
  type RequestHandler,
  type RequestMethod,
  type RouteInfo,
  type SecurityRequestHook,
  type VersioningOptions,
  type VersionValue,
  type ViewEngineRenderer,
} from "@bunest/common";
import { type CookieSigner, serializeCookie } from "../security/cookie";

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
> implements HttpServer<TRequest, TResponse, TServer>
{
  protected instance?: any;
  protected httpServer!: TServer;
  protected onRouteTriggered?: (
    requestMethod: RequestMethod,
    path: string,
  ) => void;
  protected cookieSigner?: CookieSigner;

  constructor(instance?: any) {
    this.instance = instance;
  }

  async init(): Promise<void> {
    // No-op async setup hook by default (idempotent override point)
  }

  use(...args: any[]): any {
    return this.instance?.use?.(...args);
  }

  get(handler: RequestHandler<TRequest, TResponse>): any;
  get(path: any, handler: RequestHandler<TRequest, TResponse>): any;
  get(...args: any[]): any {
    return this.instance?.get?.(...args);
  }

  post(handler: RequestHandler<TRequest, TResponse>): any;
  post(path: any, handler: RequestHandler<TRequest, TResponse>): any;
  post(...args: any[]): any {
    return this.instance?.post?.(...args);
  }

  head(handler: RequestHandler<TRequest, TResponse>): any;
  head(path: any, handler: RequestHandler<TRequest, TResponse>): any;
  head(...args: any[]): any {
    return this.instance?.head?.(...args);
  }

  delete(handler: RequestHandler<TRequest, TResponse>): any;
  delete(path: any, handler: RequestHandler<TRequest, TResponse>): any;
  delete(...args: any[]): any {
    return this.instance?.delete?.(...args);
  }

  put(handler: RequestHandler<TRequest, TResponse>): any;
  put(path: any, handler: RequestHandler<TRequest, TResponse>): any;
  put(...args: any[]): any {
    return this.instance?.put?.(...args);
  }

  patch(handler: RequestHandler<TRequest, TResponse>): any;
  patch(path: any, handler: RequestHandler<TRequest, TResponse>): any;
  patch(...args: any[]): any {
    return this.instance?.patch?.(...args);
  }

  propfind(handler: RequestHandler<TRequest, TResponse>): any;
  propfind(path: any, handler: RequestHandler<TRequest, TResponse>): any;
  propfind(...args: any[]): any {
    return this.instance?.propfind?.(...args);
  }

  proppatch(handler: RequestHandler<TRequest, TResponse>): any;
  proppatch(path: any, handler: RequestHandler<TRequest, TResponse>): any;
  proppatch(...args: any[]): any {
    return this.instance?.proppatch?.(...args);
  }

  mkcol(handler: RequestHandler<TRequest, TResponse>): any;
  mkcol(path: any, handler: RequestHandler<TRequest, TResponse>): any;
  mkcol(...args: any[]): any {
    return this.instance?.mkcol?.(...args);
  }

  copy(handler: RequestHandler<TRequest, TResponse>): any;
  copy(path: any, handler: RequestHandler<TRequest, TResponse>): any;
  copy(...args: any[]): any {
    return this.instance?.copy?.(...args);
  }

  move(handler: RequestHandler<TRequest, TResponse>): any;
  move(path: any, handler: RequestHandler<TRequest, TResponse>): any;
  move(...args: any[]): any {
    return this.instance?.move?.(...args);
  }

  lock(handler: RequestHandler<TRequest, TResponse>): any;
  lock(path: any, handler: RequestHandler<TRequest, TResponse>): any;
  lock(...args: any[]): any {
    return this.instance?.lock?.(...args);
  }

  unlock(handler: RequestHandler<TRequest, TResponse>): any;
  unlock(path: any, handler: RequestHandler<TRequest, TResponse>): any;
  unlock(...args: any[]): any {
    return this.instance?.unlock?.(...args);
  }

  all(handler: RequestHandler<TRequest, TResponse>): any;
  all(path: any, handler: RequestHandler<TRequest, TResponse>): any;
  all(...args: any[]): any {
    return this.instance?.all?.(...args);
  }

  search(handler: RequestHandler<TRequest, TResponse>): any;
  search(path: any, handler: RequestHandler<TRequest, TResponse>): any;
  search(...args: any[]): any {
    return this.instance?.search?.(...args);
  }

  query(handler: RequestHandler<TRequest, TResponse>): any;
  query(path: any, handler: RequestHandler<TRequest, TResponse>): any;
  query(...args: any[]): any {
    return this.instance?.query?.(...args);
  }

  options(handler: RequestHandler<TRequest, TResponse>): any;
  options(path: any, handler: RequestHandler<TRequest, TResponse>): any;
  options(...args: any[]): any {
    return this.instance?.options?.(...args);
  }

  listen(port: string | number, callback?: () => void): any;
  listen(port: string | number, hostname: string, callback?: () => void): any;
  listen(port: any, ...args: any[]): any {
    return this.instance?.listen?.(port, ...args);
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
    | ((requestMethod: RequestMethod, path: string) => void)
    | undefined {
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

  registerSecurityHook(hook: SecurityRequestHook<TRequest>): any {
    return this.use(
      (req: TRequest, res: any, next: (err?: unknown) => unknown) => {
        const rejection = hook(req, {
          setHeader: (name: string, value: string) => {
            if (typeof res?.setHeader === "function") {
              res.setHeader(name, value);
            } else if (typeof res?.header === "function") {
              res.header(name, value);
            } else {
              this.setHeader(res, name, value);
            }
          },
          removeHeader: (name: string) => {
            if (typeof res?.removeHeader === "function") {
              res.removeHeader(name);
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
  ): any {
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
  ): any {
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

  abstract close(): any;
  abstract initHttpServer(options: NestApplicationOptions): any;
  abstract useStaticAssets(...args: any[]): any;
  abstract setViewEngine(engine: string | ViewEngineRenderer): any;
  abstract getRequestHostname(request: any): any;
  abstract getRequestMethod(request: any): any;
  abstract getRequestUrl(request: any): any;
  abstract status(response: any, statusCode: number): any;
  abstract reply(response: any, body: any, statusCode?: number): any;
  abstract end(response: any, message?: string): any;
  abstract render(response: any, view: string, options: any): any;
  abstract redirect(response: any, statusCode: number, url: string): any;
  abstract setErrorHandler(handler: Function, prefix?: string): any;
  abstract setNotFoundHandler(
    handler: Function,
    prefix?: string,
    excludedRoutes?: RouteInfo[],
  ): any;
  abstract isHeadersSent(response: any): any;
  abstract getHeader(response: any, name: string): any;
  abstract setHeader(response: any, name: string, value: string): any;
  abstract appendHeader(response: any, name: string, value: string): any;
  abstract registerParserMiddleware(prefix?: string, rawBody?: boolean): any;
  abstract enableCors(options?: any, prefix?: string): any;
  abstract createMiddlewareFactory(
    requestMethod: RequestMethod,
  ):
    | ((path: string, callback: Function) => any)
    | Promise<(path: string, callback: Function) => any>;
  abstract getType(): string;
  abstract applyVersionFilter(
    handler: Function,
    version: VersionValue,
    versioningOptions: VersioningOptions,
  ): (req: TRequest, res: TResponse, next: () => void) => Function;
}
