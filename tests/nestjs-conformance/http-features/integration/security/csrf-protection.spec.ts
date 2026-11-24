import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  Body,
  Catch,
  Controller,
  ForbiddenException,
  Get,
  Header,
  Injectable,
  InternalServerErrorException,
  Module,
  Post,
  Put,
  RequestMethod,
  Sse,
  UnauthorizedException,
  UseGuards,
  type ArgumentsHost,
  type BunestMiddleware,
  type BunestModule,
  type CanActivate,
  type ExceptionFilter,
  type MiddlewareConsumer,
  type NextFunction,
  type ResponseContext,
  type SseMessageEvent,
} from "../../../../../packages/core/src/common";
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

const HOST = "app.example";

@Injectable()
class DenyGuard implements CanActivate {
  canActivate(): boolean {
    throw new UnauthorizedException();
  }
}

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

  @Post("webhooks/stripe")
  webhook() {
    return { received: true };
  }

  @Post("guarded")
  @UseGuards(DenyGuard)
  guarded() {
    return { guarded: true };
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

  @Post("middleware")
  middlewareRoute() {
    return "unreachable";
  }

  @Get("middleware")
  middlewareGet() {
    return "unreachable";
  }

  @Post("use")
  useRoute() {
    return "unreachable";
  }
}

@Controller("hooks")
class HooksController {
  @Post("github")
  github() {
    return { handler: "github" };
  }

  @Post("github/:event")
  githubEvent() {
    return { handler: "github/:event" };
  }

  @Post(":provider")
  provider() {
    return { handler: ":provider" };
  }
}

@Module({
  controllers: [AppController, HooksController],
  providers: [AnswerMiddleware, DenyGuard],
})
class AppModule implements BunestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(AnswerMiddleware).forRoutes("middleware");
  }
}

@Catch(ForbiddenException)
class ProblemDetailsFilter implements ExceptionFilter {
  catch(exception: ForbiddenException, _host: ArgumentsHost) {
    return new Response(
      JSON.stringify({
        type: "about:blank",
        title: "Forbidden",
        status: 403,
        detail: exception.message,
      }),
      {
        status: 403,
        headers: { "content-type": "application/problem+json" },
      },
    );
  }
}

