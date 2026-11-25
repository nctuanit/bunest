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
      { attempts: 3, backoff: { type: "exponential", delay: 500 } },
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
