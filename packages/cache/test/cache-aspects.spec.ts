import { describe, expect, test } from "bun:test";
import { Injectable, Module, Scope } from "@bunest/core";
import { BunestFactory } from "@bunest/core";
import {
  CacheEvict,
  CacheModule,
  CachePut,
  CacheService,
  Cacheable,
} from "../src";

describe("@bunest/cache Service-Level Method Aspect Decorators", () => {
  test("@Cacheable caches by default key, static key, dynamic key, TTL, tags (static & dynamic), condition, unless, and deduplicates concurrent misses", async () => {
    let defaultCalls = 0;
    let userCalls = 0;
    let conditionalCalls = 0;
    let unlessCalls = 0;
    let stampedeCalls = 0;

    @Injectable()
    class CatalogService {
      @Cacheable()
      async getConfig(): Promise<{ version: number }> {
        defaultCalls += 1;
        return { version: defaultCalls };
      }

      @Cacheable({
        key: (id: string) => `user:${id}`,
        ttl: 80,
        tags: (id: string, user?: { orgId: string }) => [
          `user-tag:${id}`,
          `org:${user?.orgId ?? "none"}`,
        ],
      })
      async getUser(
        id: string,
      ): Promise<{ id: string; orgId: string; fetchCount: number }> {
        userCalls += 1;
        return {
          id,
          orgId: id.startsWith("a") ? "acme" : "beta",
          fetchCount: userCalls,
        };
      }

      @Cacheable({
        key: (id: number) => `cond:${id}`,
        condition: (id: number) => id > 0,
      })
      async getConditional(id: number): Promise<{ id: number; calls: number }> {
        conditionalCalls += 1;
        return { id, calls: conditionalCalls };
      }

      @Cacheable({
        key: (code: string) => `unless:${code}`,
        unless: (res: { ok: boolean } | null) => !res || !res.ok,
      })
      async getWithUnless(
        code: string,
      ): Promise<{ code: string; ok: boolean; calls: number }> {
        unlessCalls += 1;
        return { code, ok: code === "good", calls: unlessCalls };
      }

      @Cacheable({ key: (k: string) => `flight:${k}` })
      async slowCompute(k: string): Promise<string> {
        stampedeCalls += 1;
        await Bun.sleep(20);
        return `${k}#${stampedeCalls}`;
      }
    }

    @Module({
      imports: [CacheModule.register({ isGlobal: true })],
      providers: [CatalogService],
    })
    class AppModule {}

    const ctx = await BunestFactory.createApplicationContext(AppModule, {
      logger: false,
    });

    try {
      const svc = ctx.get(CatalogService);
      const cache = ctx.get(CacheService);

      // Default derived key
      expect(await svc.getConfig()).toEqual({ version: 1 });
      expect(await svc.getConfig()).toEqual({ version: 1 });
      expect(defaultCalls).toBe(1);

      // Dynamic key + dynamic tags from (args, result) + TTL
      const u1 = await svc.getUser("a1");
      const u1Again = await svc.getUser("a1");
      expect(u1).toEqual({ id: "a1", orgId: "acme", fetchCount: 1 });
      expect(u1Again).toEqual(u1);
      expect(userCalls).toBe(1);

      // Dynamic tag derived from result (`org:acme`) invalidates cached entry!
      expect(await cache.invalidateTag("org:acme")).toBe(1);
      const u1Refetched = await svc.getUser("a1");
      expect(u1Refetched.fetchCount).toBe(2);
      expect(userCalls).toBe(2);

      // TTL expiration
      await Bun.sleep(95);
      const u1Expired = await svc.getUser("a1");
      expect(u1Expired.fetchCount).toBe(3);

      // condition: false bypasses cache completely
      expect(await svc.getConditional(-1)).toEqual({ id: -1, calls: 1 });
      expect(await svc.getConditional(-1)).toEqual({ id: -1, calls: 2 });
      expect(await svc.getConditional(5)).toEqual({ id: 5, calls: 3 });
      expect(await svc.getConditional(5)).toEqual({ id: 5, calls: 3 });

      // unless: true prevents storing bad results, caches good ones
      expect(await svc.getWithUnless("bad")).toEqual({
        code: "bad",
        ok: false,
        calls: 1,
      });
      expect(await svc.getWithUnless("bad")).toEqual({
        code: "bad",
        ok: false,
        calls: 2,
      });
      expect(await svc.getWithUnless("good")).toEqual({
        code: "good",
        ok: true,
        calls: 3,
      });
      expect(await svc.getWithUnless("good")).toEqual({
        code: "good",
        ok: true,
        calls: 3,
      });

      // Single-flight deduplication on concurrent cache misses
      const [f1, f2, f3] = await Promise.all([
        svc.slowCompute("x"),
        svc.slowCompute("x"),
        svc.slowCompute("x"),
      ]);
      expect(f1).toBe("x#1");
      expect(f2).toBe("x#1");
      expect(f3).toBe("x#1");
      expect(stampedeCalls).toBe(1);
    } finally {
      await ctx.close();
    }
  });

  test("@CachePut updates cache entries and @CacheEvict evicts by key, prefix, tags, allEntries, and beforeInvocation", async () => {
    let loads = 0;

    @Injectable()
    class ProfileService {
      @Cacheable({
        key: (id: string) => `profile:${id}`,
        tags: (id: string) => ["profiles", `profile:${id}`],
      })
      async getProfile(
        id: string,
      ): Promise<{ id: string; name: string; rev: number }> {
        loads += 1;
        return { id, name: `Initial-${id}`, rev: loads };
      }

      @CachePut({
        key: (id: string) => `profile:${id}`,
        tags: (id: string) => ["profiles", `profile:${id}`],
      })
      async updateProfile(
        id: string,
        name: string,
      ): Promise<{ id: string; name: string; rev: number }> {
        return { id, name, rev: 99 };
      }

      @CacheEvict({ key: (id: string) => `profile:${id}` })
      async deleteProfile(id: string, fail = false): Promise<boolean> {
        if (fail) {
          throw new Error(`delete failed for ${id}`);
        }
        return true;
      }

      @CacheEvict({
        key: (id: string) => `profile:${id}`,
        beforeInvocation: true,
      })
      async forceEvictBefore(id: string): Promise<void> {
        throw new Error(`boom after evict ${id}`);
      }

      @CacheEvict({ prefix: "profile:" })
      async evictByPrefix(): Promise<void> {}

      @CacheEvict({ tags: ["profiles"] })
      async evictByTag(): Promise<void> {}

      @CacheEvict({ allEntries: true })
      async evictAll(): Promise<void> {}
    }

    @Module({
      imports: [
        CacheModule.registerAsync({
          isGlobal: true,
          useFactory: async () => ({ ttl: 60_000 }),
        }),
      ],
      providers: [ProfileService],
    })
    class AppModule {}

    const ctx = await BunestFactory.createApplicationContext(AppModule, {
      logger: false,
    });

    try {
      const svc = ctx.get(ProfileService);
      const cache = ctx.get(CacheService);

      // Populate cache
      expect(await svc.getProfile("1")).toEqual({
        id: "1",
        name: "Initial-1",
        rev: 1,
      });
      expect(await svc.getProfile("2")).toEqual({
        id: "2",
        name: "Initial-2",
        rev: 2,
      });
      expect(loads).toBe(2);

      // @CachePut writes updated value directly into cache
      await svc.updateProfile("1", "Alice");
      expect(await svc.getProfile("1")).toEqual({
        id: "1",
        name: "Alice",
        rev: 99,
      });
      expect(loads).toBe(2);

      // @CacheEvict (default beforeInvocation: false) does NOT evict when method throws
      await expect(svc.deleteProfile("1", true)).rejects.toThrow(
        "delete failed",
      );
      expect(await svc.getProfile("1")).toEqual({
        id: "1",
        name: "Alice",
        rev: 99,
      });

      // @CacheEvict evicts exact key on success
      await svc.deleteProfile("1", false);
      expect(await svc.getProfile("1")).toEqual({
        id: "1",
        name: "Initial-1",
        rev: 3,
      });

      // @CacheEvict({ beforeInvocation: true }) evicts even when method throws!
      await expect(svc.forceEvictBefore("1")).rejects.toThrow(
        "boom after evict",
      );
      expect(await cache.has("profile:1")).toBe(false);

      // Re-populate & evict by prefix
      await svc.getProfile("1");
      await svc.evictByPrefix();
      expect(await cache.has("profile:1")).toBe(false);
      expect(await cache.has("profile:2")).toBe(false);

      // Re-populate & evict by tag
      await svc.getProfile("1");
      await svc.getProfile("2");
      await svc.evictByTag();
      expect(await cache.has("profile:1")).toBe(false);
      expect(await cache.has("profile:2")).toBe(false);

      // Re-populate + extra key & evict allEntries
      await svc.getProfile("1");
      await cache.set("unrelated:key", "keep-me");
      await svc.evictAll();
      expect(await cache.has("profile:1")).toBe(false);
      expect(await cache.has("unrelated:key")).toBe(false);
    } finally {
      await ctx.close();
    }
  });

  test("works cleanly on TRANSIENT-scoped services", async () => {
    let calls = 0;

    @Injectable({ scope: Scope.TRANSIENT })
    class TransientCachedService {
      @Cacheable("transient:shared")
      async compute(): Promise<number> {
        calls += 1;
        return calls * 10;
      }
    }

    @Module({
      imports: [CacheModule.register({ isGlobal: true })],
      providers: [TransientCachedService],
    })
    class AppModule {}

    const ctx = await BunestFactory.createApplicationContext(AppModule, {
      logger: false,
    });

    try {
      const a = await ctx.resolve(TransientCachedService);
      const b = await ctx.resolve(TransientCachedService);
      expect(a).not.toBe(b);
      expect(await a.compute()).toBe(10);
      expect(await b.compute()).toBe(10);
      expect(calls).toBe(1);
    } finally {
      await ctx.close();
    }
  });
});
