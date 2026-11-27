export const SCHEDULER_LOCK_DRIVER = Symbol.for("bunest:scheduler:lock-driver");

/**
 * Atomic Redis Lua script releasing a lock only when its stored value matches
 * the caller's unique owner token (`KEYS[1] = lockKey`, `ARGV[1] = token`).
 */
export const LUA_RELEASE_LOCK = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end
`.trim();

/**
 * Atomic Redis Lua script extending a lock's TTL (`PEXPIRE`) only when its
 * stored value matches the caller's unique owner token
 * (`KEYS[1] = lockKey`, `ARGV[1] = token`, `ARGV[2] = ttlMs`).
 */
export const LUA_RENEW_LOCK = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("PEXPIRE", KEYS[1], ARGV[2])
else
  return 0
end
`.trim();

export type CronLockMode = "skip" | "leader";

export interface CronLockOptions {
  /**
   * Lock lease duration in milliseconds.
   */
  readonly ttlMs: number;
  /**
   * Explicit distributed lock key shared across cluster replicas.
   * Defaults to the cron job's name (or deterministic `ClassName.methodName`).
   */
  readonly key?: string;
  /**
   * Locking mode:
   * - `"skip"` (default): acquire a lock before each tick, skip if held by another node,
   *   and release automatically when the tick finishes.
   * - `"leader"`: elect a single leader holding and periodically renewing the lease
   *   while running; standbys automatically take over if the leader stops or crashes.
   * @default "skip"
   */
  readonly mode?: CronLockMode;
  /**
   * Renewal interval in milliseconds while holding an active lock or leadership lease.
   * Defaults to `Math.max(10, Math.floor(ttlMs / 2))`.
   */
  readonly renewIntervalMs?: number;
}

/**
 * Alias for `CronLockOptions` used by `ScheduleModuleOptions.defaultLock`.
 */
export type SchedulerLockOptions = CronLockOptions;

/**
 * Pluggable distributed lock driver for `@Cron()` jobs.
 */
export interface SchedulerLockDriver {
  acquire(
    key: string,
    ttlMs: number,
    token: string,
  ): Promise<boolean> | boolean;
  release(
    key: string,
    token: string,
  ): Promise<boolean | void> | boolean | void;
  renew?(
    key: string,
    ttlMs: number,
    token: string,
  ): Promise<boolean> | boolean;
}

export interface InMemorySchedulerLockDriverOptions {
  /**
   * Optional clock provider returning epoch milliseconds (useful for deterministic tests).
   * @default Date.now
   */
  readonly now?: () => number;
}

interface MemoryLockEntry {
  readonly token: string;
  expiresAt: number;
}

/**
 * Zero-dependency in-memory `SchedulerLockDriver` for single-node deployments
 * and deterministic unit/integration testing.
 */
export class InMemorySchedulerLockDriver implements SchedulerLockDriver {
  private readonly locks = new Map<string, MemoryLockEntry>();
  private readonly now: () => number;

