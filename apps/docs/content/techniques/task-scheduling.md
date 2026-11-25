# Task Scheduling

**`@bunest/jobs/scheduler`** provides declarative cron jobs, intervals, and one-shot timeouts using a pure-TypeScript 5- and 6-field DST-aware cron parser with zero external runtime dependencies and 83 built-in `CronExpression` presets.

## Installation

```bash
bun add @bunest/jobs
```

## Module Setup

Import `ScheduleModule.forRoot()` once in your root `AppModule`:

@@filename(app.module.ts)

```ts
import { Module } from "@bunest/core";
import { ScheduleModule } from "@bunest/jobs/scheduler";
import { TasksService } from "./tasks.service";

@Module({
  imports: [ScheduleModule.forRoot()],
  providers: [TasksService],
})
export class AppModule {}
```

## Declarative Cron, Interval & Timeout

Decorate methods on any `@Injectable()` provider with `@Cron()`, `@Interval()`, or `@Timeout()`:

@@filename(tasks.service.ts)

```ts
import { Injectable, Logger } from "@bunest/core";
import { Cron, CronExpression, Interval, Timeout } from "@bunest/jobs/scheduler";

@Injectable()
export class TasksService {
  private readonly logger = new Logger(TasksService.name);

  @Cron(CronExpression.EVERY_5_MINUTES, {
    name: "cleanup-sessions",
    timeZone: "UTC",
    preventOverlap: true,
  })
  async cleanupExpiredSessions() {
    this.logger.log("Cleaning expired sessions");
  }

  @Interval("heartbeat", 30_000)
  handleHeartbeat() {
    this.logger.debug("Heartbeat tick");
  }

  @Timeout("warmup", 5_000)
  handleWarmup() {
    this.logger.log("Post-bootstrap warmup complete");
  }
}
```

> info **Overlap Protection** Set `preventOverlap: true` to guarantee a slow execution is never re-entered concurrently on the same instance. For multi-instance cluster deduplication, combine with `@OnOneInstance()` or `@WithoutOverlapping()` from [`@bunest/resilience/locks`](/distributed/locks-idempotency).

## Dynamic Job Management (`SchedulerRegistry`)

Inject `SchedulerRegistry` to inspect, start, stop, add, or delete cron jobs, intervals, and timeouts at runtime:

@@filename(jobs.service.ts)

```ts
import { Injectable } from "@bunest/core";
import { CronJob, SchedulerRegistry } from "@bunest/jobs/scheduler";

@Injectable()
export class JobsService {
  constructor(private readonly registry: SchedulerRegistry) {}

  pauseJob(name: string) {
    const job = this.registry.getCronJob(name);
    job.stop();
  }

  addDynamicCron(name: string, expression: string, fn: () => void) {
    const job = new CronJob(expression, fn);
    this.registry.addCronJob(name, job);
    job.start();
  }
}
```
