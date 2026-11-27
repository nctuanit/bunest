import {
  Injectable,
  type OnApplicationShutdown,
  type OnModuleDestroy,
} from "@bunest/core";
import type {
  ThrottlerStorage,
  ThrottlerStorageRecord,
} from "./throttler.interface";

/**
 * Atomic Redis Lua fixed-window throttler script using `INCR`, `PEXPIRE`, `PTTL`,
 * and dedicated block keys with `SET ... PX`.
 *
 * `KEYS = [counterKey, blockKey]`
 * `ARGV = [ttlMs, limit, blockDurationMs]`
 * Returns `{ totalHits, timeToExpireMs, isBlocked (0|1), timeToBlockExpireMs }`.
 */
export const LUA_FIXED_WINDOW_INCREMENT = `
local counterKey = KEYS[1]
local blockKey = KEYS[2]
local ttlMs = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local blockDurationMs = tonumber(ARGV[3])

local blockPttl = redis.call('PTTL', blockKey)
if blockPttl and blockPttl > 0 then
  local blockedHits = tonumber(redis.call('GET', blockKey) or '0')
  if blockedHits <= limit then
    blockedHits = limit + 1
  end
  local pttl = redis.call('PTTL', counterKey)
  if not pttl or pttl <= 0 then
    pttl = blockPttl
  end
  return { blockedHits, pttl, 1, blockPttl }
end

local current = tonumber(redis.call('GET', counterKey) or '0')
if current >= limit then
  local pttl = redis.call('PTTL', counterKey)
  if not pttl or pttl <= 0 then
    pttl = ttlMs
  end
  local totalHits = current + 1
  local timeToBlockMs = pttl
  if blockDurationMs > 0 then
    redis.call('SET', blockKey, tostring(totalHits), 'PX', blockDurationMs)
    redis.call('DEL', counterKey)
    timeToBlockMs = blockDurationMs
  end
  return { totalHits, pttl, 1, timeToBlockMs }
end

local hits = redis.call('INCR', counterKey)
local pttl = redis.call('PTTL', counterKey)
if hits == 1 or not pttl or pttl < 0 then
  redis.call('PEXPIRE', counterKey, ttlMs)
  pttl = ttlMs
end
return { hits, pttl, 0, 0 }
`.trim();

/**
 * Atomic Redis Lua sliding-window throttler script using a Sorted Set (`ZREMRANGEBYSCORE`,
 * `ZCARD`, `ZADD`, `ZRANGE WITHSCORES`, `PEXPIRE`) and dedicated block keys with `SET ... PX`.
 * Rejected requests do NOT pollute the sliding window (matching `MemoryThrottlerStorage`).
 *
 * `KEYS = [zsetKey, blockKey]`
 * `ARGV = [ttlMs, limit, blockDurationMs, nowMs, memberId]`
 * Returns `{ totalHits, timeToExpireMs, isBlocked (0|1), timeToBlockExpireMs }`.
 */
export const LUA_SLIDING_WINDOW_INCREMENT = `
local zsetKey = KEYS[1]
local blockKey = KEYS[2]
local ttlMs = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local blockDurationMs = tonumber(ARGV[3])
local nowMs = tonumber(ARGV[4])
local memberId = ARGV[5]

local blockPttl = redis.call('PTTL', blockKey)
if blockPttl and blockPttl > 0 then
  local blockedHits = tonumber(redis.call('GET', blockKey) or '0')
  if blockedHits <= limit then
    blockedHits = limit + 1
  end
  local pttl = redis.call('PTTL', zsetKey)
  if not pttl or pttl <= 0 then
    pttl = blockPttl
  end
  return { blockedHits, pttl, 1, blockPttl }
end

local cutoff = nowMs - ttlMs
redis.call('ZREMRANGEBYSCORE', zsetKey, '-inf', cutoff)
local count = tonumber(redis.call('ZCARD', zsetKey))

if count >= limit then
  local oldest = redis.call('ZRANGE', zsetKey, 0, 0, 'WITHSCORES')
  local pttl = ttlMs
  if oldest and oldest[2] then
    pttl = math.max(1, tonumber(oldest[2]) + ttlMs - nowMs)
  end
  local totalHits = count + 1
  local timeToBlockMs = pttl
  if blockDurationMs > 0 then
    redis.call('SET', blockKey, tostring(totalHits), 'PX', blockDurationMs)
    redis.call('DEL', zsetKey)
    timeToBlockMs = blockDurationMs
  end
  return { totalHits, pttl, 1, timeToBlockMs }
end

redis.call('ZADD', zsetKey, nowMs, memberId)
redis.call('PEXPIRE', zsetKey, ttlMs)
local oldest = redis.call('ZRANGE', zsetKey, 0, 0, 'WITHSCORES')
local pttl = ttlMs
if oldest and oldest[2] then
  pttl = math.max(1, tonumber(oldest[2]) + ttlMs - nowMs)
end
return { count + 1, pttl, 0, 0 }
`.trim();

export type RedisThrottlerAlgorithm = "fixed-window" | "sliding-window";

