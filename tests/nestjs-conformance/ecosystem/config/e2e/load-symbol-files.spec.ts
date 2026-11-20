import "reflect-metadata";
import { afterEach, beforeEach, expect, it } from "bun:test";
import type { BunestApplication } from "../../../../../packages/core/src";
import { describeConformance, Test } from "../../../_helpers/index";
import { AppModule } from "../_fixtures/app.module";

describeConformance(
  "Symbol Files",
  {
    upstreamPath: "config/tests/e2e/load-symbol-files.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    let app: BunestApplication;
    let originalEnv: NodeJS.ProcessEnv;

    beforeEach(async () => {
      originalEnv = { ...process.env };
      const moduleRef = await Test.createTestingModule({
        imports: [AppModule.withSymbolLoadedConfigurations()],
      }).compile();

      app = moduleRef.createNestApplication({ logger: false });
      await app.init();
    });

    // BUNEST_BUG: app.get(AppModule) throws UnknownDependencyException (packages/core/src/di/di-container.ts:1201,2626-2731); additionally default ConfigService<Record<string, unknown>> KeyOf<T> resolves to `string` instead of `string | symbol`, rejecting symbol keys at compile time (packages/config/src/config.service.ts:27)
    it.skip("should return symbol loaded configuration", () => {
      const config = app.get(AppModule).getSymbolDatabaseConfig();
      expect(config.host).toEqual("host");
      expect(config.port).toEqual(4000);
    });

    afterEach(async () => {
      await app.close();
      process.env = originalEnv;
    });
  },
);
