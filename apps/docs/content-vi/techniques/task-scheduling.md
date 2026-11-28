# Lập lịch tác vụ (Task Scheduling)

**`@bunest/jobs/scheduler`** cung cấp các tác vụ cron dạng khai báo, interval, timeout chạy một lần và cron cấp hệ điều hành (OS-level) được tích hợp trực tiếp với `Bun.cron` của Bun 1.4.5 (`Bun.cron.parse`, in-process `Bun.cron()`, và OS-level `Bun.cron(path, schedule, title)` / `Bun.cron.remove()`), đồng thời tự động fallback sang bộ phân tích 6 trường thuần TypeScript có nhận biết DST, không có phụ thuộc runtime bên ngoài và đi kèm 83 cấu hình `CronExpression` dựng sẵn.

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

> info **Chống chạy chồng chéo (Overlap Protection)** Đặt `waitForCompletion: true` để đảm bảo một lần thực thi chậm không bao giờ bị gọi lại đồng thời trên cùng một instance. Để chống trùng lặp trên cụm đa instance, hãy kết hợp với `@OnOneInstance()` hoặc `@WithoutOverlapping()` từ [`@bunest/resilience/locks`](/distributed/locks-idempotency).

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
    const job = new CronJob(expression, fn, { engine: "auto" });
    this.registry.addCronJob(name, job);
    job.start();
  }
}
```

## Engine thực thi Native `Bun.cron`

Mặc định (`engine: "auto"`), `CronJob` và `@Cron()` tự động chạy các biểu thức 5 trường và nickname `@` (`@hourly`, `@daily`, `@weekly`, `@monthly`, `@yearly`, `@annually`, `@midnight`, `@every_minute`) trên engine in-process native `Bun.cron(expr, handler, { tz })` của Bun 1.4.5 và tính thời điểm kế tiếp bằng `Bun.cron.parse(expr, from, { tz })`. Các lịch cần độ chính xác theo giây (6 trường), khoảng vòng ngược (`22-2`, `FRI-MON`), `Date` chạy một lần hoặc `utcOffset` khác 0 sẽ tự động dùng timer engine thuần TypeScript.

- Tùy chỉnh engine mặc định ở cấp module qua `ScheduleModule.forRoot({ defaultEngine: "auto" | "native" | "timer" })`, hoặc từng job qua `@Cron(expr, { engine: "native" })`.
- `CronJob` hỗ trợ `Disposable` (`using job = new CronJob(...)`), `.ref()` / `.unref()` dạng chainable, và `job.nextDates(count)` / `getNextCronDates(expr, count, from, timeZone)`.

## Cron cấp Hệ điều hành (`Bun.cron` OS-level)

Với các tác vụ cần tồn tại độc lập sau khi process thoát hoặc máy khởi động lại (`crontab` trên Linux, `launchd` trên macOS, Task Scheduler trên Windows), bạn có thể tạo nhanh bằng `bunest generate cron weekly-report` hoặc khai báo bằng `defineOsCronJob` (nhẹ, không cần DI) hay `bootstrapCronApplication` (đầy đủ DI + CLS + graceful shutdown):

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

Đăng ký, xem trước, chạy thử cục bộ hoặc gỡ bỏ tác vụ OS cron qua `OsCronService` hoặc CLI:

```bash
bunest cron parse "30 2 * * MON" --tz UTC --count 5
bunest cron run ./src/jobs/weekly-report.cron.ts --schedule "30 2 * * MON"
bunest cron register ./src/jobs/weekly-report.cron.ts "30 2 * * MON" weekly-report
bunest cron remove weekly-report
```
