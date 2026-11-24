import "../../src/common/metadata/reflect-shim";
import { describe, expect, test } from "bun:test";
import {
  Body,
  Controller,
  Cookies,
  Get,
  Ip,
  Post,
  Query,
  Res,
  type ResponseContext,
  UploadedFile,
  UploadedFiles,
  type UploadedFileInfo,
} from "../../src/common/index";
import { BunHttpAdapter, sanitizeObject } from "../../src/http/index";

describe("Body Parsing, Caching & Edge Cases", () => {
  test("parses request body AT MOST ONCE across multiple @Body() extractors", async () => {
    @Controller("/body-cache")
    class BodyCacheController {
      @Post()
      combine(
        @Body("first") first: string,
        @Body("second") second: number,
        @Body() whole: Record<string, unknown>,
      ) {
        return { first, second, keys: Object.keys(whole) };
      }
    }

    const adapter = new BunHttpAdapter({ logger: false });
    await adapter.compileControllers([BodyCacheController]);

    let readerCalls = 0;
    const req = new Request("http://localhost/body-cache", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ first: "bun", second: 2 }),
    });
    const bodyStream = req.body!;
    const origGetReader = bodyStream.getReader.bind(bodyStream);
    bodyStream.getReader = (() => {
      readerCalls++;
      return origGetReader();
    }) as typeof bodyStream.getReader;

    const res = await adapter.fetch(req);
    expect(res.status).toBe(201);
    expect(readerCalls).toBe(1);
    expect(await res.json()).toEqual({
      first: "bun",
      second: 2,
      keys: ["first", "second"],
    });
  });

  test("distinguishes missing body (undefined) vs JSON null vs empty string ''", async () => {
    @Controller("/tri-state")
    class TriStateController {
      @Post()
      inspect(@Body() body: unknown) {
        return {
          kind:
            body === undefined
              ? "undefined"
              : body === null
                ? "null"
                : typeof body,
          value: body === undefined ? "__UNDEFINED__" : body,
        };
      }
    }

    const adapter = new BunHttpAdapter({ logger: false });
    await adapter.compileControllers([TriStateController]);

    const missingRes = await adapter.fetch(
      new Request("http://localhost/tri-state", { method: "POST" }),
    );
    expect(await missingRes.json()).toEqual({
      kind: "undefined",
      value: "__UNDEFINED__",
    });

    const nullRes = await adapter.fetch(
      new Request("http://localhost/tri-state", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "null",
      }),
    );
    expect(await nullRes.json()).toEqual({ kind: "null", value: null });

    const jsonEmptyStrRes = await adapter.fetch(
      new Request("http://localhost/tri-state", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '""',
      }),
    );
    expect(await jsonEmptyStrRes.json()).toEqual({ kind: "string", value: "" });

    const textEmptyRes = await adapter.fetch(
      new Request("http://localhost/tri-state", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "",
      }),
    );
    expect(await textEmptyRes.json()).toEqual({ kind: "string", value: "" });
  });

  test("rejects malformed JSON with 400 Bad Request and oversized bodies with 413 Payload Too Large", async () => {
    @Controller("/limits")
    class LimitsController {
      @Post()
      accept(@Body() body: unknown) {
        return { ok: true, body };
      }
    }

    const adapter = new BunHttpAdapter({ logger: false, bodyLimit: 32 });
    await adapter.compileControllers([LimitsController]);

    // Malformed JSON -> 400
    const malformed = await adapter.fetch(
      new Request("http://localhost/limits", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"broken": ',
      }),
    );
    expect(malformed.status).toBe(400);
    const malformedBody = (await malformed.json()) as Record<string, unknown>;
    expect(malformedBody.statusCode).toBe(400);

    // Content-Length header pre-check -> 413
    const oversizedByHeader = await adapter.fetch(
      new Request("http://localhost/limits", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": "1024",
        },
        body: JSON.stringify({ data: "x".repeat(64) }),
      }),
    );
    expect(oversizedByHeader.status).toBe(413);

    // Chunked stream without Content-Length header -> 413
    const chunkedStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('{"a":"1234567890123456"}'),
        );
        controller.enqueue(new TextEncoder().encode("12345678901234567890"));
        controller.close();
      },
    });
    const oversizedChunked = await adapter.fetch(
      new Request("http://localhost/limits", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: chunkedStream,
      }),
    );
    expect(oversizedChunked.status).toBe(413);
  });

  test("strips prototype pollution keys from JSON, urlencoded, query, and cookies", async () => {
    // Direct unit check
    const raw = JSON.parse(
      '{"safe":1,"__proto__":{"polluted":true},"nested":{"constructor":{"prototype":{"evil":1}},"ok":"yes"}}',
    );
    const clean = sanitizeObject(raw) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(clean, "__proto__")).toBe(
      false,
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(clean).toEqual({ safe: 1, nested: { ok: "yes" } });

    @Controller("/proto")
    class ProtoController {
      @Post()
      submit(
        @Body() body: Record<string, unknown>,
        @Query() query: Record<string, unknown>,
        @Cookies() cookies: Record<string, string>,
      ) {
        return {
          bodyKeys: Object.keys(body),
          nestedKeys: Object.keys(
            (body.nested as Record<string, unknown>) ?? {},
          ),
          queryKeys: Object.keys(query),
          cookieKeys: Object.keys(cookies),
        };
      }
    }

    const adapter = new BunHttpAdapter({ logger: false });
    await adapter.compileControllers([ProtoController]);

    const res = await adapter.fetch(
      new Request(
        "http://localhost/proto?ok=1&__proto__=bad&constructor=bad&prototype=bad",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie: "session=abc; __proto__=evil; constructor=evil",
          },
          body: '{"safe":"ok","__proto__":{"pwn":true},"constructor":{"x":1},"nested":{"prototype":{"y":2},"good":true}}',
        },
      ),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      bodyKeys: ["safe", "nested"],
      nestedKeys: ["good"],
      queryKeys: ["ok"],
      cookieKeys: ["session"],
    });
    expect(({} as Record<string, unknown>).pwn).toBeUndefined();
  });

  test("extracts multipart/form-data fields and files via @UploadedFile and @UploadedFiles", async () => {
    @Controller("/upload")
    class UploadController {
      @Post("single")
      single(
        @UploadedFile("avatar") avatar: UploadedFileInfo,
        @Body("username") username: string,
      ) {
        return {
          username,
          fieldname: avatar.fieldname,
          originalname: avatar.originalname,
          mimetype: avatar.mimetype,
          size: avatar.size,
          text: new TextDecoder().decode(avatar.buffer),
          isFile: avatar.file instanceof File,
        };
      }

      @Post("multi")
      multi(@UploadedFiles("docs") docs: UploadedFileInfo[]) {
        return {
          count: docs.length,
          names: docs.map((d) => d.originalname),
        };
      }
    }

    const adapter = new BunHttpAdapter({ logger: false });
    await adapter.compileControllers([UploadController]);

    const form1 = new FormData();
    form1.append("username", "alice");
    form1.append(
      "avatar",
      new File(["hello-avatar"], "avatar.txt", { type: "text/plain" }),
    );
    const res1 = await adapter.fetch(
      new Request("http://localhost/upload/single", {
        method: "POST",
        body: form1,
      }),
    );
    expect(res1.status).toBe(201);
    const singleJson = (await res1.json()) as Record<string, unknown>;
    expect(String(singleJson.mimetype)).toStartWith("text/plain");
    expect(singleJson).toMatchObject({
      username: "alice",
      fieldname: "avatar",
      originalname: "avatar.txt",
      size: 12,
      text: "hello-avatar",
      isFile: true,
    });

    const form2 = new FormData();
    form2.append("docs", new File(["one"], "a.txt", { type: "text/plain" }));
    form2.append("docs", new File(["two"], "b.txt", { type: "text/plain" }));
    form2.append("other", new File(["skip"], "c.txt", { type: "text/plain" }));
    const res2 = await adapter.fetch(
      new Request("http://localhost/upload/multi", {
        method: "POST",
        body: form2,
      }),
    );
    expect(res2.status).toBe(201);
    expect(await res2.json()).toEqual({ count: 2, names: ["a.txt", "b.txt"] });
  });
});

