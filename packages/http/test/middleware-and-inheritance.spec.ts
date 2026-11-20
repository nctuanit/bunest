import "reflect-metadata";
import { describe, expect, test } from "bun:test";
import {
  Controller,
  Get,
  InheritMethodEnhancers,
  Param,
  Reflector,
  RequestMethod,
  SetMetadata,
  UseFilters,
  UseGuards,
  UseInterceptors,
  UseMiddleware,
  UsePipes,
  type ArgumentsHost,
  type BunestInterceptor,
  type BunestMiddleware,
  type CallHandler,
  type CanActivate,
  type ExceptionFilter,
  type ExecutionContext,
  type MiddlewareFunction,
  type NextFunction,
  type PipeTransform,
  type ResponseContext,
} from "@bunest/common";
import { BunHttpAdapter, compileRoutes, DefaultExceptionFilter, DefaultHttpRuntimeBridge, scanControllers } from "../src";

describe("@UseMiddleware() on controllers and route methods", () => {
  test("executes Global -> Module -> Controller -> Method middlewares before guards, interceptors, and handler with zero overhead on plain routes", async () => {
    const order: string[] = [];

    const globalMw: MiddlewareFunction = (_req, _res, next) => {
      order.push("global-mw");
      return next();
    };

    const moduleMw: MiddlewareFunction = (_req, _res, next) => {
      order.push("module-mw");
      return next();
    };

    class ControllerClassMw implements BunestMiddleware {
      use(_req: Request, res: ResponseContext, next: NextFunction) {
        order.push("ctrl-mw-1");
        res.header("X-Ctrl-Mw", "applied");
        return next();
      }
    }

    const ctrlFnMw: MiddlewareFunction = (_req, _res, next) => {
      order.push("ctrl-mw-2");
      return next();
    };

    const methodMw: MiddlewareFunction = (_req, res, next) => {
      order.push("method-mw");
      res.header("X-Method-Mw", "applied");
      return next();
    };

    const shortCircuitMw: MiddlewareFunction = () => {
      order.push("short-circuit-mw");
      return new Response("blocked-by-mw", { status: 418 });
    };

    class TraceGuard implements CanActivate {
      canActivate() {
        order.push("guard");
        return true;
      }
    }

    class TraceInterceptor implements BunestInterceptor {
      async intercept(_ctx: ExecutionContext, next: CallHandler) {
        order.push("interceptor:before");
        const out = await next.handle();
        order.push("interceptor:after");
        return out;
      }
    }

    @Controller("mw")
    @UseMiddleware(ControllerClassMw)
    @UseMiddleware(ctrlFnMw)
    class MwController {
      @Get("full")
      @UseMiddleware(methodMw)
      @UseGuards(TraceGuard)
      @UseInterceptors(TraceInterceptor)
      full() {
        order.push("handler");
        return { ok: true };
      }

      @Get("blocked")
      @UseMiddleware(shortCircuitMw)
      @UseGuards(TraceGuard)
      blocked() {
        order.push("should-not-run");
        return { ok: false };
      }
    }

    @Controller("fast")
    class PlainController {
      @Get("ping")
      ping() {
        return { pong: true };
      }
    }

    // Verify fast-singleton flag is preserved on routes without @UseMiddleware
    const scanned = scanControllers([MwController, PlainController]);
    const compiled = await compileRoutes({
      scannedRoutes: scanned,
      bridge: new DefaultHttpRuntimeBridge(),
      globalMiddlewares: [],
      moduleMiddlewares: [],
      globalGuards: [],
      globalPipes: [],
      globalInterceptors: [],
      globalFilters: [],
      defaultFilter: new DefaultExceptionFilter(),
    });
    const plainCompiled = compiled.compiledRoutes.find(
      (r) => r.route.fullPath === "/fast/ping",
    );
    const mwCompiled = compiled.compiledRoutes.find(
      (r) => r.route.fullPath === "/mw/full",
    );
    expect(plainCompiled?.isFastSingleton).toBe(true);
    expect(mwCompiled?.isFastSingleton).toBe(false);

    // Full execution order check
    const adapter = new BunHttpAdapter({ logger: false });
    adapter.use(globalMw);
    adapter.registerModuleMiddlewares([
      {
        middleware: moduleMw,
        include: [{ path: "/mw/*", method: RequestMethod.ALL }],
      },
    ]);
    await adapter.compileControllers([MwController, PlainController]);

    order.length = 0;
    const res = await adapter.fetch(new Request("http://localhost/mw/full"));
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Ctrl-Mw")).toBe("applied");
    expect(res.headers.get("X-Method-Mw")).toBe("applied");
    expect(await res.json()).toEqual({ ok: true });
    expect(order).toEqual([
      "global-mw",
      "module-mw",
      "ctrl-mw-1",
      "ctrl-mw-2",
      "method-mw",
      "guard",
      "interceptor:before",
      "handler",
      "interceptor:after",
    ]);

    // Short-circuit middleware stops before guard & handler
    order.length = 0;
    const blockedRes = await adapter.fetch(
      new Request("http://localhost/mw/blocked"),
    );
    expect(blockedRes.status).toBe(418);
    expect(await blockedRes.text()).toBe("blocked-by-mw");
    expect(order).toEqual([
      "global-mw",
      "module-mw",
      "ctrl-mw-1",
      "ctrl-mw-2",
      "short-circuit-mw",
    ]);
  });
});

