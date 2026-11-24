import { describe, expect, it } from "bun:test";
import {
  All,
  Body,
  Catch,
  Controller,
  Cookies,
  Delete,
  forwardRef,
  Get,
  Global,
  Head,
  Header,
  Headers,
  HostParam,
  HttpCode,
  Inject,
  Injectable,
  Ip,
  isDynamicModule,
  isForwardReference,
  METADATA_KEYS,
  MetadataRegistry,
  Module,
  Optional,
  Options,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
  Redirect,
  Req,
  Res,
  Scope,
  SetMetadata,
  Sse,
  UploadedFile,
  UploadedFiles,
  UseFilters,
  UseGuards,
  UseInterceptors,
  UsePipes,
  createParamDecorator,
  type BunestInterceptor,
  type CanActivate,
  type ExceptionFilter,
  type ExecutionContext,
  type PipeTransform,
} from "../../src/common";

class GuardA implements CanActivate {
  canActivate() {
    return true;
  }
}
class GuardB implements CanActivate {
  canActivate() {
    return true;
  }
}
class GuardC implements CanActivate {
  canActivate() {
    return true;
  }
}
class PipeA implements PipeTransform {
  transform(v: unknown) {
    return v;
  }
}
class PipeB implements PipeTransform {
  transform(v: unknown) {
    return v;
  }
}
class InterceptorA implements BunestInterceptor {
  intercept(_ctx: ExecutionContext, next: { handle(): Promise<unknown> }) {
    return next.handle();
  }
}
class InterceptorB implements BunestInterceptor {
  intercept(_ctx: ExecutionContext, next: { handle(): Promise<unknown> }) {
    return next.handle();
  }
}
@Catch(Error)
class FilterA implements ExceptionFilter {
  catch(err: unknown) {
    return err;
  }
}
class FilterB implements ExceptionFilter {
  catch(err: unknown) {
    return err;
  }
}

describe("Core & DI Decorators", () => {
  it("stores @Module, @Global, @Injectable, @Catch, and @SetMetadata metadata", () => {
    @Injectable({ scope: Scope.REQUEST })
    class ReqScopedService {}

    @Injectable()
    class DefaultService {}

    @Global()
    @Module({
      providers: [ReqScopedService, DefaultService],
      exports: [DefaultService],
    })
    class SharedModule {}

    expect(
      MetadataRegistry.get(METADATA_KEYS.GLOBAL_MODULE, SharedModule),
    ).toBe(true);
    expect(MetadataRegistry.get(METADATA_KEYS.MODULE, SharedModule)).toEqual({
      imports: undefined,
      controllers: undefined,
      providers: [ReqScopedService, DefaultService],
      exports: [DefaultService],
    });
    expect(
      MetadataRegistry.get(METADATA_KEYS.INJECTABLE, DefaultService),
    ).toEqual({ scope: Scope.SINGLETON });
    expect(
      MetadataRegistry.get(METADATA_KEYS.INJECTABLE, ReqScopedService),
    ).toEqual({ scope: Scope.REQUEST });
    expect(
      MetadataRegistry.get(METADATA_KEYS.CATCH_EXCEPTIONS, FilterA),
    ).toEqual([Error]);

    const Roles = SetMetadata("roles", ["admin"]);
    expect(Roles.KEY).toBe("roles");

    @SetMetadata("class-meta", 42)
    class MetaTarget {
      @Roles
      handle() {}
    }

    expect(MetadataRegistry.get("class-meta", MetaTarget)).toBe(42);
    expect(MetadataRegistry.get("roles", MetaTarget.prototype.handle)).toEqual([
      "admin",
    ]);
  });

  it("handles @Inject and @Optional on constructor & properties without mutating parent metadata", () => {
    const TOKEN_A = Symbol("TOKEN_A");
    const TOKEN_B = Symbol("TOKEN_B");
    const TOKEN_C = Symbol("TOKEN_C");

    @Injectable()
    class BaseService {
      @Inject(TOKEN_A)
      @Optional()
      propA?: unknown;

      constructor(
        @Inject(TOKEN_A) public a: unknown,
        @Optional() @Inject(TOKEN_B) public b?: unknown,
      ) {}
    }

    @Injectable()
    class ChildService extends BaseService {
      @Inject(TOKEN_C)
      propC?: unknown;

      constructor(
        @Inject(TOKEN_C) a: unknown,
        @Optional() @Inject(TOKEN_B) b?: unknown,
        @Optional() public c?: string,
      ) {
        super(a, b);
      }
    }

    expect(MetadataRegistry.getInjectTokens(BaseService)).toEqual([
      { index: 0, token: TOKEN_A },
      { index: 1, token: TOKEN_B },
    ]);
    expect(MetadataRegistry.getOptionalDeps(BaseService)).toEqual([1]);

    expect(MetadataRegistry.getInjectTokens(ChildService)).toEqual([
      { index: 0, token: TOKEN_C },
      { index: 1, token: TOKEN_B },
    ]);
    expect(MetadataRegistry.getOptionalDeps(ChildService)).toEqual([1, 2]);

    // Property injections merged cleanly without mutating base
    expect(MetadataRegistry.getPropertyInjectTokens(BaseService)).toEqual([
      { propertyKey: "propA", token: TOKEN_A },
    ]);
    expect(MetadataRegistry.getPropertyInjectTokens(ChildService)).toEqual([
      { propertyKey: "propA", token: TOKEN_A },
      { propertyKey: "propC", token: TOKEN_C },
    ]);
    expect(MetadataRegistry.getOptionalPropertyDeps(BaseService)).toEqual([
      "propA",
    ]);
  });

  it("supports forwardRef and isDynamicModule helpers", () => {
    class LateService {}
    const ref = forwardRef(() => LateService);
    expect(isForwardReference(ref)).toBe(true);
    expect(ref.forwardRef()).toBe(LateService);
    expect(isForwardReference(LateService)).toBe(false);
    expect(isForwardReference(null)).toBe(false);

    class DynMod {}
    expect(isDynamicModule({ module: DynMod, global: true })).toBe(true);
    expect(isDynamicModule(DynMod)).toBe(false);
  });
});

