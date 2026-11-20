import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { Module, type StandardSchemaV1 } from "@bunest/common";
import { BunestFactory } from "@bunest/core";
import { ConfigModule, ConfigService, ConfigValidationError } from "../src";

const envStandardSchema: StandardSchemaV1<
  Record<string, unknown>,
  { PORT: number; APP_ENV: "dev" | "prod" }
> = {
  "~standard": {
    version: 1,
    vendor: "custom-env-schema",
    validate(raw: unknown) {
      const rec = (raw ?? {}) as Record<string, unknown>;
      const issues: Array<{ message: string; path: string[] }> = [];
      const port = Number(rec.PORT);
      if (!Number.isInteger(port) || port <= 0) {
        issues.push({ message: "PORT must be a positive integer", path: ["PORT"] });
      }
      const env = rec.APP_ENV;
      if (env !== "dev" && env !== "prod") {
        issues.push({ message: "APP_ENV must be 'dev' or 'prod'", path: ["APP_ENV"] });
      }
      if (issues.length > 0) {
        return { issues };
      }
      return { value: { PORT: port, APP_ENV: env as "dev" | "prod" } };
    },
  },
};

describe("@bunest/config Standard Schema v1 (validationSchema)", () => {
  it("validates and transforms env config via Standard Schema v1", async () => {
    @Module({
      imports: [
        ConfigModule.forRoot({
          ignoreEnvFile: true,
          envSource: { PORT: "8080", APP_ENV: "prod", EXTRA: "kept" },
          validationSchema: envStandardSchema,
        }),
      ],
    })
    class ValidAppModule {}

    const ctx = await BunestFactory.createApplicationContext(ValidAppModule, {
      logger: false,
    });
    try {
      const cfg = ctx.get(ConfigService);
      expect(cfg.get<number>("PORT")).toBe(8080);
      expect(cfg.get<string>("APP_ENV")).toBe("prod");
      expect(cfg.get<string>("EXTRA")).toBe("kept");
    } finally {
      await ctx.close();
    }
  });

  it("throws ConfigValidationError with normalized details on Standard Schema failure", async () => {
    @Module({
      imports: [
        ConfigModule.forRoot({
          ignoreEnvFile: true,
          envSource: { PORT: "abc", APP_ENV: "staging" },
          validationSchema: envStandardSchema,
        }),
      ],
    })
    class InvalidAppModule {}

    let caught: unknown;
    try {
      await BunestFactory.createApplicationContext(InvalidAppModule, {
        logger: false,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ConfigValidationError);
    const err = caught as ConfigValidationError;
    expect(err.message).toContain("PORT");
    expect(err.message).toContain("APP_ENV");
    expect(err.details?.map((d) => d.field)).toEqual(["PORT", "APP_ENV"]);
  });
});
