import { describe, expect, it, mock } from "bun:test";
import {
  Controller,
  Get,
  Inject,
  Injectable,
  Module as ModuleDecorator,
  Scope,
  UseGuards,
} from "../../../../../packages/core/src/common";
import {
  Test,
  TestingLogger,
  TestingModule,
  TestingModuleBuilder,
  describeConformance,
  itAdapted,
  request,
} from "../../../_helpers";

describeConformance(
  "TestingModuleBuilder",
  {
    upstreamPath: "packages/testing/test/testing-module-builder.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-002", "ADR-012"],
    notes:
      "Ported all 44 upstream TestingModuleBuilder assertions (overridePipe/Filter/Guard/Interceptor/Provider/Module, useMocker across singleton/transient/request/factory/property scopes, snapshot/preview).",
  },
  () => {
    describe("constructor", () => {
      it("should be created via Test.createTestingModule", () => {
        const builder = Test.createTestingModule({});
        expect(builder).toBeInstanceOf(TestingModuleBuilder);
      });
    });

    describe("overridePipe", () => {
      class SomePipe {}

      it("should return an OverrideBy object with useValue, useFactory, useClass", () => {
        const builder = Test.createTestingModule({});
        const overrideBy = builder.overridePipe(SomePipe);

        expect(typeof overrideBy.useValue).toBe("function");
        expect(typeof overrideBy.useFactory).toBe("function");
        expect(typeof overrideBy.useClass).toBe("function");
      });

      it("should be chainable via useValue", () => {
        const builder = Test.createTestingModule({});
        const result = builder.overridePipe(SomePipe).useValue({});
        expect(result).toBe(builder);
      });
    });

    describe("overrideFilter", () => {
      class SomeFilter {}

      it("should return an OverrideBy object", () => {
        const builder = Test.createTestingModule({});
        const overrideBy = builder.overrideFilter(SomeFilter);
        expect(typeof overrideBy.useValue).toBe("function");
      });

      it("should be chainable via useClass", () => {
        const builder = Test.createTestingModule({});
        class FakeFilter {}
        const result = builder.overrideFilter(SomeFilter).useClass(FakeFilter);
        expect(result).toBe(builder);
      });
    });

    describe("overrideGuard", () => {
      class SomeGuard {}

      it("should return an OverrideBy object", () => {
        const builder = Test.createTestingModule({});
        const overrideBy = builder.overrideGuard(SomeGuard);
        expect(typeof overrideBy.useValue).toBe("function");
      });

      it("should be chainable via useFactory", () => {
        const builder = Test.createTestingModule({});
        const result = builder
          .overrideGuard(SomeGuard)
          .useFactory({ factory: () => ({}) });
        expect(result).toBe(builder);
      });
    });

    describe("overrideInterceptor", () => {
      class SomeInterceptor {}

      it("should return an OverrideBy object", () => {
        const builder = Test.createTestingModule({});
        const overrideBy = builder.overrideInterceptor(SomeInterceptor);
        expect(typeof overrideBy.useValue).toBe("function");
      });

      it("should be chainable via useValue", () => {
        const builder = Test.createTestingModule({});
        const result = builder
          .overrideInterceptor(SomeInterceptor)
          .useValue({});
        expect(result).toBe(builder);
      });
    });

    describe("overrideProvider", () => {
      it("should return an OverrideBy object", () => {
        const builder = Test.createTestingModule({});
        const overrideBy = builder.overrideProvider("someProvider");
        expect(typeof overrideBy.useValue).toBe("function");
      });

      it("should be chainable via useValue", () => {
        const builder = Test.createTestingModule({});
        const result = builder.overrideProvider("someProvider").useValue({});
        expect(result).toBe(builder);
      });
    });

    describe("overrideModule", () => {
      it("should return an OverrideModule object with useModule", () => {
        const builder = Test.createTestingModule({});
        class Placeholder {}
        const overrideModule = builder.overrideModule(Placeholder);
        expect(typeof overrideModule.useModule).toBe("function");
      });

      it("should be chainable via useModule", () => {
        const builder = Test.createTestingModule({});
        @ModuleDecorator({})
        class ToOverride {}
        @ModuleDecorator({})
        class ReplacementModule {}

        const result = builder
          .overrideModule(ToOverride)
          .useModule(ReplacementModule);
        expect(result).toBe(builder);
      });
    });

    describe("useMocker", () => {
      it("should set the mocker and return the builder", () => {
        const builder = Test.createTestingModule({});
        const mocker = () => ({});
        const result = builder.useMocker(mocker);
        expect(result).toBe(builder);
      });
    });

    describe("setLogger", () => {
      it("should set the logger and return the builder", () => {
        const builder = Test.createTestingModule({});
        const logger = new TestingLogger();
        const result = builder.setLogger(logger);
        expect(result).toBe(builder);
      });
    });

    describe("compile", () => {
      it("should return a TestingModule instance", async () => {
        @ModuleDecorator({})
        class TestModule {}

        const mod = await Test.createTestingModule({
          imports: [TestModule],
        }).compile();

        expect(mod).toBeInstanceOf(TestingModule);
        await mod.close();
      });

      it("should allow retrieving registered providers", async () => {
        @ModuleDecorator({
          providers: [{ provide: "TOKEN", useValue: "token-value" }],
        })
        class TestModule {}

        const mod = await Test.createTestingModule({
          imports: [TestModule],
        }).compile();

        expect(mod.get("TOKEN")).toBe("token-value");
        await mod.close();
      });

      it("should support overriding a provider with useValue", async () => {
        @ModuleDecorator({
          providers: [{ provide: "DATABASE_CONNECTION", useValue: "real-db" }],
        })
        class TestModule {}

        const mod = await Test.createTestingModule({
          imports: [TestModule],
        })
          .overrideProvider("DATABASE_CONNECTION")
          .useValue("mock-db")
          .compile();

        expect(mod.get("DATABASE_CONNECTION")).toBe("mock-db");
        await mod.close();
      });

      it("should support overriding a provider with useValue undefined", async () => {
        const constructed = mock(() => {});

        @Injectable()
        class Foo {
          constructor() {
            constructed();
          }
        }

        @ModuleDecorator({ providers: [Foo] })
        class TestModule {}

        const mod = await Test.createTestingModule({
          imports: [TestModule],
        })
          .overrideProvider(Foo)
          .useValue(undefined)
          .compile();

        expect(mod.get(Foo)).toBeUndefined();
        expect(constructed).not.toHaveBeenCalled();
        await mod.close();
      });

      it("should support overriding a provider with useValue null", async () => {
        const constructed = mock(() => {});

        @Injectable()
        class Foo {
          constructor() {
            constructed();
          }
        }

        @ModuleDecorator({ providers: [Foo] })
        class TestModule {}

        const mod = await Test.createTestingModule({
          imports: [TestModule],
        })
          .overrideProvider(Foo)
          .useValue(null)
          .compile();

        expect(mod.get(Foo)).toBeNull();
        expect(constructed).not.toHaveBeenCalled();
        await mod.close();
      });

      it("should support overriding a provider with useClass", async () => {
        class OriginalService {}
        @ModuleDecorator({
          providers: [{ provide: "SERVICE", useClass: OriginalService }],
        })
        class TestModule {}

        class MockService {}

        const mod = await Test.createTestingModule({
          imports: [TestModule],
        })
          .overrideProvider("SERVICE")
          .useClass(MockService)
          .compile();

        expect(mod.get("SERVICE")).toBeInstanceOf(MockService);
        await mod.close();
      });

      it("should support overriding a request-scoped provider with useClass", async () => {
        @Injectable({ scope: Scope.REQUEST })
        class OriginalService {}

        @ModuleDecorator({
          providers: [{ provide: "SERVICE", useClass: OriginalService }],
        })
        class TestModule {}

        class MockService {}

        const mod = await Test.createTestingModule({
          imports: [TestModule],
        })
          .overrideProvider("SERVICE")
          .useClass(MockService)
          .compile();

        expect(mod.get("SERVICE")).toBeInstanceOf(MockService);
        await mod.close();
      });

      it("should take the scope of the class that overrides a provider", async () => {
        class OriginalService {}
        @ModuleDecorator({
          providers: [{ provide: "SERVICE", useClass: OriginalService }],
        })
        class TestModule {}

        @Injectable({ scope: Scope.REQUEST })
        class MockService {}

        const mod = await Test.createTestingModule({
          imports: [TestModule],
        })
          .overrideProvider("SERVICE")
          .useClass(MockService)
          .compile();

        expect(() => mod.get("SERVICE")).toThrow();
        const [first, second] = await Promise.all([
          mod.resolve("SERVICE"),
          mod.resolve("SERVICE"),
        ]);
        expect(first).toBeInstanceOf(MockService);
        expect(first).not.toBe(second);
        await mod.close();
      });

      it("should support overriding a value provider with useClass", async () => {
        @ModuleDecorator({
          providers: [{ provide: "SERVICE", useValue: "real-service" }],
        })
        class TestModule {}

        class MockService {}

        const mod = await Test.createTestingModule({
          imports: [TestModule],
        })
          .overrideProvider("SERVICE")
          .useClass(MockService)
          .compile();

        expect(mod.get("SERVICE")).toBeInstanceOf(MockService);
        await mod.close();
      });

      it("should support overriding a value provider with useFactory", async () => {
        @ModuleDecorator({
          providers: [{ provide: "SERVICE", useValue: "real-service" }],
        })
        class TestModule {}

        const mod = await Test.createTestingModule({
          imports: [TestModule],
        })
          .overrideProvider("SERVICE")
          .useFactory({ factory: () => "mock-service" })
          .compile();

        expect(mod.get("SERVICE")).toBe("mock-service");
        await mod.close();
      });

      it("should run the lifecycle hooks of the class that overrides a useExisting provider", async () => {
        const onModuleInitStub = mock(() => {});
        const onModuleDestroyStub = mock(() => {});

        class OriginalService {}

        class MockService {
          onModuleInit() {
            onModuleInitStub();
          }

          onModuleDestroy() {
            onModuleDestroyStub();
          }
        }

        @ModuleDecorator({
          providers: [
            OriginalService,
            { provide: "SERVICE", useExisting: OriginalService },
          ],
        })
        class TestModule {}

        const mod = await Test.createTestingModule({
          imports: [TestModule],
        })
          .overrideProvider("SERVICE")
          .useClass(MockService)
          .compile();

        await mod.init();
        await mod.close();

        expect(mod.get("SERVICE")).toBeInstanceOf(MockService);
        expect(onModuleInitStub).toHaveBeenCalledTimes(1);
        expect(onModuleDestroyStub).toHaveBeenCalledTimes(1);
      });

      describe("when a class is both a provider and a guard", () => {
        @Injectable()
        class AuthGuard {
          canActivate() {
            return true;
          }
        }

        @Controller("dual")
        @UseGuards(AuthGuard)
        class TestController {
          @Get()
          index() {
            return "ok";
          }
        }

        @ModuleDecorator({
          controllers: [TestController],
          providers: [AuthGuard],
        })
        class TestModule {}

        const providerMock = { canActivate: () => true };
        const guardMock = { canActivate: () => false };

        itAdapted(
          "ADR-001",
          "should apply both overrides when the provider is overridden first",
          async () => {
            const mod = await Test.createTestingModule({
              imports: [TestModule],
            })
              .overrideProvider(AuthGuard)
              .useValue(providerMock)
              .overrideGuard(AuthGuard)
              .useValue(guardMock)
              .compile();

            const app = mod.createNestApplication();
            await app.init();

            expect(mod.get(AuthGuard)).toBe(providerMock);
            await request(app).get("/dual").expect(403);
            await mod.close();
          },
        );

        itAdapted(
          "ADR-001",
          "should apply both overrides when the guard is overridden first",
          async () => {
            const mod = await Test.createTestingModule({
              imports: [TestModule],
            })
              .overrideGuard(AuthGuard)
              .useValue(guardMock)
              .overrideProvider(AuthGuard)
              .useValue(providerMock)
              .compile();

            const app = mod.createNestApplication();
            await app.init();

            expect(mod.get(AuthGuard)).toBe(providerMock);
            await request(app).get("/dual").expect(403);
            await mod.close();
          },
        );
      });

      it("should use mocker for unresolved providers", async () => {
        @Injectable()
        class MissingDepClass {}

        @Injectable()
        class NeedsMissing {
          constructor(public readonly dep: MissingDepClass) {}
        }

        @ModuleDecorator({ providers: [NeedsMissing] })
        class TestModule {}

        const mod = await Test.createTestingModule({
          imports: [TestModule],
        })
          .useMocker((token) => {
            if (token === MissingDepClass) {
              return { mockValue: "mocked-dep" };
            }
            return undefined;
          })
          .compile();

        expect(mod.get(NeedsMissing).dep).toEqual({
          mockValue: "mocked-dep",
        } as unknown as MissingDepClass);
        await mod.close();
      });

      it("should use mocker for unresolved dependencies of request-scoped providers", async () => {
        @Injectable()
        class MissingDepClass {}

        @Injectable({ scope: Scope.REQUEST })
        class NeedsMissing {
          constructor(public readonly dep: MissingDepClass) {}
        }

        const mod = await Test.createTestingModule({
          providers: [NeedsMissing],
        })
          .useMocker(() => ({ mockValue: "mocked-dep" }))
          .compile();

        const instance = await mod.resolve(NeedsMissing);
        expect(instance.dep).toEqual({
          mockValue: "mocked-dep",
        } as unknown as MissingDepClass);
        await mod.close();
      });

      it("should use mocker for unresolved dependencies of transient providers used by request-scoped providers", async () => {
        @Injectable()
        class MissingDepClass {}

        @Injectable({ scope: Scope.TRANSIENT })
        class NeedsMissing {
          constructor(public readonly dep: MissingDepClass) {}
        }

        @Injectable({ scope: Scope.REQUEST })
        class Consumer {
          constructor(public readonly transient: NeedsMissing) {}
        }

        const mod = await Test.createTestingModule({
          providers: [Consumer, NeedsMissing],
        })
          .useMocker(() => ({ mockValue: "mocked-dep" }))
          .compile();

        const instance = await mod.resolve(Consumer);
        expect(instance.transient.dep).toEqual({
          mockValue: "mocked-dep",
        } as unknown as MissingDepClass);
        await mod.close();
      });

      it("should use mocker for unresolved properties of request-scoped providers", async () => {
        @Injectable()
        class MissingDepClass {}

        @Injectable({ scope: Scope.REQUEST })
        class NeedsMissing {
          @Inject(MissingDepClass)
          public readonly dep!: MissingDepClass;
        }

        const mod = await Test.createTestingModule({
          providers: [NeedsMissing],
        })
          .useMocker(() => ({ mockValue: "mocked-dep" }))
          .compile();

        const instance = await mod.resolve(NeedsMissing);
        expect(instance.dep).toEqual({
          mockValue: "mocked-dep",
        } as unknown as MissingDepClass);
        await mod.close();
      });

      it("should use mocker for unresolved properties of transient providers used by request-scoped providers", async () => {
        @Injectable()
        class MissingDepClass {}

        @Injectable({ scope: Scope.TRANSIENT })
        class NeedsMissing {
          @Inject(MissingDepClass)
          public readonly dep!: MissingDepClass;
        }

        @Injectable({ scope: Scope.REQUEST })
        class Consumer {
          constructor(public readonly transient: NeedsMissing) {}
        }

        const mod = await Test.createTestingModule({
          providers: [Consumer, NeedsMissing],
        })
          .useMocker(() => ({ mockValue: "mocked-dep" }))
          .compile();

        const instance = await mod.resolve(Consumer);
        expect(instance.transient.dep).toEqual({
          mockValue: "mocked-dep",
        } as unknown as MissingDepClass);
        await mod.close();
      });

      it("should not create extra transient instances when a mocker is set", async () => {
        let created = 0;

        @Injectable({ scope: Scope.TRANSIENT })
        class NestedTransient {
          constructor() {
            created++;
          }
        }

        @Injectable({ scope: Scope.TRANSIENT })
        class TransientService {
          constructor(public readonly nested: NestedTransient) {}
        }

        @Injectable()
        class ConsumerA {
          constructor(public readonly transient: TransientService) {}
        }

        @Injectable()
        class ConsumerB {
          constructor(public readonly transient: TransientService) {}
        }

        const mod = await Test.createTestingModule({
          providers: [ConsumerA, ConsumerB, TransientService, NestedTransient],
        })
          .useMocker(() => undefined)
          .compile();

        expect(created).toBe(2);
        await mod.close();
      });

      it("should use mocker for unresolved dependencies of request-scoped factory providers", async () => {
        @Injectable()
        class MissingDepClass {}

        const mod = await Test.createTestingModule({
          providers: [
            {
              provide: "NEEDS_MISSING",
              useFactory: (dep: MissingDepClass) => ({ dep }),
              inject: [MissingDepClass],
              scope: Scope.REQUEST,
            },
          ],
        })
          .useMocker(() => ({ mockValue: "mocked-dep" }))
          .compile();

        const instance = await mod.resolve<{ dep: unknown }>("NEEDS_MISSING");
        expect(instance.dep).toEqual({ mockValue: "mocked-dep" });
        await mod.close();
      });

      itAdapted(
        "ADR-007",
        "should fail when mocker skips a dependency of a request-scoped provider",
        async () => {
          @Injectable()
          class MissingDepClass {}

          @Injectable({ scope: Scope.REQUEST })
          class NeedsMissing {
            constructor(public readonly dep: MissingDepClass) {}
          }

          await expect(
            (async () => {
              const mod = await Test.createTestingModule({
                providers: [NeedsMissing],
              })
                .useMocker(() => undefined)
                .compile();
              return mod.resolve(NeedsMissing);
            })(),
          ).rejects.toThrow();
        },
      );

      itAdapted(
        "ADR-007",
        "should fail when a request-scoped factory provider has an undefined dependency",
        async () => {
          await expect(
            (async () => {
              const mod = await Test.createTestingModule({
                providers: [
                  {
                    provide: "NEEDS_UNDEFINED",
                    useFactory: (dep: unknown) => ({ dep }),
                    inject: [undefined as unknown as string],
                    scope: Scope.REQUEST,
                  },
                ],
              })
                .useMocker(() => ({ mockValue: "mocked-dep" }))
                .compile();
              return mod.resolve("NEEDS_UNDEFINED");
            })(),
          ).rejects.toThrow();
        },
      );

      it("should use mocker for unresolved dependencies of transient providers", async () => {
        @Injectable()
        class MissingDepClass {}

        @Injectable({ scope: Scope.TRANSIENT })
        class TransientService {
          constructor(public readonly dep: MissingDepClass) {}
        }

        @Injectable()
        class NeedsTransient {
          constructor(public readonly transient: TransientService) {}
        }

        const mod = await Test.createTestingModule({
          providers: [TransientService, NeedsTransient],
        })
          .useMocker((token) =>
            token === MissingDepClass ? { mockValue: "mocked-dep" } : undefined,
          )
          .compile();

        const instance = mod.get(NeedsTransient);
        expect(instance.transient).toBeInstanceOf(TransientService);
        expect(instance.transient.dep).toEqual({
          mockValue: "mocked-dep",
        } as unknown as MissingDepClass);
        await mod.close();
      });

      it("should use mocker for unresolved properties of transient providers", async () => {
        @Injectable()
        class MissingDepClass {}

        @Injectable({ scope: Scope.TRANSIENT })
        class TransientService {
          @Inject(MissingDepClass)
          public readonly dep!: MissingDepClass;
        }

        @Injectable()
        class NeedsTransient {
          constructor(public readonly transient: TransientService) {}
        }

        const mod = await Test.createTestingModule({
          providers: [TransientService, NeedsTransient],
        })
          .useMocker((token) =>
            token === MissingDepClass ? { mockValue: "mocked-dep" } : undefined,
          )
          .compile();

        const instance = mod.get(NeedsTransient);
        expect(instance.transient).toBeInstanceOf(TransientService);
        expect(instance.transient.dep).toEqual({
          mockValue: "mocked-dep",
        } as unknown as MissingDepClass);
        await mod.close();
      });

      it("should share one mock between providers that depend on the same token", async () => {
        @Injectable()
        class MissingDepClass {}

        @Injectable()
        class FirstConsumer {
          constructor(public readonly dep: MissingDepClass) {}
        }

        @Injectable()
        class SecondConsumer {
          constructor(public readonly dep: MissingDepClass) {}
        }

        const mocker = mock(() => ({ mockValue: "mocked-dep" }));
        const mod = await Test.createTestingModule({
          providers: [FirstConsumer, SecondConsumer],
        })
          .useMocker(mocker)
          .compile();

        const mocked = mod.get(MissingDepClass);
        expect(mod.get(FirstConsumer).dep).toBe(mocked);
        expect(mod.get(SecondConsumer).dep).toBe(mocked);
        expect(mocker).toHaveBeenCalledTimes(1);
        await mod.close();
      });

      it("should support compiling with snapshot option", async () => {
        @ModuleDecorator({})
        class TestModule {}

        const mod = await Test.createTestingModule({
          imports: [TestModule],
        }).compile({ snapshot: true });

        expect(mod).toBeInstanceOf(TestingModule);
        await mod.close();
      });

      it("should support compiling with preview option", async () => {
        @ModuleDecorator({})
        class TestModule {}

        const mod = await Test.createTestingModule({
          imports: [TestModule],
        }).compile({ preview: true });

        expect(mod).toBeInstanceOf(TestingModule);
        await mod.close();
      });
    });
  },
);
