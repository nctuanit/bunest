# Observability, Terminus & Devtools

Bunest provides a unified, zero-external-dependency observability stack—alongside drop-in migration facades for `@nestjs/terminus` and `@nestjs/devtools-integration`:

- **`@bunest/observability`** — `ObservabilityModule.forRoot()`, `@Span`/`@Trace`/`@Timed`/`@Counted` service aspects ([ADR-014](/architecture/adrs)), W3C Trace Context (`TracingModule`, `OtlpHttpSpanExporter`), Prometheus `MetricsModule`, Terminus `HealthModule`, and `DevtoolsModule` graph exporter.
- **`@bunest/terminus`** — Drop-in `@nestjs/terminus` v12 facade (`TerminusModule`, `HealthCheckService`, `HttpHealthIndicator`, `MemoryHealthIndicator`, `DiskHealthIndicator`, `EventLoopHealthIndicator`, plus zero-dep ORM health indicators).
- **`@bunest/devtools-integration`** — Drop-in `@nestjs/devtools-integration` v12 facade (`DevtoolsModule`, `GraphPublisher`).

## Installation

@@tab(@bunest/observability)
```bash
bun add @bunest/observability
```
@@switch
@@tab(@bunest/terminus)
```bash
bun add @bunest/terminus
```
@@switch
@@tab(@bunest/devtools-integration)
```bash
bun add @bunest/devtools-integration
```

## One-Line `ObservabilityModule.forRoot()`

@@filename(app.module.ts)
```ts
import { Module } from "@bunest/core";
import { ObservabilityModule } from "@bunest/observability";

@Module({
  imports: [
    ObservabilityModule.forRoot({
      serviceName: "orders-api",
      tracing: { enabled: true },
      metrics: { enabled: true, path: "/metrics" },
      health: { enabled: true, path: "/health" },
      devtools: { enabled: process.env.NODE_ENV !== "production" },
    }),
  ],
})
export class AppModule {}
```

## Declarative `@Span()`, `@Timed()` & `@Counted()`

Instrument `@Injectable()` service methods with zero manual span lifecycle boilerplate:

@@filename(orders.service.ts)
```ts
import { Injectable } from "@bunest/core";
import { Counted, Span, Timed } from "@bunest/observability";

@Injectable()
export class OrdersService {
  @Span("orders.create")
  @Timed("orders_create_duration_seconds")
  @Counted("orders_created_total")
  async create(amountCents: number) {
    return { id: crypto.randomUUID(), amountCents };
  }
}
```

## Health Checks (`@bunest/terminus`)

@@filename(health.controller.ts)
```ts
import { Controller, Get } from "@bunest/core";
import { HealthCheck, HealthCheckService, MemoryHealthIndicator } from "@bunest/terminus";

@Controller("health")
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly memory: MemoryHealthIndicator,
  ) {}

  @Get()
  @HealthCheck()
  check() {
    return this.health.check([
      () => this.memory.checkHeap("memory_heap", 256 * 1024 * 1024),
    ]);
  }
}
```
