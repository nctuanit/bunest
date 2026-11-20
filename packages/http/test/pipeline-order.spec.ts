import "reflect-metadata";
import { describe, expect, test } from "bun:test";
import {
  type ArgumentMetadata,
  type ArgumentsHost,
  BadRequestException,
  Body,
  type BunestInterceptor,
  type BunestMiddleware,
  type CallHandler,
  type CanActivate,
  Catch,
  Controller,
  createParamDecorator,
  type ExceptionFilter,
  type ExecutionContext,
  Get,
  Headers,
  HttpException,
  Injectable,
  type InjectionToken,
  type NextFunction,
  Param,
  type PipeTransform,
  Post,
  Query,
  Reflector,
  Req,
  REQUEST,
  REQUEST_CONTEXT,
  RequestMethod,
  Res,
  type ResponseContext,
  Scope,
  SetMetadata,
  type Type,
  UnauthorizedException,
  UseFilters,
  UseGuards,
  UseInterceptors,
  UsePipes,
} from "@bunest/common";
import {
  BunHttpAdapter,
  type HttpRuntimeBridge,
  type RequestScopeContainer,
} from "../src/index";

describe("11-Stage Execution Pipeline Order (ADR-008)", () => {
  test("executes middleware -> guards -> interceptors(before) -> params/pipes -> handler -> interceptors(after) in exact order", async () => {
    const events: string[] = [];

    const globalMw = async (
      _req: Request,
      _res: ResponseContext,
      next: NextFunction,
    ) => {
      events.push("mw:global:before");
      const response = await next();
      events.push("mw:global:after");
      return response;
    };

    class ModuleMw implements BunestMiddleware {
      async use(_req: Request, _res: ResponseContext, next: NextFunction) {
        events.push("mw:module:before");
        const response = await next();
        events.push("mw:module:after");
        return response;
      }
    }

    const createGuard = (label: string): CanActivate => ({
      canActivate: () => {
        events.push(`guard:${label}`);
        return true;
      },
    });

    const createInterceptor = (label: string): BunestInterceptor => ({
      intercept: async (_ctx: ExecutionContext, next: CallHandler) => {
        events.push(`interceptor:${label}:before`);
        const out = await next.handle();
        events.push(`interceptor:${label}:after`);
        return {
          ...(out as Record<string, unknown>),
          [`wrapped_${label}`]: true,
        };
      },
    });

    const createPipe = (label: string): PipeTransform => ({
      transform: (value: unknown, meta: ArgumentMetadata) => {
        events.push(`pipe:${label}:${meta.type}:${meta.data ?? ""}`);
        return typeof value === "string" ? `${value}|${label}` : value;
      },
    });

    const globalGuard = createGuard("global");
    const ctrlGuard = createGuard("controller");
    const methodGuard = createGuard("method");

    const globalIc = createInterceptor("global");
    const ctrlIc = createInterceptor("controller");
    const methodIc = createInterceptor("method");

    const globalPipe = createPipe("global");
    const ctrlPipe = createPipe("controller");
    const methodPipe = createPipe("method");
    const paramPipe = createPipe("param");

    @UseGuards(ctrlGuard)
    @UseInterceptors(ctrlIc)
    @UsePipes(ctrlPipe)
    @Controller("/pipeline")
    class PipelineController {
      @UseGuards(methodGuard)
      @UseInterceptors(methodIc)
      @UsePipes(methodPipe)
      @Get(":id")
      run(
        @Param("id", paramPipe) id: string,
        @Req() req: Request,
        @Res() res: ResponseContext,
      ) {
        events.push("handler");
        res.header("X-Handler-Seen", req.method);
        return { id };
      }
    }

    const adapter = new BunHttpAdapter({ logger: false });
    adapter
      .use(globalMw)
      .registerModuleMiddlewares([
        {
          middleware: ModuleMw,
          include: [{ path: "/pipeline/*", method: RequestMethod.GET }],
        },
        {
          middleware: () => {
            events.push("mw:excluded-should-not-run");
          },
          include: [{ path: "/pipeline/*", method: RequestMethod.ALL }],
          exclude: [{ path: "/pipeline/:id", method: RequestMethod.GET }],
        },
      ])
      .useGlobalGuards(globalGuard)
      .useGlobalInterceptors(globalIc)
      .useGlobalPipes(globalPipe);

    await adapter.compileControllers([PipelineController]);

    const res = await adapter.fetch(new Request("http://localhost/pipeline/42"));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-handler-seen")).toBe("GET");
    expect(await res.json()).toEqual({
      id: "42|global|controller|method|param",
      wrapped_method: true,
      wrapped_controller: true,
      wrapped_global: true,
    });

    // Global/controller/method pipes MUST be skipped for @Req() and @Res()
    expect(events).toEqual([
      "mw:global:before",
      "mw:module:before",
      "guard:global",
      "guard:controller",
      "guard:method",
      "interceptor:global:before",
      "interceptor:controller:before",
      "interceptor:method:before",
      "pipe:global:param:id",
      "pipe:controller:param:id",
      "pipe:method:param:id",
      "pipe:param:param:id",
      "handler",
      "interceptor:method:after",
      "interceptor:controller:after",
      "interceptor:global:after",
      "mw:module:after",
      "mw:global:after",
    ]);
  });

  test("guards returning false throw 403 BEFORE body parsing, interceptors, or pipes run", async () => {
    let bodyRead = false;
    let interceptorCalled = false;
    let pipeCalled = false;

    const denyGuard: CanActivate = {
      canActivate: () => false,
    };

    const spyInterceptor: BunestInterceptor = {
      intercept: (_ctx, next) => {
        interceptorCalled = true;
        return next.handle();
      },
    };

    const spyPipe: PipeTransform = {
      transform: (v) => {
        pipeCalled = true;
        return v;
      },
    };

    @Controller("/secure")
    class SecureController {
      @UseGuards(denyGuard)
      @UseInterceptors(spyInterceptor)
      @UsePipes(spyPipe)
      @Post()
      create(@Body() payload: unknown) {
        return payload;
      }

      @UseGuards({
        canActivate: () => {
          throw new UnauthorizedException("Missing bearer token");
        },
      })
      @Get("auth")
      authOnly() {
        return { ok: true };
      }
    }

    const adapter = new BunHttpAdapter({ logger: false });
    await adapter.compileControllers([SecureController]);

    const stream = new ReadableStream({
      start(controller) {
        bodyRead = true;
        controller.enqueue(new TextEncoder().encode('{"a":1}'));
        controller.close();
      },
    });
    // Reset after ReadableStream constructor's eager start
    bodyRead = false;
    const req = new Request("http://localhost/secure", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
    });
    const bodyStream = req.body!;
    const origGetReader = bodyStream.getReader.bind(bodyStream);
    bodyStream.getReader = (() => {
      bodyRead = true;
      return origGetReader();
    }) as typeof bodyStream.getReader;

    const res403 = await adapter.fetch(req);
    expect(res403.status).toBe(403);
    expect(bodyRead).toBe(false);
    expect(interceptorCalled).toBe(false);
    expect(pipeCalled).toBe(false);

    const res401 = await adapter.fetch(
      new Request("http://localhost/secure/auth"),
    );
    expect(res401.status).toBe(401);
    const body401 = (await res401.json()) as Record<string, unknown>;
    expect(body401.message).toBe("Missing bearer token");
  });

  test("supports middleware short-circuiting, sync next(), and interceptor cache short-circuit", async () => {
    let handlerCalls = 0;

    const shortCircuitInterceptor: BunestInterceptor = {
      intercept: () => ({ cached: true }),
    };

    @Controller("/short")
    class ShortController {
      @Get("blocked")
      blocked() {
        handlerCalls++;
        return { ok: true };
      }

      @UseInterceptors(shortCircuitInterceptor)
      @Get("cached")
      cached() {
        handlerCalls++;
        return { fresh: true };
      }
    }

    const adapter = new BunHttpAdapter({ logger: false });
    adapter.enableCors({ origin: "https://app.test" });
    adapter.use((req, res, next) => {
      res.header("X-MW", "ran");
      if (new URL(req.url).pathname === "/short/blocked") {
        return new Response("blocked-by-mw", { status: 418 });
      }
      // Deliberately invoke next() without returning or awaiting (classic Express style)
      void next();
    });
    await adapter.compileControllers([ShortController]);

    const blockedRes = await adapter.fetch(
      new Request("http://localhost/short/blocked", {
        headers: { origin: "https://app.test" },
      }),
    );
    expect(blockedRes.status).toBe(418);
    expect(await blockedRes.text()).toBe("blocked-by-mw");
    expect(blockedRes.headers.get("access-control-allow-origin")).toBe(
      "https://app.test",
    );
    expect(blockedRes.headers.get("x-mw")).toBe("ran");

    const cachedRes = await adapter.fetch(
      new Request("http://localhost/short/cached"),
    );
    expect(cachedRes.status).toBe(200);
    expect(await cachedRes.json()).toEqual({ cached: true });
    expect(cachedRes.headers.get("x-mw")).toBe("ran");
    expect(handlerCalls).toBe(0);
  });

  test("binds out-of-order, sparse, and custom parameter decorators at exact parameter indices", async () => {
    const UserHeader = createParamDecorator<string>((prefix, ctx) => {
      const req = ctx.switchToHttp().getRequest<Request>();
      return `${prefix}:${req.headers.get("x-user") ?? "anon"}`;
    });

    @Controller("/params")
    class OutOfOrderController {
      @Post(":id")
      handle(
        @Query("sort") sort: string | undefined,
        undecoratedSlot: unknown,
        @Body("title") title: string,
        @UserHeader("usr") user: string,
        @Param("id") id: string,
        @Headers("x-trace") trace: string,
      ) {
        return {
          sort: sort ?? null,
          undecoratedIsUndefined: undecoratedSlot === undefined,
          title,
          user,
          id,
          trace,
        };
      }
    }

    const adapter = new BunHttpAdapter({ logger: false });
    await adapter.compileControllers([OutOfOrderController]);

    const res = await adapter.fetch(
      new Request("http://localhost/params/abc-99?sort=desc", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-user": "alice",
          "x-trace": "trace-1",
        },
        body: JSON.stringify({ title: "Hello" }),
      }),
    );

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      sort: "desc",
      undecoratedIsUndefined: true,
      title: "Hello",
      user: "usr:alice",
      id: "abc-99",
      trace: "trace-1",
    });
  });

  test("executes Exception Filters in Method -> Controller -> Global -> Default precedence honoring @Catch()", async () => {
    class CustomDomainError extends Error {}

    @Catch(BadRequestException)
    class MethodBadRequestFilter implements ExceptionFilter<BadRequestException> {
      catch(err: BadRequestException) {
        return { caughtBy: "method", msg: err.message };
      }
    }

    @Catch(HttpException)
    class ControllerHttpFilter implements ExceptionFilter<HttpException> {
      catch(err: HttpException, host: ArgumentsHost) {
        host.switchToHttp().getResponse().status(err.getStatus());
        return { caughtBy: "controller", status: err.getStatus() };
      }
    }

    @Catch(CustomDomainError)
    class GlobalDomainFilter implements ExceptionFilter<CustomDomainError> {
      catch(err: CustomDomainError) {
        return new Response(
          JSON.stringify({ caughtBy: "global", msg: err.message }),
          { status: 422, headers: { "content-type": "application/json" } },
        );
      }
    }

    @UseFilters(ControllerHttpFilter)
    @Controller("/errors")
    class ErrorController {
      @UseFilters(MethodBadRequestFilter)
      @Get("bad")
      bad() {
        throw new BadRequestException("invalid-input");
      }

      @Get("unauth")
      unauth() {
        throw new UnauthorizedException("nope");
      }

      @Get("domain")
      domain() {
        throw new CustomDomainError("domain-violation");
      }
    }

    const adapter = new BunHttpAdapter({ logger: false });
    adapter.useGlobalFilters(GlobalDomainFilter);
    await adapter.compileControllers([ErrorController]);

    const badRes = await adapter.fetch(new Request("http://localhost/errors/bad"));
    expect(badRes.status).toBe(400);
    expect(await badRes.json()).toEqual({
      caughtBy: "method",
      msg: "invalid-input",
    });

    const unauthRes = await adapter.fetch(
      new Request("http://localhost/errors/unauth"),
    );
    expect(unauthRes.status).toBe(401);
    expect(await unauthRes.json()).toEqual({
      caughtBy: "controller",
      status: 401,
    });

    const domainRes = await adapter.fetch(
      new Request("http://localhost/errors/domain"),
    );
    expect(domainRes.status).toBe(422);
    expect(await domainRes.json()).toEqual({
      caughtBy: "global",
      msg: "domain-violation",
    });
  });

  test("provides ExecutionContext with Reflector metadata access and RequestScopeContainer lifecycle", async () => {
    const Roles = (...roles: string[]) => SetMetadata("roles", roles);
    const reflector = new Reflector();

    class RolesGuard implements CanActivate {
      canActivate(ctx: ExecutionContext): boolean {
        expect(ctx.getType()).toBe("http");
        const required = reflector.getAllAndOverride<string[]>("roles", [
          ctx.getHandler(),
          ctx.getClass(),
        ]);
        if (!required) return true;
        const role = ctx.switchToHttp().getRequest().headers.get("x-role");
        return role !== null && required.includes(role);
      }
    }

    let destroyedCount = 0;
    let resolvedContainers = 0;

    @Controller({ path: "/scoped", scope: Scope.REQUEST })
    class ScopedController {
      public readonly reqId: string;
      constructor(reqId = "default") {
        this.reqId = reqId;
      }

      @Roles("admin")
      @Get("whoami")
      whoami() {
        return { reqId: this.reqId };
      }

      @Get("boom")
      boom() {
        throw new BadRequestException("fail-after-scope");
      }
    }

    const customBridge: HttpRuntimeBridge = {
      requiresRequestScope: (ctrl) => ctrl === ScopedController,
      createRequestContainer: () => {
        resolvedContainers++;
        const values = new Map<InjectionToken, unknown>();
        return {
          registerRequestValue(token, value) {
            values.set(token, value);
          },
          resolve<T>(token: InjectionToken<T>): T {
            return values.get(token) as T;
          },
          async destroy() {
            destroyedCount++;
          },
        } satisfies RequestScopeContainer;
      },
      resolveController: async (_token, reqContainer) => {
        expect(reqContainer).toBeDefined();
        const req = await reqContainer!.resolve<Request>(REQUEST);
        const reqCtx = await reqContainer!.resolve(REQUEST_CONTEXT);
        expect(req).toBeInstanceOf(Request);
        expect(reqCtx).toBeDefined();
        return new ScopedController(
          req.headers.get("x-req-id") ?? "missing",
        );
      },
      resolveEnhancer: <T>(enhancer: Type<T> | T): T =>
        typeof enhancer === "function" ? new (enhancer as Type<T>)() : enhancer,
    };

    const adapter = new BunHttpAdapter({ logger: false });
    adapter.setBridge(customBridge).useGlobalGuards(RolesGuard);
    await adapter.compileControllers([ScopedController]);

    const okRes = await adapter.fetch(
      new Request("http://localhost/scoped/whoami", {
        headers: { "x-role": "admin", "x-req-id": "req-A" },
      }),
    );
    expect(okRes.status).toBe(200);
    expect(await okRes.json()).toEqual({ reqId: "req-A" });

    const deniedRes = await adapter.fetch(
      new Request("http://localhost/scoped/whoami", {
        headers: { "x-role": "guest", "x-req-id": "req-B" },
      }),
    );
    expect(deniedRes.status).toBe(403);

    const errRes = await adapter.fetch(
      new Request("http://localhost/scoped/boom", {
        headers: { "x-req-id": "req-C" },
      }),
    );
    expect(errRes.status).toBe(400);

    // Every request-scoped invocation MUST create & destroy its container (even on error/403)
    expect(resolvedContainers).toBe(3);
    expect(destroyedCount).toBe(3);
  });

  test("resolves request-scoped global ExceptionFilter lazily per-request without failing bootstrap", async () => {
    let createdContainers = 0;
    let destroyedContainers = 0;

    @Catch()
    @Injectable({ scope: Scope.REQUEST })
    class RequestScopedGlobalFilter implements ExceptionFilter {
      constructor(private readonly reqId: string) {}

      catch(exception: unknown) {
        const status =
          exception instanceof HttpException ? exception.getStatus() : 500;
        return new Response(
          JSON.stringify({
            reqId: this.reqId,
            status,
            handledBy: "scoped-global-filter",
          }),
          { status, headers: { "content-type": "application/json" } },
        );
      }
    }

    @Controller("/rgf")
    class RgfController {
      @Get("fail")
      fail() {
        throw new BadRequestException("bad");
      }
    }

    const strictBridge: HttpRuntimeBridge = {
      requiresRequestScope: (_ctrl, tokens) =>
        tokens.includes(RequestScopedGlobalFilter),
      createRequestContainer: () => {
        createdContainers++;
        const map = new Map<InjectionToken, unknown>();
        return {
          registerRequestValue(token, value) {
            map.set(token, value);
          },
          resolve<T>(token: InjectionToken<T>): T {
            return map.get(token) as T;
          },
          async destroy() {
            destroyedContainers++;
          },
        };
      },
      resolveController: (Ctrl) => new Ctrl() as object,
      resolveEnhancer: <T>(
        enhancer: Type<T> | T,
        reqContainer?: RequestScopeContainer,
      ): T => {
        if (enhancer === (RequestScopedGlobalFilter as unknown)) {
          if (!reqContainer) {
            throw new Error(
              "Request-scoped global filter MUST NOT be resolved without a RequestScopeContainer!",
            );
          }
          const req = reqContainer.resolve<Request>(REQUEST) as Request;
          return new RequestScopedGlobalFilter(
            req.headers.get("x-req-id") ?? "none",
          ) as unknown as T;
        }
        return typeof enhancer === "function"
          ? new (enhancer as Type<T>)()
          : enhancer;
      },
    };

    const adapter = new BunHttpAdapter({ logger: false });
    adapter.setBridge(strictBridge).useGlobalFilters(RequestScopedGlobalFilter);

    // Must NOT throw during bootstrap
    await adapter.compileControllers([RgfController]);

    // Fallback 404 uses lazy request container for the request-scoped global filter
    const res404 = await adapter.fetch(
      new Request("http://localhost/missing-route", {
        headers: { "x-req-id": "trace-404" },
      }),
    );
    expect(res404.status).toBe(404);
    expect(await res404.json()).toEqual({
      reqId: "trace-404",
      status: 404,
      handledBy: "scoped-global-filter",
    });

    // Matched route error also resolves the request-scoped global filter
    const res400 = await adapter.fetch(
      new Request("http://localhost/rgf/fail", {
        headers: { "x-req-id": "trace-400" },
      }),
    );
    expect(res400.status).toBe(400);
    expect(await res400.json()).toEqual({
      reqId: "trace-400",
      status: 400,
      handledBy: "scoped-global-filter",
    });

    expect(createdContainers).toBe(2);
    expect(destroyedContainers).toBe(2);
  });

  test("propagates dynamic setLogger() to DefaultExceptionFilter, passes enhancer kind to bridge, and keeps setDiGlobalEnhancers ahead of imperative useGlobal*", async () => {
    const logged: unknown[] = [];
    const seenKinds: Array<string | undefined> = [];
    const guardTrail: string[] = [];

    class MarkerGuard implements CanActivate {
      canActivate() {
        return true;
      }
    }

    @Controller("/hooks")
    class HooksController {
      @Get("ok")
      @UseGuards(MarkerGuard)
      ok() {
        return { ok: true };
      }

      @Get("err")
      err() {
        throw new Error("unhandled-http-err");
      }
    }

    const adapter = new BunHttpAdapter({ logger: false });
    adapter.setBridge({
      resolveController: (C) => new C() as object,
      resolveEnhancer: <T>(
        enhancer: Type<T> | T,
        _rc?: RequestScopeContainer,
        kind?: "guard" | "pipe" | "interceptor" | "filter",
      ): T => {
        if (enhancer === (MarkerGuard as unknown)) {
          seenKinds.push(kind);
          return new MarkerGuard() as unknown as T;
        }
        return typeof enhancer === "function"
          ? new (enhancer as Type<T>)()
          : enhancer;
      },
    });

    // Imperative registered BEFORE DI global enhancers -> DI must still run first
    adapter.useGlobalGuards({
      canActivate: () => {
        guardTrail.push("imperative");
        return true;
      },
    });
    adapter.setDiGlobalEnhancers({
      guards: [
        {
          canActivate: () => {
            guardTrail.push("di");
            return true;
          },
        },
      ],
    });

    await adapter.compileControllers([HooksController]);

    // Update logger AFTER route compilation -> DefaultExceptionFilter must use new logger
    adapter.setLogger({
      log: () => {},
      warn: () => {},
      error: (msg) => logged.push(msg),
    });

    const okRes = await adapter.fetch(new Request("http://localhost/hooks/ok"));
    expect(okRes.status).toBe(200);
    expect(seenKinds).toEqual(["guard"]);
    expect(guardTrail).toEqual(["di", "imperative"]);

    const errRes = await adapter.fetch(new Request("http://localhost/hooks/err"));
    expect(errRes.status).toBe(500);
    expect(logged).toContain("unhandled-http-err");
  });
});
