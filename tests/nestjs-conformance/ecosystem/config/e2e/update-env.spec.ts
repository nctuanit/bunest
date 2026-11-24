import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { join, type BunestApplication } from "../../../../../packages/core/src";
import {
  ConfigModule,
  ConfigService,
  type ConfigModuleOptions,
} from "../../../../../packages/core/src/config";
import {
  describeConformance,
  Test,
  type TestingModule,
} from "../../../_helpers/index";
import { AppModule, fixturesDir } from "../_fixtures/app.module";
import { createStandardSchema } from "../_fixtures/schema-helpers";

const chainEnvFilePaths = [
  join(fixturesDir, ".env.chain.local"),
  join(fixturesDir, ".env.chain"),
];

const urlSchema = createStandardSchema<Record<string, unknown>>((raw) => {
  const rec = (raw ?? {}) as Record<string, unknown>;
  if (rec.URL !== undefined && typeof rec.URL !== "string") {
    return {
      issues: [{ message: '"URL" must be a string', path: ["URL"] }],
    };
  }
  return { value: { ...rec } };
}, "joi");

const baseCopyNumberSchema = createStandardSchema<Record<string, unknown>>(
  (raw) => {
    const rec = (raw ?? {}) as Record<string, unknown>;
    const out: Record<string, unknown> = { ...rec };
    if (rec.BASE !== undefined) {
      out.BASE = Number(rec.BASE);
    }
    if (rec.COPY !== undefined) {
      out.COPY = Number(rec.COPY);
    }
    return { value: out };
  },
  "joi",
);

const variants: { name: string; options: ConfigModuleOptions }[] = [
  { name: "cache", options: { cache: true } },
  { name: "validate", options: { validate: (config) => config } },
  { name: "validationSchema", options: { validationSchema: urlSchema } },
];

