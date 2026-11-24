import { afterEach, beforeEach, describe, it } from "bun:test";
import {
  Controller,
  Get,
  Module,
  Post,
  RequestMethod,
  VERSION_NEUTRAL,
  VersioningType,
  type BunestModule,
  type MiddlewareConsumer,
  type RouteInfo,
  type VersioningOptions,
} from "../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  Test,
  describeConformance,
  itAdapted,
  request,
} from "../../../_helpers";

type VersionedRouteInfo = RouteInfo & { version?: string };

const RETURN_VALUE = "test";
const MIDDLEWARE_VALUE = "middleware";

@Controller()
class HealthController {
  @Get("health")
  getHealth() {
    return RETURN_VALUE;
  }

  @Post("health")
  postHealth() {
    return RETURN_VALUE;
  }
}

@Controller("users")
class UsersController {
  @Get("me")
  findMe() {
    return RETURN_VALUE;
  }

  @Get(":id")
  findOne() {
    return RETURN_VALUE;
  }
}

@Module({
  controllers: [HealthController, UsersController],
})
class TestModule implements BunestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply((_req, _res, _next) => new Response(MIDDLEWARE_VALUE))
      .forRoutes("health", { path: "users/:id", method: RequestMethod.GET });
  }
}

@Controller("reports")
class ReportsController {
  @Get()
  findAll() {
    return RETURN_VALUE;
  }

  @Get(":id")
  findOne() {
    return RETURN_VALUE;
  }
}

@Controller("health")
class ProbesController {
  @Get()
  live() {
    return RETURN_VALUE;
  }

  @Get("ready")
  ready() {
    return RETURN_VALUE;
  }
}

@Controller({ path: "admin", version: "2" })
class VersionedAdminController {
  @Get("secret")
  getSecret() {
    return RETURN_VALUE;
  }

  @Get("items/:version")
  findItem() {
    return RETURN_VALUE;
  }
}

