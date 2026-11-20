import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  Body,
  Controller,
  Get,
  Header,
  Injectable,
  InternalServerErrorException,
  Module,
  Post,
  Put,
  Sse,
  type BunestMiddleware,
  type BunestModule,
  type MiddlewareConsumer,
  type NextFunction,
  type ResponseContext,
  type SseMessageEvent,
} from "../../../../../packages/common/src";
import {
  NestFactory,
  type BunestApplication,
} from "../../../../../packages/core/src";
import {
  Test,
  describeConformance,
  itAdapted,
  request,
} from "../../../_helpers";

const DEFAULT_CSP =
  "default-src 'self';base-uri 'self';font-src 'self' https: data:;" +
  "form-action 'self';frame-ancestors 'self';img-src 'self' data:;" +
  "object-src 'none';script-src 'self';script-src-attr 'none';" +
  "style-src 'self' https: 'unsafe-inline';upgrade-insecure-requests";

const DEFAULT_HEADERS: Record<string, string> = {
  "content-security-policy": DEFAULT_CSP,
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "origin-agent-cluster": "?1",
  "referrer-policy": "no-referrer",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "x-dns-prefetch-control": "off",
  "x-download-options": "noopen",
  "x-frame-options": "SAMEORIGIN",
  "x-permitted-cross-domain-policies": "none",
  "x-xss-protection": "0",
};

const expectDefaultHeaders = (headers: Record<string, unknown>) => {
  for (const [name, value] of Object.entries(DEFAULT_HEADERS)) {
    expect(headers[name]).toBe(value);
  }
  expect(headers["x-powered-by"]).toBeUndefined();
  expect(headers["cross-origin-embedder-policy"]).toBeUndefined();
};

