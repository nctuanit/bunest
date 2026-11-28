# Bun Workers (Multi-Threading)

Offload CPU-bound workloads (cryptography, compression, image/PDF/CSV processing, parsing, embeddings) onto native [Bun Workers](https://bun.sh/docs/runtime/workers) threads without blocking `Bun.serve()`'s main event loop.

`@bunest/jobs/workers` is built purely on Bun's Web Worker globals (`new Worker(...)`, `postMessage`, `Bun.isMainThread`, `smol`, `preload`, `ref`/`unref`, `File` `blob:` URLs) with **zero external runtime dependencies** and **zero `node:worker_threads` imports** (`ADR-017`, `ADR-019`).

---

## 1. Quickstart (`defineWorker` + `WorkerModule`)

### Define a worker script

```ts
// src/workers/hash.worker.ts
import {
  defineWorker,
  defineWorkerContract,
  transferable,
  type WorkerTaskContext,
} from "@bunest/jobs/workers";

export const Sha256Contract = defineWorkerContract<Uint8Array, Uint8Array>(
  "sha256",
);

export default defineWorker({
  [Sha256Contract.name]: (input: Uint8Array, ctx: WorkerTaskContext) => {
    ctx.reportProgress(50);
    const digest = new Bun.CryptoHasher("sha256").update(input).digest();
    ctx.reportProgress(100);
    // Zero-copy transfer of the resulting ArrayBuffer back to the main thread
    return transferable(digest, [digest.buffer]);
  },
});
```

> **Startup safety on Bun:** `defineWorker()` and `bootstrapWorkerApplication()` always install `self.onmessage` synchronously before any `await`, buffering early messages until `INIT` / `onInit()` completes so zero startup messages are dropped.

### Register the pool & inject it

```ts
// src/app.module.ts
import { Injectable, Module } from "@bunest/core";
import {
  InjectWorkerPool,
  WorkerModule,
  type WorkerPool,
} from "@bunest/jobs/workers";
import { Sha256Contract } from "./workers/hash.worker";

@Injectable()
export class HashService {
  constructor(
    @InjectWorkerPool("hash") private readonly pool: WorkerPool,
  ) {}

  async digest(bytes: Uint8Array): Promise<Uint8Array> {
    return this.pool.run(Sha256Contract, bytes, {
      timeoutMs: 5_000,
      onProgress: (pct) => console.log("progress", pct),
    });
  }
}

@Module({
  imports: [
    WorkerModule.forRoot({
      defaultPoolOptions: {
        minThreads: 1,
        maxThreads: 4,
        smol: false,
        unrefWhenIdle: true,
        idleTimeoutMs: 30_000,
        maxQueueSize: 1024,
      },
    }),
    WorkerModule.registerPool({
      name: "hash",
      script: new URL("./workers/hash.worker.ts", import.meta.url),
      preload: ["./preload-otel.ts"],
    }),
  ],
  providers: [HashService],
})
export class AppModule {}
```

---

## 2. Declarative Service AOP (`@Offload`)

Route any `@Injectable()` method transparently to a registered `WorkerPool` using Bunest's compile-once service-layer AOP weaver (`ADR-014`):

```ts
import { Injectable } from "@bunest/core";
import { Offload } from "@bunest/jobs/workers";
import { Sha256Contract } from "./workers/hash.worker";

@Injectable()
export class CryptoService {
  @Offload({ pool: "hash", contract: Sha256Contract, timeoutMs: 5_000 })
  async sha256(_input: Uint8Array): Promise<Uint8Array> {
    throw new Error("Executed on worker thread");
  }
}
```

---

## 3. DI-Enabled Worker (`bootstrapWorkerApplication`)

When a worker needs `@Injectable()` services, `ConfigService`, or database access inside its own thread without starting an HTTP server:

```ts
// src/workers/report.worker.ts
import { Injectable, Module } from "@bunest/core";
import {
  WorkerHandler,
  bootstrapWorkerApplication,
  type WorkerTaskContext,
} from "@bunest/jobs/workers";

@Injectable()
class ReportGenerator {
  @WorkerHandler("generate-csv")
  async generate(rows: readonly string[], ctx: WorkerTaskContext): Promise<string> {
    ctx.reportProgress(100);
    return rows.join("\n");
  }
}

@Module({ providers: [ReportGenerator] })
class ReportWorkerModule {}

bootstrapWorkerApplication(ReportWorkerModule);
```

---

## 4. Inline Workers (`createInlineWorkerPool`)

For self-contained computations without creating a separate file, Bunest creates an in-memory `File` + `blob:` URL and revokes it automatically on `pool.close()`:

```ts
import { createInlineWorkerPool } from "@bunest/jobs/workers";

const pool = createInlineWorkerPool(
  (n: number) => {
    let acc = 0;
    for (let i = 0; i <= n; i++) acc += i;
    return acc;
  },
  { maxThreads: 2, smol: true },
);

const total = await pool.run("default", 1_000_000);
await pool.close();
```

---

## 5. Sandboxed Queue Processors (`@bunest/jobs/queues`)

Run background queue jobs off the main event loop by passing `workerFile` to `@Processor()`:

```ts
import { Processor } from "@bunest/jobs/queues";

@Processor({
  name: "video-transcode",
  concurrency: 2,
  workerFile: new URL("./transcode.worker.ts", import.meta.url),
  workerPool: { smol: false, maxTasksPerWorker: 100 },
})
export class VideoProcessor {}
```

---

## 6. Observability, Context Propagation & Health

- **CLS & W3C `traceparent`:** `WorkerPool.run()` automatically captures ambient CLS keys (`requestId`, `tenantId`, `userId`, `correlationId`) and active W3C `traceparent`, restoring CLS inside the worker thread.
- **Auto-Tracing:** `@bunest/observability`'s `OtelAutoInstrumentation` automatically subscribes to `bunest:workers:dispatch` and emits `workers.run <pool>/<task>` spans.
- **Readiness Health Check:** Use `WorkerPoolHealthIndicator` from `@bunest/observability/health` with a `WorkerPool` or `WorkerPoolRegistry`.

---

## 7. CLI Scaffolding, Bundling & Standalone Executables

- Generate a worker + test pair:
  ```bash
  bunest generate worker crypto
  # alias: bunest g w crypto
  ```
- `bunest build` and `bunest build --compile` automatically discover `**/*.worker.{ts,js,mts,mjs}` under `sourceRoot` (or explicit `--worker <path>` / `compilerOptions.workers`) and embed them as entrypoints.

---

## 8. Multi-Thread HTTP Scaling (`reusePort` + `BunestWorkerCluster`)

On Linux, multiple Bun Worker threads can share one listening port via `SO_REUSEPORT`:

```ts
// main.ts
import { createWorkerCluster, isMainThread } from "@bunest/jobs/workers";

if (isMainThread()) {
  const cluster = createWorkerCluster({
    script: new URL("./server.worker.ts", import.meta.url),
    workers: 4,
  });
  cluster.start();
}
```

```ts
// server.worker.ts
import { BunestFactory } from "@bunest/core";
import { onClusterShutdown } from "@bunest/jobs/workers";
import { AppModule } from "./app.module";

const app = await BunestFactory.create(AppModule);
await app.listen({ port: 3000, reusePort: true });
onClusterShutdown(() => app.close());
```

> **Platform note:** Kernel `SO_REUSEPORT` load balancing is recommended on **Linux**. On macOS/Windows, kernel connection distribution across threads may be uneven.
