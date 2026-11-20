# @bunest/observability

Unified observability suite for **Bunest** with zero external runtime dependencies. Provides W3C distributed tracing, OpenTelemetry OTLP export, Prometheus metrics, Terminus-compatible health checks, correlated structured logging, and Devtools application graph introspection.

## Features

- **Distributed W3C Tracing**: `AsyncLocalStorage`-backed `TraceContextStorage`, W3C `traceparent`/`tracestate`/`baggage` propagation, `Tracer`, `TracingMiddleware`, `TracingInterceptor`, and `@Trace()` / `@Span()` / `@TraceSpan()` decorators.
- **Span Exporters**: `OtlpHttpSpanExporter` (native `fetch()`), `ConsoleSpanExporter`, and `InMemorySpanExporter`.
- **Prometheus Metrics**: `MetricsRegistry`, `Counter`, `Gauge`, `Histogram`, `HttpMetricsInterceptor`, `@Counted()`, and `@Timed()` with standard Prometheus text exposition (`PROMETHEUS_CONTENT_TYPE`).
- **Health & Readiness Checks**: `HealthModule` / `TerminusModule`, `HealthCheckService`, `HealthIndicatorService`, `@HealthCheck()`, and built-in indicators (`HttpHealthIndicator`, `FetchHealthIndicator`, `MemoryHealthIndicator`, `DiskHealthIndicator`, `EventLoopHealthIndicator`, `SqlHealthIndicator`, `PrismaHealthIndicator`, `QueueHealthIndicator`, `MicroserviceHealthIndicator`, `GRPCHealthIndicator`, `CustomHealthIndicator`).
- **Correlated Logging & Devtools**: `ObservabilityLogger` with automatic trace/span ID injection, plus `DevtoolsModule`, `DevtoolsService`, and `GraphPublisher`.

## Installation

```bash
bun add @bunest/observability
```

## Quick Start

```ts
import { Controller, Get, Module } from "@bunest/common";
import {
  HealthCheck,
  HealthCheckService,
  MemoryHealthIndicator,
  MetricsRegistry,
  ObservabilityModule,
  PROMETHEUS_CONTENT_TYPE,
  Span,
} from "@bunest/observability";

@Controller()
export class OpsController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly memory: MemoryHealthIndicator,
    private readonly metrics: MetricsRegistry,
  ) {}

  @Get("health")
  @HealthCheck()
  check() {
    return this.health.check([
      () => this.memory.checkHeap("memory_heap", 150 * 1024 * 1024),
    ]);
  }

  @Get("metrics")
  @Span("ops.metrics")
  scrape() {
    return new Response(this.metrics.toPrometheus(), {
      headers: { "content-type": PROMETHEUS_CONTENT_TYPE },
    });
  }
}

@Module({
  imports: [ObservabilityModule.forRoot({ serviceName: "orders-api" })],
  controllers: [OpsController],
})
export class AppModule {}
```

## Key Exports

- **Modules**: `ObservabilityModule`, `TracingModule`, `MetricsModule`, `HealthModule`, `TerminusModule`, `DevtoolsModule`
- **Tracing**: `Tracer`, `TraceContextStorage`, `traceContextStorage`, `TracingMiddleware`, `TracingInterceptor`, `OtlpHttpSpanExporter`, `ConsoleSpanExporter`, `InMemorySpanExporter`, `extractTraceContext`, `injectTraceContext`, `formatTraceParent`, `parseTraceParent`
- **Metrics**: `MetricsRegistry`, `Counter`, `Gauge`, `Histogram`, `HttpMetricsInterceptor`, `DEFAULT_HTTP_BUCKETS`, `PROMETHEUS_CONTENT_TYPE`
- **Decorators & Aspects**: `Span`, `Trace`, `TraceSpan`, `Counted`, `Timed`, `HealthCheck`, `SpanAspectHandler`, `CountedAspectHandler`, `TimedAspectHandler`
- **Health Checks**: `HealthCheckService`, `HealthIndicatorService`, `HealthIndicator`, `HealthIndicatorSession`, `HealthCheckError`, `HealthCheckException`, `HttpHealthIndicator`, `FetchHealthIndicator`, `MemoryHealthIndicator`, `DiskHealthIndicator`, `EventLoopHealthIndicator`, `SqlHealthIndicator`, `PrismaHealthIndicator`, `QueueHealthIndicator`, `MicroserviceHealthIndicator`, `GRPCHealthIndicator`, `CustomHealthIndicator`
- **Logging & Devtools**: `ObservabilityLogger`, `DevtoolsService`, `GraphPublisher`, `TRACER_OPTIONS`, `METRICS_MODULE_OPTIONS`, `HEALTH_MODULE_OPTIONS`, `TERMINUS_MODULE_OPTIONS`, `OBSERVABILITY_LOGGER_OPTIONS`, `DEVTOOLS_OPTIONS`

## Documentation

- [Bunest Documentation](../../README.md)
- [ADR Index](../../docs/adr/README.md)
