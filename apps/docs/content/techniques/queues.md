# Queues, Bull & BullMQ

Bunest provides background job processing through **`@bunest/queues`** along with 100% API-compatible drop-in packages **`@bunest/bull`** (`@nestjs/bull`) and **`@bunest/bullmq`** (`@nestjs/bullmq`). All three run natively on Bun with zero external runtime dependencies—supporting both in-memory development/testing (`MemoryQueueDriver`) and atomic Lua-scripted Redis (`RedisQueueDriver`) with lock leases, stalled job recovery, retries, backoff, delayed jobs, and dead-letter queues (DLQ).

## Installation

@@tab(@bunest/queues)
```bash
bun add @bunest/queues
```
@@switch
@@tab(@bunest/bull)
```bash
bun add @bunest/bull
```
@@switch
@@tab(@bunest/bullmq)
```bash
bun add @bunest/bullmq
```

## Native `@bunest/queues`

Register `QueueModule.forRoot()` and queue names with `QueueModule.registerQueue()`:

@@filename(app.module.ts)
```ts
import { Module } from "@bunest/core";
import { MemoryQueueDriver, QueueModule } from "@bunest/queues";
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

Define a worker with `@Processor()` and `@Process()`, and enqueue jobs via `@InjectQueue()`:

@@filename(email.processor.ts)
```ts
import { Injectable } from "@bunest/core";
import { InjectQueue, Process, Processor, type Job, type Queue } from "@bunest/queues";

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
    await this.emailQueue.add("welcome", { to }, { attempts: 3, backoff: { type: "exponential", delay: 500 } });
  }
}
```

## Drop-In `@bunest/bull` & `@bunest/bullmq`

Teams migrating from NestJS can keep `@nestjs/bull` or `@nestjs/bullmq` patterns verbatim:

@@filename(audio.module.ts)
```ts
import { Module } from "@bunest/core";
import { BullModule, Processor, WorkerHost, type Job } from "@bunest/bullmq";

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

> info **Redis Atomic Lua Driver** Switch from `MemoryQueueDriver` to `RedisQueueDriver` in production for multi-worker lock leases, automatic stalled-job recovery, scheduled/delayed queues, and dead-letter queue inspection.
