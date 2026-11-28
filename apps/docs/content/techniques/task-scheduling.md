# Task Scheduling

**`@bunest/jobs/scheduler`** provides declarative cron jobs, intervals, one-shot timeouts, and OS-level persistent cron jobs backed natively by Bun 1.4.5's `Bun.cron` API (`Bun.cron.parse`, in-process `Bun.cron()`, and OS-level `Bun.cron(path, schedule, title)` / `Bun.cron.remove()`), seamlessly falling back to a zero-dependency DST-aware 6-field TypeScript engine with 83 built-in `CronExpression` presets.

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
    waitForCompletion: true,
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

> info **Overlap Protection** Set `waitForCompletion: true` to guarantee a slow execution is never re-entered concurrently on the same instance. For multi-instance cluster deduplication, combine with `@OnOneInstance()` or `@WithoutOverlapping()` from [`@bunest/resilience/locks`](/distributed/locks-idempotency).

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
    const job = new CronJob(expression, fn, { engine: "auto" });
    this.registry.addCronJob(name, job);
    job.start();
  }
}
```

## Native `Bun.cron` Execution Engine

By default (`engine: "auto"`), `CronJob` and `@Cron()` automatically execute compatible 5-field expressions and `@` nicknames (`@hourly`, `@daily`, `@weekly`, `@monthly`, `@yearly`, `@annually`, `@midnight`, `@every_minute`) on Bun 1.4.5's native in-process `Bun.cron(expr, handler, { tz })` engine and compute upcoming runs with `Bun.cron.parse(expr, from, { tz })`. Schedules requiring 6-field second precision, wrap-around ranges (`22-2`, `FRI-MON`), one-shot `Date` targets, or non-zero `utcOffset` automatically use the pure-TypeScript timer engine.

- Control the default engine module-wide via `ScheduleModule.forRoot({ defaultEngine: "auto" | "native" | "timer" })`, or per job via `@Cron(expr, { engine: "native" })`.
- `CronJob` implements `Disposable` (`using job = new CronJob(...)`), chainable `.ref()` / `.unref()`, and `job.nextDates(count)` / `getNextCronDates(expr, count, from, timeZone)`.

## OS-Level Persistent Cron Jobs (`Bun.cron`)

For jobs that must survive process exit and system reboots (`crontab` on Linux, `launchd` on macOS, Task Scheduler on Windows), scaffold a cron module with `bunest generate cron weekly-report` or write one using `defineOsCronJob` (lightweight) or `bootstrapCronApplication` (full DI + CLS + graceful shutdown):

@@filename(src/jobs/weekly-report.cron.ts)

```ts
import { bootstrapCronApplication } from "@bunest/jobs/scheduler";
import { AppModule } from "../app.module";
import { ReportsService } from "../reports/reports.service";

export default bootstrapCronApplication(AppModule, {
  provider: ReportsService,
  method: "generateWeekly",
});
```

Register, preview, run locally, or remove OS-level cron jobs via `OsCronService` or the CLI:

```bash
bunest cron parse "30 2 * * MON" --tz UTC --count 5
bunest cron run ./src/jobs/weekly-report.cron.ts --schedule "30 2 * * MON"
bunest cron register ./src/jobs/weekly-report.cron.ts "30 2 * * MON" weekly-report
bunest cron remove weekly-report
```
