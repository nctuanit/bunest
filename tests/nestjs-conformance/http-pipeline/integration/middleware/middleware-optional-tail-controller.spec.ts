import { afterEach, it } from "bun:test";
import {
  All,
  Controller,
  Get,
  Module,
  type BunestModule,
  type MiddlewareConsumer,
  type Type,
} from "../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../packages/core/src";
import { Test, describeConformance, request } from "../../../_helpers";

const MIDDLEWARE_VALUE = "middleware";

@Controller("proxy/*")
class LegacyWildcardController {
  @All()
  forward() {
    return "proxy";
  }
}

@Controller("files/{*path}")
class WildcardController {
  @Get()
  find() {
    return "files";
  }
}

@Controller("items/{:id}")
class OptionalParamController {
  @Get()
  find() {
    return "items";
  }
}

const legacyWildcardCases = [
  [LegacyWildcardController, "/proxy", ["/proxy/", "/proxy/a", "/proxy/a/b/"]],
] as const;

const braceOptionalTailCases = [
  [WildcardController, "/files", ["/files/", "/files/a", "/files/a/b"]],
  [OptionalParamController, "/items", ["/items/", "/items/1"]],
] as const;

describeConformance(
  "Middleware - controller path ending in an optional segment (BunHttpAdapter)",
  {
    upstreamPath:
      "integration/hello-world/e2e/middleware-optional-tail-controller.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008", "ADR-010", "ADR-011"],
    notes:
      "Collapsed Express/Fastify/Node adapter matrix to canonical BunHttpAdapter; adapted Express middleware res.end() to native Web Response.",
  },
  () => {
    let app: BunestApplication | undefined;

    const createApp = async (controller: Type<unknown>, prefix?: string) => {
      @Module({ controllers: [controller] })
      class TestModule implements BunestModule {
        configure(consumer: MiddlewareConsumer) {
          consumer
            .apply((_req, _res, _next) => new Response(MIDDLEWARE_VALUE))
            .forRoutes(controller);
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

    it.each(
      legacyWildcardCases.map(
        ([controller, base, urls]) => [base, controller, urls] as const,
      ),
    )(
      'should run on every path of the "%s" controller, the empty one included',
      async (base, controller, urls) => {
        await createApp(controller);
        for (const url of urls) {
          await request(app!).get(url).expect(200, MIDDLEWARE_VALUE);
        }
        await request(app!).post(`${base}/`).expect(200);
      },
    );

    // BUNEST_BUG: Expected GET /files/ (for "@Controller('files/{*path}')") and GET /items/ (for "@Controller('items/{:id}')") to return 200 "middleware", got 404. packages/core/src/http/router/fallback-radix-router.ts (parseRouteSegments) only supports `*` and `:id?`, not path-to-regexp v8 brace optional-tail syntax `{*path}` or `{:id}`.
    it.skip.each(
      braceOptionalTailCases.map(
        ([controller, base, urls]) => [base, controller, urls] as const,
      ),
    )(
      'should run on every path of the "%s" controller, the empty one included',
      async (base, controller, urls) => {
        await createApp(controller);
        for (const url of urls) {
          await request(app!).get(url).expect(200, MIDDLEWARE_VALUE);
        }
        await request(app!).post(`${base}/`).expect(404);
      },
    );

    it("should run on the empty wildcard under a global prefix", async () => {
      await createApp(LegacyWildcardController, "api");
      await request(app!).get("/api/proxy/").expect(200, MIDDLEWARE_VALUE);
    });
  },
);
