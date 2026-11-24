import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  join,
  mkdirSyncPath,
  removePath,
  writeTextSync,
} from "../../../../../packages/core/src";
import type { StandardSchemaV1 } from "../../../../../packages/core/src/common";
import {
  ConfigModule,
  ConfigService,
  type ConfigModuleOptions,
} from "../../../../../packages/core/src/config";
import { describeConformance, Test } from "../../../_helpers/index";
import { createStandardSchema } from "../_fixtures/schema-helpers";

describeConformance(
  "Validated environment variables",
  {
    upstreamPath: "config/tests/e2e/validated-env.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-005", "ADR-008"],
    notes:
      "Adapts Joi/Zod schemas to zero-dep inline Standard Schema v1 objects (ADR-013).",
  },
  () => {
    let originalEnv: NodeJS.ProcessEnv;
    let tmpDir: string;

    function writeEnvFile(name: string, lines: string[]) {
      const envFilePath = join(tmpDir, name);
      writeTextSync(envFilePath, lines.join("\n"));
      return envFilePath;
    }

    async function createConfigService(...optionsList: ConfigModuleOptions[]) {
      const moduleRef = await Test.createTestingModule({
        imports: optionsList.map((options) => ConfigModule.forRoot(options)),
      }).compile();
      return moduleRef.get(ConfigService);
    }

    beforeEach(() => {
      originalEnv = { ...process.env };
      tmpDir = join(
        Bun.env.TMPDIR ?? Bun.env.TEMP ?? "/tmp",
        `bunest-config-${crypto.randomUUID()}`,
      );
      mkdirSyncPath(tmpDir);
    });

    afterEach(async () => {
      process.env = originalEnv;
      await removePath(tmpDir, { recursive: true, force: true });
    });

    describe("a variable the validator maps to undefined", () => {
      it("should not be served from process.env", async () => {
        process.env.CORS_ORIGIN = "*";
        process.env.ADMIN_API_TOKEN = "";

        const schema = createStandardSchema<Record<string, unknown>>((raw) => {
          const rec = (raw ?? {}) as Record<string, unknown>;
          let corsOrigin: string | undefined;
          if (typeof rec.CORS_ORIGIN === "string") {
            try {
              new URL(rec.CORS_ORIGIN);
              corsOrigin = rec.CORS_ORIGIN;
            } catch {
              corsOrigin = undefined;
            }
          }
          const adminApiToken =
            rec.ADMIN_API_TOKEN === ""
              ? undefined
              : typeof rec.ADMIN_API_TOKEN === "string"
                ? rec.ADMIN_API_TOKEN
                : undefined;

          return {
            value: {
              CORS_ORIGIN: corsOrigin,
              ADMIN_API_TOKEN: adminApiToken,
            },
          };
        }, "zod");

        const configService = await createConfigService({
          ignoreEnvFile: true,
          validationSchema: schema,
        });

        expect(configService.get("CORS_ORIGIN")).toBeUndefined();
        expect(configService.get("ADMIN_API_TOKEN", "disabled")).toBe(
          "disabled",
        );
        expect(() => configService.getOrThrow("ADMIN_API_TOKEN")).toThrow(
          TypeError,
        );
      });

      it("should still be served from process.env if the validator was not given it", async () => {
        process.env.PORT = "3000";
        const configService = await createConfigService({
          ignoreEnvFile: true,
          validatePredefined: false,
          validate: (config) => ({ PORT: config.PORT }),
        });

        expect(configService.get("PORT")).toBe("3000");
      });
    });

    it("should not restore a variable the schema strips", async () => {
      const envFilePath = writeEnvFile(".env", [
        "ALLOW_INSECURE_COOKIES=true",
        "PORT=3000",
        "UNDECLARED=1",
      ]);

      // Mirrors Joi.object({ ALLOW_INSECURE_COOKIES: Joi.boolean().strip(), PORT: Joi.number() })
      const joiStripSchema = Object.assign(
        createStandardSchema<Record<string, unknown>>((raw) => {
          const rec = { ...((raw ?? {}) as Record<string, unknown>) };
          delete rec.ALLOW_INSECURE_COOKIES;
          if (rec.PORT !== undefined) {
            rec.PORT = Number(rec.PORT);
          }
          return { value: rec };
        }, "joi"),
        {
          describe: () => ({ keys: { ALLOW_INSECURE_COOKIES: {}, PORT: {} } }),
        },
      );

      const configService = await createConfigService({
        envFilePath,
        validationSchema: joiStripSchema,
      });

      expect(configService.get("ALLOW_INSECURE_COOKIES")).toBeUndefined();
      expect(process.env.ALLOW_INSECURE_COOKIES).toBeUndefined();
      expect(configService.get("PORT")).toBe(3000);
      expect(configService.get("UNDECLARED")).toBe("1");
    });

    it("should keep undeclared variables of a schema that strips them", async () => {
      const envFilePath = writeEnvFile(".env", ["PORT=3000", "UNDECLARED=1"]);
      const zodPortSchema = Object.assign(
        createStandardSchema<Record<string, unknown>>((raw) => {
          const rec = (raw ?? {}) as Record<string, unknown>;
          return { value: { PORT: Number(rec.PORT) } };
        }, "zod"),
        { shape: { PORT: {} } },
      );

      const configService = await createConfigService({
        envFilePath,
        validationSchema: zodPortSchema,
      });

      expect(configService.get("PORT")).toBe(3000);
      expect(configService.get("UNDECLARED")).toBe("1");
    });

    it('should not serve undeclared process.env variables with "skipProcessEnv" (zod)', async () => {
      process.env.CLOUD_SECRET_KEY = "hunter2";
      process.env.PORT = "3000";
      const zodPortSchema = Object.assign(
        createStandardSchema<Record<string, unknown>>((raw) => {
          const rec = (raw ?? {}) as Record<string, unknown>;
          return { value: { PORT: Number(rec.PORT) } };
        }, "zod"),
        { shape: { PORT: {} } },
      );

      const configService = await createConfigService({
        ignoreEnvFile: true,
        skipProcessEnv: true,
        validationSchema: zodPortSchema,
      });

      expect(configService.get("CLOUD_SECRET_KEY")).toBeUndefined();
      expect(configService.get("CLOUD_SECRET_KEY", "none")).toBe("none");
      expect(configService.get("PORT")).toBe(3000);
    });

    it('should not serve undeclared process.env variables with "skipProcessEnv" (joi)', async () => {
      process.env.CLOUD_SECRET_KEY = "hunter2";
      process.env.PORT = "3000";
      const joiPortSchema = Object.assign(
        createStandardSchema<Record<string, unknown>>((raw) => {
          const rec = { ...((raw ?? {}) as Record<string, unknown>) };
          return { value: { ...rec, PORT: Number(rec.PORT) } };
        }, "joi"),
        { describe: () => ({ keys: { PORT: {} } }) },
      );

      const configService = await createConfigService({
        ignoreEnvFile: true,
        skipProcessEnv: true,
        validationSchema: joiPortSchema,
      });

      expect(configService.get("CLOUD_SECRET_KEY")).toBeUndefined();
      expect(configService.get("CLOUD_SECRET_KEY", "none")).toBe("none");
      expect(configService.get("PORT")).toBe(3000);
    });

    it('should keep the values converted by each validated "forRoot"', async () => {
      const appEnvFilePath = writeEnvFile(".env.app", [
        "PORT=4000",
        "DISABLE_AUTH=false",
      ]);
      const mailEnvFilePath = writeEnvFile(".env.mail", ["SMTP_PORT=25"]);

      const appSchema = createStandardSchema<Record<string, unknown>>((raw) => {
        const rec = (raw ?? {}) as Record<string, unknown>;
        return {
          value: {
            PORT: Number(rec.PORT),
            DISABLE_AUTH: rec.DISABLE_AUTH === "true",
          },
        };
      }, "zod");

      const mailSchema = createStandardSchema<Record<string, unknown>>(
        (raw) => {
          const rec = (raw ?? {}) as Record<string, unknown>;
          return {
            value: {
              SMTP_PORT: Number(rec.SMTP_PORT),
            },
          };
        },
        "zod",
      );

      const configService = await createConfigService(
        {
          envFilePath: appEnvFilePath,
          validationSchema: appSchema,
        },
        {
          envFilePath: mailEnvFilePath,
          validationSchema: mailSchema,
        },
      );

      expect(configService.get("PORT")).toBe(4000);
      expect(configService.get("DISABLE_AUTH")).toBe(false);
      expect(configService.get("SMTP_PORT")).toBe(25);
    });

    it("should prefer predefined variables when they are not validated", async () => {
      process.env.AUTH_ISSUER_URL = "https://login.corp.example";
      const envFilePath = writeEnvFile(".env", [
        "AUTH_ISSUER_URL=https://dev.example",
        "LOG_LEVEL=debug",
      ]);
      const schema = createStandardSchema<Record<string, unknown>>((raw) => {
        const rec = (raw ?? {}) as Record<string, unknown>;
        return {
          value: {
            AUTH_ISSUER_URL: String(rec.AUTH_ISSUER_URL),
            LOG_LEVEL: String(rec.LOG_LEVEL),
          },
        };
      }, "zod");

      const configService = await createConfigService({
        envFilePath,
        validatePredefined: false,
        validationSchema: schema,
      });

      expect(configService.get("AUTH_ISSUER_URL")).toBe(
        "https://login.corp.example",
      );
      expect(configService.get("LOG_LEVEL")).toBe("debug");
    });

    it('should serve the validated env file value with "skipProcessEnv" when predefined variables are not validated', async () => {
      process.env.NODE_ENV = "production";
      const envFilePath = writeEnvFile(".env", ["NODE_ENV=development"]);
      const schema = createStandardSchema<Record<string, unknown>>((raw) => {
        const rec = (raw ?? {}) as Record<string, unknown>;
        return { value: { NODE_ENV: String(rec.NODE_ENV) } };
      }, "zod");

      const configService = await createConfigService({
        envFilePath,
        skipProcessEnv: true,
        validatePredefined: false,
        validationSchema: schema,
      });

      expect(configService.get("NODE_ENV")).toBe("development");
    });

    it('should serve the members of a class instance returned by "validate"', async () => {
      process.env.PORT = "3000";
      class EnvironmentVariables {
        readonly #port: number;
        constructor(config: Record<string, any>) {
          this.#port = Number(config.PORT);
        }
        get PORT() {
          return this.#port;
        }
      }
      const configService = await createConfigService({
        ignoreEnvFile: true,
        validate: (config) => new EnvironmentVariables(config),
      });

      expect(configService.get("PORT")).toBe(3000);
    });

    it("should serve the converted value of a predefined variable that equals the env file value", async () => {
      process.env.PORT = "3000";
      const envFilePath = writeEnvFile(".env", ["PORT=3000"]);
      const schema = createStandardSchema<Record<string, unknown>>((raw) => {
        const rec = (raw ?? {}) as Record<string, unknown>;
        return { value: { PORT: Number(rec.PORT) } };
      }, "zod");

      const configService = await createConfigService({
        envFilePath,
        validatePredefined: false,
        validationSchema: schema,
      });

      expect(configService.get("PORT")).toBe(3000);
    });

    describe('async "validate" function', () => {
      it("should serve the variables it resolves with", async () => {
        process.env.PORT = "3000";
        const configService = await createConfigService({
          ignoreEnvFile: true,
          validate: async (config) => ({
            ...config,
            PORT: Number(config.PORT),
          }),
        });

        expect(configService.get("PORT")).toBe(3000);
      });

      it("should prevent the application from bootstrapping when it rejects", async () => {
        process.env.PORT = "abc";

        await expect(
          Test.createTestingModule({
            imports: [
              ConfigModule.forRoot({
                ignoreEnvFile: true,
                validate: async () => {
                  throw new Error("PORT must be a number");
                },
              }),
            ],
          }).compile(),
        ).rejects.toThrow("PORT must be a number");
      });
    });

    describe("validation error", () => {
      const apiKey = "deadbeefdeadbeefdeadbeefdeadbee";

      it("should not contain the value Joi rejects", async () => {
        process.env.API_KEY = apiKey;

        const joiPatternSchema = createStandardSchema<Record<string, unknown>>(
          (raw) => {
            const rec = (raw ?? {}) as Record<string, unknown>;
            const val = String(rec.API_KEY ?? "");
            if (!/^[0-9a-f]{32}$/.test(val)) {
              return {
                issues: [
                  {
                    message: `"API_KEY" with value "${val}" fails to match the required pattern: /^[0-9a-f]{32}$/`,
                    path: ["API_KEY"],
                  },
                ],
              };
            }
            return { value: rec };
          },
          "joi",
        );

        const result = Test.createTestingModule({
          imports: [
            ConfigModule.forRoot({
              ignoreEnvFile: true,
              validationSchema: joiPatternSchema,
            }),
          ],
        }).compile();

        await expect(result).rejects.toThrow(
          'API_KEY: "API_KEY" fails to match the required pattern',
        );
        await expect(result).rejects.not.toThrow(apiKey);
      });

      it("should not contain the rejected value quoted by any schema library", async () => {
        process.env.API_KEY = apiKey;
        const validationSchema: StandardSchemaV1<
          Record<string, unknown>,
          any
        > = {
          "~standard": {
            version: 1,
            vendor: "custom",
            validate: (value) => ({
              issues: [
                {
                  message: `Invalid key "${(value as any).API_KEY}"`,
                  path: ["API_KEY"],
                },
              ],
            }),
          },
        };

        await expect(
          Test.createTestingModule({
            imports: [
              ConfigModule.forRoot({ ignoreEnvFile: true, validationSchema }),
            ],
          }).compile(),
        ).rejects.toThrow(
          "Config validation error: API_KEY: Invalid key [redacted]",
        );
      });
    });
  },
);
