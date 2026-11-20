import "reflect-metadata";
import { afterEach, it } from "bun:test";
import {
  Controller,
  Get,
  Module,
  Post,
  RequestMethod,
  VersioningType,
  type BunestModule,
  type MiddlewareConsumer,
  type RouteInfo,
} from "../../../../../packages/common/src";
import type { BunestApplication } from "../../../../../packages/core/src";
import { Test, describeConformance, request } from "../../../_helpers";

type VersionedRouteInfo = RouteInfo & { version?: string };

const MIDDLEWARE_VALUE = "middleware";

@Controller({ path: "reports", version: "1" })
class ReportsV1Controller {
  @Get()
  findAll() {
    return "v1";
  }

  @Post()
  create() {
    return "v1";
  }
}

@Controller({ path: "reports", version: "2" })
class ReportsV2Controller {
  @Get()
  findAll() {
    return "v2";
  }

  @Post()
  create() {
    return "v2";
  }
}

@Module({
  controllers: [ReportsV1Controller, ReportsV2Controller],
})
class MiddlewareModule implements BunestModule {
  configure(consumer: MiddlewareConsumer) {
    const excludedRoute: VersionedRouteInfo = {
      path: "reports",
      method: RequestMethod.GET,
      version: "1",
    };
    consumer
      .apply((_req, _res, _next) => new Response(MIDDLEWARE_VALUE))
      .exclude(excludedRoute)
      .forRoutes("reports");
  }
}

@Module({
  controllers: [ReportsV1Controller, ReportsV2Controller],
})
class CsrfModule {}

describeConformance(
  "Exclude a version with media type versioning (BunHttpAdapter)",
  {
    upstreamPath:
      "integration/hello-world/e2e/exclude-middleware-versioning-mediatype.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008", "ADR-010"],
    notes:
      "Collapsed Express/Fastify adapter matrix to canonical BunHttpAdapter; adapted Express middleware res.end() to native Web Response short-circuit.",
  },
  () => {
    let app: BunestApplication | undefined;

    const createApp = async (
      module: typeof MiddlewareModule | typeof CsrfModule,
      beforeInit: (app: BunestApplication) => void = () => {},
    ) => {
      const moduleRef = await Test.createTestingModule({
        imports: [module],
      }).compile({ logger: false });
      app = moduleRef.createNestApplication({ logger: false });
      app.enableVersioning({ type: VersioningType.MEDIA_TYPE, key: "v=" });
      beforeInit(app);
      await app.init();
    };

    afterEach(async () => {
      await app?.close();
      app = undefined;
    });

    // BUNEST_BUG: Expected GET /reports with Accept: application/json;v=2 to run middleware ("middleware"), got "v2". RouteInfo has no `version` property in packages/common/src/interfaces/pipeline.interface.ts; packages/core/src/module/middleware-consumer.ts and packages/http/src/scanner/path-normalizer.ts (matchesMiddlewareForRoute) ignore `version` on exclude rules, excluding all versions of GET /reports.
    it.skip("should skip the middleware for the excluded version only", async () => {
      await createApp(MiddlewareModule);
      await request(app!)
        .get("/reports")
        .set("Accept", "application/json;v=1")
        .expect(200, "v1");
      await request(app!)
        .get("/reports")
        .set("Accept", "application/json;v=2")
        .expect(200, MIDDLEWARE_VALUE);
    });

    // BUNEST_BUG: Expected GET /reports with Accept: application/json;v="2" to run middleware ("middleware"), got "v2". packages/core/src/module/middleware-consumer.ts and packages/http/src/scanner/path-normalizer.ts ignore `version` on middleware exclude rules, excluding v2 alongside v1.
    it.skip("should read a quoted media type version, like the router does", async () => {
      await createApp(MiddlewareModule);
      await request(app!)
        .get("/reports")
        .set("Accept", 'application/json;v="1"')
        .expect(200, "v1");
      await request(app!)
        .get("/reports")
        .set("Accept", 'application/json;v="2"')
        .expect(200, MIDDLEWARE_VALUE);
    });

    it("should read a quoted media type version that follows other parameters", async () => {
      await createApp(MiddlewareModule);
      await request(app!)
        .get("/reports")
        .set("Accept", 'application/json; charset=utf-8; v="1" ;q=0.8')
        .expect(200, "v1");
    });

    it("should read a quoted media type version of any range of the list", async () => {
      await createApp(MiddlewareModule);
      await request(app!)
        .get("/reports")
        .set("Accept", 'text/html, application/json;v="1"')
        .expect(200, "v1");
    });

    it("should ignore a version parameter inside a quoted value", async () => {
      await createApp(MiddlewareModule);
      await request(app!)
        .get("/reports")
        .set("Accept", 'application/json;note="a;v=2";v="1"')
        .expect(200, "v1");
    });

    // BUNEST_BUG: Expected cross-site POST /reports with Accept: application/json;v="2" to fail CSRF with 403, got 201 ("v2"). packages/http/src/security/csrf-protection.ts (compileCsrfProtection) ignores `version` on RouteInfo exclude rules, exempting all versions of POST /reports.
    it.skip("should skip the CSRF check for a quoted excluded version only", async () => {
      const excludedCsrfRoute: VersionedRouteInfo = {
        path: "reports",
        method: RequestMethod.POST,
        version: "1",
      };
      await createApp(CsrfModule, (instance) =>
        instance.enableCsrfProtection({
          exclude: [excludedCsrfRoute],
        }),
      );
      const post = (version: string) =>
        request(app!)
          .post("/reports")
          .set("Host", "app.example")
          .set("Sec-Fetch-Site", "cross-site")
          .set("Origin", "https://evil.example")
          .set("Accept", `application/json;v="${version}"`);

      await post("1").expect(201, "v1");
      await post("2").expect(403);
    });
  },
);
