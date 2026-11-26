import { afterEach, describe, expect, it } from "bun:test";
import {
  LUA_ACK_JOB,
  LUA_DEQUEUE_JOB,
  LUA_ENQUEUE_JOB,
  LUA_NACK_OR_DLQ_JOB,
  LUA_RECLAIM_STALLED,
  LUA_RENEW_LEASE,
  MemoryQueueDriver,
  Queue,
  RedisQueueDriver,
  type Job,
  type QueueCounts,
  type QueueDriver,
  type RedisQueueClientLike,
} from "../../src/queues/index";

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

class FaultyDriverWrapper implements QueueDriver {
  public dequeueFailuresRemaining = 0;
  public dequeueCallCount = 0;
  public failAckOnce = false;
  public failNackOnce = false;
  public failMoveToDlqOnce = false;
  public nackCalls = 0;
  public dlqCalls = 0;
  public renewLeaseResult = true;
  public readonly lockDurationMs = 40;

  constructor(private readonly inner: MemoryQueueDriver = new MemoryQueueDriver()) {}

  enqueue<TData = unknown, TResult = unknown>(
    queueName: string,
    job: Job<TData, TResult>,
  ): Promise<Job<TData, TResult>> {
    return this.inner.enqueue(queueName, job);
  }

  async dequeue<TData = unknown, TResult = unknown>(
    queueName: string,
    now?: number,
  ): Promise<Job<TData, TResult> | null> {
    this.dequeueCallCount++;
    if (this.dequeueFailuresRemaining > 0) {
      this.dequeueFailuresRemaining--;
      throw new Error("ECONNRESET: transient Redis disconnect");
    }
    const job = await this.inner.dequeue<TData, TResult>(queueName, now);
    if (job) {
      job.leaseToken = `tok_${job.id}_${Date.now()}`;
      job.leaseExpiresAt = (job.startedAt ?? Date.now()) + this.lockDurationMs;
    }
    return job;
  }

  async ack<TData = unknown, TResult = unknown>(
    queueName: string,
    jobId: string,
    result?: TResult,
  ): Promise<Job<TData, TResult> | null> {
    if (this.failAckOnce) {
      this.failAckOnce = false;
      throw new Error("Redis write timeout during ack");
    }
    return this.inner.ack(queueName, jobId, result);
  }

  async nack<TData = unknown, TResult = unknown>(
    queueName: string,
    jobId: string,
    error: Error | string,
    retryAt?: number,
  ): Promise<Job<TData, TResult> | null> {
    this.nackCalls++;
    if (this.failNackOnce) {
      this.failNackOnce = false;
      throw new Error("Redis write timeout during nack");
    }
    return this.inner.nack(queueName, jobId, error, retryAt);
  }

  async moveToDeadLetter<TData = unknown, TResult = unknown>(
    queueName: string,
    jobId: string,
    error: Error | string,
  ): Promise<Job<TData, TResult> | null> {
    this.dlqCalls++;
    if (this.failMoveToDlqOnce) {
      this.failMoveToDlqOnce = false;
      throw new Error("Redis write timeout during moveToDeadLetter");
    }
    return this.inner.moveToDeadLetter(queueName, jobId, error);
  }

  async renewLease(): Promise<boolean> {
    return this.renewLeaseResult;
  }

  getJob<TData = unknown, TResult = unknown>(
    queueName: string,
    jobId: string,
  ): Promise<Job<TData, TResult> | null> {
    return this.inner.getJob(queueName, jobId);
  }

  getCounts(queueName: string): Promise<QueueCounts> {
    return this.inner.getCounts(queueName);
  }

  getDeadLetterJobs<TData = unknown, TResult = unknown>(
    queueName: string,
  ): Promise<Job<TData, TResult>[]> {
    return this.inner.getDeadLetterJobs(queueName);
  }

  retryDeadLetterJob<TData = unknown, TResult = unknown>(
    queueName: string,
    jobId: string,
  ): Promise<Job<TData, TResult> | null> {
    return this.inner.retryDeadLetterJob(queueName, jobId);
  }

  getNextDelayedTimestamp(queueName: string): Promise<number | null> {
    return this.inner.getNextDelayedTimestamp(queueName);
  }

  close(): void {
    this.inner.close();
  }
}