describeConformance(
  "Middleware - global prefix exclusions (BunHttpAdapter)",
  {
    upstreamPath:
      "integration/hello-world/e2e/middleware-global-prefix-exclude.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008", "ADR-010", "ADR-011"],
    notes:
      "Collapsed Express/Fastify adapter matrix to canonical BunHttpAdapter; adapted Express middleware res.end() to native Web Response.",
  },
  () => {
    describe("Middleware - routes excluded from the global prefix", () => {
      let app: BunestApplication | undefined;

      beforeEach(async () => {
        const moduleRef = await Test.createTestingModule({
          imports: [TestModule],
        }).compile({ logger: false });
        app = moduleRef.createNestApplication({ logger: false });
        app.setGlobalPrefix("api", {
          exclude: [{ path: "health", method: RequestMethod.GET }, "users/me"],
        });
        await app.init();
      });

      afterEach(async () => {
        await app?.close();
        app = undefined;
      });

      itAdapted(
        "ADR-011",
        `forRoutes('health') should run on "GET /health" excluded for GET`,
        async () => {
          await request(app!).get("/health").expect(200, MIDDLEWARE_VALUE);
          await request(app!).post("/api/health").expect(200, MIDDLEWARE_VALUE);
          // Per ADR-011, GET /health is registered at /health while POST /health is prefixed under /api/health,
          // so POST /health returns 405 Method Not Allowed with an Allow header instead of Express 404.
          await request(app!)
            .post("/health")
            .expect(405)
            .expect("allow", /GET/);
        },
        "405 Method Not Allowed + Allow header on disallowed method",
      );

      it(`forRoutes('users/:id') should run on "/users/me" excluded from the prefix`, async () => {
        await request(app!).get("/api/users/1").expect(200, MIDDLEWARE_VALUE);
        await request(app!).get("/users/me").expect(200, MIDDLEWARE_VALUE);
      });
    });

    describe("Middleware - controller root excluded from the global prefix by a wildcard", () => {
      let app: BunestApplication | undefined;

      const createApp = async (route: string) => {
        @Module({
          controllers: [ReportsController],
        })
        class ReportsModule implements BunestModule {
          configure(consumer: MiddlewareConsumer) {
            consumer
              .apply((_req, _res, _next) => new Response(MIDDLEWARE_VALUE))
              .forRoutes(route);
          }
        }

        const moduleRef = await Test.createTestingModule({
          imports: [ReportsModule],
        }).compile({ logger: false });
        app = moduleRef.createNestApplication({ logger: false });
        app.setGlobalPrefix("api", { exclude: ["reports/{*path}"] });
        await app.init();
      };

      afterEach(async () => {
        await app?.close();
        app = undefined;
      });

      it.each(["{*path}", "reports"])(
        `forRoutes('%s') should run on "/reports"`,
        async (route) => {
          await createApp(route);
          await request(app!).get("/reports").expect(200, MIDDLEWARE_VALUE);
        },
      );
    });

    describe("Middleware - exclusion covering routes excluded from the global prefix", () => {
      let app: BunestApplication | undefined;

      const createApp = async (
        exclusion: string,
        prefixExclusions: string[],
      ) => {
        @Module({
          controllers: [ProbesController, ReportsController, UsersController],
        })
        class ProbesModule implements BunestModule {
          configure(consumer: MiddlewareConsumer) {
            consumer
              .apply((_req, _res, _next) => new Response(MIDDLEWARE_VALUE))
              .exclude(exclusion)
              .forRoutes("{*path}");
          }
        }

        const moduleRef = await Test.createTestingModule({
          imports: [ProbesModule],
        }).compile({ logger: false });
        app = moduleRef.createNestApplication({ logger: false });
        app.setGlobalPrefix("api", { exclude: prefixExclusions });
        await app.init();
      };

      afterEach(async () => {
        await app?.close();
        app = undefined;
      });

      it.each(["health/{*path}", "health/:check", "health/(.*)"])(
        `exclude('%s') should skip "/health/ready" excluded from the prefix`,
        async (exclusion) => {
          await createApp(exclusion, ["health", "health/ready"]);
          await request(app!).get("/health/ready").expect(200, RETURN_VALUE);
          await request(app!).get("/health").expect(200, MIDDLEWARE_VALUE);
          await request(app!).get("/api/users/1").expect(200, MIDDLEWARE_VALUE);
        },
      );

      it.each(["health/{*path}", "health/*", "health/(.*)"])(
        `exclude('%s') should not skip "/health" excluded from the prefix as "health/"`,
        async (exclusion) => {
          // Served at "/health", which the exclusion does not match
          await createApp(exclusion, ["health/"]);
          await request(app!).get("/health").expect(200, MIDDLEWARE_VALUE);
          await request(app!)
            .get("/api/health/ready")
            .expect(200, RETURN_VALUE);
        },
      );

      it(`exclude('reports') should skip "/reports" excluded by a wildcard`, async () => {
        await createApp("reports", ["reports/{*path}"]);
        await request(app!).get("/reports").expect(200, RETURN_VALUE);
        await request(app!).get("/reports/1").expect(200, MIDDLEWARE_VALUE);
      });
    });

    describe("Middleware - wildcard on versioned routes excluded from the global prefix", () => {
      let app: BunestApplication | undefined;

      const createApp = async (
        versioning: VersioningOptions,
        route: string | VersionedRouteInfo = "*",
      ) => {
        @Module({
          controllers: [VersionedAdminController],
        })
        class VersionedAdminModule implements BunestModule {
          configure(consumer: MiddlewareConsumer) {
            consumer
              .apply((_req, _res, _next) => new Response(MIDDLEWARE_VALUE))
              .forRoutes(route);
          }
        }

        const moduleRef = await Test.createTestingModule({
          imports: [VersionedAdminModule],
        }).compile({ logger: false });
        app = moduleRef.createNestApplication({ logger: false });
        app.setGlobalPrefix("api", {
          exclude: ["admin/secret", "admin/items/:version"],
        });
        app.enableVersioning(versioning);
        await app.init();
      };

      afterEach(async () => {
        await app?.close();
        app = undefined;
      });

      it.each<[string, VersioningOptions, string]>([
        [
          "a default version",
          { type: VersioningType.URI, defaultVersion: "1" },
          "/v2/admin/secret",
        ],
        [
          "no default version",
          { type: VersioningType.URI },
          "/v2/admin/secret",
        ],
        [
          "a neutral default version",
          { type: VersioningType.URI, defaultVersion: VERSION_NEUTRAL },
          "/v2/admin/secret",
        ],
        [
          "a custom version prefix",
          { type: VersioningType.URI, defaultVersion: "1", prefix: "ver" },
          "/ver2/admin/secret",
        ],
        [
          "no version prefix",
          { type: VersioningType.URI, defaultVersion: "1", prefix: false },
          "/2/admin/secret",
        ],
      ])(
        `forRoutes('*') should run with %s`,
        async (_label, versioning, url) => {
          await createApp(versioning);
          await request(app!).get(url).expect(200, MIDDLEWARE_VALUE);
        },
      );

      it(`forRoutes('*') should run on an excluded route with a "version" parameter`, async () => {
        await createApp({ type: VersioningType.URI, defaultVersion: "1" });
        await request(app!)
          .get("/v2/admin/items/1")
          .expect(200, MIDDLEWARE_VALUE);
      });

      it(`forRoutes({ path: '*', version: '1' }) should not run for another version`, async () => {
        await createApp(
          { type: VersioningType.URI, defaultVersion: "1" },
          { path: "*", method: RequestMethod.ALL, version: "1" },
        );
        await request(app!).get("/v2/admin/secret").expect(200, RETURN_VALUE);
      });
    });
  },
);
