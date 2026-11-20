import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import {
  APP_FILTER,
  APP_GUARD,
  APP_INTERCEPTOR,
  APP_PIPE,
  BadRequestException,
  Body,
  Catch,
  Controller,
  Cookies,
  Get,
  Global,
  Headers,
  Inject,
  Injectable,
  Module,
  Optional,
  Post,
  Query,
  REQUEST,
  Res,
  Scope,
  UseFilters,
  UseGuards,
  UseInterceptors,
  UsePipes,
  forwardRef,
  type ArgumentsHost,
  type BunestInterceptor,
  type CallHandler,
  type CanActivate,
  type DynamicModule,
  type ExceptionFilter,
  type ExecutionContext,
  type LoggerService,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  type OnModuleInit,
  type PipeTransform,
  type ResponseContext,
  type Type,
} from "@bunest/common";
import {
  BunestApplication,
  BunestApplicationContext,
  BunestFactory,
  ContextIdFactory,
  DIContainer,
  ENHANCER_OVERRIDE_MARKER,
  LifecycleManager,
  ModuleScanner,
  UnknownDependencyException,
  type EnhancerOverrideEntry,
} from "../src";

function makeValueOverride(value: unknown): EnhancerOverrideEntry {
  return { [ENHANCER_OVERRIDE_MARKER]: true, kind: "value", value };
}

function makeClassOverride(
  useClass: new (...args: any[]) => unknown,
  scope?: Scope,
): EnhancerOverrideEntry {
  return { [ENHANCER_OVERRIDE_MARKER]: true, kind: "class", useClass, scope };
}

function makeFactoryOverride(
  factory: (...args: any[]) => unknown,
  inject?: readonly any[],
  scope?: Scope,
): EnhancerOverrideEntry {
  return {
    [ENHANCER_OVERRIDE_MARKER]: true,
    kind: "factory",
    factory,
    inject,
    scope,
  };
}

function makeExistingOverride(useExisting: any): EnhancerOverrideEntry {
  return { [ENHANCER_OVERRIDE_MARKER]: true, kind: "existing", useExisting };
}

