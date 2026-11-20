# @bunest/observe

Zero-dependency, Bun-native observability and APM agent for **Bunest** with full `@nestjs/observe` API parity. Captures distributed traces, runtime metrics, cardinality-bounded custom metrics, SLO objectives, and redacted OTLP/APM exports.

## Features

- **Boot-Time Instrumentation**: `createObserveModule()` returns `{ ObserveInstrument, ObserveModule }` for wiring into `BunestFactory.create(..., { instrument: ObserveInstrument })`.
- **Application Tracing**: `TracerService` with `createSpan`, `activeSpan`, `captureError`, `currentTraceId`, `setOperationId`, `setAttribute`, and `getAttribute`.
- **Cardinality-Bounded Custom Metrics**: `Counter`, `Gauge`, and reservoir-sampled `Summary` metrics with built-in series cardinality protection (`MAX_SERIES_PER_METRIC = 1000`).
- **Declarative SLO Objectives**: `@Objective()` decorator with validation helpers (`objectiveProblems`, `unknownObjectiveFields`, `toDeclaredObjective`).
- **W3C Interop & Redaction**: W3C `traceparent` / OpenTelemetry trace ID generation, `RedactionOptions` for sensitive fields, repeated span collapsing, and native `fetch()` batch export.

## Installation

```bash
bun add @bunest/observe
```

## Quick Start

```ts
import { Controller, Get, Module } from "@bunest/common";
import { BunestFactory } from "@bunest/core";
import { createObserveModule, Objective, TracerService } from "@bunest/observe";

const { ObserveInstrument, ObserveModule } = createObserveModule({
  serviceName: "billing-api",
});

@Controller("invoices")
export class InvoicesController {
  constructor(private readonly tracer: TracerService) {}

  @Get()
  @Objective({ targetMs: 200, availability: 0.999 })
  async list() {
    const requests = this.tracer.counter("invoices_listed_total");
    requests.inc();
    return this.tracer.createSpan("invoices.query", async () => {
      return [];
    });
  }
}

@Module({
  imports: [ObserveModule.forRoot()],
  controllers: [InvoicesController],
})
export class AppModule {}

const app = await BunestFactory.create(AppModule, {
  instrument: ObserveInstrument,
});
await app.listen(3000);
```

## Key Exports

- **Module & Instrumentation**: `createObserveModule`, `createInstanceDecorator`, `OBSERVE_OPTIONS`
- **Tracing**: `TracerService`, `TraceSpanDelegate`, `defaultTraceIdGenerator`, `openTelemetryTraceIdGenerator`, `TRACE_CONTEXT_KEY`, `TRACE_REGISTRY_KEY`, `SPAN_COLLAPSED_TAG`, `UNFINISHED_SPANS_TAG`, `UNRECORDED_SPANS_TAG`
- **Custom Metrics**: `Counter`, `Gauge`, `Summary`, `MAX_SERIES_PER_METRIC`, `admitsSeries`, `stringifyLabel`
- **SLO Objectives**: `Objective`, `OBJECTIVES_METADATA`, `objectiveProblems`, `toDeclaredObjective`, `unknownObjectiveFields`

## CLI

`@bunest/observe` ships the `observe` CLI binary to inspect APM configuration:

```bash
bunx observe status   # Inspect OBSERVE_* environment variables
bunx observe help     # Show CLI help
```

## Documentation

- [Bunest Documentation](../../README.md)
- [ADR Index](../../docs/adr/README.md)
