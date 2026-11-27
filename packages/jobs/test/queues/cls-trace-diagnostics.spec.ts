import { afterEach, describe, expect, it } from "bun:test";
import {
  BunestFactory,
  ClsModule,
  ClsService,
  Module,
  diagnosticsChannel,
  registerAmbientTraceparentProvider,
} from "@bunest/core";
import {
  JOBS_ENQUEUE_CHANNEL,
  JOBS_PROCESS_CHANNEL,
  JOB_CLS_METADATA_KEY,
  MemoryQueueDriver,
  Process,
  Processor,
  Queue,
  QueueModule,
  RedisQueueDriver,
  getQueueToken,
  type Job,
  type JobEnqueueDiagnosticEvent,
  type JobProcessDiagnosticEvent,
  type RedisQueueClientLike,
} from "../../src";

class SimpleRedisMock implements RedisQueueClientLike {
  private readonly hashes = new Map<string, Map<string, string>>();
  private readonly zsets = new Map<string, Map<string, number>>();
  private readonly sets = new Map<string, Set<string>>();
  private readonly lists = new Map<string, string[]>();
  private readonly strings = new Map<string, string>();

  async hset(key: string, field: string, value: string): Promise<number> {
    let m = this.hashes.get(key);
    if (!m) {
      m = new Map();
      this.hashes.set(key, m);
    }
    const isNew = !m.has(field);
    m.set(field, value);
    return isNew ? 1 : 0;
  }
  async hget(key: string, field: string): Promise<string | null> {
    return this.hashes.get(key)?.get(field) ?? null;
  }
  async hdel(key: string, ...fields: string[]): Promise<number> {
    const m = this.hashes.get(key);
    if (!m) return 0;
    let c = 0;
    for (const f of fields) if (m.delete(f)) c++;
    return c;
  }
  async zadd(key: string, score: number, member: string): Promise<number> {
    let z = this.zsets.get(key);
    if (!z) {
      z = new Map();
      this.zsets.set(key, z);
    }
    const isNew = !z.has(member);
    z.set(member, score);
    return isNew ? 1 : 0;
  }
  async zrange(key: string, start: number, stop: number): Promise<string[]> {
    const z = this.zsets.get(key);
    if (!z) return [];
    const sorted = [...z.entries()].sort((a, b) => a[1] - b[1]);
    const end = stop < 0 ? sorted.length + stop + 1 : stop + 1;
    return sorted.slice(start, end).map(([m]) => m);
  }
  async zrangebyscore(
    key: string,
    min: number | string,
    max: number | string,
  ): Promise<string[]> {
    const z = this.zsets.get(key);
    if (!z) return [];
    const minV = min === "-inf" ? -Infinity : Number(min);
    const maxV = max === "+inf" ? Infinity : Number(max);
    return [...z.entries()]
      .filter(([, s]) => s >= minV && s <= maxV)
      .sort((a, b) => a[1] - b[1])
      .map(([m]) => m);
  }
  async zrem(key: string, ...members: string[]): Promise<number> {
    const z = this.zsets.get(key);
    if (!z) return 0;
    let c = 0;
    for (const m of members) if (z.delete(m)) c++;
    return c;
  }
  async zcard(key: string): Promise<number> {
    return this.zsets.get(key)?.size ?? 0;
  }
  async sadd(key: string, ...members: string[]): Promise<number> {
    let s = this.sets.get(key);
    if (!s) {
      s = new Set();
      this.sets.set(key, s);
    }
    let c = 0;
    for (const m of members) {
      if (!s.has(m)) {
        s.add(m);
        c++;
      }
    }
    return c;
  }
  async srem(key: string, ...members: string[]): Promise<number> {
    const s = this.sets.get(key);
    if (!s) return 0;
    let c = 0;
    for (const m of members) if (s.delete(m)) c++;
    return c;
  }
  async scard(key: string): Promise<number> {
    return this.sets.get(key)?.size ?? 0;
  }
  async rpush(key: string, ...values: string[]): Promise<number> {
    let l = this.lists.get(key);
    if (!l) {
      l = [];
      this.lists.set(key, l);
    }
    l.push(...values);
    return l.length;
  }
  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const l = this.lists.get(key) ?? [];
    const end = stop < 0 ? l.length + stop + 1 : stop + 1;
    return l.slice(start, end);
  }
  async lrem(key: string, count: number, value: string): Promise<number> {
    const l = this.lists.get(key);
    if (!l) return 0;
    let c = 0;
    for (let i = 0; i < l.length;) {
      if (l[i] === value && (count === 0 || c < Math.abs(count))) {
        l.splice(i, 1);
        c++;
      } else {
        i++;
      }
    }
    return c;
  }
  async llen(key: string): Promise<number> {
    return this.lists.get(key)?.length ?? 0;
  }
  async incr(key: string): Promise<number> {
    const n = Number(this.strings.get(key) ?? 0) + 1;
    this.strings.set(key, String(n));
    return n;
  }
  async get(key: string): Promise<string | null> {
    return this.strings.get(key) ?? null;
  }
}

