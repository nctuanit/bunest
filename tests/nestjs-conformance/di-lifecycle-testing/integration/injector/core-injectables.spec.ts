import { afterEach, beforeEach, expect, it } from "bun:test";
import { Module } from "../../../../../packages/core/src/common";
import { ApplicationConfig, ModuleRef } from "../../../../../packages/core/src";
import {
  Test,
  describeConformance,
  type TestingModule,
} from "../../../_helpers";

@Module({})
class CoreInjectablesModule {}

describeConformance(
  "Core Injectables",
  {
    upstreamPath: "integration/injector/e2e/core-injectables.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    let testingModule: TestingModule;

    beforeEach(async () => {
      const builder = Test.createTestingModule({
        imports: [CoreInjectablesModule],
      });
      testingModule = await builder.compile();
    });

    afterEach(async () => {
      await testingModule.close();
    });

    it("should provide ApplicationConfig as core injectable", () => {
      const applicationConfig =
        testingModule.get<ApplicationConfig>(ApplicationConfig);

      applicationConfig.setGlobalPrefix("/api");

      expect(applicationConfig).not.toBeUndefined();
      expect(applicationConfig.getGlobalPrefix()).toBe("/api");
    });

    it("should provide ModuleRef as core injectable", () => {
      const moduleRef = testingModule.get<ModuleRef>(ModuleRef);
      expect(moduleRef).not.toBeUndefined();
    });

    it("should provide the current Module as provider", () => {
      const module = testingModule.get<CoreInjectablesModule>(
        CoreInjectablesModule,
      );
      expect(module).not.toBeUndefined();
      expect(module.constructor.name).toBe("CoreInjectablesModule");
    });
  },
);
