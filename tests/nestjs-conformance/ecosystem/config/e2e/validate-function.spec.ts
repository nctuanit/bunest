import { afterEach, beforeEach, expect, it } from "bun:test";
import { join, type BunestApplication } from "../../../../../packages/core/src";
import { ConfigService } from "../../../../../packages/core/src/config";
import { describeConformance, Test } from "../../../_helpers/index";
import { AppModule, fixturesDir } from "../_fixtures/app.module";

const envValidFilePath = join(fixturesDir, ".env.valid");

describeConformance(
  "Validate function",
  {
    upstreamPath: "config/tests/e2e/validate-function.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    let app: BunestApplication | undefined;
    let originalEnv: NodeJS.ProcessEnv;
    const errorMessage = "Validation error";
    const validate = (config: Record<string, any>) => {
      if (!("PORT" in config && "DATABASE_NAME" in config)) {
        throw new Error(errorMessage);
      }
      return {};
    };

    beforeEach(() => {
      originalEnv = { ...process.env };
      delete process.env.PORT;
      delete process.env.DATABASE_NAME;
    });

    afterEach(async () => {
      await app?.close();
      app = undefined;
      process.env = originalEnv;
    });

    it("should prevent application from bootstrapping if error is thrown due to loaded env variables", async () => {
      let hasThrown = false;
      try {
        const moduleRef = await Test.createTestingModule({
          imports: [AppModule.withValidateFunction(validate)],
        }).compile();

        app = moduleRef.createNestApplication({ logger: false });
        await app.init();
      } catch (err) {
        hasThrown = true;
        expect((err as Error).message).toEqual(errorMessage);
      }
      expect(hasThrown).toBe(true);
    });

    it("should prevent application from bootstrapping if error is thrown even when ignoreEnvFile is true", async () => {
      let hasThrown = false;
      try {
        const moduleRef = await Test.createTestingModule({
          imports: [AppModule.withValidateFunction(validate, undefined, true)],
        }).compile();

        app = moduleRef.createNestApplication({ logger: false });
        await app.init();
      } catch (err) {
        hasThrown = true;
        expect((err as Error).message).toEqual(errorMessage);
      }
      expect(hasThrown).toBe(true);
    });

    it("should load env variables if everything is ok", async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [AppModule.withValidateFunction(validate, envValidFilePath)],
      }).compile();

      app = moduleRef.createNestApplication({ logger: false });
      await app.init();

      const configService = app.get(ConfigService);
      expect(typeof configService.get("PORT")).not.toBe(undefined);
      expect(typeof configService.get("DATABASE_NAME")).not.toBe(undefined);
    });

    it("should parse loaded env variables", async () => {
      const validateAndTransform = (config: Record<string, any>) => {
        return {
          PORT: Number(config.PORT),
          DATABASE_NAME: config.DATABASE_NAME,
        };
      };
      const moduleRef = await Test.createTestingModule({
        imports: [
          AppModule.withValidateFunction(
            validateAndTransform,
            envValidFilePath,
          ),
        ],
      }).compile();

      app = moduleRef.createNestApplication({ logger: false });
      await app.init();

      const configService = app.get(ConfigService);
      expect(typeof configService.get("PORT")).toEqual("number");
    });
  },
);
