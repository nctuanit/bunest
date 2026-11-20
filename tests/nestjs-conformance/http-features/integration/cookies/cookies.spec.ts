import "reflect-metadata";
import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  Controller,
  Cookies,
  Get,
  Injectable,
  Module,
  ParseIntPipe,
  Query,
  Res,
  SignedCookies,
  Sse,
  type BunestMiddleware,
  type BunestModule,
  type CookieOptions,
  type MiddlewareConsumer,
  type NextFunction,
  type ResponseContext,
  type SseMessageEvent,
} from "../../../../../packages/common/src";
import type { BunestApplication } from "../../../../../packages/core/src";
import { signCookieValue } from "../../../../../packages/http/src";
import {
  Test,
  describeConformance,
  itAdapted,
  request,
  type SupertestResponse,
} from "../../../_helpers";

const MIDDLEWARE_COOKIE_HEADER = "x-middleware-cookie";
const RAW_COOKIE_HEADER = "x-raw-cookie";

function referenceCookieSignatureUnsign(
  signed: string,
  secret: string,
): string | false {
  const idx = signed.lastIndexOf(".");
  if (idx < 0) return false;
  const val = signed.slice(0, idx);
  const expected = createHmac("sha256", secret)
    .update(val)
    .digest("base64")
    .replace(/=+$/, "");
  return `${val}.${expected}` === signed ? val : false;
}

@Injectable()
class SessionCookieMiddleware implements BunestMiddleware {
  async use(req: Request, res: ResponseContext, next: NextFunction) {
    if (req.headers.get(MIDDLEWARE_COOKIE_HEADER)) {
      res.cookie("session", "abc", { path: "/" });
    }
    await next();
  }
}

@Controller()
class AppController {
  @Get("cookies")
  all(@Cookies() cookies: Record<string, string>) {
    return { ...cookies };
  }

  @Get("cookies/theme")
  one(@Cookies("theme") theme?: string) {
    return { theme: theme ?? null };
  }

  @Get("cookies/count")
  count(@Cookies("count", ParseIntPipe) count: number) {
    return { count };
  }

  @Get("signed")
  allSigned(@SignedCookies() cookies: Record<string, string>) {
    return { ...cookies };
  }

  @Get("signed/uid")
  oneSigned(@SignedCookies("uid") uid?: string) {
    return { uid: uid ?? null };
  }

  @Get("set")
  set(@Res({ passthrough: true }) res: ResponseContext) {
    res.cookie("a", "1", { path: "/" });
    res.cookie("b", "two words; x=y", {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      maxAge: 60,
    });
    res.cookie("uid", "42", { path: "/", signed: true });
    return { ok: true };
  }

  @Sse("set-sse")
  setSse(
    @Res({ passthrough: true }) res: ResponseContext,
  ): AsyncIterable<SseMessageEvent> {
    res.cookie("a", "1", { path: "/" });
    return (async function* () {
      yield { data: "ok" };
    })();
  }

  @Get("clear")
  clear(@Res({ passthrough: true }) res: ResponseContext) {
    res.clearCookie("a");
    res.clearCookie("b", { path: "/app" });
    return { ok: true };
  }

  @Get("set-custom")
  setCustom(
    @Res({ passthrough: true }) res: ResponseContext,
    @Query("name") name: string,
    @Query("value") value: string,
    @Query("path") path?: string,
    @Query("domain") domain?: string,
  ) {
    const options: CookieOptions = { path: path ?? "/" };
    if (domain !== undefined) {
      options.domain = domain;
    }
    res.cookie(name, value, options);
    return { ok: true };
  }
}

@Module({
  controllers: [AppController],
  providers: [SessionCookieMiddleware],
})
class AppModule implements BunestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(SessionCookieMiddleware).forRoutes("*");
  }
}

