import { afterAll, beforeAll, expect, it } from "bun:test";
import {
  Controller,
  Get,
  Inject,
  Injectable,
  Module,
} from "../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  CACHE_MANAGER,
  Cache,
  CacheModule,
  type CacheModuleOptions,
  type CacheOptionsFactory,
} from "../../../../../packages/cache/src";
import { Test, describeConformance, request } from "../../../_helpers/index";

@Injectable()
class CacheConfig implements CacheOptionsFactory {
  createCacheOptions(): CacheModuleOptions {
    return { ttl: 100 };
  }
}

@Controller()
class AsyncRegisterController {
  constructor(@Inject(CACHE_MANAGER) private readonly cacheManager: Cache) {}

  @Get()
  async getFromStore(): Promise<string> {
    const value = await this.cacheManager.get<string>("key");
    if (!value) {
      await this.cacheManager.set("key", "value");
    }
    return value ?? "Not found";
  }
}

@Module({
  imports: [
    CacheModule.registerAsync({
      isGlobal: true,
      useClass: CacheConfig,
    }),
  ],
  controllers: [AsyncRegisterController],
})
class AsyncRegisterModule {}

describeConformance(
  "CacheModule - Async Register",
  {
    upstreamPath: "cache-manager/tests/e2e/async-register.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Uses Bunest zero-socket request(app) helper instead of Express/supertest.",
  },
  () => {
    let app: BunestApplication;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [AsyncRegisterModule],
      }).compile({ logger: false });

      app = moduleRef.createNestApplication({ logger: false });
      await app.init();
    });

    it("should return empty", async () => {
      const res = await request(app).get("/").expect(200);
      expect(res.text).toBe("Not found");
    });

    it("should return data", async () => {
      const res = await request(app).get("/").expect(200);
      expect(res.text).toBe("value");
    });

    afterAll(async () => {
      await app.close();
    });
  },
);
