import type { RequestMethod, RouteHttpMethod } from "../enums/scope.enum";
import type { Type } from "./type.interface";

export interface CookieOptions {
  maxAge?: number;
  expires?: Date;
  path?: string;
  domain?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: "strict" | "lax" | "none" | boolean;
  partitioned?: boolean;
  priority?: "low" | "medium" | "high";
  /**
   * Sign cookie value using the first secret configured via `cookies.secret`.
   * Signed cookies are read with `@SignedCookies()`.
   * @default false
   */
  signed?: boolean;
}

export type CookieSerializeOptions = CookieOptions;

export interface CookiesOptions {
  /**
   * Secret (or secrets for key rotation) used to HMAC-SHA256 sign and verify
   * cookies written with `{ signed: true }` and read with `@SignedCookies()`.
   */
  secret?: string | string[];
}

export type ContextType = "http" | "ws" | "rpc";

/**
 * Mutable response builder injected via `@Res()` and passed to middleware
 * (ADR-008 & ADR-010). Applied during native Web Response serialization.
 */
export interface ResponseContext {
  status(code: number): this;
  getStatus(): number | undefined;
  header(name: string, value: string): this;
  appendHeader(name: string, value: string): this;
  removeHeader(name: string): this;
  getHeaders(): Headers;
  cookie(name: string, value: string, options?: CookieOptions): this;
  clearCookie(name: string, options?: CookieOptions): this;
}

export interface HttpArgumentsHost {
  getRequest<T = Request>(): T;
  getResponse<T = ResponseContext>(): T;
  getNext<T = NextFunction>(): T;
}

export interface WsArgumentsHost {
  getData<T = any>(): T;
  getClient<T = any>(): T;
  getPattern(): string;
}

export interface RpcArgumentsHost {
  getData<T = any>(): T;
  getContext<T = any>(): T;
}

export interface ArgumentsHost {
  getArgs<T extends Array<any> = any[]>(): T;
  getArgByIndex<T = any>(index: number): T;
  switchToRpc(): RpcArgumentsHost;
  switchToHttp(): HttpArgumentsHost;
  switchToWs(): WsArgumentsHost;
  getType<TContext extends string = ContextType>(): TContext;
}

export interface ExecutionContext extends ArgumentsHost {
  getClass<T = any>(): Type<T>;
  getHandler(): Function;
  getHandlerKey?(): string | symbol;
}

export interface CanActivate {
  canActivate(context: ExecutionContext): boolean | Promise<boolean>;
}

export interface CallHandler<T = any> {
  handle(): Promise<T>;
}

export interface BunestInterceptor<T = any, R = any> {
  intercept(context: ExecutionContext, next: CallHandler<T>): R | Promise<R>;
}

export interface ExceptionFilter<T = any> {
  catch(exception: T, host: ArgumentsHost): unknown | Promise<unknown>;
}

export type NextFunction = () => Promise<Response | void> | Response | void;

export type MiddlewareFunction = (
  req: Request,
  res: ResponseContext,
  next: NextFunction,
) => Response | void | Promise<Response | void>;

export interface BunestMiddleware {
  use(
    req: Request,
    res: ResponseContext,
    next: NextFunction,
  ): Response | void | Promise<Response | void>;
}

export interface RouteInfo {
  path: string;
  method: RequestMethod | RouteHttpMethod;
}

export interface MiddlewareProxy {
  exclude(...routes: Array<string | RouteInfo>): MiddlewareProxy;
  forRoutes(
    ...routes: Array<string | Type<any> | RouteInfo>
  ): MiddlewareConsumer;
}

export interface MiddlewareConsumer {
  apply(
    ...middleware: Array<Type<BunestMiddleware> | MiddlewareFunction>
  ): MiddlewareProxy;
}

export interface BunestModule {
  configure(consumer: MiddlewareConsumer): Promise<void> | void;
}

export type GuardLike = CanActivate | Type<CanActivate>;
export type InterceptorLike = BunestInterceptor | Type<BunestInterceptor>;
export type ExceptionFilterLike = ExceptionFilter | Type<ExceptionFilter>;
export type MiddlewareLike =
  | Type<BunestMiddleware>
  | BunestMiddleware
  | MiddlewareFunction
  | Type<unknown>
  | Function;
