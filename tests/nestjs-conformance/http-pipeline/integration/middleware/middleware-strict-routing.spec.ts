import "reflect-metadata";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import {
  Controller,
  Get,
  Module,
  RequestMethod,
  type BunestModule,
  type MiddlewareConsumer,
} from "../../../../../packages/common/src";
import {
  BunestFactory,
  type BunestApplication,
} from "../../../../../packages/core/src";
import { describeConformance, request } from "../../../_helpers";

let middlewareCalls = 0;

@Controller("health")
class HealthController {
  @Get()
  root() {
    return "root";
  }

  @Get("deep/")
  deep() {
    return "deep";
  }
}

@Controller("open")
class OpenController {
  @Get()
  root() {
    return "open";
  }
}

@Module({ controllers: [HealthController, OpenController] })
class AppModule implements BunestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply((_req, _res, _next) => {
        middlewareCalls++;
        return new Response("blocked", { status: 403 });
      })
      .exclude({ path: "open", method: RequestMethod.GET })
      .forRoutes(HealthController, OpenController);
  }
}

describeConformance(
  "Middleware with strict routing (BunHttpAdapter)",
  {
    upstreamPath:
      "integration/hello-world/e2e/middleware-strict-routing.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008", "ADR-010", "ADR-011"],
    notes:
      "Uses BunestFactory.create(..., { ignoreTrailingSlash: false }) (Bunest's strict trailing-slash routing default per ADR-011) instead of Express strict routing.",
  },
  () => {
    describe.each([[""], ["api"]])(
      'Middleware with strict routing (global prefix "%s")',
      (prefix) => {
        let app: BunestApplication;
        const base = prefix ? `/${prefix}` : "";

        beforeAll(async () => {
          app = await BunestFactory.create(AppModule, {
            logger: false,
            ignoreTrailingSlash: false,
          });
          if (prefix) {
            app.setGlobalPrefix(prefix);
          }
          await app.init();
        });

        beforeEach(() => {
          middlewareCalls = 0;
        });

        afterAll(async () => {
          await app.close();
        });

        it("should run the middleware for the root route of a controller", async () => {
          await request(app).get(`${base}/health`).expect(403, "blocked");
          expect(middlewareCalls).toBe(1);
        });

        it("should run the middleware for a route declared with a trailing slash", async () => {
          await request(app).get(`${base}/health/deep`).expect(403, "blocked");
          expect(middlewareCalls).toBe(1);
        });

        it("should still skip the middleware for an excluded root route", async () => {
          await request(app).get(`${base}/open`).expect(200, "open");
          expect(middlewareCalls).toBe(0);
        });
      },
    );
  },
);
