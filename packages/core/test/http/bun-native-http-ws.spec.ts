import { describe, expect, it } from "bun:test";
import {
  BadRequestException,
  BunHttpAdapter,
  BunestFactory,
  ClsModule,
  ClsService,
  CompressionMiddleware,
  Controller,
  Get,
  Header,
  Module,
  Scope,
  ServeStaticModule,
  SignedCookies,
  Sse,
  StreamableFile,
  createStaticAssetsMount,
  removePath,
  signCookieValue,
  tryServeStaticAsset,
} from "../../src/index";
import { serializeCookie } from "../../src/http/index";
import {
  BunWebSocketAdapter,
  WebSocketGateway,
  WebSocketModule,
  type BunWsClient,
  type OnGatewayDrain,
} from "../../src/ws/index";
import { join } from "../../src/common/utils/path.util";

describe("Wave 2 — Bun 1.4.5 Native HTTP & WebSocket optimizations", () => {
  it("supports Bun.serve({ unix }) Unix domain sockets and invokes closeIdleConnections() on close()", async () => {
    @Controller("unix")
    class UnixController {
      @Get("ping")
      ping() {
        return { ok: true, transport: "unix" };
      }
    }

    @Module({ controllers: [UnixController] })
    class UnixModule {}

    const sockPath = join(
      "/tmp",
      `bunest-unix-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`,
    );
    const app = await BunestFactory.create(UnixModule);
    let closeIdleCalls = 0;
    try {
      const adapter = app.getHttpAdapter();
      const info = await adapter.listen({ unix: sockPath });
      expect(info.url).toContain("unix://");

      const srv = adapter.getServer() as { closeIdleConnections?: () => void };
      const origCloseIdle = srv.closeIdleConnections?.bind(srv);
      srv.closeIdleConnections = () => {
        closeIdleCalls++;
        origCloseIdle?.();
      };

      const res = await fetch("http://localhost/unix/ping", {
        unix: sockPath,
      } as RequestInit);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, transport: "unix" });
    } finally {
      await app.close();
      await Bun.file(sockPath).delete().catch(() => {});
    }
    expect(closeIdleCalls).toBe(1);
  });

  it("reloadRoutes() updates routes live while preserving WS upgrades, rawRoutes 405 fallback, 503 closing, and empty-route clearing", async () => {
    @Controller("v1")
    class InitialController {
      @Get("ping")
      ping() {
        return { version: 1 };
      }
    }

    @Controller("v2")
    class AddedController {
      @Get("hello")
      hello() {
        return { version: 2 };
      }
    }

    const adapter = new BunHttpAdapter({
      return503OnClosing: true,
    });
    await adapter.compileControllers([InitialController]);
    let wsUpgrades = 0;
    adapter.registerWebsocketHandler("/ws-reload", () => {
      wsUpgrades++;
      return new Response("ws-upgrade-hook", { status: 418 });
    });
    // Raw POST route on same path as controller GET /v1/ping (tests 405 -> rawRoutes fallback)
    adapter.post("/v1/ping", () => ({ via: "raw-post" }));

    const info = await adapter.listen({ port: 0 });
    const base = info.url.replace(/\/$/, "");
    try {
      expect(await (await fetch(`${base}/v1/ping`)).json()).toEqual({
        version: 1,
      });
      expect(
        await (await fetch(`${base}/v1/ping`, { method: "POST" })).json(),
      ).toEqual({ via: "raw-post" });

      // Add a new controller and hot-reload routes without restarting server
      await adapter.compileControllers([InitialController, AddedController]);
      const reloaded = await adapter.reloadRoutes();
      expect(reloaded).toBe(true);

      expect(await (await fetch(`${base}/v2/hello`)).json()).toEqual({
        version: 2,
      });
      // Raw route 405 fallback still works after reloadRoutes()
      expect(
        await (await fetch(`${base}/v1/ping`, { method: "POST" })).json(),
      ).toEqual({ via: "raw-post" });
      // WS upgrade wrapper still fires after reloadRoutes()
      const wsProbe = await fetch(`${base}/ws-reload`, {
        headers: { upgrade: "websocket", connection: "Upgrade" },
      });
      expect(wsProbe.status).toBe(418);
      expect(wsUpgrades).toBeGreaterThanOrEqual(1);

      // Clearing all controllers + reloadRoutes() must NOT keep stale /v2/hello route
      await adapter.compileControllers([]);
      await adapter.reloadRoutes();
      const clearedRes = await fetch(`${base}/v2/hello`);
      expect(clearedRes.status).toBe(404);

      // Closing flag still returns 503 after reloadRoutes()
      (adapter as unknown as { isClosing: boolean }).isClosing = true;
      const closingRes = await fetch(`${base}/v2/hello`);
      expect(closingRes.status).toBe(503);
      (adapter as unknown as { isClosing: boolean }).isClosing = false;
    } finally {
      await adapter.close(true);
    }
  });

  it("sets server.timeout() for @Sse() on both async-iterable & fast paths and handles StreamableFile zero-copy/HEAD/chunked/404", async () => {
    const tmpFile = join(
      "/tmp",
      `bunest-streamable-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`,
    );
    await Bun.write(tmpFile, "hello zero-copy sendfile");

    const timeoutCalls: Array<{ seconds: number }> = [];

    @Controller("stream")
    class StreamController {
      @Sse("events")
      async *events() {
        yield { data: "hello" };
      }

      @Sse("custom-timeout", { idleTimeoutSeconds: 45 })
      singleEvent() {
        // Non-AsyncIterable SSE hits `serializeResponse()` directly
        return { data: "single" };
      }

      @Get("file")
      file() {
        return new StreamableFile(Bun.file(tmpFile), {
          type: "text/custom",
          disposition: 'inline; filename="demo.txt"',
        });
      }

      @Get("chunked")
      @Header("Transfer-Encoding", "chunked")
      chunked() {
        return new StreamableFile(Bun.file(tmpFile), {
          disposition: 'attachment; filename="chunked.txt"',
        });
      }

      @Get("missing")
      missing() {
        return new StreamableFile(
          Bun.file(`/tmp/bunest-missing-${Date.now()}.txt`),
        );
      }
    }

    @Module({ controllers: [StreamController] })
    class StreamModule {}

    const app = await BunestFactory.create(StreamModule);
    await app.init();
    const adapter = app.getHttpAdapter();

    const mockServer = {
      url: new URL("http://localhost:3000/"),
      stop() {},
      timeout(_req: Request, seconds: number) {
        timeoutCalls.push({ seconds });
      },
    };

    try {
      const sseRes = await adapter.fetch(
        new Request("http://localhost:3000/stream/events"),
        mockServer,
      );
      expect(sseRes.status).toBe(200);
      await sseRes.text();

      const customSseRes = await adapter.fetch(
        new Request("http://localhost:3000/stream/custom-timeout"),
        mockServer,
      );
      expect(customSseRes.status).toBe(200);
      expect(await customSseRes.text()).toContain("data: single");
      expect(timeoutCalls).toEqual([{ seconds: 0 }, { seconds: 45 }]);

      const fileRes = await adapter.fetch(
        new Request("http://localhost:3000/stream/file"),
        mockServer,
      );
      expect(fileRes.status).toBe(200);
      expect(fileRes.headers.get("content-type")).toBe("text/custom");
      expect(fileRes.headers.get("content-disposition")).toBe(
        'inline; filename="demo.txt"',
      );
      expect(await fileRes.text()).toBe("hello zero-copy sendfile");

      const headRes = await adapter.fetch(
        new Request("http://localhost:3000/stream/file", { method: "HEAD" }),
        mockServer,
      );
      expect(headRes.status).toBe(200);
      expect(headRes.headers.get("content-disposition")).toBe(
        'inline; filename="demo.txt"',
      );
      expect(await headRes.text()).toBe("");

      const chunkedRes = await adapter.fetch(
        new Request("http://localhost:3000/stream/chunked"),
        mockServer,
      );
      expect(chunkedRes.status).toBe(200);
      expect(chunkedRes.headers.get("content-length")).toBeNull();
      expect(await chunkedRes.text()).toBe("hello zero-copy sendfile");

      const missingRes = await adapter.fetch(
        new Request("http://localhost:3000/stream/missing"),
        mockServer,
      );
      expect(missingRes.status).toBe(404);
    } finally {
      await app.close();
      await Bun.file(tmpFile).delete().catch(() => {});
    }
  });

  it("safeHandler + Bun.peek() return synchronous Response without Promise allocation and handle sync/async errors safely", async () => {
    @Controller("fast")
    class FastController {
      @Get("sync")
      syncRoute() {
        return { kind: "sync" };
      }

      @Get("resolved")
      resolvedPromiseRoute() {
        return Promise.resolve({ kind: "peeked" });
      }

      @Get("rejected")
      rejectedRoute() {
        return Promise.reject(new BadRequestException("async-bad"));
      }

      @Get("sync-throw")
      syncThrowRoute() {
        throw new BadRequestException("sync-bad");
      }
    }

    @Module({ controllers: [FastController] })
    class FastModule {}

    const app = await BunestFactory.create(FastModule);
    await app.init();
    const adapter = app.getHttpAdapter();
    const table = (
      adapter as unknown as {
        compiledTable: {
          bunRoutes: Record<
            string,
            (req: Request, server: unknown) => Response | Promise<Response>
          >;
        };
      }
    ).compiledTable;

    try {
      // Sync route MUST return Response synchronously (no Promise)
      const syncOut = table.bunRoutes["/fast/sync"]!(
        new Request("http://localhost/fast/sync"),
        undefined,
      );
      expect(syncOut instanceof Promise).toBe(false);
      expect(syncOut instanceof Response).toBe(true);
      expect(await (syncOut as Response).json()).toEqual({ kind: "sync" });

      // Already-fulfilled Promise MUST be unwrapped synchronously via Bun.peek()
      const peekedOut = table.bunRoutes["/fast/resolved"]!(
        new Request("http://localhost/fast/resolved"),
        undefined,
      );
      expect(peekedOut instanceof Promise).toBe(false);
      expect(peekedOut instanceof Response).toBe(true);
      expect(await (peekedOut as Response).json()).toEqual({ kind: "peeked" });

      // Rejected Promise MUST NOT leave unhandled rejection and must return 400
      const rejRes = await table.bunRoutes["/fast/rejected"]!(
        new Request("http://localhost/fast/rejected"),
        undefined,
      );
      expect(rejRes.status).toBe(400);
      expect(await rejRes.json()).toMatchObject({ message: "async-bad" });

      // Synchronous throw must be caught by exception filter and return 400
      const throwRes = await table.bunRoutes["/fast/sync-throw"]!(
        new Request("http://localhost/fast/sync-throw"),
        undefined,
      );
      expect(throwRes.status).toBe(400);
      expect(await throwRes.json()).toMatchObject({ message: "sync-bad" });
    } finally {
      await app.close();
    }
  });

  it("serializeCookie hits Bun.Cookie fast-path across edge cases and preserves NestJS parity when sameSite unset", () => {
    // Hits `new Bun.Cookie(...)` fast path (sameSite set, no priority, not both httpOnly+secure)
    expect(
      serializeCookie("sid", "a;b=c hello", { path: "/", sameSite: "lax" }),
    ).toBe("sid=a%3Bb%3Dc%20hello; Path=/; SameSite=Lax");
    expect(
      serializeCookie("zero", "v", { path: "/", maxAge: 0, sameSite: "strict" }),
    ).toBe("zero=v; Path=/; Max-Age=0; SameSite=Strict");
    expect(
      serializeCookie("emptyPath", "v", {
        path: "",
        domain: "example.com",
        sameSite: "lax",
      }),
    ).toBe("emptyPath=v; Domain=example.com; SameSite=Lax");
    expect(
      serializeCookie("exp", "v", {
        path: "/",
        expires: new Date(0),
        sameSite: "lax",
      }),
    ).toBe("exp=v; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax");
    expect(
      serializeCookie("part", "v", {
        path: "/",
        secure: true,
        partitioned: true,
        sameSite: "none",
      }),
    ).toBe("part=v; Path=/; Secure; Partitioned; SameSite=None");

    // Manual path when priority + httpOnly + secure are combined
    const combined = serializeCookie("sid", "s:abc.x+y/z", {
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      priority: "high",
    });
    expect(combined).toBe(
      "sid=s%3Aabc.x%2By%2Fz; Path=/; HttpOnly; Secure; Priority=High; SameSite=Lax",
    );

    // Omitted sameSite must NOT inject SameSite=Lax
    const withoutSameSite = serializeCookie("plain", "value", { path: "/" });
    expect(withoutSameSite).toBe("plain=value; Path=/");
    expect(withoutSameSite).not.toContain("SameSite");
  });

  it("reads @SignedCookies() from real Bun.serve req.cookies (Bun.CookieMap) including URL-encoded, quoted, and tampered cookies", async () => {
    const secret = "top-secret-key";
    const signed = signCookieValue("user-42", secret);

    @Controller("ck")
    class CookieCtrl {
      @Get()
      read(@SignedCookies("uid") uid: string | undefined) {
        return { uid: uid ?? null };
      }
    }

    @Module({ controllers: [CookieCtrl] })
    class CookieModule {}

    const app = await BunestFactory.create(CookieModule, {
      cookies: { secret },
    });
    const info = await app.listen(0);
    const base = info.url.replace(/\/$/, "");

    try {
      // Standard URL-encoded signed cookie via real Bun.serve `req.cookies`
      const res1 = await fetch(`${base}/ck`, {
        headers: { cookie: `uid=${encodeURIComponent(signed)}` },
      });
      expect(res1.status).toBe(200);
      expect(await res1.json()).toEqual({ uid: "user-42" });

      // RFC 6265 quoted signed cookie via real Bun.serve `req.cookies`
      const res2 = await fetch(`${base}/ck`, {
        headers: { cookie: `uid="${signed}"` },
      });
      expect(res2.status).toBe(200);
      expect(await res2.json()).toEqual({ uid: "user-42" });

      // Tampered signed cookie must be rejected
      const res3 = await fetch(`${base}/ck`, {
        headers: { cookie: `uid=${encodeURIComponent(`${signed}tampered`)}` },
      });
      expect(res3.status).toBe(200);
      expect(await res3.json()).toEqual({ uid: null });
    } finally {
      await app.close();
    }
  });

  it("CompressionMiddleware covers sync vs async zstd, threshold skip + Vary, and strong ETag weakening", async () => {
    const mw = new CompressionMiddleware({
      encodings: ["zstd", "gzip"],
      threshold: 128,
      asyncThreshold: 512,
    });

    // Above asyncThreshold -> async Bun.zstdCompress + weak ETag
    const bigPayload = JSON.stringify({ data: "bunest-zstd-".repeat(200) });
    const bigRes = await mw.use(
      new Request("http://localhost/big", {
        headers: { "accept-encoding": "zstd, gzip" },
      }),
      {} as never,
      async () =>
        new Response(bigPayload, {
          status: 200,
          headers: {
            "content-type": "application/json; charset=utf-8",
            etag: '"strong-1"',
          },
        }),
    );
    expect(bigRes!.headers.get("content-encoding")).toBe("zstd");
    expect(bigRes!.headers.get("etag")).toBe('W/"strong-1"');
    expect(bigRes!.headers.get("vary")).toContain("Accept-Encoding");
    expect(
      new TextDecoder().decode(await Bun.zstdDecompress(await bigRes!.bytes())),
    ).toBe(bigPayload);

    // Between threshold and asyncThreshold -> sync Bun.zstdCompressSync
    const medPayload = JSON.stringify({ data: "a".repeat(200) });
    const medRes = await mw.use(
      new Request("http://localhost/med", {
        headers: { "accept-encoding": "zstd" },
      }),
      {} as never,
      async () =>
        new Response(medPayload, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    expect(medRes!.headers.get("content-encoding")).toBe("zstd");
    expect(
      new TextDecoder().decode(await Bun.zstdDecompress(await medRes!.bytes())),
    ).toBe(medPayload);

    // Below threshold (with Content-Length fast-skip and without) -> uncompressed + Vary
    for (const withCl of [true, false]) {
      const smallHeaders: Record<string, string> = {
        "content-type": "application/json",
      };
      if (withCl) smallHeaders["content-length"] = "11";
      const smallRes = await mw.use(
        new Request("http://localhost/small", {
          headers: { "accept-encoding": "zstd" },
        }),
        {} as never,
        async () =>
          new Response('{"ok":true}', { status: 200, headers: smallHeaders }),
      );
      expect(smallRes!.headers.get("content-encoding")).toBeNull();
      expect(smallRes!.headers.get("vary")).toContain("Accept-Encoding");
      expect(await smallRes!.text()).toBe('{"ok":true}');
    }
  });

  it("StaticAssets enforces scoped embeddedFiles security, 304/206/416/HEAD/rewriteHtml, disk .zst, and cleans up temp dir", async () => {
    const dir = join(
      "/tmp",
      `bunest-static-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const htmlPath = join(dir, "index.html");
    const jsPath = join(dir, "app.js");
    const zstPath = join(dir, "app.js.zst");
    await Bun.write(htmlPath, "<html><head></head><body>Hi</body></html>");
    await Bun.write(jsPath, "console.log('hello');");
    await Bun.write(
      zstPath,
      Bun.zstdCompressSync(new TextEncoder().encode("console.log('hello');")),
    );

    try {
      const mount = createStaticAssetsMount(dir, {
        preCompressed: true,
        rewriteHtml(rewriter) {
          rewriter.on("head", {
            element(el) {
              el.append('<meta name="bunest" content="native">', {
                html: true,
              });
            },
          });
        },
      });

      const zstRes = await tryServeStaticAsset(
        [mount],
        "/app.js",
        new Request("http://localhost/app.js", {
          headers: { "accept-encoding": "zstd, gzip" },
        }),
      );
      expect(zstRes?.status).toBe(200);
      expect(zstRes?.headers.get("content-encoding")).toBe("zstd");

      const htmlRes = await tryServeStaticAsset(
        [mount],
        "/index.html",
        new Request("http://localhost/index.html"),
      );
      expect(htmlRes?.status).toBe(200);
      expect(await htmlRes!.text()).toContain(
        '<meta name="bunest" content="native">',
      );

      // Scoped embedded mount: only files under `public/` may be served
      const setHeaderPaths: string[] = [];
      const embeddedMount = createStaticAssetsMount("public", {
        embedded: true,
        dotfiles: "deny",
        setHeaders(res, filePath) {
          setHeaderPaths.push(filePath);
          res.setHeader("X-Static-Test", "1");
        },
        rewriteHtml(rewriter) {
          rewriter.on("head", {
            element(el) {
              el.append('<meta name="emb" content="1">', { html: true });
            },
          });
        },
        embeddedFiles: [
          new File(["embedded-css-body"], "public/assets/app.css"), // empty type -> inferred from .css
          new File(["0123456789"], "public/data.txt", { type: "text/plain" }),
          new File(["<html><head></head><body>E</body></html>"], "public/page.html"),
          new File(['{"apiKey":"SECRET"}'], "config/secrets.json", {
            type: "application/json",
          }),
        ],
      });

      // SECURITY: unrelated embedded file outside `public/` MUST NOT leak!
      const leak1 = await tryServeStaticAsset(
        [embeddedMount],
        "/secrets.json",
        new Request("http://localhost/secrets.json"),
      );
      expect(leak1).toBeNull();
      const leak2 = await tryServeStaticAsset(
        [embeddedMount],
        "/config/secrets.json",
        new Request("http://localhost/config/secrets.json"),
      );
      expect(leak2).toBeNull();

      // Dotfiles policy enforced on embedded mount
      const dotRes = await tryServeStaticAsset(
        [embeddedMount],
        "/.env",
        new Request("http://localhost/.env"),
      );
      expect(dotRes?.status).toBe(403);

      // Inferred Content-Type + ETag + setHeaders + 304 Not Modified
      const cssRes = await tryServeStaticAsset(
        [embeddedMount],
        "/assets/app.css",
        new Request("http://localhost/assets/app.css"),
      );
      expect(cssRes?.status).toBe(200);
      expect(cssRes?.headers.get("content-type")).toBe("text/css; charset=utf-8");
      expect(cssRes?.headers.get("x-static-test")).toBe("1");
      const etag = cssRes?.headers.get("etag");
      expect(etag).toBeTruthy();
      expect(await cssRes!.text()).toBe("embedded-css-body");
      expect(setHeaderPaths).toContain("public/assets/app.css");

      const notMod = await tryServeStaticAsset(
        [embeddedMount],
        "/assets/app.css",
        new Request("http://localhost/assets/app.css", {
          headers: { "if-none-match": etag! },
        }),
      );
      expect(notMod?.status).toBe(304);

      // Range 206 + invalid Range 416 + HEAD
      const rangeRes = await tryServeStaticAsset(
        [embeddedMount],
        "/data.txt",
        new Request("http://localhost/data.txt", {
          headers: { range: "bytes=2-5" },
        }),
      );
      expect(rangeRes?.status).toBe(206);
      expect(rangeRes?.headers.get("content-range")).toBe("bytes 2-5/10");
      expect(await rangeRes!.text()).toBe("2345");

      const badRange = await tryServeStaticAsset(
        [embeddedMount],
        "/data.txt",
        new Request("http://localhost/data.txt", {
          headers: { range: "bytes=50-60" },
        }),
      );
      expect(badRange?.status).toBe(416);

      const headEmb = await tryServeStaticAsset(
        [embeddedMount],
        "/data.txt",
        new Request("http://localhost/data.txt", { method: "HEAD" }),
      );
      expect(headEmb?.status).toBe(200);
      expect(headEmb?.headers.get("content-length")).toBe("10");
      expect(await headEmb!.text()).toBe("");

      // Embedded HTMLRewriter must omit stale ETag
      const embHtml = await tryServeStaticAsset(
        [embeddedMount],
        "/page.html",
        new Request("http://localhost/page.html"),
      );
      expect(embHtml?.status).toBe(200);
      expect(embHtml?.headers.get("etag")).toBeNull();
      expect(await embHtml!.text()).toContain('<meta name="emb" content="1">');

      // ServeStaticModule forwards rewriteHtml & embeddedFiles cleanly
      @Module({
        imports: [
          ServeStaticModule.forRoot({
            rootPath: "public",
            embedded: true,
            embeddedFiles: [
              new File(["<html><head></head><body>MOD</body></html>"], "public/index.html"),
            ],
            rewriteHtml(rewriter) {
              rewriter.on("head", {
                element(el) {
                  el.append('<meta name="via" content="serve-static-module">', {
                    html: true,
                  });
                },
              });
            },
          }),
        ],
      })
      class StaticAppModule {}

      const staticApp = await BunestFactory.create(StaticAppModule);
      try {
        const modRes = await staticApp.inject("/");
        expect(modRes.statusCode).toBe(200);
        expect(modRes.body).toContain('content="serve-static-module"');
      } finally {
        await staticApp.close();
      }
    } finally {
      await removePath(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("BunWebSocketAdapter forwards options, triggers handleDrain for singleton & Scope.REQUEST gateways with CLS, and supports unix listen()", async () => {
    const singletonDrained: string[] = [];
    const reqScopedDrained: Array<{ clientId: string; trace: string | undefined }> = [];

    @WebSocketGateway({
      path: "/ws-bp",
      backpressureLimit: 2 * 1024 * 1024,
      closeOnBackpressureLimit: true,
      sendPings: true,
      publishToSelf: true,
    })
    class BpGateway implements OnGatewayDrain {
      async handleDrain(client: BunWsClient) {
        singletonDrained.push(client.id);
        if (client.data.failDrain) {
          throw new Error("drain-async-err");
        }
      }
    }

    @WebSocketGateway({
      path: "/ws-req-drain",
      scope: Scope.REQUEST,
    })
    class ReqScopedDrainGateway implements OnGatewayDrain {
      constructor(private readonly cls: ClsService) {}
      handleDrain(client: BunWsClient) {
        reqScopedDrained.push({
          clientId: client.id,
          trace: this.cls.get("traceId") as string | undefined,
        });
      }
    }

    @Module({
      imports: [ClsModule.forRoot(), WebSocketModule.forRoot()],
      providers: [BpGateway, ReqScopedDrainGateway],
    })
    class WsDrainModule {}

    const app = await BunestFactory.create(WsDrainModule);
    await app.init();
    await WebSocketModule.attach(app);
    const adapter = app.get(BunWebSocketAdapter);

    const wsHandler = adapter.createBunWebSocketHandler() as {
      backpressureLimit?: number;
      closeOnBackpressureLimit?: boolean;
      sendPings?: boolean;
      publishToSelf?: boolean;
      open: (ws: unknown) => void;
      drain: (ws: unknown) => void;
      close: (ws: unknown, code: number, reason: string) => void;
    };

    expect(wsHandler.backpressureLimit).toBe(2 * 1024 * 1024);
    expect(wsHandler.closeOnBackpressureLimit).toBe(true);
    expect(wsHandler.sendPings).toBe(true);
    expect(wsHandler.publishToSelf).toBe(true);
    expect(typeof wsHandler.drain).toBe("function");

    const makeMockWs = (
      path: string,
      clientId: string,
      handshakeData: Record<string, unknown>,
      clsCarrier?: unknown,
    ) => ({
      readyState: 1,
      data: {
        gatewayId: path,
        clientId,
        path,
        namespace: path,
        params: {},
        request: new Request(`http://localhost${path}`),
        handshakeData,
        clsCarrier,
      },
      send: () => 0,
      publish: () => 0,
      subscribe: () => {},
      unsubscribe: () => {},
      isSubscribed: () => false,
      close: () => {},
    });

    // Trigger singleton drain (both success and async error logged safely)
    const ws1 = makeMockWs("/ws-bp", "c-1", {});
    wsHandler.open(ws1);
    wsHandler.drain(ws1);
    const ws2 = makeMockWs("/ws-bp", "c-2", { failDrain: true });
    wsHandler.open(ws2);
    wsHandler.drain(ws2);
    await Bun.sleep(10);
    expect(singletonDrained).toEqual(["c-1", "c-2"]);

    // Trigger Scope.REQUEST gateway drain with CLS context
    const ws3 = makeMockWs(
      "/ws-req-drain",
      "c-req-1",
      {},
      { values: { traceId: "trace-drain-42" } },
    );
    wsHandler.open(ws3);
    await Bun.sleep(20);
    wsHandler.drain(ws3);
    await Bun.sleep(10);
    expect(reqScopedDrained).toEqual([
      { clientId: "c-req-1", trace: "trace-drain-42" },
    ]);

    wsHandler.close(ws1, 1000, "");
    wsHandler.close(ws2, 1000, "");
    wsHandler.close(ws3, 1000, "");

    // Standalone BunWebSocketAdapter.listen({ unix })
    const sockPath = join(
      "/tmp",
      `bunest-ws-unix-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`,
    );
    try {
      const wsInfo = await adapter.listen({ unix: sockPath });
      expect(wsInfo.url).toContain("unix://");
      expect(wsInfo.port).toBe(0);
    } finally {
      await adapter.closeAll();
      await app.close();
      await Bun.file(sockPath).delete().catch(() => {});
    }
  });
});
