import "reflect-metadata";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Inject, Injectable, Module } from "@bunest/common";
import { BunestFactory } from "@bunest/core";
import { Test } from "@bunest/testing";
import { IsBoolean, IsIn, IsInt, IsString, Max, Min } from "class-validator";
import {
  ConfigModule,
  ConfigService,
  ConfigValidationError,
  createSecretRedactor,
  registerAs,
} from "../src/index";

describe("ConfigModule, ConfigService, Validation, Namespaces & Redaction", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  function writeTempEnv(filename: string, content: string): string {
    const dir = mkdtempSync(join(tmpdir(), "bunest-config-mod-"));
    tempDirs.push(dir);
    const full = join(dir, filename);
    writeFileSync(full, content, "utf8");
    return full;
  }

  test("loads .env files, supports dot-path access, defaults, getOrThrow, and blocks prototype keys", async () => {
    const envPath = writeTempEnv(
      ".env",
      "APP_HOST=127.0.0.1\nAPP_PORT=8080\nGREETING=hello_${APP_HOST}\n",
    );

    const dbConfig = registerAs("database", () => ({
      host: "db.local",
      port: 5432,
      pool: { min: 2, max: 10 },
    }));

    @Module({
      imports: [
        ConfigModule.forRoot({
          envFilePath: envPath,
          ignoreEnvVars: true,
          expandVariables: true,
          load: [dbConfig],
        }),
      ],
    })
    class AppModule {}

    const ctx = await BunestFactory.createApplicationContext(AppModule, {
      logger: false,
    });
    try {
      const config = ctx.get(ConfigService);

      expect(config.get<string>("APP_HOST")).toBe("127.0.0.1");
      expect(config.get<string>("GREETING")).toBe("hello_127.0.0.1");
      expect(config.get<string>("MISSING", "fallback")).toBe("fallback");
      expect(config.get<string>("database.host")).toBe("db.local");
      expect(config.get<number>("database.pool.max")).toBe(10);
      expect(config.has("database.port")).toBe(true);
      expect(config.has("database.missing")).toBe(false);
      expect(config.getOrThrow<number>("database.port")).toBe(5432);
      expect(() => config.getOrThrow("DOES_NOT_EXIST")).toThrow(
        /DOES_NOT_EXIST/,
      );

      // Prototype traversal safety
      expect(config.get("__proto__")).toBeUndefined();
      expect(config.get("database.__proto__")).toBeUndefined();
      expect(config.get("database.constructor")).toBeUndefined();
    } finally {
      await ctx.close();
    }
  });

  test("supports typed registerAs() namespaces in forRoot() and forFeature() via @Inject(config.KEY)", async () => {
    const dbConfig = registerAs("database", () => ({
      host: "pg.internal",
      port: 5432,
    }));

    const cacheConfig = registerAs("cache", async () => ({
      ttlSeconds: 300,
      prefix: "bunest:",
    }));

    @Injectable()
    class StorageService {
      constructor(
        @Inject(dbConfig.KEY)
        public readonly db: { host: string; port: number },
        @Inject(cacheConfig.KEY)
        public readonly cache: { ttlSeconds: number; prefix: string },
        public readonly configService: ConfigService,
      ) {}
    }

    @Module({
      imports: [ConfigModule.forFeature(cacheConfig)],
      providers: [StorageService],
      exports: [StorageService],
    })
    class FeatureModule {}

    @Module({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          ignoreEnvVars: true,
          load: [dbConfig],
        }),
        FeatureModule,
      ],
    })
    class RootModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [RootModule],
    }).compile();

    try {
      const storage = moduleRef.get(StorageService);
      expect(storage.db).toEqual({ host: "pg.internal", port: 5432 });
      expect(storage.cache).toEqual({ ttlSeconds: 300, prefix: "bunest:" });
      expect(storage.configService.get<string>("database.host")).toBe(
        "pg.internal",
      );
      expect(storage.configService.get<number>("cache.ttlSeconds")).toBe(300);
    } finally {
      await moduleRef.close();
    }
  });

  test("validates configuration via custom validate() callback and fails fast at bootstrap", async () => {
    @Module({
      imports: [
        ConfigModule.forRoot({
          ignoreEnvFile: true,
          envSource: { PORT: "not-a-number" },
          validate: (raw) => {
            const port = Number(raw.PORT);
            if (!Number.isInteger(port) || port <= 0) {
              throw new Error("PORT must be a positive integer");
            }
            return { ...raw, PORT: port };
          },
        }),
      ],
    })
    class InvalidCustomModule {}

    await expect(
      BunestFactory.createApplicationContext(InvalidCustomModule, {
        logger: false,
      }),
    ).rejects.toThrow(ConfigValidationError);

    @Module({
      imports: [
        ConfigModule.forRoot({
          ignoreEnvFile: true,
          envSource: { PORT: "4567" },
          validate: (raw) => ({ ...raw, PORT: Number(raw.PORT) }),
        }),
      ],
    })
    class ValidCustomModule {}

    const ctx = await BunestFactory.createApplicationContext(ValidCustomModule, {
      logger: false,
    });
    try {
      expect(ctx.get(ConfigService).get<number>("PORT")).toBe(4567);
    } finally {
      await ctx.close();
    }
  });

  test("validates configuration via DTO class (class-validator + class-transformer) and fails fast with diagnostics", async () => {
    class AppEnvDto {
      @IsIn(["development", "test", "production"])
      NODE_ENV!: string;

      @IsInt()
      @Min(1)
      @Max(65535)
      PORT!: number;

      @IsString()
      APP_SECRET!: string;
    }

    // Invalid DTO -> fails fast at bootstrap with ConfigValidationError + field details
    @Module({
      imports: [
        ConfigModule.forRoot({
          ignoreEnvFile: true,
          envSource: {
            NODE_ENV: "invalid_env",
            PORT: "99999",
          },
          validate: AppEnvDto,
        }),
      ],
    })
    class BadDtoModule {}

    let caught: unknown;
    try {
      await BunestFactory.createApplicationContext(BadDtoModule, {
        logger: false,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfigValidationError);
    const validationErr = caught as ConfigValidationError;
    expect(validationErr.message).toContain("AppEnvDto");
    expect(validationErr.message).toContain("NODE_ENV");
    expect(validationErr.message).toContain("PORT");
    expect(validationErr.message).toContain("APP_SECRET");
    expect(validationErr.details?.length).toBeGreaterThanOrEqual(3);

    // Valid DTO -> coerces PORT string -> integer while preserving extra env keys
    @Module({
      imports: [
        ConfigModule.forRoot({
          ignoreEnvFile: true,
          envSource: {
            NODE_ENV: "production",
            PORT: "3000",
            APP_SECRET: "super-secret-key",
            EXTRA_OS_VAR: "kept",
          },
          validationClass: AppEnvDto,
        }),
      ],
    })
    class GoodDtoModule {}

    const ctx = await BunestFactory.createApplicationContext(GoodDtoModule, {
      logger: false,
    });
    try {
      const cfg = ctx.get(ConfigService);
      expect(cfg.get("NODE_ENV")).toBe("production");
      expect(cfg.get<number>("PORT")).toBe(3000);
      expect(cfg.get("EXTRA_OS_VAR")).toBe("kept");
    } finally {
      await ctx.close();
    }
  });

  test("strictly coerces boolean env strings ('false'/'0'/'no'/'off' -> false, rejects invalid) and merges anonymous forFeature primitives/arrays", async () => {
    class BoolEnvDto {
      @IsBoolean()
      ENABLE_CACHE!: boolean;

      @IsBoolean()
      DEBUG!: boolean;

      @IsBoolean()
      FEATURE_NO!: boolean;

      @IsBoolean()
      FEATURE_OFF!: boolean;

      @IsBoolean()
      FEATURE_YES!: boolean;

      @IsBoolean()
      FEATURE_ON!: boolean;
    }

    @Module({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          envSource: {
            ENABLE_CACHE: "false",
            DEBUG: "0",
            FEATURE_NO: "no",
            FEATURE_OFF: "off",
            FEATURE_YES: "yes",
            FEATURE_ON: "on",
          },
          validate: BoolEnvDto,
        }),
        ConfigModule.forFeature(() => ({
          TOP_FLAG: true,
          ALLOWED_ORIGINS: ["https://a.test", "https://b.test"],
          nested: { region: "us-east" },
        })),
      ],
    })
    class BoolAndFeatureModule {}

    const ctx = await BunestFactory.createApplicationContext(
      BoolAndFeatureModule,
      { logger: false },
    );
    try {
      const cfg = ctx.get(ConfigService);
      expect(cfg.get<boolean>("ENABLE_CACHE")).toBe(false);
      expect(cfg.get<boolean>("DEBUG")).toBe(false);
      expect(cfg.get<boolean>("FEATURE_NO")).toBe(false);
      expect(cfg.get<boolean>("FEATURE_OFF")).toBe(false);
      expect(cfg.get<boolean>("FEATURE_YES")).toBe(true);
      expect(cfg.get<boolean>("FEATURE_ON")).toBe(true);
      expect(cfg.get<boolean>("TOP_FLAG")).toBe(true);
      expect(cfg.get<string[]>("ALLOWED_ORIGINS")).toEqual([
        "https://a.test",
        "https://b.test",
      ]);
      expect(cfg.get<string>("nested.region")).toBe("us-east");
    } finally {
      await ctx.close();
    }
  });

  test("rejects invalid boolean env strings ('maybe') instead of coercing to true", async () => {
    class StrictBoolEnvDto {
      @IsBoolean()
      ENABLE_CACHE!: boolean;
    }

    @Module({
      imports: [
        ConfigModule.forRoot({
          ignoreEnvFile: true,
          envSource: { ENABLE_CACHE: "maybe" },
          validate: StrictBoolEnvDto,
        }),
      ],
    })
    class InvalidBoolModule {}

    await expect(
      BunestFactory.createApplicationContext(InvalidBoolModule, {
        logger: false,
      }),
    ).rejects.toThrow(ConfigValidationError);
  });

  test("redacts default and custom secret keys in getRedactedSnapshot() and createSecretRedactor() without mutating config", async () => {
    const dbConfig = registerAs("database", () => ({
      host: "db.prod",
      password: "db-secret-password",
      customPin: "9999",
    }));

    @Module({
      imports: [
        ConfigModule.forRoot({
          ignoreEnvFile: true,
          envSource: {
            PORT: "3000",
            JWT_SECRET: "my-jwt-secret",
            DATABASE_URL: "postgres://user:pass@host/db",
            STRIPE_WEBHOOK_SIGNING_KEY: "whsec_123",
            CUSTOM_PRIVATE_CODE: "top-secret",
          },
          load: [dbConfig],
          secretKeys: ["customPin", "CUSTOM_PRIVATE_CODE"],
          redactionMask: "***MASKED***",
        }),
      ],
    })
    class SecretModule {}

    const ctx = await BunestFactory.createApplicationContext(SecretModule, {
      logger: false,
    });
    try {
      const cfg = ctx.get(ConfigService);
      const snapshot = cfg.getRedactedSnapshot();

      expect(snapshot.PORT).toBe("3000");
      expect(snapshot.JWT_SECRET).toBe("***MASKED***");
      expect(snapshot.DATABASE_URL).toBe("***MASKED***");
      expect(snapshot.STRIPE_WEBHOOK_SIGNING_KEY).toBe("***MASKED***");
      expect(snapshot.CUSTOM_PRIVATE_CODE).toBe("***MASKED***");
      expect(snapshot.database).toEqual({
        host: "db.prod",
        password: "***MASKED***",
        customPin: "***MASKED***",
      });

      // Underlying stored values remain unmutated
      expect(cfg.get("JWT_SECRET")).toBe("my-jwt-secret");
      expect(cfg.get("database.password")).toBe("db-secret-password");

      // Standalone secret redactor
      const redactor = createSecretRedactor({ secretKeys: ["internalCode"] });
      expect(
        redactor({
          user: "alice",
          apiKey: "sk-123",
          nested: { internalCode: "xyz", ok: true },
        }),
      ).toEqual({
        user: "alice",
        apiKey: "[REDACTED]",
        nested: { internalCode: "[REDACTED]", ok: true },
      });
    } finally {
      await ctx.close();
    }
  });
});