class MinimalRedisMock implements RedisQueueClientLike {
  public readonly hashes = new Map<string, Map<string, string>>();
  public readonly zsets = new Map<string, Map<string, number>>();
  public readonly sets = new Map<string, Set<string>>();
  public readonly lists = new Map<string, string[]>();
  public readonly strings = new Map<string, string>();
  public readonly evalCalls: Array<{
    script: string;
    keys: string[];
    argv: string[];
  }> = [];
  public failGet = false;
  public pingImpl?: () => Promise<unknown>;

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
    let n = 0;
    for (const f of fields) {
      if (map.delete(f)) n++;
    }
    return n;
  }
  async zadd(key: string, score: number, member: string): Promise<number> {
    let map = this.zsets.get(key);
    if (!map) {
      map = new Map();
      this.zsets.set(key, map);
    }
    const isNew = !map.has(member);
    map.set(member, score);
    return isNew ? 1 : 0;
  }
  async zrange(key: string, start: number, stop: number): Promise<string[]> {
    const map = this.zsets.get(key);
    if (!map) return [];
    const sorted = [...map.entries()].sort((a, b) => a[1] - b[1]);
    const end = stop < 0 ? sorted.length + stop + 1 : stop + 1;
    return sorted.slice(start, end).map(([m]) => m);
  }
  async zrangebyscore(
    key: string,
    min: number | string,
    max: number | string,
  ): Promise<string[]> {
    const map = this.zsets.get(key);
    if (!map) return [];
    const minV = min === "-inf" ? -Infinity : Number(min);
    const maxV = max === "+inf" ? Infinity : Number(max);
    return [...map.entries()]
      .filter(([, s]) => s >= minV && s <= maxV)
      .sort((a, b) => a[1] - b[1])
      .map(([m]) => m);
  }
  async zrem(key: string, ...members: string[]): Promise<number> {
    const map = this.zsets.get(key);
    if (!map) return 0;
    let n = 0;
    for (const m of members) {
      if (map.delete(m)) n++;
    }
    return n;
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
    let n = 0;
    for (const m of members) {
      if (!set.has(m)) {
        set.add(m);
        n++;
      }
    }
    return n;
  }
  async srem(key: string, ...members: string[]): Promise<number> {
    const set = this.sets.get(key);
    if (!set) return 0;
    let n = 0;
    for (const m of members) {
      if (set.delete(m)) n++;
    }
    return n;
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
    let n = 0;
    for (let i = 0; i < list.length;) {
      if (list[i] === value && (count === 0 || n < Math.abs(count))) {
        list.splice(i, 1);
        n++;
      } else {
        i++;
      }
    }
    return n;
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
    if (this.failGet) {
      throw new Error("Redis unreachable");
    }
    return this.strings.get(key) ?? null;
  }
  ping = async (): Promise<unknown> => {
    if (this.pingImpl) {
      return this.pingImpl();
    }
    if (this.failGet) {
      throw new Error("PING failed");
    }
    return "PONG";
  };
}

