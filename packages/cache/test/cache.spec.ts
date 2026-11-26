import { describe, expect, it } from "bun:test";
import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  Injectable,
  Module,
  Post,
  Res,
  UseInterceptors,
  type ExecutionContext,
  type ResponseContext,
} from "@bunest/core";
import { BunestFactory } from "@bunest/core";
import {
  CACHE_MANAGER,
  Cache,
  CacheInterceptor,
  CacheKey,
  CacheModule,
  CacheService,
  CacheTTL,
  MemoryCacheStore,
  NoCache,
  RedisCacheStore,
  type CacheOptionsFactory,
  type RedisClientLike,
} from "../src";

/**
 * Minimal in-memory mock implementing `RedisClientLike` (including PX TTLs,
 * SCAN cursor batching, SADD/SMEMBERS tag sets, and quit tracking).
 */
function createMockRedisClient() {
  const data = new Map<string, { value: string; expiresAt?: number }>();
  const sets = new Map<string, Set<string>>();
  let closed = false;

  const isAlive = (key: string): boolean => {
    const item = data.get(key);
    if (!item) return false;
    if (item.expiresAt !== undefined && Date.now() >= item.expiresAt) {
      data.delete(key);
      return false;
    }
    return true;
  };

  const globToRegex = (pattern: string): RegExp => {
    let regexStr = "^";
    for (let i = 0; i < pattern.length; i += 1) {
      const ch = pattern[i]!;
      if (ch === "\\" && i + 1 < pattern.length) {
        regexStr += `\\${pattern[++i]!}`;
      } else if (ch === "*") {
        regexStr += ".*";
      } else if (ch === "?") {
        regexStr += ".";
      } else if (/[-/\\^$+.()|[\]{}]/.test(ch)) {
        regexStr += `\\${ch}`;
      } else {
        regexStr += ch;
      }
    }
    regexStr += "$";
    return new RegExp(regexStr);
  };

  const client: RedisClientLike = {
    async get(key: string): Promise<string | null> {
      return isAlive(key) ? (data.get(key)?.value ?? null) : null;
    },
    async set(key: string, value: string, ...args: unknown[]): Promise<string> {
      let expiresAt: number | undefined;
      if (args[0] === "PX" && typeof args[1] === "number") {
        expiresAt = Date.now() + args[1];
      }
      data.set(key, { value, expiresAt });
      return "OK";
    },
    async del(...keys: string[]): Promise<number> {
      let count = 0;
      for (const k of keys) {
        if (data.delete(k)) count += 1;
        sets.delete(k);
      }
      return count;
    },
    async exists(key: string): Promise<number> {
      return isAlive(key) ? 1 : 0;
    },
    async pttl(key: string): Promise<number> {
      if (!isAlive(key)) return -2;
      const item = data.get(key);
      if (!item || item.expiresAt === undefined) return -1;
      return Math.max(0, item.expiresAt - Date.now());
    },
    async mget(...keys: string[]): Promise<Array<string | null>> {
      return keys.map((k) =>
        isAlive(k) ? (data.get(k)?.value ?? null) : null,
      );
    },
    async scan(
      cursor: string | number,
      ...args: unknown[]
    ): Promise<[string, string[]]> {
      const matchIdx = args.indexOf("MATCH");
      const pattern = matchIdx !== -1 ? String(args[matchIdx + 1]) : "*";
      const regex = globToRegex(pattern);
      const matching = [...data.keys()].filter(
        (k) => isAlive(k) && regex.test(k),
      );
      const start = Number(cursor);
      const pageSize = 2;
      const slice = matching.slice(start, start + pageSize);
      const next =
        start + pageSize < matching.length ? String(start + pageSize) : "0";
      return [next, slice];
    },
    async sadd(key: string, ...members: string[]): Promise<number> {
      let set = sets.get(key);
      if (!set) {
        set = new Set();
        sets.set(key, set);
      }
      let added = 0;
      for (const m of members) {
        if (!set.has(m)) {
          set.add(m);
          added += 1;
        }
      }
      return added;
    },
    async smembers(key: string): Promise<string[]> {
      return [...(sets.get(key) ?? [])];
    },
    async flushdb(): Promise<string> {
      data.clear();
      sets.clear();
      return "OK";
    },
    async quit(): Promise<string> {
      closed = true;
      return "OK";
    },
  };

  return {
    client,
    isClosed: () => closed,
    rawKeys: () => [...data.keys()],
  };
}

