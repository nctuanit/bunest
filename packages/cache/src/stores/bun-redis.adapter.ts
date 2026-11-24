/**
 * Pluggable Redis client interface compatible with Bun's native `RedisClient`,
 * `ioredis`, `node-redis` wrappers, and in-memory test doubles.
 */
export interface RedisClientLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: any[]): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  exists?(key: string): Promise<number | boolean>;
  pttl?(key: string): Promise<number>;
  ttl?(key: string): Promise<number>;
  mget?(...keys: string[]): Promise<Array<string | null>>;
  scan?(
    cursor: string | number,
    ...args: any[]
  ): Promise<readonly [string | number, readonly string[]]>;
  keys?(pattern: string): Promise<string[]>;
  sadd?(key: string, ...members: string[]): Promise<number>;
  smembers?(key: string): Promise<string[]>;
  flushdb?(): Promise<unknown>;
  quit?(): Promise<unknown>;
  close?(): Promise<void> | void;
  disconnect?(): void;
}

export interface BunRedisCacheOptions {
  /** Redis connection URL (e.g. `"redis://localhost:6379"`). Defaults to `Bun.redis`. */
  url?: string;
  /** Existing `Bun.RedisClient` instance. */
  client?: Bun.RedisClient;
}

/**
 * Adapts Bun's native Zig `Bun.RedisClient` (`Bun.redis` or `new Bun.RedisClient(url)`)
 * to Bunest's `RedisClientLike` contract with zero external dependencies.
 */
export function createBunRedisClient(
  urlOrClient?: string | Bun.RedisClient,
): RedisClientLike {
  const native =
    typeof urlOrClient === "string"
      ? new Bun.RedisClient(urlOrClient)
      : urlOrClient ?? Bun.redis;

  return {
    get: (key) => native.get(key),
    set: (key, value, ...args) =>
      native.send("SET", [key, value, ...args.map(String)]),
    del: (...keys) => native.del(...keys),
    exists: (key) => native.exists(key),
    pttl: async (key) => Number(await native.send("PTTL", [key])),
    ttl: (key) => native.ttl(key),
    mget: async (...keys) =>
      (await native.send("MGET", keys)) as Array<string | null>,
    scan: async (cursor, ...args) =>
      (await native.send("SCAN", [
        String(cursor),
        ...args.map(String),
      ])) as readonly [string | number, readonly string[]],
    keys: async (pattern) => (await native.send("KEYS", [pattern])) as string[],
    sadd: async (key, ...members) =>
      Number(await native.send("SADD", [key, ...members])),
    smembers: async (key) =>
      (await native.send("SMEMBERS", [key])) as string[],
    flushdb: () => native.send("FLUSHDB", []),
    close: () => native.close(),
  };
}
