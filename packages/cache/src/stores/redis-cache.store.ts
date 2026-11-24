import type {
  CacheSetOptions,
  CacheStore,
  CacheTtlOrOptions,
} from "../interfaces/cache.interface";
import {
  createBunRedisClient,
  type RedisClientLike,
} from "./bun-redis.adapter";

export type { RedisClientLike };

export interface RedisCacheStoreOptions {
  /** Pluggable Redis client or native `Bun.RedisClient`. Optional when `url` is provided (or falls back to `Bun.redis`). */
  client?: RedisClientLike | Bun.RedisClient;
  /** Redis connection URL for Bun's native `Bun.RedisClient` (e.g. `"redis://localhost:6379"`). */
  url?: string;
  /**
   * Key namespace prefix applied to all stored keys (e.g. `"bunest:"`).
   * @default ""
   */
  keyPrefix?: string;
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
   * Batch COUNT hint passed to Redis `SCAN`.
   * @default 100
   */
  scanCount?: number;
  serialize?: (value: unknown) => string;
  deserialize?: (raw: string) => unknown;
}

function normalizeSetOptions(
  ttlMsOrOptions?: CacheTtlOrOptions,
): CacheSetOptions {
  if (typeof ttlMsOrOptions === "number") {
    return { ttlMs: ttlMsOrOptions };
  }
  return ttlMsOrOptions ?? {};
}

function escapeGlob(input: string): string {
  return input.replace(/([*?[\]\\])/g, "\\$1");
}

/**
 * Redis-backed `CacheStore` with key prefixing, JSON serialization, `PX` TTLs,
 * `PTTL` inspection, `SCAN`-based prefix invalidation, optional set-based tag
 * invalidation, and clean connection teardown.
 */
export class RedisCacheStore implements CacheStore {
  private readonly client: RedisClientLike;
  private readonly keyPrefix: string;
  private readonly defaultTtlMs: number;
  private readonly scanCount: number;
  private readonly serialize: (value: unknown) => string;
  private readonly deserialize: (raw: string) => unknown;

  constructor(options: RedisCacheStoreOptions = {}) {
    if (options.client) {
      this.client =
        options.client instanceof Bun.RedisClient
          ? createBunRedisClient(options.client)
          : options.client;
    } else {
      this.client = createBunRedisClient(options.url);
    }
    this.keyPrefix = options.keyPrefix ?? "";
    this.defaultTtlMs = options.defaultTtlMs ?? options.ttl ?? 0;
    this.scanCount = options.scanCount ?? 100;
    this.serialize = options.serialize ?? ((v) => JSON.stringify(v));
    this.deserialize = options.deserialize ?? ((raw) => JSON.parse(raw));
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const raw = await this.client.get(this.prefixKey(key));
    if (raw === null || raw === undefined) {
      return undefined;
    }
    return this.deserialize(raw) as T;
  }

  async ttl(key: string): Promise<number | null> {
    const fullKey = this.prefixKey(key);
    if (typeof this.client.pttl === "function") {
      const ms = await this.client.pttl(fullKey);
      return ms > 0 ? ms : null;
    }
    if (typeof this.client.ttl === "function") {
      const secs = await this.client.ttl(fullKey);
      return secs > 0 ? secs * 1000 : null;
    }
    return null;
  }

  async set<T = unknown>(
    key: string,
    value: T,
    ttlMsOrOptions?: CacheTtlOrOptions,
  ): Promise<void> {
    const opts = normalizeSetOptions(ttlMsOrOptions);
    const explicitTtl = opts.ttlMs !== undefined ? opts.ttlMs : opts.ttl;
    const ttlMs = explicitTtl !== undefined ? explicitTtl : this.defaultTtlMs;
    const fullKey = this.prefixKey(key);

    if (ttlMs < 0) {
      await this.client.del(fullKey);
      return;
    }

    const encoded = this.serialize(value);
    if (ttlMs > 0) {
      await this.client.set(fullKey, encoded, "PX", Math.ceil(ttlMs));
    } else {
      await this.client.set(fullKey, encoded);
    }

    if (
      opts.tags &&
      opts.tags.length > 0 &&
      typeof this.client.sadd === "function"
    ) {
      for (const tag of opts.tags) {
        await this.client.sadd(this.tagSetKey(tag), fullKey);
      }
    }
  }

