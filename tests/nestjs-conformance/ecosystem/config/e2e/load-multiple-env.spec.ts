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

    it("should return loaded env variables", () => {
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
