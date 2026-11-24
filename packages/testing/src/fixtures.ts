import {
  Reflector,
  type CallHandler,
  type ContextType,
  type ExecutionContext,
  type InjectionToken,
  type NextFunction,
  type ResponseContext,
  type Type,
  type ValueProvider,
} from "@bunest/core";
import {
  HttpExecutionContext,
  HttpResponseContext,
  RequestContext,
  requestContextStorage,
  type RequestContextOptions,
} from "@bunest/core/http";
import type { TestRequestOptions } from "./interfaces/testing.interface";
import {
  CapturingLogger,
  type CapturingLoggerOptions,
} from "./loggers/capturing-logger";
import {
  DEFAULT_TEST_BASE_URL,
  buildTestRequest,
} from "./utils/request-builder.util";

export interface MockRequestOptions extends TestRequestOptions {
  method?: string;
  baseUrl?: string;
}

export interface MockWsContextOptions {
  client?: unknown;
  data?: unknown;
  pattern?: string;
}

export interface MockRpcContextOptions {
  data?: unknown;
  context?: unknown;
}

export interface MockExecutionContextOptions {
  request?: Request;
  responseContext?: ResponseContext;
  params?: Record<string, string>;
  hostParams?: Record<string, string>;
  controllerClass?: Type<unknown>;
  handler?: Function;
  handlerKey?: string | symbol;
  next?: NextFunction;
  contextType?: ContextType;
  ws?: MockWsContextOptions;
  rpc?: MockRpcContextOptions;
}

export interface MockCallHandler<T = unknown> extends CallHandler<T> {
  readonly called: boolean;
  readonly callCount: number;
}

class DefaultMockController {
  handle(): void {}
}

/**
 * Constructs a native Web `Request` for isolated unit tests of middleware,
 * guards, pipes, interceptors, and exception filters.
 */
export function createMockRequest(
  pathOrUrl = "/",
  options: MockRequestOptions = {},
): Request {
  return buildTestRequest(
    options.method ?? "GET",
    options.baseUrl ?? DEFAULT_TEST_BASE_URL,
    pathOrUrl,
    {},
    options,
  );
}

/**
 * Constructs a fresh `HttpResponseContext` for isolated unit tests of
 * middleware, controllers using `@Res()`, and exception filters.
 */
export function createMockResponseContext(): HttpResponseContext {
  return new HttpResponseContext();
}

/**
 * Constructs a `CapturingLogger` for asserting log output in isolated unit tests.
 */
export function createMockLogger(
  options: CapturingLoggerOptions = {},
): CapturingLogger {
  return new CapturingLogger(options);
}

/**
 * Constructs a `Reflector` instance with optional method overrides for isolated
 * unit tests of metadata-driven guards and interceptors.
 */
export function createMockReflector(
  overrides: Partial<Reflector> = {},
): Reflector {
  const reflector = new Reflector();
  return Object.assign(reflector, overrides);
}

/**
 * Runs a callback inside an active `AsyncLocalStorage` `RequestContext` so code
 * calling `getCurrentRequestContext()` can be unit-tested in isolation.
 */
export async function runWithMockRequestContext<T>(
  requestOrPath: Request | string,
  fn: (ctx: RequestContext) => T | Promise<T>,
  options: Omit<RequestContextOptions, "request"> & MockRequestOptions = {},
): Promise<T> {
  const request =
    requestOrPath instanceof Request
      ? requestOrPath
      : createMockRequest(requestOrPath, options);

  const ctx = new RequestContext({
    request,
    server: options.server,
    params: options.params,
    hostParams: options.hostParams,
    pathname: options.pathname,
    trustProxy: options.trustProxy,
    maxBodyBytes: options.maxBodyBytes,
    responseContext: options.responseContext,
  });

  return await requestContextStorage.run(ctx, () => fn(ctx));
}

/**
 * Constructs an `ExecutionContext` for isolated unit tests of guards,
 * interceptors, custom param decorators, and exception filters.
 *
 * Returns a real `HttpExecutionContext` for standard HTTP contexts, and
 * cleanly isolates WS/RPC payloads without leaking HTTP objects when
 * `contextType` is `"ws"` / `"rpc"` or when `ws` / `rpc` options are provided.
 */
