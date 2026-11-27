import { afterEach, describe, expect, it } from "bun:test";
import { BunestFactory, Module } from "@bunest/core";
import {
  LUA_ACK_JOB,
  LUA_DEQUEUE_FAIR_JOB,
  LUA_DEQUEUE_JOB,
  LUA_ENQUEUE_JOB,
  LUA_NACK_OR_DLQ_JOB,
  LUA_RECLAIM_STALLED,
  LUA_RENEW_LEASE,
  MemoryQueueDriver,
  Process,
  Processor,
  Queue,
  QueueModule,
  RedisQueueDriver,
  getQueueToken,
  type Job,
  type RedisQueueClientLike,
} from "../../src";

/**
 * In-memory Redis mock supporting atomic execution of all RedisQueueDriver Lua
 * scripts including `LUA_DEQUEUE_FAIR_JOB` (per-group concurrency caps, fair
 * round-robin selection, and sliding-window rate limiting).
 */
class FairLuaMockRedisClient implements RedisQueueClientLike {
  public readonly hashes = new Map<string, Map<string, string>>();
  public readonly zsets = new Map<string, Map<string, number>>();
  public readonly sets = new Map<string, Set<string>>();
  public readonly lists = new Map<string, string[]>();
  public readonly strings = new Map<string, string>();
  public readonly executedScripts: string[] = [];

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