/**
 * Minimal structural Redis client contract compatible with Bun's native
 * `Bun.RedisClient`, `ioredis`, or custom Lua-capable Redis test doubles.
 */
export interface RedisThrottlerClientLike {
  eval?(
    script: string,
    numKeys: number,
    ...args: Array<string | number>
  ): Promise<unknown>;
  evalsha?(
    sha1: string,
    numKeys: number,
    ...args: Array<string | number>
  ): Promise<unknown>;
  scriptLoad?(script: string): Promise<string>;
  send?(command: string, args: string[]): Promise<unknown>;
  del?(...keys: string[]): Promise<number>;
  scan?(
    cursor: string | number,
    ...args: Array<string | number>
  ): Promise<[string | number, string[]]>;
  keys?(pattern: string): Promise<string[]>;
  close?(): Promise<void> | void;
  quit?(): Promise<unknown> | void;
  disconnect?(): void;
}

export interface RedisThrottlerStorageOptions {
  /**
   * Key namespace prefix prepended to throttler keys (`<prefix>:{<key>}`).
   * Pass `""` to disable prefixing.
   * @default "bunest:throttle"
   */
  prefix?: string;
  /** Alias for `prefix`. */
  keyPrefix?: string;
  /**
   * Rate-limiting algorithm:
   * - `"fixed-window"` (default): O(1) memory per key via atomic `INCR`/`PEXPIRE`/`PTTL`.
   * - `"sliding-window"`: exact sliding window via atomic Sorted Set (`ZREMRANGEBYSCORE`/`ZADD`/`PEXPIRE`).
   * @default "fixed-window"
   */
  algorithm?: RedisThrottlerAlgorithm;
  /**
   * Optional clock source returning epoch milliseconds (used by `"sliding-window"` mode; defaults to `Date.now`).
   */
  now?: () => number;
  /**
   * Batch COUNT hint passed to Redis `SCAN` during `clear()`.
   * @default 200
   */
  scanCount?: number;
}

function isBunRedisClient(client: unknown): client is Bun.RedisClient {
  return (
    typeof Bun !== "undefined" &&
    typeof Bun.RedisClient === "function" &&
    client instanceof Bun.RedisClient
  );
}

function escapeGlob(input: string): string {
  return input.replace(/([*?[\]\\])/g, "\\$1");
}

/**
 * Distributed Redis `ThrottlerStorage` using atomic Lua scripts and hash-tagged keys
 * (`<prefix>:{<key>}` / `<prefix>:{<key>}:block`) for Redis Cluster compatibility
 * and accurate multi-node rate limiting with `blockDuration` support.
 */
