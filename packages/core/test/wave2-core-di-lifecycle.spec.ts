import { describe, expect, it, spyOn } from "bun:test";
import {
  APP_FILTER,
  APP_GUARD,
  APP_INTERCEPTOR,
  APP_PIPE,
  BadRequestException,
  BunestFactory,
  Catch,
  ContextIdFactory,
  Controller,
  Get,
  Inject,
  Injectable,
  Logger,
  MODULE_FILTER,
  MODULE_GUARD,
  MODULE_INTERCEPTOR,
  MODULE_PIPE,
  Module,
  Query,
  REQUEST,
  Scope,
  ShutdownSignal,
  UseFilters,
  UseGuards,
  UseInterceptors,
  UseMiddleware,
  UsePipes,
  type ArgumentMetadata,
  type ArgumentsHost,
  type BeforeApplicationShutdown,
  type BunestInterceptor,
  type BunestMiddleware,
  type BunestModule,
  type CallHandler,
  type CanActivate,
  type ContextId,
  type ContextIdStrategy,
  type ExceptionFilter,
  type ExecutionContext,
  type HostComponentInfo,
  type MiddlewareConsumer,
  type NextFunction,
  type OnApplicationBootstrap,
  type OnApplicationListen,
  type OnApplicationShutdown,
  type OnModuleDestroy,
  type OnModuleInit,
  type PipeTransform,
  type ResponseContext,
} from "../src/index";