  async hincrby(
    key: string,
    field: string,
    increment: number,
  ): Promise<number> {
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
    for (let i = 0; i < list.length;) {
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

  private zscore(key: string, member: string): number | null {
    return this.zsets.get(key)?.get(member) ?? null;
  }

  private zremrangebyscore(key: string, min: number, max: number): number {
    const zset = this.zsets.get(key);
    if (!zset) return 0;
    let removed = 0;
    for (const [m, score] of [...zset.entries()]) {
      if (score >= min && score <= max) {
        zset.delete(m);
        removed++;
      }
    }
    return removed;
  }

  private async decrementGroupActive(
    groupActiveKey: string | undefined,
    groupId: string | undefined,
  ): Promise<void> {
    if (!groupActiveKey || !groupId) return;
    const curRaw = await this.hget(groupActiveKey, groupId);
    if (curRaw === null) return;
    const next = Number(curRaw) - 1;
    if (next <= 0) {
      await this.hdel(groupActiveKey, groupId);
    } else {
      await this.hset(groupActiveKey, groupId, String(next));
    }
  }

  async eval(
    script: string,
    numKeys: number,
    ...allArgs: Array<string | number>
  ): Promise<unknown> {
    const keys = allArgs.slice(0, numKeys).map(String);
    const argv = allArgs.slice(numKeys).map(String);

    if (script === LUA_ENQUEUE_JOB) {
      this.executedScripts.push("LUA_ENQUEUE_JOB");
      const [jobsKey, idempKey, waitingKey, delayedKey, seqKey, groupMapKey] =
        keys;
      const [
        jobId,
        jobJson,
        priorityRaw,
        processAfterRaw,
        nowRaw,
        idemp,
        _ttl,
        groupId,
      ] = argv;
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
      if (groupMapKey && groupId) {
        await this.hset(groupMapKey, jobId!, groupId);
      }
      if (idemp) await this.hset(idempKey!, idemp, jobId!);

      if (processAfter > now) {
        await this.zadd(delayedKey!, processAfter, jobId!);
      } else {
        const seq = await this.incr(seqKey!);
        await this.zadd(waitingKey!, -priority * 1_000_000_000 + seq, jobId!);
      }
      return [1, jobJson!];
    }

    if (script === LUA_DEQUEUE_FAIR_JOB) {
      this.executedScripts.push("LUA_DEQUEUE_FAIR_JOB");
      const [
        jobsKey,
        waitingKey,
        delayedKey,
        activeKey,
        leasesKey,
        seqKey,
        groupActiveKey,
        groupRrKey,
        groupRrSeqKey,
        groupMapKey,
        rateLimitKey,
      ] = keys;
      const [
        nowRaw,
        lockDurRaw,
        leaseToken,
        maxPerGroupRaw,
        groupOverridesJson,
        rateLimitMaxRaw,
        rateLimitDurationRaw,
      ] = argv;
      const now = Number(nowRaw) || 0;
      const lockDurationMs = Number(lockDurRaw) || 30000;
      const maxPerGroup = Number(maxPerGroupRaw) || 0;
      const rateLimitMax = Number(rateLimitMaxRaw) || 0;
      const rateLimitDurationMs = Number(rateLimitDurationRaw) || 0;

      // 1. Promote due delayed jobs
      const dueIds = await this.zrangebyscore(delayedKey!, "-inf", now);
      for (const dueId of dueIds) {
        if ((await this.zrem(delayedKey!, dueId)) > 0) {
          const raw = await this.hget(jobsKey!, dueId);
          if (raw) {
            const job = JSON.parse(raw) as Job;
            job.status = "waiting";
            await this.hset(jobsKey!, dueId, JSON.stringify(job));
            if (groupMapKey && job.groupId) {
              await this.hset(groupMapKey, dueId, job.groupId);
            }
            const seq = await this.incr(seqKey!);
            await this.zadd(
              waitingKey!,
              -(job.priority || 0) * 1_000_000_000 + seq,
              dueId,
            );
          }
        }
      }

      // 2. Rate limiter sliding window check
      if (rateLimitMax > 0 && rateLimitDurationMs > 0) {
        this.zremrangebyscore(
          rateLimitKey!,
          -Infinity,
          now - rateLimitDurationMs,
        );
        const used = await this.zcard(rateLimitKey!);
        if (used >= rateLimitMax) {
          const rlZset = this.zsets.get(rateLimitKey!);
          let oldestTs = now;
          if (rlZset && rlZset.size > 0) {
            const sorted = [...rlZset.entries()].sort((a, b) => a[1] - b[1]);
            oldestTs = sorted[0]![1];
          }
          return ["rate_limited", String(oldestTs + rateLimitDurationMs)];
        }
      }

      // 3. Select waiting job
      let selectedJobId: string | undefined;
      let selectedJob: Job | undefined;
      let selectedGroup = "";

      if (maxPerGroup <= 0) {
        while (true) {
          const candidates = await this.zrange(waitingKey!, 0, 0);
          if (candidates.length === 0) return null;
          const jobId = candidates[0]!;
          await this.zrem(waitingKey!, jobId);
          const raw = await this.hget(jobsKey!, jobId);
          if (raw) {
            selectedJobId = jobId;
            selectedJob = JSON.parse(raw) as Job;
            selectedGroup = selectedJob.groupId ?? "";
            break;
          }
        }
      } else {
        const overrides =
          groupOverridesJson && groupOverridesJson !== "{}"
            ? (JSON.parse(groupOverridesJson) as Record<string, number>)
            : {};
        const allWaiting = await this.zrange(waitingKey!, 0, -1);
        const seenGroup = new Set<string>();
        let bestJobId: string | undefined;
        let bestJob: Job | undefined;
        let bestGroup = "";
        let bestLastServed = Infinity;

        for (const jobId of allWaiting) {
          let gid: string | null = await this.hget(groupMapKey!, jobId);
          let raw: string | null = null;
          let decoded: Job | undefined;

          if (gid === null) {
            raw = await this.hget(jobsKey!, jobId);
            if (!raw) {
              await this.zrem(waitingKey!, jobId);
              continue;
            }
            decoded = JSON.parse(raw) as Job;
            gid = decoded.groupId ?? "";
          }

          if (seenGroup.has(gid)) {
            continue;
          }

          if (!raw) {
            raw = await this.hget(jobsKey!, jobId);
          }
          if (!raw) {
            await this.zrem(waitingKey!, jobId);
            continue;
          }
          if (!decoded) {
            decoded = JSON.parse(raw) as Job;
          }
          if (decoded.status !== "waiting") {
            await this.zrem(waitingKey!, jobId);
            continue;
          }

          seenGroup.add(gid);
          if (gid !== "") {
            const cap = Object.prototype.hasOwnProperty.call(overrides, gid)
              ? overrides[gid]!
              : maxPerGroup;
            const curActive = Number(
              (await this.hget(groupActiveKey!, gid)) ?? 0,
            );
            if (curActive >= cap) {
              continue;
            }
          }

          const lastServed = this.zscore(groupRrKey!, gid) ?? 0;
          if (lastServed < bestLastServed) {
            bestLastServed = lastServed;
            bestJobId = jobId;
            bestJob = decoded;
            bestGroup = gid;
            if (lastServed === 0) {
              break;
            }
          }
        }

        if (!bestJobId || !bestJob) {
          return null;
        }
        await this.zrem(waitingKey!, bestJobId);
        selectedJobId = bestJobId;
        selectedJob = bestJob;
        selectedGroup = bestGroup;
      }

      const leaseExpiresAt = now + lockDurationMs;
      selectedJob.status = "active";
      selectedJob.startedAt = now;
      selectedJob.leaseToken = leaseToken;
      selectedJob.leaseExpiresAt = leaseExpiresAt;
      const updated = JSON.stringify(selectedJob);
      await this.hset(jobsKey!, selectedJobId, updated);
      await this.zadd(activeKey!, leaseExpiresAt, selectedJobId);
      await this.hset(leasesKey!, selectedJobId, leaseToken!);

      if (selectedGroup !== "") {
        await this.hincrby(groupActiveKey!, selectedGroup, 1);
      }
      if (maxPerGroup > 0) {
        const rrSeq = await this.incr(groupRrSeqKey!);
        await this.zadd(groupRrKey!, rrSeq, selectedGroup);
      }
      if (rateLimitMax > 0 && rateLimitDurationMs > 0) {
        await this.zadd(
          rateLimitKey!,
          now,
          `${now}:${selectedJobId}:${leaseToken}`,
        );
      }

      return ["job", updated];
    }

    if (script === LUA_DEQUEUE_JOB) {
      this.executedScripts.push("LUA_DEQUEUE_JOB");
      const [jobsKey, waitingKey, delayedKey, activeKey, leasesKey, seqKey] =
        keys;
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
            await this.zadd(
              waitingKey!,
              -(job.priority || 0) * 1_000_000_000 + seq,
              dueId,
            );
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
          job.status = "active";
          job.startedAt = now;
          job.leaseToken = leaseToken;
          job.leaseExpiresAt = now + lockDurationMs;
          const updated = JSON.stringify(job);
          await this.hset(jobsKey!, jobId, updated);
          await this.zadd(activeKey!, job.leaseExpiresAt, jobId);
          await this.hset(leasesKey!, jobId, leaseToken!);
          return updated;
        }
      }
    }

    if (script === LUA_ACK_JOB) {
      this.executedScripts.push("LUA_ACK_JOB");
      const [
        jobsKey,
        activeKey,
        leasesKey,
        stalledKey,
        completedKey,
        idempKey,
        groupActiveKey,
        groupMapKey,
      ] = keys;
      const [
        jobId,
        resultJson,
        hasResult,
        finishedAtRaw,
        expectedToken,
        pruneIdempotency,
      ] = argv;
      if (expectedToken) {
        const cur = await this.hget(leasesKey!, jobId!);
        if (!cur || cur !== expectedToken) return null;
      }
      const wasActive = await this.zrem(activeKey!, jobId!);
      await this.hdel(leasesKey!, jobId!);
      await this.hdel(stalledKey!, jobId!);
      const raw = await this.hget(jobsKey!, jobId!);
      if (!raw) return null;
      const job = JSON.parse(raw) as Job;
      if (wasActive > 0) {
        await this.decrementGroupActive(groupActiveKey, job.groupId);
      }
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
        if (groupMapKey) await this.hdel(groupMapKey, jobId!);
      } else {
        await this.hset(jobsKey!, jobId!, updated);
      }
      if (
        idempKey &&
        job.idempotencyKey &&
        (job.removeOnComplete || pruneIdempotency === "1")
      ) {
        await this.hdel(idempKey, job.idempotencyKey);
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
        idempKey,
        groupActiveKey,
      ] = keys;
      const [
        jobId,
        errorMessage,
        errorStack,
        nowRaw,
        retryAtRaw,
        forceDlq,
        expectedToken,
        pruneIdempotency,
      ] = argv;
      const now = Number(nowRaw) || 0;
      if (expectedToken) {
        const cur = await this.hget(leasesKey!, jobId!);
        if (!cur || cur !== expectedToken) return null;
      }
      const wasActive = await this.zrem(activeKey!, jobId!);
      await this.zrem(delayedKey!, jobId!);
      await this.zrem(waitingKey!, jobId!);
      await this.hdel(leasesKey!, jobId!);
      const raw = await this.hget(jobsKey!, jobId!);
      if (!raw) return null;
      const job = JSON.parse(raw) as Job;
      if (wasActive > 0) {
        await this.decrementGroupActive(groupActiveKey, job.groupId);
      }
      job.attemptsMade = (job.attemptsMade || 0) + 1;
      job.failedReason = errorMessage;
      delete job.leaseToken;
      delete job.leaseExpiresAt;
      job.stacktrace.push(errorStack || errorMessage!);

      const moveToDlq =
        forceDlq === "1" ||
        (!retryAtRaw && job.attemptsMade >= job.maxAttempts);
      if (moveToDlq) {
        await this.hdel(stalledKey!, jobId!);
        job.status = "dead-letter";
        job.finishedAt = now;
        await this.incr(failedKey!);
        const updated = JSON.stringify(job);
        await this.hset(jobsKey!, jobId!, updated);
        await this.rpush(dlqKey!, jobId!);
        if (pruneIdempotency === "1" && idempKey && job.idempotencyKey) {
          await this.hdel(idempKey, job.idempotencyKey);
        }
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
      const cur = await this.hget(leasesKey!, jobId!);
      if (!cur || cur !== token) return 0;
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
        _idempKey,
        groupActiveKey,
      ] = keys;
      const [nowRaw, maxStalledRaw] = argv;
      const now = Number(nowRaw) || 0;
      const maxStalledCount = Number(maxStalledRaw) || 1;
      const expiredIds = await this.zrangebyscore(activeKey!, "-inf", now);
      const reclaimed: string[] = [];
      const deadLettered: string[] = [];
      for (const jobId of expiredIds) {
        const wasActive = await this.zrem(activeKey!, jobId);
        await this.hdel(leasesKey!, jobId);
        const raw = await this.hget(jobsKey!, jobId);
        if (!raw) continue;
        const job = JSON.parse(raw) as Job;
        if (wasActive > 0) {
          await this.decrementGroupActive(groupActiveKey, job.groupId);
        }
        const stalled = await this.hincrby(stalledKey!, jobId, 1);
        job.stalledCount = stalled;
        delete job.leaseToken;
        delete job.leaseExpiresAt;
        if (stalled > maxStalledCount) {
          await this.hdel(stalledKey!, jobId);
          job.status = "dead-letter";
          job.finishedAt = now;
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

    throw new Error(`Unexpected Lua script: ${script.slice(0, 60)}`);
  }
}

async function waitUntil(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
}

describe("Tenant-Aware Fair groupConcurrency & Enforced Rate Limiter", () => {
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

  describe("MemoryQueueDriver — groupConcurrency & fair round-robin", () => {
    it("prevents noisy-neighbor starvation (20 jobs from tenant A cannot starve tenant B when maxPerGroup: 1, concurrency: 2)", async () => {
      const driver = new MemoryQueueDriver();
      drivers.push(driver);

      const queue = new Queue<{ tenant: string; idx: number }>({
        name: "fair-mem",
        driver,
        concurrency: 2,
        groupConcurrency: { maxPerGroup: 1 },
      });
      queues.push(queue);

      // Enqueue 20 jobs for tenant A first, then 4 for tenant B (using tenantId alias)
      for (let i = 0; i < 20; i++) {
        await queue.add(
          "work",
          { tenant: "tenant-a", idx: i },
          { groupId: "tenant-a" },
        );
      }
      for (let i = 0; i < 4; i++) {
        await queue.add(
          "work",
          { tenant: "tenant-b", idx: i },
          { tenantId: "tenant-b" },
        );
      }

      const activePerTenant = new Map<string, number>();
      const peakPerTenant = new Map<string, number>();
      let globalActive = 0;
      let peakGlobal = 0;
      const completionOrder: string[] = [];

      queue.process(async (job) => {
        const tenant = job.groupId!;
        globalActive++;
        peakGlobal = Math.max(peakGlobal, globalActive);
        const cur = (activePerTenant.get(tenant) ?? 0) + 1;
        activePerTenant.set(tenant, cur);
        peakPerTenant.set(tenant, Math.max(peakPerTenant.get(tenant) ?? 0, cur));

        await Bun.sleep(10);

        activePerTenant.set(tenant, (activePerTenant.get(tenant) ?? 1) - 1);
        globalActive--;
        completionOrder.push(tenant);
      });

      await waitUntil(() => completionOrder.length === 24);

      // Global concurrency reached 2, yet neither tenant EVER exceeded 1 concurrent job
      expect(peakGlobal).toBe(2);
      expect(peakPerTenant.get("tenant-a")).toBe(1);
      expect(peakPerTenant.get("tenant-b")).toBe(1);

      // Tenant B MUST NOT be starved behind tenant A's 20 jobs:
      // all 4 tenant-b jobs complete within the first 10 completions!
      const lastBIndex = completionOrder.lastIndexOf("tenant-b");
      expect(lastBIndex).toBeGreaterThanOrEqual(3);
      expect(lastBIndex).toBeLessThan(10);
    });

    it("enforces fair round-robin interleaving across tenants even at concurrency: 1 and respects overrides", async () => {
      const driver = new MemoryQueueDriver();
      drivers.push(driver);

      const rrQueue = new Queue<{ tenant: string }>({
        name: "rr-seq",
        driver,
        concurrency: 1,
        groupConcurrency: 1,
      });
      queues.push(rrQueue);

      for (let i = 0; i < 4; i++) {
        await rrQueue.add("task", { tenant: "A" }, { groupId: "A" });
      }
      for (let i = 0; i < 2; i++) {
        await rrQueue.add("task", { tenant: "B" }, { groupId: "B" });
      }
      await rrQueue.add("task", { tenant: "C" }, { groupId: "C" });

      const order: string[] = [];
      rrQueue.process(async (job) => {
        order.push(job.data.tenant);
      });

      await waitUntil(() => order.length === 7);
      // First round serves A, B, C; second round serves A, B; remaining A, A
      expect(order.slice(0, 3)).toEqual(["A", "B", "C"]);
      expect(order.slice(3, 5)).toEqual(["A", "B"]);
      expect(order.slice(5)).toEqual(["A", "A"]);

      // Overrides test: enterprise capped at 3, free capped at 1, prototype-key safe ("constructor")
      const overrideQueue = new Queue<{ tenant: string }>({
        name: "override-mem",
        driver,
        concurrency: 4,
        groupConcurrency: {
          maxPerGroup: 1,
          overrides: { enterprise: 3 },
        },
      });
      queues.push(overrideQueue);

      for (let i = 0; i < 6; i++) {
        await overrideQueue.add(
          "work",
          { tenant: "enterprise" },
          { groupId: "enterprise" },
        );
      }
      for (let i = 0; i < 3; i++) {
        await overrideQueue.add("work", { tenant: "free" }, { groupId: "free" });
      }
      for (let i = 0; i < 2; i++) {
        await overrideQueue.add(
          "work",
          { tenant: "constructor" },
          { groupId: "constructor" },
        );
      }

      const active = new Map<string, number>();
      const peak = new Map<string, number>();
      let done = 0;

      overrideQueue.process(async (job) => {
        const t = job.groupId!;
        const c = (active.get(t) ?? 0) + 1;
        active.set(t, c);
        peak.set(t, Math.max(peak.get(t) ?? 0, c));
        await Bun.sleep(25);
        active.set(t, (active.get(t) ?? 1) - 1);
        done++;
      });

      await waitUntil(() => done === 11);
      expect(peak.get("enterprise")).toBe(3);
      expect(peak.get("free")).toBe(1);
      expect(peak.get("constructor")).toBe(1);
    });
  });

  describe("MemoryQueueDriver — enforced sliding-window rate limiter", () => {
    it("defers jobs cleanly when limiter { max, durationMs } is reached and executes via @Processor workerOptions.limiter", async () => {
      const startedAt: number[] = [];

      @Processor("rate-limited", {
        concurrency: 4,
        limiter: { max: 2, duration: 80 },
      })
      class LimitedProcessor {
        @Process()
        async handle() {
          startedAt.push(Date.now());
        }
      }

      @Module({
        imports: [
          QueueModule.forRoot(),
          QueueModule.registerQueue({ name: "rate-limited" }),
        ],
        providers: [LimitedProcessor],
      })
      class AppModule {}

      const app = await BunestFactory.createApplicationContext(AppModule);
      try {
        const queue = app.get<Queue<unknown>>(getQueueToken("rate-limited"));
        for (let i = 0; i < 5; i++) {
          await queue.add("ping", { i });
        }

        await waitUntil(() => startedAt.length === 5, 4000);

        // Jobs 0,1 run in window 1; jobs 2,3 wait >= ~70ms; job 4 waits another >= ~70ms
        expect(startedAt[2]! - startedAt[0]!).toBeGreaterThanOrEqual(65);
        expect(startedAt[4]! - startedAt[2]!).toBeGreaterThanOrEqual(65);
      } finally {
        await app.close();
      }
    });
  });

  describe("RedisQueueDriver (Atomic Lua) — fair groupConcurrency & rate limiter", () => {
    it("exports LUA_DEQUEUE_FAIR_JOB with real atomic Redis Lua primitives", () => {
      expect(LUA_DEQUEUE_FAIR_JOB).toContain("ZREMRANGEBYSCORE");
      expect(LUA_DEQUEUE_FAIR_JOB).toContain("HINCRBY");
      expect(LUA_DEQUEUE_FAIR_JOB).toContain("ZSCORE");
      expect(LUA_DEQUEUE_FAIR_JOB).toContain("rate_limited");
      expect(LUA_DEQUEUE_FAIR_JOB).toContain("KEYS[11]");
      expect(LUA_DEQUEUE_FAIR_JOB).toContain("ARGV[7]");
    });

    it("prevents noisy-neighbor starvation, enforces overrides, and cleans up groupActive via atomic Lua scripts", async () => {
      const redis = new FairLuaMockRedisClient();
      const driver = new RedisQueueDriver(redis, {
        prefix: "fairlua",
        stalledIntervalMs: 0,
      });
      drivers.push(driver);

      const queue = new Queue<{ tenant: string; i: number }>({
        name: "fair-redis",
        driver,
        concurrency: 2,
        groupConcurrency: { maxPerGroup: 1 },
        pollIntervalMs: 10,
      });
      queues.push(queue);

      for (let i = 0; i < 20; i++) {
        await queue.add(
          "job",
          { tenant: "tenant-a", i },
          { groupId: "tenant-a" },
        );
      }
      for (let i = 0; i < 4; i++) {
        await queue.add(
          "job",
          { tenant: "tenant-b", i },
          { tenantId: "tenant-b" },
        );
      }

      const activeByTenant = new Map<string, number>();
      const peakByTenant = new Map<string, number>();
      const finished: string[] = [];

      queue.process(async (job) => {
        const t = job.groupId!;
        const c = (activeByTenant.get(t) ?? 0) + 1;
        activeByTenant.set(t, c);
        peakByTenant.set(t, Math.max(peakByTenant.get(t) ?? 0, c));
        await Bun.sleep(10);
        activeByTenant.set(t, (activeByTenant.get(t) ?? 1) - 1);
        finished.push(t);
      });

      await waitUntil(() => finished.length === 24);

      expect(redis.executedScripts).toContain("LUA_DEQUEUE_FAIR_JOB");
      expect(peakByTenant.get("tenant-a")).toBe(1);
      expect(peakByTenant.get("tenant-b")).toBe(1);
      // Tenant B completes early instead of waiting behind all 20 tenant-a jobs
      expect(finished.lastIndexOf("tenant-b")).toBeLessThan(10);

      // Verify groupActive hash is completely cleaned up once all jobs ack
      const groupActiveHash = redis.hashes.get(
        "fairlua:fair-redis:group:active",
      );
      expect(groupActiveHash?.size ?? 0).toBe(0);
    });

    it("enforces per-group overrides & decrements groupActive on nack/DLQ/stalled reclaim in Lua", async () => {
      const redis = new FairLuaMockRedisClient();
      const driver = new RedisQueueDriver(redis, {
        prefix: "overlua",
        lockDurationMs: 50,
        stalledIntervalMs: 0,
        maxStalledCount: 2,
      });
      drivers.push(driver);

      const now = 10_000;
      const mkJob = (id: string, groupId: string): Job => ({
        id,
        queueName: "q",
        name: "work",
        data: {},
        priority: 0,
        groupId,
        maxAttempts: 2,
        attemptsMade: 0,
        status: "waiting",
        removeOnComplete: false,
        createdAt: now,
        processAfter: now,
        stacktrace: [],
      });

      await driver.enqueue("q", mkJob("e1", "enterprise"));
      await driver.enqueue("q", mkJob("e2", "enterprise"));
      await driver.enqueue("q", mkJob("e3", "enterprise"));
      await driver.enqueue("q", mkJob("f1", "free"));
      await driver.enqueue("q", mkJob("f2", "free"));

      const opts = {
        groupConcurrency: { maxPerGroup: 1, overrides: { enterprise: 2 } },
      };

      const d1 = await driver.dequeue("q", now, opts);
      const d2 = await driver.dequeue("q", now, opts);
      const d3 = await driver.dequeue("q", now, opts);
      // Now enterprise has 2 active (at cap) and free has 1 active (at cap) -> 4th dequeue returns null!
      const d4 = await driver.dequeue("q", now, opts);

      expect([d1?.groupId, d2?.groupId, d3?.groupId].sort()).toEqual([
        "enterprise",
        "enterprise",
        "free",
      ]);
      expect(d4).toBeNull();

      // Reclaim stalled jobs after lease expires -> groupActive drops to 0 and jobs can be dequeued again
      const sweep = await driver.reclaimStalledJobs("q", now + 100);
      expect(sweep.reclaimed).toHaveLength(3);
      expect(redis.hashes.get("overlua:q:group:active")?.size ?? 0).toBe(0);

      const d5 = await driver.dequeue("q", now + 100, opts);
      expect(d5).not.toBeNull();
      // Nack -> DLQ also decrements groupActive back to 0
      await driver.moveToDeadLetter("q", d5!.id, "boom", d5!.leaseToken);
      expect(redis.hashes.get("overlua:q:group:active")?.size ?? 0).toBe(0);
    });

    it("enforces atomic Lua sliding-window rate limiter in RedisQueueDriver", async () => {
      const redis = new FairLuaMockRedisClient();
      const driver = new RedisQueueDriver(redis, {
        prefix: "rllua",
        stalledIntervalMs: 0,
      });
      drivers.push(driver);

      const queue = new Queue<{ idx: number }>({
        name: "rl-redis",
        driver,
        concurrency: 4,
        limiter: { max: 2, durationMs: 80 },
        pollIntervalMs: 250, // Intentionally high poll to prove exact rate-limit timer wakeup!
      });
      queues.push(queue);

      const startedAt: number[] = [];
      for (let i = 0; i < 5; i++) {
        await queue.add("run", { idx: i });
      }

      queue.process(async () => {
        startedAt.push(Date.now());
      });

      await waitUntil(() => startedAt.length === 5, 4000);
      expect(redis.executedScripts).toContain("LUA_DEQUEUE_FAIR_JOB");
      expect(startedAt[2]! - startedAt[0]!).toBeGreaterThanOrEqual(65);
      expect(startedAt[4]! - startedAt[2]!).toBeGreaterThanOrEqual(65);
    });

    it("also enforces groupConcurrency and limiter in RedisQueueDriver non-Lua fallback mode", async () => {
      const redis = new FairLuaMockRedisClient();
      (redis as { eval?: unknown }).eval = undefined;
      const driver = new RedisQueueDriver(redis, {
        prefix: "fallbackfair",
        stalledIntervalMs: 0,
      });
      drivers.push(driver);
      expect(driver.isAtomicLuaEnabled).toBe(false);

      const queue = new Queue<{ tenant: string }>({
        name: "fb-redis",
        driver,
        concurrency: 2,
        groupConcurrency: { maxPerGroup: 1 },
        limiter: { max: 2, durationMs: 60 },
        pollIntervalMs: 10,
      });
      queues.push(queue);

      for (let i = 0; i < 4; i++) {
        await queue.add(
          "work",
          { tenant: "a" },
          { groupId: "a", removeOnComplete: true },
        );
      }
      await queue.add(
        "work",
        { tenant: "b" },
        { groupId: "b", removeOnComplete: true },
      );

      const activePerTenant = new Map<string, number>();
      const peakPerTenant = new Map<string, number>();
      const startedAt: number[] = [];
      const order: string[] = [];

      queue.process(async (job) => {
        startedAt.push(Date.now());
        const t = job.groupId!;
        const c = (activePerTenant.get(t) ?? 0) + 1;
        activePerTenant.set(t, c);
        peakPerTenant.set(t, Math.max(peakPerTenant.get(t) ?? 0, c));
        await Bun.sleep(10);
        activePerTenant.set(t, (activePerTenant.get(t) ?? 1) - 1);
        order.push(t);
      });

      await waitUntil(() => order.length === 5, 4000);
      expect(peakPerTenant.get("a")).toBe(1);
      expect(peakPerTenant.get("b")).toBe(1);
      expect(order.indexOf("b")).toBeLessThan(3);
      expect(startedAt[2]! - startedAt[0]!).toBeGreaterThanOrEqual(50);
      // Verify fallback ack() prunes group:map entries when removeOnComplete is true
      expect(
        redis.hashes.get("fallbackfair:fb-redis:group:map")?.size ?? 0,
      ).toBe(0);
    });
  });
});
