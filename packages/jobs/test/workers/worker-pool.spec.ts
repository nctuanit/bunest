import { describe, expect, it } from "bun:test";
import {
  BadRequestException,
  ClsService,
  DomainException,
  HttpException,
  Injectable,
  Module,
  diagnosticsChannel,
  registerAmbientTraceparentProvider,
} from "@bunest/core";
import { Test } from "@bunest/testing";
import {
  InjectQueue,
  MemoryQueueDriver,
  Processor,
  Queue,
  QueueModule,
} from "../../src/queues";
import {
  InProcessWorkerPool,
  InjectWorkerPool,
  Offload,
  WORKERS_DISPATCH_CHANNEL,
  WORKERS_LIFECYCLE_CHANNEL,
  WorkerAbortedException,
  WorkerModule,
  WorkerPool,
  WorkerPoolRegistry,
  WorkerPoolSaturatedException,
  WorkerSpawnException,
  WorkerTaskNotFoundException,
  WorkerTerminatedException,
  WorkerTimeoutException,
  WorkerValidationException,
  createInlineWorkerPool,
  createWorkerCluster,
  defineWorkerContract,
  isMainThread,
  isWorkerThread,
  transferable,
  type WorkerDispatchDiagnosticEvent,
  type WorkerLifecycleDiagnosticEvent,
} from "../../src/workers";
import { DiMultiplyContract } from "./fixtures/di.worker";

const BASIC_WORKER_URL = new URL("./fixtures/basic.worker.ts", import.meta.url);
const DI_WORKER_URL = new URL("./fixtures/di.worker.ts", import.meta.url);
const PRELOAD_PATH = new URL("./fixtures/preload.ts", import.meta.url).pathname;
const CLUSTER_WORKER_URL = new URL(
  "./fixtures/cluster-server.worker.ts",
  import.meta.url,
);