describe("Wave 2: Core DI, Module-Scoped Enhancers, and Lifecycle", () => {
  describe("1. Shallow Module-Scoped Enhancer Tokens (MODULE_*)", () => {
    it("applies MODULE_* enhancers only to the owning module's controllers (never imported or importing)", async () => {
      const log: string[] = [];

      @Injectable()
      class ChildGuard implements CanActivate {
        canActivate(): boolean {
          log.push("child-guard");
          return true;
        }
      }

      @Injectable()
      class MidGuard implements CanActivate {
        canActivate(): boolean {
          log.push("mid-guard");
          return true;
        }
      }

      @Injectable()
      class MidPipe implements PipeTransform {
        transform(value: unknown): unknown {
          log.push("mid-pipe");
          return typeof value === "string" ? `mid:${value}` : value;
        }
      }

      @Injectable()
      class MidInterceptor implements BunestInterceptor {
        async intercept(_ctx: ExecutionContext, next: CallHandler) {
          log.push("mid-interceptor:before");
          const res = await next.handle();
          log.push("mid-interceptor:after");
          return res;
        }
      }

      @Catch(BadRequestException)
      class MidFilter implements ExceptionFilter {
        catch(exception: BadRequestException, host: ArgumentsHost) {
          log.push("mid-filter");
          host.switchToHttp().getResponse<ResponseContext>().status(418);
          return {
            caughtBy: "MidFilter",
            message: exception.message,
          };
        }
      }

      @Controller("child")
      class ChildController {
        @Get("ok")
        ok(@Query("v") v: string) {
          return { v };
        }

        @Get("err")
        err() {
          throw new BadRequestException("child-err");
        }
      }

      @Module({
        controllers: [ChildController],
        providers: [{ provide: MODULE_GUARD, useClass: ChildGuard }],
      })
      class ChildModule {}

      @Controller("mid")
      class MidController {
        @Get("ok")
        ok(@Query("v") v: string) {
          return { v };
        }

        @Get("err")
        err() {
          throw new BadRequestException("mid-err");
        }
      }

      @Module({
        imports: [ChildModule],
        controllers: [MidController],
        providers: [
          { provide: MODULE_GUARD, useClass: MidGuard },
          { provide: MODULE_PIPE, useClass: MidPipe },
          { provide: MODULE_INTERCEPTOR, useClass: MidInterceptor },
          { provide: MODULE_FILTER, useClass: MidFilter },
        ],
      })
      class MidModule {}

      @Controller("parent")
      class ParentController {
        @Get("ok")
        ok(@Query("v") v: string) {
          return { v };
        }

        @Get("err")
        err() {
          throw new BadRequestException("parent-err");
        }
      }

      @Module({
        imports: [MidModule],
        controllers: [ParentController],
      })
      class ParentModule {}

      const app = await BunestFactory.create(ParentModule, { logger: false });
      await app.init();

      // MidModule controller gets all MidModule enhancers and NOT ChildGuard
      log.length = 0;
      const midRes = await app.inject({ method: "GET", url: "/mid/ok?v=hello" });
      expect(midRes.statusCode).toBe(200);
      expect(midRes.json()).toEqual({ v: "mid:hello" });
      expect(log).toEqual([
        "mid-guard",
        "mid-interceptor:before",
        "mid-pipe",
        "mid-interceptor:after",
      ]);

      // MidModule error caught by MidFilter
      log.length = 0;
      const midErr = await app.inject({ method: "GET", url: "/mid/err" });
      expect(midErr.statusCode).toBe(418);
      expect(midErr.json()).toEqual({
        caughtBy: "MidFilter",
        message: "mid-err",
      });
      expect(log).toContain("mid-filter");

      // ChildModule (imported by MidModule) gets ONLY ChildGuard, NOT MidModule enhancers
      log.length = 0;
      const childRes = await app.inject({
        method: "GET",
        url: "/child/ok?v=hello",
      });
      expect(childRes.statusCode).toBe(200);
      expect(childRes.json()).toEqual({ v: "hello" });
      expect(log).toEqual(["child-guard"]);

      const childErr = await app.inject({ method: "GET", url: "/child/err" });
      expect(childErr.statusCode).toBe(400);

      // ParentModule (importing MidModule) gets NO MidModule or ChildModule enhancers
      log.length = 0;
      const parentRes = await app.inject({
        method: "GET",
        url: "/parent/ok?v=hello",
      });
      expect(parentRes.statusCode).toBe(200);
      expect(parentRes.json()).toEqual({ v: "hello" });
      expect(log).toEqual([]);

      const parentErr = await app.inject({ method: "GET", url: "/parent/err" });
      expect(parentErr.statusCode).toBe(400);

      await app.close();
    });

    it("executes enhancers in exact order: APP_* -> MODULE_* -> class -> method (and reversed for filters)", async () => {
      const order: string[] = [];

      const mkGuard = (label: string): CanActivate => ({
        canActivate: () => {
          order.push(`guard:${label}`);
          return true;
        },
      });
      const mkPipe = (label: string): PipeTransform => ({
        transform: (v: unknown) => {
          order.push(`pipe:${label}`);
          return `${String(v)}>${label}`;
        },
      });
      const mkInterceptor = (label: string): BunestInterceptor => ({
        intercept: async (_ctx, next) => {
          order.push(`int:in:${label}`);
          const res = await next.handle();
          order.push(`int:out:${label}`);
          return res;
        },
      });

      class CustomError extends Error {}

      @Catch(CustomError)
      class AppErrFilter implements ExceptionFilter {
        catch(_e: CustomError, host: ArgumentsHost) {
          order.push("filter:app");
          host.switchToHttp().getResponse<ResponseContext>().status(500);
          return { caughtBy: "app" };
        }
      }

      @Catch(CustomError)
      class ModuleErrFilter implements ExceptionFilter {
        catch(_e: CustomError, host: ArgumentsHost) {
          order.push("filter:module");
          host.switchToHttp().getResponse<ResponseContext>().status(500);
          return { caughtBy: "module" };
        }
      }

      @Catch(CustomError)
      class ClassErrFilter implements ExceptionFilter {
        catch(_e: CustomError, host: ArgumentsHost) {
          order.push("filter:class");
          host.switchToHttp().getResponse<ResponseContext>().status(500);
          return { caughtBy: "class" };
        }
      }

      @Catch(CustomError)
      class MethodErrFilter implements ExceptionFilter {
        catch(_e: CustomError, host: ArgumentsHost) {
          order.push("filter:method");
          host.switchToHttp().getResponse<ResponseContext>().status(500);
          return { caughtBy: "method" };
        }
      }

      @Controller("order")
      @UseGuards(mkGuard("class"))
      @UseInterceptors(mkInterceptor("class"))
      @UsePipes(mkPipe("class"))
      @UseFilters(ClassErrFilter)
      class OrderController {
        @Get("ok")
        @UseGuards(mkGuard("method"))
        @UseInterceptors(mkInterceptor("method"))
        @UsePipes(mkPipe("method"))
        ok(@Query("x") x: string) {
          order.push("handler");
          return { x };
        }

        @Get("err-method")
        @UseFilters(MethodErrFilter)
        errMethod() {
          throw new CustomError("boom");
        }
      }

      @Controller("mod-filter-only")
      class ModFilterOnlyController {
        @Get("err")
        err() {
          throw new CustomError("boom");
        }
      }

      @Module({
        controllers: [OrderController, ModFilterOnlyController],
        providers: [
          { provide: APP_GUARD, useValue: mkGuard("app") },
          { provide: MODULE_GUARD, useValue: mkGuard("module") },
          { provide: APP_INTERCEPTOR, useValue: mkInterceptor("app") },
          { provide: MODULE_INTERCEPTOR, useValue: mkInterceptor("module") },
          { provide: APP_PIPE, useValue: mkPipe("app") },
          { provide: MODULE_PIPE, useValue: mkPipe("module") },
          { provide: APP_FILTER, useClass: AppErrFilter },
          { provide: MODULE_FILTER, useClass: ModuleErrFilter },
        ],
      })
      class OrderModule {}

      const app = await BunestFactory.create(OrderModule, { logger: false });
      await app.init();

      order.length = 0;
      const okRes = await app.inject({ method: "GET", url: "/order/ok?x=1" });
      expect(okRes.statusCode).toBe(200);
      expect(okRes.json()).toEqual({ x: "1>app>module>class>method" });
      expect(order).toEqual([
        "guard:app",
        "guard:module",
        "guard:class",
        "guard:method",
        "int:in:app",
        "int:in:module",
        "int:in:class",
        "int:in:method",
        "pipe:app",
        "pipe:module",
        "pipe:class",
        "pipe:method",
        "handler",
        "int:out:method",
        "int:out:class",
        "int:out:module",
        "int:out:app",
      ]);

      // Method filter beats class/module/app
      order.length = 0;
      const errMethod = await app.inject({
        method: "GET",
        url: "/order/err-method",
      });
      expect(errMethod.json()).toEqual({ caughtBy: "method" });

      // Module filter beats APP_FILTER when no method/class filter is present
      order.length = 0;
      const errMod = await app.inject({
        method: "GET",
        url: "/mod-filter-only/err",
      });
      expect(errMod.json()).toEqual({ caughtBy: "module" });

      await app.close();
    });

    it("supports Scope.REQUEST and Scope.TRANSIENT MODULE_* enhancers", async () => {
      let transientConstructs = 0;
      const seenHeaders: string[] = [];

      @Injectable({ scope: Scope.REQUEST })
      class ReqScopedModuleGuard implements CanActivate {
        constructor(@Inject(REQUEST) private readonly req: Request) {}
        canActivate(): boolean {
          seenHeaders.push(this.req.headers.get("x-user") ?? "none");
          return true;
        }
      }

      @Injectable({ scope: Scope.TRANSIENT })
      class TransientModulePipe implements PipeTransform {
        private readonly id: number;
        constructor() {
          this.id = ++transientConstructs;
        }
        transform(value: unknown, _meta: ArgumentMetadata): unknown {
          return `${String(value)}#${this.id}`;
        }
      }

      @Controller("scoped")
      class ScopedController {
        @Get("test")
        test(@Query("v") v: string) {
          return { v };
        }
      }

      @Module({
        controllers: [ScopedController],
        providers: [
          { provide: MODULE_GUARD, useClass: ReqScopedModuleGuard },
          { provide: MODULE_PIPE, useClass: TransientModulePipe },
        ],
      })
      class ScopedModule {}

      const app = await BunestFactory.create(ScopedModule, { logger: false });
      await app.init();

      const r1 = await app.inject({
        method: "GET",
        url: "/scoped/test?v=a",
        headers: { "x-user": "alice" },
      });
      const r2 = await app.inject({
        method: "GET",
        url: "/scoped/test?v=b",
        headers: { "x-user": "bob" },
      });

      expect(seenHeaders).toEqual(["alice", "bob"]);
      expect(r1.json<{ v: string }>().v).toBe("a#1");
      expect(r2.json<{ v: string }>().v).toBe("b#2");
      expect(transientConstructs).toBe(2);

      await app.close();
    });

    it("validates invalid MODULE_* useValue enhancers just like APP_*", async () => {
      @Controller("bad")
      class BadController {
        @Get()
        index() {
          return "ok";
        }
      }

      @Module({
        controllers: [BadController],
        providers: [{ provide: MODULE_GUARD, useValue: {} }],
      })
      class BadGuardModule {}

      await expect(
        BunestFactory.create(BadGuardModule, { logger: false }),
      ).rejects.toThrow(/MODULE_GUARD.*canActivate/);
    });
  });

  describe("2. Durable Provider Fallback Warning (PR #18520)", () => {
    it("emits a deduplicated Logger.warn when durable provider falls back to caller REQUEST without payload", async () => {
      const warnSpy = spyOn(Logger.prototype, "warn").mockImplementation(
        () => {},
      );
      const prevStrategy = ContextIdFactory.getStrategy();

      try {
        const tenantContextId = ContextIdFactory.create();
        const strategyWithoutPayload: ContextIdStrategy = {
          attach(contextId: ContextId, _request: unknown) {
            return (info: HostComponentInfo) =>
              info.isTreeDurable ? tenantContextId : contextId;
          },
        };
        ContextIdFactory.apply(strategyWithoutPayload);

        @Injectable({ scope: Scope.REQUEST, durable: true })
        class DurableService {
          constructor(@Inject(REQUEST) public readonly req: unknown) {}
        }

        @Module({
          providers: [DurableService],
        })
        class DurableAppModule {}

        const ctx = await BunestFactory.createApplicationContext(
          DurableAppModule,
          { logger: false },
        );

        const req1 = { id: "req-1" };
        const ctxId1 = ContextIdFactory.getByRequest(req1);
        ctx.registerRequestByContextId(req1, ctxId1);
        const s1 = await ctx.resolve(DurableService, ctxId1);
        expect(s1.req).toEqual(req1);

        // Second request with same durable tenant should not spam the warning
        const req2 = { id: "req-2" };
        const ctxId2 = ContextIdFactory.getByRequest(req2);
        ctx.registerRequestByContextId(req2, ctxId2);
        const s2 = await ctx.resolve(DurableService, ctxId2);
        expect(s2).toBe(s1);

        const durableWarnings = warnSpy.mock.calls.filter(
          (args) =>
            typeof args[0] === "string" &&
            args[0].includes("DurableService") &&
            args[0].includes("ContextIdStrategy.attach()"),
        );
        expect(durableWarnings.length).toBe(1);

        await ctx.close();
      } finally {
        ContextIdFactory.apply(prevStrategy);
        warnSpy.mockRestore();
      }
    });

    it("does NOT warn when ContextIdStrategy.attach() provides a payload", async () => {
      const warnSpy = spyOn(Logger.prototype, "warn").mockImplementation(
        () => {},
      );
      const prevStrategy = ContextIdFactory.getStrategy();

      try {
        const tenantContextId = ContextIdFactory.create();
        const strategyWithPayload: ContextIdStrategy = {
          attach(contextId: ContextId, _request: unknown) {
            return {
              resolve: (info: HostComponentInfo) =>
                info.isTreeDurable ? tenantContextId : contextId,
              payload: { tenantId: "acme" },
            };
          },
        };
        ContextIdFactory.apply(strategyWithPayload);

        @Injectable({ scope: Scope.REQUEST, durable: true })
        class PayloadDurableService {
          constructor(
            @Inject(REQUEST) public readonly tenant: { tenantId: string },
          ) {}
        }

        @Module({
          providers: [PayloadDurableService],
        })
        class PayloadDurableModule {}

        const ctx = await BunestFactory.createApplicationContext(
          PayloadDurableModule,
          { logger: false },
        );

        const req = { id: "req-1" };
        const ctxId = ContextIdFactory.getByRequest(req);
        ctx.registerRequestByContextId(req, ctxId);
        const svc = await ctx.resolve(PayloadDurableService, ctxId);
        expect(svc.tenant).toEqual({ tenantId: "acme" });

        const durableWarnings = warnSpy.mock.calls.filter(
          (args) =>
            typeof args[0] === "string" &&
            args[0].includes("PayloadDurableService"),
        );
        expect(durableWarnings.length).toBe(0);

        await ctx.close();
      } finally {
        ContextIdFactory.apply(prevStrategy);
        warnSpy.mockRestore();
      }
    });
  });

  describe("3. enableShutdownHooks(signals?, options?: { useProcessExit?: boolean })", () => {
    it("calls process.exit(0) after close() when useProcessExit is true", async () => {
      const exitSpy = spyOn(process, "exit").mockImplementation(
        (() => {}) as never,
      );
      let shutdownSignal: string | undefined;

      @Injectable()
      class HookService implements OnApplicationShutdown {
        onApplicationShutdown(signal?: string) {
          shutdownSignal = signal;
        }
      }

      @Module({ providers: [HookService] })
      class ExitModule {}

      const ctx = await BunestFactory.createApplicationContext(ExitModule, {
        logger: false,
      });

      try {
        ctx.enableShutdownHooks([ShutdownSignal.SIGUSR2], {
          useProcessExit: true,
        });
        process.emit("SIGUSR2" as NodeJS.Signals);
        await new Promise((r) => setTimeout(r, 25));

        expect(shutdownSignal).toBe("SIGUSR2");
        expect(exitSpy).toHaveBeenCalledWith(0);
      } finally {
        await ctx.close();
        exitSpy.mockRestore();
      }
    });

    it("does NOT call process.exit when useProcessExit is false or omitted", async () => {
      const exitSpy = spyOn(process, "exit").mockImplementation(
        (() => {}) as never,
      );

      @Module({})
      class NoExitModule {}

      const ctx = await BunestFactory.createApplicationContext(NoExitModule, {
        logger: false,
      });

      try {
        ctx.enableShutdownHooks([ShutdownSignal.SIGUSR2]);
        process.emit("SIGUSR2" as NodeJS.Signals);
        await new Promise((r) => setTimeout(r, 25));

        expect(exitSpy).not.toHaveBeenCalled();
      } finally {
        await ctx.close();
        exitSpy.mockRestore();
      }
    });
  });

  describe("4. enableProcessErrorHandlers(options?)", () => {
    it("invokes handler with origin and re-entrancy-guarded shutdown(), and cleans up listeners on close()", async () => {
      const exitSpy = spyOn(process, "exit").mockImplementation(
        (() => {}) as never,
      );
      const beforeRejectionCount = process.listenerCount("unhandledRejection");
      const beforeExceptionCount = process.listenerCount("uncaughtException");

      let destroyCalls = 0;
      @Injectable()
      class CleanupService implements OnModuleDestroy {
        onModuleDestroy() {
          destroyCalls++;
        }
      }

      @Module({ providers: [CleanupService] })
      class ErrHandlerModule {}

      const ctx = await BunestFactory.createApplicationContext(
        ErrHandlerModule,
        { logger: false },
      );

      const received: Array<{ origin: string; error: unknown }> = [];
      try {
        ctx.enableProcessErrorHandlers({
          unhandledRejection: async (err, { origin, shutdown }) => {
            received.push({ origin, error: err });
            // Calling shutdown twice concurrently should be re-entrancy guarded
            await Promise.all([
              shutdown({ exitCode: 42, timeout: 1000 }),
              shutdown({ exitCode: 99, timeout: 1000 }),
            ]);
          },
          uncaughtException: false,
        });

        expect(process.listenerCount("unhandledRejection")).toBe(
          beforeRejectionCount + 1,
        );
        expect(process.listenerCount("uncaughtException")).toBe(
          beforeExceptionCount,
        );

        const fakeErr = new Error("boom-rejection");
        process.emit("unhandledRejection" as any, fakeErr, Promise.resolve());
        await new Promise((r) => setTimeout(r, 30));

        expect(received).toEqual([
          { origin: "unhandledRejection", error: fakeErr },
        ]);
        expect(destroyCalls).toBe(1);
        expect(exitSpy).toHaveBeenCalledTimes(1);
        expect(exitSpy).toHaveBeenCalledWith(42);
        // Listeners cleaned up by close()
        expect(process.listenerCount("unhandledRejection")).toBe(
          beforeRejectionCount,
        );
      } finally {
        await ctx.close();
        expect(process.listenerCount("unhandledRejection")).toBe(
          beforeRejectionCount,
        );
        expect(process.listenerCount("uncaughtException")).toBe(
          beforeExceptionCount,
        );
        exitSpy.mockRestore();
      }
    });

    it("bounds hanging close() with timeout in shutdown()", async () => {
      const exitSpy = spyOn(process, "exit").mockImplementation(
        (() => {}) as never,
      );

      @Injectable()
      class HangingService implements OnModuleDestroy {
        onModuleDestroy(): Promise<void> {
          return new Promise(() => {
            // intentionally never resolves
          });
        }
      }

      @Module({ providers: [HangingService] })
      class HangingModule {}

      const ctx = await BunestFactory.createApplicationContext(HangingModule, {
        logger: false,
      });

      try {
        ctx.enableProcessErrorHandlers({
          unhandledRejection: async (_err, { shutdown }) => {
            await shutdown({ exitCode: 7, timeout: 40 });
          },
          uncaughtException: false,
        });

        process.emit(
          "unhandledRejection" as any,
          new Error("hang"),
          Promise.resolve(),
        );
        await new Promise((r) => setTimeout(r, 120));

        expect(exitSpy).toHaveBeenCalledWith(7);
      } finally {
        exitSpy.mockRestore();
      }
    });
  });

  describe("5. OnApplicationListen Lifecycle Hook (PR #2983)", () => {
    it("invokes onApplicationListen() on modules, providers, and controllers AFTER listen() binds socket", async () => {
      const events: string[] = [];

      @Injectable()
      class ListenProvider
        implements OnModuleInit, OnApplicationBootstrap, OnApplicationListen
      {
        onModuleInit() {
          events.push("provider:init");
        }
        onApplicationBootstrap() {
          events.push("provider:bootstrap");
        }
        onApplicationListen() {
          events.push("provider:listen");
        }
      }

      @Controller("listen-test")
      class ListenController implements OnApplicationListen {
        @Get("ping")
        ping() {
          return "pong";
        }
        onApplicationListen() {
          events.push("controller:listen");
        }
      }

      @Module({
        controllers: [ListenController],
        providers: [ListenProvider],
      })
      class ListenModule implements OnApplicationListen {
        onApplicationListen() {
          events.push("module:listen");
        }
      }

      const app = await BunestFactory.create(ListenModule, { logger: false });
      try {
        await app.init();
        // onApplicationListen MUST NOT have run during init()
        expect(events).toEqual(["provider:init", "provider:bootstrap"]);

        const info = await app.listen(0);
        expect(info.port).toBeGreaterThan(0);
        expect(events).toContain("provider:listen");
        expect(events).toContain("module:listen");
        expect(events).toContain("controller:listen");
        expect(events.indexOf("provider:bootstrap")).toBeLessThan(
          events.indexOf("provider:listen"),
        );
      } finally {
        await app.close();
      }
    });
  });

  describe("6. Wrap non-Error throws in lifecycle hooks (PR #16789)", () => {
    it("wraps non-Error throws in onModuleInit with module/class context and cause", async () => {
      @Injectable()
      class StringThrowService implements OnModuleInit {
        onModuleInit() {
          throw "init-failed-string";
        }
      }

      @Module({ providers: [StringThrowService] })
      class BadInitModule {}

      let caught: unknown;
      try {
        const ctx = await BunestFactory.createApplicationContext(
          BadInitModule,
          { logger: false },
        );
        await ctx.close();
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      const error = caught as Error & { cause?: unknown };
      expect(error.message).toContain("onModuleInit");
      expect(error.message).toContain("StringThrowService");
      expect(error.message).toContain("BadInitModule");
      expect(error.message).toContain("init-failed-string");
      expect(error.cause).toBe("init-failed-string");
    });

    it("wraps non-Error throws in onApplicationBootstrap, onApplicationListen, and shutdown hooks", async () => {
      const payloadObj = { code: "E_BOOT" };

      @Injectable()
      class ObjBootstrapService implements OnApplicationBootstrap {
        onApplicationBootstrap() {
          throw payloadObj;
        }
      }

      @Module({ providers: [ObjBootstrapService] })
      class BadBootModule {}

      let bootErr: unknown;
      try {
        const ctx1 = await BunestFactory.createApplicationContext(
          BadBootModule,
          { logger: false },
        );
        await ctx1.close();
      } catch (e) {
        bootErr = e;
      }
      expect(bootErr).toBeInstanceOf(Error);
      expect((bootErr as Error).message).toContain("onApplicationBootstrap");
      expect((bootErr as Error).message).toContain("ObjBootstrapService");
      expect((bootErr as Error & { cause?: unknown }).cause).toBe(payloadObj);

      @Injectable()
      class NumDestroyService
        implements OnModuleDestroy, BeforeApplicationShutdown
      {
        onModuleDestroy() {
          throw 12345;
        }
        beforeApplicationShutdown() {}
      }

      @Module({ providers: [NumDestroyService] })
      class BadDestroyModule {}

      const ctx2 = await BunestFactory.createApplicationContext(
        BadDestroyModule,
        { logger: false },
      );
      await ctx2.init();
      let destroyErr: unknown;
      try {
        await ctx2.close();
      } catch (e) {
        destroyErr = e;
      }
      expect(destroyErr).toBeInstanceOf(Error);
      expect((destroyErr as Error).message).toContain("onModuleDestroy");
      expect((destroyErr as Error).message).toContain("NumDestroyService");
      expect((destroyErr as Error & { cause?: unknown }).cause).toBe(12345);
    });
  });

  describe("7. Middleware Override Support on ApplicationConfig (PR #12541)", () => {
    it("replaces and disables MiddlewareConsumer and @UseMiddleware middlewares cleanly", async () => {
      const log: string[] = [];

      @Injectable()
      class OriginalConsumerMw implements BunestMiddleware {
        use(_req: Request, _res: ResponseContext, next: NextFunction) {
          log.push("original-consumer");
          return next();
        }
      }

      @Injectable()
      class ReplacementConsumerMw implements BunestMiddleware {
        use(_req: Request, _res: ResponseContext, next: NextFunction) {
          log.push("replacement-consumer");
          return next();
        }
      }

      @Injectable()
      class DisabledConsumerMw implements BunestMiddleware {
        use(_req: Request, _res: ResponseContext, next: NextFunction) {
          log.push("disabled-consumer");
          return next();
        }
      }

      const origFnMw = (
        _req: Request,
        _res: ResponseContext,
        next: NextFunction,
      ) => {
        log.push("orig-fn");
        return next();
      };

      const replacementFnMw = (
        _req: Request,
        _res: ResponseContext,
        next: NextFunction,
      ) => {
        log.push("replacement-fn");
        return next();
      };

      const disabledFnMw = (
        _req: Request,
        _res: ResponseContext,
        next: NextFunction,
      ) => {
        log.push("disabled-fn");
        return next();
      };

      @Controller("mw-override")
      @UseMiddleware(origFnMw)
      class MwController {
        @Get("test")
        @UseMiddleware(disabledFnMw)
        test() {
          log.push("handler");
          return { ok: true };
        }
      }

      @Module({
        controllers: [MwController],
      })
      class MwModule implements BunestModule {
        configure(consumer: MiddlewareConsumer) {
          consumer
            .apply(OriginalConsumerMw, DisabledConsumerMw)
            .forRoutes(MwController);
        }
      }

      const app = await BunestFactory.create(MwModule, { logger: false });
      const appConfig = app.getModuleContainer().getApplicationConfig();
      appConfig.setMiddlewareOverrides(
        new Map<unknown, unknown>([
          [OriginalConsumerMw, ReplacementConsumerMw],
          [DisabledConsumerMw, null],
          [origFnMw, replacementFnMw],
          [disabledFnMw, false],
        ]),
      );

      await app.init();

      const res = await app.inject({ method: "GET", url: "/mw-override/test" });
      expect(res.statusCode).toBe(200);
      expect(log).toEqual([
        "replacement-consumer",
        "replacement-fn",
        "handler",
      ]);

      await app.close();
    });
  });
});
