import { describe, expect, it } from "bun:test";
import {
  Controller,
  Injectable,
  Module as NestModule,
  Scope,
} from "../../../../../../packages/core/src/common";
import {
  DiscoveryService,
  type DiscoveryHost,
  type InstanceWrapper,
} from "../../../../../../packages/core/src";
import { Test, describeConformance } from "../../../../_helpers";

function createFakeWrapper<T = unknown>(
  partial: Partial<InstanceWrapper<T>> & { token: any },
): InstanceWrapper<T> {
  return {
    token: partial.token,
    instance: partial.instance,
    metatype: partial.metatype,
    moduleRef: partial.moduleRef ?? ({} as any),
    moduleId: partial.moduleId ?? "mod-1",
    scope: partial.scope ?? Scope.SINGLETON,
    isDependencyTreeStatic: partial.isDependencyTreeStatic ?? true,
  };
}

function createEmptyDiscoveryService(): DiscoveryService {
  const host: DiscoveryHost = {
    discoverProviders: () => [],
    discoverControllers: () => [],
    discoverModules: () => [],
    discoverProviderByToken: () => undefined,
  };
  return new DiscoveryService(host);
}

describeConformance(
  "DiscoveryService",
  {
    upstreamPath: "packages/core/test/discovery/discovery-service.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-002", "ADR-007"],
    notes:
      "Adapted from NestJS internal DiscoverableMetaHostCollection/Module mocks to Bunest public DiscoveryService + Test.createTestingModule API.",
  },
  () => {
    describe("createDecorator", () => {
      it("should create a decorator with a unique KEY", () => {
        const decorator1 = DiscoveryService.createDecorator();
        const decorator2 = DiscoveryService.createDecorator();

        expect(typeof decorator1.KEY).toBe("string");
        expect(typeof decorator2.KEY).toBe("string");
        expect(decorator1.KEY).not.toBe(decorator2.KEY);
      });

      it("should create a decorator that can decorate classes", () => {
        const TestDecorator = DiscoveryService.createDecorator<{
          value: string;
        }>();

        @TestDecorator({ value: "test" })
        class TestClass {}

        const metadata = Reflect.getMetadata(TestDecorator.KEY, TestClass);
        expect(metadata).toEqual({ value: "test" });
      });

      it("should create a decorator that can decorate methods", () => {
        const TestDecorator = DiscoveryService.createDecorator<{
          event: string;
        }>();

        class TestClass {
          @TestDecorator({ event: "click" })
          handleClick() {}
        }

        const metadata = Reflect.getMetadata(
          TestDecorator.KEY,
          new TestClass().handleClick,
        );
        expect(metadata).toEqual({ event: "click" });
      });

      it("should use empty object as default metadata when no options provided", () => {
        const TestDecorator = DiscoveryService.createDecorator();

        @TestDecorator()
        class TestClass {}

        const metadata = Reflect.getMetadata(TestDecorator.KEY, TestClass);
        expect(metadata).toEqual({});
      });

      it("should discover a class decorated with createDecorator() via metadataKey", async () => {
        const TestDecorator = DiscoveryService.createDecorator();

        @TestDecorator({ tag: "class" })
        @Injectable()
        class TestClass {}

        const moduleRef = await Test.createTestingModule({
          providers: [TestClass],
        }).compile();

        const discoveryService = moduleRef.get(DiscoveryService);
        const found = discoveryService.getProviders({
          metadataKey: TestDecorator.KEY,
        });
        expect(found).toHaveLength(1);
        expect(found[0]?.metatype).toBe(TestClass);
      });

      it("should not match class-level metadataKey when decorator is only on a method", async () => {
        const TestDecorator = DiscoveryService.createDecorator();

        @Injectable()
        class TestClass {
          @TestDecorator({ tag: "method" })
          testMethod() {}
        }

        const moduleRef = await Test.createTestingModule({
          providers: [TestClass],
        }).compile();

        const discoveryService = moduleRef.get(DiscoveryService);
        const found = discoveryService.getProviders({
          metadataKey: TestDecorator.KEY,
        });
        expect(found).toHaveLength(0);
      });
    });

    describe("getProviders", () => {
      it("should return all providers from all modules when no options provided", async () => {
        @NestModule({
          providers: [
            { provide: "PROVIDER_1", useValue: "p1" },
            { provide: "PROVIDER_2", useValue: "p2" },
          ],
        })
        class Module1 {}

        @NestModule({
          providers: [{ provide: "PROVIDER_3", useValue: "p3" }],
        })
        class Module2 {}

        const moduleRef = await Test.createTestingModule({
          imports: [Module1, Module2],
        }).compile();

        const discoveryService = moduleRef.get(DiscoveryService);
        const providers = discoveryService.getProviders();
        const tokens = providers.map((p) => p.token);

        expect(tokens).toContain("PROVIDER_1");
        expect(tokens).toContain("PROVIDER_2");
        expect(tokens).toContain("PROVIDER_3");
        expect(providers).toHaveLength(3);
      });

      it("should return empty array when no modules exist", () => {
        const discoveryService = createEmptyDiscoveryService();
        const providers = discoveryService.getProviders();
        expect(providers).toHaveLength(0);
      });

      it("should return empty array when modules have no providers", async () => {
        @NestModule({})
        class Module1 {}

        const moduleRef = await Test.createTestingModule({
          imports: [Module1],
        }).compile();

        const discoveryService = moduleRef.get(DiscoveryService);
        const providers = discoveryService.getProviders({
          include: [Module1],
        });
        expect(providers).toHaveLength(0);
      });

      it("should filter providers by metadataKey when provided", async () => {
        const TestDecorator = DiscoveryService.createDecorator();

        @TestDecorator({ id: 1 })
        @Injectable()
        class Provider1 {}

        @TestDecorator({ id: 2 })
        @Injectable()
        class Provider2 {}

        @Injectable()
        class UnmarkedProvider {}

        const moduleRef = await Test.createTestingModule({
          providers: [Provider1, Provider2, UnmarkedProvider],
        }).compile();

        const discoveryService = moduleRef.get(DiscoveryService);
        const providers = discoveryService.getProviders({
          metadataKey: TestDecorator.KEY,
        });

        expect(providers).toHaveLength(2);
        expect(providers.map((p) => p.token)).toContain(Provider1);
        expect(providers.map((p) => p.token)).toContain(Provider2);
      });

      it("should return empty array when no providers match the metadataKey", async () => {
        @Injectable()
        class PlainProvider {}

        const moduleRef = await Test.createTestingModule({
          providers: [PlainProvider],
        }).compile();

        const discoveryService = moduleRef.get(DiscoveryService);
        const providers = discoveryService.getProviders({
          metadataKey: "non-existent-key",
        });
        expect(providers).toHaveLength(0);
      });

      it("should filter providers by included modules", async () => {
        @NestModule({
          providers: [{ provide: "PROVIDER_1", useValue: 1 }],
        })
        class Module1 {}

        @NestModule({
          providers: [{ provide: "PROVIDER_2", useValue: 2 }],
        })
        class Module2 {}

        @NestModule({
          providers: [{ provide: "PROVIDER_3", useValue: 3 }],
        })
        class Module3 {}

        const moduleRef = await Test.createTestingModule({
          imports: [Module1, Module2, Module3],
        }).compile();

        const discoveryService = moduleRef.get(DiscoveryService);
        const providers = discoveryService.getProviders({
          include: [Module1, Module2],
        });
        const tokens = providers.map((p) => p.token);

        expect(providers).toHaveLength(2);
        expect(tokens).toContain("PROVIDER_1");
        expect(tokens).toContain("PROVIDER_2");
        expect(tokens).not.toContain("PROVIDER_3");
      });

      it("should return empty array when include option is empty array", async () => {
        @NestModule({
          providers: [{ provide: "PROVIDER_1", useValue: 1 }],
        })
        class Module1 {}

        const moduleRef = await Test.createTestingModule({
          imports: [Module1],
        }).compile();

        const discoveryService = moduleRef.get(DiscoveryService);
        const providers = discoveryService.getProviders({ include: [] });
        expect(providers).toHaveLength(0);
      });

      it("should discover useValue providers decorated with custom discovery decorator", async () => {
        const TestDecorator = DiscoveryService.createDecorator();

        @TestDecorator({ from: "value" })
        class TargetService {}

        const instance = new TargetService();
        const moduleRef = await Test.createTestingModule({
          providers: [{ provide: "VALUE_TOKEN", useValue: instance }],
        }).compile();

        const discoveryService = moduleRef.get(DiscoveryService);
        const providers = discoveryService.getProviders({
          metadataKey: TestDecorator.KEY,
        });

        expect(providers).toHaveLength(1);
        expect(providers[0]?.token).toBe("VALUE_TOKEN");
        expect(providers[0]?.instance).toBe(instance);
      });

      it("should discover providers that inherit a custom discovery decorator", async () => {
        const TestDecorator = DiscoveryService.createDecorator<{
          inherited?: boolean;
        }>();

        @TestDecorator({ inherited: true })
        @Injectable()
        class BaseService {}

        @Injectable()
        class ChildService extends BaseService {}

        const moduleRef = await Test.createTestingModule({
          providers: [ChildService],
        }).compile();

        const discoveryService = moduleRef.get(DiscoveryService);
        const providers = discoveryService.getProviders({
          metadataKey: TestDecorator.KEY,
        });

        expect(providers).toHaveLength(1);
        expect(providers[0]?.token).toBe(ChildService);
        expect(
          discoveryService.getMetadataByDecorator(TestDecorator, providers[0]!),
        ).toEqual({ inherited: true });
      });
    });

    describe("getControllers", () => {
      it("should return all controllers from all modules when no options provided", async () => {
        @Controller("c1")
        class Controller1 {}

        @Controller("c2")
        class Controller2 {}

        @NestModule({ controllers: [Controller1] })
        class Module1 {}

        @NestModule({ controllers: [Controller2] })
        class Module2 {}

        const moduleRef = await Test.createTestingModule({
          imports: [Module1, Module2],
        }).compile();

        const discoveryService = moduleRef.get(DiscoveryService);
        const controllers = discoveryService.getControllers();
        const tokens = controllers.map((c) => c.token);

        expect(controllers).toHaveLength(2);
        expect(tokens).toContain(Controller1);
        expect(tokens).toContain(Controller2);
      });

      it("should return empty array when no controllers exist", async () => {
        @NestModule({})
        class Module1 {}

        const moduleRef = await Test.createTestingModule({
          imports: [Module1],
        }).compile();

        const discoveryService = moduleRef.get(DiscoveryService);
        const controllers = discoveryService.getControllers();
        expect(controllers).toHaveLength(0);
      });

      it("should filter controllers by metadataKey when provided", async () => {
        const CtrlDecorator = DiscoveryService.createDecorator();

        @CtrlDecorator({ tagged: true })
        @Controller("c1")
        class Controller1 {}

        @Controller("c2")
        class Controller2 {}

        const moduleRef = await Test.createTestingModule({
          controllers: [Controller1, Controller2],
        }).compile();

        const discoveryService = moduleRef.get(DiscoveryService);
        const controllers = discoveryService.getControllers({
          metadataKey: CtrlDecorator.KEY,
        });

        expect(controllers).toHaveLength(1);
        expect(controllers[0]?.token).toBe(Controller1);
      });

      it("should filter controllers by included modules", async () => {
        @Controller("c1")
        class Controller1 {}

        @Controller("c2")
        class Controller2 {}

        @NestModule({ controllers: [Controller1] })
        class Module1 {}

        @NestModule({ controllers: [Controller2] })
        class Module2 {}

        const moduleRef = await Test.createTestingModule({
          imports: [Module1, Module2],
        }).compile();

        const discoveryService = moduleRef.get(DiscoveryService);
        const controllers = discoveryService.getControllers({
          include: [Module1],
        });

        expect(controllers).toHaveLength(1);
        expect(controllers[0]?.token).toBe(Controller1);
      });
    });

    describe("getMetadataByDecorator", () => {
      it("should retrieve metadata from class using decorator", () => {
        const discoveryService = createEmptyDiscoveryService();
        const TestDecorator = DiscoveryService.createDecorator<{
          role: string;
        }>();

        @TestDecorator({ role: "admin" })
        class TestClass {}

        const wrapper = createFakeWrapper({
          token: TestClass,
          metatype: TestClass,
          instance: new TestClass(),
        });

        const metadata = discoveryService.getMetadataByDecorator(
          TestDecorator,
          wrapper,
        );

        expect(metadata).toEqual({ role: "admin" });
      });

      it("should retrieve metadata from method using decorator and methodKey", () => {
        const discoveryService = createEmptyDiscoveryService();
        const TestDecorator = DiscoveryService.createDecorator<{
          event: string;
        }>();

        class TestClass {
          @TestDecorator({ event: "created" })
          onCreate() {}
        }

        const wrapper = createFakeWrapper({
          token: TestClass,
          metatype: TestClass,
          instance: new TestClass(),
        });

        const metadata = discoveryService.getMetadataByDecorator(
          TestDecorator,
          wrapper,
          "onCreate",
        );

        expect(metadata).toEqual({ event: "created" });
      });

      it("should return undefined when metadata does not exist", () => {
        const discoveryService = createEmptyDiscoveryService();
        const TestDecorator = DiscoveryService.createDecorator();

        class TestClass {}

        const wrapper = createFakeWrapper({
          token: TestClass,
          metatype: TestClass,
          instance: new TestClass(),
        });

        const metadata = discoveryService.getMetadataByDecorator(
          TestDecorator,
          wrapper,
        );

        expect(metadata).toBeUndefined();
      });

      it("should return undefined when methodKey has no decorator metadata", () => {
        const discoveryService = createEmptyDiscoveryService();
        const TestDecorator = DiscoveryService.createDecorator();

        class TestClass {
          existingMethod() {}
        }

        const wrapper = createFakeWrapper({
          token: TestClass,
          metatype: TestClass,
          instance: new TestClass(),
        });

        const metadata = discoveryService.getMetadataByDecorator(
          TestDecorator,
          wrapper,
          "existingMethod",
        );

        expect(metadata).toBeUndefined();
      });

      it("should use metatype when instance.constructor is undefined", () => {
        const discoveryService = createEmptyDiscoveryService();
        const TestDecorator = DiscoveryService.createDecorator<{
          value: number;
        }>();

        @TestDecorator({ value: 42 })
        class TestClass {}

        const instanceWithoutConstructor = Object.create(null);

        const wrapper = createFakeWrapper({
          token: TestClass,
          metatype: TestClass,
          instance: instanceWithoutConstructor,
        });

        const metadata = discoveryService.getMetadataByDecorator(
          TestDecorator,
          wrapper,
        );

        expect(metadata).toEqual({ value: 42 });
      });

      it("should handle undefined instance gracefully", () => {
        const discoveryService = createEmptyDiscoveryService();
        const TestDecorator = DiscoveryService.createDecorator<{
          test: string;
        }>();

        @TestDecorator({ test: "value" })
        class TestClass {}

        const wrapper = createFakeWrapper({
          token: TestClass,
          metatype: TestClass,
          instance: undefined,
        });

        const metadata = discoveryService.getMetadataByDecorator(
          TestDecorator,
          wrapper,
        );

        expect(metadata).toEqual({ test: "value" });
      });
    });

    describe("getModules", () => {
      it("should return all modules when no options provided", async () => {
        @NestModule({})
        class Module1 {}

        @NestModule({})
        class Module2 {}

        const moduleRef = await Test.createTestingModule({
          imports: [Module1, Module2],
        }).compile();

        const discoveryService = moduleRef.get(DiscoveryService);
        const modules = discoveryService.getModules();
        const metatypes = modules.map((m) => m.metatype);

        expect(metatypes).toContain(Module1);
        expect(metatypes).toContain(Module2);
      });

      it("should return empty array when no modules exist", () => {
        const discoveryService = createEmptyDiscoveryService();
        const modules = discoveryService.getModules();
        expect(modules).toHaveLength(0);
      });

      it("should filter modules by include option", async () => {
        @NestModule({})
        class Module1 {}

        @NestModule({})
        class Module2 {}

        @NestModule({})
        class Module3 {}

        const moduleRef = await Test.createTestingModule({
          imports: [Module1, Module2, Module3],
        }).compile();

        const discoveryService = moduleRef.get(DiscoveryService);
        const modules = (discoveryService as any).getModules({
          include: [Module1, Module3],
        });
        const metatypes = modules.map((m: any) => m.metatype);

        expect(modules).toHaveLength(2);
        expect(metatypes).toContain(Module1);
        expect(metatypes).toContain(Module3);
        expect(metatypes).not.toContain(Module2);
      });

      it("should return empty array when include option is empty", async () => {
        @NestModule({})
        class Module1 {}

        const moduleRef = await Test.createTestingModule({
          imports: [Module1],
        }).compile();

        const discoveryService = moduleRef.get(DiscoveryService);
        const modules = (discoveryService as any).getModules({ include: [] });
        expect(modules).toHaveLength(0);
      });
    });

    describe("discovery of wrappers inspected after instantiation", () => {
      it("should discover a provider registered via useFactory with a discovery decorator", async () => {
        const TestDecorator = DiscoveryService.createDecorator();

        @TestDecorator({ factory: true })
        @Injectable()
        class FactoryService {}

        @NestModule({
          providers: [
            { provide: FactoryService, useFactory: () => new FactoryService() },
          ],
        })
        class AppModule {}

        const moduleRef = await Test.createTestingModule({
          imports: [AppModule],
        }).compile();

        const providers = moduleRef
          .get(DiscoveryService)
          .getProviders({ metadataKey: TestDecorator.KEY });

        expect(providers).toHaveLength(1);
        expect(providers[0]?.instance).toBeInstanceOf(FactoryService);
      });

      it("should discover a decorated useClass provider exactly once", async () => {
        const TestDecorator = DiscoveryService.createDecorator();

        @TestDecorator({ cls: true })
        @Injectable()
        class ClassService {}

        @NestModule({
          providers: [ClassService],
        })
        class AppModule {}

        const moduleRef = await Test.createTestingModule({
          imports: [AppModule],
        }).compile();

        const providers = moduleRef
          .get(DiscoveryService)
          .getProviders({ metadataKey: TestDecorator.KEY });

        expect(providers).toHaveLength(1);
        expect(providers[0]?.instance).toBeInstanceOf(ClassService);
      });

      it("should not discover an alias wrapper in addition to the provider it points at", async () => {
        const TestDecorator = DiscoveryService.createDecorator();

        @TestDecorator({ alias: true })
        @Injectable()
        class AliasedService {}

        @NestModule({
          providers: [
            AliasedService,
            { provide: "ALIAS", useExisting: AliasedService },
          ],
        })
        class AppModule {}

        const moduleRef = await Test.createTestingModule({
          imports: [AppModule],
        }).compile();

        const providers = moduleRef
          .get(DiscoveryService)
          .getProviders({ metadataKey: TestDecorator.KEY });

        expect(providers).toHaveLength(1);
        expect(providers[0]?.instance).toBeInstanceOf(AliasedService);
      });

      it("should discover providers and controllers by each of the discovery decorators applied to them", async () => {
        const FirstDecorator = DiscoveryService.createDecorator();
        const SecondDecorator = DiscoveryService.createDecorator();

        @FirstDecorator({ first: true })
        @SecondDecorator({ second: true })
        @Injectable()
        class ClassService {}

        @SecondDecorator({ second: true })
        @FirstDecorator({ first: true })
        @Injectable()
        class FactoryService {}

        @FirstDecorator({ first: true })
        @SecondDecorator({ second: true })
        class ValueService {}

        @FirstDecorator({ first: true })
        @SecondDecorator({ second: true })
        @Controller()
        class TestController {}

        @NestModule({
          providers: [
            ClassService,
            { provide: FactoryService, useFactory: () => new FactoryService() },
            { provide: "VALUE", useValue: new ValueService() },
            { provide: "ALIAS", useExisting: ClassService },
          ],
          controllers: [TestController],
        })
        class AppModule {}

        const moduleRef = await Test.createTestingModule({
          imports: [AppModule],
        }).compile();
        const discovery = moduleRef.get(DiscoveryService);

        for (const decorator of [FirstDecorator, SecondDecorator]) {
          const providers = discovery.getProviders({
            metadataKey: decorator.KEY,
          });
          expect(providers).toHaveLength(3);
          const instances = providers.map((wrapper) => wrapper.instance);
          expect(instances.some((i) => i instanceof ClassService)).toBe(true);
          expect(instances.some((i) => i instanceof FactoryService)).toBe(true);
          expect(instances.some((i) => i instanceof ValueService)).toBe(true);

          const controllers = discovery.getControllers({
            metadataKey: decorator.KEY,
          });
          expect(controllers).toHaveLength(1);
          expect(controllers[0]?.instance).toBeInstanceOf(TestController);
        }
      });
    });
  },
);
