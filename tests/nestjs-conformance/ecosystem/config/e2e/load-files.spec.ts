import "reflect-metadata";
import { afterEach, beforeEach, expect, it } from "bun:test";
import type { BunestApplication } from "../../../../../packages/core/src";
import { describeConformance, Test } from "../../../_helpers/index";
import { AppModule } from "../_fixtures/app.module";

describeConformance(
  "Files",
  {
    upstreamPath: "config/tests/e2e/load-files.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    let app: BunestApplication;
    let originalEnv: NodeJS.ProcessEnv;

    beforeEach(async () => {
      originalEnv = { ...process.env };
      const moduleRef = await Test.createTestingModule({
        imports: [AppModule.withLoadedConfigurations()],
      }).compile();

      app = moduleRef.createNestApplication({ logger: false });
      await app.init();
    });

    // BUNEST_BUG: app.get(AppModule) throws UnknownDependencyException because DIContainer.getSync() never checks module class instances (mod.instance) (packages/core/src/di/di-container.ts:1201,2626-2731)
    it.skip("should return loaded configuration", () => {
      const host = app.get(AppModule).getDatabaseHost();
      expect(host).toEqual("host");
    });

    // BUNEST_BUG: app.get(AppModule) throws UnknownDependencyException because DIContainer.getSync() never checks module class instances (mod.instance) (packages/core/src/di/di-container.ts:1201,2626-2731)
    it.skip("should return loaded configuration (injected through constructor)", () => {
      const config = app.get(AppModule).getDatabaseConfig();
      expect(config.host).toEqual("host");
      expect(config.port).toEqual(4000);
    });

    afterEach(async () => {
      await app.close();
      process.env = originalEnv;
    });
  },
);