describeConformance(
  "Setting environment variables",
  {
    upstreamPath: "config/tests/e2e/update-env.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-005", "ADR-008"],
    notes:
      "Adapts Joi schemas to zero-dep inline Standard Schema v1 objects (ADR-013).",
  },
  () => {
    describe("basic set() and interpolation", () => {
      let app: BunestApplication;
      let moduleRef: TestingModule;
      let originalEnv: NodeJS.ProcessEnv;

      beforeEach(async () => {
        originalEnv = { ...process.env };

        moduleRef = await Test.createTestingModule({
          imports: [AppModule.withExpandedEnvVars()],
        }).compile();

        app = moduleRef.createNestApplication({ logger: false });
        await app.init();
      });

      it("should return updated value after set", async () => {
        const prevUrl = moduleRef.get(ConfigService).get("URL");

        moduleRef.get(ConfigService).set("URL", "yourapp.test");

        const updatedUrl = moduleRef.get(ConfigService).get("URL");

        expect(prevUrl).toEqual("myapp.test");
        expect(updatedUrl).toEqual("yourapp.test");
      });

      it("should return value after set", async () => {
        const undefinedEnv = moduleRef.get(ConfigService).get("UNDEFINED_ENV");

        moduleRef.get(ConfigService).set("UNDEFINED_ENV", "defined");

        const definedEnv = moduleRef.get(ConfigService).get("UNDEFINED_ENV");

        expect(undefinedEnv).toEqual(undefined);
        expect(definedEnv).toEqual("defined");
      });

      it("should return updated value with interpolation after set", async () => {
        const prevUrl = moduleRef.get(ConfigService).get("URL");
        const prevEmail = moduleRef.get(ConfigService).get("EMAIL");
        const prevSupportUrl = moduleRef.get(ConfigService).get("SUPPORT_URL");
        const prevUrlPort = moduleRef.get(ConfigService).get("URL_PORT");
        const prevDeep = moduleRef.get(ConfigService).get("DEEP");
        const prevFallback = moduleRef.get(ConfigService).get("FALLBACK");

        moduleRef.get(ConfigService).set("URL", "yourapp.test");

        const updatedUrl = moduleRef.get(ConfigService).get("URL");
        const updatedEmail = moduleRef.get(ConfigService).get("EMAIL");
        const updatedSupportUrl = moduleRef
          .get(ConfigService)
          .get("SUPPORT_URL");
        const updatedUrlPort = moduleRef.get(ConfigService).get("URL_PORT");
        const updatedDeep = moduleRef.get(ConfigService).get("DEEP");
        const updatedFallback = moduleRef.get(ConfigService).get("FALLBACK");

        expect(prevUrl).toEqual("myapp.test");
        expect(prevEmail).toEqual("support@myapp.test");
        expect(prevSupportUrl).toEqual("https://myapp.test/help");
        expect(prevUrlPort).toEqual("myapp.test:8080");
        expect(prevDeep).toEqual("host=myapp.test:8080/path");
        expect(prevFallback).toEqual("myapp.test");

        expect(updatedUrl).toEqual("yourapp.test");
        expect(updatedEmail).toEqual("support@yourapp.test");
        expect(updatedSupportUrl).toEqual("https://yourapp.test/help");
        expect(updatedUrlPort).toEqual("yourapp.test:8080");
        expect(updatedDeep).toEqual("host=yourapp.test:8080/path");
        expect(updatedFallback).toEqual("yourapp.test");
      });

      it("should return updated process.env property after set", async () => {
        await ConfigModule.envVariablesLoaded;

        moduleRef.get(ConfigService).set("URL", "yourapp.test");

        const envVars = app.get(AppModule).getEnvVariables();

        expect(envVars.URL).toEqual("yourapp.test");
        expect(envVars.EMAIL).toEqual("support@yourapp.test");
        expect(envVars.SUPPORT_URL).toEqual("https://yourapp.test/help");
        expect(envVars.URL_PORT).toEqual("yourapp.test:8080");
        expect(envVars.DEEP).toEqual("host=yourapp.test:8080/path");
        expect(envVars.FALLBACK).toEqual("yourapp.test");
      });

      it("should expand all references of dependent variable after set", async () => {
        moduleRef.get(ConfigService).set("URL", "yourapp.test");
        expect(moduleRef.get(ConfigService).get("API_URL")).toEqual(
          "http://yourapp.test:3000/api",
        );

        moduleRef.get(ConfigService).set("API_PORT", "4000");
        expect(moduleRef.get(ConfigService).get("API_URL")).toEqual(
          "http://yourapp.test:4000/api",
        );
      });

      it("should safely handle special replacement patterns in new value", async () => {
        moduleRef.get(ConfigService).set("URL", "pa$$word");
        expect(moduleRef.get(ConfigService).get("EMAIL")).toEqual(
          "support@pa$$word",
        );

        moduleRef.get(ConfigService).set("URL", "x$&y");
        expect(moduleRef.get(ConfigService).get("EMAIL")).toEqual(
          "support@x$&y",
        );
      });

      afterEach(async () => {
        process.env = originalEnv;
        await app.close();
      });
    });

    describe("Setting environment variables with module options", () => {
      let app: BunestApplication | undefined;
      let originalEnv: NodeJS.ProcessEnv;

      const createConfigService = async (options: ConfigModuleOptions) => {
        const moduleRef = await Test.createTestingModule({
          imports: [AppModule.withExpandedEnvVars(options)],
        }).compile();

        app = moduleRef.createNestApplication({ logger: false });
        await app.init();
        return app.get(ConfigService);
      };

      beforeEach(() => {
        originalEnv = { ...process.env };
      });

      describe.each(variants)("$name", ({ options }) => {
        it("should return updated value with interpolation after set", async () => {
          const configService = await createConfigService(options);
          expect(configService.get("EMAIL")).toEqual("support@myapp.test");
          expect(configService.get("URL_PORT")).toEqual("myapp.test:8080");
          expect(configService.get("DEEP")).toEqual(
            "host=myapp.test:8080/path",
          );

          configService.set("URL", "yourapp.test");

          expect(configService.get("EMAIL")).toEqual("support@yourapp.test");
          expect(configService.get("URL_PORT")).toEqual("yourapp.test:8080");
          expect(configService.get("DEEP")).toEqual(
            "host=yourapp.test:8080/path",
          );
        });
      });

      it("should not overwrite variable that was set before env file was loaded", async () => {
        process.env.EMAIL = "shell@myapp.test";
        process.env.URL_PORT = "${URL}:8080";
        process.env.SUPPORT_URL = "";
        const configService = await createConfigService({});

        configService.set("URL", "yourapp.test");

        expect(configService.get("EMAIL")).toEqual("shell@myapp.test");
        expect(configService.get("URL_PORT")).toEqual("yourapp.test:8080");
        expect(configService.get("SUPPORT_URL")).toEqual(
          "https://yourapp.test/help",
        );
      });

      it("should not expand variables on set when expandVariables is disabled", async () => {
        const configService = await createConfigService({
          expandVariables: false,
        });
        expect(configService.get("EMAIL")).toEqual("support@${URL}");

        configService.set("URL", "yourapp.test");

        expect(configService.get("EMAIL")).toEqual("support@${URL}");
      });

      it("should not read env file on set when ignoreEnvFile is enabled", async () => {
        const configService = await createConfigService({
          ignoreEnvFile: true,
        });

        configService.set("URL", "yourapp.test");

        expect(configService.get("EMAIL")).toBeUndefined();
      });

      it("should not throw on set when validate returns a frozen object", async () => {
        const configService = await createConfigService({
          validate: (config) => Object.freeze({ ...config }),
        });

        expect(() => configService.set("URL", "yourapp.test")).not.toThrow();
      });

      it("should update chain of variables in order of the first env file", async () => {
        const configService = await createConfigService({
          envFilePath: chainEnvFilePaths,
        });
        expect(configService.get("COPY_OF_COPY")).toEqual("1");
        expect(configService.get("SUFFIXED")).toEqual("1-suffix");

        configService.set("BASE", "2");

        expect(configService.get("COPY")).toEqual("2");
        expect(configService.get("COPY_OF_COPY")).toEqual("2");
        expect(configService.get("SUFFIXED")).toEqual("2-suffix");
      });

      it("should update variables loaded by an earlier bootstrap in the same process", async () => {
        await createConfigService({});
        await app?.close();
        const configService = await createConfigService({});

        configService.set("URL", "yourapp.test");

        expect(configService.get("EMAIL")).toEqual("support@yourapp.test");
        expect(configService.get("DEEP")).toEqual(
          "host=yourapp.test:8080/path",
        );
      });

      it("should keep type converted by validation schema of dependent variable", async () => {
        const configService = await createConfigService({
          envFilePath: chainEnvFilePaths,
          validationSchema: baseCopyNumberSchema,
        });
        expect(configService.get("COPY")).toEqual(1);

        configService.set("BASE", 2);

        // not validated again, so converted value is not replaced by a string
        expect(configService.get("COPY")).toEqual(1);
        expect(process.env.COPY).toEqual("2");
        expect(configService.get("COPY_OF_COPY")).toEqual("2");
      });

      afterEach(async () => {
        process.env = originalEnv;
        await app?.close();
        app = undefined;
      });
    });
  },
);
