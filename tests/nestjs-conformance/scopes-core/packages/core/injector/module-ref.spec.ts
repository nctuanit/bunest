import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import {
  Inject,
  Injectable,
  Module,
  REQUEST,
  Scope,
} from "../../../../../../packages/common/src";
import {
  ModuleRef,
  UnknownDependencyException,
  createContextId,
} from "../../../../../../packages/core/src";
import {
  Test,
  describeConformance,
  expectScopeLeak,
  itAdapted,
} from "../../../../_helpers";

describeConformance(
  "ModuleRef",
  {
    upstreamPath: "packages/core/test/injector/module-ref.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-007", "ADR-012"],
    notes:
      "Adapted from NestJS internal ConcreteModuleRef/InstanceWrapper assertions to Bunest public ModuleRef + Test.createTestingModule, including ADR-012 ScopeLeakException verification.",
  },
  () => {
    describe("introspect", () => {
      it("should return Scope.DEFAULT for a static provider", async () => {
        @Injectable()
        class StaticService {}

        const testingModule = await Test.createTestingModule({
          providers: [StaticService],
        }).compile();
        const moduleRef = testingModule.get(ModuleRef);

        const result = moduleRef.introspect(StaticService);
        expect(result.scope).toBe(Scope.DEFAULT);
      });

      it("should return Scope.REQUEST for a request-scoped provider", async () => {
        @Injectable({ scope: Scope.REQUEST })
        class ReqScopedService {}

        const testingModule = await Test.createTestingModule({
          providers: [ReqScopedService],
        }).compile();
        const moduleRef = testingModule.get(ModuleRef);

        const result = moduleRef.introspect(ReqScopedService);
        expect(result.scope).toBe(Scope.REQUEST);
      });

      it("should return Scope.TRANSIENT for a transient provider", async () => {
        @Injectable({ scope: Scope.TRANSIENT })
        class TransientService {}

        const testingModule = await Test.createTestingModule({
          providers: [TransientService],
        }).compile();
        const moduleRef = testingModule.get(ModuleRef);

        const result = moduleRef.introspect(TransientService);
        expect(result.scope).toBe(Scope.TRANSIENT);
      });
    });

    describe("registerRequestByContextId", () => {
      it("should register a request object resolvable via REQUEST token for contextId", async () => {
        @Injectable({ scope: Scope.REQUEST })
        class ReqConsumer {
          constructor(@Inject(REQUEST) public readonly req: unknown) {}
        }

        const testingModule = await Test.createTestingModule({
          providers: [ReqConsumer],
        }).compile();
        const moduleRef = testingModule.get(ModuleRef);

        const request = { foo: "bar" };
        const contextId = { id: 42 };
        moduleRef.registerRequestByContextId(request, contextId);

        const resolved = await moduleRef.resolve(ReqConsumer, contextId);
        expect(resolved.req).toBe(request);
      });
    });

    describe("instantiateClass (create)", () => {
      it("should create an instance with resolved dependencies", async () => {
        @Injectable()
        class A {}
        @Injectable()
        class B {}

        @Injectable()
        class Foo {
          constructor(
            public a: A,
            public b: B,
          ) {}
        }

        const testingModule = await Test.createTestingModule({
          providers: [A, B],
        }).compile();
        const moduleRef = testingModule.get(ModuleRef);

        const instance = await moduleRef.create(Foo);
        expect(instance).toBeInstanceOf(Foo);
        expect(instance.a).toBeInstanceOf(A);
        expect(instance.b).toBeInstanceOf(B);
      });

      it("should propagate errors from dependency resolution", async () => {
        class UnregisteredDep {}

        @Injectable()
        class MissingDep {
          constructor(_x: UnregisteredDep) {}
        }

        const testingModule = await Test.createTestingModule({}).compile();
        const moduleRef = testingModule.get(ModuleRef);

        await expect(moduleRef.create(MissingDep)).rejects.toBeInstanceOf(
          UnknownDependencyException,
        );
      });

      describe("when snapshot mode is enabled", () => {
        it("should allow repeated moduleRef.create() calls without mutating graph", async () => {
          @Injectable()
          class Foo {}

          const testingModule = await Test.createTestingModule({}).compile({
            snapshot: true,
          });
          const moduleRef = testingModule.get(ModuleRef);

          const a = await moduleRef.create(Foo);
          const b = await moduleRef.create(Foo);

          expect(a).toBeInstanceOf(Foo);
          expect(b).toBeInstanceOf(Foo);
          expect(a).not.toBe(b);
        });
      });

      describe("when the created class has transient dependencies", () => {
        @Injectable()
        class SingletonDep {}

        @Injectable({ scope: Scope.TRANSIENT })
        class NestedTransientDep {
          static count = 0;
          readonly id = ++NestedTransientDep.count;
        }

        @Injectable({ scope: Scope.TRANSIENT })
        class TransientDep {
          static count = 0;
          readonly id = ++TransientDep.count;
          constructor(public nested: NestedTransientDep) {}
        }

        it("should create fresh transient instances on each create() without caching them", async () => {
          NestedTransientDep.count = 0;
          TransientDep.count = 0;

          @Injectable()
          class Created {
            constructor(public dep: TransientDep) {}
          }

          const testingModule = await Test.createTestingModule({
            providers: [SingletonDep, TransientDep, NestedTransientDep],
          }).compile();
          const moduleRef = testingModule.get(ModuleRef);

          const first = await moduleRef.create(Created);
          const second = await moduleRef.create(Created);

          expect(first.dep).not.toBe(second.dep);
          expect(first.dep.nested).not.toBe(second.dep.nested);
          expect(TransientDep.count).toBe(2);
          expect(NestedTransientDep.count).toBe(2);
        });

        it("should inject fresh transient instances into properties", async () => {
          @Injectable()
          class Created {
            @Inject(TransientDep)
            public dep!: TransientDep;
          }

          const testingModule = await Test.createTestingModule({
            providers: [SingletonDep, TransientDep, NestedTransientDep],
          }).compile();
          const moduleRef = testingModule.get(ModuleRef);

          const first = await moduleRef.create(Created);
          const second = await moduleRef.create(Created);

          expect(first.dep).toBeInstanceOf(TransientDep);
          expect(first.dep.nested).toBeInstanceOf(NestedTransientDep);
          expect(first.dep).not.toBe(second.dep);
        });

        it("should share singleton dependencies across created instances without corrupting singleton state", async () => {
          @Injectable()
          class Created {
            constructor(public dep: SingletonDep) {}
          }

          const testingModule = await Test.createTestingModule({
            providers: [SingletonDep],
          }).compile();
          const moduleRef = testingModule.get(ModuleRef);

          const singleton = moduleRef.get(SingletonDep);
          const first = await moduleRef.create(Created);
          const second = await moduleRef.create(Created);

          expect(first.dep).toBe(singleton);
          expect(second.dep).toBe(singleton);
        });

        it("should reject cleanly when a constructor dependency is missing without corrupting singletons", async () => {
          class UnregisteredDep {}

          @Injectable()
          class Created {
            constructor(
              public dep: SingletonDep,
              _missing: UnregisteredDep,
            ) {}
          }

          const testingModule = await Test.createTestingModule({
            providers: [SingletonDep],
          }).compile();
          const moduleRef = testingModule.get(ModuleRef);

          await expect(moduleRef.create(Created)).rejects.toBeInstanceOf(
            UnknownDependencyException,
          );
          expect(moduleRef.get(SingletonDep)).toBeInstanceOf(SingletonDep);
        });

        it("should reject cleanly when a transient dependency is paired with a missing dependency", async () => {
          class UnregisteredDep {}

          @Injectable()
          class Created {
            constructor(
              public dep: TransientDep,
              _missing: UnregisteredDep,
            ) {}
          }

          const testingModule = await Test.createTestingModule({
            providers: [TransientDep, NestedTransientDep],
          }).compile();
          const moduleRef = testingModule.get(ModuleRef);

          await expect(moduleRef.create(Created)).rejects.toBeInstanceOf(
            UnknownDependencyException,
          );
        });

        it("should propagate errors when a request-scoped dependency throws during create()", async () => {
          @Injectable({ scope: Scope.REQUEST })
          class FailingDep {
            constructor() {
              throw new Error("failing");
            }
          }

          @Injectable()
          class Created {
            constructor(
              _failing: FailingDep,
              public dep: TransientDep,
            ) {}
          }

          const testingModule = await Test.createTestingModule({
            providers: [FailingDep, TransientDep, NestedTransientDep],
          }).compile();
          const moduleRef = testingModule.get(ModuleRef);

          const contextId = createContextId();
          await expect(moduleRef.create(Created, contextId)).rejects.toThrow(
            "failing",
          );
        });

        it("should reject when an injected property dependency is missing", async () => {
          class UnregisteredDep {}

          @Injectable()
          class Created {
            @Inject(TransientDep)
            public dep!: TransientDep;
            @Inject(UnregisteredDep)
            public missing!: UnregisteredDep;
          }

          const testingModule = await Test.createTestingModule({
            providers: [TransientDep, NestedTransientDep],
          }).compile();
          const moduleRef = testingModule.get(ModuleRef);

          await expect(moduleRef.create(Created)).rejects.toBeInstanceOf(
            UnknownDependencyException,
          );
        });

        describe("when a dependency of a transient dependency fails", () => {
          @Injectable({ scope: Scope.REQUEST })
          class FailingDep {
            constructor() {
              throw new Error("failing");
            }
          }

          @Injectable({ scope: Scope.TRANSIENT })
          class OuterTransientDep {
            constructor(public dep: TransientDep) {}
          }

          @Injectable({ scope: Scope.TRANSIENT })
          class HostWithParams {
            constructor(
              _failing: FailingDep,
              public dep: OuterTransientDep,
            ) {}
          }

          @Injectable({ scope: Scope.TRANSIENT })
          class HostWithProperties {
            @Inject(FailingDep)
            public failing!: FailingDep;
            @Inject(OuterTransientDep)
            public dep!: OuterTransientDep;
          }

          it("should propagate failure repeatedly for constructor-parameter transient hosts", async () => {
            @Injectable()
            class Created {
              constructor(@Inject(HostWithParams) public host: unknown) {}
            }

            const testingModule = await Test.createTestingModule({
              providers: [
                FailingDep,
                NestedTransientDep,
                TransientDep,
                OuterTransientDep,
                HostWithParams,
              ],
            }).compile();
            const moduleRef = testingModule.get(ModuleRef);

            for (const contextId of [createContextId(), createContextId()]) {
              await expect(
                moduleRef.create(Created, contextId),
              ).rejects.toThrow("failing");
            }
          });

          it("should propagate failure repeatedly for property-injected transient hosts", async () => {
            @Injectable()
            class Created {
              constructor(@Inject(HostWithProperties) public host: unknown) {}
            }

            const testingModule = await Test.createTestingModule({
              providers: [
                FailingDep,
                NestedTransientDep,
                TransientDep,
                OuterTransientDep,
                HostWithProperties,
              ],
            }).compile();
            const moduleRef = testingModule.get(ModuleRef);

            for (const contextId of [createContextId(), createContextId()]) {
              await expect(
                moduleRef.create(Created, contextId),
              ).rejects.toThrow("failing");
            }
          });
        });
      });

      describe("when a dependency is request-scoped", () => {
        @Injectable({ scope: Scope.REQUEST })
        class RequestDep {}

        @Injectable()
        class Created {
          constructor(public dep: RequestDep) {}
        }

        it("should reject without a context id", async () => {
          const testingModule = await Test.createTestingModule({
            providers: [RequestDep],
          }).compile();
          const moduleRef = testingModule.get(ModuleRef);

          await expect(moduleRef.create(Created)).rejects.toThrow();
        });

        it("should resolve with a context id", async () => {
          const testingModule = await Test.createTestingModule({
            providers: [RequestDep],
          }).compile();
          const moduleRef = testingModule.get(ModuleRef);

          const instance = await moduleRef.create(Created, createContextId());
          expect(instance.dep).toBeInstanceOf(RequestDep);
        });

        describe("and it is injected into a property", () => {
          @Injectable()
          class CreatedWithProperty {
            @Inject(RequestDep)
            public dep!: RequestDep;
          }

          it("should reject without a context id", async () => {
            const testingModule = await Test.createTestingModule({
              providers: [RequestDep],
            }).compile();
            const moduleRef = testingModule.get(ModuleRef);

            await expect(
              moduleRef.create(CreatedWithProperty),
            ).rejects.toThrow();
          });

          it("should resolve distinct instances with distinct context ids", async () => {
            const testingModule = await Test.createTestingModule({
              providers: [RequestDep],
            }).compile();
            const moduleRef = testingModule.get(ModuleRef);

            const first = await moduleRef.create(
              CreatedWithProperty,
              createContextId(),
            );
            const second = await moduleRef.create(
              CreatedWithProperty,
              createContextId(),
            );

            expect(first.dep).toBeInstanceOf(RequestDep);
            expect(second.dep).toBeInstanceOf(RequestDep);
            expect(first.dep).not.toBe(second.dep);
          });
        });

        describe("and it is injected into a property of a dependency", () => {
          itAdapted(
            "ADR-012",
            "should fail fast with ScopeLeakException when a singleton dependency property-injects a request-scoped provider",
            async () => {
              @Injectable()
              class StaticDep {
                @Inject(RequestDep)
                public dep!: RequestDep;
              }

              await expectScopeLeak(() =>
                Test.createTestingModule({
                  providers: [RequestDep, StaticDep],
                }).compile(),
              );
            },
          );

          itAdapted(
            "ADR-012",
            "should reject without a context id and resolve with a context id when intermediate dep is explicitly Scope.REQUEST",
            async () => {
              @Injectable({ scope: Scope.REQUEST })
              class ExplicitRequestDep {
                @Inject(RequestDep)
                public dep!: RequestDep;
              }

              @Injectable()
              class CreatedWithNestedProperty {
                constructor(public dep: ExplicitRequestDep) {}
              }

              const testingModule = await Test.createTestingModule({
                providers: [RequestDep, ExplicitRequestDep],
              }).compile();
              const moduleRef = testingModule.get(ModuleRef);

              await expect(
                moduleRef.create(CreatedWithNestedProperty),
              ).rejects.toThrow();

              const instance = await moduleRef.create(
                CreatedWithNestedProperty,
                createContextId(),
              );
              expect(instance.dep).toBeInstanceOf(ExplicitRequestDep);
              expect(instance.dep.dep).toBeInstanceOf(RequestDep);
            },
          );
        });
      });

      it("should create a request-scoped class without a context id when its dependencies are static", async () => {
        @Injectable()
        class SingletonDep {}

        @Injectable({ scope: Scope.REQUEST })
        class Created {
          @Inject(SingletonDep)
          public dep!: SingletonDep;

          constructor(public ctorDep: SingletonDep) {}
        }

        const testingModule = await Test.createTestingModule({
          providers: [SingletonDep],
        }).compile();
        const moduleRef = testingModule.get(ModuleRef);

        const instance = await moduleRef.create(Created);

        expect(instance).toBeInstanceOf(Created);
        expect(instance.dep).toBeInstanceOf(SingletonDep);
        expect(instance.ctorDep).toBe(instance.dep);
      });
    });

    describe("find (get)", () => {
      it("should retrieve a static provider instance", async () => {
        @Injectable()
        class MyService {}

        const testingModule = await Test.createTestingModule({
          providers: [MyService],
        }).compile();
        const moduleRef = testingModule.get(ModuleRef);

        const instance = moduleRef.get(MyService);
        expect(instance).toBeInstanceOf(MyService);
      });

      it("should throw for request-scoped provider", async () => {
        @Injectable({ scope: Scope.REQUEST })
        class ReqService {}

        const testingModule = await Test.createTestingModule({
          providers: [ReqService],
        }).compile();
        const moduleRef = testingModule.get(ModuleRef);

        expect(() => moduleRef.get(ReqService)).toThrow();
      });

      it("should return all instances when each: true (strict: false)", async () => {
        @Injectable()
        class ServiceA {}
        @Injectable()
        class ServiceB {}
        @Injectable()
        class ServiceC {}
        const TOKEN = "MULTI";

        @Module({ providers: [{ provide: TOKEN, useClass: ServiceA }] })
        class ModA {}

        @Module({ providers: [{ provide: TOKEN, useClass: ServiceB }] })
        class ModB {}

        const testingModule = await Test.createTestingModule({
          imports: [ModA, ModB],
          providers: [{ provide: TOKEN, useClass: ServiceC }],
        }).compile();
        const moduleRef = testingModule.get(ModuleRef);

        const instances = moduleRef.get(TOKEN, { strict: false, each: true });
        expect(instances).toHaveLength(3);
      });
    });

    describe("resolve", () => {
      it("should resolve a static dependency", async () => {
        @Injectable()
        class MyService {}

        const testingModule = await Test.createTestingModule({
          providers: [MyService],
        }).compile();
        const moduleRef = testingModule.get(ModuleRef);

        const instance = await moduleRef.resolve(MyService);
        expect(instance).toBeInstanceOf(MyService);
      });

      it("should resolve a transient dependency, returning new instances each time", async () => {
        @Injectable({ scope: Scope.TRANSIENT })
        class TransientService {}

        const testingModule = await Test.createTestingModule({
          providers: [TransientService],
        }).compile();
        const moduleRef = testingModule.get(ModuleRef);

        const a = await moduleRef.resolve(TransientService, { id: 1 });
        const b = await moduleRef.resolve(TransientService, { id: 2 });
        expect(a).toBeInstanceOf(TransientService);
        expect(b).toBeInstanceOf(TransientService);
        expect(a).not.toBe(b);
      });

      it("should resolve a request-scoped dependency", async () => {
        @Injectable({ scope: Scope.REQUEST })
        class ReqService {}

        const testingModule = await Test.createTestingModule({
          providers: [ReqService],
        }).compile();
        const moduleRef = testingModule.get(ModuleRef);

        const contextId = { id: 99 };
        const instance = await moduleRef.resolve(ReqService, contextId);
        expect(instance).toBeInstanceOf(ReqService);
      });
    });
  },
);
