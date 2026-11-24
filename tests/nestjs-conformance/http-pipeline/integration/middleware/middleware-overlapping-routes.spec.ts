import { afterEach, describe, it } from "bun:test";
import {
  All,
  Controller,
  Get,
  Module,
  Post,
  RequestMethod,
  VersioningType,
  type BunestModule,
  type MiddlewareConsumer,
  type Type,
} from "../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../packages/core/src";
import { Test, describeConformance, request } from "../../../_helpers";

const RETURN_VALUE = "test";
const MIDDLEWARE_VALUE = "middleware";

@Controller("docs")
class DocsController {
  @Get("admin")
  admin() {
    return RETURN_VALUE;
  }

  @Get(":id.json")
  json() {
    return RETURN_VALUE;
  }
}

@Controller("files")
class FilesController {
  @Get(":id")
  findOne() {
    return RETURN_VALUE;
  }

  @Get("{*path}")
  findAll() {
    return RETURN_VALUE;
  }
}

@Controller({ path: "accounts", version: "1" })
class AccountsV1Controller {
  @Get(":id")
  findOne() {
    return RETURN_VALUE;
  }
}

@Controller({ path: "accounts", version: "2" })
class AccountsV2Controller {
  @Get("me")
  findMe() {
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

@Controller("invoices")
class InvoicesController {
  @Get()
  findAll() {
    return RETURN_VALUE;
  }
}

@Controller(":tenant")
class TenantPagesController {
  @Get("*")
  findPage() {
    return RETURN_VALUE;
  }
}

@Controller("a")
class OptionalIdController {
  @Get()
  findAll() {
    return RETURN_VALUE;
  }

  @Get("{:id}")
  findOne() {
    return RETURN_VALUE;
  }
}

@Controller("shop")
class ShopController {
  @Get("admin/reports")
  findReports() {
    return RETURN_VALUE;
  }

  @Post("admin/reports")
  createReport() {
    return RETURN_VALUE;
  }

  @Get(":id")
  findOne() {
    return RETURN_VALUE;
  }
}

@Controller("shop")
class ShopWithAllController {
  @All(":id")
  handle() {
    return RETURN_VALUE;
  }
}

describeConformance(
  "Middleware - overlapping routes (BunHttpAdapter)",
  {
    upstreamPath:
      "integration/hello-world/e2e/middleware-overlapping-routes.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008", "ADR-010", "ADR-011"],
    notes:
      "Collapsed Express/Fastify/Node adapter matrices to canonical BunHttpAdapter; adapted Express middleware res.end() to native Web Response.",
  },
  () => {
    describe("Middleware - routes next to a parameterized route", () => {
      let app: BunestApplication | undefined;

      const createApp = async (
        controllers: Type<unknown>[],
        beforeInit: (app: BunestApplication) => void = () => {},
      ) => {
        @Module({ controllers })
        class TestModule implements BunestModule {
          configure(consumer: MiddlewareConsumer) {
            consumer
              .apply((_req, _res, _next) => new Response(MIDDLEWARE_VALUE))
              .forRoutes(...controllers);
          }
        }

        const moduleRef = await Test.createTestingModule({
          imports: [TestModule],
        }).compile({ logger: false });
        app = moduleRef.createNestApplication({ logger: false });
        beforeInit(app);
        await app.init();
      };

      afterEach(async () => {
        await app?.close();
        app = undefined;
      });

      it(`should run on "/docs/admin" next to "/docs/:id.json"`, async () => {
        await createApp([DocsController]);
        await request(app!).get("/docs/x.json").expect(200, MIDDLEWARE_VALUE);
        await request(app!).get("/docs/admin").expect(200, MIDDLEWARE_VALUE);
      });

      it(`should run on "/v2/accounts/me" next to "/v1/accounts/:id"`, async () => {
        await createApp(
          [AccountsV1Controller, AccountsV2Controller],
          (instance) => instance.enableVersioning({ type: VersioningType.URI }),
        );
        await request(app!).get("/v1/accounts/1").expect(200, MIDDLEWARE_VALUE);
        await request(app!)
          .get("/v2/accounts/me")
          .expect(200, MIDDLEWARE_VALUE);
      });

      it(`should run on "/users/me" excluded from the global prefix next to "/api/users/:id"`, async () => {
        await createApp([UsersController], (instance) =>
          instance.setGlobalPrefix("api", { exclude: ["users/me"] }),
        );
        await request(app!).get("/api/users/1").expect(200, MIDDLEWARE_VALUE);
        await request(app!).get("/users/me").expect(200, MIDDLEWARE_VALUE);
      });

      it(`should run on the root route "/invoices" next to "/:tenant/*"`, async () => {
        await createApp([InvoicesController, TenantPagesController]);
        await request(app!).get("/acme/settings").expect(200, MIDDLEWARE_VALUE);
        await request(app!).get("/invoices").expect(200, MIDDLEWARE_VALUE);
      });

      it(`should run on the root route "/a" next to "/a/{:id}"`, async () => {
        await createApp([OptionalIdController]);
        await request(app!).get("/a/1").expect(200, MIDDLEWARE_VALUE);
        await request(app!).get("/a").expect(200, MIDDLEWARE_VALUE);
      });

      it(`should run on "/files/a/b" next to "/files/:id"`, async () => {
        await createApp([FilesController]);
        await request(app!).get("/files/a").expect(200, MIDDLEWARE_VALUE);
        await request(app!).get("/files/a/b").expect(200, MIDDLEWARE_VALUE);
      });
    });

    describe("Middleware - a plain string next to a parameterized RequestMethod.ALL route", () => {
      let app: BunestApplication | undefined;

      const createApp = async (
        controller: Type<unknown>,
        configure: (consumer: MiddlewareConsumer) => void,
      ) => {
        @Module({ controllers: [controller] })
        class TestModule implements BunestModule {
          configure(consumer: MiddlewareConsumer) {
            configure(consumer);
          }
        }

        const moduleRef = await Test.createTestingModule({
          imports: [TestModule],
        }).compile({ logger: false });
        app = moduleRef.createNestApplication({ logger: false });
        await app.init();
      };

      const middleware = () => new Response(MIDDLEWARE_VALUE);

      afterEach(async () => {
        await app?.close();
        app = undefined;
      });

      it(`should run under "/shop/admin" next to "/shop/:id"`, async () => {
        await createApp(ShopController, (consumer) =>
          consumer
            .apply(middleware)
            .forRoutes(
              { path: "shop/:id", method: RequestMethod.ALL },
              "shop/admin",
            ),
        );
        await request(app!).get("/shop/admin").expect(200, MIDDLEWARE_VALUE);
        await request(app!)
          .get("/shop/admin/reports")
          .expect(200, MIDDLEWARE_VALUE);
        await request(app!)
          .post("/shop/admin/reports")
          .expect(200, MIDDLEWARE_VALUE);
      });

      it("should run under the string next to a controller with an @All() route", async () => {
        await createApp(ShopWithAllController, (consumer) =>
          consumer
            .apply(middleware)
            .forRoutes(ShopWithAllController, "shop/admin"),
        );
        await request(app!)
          .get("/shop/admin/undeclared")
          .expect(200, MIDDLEWARE_VALUE);
      });
    });
  },
);