describe("HTTP & Enhancer Decorators + Inheritance Safety", () => {
  it("registers all HTTP verb decorators, @Sse, @HttpCode, @Header, and @Redirect", () => {
    @Controller("/items")
    class ItemsController {
      @Get()
      list() {}

      @Post("create")
      @HttpCode(201)
      @Header("X-First", "1")
      @Header("X-Second", "2")
      create() {}

      @Put(":id")
      replace() {}

      @Patch(":id")
      update() {}

      @Delete(":id")
      remove() {}

      @Options(":id")
      opts() {}

      @Head(":id")
      head() {}

      @All("any/*")
      any() {}

      @Sse("events")
      events() {}

      @Get("old")
      @Redirect("https://example.com", 301)
      old() {}
    }

    expect(
      MetadataRegistry.get(METADATA_KEYS.CONTROLLER, ItemsController),
    ).toEqual({ path: "/items" });

    const routes = MetadataRegistry.getControllerRoutes(ItemsController);
    expect(routes).toEqual([
      { method: "GET", path: "", handlerKey: "list" },
      { method: "POST", path: "create", handlerKey: "create" },
      { method: "PUT", path: ":id", handlerKey: "replace" },
      { method: "PATCH", path: ":id", handlerKey: "update" },
      { method: "DELETE", path: ":id", handlerKey: "remove" },
      { method: "OPTIONS", path: ":id", handlerKey: "opts" },
      { method: "HEAD", path: ":id", handlerKey: "head" },
      { method: "ALL", path: "any/*", handlerKey: "any" },
      { method: "GET", path: "events", handlerKey: "events", isSse: true },
      { method: "GET", path: "old", handlerKey: "old" },
    ]);

    expect(
      MetadataRegistry.get(
        METADATA_KEYS.HTTP_CODE,
        ItemsController.prototype.create,
      ),
    ).toBe(201);
    expect(
      MetadataRegistry.getHeaders(ItemsController.prototype.create),
    ).toEqual([
      { name: "X-First", value: "1" },
      { name: "X-Second", value: "2" },
    ]);
    expect(
      MetadataRegistry.get(
        METADATA_KEYS.REDIRECT,
        ItemsController.prototype.old,
      ),
    ).toEqual({ url: "https://example.com", statusCode: 301 });
    expect(
      MetadataRegistry.get(METADATA_KEYS.SSE, ItemsController.prototype.events),
    ).toBe(true);
  });

  it("NEVER mutates parent controller routes or enhancers when subclass extends it", () => {
    @Controller("/base")
    @UseGuards(GuardA)
    @UsePipes(PipeA)
    @UseInterceptors(InterceptorA)
    @UseFilters(FilterA)
    class BaseController {
      @Get("health")
      health() {}

      @Get("shared")
      shared(@Param("id") id: unknown) {
        return String(id);
      }
    }

    @Controller("/child")
    @UseGuards(GuardB)
    @UseGuards(GuardC)
    @UsePipes(PipeB)
    @UseInterceptors(InterceptorB)
    @UseFilters(FilterB)
    class ChildController extends BaseController {
      @Post("shared")
      override shared(@Body() payload: unknown) {
        return String(payload);
      }

      @Delete(":id")
      remove(@Param("id") id: string) {
        return id;
      }
    }

    // Parent metadata is completely untouched
    expect(MetadataRegistry.getControllerRoutes(BaseController)).toEqual([
      { method: "GET", path: "health", handlerKey: "health" },
      { method: "GET", path: "shared", handlerKey: "shared" },
    ]);
    expect(
      MetadataRegistry.getOwn(METADATA_KEYS.GUARDS, BaseController),
    ).toEqual([GuardA]);
    expect(
      MetadataRegistry.getOwn(METADATA_KEYS.PIPES, BaseController),
    ).toEqual([PipeA]);
    expect(
      MetadataRegistry.getOwn(METADATA_KEYS.INTERCEPTORS, BaseController),
    ).toEqual([InterceptorA]);
    expect(
      MetadataRegistry.getOwn(METADATA_KEYS.EXCEPTION_FILTERS, BaseController),
    ).toEqual([FilterA]);

    // Child metadata has overridden 'shared', inherited 'health', and new 'remove'
    expect(MetadataRegistry.getControllerRoutes(ChildController)).toEqual([
      { method: "GET", path: "health", handlerKey: "health" },
      { method: "POST", path: "shared", handlerKey: "shared" },
      { method: "DELETE", path: ":id", handlerKey: "remove" },
    ]);

    // Stacked enhancers on child preserve top-to-bottom declaration order
    expect(
      MetadataRegistry.getOwn(METADATA_KEYS.GUARDS, ChildController),
    ).toEqual([GuardB, GuardC]);
    expect(
      MetadataRegistry.getMergedClassArray(
        METADATA_KEYS.GUARDS,
        ChildController,
      ),
    ).toEqual([GuardA, GuardB, GuardC]);

    // Overridden method parameter metadata does NOT mutate parent
    expect(
      MetadataRegistry.getRouteParameters(BaseController, "shared"),
    ).toMatchObject([{ index: 0, source: "param", key: "id" }]);
    expect(
      MetadataRegistry.getRouteParameters(ChildController, "shared"),
    ).toMatchObject([{ index: 0, source: "body", key: undefined }]);
  });
});

