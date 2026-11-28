# @bunest/jobs

Unified background job queues (native `QueueModule` + BullMQ-compatible `BullModule` / `WorkerHost` / `FlowProducer` + native `Bun.RedisClient` Lua driver), native Bun 1.4.5 cron/interval/timeout scheduler (`Bun.cron` in-process & OS-level + `Bun.cron.parse(..., { tz })` + DST-aware 6-field fallback engine), and multi-threaded Bun Workers pool for Bunest.

Zero external runtime dependencies.

## Installation

```bash
bun add @bunest/jobs
```

## Quickstart (`QueueModule`)

```ts
import { Injectable, Module } from "@bunest/core";
import {
  InjectQueue,
  MemoryQueueDriver,
  Process,
  Processor,
  QueueModule,
  type Job,
  type Queue,
} from "@bunest/jobs/queues";

@Processor("emails")
export class EmailProcessor {
  @Process("welcome")
  async sendWelcome(job: Job<{ to: string }>) {
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
      {
        attempts: 3,
        backoff: { type: "exponential", delayMs: 500, maxDelayMs: 10_000 },
        idempotencyKey: `welcome:${to}`,
      },
    );
  }
}

@Module({
  imports: [
    QueueModule.forRoot({
      driver: new MemoryQueueDriver(),
    }),
    QueueModule.registerQueue({ name: "emails", concurrency: 4 }),
  ],
  providers: [EmailProcessor, SignupService],
})
export class AppModule {}
```

## Production Redis Driver (`RedisQueueDriver`)

Switch to `RedisQueueDriver` (exported from `@bunest/jobs/redis` and `@bunest/jobs/queues`) for multi-process workers backed by atomic Redis Lua scripts (`EVALSHA` with automatic `NOSCRIPT` reload):

```ts
import { Queue, QueueModule } from "@bunest/jobs/queues";
import { RedisQueueDriver } from "@bunest/jobs/redis";

const driver = new RedisQueueDriver(process.env.REDIS_URL ?? "redis://127.0.0.1:6379", {
  prefix: "myapp:queue",
  lockDurationMs: 30_000,            // active worker lease duration
  stalledIntervalMs: 30_000,         // background stalled-job sweep interval (0 disables)
  maxStalledCount: 1,                // stalls allowed before moving to DLQ
  idempotencyTtlMs: 86_400_000,      // PEXPIRE on idempotency hash (default 24h)
  pruneIdempotencyOnTerminal: true,  // prune idempotency entry on completion/DLQ
});

// Readiness / health probe
const healthy: boolean = await driver.ping();

// Worker queue with cross-process polling (defaults to 250ms for external drivers)
const queue = new Queue({
  name: "emails",
  driver,
  concurrency: 4,
  pollIntervalMs: 250,
});

// Observe transient Redis/driver errors without crashing the worker loop
queue.on("error", (_job, err) => {
  console.error("Queue driver error:", err);
});
```

## Delivery Semantics & Handler Idempotency Contract

`@bunest/jobs` provides **at-least-once** delivery semantics:

- **Lease expiry & duplicate delivery:** When a worker crashes, pauses due to GC/CPU starvation, or loses connectivity to Redis for longer than `lockDurationMs`, the stalled-job sweeper reclaims the expired lease and re-enqueues the job for another worker. A slow worker that later finishes cannot overwrite the reclaimed job's state in Redis (its stale lease token is rejected atomically by Lua `ack`/`nack`), **but its side effects may already have run**.
- **Design handlers to be idempotent:** Any external side effect (payments, emails, webhooks, DB writes) should be guarded by an idempotency key (e.g., `job.id` or `job.idempotencyKey`) in the downstream store.
- **Cooperative cancellation on lease loss:** When automatic lease renewal fails (`renewLease()` returns `false`), `Queue` emits `"lockRenewalFailed"` and aborts an `AbortSignal` passed as the optional 3rd argument `(job, token, signal)` (and also accessible as a non-enumerable `signal` property on `job`). Long-running handlers can check `signal?.aborted` or forward `signal` to `fetch()` / DB calls to stop work promptly.
- **Transient outage recovery:** If Redis disconnects transiently, `pumpLoop()` emits `"error"` and retries with bounded exponential backoff (up to 5s) instead of permanently stalling the worker.

## Multi-Threaded Bun Workers (`@bunest/jobs/workers`)

