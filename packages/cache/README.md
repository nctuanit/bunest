# @bunest/cache

LRU memory and pluggable Redis caching for Bunest, featuring single-flight stampede protection, tag/prefix invalidation, method-level AOP caching decorators, and HTTP `CacheInterceptor` with zero external runtime dependencies.

## Features

- **Pluggable Cache Stores**: Built-in `MemoryCacheStore` (LRU with TTL) and `RedisCacheStore` (accepting Bun's native `Bun.RedisClient`, a `url`, or any `RedisClientLike` client via `@bunest/cache` or `@bunest/cache/redis`), plus the `CacheStore` contract for custom stores.
- **Fail-Open Resilience & Stampede Protection**: `CacheService` supports single-flight `wrap()` deduplication, fail-open error handling on `get()` and `wrap()` (transient backend errors emit lifecycle events and fall through cleanly to the factory), batch operations (`mget`/`mset`/`mdel`), and tag or prefix-based invalidation.
- **Redis Health Probes**: `RedisCacheStore.ping()` probes Redis connectivity with `PING` (returning `true`/`false` without throwing) for `/ready` health checks.
- **HTTP Caching**: `CacheInterceptor` with `@CacheKey()`, `@CacheTTL()`, and `@NoCache()` route decorators.
- **Service-Layer AOP Caching**: `@Cacheable()`, `@CachePut()`, and `@CacheEvict()` method decorators with key and tag resolvers.

## Installation

```bash
bun add @bunest/cache
```

## Quick Start

```ts
import { Controller, Get, Module, UseInterceptors } from "@bunest/core";
import {
  CacheInterceptor,
  CacheKey,
  CacheModule,
  CacheService,
  CacheTTL,
} from "@bunest/cache";
import { RedisCacheStore } from "@bunest/cache/redis";

@Controller("catalog")
export class CatalogController {
  constructor(private readonly cache: CacheService) {}

  @Get("featured")
  @UseInterceptors(CacheInterceptor)
  @CacheKey("catalog:featured")
  @CacheTTL(60_000)
  getFeatured() {
    return this.cache.wrap("featured:items", async () => ["item-1", "item-2"], {
      ttl: 60_000,
    });
  }
}

const redisStore = new RedisCacheStore({
  url: process.env.REDIS_URL ?? "redis://localhost:6379",
  keyPrefix: "catalog:",
});

@Module({
  imports: [
    CacheModule.register({
      isGlobal: true,
      ttl: 30_000,
      store: redisStore,
    }),
  ],
  controllers: [CatalogController],
})
export class AppModule {}

// Safe readiness probe (returns boolean without throwing)
const redisReady = await redisStore.ping();
```

## Key Exports

- **Module & Service**: `CacheModule` (`register`, `registerAsync`), `CacheService`, `Cache`, `CacheInterceptor`
- **Stores (`@bunest/cache` & `@bunest/cache/redis`)**: `MemoryCacheStore`, `RedisCacheStore` (with `ping()`), `createBunRedisClient`
- **HTTP Decorators**: `@CacheKey()`, `@CacheTTL()`, `@NoCache()`
- **AOP Decorators & Handlers**: `@Cacheable()`, `@CachePut()`, `@CacheEvict()`, `CacheableAspectHandler`, `CachePutAspectHandler`, `CacheEvictAspectHandler`
- **Tokens**: `CACHE_MANAGER`, `CACHE_STORE`, `CACHE_MODULE_OPTIONS`, `CACHE_KEY_METADATA`, `CACHE_TTL_METADATA`, `NO_CACHE_METADATA`

## Documentation

- [Bunest Documentation](../../README.md)
- [ADR Index](../../docs/adr/README.md)
