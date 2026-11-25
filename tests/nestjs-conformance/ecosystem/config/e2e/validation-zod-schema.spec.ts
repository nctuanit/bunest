import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { join, type BunestApplication } from "../../../../../packages/core/src";
import { ConfigService } from "../../../../../packages/core/src/config";
import { describeConformance, Test } from "../../../_helpers/index";
import { AppModule, fixturesDir } from "../_fixtures/app.module";

const envValidFilePath = join(fixturesDir, ".env.valid");
const envExtraFilePath = join(fixturesDir, ".env.extra");

const variants = [
  { name: "Zod v3", withValidation: AppModule.withZodV3SchemaValidation },
  { name: "Zod v4", withValidation: AppModule.withZodV4SchemaValidation },
  {
    name: "Zod v4 mini",
    withValidation: AppModule.withZodV4MiniSchemaValidation,
  },
];

describeConformance(
  "Zod schema validation",
  {
    upstreamPath: "config/tests/e2e/validation-zod-schema.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-005", "ADR-008"],
    notes:
      "Adapts Zod v3/v4/v4-mini object schemas to zero-dep Standard Schema v1 objects (ADR-013).",
  },
  () => {
    let app: BunestApplication | undefined;
    let envBackup: NodeJS.ProcessEnv;

    beforeEach(() => {
      envBackup = { ...process.env };
      delete process.env.PORT;
      delete process.env.DATABASE_NAME;
      delete process.env.FEATURE_FLAG;
    });

    afterEach(async () => {
      process.env = { ...envBackup };
      await app?.close();
      app = undefined;
    });

    describe.each(variants)("$name", ({ withValidation }) => {
      it("should validate loaded env variables", async () => {
        await expect(
          Test.createTestingModule({
            imports: [withValidation()],
          }).compile(),
        ).rejects.toThrow(/^Config validation error: [\s\S]*PORT/);
      });

      it("should report an issue for every invalid variable", async () => {
        await expect(
          Test.createTestingModule({
            imports: [withValidation()],
          }).compile(),
        ).rejects.toThrow(/PORT[\s\S]*DATABASE_NAME/);
      });

      it("should validate env variables even when ignoreEnvFile is true", async () => {
        await expect(
          Test.createTestingModule({
            imports: [withValidation(undefined, true)],
          }).compile(),
        ).rejects.toThrow(/^Config validation error: [\s\S]*DATABASE_NAME/);
      });

      it("should parse loaded env variables", async () => {
        const moduleRef = await Test.createTestingModule({
          imports: [withValidation(envValidFilePath)],
        }).compile();

        app = moduleRef.createNestApplication({ logger: false });
        await app.init();

        const configService = app.get(ConfigService);
        expect(typeof configService.get("PORT")).toEqual("number");
        expect(typeof configService.get("DATABASE_NAME")).toEqual("string");
      });

      it("should keep env variables that the schema does not declare", async () => {
        const moduleRef = await Test.createTestingModule({
          imports: [withValidation(envExtraFilePath)],
        }).compile();

        app = moduleRef.createNestApplication({ logger: false });
        await app.init();

        // Zod object schemas strip undeclared keys, but variables loaded from the
        // env file must still reach process.env and ConfigService.
        expect(process.env.FEATURE_FLAG).toEqual("enabled");
        expect(app.get(ConfigService).get("FEATURE_FLAG")).toEqual("enabled");
      });
    });
  },
);