Offload CPU-bound work onto native Bun Worker threads (zero `node:worker_threads`, zero external dependencies) with typed contracts, zero-copy `Transferable` payloads, CLS/`traceparent` propagation, declarative `@Offload()`, and sandboxed `@Processor({ workerFile })` queues:

```ts
// crypto.worker.ts
import { defineWorker, defineWorkerContract, transferable } from "@bunest/jobs/workers";

export const HashContract = defineWorkerContract<Uint8Array, Uint8Array>("sha256");

export default defineWorker({
  [HashContract.name]: (bytes) => {
    const digest = new Bun.CryptoHasher("sha256").update(bytes).digest();
    return transferable(digest, [digest.buffer]);
  },
});
```

```ts
// app.module.ts
import { Module } from "@bunest/core";
import { WorkerModule } from "@bunest/jobs/workers";

@Module({
  imports: [
    WorkerModule.forRoot({
      defaultPoolOptions: { smol: false, unrefWhenIdle: true },
    }),
    WorkerModule.registerPool({
      name: "crypto",
      script: new URL("./crypto.worker.ts", import.meta.url),
      maxThreads: 4,
    }),
  ],
})
export class AppModule {}
```

## Native Bun.cron Scheduler (`@bunest/jobs/scheduler`)

`ScheduleModule` and `CronJob` integrate all three layers of Bun 1.4.5's `Bun.cron` API:

- **`Bun.cron.parse(expr, from, { tz })`:** Automatic native fast-path for 5-field expressions, `@` nicknames, local timezone, IANA `timeZone`, and `utcOffset: 0` (plus `getNextCronDates()` / `job.nextDates()`).
- **In-process `Bun.cron(expr, handler, { tz })`:** Used automatically when `engine: "auto"` (default) for 5-field / nickname jobs with `ref()`, `unref()`, `Symbol.dispose`, `waitForCompletion`, missed-deadline `threshold`, and distributed locks; automatically falls back to the pure-TS timer engine for 6-field seconds, wrap-around ranges, one-shot `Date` schedules, and non-zero `utcOffset`.
- **OS-level `Bun.cron(path, schedule, title)` & `Bun.cron.remove(title)`:** Persistent `crontab` / `launchd` / Task Scheduler jobs via `defineOsCronJob()`, `bootstrapCronApplication()`, `@OsCron()`, `OsCronService`, `registerOsCronJob()`, `removeOsCronJob()`, `syncOsCronJobs()`, and the `bunest cron` CLI (`parse`, `register`, `remove`, `run`, `bunest generate cron`).

```ts
// src/jobs/weekly-report.cron.ts
import { bootstrapCronApplication } from "@bunest/jobs/scheduler";
import { AppModule } from "../app.module";
import { ReportsService } from "../reports/reports.service";

export default bootstrapCronApplication(AppModule, {
  provider: ReportsService,
  method: "generateWeekly",
});
```

## Subpath Exports

| Subpath | Contents |
| --- | --- |
| `@bunest/jobs` | Re-exports queues + scheduler + workers |
| `@bunest/jobs/queues` | `Queue`, `QueueModule`, `BullModule`, `BullMQModule`, `WorkerHost`, `FlowProducer`, `MemoryQueueDriver`, `RedisQueueDriver`, decorators (including sandboxed `workerFile`) |
| `@bunest/jobs/redis` | `RedisQueueDriver`, `createBunRedisQueueClient`, atomic Lua script constants |
| `@bunest/jobs/scheduler` | `ScheduleModule`, `SchedulerRegistry`, `OsCronService`, `CronJob`, `@Cron`, `@OsCron`, `@Interval`, `@Timeout`, `CronExpression`, `defineOsCronJob`, `bootstrapCronApplication`, `registerOsCronJob`, `removeOsCronJob`, `syncOsCronJobs`, `getNextCronDate`, `getNextCronDates`, `isNativeCronExpression` |
| `@bunest/jobs/workers` | `WorkerModule`, `WorkerPool`, `WorkerPoolRegistry`, `defineWorker`, `bootstrapWorkerApplication`, `defineWorkerContract`, `createInlineWorkerPool`, `InProcessWorkerPool`, `BunestWorkerCluster`, `@InjectWorkerPool`, `@WorkerHandler`, `@Offload`, `transferable` |
