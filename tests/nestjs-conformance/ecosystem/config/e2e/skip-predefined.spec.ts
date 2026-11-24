import { afterEach, beforeEach, expect, it } from "bun:test";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  ConfigModule,
  ConfigService,
} from "../../../../../packages/core/src/config";
import { describeConformance, Test } from "../../../_helpers/index";
import { AppModule } from "../_fixtures/app.module";

describeConformance(
  "Environment variables (skip process env)",
  {
    upstreamPath: "config/tests/e2e/skip-predefined.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    let app: BunestApplication;
    let originalEnv: NodeJS.ProcessEnv;

    beforeEach(async () => {
      originalEnv = { ...process.env };
      const moduleRef = await Test.createTestingModule({
        imports: [AppModule.withSkipProcessEnv()],
      }).compile();

      app = moduleRef.createNestApplication({ logger: false });
      await app.init();
    });

    it("should ignore predefined environment variables (process.env)", async () => {
      process.env.RANDOM_PREDEFINED = "test";
      await ConfigModule.envVariablesLoaded;

      const configService = app.get(ConfigService);
      expect(configService.get("RANDOM_PREDEFINED")).toBeUndefined();
    });

    afterEach(async () => {
      await app.close();
      process.env = originalEnv;
    });
  },
);
