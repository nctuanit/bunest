import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  Controller,
  Get,
  Module,
  Param,
  type BunestModule,
  type MiddlewareConsumer,
  type NextFunction,
  type ResponseContext,
} from "../../../../../packages/common/src";
import {
  RouterModule,
  type BunestApplication,
} from "../../../../../packages/core/src";
import {
  Test,
  describeConformance,
  itAdapted,
  request,
} from "../../../_helpers";

function markMiddleware(
  _req: Request,
  res: ResponseContext,
  next: NextFunction,
) {
  res.header("x-middleware", "ran");
  return next();
}

@Controller("admin")
class AdminController {
  @Get()
  index() {
    return "admin index";
  }

  @Get("*")
  catchAll() {
    return "admin catch-all";
  }
}

@Controller("named")
class NamedWildcardController {
  @Get("{*path}")
  catchAll(@Param("path") path: string[] | string | undefined) {
    return { path: path ?? null };
  }
}

@Controller("optional")
class OptionalParamController {
  @Get(":id?")
  byId(@Param("id") id: string | undefined) {
    return { id: id ?? null };
  }
}

@Controller()
class ShapesController {
  @Get("docs{/}")
  docs() {
    return "docs";
  }

  @Get("files{.json}")
  files() {
    return "files";
  }

  @Get("users/:id?/posts")
  posts(@Param() params: Record<string, string>) {
    return params;
  }

  @Get("wild/*splat")
  splat(@Param("splat") splat: string[] | string) {
    return splat;
  }
}

@Module({
  controllers: [
    AdminController,
    NamedWildcardController,
    OptionalParamController,
    ShapesController,
  ],
})
class WildcardsModule implements BunestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(markMiddleware)
      .forRoutes(
        AdminController,
        NamedWildcardController,
        OptionalParamController,
      );
  }
}

@Controller()
class RootCatchAllController {
  @Get("*")
  catchAll() {
    return "catch-all";
  }
}

@Module({ controllers: [RootCatchAllController] })
class RootCatchAllModule {}

@Controller(":locale?")
class LocaleController {
  @Get()
  index(@Param("locale") locale: string | undefined) {
    return { locale: locale ?? null };
  }
}

@Module({ controllers: [LocaleController] })
class RootOptionalGroupModule implements BunestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(markMiddleware).forRoutes(LocaleController);
  }
}

@Controller("cats")
class OptionalGroupCatsController {
  @Get()
  index(@Param("lang") lang: string | undefined) {
    return { lang: lang ?? null };
  }
}

@Module({ controllers: [OptionalGroupCatsController] })
class OptionalGroupCatsModule {}

@Controller("dogs")
class OptionalGroupDogsController {
  @Get()
  index(@Param("lang") lang: string | undefined) {
    return { lang: lang ?? null };
  }
}

@Module({ controllers: [OptionalGroupDogsController] })
class OptionalGroupDogsModule {}

@Module({
  imports: [
    OptionalGroupCatsModule,
    OptionalGroupDogsModule,
    RouterModule.register([
      { path: ":lang?", module: OptionalGroupCatsModule },
      {
        path: "v1",
        children: [{ path: ":lang?", module: OptionalGroupDogsModule }],
      },
    ]),
  ],
})
class RouterModuleOptionalGroupModule {}

