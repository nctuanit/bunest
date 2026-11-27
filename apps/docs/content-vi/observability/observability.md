# Giám sát, Kiểm tra sức khỏe & Devtools

**`@bunest/observability`** cung cấp một bộ công cụ giám sát (observability) thống nhất, không phụ thuộc thư viện bên ngoài (zero-external-dependency) trong một package duy nhất:

- `ObservabilityModule.forRoot()`, các aspect ở tầng service `@Span`/`@Trace`/`@Timed`/`@Counted`, W3C Trace Context (`TracingModule`, `OtlpHttpSpanExporter`), và Prometheus `MetricsModule`.
- Kiểm tra sức khỏe (health checks) tương thích Terminus v12 (`TerminusModule`, `HealthModule`, `HealthCheckService`, `HttpHealthIndicator`, `MemoryHealthIndicator`, `DiskHealthIndicator`, `EventLoopHealthIndicator`, `OrmHealthIndicator`).
- Kiểm tra đồ thị Devtools (`DevtoolsModule`, `DevtoolsService`, `GraphPublisher`).

## Cài đặt

```bash
bun add @bunest/observability
```

## Cấu hình một dòng `ObservabilityModule.forRoot()`

@@filename(app.module.ts)

```ts
import { Module } from "@bunest/core";
import { ObservabilityModule } from "@bunest/observability";

@Module({
  imports: [
    ObservabilityModule.forRoot({
      tracing: true,
      metrics: true,
      health: true,
      devtools: { enabled: process.env.NODE_ENV !== "production" },
    }),
  ],
})
export class AppModule {}
```

## Khai báo `@Span()`, `@Timed()` & `@Counted()`

Gắn đo đạc (instrument) cho các phương thức service `@Injectable()` mà không cần viết mã vòng đời span thủ công:

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

## Kiểm tra sức khỏe (`TerminusModule`)

@@filename(health.controller.ts)

```ts
import { Controller, Get } from "@bunest/core";
import {
  HealthCheck,
  HealthCheckService,
  MemoryHealthIndicator,
} from "@bunest/observability";

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