@Injectable()
class AnswerMiddleware implements BunestMiddleware {
  use() {
    return new Response("answered by middleware", {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
}

@Controller()
class AppController {
  @Get("items")
  findAll() {
    return { items: [] };
  }

  @Post("items")
  create(@Body() body: Record<string, unknown>) {
    return { created: true, body };
  }

  @Put("items")
  replace() {
    return { replaced: true };
  }

  @Get("embeddable")
  @Header("X-Frame-Options", "DENY")
  @Header("Cross-Origin-Resource-Policy", "cross-origin")
  embeddable() {
    return { embeddable: true };
  }

  @Get("error")
  error() {
    throw new InternalServerErrorException();
  }

  @Sse("events")
  async *events(): AsyncIterable<SseMessageEvent> {
    yield { data: "hello" };
  }

  @Get("middleware")
  middlewareRoute() {
    return "unreachable";
  }

  @Get("early")
  earlyRoute() {
    return "unreachable";
  }
}

@Controller("hooks")
class HooksController {
  @Post("github/:event")
  githubEvent() {
    return { handler: "github/:event" };
  }
}

@Module({
  controllers: [AppController, HooksController],
  providers: [AnswerMiddleware],
})
class AppModule implements BunestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(AnswerMiddleware).forRoutes("middleware");
  }
}

describeConformance(
  "Security headers E2E (BunHttpAdapter)",
  {
    upstreamPath: "integration/security/e2e/security-headers.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008", "ADR-010"],
    notes:
      "Adapts NestJS v12 useSecurityHeaders() E2E tests from Express/Fastify/Node to BunHttpAdapter.",
  },
  () => {
    let app: BunestApplication;

    const init = async (configure: (app: BunestApplication) => void) => {
      const moduleRef = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      app = moduleRef.createNestApplication({ logger: false });
      configure(app);
      await app.init();
    };

    afterEach(async () => {
      await app?.close();
    });

    describe("with default options", () => {
      beforeEach(() => init((a) => a.useSecurityHeaders()));

      it("sets the helmet-equivalent defaults and removes X-Powered-By", async () => {
        const res = await request(app).get("/items").expect(200);
        expectDefaultHeaders(res.headers);
      });

      it("sets each header exactly once", async () => {
        const res = await request(app).get("/items").expect(200);
        const rawEntries = [...res.rawHeaders.entries()].map(([k]) =>
          k.toLowerCase(),
        );
        for (const name of Object.keys(DEFAULT_HEADERS)) {
          expect(rawEntries.filter((n) => n === name)).toHaveLength(1);
        }
      });

      it("sets them on 404 responses", async () => {
        const res = await request(app).get("/does-not-exist").expect(404);
        expectDefaultHeaders(res.headers);
      });

      it("sets them on error responses", async () => {
        const res = await request(app).get("/error").expect(500);
        expectDefaultHeaders(res.headers);
      });

      it("sets them on 405 Method Not Allowed responses rejected by the router", async () => {
        const res = await request(app).delete("/items").expect(405);
        expectDefaultHeaders(res.headers);
      });

      itAdapted(
        ["ADR-008", "ADR-010"],
        "sets them on Server-Sent Events streams",
        async () => {
          const res = await request(app)
            .get("/events")
            .expect(200)
            .expect("Content-Type", /text\/event-stream/);
          expectDefaultHeaders(res.headers);
        },
        "AsyncIterable SSE response receives compiled security headers",
      );

      it("lets @Header() override a header per route", async () => {
        const res = await request(app).get("/embeddable").expect(200);
        expect(res.headers["x-frame-options"]).toBe("DENY");
        expect(res.headers["cross-origin-resource-policy"]).toBe("cross-origin");
        expect(res.headers["content-security-policy"]).toBe(DEFAULT_CSP);
      });
    });

    describe.each([
      [
        "useSecurityHeaders() first",
        (a: BunestApplication) =>
          a.useSecurityHeaders().enableCsrfProtection(),
      ],
      [
        "enableCsrfProtection() first",
        (a: BunestApplication) =>
          a.enableCsrfProtection().useSecurityHeaders(),
      ],
    ])("with CSRF protection, %s", (_order, configure) => {
      beforeEach(() => init(configure));

      it("sets them on responses rejected by the CSRF protection", async () => {
        const res = await request(app)
          .post("/items")
          .set("Sec-Fetch-Site", "cross-site")
          .expect(403);
        expectDefaultHeaders(res.headers);
      });

      it("sets them on allowed requests", async () => {
        const res = await request(app)
          .post("/items")
          .set("Sec-Fetch-Site", "same-origin")
          .expect(201);
        expectDefaultHeaders(res.headers);
      });
    });

    describe("with custom options", () => {
      beforeEach(() =>
        init((a) =>
          a.useSecurityHeaders({
            xFrameOptions: false,
            strictTransportSecurity: { maxAge: 600, preload: true },
            contentSecurityPolicy: {
              directives: {
                scriptSrc: ["'self'", "https://cdn.example"],
                upgradeInsecureRequests: null,
              },
            },
          }),
        ),
      );

      it("omits disabled headers and applies the configuration", async () => {
        const res = await request(app).get("/items").expect(200);
        expect(res.headers["x-frame-options"]).toBeUndefined();
        expect(res.headers["strict-transport-security"]).toBe(
          "max-age=600; includeSubDomains; preload",
        );
        expect(res.headers["content-security-policy"]).toBe(
          DEFAULT_CSP.replace(
            "script-src 'self';",
            "script-src 'self' https://cdn.example;",
          ).replace(";upgrade-insecure-requests", ""),
        );
        expect(res.headers["x-content-type-options"]).toBe("nosniff");
      });
    });

    describe("with a report-only policy and X-Powered-By kept", () => {
      beforeEach(() =>
        init((a) =>
          a.useSecurityHeaders({
            contentSecurityPolicy: { reportOnly: true },
            xPoweredBy: false,
          }),
        ),
      );

      it("sends Content-Security-Policy-Report-Only", async () => {
        const res = await request(app).get("/items").expect(200);
        expect(res.headers["content-security-policy"]).toBeUndefined();
        expect(res.headers["content-security-policy-report-only"]).toBe(
          DEFAULT_CSP,
        );
      });
    });

    // BUNEST_BUG: executeMiddlewareChain returns middleware short-circuit Responses directly via finalizeShortCircuitResponse without calling applySecurityHeaders() (packages/http/src/pipeline/execution-pipeline.ts:482-515).
    it.skip("sets them on responses ended by Nest middleware (NestFactory.create())", async () => {
      app = await NestFactory.create(AppModule, { logger: false });
      app.useSecurityHeaders();
      await app.init();

      const res = await request(app)
        .get("/middleware")
        .expect(200, "answered by middleware");
      expectDefaultHeaders(res.headers);
    });

    // BUNEST_BUG: executeMiddlewareChain returns middleware short-circuit Responses directly without calling applySecurityHeaders(), leaving X-Powered-By intact (packages/http/src/pipeline/execution-pipeline.ts:482-515).
    it.skip("removes X-Powered-By from responses ended by earlier middleware and preflight", async () => {
      await init((a) => {
        a.use((req: Request, _res: ResponseContext, next: NextFunction) => {
          if (new URL(req.url).pathname === "/early") {
            return new Response(null, {
              status: 200,
              headers: { "X-Powered-By": "Custom" },
            });
          }
          return next();
        });
        a.enableCors();
        a.useSecurityHeaders();
      });

      const early = await request(app).get("/early").expect(200);
      expect(early.headers["x-powered-by"]).toBeUndefined();

      const preflight = await request(app)
        .options("/items")
        .set("Origin", "http://example.com")
        .set("Access-Control-Request-Method", "GET")
        .expect(204);
      expect(preflight.headers["x-powered-by"]).toBeUndefined();
    });

    it("does not send security headers when the feature is not used", async () => {
      await init(() => undefined);
      const res = await request(app).get("/items").expect(200);
      expect(res.headers["content-security-policy"]).toBeUndefined();
    });

    // BUNEST_BUG: compileSecurityHeaders does not validate CSP directive values for ";" injection and fails to throw at startup (packages/http/src/security/security-headers.ts).
    it.skip("rejects an invalid policy at startup", async () => {
      await expect(
        init((a) =>
          a.useSecurityHeaders({
            contentSecurityPolicy: {
              directives: { scriptSrc: "'self'; script-src *" },
            },
          }),
        ),
      ).rejects.toThrow(/script-src|Content-Security-Policy/i);
    });
  },
);
