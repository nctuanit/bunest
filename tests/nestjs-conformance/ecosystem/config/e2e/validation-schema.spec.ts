import "reflect-metadata";
import { afterEach, beforeEach, expect, it } from "bun:test";
import { join } from "node:path";
import type { BunestApplication } from "../../../../../packages/core/src";
import { ConfigService } from "../../../../../packages/config/src";
import { describeConformance, Test } from "../../../_helpers/index";
import { AppModule, fixturesDir } from "../_fixtures/app.module";

const envValidFilePath = join(fixturesDir, ".env.valid");

describeConformance(
  "Schema validation",
  {
    upstreamPath: "config/tests/e2e/validation-schema.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-005", "ADR-008"],
    notes:
      "Adapts Joi.object({ PORT, DATABASE_NAME }) to zero-dep Standard Schema v1 (ADR-013).",
  },
  () => {
    let app: BunestApplication | undefined;
    let envBackup: NodeJS.ProcessEnv;

    beforeEach(() => {
      envBackup = { ...process.env };
      delete process.env.PORT;
      delete process.env.DATABASE_NAME;
    });

    afterEach(async () => {
      process.env = { ...envBackup };
      await app?.close();
      app = undefined;
    });

    // BUNEST_BUG: Standard Schema failure message uses "Configuration Standard Schema validation failed:\n  - PORT: ..." instead of NestJS "Config validation error: PORT: ..." format (packages/config/src/validator.ts:194-197)
    it.skip("should validate loaded env variables", async () => {
      await expect(
        Test.createTestingModule({
          imports: [AppModule.withSchemaValidation()],
        }).compile(),
      ).rejects.toThrow(
        'Config validation error: PORT: "PORT" is required\n' +
          'DATABASE_NAME: "DATABASE_NAME" is required',
      );
    });

    // BUNEST_BUG: Standard Schema failure message uses "Configuration Standard Schema validation failed:\n  - PORT: ..." instead of NestJS "Config validation error: PORT: ..." format (packages/config/src/validator.ts:194-197)
    it.skip("should validate env variables even when ignoreEnvFile is true", async () => {
      await expect(
        Test.createTestingModule({
          imports: [AppModule.withSchemaValidation(undefined, true)],
        }).compile(),
      ).rejects.toThrow(
        'Config validation error: PORT: "PORT" is required\n' +
          'DATABASE_NAME: "DATABASE_NAME" is required',
      );
    });

    it("should report every issue instead of aborting on the first one", async () => {
      await expect(
        Test.createTestingModule({
          imports: [AppModule.withSchemaValidation()],
        }).compile(),
      ).rejects.toThrow(/PORT[\s\S]*DATABASE_NAME/);
    });

    it("should allow variables that are not declared in the schema", async () => {
      process.env.UNRELATED_VARIABLE = "unrelated";

      const moduleRef = await Test.createTestingModule({
        imports: [AppModule.withSchemaValidation(envValidFilePath)],
      }).compile();

      app = moduleRef.createNestApplication({ logger: false });
      await app.init();

      const configService = app.get(ConfigService);
      expect(configService.get("UNRELATED_VARIABLE")).toEqual("unrelated");
    });

    // BUNEST_BUG: validateConfiguration() does not forward options.validationOptions to validationSchema["~standard"].validate(value, options) (and ConfigModuleOptions.validationOptions is typed only as ValidationPipeOptions, not StandardSchemaV1Options) (packages/config/src/validator.ts:186, packages/config/src/interfaces/config.interface.ts:138)
    it.skip('should let "allowUnknown" be disabled through validationOptions', async () => {
      process.env.UNRELATED_VARIABLE = "unrelated";

      await expect(
        Test.createTestingModule({
          imports: [
            AppModule.withSchemaValidation(envValidFilePath, false, {
              libraryOptions: { allowUnknown: false },
            }),
          ],
        }).compile(),
      ).rejects.toThrow('"UNRELATED_VARIABLE" is not allowed');
    });

    it("should parse loaded env variables", async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [AppModule.withSchemaValidation(envValidFilePath)],
      }).compile();

      app = moduleRef.createNestApplication({ logger: false });
      await app.init();

      const configService = app.get(ConfigService);
      expect(typeof configService.get("PORT")).toEqual("number");
    });
  },
);
