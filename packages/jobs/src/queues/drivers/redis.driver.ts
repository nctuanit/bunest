import type {
  Job,
  JobStatus,
  QueueCounts,
  QueueDequeueOptions,
  QueueDriver,
  ReclaimStalledResult,
} from "../interfaces";
import {
  normalizeGroupConcurrency,
  normalizeRateLimiter,
  resolveGroupCap,
} from "../queue-policy";
import {
  createBunRedisQueueClient,
  type RedisQueueClientLike,
} from "./bun-redis.adapter";
import {
  LUA_ACK_JOB,
  LUA_DEQUEUE_FAIR_JOB,
  LUA_DEQUEUE_JOB,
  LUA_ENQUEUE_JOB,
  LUA_NACK_OR_DLQ_JOB,
  LUA_RECLAIM_STALLED,
  LUA_RENEW_LEASE,
} from "./redis-lua.scripts";

export type { RedisQueueClientLike };

export interface RedisQueueDriverOptions {
  readonly prefix?: string;
  /**
   * Duration in milliseconds that an active job's worker lease remains valid
   * before being considered stalled.
   * @default 30000
   */
  readonly lockDurationMs?: number;
  /**
   * Periodic interval in milliseconds for automatic stalled-job sweeping.
   * Set to `0` to disable the background timer (`reclaimStalledJobs()` can
   * still be invoked manually).
   * @default 30000
   */
  readonly stalledIntervalMs?: number;
  /**
   * Maximum number of times a job may stall before being moved to the DLQ.
   * @default 1
   */
  readonly maxStalledCount?: number;
  /**
   * Optional TTL in milliseconds applied to the queue's `idempotency` hash via
   * `PEXPIRE` so idle idempotency entries do not live forever. Set to `0` to
   * disable hash-level expiration.
   * @default 86400000 (24 hours)
   */
  readonly idempotencyTtlMs?: number;
  /**
   * Remove a job's `idempotencyKey` entry from the `idempotency` hash once the
   * job reaches a terminal state (completed, failed, or dead-lettered) so the
   * hash stays bounded under continuous traffic.
   * @default true
   */
  readonly pruneIdempotencyOnTerminal?: boolean;
  /**
   * Optional callback notified whenever stalled jobs are reclaimed or moved to DLQ.
   */
  readonly onStalledReclaimed?: (
    queueName: string,
    result: ReclaimStalledResult,
  ) => void;
}

function formatError(error: Error | string): {
  message: string;
  stack?: string;
} {
  if (typeof error === "string") {
    return { message: error };
  }
  return {
    message: error.message || String(error),
    stack: error.stack,
  };
}

function unrefTimer(timer: ReturnType<typeof setInterval>): void {
  if (typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as { unref: () => void }).unref();
  }
}

/**
 * Redis-backed `QueueDriver` compatible with BullMQ-style key layouts:
 * - Hash `jobs` stores serialized job JSON
 * - Hash `idempotency` maps idempotency keys to job IDs
 * - ZSET `waiting` orders by descending priority + FIFO sequence
 * - ZSET `delayed` orders by `processAfter` epoch timestamp
 * - ZSET `active` (Lua mode, score = `leaseExpiresAt`) or SET `active` (fallback mode)
 * - Hash `leases` maps active job IDs to worker lease tokens (Lua mode)
 * - Hash `stalled` tracks per-job stalled counts (Lua mode)
 * - LIST `dlq` stores dead-letter job IDs
 */
export class RedisQueueDriver implements QueueDriver {
  public readonly lockDurationMs: number;
  public readonly stalledIntervalMs: number;
  public readonly maxStalledCount: number;
  public readonly idempotencyTtlMs: number;
  public readonly pruneIdempotencyOnTerminal: boolean;

  private readonly prefix: string;
  private readonly useLua: boolean;
  private readonly onStalledReclaimed?: (
    queueName: string,
    result: ReclaimStalledResult,
  ) => void;

  private readonly scriptShas = new Map<string, string>();
  private readonly knownQueues = new Set<string>();
  private readonly jobQueueIndex = new Map<string, string>();
  private readonly activeTokens = new Map<string, string>();
  private readonly nextRateLimitAt = new Map<string, number>();
  private readonly fallbackActiveByGroup = new Map<string, Map<string, number>>();
  private readonly fallbackGroupLastServed = new Map<
    string,
    Map<string, number>
  >();
  private readonly fallbackRrTick = new Map<string, number>();
  private readonly fallbackRateLimitTimestamps = new Map<string, number[]>();
  private readonly stalledListeners = new Map<
    string,
    Set<(result: ReclaimStalledResult) => void>
  >();

  private stalledTimer: ReturnType<typeof setInterval> | undefined;
  private sweeping = false;
  private closed = false;

  private readonly nativeRedis?: Bun.RedisClient;
  private readonly redis: RedisQueueClientLike;

