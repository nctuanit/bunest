import { describe, expect, it, spyOn } from "bun:test";
import {
  deleteKeychainSecret,
  getKeychainSecret,
  loadKeychainSecrets,
  parseJson5Config,
  setKeychainSecret,
  type BunSecretsBackend,
} from "../../src/config/index";
import { JsonI18nLoader } from "../../src/i18n/index";
import {
  HttpClient,
  HttpClientModule,
  type BunFetchSessionLike,
} from "../../src/client/index";
import {
  BunestFactory,
  Controller,
  Get,
  Injectable,
  Module,
  createReplContext,
  removePath,
  repl,
} from "../../src/index";
import { join } from "../../src/common/utils/path.util";

describe("Wave 3 — Config (JSON5/Secrets), i18n (JSON5/Embedded), HttpClient (FetchSession/preconnect/unix) & REPL", () => {
  it("parseJson5Config parses JSON5, strips prototype-pollution keys, handles non-object roots, and throws SyntaxError on invalid input", () => {
    const parsed = parseJson5Config(`{
      // server config
      host: '127.0.0.1',
      port: 0x0bb8,
      nested: { enabled: true, "__proto__": { polluted: true }, },
      "__proto__": { evil: 1 },
      "constructor": { bad: 2 },
    }`);
    expect(parsed).toEqual({
      host: "127.0.0.1",
      port: 3000,
      nested: { enabled: true },
    });
    expect(Object.hasOwn(parsed, "__proto__")).toBe(false);
    expect(Object.hasOwn(parsed, "constructor")).toBe(false);
    expect(Object.hasOwn(parsed.nested as object, "__proto__")).toBe(false);

    // Non-object roots return {}
    expect(parseJson5Config("[1, 2, 3]")).toEqual({});
    expect(parseJson5Config("42")).toEqual({});
    expect(parseJson5Config("null")).toEqual({});

    // Invalid JSON5 throws SyntaxError
    expect(() => parseJson5Config("{ unclosed: 'str")).toThrow(SyntaxError);
  });

  it("keychain secret helpers and loadKeychainSecrets handle record/array keys, error modes, and dangerous keys", async () => {
    const store = new Map<string, string>();
    const mockBackend: BunSecretsBackend = {
      async get({ service, name }) {
        if (name === "BOOM") {
          throw new Error("keychain locked");
        }
        return store.get(`${service}:${name}`) ?? null;
      },
      async set({ service, name, value }) {
        store.set(`${service}:${name}`, value);
      },
      async delete({ service, name }) {
        return store.delete(`${service}:${name}`);
      },
    };

    await setKeychainSecret("bunest.app", "DB_PASS", "s3cr3t", mockBackend);
    expect(await getKeychainSecret("bunest.app", "DB_PASS", mockBackend)).toBe(
      "s3cr3t",
    );

    // Record key mapping + dangerous key ignored
    const recordFactory = loadKeychainSecrets({
      service: "bunest.app",
      keys: {
        dbPassword: "DB_PASS",
        missingKey: "ABSENT",
        __proto__: "DB_PASS",
      },
      backend: mockBackend,
    });
    const recResult = await recordFactory();
    expect(recResult).toEqual({ dbPassword: "s3cr3t" });
    expect(Object.hasOwn(recResult, "__proto__")).toBe(false);

    // Array keys shorthand
    const arrayFactory = loadKeychainSecrets({
      service: "bunest.app",
      keys: ["DB_PASS", "ABSENT"],
      backend: mockBackend,
    });
    expect(await arrayFactory()).toEqual({ DB_PASS: "s3cr3t" });

    // ignoreErrors: true swallows backend errors
    const tolerantFactory = loadKeychainSecrets({
      service: "bunest.app",
      keys: ["DB_PASS", "BOOM"],
      ignoreErrors: true,
      backend: mockBackend,
    });
    expect(await tolerantFactory()).toEqual({ DB_PASS: "s3cr3t" });

    // ignoreErrors: false rethrows backend errors
    const strictFactory = loadKeychainSecrets({
      service: "bunest.app",
      keys: ["BOOM"],
      ignoreErrors: false,
      backend: mockBackend,
    });
    await expect(strictFactory()).rejects.toThrow("keychain locked");

    expect(
      await deleteKeychainSecret("bunest.app", "DB_PASS", mockBackend),
    ).toBe(true);
    expect(
      await getKeychainSecret("bunest.app", "DB_PASS", mockBackend),
    ).toBeNull();
  });

  it("JsonI18nLoader loads .json5 from disk and enforces strict embeddedFiles fallback edge cases", async () => {
    // 1. Load real .json5 from disk (cleaned up in finally)
    const dir = join(
      "/tmp",
      `bunest-i18n-json5-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    await Bun.write(
      join(dir, "vi", "common.json5"),
      "{ greeting: 'Xin chao', // comment\n }\n",
    );
    try {
      const diskLoader = new JsonI18nLoader({ path: dir });
      expect(await diskLoader.load()).toEqual({
        vi: { common: { greeting: "Xin chao" } },
      });
    } finally {
      await removePath(dir, { recursive: true, force: true }).catch(() => {});
    }

    // 2. Embedded fallback with .json5 & .json
    const embedded = [
      new File(
        ["{ greeting: 'Xin chao', // comment\n }"],
        "locales/vi/common.json5",
      ),
      new File(['{"greeting": "Hello"}'], "locales/en/common.json"),
    ];
    const loader = new JsonI18nLoader({
      path: "/non-existent-dir-for-embedded/locales",
      embeddedFiles: embedded,
    });
    expect(await loader.load()).toEqual({
      vi: { common: { greeting: "Xin chao" } },
      en: { common: { greeting: "Hello" } },
    });

    // 3. Unrelated embedded files must throw ENOENT (not silently return {})
    const unrelatedLoader = new JsonI18nLoader({
      path: "/non-existent/missing-locales",
      embeddedFiles: [new File(["png"], "public/logo.png")],
    });
    await expect(unrelatedLoader.load()).rejects.toThrow("ENOENT");

    // 4. Malformed embedded JSON5 includes filename in error
    const badEmbedded = new JsonI18nLoader({
      path: "/non-existent/locales",
      embeddedFiles: [new File(["{ broken: "], "locales/en/bad.json5")],
    });
    await expect(badEmbedded.load()).rejects.toThrow("locales/en/bad.json5:");

    // 5. Conflicting file vs folder namespace throws "is defined twice"
    const conflictEmbedded = new JsonI18nLoader({
      path: "/non-existent/locales",
      embeddedFiles: [
        new File(['{"admin": "string-val"}'], "locales/en/users.json"),
        new File(['{"role": "owner"}'], "locales/en/users/admin/roles.json"),
      ],
    });
    await expect(conflictEmbedded.load()).rejects.toThrow("is defined twice");
  });

  it("HttpClient supports Bun.FetchSession redirects, DI onModuleDestroy close(), external session preservation, custom this-bound sessions, unix & fetch options", async () => {
    // 1. Live TCP server for redirects & header propagation with real Bun.FetchSession
    const server = Bun.serve({
      port: 0,
      routes: {
        "/redir": () =>
          new Response(null, { status: 302, headers: { Location: "/target" } }),
        "/cross": () =>
          new Response(null, {
            status: 302,
            headers: { Location: "https://example.invalid/outside" },
          }),
        "/target": (req) =>
          Response.json({
            ok: true,
            hdr: req.headers.get("x-custom"),
          }),
      },
      fetch: () => new Response("Not Found", { status: 404 }),
    });

    // 2. Unix socket server
    const sockPath = join(
      "/tmp",
      `bunest-httpclient-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`,
    );
    const unixServer = Bun.serve({
      unix: sockPath,
      routes: {
        "/hello": () => Response.json({ ok: true, via: "fetch-session" }),
      },
      fetch: () => new Response("Not Found", { status: 404 }),
    });

    const externalSession = new (
      Bun as unknown as {
        FetchSession: new (opts?: Record<string, unknown>) => BunFetchSessionLike;
      }
    ).FetchSession();
    let externalCloseCalls = 0;
    const origExtClose = externalSession.close.bind(externalSession);
    externalSession.close = () => {
      externalCloseCalls++;
      origExtClose();
    };

    try {
      // Same-origin redirect preserves custom headers via real Bun.FetchSession
      const redirClient = new HttpClient({
        baseUrl: server.url.toString(),
        headers: { "x-custom": "keep-me" },
        session: { keepAlive: true },
        decompress: true,
        verbose: false,
      });
      try {
        const res = await redirClient.get<{ ok: boolean; hdr: string }>(
          "/redir",
        );
        expect(res.status).toBe(200);
        expect(res.data).toEqual({ ok: true, hdr: "keep-me" });

        // Cross-origin redirect must be refused
        await expect(redirClient.get("/cross")).rejects.toThrow();
      } finally {
        redirClient.close();
      }

      // External FetchSession is NOT closed by client.close()
      const extClient = new HttpClient({
        baseUrl: server.url.toString(),
        session: externalSession,
      });
      expect((await extClient.get("/target")).status).toBe(200);
      extClient.close();
      expect(externalCloseCalls).toBe(0);

      // Custom BunFetchSessionLike using `this` keeps binding
      const customSession = {
        tag: "bound-ok",
        fetch(this: { tag: string }) {
          return Promise.resolve(
            Response.json({ tag: this.tag }),
          );
        },
        close() {},
      };
      const boundClient = new HttpClient({
        session: customSession as unknown as BunFetchSessionLike,
      });
      expect(
        (await boundClient.get<{ tag: string }>("http://localhost/any")).data,
      ).toEqual({ tag: "bound-ok" });

      // Unix socket session + preconnect
      const unixClient = new HttpClient({
        baseUrl: "http://localhost",
        session: {
          unix: sockPath,
          keepAlive: { idleTimeout: 10, maxIdleSockets: 2 },
        },
        preconnect: true,
      });
      try {
        unixClient.preconnect();
        const res = await unixClient.get<{ ok: boolean; via: string }>("/hello");
        expect(res.status).toBe(200);
        expect(res.data).toEqual({ ok: true, via: "fetch-session" });
      } finally {
        unixClient.close();
      }

      // HttpClientModule.register({ session: {...} }) closes owned FetchSession on app.close()
      @Module({
        imports: [
          HttpClientModule.register({
            baseUrl: server.url.toString(),
            session: { keepAlive: true },
            preconnect: true,
          }),
        ],
      })
      class ClientAppModule {}

      const app = await BunestFactory.createApplicationContext(ClientAppModule);
      await app.init();
      const diClient = app.get(HttpClient);
      const owned = (
        diClient as unknown as { ownedSession?: BunFetchSessionLike }
      ).ownedSession;
      expect(owned).toBeDefined();
      let ownedClosed = 0;
      const origOwnedClose = owned!.close.bind(owned);
      owned!.close = () => {
        ownedClosed++;
        origOwnedClose();
      };
      await app.close();
      expect(ownedClosed).toBe(1);
    } finally {
      origExtClose();
      server.stop(true);
      unixServer.stop(true);
      await Bun.file(sockPath).delete().catch(() => {});
    }
  });

  it("REPL defaults useColors from Bun.enableANSIColors and formats debug() with Bun.inspect.table", async () => {
    @Injectable()
    class DemoService {}

    @Controller("demo")
    class DemoController {
      @Get()
      index() {
        return "ok";
      }
    }

    @Module({ controllers: [DemoController], providers: [DemoService] })
    class DemoReplModule {}

    const app = await BunestFactory.createApplicationContext(DemoReplModule);
    await app.init();
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      const ctx = createReplContext(app);
      ctx.debug(DemoReplModule);
      const out = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(out).toContain("DemoReplModule");
      expect(out).toContain("DemoController");
      expect(out).toContain("DemoService");
      // Bun.inspect.table outputs structured box/column headers
      expect(out).toContain("module");
      expect(out).toContain("token");
    } finally {
      logSpy.mockRestore();
      await app.close();
    }

    // Verify repl() respects Bun.enableANSIColors when useColors is omitted
    const chunks: string[] = [];
    async function* emptyInput() {
      yield ".exit\n";
    }
    const server = await repl(DemoReplModule, {
      input: emptyInput(),
      output: {
        write(c: string) {
          chunks.push(c);
        },
      },
    });
    const evalOut = await server.evalLine("{ ok: true }");
    expect(evalOut).toEqual({ ok: true });
    server.close();
    const expectedAnsi = Boolean(
      (Bun as unknown as { enableANSIColors?: boolean }).enableANSIColors,
    );
    const rendered = chunks.join("");
    expect(rendered).toContain("ok");
    expect(rendered.includes("\x1b[")).toBe(expectedAnsi);
  });
});
