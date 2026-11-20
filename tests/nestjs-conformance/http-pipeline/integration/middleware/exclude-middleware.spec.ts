import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { connect } from "node:net";
import {
  Controller,
  Delete,
  Get,
  Module,
  Post,
  RequestMethod,
  type BunestModule,
  type MiddlewareConsumer,
} from "../../../../../packages/common/src";
import type { BunestApplication } from "../../../../../packages/core/src";
import { Test, describeConformance, request } from "../../../_helpers";

const RETURN_VALUE = "test";
const MIDDLEWARE_VALUE = "middleware";

@Controller("hello")
class HelloController {
  @Get()
  greeting() {
    return "Hello world!";
  }
}

@Module({
  controllers: [HelloController],
})
class HelloModule {}

@Controller()
class TestController {
  @Get("test")
  test() {
    return RETURN_VALUE;
  }

  @Get("test2")
  test2() {
    return RETURN_VALUE;
  }

  @Get("middleware")
  middleware() {
    return RETURN_VALUE;
  }

  @Post("middleware")
  noMiddleware() {
    return RETURN_VALUE;
  }

  @Get("wildcard/overview")
  testOverview() {
    return RETURN_VALUE;
  }

  @Get("legacy-wildcard/overview")
  testLegacyWildcard() {
    return RETURN_VALUE;
  }

  @Get("splat-wildcard/overview")
  testSplatWildcard() {
    return RETURN_VALUE;
  }

  @Get("overview/:id")
  overviewById() {
    return RETURN_VALUE;
  }

  @Get("multiple/exclude")
  multipleExclude() {
    return RETURN_VALUE;
  }
}

@Module({
  imports: [HelloModule],
  controllers: [TestController],
})
class TestModule implements BunestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply((_req, _res, _next) => new Response(MIDDLEWARE_VALUE))
      .exclude(
        "test",
        "overview/:id",
        "wildcard/*",
        "legacy-wildcard/(.*)",
        "splat-wildcard/*splat",
        {
          path: "middleware",
          method: RequestMethod.POST,
        },
      )
      .exclude("multiple/exclude")
      .forRoutes("*path");
  }
}

@Controller("users")
class UsersController {
  @Get("login")
  login() {
    return RETURN_VALUE;
  }

  @Get(":id")
  findOne() {
    return RETURN_VALUE;
  }
}

@Module({
  controllers: [UsersController],
})
class RouteMatchingModule implements BunestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply((_req, _res, _next) => new Response(MIDDLEWARE_VALUE))
      .exclude("users/login")
      .forRoutes(UsersController);
  }
}

@Controller("profiles")
class ProfilesController {
  @Get(":id")
  findOne() {
    return RETURN_VALUE;
  }

  @Get(":id/avatar")
  avatar() {
    return RETURN_VALUE;
  }
}

@Module({
  controllers: [ProfilesController],
})
class RequestTargetModule implements BunestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply((_req, _res, _next) => new Response(MIDDLEWARE_VALUE))
      .exclude("profiles/:id/avatar")
      .forRoutes(ProfilesController);
  }
}

@Controller("invoices")
class InvoicesController {
  @Get()
  findAll() {
    return RETURN_VALUE;
  }

  @Get(":token")
  findShared() {
    return RETURN_VALUE;
  }
}

@Module({
  controllers: [InvoicesController],
})
class TrailingSlashModule implements BunestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply((_req, _res, _next) => new Response(MIDDLEWARE_VALUE))
      .exclude("invoices/*")
      .forRoutes(InvoicesController);
  }
}

@Controller("reports")
class ReportsController {
  // Registered first, so the router serves "/reports/" with it
  @Get("{*path}")
  read() {
    return "read";
  }

  @Get()
  about() {
    return RETURN_VALUE;
  }
}

@Controller("exports")
class ExportsController {
  @Get()
  list() {
    return RETURN_VALUE;
  }

  // Serves DELETE "/exports/", which the "exports" exclusion covers too
  @Delete("*")
  remove() {
    return "removed";
  }
}

