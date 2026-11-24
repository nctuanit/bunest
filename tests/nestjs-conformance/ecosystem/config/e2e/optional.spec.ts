import { afterEach, beforeEach, expect, it } from "bun:test";
import type { BunestApplication } from "../../../../../packages/core/src";
import { ConfigService } from "../../../../../packages/core/src/config";
import { describeConformance, Test } from "../../../_helpers/index";
import { AppModule } from "../_fixtures/app.module";

describeConformance(
  "Optional environment variables",
  {
    upstreamPath: "config/tests/e2e/optional.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    let app: BunestApplication | undefined;
    let originalEnv: NodeJS.ProcessEnv;

    beforeEach(() => {
      originalEnv = { ...process.env };
    });

    afterEach(async () => {
      await app?.close();
      app = undefined;
      process.env = originalEnv;
    });

    it("should return undefined for optional variables", async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [
          AppModule.withValidateFunction(() => ({
            optional: undefined,
          })),
        ],
      }).compile();

      app = moduleRef.createNestApplication({ logger: false });
      await app.init();

      const optional = moduleRef.get(ConfigService).get("optional");
      expect(optional).toEqual(undefined);
    });

    it("should not assign complex objects back to process.env", async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [
          AppModule.withValidateFunction(() => ({
            complex: { hello: "there" },
          })),
        ],
      }).compile();

      app = moduleRef.createNestApplication({ logger: false });
      await app.init();

      expect(process.env.complex).toEqual(undefined);
    });
  },
);
