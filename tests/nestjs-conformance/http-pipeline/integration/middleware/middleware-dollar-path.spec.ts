import { afterEach, it } from "bun:test";
import {
  Controller,
  Get,
  Module,
  RequestMethod,
  type BunestModule,
  type MiddlewareConsumer,
  type RouteInfo,
} from "../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../packages/core/src";
import { Test, describeConformance, request } from "../../../_helpers";

const MIDDLEWARE_VALUE = "middleware";

@Controller("prices")
class PricesController {
  // The path really ends in "$", which NestJS core also uses to mark a path
  // that matches exactly
  @Get("usd$")
  usd() {
    return "usd";
  }

  @Get("usd")
  usdLegacy() {
    return "usd-legacy";
  }
}

describeConformance(
  'Middleware - route path ending in "$" (BunHttpAdapter)',
  {
    upstreamPath: "integration/hello-world/e2e/middleware-dollar-path.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008", "ADR-010", "ADR-011"],
    notes:
      "Collapsed Express/Fastify/Node adapter matrix to canonical BunHttpAdapter; adapted Express middleware res.end() to native Web Response.",
  },
  () => {
    let app: BunestApplication | undefined;

    const createApp = async (
      route: typeof PricesController | string | RouteInfo,
      prefix?: string,
    ) => {
      @Module({ controllers: [PricesController] })
      class TestModule implements BunestModule {
        configure(consumer: MiddlewareConsumer) {
          consumer
            .apply((_req, _res, _next) => new Response(MIDDLEWARE_VALUE))
            .forRoutes(route);
        }
      }

      const testingModule = await Test.createTestingModule({
        imports: [TestModule],
      }).compile({ logger: false });
      app = testingModule.createNestApplication({ logger: false });
      if (prefix) {
        app.setGlobalPrefix(prefix);
      }
      await app.init();
    };

    afterEach(async () => {
      await app?.close();
      app = undefined;
    });

    it.each([
      ["the controller", PricesController],
      ["a plain string", "prices/usd$"],
      ["a route", { path: "prices/usd$", method: RequestMethod.GET }],
    ] as const)(
      'should run on the "$" route bound by %s',
      async (_label, route) => {
        await createApp(route);
        await request(app!).get("/prices/usd$").expect(200, MIDDLEWARE_VALUE);
      },
    );

    it('should not run on the route without the "$" bound by a route with it', async () => {
      await createApp({ path: "prices/usd$", method: RequestMethod.GET });
      await request(app!).get("/prices/usd").expect(200, "usd-legacy");
    });

    it('should run on the "$" route under a global prefix', async () => {
      await createApp(PricesController, "api");
      await request(app!).get("/api/prices/usd$").expect(200, MIDDLEWARE_VALUE);
    });
  },
);
