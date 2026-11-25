# Bộ nhớ đệm (Caching)

**`@bunest/cache`** cung cấp cơ chế lưu đệm hiệu năng cao cho cả phản hồi HTTP (`CacheInterceptor`) và phương thức của service `@Injectable()` (`@Cacheable`, `@CacheEvict`, `@CachePut`), được hỗ trợ bởi các kho lưu trữ có thể hoán đổi (`MemoryCacheStore`, `RedisCacheStore`) cùng cơ chế chống tràn yêu cầu (stampede protection) single-flight tích hợp sẵn.

## Cài đặt

```bash
bun add @bunest/cache
```

## Thiết lập Module

Đăng ký `CacheModule.register()` (hoặc `registerAsync()`) trong module gốc của bạn:

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

Đối với triển khai đa instance, truyền `new RedisCacheStore({ client: redisClient, keyPrefix: "app:" })`.

## Lưu đệm tầng Service dạng khai báo ([ADR-014](/architecture/adrs))

Gắn trực tiếp `@Cacheable()`, `@CacheEvict()` và `@CachePut()` lên các phương thức service `@Injectable()`. `CacheModule` tự động đăng ký các aspect handler với `MethodAspectWeaver` của `DIContainer`:

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

> info **Chống tràn yêu cầu (Stampede Protection)** `@Cacheable()` sử dụng cơ chế khử trùng lặp đang thực thi (single-flight in-flight deduplication) để các lời gọi đồng thời cho cùng một khóa chưa có trong cache chỉ thực thi phương thức gốc một lần và dùng chung kết quả trả về.

## Lưu đệm phản hồi HTTP (`CacheInterceptor`)

Lưu đệm phản hồi GET của controller với `CacheInterceptor`, `@CacheKey()`, `@CacheTTL()` và `@NoCache()`:

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

## Sử dụng `CacheService` / `CACHE_MANAGER` trực tiếp

Inject `CacheService` (hoặc `@Inject(CACHE_MANAGER)`) để thao tác trực tiếp `get`, `set`, `del`, `wrap`, `mget`, `mset` và hủy cache theo thẻ (tag-based invalidation):

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