describe("Subclass overridden route method enhancer inheritance (Fix C3)", () => {
  test("merges parent method guards, pipes, interceptors, filters, middlewares, and @Roles unless opted out", async () => {
    const trace: string[] = [];
    const reflector = new Reflector();

    class AdminGuard implements CanActivate {
      canActivate(ctx: ExecutionContext) {
        const roles = reflector.getAllAndOverride<string[]>("roles", [
          ctx.getHandler(),
          ctx.getClass(),
        ]);
        trace.push(`admin-guard:${roles?.join(",") ?? "none"}`);
        const req = ctx.switchToHttp().getRequest<Request>();
        return req.headers.get("x-role") === "admin";
      }
    }

    class ChildGuard implements CanActivate {
      canActivate() {
        trace.push("child-guard");
        return true;
      }
    }

    class ParentPipe implements PipeTransform {
      transform(v: unknown) {
        trace.push("parent-pipe");
        return typeof v === "string" ? v.trim() : v;
      }
    }

    class ChildPipe implements PipeTransform {
      transform(v: unknown) {
        trace.push("child-pipe");
        return typeof v === "string" ? v.toUpperCase() : v;
      }
    }

    class ParentInterceptor implements BunestInterceptor {
      async intercept(_ctx: ExecutionContext, next: CallHandler) {
        trace.push("parent-ic:before");
        const out = await next.handle();
        trace.push("parent-ic:after");
        return out;
      }
    }

    class ChildInterceptor implements BunestInterceptor {
      async intercept(_ctx: ExecutionContext, next: CallHandler) {
        trace.push("child-ic:before");
        const out = await next.handle();
        trace.push("child-ic:after");
        return out;
      }
    }

    class ParentFilter implements ExceptionFilter {
      catch(err: unknown, _host: ArgumentsHost) {
        trace.push("parent-filter");
        return new Response(JSON.stringify({ caughtBy: "parent", err: String(err) }), {
          status: 499,
          headers: { "content-type": "application/json" },
        });
      }
    }

    const parentMw: MiddlewareFunction = (_req, _res, next) => {
      trace.push("parent-mw");
      return next();
    };

    const childMw: MiddlewareFunction = (_req, _res, next) => {
      trace.push("child-mw");
      return next();
    };

    @Controller("base-sec")
    class BaseSecController {
      @Get("secret/:name")
      @UseMiddleware(parentMw)
      @UseGuards(AdminGuard)
      @SetMetadata("roles", ["admin"])
      @UsePipes(ParentPipe)
      @UseInterceptors(ParentInterceptor)
      @UseFilters(ParentFilter)
      secret(@Param("name") name: string) {
        return { from: "base", name };
      }

      @Get("fail")
      @UseFilters(ParentFilter)
      fail() {
        throw new Error("base-boom");
      }
    }

    @Controller("sub-sec")
    class SubSecController extends BaseSecController {
      @Get("secret/:name")
      @UseMiddleware(childMw)
      @UseGuards(ChildGuard)
      @UsePipes(ChildPipe)
      @UseInterceptors(ChildInterceptor)
      override secret(@Param("name") name: string) {
        trace.push(`sub-handler:${name}`);
        return { from: "sub", name };
      }

      @Get("fail")
      override fail() {
        throw new Error("sub-boom");
      }
    }

    @Controller("optout-sec")
    class OptOutController extends BaseSecController {
      @Get("secret/:name")
      @InheritMethodEnhancers(false)
      override secret(@Param("name") name: string) {
        return { from: "optout", name };
      }
    }

    const adapter = new BunHttpAdapter({ logger: false });
    await adapter.compileControllers([
      BaseSecController,
      SubSecController,
      OptOutController,
    ]);

    // 1. SubSecController enforces inherited AdminGuard even without repeating @UseGuards(AdminGuard) / @Roles!
    trace.length = 0;
    const denied = await adapter.fetch(
      new Request("http://localhost/sub-sec/secret/ada"),
    );
    expect(denied.status).toBe(499); // Caught by inherited ParentFilter!
    expect(trace).toEqual([
      "parent-mw",
      "child-mw",
      "admin-guard:admin",
      "parent-filter",
    ]);

    // 2. When authorized, parent enhancers execute before child enhancers!
    trace.length = 0;
    const allowed = await adapter.fetch(
      new Request("http://localhost/sub-sec/secret/%20ada%20", {
        headers: { "x-role": "admin" },
      }),
    );
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ from: "sub", name: "ADA" });
    expect(trace).toEqual([
      "parent-mw",
      "child-mw",
      "admin-guard:admin",
      "child-guard",
      "parent-ic:before",
      "child-ic:before",
      "parent-pipe",
      "child-pipe",
      "sub-handler:ADA",
      "child-ic:after",
      "parent-ic:after",
    ]);

    // 3. Inherited filter catches exception thrown by overridden fail()
    trace.length = 0;
    const failed = await adapter.fetch(
      new Request("http://localhost/sub-sec/fail"),
    );
    expect(failed.status).toBe(499);
    expect(trace).toEqual(["parent-filter"]);

    // 4. Opt-out via @InheritMethodEnhancers(false) skips parent guards/pipes/filters
    const optOut = await adapter.fetch(
      new Request("http://localhost/optout-sec/secret/ada"),
    );
    expect(optOut.status).toBe(200);
    expect(await optOut.json()).toEqual({ from: "optout", name: "ada" });

    // 5. BaseSecController metadata was NEVER mutated by SubSecController
    trace.length = 0;
    const baseOk = await adapter.fetch(
      new Request("http://localhost/base-sec/secret/ada", {
        headers: { "x-role": "admin" },
      }),
    );
    expect(baseOk.status).toBe(200);
    expect(await baseOk.json()).toEqual({ from: "base", name: "ada" });
    expect(trace).toEqual([
      "parent-mw",
      "admin-guard:admin",
      "parent-ic:before",
      "parent-pipe",
      "parent-ic:after",
    ]);
  });
});
