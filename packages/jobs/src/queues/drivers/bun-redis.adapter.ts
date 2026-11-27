/**
 * Minimal Redis client contract compatible with Bun's native Redis client,
 * `ioredis`, or mock clients without forcing a runtime dependency.
 *
 * When `eval` (or `evalsha` + `scriptLoad`) is implemented, `RedisQueueDriver`
 * automatically executes atomic Lua scripts with worker leases and stalled-job
 * recovery. Basic clients without `eval` transparently fall back to standard
 * Redis commands.
 */
export interface RedisQueueClientLike {
  hset(key: string, field: string, value: string): Promise<number>;
  hget(key: string, field: string): Promise<string | null>;
  hdel(key: string, ...fields: string[]): Promise<number>;
  hvals?(key: string): Promise<string[]>;
  hincrby?(key: string, field: string, increment: number): Promise<number>;
  zadd(key: string, score: number, member: string): Promise<number>;
  zrange(key: string, start: number, stop: number): Promise<string[]>;
  zrangebyscore(
    key: string,
    min: number | string,
    max: number | string,
  ): Promise<string[]>;
  zrem(key: string, ...members: string[]): Promise<number>;
  zcard(key: string): Promise<number>;
  sadd(key: string, ...members: string[]): Promise<number>;
  srem(key: string, ...members: string[]): Promise<number>;
  scard(key: string): Promise<number>;
  rpush(key: string, ...values: string[]): Promise<number>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  lrem(key: string, count: number, value: string): Promise<number>;
  llen(key: string): Promise<number>;
  incr(key: string): Promise<number>;
  get(key: string): Promise<string | null>;
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
  quit?(): Promise<unknown>;
  close?(): Promise<void> | void;
}

/**
 * Adapts Bun's native `Bun.RedisClient` (`Bun.redis` or `new Bun.RedisClient(url)`)
 * to `RedisQueueClientLike` including atomic Lua script execution (`EVAL`, `EVALSHA`,
 * `SCRIPT LOAD`) with zero external dependencies.
 */
export function createBunRedisQueueClient(
  urlOrClient?: string | Bun.RedisClient,
): RedisQueueClientLike {
  const native =
    typeof urlOrClient === "string"
      ? new Bun.RedisClient(urlOrClient)
      : urlOrClient ?? Bun.redis;

  return {
    hset: async (key, field, value) =>
      Number(await native.send("HSET", [key, field, value])),
    hget: async (key, field) =>
      (await native.send("HGET", [key, field])) as string | null,
    hdel: async (key, ...fields) =>
      Number(await native.send("HDEL", [key, ...fields])),
    hvals: async (key) =>
      ((await native.send("HVALS", [key])) as string[] | null) ?? [],
    hincrby: async (key, field, increment) =>
      Number(await native.send("HINCRBY", [key, field, String(increment)])),
    zadd: async (key, score, member) =>
      Number(await native.send("ZADD", [key, String(score), member])),
    zrange: async (key, start, stop) =>
      (await native.send("ZRANGE", [
        key,
        String(start),
        String(stop),
      ])) as string[],
    zrangebyscore: async (key, min, max) =>
      (await native.send("ZRANGEBYSCORE", [
        key,
        String(min),
        String(max),
      ])) as string[],
    zrem: async (key, ...members) =>
      Number(await native.send("ZREM", [key, ...members])),
    zcard: async (key) => Number(await native.send("ZCARD", [key])),
    sadd: async (key, ...members) =>
      Number(await native.send("SADD", [key, ...members])),
    srem: async (key, ...members) =>
      Number(await native.send("SREM", [key, ...members])),
    scard: async (key) => Number(await native.send("SCARD", [key])),
    rpush: async (key, ...values) =>
      Number(await native.send("RPUSH", [key, ...values])),
    lrange: async (key, start, stop) =>
      (await native.send("LRANGE", [
        key,
        String(start),
        String(stop),
      ])) as string[],
    lrem: async (key, count, value) =>
      Number(await native.send("LREM", [key, String(count), value])),
    llen: async (key) => Number(await native.send("LLEN", [key])),
    incr: async (key) => Number(await native.send("INCR", [key])),
    get: (key) => native.get(key),
    eval: (script, numKeys, ...args) =>
      native.send("EVAL", [script, String(numKeys), ...args.map(String)]),
    evalsha: (sha1, numKeys, ...args) =>
      native.send("EVALSHA", [sha1, String(numKeys), ...args.map(String)]),
    scriptLoad: async (script) =>
      String(await native.send("SCRIPT", ["LOAD", script])),
    close: () => native.close(),
  };
}
