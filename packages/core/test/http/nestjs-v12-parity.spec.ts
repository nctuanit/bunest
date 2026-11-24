import { afterEach, describe, expect, it } from "bun:test";
import {
  BadRequestException,
  Body,
  Controller,
  ensureDir,
  ForbiddenException,
  Get,
  HttpStatus,
  join,
  Post,
  Query,
  removePath,
  RequestMethod,
  Sse,
  StandardSchemaValidationPipe,
  VersioningType,
  type ArgumentMetadata,
  type PipeTransform,
  type StandardSchemaV1,
} from "../../src/common/index";
import {
  AbstractHttpAdapter,
  AbstractLoader,
  BunHttpAdapter,
  BunStaticLoader,
  CookieSigner,
  DEFAULT_EXPRESS_RENDER_PATH,
  DEFAULT_FASTIFY_RENDER_PATH,
  DEFAULT_RENDER_PATH,
  DEFAULT_ROOT_PATH,
  HttpResponseContext,
  NoopLoader,
  SERVE_STATIC_MODULE_OPTIONS,
  SIGNED_COOKIE_PREFIX,
  ServeStaticModule,
  formatSseEvent,
  parseMaxAgeSeconds,
  serveStaticProviders,
} from "../../src/http";

function makeStandardSchema<T>(
  validator: (
    value: unknown,
    options?: Record<string, unknown>,
  ) =>
    | { ok: true; value: T }
    | {
        ok: false;
        issues: Array<{ message: string; path?: (string | number)[] }>;
      },
): StandardSchemaV1<unknown, T> {
  return {
    "~standard": {
      version: 1,
      vendor: "test-schema",
      validate(value: unknown, options?: unknown) {
        const res = validator(
          value,
          options as Record<string, unknown> | undefined,
        );
        return res.ok ? { value: res.value } : { issues: res.issues };
      },
    },
  };
}

