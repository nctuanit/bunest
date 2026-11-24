import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import {
  Controller,
  Get,
  Module,
  UnauthorizedException,
  type BunestModule,
  type MiddlewareConsumer,
  type NextFunction,
  type ResponseContext,
} from "../../../../../packages/core/src/common";
import {
  NestFactory,
  type BunestApplication,
} from "../../../../../packages/core/src";
import { describeConformance, itAdapted, request } from "../../../_helpers";

const middlewareCalls: string[] = [];

@Controller()
class AppController {
  @Get()
  getRoot() {
    return "ok";
  }

  @Get("ended")
  getEnded() {
    return "unreachable";
  }
}

@Module({ controllers: [AppController] })
class AppModule implements BunestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply((req: Request, res: ResponseContext, next: NextFunction) => {
        middlewareCalls.push(req.method);
        const pathname = new URL(req.url).pathname;
        if (pathname.startsWith("/ended")) {
          res.status(418);
          return new Response(null, { status: 418 });
        }
        if (!req.headers.get("authorization")) {
          throw new UnauthorizedException();
        }
        return next();
      })
      .forRoutes(AppController);
  }
}

describeConformance(
  "CORS and middleware (BunHttpAdapter)",
  {
    upstreamPath: "integration/cors/e2e/middleware.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008"],
    notes:
      "Adapts NestJS CORS + middleware interaction tests to Bunest 11-stage Promise onion pipeline where Stage 3 (CORS) precedes Stage 4 (Middleware).",
  },
  () => {
    const setups: Array<[string, () => Promise<BunestApplication>]> = [
      [
        "enableCors()",
        async () => {
          const app = await NestFactory.create(AppModule, { logger: false });
          app.enableCors({ origin: "*" });
          await app.init();
          return app;
        },
      ],
      [
        "the cors option",
        async () => {
          const app = await NestFactory.create(AppModule, {
            logger: false,
            cors: { origin: "*" },
          });
          await app.init();
          return app;
        },
      ],
      [
        "enableCors() with dynamic origin callback",
        async () => {
          const app = await NestFactory.create(AppModule, { logger: false });
          app.enableCors({ origin: () => "*" });
          await app.init();
          return app;
        },
      ],
    ];

    describe.each(setups)("with %s", (_label, createApp) => {
      let app: BunestApplication;

      beforeAll(async () => {
        app = await createApp();
      });

      beforeEach(() => {
        middlewareCalls.length = 0;
      });

      afterAll(async () => {
        await app.close();
      });

      it("should add the CORS headers to the error response of a middleware", async () => {
        await request(app)
          .get("/")
          .set("Origin", "https://example.com")
          .expect(401)
          .expect("access-control-allow-origin", "*");
      });

      it("should add the CORS headers to a response a middleware ends", async () => {
        await request(app)
          .get("/ended")
          .set("Origin", "https://example.com")
          .expect(418)
          .expect("access-control-allow-origin", "*");
      });

      it("should answer a preflight request before the middleware", async () => {
        await request(app)
          .options("/")
          .set("Origin", "https://example.com")
          .set("Access-Control-Request-Method", "GET")
          .set("Access-Control-Request-Headers", "authorization")
          .expect(204)
          .expect("access-control-allow-origin", "*")
          .expect("access-control-allow-headers", "authorization");
        expect(middlewareCalls).toEqual([]);
      });

      it("should add the CORS headers to a response the handler sends", async () => {
        await request(app)
          .get("/")
          .set("Origin", "https://example.com")
          .set("Authorization", "Bearer token")
          .expect(200, "ok")
          .expect("access-control-allow-origin", "*");
      });
    });

    itAdapted(
      "ADR-008",
      "should also add CORS headers when a middleware short-circuits by omitting next()",
      async () => {
        @Controller()
        class ShortCircuitController {
          @Get("short")
          short() {
            return "unreachable";
          }
        }

        @Module({ controllers: [ShortCircuitController] })
        class ShortCircuitModule implements BunestModule {
          configure(consumer: MiddlewareConsumer) {
            consumer
              .apply((_req: Request, res: ResponseContext) => {
                res.status(418);
              })
              .forRoutes(ShortCircuitController);
          }
        }

        const app = await NestFactory.create(ShortCircuitModule, {
          logger: false,
          cors: { origin: "*" },
        });
        await app.init();
        try {
          await request(app)
            .get("/short")
            .set("Origin", "https://example.com")
            .expect(418)
            .expect("access-control-allow-origin", "*");
        } finally {
          await app.close();
        }
      },
      "Stage 4 middleware short-circuit without returning Response preserves Stage 3 CORS headers",
    );
  },
);
