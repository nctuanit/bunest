# @bunest/terminus

Drop-in 1:1 NestJS `@nestjs/terminus` (v12) migration facade for **Bunest**, powered by `@bunest/observability` with zero external runtime dependencies and structural ORM health indicators.

## Features

- **Drop-In `@nestjs/terminus` v12 Parity (43/43 exports)**: Replace `@nestjs/terminus` imports with `@bunest/terminus` verbatim.
- **Built-In System & Network Indicators**: `FetchHealthIndicator`, `HttpHealthIndicator`, `MemoryHealthIndicator`, `DiskHealthIndicator`, `EventLoopHealthIndicator`, `MicroserviceHealthIndicator`, `GRPCHealthIndicator`, `QueueHealthIndicator`, and `SqlHealthIndicator`.
- **Zero-Dep Structural ORM Indicators**: `PrismaHealthIndicator`, `TypeOrmHealthIndicator`, `MongooseHealthIndicator`, `SequelizeHealthIndicator`, and `MikroOrmHealthIndicator` work with any structurally compatible client.
- **Custom Indicators & Caching**: Build custom checks with `HealthIndicatorService`, `HealthIndicatorSession`, `CustomHealthIndicator`, and `AttemptCache`.

## Installation

```bash
bun add @bunest/terminus
```

## Quick Start

```ts
import { Controller, Get, Module } from "@bunest/common";
import {
  DiskHealthIndicator,
  FetchHealthIndicator,
  HealthCheck,
  HealthCheckService,
  MemoryHealthIndicator,
  TerminusModule,
  toBytes,
} from "@bunest/terminus";

@Controller("health")
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly http: FetchHealthIndicator,
    private readonly memory: MemoryHealthIndicator,
    private readonly disk: DiskHealthIndicator,
  ) {}

  @Get()
  @HealthCheck()
  check() {
    return this.health.check([
      () => this.http.pingCheck("docs", "https://example.com"),
      () => this.memory.checkHeap("memory_heap", toBytes("150MB")),
      () => this.disk.checkStorage("storage", { path: "/", thresholdPercent: 0.9 }),
    ]);
  }
}

@Module({
  imports: [TerminusModule],
  controllers: [HealthController],
})
export class AppModule {}
```

## Key Exports

- **Module & Services**: `TerminusModule` (`forRoot`, `forRootAsync`), `HealthModule`, `HealthCheckService`, `HealthIndicatorService`, `HealthIndicatorSession`, `HealthCheckAttempt`, `AttemptCache`, `HealthCheck`
- **Built-In Indicators**: `FetchHealthIndicator`, `HttpHealthIndicator`, `MemoryHealthIndicator`, `DiskHealthIndicator`, `EventLoopHealthIndicator`, `SqlHealthIndicator`, `QueueHealthIndicator`, `MicroserviceHealthIndicator`, `GRPCHealthIndicator`, `CustomHealthIndicator`
- **ORM Indicators**: `PrismaHealthIndicator`, `TypeOrmHealthIndicator`, `MongooseHealthIndicator`, `SequelizeHealthIndicator`, `MikroOrmHealthIndicator`
- **Statuses, Units & Errors**: `HealthCheckStatus`, `HealthIndicatorStatus`, `HealthIndicator`, `HealthCheckError`, `HealthCheckException`, `DatabaseNotConnectedError`, `TimeoutError`, `NotServingError`, `ResponseStatusError`, `toMs`, `toBytes`, `DurationUnit`, `SizeUnit`

## Documentation

- [Bunest Documentation](../../README.md)
- [ADR Index](../../docs/adr/README.md)
