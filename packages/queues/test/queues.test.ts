import "reflect-metadata";
import { afterEach, describe, expect, it } from "bun:test";
import { Injectable } from "@bunest/common";
import { Test } from "@bunest/testing";
import {
  InjectQueue,
  JobTimeoutError,
  MemoryQueueDriver,
  OnQueueEvent,
  Process,
  Processor,
  Queue,
  QueueModule,
  RedisQueueDriver,
  calculateBackoffDelay,
  type Job,
  type RedisQueueClientLike,
} from "../src/index";

/**
 * Faithful in-memory mock implementing `RedisQueueClientLike` for testing `RedisQueueDriver`.
 */
class MockRedisQueueClient implements RedisQueueClientLike {
  private readonly hashes = new Map<string, Map<string, string>>();
  private readonly zsets = new Map<string, Map<string, number>>();
  private readonly sets = new Map<string, Set<string>>();
  private readonly lists = new Map<string, string[]>();
  private readonly strings = new Map<string, string>();
  public quitCalled = false;

  async hset(key: string, field: string, value: string): Promise<number> {
    let map = this.hashes.get(key);
    if (!map) {
      map = new Map();
      this.hashes.set(key, map);
    }
    const isNew = !map.has(field);
    map.set(field, value);
    return isNew ? 1 : 0;
  }

  async hget(key: string, field: string): Promise<string | null> {
    return this.hashes.get(key)?.get(field) ?? null;
  }

  async hdel(key: string, ...fields: string[]): Promise<number> {
    const map = this.hashes.get(key);
    if (!map) return 0;
    let deleted = 0;
    for (const f of fields) {
      if (map.delete(f)) deleted++;
    }
    return deleted;
  }

  async zadd(key: string, score: number, member: string): Promise<number> {
    let zset = this.zsets.get(key);
    if (!zset) {
      zset = new Map();
      this.zsets.set(key, zset);
    }
    const isNew = !zset.has(member);
    zset.set(member, score);
    return isNew ? 1 : 0;
  }

  async zrange(key: string, start: number, stop: number): Promise<string[]> {
    const zset = this.zsets.get(key);
    if (!zset) return [];
    const sorted = [...zset.entries()].sort((a, b) => a[1] - b[1]);
    const end = stop < 0 ? sorted.length + stop + 1 : stop + 1;
    return sorted.slice(start, end).map(([member]) => member);
  }

  async zrangebyscore(
    key: string,
    min: number | string,
    max: number | string,
  ): Promise<string[]> {
    const zset = this.zsets.get(key);
    if (!zset) return [];
    const minVal = min === "-inf" ? -Infinity : Number(min);
    const maxVal = max === "+inf" ? Infinity : Number(max);
    return [...zset.entries()]
      .filter(([, score]) => score >= minVal && score <= maxVal)
      .sort((a, b) => a[1] - b[1])
      .map(([member]) => member);
  }

  async zrem(key: string, ...members: string[]): Promise<number> {
    const zset = this.zsets.get(key);
    if (!zset) return 0;
    let removed = 0;
    for (const m of members) {
      if (zset.delete(m)) removed++;
    }
    return removed;
  }

  async zcard(key: string): Promise<number> {
    return this.zsets.get(key)?.size ?? 0;
  }

  async sadd(key: string, ...members: string[]): Promise<number> {
    let set = this.sets.get(key);
    if (!set) {
      set = new Set();
      this.sets.set(key, set);
    }
    let added = 0;
    for (const m of members) {
      if (!set.has(m)) {
        set.add(m);
        added++;
      }
    }
    return added;
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    const set = this.sets.get(key);
    if (!set) return 0;
    let removed = 0;
    for (const m of members) {
      if (set.delete(m)) removed++;
    }
    return removed;
  }

  async scard(key: string): Promise<number> {
    return this.sets.get(key)?.size ?? 0;
  }

  async rpush(key: string, ...values: string[]): Promise<number> {
    let list = this.lists.get(key);
    if (!list) {
      list = [];
      this.lists.set(key, list);
    }
    list.push(...values);
    return list.length;
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const list = this.lists.get(key) ?? [];
    const end = stop < 0 ? list.length + stop + 1 : stop + 1;
    return list.slice(start, end);
  }

  async lrem(key: string, count: number, value: string): Promise<number> {
    const list = this.lists.get(key);
    if (!list) return 0;
    let removed = 0;
    for (let i = 0; i < list.length; ) {
      if (list[i] === value && (count === 0 || removed < Math.abs(count))) {
        list.splice(i, 1);
        removed++;
      } else {
        i++;
      }
    }
    return removed;
  }

  async llen(key: string): Promise<number> {
    return this.lists.get(key)?.length ?? 0;
  }

