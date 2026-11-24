import "../../src/common/metadata/reflect-shim";
import { describe, expect, spyOn, test } from "bun:test";
import {
  All,
  Body,
  Controller,
  Get,
  HostParam,
  Param,
  Post,
  Query,
  RequestMethod,
  UseGuards,
  type CanActivate,
  type ExecutionContext,
} from "../../src/common/index";
import {
  BunHttpAdapter,
  canonicalizePath,
  DuplicateRouteException,
  InvalidControllerException,
  isNativeBunRoutePath,
  normalizePath,
  scanControllers,
} from "../../src/http/index";

describe("Path Normalization & Canonical Collision Keys", () => {
  test("normalizes leading, trailing, and repeated slashes per RFC-001", () => {
    expect(normalizePath()).toBe("/");
    expect(normalizePath("", "/")).toBe("/");
    expect(normalizePath("/users/", "/:id/")).toBe("/users/:id");
    expect(normalizePath("///api///", "//v1//users///", "///profile//")).toBe(
      "/api/v1/users/profile",
    );
    expect(normalizePath("health")).toBe("/health");
  });

  test("canonicalizes parameter names to positional placeholders", () => {
    expect(canonicalizePath("/users/:id")).toBe("/users/:_");
    expect(canonicalizePath("/users/:userId")).toBe("/users/:_");
    expect(canonicalizePath("/orgs/:orgId/repos/:repoId")).toBe(
      "/orgs/:_/repos/:_",
    );
    expect(canonicalizePath("/orders/:id(\\d+)")).toBe("/orders/:_(\\d+)");
    expect(canonicalizePath("/archive/:year?")).toBe("/archive/:_?");
  });

  test("classifies Bun.serve native-eligible vs fallback paths per ADR-011", () => {
    expect(isNativeBunRoutePath("/")).toBe(true);
    expect(isNativeBunRoutePath("/users")).toBe(true);
    expect(isNativeBunRoutePath("/users/:id/posts/:postId")).toBe(true);
    expect(isNativeBunRoutePath("/files/*")).toBe(true);
    expect(isNativeBunRoutePath("/:org/files/*")).toBe(true);

    // Non-native advanced patterns -> FallbackRadixRouter
    expect(isNativeBunRoutePath("/files/*/meta")).toBe(false);
    expect(isNativeBunRoutePath("/users/:id?")).toBe(false);
    expect(isNativeBunRoutePath("/orders/:id(\\d+)")).toBe(false);
  });
});

describe("Controller Scanner & Duplicate Route Detection", () => {
  test("fails fast on undecorated controller classes", () => {
    class NotAController {
      list() {
        return [];
      }
    }

    expect(() => scanControllers([NotAController])).toThrow(
      InvalidControllerException,
    );
  });

  test("fails fast on exact duplicate routes and renamed parameter collisions (:id vs :userId)", () => {
    @Controller("/users")
    class ParamCollisionController {
      @Get(":id")
      getById(@Param("id") id: string) {
        return { id };
      }

      @Get(":userId")
      getByUserId(@Param("userId") userId: string) {
        return { userId };
      }
    }

    expect(() => scanControllers([ParamCollisionController])).toThrow(
      DuplicateRouteException,
    );

    @Controller("/items")
    class FirstItemsController {
      @Post()
      create() {
        return {};
      }
    }

    @Controller("items/")
    class SecondItemsController {
      @Post("/")
      createAgain() {
        return {};
      }
    }

    expect(() =>
      scanControllers([FirstItemsController, SecondItemsController]),
    ).toThrow(DuplicateRouteException);
  });

  test("allows same path under different host constraints without collision", () => {
    @Controller({ path: "/status", host: "admin.example.com" })
    class AdminStatusController {
      @Get()
      status() {
        return { scope: "admin" };
      }
    }

    @Controller({ path: "/status", host: "api.example.com" })
    class ApiStatusController {
      @Get()
      status() {
        return { scope: "api" };
      }
    }

    const routes = scanControllers([
      AdminStatusController,
      ApiStatusController,
    ]);
    expect(routes).toHaveLength(2);
  });

  test("supports multi-path controllers, multi-path methods, and global prefix exclusions", async () => {
    @Controller(["v1/items", "v2/items"])
    class MultiController {
      @Get(["", "list"])
      findAll() {
        return { ok: true };
      }
    }

    @Controller("health")
    class HealthController {
      @Get()
      check() {
        return { status: "up" };
      }
    }

    const adapter = new BunHttpAdapter({ logger: false });
    adapter.setGlobalPrefix("api", {
      exclude: [{ path: "health", method: RequestMethod.GET }],
    });

    const compiled = await adapter.compileControllers([
      MultiController,
      HealthController,
    ]);
    const paths = compiled.map((r) => `${r.method} ${r.fullPath}`);

    expect(paths).toContain("GET /api/v1/items");
    expect(paths).toContain("GET /api/v1/items/list");
    expect(paths).toContain("GET /api/v2/items");
    expect(paths).toContain("GET /api/v2/items/list");
    expect(paths).toContain("GET /health");

    const healthRes = await adapter.fetch(
      new Request("http://localhost/health"),
    );
    expect(healthRes.status).toBe(200);
    expect(await healthRes.json()).toEqual({ status: "up" });

    const v2Res = await adapter.fetch(
      new Request("http://localhost/api/v2/items/list"),
    );
    expect(v2Res.status).toBe(200);
    expect(await v2Res.json()).toEqual({ ok: true });
  });

  test("supports controller inheritance without mutating parent metadata", async () => {
    const trace: string[] = [];

    class BaseGuard implements CanActivate {
      canActivate(_ctx: ExecutionContext) {
        trace.push("base-guard");
        return true;
      }
    }

    class ChildGuard implements CanActivate {
      canActivate(_ctx: ExecutionContext) {
        trace.push("child-guard");
        return true;
      }
    }

    @UseGuards(BaseGuard)
    @Controller("/base")
    class BaseController {
      @Get("ping")
      ping() {
        return "base-ping";
      }

      @Get("shared/:id")
      shared(@Param("id") id: string) {
        return { from: "base", id };
      }
    }

    @UseGuards(ChildGuard)
    @Controller("/child")
    class ChildController extends BaseController {
      @Get("shared/:id")
      override shared(@Param("id") id: string, @Query("tag") tag?: string) {
        return { from: "child", id, tag };
      }

      @Get("only-child")
      onlyChild() {
        return "child-only";
      }
    }

    const adapter = new BunHttpAdapter({ logger: false });
    await adapter.compileControllers([BaseController, ChildController]);

    // Parent must NOT inherit child routes or child guard
    const parentOnlyChild = await adapter.fetch(
      new Request("http://localhost/base/only-child"),
    );
    expect(parentOnlyChild.status).toBe(404);

    trace.length = 0;
    const baseShared = await adapter.fetch(
      new Request("http://localhost/base/shared/10?tag=ignored"),
    );
    expect(baseShared.status).toBe(200);
    expect(await baseShared.json()).toEqual({ from: "base", id: "10" });
    expect(trace).toEqual(["base-guard"]);

    trace.length = 0;
    const childPing = await adapter.fetch(
      new Request("http://localhost/child/ping"),
    );
    expect(childPing.status).toBe(200);
    expect(await childPing.text()).toBe("base-ping");
    expect(trace).toEqual(["base-guard", "child-guard"]);

    const childShared = await adapter.fetch(
      new Request("http://localhost/child/shared/99?tag=v2"),
    );
    expect(childShared.status).toBe(200);
    expect(await childShared.json()).toEqual({
      from: "child",
      id: "99",
      tag: "v2",
    });
  });
});