describeConformance(
  "Wildcard and optional routes (BunHttpAdapter)",
  {
    upstreamPath: "integration/http-adapters/e2e/wildcard-routes.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-011"],
    notes:
      "Adapts NestJS wildcard & optional route syntax tests to BunHttpAdapter hybrid native Bun.serve({ routes }) + FallbackRadixRouter (:id? optional params & * wildcards).",
  },
  () => {
    let app: BunestApplication;

    afterEach(async () => {
      await app?.close();
    });

    describe("with middleware applied to their controllers", () => {
      beforeEach(async () => {
        const modRef = await Test.createTestingModule({
          imports: [WildcardsModule],
        }).compile();
        app = modRef.createNestApplication({ logger: false });
        await app.init();
      });

      it("should route the bare path to the index route, and below it to the '*' catch-all", async () => {
        const index = await request(app).get("/admin");
        const catchAll = await request(app).get("/admin/x");
        const withSlash = await request(app).get("/admin/x/");
        const doubleSlash = await request(app).get("/admin//x");

        expect(index.status).toBe(200);
        expect(index.text).toBe("admin index");
        expect(index.headers["x-middleware"]).toBe("ran");
        for (const res of [catchAll, withSlash, doubleSlash]) {
          expect(res.status).toBe(200);
          expect(res.text).toBe("admin catch-all");
          expect(res.headers["x-middleware"]).toBe("ran");
        }
      });

      it("should run the middleware for HEAD requests to a catch-all", async () => {
        const res = await request(app).head("/admin/x");

        expect(res.status).toBe(200);
        expect(res.headers["x-middleware"]).toBe("ran");
      });

      // BUNEST_BUG: FallbackRadixRouter/NativePathMatcher do not support path-to-regexp v8 named wildcard syntax "{*path}" (packages/http/src/router/fallback-radix-router.ts:147-207).
      it.skip("should match a '{*path}' named wildcard route", async () => {
        const bare = await request(app).get("/named");
        const root = await request(app).get("/named/");
        const nested = await request(app).get("/named/a/b");

        expect(bare.status).toBe(404);
        expect(bare.headers["x-middleware"]).toBeUndefined();
        expect(root.status).toBe(200);
        expect(root.body).toEqual({ path: null });
        expect(root.headers["x-middleware"]).toBe("ran");
        expect(nested.body).toEqual({ path: ["a", "b"] });
        expect(nested.headers["x-middleware"]).toBe("ran");
      });

      itAdapted(
        "ADR-011",
        "should match an optional ':id?' route on bare path and parameterized path",
        async () => {
          const bare = await request(app).get("/optional");
          const withId = await request(app).get("/optional/1");

          expect(bare.status).toBe(200);
          expect(bare.body).toEqual({ id: null });
          expect(bare.headers["x-middleware"]).toBe("ran");
          expect(withId.status).toBe(200);
          expect(withId.body).toEqual({ id: "1" });
          expect(withId.headers["x-middleware"]).toBe("ran");
        },
        "Bunest FallbackRadixRouter uses :id? optional param syntax",
      );
    });

    describe("optional groups and wildcards", () => {
      beforeEach(async () => {
        const modRef = await Test.createTestingModule({
          imports: [WildcardsModule],
        }).compile();
        app = modRef.createNestApplication({ logger: false });
        await app.init();
      });

      // BUNEST_BUG: FallbackRadixRouter/NativePathMatcher do not support path-to-regexp v8 optional trailing slash group syntax "docs{/}" (packages/http/src/router/fallback-radix-router.ts:147-207).
      it.skip("should match an optional trailing slash group with and without the slash", async () => {
        expect((await request(app).get("/docs")).text).toBe("docs");
        expect((await request(app).get("/docs/")).text).toBe("docs");
      });

      // BUNEST_BUG: FallbackRadixRouter/NativePathMatcher do not support path-to-regexp v8 optional extension group syntax "files{.json}" (packages/http/src/router/fallback-radix-router.ts:147-207).
      it.skip("should match an optional extension group with and without the extension only", async () => {
        expect((await request(app).get("/files")).text).toBe("files");
        expect((await request(app).get("/files.json")).text).toBe("files");
        expect((await request(app).get("/files.xml")).status).toBe(404);
      });

      itAdapted(
        "ADR-011",
        "should match an optional parameter in the middle of the path (users/:id?/posts)",
        async () => {
          expect((await request(app).get("/users/posts")).body).toEqual({});
          expect((await request(app).get("/users/1/posts")).body).toEqual({
            id: "1",
          });
        },
        "Bunest FallbackRadixRouter supports optional :id? segment in middle of path",
      );

      // BUNEST_BUG: FallbackRadixRouter matches an empty path segment "" for optional :id? in "/users//posts" (returning 200 { id: "" }) instead of 404 (packages/http/src/router/fallback-radix-router.ts:696-712).
      it.skip("should not match double slashes for middle optional parameter (/users//posts)", async () => {
        expect((await request(app).get("/users//posts")).status).toBe(404);
      });

      // BUNEST_BUG: FallbackRadixRouter/NativePathMatcher do not support named splat wildcard syntax "*splat" (packages/http/src/router/fallback-radix-router.ts:147-207).
      it.skip("should split a named wildcard '*splat' before decoding it, keeping an encoded '/' in its segment", async () => {
        expect((await request(app).get("/wild/a%2Fb/c")).body).toEqual([
          "a/b",
          "c",
        ]);
        expect((await request(app).get("/wild/100%25/a%20b")).body).toEqual([
          "100%",
          "a b",
        ]);
      });
    });

    describe("a root catch-all under a global prefix", () => {
      beforeEach(async () => {
        const modRef = await Test.createTestingModule({
          imports: [RootCatchAllModule],
        }).compile();
        app = modRef.createNestApplication({ logger: false });
        app.setGlobalPrefix("api");
        await app.init();
      });

      it("should not match the bare prefix, and match /api/ and /api/x", async () => {
        expect((await request(app).get("/api")).status).toBe(404);
        expect((await request(app).get("/api/")).text).toBe("catch-all");
        expect((await request(app).get("/api/x")).text).toBe("catch-all");
      });
    });

    describe("an optional parameter at the root, with middleware applied to its controller", () => {
      beforeEach(async () => {
        const modRef = await Test.createTestingModule({
          imports: [RootOptionalGroupModule],
        }).compile();
        app = modRef.createNestApplication({ logger: false });
        await app.init();
      });

      itAdapted(
        "ADR-011",
        'should match "/" and one segment, but not "//"',
        async () => {
          const root = await request(app).get("/");
          const withLocale = await request(app).get("/en");
          const doubleSlash = await app.fetch(new Request("http://localhost//"));

          expect(root.body).toEqual({ locale: null });
          expect(root.headers["x-middleware"]).toBe("ran");
          expect(withLocale.body).toEqual({ locale: "en" });
          expect(withLocale.headers["x-middleware"]).toBe("ran");
          expect(doubleSlash.status).toBe(404);
        },
        "Bunest :locale? optional root param (strict trailing slash)",
      );
    });

    describe("an optional parameter as the path of a RouterModule route", () => {
      beforeEach(async () => {
        const modRef = await Test.createTestingModule({
          imports: [RouterModuleOptionalGroupModule],
        }).compile();
        app = modRef.createNestApplication({ logger: false });
        await app.init();
      });

      itAdapted(
        "ADR-011",
        "should match the routes of the module with and without the optional segment",
        async () => {
          expect((await request(app).get("/cats")).body).toEqual({
            lang: null,
          });
          expect((await request(app).get("/en/cats")).body).toEqual({
            lang: "en",
          });
          expect((await request(app).get("//cats")).status).toBe(404);
        },
        "RouterModule path ':lang?' combined with controller path 'cats'",
      );

      itAdapted(
        "ADR-011",
        "should match the routes of a child module with and without the optional segment",
        async () => {
          expect((await request(app).get("/v1/dogs")).body).toEqual({
            lang: null,
          });
          expect((await request(app).get("/v1/en/dogs")).body).toEqual({
            lang: "en",
          });
        },
        "Nested RouterModule path 'v1' + ':lang?' + 'dogs'",
      );
    });
  },
);
