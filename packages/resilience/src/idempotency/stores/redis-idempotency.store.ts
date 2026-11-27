import type { IdempotencyStorageRegisterOptions } from "../interfaces/idempotency-storage.interface";
import type {
  IdempotencyAcquireResult,
  IdempotencyStore,
  IdempotencyStoredPayload,
} from "../interfaces/idempotency-store.interface";
import type { IdempotencyStorage } from "../storage/idempotency.storage";

/**
 * Atomic Redis Lua script acquiring an idempotency key or inspecting an existing
 * live in-flight lock / completed replay record.
 *
 * - `KEYS[1]`: idempotency hash key (`<prefix>:<key>`)
 * - `ARGV[1]`: unique owner token
 * - `ARGV[2]`: request fingerprint
 * - `ARGV[3]`: lock TTL in milliseconds (64-bit integer)
 *
 * Returns a tuple:
 * - `{"acquired"}` if the key was free and is now locked in-flight for `ARGV[1]`
 * - `{"completed", fingerprint, responseJson}` if a completed record exists
 * - `{"in-flight", fingerprint}` if another live execution currently holds the key
 */
export const LUA_REDIS_IDEMPOTENCY_ACQUIRE = `
if redis.call("EXISTS", KEYS[1]) == 0 then
  redis.call("HSET", KEYS[1], "state", "in-flight", "owner", ARGV[1], "fingerprint", ARGV[2])
  redis.call("PEXPIRE", KEYS[1], ARGV[3])
  return {"acquired"}
end
local vals = redis.call("HMGET", KEYS[1], "state", "fingerprint", "response")
if vals[1] == "completed" then
  return {"completed", vals[2] or "", vals[3] or ""}
end
return {"in-flight", vals[2] or ""}
`.trim();

/**
 * Atomic Redis Lua script committing a completed idempotency response for the
 * active lock owner and updating the key's expiration to the replay TTL.
 *
 * - `KEYS[1]`: idempotency hash key (`<prefix>:<key>`)
 * - `ARGV[1]`: owner token
 * - `ARGV[2]`: JSON-serialized `IdempotencyStoredPayload`
 * - `ARGV[3]`: replay record TTL in milliseconds
 *
 * Returns `1` on compare-and-set success, `0` otherwise.
 */
export const LUA_REDIS_IDEMPOTENCY_COMPLETE = `
local vals = redis.call("HMGET", KEYS[1], "state", "owner")
if vals[1] == "in-flight" and vals[2] == ARGV[1] then
  redis.call("HSET", KEYS[1], "state", "completed", "response", ARGV[2])
  redis.call("HDEL", KEYS[1], "owner")
  redis.call("PEXPIRE", KEYS[1], ARGV[3])
  return 1
end
return 0
`.trim();

/**
 * Atomic Redis Lua script deleting an in-flight idempotency lock only when its
 * stored owner matches the caller's token. Never deletes completed records or
 * another node's lock.
 *
 * - `KEYS[1]`: idempotency hash key (`<prefix>:<key>`)
 * - `ARGV[1]`: owner token
 *
 * Returns `1` if deleted, `0` otherwise.
 */
export const LUA_REDIS_IDEMPOTENCY_RELEASE = `
local vals = redis.call("HMGET", KEYS[1], "state", "owner")
if vals[1] == "in-flight" and vals[2] == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`.trim();

/**
 * Atomic Redis Lua script extending an in-flight idempotency lock's TTL only
 * when its stored owner matches the caller's token. Never revives expired locks
 * or modifies completed records.
 *
 * - `KEYS[1]`: idempotency hash key (`<prefix>:<key>`)
 * - `ARGV[1]`: owner token
 * - `ARGV[2]`: new lock TTL in milliseconds
 *
 * Returns `1` if extended, `0` otherwise.
 */
export const LUA_REDIS_IDEMPOTENCY_EXTEND = `
local vals = redis.call("HMGET", KEYS[1], "state", "owner")
if vals[1] == "in-flight" and vals[2] == ARGV[1] then
  return redis.call("PEXPIRE", KEYS[1], ARGV[2])
end
return 0
`.trim();

/**
 * Structural Redis client contract compatible with Bun's native `Bun.RedisClient`,
 * `ioredis`, wrappers, and Lua-evaluating test doubles with zero external deps.
 */
export interface RedisIdempotencyClientLike {
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
  close?(): Promise<void> | void;
  quit?(): Promise<unknown>;
}

export interface RedisIdempotencyStoreOptions {
  /**
   * Key prefix namespace applied to idempotency keys (`<prefix>:<key>`).
   * Pass `""` to use raw keys with no prefix.
   * @default "bunest:idempotency"
   */
  readonly prefix?: string;
}

const DEFAULT_PREFIX = "bunest:idempotency";

function isBunRedisClient(client: unknown): client is Bun.RedisClient {
  return (
    typeof Bun !== "undefined" &&
    typeof Bun.RedisClient === "function" &&
    client instanceof Bun.RedisClient
  );
}

function normalizeTtlMs(ttl: number, method: string): number {
  if (!Number.isFinite(ttl) || ttl <= 0) {
    throw new RangeError(
      `RedisIdempotencyStore.${method}(): ttl must be a positive finite number of milliseconds, got ${String(ttl)}`,
    );
  }
  return Math.max(1, Math.trunc(ttl));
}