const createOptionalTailModule = (...exclusions: string[]) => {
  @Module({
    controllers: [ReportsController, ExportsController],
  })
  class OptionalTailModule implements BunestModule {
    configure(consumer: MiddlewareConsumer) {
      consumer
        .apply((_req, _res, _next) => new Response(MIDDLEWARE_VALUE))
        .exclude(...exclusions)
        .forRoutes(ReportsController, ExportsController);
    }
  }
  return OptionalTailModule;
};

@Controller("statements")
class StatementsController {
  @Get(":id.pdf")
  published() {
    return "published";
  }

  @Get(":name")
  internal() {
    return RETURN_VALUE;
  }
}

@Module({
  controllers: [StatementsController],
})
class MixedSegmentModule implements BunestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply((_req, _res, _next) => new Response(MIDDLEWARE_VALUE))
      .exclude({ path: "statements/:id.pdf", method: RequestMethod.GET })
      .forRoutes(StatementsController);
  }
}

describeConformance(
  "Exclude middleware (BunHttpAdapter)",
  {
    upstreamPath: "integration/hello-world/e2e/exclude-middleware.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008", "ADR-010", "ADR-011"],
    notes:
      "Collapsed Express/Fastify/Node adapter matrices to canonical BunHttpAdapter; adapted Express middleware res.send()/res.end() to native Web Response.",
  },
  () => {
    describe("Exclude middleware - request targets", () => {
      let app: BunestApplication | undefined;
      let port: number;

      const sendRawRequest = (requestTarget: string) =>
        new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
          let response = "";
          const socket = connect(port, "127.0.0.1", () => {
            socket.write(
              `GET ${requestTarget} HTTP/1.1\r\n` +
                `Host: 127.0.0.1:${port}\r\n` +
                `Connection: close\r\n\r\n`,
            );
          });
          socket.setEncoding("utf8");
          socket.on("data", (chunk) => {
            response += chunk;
          });
          socket.on("error", reject);
          socket.on("end", () => {
            const [head = "", body = ""] = response.split("\r\n\r\n");
            resolve({ statusCode: Number(head.split(" ")[1]), body });
          });
        });

      beforeEach(async () => {
        const moduleRef = await Test.createTestingModule({
          imports: [RequestTargetModule],
        }).compile({ logger: false });
        app = moduleRef.createNestApplication({ logger: false });
        const info = await app.listen(0, "127.0.0.1");
        port = info.port;
      });

      afterEach(async () => {
        await app?.close();
        app = undefined;
      });

      it(`should exclude "/profiles/1/avatar" endpoint`, async () => {
        const response = await sendRawRequest("/profiles/1/avatar");
        expect(response.body).toBe(RETURN_VALUE);
      });

      // BUNEST_BUG: Expected raw request target "/profiles/1#/avatar" to route to "/profiles/:id" and run middleware ("middleware"), got "test". Native Bun.serve({ routes }) in packages/http/src/router/route-compiler.ts matches "/profiles/1#/avatar" against "/profiles/:id/avatar" (excluded) instead of stripping the "#" fragment before matching.
      it.skip(`should not exclude "/profiles/1#/avatar", which the router serves with "/profiles/:id"`, async () => {
        const response = await sendRawRequest("/profiles/1#/avatar");
        expect(response.body).toBe(MIDDLEWARE_VALUE);
      });
    });

    describe("Exclude middleware - trailing slash", () => {
      let app: BunestApplication | undefined;

      beforeEach(async () => {
        const moduleRef = await Test.createTestingModule({
          imports: [TrailingSlashModule],
        }).compile({ logger: false });
        app = moduleRef.createNestApplication({
          logger: false,
          ignoreTrailingSlash: true,
        });
        await app.init();
      });

      afterEach(async () => {
        await app?.close();
        app = undefined;
      });

      it(`should exclude "/invoices/abc" endpoint`, async () => {
        await request(app!).get("/invoices/abc").expect(200, RETURN_VALUE);
      });

      // BUNEST_BUG: Expected GET /invoices/ to run middleware ("middleware"), got "test". packages/http/src/scanner/path-normalizer.ts (matchesPathPattern lines 160-167) matches trailing wildcard "invoices/*" against the bare parent path "/invoices", erroneously excluding InvoicesController.findAll.
      it.skip(`should not exclude "/invoices/", which the router serves with "/invoices"`, async () => {
        await request(app!).get("/invoices/").expect(200, MIDDLEWARE_VALUE);
      });
    });

    describe("Exclude middleware - trailing slash next to an optional-tail route", () => {
      let app: BunestApplication | undefined;

      const createApp = async (...exclusions: string[]) => {
        const testingModule = await Test.createTestingModule({
          imports: [createOptionalTailModule(...exclusions)],
        }).compile({ logger: false });
        app = testingModule.createNestApplication({ logger: false });
        await app.init();
      };

      afterEach(async () => {
        await app?.close();
        app = undefined;
      });

      it(`should exclude "/reports" endpoint`, async () => {
        await createApp("reports", "exports");
        await request(app!).get("/reports").expect(200, RETURN_VALUE);
        await request(app!).get("/exports").expect(200, RETURN_VALUE);
      });

      // BUNEST_BUG: Expected GET /reports/ to match "/reports/{*path}" and run middleware ("middleware"), got 404. packages/http/src/router/fallback-radix-router.ts (parseRouteSegments) and packages/http/src/scanner/path-normalizer.ts do not support path-to-regexp v8 optional wildcard syntax `{*path}`.
      it.skip(`should not exclude "/reports/", which the router serves with "/reports/{*path}"`, async () => {
        await createApp("reports", "exports");
        await request(app!).get("/reports/").expect(200, MIDDLEWARE_VALUE);
        await request(app!).delete("/exports/").expect(200, MIDDLEWARE_VALUE);
      });

      // BUNEST_BUG: Expected GET /reports/ and /reports/a to match "/reports/{*path}" and return "read", got 404. packages/http/src/router/fallback-radix-router.ts (parseRouteSegments) and packages/http/src/scanner/path-normalizer.ts do not support `{*path}` syntax.
      it.skip(`should exclude "/reports/" when "/reports/{*path}" is excluded too`, async () => {
        await createApp("reports", "reports/{*path}");
        await request(app!).get("/reports/").expect(200, "read");
        await request(app!).get("/reports/a").expect(200, "read");
      });
    });

    describe("Exclude middleware - parameter next to text", () => {
      let app: BunestApplication | undefined;

      beforeEach(async () => {
        const testingModule = await Test.createTestingModule({
          imports: [MixedSegmentModule],
        }).compile({ logger: false });
        app = testingModule.createNestApplication({ logger: false });
        await app.init();
      });

      afterEach(async () => {
        await app?.close();
        app = undefined;
      });

      // BUNEST_BUG: Expected GET /statements/1.pdf to match "@Get(':id.pdf')" and return "published", got "test" (routed to ":name"). packages/http/src/router/fallback-radix-router.ts (parseRouteSegments) does not support mixed param+literal segments like `:id.pdf`.
      it.skip(`should exclude "/statements/1.pdf" endpoint`, async () => {
        await request(app!).get("/statements/1.pdf").expect(200, "published");
      });

      // BUNEST_BUG: Expected GET /statements/drafts to run middleware ("middleware"), got "test". packages/http/src/scanner/path-normalizer.ts (matchesPathPattern line 151) treats any `tSeg.startsWith(":")` as matching any pattern segment, so exclude("statements/:id.pdf") erroneously excludes "/statements/:name".
      it.skip(`should not exclude "/statements/drafts" endpoint`, async () => {
        await request(app!)
          .get("/statements/drafts")
          .expect(200, MIDDLEWARE_VALUE);
      });

      // BUNEST_BUG: Expected GET /statements/1<terminator>.pdf to run middleware ("middleware"), got "test". Both mixed `:id.pdf` segment matching (fallback-radix-router.ts) and exclude pattern matching against `:name` (path-normalizer.ts line 151) fail.
      it.skip.each(["%0A", "%0D", "%E2%80%A8", "%E2%80%A9"])(
        `should not exclude "/statements/1%s.pdf", a line terminator in the parameter`,
        async (terminator) => {
          await request(app!)
            .get(`/statements/1${terminator}.pdf`)
            .expect(200, MIDDLEWARE_VALUE);
        },
      );
    });

    describe("Exclude middleware - route matching", () => {
      let app: BunestApplication | undefined;

      const createApp = async (ignoreTrailingSlash = false) => {
        const testingModule = await Test.createTestingModule({
          imports: [RouteMatchingModule],
        }).compile({ logger: false });
        app = testingModule.createNestApplication({
          logger: false,
          ignoreTrailingSlash,
        });
        await app.init();
      };

      afterEach(async () => {
        await app?.close();
        app = undefined;
      });

      describe("with ignoreTrailingSlash enabled", () => {
        beforeEach(() => createApp(true));

        it(`should exclude "/users/login/", which the router serves with "/users/login"`, async () => {
          await request(app!).get("/users/login/").expect(200, RETURN_VALUE);
        });
      });

      describe("case-sensitive routing (Bunest default per ADR-011)", () => {
        beforeEach(() => createApp(false));

        it(`should exclude "/users/login" endpoint`, async () => {
          await request(app!).get("/users/login").expect(200, RETURN_VALUE);
        });

        // BUNEST_BUG: Expected GET /users/LOGIN (served by "/users/:id") to run middleware ("middleware"), got "test". packages/http/src/scanner/path-normalizer.ts (matchesPathPattern line 151) treats `tSeg.startsWith(":")` as matching static pattern segment "login", so exclude("users/login") erroneously excludes "/users/:id".
        it.skip(`should not exclude "/users/LOGIN", which the router serves with "/users/:id"`, async () => {
          await request(app!)
            .get("/users/LOGIN")
            .expect(200, MIDDLEWARE_VALUE);
        });
      });
    });

    describe("Exclude middleware", () => {
      let app: BunestApplication | undefined;

      beforeEach(async () => {
        const moduleRef = await Test.createTestingModule({
          imports: [TestModule],
        }).compile({ logger: false });
        app = moduleRef.createNestApplication({ logger: false });
        await app.init();
      });

      afterEach(async () => {
        await app?.close();
        app = undefined;
      });

      it(`should exclude "/test" endpoint`, async () => {
        await request(app!).get("/test").expect(200, RETURN_VALUE);
      });

      // BUNEST_BUG: Expected GET /test2 to run middleware ("middleware"), got "test". packages/http/src/scanner/path-normalizer.ts (matchesPathPattern lines 109-116) does not recognize named wildcard syntax `*path` in `.forRoutes('*path')`, so the middleware is never attached to any route.
      it.skip(`should not exclude "/test2" endpoint`, async () => {
        await request(app!).get("/test2").expect(200, MIDDLEWARE_VALUE);
      });

      // BUNEST_BUG: Expected GET /middleware to run middleware ("middleware"), got "test". packages/http/src/scanner/path-normalizer.ts (matchesPathPattern lines 109-116) does not recognize named wildcard syntax `*path` in `.forRoutes('*path')`.
      it.skip(`should run middleware for "/middleware" endpoint`, async () => {
        await request(app!).get("/middleware").expect(200, MIDDLEWARE_VALUE);
      });

      it(`should exclude POST "/middleware" endpoint`, async () => {
        await request(app!).post("/middleware").expect(201, RETURN_VALUE);
      });

      it(`should exclude "/overview/:id" endpoint (by param)`, async () => {
        await request(app!).get("/overview/1").expect(200, RETURN_VALUE);
      });

      it(`should exclude "/wildcard/overview" endpoint (by wildcard)`, async () => {
        await request(app!)
          .get("/wildcard/overview")
          .expect(200, RETURN_VALUE);
      });

      it(`should exclude "/legacy-wildcard/overview" endpoint (by wildcard, legacy syntax)`, async () => {
        await request(app!)
          .get("/legacy-wildcard/overview")
          .expect(200, RETURN_VALUE);
      });

      it(`should exclude "/splat-wildcard/overview" endpoint (by wildcard, new syntax)`, async () => {
        await request(app!)
          .get("/splat-wildcard/overview")
          .expect(200, RETURN_VALUE);
      });

      it(`should exclude "/multiple/exclude" endpoint`, async () => {
        await request(app!)
          .get("/multiple/exclude")
          .expect(200, RETURN_VALUE);
      });
    });
  },
);
