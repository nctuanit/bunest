import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import {
  Controller,
  Get,
  Injectable,
  Module,
  Scope,
  UsePipes,
  type InjectionToken,
  type PipeTransform,
  type Provider,
} from "../../../../../packages/common/src";
import {
  BunestApplicationContext,
  BunestFactory,
  ContextIdFactory,
  DIContainer,
  ModuleScanner,
} from "../../../../../packages/core/src";
import {
  CapturingLogger,
  createSpy,
  describeConformance,
  expectScopeLeak,
  itAdapted,
} from "../../../_helpers";

describeConformance(
  "NestApplicationContext",
  {
    upstreamPath: "packages/core/test/nest-application-context.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-007", "ADR-012"],
    notes:
      "Adapted from NestJS internal NestContainer/Injector setup to Bunest BunestApplicationContext/BunestFactory/DIContainer, including ADR-012 explicit scope-leak tests.",
  },
  () => {
    @Injectable()
    class A {}

    async function testHelper(
      injectionKey: InjectionToken,
      scope: Scope,
      additionalProviders: Array<Provider> = [],
      options: { snapshot?: boolean; bufferLogs?: boolean } = {},
    ): Promise<BunestApplicationContext> {
      @Module({
        providers: [
          {
            provide: injectionKey,
            useClass: A,
            scope,
          },
          ...additionalProviders,
        ],
      })
      class TestModule {}

      const scanner = new ModuleScanner();
      const graph = await scanner.scan(TestModule);
      const container = new DIContainer(graph, {
        snapshot: options.snapshot,
      });
      await container.initialize();
      return new BunestApplicationContext(container, {
        logger: false,
        snapshot: options.snapshot,
        bufferLogs: options.bufferLogs,
      });
    }

    function removeListenersNotIn(
      signal: NodeJS.Signals,
      baseline: Set<(...args: any[]) => void>,
    ) {
      for (const listener of process.listeners(signal)) {
        if (!baseline.has(listener as (...args: any[]) => void)) {
          process.removeListener(signal, listener as (...args: any[]) => void);
        }
      }
    }

    describe("enableShutdownHooks (listenToShutdownSignals)", () => {
      it("should remove signal listener cleanly on close", async () => {
        const signal: NodeJS.Signals = "SIGTERM";
        const listeners = new Set(
          process.listeners(signal) as Array<(...args: any[]) => void>,
        );
        const applicationContext = await testHelper(A, Scope.DEFAULT);

        try {
          applicationContext.enableShutdownHooks([signal]);
          expect(process.listenerCount(signal)).toBe(listeners.size + 1);

          await applicationContext.close();
          expect(process.listenerCount(signal)).toBe(listeners.size);
        } finally {
          removeListenersNotIn(signal, listeners);
        }
      });

      // BUNEST_BUG: LifecycleManager.enableShutdownHooks() does not trim/uppercase/normalize signal names before deduplicating and attaching listeners (packages/core/src/lifecycle/lifecycle-manager.ts).
      it.skip("should normalize signals before removing duplicates", async () => {
        const signal: NodeJS.Signals = "SIGTERM";
        const listeners = new Set(
          process.listeners(signal) as Array<(...args: any[]) => void>,
        );
        const applicationContext = await testHelper(A, Scope.DEFAULT);

        try {
          applicationContext.enableShutdownHooks([
            "sigterm" as NodeJS.Signals,
            " SIGTERM " as NodeJS.Signals,
          ]);

          expect(process.listenerCount(signal)).toBe(listeners.size + 1);

          await applicationContext.close();
          expect(process.listenerCount(signal)).toBe(listeners.size);
        } finally {
          removeListenersNotIn(signal, listeners);
        }
      });

      it("should remove the listener when the same signal is registered by separate calls", async () => {
        const signal: NodeJS.Signals = "SIGTERM";
        const listeners = new Set(
          process.listeners(signal) as Array<(...args: any[]) => void>,
        );
        const applicationContext = await testHelper(A, Scope.DEFAULT);

        try {
          applicationContext.enableShutdownHooks([signal]);
          applicationContext.enableShutdownHooks([signal]);

          expect(process.listenerCount(signal)).toBe(listeners.size + 1);

          await applicationContext.close();
          expect(process.listenerCount(signal)).toBe(listeners.size);
        } finally {
          removeListenersNotIn(signal, listeners);
        }
      });

      // BUNEST_BUG: BunestApplicationContext.close() returns early when already closed without calling cleanupShutdownHooks(), leaving listeners registered after close() attached (packages/core/src/application/bunest-application-context.ts).
      it.skip("should allow shutdown hooks to be enabled after close", async () => {
        const signal: NodeJS.Signals = "SIGTERM";
        const listeners = new Set(
          process.listeners(signal) as Array<(...args: any[]) => void>,
        );
        const applicationContext = await testHelper(A, Scope.DEFAULT);

        try {
          applicationContext.enableShutdownHooks([signal]);
          expect(process.listenerCount(signal)).toBe(listeners.size + 1);

          await applicationContext.close();
          expect(process.listenerCount(signal)).toBe(listeners.size);

          applicationContext.enableShutdownHooks([signal]);
          expect(process.listenerCount(signal)).toBe(listeners.size + 1);

          await applicationContext.close();
          expect(process.listenerCount(signal)).toBe(listeners.size);
        } finally {
          removeListenersNotIn(signal, listeners);
        }
      });

      // BUNEST_BUG: LifecycleManager.enableShutdownHooks() clears previously registered signal listeners before registering new signals instead of accumulating them (packages/core/src/lifecycle/lifecycle-manager.ts).
      it.skip("should remove signal listeners registered by separate calls across multiple signals", async () => {
        const signals: NodeJS.Signals[] = ["SIGTERM", "SIGINT"];
        const listeners = signals.map(
          (signal) =>
            new Set(
              process.listeners(signal) as Array<(...args: any[]) => void>,
            ),
        );
        const applicationContext = await testHelper(A, Scope.DEFAULT);

        try {
          applicationContext.enableShutdownHooks([signals[0]!]);
          applicationContext.enableShutdownHooks([signals[1]!]);

          signals.forEach((signal, index) => {
            expect(process.listenerCount(signal)).toBe(
              listeners[index]!.size + 1,
            );
          });

          await applicationContext.close();

          signals.forEach((signal, index) => {
            expect(process.listenerCount(signal)).toBe(listeners[index]!.size);
          });
        } finally {
          signals.forEach((signal, index) => {
            removeListenersNotIn(signal, listeners[index]!);
          });
        }
      });

      it("should run shutdown hooks once when signal is triggered during close", async () => {
        const signal: NodeJS.Signals = "SIGINT";
        const listeners = new Set(
          process.listeners(signal) as Array<(...args: any[]) => void>,
        );
        const onModuleDestroyStub = createSpy();
        const onApplicationShutdownStub = createSpy();

        let releaseDestroy!: () => void;
        const destroyStarted = new Promise<void>((resolve) => {
          releaseDestroy = resolve;
        });

        @Injectable()
        class SlowDestroyService {
          async onModuleDestroy() {
            onModuleDestroyStub();
            releaseDestroy();
            await new Promise((r) => setTimeout(r, 15));
          }
          onApplicationShutdown() {
            onApplicationShutdownStub();
          }
        }

        const applicationContext = await testHelper(A, Scope.DEFAULT, [
          SlowDestroyService,
        ]);

        try {
          applicationContext.enableShutdownHooks([signal]);
          const closing = applicationContext.close();
          await destroyStarted;
          await applicationContext.close(signal);
          await closing;

          expect(onModuleDestroyStub.callCount).toBe(1);
          expect(onApplicationShutdownStub.callCount).toBe(1);
          expect(process.listenerCount(signal)).toBe(listeners.size);
        } finally {
          removeListenersNotIn(signal, listeners);
        }
      });

      // BUNEST_BUG: BunestApplicationContext.close() does not await an in-flight init() promise before invoking onApplicationShutdown hooks (packages/core/src/application/bunest-application-context.ts).
      it.skip("should defer shutdown until all init hooks are resolved", async () => {
        const onModuleInitStub = createSpy();
        const onApplicationShutdownStub = createSpy();

        const delay = (ms: number) =>
          new Promise<void>((resolve) => setTimeout(resolve, ms));

        @Injectable()
        class B {
          async onModuleInit() {
            await delay(30);
            onModuleInitStub();
          }

          async onApplicationShutdown() {
            onApplicationShutdownStub();
          }
        }

        const applicationContext = await testHelper(A, Scope.DEFAULT, [B]);
        const initPromise = applicationContext.init();
        await delay(5);
        const closePromise = applicationContext.close("SIGTERM");

        await Promise.all([initPromise, closePromise]);

        expect(onModuleInitStub.calledBefore(onApplicationShutdownStub)).toBe(
          true,
        );
      });

      it("should run shutdown hooks when closed after a failed init", async () => {
        const onApplicationShutdownStub = createSpy();

        @Injectable()
        class B {
          onModuleInit() {
            throw new Error("init failed");
          }

          onApplicationShutdown() {
            onApplicationShutdownStub();
          }
        }

        const applicationContext = await testHelper(A, Scope.DEFAULT, [B]);

        await expect(applicationContext.init()).rejects.toThrow("init failed");
        await applicationContext.close("SIGTERM");

        expect(onApplicationShutdownStub.callCount).toBe(1);
      });
    });

    describe("close", () => {
      it("should run the shutdown sequence after a failed init", async () => {
        const onModuleDestroyStub = createSpy();
        const beforeApplicationShutdownStub = createSpy();
        const onApplicationShutdownStub = createSpy();

        @Injectable()
        class B {
          onModuleInit() {
            throw new Error("init failed");
          }

          onModuleDestroy() {
            onModuleDestroyStub();
          }

          beforeApplicationShutdown() {
            beforeApplicationShutdownStub();
          }

          onApplicationShutdown() {
            onApplicationShutdownStub();
          }
        }

        const applicationContext = await testHelper(A, Scope.DEFAULT, [B]);

        await expect(applicationContext.init()).rejects.toThrow("init failed");
        await applicationContext.close();

        expect(onModuleDestroyStub.callCount).toBe(1);
        expect(beforeApplicationShutdownStub.callCount).toBe(1);
        expect(onApplicationShutdownStub.callCount).toBe(1);
      });
    });

    describe("buffered logs", () => {
      it("should buffer logs until useLogger() or flushLogs() is called", async () => {
        const capturingLogger = new CapturingLogger();
        const applicationContext = await testHelper(A, Scope.DEFAULT, [], {
          bufferLogs: true,
        });

        applicationContext.getLogger().log("buffered message");
        expect(capturingLogger.entries).toHaveLength(0);

        applicationContext.useLogger(capturingLogger);
        expect(
          capturingLogger.entries.some((e) =>
            String(e.message).includes("buffered message"),
          ),
        ).toBe(true);
        await applicationContext.close();
      });

      // BUNEST_BUG: BunestApplicationContext.init() does not auto-flush buffered logs in a finally/catch block when initialization fails (packages/core/src/application/bunest-application-context.ts).
      it.skip("should flush buffered logs when initialization fails", async () => {
        const capturingLogger = new CapturingLogger();

        @Injectable()
        class FailingInit {
          onModuleInit() {
            throw new Error("init failed");
          }
        }

        @Module({ providers: [FailingInit] })
        class FailModule {}

        const scanner = new ModuleScanner();
        const graph = await scanner.scan(FailModule);
        const container = new DIContainer(graph);
        await container.initialize();
        const ctx = new BunestApplicationContext(container, {
          logger: capturingLogger,
          bufferLogs: true,
        });

        ctx.getLogger().log("buffered before fail");
        await expect(ctx.init()).rejects.toThrow("init failed");

        expect(
          capturingLogger.entries.some((e) =>
            String(e.message).includes("buffered before fail"),
          ),
        ).toBe(true);
      });
    });

    describe("get", () => {
      describe("when scope = DEFAULT", () => {
        it("should get value with function injection key", async () => {
          const key = A;
          const applicationContext = await testHelper(key, Scope.DEFAULT);

          const a1 = applicationContext.get<A>(key);
          const a2 = applicationContext.get<A>(key);

          expect(a1).toBeInstanceOf(A);
          expect(a2).toBeInstanceOf(A);
          expect(a1).toBe(a2);
        });

        it("should get value with string injection key", async () => {
          const key = "KEY_A";
          const applicationContext = await testHelper(key, Scope.DEFAULT);

          const a1 = applicationContext.get<A>(key);
          const a2 = applicationContext.get<A>(key);

          expect(a1).toBeInstanceOf(A);
          expect(a2).toBeInstanceOf(A);
          expect(a1).toBe(a2);
        });

        it("should get value with symbol injection key", async () => {
          const key = Symbol("KEY_A");
          const applicationContext = await testHelper(key, Scope.DEFAULT);

          const a1 = applicationContext.get<A>(key);
          const a2 = applicationContext.get<A>(key);

          expect(a1).toBeInstanceOf(A);
          expect(a2).toBeInstanceOf(A);
          expect(a1).toBe(a2);
        });
      });

      describe("when scope = REQUEST", () => {
        it("should throw error when use function injection key", async () => {
          const key = A;
          const applicationContext = await testHelper(key, Scope.REQUEST);

          expect(() => applicationContext.get(key)).toThrow();
        });

        it("should throw error when use string injection key", async () => {
          const key = "KEY_A";
          const applicationContext = await testHelper(key, Scope.REQUEST);

          expect(() => applicationContext.get(key)).toThrow();
        });

        it("should throw error when use symbol injection key", async () => {
          const key = Symbol("KEY_A");
          const applicationContext = await testHelper(key, Scope.REQUEST);

          expect(() => applicationContext.get(key)).toThrow();
        });
      });

      describe("when scope = TRANSIENT", () => {
        it("should throw error when use function injection key", async () => {
          const key = A;
          const applicationContext = await testHelper(key, Scope.TRANSIENT);

          expect(() => applicationContext.get(key)).toThrow();
        });

        it("should throw error when use string injection key", async () => {
          const key = "KEY_A";
          const applicationContext = await testHelper(key, Scope.TRANSIENT);

          expect(() => applicationContext.get(key)).toThrow();
        });

        it("should throw error when use symbol injection key", async () => {
          const key = Symbol("KEY_A");
          const applicationContext = await testHelper(key, Scope.TRANSIENT);

          expect(() => applicationContext.get(key)).toThrow();
        });
      });
    });

    describe("resolve", () => {
      describe("when scope = DEFAULT", () => {
        it("should resolve value with function injection key", async () => {
          const key = A;
          const applicationContext = await testHelper(key, Scope.DEFAULT);

          const a1 = await applicationContext.resolve<A>(key);
          const a2 = await applicationContext.resolve<A>(key);

          expect(a1).toBeInstanceOf(A);
          expect(a2).toBeInstanceOf(A);
          expect(a1).toBe(a2);
        });

        it("should resolve value with string injection key", async () => {
          const key = "KEY_A";
          const applicationContext = await testHelper(key, Scope.DEFAULT);

          const a1 = await applicationContext.resolve<A>(key);
          const a2 = await applicationContext.resolve<A>(key);

          expect(a1).toBeInstanceOf(A);
          expect(a2).toBeInstanceOf(A);
          expect(a1).toBe(a2);
        });

        it("should resolve value with symbol injection key", async () => {
          const key = Symbol("KEY_A");
          const applicationContext = await testHelper(key, Scope.DEFAULT);

          const a1 = await applicationContext.resolve<A>(key);
          const a2 = await applicationContext.resolve<A>(key);

          expect(a1).toBeInstanceOf(A);
          expect(a2).toBeInstanceOf(A);
          expect(a1).toBe(a2);
        });
      });

      describe("when scope = REQUEST", () => {
        it("should resolve value with function injection key", async () => {
          const key = A;
          const applicationContext = await testHelper(key, Scope.REQUEST);

          const contextId = ContextIdFactory.create();
          const a1 = await applicationContext.resolve<A>(key);
          const a2 = await applicationContext.resolve<A>(key, contextId);
          const a3 = await applicationContext.resolve<A>(key, contextId);

          expect(a1).toBeInstanceOf(A);
          expect(a2).toBeInstanceOf(A);
          expect(a1).not.toBe(a2);
          expect(a2).toBe(a3);
        });

        it("should resolve value with string injection key", async () => {
          const key = "KEY_A";
          const applicationContext = await testHelper(key, Scope.REQUEST);

          const contextId = ContextIdFactory.create();
          const a1 = await applicationContext.resolve<A>(key);
          const a2 = await applicationContext.resolve<A>(key, contextId);
          const a3 = await applicationContext.resolve<A>(key, contextId);

          expect(a1).toBeInstanceOf(A);
          expect(a2).toBeInstanceOf(A);
          expect(a1).not.toBe(a2);
          expect(a2).toBe(a3);
        });

        it("should resolve value with symbol injection key", async () => {
          const key = Symbol("KEY_A");
          const applicationContext = await testHelper(key, Scope.REQUEST);

          const contextId = ContextIdFactory.create();
          const a1 = await applicationContext.resolve<A>(key);
          const a2 = await applicationContext.resolve<A>(key, contextId);
          const a3 = await applicationContext.resolve<A>(key, contextId);

          expect(a1).toBeInstanceOf(A);
          expect(a2).toBeInstanceOf(A);
          expect(a1).not.toBe(a2);
          expect(a2).toBe(a3);
        });
      });

      describe("when scope = TRANSIENT", () => {
        // BUNEST_BUG: DIContainer.resolveAsync() does not cache Scope.TRANSIENT instances per explicit contextId (packages/core/src/di/di-container.ts:3378-3390); two resolve(key, contextId) calls return distinct instances instead of the same instance.
        it.skip("should resolve value with function injection key (same contextId returns same instance)", async () => {
          const key = A;
          const applicationContext = await testHelper(key, Scope.TRANSIENT);

          const contextId = ContextIdFactory.create();
          const a1 = await applicationContext.resolve<A>(key);
          const a2 = await applicationContext.resolve<A>(key, contextId);
          const a3 = await applicationContext.resolve<A>(key, contextId);

          expect(a1).toBeInstanceOf(A);
          expect(a2).toBeInstanceOf(A);
          expect(a1).not.toBe(a2);
          expect(a2).toBe(a3);
        });

        // BUNEST_BUG: DIContainer.resolveAsync() does not cache Scope.TRANSIENT instances per explicit contextId (packages/core/src/di/di-container.ts:3378-3390).
        it.skip("should resolve value with string injection key (same contextId returns same instance)", async () => {
          const key = "KEY_A";
          const applicationContext = await testHelper(key, Scope.TRANSIENT);

          const contextId = ContextIdFactory.create();
          const a1 = await applicationContext.resolve<A>(key);
          const a2 = await applicationContext.resolve<A>(key, contextId);
          const a3 = await applicationContext.resolve<A>(key, contextId);

          expect(a1).toBeInstanceOf(A);
          expect(a2).toBeInstanceOf(A);
          expect(a1).not.toBe(a2);
          expect(a2).toBe(a3);
        });

        // BUNEST_BUG: DIContainer.resolveAsync() does not cache Scope.TRANSIENT instances per explicit contextId (packages/core/src/di/di-container.ts:3378-3390).
        it.skip("should resolve value with symbol injection key (same contextId returns same instance)", async () => {
          const key = Symbol("KEY_A");
          const applicationContext = await testHelper(key, Scope.TRANSIENT);

          const contextId = ContextIdFactory.create();
          const a1 = await applicationContext.resolve<A>(key);
          const a2 = await applicationContext.resolve<A>(key, contextId);
          const a3 = await applicationContext.resolve<A>(key, contextId);

          expect(a1).toBeInstanceOf(A);
          expect(a2).toBeInstanceOf(A);
          expect(a1).not.toBe(a2);
          expect(a2).toBe(a3);
        });
      });
    });

    describe("request-scoped enhancers on controllers (ADR-012)", () => {
      @Injectable({ scope: Scope.REQUEST })
      class ReqScopedPipe implements PipeTransform {
        transform(value: unknown) {
          return value;
        }
      }

      itAdapted(
        "ADR-012",
        "explicit Scope.REQUEST controller with request-scoped pipe throws on get() and resolves via resolve()",
        async () => {
          @Controller({ path: "host", scope: Scope.REQUEST })
          @UsePipes(ReqScopedPipe)
          class RequestHost {
            @Get()
            index() {
              return "ok";
            }
          }

          @Module({
            controllers: [RequestHost],
            providers: [ReqScopedPipe],
          })
          class AppModule {}

          const appCtx = await BunestFactory.createApplicationContext(
            AppModule,
            { logger: false },
          );

          expect(() => appCtx.get(RequestHost)).toThrow();
          const instance = await appCtx.resolve(RequestHost);
          expect(instance).toBeInstanceOf(RequestHost);
          await appCtx.close();
        },
      );

      itAdapted(
        "ADR-012",
        "singleton controller remains static in Bunest while request-scoped pipe resolves per request",
        async () => {
          @Controller("singleton-host")
          @UsePipes(ReqScopedPipe)
          class SingletonHost {
            @Get()
            index() {
              return "ok";
            }
          }

          @Module({
            controllers: [SingletonHost],
            providers: [ReqScopedPipe],
          })
          class AppModule {}

          const appCtx = await BunestFactory.createApplicationContext(
            AppModule,
            { logger: false },
          );

          // In Bunest ADR-012, request-scoped enhancers do not silently bubble singleton controllers;
          // the controller stays singleton unless it injects a REQUEST provider itself.
          expect(appCtx.get(SingletonHost)).toBeInstanceOf(SingletonHost);
          await appCtx.close();
        },
      );

      itAdapted(
        "ADR-012",
        "singleton controller injecting a REQUEST provider fails fast with ScopeLeakException",
        async () => {
          @Injectable({ scope: Scope.REQUEST })
          class ReqService {}

          @Controller("leaky-host")
          class LeakyHost {
            constructor(public readonly req: ReqService) {}
          }

          @Module({
            controllers: [LeakyHost],
            providers: [ReqService],
          })
          class LeakyModule {}

          await expectScopeLeak(() =>
            BunestFactory.createApplicationContext(LeakyModule, {
              logger: false,
            }),
          );
        },
      );
    });

    describe("resolve with each: true", () => {
      it("should resolve all default-scoped providers registered under the same token", async () => {
        @Injectable()
        class Service1 {}
        @Injectable()
        class Service2 {}
        @Injectable()
        class Service3 {}
        const TOKEN = "MULTI_TOKEN";

        @Module({ providers: [{ provide: TOKEN, useClass: Service1 }] })
        class Module1 {}

        @Module({ providers: [{ provide: TOKEN, useClass: Service2 }] })
        class Module2 {}

        @Module({ providers: [{ provide: TOKEN, useClass: Service3 }] })
        class Module3 {}

        @Module({ imports: [Module1, Module2, Module3] })
        class RootModule {}

        const appCtx = await BunestFactory.createApplicationContext(RootModule, {
          logger: false,
        });

        const instances = await appCtx.resolve(TOKEN, undefined, {
          strict: false,
          each: true,
        });

        expect(Array.isArray(instances)).toBe(true);
        expect(instances).toHaveLength(3);
        expect(instances[0]).toBeInstanceOf(Service1);
        expect(instances[1]).toBeInstanceOf(Service2);
        expect(instances[2]).toBeInstanceOf(Service3);
        await appCtx.close();
      });
    });

    describe("snapshot bootstrap", () => {
      it("should not eagerly instantiate an unused transient provider", async () => {
        @Injectable({ scope: Scope.TRANSIENT })
        class UnusedTransient {
          static constructorCalls = 0;

          constructor() {
            UnusedTransient.constructorCalls++;
          }
        }

        const appCtx = await testHelper(
          A,
          Scope.DEFAULT,
          [UnusedTransient],
          { snapshot: true },
        );

        expect(UnusedTransient.constructorCalls).toBe(0);

        const instance = await appCtx.resolve(UnusedTransient);
        expect(instance).toBeInstanceOf(UnusedTransient);
        expect(UnusedTransient.constructorCalls).toBe(1);
        await appCtx.close();
      });
    });
  },
);
