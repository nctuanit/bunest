# Queues & BullMQ API

Bunest provides background job processing directly through **`@bunest/jobs/queues`**, which includes both native `QueueModule` and BullMQ-compatible `BullModule` / `BullMQModule` (`WorkerHost`, `FlowProducer`, `QueueEventsHost`). It runs natively on Bun with zero external runtime dependencies—supporting both in-memory development/testing (`MemoryQueueDriver`) and atomic Lua-scripted Redis (`RedisQueueDriver`) with lock leases, stalled job recovery, retries, backoff, delayed jobs, and dead-letter queues (DLQ).

## Installation

```bash
bun add @bunest/jobs
```

## Native `@bunest/jobs/queues`

Register `QueueModule.forRoot()` and queue names with `QueueModule.registerQueue()`:

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

Define a worker with `@Processor()` and `@Process()`, and enqueue jobs via `@InjectQueue()`:

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

## BullMQ-Compatible `BullModule` & `WorkerHost`

Teams migrating from `@nestjs/bullmq` can use `BullModule` and `WorkerHost` directly from `@bunest/jobs/queues`:

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

> info **Redis Atomic Lua Driver** Switch from `MemoryQueueDriver` to `RedisQueueDriver` in production for multi-worker lock leases, automatic stalled-job recovery, scheduled/delayed queues, and dead-letter queue inspection.
