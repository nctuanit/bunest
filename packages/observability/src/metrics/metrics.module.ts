import {
  APP_INTERCEPTOR,
  Controller,
  Get,
  HttpException,
  Inject,
  Injectable,
  METADATA_KEYS,
  MetadataRegistry,
  Module,
  Optional,
  UseGuards,
  type BunestInterceptor,
  type CallHandler,
  type ControllerMetadata,
  type DynamicModule,
  type ExecutionContext,
  type GuardLike,
  type ResponseContext,
  type Type,
} from "@bunest/core";
import {
  CountedAspectHandler,
  TimedAspectHandler,
} from "../decorators/observability.decorators";
import {
  Counter,
  DEFAULT_HTTP_BUCKETS,
  Gauge,
  Histogram,
  MetricsRegistry,
  PROMETHEUS_CONTENT_TYPE,
} from "./metrics.registry";
import {
  OtlpHttpMetricsExporter,
  type OtlpHttpMetricsExporterOptions,
} from "./otlp-metrics-exporter";

export const METRICS_MODULE_OPTIONS = Symbol.for(
  "bunest:observability:metrics_options",
);

export interface MetricsModuleOptions {
  path?: string;
  exposeEndpoint?: boolean;
  registerGlobalInterceptor?: boolean;
  buckets?: readonly number[];
  guard?: GuardLike;
  registry?: MetricsRegistry;
  /**
   * Optional OTLP/HTTP JSON metrics exporter (or options) pushed periodically
   * and flushed gracefully on module destroy.
   */
  otlpExporter?: OtlpHttpMetricsExporter | OtlpHttpMetricsExporterOptions;
  global?: boolean;
}

function resolveRouteLabel(context: ExecutionContext): string {
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

  const prefix = ctrlMeta
    ? Array.isArray(ctrlMeta.path)
      ? (ctrlMeta.path[0] ?? "")
      : ctrlMeta.path
    : "";
  const suffix = Array.isArray(methodPath)
    ? (methodPath[0] ?? "")
    : (methodPath ?? "");

  const combined = `/${prefix}/${suffix}`
    .replace(/\/+/g, "/")
    .replace(/\/$/, "");
  return combined || "/";
}

/**
 * Interceptor recording Prometheus HTTP request counters, latency histograms,
 * and in-flight request gauges labeled by `(method, route, status)`.
 */
@Injectable()
export class HttpMetricsInterceptor implements BunestInterceptor {
  private readonly requestsTotal: Counter;
  private readonly requestDuration: Histogram;
  private readonly requestsInFlight: Gauge;

  constructor(
    registry: MetricsRegistry,
    @Optional()
    @Inject(METRICS_MODULE_OPTIONS)
    options: MetricsModuleOptions = {},
  ) {
    this.requestsTotal = registry.createCounter({
      name: "http_requests_total",
      help: "Total number of HTTP requests handled",
      labelNames: ["method", "route", "status"],
    });

    this.requestDuration = registry.createHistogram({
      name: "http_request_duration_seconds",
      help: "HTTP request duration in seconds",
      labelNames: ["method", "route", "status"],
      buckets: options.buckets ?? DEFAULT_HTTP_BUCKETS,
    });

    this.requestsInFlight = registry.createGauge({
      name: "http_requests_in_flight",
      help: "Current number of in-flight HTTP requests",
      labelNames: ["method", "route"],
    });
  }

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
    const route = resolveRouteLabel(context);

    this.requestsInFlight.inc({ method, route });
    const start = performance.now();

    try {
      const result = await next.handle();
      const status =
        result instanceof Response
          ? result.status
          : (res?.getStatus?.() ?? (method === "POST" ? 201 : 200));

      const durationSec = Math.max(0, (performance.now() - start) / 1000);
      const statusLabel = String(status);
      this.requestsTotal.inc({ method, route, status: statusLabel });
      this.requestDuration.observe(
        { method, route, status: statusLabel },
        durationSec,
      );
      return result;
    } catch (err) {
      const status = err instanceof HttpException ? err.getStatus() : 500;
      const durationSec = Math.max(0, (performance.now() - start) / 1000);
      const statusLabel = String(status);
      this.requestsTotal.inc({ method, route, status: statusLabel });
      this.requestDuration.observe(
        { method, route, status: statusLabel },
        durationSec,
      );
      throw err;
    } finally {
      this.requestsInFlight.dec({ method, route });
    }
  }
}

function createMetricsController(
  path: string,
  guard?: GuardLike,
): Type<unknown> {
  @Controller(path)
  class MetricsController {
    constructor(
      @Inject(MetricsRegistry) private readonly registry: MetricsRegistry,
    ) {}

    @Get()
    scrape(): Response {
      return new Response(this.registry.toPrometheusText(), {
        status: 200,
        headers: {
          "content-type": PROMETHEUS_CONTENT_TYPE,
          "cache-control": "no-store",
        },
      });
    }
  }

  if (guard) {
    UseGuards(guard)(MetricsController);
  }

  return MetricsController;
}

@Module({})
export class MetricsModule {
  static forRoot(options: MetricsModuleOptions = {}): DynamicModule {
    const path = options.path ?? "/metrics";
    const exposeEndpoint = options.exposeEndpoint ?? true;
    const controllers: Type<unknown>[] = exposeEndpoint
      ? [createMetricsController(path, options.guard)]
      : [];

    const registryProvider = options.registry
      ? { provide: MetricsRegistry, useValue: options.registry }
      : MetricsRegistry;

    const providers: NonNullable<DynamicModule["providers"]>[number][] = [
      { provide: METRICS_MODULE_OPTIONS, useValue: options },
      registryProvider,
      HttpMetricsInterceptor,
      TimedAspectHandler,
      CountedAspectHandler,
    ];

    const exportsList: NonNullable<DynamicModule["exports"]>[number][] = [
      METRICS_MODULE_OPTIONS,
      MetricsRegistry,
      HttpMetricsInterceptor,
      TimedAspectHandler,
      CountedAspectHandler,
    ];

    if (options.otlpExporter) {
      const configuredExporter = options.otlpExporter;
      providers.push({
        provide: OtlpHttpMetricsExporter,
        useFactory: (registry: MetricsRegistry) => {
          if (configuredExporter instanceof OtlpHttpMetricsExporter) {
            return configuredExporter.attachRegistry(registry);
          }
          return new OtlpHttpMetricsExporter(registry, configuredExporter);
        },
        inject: [MetricsRegistry],
      });
      exportsList.push(OtlpHttpMetricsExporter);
    }

    if (options.registerGlobalInterceptor) {
      providers.push({
        provide: APP_INTERCEPTOR,
        useExisting: HttpMetricsInterceptor,
      });
    }

    return {
      module: MetricsModule,
      global: options.global,
      controllers,
      providers,
      exports: exportsList,
    };
  }
}
