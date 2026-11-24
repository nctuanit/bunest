import { afterEach, describe, expect, it, spyOn } from "bun:test";
import {
  APP_FILTER,
  APP_GUARD,
  APP_INTERCEPTOR,
  APP_PIPE,
  BadRequestException,
  Catch,
  Controller,
  ForbiddenException,
  Get,
  Global,
  Inject,
  Injectable,
  Logger,
  Module,
  Optional,
  Param,
  REQUEST,
  REQUEST_CONTEXT,
  Scope,
  SetMetadata,
  UseFilters,
  UseGuards,
  UsePipes,
  forwardRef,
  type ArgumentsHost,
  type BunestInterceptor,
  type CallHandler,
  type CanActivate,
  type DynamicModule,
  type ExceptionFilter,
  type ExecutionContext,
  type OnModuleDestroy,
  type OnModuleInit,
  type PipeTransform,
} from "@bunest/core";
import {
  BunHttpAdapter,
  UnknownDependencyException,
  getCurrentRequestContext,
} from "@bunest/core";
import {
  CapturingLogger,
  ContextIdFactory,
  ModuleMocker,
  Test,
  TestingLogger,
  createAutoMocker,
  createMockExecutionContext,
  createMockFn,
  createMockLogger,
  createMockReflector,
  createMockRequest,
  createMockResponseContext,
  request,
  runWithMockRequestContext,
} from "../src";