describe("@bunest/jobs/workers — Bun Runtime Workers", () => {
  it("detects main vs worker thread and passes Bun WorkerOptions (smol, preload, env, argv, initData)", async () => {
    expect(isMainThread()).toBe(true);
    expect(isWorkerThread()).toBe(false);

    const pool = new WorkerPool({
      name: "opts-pool",
      script: BASIC_WORKER_URL,
      maxThreads: 1,
      smol: true,
      preload: PRELOAD_PATH,
      env: { BUNEST_WORKER_TEST_ENV: "bun-workers-ok" },
      argv: ["--worker-flag", "42"],
      initData: { region: "ap-southeast-1" },
    });

    try {
      const info = await pool.run<undefined, Record<string, unknown>>(
        "threadInfo",
        undefined,
      );
      expect(info.isMainThread).toBe(false);
      expect(info.isWorkerThread).toBe(true);
      expect(info.initializedFlag).toBe(true);
      expect(info.preloaded).toBe(true);
      expect(info.envMarker).toBe("bun-workers-ok");
      expect(info.argvTail).toEqual(["--worker-flag", "42"]);
      expect(info.initData).toEqual({ region: "ap-southeast-1" });
      expect(String(info.workerId)).toContain("opts-pool-w1");
    } finally {
      await pool.close();
    }
  });

  it("buffers startup bursts with zero dropped messages despite async onInit", async () => {
    const pool = new WorkerPool({
      name: "burst-pool",
      script: BASIC_WORKER_URL,
      maxThreads: 2,
    });

    try {
      const count = 40;
      const results = await Promise.all(
        Array.from({ length: count }, (_, i) =>
          pool.run<{ a: number; b: number }, number>("add", { a: i, b: 100 }),
        ),
      );
      expect(results).toEqual(Array.from({ length: count }, (_, i) => i + 100));
      expect(pool.getStats().completedTasks).toBe(count);
    } finally {
      await pool.close();
    }
  });

  it("supports typed WorkerContract + StandardSchema input/output validation", async () => {
    const AddContract = defineWorkerContract<
      { readonly a: number; readonly b: number },
      number
    >("add", {
      inputSchema: {
        "~standard": {
          version: 1,
          vendor: "test",
          validate(value) {
            if (
              typeof value === "object" &&
              value !== null &&
              typeof (value as { a?: unknown }).a === "number" &&
              typeof (value as { b?: unknown }).b === "number"
            ) {
              return { value: value as { a: number; b: number } };
            }
            return {
              issues: [{ message: "Expected numeric a and b", path: ["a"] }],
            };
          },
        },
      },
    });

    const pool = new WorkerPool({
      name: "contract-pool",
      script: BASIC_WORKER_URL,
      maxThreads: 1,
    });

    try {
      const sum = await pool.run(AddContract, { a: 7, b: 35 });
      expect(sum).toBe(42);

      await expect(
        pool.run(AddContract, { a: "bad" as unknown as number, b: 1 }),
      ).rejects.toThrow(WorkerValidationException);
    } finally {
      await pool.close();
    }
  });

  it("supports zero-copy Transferable payloads and outputs", async () => {
    const pool = new WorkerPool({
      name: "transfer-pool",
      script: BASIC_WORKER_URL,
      maxThreads: 1,
    });

    try {
      const input = new Uint8Array([0x00, 0x0f, 0xf0, 0xaa]);
      const originalBuffer = input.buffer;
      const result = await pool.run<Uint8Array, Uint8Array>(
        "transferBuffer",
        transferable(input, [originalBuffer]) as unknown as Uint8Array,
      );

      // Buffer ownership was transferred out of the sender thread
      expect(originalBuffer.byteLength).toBe(0);
      expect(Array.from(result)).toEqual([0xff, 0xf0, 0x0f, 0x55]);
    } finally {
      await pool.close();
    }
  });

  it("streams progress callbacks and preserves HttpException, DomainException, TypeError, and WorkerTaskNotFoundException", async () => {
    const pool = new WorkerPool({
      name: "errors-pool",
      script: BASIC_WORKER_URL,
      maxThreads: 1,
    });

    try {
      const progressEvents: number[] = [];
      const done = await pool.run<number, { done: number }>("progress", 4, {
        onProgress: (p) => progressEvents.push(Number(p)),
      });
      expect(done).toEqual({ done: 4 });
      expect(progressEvents).toEqual([25, 50, 75, 100]);

      try {
        await pool.run("throwHttp", undefined);
        expect.unreachable("should have thrown HttpException");
      } catch (err) {
        expect(err).toBeInstanceOf(HttpException);
        expect((err as HttpException).getStatus()).toBe(400);
        expect((err as HttpException).message).toContain("Invalid worker input");
      }

      try {
        await pool.run("throwDomain", undefined);
        expect.unreachable("should have thrown DomainException");
      } catch (err) {
        expect(err).toBeInstanceOf(DomainException);
        expect((err as DomainException).code).toBe("QUOTA_EXCEEDED");
        expect((err as DomainException).kind).toBe("rate_limited");
        expect((err as DomainException).details).toEqual({ limit: 10 });
      }

      try {
        await pool.run("throwTypeError", undefined);
        expect.unreachable("should have thrown TypeError");
      } catch (err) {
        expect(err).toBeInstanceOf(TypeError);
        expect((err as TypeError).message).toBe("Bad type in worker");
      }

      try {
        await pool.run("nonExistentTask", undefined);
        expect.unreachable("should throw WorkerTaskNotFoundException");
      } catch (err) {
        expect(err).toBeInstanceOf(WorkerTaskNotFoundException);
        expect((err as WorkerTaskNotFoundException).code).toBe("BUNEST_E205");
      }
    } finally {
      await pool.close();
    }
  });

  it("recovers from hung CPU timeouts (infinite loop) and worker crashes cleanly", async () => {
    const pool = new WorkerPool({
      name: "recovery-pool",
      script: BASIC_WORKER_URL,
      maxThreads: 1,
      terminateOnTimeout: true,
    });

    try {
      await expect(
        pool.run("infiniteLoop", undefined, { timeoutMs: 80 }),
      ).rejects.toThrow(WorkerTimeoutException);

      // Pool automatically replaces terminated worker and handles subsequent tasks
      const recovered = await pool.run<{ a: number; b: number }, number>(
        "add",
        { a: 10, b: 20 },
      );
      expect(recovered).toBe(30);

      // Simulate worker process.exit(42) crash
      await expect(pool.run("crashWorker", undefined)).rejects.toThrow(
        WorkerTerminatedException,
      );
      expect(pool.getStats().workersCrashed).toBeGreaterThanOrEqual(1);

      // Pool recovers again on next dispatch
      const afterCrash = await pool.run<{ a: number; b: number }, number>(
        "add",
        { a: 2, b: 3 },
      );
      expect(afterCrash).toBe(5);
    } finally {
      await pool.close();
    }
  });

  it("enforces bounded queue backpressure, priority ordering, AbortSignal, recycling, and broadcast", async () => {
    const pool = new WorkerPool({
      name: "policy-pool",
      script: BASIC_WORKER_URL,
      maxThreads: 1,
      maxQueueSize: 2,
      maxTasksPerWorker: 4,
    });

    try {
      await pool.warmUp(1);
      expect(pool.broadcast("cache:clear", { key: "users" })).toBe(1);
      const seen = await pool.run<
        undefined,
        Array<{ event: string; payload: unknown }>
      >("getBroadcasts", undefined);
      expect(seen).toEqual([{ event: "cache:clear", payload: { key: "users" } }]);

      // Backpressure test: 1 active + 2 queued = ok, 4th rejects with BUNEST_E203
      const p1 = pool.run("slowCooperative", 80);
      const ac = new AbortController();
      const p2 = pool.run("add", { a: 1, b: 1 }, { priority: 1, signal: ac.signal });
      const p3 = pool.run("add", { a: 2, b: 2 }, { priority: 10 });
      await expect(pool.run("add", { a: 3, b: 3 })).rejects.toThrow(
        WorkerPoolSaturatedException,
      );

      // Cancel queued p2 before it runs
      ac.abort("user-cancelled");
      await expect(p2).rejects.toThrow(WorkerAbortedException);
      expect(await p3).toBe(4);
      await p1;

      // Trigger maxTasksPerWorker recycling
      await pool.map(
        [
          { a: 1, b: 1 },
          { a: 2, b: 2 },
          { a: 3, b: 3 },
          { a: 4, b: 4 },
        ],
        "add",
      );
      expect(pool.getStats().workersRecycled).toBeGreaterThanOrEqual(1);
    } finally {
      await pool.close();
    }
  });

  it("propagates CLS + W3C traceparent and publishes diagnosticsChannel telemetry", async () => {
    const cls = new ClsService({ generateId: false });
    const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    const disposeTrace = registerAmbientTraceparentProvider(() => traceparent);

    const dispatchEvents: WorkerDispatchDiagnosticEvent[] = [];
    const lifecycleEvents: WorkerLifecycleDiagnosticEvent[] = [];
    const dCh = diagnosticsChannel(WORKERS_DISPATCH_CHANNEL);
    const lCh = diagnosticsChannel(WORKERS_LIFECYCLE_CHANNEL);
    const dListener = (msg: unknown) =>
      dispatchEvents.push(msg as WorkerDispatchDiagnosticEvent);
    const lListener = (msg: unknown) =>
      lifecycleEvents.push(msg as WorkerLifecycleDiagnosticEvent);
    dCh.subscribe(dListener);
    lCh.subscribe(lListener);

    const pool = new WorkerPool({
      name: "cls-pool",
      script: BASIC_WORKER_URL,
      maxThreads: 1,
      clsService: cls,
    });

    try {
      const result = await cls.run(
        () => pool.run<undefined, Record<string, unknown>>("clsCheck", undefined),
        { requestId: "req-999", tenantId: "acme" },
      );

      expect(result.requestId).toBe("req-999");
      expect(result.tenantId).toBe("acme");
      expect(result.traceparent).toBe(traceparent);

      expect(
        dispatchEvents.some(
          (e) =>
            e.phase === "end" &&
            e.pool === "cls-pool" &&
            e.task === "clsCheck" &&
            e.traceparent === traceparent &&
            e.status === "completed",
        ),
      ).toBe(true);
      expect(lifecycleEvents.some((e) => e.event === "ready")).toBe(true);
    } finally {
      dCh.unsubscribe(dListener);
      lCh.unsubscribe(lListener);
      disposeTrace();
      await pool.close();
    }
  });

  it("runs inline Blob workers via createInlineWorkerPool and revokes URL on close", async () => {
    const pool = createInlineWorkerPool(
      (n: number, ctx) => {
        ctx.reportProgress(100);
        let acc = 0;
        for (let i = 1; i <= n; i++) acc += i;
        return acc + Number((ctx.initData as { offset?: number })?.offset ?? 0);
      },
      { name: "inline-sum", maxThreads: 2, smol: true, initData: { offset: 5 } },
    );

    try {
      const progress: unknown[] = [];
      const sum = await pool.run<number, number>("default", 100, {
        onProgress: (p) => progress.push(p),
      });
      expect(sum).toBe(5055);
      expect(progress).toEqual([100]);
    } finally {
      await pool.close();
    }
  });

  it("supports DI-enabled workers via bootstrapWorkerApplication + @WorkerHandler", async () => {
    const pool = new WorkerPool({
      name: "di-pool",
      script: DI_WORKER_URL,
      maxThreads: 1,
    });

    try {
      const out = await pool.run(DiMultiplyContract, { x: 6, y: 7 });
      expect(out.product).toBe(42);
      expect(out.workerId).toContain("di-pool-w1");

      const ping = await pool.run<string, string>("ping-di", "bunest");
      expect(ping).toBe("di:bunest");
    } finally {
      await pool.close();
    }
  });

  it("integrates WorkerModule, @InjectWorkerPool, @Offload AOP, and graceful shutdown", async () => {
    @Injectable()
    class MathService {
      constructor(
        @InjectWorkerPool("math") private readonly pool: WorkerPool,
      ) {}

      async directAdd(a: number, b: number): Promise<number> {
        return this.pool.run("add", { a, b });
      }

      @Offload({ pool: "math", task: "add", timeoutMs: 5_000 })
      async offloadedAdd(_input: { a: number; b: number }): Promise<number> {
        throw new Error("Should have executed on worker thread");
      }

      @Offload({ pool: "missing-pool", fallbackToLocal: true })
      async localFallback(x: number): Promise<number> {
        return x * 10;
      }
    }

    @Module({
      imports: [
        WorkerModule.forRoot({
          defaultPoolOptions: { maxThreads: 1, smol: true },
        }),
        WorkerModule.registerPool({
          name: "math",
          script: BASIC_WORKER_URL,
          warmUp: true,
          minThreads: 1,
        }),
      ],
      providers: [MathService],
    })
    class TestWorkerAppModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [TestWorkerAppModule],
    }).compile();
    await moduleRef.init();

    const math = moduleRef.get(MathService);
    const registry = moduleRef.get(WorkerPoolRegistry);
    expect(registry.get("math")?.getStats().totalWorkers).toBe(1);

    expect(await math.directAdd(12, 30)).toBe(42);
    expect(await math.offloadedAdd({ a: 20, b: 22 })).toBe(42);
    expect(await math.localFallback(7)).toBe(70);

    await moduleRef.close();
    expect(registry.get("math")).toBeUndefined();
  });

  it("integrates sandboxed @Processor({ workerFile }) with QueueModule", async () => {
    @Processor({
      name: "sandboxed-jobs",
      concurrency: 2,
      workerFile: BASIC_WORKER_URL,
      workerPool: { maxThreads: 2, smol: true },
    })
    class SandboxedJobProcessor {}

    @Injectable()
    class ProducerService {
      constructor(
        @InjectQueue("sandboxed-jobs")
        readonly queue: Queue<{ n: number }, { doubled: number }>,
      ) {}
    }

    @Module({
      imports: [
        QueueModule.forRoot({ driver: new MemoryQueueDriver() }),
        QueueModule.registerQueue({ name: "sandboxed-jobs", concurrency: 2 }),
      ],
      providers: [SandboxedJobProcessor, ProducerService],
    })
    class SandboxedQueueAppModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [SandboxedQueueAppModule],
    }).compile();
    await moduleRef.init();

    try {
      const producer = moduleRef.get(ProducerService);
      const completed = new Promise<{ doubled: number }>((resolve, reject) => {
        producer.queue.on("completed", (_job, result) =>
          resolve(result as { doubled: number }),
        );
        producer.queue.on("failed", (_job, err) => reject(err));
      });

      await producer.queue.add("heavy-compute", { n: 21 });
      expect(await completed).toEqual({ doubled: 42 });
    } finally {
      await moduleRef.close();
    }
  });

  it("supports InProcessWorkerPool for fast unit tests without spawning threads", async () => {
    const pool = new InProcessWorkerPool({
      double: async (n: number, ctx) => {
        ctx.reportProgress(100);
        return n * 2;
      },
    });
    const seen: unknown[] = [];
    expect(
      await pool.run<number, number>("double", 21, {
        onProgress: (p) => seen.push(p),
      }),
    ).toBe(42);
    expect(seen).toEqual([100]);
    expect(pool.getHealthSnapshot().healthy).toBe(true);
    await pool.close();
    expect(pool.getHealthSnapshot().healthy).toBe(false);
  });

  it("fails fast with WorkerSpawnException (BUNEST_E201) for non-existent worker script", async () => {
    const pool = new WorkerPool({
      name: "bad-script",
      script: new URL("./fixtures/does-not-exist.worker.ts", import.meta.url),
      maxThreads: 1,
      maxConsecutiveCrashes: 1,
      startupTimeoutMs: 1_000,
    });

    try {
      await expect(pool.run("add", { a: 1, b: 2 })).rejects.toThrow(
        WorkerSpawnException,
      );
    } finally {
      await pool.close({ force: true });
    }
  });

  it("starts and gracefully stops BunestWorkerCluster", async () => {
    const ready: number[] = [];
    const exited: number[] = [];
    const cluster = createWorkerCluster({
      script: CLUSTER_WORKER_URL,
      workers: 2,
      restartOnCrash: false,
      ref: false,
      onWorkerReady: (idx) => ready.push(idx),
      onWorkerExit: (idx) => exited.push(idx),
    });

    cluster.start();
    // Wait briefly for both cluster workers to open
    const deadline = Date.now() + 2_000;
    while (ready.length < 2 && Date.now() < deadline) {
      await Bun.sleep(15);
    }
    expect(cluster.getStatus().running).toBe(true);
    expect(cluster.getStatus().liveWorkers).toBe(2);

    await cluster.stop();
    expect(cluster.getStatus().running).toBe(false);
    expect(cluster.getStatus().liveWorkers).toBe(0);
    expect(exited.length).toBeGreaterThanOrEqual(2);
  });

  it("does not hang process exit when unrefWhenIdle is enabled", async () => {
    const script = `
      import { createInlineWorkerPool } from "${new URL("../../src/workers/index.ts", import.meta.url).pathname}";
      const pool = createInlineWorkerPool((n: number) => n + 1, { maxThreads: 1, unrefWhenIdle: true });
      const res = await pool.run("default", 41);
      if (res !== 42) process.exit(2);
      // Intentionally do NOT call pool.close() — unrefWhenIdle must allow clean exit!
    `;
    const proc = Bun.spawn([process.execPath, "-e", script], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exited = await Promise.race([
      proc.exited,
      Bun.sleep(5_000).then(() => {
        proc.kill();
        return -1;
      }),
    ]);
    expect(exited).toBe(0);
  });

  it("survives repeated spawn/recycle/close cycles without errors", async () => {
    for (let round = 0; round < 3; round++) {
      const pool = new WorkerPool({
        name: `cycle-${round}`,
        script: BASIC_WORKER_URL,
        maxThreads: 2,
        maxTasksPerWorker: 2,
      });
      const out = await pool.map(
        [
          { a: 1, b: round },
          { a: 2, b: round },
          { a: 3, b: round },
          { a: 4, b: round },
        ],
        "add",
      );
      expect(out).toEqual([1 + round, 2 + round, 3 + round, 4 + round]);
      await pool.close();
      expect(pool.isClosed).toBe(true);
    }
  });
});
