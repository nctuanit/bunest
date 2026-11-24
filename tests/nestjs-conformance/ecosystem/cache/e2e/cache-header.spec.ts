import { afterEach, beforeEach, expect, it } from "bun:test";
import {
  Controller,
  Get,
  Module,
  UseInterceptors,
} from "../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  CacheInterceptor,
  CacheModule,
  CacheTTL,
} from "../../../../../packages/cache/src";
import { Test, describeConformance, request } from "../../../_helpers/index";

@Controller()
@CacheTTL(600)
class CustomTtlController {
  counter = 0;

  @Get()
  @CacheTTL(500)
  @UseInterceptors(CacheInterceptor)
  getNumber() {
    return this.counter++;
  }

  @Get("/controller")
  @UseInterceptors(CacheInterceptor)
  getNumberWithControllerTTL() {
    return this.counter++;
  }
}

@Module({
  imports: [CacheModule.register()],
  controllers: [CustomTtlController],
})
class CustomTtlModule {}

describeConformance(
  "CacheInterceptor - X-Cache header",
  {
    upstreamPath: "cache-manager/tests/e2e/cache-header.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Uses Bunest zero-socket request(app) helper instead of Express/supertest.",
  },
  () => {
    let app: BunestApplication;

    beforeEach(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [CustomTtlModule],
      }).compile({ logger: false });

      app = moduleRef.createNestApplication({ logger: false });
      await app.init();
    });

    it("should set X-Cache header MISS when cache wasn't hit", async () => {
      const res = await request(app).get("/").expect(200);
      expect(res.headers["x-cache"]).toBe("MISS");
    });

    it("should set X-Cache header HIT when cache was hit", async () => {
      const first = await request(app).get("/").expect(200);
      expect(first.headers["x-cache"]).toBe("MISS");

      const second = await request(app).get("/").expect(200);
      expect(second.headers["x-cache"]).toBe("HIT");
    });

    afterEach(async () => {
      await app.close();
    });
  },
);
