import { afterEach, describe, it } from "bun:test";
import {
  Controller,
  Get,
  Module,
  RequestMethod,
  VersioningType,
  type BunestModule,
  type MiddlewareConsumer,
  type RouteInfo,
  type Type,
} from "../../../../../packages/core/src/common";
import type {
  BunestApplication,
  GlobalPrefixOptions,
} from "../../../../../packages/core/src";
import { Test, describeConformance, request } from "../../../_helpers";

const RETURN_VALUE = "test";
const MIDDLEWARE_VALUE = "middleware";

@Controller("files")
class FilesController {
  @Get(":name")
  findOne() {
    return RETURN_VALUE;
  }

  @Get(":name/versions")
  findVersions() {
    return RETURN_VALUE;
  }
}

@Controller("health")
class HealthController {
  @Get("deep")
  deep() {
    return RETURN_VALUE;
  }
}

@Controller("users")
class UsersController {
  @Get()
  findAll() {
    return RETURN_VALUE;
  }

  @Get("me")
  findMe() {
    return RETURN_VALUE;
  }

  @Get(":id")
  findOne() {
    return RETURN_VALUE;
  }
}

@Controller("documents")
class DocumentsController {
  @Get(":id")
  findOne() {
    return RETURN_VALUE;
  }

  @Get("*")
  download() {
    return RETURN_VALUE;
  }
}

@Controller("billing")
class BillingController {
  @Get("webhooks")
  webhooks() {
    return RETURN_VALUE;
  }
}

describeConformance(
  "Middleware - global prefix split routes (BunHttpAdapter)",
  {
    upstreamPath:
      "integration/hello-world/e2e/middleware-global-prefix-split-routes.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008", "ADR-010", "ADR-011"],
    notes:
      "Collapsed Express/Fastify/Node adapter matrix to canonical BunHttpAdapter; adapted Express middleware res.end() to native Web Response and DocumentsController wildcard to Bunest '*' syntax.",
  },
  () => {
    describe("Middleware - routes on both sides of the global prefix", () => {
      let app: BunestApplication | undefined;

      const createApp = async (
        controllers: Type<unknown>[],
        route: string | RouteInfo,
        prefixOptions: GlobalPrefixOptions,
        configure: (app: BunestApplication) => void = () => {},
      ) => {
        @Module({ controllers })
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
        app.setGlobalPrefix("api", prefixOptions);
        configure(app);
        await app.init();
      };

      afterEach(async () => {
        await app?.close();
        app = undefined;
      });

      it(`forRoutes('files/*path') should run on the prefixed routes it covers when it reads as excluded`, async () => {
        // "files/:name" matches the text "files/*path", but not the route
        // "files/:name/versions", which the router keeps under the prefix
        await createApp([FilesController], "files/*path", {
          exclude: ["files/:name"],
        });
        await request(app!).get("/files/x").expect(200, MIDDLEWARE_VALUE);
        await request(app!)
          .get("/api/files/x/versions")
          .expect(200, MIDDLEWARE_VALUE);
      });

      it(`forRoutes('files/*path') should run on the excluded routes it covers`, async () => {
        await createApp([FilesController], "files/*path", {
          exclude: ["files/:name/versions"],
        });
        await request(app!).get("/api/files/x").expect(200, MIDDLEWARE_VALUE);
        await request(app!)
          .get("/files/x/versions")
          .expect(200, MIDDLEWARE_VALUE);
      });

      it(`an all-methods route should run on a route excluded for GET only`, async () => {
        await createApp(
          [HealthController],
          { path: "health/deep", method: RequestMethod.ALL },
          { exclude: [{ path: "health/{*path}", method: RequestMethod.GET }] },
        );
        await request(app!).get("/health/deep").expect(200, MIDDLEWARE_VALUE);
      });

      it(`forRoutes('users/:id') should run on the route excluded for GET only`, async () => {
        await createApp([UsersController], "users/:id", {
          exclude: [{ path: "users/:id", method: RequestMethod.GET }],
        });
        await request(app!).get("/users/42").expect(200, MIDDLEWARE_VALUE);
      });

      it(`should not run on a path no route covered by it serves`, async () => {
        await createApp([FilesController], "files/*path", {
          exclude: ["files/:name"],
        });
        // Under the prefix, only "files/:name/versions" is served
        await request(app!).get("/api/files/x").expect(404);
      });

      describe("mounting a plain string on its sub-paths", () => {
        it(`forRoutes('users') should run on the prefixed routes below it when it is excluded`, async () => {
          await createApp([UsersController], "users", {
            exclude: ["users"],
          });
          await request(app!).get("/users").expect(200, MIDDLEWARE_VALUE);
          await request(app!)
            .get("/api/users/42")
            .expect(200, MIDDLEWARE_VALUE);
        });

        it(`forRoutes('users') should run on the excluded routes below it`, async () => {
          await createApp([UsersController], "users", {
            exclude: ["users/me"],
          });
          await request(app!)
            .get("/api/users/42")
            .expect(200, MIDDLEWARE_VALUE);
          await request(app!).get("/users/me").expect(200, MIDDLEWARE_VALUE);
        });
      });
    });

    describe("Middleware - wildcard on routes excluded from the global prefix", () => {
      let app: BunestApplication | undefined;

      const createApp = async (
        controller: Type<unknown>,
        route: string | RouteInfo,
        exclude: GlobalPrefixOptions["exclude"],
        configure: (app: BunestApplication) => void = () => {},
      ) => {
        @Module({ controllers: [controller, UsersController] })
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
        app.setGlobalPrefix("api", { exclude });
        configure(app);
        await app.init();
      };

      afterEach(async () => {
        await app?.close();
        app = undefined;
      });

      it.each<[string, string | RouteInfo]>([
        ["{*splat}", "{*splat}"],
        [
          "RequestMethod.ALL {*splat}",
          { path: "{*splat}", method: RequestMethod.ALL },
        ],
        [
          "RequestMethod.GET *path",
          { path: "*path", method: RequestMethod.GET },
        ],
      ])(
        `forRoutes(%s) should run on the wildcard route a parameterized exclusion takes out of the prefix`,
        async (_label, route) => {
          await createApp(DocumentsController, route, ["documents/:id"]);
          await request(app!)
            .get("/documents/42")
            .expect(200, MIDDLEWARE_VALUE);
          await request(app!)
            .get("/documents/2026/payroll.pdf")
            .expect(200, MIDDLEWARE_VALUE);
          await request(app!).get("/api/users/1").expect(200, MIDDLEWARE_VALUE);
        },
      );

      it(`forRoutes('{*splat}') should run on the wildcard route excluded under the default version`, async () => {
        await createApp(
          DocumentsController,
          "{*splat}",
          ["documents/:id"],
          (instance) =>
            instance.enableVersioning({
              type: VersioningType.URI,
              defaultVersion: "1",
            }),
        );
        await request(app!)
          .get("/v1/documents/42")
          .expect(200, MIDDLEWARE_VALUE);
        await request(app!)
          .get("/v1/documents/2026/payroll.pdf")
          .expect(200, MIDDLEWARE_VALUE);
      });

      it(`forRoutes('{*splat}') should run on a route excluded in another letter case`, async () => {
        await createApp(BillingController, "{*splat}", ["billing/webHooks"]);
        await request(app!)
          .get("/billing/webhooks")
          .expect(200, MIDDLEWARE_VALUE);
      });
    });
  },
);