  constructor(
    redis: RedisQueueClientLike | Bun.RedisClient | string,
    options: RedisQueueDriverOptions = {},
  ) {
    if (typeof redis === "string") {
      const client = new Bun.RedisClient(redis);
      this.nativeRedis = client;
      this.redis = createBunRedisQueueClient(client);
    } else if (redis instanceof Bun.RedisClient) {
      this.nativeRedis = redis;
      this.redis = createBunRedisQueueClient(redis);
    } else {
      this.redis = redis;
    }
    this.prefix = options.prefix ?? "bunest:queue";
    this.lockDurationMs = Math.max(
      10,
      Math.floor(options.lockDurationMs ?? 30_000),
    );
    this.stalledIntervalMs = Math.max(
      0,
      Math.floor(options.stalledIntervalMs ?? 30_000),
    );
    this.maxStalledCount = Math.max(
      0,
      Math.floor(options.maxStalledCount ?? 1),
    );
    this.idempotencyTtlMs = Math.max(
      0,
      Math.floor(options.idempotencyTtlMs ?? 86_400_000),
    );
    this.pruneIdempotencyOnTerminal =
      options.pruneIdempotencyOnTerminal ?? true;
    this.onStalledReclaimed = options.onStalledReclaimed;
    this.useLua =
      typeof this.redis.eval === "function" ||
      (typeof this.redis.evalsha === "function" &&
        typeof this.redis.scriptLoad === "function");
  }

  /**
   * Health probe verifying that the underlying Redis connection is reachable.
   */
  async ping(): Promise<boolean> {
    if (this.closed) {
      return false;
    }
    try {
      if (this.nativeRedis) {
        const res = await this.nativeRedis.send("PING", []);
        return res === "PONG" || res === true;
      }
      const maybePing = (
        this.redis as { ping?: () => Promise<unknown> }
      ).ping;
      if (typeof maybePing === "function") {
        const res = await maybePing.call(this.redis);
        return res === "PONG" || res === true || res === undefined;
      }
      await this.redis.get(`${this.prefix}:__ping__`);
      return true;
    } catch {
      return false;
    }
  }

  private parseJob<TData = unknown, TResult = unknown>(
    raw: string,
  ): Job<TData, TResult> {
    const job = JSON.parse(raw) as Job<TData, TResult>;
    if (!Array.isArray(job.stacktrace)) {
      (job as { stacktrace: string[] }).stacktrace = [];
    }
    return job;
  }

  /**
   * Returns `true` when the underlying Redis client supports atomic Lua execution.
   */
  get isAtomicLuaEnabled(): boolean {
    return this.useLua;
  }

  private keys(queueName: string) {
    const base = `${this.prefix}:${queueName}`;
    return {
      jobs: `${base}:jobs`,
      idempotency: `${base}:idempotency`,
      waiting: `${base}:waiting`,
      delayed: `${base}:delayed`,
      active: `${base}:active`,
      leases: `${base}:leases`,
      stalled: `${base}:stalled`,
      dlq: `${base}:dlq`,
      seq: `${base}:seq`,
      completedCount: `${base}:completed`,
      failedCount: `${base}:failed`,
      groupActive: `${base}:group:active`,
      groupRr: `${base}:group:rr`,
      groupRrSeq: `${base}:group:rr_seq`,
      groupMap: `${base}:group:map`,
      rateLimit: `${base}:ratelimit`,
    };
  }

  private trackQueue(queueName: string): void {
    this.knownQueues.add(queueName);
    if (
      this.useLua &&
      !this.closed &&
      this.stalledIntervalMs > 0 &&
      this.stalledTimer === undefined
    ) {
      this.startStalledSweep();
    }
  }

  private tokenKey(queueName: string, jobId: string): string {
    return `${queueName}\0${jobId}`;
  }

  private async runLua(
    script: string,
    keys: readonly string[],
    args: ReadonlyArray<string | number>,
  ): Promise<unknown> {
    if (
      typeof this.redis.evalsha === "function" &&
      typeof this.redis.scriptLoad === "function"
    ) {
      let sha = this.scriptShas.get(script);
      if (!sha) {
        sha = await this.redis.scriptLoad(script);
        this.scriptShas.set(script, sha);
      }
      try {
        return await this.redis.evalsha(sha, keys.length, ...keys, ...args);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("NOSCRIPT")) {
          throw err;
        }
        this.scriptShas.delete(script);
        if (typeof this.redis.eval === "function") {
          return await this.redis.eval(script, keys.length, ...keys, ...args);
        }
        const reloaded = await this.redis.scriptLoad(script);
        this.scriptShas.set(script, reloaded);
        return await this.redis.evalsha(
          reloaded,
          keys.length,
          ...keys,
          ...args,
        );
      }
    }

    if (typeof this.redis.eval === "function") {
      return await this.redis.eval(script, keys.length, ...keys, ...args);
    }

