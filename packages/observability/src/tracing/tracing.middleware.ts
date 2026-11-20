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
} from "@bunest/common";
import {
  extractTraceContext,
  formatTraceParent,
  traceContextStorage,
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

  const rawPrefix = ctrlMeta
    ? Array.isArray(ctrlMeta.path)
      ? (ctrlMeta.path[0] ?? "")
      : ctrlMeta.path
    : "";
  const rawSuffix = Array.isArray(methodPath)
    ? (methodPath[0] ?? "")
    : (methodPath ?? "");

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
 * Interceptor extracting W3C `traceparent`, recording controller route metadata
 * (`http.method`, `http.route`, `http.status_code`), and propagating active
 * `SpanContext` across downstream async DB/Queue operations.
 */
@Injectable()
export class TracingInterceptor implements BunestInterceptor {
  constructor(private readonly tracer: Tracer) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<unknown> {
    if (context.getType() !== "http") {
      return next.handle();
    }

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
        "code.namespace": context.getClass().name || "Controller",
        "code.function":
          String(context.getHandlerKey?.() ?? context.getHandler().name) ||
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
    const providers: DynamicModule["providers"] = [
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
    const providers: DynamicModule["providers"] = [
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
