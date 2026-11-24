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
class MultiStoreController {
  constructor(@Inject(CACHE_MANAGER) private readonly cacheManager: Cache) {}

  @Get()
  async getFromMultiStore(): Promise<unknown> {
    const value = await this.cacheManager.get("multi-store-key");
    if (!value) {
      await this.cacheManager.set("multi-store-key", "multi-store-value");
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
      }),
    }),
  ],
  controllers: [MultiStoreController],
})
class MultiStoreModule {}

describeConformance(
  "CacheModule - Multi Store",
  {
    upstreamPath: "cache-manager/tests/e2e/multi-store.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts Keyv + @keyv/redis layered stores to native Bunest L1/L2 MemoryCacheStore instances.",
  },
  () => {
    let app: BunestApplication;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [MultiStoreModule],
      }).compile({ logger: false });

      app = moduleRef.createNestApplication({ logger: false });
      await app.init();
    });

    it("should return empty", async () => {
      const res = await request(app).get("/").expect(200);
      expect(res.text).toBe("");
    });

    it("should return data", async () => {
      const res = await request(app).get("/").expect(200);
      expect(res.text).toBe("multi-store-value");
    });

    afterAll(async () => {
      const cache = app.get<Cache>(CACHE_MANAGER);
      await cache.clear();
      await app.close();
    });
  },
);