describe("@bunest/cache", () => {
  describe("MemoryCacheStore (LRU eviction, TTL expiry, prefix & tag invalidation)", () => {
    it("evicts least-recently-used entries when maxItems is exceeded", () => {
      const store = new MemoryCacheStore({
        maxItems: 2,
        cleanupIntervalMs: 0,
      });

      store.set("a", 1);
      store.set("b", 2);
      // Touch "a" so "b" becomes least-recently-used
      expect(store.get("a")).toBe(1);

      store.set("c", 3);
      expect(store.has("b")).toBe(false);
      expect(store.get("a")).toBe(1);
      expect(store.get("c")).toBe(3);

      store.close();
    });

    it("expires entries by per-key and default TTL, and supports prefix + tag invalidation", () => {
      let currentTime = 1000;
      const store = new MemoryCacheStore({
        maxItems: 50,
        defaultTtlMs: 100,
        cleanupIntervalMs: 0,
        now: () => currentTime,
      });

      store.set("user:1", { name: "Alice" }, { tags: ["users", "org:1"] });
      store.set("user:2", { name: "Bob" }, { ttlMs: 300, tags: ["users"] });
      store.set("post:1", { title: "Hi" }, { ttlMs: 0, tags: ["org:1"] });

      expect(store.get("user:1")).toEqual({ name: "Alice" });
      expect(store.mget(["user:1", "post:1", "missing"])).toEqual([
        { name: "Alice" },
        { title: "Hi" },
        undefined,
      ]);

      // Advance past default TTL (100ms): user:1 expires, user:2 (300ms) & post:1 (0 = no expiry) survive
      currentTime += 150;
      expect(store.get("user:1")).toBeUndefined();
      expect(store.get("user:2")).toEqual({ name: "Bob" });
      expect(store.get("post:1")).toEqual({ title: "Hi" });

      // Tag invalidation
      store.set("user:3", { name: "Cara" }, { ttlMs: 500, tags: ["users"] });
      expect(store.invalidateTag("users")).toBe(2);
      expect(store.has("user:2")).toBe(false);
      expect(store.has("user:3")).toBe(false);
      expect(store.has("post:1")).toBe(true);

      // Prefix invalidation
      store.set("items:a", 1, 0);
      store.set("items:b", 2, 0);
      expect(store.deleteByPrefix("items:")).toBe(2);
      expect(store.keys("items:")).toEqual([]);

      store.close();
    });
  });

  describe("CacheService.wrap() single-flight stampede deduplication", () => {
    it("deduplicates concurrent cache misses into a single factory execution and never caches errors", async () => {
      const store = new MemoryCacheStore({ cleanupIntervalMs: 0 });
      const service = new CacheService(store);
      let factoryCalls = 0;

      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          service.wrap(
            "expensive:key",
            async () => {
              factoryCalls += 1;
              await Bun.sleep(25);
              return { computed: true, call: factoryCalls };
            },
            5000,
          ),
        ),
      );

      expect(factoryCalls).toBe(1);
      for (const r of results) {
        expect(r).toEqual({ computed: true, call: 1 });
      }

      // Preserves cached falsy values (false, 0, "", null) without re-running factory
      let falsyCalls = 0;
      expect(
        await service.wrap("flag", () => {
          falsyCalls += 1;
          return false;
        }),
      ).toBe(false);
      expect(
        await service.wrap("flag", () => {
          falsyCalls += 1;
          return true;
        }),
      ).toBe(false);
      expect(falsyCalls).toBe(1);

      // Errors clear in-flight state and are NOT cached
      let errAttempts = 0;
      await expect(
        service.wrap("flaky", async () => {
          errAttempts += 1;
          throw new Error("transient-fail");
        }),
      ).rejects.toThrow("transient-fail");

      expect(
        await service.wrap("flaky", async () => {
          errAttempts += 1;
          return "recovered";
        }),
      ).toBe("recovered");
      expect(errAttempts).toBe(2);

      await service.onApplicationShutdown();
    });
  });

  describe("RedisCacheStore with mock RedisClientLike", () => {
    it("supports keyPrefix, JSON serialization, PX TTL, SCAN deleteByPrefix, tag invalidation, and close()", async () => {
      const mock = createMockRedisClient();
      const store = new RedisCacheStore({
        client: mock.client,
        keyPrefix: "app:",
        defaultTtlMs: 500,
      });

      await store.set("user:1", { id: 1, name: "Alice" }, { tags: ["users"] });
      await store.set(
        "user:2",
        { id: 2, name: "Bob" },
        { ttlMs: 5000, tags: ["users"] },
      );
      await store.set("user:3", { id: 3, name: "Cara" }, { ttlMs: 5000 });
      await store.set("other:1", { ok: true }, 5000);

      expect(mock.rawKeys()).toContain("app:user:1");
      expect(await store.get<{ id: number; name: string }>("user:1")).toEqual({
        id: 1,
        name: "Alice",
      });
      expect(await store.has("user:1")).toBe(true);
      expect(await store.mget(["user:1", "missing"])).toEqual([
        { id: 1, name: "Alice" },
        undefined,
      ]);

      // Tag invalidation removes tagged keys only
      expect(await store.invalidateTag("users")).toBe(2);
      expect(await store.has("user:1")).toBe(false);
      expect(await store.has("user:2")).toBe(false);
      expect(await store.has("user:3")).toBe(true);

      // SCAN-based prefix invalidation (paginating over multiple SCAN cursors)
      await store.set("user:4", { id: 4 });
      await store.set("user:5", { id: 5 });
      expect(await store.deleteByPrefix("user:")).toBe(3);
      expect(await store.has("user:3")).toBe(false);
      expect(await store.has("other:1")).toBe(true);

      // Short PX TTL expires
      await store.set("ephemeral", "bye", 20);
      expect(await store.get("ephemeral")).toBe("bye");
      await Bun.sleep(35);
      expect(await store.get("ephemeral")).toBeUndefined();

      await store.close();
      expect(mock.isClosed()).toBe(true);
    });

    it("supports ping() health probe for healthy, failing, and minimal Redis clients", async () => {
      // 1. Client with native ping() returning "PONG"
      const pingStore = new RedisCacheStore({
        client: {
          ...createMockRedisClient().client,
          async ping() {
            return "PONG";
          },
        },
      });
      expect(await pingStore.ping()).toBe(true);

      // 2. Client with ping() returning unexpected value -> false
      const badPongStore = new RedisCacheStore({
        client: {
          ...createMockRedisClient().client,
          async ping() {
            return "ERR";
          },
        },
      });
      expect(await badPongStore.ping()).toBe(false);

      // 3. Client with ping() throwing -> false without throwing
      const failingPingStore = new RedisCacheStore({
        client: {
          ...createMockRedisClient().client,
          async ping() {
            throw new Error("ECONNREFUSED");
          },
        },
      });
      expect(await failingPingStore.ping()).toBe(false);

      // 4. Client with send("PING", []) -> true when PONG, false on error
      const sendStore = new RedisCacheStore({
        client: {
          ...createMockRedisClient().client,
          async send(cmd: string) {
            return cmd === "PING" ? "PONG" : null;
          },
        },
      });
      expect(await sendStore.ping()).toBe(true);

      // 5. Minimal RedisClientLike without ping()/send() falls back safely
      const fallbackHealthy = new RedisCacheStore({
        client: createMockRedisClient().client,
        keyPrefix: "health:",
      });
      expect(await fallbackHealthy.ping()).toBe(true);

      const fallbackFailing = new RedisCacheStore({
        client: {
          ...createMockRedisClient().client,
          async exists() {
            throw new Error("Redis down");
          },
        },
      });
      expect(await fallbackFailing.ping()).toBe(false);
    });
  });

  describe("CacheService.wrap() fail-open resilience", () => {
    it("falls through to factory and returns value when store.get() or store.set() throws", async () => {
      const getErrors: unknown[] = [];
      const setErrors: unknown[] = [];

      const flakyStore = new RedisCacheStore({
        client: {
          async get() {
            throw new Error("Redis GET timeout");
          },
          async set() {
            throw new Error("Redis SET timeout");
          },
          async del() {
            return 0;
          },
        },
      });

      const service = new CacheService(flakyStore);
      service.on("get", (e: { error?: unknown }) => {
        if (e.error) getErrors.push(e.error);
      });
      service.on("set", (e: { error?: unknown }) => {
        if (e.error) setErrors.push(e.error);
      });

      let factoryCalls = 0;
      const result = await service.wrap(
        "resilient:key",
        async () => {
          factoryCalls += 1;
          return { ok: true, attempt: factoryCalls };
        },
        5_000,
      );

      expect(result).toEqual({ ok: true, attempt: 1 });
      expect(factoryCalls).toBe(1);
      expect(getErrors).toHaveLength(1);
      expect(setErrors).toHaveLength(1);

      // Multi-tier L1 failing -> falls through to healthy L2 hit
      const l2 = new MemoryCacheStore({ cleanupIntervalMs: 0 });
      l2.set("tiered:key", "from-l2", 5_000);
      const tieredService = new CacheService(undefined, {
        stores: [flakyStore, l2],
      });

      let l2FactoryCalls = 0;
      const tieredResult = await tieredService.wrap("tiered:key", () => {
        l2FactoryCalls += 1;
        return "should-not-run";
      });

      expect(tieredResult).toBe("from-l2");
      expect(l2FactoryCalls).toBe(0);

      await service.disconnect();
      await tieredService.disconnect();
    });
  });

  describe("CacheInterceptor, @CacheKey, @CacheTTL, @NoCache, and CacheModule.registerAsync HTTP integration", () => {
    it("caches GET responses with custom keys/TTLs while skipping POST, @NoCache, errors, streams, and Cache-Control: no-store", async () => {
      let productsCalls = 0;
      let shortTtlCalls = 0;
      let noCacheCalls = 0;
      let postCalls = 0;
      let errorCalls = 0;
      let streamCalls = 0;
      let noStoreResCalls = 0;
      let nativeResCalls = 0;
      let cookieResCalls = 0;
      let nativeCookieCalls = 0;

      @Controller("/catalog")
      @UseInterceptors(CacheInterceptor)
      class CatalogController {
        @Get("products")
        @CacheKey("catalog:products")
        getProducts() {
          productsCalls += 1;
          return { count: productsCalls, items: ["a", "b"] };
        }

        @Get("flash")
        @CacheTTL(30)
        getFlash() {
          shortTtlCalls += 1;
          return { call: shortTtlCalls };
        }

        @Get("live")
        @NoCache()
        getLive() {
          noCacheCalls += 1;
          return { live: noCacheCalls };
        }

        @Post("products")
        createProduct() {
          postCalls += 1;
          return { created: postCalls };
        }

        @Get("fail")
        failEndpoint(): never {
          errorCalls += 1;
          throw new BadRequestException("never cache errors");
        }

        @Get("stream")
        getStream(): ReadableStream {
          streamCalls += 1;
          const n = streamCalls;
          return new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(`stream-${n}`));
              controller.close();
            },
          });
        }

        @Get("private")
        getPrivate(@Res() res: ResponseContext) {
          noStoreResCalls += 1;
          res.header("Cache-Control", "no-store");
          return { secret: noStoreResCalls };
        }

        @Get("native-json")
        getNativeJson(): Response {
          nativeResCalls += 1;
          return Response.json({ native: nativeResCalls });
        }

        @Get("with-cookie")
        getWithCookie(@Res() res: ResponseContext) {
          cookieResCalls += 1;
          res.cookie("session", `sid_${cookieResCalls}`, { httpOnly: true });
          return { sessionCall: cookieResCalls };
        }

        @Get("native-cookie")
        getNativeCookie(): Response {
          nativeCookieCalls += 1;
          return Response.json(
            { nativeCookieCall: nativeCookieCalls },
            {
              headers: {
                "Set-Cookie": `csrf=tok_${nativeCookieCalls}; Path=/`,
              },
            },
          );
        }
      }

      @Module({
        imports: [
          CacheModule.registerAsync({
            isGlobal: true,
            useFactory: async () => {
              await Bun.sleep(1);
              return { ttlMs: 5000, maxItems: 100, cleanupIntervalMs: 0 };
            },
          }),
        ],
        controllers: [CatalogController],
      })
      class AppModule {}

      const app = await BunestFactory.create(AppModule);

      try {
        // 1. GET with @CacheKey -> MISS then HIT
        const r1 = await app.fetch(
          new Request("http://localhost/catalog/products"),
        );
        expect(r1.status).toBe(200);
        expect(r1.headers.get("x-cache")).toBe("MISS");
        expect(await r1.json()).toEqual({ count: 1, items: ["a", "b"] });

        const r2 = await app.fetch(
          new Request("http://localhost/catalog/products"),
        );
        expect(r2.status).toBe(200);
        expect(r2.headers.get("x-cache")).toBe("HIT");
        expect(await r2.json()).toEqual({ count: 1, items: ["a", "b"] });
        expect(productsCalls).toBe(1);

        // Request Cache-Control: no-store bypasses cache completely
        const rNoStore = await app.fetch(
          new Request("http://localhost/catalog/products", {
            headers: { "Cache-Control": "no-store" },
          }),
        );
        expect(await rNoStore.json()).toEqual({ count: 2, items: ["a", "b"] });
        expect(productsCalls).toBe(2);

        // 2. @CacheTTL(30) expires cleanly
        const f1 = await app.fetch(
          new Request("http://localhost/catalog/flash"),
        );
        expect(await f1.json()).toEqual({ call: 1 });
        const f2 = await app.fetch(
          new Request("http://localhost/catalog/flash"),
        );
        expect(await f2.json()).toEqual({ call: 1 });
        await Bun.sleep(45);
        const f3 = await app.fetch(
          new Request("http://localhost/catalog/flash"),
        );
        expect(await f3.json()).toEqual({ call: 2 });
        expect(shortTtlCalls).toBe(2);

        // 3. @NoCache() never caches
        expect(
          await (
            await app.fetch(new Request("http://localhost/catalog/live"))
          ).json(),
        ).toEqual({ live: 1 });
        expect(
          await (
            await app.fetch(new Request("http://localhost/catalog/live"))
          ).json(),
        ).toEqual({ live: 2 });
        expect(noCacheCalls).toBe(2);

        // 4. POST is never cached
        await app.fetch(
          new Request("http://localhost/catalog/products", { method: "POST" }),
        );
        await app.fetch(
          new Request("http://localhost/catalog/products", { method: "POST" }),
        );
        expect(postCalls).toBe(2);

        // 5. Errors are never cached
        const e1 = await app.fetch(
          new Request("http://localhost/catalog/fail"),
        );
        const e2 = await app.fetch(
          new Request("http://localhost/catalog/fail"),
        );
        expect(e1.status).toBe(400);
        expect(e2.status).toBe(400);
        expect(errorCalls).toBe(2);

        // 6. Native ReadableStream is never cached
        const s1 = await (
          await app.fetch(new Request("http://localhost/catalog/stream"))
        ).text();
        const s2 = await (
          await app.fetch(new Request("http://localhost/catalog/stream"))
        ).text();
        expect(s1).toBe("stream-1");
        expect(s2).toBe("stream-2");
        expect(streamCalls).toBe(2);

        // 7. Response with Cache-Control: no-store is never cached
        expect(
          await (
            await app.fetch(new Request("http://localhost/catalog/private"))
          ).json(),
        ).toEqual({ secret: 1 });
        expect(
          await (
            await app.fetch(new Request("http://localhost/catalog/private"))
          ).json(),
        ).toEqual({ secret: 2 });
        expect(noStoreResCalls).toBe(2);

        // 8. Native Web Response instances are treated as non-cacheable streams (NestJS conformance)
        const n1 = await app.fetch(
          new Request("http://localhost/catalog/native-json"),
        );
        expect(n1.status).toBe(200);
        expect(n1.headers.get("x-cache")).toBe("MISS");
        expect(await n1.json()).toEqual({ native: 1 });
        const n2 = await app.fetch(
          new Request("http://localhost/catalog/native-json"),
        );
        expect(n2.status).toBe(200);
        expect(n2.headers.get("x-cache")).toBe("MISS");
        expect(await n2.json()).toEqual({ native: 2 });
        expect(nativeResCalls).toBe(2);

        // 9. Responses emitting Set-Cookie (via @Res() OR native Response) MUST NEVER be cached
        const c1 = await app.fetch(
          new Request("http://localhost/catalog/with-cookie"),
        );
        const c2 = await app.fetch(
          new Request("http://localhost/catalog/with-cookie"),
        );
        expect(await c1.json()).toEqual({ sessionCall: 1 });
        expect(await c2.json()).toEqual({ sessionCall: 2 });
        expect(cookieResCalls).toBe(2);

        const nc1 = await app.fetch(
          new Request("http://localhost/catalog/native-cookie"),
        );
        const nc2 = await app.fetch(
          new Request("http://localhost/catalog/native-cookie"),
        );
        expect(await nc1.json()).toEqual({ nativeCookieCall: 1 });
        expect(await nc2.json()).toEqual({ nativeCookieCall: 2 });
        expect(nativeCookieCalls).toBe(2);
      } finally {
        await app.close();
      }
    });
  });

  describe("NestJS v12 parity: CACHE_MANAGER, Cache token/facade, ttl alias, namespace, multi-tier stores, refreshThreshold, events, object mset, extraProviders & dynamic CacheTTLFactory", () => {
    it("binds CACHE_MANAGER, Cache, and CacheService to the same instance, honors ttl alias, namespace, cacheId, ttl(), clear(), object mset, on/off, and disconnect()", async () => {
      const eventsLog: string[] = [];

      @Injectable()
      class CacheConsumer {
        constructor(
          @Inject(CACHE_MANAGER) public readonly byToken: Cache,
          public readonly byAbstract: Cache,
          public readonly byService: CacheService,
        ) {}
      }

      @Module({
        imports: [
          CacheModule.register({
            isGlobal: true,
            ttl: 45,
            namespace: "ns1",
            cacheId: "cache-alpha",
            cleanupIntervalMs: 0,
          }),
        ],
        providers: [CacheConsumer],
      })
      class AppModule {}

      const app = await BunestFactory.createApplicationContext(AppModule);
      try {
        const consumer = app.get(CacheConsumer);
        expect(CACHE_MANAGER).toBe("CACHE_MANAGER");
        expect(consumer.byToken).toBe(consumer.byAbstract);
        expect(consumer.byAbstract).toBe(consumer.byService);
        expect(consumer.byService instanceof Cache).toBe(true);
        expect(consumer.byToken.cacheId()).toBe("cache-alpha");
        expect(consumer.byToken.stores).toHaveLength(1);

        const onSet = (e: { key: string; value: unknown }) =>
          eventsLog.push(`set:${e.key}=${String(e.value)}`);
        const onDel = (e: { key: string }) => eventsLog.push(`del:${e.key}`);
        const onClear = () => eventsLog.push("clear");

        consumer.byToken.on("set", onSet);
        consumer.byToken.on("del", onDel);
        consumer.byToken.on("clear", onClear);

        // set returns stored value and honors `ttl` option alias
        expect(await consumer.byToken.set("greeting", "hello")).toBe("hello");
        expect(await consumer.byToken.get("greeting")).toBe("hello");
        // Underlying store received namespaced key
        expect(await consumer.byService.getStore().get("ns1:greeting")).toBe(
          "hello",
        );
        expect(await consumer.byService.keys()).toEqual(["greeting"]);

        const rem = await consumer.byToken.ttl("greeting");
        expect(rem).not.toBeNull();
        expect(rem!).toBeGreaterThan(0);
        expect(rem!).toBeLessThanOrEqual(45);

        await Bun.sleep(60);
        expect(await consumer.byToken.get("greeting")).toBeUndefined();
        expect(await consumer.byToken.ttl("greeting")).toBeNull();

        // Object-array mset (cache-manager v7 shape) + tuple mset
        await consumer.byToken.mset([
          { key: "k1", value: "v1", ttl: 500 },
          { key: "k2", value: "v2", ttl: 500 },
        ]);
        await consumer.byToken.mset([["k3", "v3", 500]]);
        expect(await consumer.byToken.mget(["k1", "k2", "k3"])).toEqual([
          "v1",
          "v2",
          "v3",
        ]);

        await consumer.byToken.del("k1");
        expect(await consumer.byToken.clear()).toBe(true);
        expect(await consumer.byToken.get("k2")).toBeUndefined();

        consumer.byToken.off("set", onSet);
        await consumer.byToken.set("silent", 1, 500);

        expect(eventsLog).toEqual(["set:greeting=hello", "del:k1", "clear"]);
      } finally {
        await app.close();
      }
    });

    it("supports RedisCacheStore.ttl() via PTTL and multi-tier L1/L2 stores with read-through backfill & refreshThreshold stale-while-revalidate", async () => {
      // 1. RedisCacheStore.ttl() via PTTL
      const mockRedis = createMockRedisClient();
      const redisStore = new RedisCacheStore({
        client: mockRedis.client,
        keyPrefix: "t:",
      });
      await redisStore.set("r1", "val", 500);
      const rTtl = await redisStore.ttl("r1");
      expect(rTtl).not.toBeNull();
      expect(rTtl!).toBeGreaterThan(0);
      expect(rTtl!).toBeLessThanOrEqual(500);
      expect(await redisStore.ttl("missing")).toBeNull();

      // 2. Multi-tier L1/L2 stores + refreshThreshold with deterministic clock
      let nowMs = 10_000;
      const l1 = new MemoryCacheStore({
        cleanupIntervalMs: 0,
        now: () => nowMs,
      });
      const l2 = new MemoryCacheStore({
        cleanupIntervalMs: 0,
        now: () => nowMs,
      });

      const cache = new CacheService(undefined, {
        stores: [l1, l2],
        refreshThreshold: 60,
        refreshAllStores: true,
      });

      const refreshed: Array<{ key: string; value: unknown }> = [];
      cache.on("refresh", (payload) => refreshed.push(payload));

      // Write populates both L1 and L2; deleting L1 reads through L2 and backfills L1
      await cache.set("item", "from-both", 200);
      expect(l1.get("item")).toBe("from-both");
      expect(l2.get("item")).toBe("from-both");

      l1.del("item");
      expect(await cache.get("item")).toBe("from-both");
      expect(l1.get("item")).toBe("from-both");

      // wrap() with stale-while-revalidate refreshThreshold
      let version = 0;
      const first = await cache.wrap(
        "swr",
        async () => {
          version += 1;
          return `v${version}`;
        },
        100,
      );
      expect(first).toBe("v1");
      expect(await cache.ttl("swr")).toBe(100);

      // Advance clock by 50ms -> remaining TTL = 50ms < refreshThreshold (60ms)
      nowMs += 50;
      expect(await cache.ttl("swr")).toBe(50);

      const staleServed = await cache.wrap(
        "swr",
        async () => {
          version += 1;
          return `v${version}`;
        },
        100,
      );
      // Immediately serves stale v1 while refreshing in background
      expect(staleServed).toBe("v1");
      await Bun.sleep(10);

      expect(refreshed).toEqual([{ key: "swr", value: "v2" }]);
      expect(l1.get("swr")).toBe("v2");
      expect(l2.get("swr")).toBe("v2");

      await cache.disconnect();
      await redisStore.disconnect();
      expect(mockRedis.isClosed()).toBe(true);
    });

    it("supports dynamic @CacheTTL(CacheTTLFactory), async @CacheKey(CacheKeyFactory), extraProviders, and subclassable CacheInterceptor hooks", async () => {
      let dynamicCalls = 0;
      let subclassCalls = 0;
      const EXTRA_TOKEN = Symbol("EXTRA_CACHE_PROVIDER");

      class CustomCacheInterceptor extends CacheInterceptor {
        protected override isRequestCacheable(
          context: ExecutionContext,
        ): boolean {
          const req = context.switchToHttp().getRequest<Request>();
          if (req.headers.get("x-skip-cache") === "1") {
            return false;
          }
          return super.isRequestCacheable(context);
        }
      }

      @Controller("/dyn-cache")
      @UseInterceptors(CustomCacheInterceptor)
      class DynamicCacheController {
        @Get("adaptive")
        @CacheKey(async (ctx) => {
          const url = new URL(ctx.switchToHttp().getRequest<Request>().url);
          return `adaptive:${url.searchParams.get("tier") ?? "std"}`;
        })
        @CacheTTL(async (ctx) => {
          const url = new URL(ctx.switchToHttp().getRequest<Request>().url);
          return url.searchParams.get("tier") === "short" ? 25 : 5000;
        })
        getAdaptive() {
          dynamicCalls += 1;
          return { call: dynamicCalls };
        }

        @Get("custom-hook")
        getCustomHook() {
          subclassCalls += 1;
          return { call: subclassCalls };
        }
      }

      @Injectable()
      class MyCacheConfig implements CacheOptionsFactory {
        createCacheOptions() {
          return { ttl: 5000, cleanupIntervalMs: 0 };
        }
      }

      @Module({
        imports: [
          CacheModule.registerAsync({
            isGlobal: true,
            useClass: MyCacheConfig,
            extraProviders: [{ provide: EXTRA_TOKEN, useValue: "extra-ready" }],
          }),
        ],
        controllers: [DynamicCacheController],
      })
      class AppModule {}

      const app = await BunestFactory.create(AppModule);
      try {
        expect(app.get(EXTRA_TOKEN)).toBe("extra-ready");

        // Dynamic @CacheTTL(fn) returns 25ms for tier=short -> expires quickly
        const s1 = await app.fetch(
          new Request("http://localhost/dyn-cache/adaptive?tier=short"),
        );
        expect(await s1.json()).toEqual({ call: 1 });
        const s2 = await app.fetch(
          new Request("http://localhost/dyn-cache/adaptive?tier=short"),
        );
        expect(s2.headers.get("x-cache")).toBe("HIT");
        expect(await s2.json()).toEqual({ call: 1 });

        await Bun.sleep(45);
        const s3 = await app.fetch(
          new Request("http://localhost/dyn-cache/adaptive?tier=short"),
        );
        expect(await s3.json()).toEqual({ call: 2 });

        // Custom subclassed CacheInterceptor hook skips cache when x-skip-cache: 1
        const h1 = await app.fetch(
          new Request("http://localhost/dyn-cache/custom-hook", {
            headers: { "x-skip-cache": "1" },
          }),
        );
        const h2 = await app.fetch(
          new Request("http://localhost/dyn-cache/custom-hook", {
            headers: { "x-skip-cache": "1" },
          }),
        );
        expect(await h1.json()).toEqual({ call: 1 });
        expect(await h2.json()).toEqual({ call: 2 });
      } finally {
        await app.close();
      }
    });
  });
});