describe("@bunest/testing Parity & Regression Suite", () => {
  describe("overrideModule (top-level, nested, @Global, DynamicModule, circular forwardRef)", () => {
    it("overrides a top-level imported module", async () => {
      @Injectable()
      class RealService {
        kind() {
          return "real";
        }
      }

      @Module({ providers: [RealService], exports: [RealService] })
      class RealModule {}

      @Injectable()
      class FakeService {
        kind() {
          return "fake";
        }
      }

      @Module({
        providers: [
          { provide: RealService, useClass: FakeService },
          FakeService,
        ],
        exports: [RealService, FakeService],
      })
      class FakeModule {}

      const mod = await Test.createTestingModule({
        imports: [RealModule],
      })
        .overrideModule(RealModule)
        .useModule(FakeModule)
        .compile();

      try {
        expect(mod.get(RealService).kind()).toBe("fake");
        expect(mod.get(FakeService)).toBeInstanceOf(FakeService);
      } finally {
        await mod.close();
      }
    });

    it("overrides a nested imported module without changing parent module code", async () => {
      const DB_TOKEN = Symbol("DB");

      @Module({
        providers: [{ provide: DB_TOKEN, useValue: "postgres-prod" }],
        exports: [DB_TOKEN],
      })
      class ProdDbModule {}

      @Module({
        providers: [{ provide: DB_TOKEN, useValue: "sqlite-memory" }],
        exports: [DB_TOKEN],
      })
      class TestDbModule {}

      @Injectable()
      class Repo {
        constructor(@Inject(DB_TOKEN) readonly db: string) {}
      }

      @Module({
        imports: [ProdDbModule],
        providers: [Repo],
        exports: [Repo],
      })
      class FeatureModule {}

      const mod = await Test.createTestingModule({
        imports: [FeatureModule],
      })
        .overrideModule(ProdDbModule)
        .useModule(TestDbModule)
        .compile();

      try {
        expect(mod.get(Repo).db).toBe("sqlite-memory");
      } finally {
        await mod.close();
      }
    });

    it("overrides a @Global() module", async () => {
      const CONFIG = Symbol("GLOBAL_CONFIG");

      @Global()
      @Module({
        providers: [{ provide: CONFIG, useValue: { env: "prod" } }],
        exports: [CONFIG],
      })
      class ProdConfigModule {}

      @Global()
      @Module({
        providers: [{ provide: CONFIG, useValue: { env: "test" } }],
        exports: [CONFIG],
      })
      class TestConfigModule {}

      @Injectable()
      class Consumer {
        constructor(@Inject(CONFIG) readonly cfg: { env: string }) {}
      }

      @Module({ providers: [Consumer], exports: [Consumer] })
      class ConsumerModule {}

      const mod = await Test.createTestingModule({
        imports: [ProdConfigModule, ConsumerModule],
      })
        .overrideModule(ProdConfigModule)
        .useModule(TestConfigModule)
        .compile();

      try {
        expect(mod.get(Consumer).cfg.env).toBe("test");
      } finally {
        await mod.close();
      }
    });

    it("overrides a DynamicModule by exact reference and by module class", async () => {
      const KEY = Symbol("DYN_KEY");

      @Module({})
      class ConfigurableModule {
        static forRoot(val: string): DynamicModule {
          return {
            module: ConfigurableModule,
            providers: [{ provide: KEY, useValue: val }],
            exports: [KEY],
          };
        }
      }

      @Module({
        providers: [{ provide: KEY, useValue: "overridden-exact" }],
        exports: [KEY],
      })
      class ExactOverrideModule {}

      const dynRef = ConfigurableModule.forRoot("original");
      const mod1 = await Test.createTestingModule({
        imports: [dynRef],
      })
        .overrideModule(dynRef)
        .useModule(ExactOverrideModule)
        .compile();

      try {
        expect(mod1.get<string>(KEY)).toBe("overridden-exact");
      } finally {
        await mod1.close();
      }

      // Override DynamicModule by matching its .module class
      const mod2 = await Test.createTestingModule({
        imports: [ConfigurableModule.forRoot("original-2")],
      })
        .overrideModule(ConfigurableModule)
        .useModule(ConfigurableModule.forRoot("overridden-by-class"))
        .compile();

      try {
        expect(mod2.get<string>(KEY)).toBe("overridden-by-class");
      } finally {
        await mod2.close();
      }
    });

    it("overrides a module involved in forwardRef() circular module imports", async () => {
      @Injectable()
      class AProvider {
        name = "A";
      }

      @Injectable()
      class RealBProvider {
        name = "RealB";
      }

      @Injectable()
      class MockBProvider {
        name = "MockB";
      }

      @Module({
        imports: [forwardRef(() => BModule)],
        providers: [AProvider],
        exports: [AProvider],
      })
      class AModule {}

      @Module({
        imports: [forwardRef(() => AModule)],
        providers: [RealBProvider],
        exports: [RealBProvider],
      })
      class BModule {}

      @Module({
        imports: [forwardRef(() => AModule)],
        providers: [MockBProvider],
        exports: [MockBProvider],
      })
      class BModuleOverride {}

      const mod = await Test.createTestingModule({
        imports: [AModule],
      })
        .overrideModule(BModule)
        .useModule(BModuleOverride)
        .compile();

      try {
        expect(mod.get(AProvider).name).toBe("A");
        expect(mod.get(MockBProvider).name).toBe("MockB");
        expect(() => mod.get(RealBProvider)).toThrow(
          UnknownDependencyException,
        );
      } finally {
        await mod.close();
      }
    });
  });

  describe("useMocker, ModuleMocker, createAutoMocker & createMockFn", () => {
    it("caches auto-mocked instances across consumers and exposes them via module.get()", async () => {
      @Injectable()
      class MissingDep {
        compute(_x: number): number {
          return 999;
        }
      }

      @Injectable()
      class ConsumerA {
        constructor(readonly dep: MissingDep) {}
      }

      @Injectable()
      class ConsumerB {
        constructor(readonly dep: MissingDep) {}
      }

      let factoryCalls = 0;
      const mod = await Test.createTestingModule({
        providers: [ConsumerA, ConsumerB],
      })
        .useMocker((token) => {
          factoryCalls += 1;
          if (token === MissingDep) {
            return { compute: (x: number) => x * 2 };
          }
          return undefined;
        })
        .compile();

      try {
        const a = mod.get(ConsumerA);
        const b = mod.get(ConsumerB);
        const mocked = mod.get(MissingDep);

        expect(factoryCalls).toBe(1);
        expect(a.dep).toBe(mocked);
        expect(b.dep).toBe(mocked);
        expect(a.dep.compute(21)).toBe(42);
      } finally {
        await mod.close();
      }
    });

    it("rethrows UnknownDependencyException when mocker returns null or undefined", async () => {
      @Injectable()
      class UnmockedDep {}

      @Injectable()
      class NeedsUnmocked {
        constructor(readonly dep: UnmockedDep) {}
      }

      await expect(
        Test.createTestingModule({ providers: [NeedsUnmocked] })
          .useMocker(() => undefined)
          .compile(),
      ).rejects.toThrow(UnknownDependencyException);

      await expect(
        Test.createTestingModule({ providers: [NeedsUnmocked] })
          .useMocker(() => null)
          .compile(),
      ).rejects.toThrow(UnknownDependencyException);
    });

    it("auto-mocks missing constructor and property dependencies of REQUEST and TRANSIENT providers", async () => {
      @Injectable()
      class MissingAudit {
        record(_msg: string): string {
          return "real";
        }
      }

      @Injectable()
      class MissingMetrics {
        inc(): void {}
      }

      @Injectable({ scope: Scope.TRANSIENT })
      class TransientConsumer {
        @Inject(MissingMetrics)
        metrics!: MissingMetrics;

        constructor(readonly audit: MissingAudit) {}
      }

      @Injectable({ scope: Scope.REQUEST })
      class RequestConsumer {
        @Inject(MissingMetrics)
        metrics!: MissingMetrics;

        constructor(
          readonly audit: MissingAudit,
          readonly transient: TransientConsumer,
        ) {}
      }

      const mod = await Test.createTestingModule({
        providers: [TransientConsumer, RequestConsumer],
      })
        .useMocker(createAutoMocker())
        .compile();

      try {
        const auditMock = mod.get<any>(MissingAudit);
        const metricsMock = mod.get<any>(MissingMetrics);
        auditMock.record.mockReturnValue("mocked-audit");

        const ctxId = ContextIdFactory.create();
        mod.registerRequestByContextId(createMockRequest("/scoped"), ctxId);

        const reqConsumer = await mod.resolve(RequestConsumer, ctxId);
        expect(reqConsumer.audit).toBe(auditMock);
        expect(reqConsumer.metrics).toBe(metricsMock);
        expect(reqConsumer.transient.audit).toBe(auditMock);
        expect(reqConsumer.transient.metrics).toBe(metricsMock);
        expect(reqConsumer.audit.record("hello")).toBe("mocked-audit");
        expect(auditMock.record.calls).toEqual([["hello"]]);
      } finally {
        await mod.close();
      }
    });

    it("respects @Optional() and never auto-mocks REQUEST or REQUEST_CONTEXT", async () => {
      const OPTIONAL_TOKEN = Symbol("OPTIONAL_TOKEN");
      const seenTokens: unknown[] = [];

      @Injectable({ scope: Scope.REQUEST })
      class ScopedService {
        constructor(
          @Optional() @Inject(OPTIONAL_TOKEN) readonly opt: string | undefined,
          @Inject(REQUEST) readonly req: Request,
          @Optional() @Inject(REQUEST_CONTEXT) readonly reqCtx: unknown,
        ) {}
      }

      const mod = await Test.createTestingModule({
        providers: [ScopedService],
      })
        .useMocker((token) => {
          seenTokens.push(token);
          return { shouldNotBeUsed: true };
        })
        .compile();

      try {
        const ctxId = ContextIdFactory.create();
        const fakeReq = createMockRequest("/no-auto-mock");
        mod.registerRequestByContextId(fakeReq, ctxId);

        const svc = await mod.resolve(ScopedService, ctxId);
        expect(svc.opt).toBeUndefined();
        expect(svc.req).toBe(fakeReq);
        expect(seenTokens).not.toContain(OPTIONAL_TOKEN);
        expect(seenTokens).not.toContain(REQUEST);
        expect(seenTokens).not.toContain(REQUEST_CONTEXT);
      } finally {
        await mod.close();
      }
    });

    it("supports ModuleMocker (getMetadata/generateFromMetadata/mockClass), createMockFn, and createAutoMocker options", async () => {
      class BaseRepo {
        ping(): string {
          return "pong";
        }
      }
      class UsersRepo extends BaseRepo {
        findById(_id: string): Promise<{ id: string } | null> {
          return Promise.resolve(null);
        }
      }

      // 1. createMockFn spy API
      const spy = createMockFn<[number], number>();
      spy
        .mockReturnValue(10)
        .mockReturnValueOnce(1)
        .mockImplementationOnce((x) => x * 3);
      expect(spy(2)).toBe(1);
      expect(spy(4)).toBe(12);
      expect(spy(5)).toBe(10);
      expect(spy.called).toBe(true);
      expect(spy.callCount).toBe(3);
      expect(spy.calls).toEqual([[2], [4], [5]]);
      spy.mockClear();
      expect(spy.callCount).toBe(0);
      expect(spy(9)).toBe(10); // implementation kept after mockClear
      spy.mockReset();
      expect(spy(9)).toBeUndefined();

      const asyncSpy = createMockFn<[], Promise<string>>();
      asyncSpy
        .mockResolvedValueOnce("first")
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValue("rest");
      expect(await asyncSpy()).toBe("first");
      await expect(asyncSpy()).rejects.toThrow("boom");
      expect(await asyncSpy()).toBe("rest");

      // 2. ModuleMocker NestJS canonical recipe
      const mocker = new ModuleMocker();
      const meta = mocker.getMetadata(UsersRepo);
      expect(meta).not.toBeNull();
      const MockCtor = mocker.generateFromMetadata(meta!) as new () => any;
      const generated = new MockCtor();
      generated.findById.mockResolvedValue({ id: "u1" });
      generated.ping.mockReturnValue("mock-pong");
      expect(await generated.findById("u1")).toEqual({ id: "u1" });
      expect(generated.ping()).toBe("mock-pong");

      // 3. mockClass preserves instanceof
      const mocked = mocker.mockClass(UsersRepo);
      expect(mocked).toBeInstanceOf(UsersRepo);
      expect(mocked).toBeInstanceOf(BaseRepo);

      // 4. createAutoMocker with overrides, customFactory, and mockUnregisteredTokens
      const CUSTOM_TOKEN = Symbol("CUSTOM_TOKEN");
      const PROXY_TOKEN = "PROXY_SERVICE";

      @Injectable()
      class ServiceWithTokens {
        constructor(
          readonly repo: UsersRepo,
          @Inject(CUSTOM_TOKEN) readonly custom: string,
          @Inject(PROXY_TOKEN)
          readonly proxySvc: { run: (v: string) => string },
        ) {}
      }

      const mod = await Test.createTestingModule({
        providers: [ServiceWithTokens],
      })
        .useMocker(
          createAutoMocker({
            overrides: [[CUSTOM_TOKEN, "explicit-override"]],
            mockUnregisteredTokens: true,
          }),
        )
        .compile();

      try {
        const svc = mod.get(ServiceWithTokens);
        expect(svc.repo).toBeInstanceOf(UsersRepo);
        expect(svc.custom).toBe("explicit-override");
        (svc.proxySvc.run as any).mockReturnValue("proxied-ok");
        expect(svc.proxySvc.run("a")).toBe("proxied-ok");
      } finally {
        await mod.close();
      }
    });
  });

  describe("overrideProvider edge cases (undefined/null short-circuit, scope & lifecycle inheritance)", () => {
    it("short-circuits useValue(undefined) and useValue(null) without instantiating original class", async () => {
      let constructed = 0;

      @Injectable()
      class ExpensiveService {
        constructor() {
          constructed += 1;
        }
      }

      @Injectable()
      class Consumer {
        @Inject(ExpensiveService)
        propRef!: ExpensiveService;

        constructor(readonly ctorRef: ExpensiveService) {}
      }

      const modUndef = await Test.createTestingModule({
        providers: [ExpensiveService, Consumer],
      })
        .overrideProvider(ExpensiveService)
        .useValue(undefined)
        .compile();

      try {
        expect(constructed).toBe(0);
        expect(modUndef.get(ExpensiveService)).toBeUndefined();
        expect(modUndef.get(Consumer).ctorRef).toBeUndefined();
        expect(modUndef.get(Consumer).propRef).toBeUndefined();
      } finally {
        await modUndef.close();
      }

      const modNull = await Test.createTestingModule({
        providers: [ExpensiveService, Consumer],
      })
        .overrideProvider(ExpensiveService)
        .useValue(null)
        .compile();

      try {
        expect(constructed).toBe(0);
        expect(modNull.get(ExpensiveService)).toBeNull();
        expect(modNull.get(Consumer).ctorRef).toBeNull();
        expect(modNull.get(Consumer).propRef).toBeNull();
      } finally {
        await modNull.close();
      }
    });

    it("inherits @Injectable({ scope }) and runs lifecycle hooks when overriding useValue/useExisting with useClass", async () => {
      const hooks: string[] = [];

      @Injectable({ scope: Scope.TRANSIENT })
      class TransientMock {
        readonly uid = Math.random();
      }

      @Injectable()
      class OriginalSingleton {}

      const mod1 = await Test.createTestingModule({
        providers: [OriginalSingleton],
      })
        .overrideProvider(OriginalSingleton)
        .useClass(TransientMock)
        .compile();

      try {
        const a = await mod1.resolve(OriginalSingleton);
        const b = await mod1.resolve(OriginalSingleton);
        expect(a).toBeInstanceOf(TransientMock);
        expect(b).toBeInstanceOf(TransientMock);
        expect(a).not.toBe(b);
      } finally {
        await mod1.close();
      }

      @Injectable()
      class LifecycleMock implements OnModuleInit, OnModuleDestroy {
        onModuleInit() {
          hooks.push("mock:init");
        }
        onModuleDestroy() {
          hooks.push("mock:destroy");
        }
      }

      @Injectable()
      class TargetReal {}

      const VALUE_TOK = Symbol("VAL_TOK");
      const ALIAS_TOK = Symbol("ALIAS_TOK");

      const mod2 = await Test.createTestingModule({
        providers: [
          TargetReal,
          { provide: VALUE_TOK, useValue: "static-value" },
          { provide: ALIAS_TOK, useExisting: TargetReal },
        ],
      })
        .overrideProvider(VALUE_TOK)
        .useClass(LifecycleMock)
        .overrideProvider(ALIAS_TOK)
        .useClass(LifecycleMock)
        .compile();

      try {
        await mod2.init();
        expect(mod2.get(VALUE_TOK)).toBeInstanceOf(LifecycleMock);
        expect(mod2.get(ALIAS_TOK)).toBeInstanceOf(LifecycleMock);
        expect(hooks).toEqual(["mock:init", "mock:init"]);
      } finally {
        await mod2.close();
      }
      expect(hooks).toEqual([
        "mock:init",
        "mock:init",
        "mock:destroy",
        "mock:destroy",
      ]);
    });
  });

  describe("Enhancer override regressions (all 5 bugs from #5/#6)", () => {
    it("Bug 1 & 3: APP_GUARD/APP_PIPE/APP_INTERCEPTOR/APP_FILTER override via useFactory with module-private inject deps", async () => {
      const PRIVATE_SECRET = Symbol("PRIVATE_SECRET");

      @Injectable()
      class RealAppGuard implements CanActivate {
        canActivate() {
          return false;
        }
      }

      @Injectable()
      class RealAppPipe implements PipeTransform {
        transform(v: unknown) {
          return v;
        }
      }

      @Injectable()
      class RealAppInterceptor implements BunestInterceptor {
        async intercept(_ctx: ExecutionContext, next: CallHandler) {
          return next.handle();
        }
      }

      class AppDomainError extends Error {}

      @Catch(AppDomainError)
      @Injectable()
      class RealAppFilter implements ExceptionFilter<AppDomainError> {
        catch(err: AppDomainError) {
          return Response.json(
            { from: "real", msg: err.message },
            { status: 418 },
          );
        }
      }

      @Controller("/app-enh")
      class AppEnhController {
        @Get("ok/:word")
        ok(@Param("word") word: string) {
          return { word };
        }

        @Get("err")
        err(): never {
          throw new AppDomainError("oops");
        }
      }

      @Module({
        controllers: [AppEnhController],
        // PRIVATE_SECRET is intentionally NOT exported!
        providers: [
          { provide: PRIVATE_SECRET, useValue: "priv42" },
          { provide: APP_GUARD, useClass: RealAppGuard },
          { provide: APP_PIPE, useClass: RealAppPipe },
          { provide: APP_INTERCEPTOR, useClass: RealAppInterceptor },
          { provide: APP_FILTER, useClass: RealAppFilter },
        ],
      })
      class PrivateEnhancerModule {}

      const mod = await Test.createTestingModule({
        imports: [PrivateEnhancerModule],
      })
        .overrideGuard(RealAppGuard)
        .useFactory({
          factory: (secret: string) => ({
            canActivate: () => secret === "priv42",
          }),
          inject: [PRIVATE_SECRET],
        })
        .overridePipe(RealAppPipe)
        .useFactory({
          factory: (secret: string) => ({
            transform: (v: unknown) => `${String(v)}:${secret}`,
          }),
          inject: [PRIVATE_SECRET],
        })
        .overrideInterceptor(RealAppInterceptor)
        .useFactory({
          factory: (secret: string) => ({
            intercept: async (_ctx: ExecutionContext, next: CallHandler) => ({
              secret,
              data: await next.handle(),
            }),
          }),
          inject: [PRIVATE_SECRET],
        })
        .overrideFilter(RealAppFilter)
        .useFactory({
          factory: (secret: string) => ({
            catch: (err: AppDomainError) =>
              Response.json(
                { from: "factory-filter", secret, msg: err.message },
                { status: 422 },
              ),
          }),
          inject: [PRIVATE_SECRET],
        })
        .compile();

      try {
        const app = mod.createNestApplication();
        await request(app)
          .get("/app-enh/ok/hi")
          .expect(200, { secret: "priv42", data: { word: "hi:priv42" } });

        await request(app).get("/app-enh/err").expect(422, {
          from: "factory-filter",
          secret: "priv42",
          msg: "oops",
        });
      } finally {
        await mod.close();
      }
    });

    it("Bug 2: overrideFilter preserves @Catch(...) on useValue/useFactory and uses NewFilter's @Catch(...) on useClass", async () => {
      class DomainAError extends Error {}
      class DomainBError extends Error {}

      @Catch(DomainAError)
      @Injectable()
      class FilterA implements ExceptionFilter<DomainAError> {
        catch(err: DomainAError) {
          return Response.json(
            { filter: "realA", msg: err.message },
            { status: 409 },
          );
        }
      }

      @Catch(DomainBError)
      @Injectable()
      class FilterB implements ExceptionFilter<DomainBError> {
        catch(err: DomainBError) {
          return Response.json(
            { filter: "classB", msg: err.message },
            { status: 410 },
          );
        }
      }

      @Controller("/filters")
      @UseFilters(FilterA)
      class FilterController {
        @Get("a")
        throwA(): never {
          throw new DomainAError("err-a");
        }

        @Get("b")
        throwB(): never {
          throw new DomainBError("err-b");
        }

        @Get("bad")
        throwBad(): never {
          throw new BadRequestException("std-bad");
        }
      }

      // Case 1: useValue on @UseFilters(FilterA) must catch DomainAError ONLY (not turn into catch-all!)
      const modVal = await Test.createTestingModule({
        controllers: [FilterController],
      })
        .overrideFilter(FilterA)
        .useValue({
          catch: (err: DomainAError) =>
            Response.json(
              { filter: "valA", msg: err.message },
              { status: 418 },
            ),
        })
        .compile();

      try {
        const app = modVal.createNestApplication();
        await request(app)
          .get("/filters/a")
          .expect(418, { filter: "valA", msg: "err-a" });
        // BadRequestException must fall through to DefaultExceptionFilter -> 400 (NOT caught by valA!)
        await request(app)
          .get("/filters/bad")
          .expect(400)
          .expect((res) => {
            expect(res.body.message).toBe("std-bad");
          });
      } finally {
        await modVal.close();
      }

      // Case 2: useValue on APP_FILTER must also preserve @Catch(DomainAError)
      @Controller("/app-filters")
      class AppFilterController {
        @Get("a")
        throwA(): never {
          throw new DomainAError("app-a");
        }
        @Get("bad")
        throwBad(): never {
          throw new BadRequestException("app-bad");
        }
      }

      const modAppVal = await Test.createTestingModule({
        controllers: [AppFilterController],
        providers: [{ provide: APP_FILTER, useClass: FilterA }],
      })
        .overrideFilter(FilterA)
        .useValue({
          catch: (err: DomainAError) =>
            Response.json(
              { filter: "appValA", msg: err.message },
              { status: 418 },
            ),
        })
        .compile();

      try {
        const app = modAppVal.createNestApplication();
        await request(app)
          .get("/app-filters/a")
          .expect(418, { filter: "appValA", msg: "app-a" });
        await request(app)
          .get("/app-filters/bad")
          .expect(400)
          .expect((res) => {
            expect(res.body.message).toBe("app-bad");
          });
      } finally {
        await modAppVal.close();
      }

      // Case 3: useClass(FilterB) must adopt FilterB's @Catch(DomainBError), NOT FilterA's @Catch(DomainAError)
      const modCls = await Test.createTestingModule({
        controllers: [FilterController],
      })
        .overrideFilter(FilterA)
        .useClass(FilterB)
        .compile();

      try {
        const app = modCls.createNestApplication();
        // DomainBError is now caught by FilterB -> 410
        await request(app)
          .get("/filters/b")
          .expect(410, { filter: "classB", msg: "err-b" });
        // DomainAError is NO LONGER caught by FilterB -> unhandled 500
        await request(app).get("/filters/a").expect(500);
      } finally {
        await modCls.close();
      }

      // Case 4: Scope.REQUEST APP_FILTER overridden with useFactory returning a @Catch(DomainBError) class instance
      @Controller("/req-app-filters")
      class ReqAppFilterController {
        @Get("a")
        throwA(): never {
          throw new DomainAError("req-a");
        }
        @Get("b")
        throwB(): never {
          throw new DomainBError("req-b");
        }
      }

      const modReqFactory = await Test.createTestingModule({
        controllers: [ReqAppFilterController],
        providers: [{ provide: APP_FILTER, useClass: FilterA }],
      })
        .overrideFilter(FilterA)
        .useFactory({
          factory: () => new FilterB(),
          scope: Scope.REQUEST,
        })
        .compile();

      try {
        const app = modReqFactory.createNestApplication();
        await request(app)
          .get("/req-app-filters/b")
          .expect(410, { filter: "classB", msg: "req-b" });
        await request(app).get("/req-app-filters/a").expect(500);
      } finally {
        await modReqFactory.close();
      }
    });

    it("Bug 4: imperative app.useGlobalGuards(GuardClass) with overrideGuard(GuardClass).useValue() bypasses original dep/scope validation", async () => {
      const MISSING_AUTH_CLIENT = Symbol("MISSING_AUTH_CLIENT");

      @Injectable()
      class BrokenAuthGuard implements CanActivate {
        constructor(@Inject(MISSING_AUTH_CLIENT) readonly _client: unknown) {}
        canActivate() {
          return false;
        }
      }

      @Controller("/imperative")
      class ImperativeController {
        @Get("ping")
        ping() {
          return { ok: true };
        }
      }

      const mod = await Test.createTestingModule({
        controllers: [ImperativeController],
      })
        .overrideGuard(BrokenAuthGuard)
        .useValue({ canActivate: () => true })
        .compile();

      try {
        const app = mod.createNestApplication();
        app.useGlobalGuards(BrokenAuthGuard);
        await request(app).get("/imperative/ping").expect(200, { ok: true });
      } finally {
        await mod.close();
      }
    });

    it("Bug 5: dual registration (same class as provider AND guard, and as guard AND pipe) overrides independently in both orders", async () => {
      @Injectable()
      class DualProviderGuard implements CanActivate {
        tag() {
          return "real-provider";
        }
        canActivate() {
          return false;
        }
      }

      @Injectable()
      class DualGuardPipe
        implements CanActivate, PipeTransform<string, string>
      {
        canActivate() {
          return false;
        }
        transform(value: string) {
          return `real:${value}`;
        }
      }

      @Controller("/dual")
      class DualController {
        constructor(private readonly svc: DualProviderGuard) {}

        @Get("pg")
        @UseGuards(DualProviderGuard)
        pg() {
          return { tag: this.svc.tag() };
        }

        @Get("gp/:val")
        @UseGuards(DualGuardPipe)
        gp(@Param("val", DualGuardPipe) val: string) {
          return { val };
        }
      }

      // Order A: provider first, guard second; guard first, pipe second
      const modA = await Test.createTestingModule({
        controllers: [DualController],
        providers: [DualProviderGuard],
      })
        .overrideProvider(DualProviderGuard)
        .useValue({ tag: () => "mock-provider", canActivate: () => false })
        .overrideGuard(DualProviderGuard)
        .useValue({ canActivate: () => true })
        .overrideGuard(DualGuardPipe)
        .useValue({ canActivate: () => true })
        .overridePipe(DualGuardPipe)
        .useValue({ transform: (v: string) => `mock-pipe:${v}` })
        .compile();

      try {
        const app = modA.createNestApplication();
        await request(app)
          .get("/dual/pg")
          .expect(200, { tag: "mock-provider" });
        await request(app)
          .get("/dual/gp/x")
          .expect(200, { val: "mock-pipe:x" });
      } finally {
        await modA.close();
      }

      // Order B: reversed registration order
      const modB = await Test.createTestingModule({
        controllers: [DualController],
        providers: [DualProviderGuard],
      })
        .overrideGuard(DualProviderGuard)
        .useValue({ canActivate: () => true })
        .overrideProvider(DualProviderGuard)
        .useValue({ tag: () => "mock-provider-b", canActivate: () => false })
        .overridePipe(DualGuardPipe)
        .useValue({ transform: (v: string) => `mock-pipe-b:${v}` })
        .overrideGuard(DualGuardPipe)
        .useValue({ canActivate: () => true })
        .compile();

      try {
        const app = modB.createNestApplication();
        await request(app)
          .get("/dual/pg")
          .expect(200, { tag: "mock-provider-b" });
        await request(app)
          .get("/dual/gp/y")
          .expect(200, { val: "mock-pipe-b:y" });
      } finally {
        await modB.close();
      }
    });

    it("supports overrideGuard.useExisting(AltGuardToken)", async () => {
      const ALT_GUARD = Symbol("ALT_GUARD");

      @Injectable()
      class DenyGuard implements CanActivate {
        canActivate() {
          return false;
        }
      }

      @Controller("/existing-enh")
      class ExistingEnhController {
        @Get("open")
        @UseGuards(DenyGuard)
        open() {
          return { opened: true };
        }
      }

      const mod = await Test.createTestingModule({
        controllers: [ExistingEnhController],
        providers: [
          { provide: ALT_GUARD, useValue: { canActivate: () => true } },
        ],
      })
        .overrideGuard(DenyGuard)
        .useExisting(ALT_GUARD)
        .compile();

      try {
        const app = mod.createNestApplication();
        await request(app)
          .get("/existing-enh/open")
          .expect(200, { opened: true });
      } finally {
        await mod.close();
      }
    });
  });

  describe("TestingLogger & CapturingLogger", () => {
    const spies: Array<{ mockRestore(): void }> = [];

    afterEach(() => {
      while (spies.length > 0) {
        spies.pop()!.mockRestore();
      }
    });

    it("TestingLogger silences log/warn/debug/verbose and emits error/fatal", () => {
      const logSpy = spyOn(console, "log").mockImplementation(() => {});
      const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
      const errSpy = spyOn(console, "error").mockImplementation(() => {});
      spies.push(logSpy, warnSpy, errSpy);

      const logger = new TestingLogger("Unit");
      logger.log("silent-log");
      logger.warn("silent-warn");
      logger.debug("silent-debug");
      logger.verbose("silent-verbose");
      logger.error("loud-error");
      logger.fatal("loud-fatal");

      expect(logSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
      expect(errSpy).toHaveBeenCalledTimes(2);
    });

    it("CapturingLogger records structured entries and supports filter/find/assertLogged/assertNotLogged/clear", () => {
      const logger = new CapturingLogger();
      logger.log("Server ready", "Bootstrap");
      logger.warn("Cache miss", { key: "k1" }, "CacheService");
      logger.error("DB failed", "Error: conn\n  at connect (db.ts:1:1)");
      logger.debug("trace-details", "DebugCtx");

      expect(logger.entries).toHaveLength(4);
      expect(logger.filter({ level: "warn" })).toHaveLength(1);
      expect(logger.filter({ context: "Bootstrap" })).toHaveLength(1);
      expect(logger.filter({ message: /Cache/ })).toHaveLength(1);

      const found = logger.find({ level: "error", message: "DB failed" });
      expect(found).toBeDefined();
      expect(found?.context).toBeUndefined(); // stack trace not misclassified as context

      expect(logger.assertLogged("Server ready", "log").context).toBe(
        "Bootstrap",
      );
      expect(logger.assertLogged(/Cache miss/, "warn")).toBeDefined();
      logger.assertNotLogged("Something else");
      logger.assertNotLogged("Server ready", "error");

      expect(() => logger.assertLogged("Never logged")).toThrow(
        /Expected a log entry/,
      );
      expect(() => logger.assertNotLogged("Server ready", "log")).toThrow(
        /Expected no log entry/,
      );

      logger.clear();
      expect(logger.entries).toHaveLength(0);
    });
  });

  describe("ContextIdFactory, registerRequestByContextId, select(), { strict, each }, useLogger/flushLogs, createNestApplication", () => {
    it("resolves Scope.REQUEST providers outside HTTP via ContextIdFactory + registerRequestByContextId", async () => {
      let instances = 0;

      @Injectable({ scope: Scope.REQUEST })
      class RequestTenantService {
        readonly instanceId = ++instances;
        constructor(@Inject(REQUEST) readonly req: Request) {}
        getTenant() {
          return this.req.headers.get("x-tenant") ?? "none";
        }
      }

      const mod = await Test.createTestingModule({
        providers: [RequestTenantService],
      }).compile();

      try {
        const ctx1 = ContextIdFactory.create();
        const ctx2 = ContextIdFactory.create();
        mod.registerRequestByContextId(
          createMockRequest("/t1", { headers: { "x-tenant": "acme" } }),
          ctx1,
        );
        mod.registerRequestByContextId(
          createMockRequest("/t2", { headers: { "x-tenant": "globex" } }),
          ctx2,
        );

        const s1a = await mod.resolve(RequestTenantService, ctx1);
        const s1b = await mod.resolve(RequestTenantService, ctx1);
        const s2 = await mod.resolve(RequestTenantService, ctx2);

        expect(s1a).toBe(s1b);
        expect(s1a).not.toBe(s2);
        expect(s1a.getTenant()).toBe("acme");
        expect(s2.getTenant()).toBe("globex");

        // Also supports standalone createRequestContainer()
        const reqContainer = mod.createRequestContainer(
          createMockRequest("/manual", { headers: { "x-tenant": "manual" } }),
        );
        const s3 = await mod.resolve(RequestTenantService, reqContainer);
        expect(s3.getTenant()).toBe("manual");
        await reqContainer.destroy();
      } finally {
        await mod.close();
      }
    });

    it("supports chainable select() (including DynamicModule) and { strict, each: true } lookups", async () => {
      const TAG = Symbol("TAG");

      @Module({})
      class LeafDynamicModule {
        static register(value: string): DynamicModule {
          return {
            module: LeafDynamicModule,
            providers: [{ provide: TAG, useValue: value }],
            exports: [TAG],
          };
        }
      }

      const dynA = LeafDynamicModule.register("dyn-a");
      const dynB = LeafDynamicModule.register("dyn-b");

      @Module({
        imports: [dynA],
        providers: [{ provide: TAG, useValue: "parent-a" }],
      })
      class ParentAModule {}

      @Module({
        imports: [dynB],
        providers: [{ provide: TAG, useValue: "parent-b" }],
      })
      class ParentBModule {}

      const mod = await Test.createTestingModule({
        imports: [ParentAModule, ParentBModule],
      }).compile();

      try {
        // Chainable select on static + DynamicModule
        expect(mod.select(ParentAModule).get<string>(TAG)).toBe("parent-a");
        expect(mod.select(ParentAModule).select(dynA).get<string>(TAG)).toBe(
          "dyn-a",
        );
        expect(mod.select(ParentBModule).select(dynB).get<string>(TAG)).toBe(
          "dyn-b",
        );

        // { each: true } returns all matching registrations across modules
        const allSync = mod.get<string>(TAG, { each: true });
        expect(allSync.sort()).toEqual([
          "dyn-a",
          "dyn-b",
          "parent-a",
          "parent-b",
        ]);

        const allAsync = await mod.resolve<string>(TAG, undefined, {
          each: true,
        });
        expect(allAsync.sort()).toEqual([
          "dyn-a",
          "dyn-b",
          "parent-a",
          "parent-b",
        ]);

        // strict + each narrows to selected module
        expect(
          mod
            .select(ParentAModule)
            .get<string>(TAG, { strict: true, each: true }),
        ).toEqual(["parent-a"]);
      } finally {
        await mod.close();
      }
    });

    it("supports useLogger(), bufferLogs/flushLogs(), and overloaded createNestApplication()", async () => {
      const captured = new CapturingLogger();

      @Controller("/ctx")
      class CtxController {
        @Get("boom")
        boom(): never {
          throw new Error("internal-boom-for-logger");
        }
      }

      const mod = await Test.createTestingModule(
        { controllers: [CtxController] },
        { bufferLogs: true, autoFlushLogs: false },
      ).compile();

      try {
        // Explicit adapter overload of createNestApplication
        const customAdapter = new BunHttpAdapter();
        const app = mod.createNestApplication(customAdapter);
        expect(app.getHttpAdapter()).toBe(customAdapter);

        mod.useLogger(captured);
        mod.flushLogs();

        await request(app).get("/ctx/boom").expect(500);
        // DefaultExceptionFilter uses propagated logger
        captured.assertLogged(/internal-boom-for-logger/, "error");
      } finally {
        await mod.close();
      }
    });
  });

  describe("Upgraded mock fixtures (WS/RPC isolation, ResponseContext, Logger, Reflector, RequestContext ALS)", () => {
    it("isolates WS and RPC contexts in createMockExecutionContext without leaking HTTP objects", () => {
      const wsClient = { id: "sock-1" };
      const wsCtx = createMockExecutionContext({
        contextType: "ws",
        ws: { client: wsClient, data: { event: "chat" }, pattern: "chat.send" },
      });

      expect(wsCtx.getType()).toBe("ws");
      expect(wsCtx.switchToWs().getClient()).toBe(wsClient);
      expect(wsCtx.switchToWs().getData()).toEqual({ event: "chat" });
      expect(wsCtx.switchToWs().getPattern()).toBe("chat.send");
      expect(wsCtx.getArgs()).toEqual([
        wsClient,
        { event: "chat" },
        "chat.send",
      ]);
      expect(wsCtx.getArgByIndex(0)).not.toBeInstanceOf(Request);

      const rpcCtx = createMockExecutionContext({
        contextType: "rpc",
        rpc: { data: { orderId: 7 }, context: { topic: "orders" } },
      });
      expect(rpcCtx.getType()).toBe("rpc");
      expect(rpcCtx.switchToRpc().getData()).toEqual({ orderId: 7 });
      expect(rpcCtx.switchToRpc().getContext()).toEqual({ topic: "orders" });
      expect(rpcCtx.getArgs()).toEqual([{ orderId: 7 }, { topic: "orders" }]);
    });

    it("provides createMockResponseContext, createMockLogger, createMockReflector, and runWithMockRequestContext", async () => {
      const resCtx = createMockResponseContext();
      resCtx.status(202).header("x-test", "1").cookie("sid", "abc");
      expect(resCtx.getStatus()).toBe(202);
      expect(resCtx.getHeaders().get("x-test")).toBe("1");

      const mockLogger = createMockLogger();
      mockLogger.log("unit-check", "TestCtx");
      mockLogger.assertLogged("unit-check", "log");

      const META_KEY = Symbol("MOCK_META");
      class MetaTarget {
        @SetMetadata(META_KEY, "real")
        action() {}
      }
      const mockReflector = createMockReflector({
        getAllAndOverride: (() => "overridden-meta") as any,
      });
      expect(
        mockReflector.getAllAndOverride(META_KEY, [
          MetaTarget.prototype.action,
          MetaTarget,
        ]),
      ).toBe("overridden-meta");

      const observed = await runWithMockRequestContext(
        "/als/item/42",
        async (ctx) => {
          await Bun.sleep(1);
          const current = getCurrentRequestContext();
          return {
            same: current === ctx,
            pathname: current?.pathname,
            id: current?.params.id,
          };
        },
        { params: { id: "42" } },
      );
      expect(observed).toEqual({
        same: true,
        pathname: "/als/item/42",
        id: "42",
      });
    });
  });
});