describe("Parameter Decorators", () => {
  it("supports all built-in parameter decorators and createParamDecorator sorted by parameter index", () => {
    const CurrentUser = createParamDecorator(
      (data: string | undefined, _ctx: ExecutionContext) => data ?? "full-user",
    );
    const customPipe = new PipeA();

    @Controller("/params")
    class ParamsController {
      @Post(":id")
      handle(
        @Param("id", ParseIntPipe) id: number,
        @Query("filter") filter: string,
        @Body("payload", customPipe) payload: Record<string, unknown>,
        @Headers("x-token") token: string,
        @Req() req: Request,
        @Res() res: Response,
        @Ip() ip: string,
        @HostParam("tenant") tenant: string,
        @Cookies("session") session: string,
        @UploadedFile("avatar") avatar: unknown,
        @UploadedFiles("docs") docs: unknown[],
        @CurrentUser("email", customPipe) email: string,
      ) {
        return {
          id,
          filter,
          payload,
          token,
          req,
          res,
          ip,
          tenant,
          session,
          avatar,
          docs,
          email,
        };
      }

      @Get("sparse")
      sparse(
        undecorated0: string,
        @Query("b") b: string,
        undecorated2: number,
        @Param("a") a: string,
      ) {
        return { undecorated0, b, undecorated2, a };
      }

      @Get("custom-pipes-only")
      customPipesOnly(@CurrentUser(customPipe) user: unknown) {
        return user;
      }
    }

    const params = MetadataRegistry.getRouteParameters(
      ParamsController,
      "handle",
    );
    expect(params.map((p) => [p.index, p.source, p.key])).toEqual([
      [0, "param", "id"],
      [1, "query", "filter"],
      [2, "body", "payload"],
      [3, "header", "x-token"],
      [4, "request", undefined],
      [5, "response", undefined],
      [6, "ip", undefined],
      [7, "hostParam", "tenant"],
      [8, "cookies", "session"],
      [9, "uploadedFile", "avatar"],
      [10, "uploadedFiles", "docs"],
      [11, "custom", "email"],
    ]);

    expect(params[0]?.pipes).toEqual([ParseIntPipe]);
    expect(params[2]?.pipes).toEqual([customPipe]);
    expect(params[11]?.pipes).toEqual([customPipe]);
    expect(params[11]?.data).toBe("email");
    expect(typeof params[11]?.factory).toBe("function");

    // Sparse / mixed undecorated parameters preserve exact ascending indices
    const sparseParams = MetadataRegistry.getRouteParameters(
      ParamsController,
      "sparse",
    );
    expect(sparseParams.map((p) => [p.index, p.source, p.key])).toEqual([
      [1, "query", "b"],
      [3, "param", "a"],
    ]);

    // createParamDecorator with pipe as first argument (no data)
    const pipeOnlyParams = MetadataRegistry.getRouteParameters(
      ParamsController,
      "customPipesOnly",
    );
    expect(pipeOnlyParams).toHaveLength(1);
    expect(pipeOnlyParams[0]?.data).toBeUndefined();
    expect(pipeOnlyParams[0]?.pipes).toEqual([customPipe]);
  });

  it("throws on duplicate parameter decorators at the same parameter index", () => {
    expect(() => {
      @Controller("/dup")
      class DuplicateParamController {
        @Post()
        bad(@Body() @Query("x") val: unknown) {
          return val;
        }
      }
      return DuplicateParamController;
    }).toThrow(/Duplicate parameter decorator/);
  });

  it("does NOT leak parent parameter metadata when subclass overrides a method with 0 params", () => {
    @Controller("/base-override")
    class BaseCtrl {
      @Get(":id")
      find(@Param("id") id?: string) {
        return id ?? "all";
      }

      @Get("inherited/:slug")
      inherited(@Param("slug") slug: string) {
        return slug;
      }
    }

    @Controller("/child-override")
    class ChildCtrl extends BaseCtrl {
      @Get("all")
      override find() {
        return "all";
      }
    }

    // Parent keeps its own parameter metadata
    expect(MetadataRegistry.getRouteParameters(BaseCtrl, "find")).toMatchObject(
      [{ index: 0, source: "param", key: "id", metatype: String }],
    );
    // Child overriding with 0 params MUST NOT leak parent's @Param("id")
    expect(MetadataRegistry.getRouteParameters(ChildCtrl, "find")).toEqual([]);
    // Child inheriting an unoverridden method STILL resolves parent's parameter metadata
    expect(
      MetadataRegistry.getRouteParameters(ChildCtrl, "inherited"),
    ).toMatchObject([
      { index: 0, source: "param", key: "slug", metatype: String },
    ]);
  });

  it("does NOT leak parent @Inject/@Optional when subclass declares its own constructor, while inheriting when no own constructor", () => {
    const TOK_A = Symbol("TOK_A");
    const TOK_B = Symbol("TOK_B");

    @Injectable()
    class DepA {}

    @Injectable()
    class BaseSvc {
      constructor(
        @Inject(TOK_A) public a: unknown,
        @Optional() @Inject(TOK_B) public b?: unknown,
      ) {}
    }

    @Injectable()
    class ChildOwnCtor extends BaseSvc {
      constructor(public dep: DepA) {
        super(dep);
      }
    }

    @Injectable()
    class ChildZeroArgCtor extends BaseSvc {
      constructor() {
        super("default");
      }
    }

    @Injectable()
    class ChildInheritedCtor extends BaseSvc {}

    expect(MetadataRegistry.getInjectTokens(BaseSvc)).toEqual([
      { index: 0, token: TOK_A },
      { index: 1, token: TOK_B },
    ]);
    expect(MetadataRegistry.getOptionalDeps(BaseSvc)).toEqual([1]);

    // Subclasses with their own constructors MUST NOT inherit parent @Inject/@Optional
    expect(MetadataRegistry.getInjectTokens(ChildOwnCtor)).toEqual([]);
    expect(MetadataRegistry.getOptionalDeps(ChildOwnCtor)).toEqual([]);
    expect(MetadataRegistry.getInjectTokens(ChildZeroArgCtor)).toEqual([]);
    expect(MetadataRegistry.getOptionalDeps(ChildZeroArgCtor)).toEqual([]);

    // Subclass without its own constructor inherits parent's @Inject/@Optional
    expect(MetadataRegistry.getInjectTokens(ChildInheritedCtor)).toEqual([
      { index: 0, token: TOK_A },
      { index: 1, token: TOK_B },
    ]);
    expect(MetadataRegistry.getOptionalDeps(ChildInheritedCtor)).toEqual([1]);
  });

  it("preserves top-to-bottom declaration order for stacked route decorators on one method AND across methods", () => {
    @Controller("/stacked")
    class StackedController {
      @Get("v1")
      @Get("v2")
      @Get("v3")
      list() {}

      @Post("create")
      create() {}
    }

    expect(MetadataRegistry.getControllerRoutes(StackedController)).toEqual([
      { method: "GET", path: "v1", handlerKey: "list" },
      { method: "GET", path: "v2", handlerKey: "list" },
      { method: "GET", path: "v3", handlerKey: "list" },
      { method: "POST", path: "create", handlerKey: "create" },
    ]);
  });
});