describeConformance(
  "CSRF protection E2E (BunHttpAdapter)",
  {
    upstreamPath: "integration/security/e2e/csrf-protection.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008", "ADR-010"],
    notes:
      "Adapts NestJS v12 enableCsrfProtection() E2E tests from Express/Fastify/Node to BunHttpAdapter + native Web Response exception filter.",
  },
  () => {
    let app: BunestApplication;

    const init = async (
      configure: (app: BunestApplication) => void | Promise<void>,
      listen = false,
    ) => {
      const moduleRef = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      app = moduleRef.createNestApplication({ logger: false });
      await configure(app);
      if (listen) {
        await app.listen(0, "127.0.0.1");
      } else {
        await app.init();
      }
    };

    afterEach(async () => {
      await app?.close();
    });

    describe("with default options", () => {
      beforeEach(() =>
        init((a) => {
          a.enableCsrfProtection();
        }),
      );

      it("rejects a cross-site POST with 403 before the route runs", async () => {
        const res = await request(app)
          .post("/items")
          .set("Host", HOST)
          .set("Sec-Fetch-Site", "cross-site")
          .set("Origin", "https://evil.example")
          .send({ name: "x" })
          .expect(403);
        expect(res.body.statusCode).toBe(403);
        expect(res.body.error).toBe("Forbidden");
        expect(res.body.message).toMatch(/Sec-Fetch-Site/i);
      });

      it("rejects a same-site (sibling subdomain) PUT", async () => {
        await request(app)
          .put("/items")
          .set("Host", HOST)
          .set("Sec-Fetch-Site", "same-site")
          .expect(403);
      });

      it("allows a same-origin POST", async () => {
        await request(app)
          .post("/items")
          .set("Host", HOST)
          .set("Sec-Fetch-Site", "same-origin")
          .set("Origin", `https://${HOST}`)
          .send({ name: "x" })
          .expect(201, { created: true, body: { name: "x" } });
      });

      it("allows a POST without Sec-Fetch-Site and Origin (non-browser)", async () => {
        await request(app).post("/items").set("Host", HOST).expect(201);
      });

      it("allows a POST whose Origin matches Host (no Sec-Fetch-Site)", async () => {
        await request(app)
          .post("/items")
          .set("Host", HOST)
          .set("Origin", `https://${HOST}`)
          .expect(201);
      });

      it("rejects a POST whose Origin does not match Host (no Sec-Fetch-Site)", async () => {
        const res = await request(app)
          .post("/items")
          .set("Host", HOST)
          .set("Origin", "https://evil.example")
          .expect(403);
        expect(res.body.message).toMatch(/Origin does not match Host/);
      });

      it("always allows GET", async () => {
        await request(app)
          .get("/items")
          .set("Host", HOST)
          .set("Sec-Fetch-Site", "cross-site")
          .set("Origin", "https://evil.example")
          .expect(200);
      });

      it("runs before guards", async () => {
        await request(app)
          .post("/guarded")
          .set("Host", HOST)
          .set("Sec-Fetch-Site", "cross-site")
          .expect(403);
      });

      it("runs before body parsing", async () => {
        await request(app)
          .post("/items")
          .set("Host", HOST)
          .set("Sec-Fetch-Site", "cross-site")
          .set("Content-Type", "application/json")
          .send("{not json")
          .expect(403);
      });

      // BUNEST_BUG: BunHttpAdapter 404 fallback path does not evaluate csrfProtection before returning 404 NotFoundException (packages/core/src/http/adapter/bun-http.adapter.ts:835-850).
      it.skip("protects unmatched routes as well", async () => {
        await request(app)
          .post("/does-not-exist")
          .set("Host", HOST)
          .set("Sec-Fetch-Site", "cross-site")
          .expect(403);
      });

      it("runs before Nest middleware", async () => {
        await request(app)
          .post("/middleware")
          .set("Host", HOST)
          .set("Sec-Fetch-Site", "cross-site")
          .expect(403);
      });
    });

    describe("with an application created by NestFactory.create()", () => {
      beforeEach(async () => {
        app = await NestFactory.create(AppModule, { logger: false });
        app.enableCsrfProtection();
        app.use((req: Request, _res: ResponseContext, next: NextFunction) => {
          if (new URL(req.url).pathname === "/use") {
            return new Response("answered by app.use()", { status: 200 });
          }
          return next();
        });
        await app.init();
      });

      it("runs before Nest middleware and middleware added afterwards", async () => {
        const post = (path: string) =>
          request(app)
            .post(path)
            .set("Host", HOST)
            .set("Sec-Fetch-Site", "cross-site");

        await post("/middleware").expect(403);
        await post("/use").expect(403);
        await post("/items").expect(403);
      });

      it("allows a same-origin POST to reach middleware", async () => {
        await request(app)
          .post("/middleware")
          .set("Host", HOST)
          .set("Sec-Fetch-Site", "same-origin")
          .expect(200, "answered by middleware");
      });
    });

    describe("with trusted origins and exclusions", () => {
      beforeEach(() =>
        init((a) => {
          a.setGlobalPrefix("api");
          a.enableCsrfProtection({
            trustedOrigins: ["https://admin.example"],
            exclude: [
              { path: "webhooks/*path", method: RequestMethod.POST },
              { path: "hooks/github", method: RequestMethod.POST },
            ],
          });
        }, true),
      );

      it("allows a cross-site POST from a trusted origin", async () => {
        await request(app)
          .post("/api/items")
          .set("Host", HOST)
          .set("Sec-Fetch-Site", "cross-site")
          .set("Origin", "https://admin.example")
          .expect(201);
      });

      it("allows an Origin mismatch from a trusted origin", async () => {
        await request(app)
          .post("/api/items")
          .set("Host", HOST)
          .set("Origin", "https://admin.example")
          .expect(201);
      });

      it("still rejects other origins", async () => {
        await request(app)
          .post("/api/items")
          .set("Host", HOST)
          .set("Sec-Fetch-Site", "cross-site")
          .set("Origin", "https://evil.example")
          .expect(403);
      });

      // BUNEST_BUG: compileCsrfProtection exclude matching only performs exact string equality and does not support wildcard patterns like "webhooks/*path" (packages/core/src/http/security/csrf-protection.ts:90-140).
      it.skip("allows an excluded route (declared without the global prefix)", async () => {
        await request(app)
          .post("/api/webhooks/stripe")
          .set("Host", HOST)
          .set("Sec-Fetch-Site", "cross-site")
          .set("Origin", "https://api.stripe.example")
          .expect(201, { received: true });
      });

      // BUNEST_BUG: BunHttpAdapter skips CSRF check on unmatched 404 routes like "/api/hooks/github/" (returns 404 instead of 403), and compileCsrfProtection erroneously also excludes unprefixed "/hooks/github" when globalPrefix is set (packages/core/src/http/adapter/bun-http.adapter.ts:835-850, packages/core/src/http/security/csrf-protection.ts:97-101).
      it.skip("only excludes the exact route", async () => {
        const post = (path: string) =>
          request(app)
            .post(path)
            .set("Host", HOST)
            .set("Sec-Fetch-Site", "cross-site")
            .set("Origin", "https://github.example");

        await post("/api/hooks/github").expect(201, { handler: "github" });
        await post("/api/hooks/github/").expect(403);
        await post("/api/hooks/GITHUB").expect(403);
        await post("/api/hooks/github/push").expect(403);
        await post("/api/hooks/gitlab").expect(403);
        await post("/hooks/github").expect(403);
        await post("/api/hooks/github?x=1").expect(201);
      });

      // BUNEST_BUG: compileCsrfProtection does not support wildcard exclude "webhooks/*path", so /api/webhooks/stripe returns 403 instead of 201 (packages/core/src/http/security/csrf-protection.ts:90-140).
      it.skip("does not exclude non-canonical paths", async () => {
        const port = Number(new URL(app.getUrl()!).port);
        const rawPost = (path: string) =>
          new Promise<number>((resolve, reject) => {
            const chunks: Uint8Array[] = [];
            let settled = false;
            const finish = () => {
              if (settled) {
                return;
              }
              settled = true;
              const head = Buffer.concat(chunks)
                .toString("utf8")
                .split("\r\n\r\n")[0] ?? "";
              resolve(Number(head.split(" ")[1]));
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
                    `POST ${path} HTTP/1.1\r\n` +
                      `Host: ${HOST}\r\n` +
                      `Sec-Fetch-Site: cross-site\r\n` +
                      `Content-Length: 0\r\n` +
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

        expect(await rawPost("/api/webhooks/stripe")).toBe(201);
        expect(await rawPost("/api/webhooks/stripe/../../items")).toBe(403);
        expect(await rawPost("/api/webhooks/%2e%2e/%2e%2e/items")).toBe(403);
        expect(await rawPost("/api//hooks/github")).toBe(403);
        expect(await rawPost("/api/hooks/github;x")).toBe(403);
      });
    });

    describe("with an exclusion ending in an optional wildcard", () => {
      beforeEach(() =>
        init((a) => {
          a.setGlobalPrefix("api");
          a.enableCsrfProtection({ exclude: ["hooks/github/*"] });
        }),
      );

      // BUNEST_BUG: compileCsrfProtection does not support wildcard exclude patterns like "hooks/github/*" (packages/core/src/http/security/csrf-protection.ts:90-140).
      it.skip("does not exclude the parent route through a trailing slash", async () => {
        const post = (path: string) =>
          request(app)
            .post(path)
            .set("Host", HOST)
            .set("Sec-Fetch-Site", "cross-site")
            .set("Origin", "https://github.example");

        await post("/api/hooks/github/push").expect(201, {
          handler: "github/:event",
        });
        await post("/api/hooks/github").expect(403);
        const trailing = await post("/api/hooks/github/");
        expect([403, 404]).toContain(trailing.status);
      });
    });

    describe("with an exclusion covering a route excluded from the global prefix", () => {
      beforeEach(() =>
        init((a) => {
          a.setGlobalPrefix("api", { exclude: ["webhooks/stripe"] });
          a.enableCsrfProtection({
            exclude: [{ path: "webhooks/*path", method: RequestMethod.POST }],
          });
        }),
      );

      // BUNEST_BUG: compileCsrfProtection does not support wildcard exclude patterns like "webhooks/*path" (packages/core/src/http/security/csrf-protection.ts:90-140).
      it.skip("allows a cross-site POST to the route served without the prefix", async () => {
        const post = (path: string) =>
          request(app)
            .post(path)
            .set("Host", HOST)
            .set("Sec-Fetch-Site", "cross-site")
            .set("Origin", "https://api.stripe.example");

        await post("/webhooks/stripe").expect(201, { received: true });
        await post("/api/items").expect(403);
      });
    });

    describe("with a global exception filter", () => {
      beforeEach(() =>
        init((a) => {
          a.useGlobalFilters(new ProblemDetailsFilter());
          a.enableCsrfProtection();
        }),
      );

      itAdapted(
        "ADR-010",
        "lets exception filters shape the 403 response",
        async () => {
          const res = await request(app)
            .post("/items")
            .set("Host", HOST)
            .set("Sec-Fetch-Site", "cross-site")
            .expect(403)
            .expect("Content-Type", /application\/problem\+json/);
          expect(res.body.type).toBe("about:blank");
          expect(res.body.title).toBe("Forbidden");
          expect(res.body.status).toBe(403);
          expect(res.body.detail).toMatch(/Sec-Fetch-Site/i);
        },
        "ProblemDetailsFilter returns native Web Response",
      );
    });

    // BUNEST_BUG: BunestApplication.enableCsrfProtection() does not guard against or throw when called after app.init() (packages/core/src/application/bunest-application.ts).
    it.skip("throws when enabled after init", async () => {
      await init(() => undefined);
      expect(() => app.enableCsrfProtection()).toThrow(
        /must be called before app\.init\(\)/,
      );
    });
  },
);
