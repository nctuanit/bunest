# Background Queues (`26-queues`)

Bunest counterpart of NestJS's [`sample/26-queues`](https://github.com/nestjs/nest/tree/master/sample/26-queues), powered by `@bunest/jobs/queues`:

- **`BullModule.forRoot()` & `BullModule.registerQueue({ name: "audio" })`**: Zero-dependency BullMQ-compatible queue (uses in-memory driver by default; swap to `RedisQueueDriver` for multi-instance Redis)
- **`@Processor("audio")` + `WorkerHost`**: Processes audio transcoding jobs with concurrency and failure handling
- **`@OnWorkerEvent` & `@QueueEventsListener`**: Tracks `added`, `active`, `completed`, and `failed` job lifecycle events

## Run

```bash
bun run --cwd examples/queues dev
bun run --cwd examples/queues test
```
