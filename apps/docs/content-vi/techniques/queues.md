# Hàng đợi & API BullMQ

Bunest cung cấp cơ chế xử lý tác vụ nền trực tiếp thông qua **`@bunest/jobs/queues`**, bao gồm cả `QueueModule` gốc và `BullModule` / `BullMQModule` tương thích với BullMQ (`WorkerHost`, `FlowProducer`, `QueueEventsHost`). Gói chạy trực tiếp trên Bun mà không có phụ thuộc runtime bên ngoài—hỗ trợ cả chế độ phát triển/kiểm thử trong bộ nhớ (`MemoryQueueDriver`) và Redis chạy Lua script nguyên tử (`RedisQueueDriver`) với lock lease, khôi phục tác vụ bị treo, thử lại (retries), backoff, tác vụ trì hoãn (delayed jobs) và hàng đợi thư chết (DLQ).

## Cài đặt

```bash
bun add @bunest/jobs
```

## `@bunest/jobs/queues` gốc

Đăng ký `QueueModule.forRoot()` và tên các hàng đợi bằng `QueueModule.registerQueue()`:

@@filename(app.module.ts)

```ts
import { Module } from "@bunest/core";
import { MemoryQueueDriver, QueueModule } from "@bunest/jobs/queues";
import { EmailProcessor } from "./email.processor";

@Module({
  imports: [
    QueueModule.forRoot({
      driver: new MemoryQueueDriver(),
    }),
    QueueModule.registerQueue({ name: "emails" }),
  ],
  providers: [EmailProcessor],
})
export class AppModule {}
```

Định nghĩa worker bằng `@Processor()` và `@Process()`, đồng thời đưa tác vụ vào hàng đợi qua `@InjectQueue()`:

@@filename(email.processor.ts)

```ts
import { Injectable } from "@bunest/core";
import {
  InjectQueue,
  Process,
  Processor,
  type Job,
  type Queue,
} from "@bunest/jobs/queues";

@Processor("emails")
export class EmailProcessor {
  @Process("welcome")
  async sendWelcome(job: Job<{ to: string }>) {
    // Process job payload
    return { sentTo: job.data.to };
  }
}

@Injectable()
export class SignupService {
  constructor(@InjectQueue("emails") private readonly emailQueue: Queue) {}

  async enqueueWelcome(to: string) {
    await this.emailQueue.add(
      "welcome",
      { to },
      { attempts: 3, backoff: { type: "exponential", delayMs: 500 } },
    );
  }
}
```

## `BullModule` & `WorkerHost` tương thích BullMQ

Các đội ngũ chuyển đổi từ `@nestjs/bullmq` có thể sử dụng trực tiếp `BullModule` và `WorkerHost` từ `@bunest/jobs/queues`:

@@filename(audio.module.ts)

```ts
import { Module } from "@bunest/core";
import { BullModule, Processor, WorkerHost, type Job } from "@bunest/jobs/queues";

@Processor("audio")
export class AudioConsumer extends WorkerHost {
  async process(job: Job<{ file: string }>) {
    return { transcoded: job.data.file };
  }
}

@Module({
  imports: [BullModule.registerQueue({ name: "audio" })],
  providers: [AudioConsumer],
})
export class AudioModule {}
```

> info **Driver Redis Lua nguyên tử** Chuyển từ `MemoryQueueDriver` sang `RedisQueueDriver` ở môi trường production để có lock lease đa worker, tự động khôi phục tác vụ bị treo, hàng đợi hẹn giờ/trì hoãn và kiểm tra hàng đợi thư chết (DLQ).

## Driver Redis & Tăng cường độ bền Worker

Ở môi trường production, sử dụng `RedisQueueDriver` (dựa trên `Bun.RedisClient` gốc với các Lua script nguyên tử và tự động nạp lại `EVALSHA`/`NOSCRIPT`):

```ts
import { QueueModule } from "@bunest/jobs/queues";
import { RedisQueueDriver } from "@bunest/jobs/redis";

const driver = new RedisQueueDriver(process.env.REDIS_URL!, {
  prefix: "myapp:queue",
  lockDurationMs: 30_000,
  stalledIntervalMs: 30_000,
  maxStalledCount: 1,
  idempotencyTtlMs: 86_400_000,
  pruneIdempotencyOnTerminal: true,
});

// Kiểm tra kết nối / readiness probe
const ok = await driver.ping();
```

Các driver ngoài tự động bật bộ hẹn giờ thăm dò nhẹ (`pollIntervalMs`, mặc định `250` ms) để các tiến trình worker riêng biệt hoặc mới khởi động lại nhận được tác vụ do tiến trình khác đưa vào hàng đợi. Khi mất kết nối Redis tạm thời, vòng lặp worker phát sự kiện `"error"` và tự động thử lại theo cơ chế exponential backoff có giới hạn thay vì dừng vĩnh viễn.

## Cam kết gửi ít nhất một lần (At-Least-Once) & Tính bất biến của Handler

`@bunest/jobs` đảm bảo cơ chế gửi **ít nhất một lần (at-least-once)**, không phải chính xác một lần:

- **Hết hạn lease & xử lý trùng lặp:** Nếu một worker bị treo hoặc dừng quá `lockDurationMs`, bộ quét tác vụ bị treo sẽ thu hồi lease và đưa tác vụ trở lại hàng đợi cho worker khác. Việc kiểm tra lease token nguyên tử trong Lua ngăn worker cũ ghi đè trạng thái khi `ack()`/`nack()` muộn, nhưng các tác động bên ngoài đã thực thi trước đó vẫn có thể chạy hai lần.
- **Thiết kế handler có tính idempotent:** Luôn bảo vệ các tác động bên ngoài (thanh toán, gửi email, ghi CSDL) bằng `job.id` hoặc `job.idempotencyKey`.
- **Hủy hợp tác khi mất lease (`lockRenewalFailed`):** Khi gia hạn lease thất bại (`renewLease()` trả về `false`), `Queue` phát sự kiện `"lockRenewalFailed"` và hủy một `AbortSignal` được truyền ở tham số thứ 3 `(job, token, signal)` (đồng thời gắn dưới dạng thuộc tính không liệt kê `job.signal`) để các handler chạy dài có thể dừng an toàn.
