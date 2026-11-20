# @bunest/bull

Classic `@nestjs/bull` API parity backed natively by `@bunest/queues` (`MemoryQueueDriver` / `RedisQueueDriver`) with zero external `bull` or `ioredis` npm runtime dependencies.

## Features

- **`BullModule`**: `forRoot`, `forRootAsync`, `registerQueue`, and `registerQueueAsync` with shared named `configKey` support and `MissingBullSharedConfigurationError` validation.
- **Full Decorator Suite**: `@Processor`, `@Process`, `@InjectQueue`, `@OnQueueEvent`, all 12 `@OnQueue*` local event decorators, and all 12 `@OnGlobalQueue*` global event decorators (including `{ name }` / `{ id }` event filtering).
- **Scoped Processors**: `Scope.REQUEST` processors with `@Inject(JOB_REF)` injection.
- **Bull v4-Compatible `BullQueue` & `BullJob`**: `add`, `addBulk`, `process` (Promise and `done` callbacks plus separate processor file paths), `pause`, `resume`, `clean`, `empty`, `obliterate`, `getJob`, `getJobs`, `getJobCounts`, `progress`, `log`, `finished`, and graceful `onApplicationShutdown`.

## Installation

```bash
bun add @bunest/bull
```

## Quick Start

```ts
import { Injectable, Module } from "@bunest/common";
import {
  BullModule,
  InjectQueue,
  Process,
  Processor,
  type BullJob,
  type BullQueue,
} from "@bunest/bull";

@Processor("audio")
export class AudioProcessor {
  @Process("transcode")
  async handleTranscode(job: BullJob<{ file: string }>) {
    await job.progress(100);
    return { done: true, file: job.data.file };
  }
}

@Injectable()
export class AudioService {
  constructor(@InjectQueue("audio") private readonly audioQueue: BullQueue) {}

  enqueue(file: string) {
    return this.audioQueue.add("transcode", { file });
  }
}

@Module({
  imports: [
    BullModule.forRoot({}),
    BullModule.registerQueue({ name: "audio" }),
  ],
  providers: [AudioProcessor, AudioService],
})
export class AppModule {}
```

## Key Exports

- **Module & Runtime**: `BullModule`, `BullQueue`, `BullJob`, `BullExplorer`, `BullMetadataAccessor`, `createQueueProviders`, `createQueueOptionProviders`
- **Decorators**: `@Processor()`, `@Process()`, `@InjectQueue()`, `@OnQueueEvent()`, `@OnQueueActive()`, `@OnQueueCompleted()`, `@OnQueueFailed()`, `@OnQueueProgress()`, `@OnQueueWaiting()`, `@OnQueueStalled()`, `@OnQueuePaused()`, `@OnQueueResumed()`, `@OnQueueCleaned()`, `@OnQueueDrained()`, `@OnQueueRemoved()`, `@OnQueueError()`, and `@OnGlobalQueue*()` equivalents
- **Enums & Errors**: `BullQueueEvents`, `BullQueueGlobalEvents`, `MissingBullSharedConfigurationError`
- **Tokens & Helpers**: `JOB_REF`, `NO_QUEUE_FOUND`, `BULL_CONFIG_DEFAULT_TOKEN`, `BULL_MODULE_QUEUE`, `BULL_MODULE_QUEUE_PROCESS`, `BULL_MODULE_ON_QUEUE_EVENT`, `getQueueToken`, `getQueueOptionsToken`, `getSharedConfigToken`

## Documentation

- [Bunest Documentation](../../README.md)
- [ADR Index](../../docs/adr/README.md)
