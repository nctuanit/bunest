# Caching

**`@bunest/cache`** provides high-performance caching for both HTTP responses (`CacheInterceptor`) and `@Injectable()` service methods (`@Cacheable`, `@CacheEvict`, `@CachePut`), backed by pluggable stores (`MemoryCacheStore`, `RedisCacheStore`) with built-in single-flight stampede protection.

## Installation

```bash
bun add @bunest/cache
```

## Module Setup

Register `CacheModule.register()` (or `registerAsync()`) in your root module:

@@filename(app.module.ts)

```ts
import { Module } from "@bunest/core";
import { CacheModule, MemoryCacheStore } from "@bunest/cache";

@Module({
  imports: [
    CacheModule.register({
      isGlobal: true,
      ttl: 60_000, // default TTL in ms
      max: 1_000,
      store: new MemoryCacheStore({ maxEntries: 1_000 }),
    }),
  ],
})
export class AppModule {}
```

For multi-instance deployments, pass `new RedisCacheStore({ client: redisClient, keyPrefix: "app:" })`.

## Declarative Service-Layer Caching

Decorate `@Injectable()` service methods directly with `@Cacheable()`, `@CacheEvict()`, and `@CachePut()`. `CacheModule` automatically registers the aspect handlers with `DIContainer`'s `MethodAspectWeaver`:

@@filename(users.service.ts)

```ts
import { Injectable } from "@bunest/core";
import { Cacheable, CacheEvict, CachePut } from "@bunest/cache";

@Injectable()
export class UsersService {
  @Cacheable({
    key: (id: string) => `user:${id}`,
    ttl: 30_000,
    tags: (id: string) => ["users", `user:${id}`],
  })
  async findById(id: string) {
    return this.loadUserFromDb(id);
  }

  @CachePut({
    key: (id: string) => `user:${id}`,
    ttl: 30_000,
  })
  async update(id: string, name: string) {
    return this.saveUser(id, name);
  }

  @CacheEvict({
    key: (id: string) => `user:${id}`,
  })
  async remove(id: string) {
    await this.deleteUser(id);
  }
}
```

> info **Stampede Protection** `@Cacheable()` uses single-flight in-flight deduplication so concurrent calls for the same cold key invoke the underlying method once and share the resolved result.

## HTTP Response Caching (`CacheInterceptor`)

Cache GET controller responses with `CacheInterceptor`, `@CacheKey()`, `@CacheTTL()`, and `@NoCache()`:

@@filename(catalog.controller.ts)

```ts
import { Controller, Get, UseInterceptors } from "@bunest/core";
import { CacheInterceptor, CacheKey, CacheTTL, NoCache } from "@bunest/cache";

@Controller("catalog")
@UseInterceptors(CacheInterceptor)
export class CatalogController {
  @Get("featured")
  @CacheKey("catalog:featured")
  @CacheTTL(120_000)
  getFeatured() {
    return { items: ["bunest", "bun"] };
  }

  @Get("live-inventory")
  @NoCache()
  getLiveInventory() {
    return { count: 42 };
  }
}
```

## Imperative `CacheService` / `CACHE_MANAGER`

Inject `CacheService` (or `@Inject(CACHE_MANAGER)`) for direct `get`, `set`, `del`, `wrap`, `mget`, `mset`, and tag-based invalidation:

@@filename(stats.service.ts)

```ts
import { Injectable } from "@bunest/core";
import { CacheService } from "@bunest/cache";

@Injectable()
export class StatsService {
  constructor(private readonly cache: CacheService) {}

  async getDailyMetrics() {
    return this.cache.wrap(
      "metrics:daily",
      () => this.computeMetrics(),
      60_000,
    );
  }
}
```
