import { afterEach, beforeEach, expect, it } from "bun:test";
import type { BunestApplication } from "../../../../../packages/core/src";
import { ConfigModule } from "../../../../../packages/core/src/config";
import { describeConformance, Test } from "../../../_helpers/index";
import { AppModule } from "../_fixtures/app.module";

describeConformance(
  "Environment variables",
  {
    upstreamPath: "config/tests/e2e/load-env.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    let app: BunestApplication;
    let originalEnv: NodeJS.ProcessEnv;

    beforeEach(async () => {
      originalEnv = { ...process.env };
      const moduleRef = await Test.createTestingModule({
        imports: [AppModule.withEnvVars()],
      }).compile();

      app = moduleRef.createNestApplication({ logger: false });
      await app.init();
    });

    it("should return loaded env variables", async () => {
      await ConfigModule.envVariablesLoaded;

      const envVars = app.get(AppModule).getEnvVariables();
      expect(envVars.PORT).toEqual("4000");
    });

    afterEach(async () => {
      await app.close();
      process.env = originalEnv;
    });
  },
);