  constructor(options: InMemorySchedulerLockDriverOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  async acquire(key: string, ttlMs: number, token: string): Promise<boolean> {
    const currentTime = this.now();
    const existing = this.locks.get(key);
    if (existing && existing.expiresAt > currentTime) {
      return false;
    }
    const ttl = Math.max(1, Math.floor(ttlMs));
    this.locks.set(key, {
      token,
      expiresAt: currentTime + ttl,
    });
    return true;
  }

  async release(key: string, token: string): Promise<boolean> {
    const currentTime = this.now();
    const existing = this.locks.get(key);
    if (!existing) {
      return false;
    }
    if (existing.expiresAt <= currentTime) {
      this.locks.delete(key);
      return false;
    }
    if (existing.token !== token) {
      return false;
    }
    this.locks.delete(key);
    return true;
  }

  async renew(key: string, ttlMs: number, token: string): Promise<boolean> {
    const currentTime = this.now();
    const existing = this.locks.get(key);
    if (!existing) {
      return false;
    }
    if (existing.expiresAt <= currentTime) {
      this.locks.delete(key);
      return false;
    }
    if (existing.token !== token) {
      return false;
    }
    const ttl = Math.max(1, Math.floor(ttlMs));
    existing.expiresAt = currentTime + ttl;
    return true;
  }

  has(key: string): boolean {
    const existing = this.locks.get(key);
    if (!existing) {
      return false;
    }
    if (existing.expiresAt <= this.now()) {
      this.locks.delete(key);
      return false;
    }
    return true;
  }

  clear(): void {
    this.locks.clear();
  }
}

/**
 * Minimal structural Redis client contract compatible with Bun's native
 * `Bun.RedisClient`, `ioredis`, or mock Redis clients with zero external deps.
 */
export interface RedisLockClientLike {
  set?(
    key: string,
    value: string,
    ...args: Array<string | number>
  ): Promise<string | null | boolean | number>;
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
}

export interface RedisSchedulerLockDriverOptions {
  /**
   * Optional key prefix prepended to lock keys (`<prefix>:<key>`).
   * Pass `""` to use raw keys with no prefix or leading colon.
   * @default "bunest:cron:lock"
   */
  readonly prefix?: string;
}

function isBunRedisClient(client: unknown): client is Bun.RedisClient {
  return (
    typeof Bun !== "undefined" &&
    typeof Bun.RedisClient === "function" &&
    client instanceof Bun.RedisClient
  );
}

/**
 * Distributed Redis `SchedulerLockDriver` using atomic `SET key token NX PX ttlMs`
 * acquisition and token-verified Lua scripts (`LUA_RELEASE_LOCK`, `LUA_RENEW_LOCK`)
 * for safe release and lease renewal.
 */
export class RedisSchedulerLockDriver implements SchedulerLockDriver {
  private readonly prefix: string;
  private readonly nativeRedis?: Bun.RedisClient;
  private readonly client?: RedisLockClientLike;
  private readonly scriptShas = new Map<string, string>();

  constructor(
    redis: Bun.RedisClient | RedisLockClientLike | string,
    options: RedisSchedulerLockDriverOptions = {},
  ) {
    if (typeof redis === "string") {
      this.nativeRedis = new Bun.RedisClient(redis);
    } else if (isBunRedisClient(redis)) {
      this.nativeRedis = redis;
    } else {
      this.client = redis;
    }
    this.prefix = options.prefix ?? "bunest:cron:lock";
  }

  private formatKey(key: string): string {
    return this.prefix.length > 0 ? `${this.prefix}:${key}` : key;
  }

  async acquire(key: string, ttlMs: number, token: string): Promise<boolean> {
    const fullKey = this.formatKey(key);
    const ttl = Math.max(1, Math.floor(ttlMs));

    let res: unknown;
    if (this.nativeRedis) {
      res = await this.nativeRedis.send("SET", [
        fullKey,
        token,
        "NX",
        "PX",
        String(ttl),
      ]);
    } else if (typeof this.client?.set === "function") {
      res = await this.client.set(fullKey, token, "NX", "PX", ttl);
    } else if (typeof this.client?.send === "function") {
      res = await this.client.send("SET", [
        fullKey,
        token,
        "NX",
        "PX",
        String(ttl),
      ]);
    } else {
      throw new Error(
        'RedisSchedulerLockDriver requires a Redis client implementing set() or send("SET", ...).',
      );
    }

    return res === "OK" || res === true || res === 1;
  }

  async release(key: string, token: string): Promise<boolean> {
    const fullKey = this.formatKey(key);
    const res = await this.runLua(LUA_RELEASE_LOCK, [fullKey], [token]);
    return Number(res) === 1;
  }

  async renew(key: string, ttlMs: number, token: string): Promise<boolean> {
    const fullKey = this.formatKey(key);
    const ttl = Math.max(1, Math.floor(ttlMs));
    const res = await this.runLua(
      LUA_RENEW_LOCK,
      [fullKey],
      [token, String(ttl)],
    );
    return Number(res) === 1;
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
      'RedisSchedulerLockDriver requires a Redis client supporting eval(), evalsha()+scriptLoad(), or send("EVAL", ...) for atomic token-verified lock scripts.',
    );
  }
}
