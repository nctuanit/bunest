import { afterAll, beforeAll, expect, it } from "bun:test";
import {
  Controller,
  Get,
  Inject,
  Module,
} from "../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  CACHE_MANAGER,
  Cache,
  CacheModule,
  MemoryCacheStore,
} from "../../../../../packages/cache/src";
import { Test, describeConformance, request } from "../../../_helpers/index";

@Controller()
class CacheableNonBlockingController {
  constructor(@Inject(CACHE_MANAGER) private readonly cacheManager: Cache) {}

  @Get()
  async getFromCacheable(): Promise<unknown> {
    const value = await this.cacheManager.get("cacheable-key");
    if (!value) {
      await this.cacheManager.set("cacheable-key", "cacheable-value");
    } else {
      await this.cacheManager.del("cacheable-key");
    }
    return value ?? "";
  }
}

@Module({
  imports: [
    CacheModule.registerAsync({
      useFactory: async () => ({
        stores: [
          new MemoryCacheStore({ defaultTtlMs: 60_000, maxItems: 5000 }),
          new MemoryCacheStore({ defaultTtlMs: 60_000 }),
        ],
        nonBlocking: true,
        ttl: 30_000,
        namespace: "test-cacheable",
      }),
    }),
  ],
  controllers: [CacheableNonBlockingController],
})
class CacheableNonBlockingModule {}

describeConformance(
  "CacheModule - Caching with nonBlocking multi-tier stores",
  {
    upstreamPath: "cache-manager/tests/e2e/cacheable-nonblocking.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts upstream Cacheable(Keyv + @keyv/redis, nonBlocking: true) to native Bunest CacheModule L1/L2 MemoryCacheStore with nonBlocking: true and namespace.",
  },
  () => {
    let app: BunestApplication;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [CacheableNonBlockingModule],
      }).compile({ logger: false });

      app = moduleRef.createNestApplication({ logger: false });
      await app.init();
    });

    it("should return empty on first call", async () => {
      const res = await request(app).get("/").expect(200);
      expect(res.text).toBe("");
    });

    it("should return cached data on second call", async () => {
      const res = await request(app).get("/").expect(200);
      expect(res.text).toBe("cacheable-value");
    });

    afterAll(async () => {
      await app.close();
    });
  },
);
