# @bunest/bullmq

Drop-in 1:1 `@nestjs/bullmq` (v12) migration facade for Bunest, powered natively by `@bunest/queues` with zero external runtime dependencies.

## Features

- **Drop-In `@nestjs/bullmq` Parity**: Replace `@nestjs/bullmq` imports with `@bunest/bullmq` verbatim (41/41 `@nestjs/bullmq@12` API parity).
- **Worker & Event Hosts**: `WorkerHost`, `QueueEventsHost`, `QueueEvents`, `Queue`, and `FlowProducer` backed by `@bunest/queues`.
- **Full Decorator Support**: `@Processor()`, `@Process()`, `@InjectQueue()`, `@InjectFlowProducer()`, `@OnWorkerEvent()`, `@QueueEventsListener()`, and `@OnQueueEvent()`.
- **Async & Shared Configuration**: `BullModule.forRoot()`, `forRootAsync()`, `registerQueue()`, `registerQueueAsync()`, and `registerFlowProducer()`.

## Installation

```bash
bun add @bunest/bullmq
```

## Quick Start

```ts
import { Module } from "@bunest/common";
import {
  BullModule,
  InjectQueue,
  OnWorkerEvent,
  Processor,
  Queue,
  WorkerHost,
  type Job,
} from "@bunest/bullmq";

@Processor("emails")
export class EmailWorker extends WorkerHost {
  async process(job: Job<{ to: string }>) {
    return { sentTo: job.data.to };
  }

  @OnWorkerEvent("completed")
  onCompleted(job: Job) {
    console.log(`Completed job ${job.id}`);
  }
}

@Module({
  imports: [
    BullModule.forRoot({}),
    BullModule.registerQueue({ name: "emails" }),
  ],
  providers: [EmailWorker],
})
export class AppModule {
  constructor(@InjectQueue("emails") readonly queue: Queue) {}
}
```

## Key Exports

- **Module & Driver**: `BullModule`, `BullMQModule`, `BullRegistrar`, `BullMQExplorer`, `BullMQQueueDriver`, `ProcessorDecoratorService`
- **Hosts & Runtime Classes**: `WorkerHost`, `QueueEventsHost`, `QueueEvents`, `FlowProducer`, `Queue`
- **Decorators**: `@Processor()`, `@Process()`, `@InjectQueue()`, `@InjectFlowProducer()`, `@OnWorkerEvent()`, `@QueueEventsListener()`, `@OnQueueEvent()`
- **Tokens & Helpers**: `BULLMQ_DRIVER`, `BULLMQ_MODULE_OPTIONS`, `BULL_CONFIG_DEFAULT_TOKEN`, `BULL_EXTRA_OPTIONS_TOKEN`, `JOB_REF`, `getQueueToken`, `getQueueOptionsToken`, `getFlowProducerToken`, `getFlowProducerOptionsToken`, `getSharedConfigToken`

## Documentation

- [Bunest Documentation](../../README.md)
- [ADR Index](../../docs/adr/README.md)
