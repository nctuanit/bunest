import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { Readable } from "node:stream";
import {
  BadGatewayException,
  GatewayTimeoutException,
  HttpException,
  Inject,
  Injectable,
  Module,
} from "@bunest/common";
import { Test } from "@bunest/testing";
import {
  HTTP_CLIENT_MODULE_OPTIONS,
  HttpClient,
  HttpClientError,
  HttpClientModule,
  HttpNetworkError,
  HttpParseError,
  HttpResponseError,
  HttpTimeoutError,
  InjectHttpClient,
  getHttpClientToken,
  toHttpException,
  type HttpClientFactoryOptions,
  type HttpClientInterceptor,
  type HttpClientModuleFactoryOptions,
  type HttpClientModuleOptionsFactory,
  type HttpClientOptionsFactory,
  type HttpHandler,
  type HttpRequest,
} from "../src/index";

function mockFetch(
  handler: (
    url: URL,
    init?: RequestInit,
  ) => Response | Promise<Response>,
): typeof globalThis.fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      input instanceof URL
        ? input
        : typeof input === "string"
          ? new URL(input)
          : new URL(input.url);
    return handler(url, init);
  }) as typeof globalThis.fetch;
}

describe("@bunest/http-client", () => {
  describe("HttpClient core verbs, URLs, params, query & response types", () => {
    it("supports all HTTP verb methods and JSON auto-parsing", async () => {
      const seen: Array<{ method: string; url: string; contentType: string | null; body: unknown }> = [];
      const client = new HttpClient({
        baseUrl: "https://api.example.com/v1",
        retry: false,
        fetch: mockFetch((url, init) => {
          const headers = new Headers(init?.headers);
          seen.push({
            method: init?.method ?? "GET",
            url: url.href,
            contentType: headers.get("content-type"),
            body: init?.body,
          });
          if (init?.method === "HEAD") {
            return new Response(null, { status: 200 });
          }
          return new Response(JSON.stringify({ ok: true, method: init?.method }), {
            status: 200,
            headers: { "content-type": "application/json; charset=utf-8" },
          });
        }),
      });

      const r1 = await client.get<{ ok: boolean }>("/users/:id", {
        params: { id: "a/b" },
        query: {
          tag: ["x", "y"],
          active: true,
          since: new Date("2026-01-01T00:00:00.000Z"),
          skip: undefined,
          empty: null,
        },
      });
      expect(r1.status).toBe(200);
      expect(r1.ok).toBe(true);
      expect(r1.data).toEqual({ ok: true, method: "GET" } as never);
      expect(seen[0]!.url).toBe(
        "https://api.example.com/v1/users/a%2Fb?tag=x&tag=y&active=true&since=2026-01-01T00%3A00%3A00.000Z",
      );

      await client.post("/users", { json: { name: "Ada" } });
      expect(seen[1]!.method).toBe("POST");
      expect(seen[1]!.contentType).toBe("application/json");
      expect(seen[1]!.body).toBe('{"name":"Ada"}');

      await client.put("/users/1", { json: { name: "Grace" } });
      await client.patch("/users/1", { json: { active: true } });
      await client.delete("/users/1");
      const headRes = await client.head("/users/1");
      expect(headRes.data).toBeUndefined();
      await client.options("/users");
      await client.request("/users", { method: "get" });

      expect(seen.map((s) => s.method)).toEqual([
        "GET",
        "POST",
        "PUT",
        "PATCH",
        "DELETE",
        "HEAD",
        "OPTIONS",
        "GET",
      ]);
    });

    it("supports URLSearchParams query and responseType modes (text, json, arrayBuffer, stream, response, auto)", async () => {
      const client = new HttpClient({
        baseUrl: "https://api.example.com",
        retry: false,
        fetch: mockFetch((url) => {
          if (url.pathname === "/text") {
            return new Response("hello", {
              headers: { "content-type": "text/plain" },
            });
          }
          if (url.pathname === "/problem") {
            return new Response(JSON.stringify({ title: "oops" }), {
              headers: { "content-type": "application/problem+json" },
            });
          }
          if (url.pathname === "/empty") {
            return new Response(null, { status: 204 });
          }
          if (url.pathname === "/bad-json") {
            return new Response("{not-json", {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          return new Response("stream-data", { status: 200 });
        }),
      });

      const textRes = await client.get("/text", {
        query: new URLSearchParams({ a: "1", b: "2" }),
        responseType: "text",
      });
      expect(textRes.data).toBe("hello");
      expect(textRes.request.url.search).toBe("?a=1&b=2");

      const problemRes = await client.get<{ title: string }>("/problem");
      expect(problemRes.data).toEqual({ title: "oops" });

      const emptyRes = await client.get("/empty");
      expect(emptyRes.data).toBeUndefined();

      const abRes = await client.get("/text", { responseType: "arrayBuffer" });
      expect(new TextDecoder().decode(abRes.data)).toBe("hello");

      const streamRes = await client.get("/stream", { responseType: "stream" });
      expect(streamRes.data).toBeInstanceOf(Readable);
      const chunks: Buffer[] = [];
      for await (const chunk of streamRes.data) {
        chunks.push(Buffer.from(chunk as Uint8Array));
      }
      expect(Buffer.concat(chunks).toString("utf8")).toBe("stream-data");

      const rawRes = await client.get("/text", { responseType: "response" });
      expect(rawRes.data).toBeInstanceOf(Response);
      expect(await rawRes.data.text()).toBe("hello");

      await expect(client.get("/bad-json")).rejects.toBeInstanceOf(HttpParseError);
    });

    it("validates baseUrl, path params, json/body exclusivity, and cross-origin URLs", async () => {
      expect(() => new HttpClient({ baseUrl: "/relative" })).toThrow(TypeError);
      expect(() => new HttpClient({ baseUrl: "ftp://example.com" })).toThrow(TypeError);
      expect(() => new HttpClient({ baseUrl: "https://user:pass@example.com" })).toThrow(TypeError);
      expect(() => new HttpClient({ baseUrl: "https://example.com?a=1" })).toThrow(TypeError);
      expect(() => new HttpClient({ timeout: -1 })).toThrow(TypeError);
      expect(() => new HttpClient({ timeout: "bogus" as never })).toThrow(TypeError);
      expect(() => new HttpClient({ retry: { attempts: -1 } })).toThrow(TypeError);
      expect(() => new HttpClient({ interceptors: [null as never] })).toThrow(TypeError);

      const client = new HttpClient({
        baseUrl: "https://api.example.com",
        retry: false,
        fetch: mockFetch(() => new Response("ok")),
      });

      await expect(client.get("/users/:id")).rejects.toThrow(/Missing path parameter/);
      await expect(
        client.get("/users/:id", { params: { id: ".." } }),
      ).rejects.toThrow(/can't be "\.\."/);
      await expect(
        client.get("/users", { params: { unused: "1" } }),
      ).rejects.toThrow(/No ":unused" segment/);
      await expect(
        client.post("/users", { json: { a: 1 }, body: "raw" }),
      ).rejects.toThrow(/either `json` or `body`/);
      await expect(
        client.get("/users", { body: "nope" }),
      ).rejects.toThrow(/GET request can't have a body/);
      await expect(
        client.get("https://evil.example.com/steal"),
      ).rejects.toThrow(/not on the client's origin/);
    });
  });

  describe("headers, redirects, timeouts, retries & error redaction", () => {
    it("merges headers across layers and supports null removal", async () => {
      let capturedHeaders = new Headers();
      const client = new HttpClient({
        baseUrl: "https://api.example.com",
        headers: {
          "x-base": "1",
          authorization: "Bearer secret",
          "x-multi": ["a", "b"],
        },
        retry: false,
        fetch: mockFetch((_url, init) => {
          capturedHeaders = new Headers(init?.headers);
          return new Response("ok");
        }),
      });

      await client.get("/test", {
        headers: {
          authorization: null,
          "x-req": 42,
        },
      });

      expect(capturedHeaders.get("x-base")).toBe("1");
      expect(capturedHeaders.get("authorization")).toBeNull();
      expect(capturedHeaders.get("x-req")).toBe("42");
      expect(capturedHeaders.get("x-multi")).toContain("a");
    });

    it("follows same-origin redirects and blocks cross-origin redirects when baseUrl is set", async () => {
      const seen: Array<{ url: string; method: string; hasContentType: boolean }> = [];
      const client = new HttpClient({
        baseUrl: "https://api.example.com",
        retry: false,
        fetch: mockFetch((url, init) => {
          const h = new Headers(init?.headers);
          seen.push({
            url: url.href,
            method: init?.method ?? "GET",
            hasContentType: h.has("content-type"),
          });
          if (url.pathname === "/old") {
            return new Response(null, {
              status: 302,
              headers: { location: "/new" },
            });
          }
          if (url.pathname === "/cross") {
            return new Response(null, {
              status: 302,
              headers: { location: "https://other.example.com/leak" },
            });
          }
          return new Response(JSON.stringify({ arrived: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }),
      });

      const res = await client.post<{ arrived: boolean }>("/old", {
        json: { a: 1 },
      });
      expect(res.data).toEqual({ arrived: true });
      expect(seen[0]!.method).toBe("POST");
      expect(seen[1]!.method).toBe("GET");
      expect(seen[1]!.hasContentType).toBe(false);

      await expect(client.get("/cross")).rejects.toBeInstanceOf(HttpNetworkError);
    });

    it("retries transient statuses and respects Retry-After & retryIf", async () => {
      let calls = 0;
      const client = new HttpClient({
        baseUrl: "https://api.example.com",
        retry: {
          attempts: 3,
          backoff: { delay: "1ms", jitter: "none" },
        },
        fetch: mockFetch(() => {
          calls++;
          if (calls < 3) {
            return new Response(JSON.stringify({ err: "busy" }), {
              status: 503,
              headers: { "content-type": "application/json" },
            });
          }
          return new Response(JSON.stringify({ attempt: calls }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }),
      });

      const res = await client.get<{ attempt: number }>("/flaky");
      expect(calls).toBe(3);
      expect(res.data).toEqual({ attempt: 3 });

      // POST is not retried by default
      let postCalls = 0;
      const postClient = new HttpClient({
        baseUrl: "https://api.example.com",
        retry: { attempts: 3, backoff: { delay: 1, jitter: "none" } },
        fetch: mockFetch(() => {
          postCalls++;
          return new Response("fail", { status: 503 });
        }),
      });
      await expect(postClient.post("/submit", { json: {} })).rejects.toBeInstanceOf(
        HttpResponseError,
      );
      expect(postCalls).toBe(1);

      // retryIf stops retries early
      let condCalls = 0;
      const condClient = new HttpClient({
        baseUrl: "https://api.example.com",
        retry: {
          attempts: 3,
          backoff: { delay: 1, jitter: "none" },
          retryIf: (err) =>
            !(err instanceof HttpResponseError && err.status === 500),
        },
        fetch: mockFetch(() => {
          condCalls++;
          return new Response("boom", { status: 500 });
        }),
      });
      await expect(condClient.get("/stop")).rejects.toBeInstanceOf(HttpResponseError);
      expect(condCalls).toBe(1);
    });

    it("handles per-attempt timeouts, redacts URL query values in errors, and maps via toHttpException", async () => {
      const slowClient = new HttpClient({
        baseUrl: "https://api.example.com",
        timeout: "25ms",
        retry: false,
        fetch: mockFetch((_url, init) => {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(init.signal?.reason),
            );
          });
        }),
      });

      let caught: unknown;
      try {
        await slowClient.get("/slow", { query: { apiKey: "super-secret" } });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(HttpTimeoutError);
      expect(caught).toBeInstanceOf(HttpClientError);
      const timeoutErr = caught as HttpTimeoutError;
      expect(timeoutErr.timeoutMs).toBe(25);
      expect(timeoutErr.message).toContain("apiKey=***");
      expect(timeoutErr.message).not.toContain("super-secret");
      expect(timeoutErr.url).toContain("apiKey=super-secret");
      // url is non-enumerable
      expect(Object.keys(timeoutErr)).not.toContain("url");

      const mappedTimeout = toHttpException(timeoutErr, { log: false });
      expect(mappedTimeout).toBeInstanceOf(GatewayTimeoutException);
      expect(mappedTimeout.getStatus()).toBe(504);

      const respErr = new HttpResponseError({
        method: "GET",
        url: "https://api.example.com/item?token=abc",
        status: 404,
        statusText: "Not Found",
        body: { code: "NOT_FOUND" },
      });
      expect(respErr.message).toContain("token=***");
      expect(respErr.message).not.toContain("abc");
      expect(Object.keys(respErr)).not.toContain("body");
      expect(Object.keys(respErr)).not.toContain("headers");

      const badGateway = toHttpException(respErr, { log: false });
      expect(badGateway).toBeInstanceOf(BadGatewayException);
      expect(badGateway.getStatus()).toBe(502);

      const forwarded = toHttpException(respErr, {
        forward: [404],
        log: false,
      });
      expect(forwarded).toBeInstanceOf(HttpException);
      expect(forwarded.getStatus()).toBe(404);
      expect(forwarded.getResponse()).toEqual({ code: "NOT_FOUND" });

      const unrelated = new Error("plain");
      expect(toHttpException(unrelated, { log: false })).toBe(unrelated);
    });
  });

  describe("HttpClientModule DI, named clients, forRoot & interceptors", () => {
    it("merges forRoot defaults with named register/registerAsync clients and resolves DI class interceptors", async () => {
      const order: string[] = [];

      @Injectable()
      class TokenStore {
        token = "di-token-123";
      }

      @Injectable()
      class AuthInterceptor implements HttpClientInterceptor {
        constructor(private readonly tokens: TokenStore) {}

        async intercept(
          request: HttpRequest,
          next: HttpHandler,
        ): Promise<Response> {
          order.push(`auth:${request.context.tag ?? "none"}`);
          request.headers.set("authorization", `Bearer ${this.tokens.token}`);
          return next(request);
        }
      }

      @Module({
        providers: [TokenStore],
        exports: [TokenStore],
      })
      class AuthModule {}

      const captured = {
        auth: null as string | null,
        rootHeader: null as string | null,
        clientHeader: null as string | null,
      };

      const stubFetch = mockFetch((_url, init) => {
        const h = new Headers(init?.headers);
        captured.auth = h.get("authorization");
        captured.rootHeader = h.get("x-root");
        captured.clientHeader = h.get("x-client");
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        });
      });

      @Injectable()
      class GithubOptionsFactory implements HttpClientOptionsFactory {
        createHttpClientOptions(): HttpClientFactoryOptions {
          return {
            baseUrl: "https://api.github.com",
            headers: { "x-client": "github" },
          };
        }
      }

      @Injectable()
      class ConsumerService {
        constructor(
          readonly defaultClient: HttpClient,
          @InjectHttpClient("github") readonly githubClient: HttpClient,
          @Inject(HTTP_CLIENT_MODULE_OPTIONS)
          readonly rootOptions: Record<string, unknown>,
        ) {}
      }

      const moduleRef = await Test.createTestingModule({
        imports: [
          HttpClientModule.forRoot({
            headers: { "x-root": "global" },
            retry: false,
            fetch: stubFetch,
            interceptors: [
              async (req, next) => {
                order.push("root-fn");
                return next(req);
              },
            ],
          }),
          HttpClientModule.register({
            baseUrl: "https://default.example.com",
            headers: { "x-client": "default" },
          }),
          HttpClientModule.registerAsync({
            name: "github",
            imports: [AuthModule],
            interceptors: [AuthInterceptor],
            useClass: GithubOptionsFactory,
          }),
        ],
        providers: [ConsumerService],
      }).compile();

      await moduleRef.init();

      const consumer = moduleRef.get(ConsumerService);
      expect(getHttpClientToken()).toBe(HttpClient);
      expect(getHttpClientToken("github")).toBe("HttpClient:github");
      expect(consumer.defaultClient).toBeInstanceOf(HttpClient);
      expect(consumer.githubClient).toBeInstanceOf(HttpClient);
      expect(consumer.defaultClient).not.toBe(consumer.githubClient);
      expect(consumer.rootOptions).toBeDefined();

      const res = await consumer.githubClient.get<{ ok: boolean }>("/repos", {
        context: { tag: "gh" },
      });
      expect(res.data).toEqual({ ok: true });
      expect(order).toEqual(["root-fn", "auth:gh"]);
      expect(captured.auth).toBe("Bearer di-token-123");
      expect(captured.rootHeader).toBe("global");
      expect(captured.clientHeader).toBe("github");

      await moduleRef.close();
    });

    it("supports forRootAsync with useClass and rejects structural keys returned from factory", async () => {
      @Injectable()
      class RootConfigFactory implements HttpClientModuleOptionsFactory {
        createHttpClientModuleOptions(): HttpClientModuleFactoryOptions {
          return {
            headers: { "x-async-root": "yes" },
            retry: false,
            fetch: mockFetch((_url, init) => {
              const h = new Headers(init?.headers);
              return new Response(
                JSON.stringify({ header: h.get("x-async-root") }),
                { headers: { "content-type": "application/json" } },
              );
            }),
          };
        }
      }

      const mod = await Test.createTestingModule({
        imports: [
          HttpClientModule.forRootAsync({
            useClass: RootConfigFactory,
          }),
          HttpClientModule.register({
            baseUrl: "https://async.example.com",
          }),
        ],
      }).compile();

      const client = mod.get(HttpClient);
      const res = await client.get<{ header: string }>("/ping");
      expect(res.data).toEqual({ header: "yes" });
      await mod.close();

      await expect(
        Test.createTestingModule({
          imports: [
            HttpClientModule.registerAsync({
              useFactory: () =>
                ({ name: "bad", baseUrl: "https://x.test" }) as never,
            }),
          ],
        }).compile(),
      ).rejects.toThrow(/the factory returned `name`/);
    });

    it("supports throwOnHttpError: false, Retry-After capping, and non-replayable stream body guard", async () => {
      // throwOnHttpError: false
      const client = new HttpClient({
        baseUrl: "https://api.example.com",
        retry: false,
        throwOnHttpError: false,
        fetch: mockFetch(
          () =>
            new Response("<html>502</html>", {
              status: 502,
              headers: { "content-type": "text/html" },
            }),
        ),
      });
      const nonOk = await client.get("/down", { responseType: "json" });
      expect(nonOk.status).toBe(502);
      expect(nonOk.ok).toBe(false);
      expect(nonOk.data).toBe("<html>502</html>");

      // Retry-After exceeding maxDelay aborts retries immediately
      let retryAfterCalls = 0;
      const raClient = new HttpClient({
        baseUrl: "https://api.example.com",
        retry: {
          attempts: 3,
          backoff: { delay: 1, maxDelay: "1s", jitter: "none" },
        },
        fetch: mockFetch(() => {
          retryAfterCalls++;
          return new Response("too many", {
            status: 429,
            headers: { "retry-after": "120" },
          });
        }),
      });
      await expect(raClient.get("/limited")).rejects.toBeInstanceOf(
        HttpResponseError,
      );
      expect(retryAfterCalls).toBe(1);

      // Non-replayable stream body cannot be sent twice
      const streamBody = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("chunk"));
          controller.close();
        },
      });
      const streamClient = new HttpClient({
        baseUrl: "https://api.example.com",
        retry: false,
        fetch: mockFetch(() => new Response("ok")),
      });
      await streamClient.post("/upload", { body: streamBody });
      await expect(
        streamClient.post("/upload", { body: streamBody }),
      ).rejects.toThrow(/already sent/);
    });
  });
});