  async del(key: string): Promise<boolean> {
    const removed = await this.client.del(this.prefixKey(key));
    return removed > 0;
  }

  async has(key: string): Promise<boolean> {
    const fullKey = this.prefixKey(key);
    if (typeof this.client.exists === "function") {
      const res = await this.client.exists(fullKey);
      return typeof res === "boolean" ? res : res > 0;
    }
    const raw = await this.client.get(fullKey);
    return raw !== null && raw !== undefined;
  }

  async mget<T = unknown>(
    keys: readonly string[],
  ): Promise<Array<T | undefined>> {
    if (keys.length === 0) {
      return [];
    }
    const prefixed = keys.map((k) => this.prefixKey(k));
    if (typeof this.client.mget === "function") {
      const rawValues = await this.client.mget(...prefixed);
      return rawValues.map((raw) =>
        raw === null || raw === undefined
          ? undefined
          : (this.deserialize(raw) as T),
      );
    }
    return await Promise.all(keys.map((k) => this.get<T>(k)));
  }

  async mset(
    entries: ReadonlyArray<readonly [string, unknown, CacheTtlOrOptions?]>,
  ): Promise<void> {
    for (const [key, value, opts] of entries) {
      await this.set(key, value, opts);
    }
  }

  async mdel(keys: readonly string[]): Promise<number> {
    if (keys.length === 0) {
      return 0;
    }
    return await this.client.del(...keys.map((k) => this.prefixKey(k)));
  }

  async keys(prefix = ""): Promise<string[]> {
    const pattern = `${escapeGlob(this.prefixKey(prefix))}*`;
    const matched = await this.scanMatchingKeys(pattern);
    return matched
      .map((fullKey) =>
        this.keyPrefix.length > 0 && fullKey.startsWith(this.keyPrefix)
          ? fullKey.slice(this.keyPrefix.length)
          : fullKey,
      )
      .filter((key) => !key.startsWith("__tag:"));
  }

  async deleteByPrefix(prefix: string): Promise<number> {
    const pattern = `${escapeGlob(this.prefixKey(prefix))}*`;
    const matched = await this.scanMatchingKeys(pattern);
    if (matched.length === 0) {
      return 0;
    }
    return await this.client.del(...matched);
  }

  async invalidateTag(tag: string): Promise<number> {
    if (typeof this.client.smembers !== "function") {
      return 0;
    }
    const tagKey = this.tagSetKey(tag);
    const members = await this.client.smembers(tagKey);
    if (members.length === 0) {
      await this.client.del(tagKey);
      return 0;
    }
    const deleted = await this.client.del(...members);
    await this.client.del(tagKey);
    return deleted;
  }

  async reset(): Promise<void> {
    if (this.keyPrefix.length > 0) {
      await this.deleteByPrefix("");
      return;
    }
    if (typeof this.client.flushdb === "function") {
      await this.client.flushdb();
      return;
    }
    const all = await this.scanMatchingKeys("*");
    if (all.length > 0) {
      await this.client.del(...all);
    }
  }

  async close(): Promise<void> {
    if (typeof this.client.quit === "function") {
      await this.client.quit();
    } else if (typeof this.client.close === "function") {
      await this.client.close();
    } else if (typeof this.client.disconnect === "function") {
      this.client.disconnect();
    }
  }

  async disconnect(): Promise<void> {
    await this.close();
  }

  private prefixKey(key: string): string {
    return `${this.keyPrefix}${key}`;
  }

  private tagSetKey(tag: string): string {
    return `${this.keyPrefix}__tag:${tag}`;
  }

  private async scanMatchingKeys(pattern: string): Promise<string[]> {
    if (typeof this.client.scan === "function") {
      const found = new Set<string>();
      let cursor: string | number = "0";
      let guard = 0;

      while (guard < 10_000) {
        guard += 1;
        const [nextCursor, batch] = await this.client.scan(
          cursor,
          "MATCH",
          pattern,
          "COUNT",
          this.scanCount,
        );
        for (const key of batch) {
          found.add(key);
        }
        if (String(nextCursor) === "0") {
          break;
        }
        cursor = nextCursor;
      }

      return [...found];
    }

    if (typeof this.client.keys === "function") {
      return await this.client.keys(pattern);
    }

    return [];
  }
}
