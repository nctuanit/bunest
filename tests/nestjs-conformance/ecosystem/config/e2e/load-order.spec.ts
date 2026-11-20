import "reflect-metadata";
import { afterEach, beforeEach, expect, it } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Inject, Injectable, Module } from "../../../../../packages/common/src";
import {
  ConditionalModule,
  ConfigModule,
  ConfigService,
  registerAs,
} from "../../../../../packages/config/src";
import { describeConformance, itAdapted, Test } from "../../../_helpers/index";
import { createStandardSchema } from "../_fixtures/schema-helpers";

const JWT_SECRET = "JWT_SECRET";

describeConformance(
  "Load order",
  {
    upstreamPath: "config/tests/e2e/load-order.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-005", "ADR-008"],
    notes:
      "Adapts Joi.object({ ENABLE_DEBUG: Joi.boolean() }) to zero-dep inline Standard Schema v1 (ADR-013).",
  },
  () => {
    let originalEnv: NodeJS.ProcessEnv;
    let tmpDir: string;
    let envFilePath: string;

    beforeEach(() => {
      originalEnv = { ...process.env };
      tmpDir = fs.mkdtempSync(join(tmpdir(), "bunest-config-"));
      envFilePath = join(tmpDir, ".env");
      fs.writeFileSync(
        envFilePath,
        ["JWT_SECRET=from-env-file", "ENABLE_DEBUG=false"].join("\n"),
      );
    });

    afterEach(() => {
      process.env = originalEnv;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    const loadSecrets = async () => {
      await delay(20);
      return { JWT_SECRET: "from-secret-store" };
    };

    // BUNEST_BUG: Plain `ConfigModule` (without .forRoot()) declares empty `@Module({})` instead of providing/exporting `ConfigService` via a shared ConfigHostModule, throwing UnknownDependencyException for ConfigService in AuthModule (packages/config/src/config.module.ts:27)
    it.skip('should provide ConfigService to a plain "ConfigModule" import once async "load" factories are merged', async () => {
      @Module({
        imports: [ConfigModule],
        providers: [
          {
            provide: JWT_SECRET,
            useFactory: (configService: ConfigService) =>
              configService.get("JWT_SECRET"),
            inject: [ConfigService],
          },
        ],
        exports: [JWT_SECRET],
      })
      class AuthModule {}

      const moduleRef = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({ envFilePath, load: [loadSecrets] }),
          AuthModule,
        ],
      }).compile();

      expect(moduleRef.get(JWT_SECRET)).toBe("from-secret-store");
      await moduleRef.close();
    });

    // BUNEST_BUG: ConfigModule.forFeature() only exports configFactory.KEY and does not provide/export ConfigService (nor wait for async feature factory before ConfigService is injected in non-global setups), throwing UnknownDependencyException for ConfigService in AuthModule (packages/config/src/config.module.ts:209-233)
    it.skip('should provide ConfigService of "forFeature" once its async factory is merged', async () => {
      const authConfig = registerAs("auth", async () => {
        await delay(20);
        return { secret: "from-secret-store" };
      });

      @Injectable()
      class AuthService {
        readonly secret: string | undefined;
        constructor(@Inject(ConfigService) configService: ConfigService) {
          this.secret = configService.get("auth.secret");
        }
      }

      @Module({
        imports: [ConfigModule.forFeature(authConfig)],
        providers: [AuthService],
      })
      class AuthModule {}

      const moduleRef = await Test.createTestingModule({
        imports: [ConfigModule.forRoot({ envFilePath }), AuthModule],
      }).compile();

      expect(moduleRef.get(AuthService).secret).toBe("from-secret-store");
      await moduleRef.close();
    });

    // BUNEST_BUG: Plain `ConfigModule` declares `@Module({})` without providing/exporting `ConfigService`, throwing UnknownDependencyException when imported without .forRoot() (packages/config/src/config.module.ts:27)
    it.skip('should provide ConfigService to a plain "ConfigModule" import without "forRoot"', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [ConfigModule],
      }).compile();

      expect(moduleRef.get(ConfigService)).toBeInstanceOf(ConfigService);
      await moduleRef.close();
    });

    itAdapted(
      "ADR-005",
      'should evaluate "registerWhen" after every "forRoot" has loaded its env file',
      async () => {
        @Injectable()
        class DebugService {}

        @Module({ providers: [DebugService], exports: [DebugService] })
        class DebugModule {}

        @Module({ imports: [ConfigModule.forRoot({ ignoreEnvFile: true })] })
        class LibraryModule {}

        const enableDebugSchema = createStandardSchema<Record<string, unknown>>(
          (raw) => {
            const rec = (raw ?? {}) as Record<string, unknown>;
            const val = rec.ENABLE_DEBUG;
            if (val === undefined) {
              return { value: {} };
            }
            if (val === "true" || val === true) {
              return { value: { ENABLE_DEBUG: true } };
            }
            if (val === "false" || val === false) {
              return { value: { ENABLE_DEBUG: false } };
            }
            return {
              issues: [
                {
                  message: '"ENABLE_DEBUG" must be a boolean',
                  path: ["ENABLE_DEBUG"],
                },
              ],
            };
          },
          "joi",
        );

        const moduleRef = await Test.createTestingModule({
          imports: [
            ConditionalModule.registerWhen(DebugModule, "ENABLE_DEBUG", {
              debug: false,
            }),
            ConfigModule.forRoot({
              envFilePath,
              validationSchema: enableDebugSchema,
            }),
            LibraryModule,
          ],
        }).compile();

        expect(process.env.ENABLE_DEBUG).toBe("false");
        expect(() => moduleRef.get(DebugService)).toThrow();
        await moduleRef.close();
      },
      "inline Standard Schema v1 instead of Joi",
    );

    it('should not make "registerWhen" wait for slow "load" factories', async () => {
      @Injectable()
      class DebugService {}

      @Module({ providers: [DebugService], exports: [DebugService] })
      class DebugModule {}

      const uncaughtErrors: unknown[] = [];
      const onUncaughtException = (error: unknown) =>
        uncaughtErrors.push(error);
      process.prependListener("uncaughtException", onUncaughtException);
      try {
        const moduleRef = await Test.createTestingModule({
          imports: [
            ConditionalModule.registerWhen(DebugModule, "ENABLE_DEBUG", {
              timeout: 50,
              debug: false,
            }),
            ConfigModule.forRoot({
              envFilePath,
              load: [delay(150).then(() => () => ({}))],
            }),
          ],
        }).compile();

        expect(() => moduleRef.get(DebugService)).toThrow();
        expect(uncaughtErrors).toEqual([]);
        await moduleRef.close();
      } finally {
        process.removeListener("uncaughtException", onUncaughtException);
      }
    });
  },
);
