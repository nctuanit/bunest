
// Tracing & W3C Trace Context
export {
  TraceContextStorage,
  extractTraceContext,
  formatBaggage,
  formatTraceParent,
  formatTraceState,
  generateSpanId,
  generateTraceId,
  injectTraceContext,
  parseBaggage,
  parseTraceParent,
  parseTraceState,
  traceContextStorage,
  type ParsedTraceParent,
  type SpanContext,
  type TraceCarrier,
} from "./tracing/trace-context";
export {
  spanDataToOtlp,
  toOtlpAttributes,
  type OtlpAnyValue,
  type OtlpKeyValue,
  type OtlpSpan,
  type SpanAttributeValue,
  type SpanData,
  type SpanEvent,
  type SpanKind,
  type SpanStatus,
  type SpanStatusCode,
} from "./tracing/span";
export {
  Counted,
  CountedAspectHandler,
  Span,
  SpanAspectHandler,
  Timed,
  TimedAspectHandler,
  Trace,
  TraceSpan,
  type CountedDecoratorOptions,
  type SpanAttributesMap,
  type SpanConstructorAndDecorator,
  type SpanDecoratorOptions,
  type TimedDecoratorOptions,
} from "./decorators/observability.decorators";
export {
  ObservabilityModule,
  type ObservabilityModuleOptions,
} from "./observability.module";
export {
  ConsoleSpanExporter,
  InMemorySpanExporter,
  OtlpHttpSpanExporter,
  type ConsoleSpanExporterOptions,
  type OtlpExportTraceServiceRequest,
  type OtlpHttpSpanExporterOptions,
  type SpanExporter,
} from "./tracing/span-exporters";
export {
  TRACER_OPTIONS,
  Tracer,
  type StartSpanOptions,
  type TracerOptions,
} from "./tracing/tracer";
export {
  TracingInterceptor,
  TracingMiddleware,
  TracingModule,
  createTracingMiddleware,
  type TracingModuleAsyncOptions,
  type TracingModuleOptions,
} from "./tracing/tracing.middleware";

// Metrics & Prometheus Exposition
export {
  Counter,
  DEFAULT_HTTP_BUCKETS,
  Gauge,
  Histogram,
  MetricsRegistry,
  PROMETHEUS_CONTENT_TYPE,
  type HistogramOptions,
  type MetricLabels,
  type MetricOptions,
  type MetricType,
  type PrometheusMetric,
} from "./metrics/metrics.registry";
export {
  HttpMetricsInterceptor,
  METRICS_MODULE_OPTIONS,
  MetricsModule,
  type MetricsModuleOptions,
} from "./metrics/metrics.module";

// Health & Readiness (Terminus v12 Parity)
export {
  DurationUnit,
  NotServingError,
  ResponseStatusError,
  SizeUnit,
  TimeoutError,
  toBytes,
  toMs,
  type ByteSize,
  type Duration,
} from "./health/units";
export {
  CHECK_DISK_SPACE_LIB,
  HEALTH_MODULE_OPTIONS,
  HealthCheckStatus,
  HealthIndicator,
  HealthIndicatorStatus,
  TERMINUS_LOGGER,
  TERMINUS_MODULE_OPTIONS,
  type ErrorLogStyle,
  type HealthCheckOptions,
  type HealthCheckResult,
  type HealthIndicatorDetail,
  type HealthIndicatorResult,
  type TerminusAsyncModuleOptions,
  type TerminusAsyncOptions,
  type TerminusModuleOptions,
  type TerminusOptionsFactory,
} from "./health/health.interface";
export {
  AttemptCache,
  HealthCheckAttempt,
  HealthCheckAttempt as HealthIndicatorAttempt,
  HealthIndicatorService,
  HealthIndicatorSession,
  type HealthCheckAttemptResult,
  type HealthCheckFunction,
  type HealthIndicatorFunction,
  type InferHealthIndicatorResult,
  type InferHealthIndicatorResults,
} from "./health/health-indicator.service";
export { HEALTH_CHECK_METADATA, HealthCheck } from "./health/health.decorator";
export {
  CustomHealthIndicator,
  DiskHealthIndicator,
  EVENT_LOOP_HEALTH_MAX_DELAY,
  EventLoopHealthIndicator,
  FetchHealthIndicator,
  GRPCHealthIndicator,
  HttpHealthIndicator,
  MEMORY_HEALTH_HEAP_LIMIT,
  MEMORY_HEALTH_RSS_LIMIT,
  MemoryHealthIndicator,
  MicroserviceHealthIndicator,
  OrmHealthIndicator,
  PrismaHealthIndicator,
  QueueHealthIndicator,
  SqlHealthIndicator,
  defaultCheckDiskSpace,
  type CheckDiskSpace,
  type CheckGRPCServiceOptions,
  type CustomIndicatorCallback,
  type DiskHealthIndicatorOptions,
  type DiskOptionsWithThreshold,
  type DiskOptionsWithThresholdPercent,
  type DiskSpaceInfo,
  type FetchCheckOptions,
  type FetchLike,
  type FetchLikeInit,
  type GrpcClientOptionsLike,
  type HealthServiceCheck,
  type HttpHealthCheckRequestOptions,
  type HttpHealthResponse,
  type HttpResponseLike,
  type MicroserviceHealthIndicatorOptions,
  type MicroserviceOptionsLike,
  type OrmHealthTarget,
  type OrmPingCheckOptions,
  type PrismaClientPingCheckSettings,
  type PrismaHealthClient,
  type QueueHealthCounts,
  type QueueHealthTarget,
  type QueueHealthThresholds,
  type SqlHealthTarget,
} from "./health/health.indicators";
export {
  HealthCheckError,
  HealthCheckException,
  HealthCheckService,
} from "./health/health.service";
export {
  HealthModule,
  TerminusModule,
  type HealthModuleOptions,
} from "./health/health.module";

// Correlated Structured Logger
export {
  OBSERVABILITY_LOGGER_OPTIONS,
  ObservabilityLogger,
  type ObservabilityLoggerOptions,
} from "./logging/observability-logger";

// Devtools Introspection & Graph Publishing
export {
  DEVTOOLS_OPTIONS,
  DevtoolsService,
  type DevtoolsApplicationGraph,
  type DevtoolsControllerNode,
  type DevtoolsGraphEdge,
  type DevtoolsModuleAsyncOptions,
  type DevtoolsModuleOptions,
  type DevtoolsModuleNode,
  type DevtoolsOptionsFactory,
  type DevtoolsProviderNode,
  type DevtoolsRouteNode,
  type DevtoolsTarget,
} from "./devtools/devtools.service";
export { DevtoolsModule } from "./devtools/devtools.module";
export {
  GraphPublisher,
  type GraphPublisherResponse,
  type PublishGraphOptions,
} from "./devtools/graph.publisher";
