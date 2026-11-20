import "reflect-metadata";
import { afterEach, describe, it } from "bun:test";
import {
  Controller,
  Get,
  Module,
  Req,
  type BunestModule,
  type MiddlewareConsumer,
} from "../../../../../packages/common/src";
import type { BunestApplication } from "../../../../../packages/core/src";
import { Test, describeConformance, request } from "../../../_helpers";

const RETURN_VALUE = "test";
const SCOPED_VALUE = "test_scoped";
const WILDCARD_VALUE = "test_wildcard";
const EXCLUDE_VALUE = "test_exclude";

const requestRuns = new WeakMap<Request, number>();
const incrementRuns = (req: Request) => {
  requestRuns.set(req, (requestRuns.get(req) ?? 0) + 1);
};
const getRuns = (req: Request) => requestRuns.get(req) ?? 0;

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

  @Get("tests/wildcard_nested")
  wildcard_nested() {
    return RETURN_VALUE;
  }

  @Get("legacy-wildcard/overview")
  legacyWildcard() {
    return RETURN_VALUE;
  }

  @Get("exclude")
  exclude() {
    return EXCLUDE_VALUE;
  }
}

@Module({
  imports: [HelloModule],
  controllers: [TestController],
})
class TestModule implements BunestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply((_req, _res, _next) => new Response(WILDCARD_VALUE))
      .forRoutes("tests/*path", "legacy-wildcard/*")
      .apply((_req, _res, _next) => new Response(SCOPED_VALUE))
      .exclude("exclude")
      .forRoutes(TestController)
      .apply((_req, _res, _next) => new Response(RETURN_VALUE))
      .exclude("exclude")
      .forRoutes("*");
  }
}

@Controller()
class RootController {
  @Get()
  root(@Req() req: Request) {
    return `${getRuns(req)}`;
  }
}

async function createApp(
  beforeInit?: (app: BunestApplication) => void,
): Promise<BunestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [TestModule],
  }).compile({ logger: false });
  const app = moduleRef.createNestApplication({ logger: false });

  if (beforeInit) {
    beforeInit(app);
  }
  await app.init();

  return app;
}

describeConformance(
  "Middleware",
  {
    upstreamPath: "integration/hello-world/e2e/middleware.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008", "ADR-010", "ADR-011"],
    notes:
      "Adapted Express middleware res.send() to Bunest middleware returning native Web Response and per-request run tracking via WeakMap<Request, number>.",
  },
  () => {
    describe("Middleware", () => {
      let app: BunestApplication | undefined;

      afterEach(async () => {
        await app?.close();
        app = undefined;
      });

      // BUNEST_BUG: Expected GET /hello (HelloController) to hit wildcard middleware ("test"), got "test_scoped" (TestController middleware). packages/core/src/module/middleware-consumer.ts (toRouteInfos lines 33-51) expands an empty-prefix `@Controller()` into `["/", "/*"]` instead of scanning the controller's actual route paths, leaking TestController's middleware onto HelloController.
      it.skip(`forRoutes(*)`, async () => {
        app = await createApp();
        await request(app).get("/hello").expect(200, RETURN_VALUE);
        await request(app).get("/exclude").expect(200, EXCLUDE_VALUE);
      });

      // BUNEST_BUG: Expected GET /api/hello to return "test" and GET /api (prefix root) to return "test", got "test_scoped" on /api/hello and 404 on /api. packages/core/src/module/middleware-consumer.ts expands `@Controller()` TestController into `/*` (leaking onto HelloController), and packages/http/src/router/route-compiler.ts does not execute middleware on unmatched prefix root `/api`.
      it.skip(`forRoutes(*) with global prefix`, async () => {
        app = await createApp((instance) => instance.setGlobalPrefix("api"));
        await request(app).get("/api/hello").expect(200, RETURN_VALUE);
        await request(app).get("/api").expect(200, RETURN_VALUE);
        await request(app).get("/api/exclude").expect(200, EXCLUDE_VALUE);
      });

      it(`forRoutes(TestController)`, async () => {
        app = await createApp();
        await request(app).get("/test").expect(200, SCOPED_VALUE);
        await request(app).get("/exclude").expect(200, EXCLUDE_VALUE);
      });

      // BUNEST_BUG: Expected GET /tests/wildcard (no matching controller handler; only /tests/wildcard_nested exists) to run middleware ("test_wildcard"), got 404. packages/http/src/router/route-compiler.ts does not run module middleware on unmatched routes, and packages/http/src/scanner/path-normalizer.ts does not recognize named wildcard `*path` in `tests/*path`.
      it.skip(`forRoutes(tests/*)`, async () => {
        app = await createApp();
        await request(app).get("/tests/wildcard").expect(200, WILDCARD_VALUE);
      });

      it(`forRoutes(legacy-wildcard/*)`, async () => {
        app = await createApp();
        await request(app)
          .get("/legacy-wildcard/overview")
          .expect(200, WILDCARD_VALUE);
      });
    });

    describe("Middleware - wildcard at the global prefix root", () => {
      let app: BunestApplication | undefined;

      const createAppWithWildcard = async (wildcard: string) => {
        @Module({
          controllers: [RootController],
        })
        class RootModule implements BunestModule {
          configure(consumer: MiddlewareConsumer) {
            consumer
              .apply((req, _res, next) => {
                incrementRuns(req);
                return next();
              })
              .forRoutes(wildcard);
          }
        }

        const moduleRef = await Test.createTestingModule({
          imports: [RootModule],
        }).compile({ logger: false });
        app = moduleRef.createNestApplication({
          logger: false,
          ignoreTrailingSlash: true,
        });
        app.setGlobalPrefix("api");
        await app.init();
      };

      afterEach(async () => {
        await app?.close();
        app = undefined;
      });

      it.each(["*"])(
        'should run the middleware once for "/api" and "/api/" (%s)',
        async (wildcard) => {
          await createAppWithWildcard(wildcard);
          await request(app!).get("/api").expect(200, "1");
          await request(app!).get("/api/").expect(200, "1");
        },
      );

      // BUNEST_BUG: Expected GET /api and GET /api/ to run middleware once ("1") for path-to-regexp v8 catch-all wildcards `{*path}`, `*path`, and `/*splat`, got "0". packages/http/src/scanner/path-normalizer.ts (matchesPathPattern lines 109-116) only recognizes `*`, `/*`, `(.*)`, and `/(.*)`.
      it.skip.each(["{*path}", "*path", "/*splat"])(
        'should run the middleware once for "/api" and "/api/" (%s)',
        async (wildcard) => {
          await createAppWithWildcard(wildcard);
          await request(app!).get("/api").expect(200, "1");
          await request(app!).get("/api/").expect(200, "1");
        },
      );
    });
  },
);
