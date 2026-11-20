# @bunest/queues

Background job queues for **Bunest** with zero external runtime dependencies. Supports pluggable memory and Redis drivers, priority and delayed scheduling, retries with backoff, job idempotency, dead-letter queues, parent-child flows, and graceful drain.

## Features

- **Pluggable Queue Drivers**: Includes `MemoryQueueDriver` for local/test execution and `RedisQueueDriver` backed by atomic Lua scripts (`LUA_ENQUEUE_JOB`, `LUA_DEQUEUE_JOB`, `LUA_ACK_JOB`, `LUA_NACK_OR_DLQ_JOB`, `LUA_RENEW_LEASE`, `LUA_RECLAIM_STALLED`).
- **Declarative Workers & Listeners**: `@Processor()`, `@Process()`, `WorkerHost`, `@QueueEventsListener()`, `QueueEventsHost`, `@OnQueueEvent()`, and `@OnWorkerEvent()`.
- **Parent-Child Job Flows**: Orchestrate DAG job dependencies with `FlowProducer` and `@InjectFlowProducer()`.
- **Retries, Backoff & Timeouts**: Configurable exponential/fixed backoff (`calculateBackoffDelay()`), `JobTimeoutError`, lease renewal, stalled job reclamation, and DLQ handling.
- **BullMQ Compatibility**: Built-in `BullModule` / `BullMQModule` adapter layer powering `@bunest/bull` and `@bunest/bullmq`.

## Installation

```bash
bun add @bunest/queues
```

## Quick Start

```ts
import { Injectable, Module } from "@bunest/common";
import {
  InjectQueue,
  MemoryQueueDriver,
  Processor,
  Queue,
  QueueModule,
  WorkerHost,
  type Job,
} from "@bunest/queues";

@Processor("emails")
export class EmailWorker extends WorkerHost {
  async process(job: Job<{ to: string; subject: string }>) {
    console.log("Sending email to", job.data.to);
    return { sent: true };
  }
}

@Injectable()
export class NotificationsService {
  constructor(@InjectQueue("emails") private readonly emailQueue: Queue) {}

  enqueueWelcome(to: string) {
    return this.emailQueue.add("welcome", { to, subject: "Welcome!" }, { attempts: 3 });
  }
}

@Module({
  imports: [
    QueueModule.forRoot({ driver: new MemoryQueueDriver() }),
    QueueModule.registerQueue({ name: "emails" }),
  ],
  providers: [EmailWorker, NotificationsService],
})
export class AppModule {}
```

## Key Exports

- **Modules & Registry**: `QueueModule`, `QueueRegistry`, `QueueExplorer`, `Queue`, `FlowProducer`, `BullModule`, `BullMQModule`, `BullMQExplorer`, `BullRegistrar`
- **Drivers & Lua Scripts**: `MemoryQueueDriver`, `RedisQueueDriver`, `BullMQQueueDriver`, `LUA_ENQUEUE_JOB`, `LUA_DEQUEUE_JOB`, `LUA_ACK_JOB`, `LUA_NACK_OR_DLQ_JOB`, `LUA_RENEW_LEASE`, `LUA_RECLAIM_STALLED`
- **Decorators & Hosts**: `Processor`, `Process`, `WorkerHost`, `QueueEvents`, `QueueEventsHost`, `QueueEventsListener`, `OnQueueEvent`, `OnWorkerEvent`, `InjectQueue`, `InjectFlowProducer`, `ProcessorDecoratorService`
- **Tokens, Errors & Utilities**: `QUEUE_DRIVER`, `QUEUE_REGISTRY`, `QUEUE_MODULE_OPTIONS`, `JOB_REF`, `getQueueToken`, `getFlowProducerToken`, `JobTimeoutError`, `calculateBackoffDelay`

## Documentation

- [Bunest Documentation](../../README.md)
- [ADR Index](../../docs/adr/README.md)
