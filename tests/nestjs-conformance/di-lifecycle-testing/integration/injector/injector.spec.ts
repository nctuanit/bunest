import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import {
  Global,
  Inject,
  Injectable,
  Module,
  Scope,
  forwardRef,
  type DynamicModule,
  type Type,
} from "../../../../../packages/common/src";
import {
  CircularDependencyException,
  CoreBootstrapException,
  InvalidExportException,
  ModuleRef,
  NestFactory,
  UnknownDependencyException,
} from "../../../../../packages/core/src";
import {
  Test,
  describeConformance,
  expectScopeLeak,
  itAdapted,
} from "../../../_helpers";

// Fixture: dynamic module
const DYNAMIC_TOKEN = "DYNAMIC_TOKEN";
const DYNAMIC_VALUE = {};
const dynamicProvider = {
  provide: DYNAMIC_TOKEN,
  useValue: DYNAMIC_VALUE,
};

@Module({})
class NestDynamicModule {
  static byObject(): DynamicModule {
    return {
      module: NestDynamicModule,
      providers: [dynamicProvider],
      exports: [dynamicProvider],
    };
  }

  static byName(): DynamicModule {
    return {
      module: NestDynamicModule,
      providers: [dynamicProvider],
      exports: [DYNAMIC_TOKEN],
    };
  }
}

// Fixture: inconsistent exports
@Injectable()
class ExportsService {}

@Module({
  exports: [ExportsService],
})
class ExportsModule {}

// Fixture: inject same name as class
@Injectable()
class SameNameCoreService {
  constructor(
    @Inject(SameNameCoreService.name) public readonly coreService: unknown,
  ) {}
}

@Module({
  providers: [
    {
      provide: SameNameCoreService.name,
      useValue: "anything",
    },
  ],
})
class InjectSameNameModule {}

// Fixture: missing dependency
@Injectable()
class MissingCoreService {}

@Injectable()
class InjectService {
  constructor(public readonly coreService: MissingCoreService) {}
}

@Module({
  providers: [InjectService],
})
class InjectModule {}

// Fixture: self-injection providers
@Injectable()
class ServiceInjectingItself {
  constructor(public readonly coreService: ServiceInjectingItself) {}
}

@Injectable()
class ServiceInjectingItselfForward {
  constructor(
    @Inject(forwardRef(() => ServiceInjectingItself))
    public readonly coreService: ServiceInjectingItself,
  ) {}
}

@Injectable()
class ServiceInjectingItselfViaCustomToken {
  constructor(@Inject("AnotherToken") public readonly coreService: unknown) {}
}

@Module({
  providers: [ServiceInjectingItself],
})
class SelfInjectionProviderModule {}

@Module({
  providers: [ServiceInjectingItselfForward],
})
class SelfInjectionForwardProviderModule {}

@Module({
  providers: [
    ServiceInjectingItselfViaCustomToken,
    {
      provide: "AnotherToken",
      useClass: ServiceInjectingItselfViaCustomToken,
    },
  ],
})
class SelfInjectionProviderCustomTokenModule {}

