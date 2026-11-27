import { describe, expect, it } from "bun:test";
import { APP_GUARD, Controller, Get } from "@bunest/core";
import { Test } from "@bunest/testing";
import {
  LUA_FIXED_WINDOW_INCREMENT,
  LUA_SLIDING_WINDOW_INCREMENT,
  RedisThrottlerStorage,
  SkipThrottle,
  Throttle,
  ThrottlerGuard,
  ThrottlerModule,
  type RedisThrottlerClientLike,
} from "../src";
import { RedisThrottlerStorage as SubpathRedisThrottlerStorage } from "../src/throttler";

interface StringEntry {
  value: string;
  expiresAt?: number;
}

interface ZSetEntry {
  members: Map<string, number>; // member -> score
  expiresAt?: number;
}

/**
 * Faithful Lua-executing Redis test double with deterministic virtual clock
 * simulating exact fixed-window (`INCR`/`PEXPIRE`/`PTTL`/`SET PX`) and
 * sliding-window (`ZREMRANGEBYSCORE`/`ZCARD`/`ZADD`/`ZRANGE`/`PEXPIRE`/`SET PX`)
 * Lua script semantics, plus `SCRIPT LOAD`/`EVALSHA`/`NOSCRIPT` and `SCAN`/`DEL`.
 */
class LuaMockRedisClient implements RedisThrottlerClientLike {
  readonly strings = new Map<string, StringEntry>();
  readonly zsets = new Map<string, ZSetEntry>();
  readonly loadedScripts = new Map<string, string>();
  readonly recordedCalls: Array<{ op: string; keys: string[]; args: string[] }> =
    [];
  failNextEvalshaNoScript = false;

  constructor(private readonly nowMs: () => number) {}

  private evictIfExpired(key: string): void {
    const now = this.nowMs();
    const s = this.strings.get(key);
    if (s?.expiresAt !== undefined && s.expiresAt <= now) {
      this.strings.delete(key);
    }
    const z = this.zsets.get(key);
    if (z?.expiresAt !== undefined && z.expiresAt <= now) {
      this.zsets.delete(key);
    }
  }

  private pttl(key: string): number {
    this.evictIfExpired(key);
    const s = this.strings.get(key);
    if (s) {
      return s.expiresAt === undefined ? -1 : Math.max(1, s.expiresAt - this.nowMs());
    }
    const z = this.zsets.get(key);
    if (z) {
      return z.expiresAt === undefined ? -1 : Math.max(1, z.expiresAt - this.nowMs());
    }
    return -2;
  }

