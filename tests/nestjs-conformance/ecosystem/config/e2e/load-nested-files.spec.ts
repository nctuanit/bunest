import { afterEach, beforeEach, expect, it } from "bun:test";
import type { BunestApplication } from "../../../../../packages/core/src";
import { describeConformance, Test } from "../../../_helpers/index";
import { AppModule } from "../_fixtures/app.module";

describeConformance(
  "Nested Files",
  {
    upstreamPath: "config/tests/e2e/load-nested-files.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    let app: BunestApplication;
    let originalEnv: NodeJS.ProcessEnv;

    beforeEach(async () => {
      originalEnv = { ...process.env };
      const moduleRef = await Test.createTestingModule({
        imports: [AppModule.withNestedLoadedConfigurations()],
      }).compile();

      app = moduleRef.createNestApplication({ logger: false });
      await app.init();
    });

    it("should return nested loaded configuration", () => {
      const host = app.get(AppModule).getNestedDatabaseHost();
      expect(host).toEqual("host");
    });

    afterEach(async () => {
      await app.close();
      process.env = originalEnv;
    });
  },
);
