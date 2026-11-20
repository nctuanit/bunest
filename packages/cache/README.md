# @bunest/cache

LRU memory and pluggable Redis caching for Bunest, featuring single-flight stampede protection, tag/prefix invalidation, method-level AOP caching decorators, and HTTP `CacheInterceptor` with zero external runtime dependencies.

## Features

- **Pluggable Cache Stores**: Built-in `MemoryCacheStore` (LRU with TTL) and `RedisCacheStore` (accepting any `RedisClientLike` client), plus the `CacheStore` contract for custom stores.
- **Stampede Protection & Invalidation**: `CacheService` supports single-flight `wrap()` deduplication, batch operations (`mget`/`mset`/`mdel`), and tag or prefix-based invalidation.
- **HTTP Caching**: `CacheInterceptor` with `@CacheKey()`, `@CacheTTL()`, and `@NoCache()` route decorators.
- **Service-Layer AOP Caching**: `@Cacheable()`, `@CachePut()`, and `@CacheEvict()` method decorators with key and tag resolvers.

## Installation

```bash
bun add @bunest/cache
```

## Quick Start

```ts
import { Controller, Get, Module, UseInterceptors } from "@bunest/common";
import {
  CacheInterceptor,
  CacheKey,
  CacheModule,
  CacheService,
  CacheTTL,
} from "@bunest/cache";

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

@Module({
  imports: [CacheModule.register({ isGlobal: true, ttl: 30_000 })],
  controllers: [CatalogController],
})
export class AppModule {}
```

## Key Exports

- **Module & Service**: `CacheModule` (`register`, `registerAsync`), `CacheService`, `Cache`, `CacheInterceptor`
- **Stores**: `MemoryCacheStore`, `RedisCacheStore`
- **HTTP Decorators**: `@CacheKey()`, `@CacheTTL()`, `@NoCache()`
- **AOP Decorators & Handlers**: `@Cacheable()`, `@CachePut()`, `@CacheEvict()`, `CacheableAspectHandler`, `CachePutAspectHandler`, `CacheEvictAspectHandler`
- **Tokens**: `CACHE_MANAGER`, `CACHE_STORE`, `CACHE_MODULE_OPTIONS`, `CACHE_KEY_METADATA`, `CACHE_TTL_METADATA`, `NO_CACHE_METADATA`

## Documentation

- [Bunest Documentation](../../README.md)
- [ADR Index](../../docs/adr/README.md)