  async incr(key: string): Promise<number> {
    const next = Number(this.strings.get(key) ?? 0) + 1;
    this.strings.set(key, String(next));
    return next;
  }

  async get(key: string): Promise<string | null> {
    return this.strings.get(key) ?? null;
  }

  async quit(): Promise<void> {
    this.quitCalled = true;
  }
}

async function waitUntil(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
}

describe("Queue & MemoryQueueDriver", () => {
  const queues: Queue<any, any>[] = [];
  const track = <T, R>(q: Queue<T, R>): Queue<T, R> => {
    queues.push(q);
    return q;
  };

  afterEach(async () => {
    while (queues.length > 0) {
      await queues.pop()!.close();
    }
  });

  it("calculates fixed and exponential backoff delays with caps and jitter", () => {
    expect(calculateBackoffDelay({ type: "fixed", delayMs: 100 }, 1)).toBe(100);
    expect(calculateBackoffDelay({ type: "fixed", delayMs: 100 }, 4)).toBe(100);

    expect(
      calculateBackoffDelay({ type: "exponential", delayMs: 50 }, 1),
    ).toBe(50);
    expect(
      calculateBackoffDelay({ type: "exponential", delayMs: 50 }, 2),
    ).toBe(100);
    expect(
      calculateBackoffDelay(
        { type: "exponential", delayMs: 50, maxDelayMs: 120 },
        3,
      ),
    ).toBe(120);

    // Deterministic jitter bounds
    expect(
      calculateBackoffDelay(
        { type: "fixed", delayMs: 100, jitter: 0.2 },
        1,
        () => 0,
      ),
    ).toBe(80);
    expect(
      calculateBackoffDelay(
        { type: "fixed", delayMs: 100, jitter: 0.2 },
        1,
        () => 1,
      ),
    ).toBe(120);
  });

  it("processes jobs in priority order with FIFO tie-breaking", async () => {
    const q = track(new Queue<{ label: string }, string>({ name: "prio", concurrency: 1 }));
    q.pause();

    await q.add("work", { label: "normal-1" }, { priority: 0 });
    await q.add("work", { label: "low" }, { priority: -5 });
    await q.add("work", { label: "high-1" }, { priority: 10 });
    await q.add("work", { label: "normal-2" }, { priority: 0 });
    await q.add("work", { label: "high-2" }, { priority: 10 });

    const order: string[] = [];
    q.process("work", (job) => {
      order.push(job.data.label);
      return job.data.label;
    });

    q.resume();
    await waitUntil(() => order.length === 5);

    expect(order).toEqual([
      "high-1",
      "high-2",
      "normal-1",
      "normal-2",
      "low",
    ]);
  });

  it("schedules delayed jobs and executes them after delayMs", async () => {
    const q = track(new Queue<{ msg: string }, string>({ name: "delayed" }));
    let executedAt = 0;
    const enqueuedAt = Date.now();

    q.process("notify", (job) => {
      executedAt = Date.now();
      return job.data.msg;
    });

    const job = await q.add("notify", { msg: "later" }, { delayMs: 45 });
    expect(job.status).toBe("delayed");

    await waitUntil(() => executedAt > 0);
    expect(executedAt - enqueuedAt).toBeGreaterThanOrEqual(30);

    const completed = await q.getJob(job.id);
    expect(completed?.status).toBe("completed");
    expect(completed?.returnValue).toBe("later");
  });

  it("enforces concurrency limit strictly under parallel load", async () => {
    const q = track(new Queue<{ id: number }, number>({ name: "conc", concurrency: 2 }));
    let current = 0;
    let peak = 0;
    let done = 0;

    q.process("task", async (job) => {
      current++;
      if (current > peak) peak = current;
      await Bun.sleep(20);
      current--;
      done++;
      return job.data.id;
    });

    await q.addBulk([
      { name: "task", data: { id: 1 } },
      { name: "task", data: { id: 2 } },
      { name: "task", data: { id: 3 } },
      { name: "task", data: { id: 4 } },
      { name: "task", data: { id: 5 } },
      { name: "task", data: { id: 6 } },
    ]);

    await waitUntil(() => done === 6);
    expect(peak).toBe(2);
    expect(current).toBe(0);
  });

  it("deduplicates jobs by idempotencyKey without running duplicate work", async () => {
    const q = track(new Queue<{ orderId: string }, string>({ name: "idemp" }));
    q.pause();

    const j1 = await q.add(
      "charge",
      { orderId: "ord_1" },
      { idempotencyKey: "charge:ord_1" },
    );
    const j2 = await q.add(
      "charge",
      { orderId: "ord_1" },
      { idempotencyKey: "charge:ord_1" },
    );
    expect(j2.id).toBe(j1.id);

    let runs = 0;
    q.process("charge", (job) => {
      runs++;
      return `charged:${job.data.orderId}`;
    });
    q.resume();

    await waitUntil(() => runs === 1);
    await Bun.sleep(20);

    // Enqueue again after completion -> still returns existing job, no re-run
    const j3 = await q.add(
      "charge",
      { orderId: "ord_1" },
      { idempotencyKey: "charge:ord_1" },
    );
    expect(j3.id).toBe(j1.id);
    await Bun.sleep(20);
    expect(runs).toBe(1);
  });

  it("retries transient faults with exponential backoff until success", async () => {
    const q = track(new Queue<{ n: number }, string>({ name: "retry" }));
    const attemptTimestamps: number[] = [];
    const failedEvents: number[] = [];
    let completedResult: unknown;

    q.on("failed", (job) => {
      failedEvents.push(job.attemptsMade);
    });
    q.on("completed", (_job, result) => {
      completedResult = result;
    });

    q.process("flaky", () => {
      attemptTimestamps.push(Date.now());
      if (attemptTimestamps.length < 3) {
        throw new Error(`transient-${attemptTimestamps.length}`);
      }
      return "recovered";
    });

    const job = await q.add(
      "flaky",
      { n: 1 },
      {
        attempts: 3,
        backoff: { type: "exponential", delayMs: 20 },
      },
    );

    await waitUntil(() => completedResult === "recovered");
    expect(attemptTimestamps).toHaveLength(3);
    expect(failedEvents).toEqual([1, 2]);
    // 2nd backoff (~40ms) should be >= 1st backoff (~20ms) minus timer slack
    const gap1 = attemptTimestamps[1]! - attemptTimestamps[0]!;
    const gap2 = attemptTimestamps[2]! - attemptTimestamps[1]!;
    expect(gap1).toBeGreaterThanOrEqual(10);
    expect(gap2).toBeGreaterThanOrEqual(25);

    const finalJob = await q.getJob(job.id);
    expect(finalJob?.status).toBe("completed");
    expect(finalJob?.returnValue).toBe("recovered");
  });

  it("moves permanently failing jobs to DLQ and supports manual retryDeadLetter()", async () => {
    const q = track(new Queue<{ fail: boolean }, string>({ name: "dlq" }));
    let shouldFail = true;
    const dlqEvents: string[] = [];

    q.on("dead-letter", (job) => {
      dlqEvents.push(job.id);
    });

    q.process("export", () => {
      if (shouldFail) {
        throw new Error("permanent-failure");
      }
      return "exported-ok";
    });

    const job = await q.add(
      "export",
      { fail: true },
      { attempts: 2, backoff: { type: "fixed", delayMs: 10 } },
    );

    await waitUntil(() => dlqEvents.length === 1);

    const dlqJobs = await q.getDeadLetterJobs();
    expect(dlqJobs).toHaveLength(1);
    expect(dlqJobs[0]!.id).toBe(job.id);
    expect(dlqJobs[0]!.status).toBe("dead-letter");
    expect(dlqJobs[0]!.failedReason).toBe("permanent-failure");
    expect(dlqJobs[0]!.attemptsMade).toBe(2);

    // Fix fault and retry from DLQ
    shouldFail = false;
    const retried = await q.retryDeadLetter(job.id);
    expect(retried).not.toBeNull();

    await waitUntil(async () => (await q.getJob(job.id))?.status === "completed");
    expect((await q.getJob(job.id))?.returnValue).toBe("exported-ok");
    expect(await q.getDeadLetterJobs()).toHaveLength(0);
  });

  it("enforces per-job timeoutMs and sends timed-out job to DLQ", async () => {
    const q = track(new Queue<unknown, string>({ name: "timeout" }));
    let failureErr: unknown;

    q.on("dead-letter", (_job, err) => {
      failureErr = err;
    });

    q.process("slow", async () => {
      await Bun.sleep(200);
      return "too-late";
    });

    const job = await q.add("slow", {}, { attempts: 1, timeoutMs: 25 });
    await waitUntil(() => failureErr !== undefined);

    expect(failureErr).toBeInstanceOf(JobTimeoutError);
    expect((await q.getJob(job.id))?.status).toBe("dead-letter");
  });

  it("integrates QueueModule, @Processor/@Process/@OnQueueEvent, and gracefully drains on app.close()", async () => {
    const completed: string[] = [];
    let inFlightFinished = false;
    let startedInFlight = false;

    @Processor("emails", { concurrency: 2 })
    class EmailProcessor {
      @Process("welcome")
      async handleWelcome(job: Job<{ to: string; delay?: number }>) {
        startedInFlight = true;
        if (job.data.delay) {
          await Bun.sleep(job.data.delay);
        }
        inFlightFinished = true;
        return `sent:${job.data.to}`;
      }

      @OnQueueEvent("completed")
      onCompleted(_job: Job, result: string) {
        completed.push(result);
      }
    }

    @Injectable()
    class MailProducer {
      constructor(
        @InjectQueue("emails")
        public readonly queue: Queue<{ to: string; delay?: number }, string>,
      ) {}
    }

    const mod = await Test.createTestingModule({
      imports: [
        QueueModule.forRoot({ driver: new MemoryQueueDriver() }),
        QueueModule.registerQueue({ name: "emails" }),
      ],
      providers: [EmailProcessor, MailProducer],
    }).compile();

    const app = mod.createBunestApplication();
    await app.init();

    const producer = mod.get(MailProducer);
    await producer.queue.add("welcome", { to: "ada@bunest.dev", delay: 60 });
    // Also enqueue a far-future delayed job to verify its timer is cleared on shutdown
    await producer.queue.add("welcome", { to: "never@bunest.dev" }, { delayMs: 60_000 });

    await waitUntil(() => startedInFlight);
    expect(inFlightFinished).toBe(false);

    // Graceful close must wait for in-flight job to complete and not hang on the 60s delayed job!
    await app.close();
    expect(inFlightFinished).toBe(true);
    expect(completed).toEqual(["sent:ada@bunest.dev"]);
    expect(producer.queue.isClosed).toBe(true);
    await expect(
      producer.queue.add("welcome", { to: "after-close@bunest.dev" }),
    ).rejects.toThrow(/closed/i);
  });

  it("runs full Queue lifecycle on RedisQueueDriver with mock Redis client", async () => {
    const mockRedis = new MockRedisQueueClient();
    const driver = new RedisQueueDriver(mockRedis, { prefix: "testq" });
    const q = track(
      new Queue<{ value: number }, number>({
        name: "math",
        driver,
        concurrency: 1,
      }),
    );

    q.pause();
    const first = await q.add(
      "double",
      { value: 5 },
      { idempotencyKey: "dup:5", priority: 1 },
    );
    const dup = await q.add(
      "double",
      { value: 5 },
      { idempotencyKey: "dup:5", priority: 1 },
    );
    expect(dup.id).toBe(first.id);

    const highPrio = await q.add("double", { value: 10 }, { priority: 20 });
    const failing = await q.add("fail", { value: 0 }, { attempts: 1, priority: 0 });

    const results: number[] = [];
    q.process("double", (job) => {
      const doubled = job.data.value * 2;
      results.push(doubled);
      return doubled;
    });
    q.process("fail", () => {
      throw new Error("redis-job-fail");
    });

    q.resume();
    await waitUntil(async () => (await q.getDeadLetterJobs()).length === 1);

    expect(results).toEqual([20, 10]); // highPrio ran first!
    expect((await q.getJob(highPrio.id))?.returnValue).toBe(20);
    expect((await q.getJob(failing.id))?.status).toBe("dead-letter");

    const counts = await q.getCounts();
    expect(counts.completed).toBe(2);
    expect(counts.deadLetter).toBe(1);

    await q.close();
    await driver.close();
    expect(mockRedis.quitCalled).toBe(true);
  });

  it("persists attemptsMade in RedisQueueDriver so retries converge to DLQ and can be manually retried", async () => {
    const mockRedis = new MockRedisQueueClient();
    const driver = new RedisQueueDriver(mockRedis, { prefix: "dlqtest" });
    const q = track(
      new Queue<{ key: string }, string>({
        name: "redis-dlq",
        driver,
        concurrency: 1,
      }),
    );

    let runs = 0;
    let shouldFail = true;
    const dlqIds: string[] = [];

    q.on("dead-letter", (job) => {
      dlqIds.push(job.id);
    });

    q.process("flaky-redis", () => {
      runs++;
      if (shouldFail) {
        throw new Error(`redis-fail-${runs}`);
      }
      return "redis-recovered";
    });

    const job = await q.add(
      "flaky-redis",
      { key: "k1" },
      { attempts: 2, backoff: { type: "fixed", delayMs: 10 } },
    );

    await waitUntil(() => dlqIds.length === 1);
    await Bun.sleep(30); // Ensure it did NOT keep retrying after reaching DLQ

    expect(runs).toBe(2);
    const dlqJobs = await q.getDeadLetterJobs();
    expect(dlqJobs).toHaveLength(1);
    expect(dlqJobs[0]!.id).toBe(job.id);
    expect(dlqJobs[0]!.attemptsMade).toBe(2);
    expect(dlqJobs[0]!.status).toBe("dead-letter");

    // Manual retry from DLQ succeeds
    shouldFail = false;
    await q.retryDeadLetter(job.id);
    await waitUntil(async () => (await q.getJob(job.id))?.status === "completed");
    expect((await q.getJob(job.id))?.returnValue).toBe("redis-recovered");
    expect(runs).toBe(3);

    await q.close();
    await driver.close();
  });
});