describe("Core & HTTP Testing Foundation (overrideModule, useMocker, 5 Bug Fixes, ContextId, select, useLogger, inject)", () => {
  describe("1. ModuleScanner.scan() overrideModule", () => {
    it("overrides top-level, nested, @Global(), re-exported, forwardRef circular, DynamicModule (exact & class), and chained modules safely", async () => {
      const TOKEN_TOP = Symbol("TOP");
      const TOKEN_NESTED = Symbol("NESTED");
      const TOKEN_GLOBAL = Symbol("GLOBAL");
      const TOKEN_DYN_EXACT = Symbol("DYN_EXACT");
      const TOKEN_DYN_CLASS = Symbol("DYN_CLASS");
      const TOKEN_CHAIN = Symbol("CHAIN");

      @Module({
        providers: [{ provide: TOKEN_TOP, useValue: "real-top" }],
        exports: [TOKEN_TOP],
      })
      class RealTopMod {}

      @Module({
        providers: [{ provide: TOKEN_TOP, useValue: "mock-top" }],
        exports: [TOKEN_TOP],
      })
      class MockTopMod {}

      @Module({
        providers: [{ provide: TOKEN_NESTED, useValue: "real-nested" }],
        exports: [TOKEN_NESTED],
      })
      class RealNestedMod {}

      @Module({
        providers: [{ provide: TOKEN_NESTED, useValue: "mock-nested" }],
        exports: [TOKEN_NESTED],
      })
      class MockNestedMod {}

      // Wrapper re-exports RealNestedMod — overrideModule MUST preserve re-exports cleanly
      @Module({
        imports: [RealNestedMod],
        exports: [RealNestedMod],
      })
      class WrapperMod {}

      @Global()
      @Module({
        providers: [{ provide: TOKEN_GLOBAL, useValue: "real-global" }],
        exports: [TOKEN_GLOBAL],
      })
      class RealGlobalMod {}

      @Global()
      @Module({
        providers: [{ provide: TOKEN_GLOBAL, useValue: "mock-global" }],
        exports: [TOKEN_GLOBAL],
      })
      class MockGlobalMod {}

      class ConfigDynMod {
        static register(token: symbol, val: string): DynamicModule {
          return {
            module: ConfigDynMod,
            providers: [{ provide: token, useValue: val }],
            exports: [token],
          };
        }
      }

      const exactDyn = ConfigDynMod.register(TOKEN_DYN_EXACT, "real-dyn-exact");
      const otherDyn = ConfigDynMod.register(TOKEN_DYN_CLASS, "real-dyn-class");

      const mockExactDyn: DynamicModule = {
        module: class MockExactDyn {},
        providers: [{ provide: TOKEN_DYN_EXACT, useValue: "mock-dyn-exact" }],
        exports: [TOKEN_DYN_EXACT],
      };

      const mockClassDyn: DynamicModule = {
        module: class MockClassDyn {},
        providers: [{ provide: TOKEN_DYN_CLASS, useValue: "mock-dyn-class" }],
        exports: [TOKEN_DYN_CLASS],
      };

      // Chained override A -> B -> C
      @Module({
        providers: [{ provide: TOKEN_CHAIN, useValue: "chain-a" }],
        exports: [TOKEN_CHAIN],
      })
      class ChainA {}
      @Module({
        providers: [{ provide: TOKEN_CHAIN, useValue: "chain-b" }],
        exports: [TOKEN_CHAIN],
      })
      class ChainB {}
      @Module({
        providers: [{ provide: TOKEN_CHAIN, useValue: "chain-c" }],
        exports: [TOKEN_CHAIN],
      })
      class ChainC {}

      // Circular forwardRef modules where CircB is overridden
      const CIRC_TOK = Symbol("CIRC_TOK");
      @Module({
        imports: [forwardRef(() => CircB)],
      })
      class CircA {}
      @Module({
        imports: [forwardRef(() => CircA)],
        providers: [{ provide: CIRC_TOK, useValue: "real-circ-b" }],
        exports: [CIRC_TOK],
      })
      class CircB {}
      @Module({
        imports: [forwardRef(() => CircA)],
        providers: [{ provide: CIRC_TOK, useValue: "mock-circ-b" }],
        exports: [CIRC_TOK],
      })
      class MockCircB {}

      @Module({
        imports: [
          RealTopMod,
          WrapperMod,
          RealGlobalMod,
          exactDyn,
          otherDyn,
          ChainA,
          CircA,
        ],
      })
      class AppModule {}

      const moduleOverrides = new Map<any, any>([
        [RealTopMod, MockTopMod],
        [RealNestedMod, MockNestedMod],
        [RealGlobalMod, MockGlobalMod],
        [exactDyn, mockExactDyn],
        [ConfigDynMod, mockClassDyn],
        [ChainA, ChainB],
        [ChainB, ChainC],
        [CircB, MockCircB],
      ]);

      const ctx = await BunestFactory.createApplicationContext(AppModule, {
        logger: false,
        overrides: { modules: moduleOverrides },
      });

      expect(ctx.get(TOKEN_TOP)).toBe("mock-top");
      expect(ctx.get(TOKEN_NESTED)).toBe("mock-nested");
      expect(ctx.get(TOKEN_GLOBAL)).toBe("mock-global");
      expect(ctx.get(TOKEN_DYN_EXACT)).toBe("mock-dyn-exact");
      expect(ctx.get(TOKEN_DYN_CLASS)).toBe("mock-dyn-class");
      expect(ctx.get(TOKEN_CHAIN)).toBe("chain-c");
      expect(ctx.get(CIRC_TOK)).toBe("mock-circ-b");
      await ctx.close();

      // Cycle in moduleOverrides (X -> Y, Y -> X) must NOT hang!
      @Module({})
      class LoopX {}
      @Module({})
      class LoopY {}
      const loopGraph = await new ModuleScanner().scan(LoopX, {
        moduleOverrides: new Map<any, any>([
          [LoopX, LoopY],
          [LoopY, LoopX],
        ]),
      });
      expect(loopGraph.root).toBeDefined();
    });
  });

  describe("2. useMocker in DIContainer", () => {
    it("caches a single mock per token across singleton, TRANSIENT, and REQUEST consumers, supports property injection & get()/resolve(), skips @Optional() and REQUEST", async () => {
      const MISSING_A = Symbol("MISSING_A");
      const MISSING_PROP = Symbol("MISSING_PROP");
      const OPTIONAL_MISSING = Symbol("OPTIONAL_MISSING");
      const UNMOCKABLE = Symbol("UNMOCKABLE");

      const mockCalls: unknown[] = [];

      @Injectable()
      class SingletonConsumer {
        @Inject(MISSING_PROP)
        propDep!: { id: string };

        @Optional()
        @Inject(OPTIONAL_MISSING)
        optDep?: string;

        constructor(
          @Inject(MISSING_A) public readonly depA: { kind: string },
          @Optional() @Inject(OPTIONAL_MISSING) public readonly optParam?: string,
        ) {}
      }

      @Injectable({ scope: Scope.TRANSIENT })
      class TransientConsumer {
        constructor(@Inject(MISSING_A) public readonly depA: { kind: string }) {}
      }

      @Injectable({ scope: Scope.REQUEST })
      class RequestConsumer {
        constructor(
          @Inject(MISSING_A) public readonly depA: { kind: string },
          @Inject(REQUEST) public readonly req: Request,
        ) {}
      }

      @Module({
        providers: [SingletonConsumer, TransientConsumer, RequestConsumer],
      })
      class AppModule {}

      const mocker = (token: unknown) => {
        mockCalls.push(token);
        if (token === MISSING_A) return { kind: "mocked-A" };
        if (token === MISSING_PROP) return { id: "mocked-prop" };
        return undefined;
      };

      const ctx = await BunestFactory.createApplicationContext(AppModule, {
        logger: false,
        overrides: { mocker },
      });

      const s = ctx.get(SingletonConsumer);
      const t = await ctx.resolve(TransientConsumer);
      const ctxId = ContextIdFactory.create();
      const fakeReq = new Request("http://localhost/mock");
      ctx.registerRequestByContextId(fakeReq, ctxId);
      const r = await ctx.resolve(RequestConsumer, ctxId);

      // Exact same cached mock instance shared across all scopes + retrievable via get()/resolve()
      expect(s.depA).toEqual({ kind: "mocked-A" });
      expect(t.depA).toBe(s.depA);
      expect(r.depA).toBe(s.depA);
      expect(ctx.get(MISSING_A)).toBe(s.depA);
      expect(await ctx.resolve(MISSING_A)).toBe(s.depA);
      expect(s.propDep).toEqual({ id: "mocked-prop" });
      expect(s.optDep).toBeUndefined();
      expect(s.optParam).toBeUndefined();
      expect(r.req).toBe(fakeReq);

      // Mocker called ONCE per missing required token, NEVER for @Optional() or REQUEST
      expect(mockCalls).toEqual([MISSING_A, MISSING_PROP]);

      await ctx.close();

      // Returning undefined/null from mocker throws UnknownDependencyException
      @Injectable()
      class BrokenConsumer {
        constructor(@Inject(UNMOCKABLE) public readonly x: unknown) {}
      }
      @Module({ providers: [BrokenConsumer] })
      class BrokenModule {}

      await expect(
        BunestFactory.createApplicationContext(BrokenModule, {
          logger: false,
          overrides: { mocker: () => null },
        }),
      ).rejects.toThrow(UnknownDependencyException);
    });
  });

  describe("3. All 5 enhancer-override & provider-override bug fixes", () => {
    it("Fixes Bug 1 & 3: APP_* useFactory & useExisting + decorator @Use* useFactory inject module-private AND root providers", async () => {
      const PRIVATE_SECRET = Symbol("PRIVATE_SECRET");
      const ROOT_FLAG = Symbol("ROOT_FLAG");

      @Injectable()
      class RealAppGuard implements CanActivate {
        canActivate() {
          return false;
        }
      }

      @Injectable()
      class RealRouteGuard implements CanActivate {
        canActivate() {
          return false;
        }
      }

      @Injectable()
      class RealPipe implements PipeTransform {
        transform(v: string) {
          return `real:${v}`;
        }
      }

      @Injectable()
      class ExistingPipe implements PipeTransform {
        transform(v: string) {
          return `existing:${v}`;
        }
      }

      @Controller("/b13")
      class FeatureController {
        @Get()
        @UseGuards(RealRouteGuard)
        get(@Query("q", RealPipe) q: string) {
          return { q };
        }
      }

      @Module({
        controllers: [FeatureController],
        providers: [
          { provide: PRIVATE_SECRET, useValue: "priv-ok" },
          ExistingPipe,
          { provide: APP_GUARD, useClass: RealAppGuard },
        ],
      })
      class FeatureModule {}

      @Module({
        imports: [FeatureModule],
        providers: [{ provide: ROOT_FLAG, useValue: "root-ok" }],
      })
      class RootModule {}

      const app = await BunestFactory.create(RootModule, {
        logger: false,
        overrides: {
          guards: new Map([
            // APP_GUARD overridden with useFactory injecting BOTH private & root tokens!
            [
              RealAppGuard,
              makeFactoryOverride(
                (priv: string, rootFlag: string): CanActivate => ({
                  canActivate: () => priv === "priv-ok" && rootFlag === "root-ok",
                }),
                [PRIVATE_SECRET, ROOT_FLAG],
              ),
            ],
            // Decorator @UseGuards overridden with useFactory injecting private token!
            [
              RealRouteGuard,
              makeFactoryOverride(
                (priv: string): CanActivate => ({
                  canActivate: () => priv === "priv-ok",
                }),
                [PRIVATE_SECRET],
              ),
            ],
          ]),
          pipes: new Map([
            // Decorator param pipe overridden with useExisting referencing module-private provider!
            [RealPipe, makeExistingOverride(ExistingPipe)],
          ]),
        },
      });

      try {
        const res = await app.inject("/b13?q=hi");
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ q: "existing:hi" });
      } finally {
        await app.close();
      }
    });

    it("Fixes Bug 2: preserves @Catch(...) on APP_FILTER & @UseFilters value/factory overrides and honors replacement @Catch(...) on useClass", async () => {
      class DomainAError extends Error {}
      class DomainBError extends Error {}

      @Catch(DomainAError)
      @Injectable()
      class AppDomainAFilter implements ExceptionFilter {
        catch() {
          return Response.json({ filter: "real-app-a" }, { status: 418 });
        }
      }

      @Catch(DomainAError)
      @Injectable()
      class MethodDomainAFilter implements ExceptionFilter {
        catch() {
          return Response.json({ filter: "real-method-a" }, { status: 418 });
        }
      }

      @Catch()
      @Injectable()
      class CatchAllReplacementFilter implements ExceptionFilter {
        catch(err: unknown) {
          return Response.json(
            {
              filter: "catch-all-replacement",
              msg: err instanceof Error ? err.message : String(err),
            },
            { status: 499 },
          );
        }
      }

      @Controller("/b2")
      class ErrController {
        @Get("app-a")
        throwA() {
          throw new DomainAError("err-a");
        }

        @Get("app-b")
        throwB() {
          throw new BadRequestException("err-bad");
        }

        @Get("method-useclass")
        @UseFilters(MethodDomainAFilter)
        throwMethodB() {
          throw new DomainBError("err-b");
        }
      }

      @Module({
        controllers: [ErrController],
        providers: [{ provide: APP_FILTER, useClass: AppDomainAFilter }],
      })
      class ErrModule {}

      const app = await BunestFactory.create(ErrModule, {
        logger: false,
        overrides: {
          filters: new Map([
            // APP_FILTER value override without @Catch MUST preserve @Catch(DomainAError)!
            [
              AppDomainAFilter,
              makeValueOverride({
                catch: (err: Error) =>
                  Response.json(
                    { filter: "mock-app-a", msg: err.message },
                    { status: 418 },
                  ),
              }),
            ],
            // @UseFilters useClass(CatchAllReplacementFilter) MUST read replacement's @Catch() (empty catch-all)!
            [
              MethodDomainAFilter,
              makeClassOverride(CatchAllReplacementFilter),
            ],
          ]),
        },
      });

      try {
        // DomainAError caught by mocked APP_FILTER
        const rA = await app.inject("/b2/app-a");
        expect(rA.statusCode).toBe(418);
        expect(rA.json()).toEqual({ filter: "mock-app-a", msg: "err-a" });

        // BadRequestException MUST NOT be caught by mocked APP_FILTER (falls through to DefaultExceptionFilter -> 400!)
        const rB = await app.inject("/b2/app-b");
        expect(rB.statusCode).toBe(400);
        expect((rB.json() as { message: string }).message).toBe("err-bad");

        // DomainBError on method-useclass IS caught by CatchAllReplacementFilter -> 499!
        const rMethod = await app.inject("/b2/method-useclass");
        expect(rMethod.statusCode).toBe(499);
        expect(rMethod.json()).toEqual({
          filter: "catch-all-replacement",
          msg: "err-b",
        });
      } finally {
        await app.close();
      }
    });

    it("Fixes Bug 4: pre-override validation skips original enhancer deps & scope leaks for @UseGuards and imperative app.useGlobalGuards", async () => {
      const MISSING_DEP = Symbol("MISSING_DEP");

      @Injectable({ scope: Scope.REQUEST })
      class ReqDep {}

      // Singleton guard with missing dep + REQUEST dep -> would fail validation & ScopeLeakException if not overridden!
      @Injectable()
      class LeakyBrokenGuard implements CanActivate {
        constructor(
          @Inject(MISSING_DEP) public readonly missing: unknown,
          public readonly reqDep: ReqDep,
        ) {}
        canActivate() {
          return false;
        }
      }

      @Injectable()
      class GlobalBrokenGuard implements CanActivate {
        constructor(public readonly reqDep: ReqDep) {}
        canActivate() {
          return false;
        }
      }

      @Controller("/b4")
      class SafeController {
        @Get()
        @UseGuards(LeakyBrokenGuard)
        ok() {
          return { ok: true };
        }
      }

      @Module({
        controllers: [SafeController],
        providers: [ReqDep],
      })
      class SafeModule {}

      const app = await BunestFactory.create(SafeModule, {
        logger: false,
        overrides: {
          guards: new Map<Type<unknown>, EnhancerOverrideEntry>([
            [LeakyBrokenGuard, makeValueOverride({ canActivate: () => true })],
            [
              GlobalBrokenGuard,
              makeFactoryOverride(
                (req: Request): CanActivate => ({
                  canActivate: () => req.headers.get("x-pass") === "yes",
                }),
                [REQUEST],
                Scope.REQUEST,
              ),
            ],
          ]),
        },
      });
      app.useGlobalGuards(GlobalBrokenGuard);

      try {
        const denied = await app.inject("/b4");
        expect(denied.statusCode).toBe(403);

        const allowed = await app.inject({
          url: "/b4",
          headers: { "x-pass": "yes" },
        });
        expect(allowed.statusCode).toBe(200);
        expect(allowed.json()).toEqual({ ok: true });
      } finally {
        await app.close();
      }
    });

    it("Fixes Bug 5 & provider edge cases: kind separation, provider vs enhancer isolation, useValue(undefined/null), and useClass scope/lifecycle inheritance", async () => {
      let realConstructed = 0;
      const mockLifecycle: string[] = [];

      @Injectable()
      class DualClass implements CanActivate, PipeTransform {
        readonly source = "real-provider";
        canActivate() {
          return true;
        }
        transform(v: string) {
          return `real-pipe:${v}`;
        }
      }

      @Injectable()
      class ShouldNotConstruct {
        constructor() {
          realConstructed++;
        }
      }

      @Injectable()
      class NullTarget {
        constructor() {
          realConstructed++;
        }
      }

      const LIFECYCLE_TOK = Symbol("LIFECYCLE_TOK");

      @Injectable()
      class ReplacementLifecycleService
        implements OnModuleInit, OnModuleDestroy
      {
        onModuleInit() {
          mockLifecycle.push("mock:init");
        }
        onModuleDestroy() {
          mockLifecycle.push("mock:destroy");
        }
      }

      @Injectable()
      class ConsumerOfNulls {
        @Inject(ShouldNotConstruct)
        propUndef: unknown = "should-become-undefined";

        constructor(
          public readonly undefDep: ShouldNotConstruct,
          public readonly nullDep: NullTarget,
          public readonly dual: DualClass,
        ) {}
      }

      @Controller("/b5")
      class DualController {
        @Get()
        @UseGuards(DualClass)
        check(@Query("v", DualClass) v: string) {
          return { v };
        }
      }

      @Module({
        controllers: [DualController],
        providers: [
          DualClass,
          ShouldNotConstruct,
          NullTarget,
          { provide: LIFECYCLE_TOK, useValue: { plain: true } },
          ConsumerOfNulls,
        ],
      })
      class DualModule {}

      const app = await BunestFactory.create(DualModule, {
        logger: false,
        overrides: {
          providers: new Map<any, any>([
            [DualClass, { provide: DualClass, useValue: { source: "mock-provider" } }],
            [ShouldNotConstruct, { provide: ShouldNotConstruct, useValue: undefined }],
            [NullTarget, { provide: NullTarget, useValue: null }],
            [
              LIFECYCLE_TOK,
              { provide: LIFECYCLE_TOK, useClass: ReplacementLifecycleService },
            ],
          ]),
          guards: new Map([
            [DualClass, makeValueOverride({ canActivate: () => true })],
          ]),
          pipes: new Map([
            [
              DualClass,
              makeValueOverride({ transform: (v: string) => `mock-pipe:${v}` }),
            ],
          ]),
        },
      });

      await app.init();
      try {
        // Provider, guard, and pipe overrides all stay independent!
        const consumer = app.get(ConsumerOfNulls);
        expect(consumer.dual).toEqual({ source: "mock-provider" } as any);
        expect(consumer.undefDep).toBeUndefined();
        expect(consumer.propUndef).toBeUndefined();
        expect(consumer.nullDep).toBeNull();
        expect(app.get(ShouldNotConstruct)).toBeUndefined();
        expect(app.get(NullTarget)).toBeNull();
        expect(realConstructed).toBe(0);

        const res = await app.inject("/b5?v=abc");
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ v: "mock-pipe:abc" });

        // Replacement class replacing a useValue provider runs lifecycle hooks!
        expect(mockLifecycle).toEqual(["mock:init"]);
      } finally {
        await app.close();
      }
      expect(mockLifecycle).toEqual(["mock:init", "mock:destroy"]);
    });
  });

  describe("4. LifecycleManager sharing, global enhancer ordering, ContextId, select, { each: true }, useLogger/flushLogs, getHttpServer, inject", () => {
    it("shares LifecycleManager without double-firing hooks and keeps APP_* ahead of imperative app.useGlobal*()", async () => {
      const hooks: string[] = [];
      const guardOrder: string[] = [];

      @Injectable()
      class TrackedService implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
        onModuleInit() {
          hooks.push("init");
        }
        onApplicationBootstrap() {
          hooks.push("bootstrap");
        }
        onModuleDestroy() {
          hooks.push("destroy");
        }
      }

      @Controller("/ord")
      class OrdController {
        @Get()
        ok() {
          return { ok: true };
        }
      }

      @Module({
        controllers: [OrdController],
        providers: [
          TrackedService,
          {
            provide: APP_GUARD,
            useValue: {
              canActivate: () => {
                guardOrder.push("app-guard");
                return true;
              },
            },
          },
        ],
      })
      class OrdModule {}

      const graph = await new ModuleScanner().scan(OrdModule);
      const container = new DIContainer(graph);
      await container.initialize();

      const sharedLifecycle = new LifecycleManager();
      const ctx = new BunestApplicationContext(container, {
        logger: false,
        lifecycleManager: sharedLifecycle,
      });
      const app = new BunestApplication(container, {
        logger: false,
        lifecycleManager: sharedLifecycle,
      });

      // Register imperative global guard BEFORE prepareHttpPipeline() runs (TestingModule pattern!)
      app.useGlobalGuards({
        canActivate: () => {
          guardOrder.push("imperative-guard");
          return true;
        },
      });

      ctx.enableShutdownHooks(["SIGINT"]);
      expect(sharedLifecycle.getActiveHookCount()).toBe(1);

      await ctx.init();
      await app.init();
      const res = await app.inject("/ord");
      expect(res.statusCode).toBe(200);
      expect(hooks).toEqual(["init", "bootstrap"]);
      expect(guardOrder).toEqual(["app-guard", "imperative-guard"]);

      await app.close();
      await ctx.close();
      expect(hooks).toEqual(["init", "bootstrap", "destroy"]);
      expect(sharedLifecycle.getActiveHookCount()).toBe(0);
    });

    it("supports ContextId, registerRequestByContextId, chainable select() (static & DynamicModule), and { each: true }", async () => {
      const MULTI_TOKEN = Symbol("MULTI_TOKEN");
      const DYN_TOKEN = Symbol("DYN_TOKEN");

      @Injectable({ scope: Scope.REQUEST })
      class ScopedByReq {
        constructor(@Inject(REQUEST) public readonly req: { user: string }) {}
      }

      @Injectable({ scope: Scope.REQUEST })
      class ScopedNoReq {
        readonly nonce = Math.random();
      }

      class FeatureDyn {
        static register(val: string): DynamicModule {
          return {
            module: FeatureDyn,
            providers: [{ provide: DYN_TOKEN, useValue: val }],
          };
        }
      }

      const dyn1 = FeatureDyn.register("one");
      const dyn2 = FeatureDyn.register("two");

      @Module({
        imports: [dyn1],
        providers: [{ provide: MULTI_TOKEN, useValue: "from-a" }],
      })
      class ModA {}

      @Module({
        imports: [dyn2],
        providers: [{ provide: MULTI_TOKEN, useValue: "from-b" }],
      })
      class ModB {}

      @Module({
        imports: [ModA, ModB],
        providers: [ScopedByReq, ScopedNoReq],
      })
      class RootMod {}

      const ctx = await BunestFactory.createApplicationContext(RootMod, {
        logger: false,
      });

      try {
        // ContextId + registerRequestByContextId
        const id1 = ContextIdFactory.create();
        const id2 = ContextIdFactory.create();
        ctx.registerRequestByContextId({ user: "alice" }, id1);
        ctx.registerRequestByContextId({ user: "bob" }, id2);

        const a1 = await ctx.resolve(ScopedByReq, id1);
        const a2 = await ctx.resolve(ScopedByReq, id1);
        const b1 = await ctx.resolve(ScopedByReq, id2);
        expect(a1).toBe(a2);
        expect(a1).not.toBe(b1);
        expect(a1.req.user).toBe("alice");
        expect(b1.req.user).toBe("bob");

        // Auto-ephemeral RequestContainer when no ContextId provided
        const n1 = await ctx.resolve(ScopedNoReq);
        const n2 = await ctx.resolve(ScopedNoReq);
        expect(n1).not.toBe(n2);

        // Chainable select() + exact DynamicModule disambiguation
        expect(ctx.select(ModA).get(MULTI_TOKEN)).toBe("from-a");
        expect(ctx.select(ModA).select(dyn1).get(DYN_TOKEN)).toBe("one");
        expect(ctx.select(dyn2).get(DYN_TOKEN)).toBe("two");

        // { each: true } on get() and resolve()
        const allSync = ctx.get<unknown, string>(MULTI_TOKEN, { each: true });
        expect(allSync.sort()).toEqual(["from-a", "from-b"]);
        const allAsync = await ctx.resolve<unknown, string>(
          MULTI_TOKEN,
          undefined,
          { each: true },
        );
        expect(allAsync.sort()).toEqual(["from-a", "from-b"]);
      } finally {
        await ctx.close();
      }
    });

    it("supports useLogger(), bufferLogs + flushLogs(), getHttpServer(), and full inject()", async () => {
      const captured: Array<{ level: string; msg: unknown }> = [];
      const customLogger: LoggerService = {
        log: (msg) => captured.push({ level: "log", msg }),
        error: (msg) => captured.push({ level: "error", msg }),
        warn: (msg) => captured.push({ level: "warn", msg }),
      };

      @Controller("/inj")
      class InjController {
        @Post("echo")
        echo(
          @Body() body: { hello: string },
          @Query("tag") tag: string,
          @Headers("x-custom") hdr: string,
          @Cookies("sid") sid: string,
          @Res() res: ResponseContext,
        ) {
          res.cookie("c1", "v1").cookie("c2", "v2");
          return { body, tag, hdr, sid };
        }

        @Get("crash")
        crash() {
          throw new Error("boom-unhandled");
        }
      }

      @Module({ controllers: [InjController] })
      class InjModule {}

      const app = await BunestFactory.create(InjModule, {
        bufferLogs: true,
        autoFlushLogs: false,
      });

      // Before listen(): getHttpServer() is undefined
      expect(app.getHttpServer()).toBeUndefined();

      // Trigger unhandled 500 while logs are buffered
      const crashRes = await app.inject("/inj/crash");
      expect(crashRes.statusCode).toBe(500);

      // Attach custom logger with autoFlushLogs: false -> not flushed yet!
      app.useLogger(customLogger);
      expect(captured).toHaveLength(0);

      // flushLogs() replays buffered 500 error into customLogger!
      app.flushLogs();
      expect(captured.some((e) => e.level === "error" && e.msg === "boom-unhandled")).toBe(
        true,
      );

      // Subsequent 500 errors log directly to customLogger
      const prevLen = captured.length;
      await app.inject("/inj/crash");
      expect(captured.length).toBeGreaterThan(prevLen);

      // Full inject() with payload, query, headers, cookies, multi Set-Cookie
      const echoRes = await app.inject({
        method: "POST",
        url: "/inj/echo",
        query: { tag: "e2e" },
        headers: { "x-custom": "val" },
        cookies: { sid: "sess-9" },
        payload: { hello: "bunest" },
      });
      expect(echoRes.statusCode).toBe(201);
      expect(echoRes.json()).toEqual({
        body: { hello: "bunest" },
        tag: "e2e",
        hdr: "val",
        sid: "sess-9",
      });
      expect(Array.isArray(echoRes.headers["set-cookie"])).toBe(true);
      expect(echoRes.headers["set-cookie"]).toHaveLength(2);

      // Live listen() populates getHttpServer() and close() clears it
      await app.listen(0);
      expect(app.getHttpServer()).toBeDefined();
      expect(app.getHttpServer()?.port).toBeGreaterThan(0);

      await app.close();
      expect(app.getHttpServer()).toBeUndefined();
    });

    it("stops all listening HTTP servers without leaking when multiple apps share one LifecycleManager and close in any order", async () => {
      const destroyEvents: string[] = [];

      @Injectable()
      class SharedSvc implements OnModuleDestroy {
        onModuleDestroy() {
          destroyEvents.push("destroyed");
        }
      }

      @Controller("/multi")
      class MultiController {
        @Get()
        ping() {
          return { pong: true };
        }
      }

      @Module({ controllers: [MultiController], providers: [SharedSvc] })
      class MultiAppModule {}

      const graph = await new ModuleScanner().scan(MultiAppModule);
      const container = new DIContainer(graph);
      await container.initialize();

      const sharedLifecycle = new LifecycleManager();
      const app1 = new BunestApplication(container, {
        logger: false,
        lifecycleManager: sharedLifecycle,
      });
      const app2 = new BunestApplication(container, {
        logger: false,
        lifecycleManager: sharedLifecycle,
      });

      await app1.listen(0);
      await app2.listen(0);
      expect(app1.getHttpServer()).toBeDefined();
      expect(app2.getHttpServer()).toBeDefined();

      // Close app2 first (marks shared lifecycle closed), then app1 -> app1 MUST still stop its HTTP server!
      await app2.close();
      expect(app2.getHttpServer()).toBeUndefined();
      expect(app1.getHttpServer()).toBeDefined();

      await app1.close();
      expect(app1.getHttpServer()).toBeUndefined();
      // Shutdown hooks still ran exactly once!
      expect(destroyEvents).toEqual(["destroyed"]);
    });

    it("honors replacement @Catch(...) on Scope.REQUEST APP_FILTER factory override while preserving original @Catch(...) for plain objects", async () => {
      class ErrA extends Error {}
      class ErrB extends Error {}

      @Catch(ErrA)
      @Injectable()
      class OrigAppFilter implements ExceptionFilter {
        catch() {
          return Response.json({ filter: "orig-a" }, { status: 418 });
        }
      }

      @Catch(ErrB)
      class AltCatchFilter implements ExceptionFilter {
        constructor(private readonly reqUrl: string) {}
        catch(err: ErrB) {
          return Response.json(
            { filter: "alt-b", msg: err.message, url: this.reqUrl },
            { status: 422 },
          );
        }
      }

      @Controller("/req-filter")
      class ReqFilterController {
        @Get("a")
        throwA() {
          throw new ErrA("boom-a");
        }
        @Get("b")
        throwB() {
          throw new ErrB("boom-b");
        }
      }

      @Module({
        controllers: [ReqFilterController],
        providers: [{ provide: APP_FILTER, useClass: OrigAppFilter }],
      })
      class ReqFilterModule {}

      // 1. Replacement returns @Catch(ErrB) class instance -> catches ErrB, lets ErrA fall through to 500
      const appAlt = await BunestFactory.create(ReqFilterModule, {
        logger: false,
        overrides: {
          filters: new Map([
            [
              OrigAppFilter,
              makeFactoryOverride(
                (req: Request) => new AltCatchFilter(new URL(req.url).pathname),
                [REQUEST],
                Scope.REQUEST,
              ),
            ],
          ]),
        },
      });
      try {
        const resB = await appAlt.inject("/req-filter/b");
        expect(resB.statusCode).toBe(422);
        expect(resB.json()).toEqual({
          filter: "alt-b",
          msg: "boom-b",
          url: "/req-filter/b",
        });

        const resA = await appAlt.inject("/req-filter/a");
        expect(resA.statusCode).toBe(500);
      } finally {
        await appAlt.close();
      }

      // 2. Replacement returns plain object without @Catch -> preserves OrigAppFilter's @Catch(ErrA)
      const appPlain = await BunestFactory.create(ReqFilterModule, {
        logger: false,
        overrides: {
          filters: new Map([
            [
              OrigAppFilter,
              makeFactoryOverride(
                () => ({
                  catch: (err: ErrA) =>
                    Response.json(
                      { filter: "plain-preserves-a", msg: err.message },
                      { status: 418 },
                    ),
                }),
                [],
                Scope.REQUEST,
              ),
            ],
          ]),
        },
      });
      try {
        const resA = await appPlain.inject("/req-filter/a");
        expect(resA.statusCode).toBe(418);
        expect(resA.json()).toEqual({
          filter: "plain-preserves-a",
          msg: "boom-a",
        });

        const resB = await appPlain.inject("/req-filter/b");
        expect(resB.statusCode).toBe(500);
      } finally {
        await appPlain.close();
      }
    });
  });
});
