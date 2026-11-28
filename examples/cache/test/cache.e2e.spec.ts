import { describe, expect, it } from "bun:test";
import { Test } from "@bunest/testing";
import { AppController } from "../src/app.controller";
import { AppModule } from "../src/app.module";
import { ProductsService, type ProductRecord } from "../src/products.service";

describe("Caching (NestJS 20-cache E2E)", () => {
  it("caches HTTP responses via CacheInterceptor, respects @NoCache, and supports @Cacheable/@CachePut/@CacheEvict", async () => {
    const mod = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    const app = mod.createBunestApplication();
    const client = mod.createTestClient(app);
    await app.init();

    try {
      const controller = mod.get(AppController);
      const products = mod.get(ProductsService);

      // 1. HTTP CacheInterceptor caches /summary
      const s1 = (await (await client.get("/summary")).json()) as {
        computedAt: number;
      };
      const s2 = (await (await client.get("/summary")).json()) as {
        computedAt: number;
      };
      expect(s1.computedAt).toBe(1);
      expect(s2.computedAt).toBe(1);
      expect(controller.summaryCalls).toBe(1);

      // 2. @NoCache() bypasses HTTP CacheInterceptor
      const l1 = (await (await client.get("/live")).json()) as { liveTick: number };
      const l2 = (await (await client.get("/live")).json()) as { liveTick: number };
      expect(l1.liveTick).toBe(1);
      expect(l2.liveTick).toBe(2);

      // 3. @Cacheable caches product lookup in service layer
      const p1First = (await (
        await client.get("/products/p1")
      ).json()) as ProductRecord;
      const p1Second = (await (
        await client.get("/products/p1")
      ).json()) as ProductRecord;
      expect(p1First.price).toBe(149);
      expect(p1First.loadCount).toBe(1);
      expect(p1Second.loadCount).toBe(1);
      expect(products.dbReads).toBe(1);

      // 4. @CachePut refreshes cached entry without triggering a DB read
      const updated = (await (
        await client.patch("/products/p1", { json: { price: 129 } })
      ).json()) as ProductRecord;
      expect(updated.price).toBe(129);
      const p1AfterPut = (await (
        await client.get("/products/p1")
      ).json()) as ProductRecord;
      expect(p1AfterPut.price).toBe(129);
      expect(products.dbReads).toBe(1);

      // 5. @CacheEvict({ tags: ["products"] }) forces fresh DB read
      await client.delete("/products/cache");
      const p1Refetched = (await (
        await client.get("/products/p1")
      ).json()) as ProductRecord;
      expect(p1Refetched.price).toBe(129);
      expect(p1Refetched.loadCount).toBe(2);
      expect(products.dbReads).toBe(2);

      // 6. Imperative CACHE_MANAGER clear invalidates /summary too
      await client.delete("/cache");
      const s3 = (await (await client.get("/summary")).json()) as {
        computedAt: number;
      };
      expect(s3.computedAt).toBe(2);
    } finally {
      await app.close();
    }
  });
});