describe("Hybrid Routing & FallbackRadixRouter", () => {
  test("routes host constraints, regex params, optional params, mid-wildcards, and @All precedence", async () => {
    @Controller({ path: "/tenant", host: ":tenant.example.com" })
    class TenantController {
      @Get("info")
      info(@HostParam("tenant") tenant: string) {
        return { tenant };
      }
    }

    @Controller({ path: "/tenant", host: /^admin\./ })
    class AdminHostController {
      @Get("dashboard")
      dashboard() {
        return { admin: true };
      }
    }

    @Controller("/advanced")
    class AdvancedController {
      @Get("orders/:id(\\d+)")
      numericOrder(@Param("id") id: string) {
        return { kind: "numeric", id };
      }

      @Get("archive/:year/:month?")
      archive(@Param("year") year: string, @Param("month") month?: string) {
        return { year, month: month ?? null };
      }

      @Get("files/*/meta")
      fileMeta() {
        return { meta: true };
      }

      @Get("combo")
      comboGet() {
        return { verb: "GET" };
      }

      @All("combo")
      comboAll() {
        return { verb: "ALL" };
      }
    }

    const adapter = new BunHttpAdapter({ logger: false });
    await adapter.compileControllers([
      TenantController,
      AdminHostController,
      AdvancedController,
    ]);

    // Parameterized host constraint
    const tenantRes = await adapter.fetch(
      new Request("http://acme.example.com/tenant/info", {
        headers: { host: "acme.example.com:3000" },
      }),
    );
    expect(tenantRes.status).toBe(200);
    expect(await tenantRes.json()).toEqual({ tenant: "acme" });

    // Non-matching host returns 404
    const wrongHostRes = await adapter.fetch(
      new Request("http://other.org/tenant/info", {
        headers: { host: "other.org" },
      }),
    );
    expect(wrongHostRes.status).toBe(404);

    // RegExp host constraint
    const adminHostRes = await adapter.fetch(
      new Request("http://admin.internal/tenant/dashboard", {
        headers: { host: "admin.internal" },
      }),
    );
    expect(adminHostRes.status).toBe(200);
    expect(await adminHostRes.json()).toEqual({ admin: true });

    // Regex-constrained param
    const numOk = await adapter.fetch(
      new Request("http://localhost/advanced/orders/12345"),
    );
    expect(numOk.status).toBe(200);
    expect(await numOk.json()).toEqual({ kind: "numeric", id: "12345" });

    const numFail = await adapter.fetch(
      new Request("http://localhost/advanced/orders/abc"),
    );
    expect(numFail.status).toBe(404);

    // Optional param (present & omitted)
    const withMonth = await adapter.fetch(
      new Request("http://localhost/advanced/archive/2026/11"),
    );
    expect(withMonth.status).toBe(200);
    expect(await withMonth.json()).toEqual({ year: "2026", month: "11" });

    const withoutMonth = await adapter.fetch(
      new Request("http://localhost/advanced/archive/2026"),
    );
    expect(withoutMonth.status).toBe(200);
    expect(await withoutMonth.json()).toEqual({ year: "2026", month: null });

    // Mid-path wildcard
    const meta1 = await adapter.fetch(
      new Request("http://localhost/advanced/files/report/meta"),
    );
    expect(meta1.status).toBe(200);
    expect(await meta1.json()).toEqual({ meta: true });

    const metaNested = await adapter.fetch(
      new Request("http://localhost/advanced/files/a/b/c/meta"),
    );
    expect(metaNested.status).toBe(200);
    expect(await metaNested.json()).toEqual({ meta: true });

    // Specific method overrides @All()
    const comboGet = await adapter.fetch(
      new Request("http://localhost/advanced/combo", { method: "GET" }),
    );
    expect(await comboGet.json()).toEqual({ verb: "GET" });

    const comboPut = await adapter.fetch(
      new Request("http://localhost/advanced/combo", { method: "PUT" }),
    );
    expect(await comboPut.json()).toEqual({ verb: "ALL" });
  });

  test("demotes overlapping native :param routes so regex/optional fallback routes keep static > regex > param precedence", async () => {
    @Controller("/items")
    class OverlapController {
      @Get("special")
      special() {
        return { matched: "static" };
      }

      @Get(":id(\\d+)")
      byNum(@Param("id") id: string) {
        return { matched: "regex", id };
      }

      @Get(":slug")
      bySlug(@Param("slug") slug: string) {
        return { matched: "param", slug };
      }
    }

    const adapter = new BunHttpAdapter({ logger: false });
    await adapter.compileControllers([OverlapController]);

    // Verify in-memory fetch
    expect(
      await (
        await adapter.fetch(new Request("http://localhost/items/special"))
      ).json(),
    ).toEqual({ matched: "static" });
    expect(
      await (
        await adapter.fetch(new Request("http://localhost/items/123"))
      ).json(),
    ).toEqual({ matched: "regex", id: "123" });
    expect(
      await (
        await adapter.fetch(new Request("http://localhost/items/hello-world"))
      ).json(),
    ).toEqual({ matched: "param", slug: "hello-world" });

    // Verify on live Bun.serve({ port: 0 }) as well
    const info = await adapter.listen({ port: 0, hostname: "127.0.0.1" });
    try {
      const base = `http://127.0.0.1:${info.port}`;
      expect(await (await fetch(`${base}/items/special`)).json()).toEqual({
        matched: "static",
      });
      expect(await (await fetch(`${base}/items/123`)).json()).toEqual({
        matched: "regex",
        id: "123",
      });
      expect(await (await fetch(`${base}/items/hello-world`)).json()).toEqual({
        matched: "param",
        slug: "hello-world",
      });
    } finally {
      await adapter.close(true);
    }
  });

  test("strips URL hash fragments cleanly from pathname and query parameters", async () => {
    @Controller("/frag")
    class FragController {
      @Get()
      read(@Query() query: Record<string, string | string[]>) {
        return { query };
      }
    }

    const adapter = new BunHttpAdapter({ logger: false });
    await adapter.compileControllers([FragController]);

    const res1 = await adapter.fetch(new Request("http://localhost/frag#top"));
    expect(res1.status).toBe(200);
    expect(await res1.json()).toEqual({ query: {} });

    const res2 = await adapter.fetch(
      new Request("http://localhost/frag?a=1&b=two#section-2"),
    );
    expect(res2.status).toBe(200);
    expect(await res2.json()).toEqual({ query: { a: "1", b: "two" } });

    const res3 = await adapter.fetch(
      new Request("http://localhost/frag#anchor?ignored=1"),
    );
    expect(res3.status).toBe(200);
    expect(await res3.json()).toEqual({ query: {} });
  });

  test("performs ZERO Reflect.getMetadata() calls on the hot request path (RFC-001)", async () => {
    @Controller("/hot")
    class HotController {
      @Post(":id")
      update(
        @Param("id") id: string,
        @Query("mode") mode: string,
        @Body() body: { name: string },
      ) {
        return { id, mode, body };
      }
    }

    const adapter = new BunHttpAdapter({ logger: false });
    await adapter.compileControllers([HotController]);

    const spy = spyOn(Reflect, "getMetadata");
    try {
      for (let i = 0; i < 5; i++) {
        const res = await adapter.fetch(
          new Request(`http://localhost/hot/${i}?mode=fast`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: "bunest" }),
          }),
        );
        expect(res.status).toBe(201);
      }
      expect(spy).toHaveBeenCalledTimes(0);
    } finally {
      spy.mockRestore();
    }
  });
});
