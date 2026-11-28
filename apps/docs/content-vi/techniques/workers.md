# Bun Workers (Đa luồng)

Đẩy các tác vụ nặng CPU (mã hóa, nén dữ liệu, xử lý ảnh/PDF/CSV, phân tích cú pháp, embeddings) sang các luồng [Bun Workers](https://bun.sh/docs/runtime/workers) gốc mà không chặn event loop chính của `Bun.serve()`.

`@bunest/jobs/workers` được xây dựng hoàn toàn trên Web Worker globals của Bun (`new Worker(...)`, `postMessage`, `Bun.isMainThread`, `smol`, `preload`, `ref`/`unref`, `File` `blob:` URLs) với **0 phụ thuộc runtime ngoài** và **0 import `node:worker_threads`** (`ADR-017`, `ADR-019`).

---

## 1. Bắt đầu nhanh (`defineWorker` + `WorkerModule`)

### Định nghĩa script worker

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

> **An toàn khởi động trên Bun:** `defineWorker()` và `bootstrapWorkerApplication()` luôn gắn `self.onmessage` đồng bộ trước bất kỳ lệnh `await` nào, đệm các thông điệp đến sớm cho tới khi `INIT` / `onInit()` hoàn tất để không làm rơi bất kỳ thông điệp khởi động nào.

### Đăng ký pool và inject

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

## 2. Service AOP khai báo (`@Offload`)

Chuyển tiếp trong suốt bất kỳ phương thức `@Injectable()` nào sang một `WorkerPool` đã đăng ký bằng trình dệt Service-Layer AOP biên dịch một lần của Bunest (`ADR-014`):

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

## 3. Worker tích hợp DI (`bootstrapWorkerApplication`)

Khi một worker cần dùng `@Injectable()` services, `ConfigService` hoặc kết nối cơ sở dữ liệu ngay trong luồng riêng mà không mở HTTP server:

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

Với các phép tính tự chứa không cần tạo tệp riêng, Bunest tạo một `File` trong bộ nhớ kèm `blob:` URL và tự động thu hồi khi gọi `pool.close()`:

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

Chạy các tác vụ hàng đợi nền tách khỏi event loop chính bằng cách truyền `workerFile` cho `@Processor()`:

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

## 6. Giám sát, Lan truyền Ngữ cảnh & Health

- **CLS & W3C `traceparent`:** `WorkerPool.run()` tự động chụp các khóa CLS hiện hành (`requestId`, `tenantId`, `userId`, `correlationId`) cùng `traceparent` W3C đang hoạt động và khôi phục CLS bên trong luồng worker.
- **Auto-Tracing:** `OtelAutoInstrumentation` của `@bunest/observability` tự động đăng ký kênh `bunest:workers:dispatch` và phát ra các span `workers.run <pool>/<task>`.
- **Kiểm tra Readiness Health:** Dùng `WorkerPoolHealthIndicator` từ `@bunest/observability/health` với `WorkerPool` hoặc `WorkerPoolRegistry`.

---

## 7. CLI Scaffolding, Đóng gói & Binary Độc lập

- Sinh cặp tệp worker + test:
  ```bash
  bunest generate worker crypto
  # viết tắt: bunest g w crypto
  ```
- `bunest build` và `bunest build --compile` tự động phát hiện `**/*.worker.{ts,js,mts,mjs}` trong `sourceRoot` (hoặc `--worker <path>` / `compilerOptions.workers`) và nhúng chúng làm entrypoint.

---

## 8. Mở rộng HTTP đa luồng (`reusePort` + `BunestWorkerCluster`)

Trên Linux, nhiều luồng Bun Worker có thể chia sẻ cùng một cổng lắng nghe qua `SO_REUSEPORT`:

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

> **Lưu ý nền tảng:** Cân bằng tải kernel `SO_REUSEPORT` được khuyến nghị trên **Linux**. Trên macOS/Windows, việc phân phối kết nối giữa các luồng có thể không đồng đều.