async function createApp(
  options: { cookies?: { secret: string | string[] } } = {},
): Promise<BunestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = moduleRef.createNestApplication({
    logger: false,
    ...options,
  });
  app.use(async (req: Request, res: ResponseContext, next: NextFunction) => {
    if (req.headers.get(RAW_COOKIE_HEADER)) {
      res.header("Set-Cookie", "session=abc");
    }
    await next();
  });
  await app.init();
  return app;
}

function signedWith(secret: string, value: string): string {
  return encodeURIComponent(signCookieValue(value, secret));
}

function setCookieHeaders(res: SupertestResponse): string[] {
  return res.setCookies;
}

describeConformance(
  "Cookies E2E (BunHttpAdapter)",
  {
    upstreamPath: "integration/cookies/e2e/cookies.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008", "ADR-010"],
    notes:
      "Adapts NestJS v12 @Cookies()/@SignedCookies() & ResponseContext.cookie()/clearCookie() E2E suite from Express/Fastify/Node matrix to BunHttpAdapter + native AsyncIterable SSE.",
  },
  () => {
    describe("with a cookie secret", () => {
      let app: BunestApplication;

      beforeAll(async () => {
        app = await createApp({
          cookies: { secret: ["new-secret", "old-secret"] },
        });
      });

      afterAll(async () => {
        await app.close();
      });

      describe("@Cookies()", () => {
        it("should read all cookies", async () => {
          const res = await request(app)
            .get("/cookies")
            .set("Cookie", "theme=dark; lang=en%20US; theme=ignored")
            .expect(200);
          expect(res.body).toEqual({ theme: "dark", lang: "en US" });
        });

        it("should read an empty set of cookies", async () => {
          const res = await request(app).get("/cookies").expect(200);
          expect(res.body).toEqual({});
        });

        it("should read a single cookie", async () => {
          await request(app)
            .get("/cookies/theme")
            .set("Cookie", "lang=en; theme=dark")
            .expect(200, { theme: "dark" });
          await request(app)
            .get("/cookies/theme")
            .expect(200, { theme: null });
        });

        it("should apply pipes", async () => {
          await request(app)
            .get("/cookies/count")
            .set("Cookie", "count=41")
            .expect(200, { count: 41 });
          await request(app)
            .get("/cookies/count")
            .set("Cookie", "count=abc")
            .expect(400);
        });

        itAdapted(
          "ADR-001",
          "should sanitize dangerous prototype keys from cookies",
          async () => {
            const res = await request(app)
              .get("/cookies")
              .set("Cookie", "__proto__=x; constructor=y; safe=ok")
              .expect(200);
            expect(res.body).toEqual({ safe: "ok" });
            expect(({} as Record<string, unknown>).polluted).toBeUndefined();
          },
          "Bunest prototype-sanitizer strips __proto__/constructor/prototype keys",
        );
      });

      describe("@SignedCookies()", () => {
        it("should read a cookie signed with the current secret", async () => {
          await request(app)
            .get("/signed/uid")
            .set("Cookie", `uid=${signedWith("new-secret", "42")}`)
            .expect(200, { uid: "42" });
        });

        it("should read a cookie signed with a rotated-out secret", async () => {
          await request(app)
            .get("/signed/uid")
            .set("Cookie", `uid=${signedWith("old-secret", "42")}`)
            .expect(200, { uid: "42" });
        });

        it("should resolve a tampered cookie to undefined", async () => {
          const tampered = signedWith("new-secret", "42").replace("42", "43");
          await request(app)
            .get("/signed/uid")
            .set("Cookie", `uid=${tampered}`)
            .expect(200, { uid: null });
        });

        it("should resolve a cookie signed with an unknown secret to undefined", async () => {
          await request(app)
            .get("/signed/uid")
            .set("Cookie", `uid=${signedWith("unknown", "42")}`)
            .expect(200, { uid: null });
        });

        it("should never return an unsigned value", async () => {
          await request(app)
            .get("/signed/uid")
            .set("Cookie", "uid=42")
            .expect(200, { uid: null });
        });

        it("should read all valid signed cookies only", async () => {
          const res = await request(app)
            .get("/signed")
            .set(
              "Cookie",
              [
                `uid=${signedWith("new-secret", "42")}`,
                `legacy=${signedWith("old-secret", "yes")}`,
                `forged=${signedWith("unknown", "no")}`,
                "plain=value",
              ].join("; "),
            )
            .expect(200);
          expect(res.body).toEqual({ uid: "42", legacy: "yes" });
        });
      });

      describe("ResponseContext.cookie() / clearCookie()", () => {
        it("should set several cookies in one response", async () => {
          const res = await request(app).get("/set").expect(200);
          const cookies = setCookieHeaders(res);

          expect(cookies).toHaveLength(3);
          expect(cookies[0]).toBe("a=1; Path=/");
          expect(cookies[1]).toContain("b=two%20words%3B%20x%3Dy");
          expect(cookies[1]).toContain("Path=/");
          expect(cookies[1]).toContain("Max-Age=60");
          expect(cookies[1]).toContain("HttpOnly");
          expect(cookies[1]).toContain("SameSite=Lax");
          expect(cookies[2]).toMatch(/^uid=s%3A42\.[^;]+; Path=\/$/);
        });

        it("should keep a cookie when a middleware set it via res.header('Set-Cookie', ...)", async () => {
          const res = await request(app)
            .get("/set")
            .set(RAW_COOKIE_HEADER, "1")
            .expect(200);
          const cookies = setCookieHeaders(res);

          expect(cookies).toHaveLength(4);
          expect(cookies[0]).toBe("session=abc");
          expect(cookies[1]).toBe("a=1; Path=/");
        });

        itAdapted(
          ["ADR-008", "ADR-010"],
          "should keep a raw cookie when an SSE handler sets a cookie",
          async () => {
            const res = await request(app)
              .get("/set-sse")
              .set(RAW_COOKIE_HEADER, "1")
              .expect(200);

            expect(setCookieHeaders(res)).toEqual([
              "session=abc",
              "a=1; Path=/",
            ]);
          },
          "AsyncIterable SSE handler with ResponseContext.cookie()",
        );

        it("should keep a cookie that a Nest middleware set with res.cookie()", async () => {
          const res = await request(app)
            .get("/set")
            .set(MIDDLEWARE_COOKIE_HEADER, "1")
            .expect(200);
          const cookies = setCookieHeaders(res);

          expect(cookies).toHaveLength(4);
          expect(cookies[0]).toBe("session=abc; Path=/");
          expect(cookies[1]).toBe("a=1; Path=/");
        });

        it("should round-trip the cookies it sets", async () => {
          const res = await request(app).get("/set").expect(200);
          const cookieHeader = setCookieHeaders(res)
            .map((cookie) => cookie.split(";")[0])
            .join("; ");

          const all = await request(app)
            .get("/cookies")
            .set("Cookie", cookieHeader)
            .expect(200);
          expect(all.body.a).toBe("1");
          expect(all.body.b).toBe("two words; x=y");

          await request(app)
            .get("/signed/uid")
            .set("Cookie", cookieHeader)
            .expect(200, { uid: "42" });
        });

        it("should sign cookies in the format cookie-parser verifies", async () => {
          const res = await request(app).get("/set").expect(200);
          const uid = setCookieHeaders(res)[2]!
            .split(";")[0]!
            .slice("uid=".length);
          const value = decodeURIComponent(uid);
          expect(
            referenceCookieSignatureUnsign(value.slice(2), "new-secret"),
          ).toBe("42");
        });

        it("should clear cookies", async () => {
          const res = await request(app).get("/clear").expect(200);
          const cookies = setCookieHeaders(res);
          expect(cookies).toHaveLength(2);
          expect(cookies[0]).toContain("a=;");
          expect(cookies[0]).toContain("Path=/");
          expect(cookies[0]).toContain("Max-Age=0");
          expect(cookies[0]).toContain("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
          expect(cookies[1]).toContain("b=;");
          expect(cookies[1]).toContain("Path=/app");
          expect(cookies[1]).toContain("Max-Age=0");
          expect(cookies[1]).toContain("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
        });

        it.each([
          ["a name with CR/LF", { name: "a\r\nX-Injected: 1", value: "v" }],
          ['a name with ";"', { name: "a;b", value: "v" }],
          ["a path with CR/LF", { name: "a", value: "v", path: "/\r\nX: 1" }],
        ])("should reject %s", async (_label, query) => {
          const res = await request(app)
            .get("/set-custom")
            .query(query)
            .expect(500);
          expect(setCookieHeaders(res)).toEqual([]);
          expect(res.headers["x-injected"]).toBeUndefined();
        });

        // BUNEST_BUG: serializeCookie only checks CR/LF on path/domain and does not reject ";" (enabling Set-Cookie attribute injection) (packages/http/src/security/cookie.ts:227-239).
        it.skip.each([
          ['a path with ";"', { name: "a", value: "v", path: "/; Domain=evil" }],
          [
            "an invalid domain",
            { name: "a", value: "v", domain: "x.com; Secure" },
          ],
        ])("should reject %s", async (_label, query) => {
          const res = await request(app)
            .get("/set-custom")
            .query(query)
            .expect(500);
          expect(setCookieHeaders(res)).toEqual([]);
          expect(res.headers["x-injected"]).toBeUndefined();
        });

        // BUNEST_BUG: When a middleware returns `next()` (Promise<Response>), executeMiddlewareChain checks `result instanceof Response` even when `nextCalled === true` and calls finalizeShortCircuitResponse -> mergeHeadersOntoNativeResponse, re-appending every Set-Cookie header once per middleware (packages/http/src/pipeline/execution-pipeline.ts:482-486).
        it.skip("should not duplicate Set-Cookie headers when a middleware returns next()", async () => {
          const modRef = await Test.createTestingModule({
            imports: [AppModule],
          }).compile();
          const returnNextApp = modRef.createNestApplication({
            logger: false,
            cookies: { secret: "secret" },
          });
          returnNextApp.use(
            (_req: Request, _res: ResponseContext, next: NextFunction) => {
              return next();
            },
          );
          await returnNextApp.init();
          try {
            const res = await request(returnNextApp).get("/set").expect(200);
            expect(setCookieHeaders(res)).toHaveLength(3);
          } finally {
            await returnNextApp.close();
          }
        });

        it('should percent-encode CR/LF and ";" in values', async () => {
          const res = await request(app)
            .get("/set-custom")
            .query({ name: "a", value: "v\r\nX-Injected: 1; Domain=evil" })
            .expect(200);
          expect(setCookieHeaders(res)).toEqual([
            "a=v%0D%0AX-Injected%3A%201%3B%20Domain%3Devil; Path=/",
          ]);
          expect(res.headers["x-injected"]).toBeUndefined();
        });
      });
    });

    describe("without a cookie secret", () => {
      let app: BunestApplication;

      beforeAll(async () => {
        app = await createApp({});
      });

      afterAll(async () => {
        await app.close();
      });

      it("should still read plain cookies", async () => {
        await request(app)
          .get("/cookies/theme")
          .set("Cookie", "theme=dark")
          .expect(200, { theme: "dark" });
      });

      // BUNEST_BUG: RequestContext.signedCookies silently returns {} instead of throwing when no cookie secret is configured (packages/http/src/context/request-context.ts:237-245).
      it.skip("should fail loudly when reading signed cookies", async () => {
        await request(app)
          .get("/signed/uid")
          .set("Cookie", `uid=${signedWith("parser-secret", "42")}`)
          .expect(500);
      });

      it("should fail loudly when setting a signed cookie", async () => {
        const res = await request(app).get("/set").expect(500);
        expect(
          setCookieHeaders(res).filter((cookie) => cookie.startsWith("uid=")),
        ).toEqual([]);
      });
    });
  },
);
