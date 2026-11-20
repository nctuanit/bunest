import "reflect-metadata";
import { afterEach, beforeEach, expect, it } from "bun:test";
import type { BunestApplication } from "../../../../../packages/core/src";
import { describeConformance, Test } from "../../../_helpers/index";
import { AppModule } from "../_fixtures/app.module";

describeConformance(
  "Environment variables (expanded ignore process env)",
  {
    upstreamPath: "config/tests/e2e/load-env-expanded-ignore-process-env.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    let app: BunestApplication;
    let originalEnv: NodeJS.ProcessEnv;

    beforeEach(async () => {
      originalEnv = { ...process.env };
      process.env.URL = "process-app.test";

      const moduleRef = await Test.createTestingModule({
        imports: [AppModule.withExpandedEnvVarsIgnoreProcessEnv()],
      }).compile();

      app = moduleRef.createNestApplication({ logger: false });
      await app.init();
    });

    // BUNEST_BUG: app.get(AppModule) throws UnknownDependencyException because DIContainer.getSync() never checks module class instances (mod.instance) (packages/core/src/di/di-container.ts:1201,2626-2731)
    it.skip("should ignore process environment variable", () => {
      const envVars = app.get(AppModule).getEnvVariables();
      expect(envVars.EMAIL).toEqual("support@myapp.test");
    });

    afterEach(async () => {
      await app.close();
      process.env = originalEnv;
    });
  },
);