export function createMockExecutionContext(
  options: MockExecutionContextOptions = {},
): ExecutionContext {
  const controllerClass = options.controllerClass ?? DefaultMockController;
  const handlerKey = options.handlerKey ?? "handle";
  const protoHandler = (
    controllerClass.prototype as Record<string | symbol, unknown> | undefined
  )?.[handlerKey];
  const handler =
    options.handler ??
    (typeof protoHandler === "function"
      ? (protoHandler as Function)
      : DefaultMockController.prototype.handle);
  const request = options.request ?? createMockRequest("/");
  const next: NextFunction = options.next ?? (() => undefined);
  const contextType = options.contextType ?? "http";
  const httpResponseContext =
    options.responseContext instanceof HttpResponseContext
      ? options.responseContext
      : new HttpResponseContext();

  const requestContext = new RequestContext({
    request,
    params: options.params,
    hostParams: options.hostParams,
    responseContext: httpResponseContext,
  });

  const ctx = new HttpExecutionContext(
    requestContext,
    controllerClass,
    handler,
    handlerKey,
    next,
  );

  const hasCustomWsOrRpc =
    options.ws !== undefined ||
    options.rpc !== undefined ||
    contextType === "ws" ||
    contextType === "rpc";

  if (
    contextType === "http" &&
    !hasCustomWsOrRpc &&
    (!options.responseContext ||
      options.responseContext instanceof HttpResponseContext)
  ) {
    return ctx;
  }

  const customRes = options.responseContext ?? httpResponseContext;
  const wsClient = options.ws?.client;
  const wsData = options.ws?.data;
  const wsPattern = options.ws?.pattern ?? "";
  const rpcData = options.rpc?.data;
  const rpcContext = options.rpc?.context;

  const args: unknown[] =
    contextType === "ws"
      ? [wsClient, wsData, wsPattern]
      : contextType === "rpc"
        ? [rpcData, rpcContext]
        : [request, customRes, next];

  return {
    getType: <TContext extends string = ContextType>() =>
      contextType as TContext,
    getClass: <T = any>() => ctx.getClass<T>(),
    getHandler: () => ctx.getHandler(),
    getHandlerKey: () => ctx.getHandlerKey(),
    getArgs: <T extends Array<any> = any[]>() => args as unknown as T,
    getArgByIndex: <T = any>(index: number) => args[index] as T,
    switchToHttp: () => ({
      getRequest: <T = Request>() => request as unknown as T,
      getResponse: <T = ResponseContext>() => customRes as unknown as T,
      getNext: <T = NextFunction>() => next as unknown as T,
    }),
    switchToWs: () => ({
      getClient: <T = any>() => wsClient as T,
      getData: <T = any>() => wsData as T,
      getPattern: () => wsPattern,
    }),
    switchToRpc: () => ({
      getData: <T = any>() => rpcData as T,
      getContext: <T = any>() => rpcContext as T,
    }),
  };
}

/**
 * Constructs a `CallHandler` fixture that tracks invocation counts so tests
 * can assert whether an interceptor forwarded or short-circuited execution.
 */
export function createMockCallHandler<T = unknown>(
  valueOrFactory: T | (() => T | Promise<T>),
): MockCallHandler<T> {
  let count = 0;

  return {
    get called(): boolean {
      return count > 0;
    },
    get callCount(): number {
      return count;
    },
    async handle(): Promise<T> {
      count += 1;
      if (typeof valueOrFactory === "function") {
        return await (valueOrFactory as () => T | Promise<T>)();
      }
      return valueOrFactory;
    },
  };
}

/**
 * Helper for creating typed mock `ValueProvider` definitions for test modules.
 */
export function createMockProvider<T>(
  token: InjectionToken<T>,
  mockValue: Partial<T>,
): ValueProvider<T> {
  return {
    provide: token,
    useValue: mockValue as T,
  };
}