  private executeScript(
    script: string,
    keys: string[],
    args: string[],
  ): unknown {
    this.recordedCalls.push({ op: "EXEC", keys, args });

    if (script === LUA_FIXED_WINDOW_INCREMENT) {
      const counterKey = keys[0]!;
      const blockKey = keys[1]!;
      const ttlMs = Number(args[0]);
      const limit = Number(args[1]);
      const blockDurationMs = Number(args[2]);

      const blockPttl = this.pttl(blockKey);
      if (blockPttl > 0) {
        const rawBlocked = Number(this.strings.get(blockKey)?.value ?? "0");
        const blockedHits = rawBlocked <= limit ? limit + 1 : rawBlocked;
        let pttl = this.pttl(counterKey);
        if (pttl <= 0) pttl = blockPttl;
        return [blockedHits, pttl, 1, blockPttl];
      }

      this.evictIfExpired(counterKey);
      const current = Number(this.strings.get(counterKey)?.value ?? "0");
      if (current >= limit) {
        let pttl = this.pttl(counterKey);
        if (pttl <= 0) pttl = ttlMs;
        const totalHits = current + 1;
        let timeToBlockMs = pttl;
        if (blockDurationMs > 0) {
          this.strings.set(blockKey, {
            value: String(totalHits),
            expiresAt: this.nowMs() + blockDurationMs,
          });
          this.strings.delete(counterKey);
          timeToBlockMs = blockDurationMs;
        }
        return [totalHits, pttl, 1, timeToBlockMs];
      }

      const existing = this.strings.get(counterKey);
      const hits = current + 1;
      this.strings.set(counterKey, {
        value: String(hits),
        expiresAt: existing?.expiresAt,
      });
      let pttl = this.pttl(counterKey);
      if (hits === 1 || pttl < 0) {
        this.strings.get(counterKey)!.expiresAt = this.nowMs() + ttlMs;
        pttl = ttlMs;
      }
      return [hits, pttl, 0, 0];
    }

    if (script === LUA_SLIDING_WINDOW_INCREMENT) {
      const zsetKey = keys[0]!;
      const blockKey = keys[1]!;
      const ttlMs = Number(args[0]);
      const limit = Number(args[1]);
      const blockDurationMs = Number(args[2]);
      const nowMs = Number(args[3]);
      const memberId = args[4]!;

      const blockPttl = this.pttl(blockKey);
      if (blockPttl > 0) {
        const rawBlocked = Number(this.strings.get(blockKey)?.value ?? "0");
        const blockedHits = rawBlocked <= limit ? limit + 1 : rawBlocked;
        let pttl = this.pttl(zsetKey);
        if (pttl <= 0) pttl = blockPttl;
        return [blockedHits, pttl, 1, blockPttl];
      }

      this.evictIfExpired(zsetKey);
      let zset = this.zsets.get(zsetKey);
      if (!zset) {
        zset = { members: new Map() };
        this.zsets.set(zsetKey, zset);
      }

      const cutoff = nowMs - ttlMs;
      for (const [m, score] of zset.members) {
        if (score <= cutoff) {
          zset.members.delete(m);
        }
      }

      const count = zset.members.size;
      const oldestScore = (): number | undefined => {
        let min: number | undefined;
        for (const score of zset!.members.values()) {
          if (min === undefined || score < min) min = score;
        }
        return min;
      };

      if (count >= limit) {
        const oldest = oldestScore();
        const pttl =
          oldest !== undefined ? Math.max(1, oldest + ttlMs - nowMs) : ttlMs;
        const totalHits = count + 1;
        let timeToBlockMs = pttl;
        if (blockDurationMs > 0) {
          this.strings.set(blockKey, {
            value: String(totalHits),
            expiresAt: this.nowMs() + blockDurationMs,
          });
          this.zsets.delete(zsetKey);
          timeToBlockMs = blockDurationMs;
        }
        return [totalHits, pttl, 1, timeToBlockMs];
      }

      zset.members.set(memberId, nowMs);
      zset.expiresAt = this.nowMs() + ttlMs;
      const oldest = oldestScore();
      const pttl =
        oldest !== undefined ? Math.max(1, oldest + ttlMs - nowMs) : ttlMs;
      return [count + 1, pttl, 0, 0];
    }

    throw new Error("Unsupported Lua script in test double");
  }

  async scriptLoad(script: string): Promise<string> {
    const hasher = new Bun.CryptoHasher("sha1");
    hasher.update(script);
    const sha = hasher.digest("hex");
    this.loadedScripts.set(sha, script);
    return sha;
  }

  async evalsha(
    sha1: string,
    numKeys: number,
    ...rest: Array<string | number>
  ): Promise<unknown> {
    if (this.failNextEvalshaNoScript) {
      this.failNextEvalshaNoScript = false;
      throw new Error("NOSCRIPT No matching script. Please use EVAL.");
    }
    const script = this.loadedScripts.get(sha1);
    if (!script) {
      throw new Error("NOSCRIPT No matching script. Please use EVAL.");
    }
    const strRest = rest.map(String);
    return this.executeScript(
      script,
      strRest.slice(0, numKeys),
      strRest.slice(numKeys),
    );
  }

  async eval(
    script: string,
    numKeys: number,
    ...rest: Array<string | number>
  ): Promise<unknown> {
    const strRest = rest.map(String);
    return this.executeScript(
      script,
      strRest.slice(0, numKeys),
      strRest.slice(numKeys),
    );
  }

  async del(...keys: string[]): Promise<number> {
    let removed = 0;
    for (const k of keys) {
      if (this.strings.delete(k) || this.zsets.delete(k)) removed++;
    }
    return removed;
  }

