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
  "CacheInterceptor - Caching Custom TTL",
  {
    upstreamPath: "cache-manager/tests/e2e/custom-ttl.spec.ts",
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

    it("should return a different value after the TTL is elapsed", async () => {
      const first = await request(app).get("/").expect(200);
      expect(first.text).toBe("0");
      await new Promise((resolve) => setTimeout(resolve, 550));
      const second = await request(app).get("/").expect(200);
      expect(second.text).toBe("1");
    });

    it("should return the cached value within the TTL", async () => {
      const first = await request(app).get("/").expect(200);
      expect(first.text).toBe("0");
      await new Promise((resolve) => setTimeout(resolve, 200));
      const second = await request(app).get("/").expect(200);
      expect(second.text).toBe("0");
    });

    it("should return a different value after the TTL of the controller is elapsed", async () => {
      const first = await request(app).get("/controller").expect(200);
      expect(first.text).toBe("0");
      await new Promise((resolve) => setTimeout(resolve, 650));
      const second = await request(app).get("/controller").expect(200);
      expect(second.text).toBe("1");
    });

    it("should return the cached value within the TTL of the controller", async () => {
      const first = await request(app).get("/controller").expect(200);
      expect(first.text).toBe("0");
      await new Promise((resolve) => setTimeout(resolve, 300));
      const second = await request(app).get("/controller").expect(200);
      expect(second.text).toBe("0");
    });

    afterEach(async () => {
      await app.close();
    });
  },
);
