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
class ConfigService {
  public getTtl(): number {
    return 100;
  }
}

@Injectable()
class CacheConfig implements CacheOptionsFactory {
  constructor(private readonly configService: ConfigService) {}

  createCacheOptions(): CacheModuleOptions {
    const ttl = this.configService.getTtl();
    return { ttl };
  }
}

@Controller()
class AsyncRegisterExtraController {
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
      extraProviders: [ConfigService],
      isGlobal: true,
      useClass: CacheConfig,
    }),
  ],
  controllers: [AsyncRegisterExtraController],
})
class AsyncRegisterExtraModule {}

describeConformance(
  "CacheModule - Async Register Extra Providers",
  {
    upstreamPath:
      "cache-manager/tests/e2e/async-register-extra-providers.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Uses Bunest zero-socket request(app) helper instead of Express/supertest.",
  },
  () => {
    let app: BunestApplication;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [AsyncRegisterExtraModule],
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
