# @bunest/scheduler

Cron, interval, and timeout task scheduler for **Bunest** with zero external runtime dependencies. Features a pure TypeScript cron parser with IANA time zones, overlap protection, dynamic job management, and graceful shutdown.

## Features

- **Declarative Scheduling**: Schedule recurring or one-shot provider methods using `@Cron()`, `@Interval()`, and `@Timeout()`.
- **Pure TypeScript Cron Engine**: Built-in `parseCronExpression()`, `getNextCronDate()`, `CronJob`, and `CronExpression` presets with IANA time zone and UTC offset validation (`validateTimeZone()`, `validateUtcOffset()`).
- **Dynamic Job Registry**: Inspect, add, start, stop, and delete cron jobs, intervals, and timeouts at runtime through `SchedulerRegistry`.
- **Graceful Lifecycle**: Automatic discovery via `SchedulerExplorer` and clean timer teardown on application shutdown.

## Installation

```bash
bun add @bunest/scheduler
```

## Quick Start

```ts
import { Injectable, Module } from "@bunest/common";
import {
  Cron,
  CronExpression,
  Interval,
  ScheduleModule,
  Timeout,
} from "@bunest/scheduler";

@Injectable()
export class MaintenanceTasks {
  @Cron(CronExpression.EVERY_HOUR, { name: "cleanup", timeZone: "UTC" })
  cleanupExpiredSessions() {
    console.log("Running hourly session cleanup");
  }

  @Interval("heartbeat", 30_000)
  emitHeartbeat() {
    console.log("Heartbeat tick");
  }

  @Timeout("warmup", 5_000)
  warmupCache() {
    console.log("Cache warmed");
  }
}

@Module({
  imports: [ScheduleModule.forRoot()],
  providers: [MaintenanceTasks],
})
export class AppModule {}
```

## Key Exports

- **Module & Registry**: `ScheduleModule` (`forRoot`, `forRootAsync`), `SchedulerRegistry`, `SchedulerExplorer`, `ScheduleExplorer`, `SCHEDULE_MODULE_OPTIONS`
- **Decorators**: `Cron`, `Interval`, `Timeout`, `getCronMetadata`, `getIntervalMetadata`, `getTimeoutMetadata`, `CRON_METADATA`, `INTERVAL_METADATA`, `TIMEOUT_METADATA`
- **Cron Engine**: `CronJob`, `CronExpression`, `CronExpressionError`, `parseCronExpression`, `getNextCronDate`, `validateTimeZone`, `validateUtcOffset`

## Documentation

- [Bunest Documentation](../../README.md)
- [ADR Index](../../docs/adr/README.md)
