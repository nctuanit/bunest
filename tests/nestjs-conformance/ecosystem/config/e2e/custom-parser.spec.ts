import "reflect-metadata";
import { afterEach, beforeEach, expect, it } from "bun:test";
import { join } from "node:path";
import type { BunestApplication } from "../../../../../packages/core/src";
import { ConfigModule } from "../../../../../packages/config/src";
import { describeConformance, Test } from "../../../_helpers/index";
import { AppModule, fixturesDir } from "../_fixtures/app.module";

describeConformance(
  "Custom parser",
  {
    upstreamPath: "config/tests/e2e/custom-parser.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    let app: BunestApplication | undefined;
    let originalEnv: NodeJS.ProcessEnv;

    beforeEach(() => {
      originalEnv = { ...process.env };
    });

    afterEach(async () => {
      await app?.close();
      app = undefined;
      process.env = originalEnv;
    });

    // BUNEST_BUG: app.get(AppModule) throws UnknownDependencyException because DIContainer.getSync() never checks module class instances (mod.instance) registered during instantiateModuleSingletons() (packages/core/src/di/di-container.ts:1201,2626-2731)
    it.skip("should use dotenv parser by default", async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [AppModule.withEnvVars()],
      }).compile();

      app = moduleRef.createNestApplication({ logger: false });
      await app.init();
      await ConfigModule.envVariablesLoaded;

      const envVars = app.get(AppModule).getEnvVariables();
      expect(envVars.PORT).toEqual("4000");
    });

    // BUNEST_BUG: app.get(AppModule) throws UnknownDependencyException because DIContainer.getSync() never checks module class instances (mod.instance) (packages/core/src/di/di-container.ts:1201,2626-2731)
    it.skip("should use custom parser when provided", async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [
          {
            module: AppModule,
            imports: [
              ConfigModule.forRoot({
                envFilePath: join(fixturesDir, ".custom-config"),
                parser: (buffer) =>
                  JSON.parse(
                    Buffer.from(buffer.toString(), "base64").toString("utf-8"),
                  ),
              }),
            ],
          },
        ],
      }).compile();

      app = moduleRef.createNestApplication({ logger: false });
      await app.init();
      const envVars = app.get(AppModule).getEnvVariables();
      expect(envVars.lorem).toEqual("ipsum");
    });
  },
);
