import {
  APP_INTERCEPTOR,
  HttpException,
  Inject,
  Injectable,
  METADATA_KEYS,
  MetadataRegistry,
  Module,
  Optional,
  type BunestInterceptor,
  type BunestMiddleware,
  type CallHandler,
  type ControllerMetadata,
  type DynamicModule,
  type ExecutionContext,
  type FactoryDependency,
  type MiddlewareFunction,
  type ModuleMetadata,
  type NextFunction,
  type ResponseContext,
} from "@bunest/core";
import { first, toArray } from "@bunest/core/common";
import {
  extractTraceContext,
  formatTraceParent,
  traceContextStorage,
  type SpanContext,
  type TraceCarrier,
} from "./trace-context";
import { SpanAspectHandler } from "../decorators/observability.decorators";
import { TRACER_OPTIONS, Tracer, type TracerOptions } from "./tracer";

function extractPathname(rawUrl: string): string {
  try {
    return new URL(rawUrl).pathname;
  } catch {
    return rawUrl;
  }
}

function resolveHttpRouteTemplate(context: ExecutionContext): string {
  const ctrl = context.getClass();
  const handler = context.getHandler();
  const ctrlMeta = MetadataRegistry.get<ControllerMetadata>(
    METADATA_KEYS.CONTROLLER,
    ctrl,
  );
  const methodPath = MetadataRegistry.get<string | string[]>(
    METADATA_KEYS.ROUTE_PATH,
    handler,
  );

  const rawPrefix = first(toArray(ctrlMeta?.path)) ?? "";
  const rawSuffix = first(toArray(methodPath)) ?? "";

  const combined = `/${rawPrefix}/${rawSuffix}`
    .replace(/\/+/g, "/")
    .replace(/\/$/, "");
  return combined || "/";
}

function resolveStatusFromResult(
  result: unknown,
  req: Request,
  res: ResponseContext | undefined,
): number {
  if (result instanceof Response) {
    return result.status;
  }
  const explicit = res?.getStatus?.();
  if (explicit !== undefined) {
    return explicit;
  }
  return req.method.toUpperCase() === "POST" ? 201 : 200;
}

