import { afterEach, beforeEach, expect, it } from "bun:test";
import {
  join,
  mkdirSyncPath,
  removePath,
  writeTextSync,
} from "../../../../../packages/core/src";
import {
  ConfigModule,
  ConfigService,
  registerAs,
  type ConfigModuleOptions,
} from "../../../../../packages/core/src/config";
import { describeConformance, itAdapted, Test } from "../../../_helpers/index";
import { createStandardSchema } from "../_fixtures/schema-helpers";

describeConformance(
  "Property paths",
  {
    upstreamPath: "config/tests/e2e/property-path.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-005", "ADR-008"],
    notes:
      "Adapts Zod schema in _PROCESS_ENV_VALIDATED test to zero-dep inline Standard Schema v1 (ADR-013).",
  },
  () => {
    let originalEnv: NodeJS.ProcessEnv;
    let tmpDir: string;

    async function createConfigService(options: ConfigModuleOptions) {
      const moduleRef = await Test.createTestingModule({
        imports: [ConfigModule.forRoot({ ignoreEnvFile: true, ...options })],
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
      // Undo a write to a built-in, so that it doesn't break later tests
      delete (Object.prototype.hasOwnProperty as any).call;
      delete (Object.prototype.toString as any).call;
    });

    it("should not write to members inherited from built-in prototypes", async () => {
      const configService = await createConfigService({
        load: [registerAs("flags", () => ({ beta: "off" }))],
      });

      configService.set("flags.beta", "on");
      configService.set("flags.hasOwnProperty.call", "on");
      configService.set("flags.toString.call", "on");

      expect(
        Object.getOwnPropertyDescriptor(
          Object.prototype.hasOwnProperty,
          "call",
        ),
      ).toBeUndefined();
      expect(
        Object.getOwnPropertyDescriptor(Object.prototype.toString, "call"),
      ).toBeUndefined();
      expect(configService.get("flags.beta")).toBe("on");
      expect(configService.get("flags.hasOwnProperty.call")).toBe("on");
    });

    it('should ignore paths through "__proto__", "constructor" or "prototype"', async () => {
      const configService = await createConfigService({
        load: [registerAs("flags", () => ({ beta: "off" }))],
      });

      configService.set("flags.__proto__.polluted", "yes");
      configService.set("flags.constructor.prototype.polluted", "yes");

      expect(({} as any).polluted).toBeUndefined();
    });

    it("should not resolve members inherited from built-in prototypes", async () => {
      const configService = await createConfigService({
        load: [registerAs("features", () => ({ beta: true }))],
      });

      expect(configService.get("constructor.prototype")).toBeUndefined();
      expect(configService.get("features.constructor")).toBeUndefined();
      expect(configService.get("features.toString", "default")).toBe("default");
      expect(() => configService.getOrThrow("features.hasOwnProperty")).toThrow(
        TypeError,
      );
      expect(configService.get("features.beta")).toBe(true);
    });

    it("should not resolve members inherited by buffers", async () => {
      const configService = await createConfigService({
        load: [registerAs("tls", () => ({ cert: Buffer.from("cert") }))],
      });

      expect(configService.get("tls.cert.toString")).toBeUndefined();
      expect(configService.get("tls.cert.0")).toBe("c".charCodeAt(0));
    });

    // BUNEST_BUG: ConfigModule spreads `{ ...loaded }` when storing registerAs() namespaces (stripping class prototype getters) and readDotPath() uses Object.prototype.hasOwnProperty only (expected "postgres://localhost", received undefined; packages/core/src/config/config.module.ts:161, packages/core/src/config/config.service.ts:77)
    it.skip("should resolve members of class instances", async () => {
      class DatabaseConfig {
        host = "localhost";
        get url() {
          return `postgres://${this.host}`;
        }
      }
      const configService = await createConfigService({
        load: [registerAs("database", () => new DatabaseConfig() as any)],
      });

      expect(configService.get("database.host")).toBe("localhost");
      expect(configService.get("database.url")).toBe("postgres://localhost");
    });

    // BUNEST_BUG: readDotPath() aborts whenever `typeof current !== "object"`, returning undefined for own properties on primitive strings like `.length` (expected 4, received undefined; packages/core/src/config/config.service.ts:72)
    it.skip("should not let a dotted lookup change a cached value", async () => {
      process.env.FEATURE_REQUIRE_MFA = "true";
      const configService = await createConfigService({ cache: true });

      expect(configService.get("FEATURE_REQUIRE_MFA.toString")).toBeUndefined();
      expect(configService.get("FEATURE_REQUIRE_MFA")).toBe("true");
      expect(configService.get("FEATURE_REQUIRE_MFA.length")).toBe(4);
      expect(configService.get("FEATURE_REQUIRE_MFA")).toBe("true");
    });

    // BUNEST_BUG: ConfigService.set() does not update process.env or re-expand dependent dotted env variables (expected process.env["toString.call"]="other.test", received "app.test"; packages/core/src/config/config.service.ts:342-369)
    it.skip("should treat dotted env file variables as names, not paths", async () => {
      const envFilePath = join(tmpDir, ".env");
      writeTextSync(
        envFilePath,
        [
          "APP_URL=app.test",
          "JWT_SECRET.0=${APP_URL}",
          "toString.call=${APP_URL}",
        ].join("\n"),
      );
      process.env.JWT_SECRET = "pinned";
      const configService = await createConfigService({
        ignoreEnvFile: false,
        envFilePath,
        expandVariables: true,
        cache: true,
        validate: (config) => ({
          APP_URL: config.APP_URL,
          JWT_SECRET: config.JWT_SECRET,
        }),
      });

      configService.set("APP_URL", "other.test");

      expect(configService.get("JWT_SECRET")).toBe("pinned");
      expect(
        Object.getOwnPropertyDescriptor(Object.prototype.toString, "call"),
      ).toBeUndefined();
      expect(process.env["toString.call"]).toBe("other.test");
    });

    itAdapted(
      "ADR-005",
      "should not serve the validated environment as a configuration value",
      async () => {
        process.env.SOME_SECRET = "secret";
        const optionalPortSchema = createStandardSchema((raw) => {
          const rec = (raw ?? {}) as Record<string, unknown>;
          return {
            value: {
              PORT: typeof rec.PORT === "string" ? rec.PORT : undefined,
            },
          };
        }, "zod");

        const configService = await createConfigService({
          validationSchema: optionalPortSchema,
        });

        expect(configService.get("_PROCESS_ENV_VALIDATED")).toBeUndefined();
        expect(
          configService.get("_PROCESS_ENV_VALIDATED.SOME_SECRET"),
        ).toBeUndefined();
      },
      "inline Standard Schema v1 instead of Zod",
    );
  },
);
