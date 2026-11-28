import { describe, expect, it } from "bun:test";
import { Module } from "@bunest/core";
import { ConfigModule } from "@bunest/core/config";
import { Test } from "@bunest/testing";
import { AppController } from "../src/app.controller";
import {
  createDynamicAppModule,
  DEFAULT_CONFIG_DIR,
} from "../src/app.module";
import { AppService, featureConfig } from "../src/app.service";
import { EnvConfigModule } from "../src/env-config/env-config.module";
import { GreetingModule } from "../src/greeting/greeting.module";

describe("Dynamic Modules (NestJS 25-dynamic-modules E2E)", () => {
  it("resolves dynamic EnvConfigModule (dev & prod), ConfigurableModuleBuilder, and namespaced ConfigModule", async () => {
    const devMod = await Test.createTestingModule({
      imports: [createDynamicAppModule("development")],
    }).compile();
    const devApp = devMod.createBunestApplication();
    const devClient = devMod.createTestClient(devApp);
    await devApp.init();

    try {
      const res = await devClient.get("/?name=Ada");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        greeting: "Hi, Ada!",
        helloMessage: "Hello from Bunest development env!",
        region: "local-dev",
        service: "dynamic-modules-demo",
        version: "1.0.0",
      });
    } finally {
      await devApp.close();
    }

    // Async registration via registerAsync + forRootAsync
    @Module({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [featureConfig],
        }),
        EnvConfigModule.registerAsync({
          useFactory: async () => ({
            folder: DEFAULT_CONFIG_DIR,
            envName: "production",
          }),
        }),
        GreetingModule.forRootAsync({
          isGlobal: true,
          useFactory: async () => ({
            prefix: "Greetings",
            excited: false,
          }),
        }),
      ],
      controllers: [AppController],
      providers: [AppService],
    })
    class AsyncAppModule {}

    const asyncMod = await Test.createTestingModule({
      imports: [AsyncAppModule],
    }).compile();
    const asyncApp = asyncMod.createBunestApplication();
    const asyncClient = asyncMod.createTestClient(asyncApp);
    await asyncApp.init();

    try {
      const res = await asyncClient.get("/?name=Grace");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        greeting: "Greetings, Grace.",
        helloMessage: "Hello from Bunest production env!",
        region: "us-east-1",
        service: "dynamic-modules-demo",
        version: "1.0.0",
      });
    } finally {
      await asyncApp.close();
    }
  });
});