@Injectable()
export class RedisThrottlerStorage
  implements ThrottlerStorage, OnModuleDestroy, OnApplicationShutdown
{
  private readonly nativeRedis?: Bun.RedisClient;
  private readonly client?: RedisThrottlerClientLike;
  private readonly ownsClient: boolean;
  private readonly prefix: string;
  private readonly algorithm: RedisThrottlerAlgorithm;
  private readonly now: () => number;
  private readonly scanCount: number;
  private readonly scriptShas = new Map<string, string>();
  private seq = 0;

  constructor(
    redis: Bun.RedisClient | RedisThrottlerClientLike | string,
    options: RedisThrottlerStorageOptions = {},
  ) {
    if (typeof redis === "string") {
      this.nativeRedis = new Bun.RedisClient(redis);
      this.ownsClient = true;
    } else if (isBunRedisClient(redis)) {
      this.nativeRedis = redis;
      this.ownsClient = false;
    } else {
      this.client = redis;
      this.ownsClient = false;
    }

    this.prefix = options.prefix ?? options.keyPrefix ?? "bunest:throttle";
    this.algorithm = options.algorithm ?? "fixed-window";
    this.now = options.now ?? (() => Date.now());
    this.scanCount = options.scanCount ?? 200;
  }

  private keysFor(key: string): [counterKey: string, blockKey: string] {
    // Hash-tag `{key}` ensures counterKey and blockKey map to the same Redis Cluster hash slot.
    const base = this.prefix.length > 0 ? `${this.prefix}:{${key}}` : `{${key}}`;
    return [base, `${base}:block`];
  }

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration = 0,
    _throttlerName = "default",
  ): Promise<ThrottlerStorageRecord> {
    const ttlMs = Math.max(1, Math.floor(ttl));
    const normalizedLimit = Math.floor(limit);
    const blockMs = blockDuration > 0 ? Math.max(1, Math.floor(blockDuration)) : 0;
    const [counterKey, blockKey] = this.keysFor(key);

    let rawResult: unknown;
    if (this.algorithm === "sliding-window") {
      const nowMs = this.now();
      this.seq = (this.seq + 1) & 0x7fff_ffff;
      const memberId = `${nowMs}:${this.seq}:${crypto.randomUUID()}`;
      rawResult = await this.runLua(
        LUA_SLIDING_WINDOW_INCREMENT,
        [counterKey, blockKey],
        [
          String(ttlMs),
          String(normalizedLimit),
          String(blockMs),
          String(nowMs),
          memberId,
        ],
      );
    } else {
      rawResult = await this.runLua(
        LUA_FIXED_WINDOW_INCREMENT,
        [counterKey, blockKey],
        [String(ttlMs), String(normalizedLimit), String(blockMs)],
      );
    }

    if (!Array.isArray(rawResult) || rawResult.length < 4) {
      throw new Error(
        `RedisThrottlerStorage: unexpected Lua script result: ${JSON.stringify(rawResult)}`,
      );
    }

    const totalHits = Number(rawResult[0]);
    const timeToExpireMs = Number(rawResult[1]);
    const isBlocked = Number(rawResult[2]) === 1;
    const timeToBlockExpireMs = Number(rawResult[3]);

    return {
      totalHits,
      timeToExpire: Math.ceil(Math.max(1, timeToExpireMs) / 1000),
      isBlocked,
      timeToBlockExpire: isBlocked
        ? Math.ceil(Math.max(1, timeToBlockExpireMs) / 1000)
        : 0,
    };
  }

  async reset(key: string): Promise<void> {
    const [counterKey, blockKey] = this.keysFor(key);
    await this.deleteKeys([counterKey, blockKey]);
  }

  async clear(): Promise<void> {
    const pattern =
      this.prefix.length > 0 ? `${escapeGlob(this.prefix)}:*` : "{*}*";
    const matched = await this.scanMatchingKeys(pattern);
    if (matched.length > 0) {
      await this.deleteKeys(matched);
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.ownsClient && this.nativeRedis) {
      this.nativeRedis.close();
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.onModuleDestroy();
  }

  private async runLua(
    script: string,
    keys: readonly string[],
    args: ReadonlyArray<string | number>,
  ): Promise<unknown> {
    if (this.nativeRedis) {
      return await this.nativeRedis.send("EVAL", [
        script,
        String(keys.length),
        ...keys,
        ...args.map(String),
      ]);
    }

    const client = this.client;
    if (
      typeof client?.evalsha === "function" &&
      typeof client?.scriptLoad === "function"
    ) {
      let sha = this.scriptShas.get(script);
      if (!sha) {
        sha = await client.scriptLoad(script);
        this.scriptShas.set(script, sha);
      }
      try {
        return await client.evalsha(sha, keys.length, ...keys, ...args);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("NOSCRIPT")) {
          throw err;
        }
        this.scriptShas.delete(script);
        if (typeof client.eval === "function") {
          return await client.eval(script, keys.length, ...keys, ...args);
        }
        const reloaded = await client.scriptLoad(script);
        this.scriptShas.set(script, reloaded);
        return await client.evalsha(reloaded, keys.length, ...keys, ...args);
      }
    }

    if (typeof client?.eval === "function") {
      return await client.eval(script, keys.length, ...keys, ...args);
    }

    if (typeof client?.send === "function") {
      return await client.send("EVAL", [
        script,
        String(keys.length),
        ...keys,
        ...args.map(String),
      ]);
    }

    throw new Error(
      'RedisThrottlerStorage requires a Redis client supporting eval(), evalsha()+scriptLoad(), or send("EVAL", ...) for atomic rate-limit scripts.',
    );
  }

  private async deleteKeys(keys: readonly string[]): Promise<void> {
    if (keys.length === 0) {
      return;
    }
    if (this.nativeRedis) {
      await this.nativeRedis.send("DEL", [...keys]);
      return;
    }
    if (typeof this.client?.del === "function") {
      await this.client.del(...keys);
      return;
    }
    if (typeof this.client?.send === "function") {
      await this.client.send("DEL", [...keys]);
    }
  }

  private async scanMatchingKeys(pattern: string): Promise<string[]> {
    const found = new Set<string>();

    if (this.nativeRedis || typeof this.client?.send === "function") {
      const sendFn = this.nativeRedis
        ? (cmd: string, args: string[]) => this.nativeRedis!.send(cmd, args)
        : (cmd: string, args: string[]) => this.client!.send!(cmd, args);
      let cursor = "0";
      let guard = 0;
      while (guard < 10_000) {
        guard += 1;
        const res = await sendFn("SCAN", [
          cursor,
          "MATCH",
          pattern,
          "COUNT",
          String(this.scanCount),
        ]);
        if (!Array.isArray(res) || res.length < 2) {
          break;
        }
        const nextCursor = String(res[0]);
        const batch = Array.isArray(res[1]) ? (res[1] as string[]) : [];
        for (const k of batch) {
          found.add(String(k));
        }
        if (nextCursor === "0") {
          break;
        }
        cursor = nextCursor;
      }
      return [...found];
    }

    if (typeof this.client?.scan === "function") {
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
        for (const k of batch) {
          found.add(k);
        }
        if (String(nextCursor) === "0") {
          break;
        }
        cursor = nextCursor;
      }
      return [...found];
    }

    if (typeof this.client?.keys === "function") {
      return await this.client.keys(pattern);
    }

    return [];
  }
}
