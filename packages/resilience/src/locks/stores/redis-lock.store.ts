import type {
  LockAcquireResult,
  LockStore,
} from "../interfaces/lock-store.interface";
import type { LocksStorageRegisterOptions } from "../interfaces/locks-storage-register-options.interface";
import type { LocksStorage } from "../storage/locks.storage";

/**
 * Atomic Redis Lua script acquiring a lock and incrementing its monotonic fencing token.
 *
 * - `KEYS[1]`: lock key (`<prefix>:lock:<key>`)
 * - `KEYS[2]`: fencing counter key (`<prefix>:fence:<key>`)
 * - `ARGV[1]`: unique owner token
 * - `ARGV[2]`: lease TTL in milliseconds (64-bit integer)
 *
 * Returns the new positive integer fencing token on acquisition, or `0` if the key
 * is already held by any live lock (including the same owner).
 */
export const LUA_REDIS_LOCK_ACQUIRE = `
if redis.call("SET", KEYS[1], ARGV[1], "NX", "PX", ARGV[2]) then
  return redis.call("INCR", KEYS[2])
end
return 0
`.trim();

/**
 * Atomic Redis Lua script extending a lock's TTL (`PEXPIRE`) only when its stored
 * owner matches the caller's token. Never revives expired locks or extends another node's lock.
 *
 * - `KEYS[1]`: lock key (`<prefix>:lock:<key>`)
 * - `ARGV[1]`: owner token
 * - `ARGV[2]`: new lease TTL in milliseconds
 *
 * Returns `1` if renewed, `0` otherwise.
 */
export const LUA_REDIS_LOCK_RENEW = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("PEXPIRE", KEYS[1], ARGV[2])
end
return 0
`.trim();

/**
 * Atomic Redis Lua script deleting a lock only when its stored owner matches the
 * caller's token. Never deletes another node's lock and never resets the fencing counter.
 *
 * - `KEYS[1]`: lock key (`<prefix>:lock:<key>`)
 * - `ARGV[1]`: owner token
 *
 * Returns `1` if released, `0` otherwise.
 */
export const LUA_REDIS_LOCK_RELEASE = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`.trim();

/**
 * Structural Redis client contract compatible with Bun's native `Bun.RedisClient`,
 * `ioredis`, wrappers, and Lua-evaluating test doubles with zero external deps.
 */
export interface RedisLockClientLike {
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

export interface RedisLockStoreOptions {
  /**
   * Key prefix namespace applied to lock keys (`<prefix>:lock:<key>`) and fencing
   * counters (`<prefix>:fence:<key>`). Pass `""` to omit the namespace prefix.
   * @default "bunest:locks"
   */
  readonly prefix?: string;
}

const DEFAULT_PREFIX = "bunest:locks";

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
      `RedisLockStore.${method}(): ttl must be a positive finite number of milliseconds, got ${String(ttl)}`,
    );
  }
  return Math.max(1, Math.trunc(ttl));
}

/**
 * Production distributed `LockStore` backed by Redis (`Bun.RedisClient` or any
 * structural `RedisLockClientLike`) using atomic Lua scripts for acquisition with
 * monotonic fencing tokens, owner-checked renewal, and owner-checked release.
 *
 * Makes `@OnOneInstance`, `@WithoutOverlapping`, `@WithLock`, `@LeaderElection`,
 * and `Locks.acquire()` / `Locks.withLock()` multi-node safe out of the box.
 */
export class RedisLockStore implements LockStore {
  private readonly prefix: string;
  private readonly nativeRedis?: Bun.RedisClient;
  private readonly client?: RedisLockClientLike;
  private readonly ownsClient: boolean;
  private readonly scriptShas = new Map<string, string>();
  private closed = false;

  constructor(
    redis: Bun.RedisClient | RedisLockClientLike | string,
    options: RedisLockStoreOptions = {},
  ) {
    if (typeof redis === "string") {
      if (redis.length === 0) {
        throw new TypeError(
          "RedisLockStore: Redis connection URL must be a non-empty string.",
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
        'RedisLockStore: expected a Redis URL string, Bun.RedisClient, or RedisLockClientLike supporting eval(), evalsha()+scriptLoad(), or send("EVAL", ...).',
      );
    }
    this.prefix = options.prefix ?? DEFAULT_PREFIX;
  }

  /**
   * Convenience helper registering this store into `LocksStorage`.
   */
  registerInto(
    storage: LocksStorage,
    options?: LocksStorageRegisterOptions,
  ): void {
    storage.registerSource(this, options);
  }

  async acquire(
    key: string,
    owner: string,
    ttl: number,
  ): Promise<LockAcquireResult> {
    const ttlMs = normalizeTtlMs(ttl, "acquire");
    const result = await this.runLua(
      LUA_REDIS_LOCK_ACQUIRE,
      [this.lockKey(key), this.fenceKey(key)],
      [owner, String(ttlMs)],
    );
    const fencingToken = Number(result);
    if (Number.isSafeInteger(fencingToken) && fencingToken >= 1) {
      return { acquired: true, fencingToken };
    }
    return { acquired: false };
  }

  async renew(key: string, owner: string, ttl: number): Promise<boolean> {
    const ttlMs = normalizeTtlMs(ttl, "renew");
    const result = await this.runLua(
      LUA_REDIS_LOCK_RENEW,
      [this.lockKey(key)],
      [owner, String(ttlMs)],
    );
    return Number(result) === 1;
  }

  async release(key: string, owner: string): Promise<boolean> {
    const result = await this.runLua(
      LUA_REDIS_LOCK_RELEASE,
      [this.lockKey(key)],
      [owner],
    );
    return Number(result) === 1;
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

  private lockKey(key: string): string {
    return this.prefix.length > 0 ? `${this.prefix}:lock:${key}` : `lock:${key}`;
  }

  private fenceKey(key: string): string {
    return this.prefix.length > 0
      ? `${this.prefix}:fence:${key}`
      : `fence:${key}`;
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
      'RedisLockStore: client does not support eval(), evalsha()+scriptLoad(), or send("EVAL", ...).',
    );
  }
}
