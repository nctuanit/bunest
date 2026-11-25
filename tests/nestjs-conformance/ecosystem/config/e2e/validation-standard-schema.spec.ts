import { afterEach, beforeEach, expect, it, mock } from "bun:test";
import type {
  StandardSchemaV1,
  StandardSchemaV1Options,
} from "../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../packages/core/src";
import { ConfigService } from "../../../../../packages/core/src/config";
import { describeConformance, Test } from "../../../_helpers/index";
import { AppModule } from "../_fixtures/app.module";
import { createValibotLikePortSchema } from "../_fixtures/schema-helpers";

/**
 * Library-agnostic coverage for the Standard Schema v1 contract itself.
 * @see https://standardschema.dev/
 */
function createSchema(
  validate: StandardSchemaV1["~standard"]["validate"],
  vendor = "test",
): StandardSchemaV1 {
  return { "~standard": { version: 1, vendor, validate } };
}

describeConformance(
  "Standard Schema validation",
  {
    upstreamPath: "config/tests/e2e/validation-standard-schema.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-005", "ADR-008"],
    notes:
      "Adapts Valibot schema cases to zero-dep inline Standard Schema v1 objects (ADR-013).",
  },
  () => {
    let app: BunestApplication | undefined;
    let envBackup: NodeJS.ProcessEnv;

    beforeEach(() => {
      envBackup = { ...process.env };
      delete process.env.PORT;
    });

    afterEach(async () => {
      process.env = { ...envBackup };
      await app?.close();
      app = undefined;
    });

    it("should fail when issues are returned alongside a value", async () => {
      // Valibot-style failure: the partially parsed dataset is returned together
      // with the issues, so the presence of "value" must not imply success.
      const schema = createSchema(() => ({
        value: { PORT: undefined },
        issues: [{ message: "PORT is required", path: ["PORT"] }],
      }));

      await expect(
        Test.createTestingModule({
          imports: [
            AppModule.withStandardSchemaValidation(schema, undefined, true),
          ],
        }).compile(),
      ).rejects.toThrow("Config validation error: PORT: PORT is required");
    });

    it("should fail when a real valibot schema rejects the config", async () => {
      const schema = createValibotLikePortSchema();

      await expect(
        Test.createTestingModule({
          imports: [
            AppModule.withStandardSchemaValidation(schema, undefined, true),
          ],
        }).compile(),
      ).rejects.toThrow("Config validation error: PORT:");
    });

    it("should accept a config validated by a real valibot schema", async () => {
      process.env.PORT = "4000";
      const schema = createValibotLikePortSchema();

      const moduleRef = await Test.createTestingModule({
        imports: [
          AppModule.withStandardSchemaValidation(schema, undefined, true),
        ],
      }).compile();

      app = moduleRef.createNestApplication({ logger: false });
      await app.init();

      expect(app.get(ConfigService).get("PORT")).toEqual("4000");
    });

    it("should await schemas that validate asynchronously", async () => {
      const schema = createSchema(async (config) => ({
        value: { ...(config as Record<string, any>), PORT: 4000 },
      }));

      const moduleRef = await Test.createTestingModule({
        imports: [
          AppModule.withStandardSchemaValidation(schema, undefined, true),
        ],
      }).compile();

      app = moduleRef.createNestApplication({ logger: false });
      await app.init();

      expect(app.get(ConfigService).get("PORT")).toEqual(4000);
    });

    it("should report issues from schemas that validate asynchronously", async () => {
      const schema = createSchema(async () => ({
        issues: [{ message: "PORT is required", path: ["PORT"] }],
      }));

      await expect(
        Test.createTestingModule({
          imports: [
            AppModule.withStandardSchemaValidation(schema, undefined, true),
          ],
        }).compile(),
      ).rejects.toThrow("Config validation error: PORT: PORT is required");
    });

    it("should format issue paths built from path segment objects", async () => {
      const schema = createSchema(() => ({
        issues: [
          {
            message: "must be a number",
            path: [{ key: "DATABASE" }, { key: "PORT" }],
          },
        ],
      }));

      await expect(
        Test.createTestingModule({
          imports: [
            AppModule.withStandardSchemaValidation(schema, undefined, true),
          ],
        }).compile(),
      ).rejects.toThrow(
        "Config validation error: DATABASE.PORT: must be a number",
      );
    });

    it("should report issues that carry no path", async () => {
      const schema = createSchema(() => ({
        issues: [{ message: "the config is invalid" }],
      }));

      await expect(
        Test.createTestingModule({
          imports: [
            AppModule.withStandardSchemaValidation(schema, undefined, true),
          ],
        }).compile(),
      ).rejects.toThrow("Config validation error: the config is invalid");
    });

    it("should forward validationOptions to the schema", async () => {
      const validate = mock(
        (_value: unknown, _options?: StandardSchemaV1Options) => ({
          value: {},
        }),
      );
      const schema = createSchema(validate);
      const validationOptions: StandardSchemaV1Options = {
        libraryOptions: { custom: true },
      };

      const moduleRef = await Test.createTestingModule({
        imports: [
          AppModule.withStandardSchemaValidation(
            schema,
            undefined,
            true,
            validationOptions,
          ),
        ],
      }).compile();

      app = moduleRef.createNestApplication({ logger: false });
      await app.init();

      expect(validate.mock.calls[0]?.[1]).toEqual(validationOptions);
    });

    it("should not inject Joi defaults into other vendors' options", async () => {
      const validate = mock(
        (_value: unknown, _options?: StandardSchemaV1Options) => ({
          value: {},
        }),
      );
      const schema = createSchema(validate, "zod");

      const moduleRef = await Test.createTestingModule({
        imports: [
          AppModule.withStandardSchemaValidation(schema, undefined, true),
        ],
      }).compile();

      app = moduleRef.createNestApplication({ logger: false });
      await app.init();

      expect(validate.mock.calls[0]?.[1]).toBeUndefined();
    });
  },
);