describe("Queue Worker Recovery & Redis Hardening", () => {
  const queues: Queue<any, any>[] = [];
  const drivers: Array<{ close(): Promise<void> | void }> = [];

  afterEach(async () => {
    while (queues.length > 0) {
      await queues.pop()!.close();
    }
    while (drivers.length > 0) {
      await drivers.pop()!.close();
    }
  });

  it("picks up externally enqueued jobs via pollIntervalMs and stops polling on pause/close", async () => {
    const sharedDriver = new FaultyDriverWrapper();
    drivers.push(sharedDriver);

    const worker = new Queue<{ msg: string }, string>({
      name: "cross-proc",
      driver: sharedDriver,
      pollIntervalMs: 15,
    });
    queues.push(worker);

    const processed: string[] = [];
    worker.process("deliver", (job) => {
      processed.push(job.data.msg);
      return `ok:${job.data.msg}`;
    });

    // Wait until initial idle poll has settled
    await Bun.sleep(25);
    expect(processed).toEqual([]);

    // Separate producer enqueues directly into the shared driver (no triggerPump on worker)
    const producer = new Queue<{ msg: string }, string>({
      name: "cross-proc",
      driver: sharedDriver,
      pollIntervalMs: 0,
    });
    queues.push(producer);
    await producer.add("deliver", { msg: "from-other-process" });

    await waitUntil(() => processed.includes("from-other-process"), 1000);
    expect(processed).toEqual(["from-other-process"]);

    // Pausing stops polling
    worker.pause();
    const callsAtPause = sharedDriver.dequeueCallCount;
    await Bun.sleep(50);
    expect(sharedDriver.dequeueCallCount).toBe(callsAtPause);

    // Closing stops polling
    worker.resume();
    await Bun.sleep(25);
    await worker.close();
    const callsAtClose = sharedDriver.dequeueCallCount;
    await Bun.sleep(50);
    expect(sharedDriver.dequeueCallCount).toBe(callsAtClose);
  });

  it("recovers from transient pumpLoop dequeue errors via exponential backoff without stalling", async () => {
    const driver = new FaultyDriverWrapper();
    driver.dequeueFailuresRemaining = 2;
    drivers.push(driver);

    const q = new Queue<{ v: number }, number>({
      name: "pump-recovery",
      driver,
      pollIntervalMs: 10,
    });
    queues.push(q);

    const errors: Error[] = [];
    const results: number[] = [];
    q.on("error", (_job, payload) => {
      errors.push(payload as Error);
    });

    q.process("compute", (job) => {
      results.push(job.data.v * 2);
      return job.data.v * 2;
    });

    await q.add("compute", { v: 21 });

    await waitUntil(() => results.length === 1, 1500);
    expect(results).toEqual([42]);
    expect(errors.length).toBeGreaterThanOrEqual(2);
    expect(errors[0]!.message).toContain("ECONNRESET");
  });

  it("guards ack(), nack(), and moveToDeadLetter() failures in executeJob() and emits error without unhandled rejections", async () => {
    const driver = new FaultyDriverWrapper();
    drivers.push(driver);

    const q = new Queue<{ mode: "ok" | "retry" | "dlq" }, string>({
      name: "guarded-settlement",
      driver,
      pollIntervalMs: 0,
    });
    queues.push(q);

    const errors: Error[] = [];
    q.on("error", (_job, payload) => {
      errors.push(payload as Error);
    });

    q.process("work", (job) => {
      if (job.data.mode === "ok") return "done";
      throw new Error(`boom:${job.data.mode}`);
    });

    // 1. Failing ack() emits error and does NOT falsely call nack() or moveToDeadLetter()
    driver.failAckOnce = true;
    await q.add("work", { mode: "ok" }, { attempts: 2 });
    await waitUntil(() => errors.some((e) => e.message.includes("during ack")));
    expect(driver.nackCalls).toBe(0);
    expect(driver.dlqCalls).toBe(0);

    // 2. Failing nack() emits error cleanly
    driver.failNackOnce = true;
    await q.add("work", { mode: "retry" }, { attempts: 3 });
    await waitUntil(() =>
      errors.some((e) => e.message.includes("during nack")),
    );

    // 3. Failing moveToDeadLetter() emits error cleanly
    driver.failMoveToDlqOnce = true;
    await q.add("work", { mode: "dlq" }, { attempts: 1 });
    await waitUntil(() =>
      errors.some((e) => e.message.includes("during moveToDeadLetter")),
    );
  });

  it("emits lockRenewalFailed and aborts handler AbortSignal when renewLease() returns false", async () => {
    const driver = new FaultyDriverWrapper();
    driver.renewLeaseResult = false;
    drivers.push(driver);

    const q = new Queue<{ id: string }, string>({
      name: "lease-abort",
      driver,
      pollIntervalMs: 0,
    });
    queues.push(q);

    const lockFailedEvents: Array<{ jobId: string; err: Error }> = [];
    q.on("lockRenewalFailed", (job, payload) => {
      lockFailedEvents.push({ jobId: job.id, err: payload as Error });
    });

    let signalArgAborted = false;
    let jobSignalPropAborted = false;
    let handlerDone = false;

    q.process("long", (async (
      job: Job<{ id: string }, string> & { signal?: AbortSignal },
      _token?: string,
      signal?: AbortSignal,
    ) => {
      await new Promise<void>((resolve) => {
        if (signal?.aborted) {
          resolve();
          return;
        }
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      signalArgAborted = Boolean(signal?.aborted);
      jobSignalPropAborted = Boolean(job.signal?.aborted);
      handlerDone = true;
      return "aborted-cleanly";
    }) as any);

    const added = await q.add("long", { id: "j1" });
    await waitUntil(() => lockFailedEvents.length === 1 && handlerDone, 1000);

    expect(lockFailedEvents[0]!.jobId).toBe(added.id);
    expect(lockFailedEvents[0]!.err.message).toContain("Lease renewal failed");
    expect(signalArgAborted).toBe(true);
    expect(jobSignalPropAborted).toBe(true);
  });

  it("supports RedisQueueDriver.ping() health probe across healthy, error, and closed states", async () => {
    const mock = new MinimalRedisMock();
    const driver = new RedisQueueDriver(mock, {
      prefix: "pingq",
      stalledIntervalMs: 0,
    });
    drivers.push(driver);

    expect(await driver.ping()).toBe(true);

    mock.failGet = true;
    expect(await driver.ping()).toBe(false);

    mock.failGet = false;
    expect(await driver.ping()).toBe(true);

    // Fallback path when client has no ping() method
    (mock as { ping?: unknown }).ping = undefined;
    expect(await driver.ping()).toBe(true);
    mock.failGet = true;
    expect(await driver.ping()).toBe(false);

    mock.failGet = false;
    await driver.close();
    expect(await driver.ping()).toBe(false);
  });

  it("preserves stacktrace array semantics in Lua scripts and normalizes non-array stacktrace on read", async () => {
    // Verify Lua scripts guard empty stacktrace with cjson.empty_array_mt
    for (const script of [
      LUA_DEQUEUE_JOB,
      LUA_ACK_JOB,
      LUA_RENEW_LEASE,
      LUA_RECLAIM_STALLED,
    ]) {
      expect(script).toContain("cjson.empty_array_mt");
      expect(script).toContain('job["stacktrace"]');
    }
    expect(LUA_ENQUEUE_JOB).toContain("PEXPIRE");
    expect(LUA_ACK_JOB).toContain('redis.call("HDEL", idempKey, idempotency)');
    expect(LUA_NACK_OR_DLQ_JOB).toContain(
      'redis.call("HDEL", idempKey, idempotency)',
    );
    expect(LUA_RECLAIM_STALLED).toContain(
      'redis.call("HDEL", idempKey, idempotency)',
    );

    // Verify RedisQueueDriver normalizes legacy `{}` stacktrace back to `[]`
    const mock = new MinimalRedisMock();
    const driver = new RedisQueueDriver(mock, {
      prefix: "stackq",
      stalledIntervalMs: 0,
    });
    drivers.push(driver);

    await mock.hset(
      "stackq:orders:jobs",
      "legacy-1",
      JSON.stringify({
        id: "legacy-1",
        queueName: "orders",
        name: "charge",
        data: {},
        priority: 0,
        maxAttempts: 1,
        attemptsMade: 0,
        status: "waiting",
        removeOnComplete: false,
        createdAt: 1000,
        processAfter: 1000,
        stacktrace: {}, // simulates Lua cjson {} bug
      }),
    );

    const loaded = await driver.getJob("orders", "legacy-1");
    expect(loaded).not.toBeNull();
    expect(Array.isArray(loaded!.stacktrace)).toBe(true);
    expect(loaded!.stacktrace).toEqual([]);
  });

  it("prunes idempotency hash entries on terminal completion and DLQ in fallback mode", async () => {
    const mock = new MinimalRedisMock();
    const driver = new RedisQueueDriver(mock, {
      prefix: "idempq",
      stalledIntervalMs: 0,
      pruneIdempotencyOnTerminal: true,
    });
    drivers.push(driver);

    const job1: Job<{ n: number }, string> = {
      id: "j-complete",
      queueName: "q",
      name: "run",
      data: { n: 1 },
      priority: 0,
      idempotencyKey: "key-1",
      maxAttempts: 1,
      attemptsMade: 0,
      status: "waiting",
      removeOnComplete: false,
      createdAt: Date.now(),
      processAfter: Date.now(),
      stacktrace: [],
    };
    await driver.enqueue("q", job1);
    expect(await mock.hget("idempq:q:idempotency", "key-1")).toBe("j-complete");

    await driver.dequeue("q");
    await driver.ack("q", "j-complete", "ok");
    expect(await mock.hget("idempq:q:idempotency", "key-1")).toBeNull();

    const job2: Job<{ n: number }, string> = {
      ...job1,
      id: "j-dlq",
      idempotencyKey: "key-2",
    };
    await driver.enqueue("q", job2);
    expect(await mock.hget("idempq:q:idempotency", "key-2")).toBe("j-dlq");

    await driver.dequeue("q");
    await driver.moveToDeadLetter("q", "j-dlq", new Error("fatal"));
    expect(await mock.hget("idempq:q:idempotency", "key-2")).toBeNull();
  });
});
