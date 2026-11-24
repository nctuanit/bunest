import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  Controller,
  Global,
  Injectable,
  Module,
  forwardRef,
  type DynamicModule,
} from "../../../../../packages/core/src/common";
import { LazyModuleLoader } from "../../../../../packages/core/src";
import {
  Test,
  type TestingModule,
  describeConformance,
} from "../../../_helpers";

@Injectable()
class AProvider {}

@Injectable()
class BProvider {}

@Module({
  imports: [forwardRef(() => BModule)],
  providers: [AProvider],
  exports: [AProvider],
})
class AModule {}

@Module({
  imports: [forwardRef(() => AModule)],
  providers: [BProvider],
  exports: [BProvider],
})
class BModule {}

describeConformance(
  "Modules overriding",
  {
    upstreamPath:
      "integration/testing-module-override/e2e/modules-override.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    describe("Top-level module", () => {
      @Controller()
      class ControllerOverwritten {}

      @Module({ controllers: [ControllerOverwritten] })
      class ModuleToBeOverwritten {}

      @Controller()
      class ControllerOverride {}

      @Module({ controllers: [ControllerOverride] })
      class ModuleOverride {}

      let testingModule: TestingModule;

      beforeEach(async () => {
        testingModule = await Test.createTestingModule({
          imports: [ModuleToBeOverwritten],
        })
          .overrideModule(ModuleToBeOverwritten)
          .useModule(ModuleOverride)
          .compile();
      });

      afterEach(async () => {
        await testingModule.close();
      });

      it("should override top-level modules using testing module builder", () => {
        expect(() =>
          testingModule.get<ControllerOverwritten>(ControllerOverwritten),
        ).toThrow();
        expect(
          testingModule.get<ControllerOverride>(ControllerOverride),
        ).toBeInstanceOf(ControllerOverride);
      });
    });

    describe("Dynamic module", () => {
      @Controller()
      class ControllerOverwritten {}

      @Module({})
      class DynamicModuleToBeOverwritten {}

      const dynamicModuleOverwritten: DynamicModule = {
        module: DynamicModuleToBeOverwritten,
        controllers: [ControllerOverwritten],
      };

      @Controller()
      class ControllerOverride {}

      @Module({})
      class DynamicModuleOverride {}

      const dynamicModuleOverride: DynamicModule = {
        module: DynamicModuleOverride,
        controllers: [ControllerOverride],
      };

      let testingModule: TestingModule;

      beforeEach(async () => {
        testingModule = await Test.createTestingModule({
          imports: [dynamicModuleOverwritten],
        })
          .overrideModule(dynamicModuleOverwritten)
          .useModule(dynamicModuleOverride)
          .compile();
      });

      afterEach(async () => {
        await testingModule.close();
      });

      it("should override dynamic modules using testing module builder", () => {
        expect(() =>
          testingModule.get<ControllerOverwritten>(ControllerOverwritten),
        ).toThrow();
        expect(
          testingModule.get<ControllerOverride>(ControllerOverride),
        ).toBeInstanceOf(ControllerOverride);
      });
    });

    describe("Circular dependency module", () => {
      let testingModule: TestingModule;

      @Injectable()
      class CProvider {}

      @Module({ providers: [CProvider] })
      class CModule {}

      @Injectable()
      class BProviderOverride {}

      @Module({
        imports: [forwardRef(() => AModule), forwardRef(() => CModule)],
        providers: [BProviderOverride],
        exports: [BProviderOverride],
      })
      class BModuleOverride {}

      beforeEach(async () => {
        testingModule = await Test.createTestingModule({
          imports: [AModule],
        })
          .overrideModule(BModule)
          .useModule(BModuleOverride)
          .compile();
      });

      afterEach(async () => {
        await testingModule.close();
      });

      it("should override circular dependency modules using testing module builder", () => {
        expect(testingModule.get<AProvider>(AProvider)).toBeInstanceOf(
          AProvider,
        );
        expect(() => testingModule.get<BProvider>(BProvider)).toThrow();
        expect(testingModule.get<CProvider>(CProvider)).toBeInstanceOf(
          CProvider,
        );
        expect(
          testingModule.get<BProviderOverride>(BProviderOverride),
        ).toBeInstanceOf(BProviderOverride);
      });
    });

    describe("Nested module", () => {
      let testingModule: TestingModule;

      @Controller()
      class OverwrittenNestedModuleController {}

      @Module({ controllers: [OverwrittenNestedModuleController] })
      class OverwrittenNestedModule {}

      @Controller()
      class OverrideNestedModuleController {}

      @Module({ controllers: [OverrideNestedModuleController] })
      class OverrideNestedModule {}

      @Module({ imports: [OverwrittenNestedModule] })
      class AppModule {}

      beforeEach(async () => {
        testingModule = await Test.createTestingModule({
          imports: [AppModule],
        })
          .overrideModule(OverwrittenNestedModule)
          .useModule(OverrideNestedModule)
          .compile();
      });

      afterEach(async () => {
        await testingModule.close();
      });

      it("should override nested modules using testing module builder", () => {
        expect(
          testingModule.get<OverrideNestedModuleController>(
            OverrideNestedModuleController,
          ),
        ).toBeInstanceOf(OverrideNestedModuleController);
        expect(() =>
          testingModule.get<OverwrittenNestedModuleController>(
            OverwrittenNestedModuleController,
          ),
        ).toThrow();
      });
    });

    describe("Lazy-loaded module", () => {
      let testingModule: TestingModule;

      @Injectable()
      class OverwrittenLazyProvider {
        value() {
          return "overwritten lazy";
        }
      }

      @Module({
        providers: [
          {
            provide: "LAZY_PROVIDER",
            useClass: OverwrittenLazyProvider,
          },
        ],
      })
      class OverwrittenLazyModule {}

      @Injectable()
      class OverrideLazyProvider {
        value() {
          return "override lazy";
        }
      }

      @Module({
        providers: [
          {
            provide: "LAZY_PROVIDER",
            useClass: OverrideLazyProvider,
          },
        ],
      })
      class OverrideLazyModule {}

      @Injectable()
      class AppService {
        constructor(private lazyModuleLoader: LazyModuleLoader) {}

        async value() {
          const moduleRef = await this.lazyModuleLoader.load(
            () => OverwrittenLazyModule,
          );
          return moduleRef.get<{ value(): string }>("LAZY_PROVIDER").value();
        }
      }

      @Module({
        imports: [],
        providers: [AppService],
      })
      class AppModule {}

      beforeEach(async () => {
        testingModule = await Test.createTestingModule({
          imports: [AppModule],
        })
          .overrideModule(OverwrittenLazyModule)
          .useModule(OverrideLazyModule)
          .compile();
      });

      afterEach(async () => {
        await testingModule.close();
      });

      it("should override lazy loaded modules using testing module builder", async () => {
        const result = await testingModule.get<AppService>(AppService).value();
        expect(result).toBe("override lazy");
      });
    });

    describe("Global module", () => {
      let testingModule: TestingModule;

      @Injectable()
      class OverwrittenProvider {
        value() {
          return "overwritten";
        }
      }

      @Global()
      @Module({
        providers: [OverwrittenProvider],
        exports: [OverwrittenProvider],
      })
      class OverwrittenModule {}

      @Injectable()
      class OverrideProvider {
        value() {
          return "override";
        }
      }

      @Global()
      @Module({
        providers: [OverrideProvider],
        exports: [OverrideProvider],
      })
      class OverrideModule {}

      beforeEach(async () => {
        testingModule = await Test.createTestingModule({
          imports: [OverwrittenModule],
        })
          .overrideModule(OverwrittenModule)
          .useModule(OverrideModule)
          .compile();
      });

      afterEach(async () => {
        await testingModule.close();
      });

      it("should override global modules using testing module builder", () => {
        expect(
          testingModule.get<OverrideProvider>(OverrideProvider),
        ).toBeInstanceOf(OverrideProvider);
        expect(() =>
          testingModule.get<OverwrittenProvider>(OverwrittenProvider),
        ).toThrow();
      });
    });
  },
);
