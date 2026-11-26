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
      { attempts: 3, backoff: { type: "exponential", delayMs: 500 } },
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

## Redis Driver & Worker Hardening

In production, pass `RedisQueueDriver` (using Bun's native `Bun.RedisClient` with atomic Lua scripts and automatic `EVALSHA`/`NOSCRIPT` reload):

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

// Health / readiness probe
const ok = await driver.ping();
```

External drivers automatically enable a lightweight idle poll timer (`pollIntervalMs`, default `250` ms) so separate or restarted worker processes pick up jobs enqueued by other processes. On transient Redis disconnects, the worker loop emits `"error"` and retries with bounded exponential backoff instead of stalling permanently.

## At-Least-Once Delivery & Handler Idempotency

`@bunest/jobs` guarantees **at-least-once** delivery, not exactly-once execution:

- **Lease expiry & duplicate delivery:** If a worker crashes or freezes past `lockDurationMs`, the stalled-job sweeper reclaims the lease and re-delivers the job to another worker. Atomic Lua lease-token checks prevent the stale worker from clobbering job state on late `ack()`/`nack()`, but any side effects already executed by the handler may run twice.
- **Make handlers idempotent:** Guard external side effects (charges, emails, DB inserts) using `job.id` or `job.idempotencyKey`.
- **Cooperative cancellation (`lockRenewalFailed`):** If lease renewal fails (`renewLease()` returns `false`), `Queue` emits `"lockRenewalFailed"` and aborts an `AbortSignal` passed as the optional 3rd handler argument `(job, token, signal)` (also attached as a non-enumerable `job.signal` property) so long-running handlers can stop cleanly.
