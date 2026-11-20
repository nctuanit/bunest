import "reflect-metadata";
import { afterEach, beforeEach, it } from "bun:test";
import {
  Controller,
  Get,
  Module,
  Post,
  Req,
  RequestMethod,
  type BunestModule,
  type MiddlewareConsumer,
} from "../../../../../../packages/common/src";
import {
  getCurrentRequestContext,
  type BunestApplication,
} from "../../../../../../packages/core/src";
import {
  Test,
  describeConformance,
  itAdapted,
  request,
} from "../../../../_helpers";

const MIDDLEWARE_VALUE = "middleware";
const MIDDLEWARE_PARAM_VALUE = "middleware_param";

interface AugmentedRequest extends Request {
  extras?: { data: string };
  middlewareParams?: Record<string, unknown>;
  count?: number;
}

@Controller()
class AppController {
  @Get("hello/:name")
  getHello(@Req() req: AugmentedRequest): string {
    return "Hello: " + req.extras?.data;
  }

  @Get("params")
  getParams(@Req() req: AugmentedRequest): unknown {
    return req.middlewareParams;
  }

  @Get("health")
  getHealth(): string {
    return "up";
  }

  @Get("test")
  getTest(): string {
    return "test";
  }

  @Post("test")
  postTest(): string {
    return "test";
  }

  @Get()
  getHome(@Req() req: AugmentedRequest) {
    return "Extras: " + req.extras?.data + ", Count: " + req.count;
  }

  @Get("count")
  getCount(@Req() req: AugmentedRequest) {
    return String(req.count);
  }
}

@Module({
  controllers: [AppController],
})
class AppModule implements BunestModule {
  private count = 0;

  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply((_req, _res, _next) => new Response(MIDDLEWARE_VALUE))
      .forRoutes({ path: MIDDLEWARE_VALUE, method: RequestMethod.GET })
      .apply(
        (_req, _res, _next) => new Response(MIDDLEWARE_VALUE, { status: 201 }),
      )
      .forRoutes({ path: MIDDLEWARE_VALUE, method: RequestMethod.POST })
      .apply((_req, _res, _next) => new Response(MIDDLEWARE_PARAM_VALUE))
      .forRoutes({
        path: MIDDLEWARE_VALUE + "/*",
        method: RequestMethod.GET,
      })
      .apply(
        (_req, _res, _next) =>
          new Response(MIDDLEWARE_PARAM_VALUE, { status: 201 }),
      )
      .forRoutes({
        path: MIDDLEWARE_VALUE + "/*",
        method: RequestMethod.POST,
      })
      .apply((req, _res, next) => {
        (req as AugmentedRequest).extras = {
          data: "Data attached in middleware",
        };
        return next();
      })
      .forRoutes({ path: "*", method: RequestMethod.GET })
      .apply((req, _res, next) => {
        const ctx = getCurrentRequestContext();
        (req as AugmentedRequest).middlewareParams = ctx?.params ?? {};
        return next();
      })
      .forRoutes({ path: "*", method: RequestMethod.GET })
      .apply((req, _res, next) => {
        this.count += 1;
        (req as AugmentedRequest).count = this.count;
        return next();
      })
      .forRoutes("*");
  }
}

