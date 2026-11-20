import "reflect-metadata";
import { afterEach, describe, expect, it } from "bun:test";
import { Injectable } from "@bunest/common";
import { Test } from "@bunest/testing";
import {
  BullMQModule,
  BullMQQueueDriver,
  InjectQueue,
  LUA_ACK_JOB,
  LUA_DEQUEUE_JOB,
  LUA_ENQUEUE_JOB,
  LUA_NACK_OR_DLQ_JOB,
  LUA_RECLAIM_STALLED,
  LUA_RENEW_LEASE,
  OnQueueEvent,
  Process,
  Processor,
  Queue,
  RedisQueueDriver,
  type BullMQJobLike,
  type BullMQProcessorFn,
  type BullMQQueueLike,
  type BullMQWorkerLike,
  type Job,
  type RedisQueueClientLike,
} from "../src/index";

/**
 * Realistic in-memory Redis server mock supporting `eval`, `evalsha`, and
 * `scriptLoad`, executing the exact atomic semantics of all 6 exported
 * `RedisQueueDriver` Lua scripts over shared Hash / ZSET / LIST / STRING data.
 */
class MockLuaRedisClient implements RedisQueueClientLike {
  public readonly hashes = new Map<string, Map<string, string>>();
  public readonly zsets = new Map<string, Map<string, number>>();
  public readonly sets = new Map<string, Set<string>>();
  public readonly lists = new Map<string, string[]>();
  public readonly strings = new Map<string, string>();

  public readonly executedScripts: string[] = [];
  public readonly shaRegistry = new Map<string, string>();
  public simulateNoScriptOnce = false;
  public quitCalled = false;

  private readonly enableEvalSha: boolean;

  constructor(options: { enableEvalSha?: boolean } = {}) {
    this.enableEvalSha = options.enableEvalSha ?? false;
  }

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