  async scan(
    _cursor: string | number,
    ...args: Array<string | number>
  ): Promise<[string, string[]]> {
    const matchIdx = args.indexOf("MATCH");
    const pattern = matchIdx !== -1 ? String(args[matchIdx + 1]) : "*";
    const prefix = pattern.replace(/\*$/, "");
    const allKeys = [...this.strings.keys(), ...this.zsets.keys()].filter((k) =>
      k.startsWith(prefix),
    );
    return ["0", allKeys];
  }
}

describe("Distributed RedisThrottlerStorage", () => {
  it("enforces atomic fixed-window rate limiting, cluster hash-tag keys, blockDuration, reset, clear, and NOSCRIPT recovery", async () => {
    expect(SubpathRedisThrottlerStorage).toBe(RedisThrottlerStorage);

    let clock = 1_700_000_000_000;
    const redis = new LuaMockRedisClient(() => clock);
    const storage = new RedisThrottlerStorage(redis, {
      prefix: "app:throttle",
      algorithm: "fixed-window",
    });

    // Hit 1 & 2 succeed within limit=2, ttl=5000ms
    const r1 = await storage.increment("ip:1.2.3.4", 5_000, 2, 10_000);
    expect(r1).toEqual({
      totalHits: 1,
      timeToExpire: 5,
      isBlocked: false,
      timeToBlockExpire: 0,
    });

    // Verify Redis Cluster hash-tag key format
    expect(redis.recordedCalls[0]!.keys).toEqual([
      "app:throttle:{ip:1.2.3.4}",
      "app:throttle:{ip:1.2.3.4}:block",
    ]);

    // Trigger NOSCRIPT on next evalsha to verify transparent fallback
    redis.failNextEvalshaNoScript = true;
    clock += 1_500;
    const r2 = await storage.increment("ip:1.2.3.4", 5_000, 2, 10_000);
    expect(r2.totalHits).toBe(2);
    expect(r2.isBlocked).toBe(false);
    expect(r2.timeToExpire).toBe(4); // 3500ms -> ceil(3.5) = 4s

    // Hit 3 exceeds limit -> triggers 10s blockDuration
    const r3 = await storage.increment("ip:1.2.3.4", 5_000, 2, 10_000);
    expect(r3.isBlocked).toBe(true);
    expect(r3.totalHits).toBe(3);
    expect(r3.timeToBlockExpire).toBe(10);

    // Hit 4 during active block stays blocked without resetting block TTL
    clock += 3_000;
    const r4 = await storage.increment("ip:1.2.3.4", 5_000, 2, 10_000);
    expect(r4.isBlocked).toBe(true);
    expect(r4.timeToBlockExpire).toBe(7);

    // After block expires (+7001ms), next hit starts a clean fresh window (counter was cleared!)
    clock += 7_001;
    const r5 = await storage.increment("ip:1.2.3.4", 5_000, 2, 10_000);
    expect(r5.isBlocked).toBe(false);
    expect(r5.totalHits).toBe(1);

    // reset(key) clears individual key
    await storage.reset("ip:1.2.3.4");
    const r6 = await storage.increment("ip:1.2.3.4", 5_000, 2);
    expect(r6.totalHits).toBe(1);

    // clear() scans and deletes all prefixed keys
    await storage.increment("ip:9.9.9.9", 5_000, 2);
    await storage.clear();
    expect(redis.strings.size).toBe(0);
  });

  it("enforces atomic sliding-window rate limiting without rejected-hit pollution (matching MemoryThrottlerStorage)", async () => {
    let clock = 1_750_000_000_000;
    const redis = new LuaMockRedisClient(() => clock);
    const storage = new RedisThrottlerStorage(redis, {
      prefix: "slide",
      algorithm: "sliding-window",
      now: () => clock,
    });

    expect((await storage.increment("k1", 1000, 2)).totalHits).toBe(1);
    expect((await storage.increment("k1", 1000, 2)).totalHits).toBe(2);

    // Rejected hits at t=600ms MUST NOT pollute the sliding window
    clock += 600;
    const rej1 = await storage.increment("k1", 1000, 2);
    expect(rej1.isBlocked).toBe(true);
    expect(rej1.totalHits).toBe(3);
    const rej2 = await storage.increment("k1", 1000, 2);
    expect(rej2.isBlocked).toBe(true);
    expect(rej2.totalHits).toBe(3);

    // At t=1050ms, original t=0 hits have slid out -> fresh hit allowed!
    clock += 450;
    const allowed = await storage.increment("k1", 1000, 2);
    expect(allowed.isBlocked).toBe(false);
    expect(allowed.totalHits).toBe(1);
  });

  it("supports Bun.RedisClient-style send('EVAL', ...) and enforces shared limits across multi-node ThrottlerGuard instances", async () => {
    let clock = Date.now();
    const base = new LuaMockRedisClient(() => clock);

    // Structural client exposing ONLY `send()` (matching Bun.RedisClient)
    const sendOnlyClient: RedisThrottlerClientLike = {
      async send(command: string, args: string[]) {
        if (command === "EVAL") {
          const script = args[0]!;
          const numKeys = Number(args[1]);
          return base.eval(script, numKeys, ...args.slice(2));
        }
        if (command === "DEL") {
          return base.del(...args);
        }
        if (command === "SCAN") {
          return base.scan(args[0]!, ...args.slice(1));
        }
        throw new Error(`Unexpected command ${command}`);
      },
    };

    @Controller("/cluster")
    class ClusterController {
      @Get("api")
      api() {
        return { ok: true };
      }

      @Throttle({ default: { limit: 1, ttl: 5_000 } })
      @Get("strict")
      strict() {
        return { strict: true };
      }

      @SkipThrottle()
      @Get("health")
      health() {
        return { healthy: true };
      }
    }

    const createNode = async () =>
      Test.createTestingModule({
        imports: [
          ThrottlerModule.forRoot({
            throttlers: [{ name: "default", ttl: 10_000, limit: 2 }],
            storage: new RedisThrottlerStorage(sendOnlyClient, {
              prefix: "cluster:rl",
            }),
          }),
        ],
        controllers: [ClusterController],
        providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
      }).compile();

    // Two completely independent Bunest app nodes sharing the same Redis store!
    const nodeA = await createNode();
    const nodeB = await createNode();
    const clientA = nodeA.createTestClient();
    const clientB = nodeB.createTestClient();

    try {
      // Request 1 hits Node A -> remaining 1
      const r1 = await clientA.get("/cluster/api");
      expect(r1.status).toBe(200);
      expect(r1.headers.get("x-ratelimit-limit")).toBe("2");
      expect(r1.headers.get("x-ratelimit-remaining")).toBe("1");

      // Request 2 hits Node B -> remaining 0 (shared distributed counter!)
      const r2 = await clientB.get("/cluster/api");
      expect(r2.status).toBe(200);
      expect(r2.headers.get("x-ratelimit-remaining")).toBe("0");

      // Request 3 hits Node A -> 429 Too Many Requests with Retry-After!
      const r3 = await clientA.get("/cluster/api");
      expect(r3.status).toBe(429);
      expect(r3.headers.get("x-ratelimit-remaining")).toBe("0");
      expect(Number(r3.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);

      // @Throttle override works across nodes
      expect((await clientA.get("/cluster/strict")).status).toBe(200);
      expect((await clientB.get("/cluster/strict")).status).toBe(429);

      // @SkipThrottle bypasses across nodes
      expect((await clientA.get("/cluster/health")).status).toBe(200);
      expect((await clientB.get("/cluster/health")).status).toBe(200);

      // After TTL expires, requests succeed again
      clock += 11_000;
      expect((await clientB.get("/cluster/api")).status).toBe(200);
    } finally {
      await nodeA.close();
      await nodeB.close();
    }

    // Rejects client with no atomic Lua capability
    const badStorage = new RedisThrottlerStorage({});
    await expect(badStorage.increment("k", 1000, 1)).rejects.toThrow(
      /eval\(\)/,
    );
  });
});