/**
 * Production distributed `IdempotencyStore` backed by Redis (`Bun.RedisClient` or
 * any structural `RedisIdempotencyClientLike`) using atomic Lua scripts over Redis
 * Hashes for acquire, compare-and-set commit (`complete`), heartbeat (`extend`),
 * and owner-checked failure cleanup (`release`).
 *
 * Payloads are JSON-serialized in JavaScript and stored verbatim as an opaque Hash
 * field so Lua never alters empty objects, large integers, or control characters.
 */
export class RedisIdempotencyStore implements IdempotencyStore {
  private readonly prefix: string;
  private readonly nativeRedis?: Bun.RedisClient;
  private readonly client?: RedisIdempotencyClientLike;
  private readonly ownsClient: boolean;
  private readonly scriptShas = new Map<string, string>();
  private closed = false;

  constructor(
    redis: Bun.RedisClient | RedisIdempotencyClientLike | string,
    options: RedisIdempotencyStoreOptions = {},
  ) {
    if (typeof redis === "string") {
      if (redis.length === 0) {
        throw new TypeError(
          "RedisIdempotencyStore: Redis connection URL must be a non-empty string.",
        );
      }
      this.nativeRedis = new Bun.RedisClient(redis);
      this.ownsClient = true;
    } else if (isBunRedisClient(redis)) {
      this.nativeRedis = redis;
      this.ownsClient = false;
    } else if (
      redis !== null &&
      typeof redis === "object" &&
      (typeof redis.eval === "function" ||
        typeof redis.send === "function" ||
        (typeof redis.evalsha === "function" &&
          typeof redis.scriptLoad === "function"))
    ) {
      this.client = redis;
      this.ownsClient = false;
    } else {
      throw new TypeError(
        'RedisIdempotencyStore: expected a Redis URL string, Bun.RedisClient, or RedisIdempotencyClientLike supporting eval(), evalsha()+scriptLoad(), or send("EVAL", ...).',
      );
    }
    this.prefix = options.prefix ?? DEFAULT_PREFIX;
  }

  /**
   * Convenience helper registering this store into `IdempotencyStorage`.
   */
  registerInto(
    storage: IdempotencyStorage,
    options?: IdempotencyStorageRegisterOptions,
  ): void {
    storage.registerSource(this, options);
  }

  async acquire(
    key: string,
    owner: string,
    fingerprint: string,
    lockTtl: number,
  ): Promise<IdempotencyAcquireResult> {
    const ttlMs = normalizeTtlMs(lockTtl, "acquire");
    const raw = await this.runLua(
      LUA_REDIS_IDEMPOTENCY_ACQUIRE,
      [this.formatKey(key)],
      [owner, fingerprint, String(ttlMs)],
    );

    if (!Array.isArray(raw) || raw.length === 0) {
      throw new Error(
        `RedisIdempotencyStore.acquire(): unexpected Lua reply ${JSON.stringify(raw)}`,
      );
    }

    const state = String(raw[0]);
    if (state === "acquired") {
      return { state: "acquired" };
    }
    if (state === "in-flight") {
      return {
        state: "in-flight",
        fingerprint: raw[1] === undefined || raw[1] === null ? "" : String(raw[1]),
      };
    }
    if (state === "completed") {
      const storedFingerprint =
        raw[1] === undefined || raw[1] === null ? "" : String(raw[1]);
      const responseJson =
        raw[2] === undefined || raw[2] === null ? "" : String(raw[2]);
      const response = JSON.parse(responseJson) as IdempotencyStoredPayload;
      return {
        state: "completed",
        fingerprint: storedFingerprint,
        response,
      };
    }

    throw new Error(
      `RedisIdempotencyStore.acquire(): unknown state "${state}" returned from Redis.`,
    );
  }

  async complete(
    key: string,
    owner: string,
    response: IdempotencyStoredPayload,
    ttl: number,
  ): Promise<boolean> {
    const ttlMs = normalizeTtlMs(ttl, "complete");
    const serialized = JSON.stringify(response);
    const res = await this.runLua(
      LUA_REDIS_IDEMPOTENCY_COMPLETE,
      [this.formatKey(key)],
      [owner, serialized, String(ttlMs)],
    );
    return Number(res) === 1;
  }

  async release(key: string, owner: string): Promise<boolean> {
    const res = await this.runLua(
      LUA_REDIS_IDEMPOTENCY_RELEASE,
      [this.formatKey(key)],
      [owner],
    );
    return Number(res) === 1;
  }

  async extend(key: string, owner: string, lockTtl: number): Promise<boolean> {
    const ttlMs = normalizeTtlMs(lockTtl, "extend");
    const res = await this.runLua(
      LUA_REDIS_IDEMPOTENCY_EXTEND,
      [this.formatKey(key)],
      [owner, String(ttlMs)],
    );
    return Number(res) === 1;
  }

  /**
   * Closes the underlying `Bun.RedisClient` if this store created it from a URL
   * string. No-op for externally provided clients or repeated calls.
   */
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.ownsClient && this.nativeRedis) {
      this.nativeRedis.close();
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  private formatKey(key: string): string {
    return this.prefix.length > 0 ? `${this.prefix}:${key}` : key;
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

    const client = this.client!;
    if (
      typeof client.evalsha === "function" &&
      typeof client.scriptLoad === "function"
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

    if (typeof client.eval === "function") {
      return await client.eval(script, keys.length, ...keys, ...args);
    }

    if (typeof client.send === "function") {
      return await client.send("EVAL", [
        script,
        String(keys.length),
        ...keys,
        ...args.map(String),
      ]);
    }

    throw new TypeError(
      'RedisIdempotencyStore: client does not support eval(), evalsha()+scriptLoad(), or send("EVAL", ...).',
    );
  }
}