const UNSAFE_CARRIER_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function toTraceCarrier(candidate: unknown): TraceCarrier | undefined {
  if (!candidate || typeof candidate !== "object") {
    return undefined;
  }
  if (candidate instanceof Headers) {
    return candidate;
  }
  if (candidate instanceof Map) {
    const out: Record<string, string> = {};
    for (const [k, v] of candidate.entries()) {
      const key = String(k);
      if (UNSAFE_CARRIER_KEYS.has(key)) continue;
      if (typeof v === "string") {
        out[key] = v;
      }
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  const obj = candidate as Record<string, unknown> & {
    getMap?: () => Record<string, unknown>;
    keys?: () => Iterable<string>;
    values?: (key: string) => Iterable<unknown>;
  };

  if (typeof obj.getMap === "function") {
    return toTraceCarrier(obj.getMap());
  }

  if (typeof obj.keys === "function" && typeof obj.values === "function") {
    const out: Record<string, string> = {};
    for (const key of obj.keys()) {
      if (UNSAFE_CARRIER_KEYS.has(key)) continue;
      for (const val of obj.values(key)) {
        if (typeof val === "string") {
          out[key] = val;
          break;
        }
      }
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (UNSAFE_CARRIER_KEYS.has(key)) continue;
    if (typeof value === "string") {
      out[key] = value;
    } else if (Array.isArray(value) && typeof value[0] === "string") {
      out[key] = value[0];
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function readHeaderValue(
  carrier: TraceCarrier,
  name: string,
): string | undefined {
  if (carrier instanceof Headers) {
    return carrier.get(name) ?? undefined;
  }
  if (carrier instanceof Map) {
    const lower = name.toLowerCase();
    for (const [k, v] of carrier.entries()) {
      if (k.toLowerCase() === lower) return v;
    }
    return undefined;
  }
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(carrier)) {
    if (k.toLowerCase() === lower && typeof v === "string") return v;
  }
  return undefined;
}

function extractTraceFromCandidates(candidates: readonly unknown[]): {
  parentContext?: SpanContext;
  requestId?: string;
} {
  let parentContext: SpanContext | undefined;
  let requestId: string | undefined;

  for (const candidate of candidates) {
    const carrier = toTraceCarrier(candidate);
    if (!carrier) continue;
    if (!parentContext) {
      const extracted = extractTraceContext(carrier);
      if (extracted) {
        parentContext = extracted;
        if (extracted.requestId && !requestId) {
          requestId = extracted.requestId;
        }
      }
    }
    if (!requestId) {
      const reqId = readHeaderValue(carrier, "x-request-id");
      if (reqId) {
        requestId = reqId;
      }
    }
    if (parentContext && requestId) {
      break;
    }
  }

  return { parentContext, requestId };
}

function formatPatternLabel(pattern: unknown, fallback: string): string {
  if (typeof pattern === "string" && pattern.length > 0) {
    return pattern;
  }
  if (pattern !== undefined && pattern !== null && typeof pattern === "object") {
    try {
      return JSON.stringify(pattern);
    } catch {
      return fallback;
    }
  }
  return fallback;
}

/**
 * Creates an HTTP tracing middleware extracting W3C `traceparent`, starting an
 * HTTP `SERVER` span, propagating `traceparent` on response headers, and running
 * downstream handlers inside `traceContextStorage`.
 */
export function createTracingMiddleware(tracer: Tracer): MiddlewareFunction {
  return async (req: Request, res: ResponseContext, next: NextFunction) => {
    const parentContext = extractTraceContext(req.headers);
    const requestId =
      req.headers.get("x-request-id") ??
      parentContext?.requestId ??
      crypto.randomUUID();
    const pathname = extractPathname(req.url);
    const method = req.method.toUpperCase();

    const span = tracer.startSpan(`HTTP ${method} ${pathname}`, {
      kind: "SERVER",
      parentContext,
      requestId,
      attributes: {
        "http.method": method,
        "http.route": pathname,
        "url.path": pathname,
      },
    });

    res.header("traceparent", formatTraceParent(span.context));
    res.header("x-request-id", requestId);

    return traceContextStorage.run(span.context, async () => {
      try {
        const result = await next();
        const status = resolveStatusFromResult(result, req, res);
        span.setAttribute("http.status_code", status);
        if (status >= 500) {
          span.setStatus("ERROR", `HTTP ${status}`);
        } else {
          span.setStatus("OK");
        }
        return result;
      } catch (err) {
        const status = err instanceof HttpException ? err.getStatus() : 500;
        span.setAttribute("http.status_code", status);
        span.recordException(err);
        throw err;
      } finally {
        span.end();
      }
    });
  };
}

@Injectable()
export class TracingMiddleware implements BunestMiddleware {
  private readonly fn: MiddlewareFunction;

  constructor(tracer: Tracer) {
    this.fn = createTracingMiddleware(tracer);
  }

  use(req: Request, res: ResponseContext, next: NextFunction) {
    return this.fn(req, res, next);
  }
}

/**
 * Interceptor extracting W3C `traceparent` across `http`, `ws`, and `rpc`
 * execution contexts, recording transport/route/handler metadata, and
 * propagating active `SpanContext` across downstream async operations.
 */
@Injectable()
export class TracingInterceptor implements BunestInterceptor {
  constructor(private readonly tracer: Tracer) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<unknown> {
    const type = context.getType();
    if (type === "http") {
      return this.interceptHttp(context, next);
    }
    if (type === "ws") {
      return this.interceptWs(context, next);
    }
    if (type === "rpc") {
      return this.interceptRpc(context, next);
    }
    return next.handle();
  }

  private async interceptHttp(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<ResponseContext | undefined>();
    const method = req.method.toUpperCase();
    const route = resolveHttpRouteTemplate(context);
    const pathname = extractPathname(req.url);

    const activeContext = traceContextStorage.getCurrentSpanContext();
    const parentContext = activeContext ?? extractTraceContext(req.headers);
    const requestId =
      parentContext?.requestId ??
      req.headers.get("x-request-id") ??
      crypto.randomUUID();

    const span = this.tracer.startSpan(`HTTP ${method} ${route}`, {
      kind: activeContext ? "INTERNAL" : "SERVER",
      parentContext,
      requestId,
      attributes: {
        "http.method": method,
        "http.route": route,
        "url.path": pathname,
        "code.namespace": context.getClass()?.name || "Controller",
        "code.function":
          String(context.getHandlerKey?.() ?? context.getHandler()?.name) ||
          "handler",
      },
    });

    if (res && typeof res.header === "function") {
      res.header("traceparent", formatTraceParent(span.context));
      res.header("x-request-id", requestId);
    }

    return traceContextStorage.run(span.context, async () => {
      try {
        const result = await next.handle();
        const status = resolveStatusFromResult(result, req, res);
        span.setAttribute("http.status_code", status);
        if (status >= 500) {
          span.setStatus("ERROR", `HTTP ${status}`);
        } else {
          span.setStatus("OK");
        }
        return result;
      } catch (err) {
        const status = err instanceof HttpException ? err.getStatus() : 500;
        span.setAttribute("http.status_code", status);
        span.recordException(err);
        throw err;
      } finally {
        span.end();
      }
    });
  }

  private async interceptWs(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<unknown> {
    const ws = context.switchToWs();
    const client = ws.getClient<Record<string, unknown> | undefined>();
    const data = ws.getData<unknown>();
    const handlerName =
      String(context.getHandlerKey?.() ?? context.getHandler()?.name ?? "") ||
      "handler";
    const pattern = formatPatternLabel(ws.getPattern?.(), handlerName);

    const dataObj =
      data && typeof data === "object"
        ? (data as Record<string, unknown>)
        : undefined;
    const clientReq = client?.request as { headers?: unknown } | undefined;
    const clientData = client?.data as { headers?: unknown } | undefined;

    const activeContext = traceContextStorage.getCurrentSpanContext();
    const extracted = extractTraceFromCandidates([
      dataObj?.headers,
      dataObj?.metadata,
      dataObj,
      clientReq?.headers,
      client?.headers,
      clientData?.headers,
    ]);

    const parentContext = activeContext ?? extracted.parentContext;
    const requestId =
      parentContext?.requestId ?? extracted.requestId ?? crypto.randomUUID();

    const span = this.tracer.startSpan(`WS ${pattern}`, {
      kind: activeContext ? "INTERNAL" : "SERVER",
      parentContext,
      requestId,
      attributes: {
        "messaging.system": "websocket",
        "messaging.operation": "process",
        "ws.event": pattern,
        ...(typeof client?.id === "string"
          ? { "ws.client.id": client.id }
          : {}),
        "code.namespace": context.getClass()?.name || "Gateway",
        "code.function": handlerName,
      },
    });

    return traceContextStorage.run(span.context, async () => {
      try {
        const result = await next.handle();
        if (span.getStatus().code === "UNSET") {
          span.setStatus("OK");
        }
        return result;
      } catch (err) {
        span.recordException(err);
        throw err;
      } finally {
        span.end();
      }
    });
  }

  private async interceptRpc(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<unknown> {
    const rpc = context.switchToRpc();
    const data = rpc.getData<unknown>();
    const rpcCtx = rpc.getContext<Record<string, unknown> | undefined>();
    const handlerName =
      String(context.getHandlerKey?.() ?? context.getHandler()?.name ?? "") ||
      "handler";

    const rawPattern =
      (typeof rpcCtx?.getPattern === "function"
        ? (rpcCtx.getPattern as () => unknown)()
        : undefined) ??
      rpcCtx?.pattern ??
      (typeof rpcCtx?.getChannel === "function"
        ? (rpcCtx.getChannel as () => unknown)()
        : undefined) ??
      (typeof rpcCtx?.getSubject === "function"
        ? (rpcCtx.getSubject as () => unknown)()
        : undefined);
    const pattern = formatPatternLabel(rawPattern, handlerName);

    const dataObj =
      data && typeof data === "object"
        ? (data as Record<string, unknown>)
        : undefined;
    const rmqMessage =
      typeof rpcCtx?.getMessage === "function"
        ? (rpcCtx.getMessage as () => { properties?: { headers?: unknown } })()
        : undefined;

    const activeContext = traceContextStorage.getCurrentSpanContext();
    const extracted = extractTraceFromCandidates([
      typeof rpcCtx?.getMetadata === "function"
        ? (rpcCtx.getMetadata as () => unknown)()
        : undefined,
      typeof rpcCtx?.getHeaders === "function"
        ? (rpcCtx.getHeaders as () => unknown)()
        : undefined,
      rpcCtx?.metadata,
      rpcCtx?.headers,
      rmqMessage?.properties?.headers,
      rpcCtx,
      dataObj?.headers,
      dataObj?.metadata,
      dataObj,
    ]);

    const parentContext = activeContext ?? extracted.parentContext;
    const requestId =
      parentContext?.requestId ?? extracted.requestId ?? crypto.randomUUID();
    const rpcSystem =
      rpcCtx?.transport !== undefined
        ? String(rpcCtx.transport)
        : "bunest-rpc";

    const span = this.tracer.startSpan(`RPC ${pattern}`, {
      kind: activeContext ? "INTERNAL" : "SERVER",
      parentContext,
      requestId,
      attributes: {
        "rpc.system": rpcSystem,
        "rpc.method": pattern,
        "messaging.destination.name": pattern,
        "code.namespace": context.getClass()?.name || "Controller",
        "code.function": handlerName,
      },
    });

    return traceContextStorage.run(span.context, async () => {
      try {
        const result = await next.handle();
        if (span.getStatus().code === "UNSET") {
          span.setStatus("OK");
        }
        return result;
      } catch (err) {
        span.recordException(err);
        throw err;
      } finally {
        span.end();
      }
    });
  }
}

export interface TracingModuleOptions extends TracerOptions {
  global?: boolean;
  registerGlobalInterceptor?: boolean;
}

export interface TracingModuleAsyncOptions {
  imports?: ModuleMetadata["imports"];
  inject?: FactoryDependency[];
  useFactory: (
    ...args: any[]
  ) => TracingModuleOptions | Promise<TracingModuleOptions>;
  global?: boolean;
  registerGlobalInterceptor?: boolean;
}

@Module({})
export class TracingModule {
  static forRoot(options: TracingModuleOptions = {}): DynamicModule {
    const providers: NonNullable<DynamicModule["providers"]>[number][] = [
      { provide: TRACER_OPTIONS, useValue: options },
      Tracer,
      TracingMiddleware,
      TracingInterceptor,
      SpanAspectHandler,
    ];

    if (options.registerGlobalInterceptor) {
      providers.push({
        provide: APP_INTERCEPTOR,
        useExisting: TracingInterceptor,
      });
    }

    return {
      module: TracingModule,
      global: options.global,
      providers,
      exports: [
        TRACER_OPTIONS,
        Tracer,
        TracingMiddleware,
        TracingInterceptor,
        SpanAspectHandler,
      ],
    };
  }

  static forRootAsync(options: TracingModuleAsyncOptions): DynamicModule {
    const providers: NonNullable<DynamicModule["providers"]>[number][] = [
      {
        provide: TRACER_OPTIONS,
        useFactory: options.useFactory,
        inject: options.inject,
      },
      Tracer,
      TracingMiddleware,
      TracingInterceptor,
      SpanAspectHandler,
    ];

    if (options.registerGlobalInterceptor) {
      providers.push({
        provide: APP_INTERCEPTOR,
        useExisting: TracingInterceptor,
      });
    }

    return {
      module: TracingModule,
      global: options.global,
      imports: options.imports,
      providers,
      exports: [
        TRACER_OPTIONS,
        Tracer,
        TracingMiddleware,
        TracingInterceptor,
        SpanAspectHandler,
      ],
    };
  }
}
