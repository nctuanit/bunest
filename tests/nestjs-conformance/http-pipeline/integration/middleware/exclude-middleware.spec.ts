import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  Controller,
  Delete,
  Get,
  Module,
  Post,
  RequestMethod,
  type BunestModule,
  type MiddlewareConsumer,
} from "../../../../../packages/core/src/common";
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
          const chunks: Uint8Array[] = [];
          let settled = false;
          const finish = () => {
            if (settled) {
              return;
            }
            settled = true;
            const response = Buffer.concat(chunks).toString("utf8");
            const [head = "", body = ""] = response.split("\r\n\r\n");
            resolve({ statusCode: Number(head.split(" ")[1]), body });
          };
          const fail = (err: unknown) => {
            if (settled) {
              return;
            }
            settled = true;
            reject(err);
          };
          void Bun.connect({
            hostname: "127.0.0.1",
            port,
            socket: {
              open(socket) {
                socket.write(
                  `GET ${requestTarget} HTTP/1.1\r\n` +
                    `Host: 127.0.0.1:${port}\r\n` +
                    `Connection: close\r\n\r\n`,
                );
              },
              data(_socket, chunk) {
                chunks.push(new Uint8Array(chunk));
              },
              end() {
                finish();
              },
              close() {
                finish();
              },
              error(_socket, err) {
                fail(err);
              },
              connectError(_socket, err) {
                fail(err);
              },
            },
          }).catch(fail);
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

      it(`should not exclude "/profiles/1#/avatar", which the router serves with "/profiles/:id"`, async () => {
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

      it(`should not exclude "/invoices/", which the router serves with "/invoices"`, async () => {
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

      it(`should not exclude "/reports/", which the router serves with "/reports/{*path}"`, async () => {
        await createApp("reports", "exports");
        await request(app!).get("/reports/").expect(200, MIDDLEWARE_VALUE);
        await request(app!).delete("/exports/").expect(200, MIDDLEWARE_VALUE);
      });

      it(`should exclude "/reports/" when "/reports/{*path}" is excluded too`, async () => {
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

      it(`should exclude "/statements/1.pdf" endpoint`, async () => {
        await request(app!).get("/statements/1.pdf").expect(200, "published");
      });

      it(`should not exclude "/statements/drafts" endpoint`, async () => {
        await request(app!)
          .get("/statements/drafts")
          .expect(200, MIDDLEWARE_VALUE);
      });

      it.each(["%0A", "%0D", "%E2%80%A8", "%E2%80%A9"])(
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

        it(`should not exclude "/users/LOGIN", which the router serves with "/users/:id"`, async () => {
          await request(app!).get("/users/LOGIN").expect(200, MIDDLEWARE_VALUE);
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

      it(`should not exclude "/test2" endpoint`, async () => {
        await request(app!).get("/test2").expect(200, MIDDLEWARE_VALUE);
      });

      it(`should run middleware for "/middleware" endpoint`, async () => {
        await request(app!).get("/middleware").expect(200, MIDDLEWARE_VALUE);
      });

      it(`should exclude POST "/middleware" endpoint`, async () => {
        await request(app!).post("/middleware").expect(201, RETURN_VALUE);
      });

      it(`should exclude "/overview/:id" endpoint (by param)`, async () => {
        await request(app!).get("/overview/1").expect(200, RETURN_VALUE);
      });

      it(`should exclude "/wildcard/overview" endpoint (by wildcard)`, async () => {
        await request(app!).get("/wildcard/overview").expect(200, RETURN_VALUE);
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
        await request(app!).get("/multiple/exclude").expect(200, RETURN_VALUE);
      });
    });
  },
);