describe("Cookies, CORS, Trust Proxy IP & Production Redaction", () => {
  test("preserves multiple Set-Cookie headers via ResponseContext.cookie() and clearCookie()", async () => {
    @Controller("/cookies")
    class CookiesController {
      @Get("set")
      setCookies(@Res() res: ResponseContext) {
        res.cookie("sid", "abc 123", {
          httpOnly: true,
          secure: true,
          sameSite: "lax",
          path: "/",
          maxAge: 3600,
        });
        res.cookie("theme", "dark", { path: "/" });
        res.clearCookie("old_session", { path: "/" });
        return { ok: true };
      }

      @Get("read")
      readCookies(
        @Cookies("sid") sid: string,
        @Cookies() all: Record<string, string>,
      ) {
        return { sid, all };
      }
    }

    const adapter = new BunHttpAdapter({ logger: false });
    await adapter.compileControllers([CookiesController]);

    const setRes = await adapter.fetch(
      new Request("http://localhost/cookies/set"),
    );
    expect(setRes.status).toBe(200);
    const setCookies = setRes.headers.getSetCookie();
    expect(setCookies).toHaveLength(3);
    expect(setCookies[0]).toContain("sid=abc%20123");
    expect(setCookies[0]).toContain("HttpOnly");
    expect(setCookies[0]).toContain("Secure");
    expect(setCookies[0]).toContain("SameSite=Lax");
    expect(setCookies[1]).toContain("theme=dark");
    expect(setCookies[2]).toContain("old_session=");
    expect(setCookies[2]).toContain("Max-Age=0");

    const readRes = await adapter.fetch(
      new Request("http://localhost/cookies/read", {
        headers: { cookie: "sid=abc%20123; theme=dark" },
      }),
    );
    expect(await readRes.json()).toEqual({
      sid: "abc 123",
      all: { sid: "abc 123", theme: "dark" },
    });
  });

  test("handles CORS preflight, origin matching, credentials, and preserves CORS headers on error responses", async () => {
    @Controller("/cors")
    class CorsController {
      @Get("ok")
      ok() {
        return { ok: true };
      }

      @Get("fail")
      fail() {
        throw new Error("boom-internal");
      }
    }

    const adapter = new BunHttpAdapter({
      logger: false,
      cors: {
        origin: [/^https:\/\/.*\.allowed\.dev$/, "https://exact.test"],
        credentials: true,
        exposedHeaders: ["X-Request-Id"],
        allowedHeaders: ["Content-Type", "Authorization"],
        maxAge: 600,
      },
    });
    await adapter.compileControllers([CorsController]);

    // Allowed preflight on matched path
    const preflight = await adapter.fetch(
      new Request("http://localhost/cors/ok", {
        method: "OPTIONS",
        headers: {
          origin: "https://app.allowed.dev",
          "access-control-request-method": "GET",
          "access-control-request-headers": "Authorization",
        },
      }),
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(
      "https://app.allowed.dev",
    );
    expect(preflight.headers.get("access-control-allow-credentials")).toBe(
      "true",
    );
    expect(preflight.headers.get("access-control-allow-headers")).toBe(
      "Content-Type,Authorization",
    );
    expect(preflight.headers.get("access-control-max-age")).toBe("600");
    expect(preflight.headers.get("access-control-allow-methods")).toContain(
      "GET",
    );

    // Disallowed origin omits Access-Control-Allow-Origin
    const disallowed = await adapter.fetch(
      new Request("http://localhost/cors/ok", {
        headers: { origin: "https://evil.attacker" },
      }),
    );
    expect(disallowed.headers.get("access-control-allow-origin")).toBeNull();

    // Error response (500) preserves CORS headers
    const err500 = await adapter.fetch(
      new Request("http://localhost/cors/fail", {
        headers: { origin: "https://exact.test" },
      }),
    );
    expect(err500.status).toBe(500);
    expect(err500.headers.get("access-control-allow-origin")).toBe(
      "https://exact.test",
    );
    expect(err500.headers.get("access-control-allow-credentials")).toBe("true");

    // 404 & 405 responses preserve CORS headers
    const err404 = await adapter.fetch(
      new Request("http://localhost/does-not-exist", {
        headers: { origin: "https://exact.test" },
      }),
    );
    expect(err404.status).toBe(404);
    expect(err404.headers.get("access-control-allow-origin")).toBe(
      "https://exact.test",
    );

    const err405 = await adapter.fetch(
      new Request("http://localhost/cors/ok", {
        method: "DELETE",
        headers: { origin: "https://exact.test" },
      }),
    );
    expect(err405.status).toBe(405);
    expect(err405.headers.get("allow")).toBe("GET, HEAD");
    expect(err405.headers.get("access-control-allow-origin")).toBe(
      "https://exact.test",
    );
  });

  test("never emits wildcard Access-Control-Allow-Origin: * alongside Access-Control-Allow-Credentials: true", async () => {
    @Controller("/cred-cors")
    class CredCorsController {
      @Get()
      ping() {
        return { ok: true };
      }
    }

    const adapter = new BunHttpAdapter({
      logger: false,
      cors: { origin: "*", credentials: true },
    });
    await adapter.compileControllers([CredCorsController]);

    // Without Origin header: MUST NOT emit wildcard `*` + credentials
    const noOrigin = await adapter.fetch(
      new Request("http://localhost/cred-cors"),
    );
    expect(noOrigin.status).toBe(200);
    expect(noOrigin.headers.get("access-control-allow-origin")).toBeNull();
    expect(noOrigin.headers.get("access-control-allow-credentials")).toBeNull();

    // With Origin header: reflects exact Origin + credentials: true + Vary: Origin
    const withOrigin = await adapter.fetch(
      new Request("http://localhost/cred-cors", {
        headers: { origin: "https://client.app" },
      }),
    );
    expect(withOrigin.status).toBe(200);
    expect(withOrigin.headers.get("access-control-allow-origin")).toBe(
      "https://client.app",
    );
    expect(withOrigin.headers.get("access-control-allow-credentials")).toBe(
      "true",
    );
    expect(withOrigin.headers.get("vary")).toContain("Origin");
  });

  test("extracts client IP respecting trustProxy settings", async () => {
    @Controller("/ip")
    class IpController {
      @Get()
      getIp(@Ip() ip: string) {
        return { ip };
      }
    }

    const fakeServer = {
      url: new URL("http://127.0.0.1:3000"),
      stop: () => {},
      requestIP: () => ({ address: "127.0.0.1", family: "IPv4", port: 50000 }),
    };

    // trustProxy: false -> ignores X-Forwarded-For
    const noTrust = new BunHttpAdapter({ logger: false, trustProxy: false });
    await noTrust.compileControllers([IpController]);
    const r1 = await noTrust.fetch(
      new Request("http://localhost/ip", {
        headers: { "x-forwarded-for": "203.0.113.5, 10.0.0.1" },
      }),
      fakeServer,
    );
    expect(await r1.json()).toEqual({ ip: "127.0.0.1" });

    // trustProxy: true -> leftmost X-Forwarded-For
    const trustAll = new BunHttpAdapter({ logger: false, trustProxy: true });
    await trustAll.compileControllers([IpController]);
    const r2 = await trustAll.fetch(
      new Request("http://localhost/ip", {
        headers: { "x-forwarded-for": "203.0.113.5, 10.0.0.1" },
      }),
      fakeServer,
    );
    expect(await r2.json()).toEqual({ ip: "203.0.113.5" });

    // trustProxy: ["loopback", "10.0.0.0/8"] -> skips trusted proxies from right
    const trustCidr = new BunHttpAdapter({
      logger: false,
      trustProxy: ["loopback", "10.0.0.0/8"],
    });
    await trustCidr.compileControllers([IpController]);
    const r3 = await trustCidr.fetch(
      new Request("http://localhost/ip", {
        headers: { "x-forwarded-for": "198.51.100.7, 203.0.113.9, 10.1.2.3" },
      }),
      fakeServer,
    );
    expect(await r3.json()).toEqual({ ip: "203.0.113.9" });
  });

  test("redacts stack traces and internal error details in production mode", async () => {
    @Controller("/redact")
    class RedactController {
      @Get("crash")
      crash() {
        throw new Error("FATAL_DB_PASSWORD_SECRET_12345");
      }
    }

    const originalNodeEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "production";
      const prodAdapter = new BunHttpAdapter({
        logger: false,
        development: true,
      });
      await prodAdapter.compileControllers([RedactController]);

      const res = await prodAdapter.fetch(
        new Request("http://localhost/redact/crash"),
      );
      expect(res.status).toBe(500);
      const rawText = await res.text();
      expect(rawText).not.toContain("FATAL_DB_PASSWORD_SECRET_12345");
      expect(rawText).not.toContain("stack");
      const json = JSON.parse(rawText) as Record<string, unknown>;
      expect(json.message).toBe("Internal server error");
      expect(json.stack).toBeUndefined();
    } finally {
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalNodeEnv;
      }
    }
  });
});