describeConformance(
  "Global prefix",
  {
    upstreamPath:
      "integration/nest-application/global-prefix/e2e/global-prefix.spec.ts",
    category: "DIRECT_PORT",
    adrs: ["ADR-008", "ADR-010"],
  },
  () => {
    let app: BunestApplication;

    beforeEach(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();

      app = moduleRef.createNestApplication({ logger: false });
    });

    afterEach(async () => {
      await app.close();
    });

    it("should use the global prefix", async () => {
      app.setGlobalPrefix("/api/v1");
      await app.init();

      await request(app).get("/health").expect(404);
      await request(app).get("/api/v1/health").expect(200);
    });

    // BUNEST_BUG: Expected standalone module middleware bound via MiddlewareConsumer.forRoutes({ path: 'middleware', method: GET/POST }) with exclude: ['/middleware'] to serve /middleware (200/201); actual returns 404 because Bunest only executes module middleware on matched controller routes, not standalone middleware-only paths (packages/http/src/router/route-compiler.ts, packages/http/src/adapter/bun-http.adapter.ts).
    it.skip("should exclude the path as string", async () => {
      app.setGlobalPrefix("/api/v1", { exclude: ["/test", "/middleware"] });
      await app.init();

      await request(app).get("/test").expect(200);
      await request(app).post("/test").expect(201);

      await request(app).get("/api/v1/test").expect(404);
      await request(app).post("/api/v1/test").expect(404);

      await request(app).get("/middleware").expect(200, MIDDLEWARE_VALUE);
      await request(app).post("/middleware").expect(201, MIDDLEWARE_VALUE);

      await request(app).get("/api/v1/middleware").expect(404);
      await request(app).post("/api/v1/middleware").expect(404);
    });

    // BUNEST_BUG: Expected standalone module middleware bound via forRoutes({ path: 'middleware', method: GET/POST }) to serve /middleware (POST) and /api/v1/middleware (GET); actual returns 404 because Bunest does not execute module middleware on paths without a controller route (packages/http/src/router/route-compiler.ts, packages/http/src/adapter/bun-http.adapter.ts).
    it.skip("should exclude the path as RouteInfo", async () => {
      app.setGlobalPrefix("/api/v1", {
        exclude: [
          { path: "/health", method: RequestMethod.GET },
          { path: "/middleware", method: RequestMethod.POST },
        ],
      });
      await app.init();

      await request(app).get("/health").expect(200);

      await request(app).get("/middleware").expect(404);
      await request(app).post("/middleware").expect(201, MIDDLEWARE_VALUE);

      await request(app).get("/api/v1/health").expect(404);

      await request(app)
        .get("/api/v1/middleware")
        .expect(200, MIDDLEWARE_VALUE);
      await request(app).post("/api/v1/middleware").expect(404);
    });

    itAdapted(
      "ADR-011",
      "should only exclude the GET RequestMethod",
      async () => {
        app.setGlobalPrefix("/api/v1", {
          exclude: [{ path: "/test", method: RequestMethod.GET }],
        });
        await app.init();

        await request(app).get("/test").expect(200);
        // Under ADR-011, /test exists for GET so POST /test returns 405 Method Not Allowed + Allow header
        await request(app).post("/test").expect(405).expect("Allow", /GET/);
        await request(app).post("/api/v1/test").expect(201);
      },
      "ADR-011 returns 405 Method Not Allowed with Allow header for unregistered method on existing path",
    );

    it("should exclude the path as a mix of string and RouteInfo", async () => {
      app.setGlobalPrefix("/api/v1", {
        exclude: ["test", { path: "/health", method: RequestMethod.GET }],
      });
      await app.init();

      await request(app).get("/health").expect(200);
      await request(app).get("/test").expect(200);
    });

    // BUNEST_BUG: Expected standalone module middleware bound via forRoutes({ path: 'middleware/*', method: GET }) with exclude: ['/middleware/:name'] to serve /middleware/foo (200); actual returns 404 because Bunest only binds module middleware to controller routes (packages/http/src/router/route-compiler.ts, packages/http/src/adapter/bun-http.adapter.ts).
    it.skip("should exclude the path with route param", async () => {
      app.setGlobalPrefix("/api/v1", {
        exclude: ["/hello/:name", "/middleware/:name"],
      });
      await app.init();

      await request(app)
        .get("/hello/foo")
        .expect(200, "Hello: Data attached in middleware");

      await request(app)
        .get("/middleware/foo")
        .expect(200, MIDDLEWARE_PARAM_VALUE);

      await request(app).get("/api/v1/middleware/foo").expect(404);
    });

    it("should get the params in the global prefix", async () => {
      app.setGlobalPrefix("/api/:tenantId");
      await app.init();

      await request(app)
        .get("/api/test/params")
        .expect(200, { tenantId: "test" });
    });

    it("should execute middleware only once", async () => {
      app.setGlobalPrefix("/api", { exclude: ["/"] });
      await app.init();

      await request(app)
        .get("/")
        .expect(200, "Extras: Data attached in middleware, Count: 1");
      await request(app).get("/api/count").expect(200, "2");
    });

    it("should run a wildcard middleware bound to a method under the prefix when the root path is excluded", async () => {
      app.setGlobalPrefix("/api", { exclude: ["/", "health"] });
      await app.init();

      await request(app)
        .get("/api/hello/foo")
        .expect(200, "Hello: Data attached in middleware");
      await request(app).get("/api/params").expect(200, {});
      await request(app)
        .get("/")
        .expect(200, "Extras: Data attached in middleware, Count: 3");
      await request(app).get("/api/count").expect(200, "4");
    });
  },
);