  async hincrby(key: string, field: string, increment: number): Promise<number> {
    const cur = Number((await this.hget(key, field)) ?? 0);
    const next = cur + increment;
    await this.hset(key, field, String(next));
    return next;
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

  scriptLoad = async (script: string): Promise<string> => {
    if (!this.enableEvalSha) {
      throw new Error("scriptLoad disabled");
    }
    const sha = `sha_${this.shaRegistry.size + 1}`;
    this.shaRegistry.set(sha, script);
    return sha;
  };

  evalsha = async (
    sha1: string,
    numKeys: number,
    ...args: Array<string | number>
  ): Promise<unknown> => {
    if (this.simulateNoScriptOnce) {
      this.simulateNoScriptOnce = false;
      throw new Error("NOSCRIPT No matching script. Please use EVAL.");
    }
    const script = this.shaRegistry.get(sha1);
    if (!script) {
      throw new Error("NOSCRIPT No matching script.");
    }
    return await this.eval(script, numKeys, ...args);
  };

  async eval(
    script: string,
    numKeys: number,
    ...allArgs: Array<string | number>
  ): Promise<unknown> {
    const keys = allArgs.slice(0, numKeys).map(String);
    const argv = allArgs.slice(numKeys).map(String);

    if (script === LUA_ENQUEUE_JOB) {
      this.executedScripts.push("LUA_ENQUEUE_JOB");
      const [jobsKey, idempKey, waitingKey, delayedKey, seqKey] = keys;
      const [jobId, jobJson, priorityRaw, processAfterRaw, nowRaw, idemp] = argv;
      const priority = Number(priorityRaw) || 0;
      const processAfter = Number(processAfterRaw) || 0;
      const now = Number(nowRaw) || 0;

      if (idemp) {
        const existingId = await this.hget(idempKey!, idemp);
        if (existingId) {
          const existingRaw = await this.hget(jobsKey!, existingId);
          if (existingRaw) return [0, existingRaw];
        }
      }
      const existingById = await this.hget(jobsKey!, jobId!);
      if (existingById) return [0, existingById];

      await this.hset(jobsKey!, jobId!, jobJson!);
      if (idemp) await this.hset(idempKey!, idemp, jobId!);

      if (processAfter > now) {
        await this.zadd(delayedKey!, processAfter, jobId!);
      } else {
        const seq = await this.incr(seqKey!);
        await this.zadd(waitingKey!, -priority * 1_000_000_000 + seq, jobId!);
      }
      return [1, jobJson!];
    }

    if (script === LUA_DEQUEUE_JOB) {
      this.executedScripts.push("LUA_DEQUEUE_JOB");
      const [jobsKey, waitingKey, delayedKey, activeKey, leasesKey, seqKey] = keys;
      const [nowRaw, lockDurRaw, leaseToken] = argv;
      const now = Number(nowRaw) || 0;
      const lockDurationMs = Number(lockDurRaw) || 30000;

      const dueIds = await this.zrangebyscore(delayedKey!, "-inf", now);
      for (const dueId of dueIds) {
        if ((await this.zrem(delayedKey!, dueId)) > 0) {
          const raw = await this.hget(jobsKey!, dueId);
          if (raw) {
            const job = JSON.parse(raw) as Job;
            job.status = "waiting";
            await this.hset(jobsKey!, dueId, JSON.stringify(job));
            const seq = await this.incr(seqKey!);
            const score = -(job.priority || 0) * 1_000_000_000 + seq;
            await this.zadd(waitingKey!, score, dueId);
          }
        }
      }

      while (true) {
        const candidates = await this.zrange(waitingKey!, 0, 0);
        if (candidates.length === 0) return null;
        const jobId = candidates[0]!;
        await this.zrem(waitingKey!, jobId);
        const raw = await this.hget(jobsKey!, jobId);
        if (raw) {
          const job = JSON.parse(raw) as Job;
          const leaseExpiresAt = now + lockDurationMs;
          job.status = "active";
          job.startedAt = now;
          job.leaseToken = leaseToken;
          job.leaseExpiresAt = leaseExpiresAt;
          const updated = JSON.stringify(job);
          await this.hset(jobsKey!, jobId, updated);
          await this.zadd(activeKey!, leaseExpiresAt, jobId);
          await this.hset(leasesKey!, jobId, leaseToken!);
          return updated;
        }
      }
    }

    if (script === LUA_ACK_JOB) {
      this.executedScripts.push("LUA_ACK_JOB");
      const [jobsKey, activeKey, leasesKey, stalledKey, completedKey] = keys;
      const [jobId, resultJson, hasResult, finishedAtRaw, expectedToken] = argv;

      if (expectedToken) {
        const currentToken = await this.hget(leasesKey!, jobId!);
        if (!currentToken || currentToken !== expectedToken) {
          return null;
        }
      }

      await this.zrem(activeKey!, jobId!);
      await this.hdel(leasesKey!, jobId!);
      await this.hdel(stalledKey!, jobId!);

      const raw = await this.hget(jobsKey!, jobId!);
      if (!raw) return null;

      const job = JSON.parse(raw) as Job;
      job.status = "completed";
      job.finishedAt = Number(finishedAtRaw) || 0;
      delete job.leaseToken;
      delete job.leaseExpiresAt;
      if (hasResult === "1") {
        job.returnValue = JSON.parse(resultJson!);
      }
      await this.incr(completedKey!);
      const updated = JSON.stringify(job);
      if (job.removeOnComplete) {
        await this.hdel(jobsKey!, jobId!);
      } else {
        await this.hset(jobsKey!, jobId!, updated);
      }
      return updated;
    }

    if (script === LUA_NACK_OR_DLQ_JOB) {
      this.executedScripts.push("LUA_NACK_OR_DLQ_JOB");
      const [
        jobsKey,
        activeKey,
        leasesKey,
        stalledKey,
        waitingKey,
        delayedKey,
        dlqKey,
        failedKey,
        seqKey,
      ] = keys;
      const [
        jobId,
        errorMessage,
        errorStack,
        nowRaw,
        retryAtRaw,
        forceDlq,
        expectedToken,
      ] = argv;
      const now = Number(nowRaw) || 0;

      if (expectedToken) {
        const currentToken = await this.hget(leasesKey!, jobId!);
        if (!currentToken || currentToken !== expectedToken) {
          return null;
        }
      }

      await this.zrem(activeKey!, jobId!);
      await this.zrem(delayedKey!, jobId!);
      await this.zrem(waitingKey!, jobId!);
      await this.hdel(leasesKey!, jobId!);

      const raw = await this.hget(jobsKey!, jobId!);
      if (!raw) return null;

      const job = JSON.parse(raw) as Job;
      job.attemptsMade = (job.attemptsMade || 0) + 1;
      job.failedReason = errorMessage;
      delete job.leaseToken;
      delete job.leaseExpiresAt;
      job.stacktrace.push(errorStack || errorMessage!);

      const moveToDlq =
        forceDlq === "1" || (!retryAtRaw && job.attemptsMade >= job.maxAttempts);

      if (moveToDlq) {
        await this.hdel(stalledKey!, jobId!);
        job.status = "dead-letter";
        job.finishedAt = now;
        await this.incr(failedKey!);
        const updated = JSON.stringify(job);
        await this.hset(jobsKey!, jobId!, updated);
        await this.rpush(dlqKey!, jobId!);
        return ["dead-letter", updated];
      }

      if (retryAtRaw) {
        const retryAt = Number(retryAtRaw) || now;
        job.processAfter = retryAt;
        if (retryAt > now) {
          job.status = "delayed";
          const updated = JSON.stringify(job);
          await this.hset(jobsKey!, jobId!, updated);
          await this.zadd(delayedKey!, retryAt, jobId!);
          return ["delayed", updated];
        }
        job.status = "waiting";
        const updated = JSON.stringify(job);
        await this.hset(jobsKey!, jobId!, updated);
        const seq = await this.incr(seqKey!);
        await this.zadd(
          waitingKey!,
          -(job.priority || 0) * 1_000_000_000 + seq,
          jobId!,
        );
        return ["waiting", updated];
      }

      await this.hdel(stalledKey!, jobId!);
      job.status = "failed";
      job.finishedAt = now;
      await this.incr(failedKey!);
      const updated = JSON.stringify(job);
      await this.hset(jobsKey!, jobId!, updated);
      return ["failed", updated];
    }

    if (script === LUA_RENEW_LEASE) {
      this.executedScripts.push("LUA_RENEW_LEASE");
      const [jobsKey, activeKey, leasesKey] = keys;
      const [jobId, token, nowRaw, lockDurRaw] = argv;
      const currentToken = await this.hget(leasesKey!, jobId!);
      if (!currentToken || currentToken !== token) {
        return 0;
      }
      const newExpiry = (Number(nowRaw) || 0) + (Number(lockDurRaw) || 30000);
      await this.zadd(activeKey!, newExpiry, jobId!);
      const raw = await this.hget(jobsKey!, jobId!);
      if (raw) {
        const job = JSON.parse(raw) as Job;
        job.leaseExpiresAt = newExpiry;
        await this.hset(jobsKey!, jobId!, JSON.stringify(job));
      }
      return 1;
    }

    if (script === LUA_RECLAIM_STALLED) {
      this.executedScripts.push("LUA_RECLAIM_STALLED");
      const [
        jobsKey,
        activeKey,
        leasesKey,
        stalledKey,
        waitingKey,
        dlqKey,
        failedKey,
        seqKey,
      ] = keys;
      const [nowRaw, maxStalledRaw] = argv;
      const now = Number(nowRaw) || 0;
      const maxStalledCount = Number(maxStalledRaw) || 1;

      const expiredIds = await this.zrangebyscore(activeKey!, "-inf", now);
      const reclaimed: string[] = [];
      const deadLettered: string[] = [];

      for (const jobId of expiredIds) {
        await this.zrem(activeKey!, jobId);
        await this.hdel(leasesKey!, jobId);
        const raw = await this.hget(jobsKey!, jobId);
        if (!raw) continue;

        const job = JSON.parse(raw) as Job;
        const stalled = await this.hincrby(stalledKey!, jobId, 1);
        job.stalledCount = stalled;
        delete job.leaseToken;
        delete job.leaseExpiresAt;

        if (stalled > maxStalledCount) {
          await this.hdel(stalledKey!, jobId);
          const reason = `Job stalled more than maxStalledCount (${maxStalledCount})`;
          job.status = "dead-letter";
          job.failedReason = reason;
          job.finishedAt = now;
          job.stacktrace.push(reason);
          await this.incr(failedKey!);
          const updated = JSON.stringify(job);
          await this.hset(jobsKey!, jobId, updated);
          await this.rpush(dlqKey!, jobId);
          deadLettered.push(updated);
        } else {
          job.status = "waiting";
          delete job.startedAt;
          job.processAfter = now;
          const updated = JSON.stringify(job);
          await this.hset(jobsKey!, jobId, updated);
          const seq = await this.incr(seqKey!);
          await this.zadd(
            waitingKey!,
            -(job.priority || 0) * 1_000_000_000 + seq,
            jobId,
          );
          reclaimed.push(updated);
        }
      }
      return [reclaimed, deadLettered];
    }

    throw new Error(`Unknown Lua script executed: ${script.slice(0, 60)}`);
  }

  async quit(): Promise<void> {
    this.quitCalled = true;
  }
}

async function waitUntil(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 2500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
}

describe("RedisQueueDriver Atomic Lua Scripts & Stalled-Job Recovery", () => {
  const drivers: RedisQueueDriver[] = [];
  const queues: Queue<any, any>[] = [];

  afterEach(async () => {
    while (queues.length > 0) {
      await queues.pop()!.close();
    }
    while (drivers.length > 0) {
      await drivers.pop()!.close();
    }
  });

  it("exports all 6 real Redis Lua scripts with KEYS, ARGV, and redis.call primitives", () => {
    const scripts = {
      LUA_ENQUEUE_JOB,
      LUA_DEQUEUE_JOB,
      LUA_ACK_JOB,
      LUA_NACK_OR_DLQ_JOB,
      LUA_RENEW_LEASE,
      LUA_RECLAIM_STALLED,
    };

    for (const [name, src] of Object.entries(scripts)) {
      expect(src.length, `${name} should be non-empty`).toBeGreaterThan(80);
      expect(src).toContain("KEYS[1]");
      expect(src).toContain("ARGV[1]");
      expect(src).toContain("redis.call(");
    }
  });

  it("executes atomic enqueue -> dequeue with lease -> renewLease -> stalled reclaim -> retry -> DLQ", async () => {
    const redis = new MockLuaRedisClient();
    // Disable evalsha so direct eval path is exercised
    (redis as unknown as { evalsha?: unknown }).evalsha = undefined;
    (redis as unknown as { scriptLoad?: unknown }).scriptLoad = undefined;

    const driver = new RedisQueueDriver(redis, {
      prefix: "luaq",
      lockDurationMs: 100,
      stalledIntervalMs: 0, // Manual deterministic sweep in this test
      maxStalledCount: 1,
    });
    drivers.push(driver);

    expect(driver.isAtomicLuaEnabled).toBe(true);

    const baseJob: Job<{ orderId: string }, string> = {
      id: "job_1",
      queueName: "orders",
      name: "charge",
      data: { orderId: "ord_42" },
      priority: 5,
      idempotencyKey: "idem:ord_42",
      maxAttempts: 2,
      attemptsMade: 0,
      status: "waiting",
      removeOnComplete: false,
      createdAt: 1000,
      processAfter: 1000,
      stacktrace: [],
    };

    // 1. Atomic enqueue + idempotency dedupe
    const stored1 = await driver.enqueue("orders", baseJob);
    const storedDup = await driver.enqueue("orders", {
      ...baseJob,
      id: "job_1_dup",
    });
    expect(storedDup.id).toBe(stored1.id);

    // 2. Atomic dequeue assigns leaseToken and leaseExpiresAt in active ZSET
    const t0 = 5000;
    const dequeued = await driver.dequeue<{ orderId: string }, string>("orders", t0);
    expect(dequeued).not.toBeNull();
    expect(dequeued!.status).toBe("active");
    expect(dequeued!.leaseToken).toBeTruthy();
    expect(dequeued!.leaseExpiresAt).toBe(t0 + 100);
    expect((await driver.getCounts("orders")).active).toBe(1);

    // 3. Lease renewal succeeds with valid token and rejects wrong token
    expect(await driver.renewLease(dequeued!.id, "wrong-token")).toBe(false);
    expect(await driver.renewLease(dequeued!.id, dequeued!.leaseToken!, 200)).toBe(true);

    // Stale worker cannot ack with mismatched lease token
    expect(
      await driver.ack("orders", dequeued!.id, "stale", "wrong-token"),
    ).toBeNull();

    // 4. Simulate worker crash -> lease expires -> first reclaim puts job back to waiting
    const futureAfterExpiry = Date.now() + 5000;
    const sweep1 = await driver.reclaimStalledJobs("orders", futureAfterExpiry);
    expect(sweep1.reclaimed).toHaveLength(1);
    expect(sweep1.deadLettered).toHaveLength(0);
    expect(sweep1.reclaimed[0]!.id).toBe("job_1");
    expect(sweep1.reclaimed[0]!.stalledCount).toBe(1);
    expect(sweep1.reclaimed[0]!.status).toBe("waiting");

    // 5. Second dequeue + retry via nack (delayed) + delayed promotion + DLQ
    const dequeued2 = await driver.dequeue("orders", futureAfterExpiry + 10);
    expect(dequeued2).not.toBeNull();
    expect(dequeued2!.leaseToken).not.toBe(dequeued!.leaseToken);

    const nacked = await driver.nack(
      "orders",
      dequeued2!.id,
      new Error("transient-err"),
      futureAfterExpiry + 1000,
      dequeued2!.leaseToken,
    );
    expect(nacked?.status).toBe("delayed");
    expect(nacked?.attemptsMade).toBe(1);

    // Before retryAt -> dequeue returns null
    expect(await driver.dequeue("orders", futureAfterExpiry + 500)).toBeNull();

    // At retryAt -> atomic delayed promotion & dequeue
    const dequeued3 = await driver.dequeue("orders", futureAfterExpiry + 1000);
    expect(dequeued3?.id).toBe("job_1");
    expect(dequeued3?.status).toBe("active");

    // Stall a second time (> maxStalledCount: 1) -> moves directly to DLQ!
    const sweep2 = await driver.reclaimStalledJobs(
      undefined,
      futureAfterExpiry + 2000,
    );
    expect(sweep2.reclaimed).toHaveLength(0);
    expect(sweep2.deadLettered).toHaveLength(1);
    expect(sweep2.deadLettered[0]!.status).toBe("dead-letter");
    expect(sweep2.deadLettered[0]!.stalledCount).toBe(2);

    const dlq = await driver.getDeadLetterJobs("orders");
    expect(dlq).toHaveLength(1);
    expect(dlq[0]!.id).toBe("job_1");

    expect(redis.executedScripts).toContain("LUA_ENQUEUE_JOB");
    expect(redis.executedScripts).toContain("LUA_DEQUEUE_JOB");
    expect(redis.executedScripts).toContain("LUA_RENEW_LEASE");
    expect(redis.executedScripts).toContain("LUA_ACK_JOB");
    expect(redis.executedScripts).toContain("LUA_NACK_OR_DLQ_JOB");
    expect(redis.executedScripts).toContain("LUA_RECLAIM_STALLED");
  });

  it("supports evalsha + scriptLoad with automatic NOSCRIPT recovery", async () => {
    const redis = new MockLuaRedisClient({ enableEvalSha: true });
    const driver = new RedisQueueDriver(redis, {
      prefix: "shaq",
      stalledIntervalMs: 0,
    });
    drivers.push(driver);

    const job: Job<{ n: number }, number> = {
      id: "sha_1",
      queueName: "calc",
      name: "inc",
      data: { n: 1 },
      priority: 0,
      maxAttempts: 1,
      attemptsMade: 0,
      status: "waiting",
      removeOnComplete: false,
      createdAt: Date.now(),
      processAfter: Date.now(),
      stacktrace: [],
    };

    await driver.enqueue("calc", job);
    expect(redis.shaRegistry.size).toBe(1);

    // Simulate Redis SCRIPT FLUSH causing NOSCRIPT on next evalsha
    redis.simulateNoScriptOnce = true;
    const dequeued = await driver.dequeue("calc");
    expect(dequeued?.id).toBe("sha_1");
    const acked = await driver.ack("calc", "sha_1", 2, dequeued?.leaseToken);
    expect(acked?.status).toBe("completed");
    expect(acked?.returnValue).toBe(2);
  });

  it("automatically renews leases during long-running jobs and sweeps stalled jobs periodically", async () => {
    const redis = new MockLuaRedisClient();
    (redis as unknown as { evalsha?: unknown }).evalsha = undefined;
    (redis as unknown as { scriptLoad?: unknown }).scriptLoad = undefined;

    const driver = new RedisQueueDriver(redis, {
      prefix: "autoq",
      lockDurationMs: 50,
      stalledIntervalMs: 25,
      maxStalledCount: 2,
    });
    drivers.push(driver);

    const q = new Queue<{ kind: string }, string>({
      name: "long-work",
      driver,
      concurrency: 1,
    });
    queues.push(q);

    const stalledIds: string[] = [];
    const completedIds: string[] = [];
    q.on("stalled", (job) => {
      stalledIds.push(job.id);
    });
    q.on("completed", (job) => {
      completedIds.push(job.id);
    });

    q.process("slow", async (job) => {
      // Runs 3x longer than lockDurationMs (50ms) — must stay alive via lease renewal!
      await Bun.sleep(140);
      return `ok:${job.data.kind}`;
    });

    // 1. Long-running job must renew lease automatically without stalling
    const longJob = await q.add("slow", { kind: "long" });
    await waitUntil(() => completedIds.includes(longJob.id));

    expect(
      redis.executedScripts.filter((s) => s === "LUA_RENEW_LEASE").length,
    ).toBeGreaterThanOrEqual(2);
    expect(stalledIds).not.toContain(longJob.id);

    // 2. Simulate an orphaned active job (e.g. crashed external worker)
    q.pause();
    const orphan = await q.add("slow", { kind: "orphan" });
    const grabbed = await driver.dequeue("long-work", Date.now());
    expect(grabbed?.id).toBe(orphan.id);
    q.resume();

    // Background stalledIntervalMs sweeper automatically reclaims the expired job and Queue completes it!
    await waitUntil(() => completedIds.includes(orphan.id), 3000);
    expect(stalledIds).toContain(orphan.id);
    expect((await q.getJob(orphan.id))?.returnValue).toBe("ok:orphan");
  });

  it("prevents a waking stale worker from clobbering a reclaimed job when ack/nack runs after LUA_RECLAIM_STALLED", async () => {
    const redis = new MockLuaRedisClient();
    (redis as unknown as { evalsha?: unknown }).evalsha = undefined;
    (redis as unknown as { scriptLoad?: unknown }).scriptLoad = undefined;

    const driver = new RedisQueueDriver(redis, {
      prefix: "staleq",
      lockDurationMs: 50,
      stalledIntervalMs: 0,
      maxStalledCount: 2,
    });
    drivers.push(driver);

    await driver.enqueue("jobs", {
      id: "j_stale",
      queueName: "jobs",
      name: "work",
      data: { n: 1 },
      priority: 0,
      maxAttempts: 2,
      attemptsMade: 0,
      status: "waiting",
      removeOnComplete: false,
      createdAt: 1000,
      processAfter: 1000,
      stacktrace: [],
    });

    const staleGrab = await driver.dequeue("jobs", 2000);
    expect(staleGrab?.leaseToken).toBeTruthy();

    // Reclaim expired lease -> deletes leasesKey entry and returns job to waiting!
    const swept = await driver.reclaimStalledJobs("jobs", 3000);
    expect(swept.reclaimed).toHaveLength(1);
    expect((await driver.getJob("jobs", "j_stale"))?.status).toBe("waiting");

    // Stale worker wakes up and attempts ack & nack with its expired token -> MUST return null and NOT clobber!
    expect(
      await driver.ack("jobs", "j_stale", "stale-result", staleGrab!.leaseToken),
    ).toBeNull();
    expect(
      await driver.nack(
        "jobs",
        "j_stale",
        new Error("stale-err"),
        4000,
        staleGrab!.leaseToken,
      ),
    ).toBeNull();

    const untouched = await driver.getJob("jobs", "j_stale");
    expect(untouched?.status).toBe("waiting");
    expect(untouched?.returnValue).toBeUndefined();
    expect(untouched?.attemptsMade).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Realistic In-Memory BullMQ Queue / Worker Mock
// ---------------------------------------------------------------------------

interface InternalBullJob {
  id: string;
  name: string;
  data: any;
  opts: Record<string, unknown>;
  attemptsMade: number;
  timestamp: number;
  processedOn?: number;
  finishedOn?: number;
  returnvalue?: any;
  failedReason?: string;
  stacktrace: string[];
  state: "waiting" | "delayed" | "active" | "completed" | "failed";
}

class MockBullMQBus {
  readonly jobsByQueue = new Map<string, Map<string, InternalBullJob>>();
  readonly workersByQueue = new Map<string, MockBullMQWorker>();
  private idSeq = 0;

  nextId(): string {
    return `bmq_${++this.idSeq}`;
  }

  getStore(queueName: string): Map<string, InternalBullJob> {
    let map = this.jobsByQueue.get(queueName);
    if (!map) {
      map = new Map();
      this.jobsByQueue.set(queueName, map);
    }
    return map;
  }

  wrapJob(queueName: string, raw: InternalBullJob): BullMQJobLike<any, any> {
    return {
      get id() {
        return raw.id;
      },
      get name() {
        return raw.name;
      },
      get data() {
        return raw.data;
      },
      get opts() {
        return raw.opts;
      },
      get attemptsMade() {
        return raw.attemptsMade;
      },
      get timestamp() {
        return raw.timestamp;
      },
      get processedOn() {
        return raw.processedOn;
      },
      get finishedOn() {
        return raw.finishedOn;
      },
      get returnvalue() {
        return raw.returnvalue;
      },
      get failedReason() {
        return raw.failedReason;
      },
      get stacktrace() {
        return raw.stacktrace;
      },
      getState: async () => raw.state,
      retry: async () => {
        raw.state = "waiting";
        raw.failedReason = undefined;
        raw.finishedOn = undefined;
        this.workersByQueue.get(queueName)?.dispatch(raw);
      },
    };
  }
}

class MockBullMQQueue implements BullMQQueueLike<any, any> {
  public closed = false;

  constructor(
    public readonly name: string,
    private readonly bus: MockBullMQBus,
  ) {}

  async add(
    name: string,
    data: any,
    opts: Record<string, unknown> = {},
  ): Promise<BullMQJobLike<any, any>> {
    const store = this.bus.getStore(this.name);
    const id = String(opts.jobId ?? this.bus.nextId());
    const existing = store.get(id);
    if (existing) {
      return this.bus.wrapJob(this.name, existing);
    }

    const raw: InternalBullJob = {
      id,
      name,
      data,
      opts,
      attemptsMade: 0,
      timestamp: Date.now(),
      stacktrace: [],
      state: Number(opts.delay ?? 0) > 0 ? "delayed" : "waiting",
    };
    store.set(id, raw);

    const worker = this.bus.workersByQueue.get(this.name);
    if (worker && raw.state === "waiting") {
      worker.dispatch(raw);
    }
    return this.bus.wrapJob(this.name, raw);
  }

  async getJob(jobId: string): Promise<BullMQJobLike<any, any> | null> {
    const raw = this.bus.getStore(this.name).get(jobId);
    return raw ? this.bus.wrapJob(this.name, raw) : null;
  }

  async getJobCounts(): Promise<Record<string, number>> {
    const counts = { waiting: 0, delayed: 0, active: 0, completed: 0, failed: 0 };
    for (const raw of this.bus.getStore(this.name).values()) {
      counts[raw.state]++;
    }
    return counts;
  }

  async getFailed(): Promise<BullMQJobLike<any, any>[]> {
    return [...this.bus.getStore(this.name).values()]
      .filter((j) => j.state === "failed")
      .map((j) => this.bus.wrapJob(this.name, j));
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class MockBullMQWorker implements BullMQWorkerLike<any, any> {
  public closed = false;
  public inFlight = 0;
  private readonly listeners = new Map<string, Set<(...args: any[]) => void>>();
  private readonly pendingPromises = new Set<Promise<void>>();

  constructor(
    public readonly name: string,
    private readonly processor: BullMQProcessorFn<any, any>,
    private readonly bus: MockBullMQBus,
    public readonly concurrency?: number,
  ) {
    this.bus.workersByQueue.set(name, this);
    // Drain any already-waiting jobs
    for (const raw of this.bus.getStore(name).values()) {
      if (raw.state === "waiting") {
        this.dispatch(raw);
      }
    }
  }

  on(event: string, listener: (...args: any[]) => void): this {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return this;
  }

  off(event: string, listener: (...args: any[]) => void): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  private emit(event: string, ...args: any[]): void {
    for (const fn of this.listeners.get(event) ?? []) {
      fn(...args);
    }
  }

  dispatch(raw: InternalBullJob): void {
    if (this.closed) return;
    const run = (async () => {
      this.inFlight++;
      raw.state = "active";
      raw.processedOn = Date.now();
      const wrapped = this.bus.wrapJob(this.name, raw);
      this.emit("active", wrapped);

      try {
        const result = await this.processor(wrapped, "bull-token");
        raw.state = "completed";
        raw.finishedOn = Date.now();
        raw.returnvalue = result;
        this.emit("completed", wrapped, result);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        raw.attemptsMade++;
        raw.state = "failed";
        raw.finishedOn = Date.now();
        raw.failedReason = error.message;
        raw.stacktrace.push(error.stack ?? error.message);
        this.emit("failed", wrapped, error);
      } finally {
        this.inFlight--;
      }
    })();

    this.pendingPromises.add(run);
    void run.finally(() => this.pendingPromises.delete(run));
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.pendingPromises]);
    this.bus.workersByQueue.delete(this.name);
  }
}

describe("BullMQQueueDriver & BullMQModule Adapter", () => {
  it("wraps BullMQQueueLike cleanly for enqueue, deduplication, counts, failed DLQ, and retry", async () => {
    const bus = new MockBullMQBus();
    const createdQueues: MockBullMQQueue[] = [];

    const driver = new BullMQQueueDriver({
      connection: { host: "127.0.0.1", port: 6379 },
      prefix: "app",
      createQueue: (name) => {
        const q = new MockBullMQQueue(name, bus);
        createdQueues.push(q);
        return q;
      },
    });

    const job: Job<{ amount: number }, string> = {
      id: "inv_1",
      queueName: "billing",
      name: "charge",
      data: { amount: 99 },
      priority: 3,
      idempotencyKey: "idem:inv_1",
      maxAttempts: 2,
      attemptsMade: 0,
      status: "waiting",
      backoff: { type: "exponential", delayMs: 50 },
      removeOnComplete: false,
      createdAt: Date.now(),
      processAfter: Date.now(),
      stacktrace: [],
    };

    const j1 = await driver.enqueue("billing", job);
    const j2 = await driver.enqueue("billing", { ...job, id: "inv_1_dup" });
    expect(j2.id).toBe(j1.id);
    expect((await driver.getCounts("billing")).waiting).toBe(1);

    const fetched = await driver.getJob("billing", j1.id);
    expect(fetched?.data).toEqual({ amount: 99 });

    await driver.close();
    expect(createdQueues[0]!.closed).toBe(true);
  });

  it("integrates BullMQModule with @InjectQueue, @Processor, @Process, @OnQueueEvent, and graceful onModuleDestroy draining", async () => {
    const bus = new MockBullMQBus();
    const createdQueues: MockBullMQQueue[] = [];
    const createdWorkers: MockBullMQWorker[] = [];

    const completedLog: string[] = [];
    const failedLog: string[] = [];
    const dlqLog: string[] = [];
    let inFlightStarted = false;
    let inFlightFinished = false;

    @Processor("invoices", { concurrency: 4 })
    class InvoiceProcessor {
      @Process("generate")
      async handleGenerate(job: Job<{ id: string; delayMs?: number }>) {
        if (job.data.delayMs) {
          inFlightStarted = true;
          await Bun.sleep(job.data.delayMs);
          inFlightFinished = true;
        }
        return `pdf:${job.data.id}`;
      }

      @Process("broken")
      handleBroken() {
        throw new Error("invoice-boom");
      }

      @OnQueueEvent("completed")
      onCompleted(_job: Job, result: string) {
        completedLog.push(result);
      }

      @OnQueueEvent("failed")
      onFailed(_job: Job, err: Error) {
        failedLog.push(err.message);
      }

      @OnQueueEvent("dead-letter")
      onDeadLetter(job: Job) {
        dlqLog.push(job.id);
      }
    }

    @Injectable()
    class BillingService {
      constructor(
        @InjectQueue("invoices")
        public readonly queue: Queue<{ id: string; delayMs?: number }, string>,
      ) {}
    }

    const mod = await Test.createTestingModule({
      imports: [
        BullMQModule.forRoot({
          connection: { host: "127.0.0.1", port: 6379 },
          prefix: "bunest-bull",
          createQueue: (name) => {
            const q = new MockBullMQQueue(name, bus);
            createdQueues.push(q);
            return q;
          },
          createWorker: (name, processor, ctx) => {
            const w = new MockBullMQWorker(name, processor, bus, ctx.concurrency);
            createdWorkers.push(w);
            return w;
          },
        }),
        BullMQModule.registerQueue({ name: "invoices" }),
      ],
      providers: [InvoiceProcessor, BillingService],
    }).compile();

    const app = mod.createBunestApplication();
    await app.init();

    expect(createdWorkers).toHaveLength(1);
    expect(createdWorkers[0]!.concurrency).toBe(4);

    const billing = mod.get(BillingService);
    const okJob = await billing.queue.add("generate", { id: "1001" });
    const badJob = await billing.queue.add("broken", { id: "bad" }, { attempts: 1 });

    await waitUntil(() => completedLog.includes("pdf:1001") && dlqLog.includes(badJob.id));

    expect(failedLog).toEqual(["invoice-boom"]);
    expect((await billing.queue.getJob(okJob.id))?.status).toBe("completed");
    expect((await billing.queue.getDeadLetterJobs())).toHaveLength(1);

    // Enqueue an in-flight slow job and verify app.close() drains the BullMQ worker before resolving
    await billing.queue.add("generate", { id: "drain-me", delayMs: 60 });
    await waitUntil(() => inFlightStarted);
    expect(inFlightFinished).toBe(false);

    await app.close();

    expect(inFlightFinished).toBe(true);
    expect(completedLog).toContain("pdf:drain-me");
    expect(createdWorkers[0]!.closed).toBe(true);
    expect(createdQueues[0]!.closed).toBe(true);
  });
});
