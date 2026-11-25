import { beforeEach, describe, expect, it } from "bun:test";
import {
  Global,
  Inject,
  Injectable,
  Module,
  Scope,
  UseInterceptors,
  type CallHandler,
  type DynamicModule,
  type ExecutionContext,
  type NestInterceptor,
  type Type,
} from "../../../../../../../packages/core/src/common";
import {
  DiscoveryService,
  LazyModuleLoader,
  ModuleRef,
  ModulesContainer,
} from "../../../../../../../packages/core/src";
import { Test, describeConformance } from "../../../../../_helpers";

describeConformance(
  "LazyModuleLoader",
  {
    upstreamPath:
      "packages/core/test/injector/lazy-module-loader/lazy-module-loader.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-007", "ADR-008"],
    notes:
      "Adapted from NestJS internal DependenciesScanner/InstanceLoader wiring to Bunest TestingModule + LazyModuleLoader + ModulesContainer + DiscoveryService.",
  },
  () => {
    let lazyModuleLoader: LazyModuleLoader;
    let modulesContainer: ModulesContainer;
    let discoveryService: DiscoveryService;
    let initialModuleCount: number;

    beforeEach(async () => {
      const rootRef = await Test.createTestingModule({}).compile();
      lazyModuleLoader = rootRef.get(LazyModuleLoader);
      modulesContainer = rootRef.get(ModulesContainer);
      discoveryService = rootRef.get(DiscoveryService);
      initialModuleCount = discoveryService.getModules().length;
    });

    describe("load", () => {
      const bProvider = { provide: "B", useValue: "B" };

      @Module({ providers: [bProvider], exports: [bProvider] })
      class ModuleB {}

      @Module({ imports: [ModuleB] })
      class ModuleA {}

      describe("when module was not loaded yet", () => {
        it("should load it and return a module reference", async () => {
          const moduleRef = await lazyModuleLoader.load(() => ModuleA);
          expect(moduleRef).toBeInstanceOf(ModuleRef);
          expect(moduleRef.get(bProvider.provide, { strict: false })).toBe(
            bProvider.useValue,
          );
        });
      });

      describe("when module was loaded already", () => {
        @Module({})
        class ModuleC {}

        it("should return an existing module reference", async () => {
          const moduleRef = await lazyModuleLoader.load(() => ModuleC);
          const moduleRef2 = await lazyModuleLoader.load(() => ModuleC);
          expect(moduleRef).toBe(moduleRef2);
        });
      });

      describe("when logger option is false", () => {
        @Module({})
        class ModuleWithLogA {}

        @Module({})
        class ModuleWithLogB {}

        it("should accept { logger: false } without breaking subsequent load() calls", async () => {
          const refA = await lazyModuleLoader.load(() => ModuleWithLogA, {
            logger: false,
          });
          expect(refA).toBeInstanceOf(ModuleRef);

          const refB = await lazyModuleLoader.load(() => ModuleWithLogB);
          expect(refB).toBeInstanceOf(ModuleRef);
        });
      });

      describe("when load() is called while another load() of the module is in flight", () => {
        let requestConnection: () => Promise<string>;
        let connectionRequested: Promise<void>;
        let releaseConnection: (value: string) => void;
        let constructionsCount: number;

        @Injectable()
        class ReportsService {
          constructor(@Inject("CONNECTION") readonly connection: string) {
            constructionsCount++;
          }
        }

        @Module({
          providers: [
            {
              provide: "CONNECTION",
              useFactory: () => requestConnection(),
            },
            ReportsService,
          ],
          exports: [ReportsService],
        })
        class ReportsModule {}

        @Module({ imports: [ReportsModule] })
        class DashboardModule {}

        const loadReportsService = () =>
          lazyModuleLoader
            .load(() => ReportsModule)
            .then((moduleRef) => moduleRef.get(ReportsService));

        beforeEach(() => {
          constructionsCount = 0;
          const connection = new Promise<string>(
            (resolve) => (releaseConnection = resolve),
          );
          connectionRequested = new Promise((resolve) => {
            requestConnection = () => {
              resolve();
              return connection;
            };
          });
        });

        it("should return the providers after the first load() built them", async () => {
          const first = lazyModuleLoader.load(() => ReportsModule);
          await connectionRequested;
          const second = loadReportsService();
          releaseConnection("connection");

          const [, reportsService] = await Promise.all([first, second]);
          expect(reportsService.connection).toBe("connection");
          expect(constructionsCount).toBe(1);
        });

        it("should construct the providers once when both load() calls start together", async () => {
          const loads = Promise.all([
            loadReportsService(),
            loadReportsService(),
          ]);
          await connectionRequested;
          releaseConnection("connection");

          const [first, second] = await loads;
          expect(first.connection).toBe("connection");
          expect(second).toBe(first);
          expect(constructionsCount).toBe(1);
        });

        it("should wait for a load() that builds the module as an import", async () => {
          const dashboard = lazyModuleLoader.load(() => DashboardModule);
          await connectionRequested;
          const reports = loadReportsService();
          releaseConnection("connection");

          const [, reportsService] = await Promise.all([dashboard, reports]);
          expect(reportsService.connection).toBe("connection");
          expect(constructionsCount).toBe(1);
        });

        it("should complete cleanly after concurrent load() calls with logger false", async () => {
          const first = lazyModuleLoader.load(() => ReportsModule, {
            logger: false,
          });
          await connectionRequested;
          const second = lazyModuleLoader.load(() => ReportsModule, {
            logger: false,
          });
          releaseConnection("connection");
          const [ref1, ref2] = await Promise.all([first, second]);
          expect(ref1).toBe(ref2);

          const dashRef = await lazyModuleLoader.load(() => DashboardModule);
          expect(dashRef).toBeInstanceOf(ModuleRef);
        });
      });

      describe("when another load() builds an imported module while load() is still scanning", () => {
        let resolveSlowImport: (dynamicModule: DynamicModule) => void;
        let rejectSlowImport: (reason: Error) => void;
        let constructionsCount: number;

        @Injectable()
        class SessionRegistry {
          constructor() {
            constructionsCount++;
          }
        }

        @Module({ providers: [SessionRegistry], exports: [SessionRegistry] })
        class SessionsModule {}

        @Injectable()
        class DocumentsService {
          constructor(readonly sessions: SessionRegistry) {}
        }

        @Module({})
        class StorageModule {}

        const createDocumentsModule = () => {
          @Module({
            imports: [
              SessionsModule,
              new Promise<DynamicModule>((resolve, reject) => {
                resolveSlowImport = resolve;
                rejectSlowImport = reject;
              }),
            ],
            providers: [DocumentsService],
          })
          class DocumentsModule {}

          return DocumentsModule;
        };

        const isRegistered = (metatype: Type<unknown>) =>
          discoveryService
            .getModules()
            .some((mod) => mod.metatype === metatype);

        const delayTick = () =>
          new Promise<void>((resolve) => setTimeout(resolve, 10));

        beforeEach(() => {
          constructionsCount = 0;
        });

        it("should not build the module again", async () => {
          const documents = lazyModuleLoader.load(createDocumentsModule);
          await delayTick();

          const sessionsModuleRef = await lazyModuleLoader.load(
            () => SessionsModule,
          );
          const sessionRegistry = sessionsModuleRef.get(SessionRegistry);
          resolveSlowImport({ module: StorageModule });

          const documentsModuleRef = await documents;
          expect(documentsModuleRef.get(DocumentsService).sessions).toBe(
            sessionRegistry,
          );
          expect(sessionsModuleRef.get(SessionRegistry)).toBe(sessionRegistry);
          expect(constructionsCount).toBe(1);
        });

        it("should not evict the module when the scan fails", async () => {
          const documents = lazyModuleLoader.load(createDocumentsModule);
          await delayTick();

          const sessionsModuleRef = await lazyModuleLoader.load(
            () => SessionsModule,
          );
          rejectSlowImport(new Error("Dynamic import failed"));

          await expect(documents).rejects.toThrow("Dynamic import failed");
          expect(discoveryService.getModules().length).toBe(
            initialModuleCount + 1,
          );
          expect(await lazyModuleLoader.load(() => SessionsModule)).toBe(
            sessionsModuleRef,
          );
          expect(constructionsCount).toBe(1);
        });

        it("should not evict the module that is still being built when the scan fails", async () => {
          let releaseConnection!: () => void;
          const connection = new Promise<void>(
            (resolve) => (releaseConnection = resolve),
          );

          @Module({
            imports: [SessionsModule],
            providers: [
              { provide: "CONNECTION", useFactory: () => connection },
            ],
          })
          class ReportsModule {}

          const documents = lazyModuleLoader.load(createDocumentsModule);
          await delayTick();

          const reports = lazyModuleLoader.load(() => ReportsModule);
          await delayTick();
          rejectSlowImport(new Error("Dynamic import failed"));

          await expect(documents).rejects.toThrow("Dynamic import failed");
          releaseConnection();
          await reports;
          expect(isRegistered(SessionsModule)).toBe(true);
          expect(discoveryService.getModules().length).toBe(
            initialModuleCount + 2,
          );

          await lazyModuleLoader.load(() => SessionsModule);
          expect(constructionsCount).toBe(1);
        });
      });

      describe("when the first load() fails", () => {
        let factoryCalls: number;

        const connectionProvider = {
          provide: "CONNECTION",
          useFactory: () => {
            factoryCalls++;
            if (factoryCalls === 1) {
              throw new Error("Connection refused");
            }
            return "connection";
          },
        };

        @Injectable()
        class ConnectionConsumer {
          constructor(@Inject("CONNECTION") readonly connection: string) {}
        }

        @Module({ providers: [connectionProvider, ConnectionConsumer] })
        class FailingModule {}

        @Global()
        @Module({
          providers: [connectionProvider],
          exports: [connectionProvider],
        })
        class FailingGlobalModule {}

        @Module({ providers: [ConnectionConsumer] })
        class ConsumerModule {}

        @Module({ imports: [undefined as any] })
        class FailingScanModule {}

        beforeEach(() => {
          factoryCalls = 0;
        });

        it("should build the module again on the next load()", async () => {
          await expect(
            lazyModuleLoader.load(() => FailingModule),
          ).rejects.toThrow("Connection refused");
          const moduleRef = await lazyModuleLoader.load(() => FailingModule);

          expect(moduleRef.get("CONNECTION")).toBe("connection");
          expect(moduleRef.get(ConnectionConsumer).connection).toBe(
            "connection",
          );
          expect(factoryCalls).toBe(2);
        });

        it("should build a global module again on the next load()", async () => {
          await expect(
            lazyModuleLoader.load(() => FailingGlobalModule),
          ).rejects.toThrow("Connection refused");
          await lazyModuleLoader.load(() => FailingGlobalModule);
          const moduleRef = await lazyModuleLoader.load(() => ConsumerModule);

          expect(moduleRef.get(ConnectionConsumer).connection).toBe(
            "connection",
          );
        });

        it("should roll back modules if scan fails midway", async () => {
          await expect(
            lazyModuleLoader.load(() => FailingScanModule),
          ).rejects.toThrow();
          expect(discoveryService.getModules().length).toBe(initialModuleCount);
        });

        it("should not evict a module that a concurrent load() still uses", async () => {
          const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
          let sharedInstances = 0;

          @Injectable()
          class SharedService {
            constructor() {
              sharedInstances++;
            }
          }

          @Module({ providers: [SharedService], exports: [SharedService] })
          class SharedModule {}

          @Module({
            imports: [SharedModule],
            providers: [
              {
                provide: "FAIL",
                useFactory: () =>
                  delay(10).then(() => Promise.reject(new Error("A failed"))),
              },
            ],
          })
          class AModule {}

          @Module({
            imports: [SharedModule],
            providers: [{ provide: "SLOW", useFactory: () => delay(30) }],
          })
          class BModule {}

          const [a, b] = await Promise.allSettled([
            lazyModuleLoader.load(() => AModule),
            lazyModuleLoader.load(() => BModule),
          ]);
          expect(a.status).toBe("rejected");
          expect(b.status).toBe("fulfilled");
          const instancesBefore = sharedInstances;

          await lazyModuleLoader.load(() => SharedModule);

          expect(sharedInstances).toBe(instancesBefore);
        });

        it("should allow a retry after a failure while another load is in flight", async () => {
          let xCalls = 0;
          const xProvider = {
            provide: "X_PROVIDER",
            useFactory: () => {
              xCalls++;
              if (xCalls === 1) {
                throw new Error("X failed");
              }
              return "x_value";
            },
          };

          @Module({ providers: [xProvider], exports: [xProvider] })
          class XModule {}

          @Module({
            imports: [XModule],
            providers: [
              {
                provide: "Z_PROVIDER",
                useFactory: () =>
                  new Promise((resolve) => setTimeout(resolve, 20)),
              },
            ],
          })
          class ZModule {}

          const p1 = lazyModuleLoader.load(() => XModule);
          const p2 = lazyModuleLoader.load(() => ZModule);

          await expect(p1).rejects.toThrow("X failed");
          const retry = await lazyModuleLoader.load(() => XModule);
          expect(retry.get("X_PROVIDER")).toBe("x_value");

          await expect(p2).rejects.toThrow("X failed");
          const retryAfter = await lazyModuleLoader.load(() => XModule);
          expect(retryAfter).toBe(retry);
        });

        it("should roll back an overridden module when its load fails", async () => {
          let overriddenCalls = 0;
          const failingProvider = {
            provide: "FAILING_OVERRIDE",
            useFactory: () => {
              overriddenCalls++;
              if (overriddenCalls === 1) {
                throw new Error("Override failed");
              }
              return "override_value";
            },
          };

          @Module({})
          class OriginalModule {}

          @Module({
            providers: [failingProvider],
            exports: [failingProvider],
          })
          class OverriddenModule {}

          const refWithOverride = await Test.createTestingModule({})
            .overrideModule(OriginalModule)
            .useModule(OverriddenModule)
            .compile();
          const overriddenLoader = refWithOverride.get(LazyModuleLoader);

          await expect(
            overriddenLoader.load(() => OriginalModule),
          ).rejects.toThrow("Override failed");

          const moduleRef = await overriddenLoader.load(() => OriginalModule);
          expect(moduleRef.get("FAILING_OVERRIDE")).toBe("override_value");
          expect(overriddenCalls).toBe(2);
        });

        it("should unlink a failed global module from another module loaded concurrently", async () => {
          const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

          @Global()
          @Module({
            providers: [
              {
                provide: "FAILING_GLOBAL",
                useFactory: () =>
                  delay(10).then(() =>
                    Promise.reject(new Error("Global failed")),
                  ),
              },
            ],
            exports: ["FAILING_GLOBAL"],
          })
          class FailingGlobalMod {}

          @Module({
            providers: [
              {
                provide: "OTHER_PROVIDER",
                useFactory: () => delay(20).then(() => "other_value"),
              },
            ],
          })
          class OtherMod {}

          const [globalResult, otherResult] = await Promise.allSettled([
            lazyModuleLoader.load(() => FailingGlobalMod),
            lazyModuleLoader.load(() => OtherMod),
          ]);

          expect(globalResult.status).toBe("rejected");
          expect(otherResult.status).toBe("fulfilled");

          const registeredMetatypes = discoveryService
            .getModules()
            .map((m) => m.metatype);
          expect(registeredMetatypes).toContain(OtherMod);
          expect(registeredMetatypes).not.toContain(FailingGlobalMod);
        });

        it("should roll back parent module when an imported dynamic module fails to load", async () => {
          const failingDynamicModule: Promise<DynamicModule> = Promise.reject(
            new Error("Dynamic import failed"),
          );

          @Module({
            imports: [failingDynamicModule],
          })
          class ParentWithFailingDynamicImportModule {}

          await expect(
            lazyModuleLoader.load(() => ParentWithFailingDynamicImportModule),
          ).rejects.toThrow("Dynamic import failed");

          expect(discoveryService.getModules().length).toBe(initialModuleCount);
        });

        it("should roll back parent and slow sibling when another dynamic import fails to load", async () => {
          const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

          @Module({})
          class SlowSiblingModule {}

          const slowPromise: Promise<DynamicModule> = delay(30).then(() => ({
            module: SlowSiblingModule,
          }));
          const failingPromise: Promise<DynamicModule> = Promise.reject(
            new Error("Dynamic import failed"),
          );

          @Module({
            imports: [failingPromise, slowPromise],
          })
          class ParentWithMixedDynamicImportsModule {}

          await expect(
            lazyModuleLoader.load(() => ParentWithMixedDynamicImportsModule),
          ).rejects.toThrow("Dynamic import failed");

          await delay(50);

          expect(discoveryService.getModules().length).toBe(initialModuleCount);
        });

        describe("and its providers depend on a module that stays", () => {
          const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

          @Injectable()
          class Config {}

          @Injectable({ scope: Scope.TRANSIENT })
          class TransientLogger {}

          @Module({
            providers: [Config, TransientLogger],
            exports: [Config, TransientLogger],
          })
          class SharedModule {}

          const failingProvider = {
            provide: "FAILING",
            useFactory: () => Promise.reject(new Error("Connection refused")),
            inject: [Config],
          };

          const slowProvider = {
            provide: "SLOW",
            useFactory: () => delay(30),
          };

          beforeEach(async () => {
            await lazyModuleLoader.load(() => SharedModule);
          });

          it("should remove failed consumer module while preserving shared module", async () => {
            @Injectable()
            class Consumer {
              constructor(
                @Inject("FAILING") readonly connection: string,
                readonly logger: TransientLogger,
              ) {}
            }

            @Module({
              imports: [SharedModule],
              providers: [failingProvider, Consumer],
            })
            class FailingConsumerModule {}

            await expect(
              lazyModuleLoader.load(() => FailingConsumerModule),
            ).rejects.toThrow("Connection refused");

            expect(discoveryService.getModules().length).toBe(
              initialModuleCount + 1,
            );
            expect(
              discoveryService.getProviders().map((w) => w.token),
            ).not.toContain(Consumer);
          });

          it("should not keep enhancer host module when lazy load fails", async () => {
            @Injectable({ scope: Scope.TRANSIENT })
            class TransientInterceptor implements NestInterceptor {
              constructor(readonly logger: TransientLogger) {}

              intercept(_context: ExecutionContext, next: CallHandler) {
                return next.handle();
              }
            }

            @UseInterceptors(TransientInterceptor)
            @Injectable()
            class Host {}

            @Module({
              imports: [SharedModule],
              providers: [
                Host,
                {
                  provide: "FAILING_LATE",
                  useFactory: () =>
                    delay(10).then(() =>
                      Promise.reject(new Error("Connection refused")),
                    ),
                },
              ],
            })
            class FailingHostModule {}

            await expect(
              lazyModuleLoader.load(() => FailingHostModule),
            ).rejects.toThrow("Connection refused");

            expect(discoveryService.getModules().length).toBe(
              initialModuleCount + 1,
            );
          });

          it("should not keep providers that were still loading when module failed", async () => {
            @Injectable()
            class SlowConsumer {
              @Inject(Config)
              readonly config!: Config;
              @Inject(TransientLogger)
              readonly logger!: TransientLogger;

              constructor(@Inject("SLOW") readonly slow: unknown) {}
            }

            @Injectable()
            class BrokenConsumer {
              constructor(
                @Inject("MISSING") readonly missing: unknown,
                readonly logger: TransientLogger,
              ) {}
            }

            @Module({
              imports: [SharedModule],
              providers: [slowProvider, SlowConsumer, BrokenConsumer],
            })
            class FailingSlowModule {}

            await expect(
              lazyModuleLoader.load(() => FailingSlowModule),
            ).rejects.toThrow();

            await delay(50);

            expect(discoveryService.getModules().length).toBe(
              initialModuleCount + 1,
            );
          });

          it("should not discover a provider that was still loading when it failed", async () => {
            const SlowTag = DiscoveryService.createDecorator();

            @SlowTag({ slow: true })
            @Injectable()
            class SlowDiscoverable {
              constructor(@Inject("SLOW") readonly slow: unknown) {}
            }

            @Module({
              imports: [SharedModule],
              providers: [slowProvider, SlowDiscoverable, failingProvider],
            })
            class FailingDiscoverableModule {}

            await expect(
              lazyModuleLoader.load(() => FailingDiscoverableModule),
            ).rejects.toThrow("Connection refused");

            await delay(50);

            expect(
              discoveryService.getProviders({ metadataKey: SlowTag.KEY }),
            ).toHaveLength(0);
          });
        });
      });

      describe("singleton sharing and repeated loading (#17428)", () => {
        let constructionsCount = 0;
        let globalConstructionsCount = 0;

        @Injectable()
        class SharedService {
          constructor() {
            constructionsCount++;
          }
        }

        @Module({
          providers: [SharedService],
          exports: [SharedService],
        })
        class SharedModule {}

        @Global()
        @Module({
          providers: [
            {
              provide: "GlobalService",
              useFactory: () => {
                globalConstructionsCount++;
                return "global";
              },
            },
          ],
          exports: ["GlobalService"],
        })
        class GlobalSharedModule {}

        @Injectable()
        class Consumer {
          constructor(readonly shared: SharedService) {}
        }

        @Module({
          imports: [SharedModule],
          providers: [Consumer],
        })
        class LazyModule {}

        @Module({
          providers: [
            {
              provide: "GlobalConsumer",
              useFactory: (globalService: any) => globalService,
              inject: ["GlobalService"],
            },
          ],
        })
        class LazyGlobalModule {}

        @Module({
          imports: [SharedModule, GlobalSharedModule],
        })
        class EagerModule {}

        let eagerSharedService: SharedService;

        beforeEach(async () => {
          constructionsCount = 0;
          globalConstructionsCount = 0;

          const eagerRef = await Test.createTestingModule({
            imports: [EagerModule],
          }).compile();
          lazyModuleLoader = eagerRef.get(LazyModuleLoader);
          modulesContainer = eagerRef.get(ModulesContainer);
          eagerSharedService = eagerRef.get(SharedService);
        });

        it("should share already-initialized singleton providers with lazily-loaded consumer", async () => {
          const lazyModuleRef = await lazyModuleLoader.load(() => LazyModule);
          const lazyConsumer = lazyModuleRef.get(Consumer);
          expect(lazyConsumer.shared).toBe(eagerSharedService);
          expect(constructionsCount).toBe(1);
        });

        it("should not construct the provider again on repeated load() calls", async () => {
          await lazyModuleLoader.load(() => LazyModule);
          expect(constructionsCount).toBe(1);

          await lazyModuleLoader.load(() => LazyModule);
          expect(constructionsCount).toBe(1);
        });

        it("should correctly support global modules without duplicating constructor calls", async () => {
          const lazyGlobalRef = await lazyModuleLoader.load(
            () => LazyGlobalModule,
          );
          const globalConsumer = lazyGlobalRef.get("GlobalConsumer", {
            strict: false,
          });
          expect(globalConsumer).toBe("global");
          expect(globalConstructionsCount).toBe(1);

          await lazyModuleLoader.load(() => LazyGlobalModule);
          expect(globalConstructionsCount).toBe(1);
        });
      });

      describe("dynamic modules with pre-registered dynamic imports (#17462)", () => {
        @Module({
          providers: [{ provide: "ITEMS", useValue: ["itemA", "itemB"] }],
          exports: ["ITEMS"],
        })
        class ChildProviderModule {}

        @Injectable()
        class ParentService {
          constructor(@Inject("ITEMS") readonly items: string[]) {}
        }

        @Module({ providers: [ParentService], exports: [ParentService] })
        class ParentRootModule {}

        @Module({
          providers: [{ provide: "GLOBAL_DEP", useValue: "globalDep" }],
          exports: ["GLOBAL_DEP"],
        })
        @Global()
        class GlobalDepModule {}

        @Module({
          providers: [
            {
              provide: "CHILD_OUT",
              useFactory: (dep: string) => `child(${dep})`,
              inject: ["GLOBAL_DEP"],
            },
          ],
          exports: ["CHILD_OUT"],
        })
        class ChildNeedsGlobalModule {}

        @Injectable()
        class GlobalHuskConsumer {
          constructor(@Inject("CHILD_OUT") readonly childOut: string) {}
        }

        @Module({
          providers: [GlobalHuskConsumer],
          exports: [GlobalHuskConsumer],
        })
        class GlobalHuskRootModule {}

        @Module({ imports: [GlobalDepModule] })
        class AppModule {}

        beforeEach(async () => {
          const ref = await Test.createTestingModule({
            imports: [AppModule],
          }).compile();
          lazyModuleLoader = ref.get(LazyModuleLoader);
          modulesContainer = ref.get(ModulesContainer);
        });

        it("should scan dynamic imports declared in the dynamic metadata", async () => {
          const child: DynamicModule = { module: ChildProviderModule };
          const definition: DynamicModule = {
            module: ParentRootModule,
            imports: [child],
            exports: [child],
          };

          const moduleRef = await lazyModuleLoader.load(() => definition);

          expect(moduleRef.get(ParentService).items).toEqual([
            "itemA",
            "itemB",
          ]);
        });

        it("should keep the module resolvable on repeated load() calls", async () => {
          const child: DynamicModule = { module: ChildProviderModule };
          const definition: DynamicModule = {
            module: ParentRootModule,
            imports: [child],
            exports: [child],
          };

          const first = await lazyModuleLoader.load(() => definition);
          const second = await lazyModuleLoader.load(() => definition);

          expect(first).toBe(second);
          expect(second.get(ParentService).items).toEqual(["itemA", "itemB"]);
        });

        it("should bind global providers into a rescanned dynamic import", async () => {
          const definition: DynamicModule = {
            module: GlobalHuskRootModule,
            imports: [{ module: ChildNeedsGlobalModule }],
          };

          const moduleRef = await lazyModuleLoader.load(() => definition);

          expect(moduleRef.get(GlobalHuskConsumer).childOut).toBe(
            "child(globalDep)",
          );
        });

        it("should register lazily loaded modules inside ModulesContainer", async () => {
          @Module({})
          class TrackedLazyModule {}

          const beforeSize = modulesContainer.size;
          await lazyModuleLoader.load(() => TrackedLazyModule);

          expect(modulesContainer.size).toBe(beforeSize + 1);
        });
      });
    });
  },
);
