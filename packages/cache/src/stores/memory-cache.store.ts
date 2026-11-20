import type {
  CacheSetOptions,
  CacheStore,
  CacheTtlOrOptions,
} from "../interfaces/cache.interface";

export interface MemoryCacheStoreOptions {
  /**
   * Maximum number of entries before least-recently-used eviction triggers.
   * @default 1000
   */
  maxItems?: number;
  /**
   * Default TTL in milliseconds when not specified per key (0 = no expiration).
   * @default 0
   */
  defaultTtlMs?: number;
  /**
   * Alias for `defaultTtlMs`.
   */
  ttl?: number;
  /**
   * Periodic unref'd expiry cleanup interval in milliseconds (0 disables background sweep).
   * @default 60_000
   */
  cleanupIntervalMs?: number;
  /**
   * Custom clock function for deterministic testing.
   * @default Date.now
   */
  now?: () => number;
}

interface CacheEntry {
  value: unknown;
  expiresAt?: number;
  tags: ReadonlySet<string>;
}

function normalizeSetOptions(
  ttlMsOrOptions?: CacheTtlOrOptions,
): CacheSetOptions {
  if (typeof ttlMsOrOptions === "number") {
    return { ttlMs: ttlMsOrOptions };
  }
  return ttlMsOrOptions ?? {};
}

/**
 * In-memory O(1) LRU cache store with per-key & default TTL expiration,
 * lazy + periodic unref'd cleanup, prefix deletion, and tag invalidation.
 */
export class MemoryCacheStore implements CacheStore {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly tagIndex = new Map<string, Set<string>>();
  private readonly maxItems: number;
  private readonly defaultTtlMs: number;
  private readonly now: () => number;
  private cleanupTimer?: ReturnType<typeof setInterval>;

  constructor(options: MemoryCacheStoreOptions = {}) {
    const maxItems = options.maxItems ?? 1000;
    if (!Number.isInteger(maxItems) || maxItems <= 0) {
      throw new RangeError(
        `MemoryCacheStore maxItems must be a positive integer, received ${String(maxItems)}.`,
      );
    }

    this.maxItems = maxItems;
    this.defaultTtlMs = options.defaultTtlMs ?? options.ttl ?? 0;
    this.now = options.now ?? (() => Date.now());

    const cleanupIntervalMs = options.cleanupIntervalMs ?? 60_000;
    if (cleanupIntervalMs > 0) {
      this.cleanupTimer = setInterval(() => {
        this.pruneExpired();
      }, cleanupIntervalMs);
      this.cleanupTimer.unref?.();
    }
  }

  get size(): number {
    this.pruneExpired();
    return this.entries.size;
  }

  get<T = unknown>(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }

    if (this.isExpired(entry)) {
      this.deleteEntry(key, entry);
      return undefined;
    }

    // Refresh recency for O(1) LRU
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value as T;
  }

  ttl(key: string): number | null {
    const entry = this.entries.get(key);
    if (!entry) {
      return null;
    }
    if (this.isExpired(entry)) {
      this.deleteEntry(key, entry);
      return null;
    }
    if (entry.expiresAt === undefined) {
      return null;
    }
    return Math.max(0, entry.expiresAt - this.now());
  }

  set<T = unknown>(
    key: string,
    value: T,
    ttlMsOrOptions?: CacheTtlOrOptions,
  ): void {
    const opts = normalizeSetOptions(ttlMsOrOptions);
    const explicitTtl = opts.ttlMs !== undefined ? opts.ttlMs : opts.ttl;
    const effectiveTtl =
      explicitTtl !== undefined ? explicitTtl : this.defaultTtlMs;

    const existing = this.entries.get(key);
    if (existing) {
      this.deleteEntry(key, existing);
    }

    if (effectiveTtl < 0) {
      return;
    }

    const expiresAt =
      effectiveTtl > 0 ? this.now() + effectiveTtl : undefined;
    const tags = new Set(opts.tags ?? []);
    const entry: CacheEntry = { value, expiresAt, tags };

    this.entries.set(key, entry);
    for (const tag of tags) {
      let bucket = this.tagIndex.get(tag);
      if (!bucket) {
        bucket = new Set<string>();
        this.tagIndex.set(tag, bucket);
      }
      bucket.add(key);
    }

    // Evict expired first, then least-recently-used entries if over capacity
    if (this.entries.size > this.maxItems) {
      this.pruneExpired();
    }
    while (this.entries.size > this.maxItems) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      const oldestEntry = this.entries.get(oldestKey);
      if (oldestEntry) {
        this.deleteEntry(oldestKey, oldestEntry);
      }
    }
  }

  del(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry) {
      return false;
    }
    this.deleteEntry(key, entry);
    return true;
  }

  has(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry) {
      return false;
    }
    if (this.isExpired(entry)) {
      this.deleteEntry(key, entry);
      return false;
    }
    return true;
  }

  reset(): void {
    this.entries.clear();
    this.tagIndex.clear();
  }

  keys(prefix?: string): string[] {
    this.pruneExpired();
    const out: string[] = [];
    for (const key of this.entries.keys()) {
      if (prefix === undefined || key.startsWith(prefix)) {
        out.push(key);
      }
    }
    return out;
  }

  mget<T = unknown>(keys: readonly string[]): Array<T | undefined> {
    return keys.map((key) => this.get<T>(key));
  }

  mset(
    entries: ReadonlyArray<readonly [string, unknown, CacheTtlOrOptions?]>,
  ): void {
    for (const [key, value, opts] of entries) {
      this.set(key, value, opts);
    }
  }

  mdel(keys: readonly string[]): number {
    let deleted = 0;
    for (const key of keys) {
      if (this.del(key)) {
        deleted += 1;
      }
    }
    return deleted;
  }

  deleteByPrefix(prefix: string): number {
    const matching = this.keys(prefix);
    return this.mdel(matching);
  }

  invalidateTag(tag: string): number {
    const keys = this.tagIndex.get(tag);
    if (!keys || keys.size === 0) {
      return 0;
    }
    const snapshot = [...keys];
    let deleted = 0;
    for (const key of snapshot) {
      if (this.del(key)) {
        deleted += 1;
      }
    }
    this.tagIndex.delete(tag);
    return deleted;
  }

  pruneExpired(): number {
    let pruned = 0;
    const now = this.now();
    for (const [key, entry] of this.entries.entries()) {
      if (entry.expiresAt !== undefined && now >= entry.expiresAt) {
        this.deleteEntry(key, entry);
        pruned += 1;
      }
    }
    return pruned;
  }

  close(): void {
    if (this.cleanupTimer !== undefined) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }

  disconnect(): void {
    this.close();
  }

  private isExpired(entry: CacheEntry): boolean {
    return entry.expiresAt !== undefined && this.now() >= entry.expiresAt;
  }

  private deleteEntry(key: string, entry: CacheEntry): void {
    this.entries.delete(key);
    for (const tag of entry.tags) {
      const bucket = this.tagIndex.get(tag);
      if (bucket) {
        bucket.delete(key);
        if (bucket.size === 0) {
          this.tagIndex.delete(tag);
        }
      }
    }
  }
}
