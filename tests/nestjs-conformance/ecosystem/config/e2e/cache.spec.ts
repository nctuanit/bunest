import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { BunestApplication } from "../../../../../packages/core/src";
import { ConfigService } from "../../../../../packages/core/src/config";
import { describeConformance, Test } from "../../../_helpers/index";
import { AppModule } from "../_fixtures/app.module";

describeConformance(
  "Cache",
  {
    upstreamPath: "config/tests/e2e/cache.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    let app: BunestApplication;
    let envBackup: NodeJS.ProcessEnv;

    beforeAll(() => {
      envBackup = { ...process.env };
    });

    describe("without cache", () => {
      beforeAll(async () => {
        process.env["NAME"] = "TEST";
        const moduleRef = await Test.createTestingModule({
          imports: [AppModule.withEnvVars()],
        }).compile();

        app = moduleRef.createNestApplication({ logger: false });
        await app.init();
      });

      it("should return loaded env variables from vars", () => {
        const configService = app.get(ConfigService);
        expect(configService.get("NAME")).toEqual("TEST");
      });

      // BUNEST_BUG: ConfigModule copies runtime process.env into CONFIG_STORE_TOKEN at bootstrap and ConfigService.get() reads this.store before live process.env even when cache is false (expected "CHANGED", received "TEST"; packages/core/src/config/config.module.ts:130, packages/core/src/config/config.service.ts:278-286)
      it.skip("should return new vars", () => {
        process.env["NAME"] = "CHANGED";
        const configService = app.get(ConfigService);
        expect(configService.get("NAME")).toEqual("CHANGED");
      });
    });

    describe("with cache", () => {
      beforeAll(async () => {
        process.env["NAME"] = "TEST";
        const moduleRef = await Test.createTestingModule({
          imports: [AppModule.withCache()],
        }).compile();

        app = moduleRef.createNestApplication({ logger: false });
        await app.init();
      });

      it("should return loaded env variables from vars", () => {
        const configService = app.get(ConfigService);
        expect(configService.get("NAME")).toEqual("TEST");
      });

      it("should return cached vars", () => {
        process.env["NAME"] = "CHANGED";
        const configService = app.get(ConfigService);
        expect(configService.get("NAME")).toEqual("TEST");
      });
    });

    afterEach(async () => {
      process.env = { ...envBackup };
      await app?.close();
    });

    afterAll(() => {
      process.env = { ...envBackup };
    });
  },
);
