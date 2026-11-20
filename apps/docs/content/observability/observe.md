# Observe APM

**`@bunest/observe`** is a full-featured, zero-dependency Application Performance Monitoring (APM) agent built on top of [`@bunest/observability`](/observability/observability)—adding distributed tracing, runtime and custom metrics (`Counter`, `Gauge`, `Histogram`), Service Level Objective (SLO) tracking, automatic PII redaction, OTLP export, and a companion CLI.

## Installation

```bash
bun add @bunest/observe
```

## Module Setup

@@filename(app.module.ts)
```ts
import { Module } from "@bunest/core";
import { ObserveModule } from "@bunest/observe";

@Module({
  imports: [
    ObserveModule.forRoot({
      serviceName: "checkout-service",
      environment: process.env.NODE_ENV ?? "development",
      piiRedaction: true,
    }),
  ],
})
export class AppModule {}
```

## Key Capabilities

- **SLO Objectives:** Annotate critical endpoints or services with latency and availability SLO metadata (`OBJECTIVES_METADATA`) to compute burn rates and error budgets.
- **Cardinality Guards:** Built-in `MAX_SERIES_PER_METRIC` protection prevents unbounded label explosions in Prometheus/OTLP metrics.
- **Job Trace Propagation:** Automatic trace-context propagation across HTTP requests and background queue jobs (`JOB_TRACE_CONTEXT_OPTION_KEY`).
- **PII Redaction:** Strips authorization headers, emails, tokens, and sensitive fields before spans or logs leave the process.