describe("@bunest/http NestJS v12 Parity Suite", () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    while (tmpDirs.length > 0) {
      const dir = tmpDirs.pop()!;
      await removePath(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  describe("AbstractHttpAdapter & BunHttpAdapter full HttpServer contract", () => {
    it("BunHttpAdapter extends AbstractHttpAdapter with Bun-native getType() and instance accessors", async () => {
      const adapter = new BunHttpAdapter({ logger: false });
      expect(adapter).toBeInstanceOf(AbstractHttpAdapter);
      expect(adapter.getType()).toBe("bun");
      expect(adapter.getInstance()).toBe(adapter);

      const customInst = { custom: true };
      adapter.setInstance(customInst);
      expect(adapter.getInstance()).toBe(customInst);
      adapter.setInstance(adapter);

      await adapter.init();
      adapter.initHttpServer({ ignoreTrailingSlash: true, rawBody: true });
      expect(adapter.getRawBodyEnabled()).toBe(true);
      expect(adapter.getRouteMatchingOptions()).toEqual({
        caseSensitive: true,
        ignoreTrailingSlash: true,
        removesTrailingSlash: true,
      });
      expect(adapter.isRouteOrderSensitive()).toBe(true);
      adapter.setRouteResolutionStrategy("specificity");
      expect(adapter.isRouteOrderSensitive()).toBe(false);
      expect(adapter.normalizePath("/api/{*any}")).toBe("/api/*");
    });

    it("supports all 17 imperative verb route methods (including WebDAV & QUERY) with params, next(), and reply()", async () => {
      const adapter = new BunHttpAdapter({ logger: false });

      adapter.get("/raw/items/:id", (req, res) => {
        adapter.setHeader(res, "x-raw", "yes");
        expect(adapter.getHeader(res, "x-raw")).toBe("yes");
        expect(adapter.isHeadersSent(res)).toBe(false);
        adapter.reply(res, { id: (req as any).params.id, verb: "GET" }, 200);
        expect(adapter.isHeadersSent(res)).toBe(true);
      });

      adapter.post("/raw/items", async (req, res) => {
        const body = await req.json();
        adapter.reply(res, { created: body }, 201);
      });

      adapter.put("/raw/verb", (_req, res) => adapter.end(res, "PUT-OK"));
      adapter.patch("/raw/verb", (_req, res) =>
        adapter.reply(res, { verb: "PATCH" }),
      );
      adapter.delete("/raw/verb", (_req, res) => adapter.reply(res, null, 204));
      adapter.options("/raw/verb", (_req, res) => adapter.end(res, "OPT"));
      adapter.head("/raw/head-only", (_req, res) => {
        adapter.setHeader(res, "x-head", "1");
        adapter.end(res);
      });
      adapter.search("/raw/dav", (_req, res) =>
        adapter.reply(res, { dav: "SEARCH" }),
      );
      adapter.propfind("/raw/dav", (_req, res) =>
        adapter.reply(res, { dav: "PROPFIND" }),
      );
      adapter.proppatch("/raw/dav", (_req, res) =>
        adapter.reply(res, { dav: "PROPPATCH" }),
      );
      adapter.mkcol("/raw/dav", (_req, res) =>
        adapter.reply(res, { dav: "MKCOL" }),
      );
      adapter.copy("/raw/dav", (_req, res) =>
        adapter.reply(res, { dav: "COPY" }),
      );
      adapter.move("/raw/dav", (_req, res) =>
        adapter.reply(res, { dav: "MOVE" }),
      );
      adapter.lock("/raw/dav", (_req, res) =>
        adapter.reply(res, { dav: "LOCK" }),
      );
      adapter.unlock("/raw/dav", (_req, res) =>
        adapter.reply(res, { dav: "UNLOCK" }),
      );
      adapter.query("/raw/dav", (_req, res) =>
        adapter.reply(res, { dav: "QUERY" }),
      );

      // Chaining via next() preserves headers, cookies, and status across hops
      adapter.get("/raw/chain", (_req, res, next) => {
        adapter.setHeader(res, "x-step", "1");
        adapter.setCookie(res, "hop", "first", { httpOnly: true });
        next?.();
      });
      adapter.get("/raw/chain", (_req, res) => {
        adapter.setHeader(res, "x-step-2", "2");
        adapter.reply(res, { chained: true });
      });

      adapter.all("/raw/any/*", (req, res) => {
        adapter.reply(res, {
          method: req.method,
          splat: (req as any).params["*"],
        });
      });

      const getRes = await adapter.fetch(
        new Request("http://localhost/raw/items/42"),
      );
      expect(getRes.status).toBe(200);
      expect(getRes.headers.get("x-raw")).toBe("yes");
      expect(await getRes.json()).toEqual({ id: "42", verb: "GET" });

      const postRes = await adapter.fetch(
        new Request("http://localhost/raw/items", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "bun" }),
        }),
      );
      expect(postRes.status).toBe(201);
      expect(await postRes.json()).toEqual({ created: { name: "bun" } });

      expect(
        await (
          await adapter.fetch(
            new Request("http://localhost/raw/verb", { method: "PUT" }),
          )
        ).text(),
      ).toBe("PUT-OK");
      expect(
        (
          await adapter.fetch(
            new Request("http://localhost/raw/verb", { method: "DELETE" }),
          )
        ).status,
      ).toBe(204);

      for (const davVerb of [
        "SEARCH",
        "PROPFIND",
        "PROPPATCH",
        "MKCOL",
        "COPY",
        "MOVE",
        "LOCK",
        "UNLOCK",
        "QUERY",
      ]) {
        const res = await adapter.fetch(
          new Request("http://localhost/raw/dav", { method: davVerb }),
        );
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ dav: davVerb });
      }

      const chainRes = await adapter.fetch(
        new Request("http://localhost/raw/chain"),
      );
      expect(chainRes.status).toBe(200);
      expect(chainRes.headers.get("x-step")).toBe("1");
      expect(chainRes.headers.get("x-step-2")).toBe("2");
      expect(chainRes.headers.getSetCookie()).toEqual([
        "hop=first; Path=/; HttpOnly",
      ]);
      expect(await chainRes.json()).toEqual({ chained: true });

      const allRes = await adapter.fetch(
        new Request("http://localhost/raw/any/a/b/c", { method: "PATCH" }),
      );
      expect(await allRes.json()).toEqual({ method: "PATCH", splat: "a/b/c" });
    });

    it("supports redirect(), render(), CookieSigner + setCookie/clearCookie, and mapException()", async () => {
      const adapter = new BunHttpAdapter({ logger: false });
      const signer = new CookieSigner(["secret-new", "secret-old"]);
      adapter.setCookieSigner(signer);

      const signed = signer.sign("user-123");
      expect(signed.startsWith(SIGNED_COOKIE_PREFIX)).toBe(true);
      expect(signer.unsign(signed)).toBe("user-123");
      expect(signer.unsign(signed.slice(2))).toBe("user-123"); // without s: prefix
      expect(signer.unsign("s:user-123.tampered")).toBeUndefined();

      adapter.setViewEngine(
        (view, data) => `<h1>${view}:${String(data.name)}</h1>`,
      );

      const resCtx = new HttpResponseContext();
      adapter.setCookie(resCtx, "sid", "user-123", {
        signed: true,
        httpOnly: true,
        sameSite: "lax",
      });
      adapter.clearCookie(resCtx, "legacy");
      expect(() =>
        adapter.setCookie(resCtx, "bad", "x", { sameSite: "none" }),
      ).toThrow(TypeError);
      expect(() =>
        adapter.setCookie(resCtx, "bad2", "x", { partitioned: true }),
      ).toThrow(TypeError);

      const built = adapter.reply(resCtx, { ok: true });
      const cookies = built.headers.getSetCookie();
      expect(cookies.length).toBe(2);
      expect(cookies[0]).toContain("sid=");
      expect(cookies[0]).toContain("HttpOnly");
      expect(cookies[1]).toContain("legacy=;");
      expect(cookies[1]).toContain("Max-Age=0");

      const redirCtx = new HttpResponseContext();
      const redirRes = adapter.redirect(redirCtx, 302, "https://bunest.dev");
      expect(redirRes.status).toBe(302);
      expect(redirRes.headers.get("location")).toBe("https://bunest.dev");
      expect(adapter.isHeadersSent(redirCtx)).toBe(true);

      const renderCtx = new HttpResponseContext();
      const renderRes = await adapter.render(renderCtx, "home", {
        name: "Ada",
      });
      expect(renderRes.status).toBe(200);
      expect(renderRes.headers.get("content-type")).toContain("text/html");
      expect(await renderRes.text()).toBe("<h1>home:Ada</h1>");

      const mapped = adapter.mapException(
        new SyntaxError("Unexpected JSON token"),
      );
      expect(mapped).toBeInstanceOf(BadRequestException);
    });

    it("supports hooks (onRequest, onResponse, onRouteTriggered, securityHook, errorHandler, notFoundHandler, middlewareFactory, versionFilter, bodyParser, beforeClose)", async () => {
      const events: string[] = [];

      @Controller("hooked")
      class HookedController {
        @Get("ok")
        ok() {
          events.push("handler");
          return { ok: true };
        }

        @Post("echo")
        echo(@Body() body: unknown) {
          return body;
        }

        @Get("fail")
        fail(): never {
          throw new Error("boom-custom-err");
        }
      }

      const adapter = new BunHttpAdapter({
        logger: false,
        return503OnClosing: true,
      });

      adapter.setOnRequestHook(
        (_req: Request, _res: unknown, done: () => void) => {
          events.push("onRequest");
          done();
        },
      );
      adapter.setOnRouteTriggered((method, path) => {
        events.push(`route:${method}:${path}`);
      });
      expect(adapter.getOnRouteTriggered()).toBeDefined();
      adapter.setOnResponseHook(() => {
        events.push("onResponse");
      });
      adapter.registerSecurityHook((req, res) => {
        res.setHeader("x-sec-hook", "active");
        if (req.headers.get("x-block") === "1") {
          return new ForbiddenException("Blocked by security hook");
        }
        return undefined;
      });
      adapter.setErrorHandler(
        (err: Error, _req: Request, res: HttpResponseContext) => {
          adapter.reply(
            res,
            { handledBy: "customErrorHandler", msg: err.message },
            502,
          );
        },
      );
      adapter.setNotFoundHandler((_req: Request, res: HttpResponseContext) => {
        adapter.reply(res, { customNotFound: true }, 404);
      }, "/api");

      const mwFactory = adapter.createMiddlewareFactory(RequestMethod.GET);
      mwFactory(
        "/hooked/ok",
        (_req: Request, res: HttpResponseContext, next: () => unknown) => {
          res.header("x-mw-factory", "ran");
          return next();
        },
      );

      adapter.useBodyParser("json", { limit: "32b" });
      adapter.registerParserMiddleware(undefined, true);
      expect(adapter.getRawBodyEnabled()).toBe(true);

      await adapter.compileControllers([HookedController]);

      const okRes = await adapter.fetch(
        new Request("http://localhost/hooked/ok"),
      );
      expect(okRes.status).toBe(200);
      expect(okRes.headers.get("x-sec-hook")).toBe("active");
      expect(okRes.headers.get("x-mw-factory")).toBe("ran");
      expect(events).toEqual([
        "onRequest",
        `route:${RequestMethod.GET}:/hooked/ok`,
        "handler",
        "onResponse",
      ]);

      const blockedRes = await adapter.fetch(
        new Request("http://localhost/hooked/ok", {
          headers: { "x-block": "1" },
        }),
      );
      expect(blockedRes.status).toBe(502);
      expect(await blockedRes.json()).toEqual({
        handledBy: "customErrorHandler",
        msg: "Blocked by security hook",
      });

      // Body parser limit enforced (32 bytes)
      const largeRes = await adapter.fetch(
        new Request("http://localhost/hooked/echo", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ data: "x".repeat(200) }),
        }),
      );
      expect(largeRes.status).toBe(502); // caught by customErrorHandler (PayloadTooLargeException)

      // Custom notFoundHandler on `/api` prefix only
      const nfApi = await adapter.fetch(
        new Request("http://localhost/api/missing"),
      );
      expect(nfApi.status).toBe(404);
      expect(await nfApi.json()).toEqual({ customNotFound: true });

      const nfOther = await adapter.fetch(
        new Request("http://localhost/other/missing"),
      );
      expect(nfOther.status).toBe(404);
      const nfOtherBody = (await nfOther.json()) as { statusCode: number };
      expect(nfOtherBody.statusCode).toBe(404);

      // applyVersionFilter
      let versionHit = false;
      let versionMissed = false;
      const filtered = adapter.applyVersionFilter(
        () => {
          versionHit = true;
        },
        "2",
        { type: VersioningType.HEADER, header: "X-API-Version" },
      );
      filtered(
        new Request("http://localhost/v", {
          headers: { "X-API-Version": "1" },
        }),
        new HttpResponseContext(),
        () => {
          versionMissed = true;
        },
      );
      expect(versionHit).toBe(false);
      expect(versionMissed).toBe(true);
      filtered(
        new Request("http://localhost/v", {
          headers: { "X-API-Version": "2" },
        }),
        new HttpResponseContext(),
        () => {},
      );
      expect(versionHit).toBe(true);

      // beforeClose triggers 503 draining state
      adapter.beforeClose();
      const closingRes = await adapter.fetch(
        new Request("http://localhost/hooked/ok"),
      );
      expect(closingRes.status).toBe(503);
    });
  });

  describe("ArgumentMetadata.schema & MessageEvent.comment wiring", () => {
    it("wires ArgumentMetadata.schema into global StandardSchemaValidationPipe and custom pipes", async () => {
      const userSchema = makeStandardSchema<{ email: string }>(
        (input, opts) => {
          if (typeof input !== "object" || input === null) {
            return { ok: false, issues: [{ message: "Expected object" }] };
          }
          const email = (input as Record<string, unknown>).email;
          if (typeof email !== "string" || !email.includes("@")) {
            return {
              ok: false,
              issues: [{ message: "Invalid email", path: ["email"] }],
            };
          }
          const suffix = opts?.tag ? `:${String(opts.tag)}` : "";
          return {
            ok: true,
            value: { email: `${email.trim().toLowerCase()}${suffix}` },
          };
        },
      );

      let observedSchema: unknown;
      class InspectSchemaPipe implements PipeTransform {
        transform(value: unknown, metadata: ArgumentMetadata) {
          observedSchema = metadata.schema;
          return value;
        }
      }

      @Controller("schema-e2e")
      class SchemaE2eController {
        @Post("signup")
        signup(@Body(userSchema) dto: { email: string }) {
          return dto;
        }

        @Get("check")
        check(@Query(userSchema, InspectSchemaPipe) val: unknown) {
          return { val };
        }
      }

      const adapter = new BunHttpAdapter({ logger: false });
      adapter.useGlobalPipes(
        new StandardSchemaValidationPipe({
          errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY,
          validateOptions: { tag: "v12" },
        }),
      );
      await adapter.compileControllers([SchemaE2eController]);

      // Valid body transformed via StandardSchemaValidationPipe with validateOptions
      const okRes = await adapter.fetch(
        new Request("http://localhost/schema-e2e/signup", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: "  ADA@EXAMPLE.COM  " }),
        }),
      );
      expect(okRes.status).toBe(201);
      expect(await okRes.json()).toEqual({ email: "ada@example.com:v12" });

      // Invalid body rejected with StandardSchemaValidationPipe's custom 422 status (not inline 400!)
      const badRes = await adapter.fetch(
        new Request("http://localhost/schema-e2e/signup", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: "not-an-email" }),
        }),
      );
      expect(badRes.status).toBe(422);

      // Custom pipe observes metadata.schema
      const checkRes = await adapter.fetch(
        new Request("http://localhost/schema-e2e/check?email=bob@test.io"),
      );
      expect(checkRes.status).toBe(200);
      expect(observedSchema).toBe(userSchema);
    });

    it("formats MessageEvent.comment in formatSseEvent() and @Sse() endpoints", async () => {
      expect(
        formatSseEvent({ comment: "keep-alive", data: "ping", id: "1" }),
      ).toBe(": keep-alive\nid: 1\ndata: ping\n\n");

      expect(
        formatSseEvent({ comment: "line1\nline2", data: undefined as any }),
      ).toBe(": line1\n: line2\n\n");

      @Controller("sse-comment")
      class SseCommentController {
        @Sse("stream")
        async *stream() {
          yield { comment: "heartbeat", data: "ok" };
        }
      }

      const adapter = new BunHttpAdapter({ logger: false });
      await adapter.compileControllers([SseCommentController]);
      const res = await adapter.fetch(
        new Request("http://localhost/sse-comment/stream"),
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(": heartbeat\ndata: ok\n\n");
    });
  });

  describe("ServeStaticModule & enhanced static assets (Bun-native, ADR-001)", () => {
    it("exports ServeStaticModule constants, loaders, and dynamic module builders", () => {
      expect(SERVE_STATIC_MODULE_OPTIONS).toBe("SERVE_STATIC_MODULE_OPTIONS");
      expect(DEFAULT_ROOT_PATH).toBe("client");
      expect(DEFAULT_RENDER_PATH).toBe("*");
      expect(DEFAULT_FASTIFY_RENDER_PATH).toBe("*");
      expect(DEFAULT_EXPRESS_RENDER_PATH).toBe("{*any}");
      expect(Array.isArray(serveStaticProviders)).toBe(true);

      const noop = new NoopLoader();
      expect(noop).toBeInstanceOf(AbstractLoader);
      expect(noop.getIndexFilePath("/app/client")).toContain("index.html");

      const bunLoader = new BunStaticLoader();
      expect(bunLoader).toBeInstanceOf(AbstractLoader);

      const dynSync = ServeStaticModule.forRoot({ rootPath: "/tmp/public" });
      expect(dynSync.module).toBe(ServeStaticModule);

      const dynAsync = ServeStaticModule.forRootAsync({
        isGlobal: true,
        useFactory: () => [{ rootPath: "/tmp/public" }],
      });
      expect(dynAsync.module).toBe(ServeStaticModule);
      expect(dynAsync.global).toBe(true);

      expect(parseMaxAgeSeconds("7d")).toBe(7 * 86_400);
      expect(parseMaxAgeSeconds("2h")).toBe(7200);
      expect(parseMaxAgeSeconds("30m")).toBe(1800);
      expect(parseMaxAgeSeconds("5000ms")).toBe(5);
    });

    it("supports exclude, renderPath, transformIndexHtml, extensions, setHeaders, preCompressed, index[], acceptRanges, lastModified, maxAge strings", async () => {
      const dir = join(
        Bun.env.TMPDIR ?? Bun.env.TEMP ?? "/tmp",
        `bunest-serve-static-${crypto.randomUUID()}`,
      );
      await ensureDir(dir);
      tmpDirs.push(dir);
      await Bun.write(
        join(dir, "home.html"),
        "<html><body>__NONCE__</body></html>",
      );
      await Bun.write(join(dir, "about.html"), "<h1>About Page</h1>");
      const rawJs = "console.log('hello bunest static compression');";
      await Bun.write(join(dir, "bundle.js"), rawJs);
      await Bun.write(
        join(dir, "bundle.js.gz"),
        Bun.gzipSync(new TextEncoder().encode(rawJs)),
      );

      const adapter = new BunHttpAdapter({ logger: false });
      const loader = new BunStaticLoader();
      loader.register(adapter, { getGlobalPrefix: () => "" }, [
        {
          rootPath: dir,
          exclude: ["/api/*"],
          renderPath: /^\/app(\/|$)/,
          transformIndexHtml: async (html) =>
            html.replace("__NONCE__", "nonce-42"),
          serveStaticOptions: {
            index: ["home.html", "index.html"],
            extensions: ["html"],
            preCompressed: true,
            acceptRanges: false,
            lastModified: false,
            maxAge: "1d",
            immutable: true,
            setHeaders: (res, _path) => {
              res.setHeader("X-Static-Custom", "bun-native");
            },
          },
        },
      ]);

      // 1. Directory index array + transformIndexHtml + setHeaders + maxAge string + disabled ranges/lastModified
      const rootRes = await adapter.fetch(new Request("http://localhost/"));
      expect(rootRes.status).toBe(200);
      expect(await rootRes.text()).toBe("<html><body>nonce-42</body></html>");
      expect(rootRes.headers.get("x-static-custom")).toBe("bun-native");
      expect(rootRes.headers.get("cache-control")).toBe(
        "public, max-age=86400, immutable",
      );
      expect(rootRes.headers.get("accept-ranges")).toBeNull();
      expect(rootRes.headers.get("last-modified")).toBeNull();

      // 2. Extensionless file resolution (`extensions: ["html"]`)
      const aboutRes = await adapter.fetch(
        new Request("http://localhost/about"),
      );
      expect(aboutRes.status).toBe(200);
      expect(await aboutRes.text()).toBe("<h1>About Page</h1>");

      // 3. SPA fallback matching renderPath
      const spaRes = await adapter.fetch(
        new Request("http://localhost/app/dashboard"),
      );
      expect(spaRes.status).toBe(200);
      expect(await spaRes.text()).toBe("<html><body>nonce-42</body></html>");

      // 4. Excluded path falls through to 404 (not SPA shell)
      const excludedRes = await adapter.fetch(
        new Request("http://localhost/api/users"),
      );
      expect(excludedRes.status).toBe(404);

      // 5. Non-matching renderPath does not trigger SPA fallback
      const nonRenderRes = await adapter.fetch(
        new Request("http://localhost/unknown-route"),
      );
      expect(nonRenderRes.status).toBe(404);

      // 6. Pre-compressed `.gz` sibling served when Accept-Encoding includes gzip
      const gzRes = await adapter.fetch(
        new Request("http://localhost/bundle.js", {
          headers: { "Accept-Encoding": "gzip" },
        }),
      );
      expect(gzRes.status).toBe(200);
      expect(gzRes.headers.get("content-encoding")).toBe("gzip");
      expect(gzRes.headers.get("vary")).toContain("Accept-Encoding");
      expect(gzRes.headers.get("content-type")).toContain("javascript");

      // 7. Uncompressed fallback still emits Vary: Accept-Encoding when preCompressed is true
      const rawRes = await adapter.fetch(
        new Request("http://localhost/bundle.js", {
          headers: { "Accept-Encoding": "identity" },
        }),
      );
      expect(rawRes.status).toBe(200);
      expect(rawRes.headers.get("content-encoding")).toBeNull();
      expect(rawRes.headers.get("vary")).toContain("Accept-Encoding");
    });

    it("blocks percent-encoded (and win32 case-variant) exclude bypasses in static assets", async () => {
      const dir = join(
        Bun.env.TMPDIR ?? Bun.env.TEMP ?? "/tmp",
        `bunest-serve-static-sec-${crypto.randomUUID()}`,
      );
      await ensureDir(join(dir, "admin"));
      tmpDirs.push(dir);
      await Bun.write(join(dir, "admin", "secret.txt"), "top-secret");
      await Bun.write(join(dir, "public.txt"), "hello-public");

      const adapter = new BunHttpAdapter({ logger: false });
      const loader = new BunStaticLoader();
      loader.register(adapter, { getGlobalPrefix: () => "" }, [
        { rootPath: dir, exclude: ["/admin/*"], renderPath: "" },
      ]);

      expect(
        (await adapter.fetch(new Request("http://localhost/public.txt")))
          .status,
      ).toBe(200);
      expect(
        (await adapter.fetch(new Request("http://localhost/admin/secret.txt")))
          .status,
      ).toBe(404);
      // Percent-encoded 'a' (%61) must NOT bypass exclude
      expect(
        (
          await adapter.fetch(
            new Request("http://localhost/%61dmin/secret.txt"),
          )
        ).status,
      ).toBe(404);
      if (process.platform === "win32") {
        expect(
          (
            await adapter.fetch(
              new Request("http://localhost/ADMIN/secret.txt"),
            )
          ).status,
        ).toBe(404);
      }
    });
  });

  describe("Verifier #55 security & correctness regressions", () => {
    it("prevents bare CR SSE frame injection in comment and data", () => {
      expect(
        formatSseEvent({
          comment: "ok\rdata: forged",
          data: "legit\revent: evil",
        }),
      ).toBe(": ok\n: data: forged\ndata: legit\ndata: event: evil\n\n");
    });

    it("awaits async 3-arg onRequestHook once across raw next() hops, propagates done(err), guards __proto__ params, and falls through 405 with ignoreTrailingSlash", async () => {
      const trace: string[] = [];

      @Controller("clash")
      class ClashController {
        @Get()
        onlyGet() {
          return { from: "controller" };
        }
      }

      const adapter = new BunHttpAdapter({
        logger: false,
        ignoreTrailingSlash: true,
      });

      adapter.setOnRequestHook(
        (
          req: Request,
          res: HttpResponseContext,
          done: (err?: unknown) => void,
        ) => {
          trace.push("onRequest:start");
          setTimeout(() => {
            if (req.headers.get("x-reject") === "1") {
              done(new ForbiddenException("async-hook-rejected"));
              return;
            }
            res.header("x-async-hook", "awaited");
            trace.push("onRequest:done");
            done();
          }, 10);
        },
      );

      adapter.get("/async-chain", (_req, res, next) => {
        trace.push("hop1");
        res.header("x-hop1", "kept");
        next?.();
      });
      adapter.get("/async-chain", (_req, res) => {
        trace.push("hop2");
        adapter.reply(res, { ok: true });
      });

      adapter.get("/proto/:__proto__/item/:id", (req, res) => {
        const params = (req as any).params as Record<string, string>;
        adapter.reply(res, {
          hasOwnProto: Object.prototype.hasOwnProperty.call(
            params,
            "__proto__",
          ),
          id: params.id,
        });
      });

      adapter.post("/clash", (_req, res) => {
        adapter.reply(res, { from: "raw-post" }, 201);
      });

      await adapter.compileControllers([ClashController]);

      // 1. Async 3-arg onRequestHook awaited before hop1 and runs only once across next() hops
      const chainRes = await adapter.fetch(
        new Request("http://localhost/async-chain"),
      );
      expect(chainRes.status).toBe(200);
      expect(chainRes.headers.get("x-async-hook")).toBe("awaited");
      expect(chainRes.headers.get("x-hop1")).toBe("kept");
      expect(trace).toEqual([
        "onRequest:start",
        "onRequest:done",
        "hop1",
        "hop2",
      ]);

      // 2. Async done(err) rejects cleanly
      const rejRes = await adapter.fetch(
        new Request("http://localhost/async-chain", {
          headers: { "x-reject": "1" },
        }),
      );
      expect(rejRes.status).toBe(403);

      // 3. Dangerous param name `:__proto__` is skipped (prototype-pollution guard)
      const protoRes = await adapter.fetch(
        new Request("http://localhost/proto/polluted/item/99"),
      );
      expect(protoRes.status).toBe(200);
      expect(await protoRes.json()).toEqual({ hasOwnProto: false, id: "99" });

      // 4. ignoreTrailingSlash: POST /clash/ hits native GET /clash -> 405 -> falls through to raw POST /clash
      const clashRes = await adapter.fetch(
        new Request("http://localhost/clash/", { method: "POST" }),
      );
      expect(clashRes.status).toBe(201);
      expect(await clashRes.json()).toEqual({ from: "raw-post" });
    });

    it("enforces segment-boundary prefixes in setNotFoundHandler/setErrorHandler and applies mapException on fast singleton routes", async () => {
      @Controller()
      class PrefixAndFastErrController {
        @Get("api/boom")
        apiBoom(): never {
          throw new Error("api-boom");
        }

        @Get("api-v2/boom")
        apiV2Boom(): never {
          throw new Error("v2-boom");
        }

        @Get("fast-syntax")
        fastSyntax(): never {
          throw new SyntaxError("bad-json-syntax");
        }
      }

      // 1. Fast singleton route (no hooks) still maps SyntaxError -> 400 BadRequestException
      const fastAdapter = new BunHttpAdapter({ logger: false });
      await fastAdapter.compileControllers([PrefixAndFastErrController]);
      const syntaxRes = await fastAdapter.fetch(
        new Request("http://localhost/fast-syntax"),
      );
      expect(syntaxRes.status).toBe(400);

      // 2. Segment-boundary prefix matching on setNotFoundHandler and setErrorHandler
      const prefixAdapter = new BunHttpAdapter({ logger: false });
      prefixAdapter.setNotFoundHandler(
        (_req: Request, res: HttpResponseContext) => {
          prefixAdapter.reply(res, { customNotFound: true }, 404);
        },
        "/api",
      );
      prefixAdapter.setErrorHandler(
        (err: Error, _req: Request, res: HttpResponseContext) => {
          prefixAdapter.reply(res, { customErr: err.message }, 502);
        },
        "/api",
      );
      prefixAdapter.get("/api-v2/raw-boom", () => {
        throw new Error("raw-v2-boom");
      });
      await prefixAdapter.compileControllers([PrefixAndFastErrController]);

      // Exact "/api" and "/api/missing" match; "/api-v2/missing" must NOT match "/api"
      expect(
        await (
          await prefixAdapter.fetch(new Request("http://localhost/api"))
        ).json(),
      ).toEqual({ customNotFound: true });
      expect(
        await (
          await prefixAdapter.fetch(new Request("http://localhost/api/missing"))
        ).json(),
      ).toEqual({ customNotFound: true });
      const nfV2 = await prefixAdapter.fetch(
        new Request("http://localhost/api-v2/missing"),
      );
      expect(nfV2.status).toBe(404);
      expect(((await nfV2.json()) as any).customNotFound).toBeUndefined();

      // Error handler matches "/api/boom" (502), must NOT match "/api-v2/boom" or "/api-v2/raw-boom" (500)
      const errApi = await prefixAdapter.fetch(
        new Request("http://localhost/api/boom"),
      );
      expect(errApi.status).toBe(502);
      expect(await errApi.json()).toEqual({ customErr: "api-boom" });

      const errV2 = await prefixAdapter.fetch(
        new Request("http://localhost/api-v2/boom"),
      );
      expect(errV2.status).toBe(500);

      const errRawV2 = await prefixAdapter.fetch(
        new Request("http://localhost/api-v2/raw-boom"),
      );
      expect(errRawV2.status).toBe(500);
    });
  });
});
