# Lập lịch tác vụ (Task Scheduling)

**`@bunest/jobs/scheduler`** cung cấp các tác vụ cron dạng khai báo, interval và timeout chạy một lần bằng bộ phân tích cron thuần TypeScript hỗ trợ 5 và 6 trường có nhận biết DST, không có phụ thuộc runtime bên ngoài và đi kèm 83 cấu hình `CronExpression` dựng sẵn.

## Cài đặt

```bash
bun add @bunest/jobs
```

## Thiết lập Module

Import `ScheduleModule.forRoot()` một lần trong `AppModule` gốc của bạn:

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

## Cron, Interval & Timeout dạng khai báo

Gắn decorator `@Cron()`, `@Interval()` hoặc `@Timeout()` lên các phương thức trong bất kỳ provider `@Injectable()` nào:

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

> info **Chống chạy chồng chéo (Overlap Protection)** Đặt `preventOverlap: true` để đảm bảo một lần thực thi chậm không bao giờ bị gọi lại đồng thời trên cùng một instance. Để chống trùng lặp trên cụm đa instance, hãy kết hợp với `@OnOneInstance()` hoặc `@WithoutOverlapping()` từ [`@bunest/resilience/locks`](/distributed/locks-idempotency).

## Quản lý tác vụ động (`SchedulerRegistry`)

Inject `SchedulerRegistry` để kiểm tra, bắt đầu, dừng, thêm hoặc xóa các tác vụ cron, interval và timeout trong lúc chạy (runtime):

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