async function waitUntil(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
}

describe("Cross-Transport CLS Context, W3C traceparent Propagation & diagnosticsChannel Emission", () => {
  const disposers: Array<() => void> = [];
  const queues: Queue<any, any>[] = [];

  afterEach(async () => {
    while (disposers.length > 0) {
      disposers.pop()!();
    }
    while (queues.length > 0) {
      await queues.pop()!.close();
    }
  });

  it("propagates CLS keys + ambient W3C traceparent through QueueModule & @Processor while preserving user metadata", async () => {
    const activeTraceparent =
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    disposers.push(registerAmbientTraceparentProvider(() => activeTraceparent));

    const processedSnapshots: Array<{
      jobName: string;
      tenantId?: string;
      requestId?: string;
      userId?: string;
      correlationId?: string;
      traceparent?: string;
      clsId?: string;
      userMeta?: Record<string, unknown>;
    }> = [];

    @Processor("invoices")
    class InvoiceProcessor {
      constructor(private readonly cls: ClsService) {}

      @Process("generate")
      async generate(job: Job<{ amount: number }>) {
        await Bun.sleep(5);
        processedSnapshots.push({
          jobName: job.name,
          tenantId: this.cls.get<string>("tenantId"),
          requestId: this.cls.get<string>("requestId"),
          userId: this.cls.get<string>("userId"),
          correlationId: this.cls.get<string>("correlationId"),
          traceparent: this.cls.get<string>("traceparent"),
          clsId: this.cls.getId(),
          userMeta: job.metadata,
        });
      }
    }

    @Module({
      imports: [
        ClsModule.forRoot({ global: true }),
        QueueModule.forRoot(),
        QueueModule.registerQueue({ name: "invoices", concurrency: 2 }),
      ],
      providers: [InvoiceProcessor],
    })
    class AppModule {}

    const app = await BunestFactory.createApplicationContext(AppModule);
    try {
      const cls = app.get(ClsService);
      const queue = app.get<Queue<{ amount: number }>>(
        getQueueToken("invoices"),
      );

      // Enqueue delayed job inside CLS context so worker runs outside caller's synchronous stack
      let acmeOuterClsId: string | undefined;
      const added = await cls.run(
        async () => {
          acmeOuterClsId = cls.getId();
          return queue.add(
            "generate",
            { amount: 99 },
            {
              delayMs: 15,
              tenantId: "acme-corp",
              metadata: { source: "checkout-api", retries: 0 },
            },
          );
        },
        {
          requestId: "req-101",
          tenantId: "acme-corp",
          userId: "usr-77",
          correlationId: "corr-xyz",
        },
      );

      // Stored metadata preserves user fields + traceparent + CLS carrier
      expect(added.metadata?.source).toBe("checkout-api");
      expect(added.metadata?.retries).toBe(0);
      expect(added.metadata?.traceparent).toBe(activeTraceparent);
      expect(added.metadata?.[JOB_CLS_METADATA_KEY]).toBeDefined();

      // Enqueue bulk jobs from a different tenant context & explicit custom traceparent
      const explicitTp =
        "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";
      await cls.run(
        async () =>
          queue.addBulk([
            {
              name: "generate",
              data: { amount: 250 },
              options: {
                delayMs: 15,
                metadata: { traceparent: explicitTp, batch: true },
              },
            },
          ]),
        {
          requestId: "req-202",
          tenantId: "globex",
          userId: "usr-88",
        },
      );

      await waitUntil(() => processedSnapshots.length === 2);

      const acme = processedSnapshots.find((s) => s.tenantId === "acme-corp")!;
      expect(acme).toBeDefined();
      expect(acme.requestId).toBe("req-101");
      expect(acme.clsId).toBe(acmeOuterClsId);
      expect(acme.userId).toBe("usr-77");
      expect(acme.correlationId).toBe("corr-xyz");
      expect(acme.traceparent).toBe(activeTraceparent);
      expect(acme.userMeta?.source).toBe("checkout-api");

      const globex = processedSnapshots.find((s) => s.tenantId === "globex")!;
      expect(globex).toBeDefined();
      expect(globex.requestId).toBe("req-202");
      expect(globex.userId).toBe("usr-88");
      // Explicit user-supplied metadata.traceparent is preserved over ambient provider
      expect(globex.traceparent).toBe(explicitTp);
      expect(globex.userMeta?.batch).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("round-trips CLS + traceparent through JSON serialization in RedisQueueDriver", async () => {
    const traceparent =
      "00-11111111111111111111111111111111-2222222222222222-01";
    disposers.push(registerAmbientTraceparentProvider(() => traceparent));

    const cls = new ClsService();
    const driver = new RedisQueueDriver(new SimpleRedisMock(), {
      prefix: "clsredis",
      stalledIntervalMs: 0,
    });
    const queue = new Queue<{ ok: boolean }>({
      name: "redis-cls",
      driver,
      clsService: cls,
      pollIntervalMs: 10,
    });
    queues.push(queue);

    await cls.run(
      async () => {
        await queue.add("sync", { ok: true }, { groupId: "tenant-redis" });
      },
      { tenantId: "tenant-redis", requestId: "req-redis-9" },
    );

    let captured: {
      tenantId?: string;
      requestId?: string;
      traceparent?: string;
    } | null = null;

    queue.process(async () => {
      captured = {
        tenantId: cls.get<string>("tenantId"),
        requestId: cls.get<string>("requestId"),
        traceparent: cls.get<string>("traceparent"),
      };
    });

    await waitUntil(() => captured !== null);
    expect(captured!).toEqual({
      tenantId: "tenant-redis",
      requestId: "req-redis-9",
      traceparent,
    });
  });

  it("emits bunest:jobs:enqueue and bunest:jobs:process diagnosticsChannel events for success, retry, and failure", async () => {
    const traceparent =
      "00-99999999999999999999999999999999-8888888888888888-01";
    disposers.push(registerAmbientTraceparentProvider(() => traceparent));

    const enqueueEvents: JobEnqueueDiagnosticEvent[] = [];
    const processEvents: JobProcessDiagnosticEvent[] = [];

    const onEnqueue = (msg: unknown) => {
      enqueueEvents.push(msg as JobEnqueueDiagnosticEvent);
    };
    const onProcess = (msg: unknown) => {
      processEvents.push(msg as JobProcessDiagnosticEvent);
    };
    const throwingSubscriber = () => {
      throw new Error("observer bug must never crash queue");
    };

    const enqueueCh = diagnosticsChannel(JOBS_ENQUEUE_CHANNEL);
    const processCh = diagnosticsChannel(JOBS_PROCESS_CHANNEL);
    enqueueCh.subscribe(onEnqueue);
    enqueueCh.subscribe(throwingSubscriber);
    processCh.subscribe(onProcess);
    processCh.subscribe(throwingSubscriber);
    disposers.push(() => {
      enqueueCh.unsubscribe(onEnqueue);
      enqueueCh.unsubscribe(throwingSubscriber);
      processCh.unsubscribe(onProcess);
      processCh.unsubscribe(throwingSubscriber);
    });

    const queue = new Queue<{ failTimes: number }>({
      name: "diag-queue",
      driver: new MemoryQueueDriver(),
    });
    queues.push(queue);

    let seenAttempts = 0;
    let completed = 0;
    let deadLettered = 0;

    queue.on("completed", () => {
      completed++;
    });
    queue.on("dead-letter", () => {
      deadLettered++;
    });

    const okJob = await queue.add(
      "send-email",
      { failTimes: 0 },
      { groupId: "tenant-1", priority: 5 },
    );
    const flakyJob = await queue.add(
      "flaky-job",
      { failTimes: 1 },
      { groupId: "tenant-2", attempts: 2, backoff: { type: "fixed", delayMs: 10 } },
    );
    const fatalJob = await queue.add(
      "fatal-job",
      { failTimes: 99 },
      { groupId: "tenant-3", attempts: 1 },
    );

    queue.process(async (job) => {
      if (job.name === "flaky-job") {
        seenAttempts++;
        if (seenAttempts <= job.data.failTimes) {
          throw new Error("transient glitch");
        }
        return "recovered";
      }
      if (job.name === "fatal-job") {
        throw new Error("permanent failure");
      }
      return "sent";
    });

    await waitUntil(() => completed === 2 && deadLettered === 1);

    // Enqueue events
    expect(enqueueEvents).toHaveLength(3);
    expect(enqueueEvents[0]).toMatchObject({
      queue: "diag-queue",
      jobId: okJob.id,
      jobName: "send-email",
      groupId: "tenant-1",
      traceparent,
      status: "waiting",
      priority: 5,
    });

    // Process events for successful job: start -> end
    const okEvents = processEvents.filter((e) => e.jobId === okJob.id);
    expect(okEvents).toHaveLength(2);
    expect(okEvents[0]).toMatchObject({
      phase: "start",
      queue: "diag-queue",
      jobId: okJob.id,
      jobName: "send-email",
      groupId: "tenant-1",
      traceparent,
      status: "active",
    });
    expect(okEvents[1]).toMatchObject({
      phase: "end",
      queue: "diag-queue",
      jobId: okJob.id,
      jobName: "send-email",
      groupId: "tenant-1",
      traceparent,
      status: "completed",
    });
    expect(typeof okEvents[1]!.durationMs).toBe("number");
    expect(okEvents[1]!.durationMs!).toBeGreaterThanOrEqual(0);

    // Process events for flaky job: attempt 1 start -> error (delayed), attempt 2 start -> end (completed)
    const flakyEvents = processEvents.filter((e) => e.jobId === flakyJob.id);
    expect(flakyEvents.map((e) => e.phase)).toEqual([
      "start",
      "error",
      "start",
      "end",
    ]);
    expect(flakyEvents[1]!.status).toBe("delayed");
    expect((flakyEvents[1]!.error as Error).message).toBe("transient glitch");
    expect(flakyEvents[3]!.status).toBe("completed");

    // Process events for permanently failing job: start -> error (dead-letter)
    const fatalEvents = processEvents.filter((e) => e.jobId === fatalJob.id);
    expect(fatalEvents.map((e) => e.phase)).toEqual(["start", "error"]);
    expect(fatalEvents[1]!.status).toBe("dead-letter");
    expect((fatalEvents[1]!.error as Error).message).toBe("permanent failure");
    expect(fatalEvents[1]!.traceparent).toBe(traceparent);
  });
});
