# Task Scheduling (`27-scheduling`)

Bunest counterpart of NestJS's [`sample/27-scheduling`](https://github.com/nestjs/nest/tree/master/sample/27-scheduling), powered by `@bunest/jobs/scheduler`:

- **`ScheduleModule.forRoot()`**: Auto-discovers declarative scheduled jobs and stops all timers cleanly on `app.close()`
- **Declarative decorators**: `@Cron(CronExpression.EVERY_30_SECONDS, { name: "notifications" })`, `@Interval("heartbeat", 40)`, and `@Timeout("warmup", 15)`
- **Dynamic management (`SchedulerRegistry`)**: Add, inspect, and remove `CronJob`s at runtime via HTTP endpoints

## Run

```bash
bun run --cwd examples/scheduling dev
bun run --cwd examples/scheduling test
```