    throw new Error("Redis client does not support eval/evalsha.");
  }

  onStalled(
    queueName: string,
    listener: (result: ReclaimStalledResult) => void,
  ): () => void {
    this.trackQueue(queueName);
    let set = this.stalledListeners.get(queueName);
    if (!set) {
      set = new Set();
      this.stalledListeners.set(queueName, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
    };
  }

  startStalledSweep(): void {
    if (this.closed || !this.useLua || this.stalledIntervalMs <= 0) {
      return;
    }
    if (this.stalledTimer !== undefined) {
      return;
    }
    this.stalledTimer = setInterval(() => {
      if (this.sweeping || this.closed) {
        return;
      }
      this.sweeping = true;
      void this.reclaimStalledJobs()
        .catch(() => {
          // Never allow background stalled sweeps to cause unhandled rejections
        })
        .finally(() => {
          this.sweeping = false;
        });
    }, this.stalledIntervalMs);
    unrefTimer(this.stalledTimer);
  }

  stopStalledSweep(): void {
    if (this.stalledTimer !== undefined) {
      clearInterval(this.stalledTimer);
      this.stalledTimer = undefined;
    }
  }

  async enqueue<TData = unknown, TResult = unknown>(
    queueName: string,
    job: Job<TData, TResult>,
  ): Promise<Job<TData, TResult>> {
    this.trackQueue(queueName);
    const k = this.keys(queueName);

    if (this.useLua) {
      const now = Date.now();
      job.status = job.processAfter > now ? "delayed" : "waiting";
      const serialized = JSON.stringify(job);
      const rawResult = await this.runLua(
        LUA_ENQUEUE_JOB,
        [k.jobs, k.idempotency, k.waiting, k.delayed, k.seq, k.groupMap],
        [
          job.id,
          serialized,
          job.priority,
          job.processAfter,
          now,
          job.idempotencyKey ?? "",
          this.idempotencyTtlMs,
          job.groupId ?? "",
        ],
      );
      if (Array.isArray(rawResult) && typeof rawResult[1] === "string") {
        const stored = this.parseJob<TData, TResult>(rawResult[1]);
        this.jobQueueIndex.set(stored.id, queueName);
        return stored;
      }
      this.jobQueueIndex.set(job.id, queueName);
      return job;
    }

    if (job.idempotencyKey !== undefined) {
      const existingId = await this.redis.hget(
        k.idempotency,
        job.idempotencyKey,
      );
      if (existingId) {
        const existing = await this.getJob<TData, TResult>(
          queueName,
          existingId,
        );
        if (existing) {
          return existing;
        }
        await this.redis.hdel(k.idempotency, job.idempotencyKey);
      }
    }

    const existingRaw = await this.redis.hget(k.jobs, job.id);
    if (existingRaw) {
      return this.parseJob<TData, TResult>(existingRaw);
    }

    const now = Date.now();
    if (job.processAfter > now) {
      job.status = "delayed";
      await this.redis.hset(k.jobs, job.id, JSON.stringify(job));
      await this.redis.zadd(k.delayed, job.processAfter, job.id);
    } else {
      job.status = "waiting";
      await this.redis.hset(k.jobs, job.id, JSON.stringify(job));
      await this.addToWaitingSet(queueName, job);
    }

    if (job.groupId) {
      await this.redis.hset(k.groupMap, job.id, job.groupId);
    }

    if (job.idempotencyKey !== undefined) {
      await this.redis.hset(k.idempotency, job.idempotencyKey, job.id);
    }

    this.jobQueueIndex.set(job.id, queueName);
    return job;
  }

  async dequeue<TData = unknown, TResult = unknown>(
    queueName: string,
    now: number = Date.now(),
    options?: QueueDequeueOptions,
  ): Promise<Job<TData, TResult> | null> {
    this.trackQueue(queueName);
    const k = this.keys(queueName);
    const groupPolicy = normalizeGroupConcurrency(options?.groupConcurrency);
    const limiter = normalizeRateLimiter(options?.limiter);

    if (this.useLua) {
      const leaseToken = crypto.randomUUID();
      if (!groupPolicy && !limiter) {
        const raw = await this.runLua(
          LUA_DEQUEUE_JOB,
          [k.jobs, k.waiting, k.delayed, k.active, k.leases, k.seq],
          [now, this.lockDurationMs, leaseToken],
        );
        if (typeof raw !== "string" || raw.length === 0) {
          return null;
        }
        const job = this.parseJob<TData, TResult>(raw);
        this.jobQueueIndex.set(job.id, queueName);
        if (job.leaseToken) {
          this.activeTokens.set(
            this.tokenKey(queueName, job.id),
            job.leaseToken,
          );
        }
        return job;
      }

      const overridesJson =
        groupPolicy && Object.keys(groupPolicy.overrides).length > 0
          ? JSON.stringify(groupPolicy.overrides)
          : "{}";
      const res = await this.runLua(
        LUA_DEQUEUE_FAIR_JOB,
        [
          k.jobs,
          k.waiting,
          k.delayed,
          k.active,
          k.leases,
          k.seq,
          k.groupActive,
          k.groupRr,
          k.groupRrSeq,
          k.groupMap,
          k.rateLimit,
        ],
        [
          now,
          this.lockDurationMs,
          leaseToken,
          groupPolicy?.maxPerGroup ?? 0,
          overridesJson,
          limiter?.max ?? 0,
          limiter?.durationMs ?? 0,
        ],
      );

      if (!Array.isArray(res) || res.length < 2) {
        return null;
      }
      if (res[0] === "rate_limited") {
        const nextAt = Number(res[1]);
        if (Number.isFinite(nextAt)) {
          this.nextRateLimitAt.set(queueName, nextAt);
        }
        return null;
      }
      if (res[0] !== "job" || typeof res[1] !== "string" || res[1].length === 0) {
        return null;
      }

      this.nextRateLimitAt.delete(queueName);
      const job = this.parseJob<TData, TResult>(res[1]);
      this.jobQueueIndex.set(job.id, queueName);
      if (job.leaseToken) {
        this.activeTokens.set(this.tokenKey(queueName, job.id), job.leaseToken);
      }
      return job;
    }

    await this.promoteReadyDelayed(queueName, now);

    if (limiter) {
      const timestamps = this.pruneFallbackRateLimit(
        queueName,
        now,
        limiter.durationMs,
      );
      if (timestamps.length >= limiter.max) {
        return null;
      }
    }

    if (!groupPolicy) {
      const candidates = await this.redis.zrange(k.waiting, 0, 0);
      const jobId = candidates[0];
      if (!jobId) {
        return null;
      }

      const removed = await this.redis.zrem(k.waiting, jobId);
      if (removed === 0) {
        return null;
      }

      const raw = await this.redis.hget(k.jobs, jobId);
      if (!raw) {
        return null;
      }

      const job = this.parseJob<TData, TResult>(raw);
      job.status = "active";
      job.startedAt = now;
      await this.redis.hset(k.jobs, job.id, JSON.stringify(job));
      await this.redis.sadd(k.active, job.id);
      this.trackFallbackGroupActive(queueName, job.groupId, 1);
      if (limiter) {
        this.recordFallbackRateLimit(queueName, now);
      }
      this.jobQueueIndex.set(job.id, queueName);
      return job;
    }

    const allWaiting = await this.redis.zrange(k.waiting, 0, -1);
    const seenGroup = new Set<string>();
    const activeMap = this.getFallbackActiveMap(queueName);
    const rrMap = this.getFallbackRrMap(queueName);

    let bestJob: Job<TData, TResult> | undefined;
    let bestGroupKey = "";
    let bestLastServed = Infinity;

    for (const candidateId of allWaiting) {
      const raw = await this.redis.hget(k.jobs, candidateId);
      if (!raw) {
        await this.redis.zrem(k.waiting, candidateId);
        continue;
      }
      const candidate = this.parseJob<TData, TResult>(raw);
      if (candidate.status !== "waiting") {
        await this.redis.zrem(k.waiting, candidateId);
        continue;
      }

      const groupKey = candidate.groupId ?? "";
      if (seenGroup.has(groupKey)) {
        continue;
      }
      seenGroup.add(groupKey);

      if (groupKey !== "") {
        const cap = resolveGroupCap(groupPolicy, groupKey);
        if ((activeMap.get(groupKey) ?? 0) >= cap) {
          continue;
        }
      }

      const lastServed = rrMap.get(groupKey) ?? 0;
      if (lastServed < bestLastServed) {
        bestLastServed = lastServed;
        bestJob = candidate;
        bestGroupKey = groupKey;
        if (lastServed === 0) {
          break;
        }
      }
    }

    if (!bestJob) {
      return null;
    }

    const removed = await this.redis.zrem(k.waiting, bestJob.id);
    if (removed === 0) {
      return null;
    }

    bestJob.status = "active";
    bestJob.startedAt = now;
    await this.redis.hset(k.jobs, bestJob.id, JSON.stringify(bestJob));
    await this.redis.sadd(k.active, bestJob.id);
    this.trackFallbackGroupActive(queueName, bestJob.groupId, 1);
    const nextTick = (this.fallbackRrTick.get(queueName) ?? 0) + 1;
    this.fallbackRrTick.set(queueName, nextTick);
    rrMap.set(bestGroupKey, nextTick);
    if (limiter) {
      this.recordFallbackRateLimit(queueName, now);
    }
    this.jobQueueIndex.set(bestJob.id, queueName);
    return bestJob;
  }

  async getNextRateLimitTimestamp(
    queueName: string,
    now: number = Date.now(),
    options?: QueueDequeueOptions,
  ): Promise<number | null> {
    const limiter = normalizeRateLimiter(options?.limiter);
    if (!limiter) {
      return null;
    }

    if (this.useLua) {
      const nextAt = this.nextRateLimitAt.get(queueName);
      if (nextAt === undefined) {
        return null;
      }
      if (nextAt <= now) {
        this.nextRateLimitAt.delete(queueName);
        return null;
      }
      return nextAt;
    }

    const timestamps = this.pruneFallbackRateLimit(
      queueName,
      now,
      limiter.durationMs,
    );
    if (timestamps.length < limiter.max) {
      return null;
    }
    return timestamps[0]! + limiter.durationMs;
  }

  async ack<TData = unknown, TResult = unknown>(
    queueName: string,
    jobId: string,
    result?: TResult,
    leaseToken?: string,
  ): Promise<Job<TData, TResult> | null> {
    this.trackQueue(queueName);
    const k = this.keys(queueName);

    if (this.useLua) {
      const tKey = this.tokenKey(queueName, jobId);
      const token = leaseToken ?? this.activeTokens.get(tKey) ?? "";
      const hasResult = result !== undefined ? "1" : "0";
      const resultJson = result !== undefined ? JSON.stringify(result) : "";
      const raw = await this.runLua(
        LUA_ACK_JOB,
        [
          k.jobs,
          k.active,
          k.leases,
          k.stalled,
          k.completedCount,
          k.idempotency,
          k.groupActive,
          k.groupMap,
        ],
        [
          jobId,
          resultJson,
          hasResult,
          Date.now(),
          token,
          this.pruneIdempotencyOnTerminal ? "1" : "0",
        ],
      );
      if (typeof raw !== "string" || raw.length === 0) {
        return null;
      }
      this.activeTokens.delete(tKey);
      this.jobQueueIndex.delete(jobId);
      return this.parseJob<TData, TResult>(raw);
    }

    const removedActive = await this.redis.srem(k.active, jobId);

    const job = await this.getJob<TData, TResult>(queueName, jobId);
    if (!job) {
      return null;
    }
    if (removedActive > 0) {
      this.trackFallbackGroupActive(queueName, job.groupId, -1);
    }

    job.status = "completed";
    job.returnValue = result;
    job.finishedAt = Date.now();
    await this.redis.incr(k.completedCount);

    if (job.removeOnComplete) {
      await this.redis.hdel(k.jobs, jobId);
      await this.redis.hdel(k.groupMap, jobId);
    } else {
      await this.redis.hset(k.jobs, jobId, JSON.stringify(job));
    }

    if (
      job.idempotencyKey !== undefined &&
      (job.removeOnComplete || this.pruneIdempotencyOnTerminal)
    ) {
      await this.redis.hdel(k.idempotency, job.idempotencyKey);
    }

    this.jobQueueIndex.delete(jobId);
    return job;
  }

  async nack<TData = unknown, TResult = unknown>(
    queueName: string,
    jobId: string,
    error: Error | string,
    retryAt?: number,
    leaseToken?: string,
  ): Promise<Job<TData, TResult> | null> {
    this.trackQueue(queueName);
    const k = this.keys(queueName);
    const formatted = formatError(error);

    if (this.useLua) {
      const tKey = this.tokenKey(queueName, jobId);
      const token = leaseToken ?? this.activeTokens.get(tKey) ?? "";
      const res = await this.runLua(
        LUA_NACK_OR_DLQ_JOB,
        [
          k.jobs,
          k.active,
          k.leases,
          k.stalled,
          k.waiting,
          k.delayed,
          k.dlq,
          k.failedCount,
          k.seq,
          k.idempotency,
          k.groupActive,
        ],
        [
          jobId,
          formatted.message,
          formatted.stack ?? formatted.message,
          Date.now(),
          retryAt !== undefined ? String(retryAt) : "",
          "0",
          token,
          this.pruneIdempotencyOnTerminal ? "1" : "0",
        ],
      );
      if (!Array.isArray(res) || typeof res[1] !== "string") {
        return null;
      }
      this.activeTokens.delete(tKey);
      return this.parseJob<TData, TResult>(res[1]);
    }

    const removedActive = await this.redis.srem(k.active, jobId);

    const job = await this.getJob<TData, TResult>(queueName, jobId);
    if (!job) {
      return null;
    }
    if (removedActive > 0) {
      this.trackFallbackGroupActive(queueName, job.groupId, -1);
    }

    job.attemptsMade += 1;
    job.failedReason = formatted.message;
    job.stacktrace.push(formatted.stack ?? formatted.message);

    if (retryAt !== undefined) {
      job.processAfter = retryAt;
      if (retryAt > Date.now()) {
        job.status = "delayed";
        await this.redis.hset(k.jobs, jobId, JSON.stringify(job));
        await this.redis.zadd(k.delayed, retryAt, jobId);
      } else {
        job.status = "waiting";
        await this.redis.hset(k.jobs, jobId, JSON.stringify(job));
        await this.addToWaitingSet(queueName, job);
      }
    } else {
      job.status = "failed";
      job.finishedAt = Date.now();
      await this.redis.incr(k.failedCount);
      await this.redis.hset(k.jobs, jobId, JSON.stringify(job));
      if (job.idempotencyKey !== undefined && this.pruneIdempotencyOnTerminal) {
        await this.redis.hdel(k.idempotency, job.idempotencyKey);
      }
    }

    return job;
  }

  async moveToDeadLetter<TData = unknown, TResult = unknown>(
    queueName: string,
    jobId: string,
    error: Error | string,
    leaseToken?: string,
  ): Promise<Job<TData, TResult> | null> {
    this.trackQueue(queueName);
    const k = this.keys(queueName);
    const formatted = formatError(error);

    if (this.useLua) {
      const tKey = this.tokenKey(queueName, jobId);
      const token = leaseToken ?? this.activeTokens.get(tKey) ?? "";
      const res = await this.runLua(
        LUA_NACK_OR_DLQ_JOB,
        [
          k.jobs,
          k.active,
          k.leases,
          k.stalled,
          k.waiting,
          k.delayed,
          k.dlq,
          k.failedCount,
          k.seq,
          k.idempotency,
          k.groupActive,
        ],
        [
          jobId,
          formatted.message,
          formatted.stack ?? formatted.message,
          Date.now(),
          "",
          "1",
          token,
          this.pruneIdempotencyOnTerminal ? "1" : "0",
        ],
      );
      if (!Array.isArray(res) || typeof res[1] !== "string") {
        return null;
      }
      this.activeTokens.delete(tKey);
      this.jobQueueIndex.delete(jobId);
      return this.parseJob<TData, TResult>(res[1]);
    }

    const removedActive = await this.redis.srem(k.active, jobId);
    await this.redis.zrem(k.delayed, jobId);
    await this.redis.zrem(k.waiting, jobId);

    const job = await this.getJob<TData, TResult>(queueName, jobId);
    if (!job) {
      return null;
    }
    if (removedActive > 0) {
      this.trackFallbackGroupActive(queueName, job.groupId, -1);
    }

    job.attemptsMade += 1;
    job.status = "dead-letter";
    job.failedReason = formatted.message;
    job.finishedAt = Date.now();
    job.stacktrace.push(formatted.stack ?? formatted.message);

    await this.redis.incr(k.failedCount);
    await this.redis.hset(k.jobs, jobId, JSON.stringify(job));
    await this.redis.rpush(k.dlq, jobId);
    if (job.idempotencyKey !== undefined && this.pruneIdempotencyOnTerminal) {
      await this.redis.hdel(k.idempotency, job.idempotencyKey);
    }

    this.jobQueueIndex.delete(jobId);
    return job;
  }

  /**
   * Atomically extends the active lease of a job if `token` matches the current
   * owner token. Accepts either `(jobId, token, lockDurationMs?)` or
   * `(queueName, jobId, token, lockDurationMs?)`.
   */
  renewLease(
    jobId: string,
    token: string,
    lockDurationMs?: number,
  ): Promise<boolean>;
  renewLease(
    queueName: string,
    jobId: string,
    token: string,
    lockDurationMs?: number,
  ): Promise<boolean>;
  async renewLease(
    first: string,
    second: string,
    third?: string | number,
    fourth?: number,
  ): Promise<boolean> {
    let queueName: string | undefined;
    let jobId: string;
    let token: string;
    let durationMs: number;

    if (typeof third === "string") {
      queueName = first;
      jobId = second;
      token = third;
      durationMs = Math.max(10, Math.floor(fourth ?? this.lockDurationMs));
    } else {
      jobId = first;
      token = second;
      queueName = this.jobQueueIndex.get(jobId);
      durationMs = Math.max(10, Math.floor(third ?? this.lockDurationMs));
    }

    if (!queueName) {
      return false;
    }
    this.trackQueue(queueName);

    if (!this.useLua) {
      return this.activeTokens.get(this.tokenKey(queueName, jobId)) === token;
    }

    const k = this.keys(queueName);
    const renewed = await this.runLua(
      LUA_RENEW_LEASE,
      [k.jobs, k.active, k.leases],
      [jobId, token, Date.now(), durationMs],
    );
    return Number(renewed) === 1;
  }

  /**
   * Atomically sweeps expired active leases for `queueName` (or all tracked
   * queues when omitted), requeuing stalled jobs or moving jobs that exceed
   * `maxStalledCount` into the Dead-Letter Queue.
   */
  async reclaimStalledJobs(
    queueName?: string,
    now: number = Date.now(),
  ): Promise<ReclaimStalledResult> {
    if (!this.useLua) {
      return { reclaimed: [], deadLettered: [] };
    }

    const targets =
      queueName !== undefined ? [queueName] : [...this.knownQueues];
    const allReclaimed: Job<any, any>[] = [];
    const allDeadLettered: Job<any, any>[] = [];

    for (const qName of targets) {
      this.knownQueues.add(qName);
      const k = this.keys(qName);
      const res = await this.runLua(
        LUA_RECLAIM_STALLED,
        [
          k.jobs,
          k.active,
          k.leases,
          k.stalled,
          k.waiting,
          k.dlq,
          k.failedCount,
          k.seq,
          k.idempotency,
          k.groupActive,
        ],
        [now, this.maxStalledCount, this.pruneIdempotencyOnTerminal ? "1" : "0"],
      );

      if (!Array.isArray(res)) {
        continue;
      }

      const rawReclaimed = Array.isArray(res[0]) ? (res[0] as string[]) : [];
      const rawDeadLettered = Array.isArray(res[1]) ? (res[1] as string[]) : [];

      const reclaimed = rawReclaimed.map((raw) => {
        const job = this.parseJob<any, any>(raw);
        this.activeTokens.delete(this.tokenKey(qName, job.id));
        return job;
      });
      const deadLettered = rawDeadLettered.map((raw) => {
        const job = this.parseJob<any, any>(raw);
        this.activeTokens.delete(this.tokenKey(qName, job.id));
        this.jobQueueIndex.delete(job.id);
        return job;
      });

      if (reclaimed.length > 0 || deadLettered.length > 0) {
        allReclaimed.push(...reclaimed);
        allDeadLettered.push(...deadLettered);

        const queueResult: ReclaimStalledResult = { reclaimed, deadLettered };
        this.onStalledReclaimed?.(qName, queueResult);
        const listeners = this.stalledListeners.get(qName);
        if (listeners) {
          for (const listener of [...listeners]) {
            try {
              listener(queueResult);
            } catch {
              // Isolate listener faults
            }
          }
        }
      }
    }

    return {
      reclaimed: allReclaimed,
      deadLettered: allDeadLettered,
    };
  }

  async getJob<TData = unknown, TResult = unknown>(
    queueName: string,
    jobId: string,
  ): Promise<Job<TData, TResult> | null> {
    const k = this.keys(queueName);
    const raw = await this.redis.hget(k.jobs, jobId);
    if (!raw) {
      return null;
    }
    return this.parseJob<TData, TResult>(raw);
  }

  async getCounts(queueName: string): Promise<QueueCounts> {
    const k = this.keys(queueName);
    const [waiting, delayed, active, deadLetter, completedRaw, failedRaw] =
      await Promise.all([
        this.redis.zcard(k.waiting),
        this.redis.zcard(k.delayed),
        this.useLua ? this.redis.zcard(k.active) : this.redis.scard(k.active),
        this.redis.llen(k.dlq),
        this.redis.get(k.completedCount),
        this.redis.get(k.failedCount),
      ]);

    return {
      waiting,
      delayed,
      active,
      completed: Number(completedRaw ?? 0),
      failed: Number(failedRaw ?? 0),
      deadLetter,
    };
  }

  async getDeadLetterJobs<TData = unknown, TResult = unknown>(
    queueName: string,
  ): Promise<Job<TData, TResult>[]> {
    const k = this.keys(queueName);
    const ids = await this.redis.lrange(k.dlq, 0, -1);
    const jobs: Job<TData, TResult>[] = [];
    for (const id of ids) {
      const job = await this.getJob<TData, TResult>(queueName, id);
      if (job) {
        jobs.push(job);
      }
    }
    return jobs;
  }

  async retryDeadLetterJob<TData = unknown, TResult = unknown>(
    queueName: string,
    jobId: string,
  ): Promise<Job<TData, TResult> | null> {
    this.trackQueue(queueName);
    const k = this.keys(queueName);
    const removed = await this.redis.lrem(k.dlq, 1, jobId);
    if (removed === 0) {
      return null;
    }

    const job = await this.getJob<TData, TResult>(queueName, jobId);
    if (!job) {
      return null;
    }

    job.attemptsMade = 0;
    job.failedReason = undefined;
    job.finishedAt = undefined;
    job.startedAt = undefined;
    job.leaseToken = undefined;
    job.leaseExpiresAt = undefined;
    job.stalledCount = 0;
    job.processAfter = Date.now();
    job.status = "waiting";

    await this.redis.hdel(k.stalled, jobId);
    await this.redis.hset(k.jobs, jobId, JSON.stringify(job));
    await this.addToWaitingSet(queueName, job);
    return job;
  }

  async getJobs<TData = unknown, TResult = unknown>(
    queueName: string,
    status?: JobStatus | "all",
    limit?: number,
    offset: number = 0,
  ): Promise<Job<TData, TResult>[]> {
    const k = this.keys(queueName);
    const jobs: Job<TData, TResult>[] = [];

    if (typeof this.redis.hvals === "function") {
      const rawJobs = await this.redis.hvals(k.jobs);
      for (const raw of rawJobs) {
        try {
          const parsed = this.parseJob<TData, TResult>(raw);
          if (!status || status === "all" || parsed.status === status) {
            jobs.push(parsed);
          }
        } catch {
          // Skip malformed entries
        }
      }
    } else {
      const idSet = new Set<string>();
      const wantAll = !status || status === "all";
      if (wantAll || status === "waiting") {
        for (const id of await this.redis.zrange(k.waiting, 0, -1)) {
          idSet.add(id);
        }
      }
      if (wantAll || status === "delayed") {
        for (const id of await this.redis.zrange(k.delayed, 0, -1)) {
          idSet.add(id);
        }
      }
      if ((wantAll || status === "active") && this.useLua) {
        for (const id of await this.redis.zrange(k.active, 0, -1)) {
          idSet.add(id);
        }
      }
      if (wantAll || status === "dead-letter") {
        for (const id of await this.redis.lrange(k.dlq, 0, -1)) {
          idSet.add(id);
        }
      }
      for (const id of idSet) {
        const job = await this.getJob<TData, TResult>(queueName, id);
        if (job && (wantAll || job.status === status)) {
          jobs.push(job);
        }
      }
    }

    jobs.sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
    const start = Math.max(0, Math.floor(offset));
    if (limit !== undefined && Number.isFinite(limit) && limit >= 0) {
      return jobs.slice(start, start + Math.floor(limit));
    }
    return jobs.slice(start);
  }

  async retryJob<TData = unknown, TResult = unknown>(
    queueName: string,
    jobId: string,
  ): Promise<Job<TData, TResult> | null> {
    const fromDlq = await this.retryDeadLetterJob<TData, TResult>(
      queueName,
      jobId,
    );
    if (fromDlq) {
      return fromDlq;
    }
    const job = await this.getJob<TData, TResult>(queueName, jobId);
    if (!job || job.status !== "failed") {
      return null;
    }
    const k = this.keys(queueName);
    job.attemptsMade = 0;
    job.failedReason = undefined;
    job.finishedAt = undefined;
    job.startedAt = undefined;
    job.leaseToken = undefined;
    job.leaseExpiresAt = undefined;
    job.stalledCount = 0;
    job.processAfter = Date.now();
    job.status = "waiting";
    await this.redis.hdel(k.stalled, jobId);
    await this.redis.hset(k.jobs, jobId, JSON.stringify(job));
    await this.addToWaitingSet(queueName, job);
    return job;
  }

  async getNextDelayedTimestamp(queueName: string): Promise<number | null> {
    const k = this.keys(queueName);
    const ids = await this.redis.zrange(k.delayed, 0, 0);
    const firstId = ids[0];
    if (!firstId) {
      return null;
    }
    const job = await this.getJob(queueName, firstId);
    return job?.processAfter ?? null;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.stopStalledSweep();
    this.stalledListeners.clear();
    this.activeTokens.clear();
    this.nextRateLimitAt.clear();
    this.fallbackActiveByGroup.clear();
    this.fallbackGroupLastServed.clear();
    this.fallbackRrTick.clear();
    this.fallbackRateLimitTimestamps.clear();
    this.jobQueueIndex.clear();
    this.knownQueues.clear();
    this.scriptShas.clear();

    if (typeof this.redis.quit === "function") {
      await this.redis.quit();
    } else if (typeof this.redis.close === "function") {
      await this.redis.close();
    }
  }

  private getFallbackActiveMap(queueName: string): Map<string, number> {
    let map = this.fallbackActiveByGroup.get(queueName);
    if (!map) {
      map = new Map();
      this.fallbackActiveByGroup.set(queueName, map);
    }
    return map;
  }

  private getFallbackRrMap(queueName: string): Map<string, number> {
    let map = this.fallbackGroupLastServed.get(queueName);
    if (!map) {
      map = new Map();
      this.fallbackGroupLastServed.set(queueName, map);
    }
    return map;
  }

  private trackFallbackGroupActive(
    queueName: string,
    groupId: string | undefined,
    delta: number,
  ): void {
    if (!groupId) {
      return;
    }
    const map = this.getFallbackActiveMap(queueName);
    const next = (map.get(groupId) ?? 0) + delta;
    if (next <= 0) {
      map.delete(groupId);
    } else {
      map.set(groupId, next);
    }
  }

  private pruneFallbackRateLimit(
    queueName: string,
    now: number,
    durationMs: number,
  ): number[] {
    let timestamps = this.fallbackRateLimitTimestamps.get(queueName);
    if (!timestamps) {
      timestamps = [];
      this.fallbackRateLimitTimestamps.set(queueName, timestamps);
    }
    const cutoff = now - durationMs;
    let firstValid = 0;
    while (firstValid < timestamps.length && timestamps[firstValid]! <= cutoff) {
      firstValid++;
    }
    if (firstValid > 0) {
      timestamps.splice(0, firstValid);
    }
    return timestamps;
  }

  private recordFallbackRateLimit(queueName: string, now: number): void {
    let timestamps = this.fallbackRateLimitTimestamps.get(queueName);
    if (!timestamps) {
      timestamps = [];
      this.fallbackRateLimitTimestamps.set(queueName, timestamps);
    }
    timestamps.push(now);
  }

  private async addToWaitingSet(
    queueName: string,
    job: Job<any, any>,
  ): Promise<void> {
    const k = this.keys(queueName);
    const seq = await this.redis.incr(k.seq);
    // Lower ZSET score pops first: negate priority, break ties with ascending seq
    const score = -job.priority * 1_000_000_000 + seq;
    await this.redis.zadd(k.waiting, score, job.id);
  }

  private async promoteReadyDelayed(
    queueName: string,
    now: number,
  ): Promise<void> {
    const k = this.keys(queueName);
    const dueIds = await this.redis.zrangebyscore(k.delayed, "-inf", now);
    for (const id of dueIds) {
      const removed = await this.redis.zrem(k.delayed, id);
      if (removed === 0) continue;
      const job = await this.getJob(queueName, id);
      if (!job) continue;
      job.status = "waiting";
      await this.redis.hset(k.jobs, id, JSON.stringify(job));
      await this.addToWaitingSet(queueName, job);
    }
  }
}
