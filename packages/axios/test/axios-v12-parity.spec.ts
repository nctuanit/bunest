import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  HttpError,
  HttpService,
  type HttpProgressEvent,
} from "../src";

describe("@bunest/axios NestJS v12 & Bun-native options parity", () => {
  let server: ReturnType<typeof Bun.serve>;
  let baseURL: string;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);

        if (url.pathname === "/api/query" && req.method === "QUERY") {
          const body = await req.json();
          return Response.json({
            method: req.method,
            filter: body,
            auth: req.headers.get("authorization"),
          });
        }

        if (url.pathname === "/api/auth") {
          return Response.json({
            authorization: req.headers.get("authorization"),
          });
        }

        if (url.pathname === "/api/params") {
          return Response.json({
            rawSearch: url.search,
          });
        }

        if (url.pathname === "/api/transform" && req.method === "POST") {
          const text = await req.text();
          return Response.json(
            {
              receivedText: text,
              contentType: req.headers.get("content-type"),
              customHeader: req.headers.get("x-transformed"),
            },
            {
              headers: { "x-server-tag": "bunest-v12" },
            },
          );
        }

        if (url.pathname === "/api/slow") {
          await Bun.sleep(200);
          return Response.json({ ok: true });
        }

        if (url.pathname === "/api/redirect-1") {
          return new Response(null, {
            status: 302,
            headers: { location: "/api/redirect-2" },
          });
        }

        if (url.pathname === "/api/redirect-2") {
          return new Response(null, {
            status: 302,
            headers: { location: "/api/redirect-final" },
          });
        }

        if (url.pathname === "/api/redirect-final") {
          return Response.json({
            reached: true,
            hopHeader: req.headers.get("x-hop"),
          });
        }

        if (url.pathname === "/api/stream-chunks") {
          const payload = "chunk-1-data|chunk-2-data|chunk-3-data";
          const encoder = new TextEncoder();
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode("chunk-1-data|"));
              controller.enqueue(encoder.encode("chunk-2-data|"));
              controller.enqueue(encoder.encode("chunk-3-data"));
              controller.close();
            },
          });
          return new Response(stream, {
            status: 200,
            headers: {
              "content-type": "text/plain",
              "content-length": String(Buffer.byteLength(payload)),
            },
          });
        }

        if (url.pathname === "/api/chunked-no-cl") {
          const encoder = new TextEncoder();
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode("0123456789"));
              controller.enqueue(encoder.encode("0123456789"));
              controller.close();
            },
          });
          return new Response(stream, {
            status: 200,
            headers: { "content-type": "text/plain" },
          });
        }

        if (url.pathname === "/api/dates") {
          return Response.json({
            createdAt: "2026-11-20T10:00:00.000Z",
            name: "release",
          });
        }

        if (url.pathname === "/api/xsrf") {
          return Response.json({
            xsrfHeader: req.headers.get("x-xsrf-token"),
          });
        }

        if (url.pathname === "/api/binary") {
          return new Response(new Uint8Array([0x48, 0x69, 0x21]), {
            status: 200,
            headers: { "content-type": "application/octet-stream" },
          });
        }

        if (url.pathname === "/api/error-401") {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }

        if (url.pathname === "/api/upload" && req.method === "POST") {
          const body = await req.text();
          return Response.json({ bytes: Buffer.byteLength(body), body });
        }

        if (url.pathname === "/api/form-response") {
          const form = new FormData();
          form.append("greeting", "hello");
          return new Response(form, { status: 200 });
        }

        return Response.json({ path: url.pathname });
      },
    });
    baseURL = `http://127.0.0.1:${server.port}/api`;
  });

  afterAll(() => {
    server.stop(true);
  });

  it("supports HttpService.query() (RFC HTTP QUERY verb) and Basic auth", async () => {
    const http = new HttpService({ baseURL });

    const res = await http.query<{
      method: string;
      filter: { status: string };
      auth: string;
    }>(
      "/query",
      { status: "active" },
      { auth: { username: "alice", password: "s3cr3t:value" } },
    );

    expect(res.status).toBe(200);
    expect(res.data.method).toBe("QUERY");
    expect(res.data.filter).toEqual({ status: "active" });
    expect(res.data.auth).toBe(
      `Basic ${Buffer.from("alice:s3cr3t:value", "utf8").toString("base64")}`,
    );

    // Explicit Authorization header takes precedence over auth
    const overrideRes = await http.get<{ authorization: string }>("/auth", {
      auth: { username: "alice", password: "pw" },
      headers: { Authorization: "Bearer custom" },
    });
    expect(overrideRes.data.authorization).toBe("Bearer custom");
  });

  it("supports paramsSerializer (custom function, serialize option, indexes, dots, encode)", async () => {
    const http = new HttpService({ baseURL });

    const fnRes = await http.get<{ rawSearch: string }>("/params", {
      params: { a: 1, b: 2 },
      paramsSerializer: (p) => `custom=${p.a}-${p.b}`,
    });
    expect(fnRes.data.rawSearch).toBe("?custom=1-2");

    const indexedRes = await http.get<{ rawSearch: string }>("/params", {
      params: { tag: ["x", "y"], filter: { role: "admin" } },
      paramsSerializer: { indexes: true, dots: true },
    });
    expect(decodeURIComponent(indexedRes.data.rawSearch)).toBe(
      "?tag[0]=x&tag[1]=y&filter.role=admin",
    );

    const bracketsRes = await http.get<{ rawSearch: string }>("/params", {
      params: { tag: ["a", "b"] },
      paramsSerializer: { indexes: false },
    });
    expect(decodeURIComponent(bracketsRes.data.rawSearch)).toBe(
      "?tag[]=a&tag[]=b",
    );

    const objSerializeRes = await http.get<{ rawSearch: string }>("/params", {
      params: { q: "bunest" },
      paramsSerializer: {
        serialize: (p) => `?search=${p.q}`,
      },
    });
    expect(objSerializeRes.data.rawSearch).toBe("?search=bunest");
  });

  it("supports transformRequest and transformResponse pipelines", async () => {
    const http = new HttpService({ baseURL });

    const res = await http.post<{
      receivedText: string;
      contentType: string;
      customHeader: string;
      serverTag: string;
      statusSeen: number;
    }>(
      "/transform",
      { raw: "hello" },
      {
        transformRequest: [
          (data, headers) => {
            headers.set("x-transformed", "yes");
            headers.set("content-type", "text/plain");
            return `wrapped:${data.raw}`;
          },
          (data) => `${data}:v2`,
        ],
        transformResponse: [
          (data, headers, status) => ({
            ...data,
            serverTag: headers["x-server-tag"],
            statusSeen: status,
          }),
        ],
      },
    );

    expect(res.data.receivedText).toBe("wrapped:hello:v2");
    expect(res.data.contentType).toBe("text/plain");
    expect(res.data.customHeader).toBe("yes");
    expect(res.data.serverTag).toBe("bunest-v12");
    expect(res.data.statusSeen).toBe(200);
  });

  it("supports timeoutErrorMessage on timeout", async () => {
    const http = new HttpService({ baseURL });

    let caught: unknown;
    try {
      await http.get("/slow", {
        timeout: 25,
        timeoutErrorMessage: "Upstream API timed out after 25ms",
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(HttpError);
    expect((caught as HttpError).code).toBe("ECONNABORTED");
    expect((caught as HttpError).message).toBe(
      "Upstream API timed out after 25ms",
    );
  });

  it("supports maxRedirects (0, within limit, exceeded) and beforeRedirect hook", async () => {
    const http = new HttpService({ baseURL });

    // maxRedirects: 0 does not follow 302
    const manualRes = await http.get("/redirect-1", {
      maxRedirects: 0,
      validateStatus: null,
    });
    expect(manualRes.status).toBe(302);
    expect(manualRes.headers.location).toBe("/api/redirect-2");

    // maxRedirects: 2 follows 2 hops and invokes beforeRedirect
    const hops: Array<{ from: string; to: string; status: number }> = [];
    const followedRes = await http.get<{ reached: boolean; hopHeader: string }>(
      "/redirect-1",
      {
        maxRedirects: 2,
        beforeRedirect: (options, resDetails, reqDetails) => {
          hops.push({
            from: reqDetails.url,
            to: options.url,
            status: resDetails.statusCode,
          });
          options.headers["x-hop"] = `hop-${hops.length}`;
        },
      },
    );
    expect(followedRes.status).toBe(200);
    expect(followedRes.data.reached).toBe(true);
    expect(followedRes.data.hopHeader).toBe("hop-2");
    expect(hops).toHaveLength(2);
    expect(hops[0]!.status).toBe(302);

    // maxRedirects: 1 rejects on 2nd redirect with ERR_FR_TOO_MANY_REDIRECTS
    let tooManyErr: unknown;
    try {
      await http.get("/redirect-1", { maxRedirects: 1 });
    } catch (err) {
      tooManyErr = err;
    }
    expect(tooManyErr).toBeInstanceOf(HttpError);
    expect((tooManyErr as HttpError).code).toBe("ERR_FR_TOO_MANY_REDIRECTS");

    // defaults.beforeRedirect + per-request maxRedirects: 0 returns 3xx directly (manual)
    let beforeRedirectCalled = false;
    const httpWithDefaultHook = new HttpService({
      baseURL,
      beforeRedirect: () => {
        beforeRedirectCalled = true;
      },
    });
    const manualWithHookRes = await httpWithDefaultHook.get("/redirect-1", {
      maxRedirects: 0,
      validateStatus: null,
    });
    expect(manualWithHookRes.status).toBe(302);
    expect(beforeRedirectCalled).toBe(false);

    // Cross-origin redirect strips authorization, cookie, proxy-authorization, and xsrfHeaderName
    const redirectFetchCalls: Array<{ url: string; headers: Headers }> = [];
    const crossOriginHttp = new HttpService({
      baseURL: "https://origin-a.example",
      fetch: async (input, init) => {
        const url = String(input);
        const hdrs = new Headers(init?.headers);
        redirectFetchCalls.push({ url, headers: hdrs });
        if (url === "https://origin-a.example/start") {
          return new Response(null, {
            status: 302,
            headers: { location: "https://origin-b.example/final" },
          });
        }
        return Response.json({ ok: true });
      },
    });
    const crossRes = await crossOriginHttp.get<{ ok: boolean }>("/start", {
      maxRedirects: 2,
      headers: {
        Authorization: "Bearer secret",
        Cookie: "XSRF-TOKEN=xsrf-secret",
        "Proxy-Authorization": "Basic cHJveHk=",
        "X-Keep": "kept",
      },
      xsrfCookieName: "XSRF-TOKEN",
      xsrfHeaderName: "X-XSRF-TOKEN",
      withXSRFToken: true,
    });
    expect(crossRes.data.ok).toBe(true);
    expect(redirectFetchCalls).toHaveLength(2);
    expect(redirectFetchCalls[0]!.headers.get("x-xsrf-token")).toBe(
      "xsrf-secret",
    );
    expect(redirectFetchCalls[1]!.headers.get("authorization")).toBeNull();
    expect(redirectFetchCalls[1]!.headers.get("cookie")).toBeNull();
    expect(redirectFetchCalls[1]!.headers.get("proxy-authorization")).toBeNull();
    expect(redirectFetchCalls[1]!.headers.get("x-xsrf-token")).toBeNull();
    expect(redirectFetchCalls[1]!.headers.get("x-keep")).toBe("kept");
  });

  it("supports maxContentLength, maxBodyLength, onDownloadProgress, and onUploadProgress", async () => {
    const http = new HttpService({ baseURL });

    // onDownloadProgress over streamed response
    const downloadEvents: HttpProgressEvent[] = [];
    const dlRes = await http.get<string>("/stream-chunks", {
      responseType: "text",
      onDownloadProgress: (evt) => downloadEvents.push(evt),
    });
    expect(dlRes.data).toBe("chunk-1-data|chunk-2-data|chunk-3-data");
    expect(downloadEvents.length).toBeGreaterThanOrEqual(1);
    const lastDl = downloadEvents[downloadEvents.length - 1]!;
    expect(lastDl.download).toBe(true);
    expect(lastDl.loaded).toBe(Buffer.byteLength(dlRes.data));
    expect(lastDl.lengthComputable).toBe(true);
    expect(lastDl.progress).toBe(1);

    // maxContentLength rejects via Content-Length header
    let clErr: unknown;
    try {
      await http.get("/stream-chunks", { maxContentLength: 10 });
    } catch (err) {
      clErr = err;
    }
    expect(clErr).toBeInstanceOf(HttpError);
    expect((clErr as HttpError).code).toBe("ERR_BAD_RESPONSE");

    // maxContentLength rejects chunked response without Content-Length
    let chunkErr: unknown;
    try {
      await http.get("/chunked-no-cl", { maxContentLength: 12 });
    } catch (err) {
      chunkErr = err;
    }
    expect(chunkErr).toBeInstanceOf(HttpError);
    expect((chunkErr as HttpError).code).toBe("ERR_BAD_RESPONSE");

    // maxBodyLength rejects oversized outgoing body before send
    let bodyErr: unknown;
    try {
      await http.post("/upload", { payload: "x".repeat(100) }, { maxBodyLength: 20 });
    } catch (err) {
      bodyErr = err;
    }
    expect(bodyErr).toBeInstanceOf(HttpError);
    expect((bodyErr as HttpError).code).toBe("ERR_FR_MAX_BODY_LENGTH_EXCEEDED");

    // onUploadProgress fires for buffered payload and ReadableStream
    const uploadEvents: HttpProgressEvent[] = [];
    const upRes = await http.post<{ bytes: number }>("/upload", "hello-upload", {
      headers: { "content-type": "text/plain" },
      onUploadProgress: (evt) => uploadEvents.push(evt),
    });
    expect(upRes.data.bytes).toBe(12);
    expect(uploadEvents).toHaveLength(1);
    expect(uploadEvents[0]!.upload).toBe(true);
    expect(uploadEvents[0]!.loaded).toBe(12);

    const streamUploadEvents: HttpProgressEvent[] = [];
    const uploadStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("part1-"));
        controller.enqueue(new TextEncoder().encode("part2"));
        controller.close();
      },
    });
    const streamUpRes = await http.post<{ bytes: number; body: string }>(
      "/upload",
      uploadStream,
      {
        headers: { "content-type": "text/plain" },
        onUploadProgress: (evt) => streamUploadEvents.push(evt),
      },
    );
    expect(streamUpRes.data.body).toBe("part1-part2");
    expect(streamUploadEvents.length).toBeGreaterThanOrEqual(2);
    expect(streamUploadEvents[streamUploadEvents.length - 1]!.loaded).toBe(11);
  });

  it("supports parseReviver, responseEncoding, responseType:'formdata', and XSRF cookie forwarding", async () => {
    const http = new HttpService({ baseURL });

    // parseReviver revives ISO dates into Date instances
    const dateRes = await http.get<{ createdAt: Date; name: string }>("/dates", {
      parseReviver: (_key, value) =>
        typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)
          ? new Date(value)
          : value,
    });
    expect(dateRes.data.createdAt).toBeInstanceOf(Date);
    expect(dateRes.data.createdAt.toISOString()).toBe(
      "2026-11-20T10:00:00.000Z",
    );

    // responseEncoding ("hex" and "base64")
    const hexRes = await http.get<string>("/binary", {
      responseType: "text",
      responseEncoding: "hex",
    });
    expect(hexRes.data).toBe("486921");

    const b64Res = await http.get<string>("/binary", {
      responseType: "text",
      responseEncoding: "base64",
    });
    expect(b64Res.data).toBe(Buffer.from("Hi!").toString("base64"));

    // responseType: "formdata"
    const formRes = await http.get<FormData>("/form-response", {
      responseType: "formdata",
    });
    expect(formRes.data.get("greeting")).toBe("hello");

    // XSRF cookie -> header extraction
    const xsrfRes = await http.get<{ xsrfHeader: string }>("/xsrf", {
      headers: { Cookie: "sid=1; XSRF-TOKEN=tok%2F123" },
      xsrfCookieName: "XSRF-TOKEN",
      xsrfHeaderName: "X-XSRF-TOKEN",
      withXSRFToken: true,
    });
    expect(xsrfRes.data.xsrfHeader).toBe("tok/123");

    // withXSRFToken: false suppresses XSRF header
    const noXsrfRes = await http.get<{ xsrfHeader: string | null }>("/xsrf", {
      headers: { Cookie: "XSRF-TOKEN=tok123" },
      xsrfCookieName: "XSRF-TOKEN",
      xsrfHeaderName: "X-XSRF-TOKEN",
      withXSRFToken: false,
    });
    expect(noXsrfRes.data.xsrfHeader).toBeNull();
  });

  it("supports withCredentials, decompress, proxy, fetchOptions, allowAbsoluteUrls, and redact/sensitiveHeaders", async () => {
    const capturedCalls: Array<{ url: string; init: Record<string, any> }> = [];
    const mockFetch = async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      capturedCalls.push({
        url: String(input),
        init: (init ?? {}) as Record<string, any>,
      });
      return Response.json({ ok: true });
    };

    const http = new HttpService({
      baseURL: "https://api.example.com/v1",
      fetch: mockFetch,
    });

    await http.get("https://evil.example.org/pwn", {
      allowAbsoluteUrls: false,
      withCredentials: true,
      decompress: false,
      proxy: {
        protocol: "http",
        host: "proxy.internal",
        port: 8080,
        auth: { username: "u", password: "p" },
      },
      fetchOptions: { keepalive: true, mode: "cors" },
    });

    expect(capturedCalls).toHaveLength(1);
    const call = capturedCalls[0]!;
    expect(call.url).toBe(
      "https://api.example.com/v1/https://evil.example.org/pwn",
    );
    expect(call.init.credentials).toBe("include");
    expect(call.init.decompress).toBe(false);
    expect(call.init.proxy).toBe("http://u:p@proxy.internal:8080");
    expect(call.init.keepalive).toBe(true);
    expect(call.init.mode).toBe("cors");

    // proxy: false omits proxy option
    await http.get("/items", {
      proxy: false,
      withCredentials: false,
    });
    expect(capturedCalls[1]!.init.proxy).toBeUndefined();
    expect(capturedCalls[1]!.init.credentials).toBe("omit");

    // redact & sensitiveHeaders mask secrets on HttpError without mutating original input
    const realHttp = new HttpService({ baseURL });
    const reqConfig = {
      auth: { username: "admin", password: "super-secret-password" },
      params: { apiKey: "sk-live-123", page: 1 },
      headers: {
        "X-Api-Key": "secret-header",
        "X.Custom.Secret": "dotted-secret",
        "X-Safe": "visible",
      },
      sensitiveHeaders: ["x-api-key", "authorization"],
      redact: ["auth.password", "params.apiKey", "headers.x.custom.secret"],
    };

    let err401: unknown;
    try {
      await realHttp.get("/error-401", reqConfig);
    } catch (err) {
      err401 = err;
    }

    expect(err401).toBeInstanceOf(HttpError);
    const httpErr = err401 as HttpError;
    expect(httpErr.status).toBe(401);
    expect(httpErr.config.auth?.password).toBe("[REDACTED]");
    expect(httpErr.config.auth?.username).toBe("admin");
    expect((httpErr.config.params as Record<string, any>).apiKey).toBe(
      "[REDACTED]",
    );
    expect((httpErr.config.params as Record<string, any>).page).toBe(1);
    expect((httpErr.config.headers as Headers).get("x-api-key")).toBe(
      "[REDACTED]",
    );
    expect((httpErr.config.headers as Headers).get("x.custom.secret")).toBe(
      "[REDACTED]",
    );
    expect((httpErr.config.headers as Headers).get("x-safe")).toBe("visible");

    // Caller's original config remains unmutated
    expect(reqConfig.auth.password).toBe("super-secret-password");
    expect(reqConfig.params.apiKey).toBe("sk-live-123");
  });
});
