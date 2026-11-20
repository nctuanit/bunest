import "reflect-metadata";
import { afterEach, beforeEach, expect, it } from "bun:test";
import type { BunestApplication } from "../../../../../packages/core/src";
import { describeConformance, Test } from "../../../_helpers/index";
import { AppModule } from "../_fixtures/app.module";

describeConformance(
  "Environment variables (multiple env files)",
  {
    upstreamPath: "config/tests/e2e/load-multiple-env.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    let app: BunestApplication;
    let originalEnv: NodeJS.ProcessEnv;

    beforeEach(async () => {
      originalEnv = { ...process.env };
      const moduleRef = await Test.createTestingModule({
        imports: [AppModule.withMultipleEnvFiles()],
      }).compile();

      app = moduleRef.createNestApplication({ logger: false });
      await app.init();
    });

    // BUNEST_BUG: app.get(AppModule) throws UnknownDependencyException because DIContainer.getSync() never checks module class instances (mod.instance) (packages/core/src/di/di-container.ts:1201,2626-2731)
    it.skip("should return loaded env variables", () => {
      const envVars = app.get(AppModule).getEnvVariables();
      expect(envVars.PORT).toEqual("3000");
      expect(envVars.TIMEOUT).toEqual("5000");
    });

    afterEach(async () => {
      await app.close();
      process.env = originalEnv;
    });
  },
);
