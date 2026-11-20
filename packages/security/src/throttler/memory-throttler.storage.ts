import {
  Inject,
  Injectable,
  Optional,
  type OnApplicationShutdown,
  type OnModuleDestroy,
} from "@bunest/common";
import type {
  ThrottlerStorage,
  ThrottlerStorageOptions,
  ThrottlerStorageRecord,
} from "./throttler.interface";

export const DEFAULT_SWEEP_INTERVAL = 60_000;

export const MEMORY_THROTTLER_SWEEP_MS = Symbol.for(
  "bunest:security:memory_throttler_sweep_ms",
);

interface BucketEntry {
  hits: number[];
  blockedUntil: number;
  expiresAt: number;
}

/**
 * In-memory sliding-window throttler storage with automatic TTL sweep
 * using an unref'd timer so tests and short-lived scripts never hang.
 */
@Injectable()
export class MemoryThrottlerStorage
  implements ThrottlerStorage, OnModuleDestroy, OnApplicationShutdown
{
  private readonly buckets = new Map<string, BucketEntry>();
  private readonly _storage = new Map<string, ThrottlerStorageOptions>();
  private sweepTimer?: ReturnType<typeof setInterval>;
  protected readonly sweepIntervalMs: number;

  constructor(
    @Optional()
    @Inject(MEMORY_THROTTLER_SWEEP_MS)
    sweepIntervalMs = DEFAULT_SWEEP_INTERVAL,
  ) {
    this.sweepIntervalMs = sweepIntervalMs;
    if (sweepIntervalMs > 0) {
      this.sweepTimer = setInterval(() => this.sweepExpired(), sweepIntervalMs);
      if (
        typeof this.sweepTimer === "object" &&
        this.sweepTimer !== null &&
        "unref" in this.sweepTimer &&
        typeof this.sweepTimer.unref === "function"
      ) {
        this.sweepTimer.unref();
      }
    }
  }

  get storage(): Map<string, ThrottlerStorageOptions> {
    return this._storage;
  }

  increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration = 0,
    throttlerName = "default",
  ): ThrottlerStorageRecord {
    const now = Date.now();
    const windowMs = Math.max(1, ttl);
    let bucket = this.buckets.get(key);

    if (!bucket) {
      bucket = { hits: [], blockedUntil: 0, expiresAt: now + windowMs };
      this.buckets.set(key, bucket);
    }

    // Check active block window first
    if (bucket.blockedUntil > now) {
      const totalHits = bucket.hits.length + 1;
      this.syncStorageEntry(key, throttlerName, bucket, totalHits, true);
      return {
        totalHits,
        timeToExpire: Math.max(1, bucket.expiresAt - now),
        isBlocked: true,
        timeToBlockExpire: bucket.blockedUntil - now,
      };
    }

    // Prune timestamps outside the sliding window [now - windowMs, now]
    const cutoff = now - windowMs;
    if (bucket.hits.length > 0) {
      let firstValid = 0;
      while (
        firstValid < bucket.hits.length &&
        (bucket.hits[firstValid] ?? 0) <= cutoff
      ) {
        firstValid++;
      }
      if (firstValid > 0) {
        bucket.hits.splice(0, firstValid);
      }
    }

    // If already at or over limit, do NOT pollute sliding window with rejected hit timestamps
    if (bucket.hits.length >= limit) {
      const oldestHit = bucket.hits[0] ?? now;
      const timeToExpire = Math.max(1, oldestHit + windowMs - now);
      let isBlocked = false;
      let timeToBlockExpire = 0;

      if (blockDuration > 0) {
        bucket.blockedUntil = now + blockDuration;
        bucket.expiresAt = Math.max(bucket.expiresAt, bucket.blockedUntil);
        isBlocked = true;
        timeToBlockExpire = blockDuration;
      }

      const totalHits = bucket.hits.length + 1;
      this.syncStorageEntry(key, throttlerName, bucket, totalHits, isBlocked);
      return {
        totalHits,
        timeToExpire,
        isBlocked,
        timeToBlockExpire,
      };
    }

    bucket.hits.push(now);
    const totalHits = bucket.hits.length;
    const oldestHit = bucket.hits[0] ?? now;
    const timeToExpire = Math.max(1, oldestHit + windowMs - now);
    bucket.expiresAt = Math.max(now + windowMs, bucket.blockedUntil);

    this.syncStorageEntry(key, throttlerName, bucket, totalHits, false);
    return {
      totalHits,
      timeToExpire,
      isBlocked: false,
      timeToBlockExpire: 0,
    };
  }

  reset(key: string): void {
    this.buckets.delete(key);
    this._storage.delete(key);
  }

  clear(): void {
    this.buckets.clear();
    this._storage.clear();
  }

  sweepExpired(now = Date.now()): void {
    for (const [key, bucket] of this.buckets.entries()) {
      if (bucket.expiresAt <= now && bucket.blockedUntil <= now) {
        this.buckets.delete(key);
        this._storage.delete(key);
      }
    }
  }

  onModuleDestroy(): void {
    if (this.sweepTimer !== undefined) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
    this.buckets.clear();
    this._storage.clear();
  }

  onApplicationShutdown(): void {
    this.onModuleDestroy();
  }

  private syncStorageEntry(
    key: string,
    throttlerName: string,
    bucket: BucketEntry,
    totalHits: number,
    isBlocked: boolean,
  ): void {
    let entry = this._storage.get(key);
    if (!entry) {
      entry = {
        totalHits: new Map<string, number>(),
        expiresAt: bucket.expiresAt,
        isBlocked,
        blockExpiresAt: bucket.blockedUntil,
      };
      this._storage.set(key, entry);
    }
    entry.totalHits.set(throttlerName, totalHits);
    entry.expiresAt = bucket.expiresAt;
    entry.isBlocked = isBlocked;
    entry.blockExpiresAt = bucket.blockedUntil;
  }
}

export { MemoryThrottlerStorage as ThrottlerStorageService };