describeConformance(
  "Injector",
  {
    upstreamPath: "integration/injector/e2e/injector.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-012"],
    notes:
      "Adapts NestJS scope-bubbling scenarios to Bunest ADR-012 fail-fast ScopeLeakException + explicit Scope.REQUEST opt-in, and maps NestJS UnknownExportException/UnknownDependenciesException to InvalidExportException/UnknownDependencyException.",
  },
  () => {
    describe("when the same provider class is declared in multiple modules", () => {
      itAdapted(
        "ADR-012",
        "should reject singleton->request leak and bootstrap when module-local provider instances explicitly declare Scope.REQUEST",
        async () => {
          @Injectable()
          class FirstGlobalDependency {}

          @Injectable()
          class SecondGlobalDependency {}

          @Injectable({ scope: Scope.REQUEST })
          class RequestScopedDependency {}

          @Global()
          @Module({
            providers: [FirstGlobalDependency, SecondGlobalDependency],
            exports: [FirstGlobalDependency, SecondGlobalDependency],
          })
          class GlobalDepsModule {}

          @Injectable()
          class LeakingSharedService {
            constructor(
              public readonly firstDependency: FirstGlobalDependency,
              public readonly secondDependency: SecondGlobalDependency,
              public readonly requestScopedDependency: RequestScopedDependency,
            ) {}
          }

          @Module({
            providers: [LeakingSharedService, RequestScopedDependency],
            exports: [LeakingSharedService],
          })
          class LeakingModuleA {}

          @Module({
            imports: [GlobalDepsModule, LeakingModuleA],
          })
          class LeakingAppModule {}

          await expectScopeLeak(() =>
            NestFactory.create(LeakingAppModule, { logger: false }),
          );

          @Injectable({ scope: Scope.REQUEST })
          class SharedService {
            constructor(
              public readonly firstDependency: FirstGlobalDependency,
              public readonly secondDependency: SecondGlobalDependency,
              public readonly requestScopedDependency: RequestScopedDependency,
            ) {}
          }

          @Module({
            providers: [SharedService, RequestScopedDependency],
            exports: [SharedService],
          })
          class ModuleA {}

          @Module({
            providers: [SharedService, RequestScopedDependency],
          })
          class ModuleB {}

          @Module({
            imports: [GlobalDepsModule, ModuleA, ModuleB],
          })
          class AppModule {}

          let timeout: ReturnType<typeof setTimeout> | undefined;
          const app = await Promise.race([
            NestFactory.create(AppModule, { logger: false }),
            new Promise<never>((_, reject) => {
              timeout = setTimeout(
                () => reject(new Error("Application initialization timed out")),
                1000,
              );
            }),
          ]);
          clearTimeout(timeout);

          await app.close();
        },
      );

      itAdapted(
        "ADR-012",
        "should detect request-scoped factory chains across deep wrapper modules (fail-fast when singleton, Scope.REQUEST when declared)",
        async () => {
          @Injectable({ scope: Scope.REQUEST })
          class RequestScopedDependency {}

          @Global()
          @Module({
            providers: [RequestScopedDependency],
            exports: [RequestScopedDependency],
          })
          class GlobalDependencyModule {}

          class RepositoryA {}
          class RepositoryB {}

          const buildApp = (explicitRequestScope: boolean) => {
            const scope = explicitRequestScope ? Scope.REQUEST : Scope.SINGLETON;

            const repositoryAProvider = {
              provide: RepositoryA,
              scope,
              useFactory: (_dependency: RequestScopedDependency) =>
                new RepositoryA(),
              inject: [RequestScopedDependency],
            };
            const repositoryBProvider = {
              provide: RepositoryB,
              scope,
              useFactory: (_dependency: RequestScopedDependency) =>
                new RepositoryB(),
              inject: [RequestScopedDependency],
            };

            @Module({
              providers: [repositoryAProvider, repositoryBProvider],
              exports: [RepositoryA, RepositoryB],
            })
            class RepositoryModule {}

            const buildWrapperChain = (depth: number): Type<unknown> => {
              let inner: Type<unknown> = RepositoryModule;
              for (let index = 0; index < depth; index++) {
                @Module({ imports: [inner], exports: [inner] })
                class WrapperModule {}

                Object.defineProperty(WrapperModule, "name", {
                  value: `RepositoryWrapper_${index}`,
                });
                inner = WrapperModule;
              }
              return inner;
            };

            const RepositoryWrapperModule = buildWrapperChain(6);

            @Global()
            @Module({
              imports: [GlobalDependencyModule, RepositoryWrapperModule],
              exports: [RepositoryWrapperModule],
            })
            class GlobalRepositoryModule {}

            @Injectable({ scope })
            class ConsumerService {
              constructor(
                public readonly repositoryA: RepositoryA,
                public readonly repositoryB: RepositoryB,
              ) {}
            }

            const helpers: Type<unknown>[] = [];
            for (let index = 0; index < 30; index++) {
              @Injectable()
              class Helper {}

              Object.defineProperty(Helper, "name", {
                value: `Helper_${index}`,
              });
              helpers.push(Helper);
            }

            const helperToken = (index: number) => `HELPER_${index}`;
            const helperAliases = helpers.map((helper, index) => ({
              provide: helperToken(index),
              useExisting: helper,
            }));

            const siblings: Type<unknown>[] = [];
            for (let index = 0; index < 20; index++) {
              @Injectable({ scope })
              class Sibling {
                constructor(
                  @Inject(ConsumerService)
                  public readonly consumer: ConsumerService,
                  @Inject(helperToken(index % helpers.length))
                  public readonly helper: unknown,
                ) {}
              }

              Object.defineProperty(Sibling, "name", {
                value: `Sibling_${index}`,
              });
              siblings.push(Sibling);
            }

            @Module({
              providers: [
                ConsumerService,
                ...helpers,
                ...helperAliases,
                ...siblings,
              ],
            })
            class ConsumerModule {}

            @Module({ imports: [GlobalRepositoryModule, ConsumerModule] })
            class AppModule {}

            return { AppModule, ConsumerService };
          };

          const leaking = buildApp(false);
          await expectScopeLeak(() =>
            NestFactory.createApplicationContext(leaking.AppModule, {
              logger: false,
            }),
          );

          const valid = buildApp(true);
          const app = await NestFactory.createApplicationContext(
            valid.AppModule,
            { logger: false },
          );
          const introspection = app
            .get(ModuleRef)
            .introspect(valid.ConsumerService);
          await app.close();

          expect(introspection.scope).toBe(Scope.REQUEST);
        },
      );
    });

    describe('when "providers" and "exports" properties are inconsistent', () => {
      it('should fail with "InvalidExportException"', async () => {
        const builder = Test.createTestingModule({
          imports: [ExportsModule],
        });
        await expect(builder.compile()).rejects.toBeInstanceOf(
          InvalidExportException,
        );
      });
    });

    describe("When class injects a provider with the same as class's name", () => {
      it("should compile with success", async () => {
        const builder = Test.createTestingModule({
          imports: [InjectSameNameModule],
        });

        const mod = await builder.compile();
        expect(mod).toBeDefined();
        await mod.close();
      });
    });

    describe("when Nest cannot resolve dependencies", () => {
      it('should fail with "CoreBootstrapException"', async () => {
        const builder = Test.createTestingModule({
          imports: [InjectModule],
        });
        await expect(builder.compile()).rejects.toBeInstanceOf(
          CoreBootstrapException,
        );
      });

      describe("due to self-injection providers", () => {
        it("should fail due to self-injection via same class reference", async () => {
          const builder = Test.createTestingModule({
            imports: [SelfInjectionProviderModule],
          });

          await expect(builder.compile()).rejects.toBeInstanceOf(
            CircularDependencyException,
          );
        });

        it("should fail due to self-injection via forwardRef to the same class reference", async () => {
          const builder = Test.createTestingModule({
            imports: [SelfInjectionForwardProviderModule],
          });

          await expect(builder.compile()).rejects.toBeInstanceOf(
            UnknownDependencyException,
          );
        });

        it("should fail due to self-injection via custom provider", async () => {
          const builder = Test.createTestingModule({
            imports: [SelfInjectionProviderCustomTokenModule],
          });

          await expect(builder.compile()).rejects.toBeInstanceOf(
            CircularDependencyException,
          );
        });
      });
    });

    describe("when dynamic module", () => {
      it("should return provider via token (exported by object)", async () => {
        const builder = Test.createTestingModule({
          imports: [NestDynamicModule.byObject()],
        });
        const app = await builder.compile();
        expect(app.get(DYNAMIC_TOKEN)).toEqual(DYNAMIC_VALUE);
        await app.close();
      });

      it("should return provider via token (exported by token)", async () => {
        const builder = Test.createTestingModule({
          imports: [NestDynamicModule.byName()],
        });
        const app = await builder.compile();
        expect(app.get(DYNAMIC_TOKEN)).toEqual(DYNAMIC_VALUE);
        await app.close();
      });
    });
  },
);
