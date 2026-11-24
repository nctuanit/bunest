import "../../src/common/metadata/reflect-shim";
import { afterEach, describe, expect, test } from "bun:test";
import {
  Body,
  Controller,
  Cookies,
  Delete,
  Get,
  Head,
  Header,
  HttpCode,
  Ip,
  Param,
  Post,
  Put,
  Redirect,
  Res,
  type ResponseContext,
  Sse,
  type SseMessageEvent,
  UploadedFile,
  type UploadedFileInfo,
} from "../../src/common/index";
import { BunHttpAdapter, getCurrentRequestContext } from "../../src/http/index";

describe("ADR-010 Response Serialization Matrix", () => {
  test("serializes every return type according to ADR-010 priority and RFC 9110 rules", async () => {
    @Controller("/serialize")
    class SerializeController {
      @Get("native")
      @Header("X-Static", "from-decorator")
      @Header("X-Override", "static-value")
      native(@Res() res: ResponseContext) {
        res.cookie("from_res", "yes");
        return new Response("native-body", {
          status: 202,
          headers: {
            "Content-Type": "text/custom",
            "X-Override": "native-wins",
          },
        });
      }

      @Get("redirect-static")
      @Redirect("https://bun.sh", 301)
      redirectStatic() {
        return;
      }

      @Get("redirect-dynamic")
      @Redirect("https://fallback.test", 302)
      redirectDynamic() {
        return { url: "https://dynamic.test/next", statusCode: 307 };
      }

      @Get("stream")
      stream() {
        return new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("chunk-1-"));
            controller.enqueue(new TextEncoder().encode("chunk-2"));
            controller.close();
          },
        });
      }

      @Get("blob")
      blob() {
        return new Blob(["blob-data"], { type: "application/x-demo" });
      }

      @Get("bytes")
      bytes() {
        return new Uint8Array([65, 66, 67]);
      }

      @Get("null")
      returnsNull() {
        return null;
      }

      @Get("void")
      @HttpCode(204)
      returnsNoContent() {
        return { ignored: "must be stripped on 204" };
      }

      @Get("string")
      returnsString() {
        return "hello text";
      }

      @Get("number")
      returnsNumber() {
        return 42;
      }

      @Get("boolean")
      returnsBool() {
        return true;
      }

      @Post("created")
      returnsCreated() {
        return { created: true };
      }

      @Get("circular")
      returnsCircular() {
        const obj: Record<string, unknown> = { a: 1 };
        obj.self = obj;
        return obj;
      }
    }

    const adapter = new BunHttpAdapter({ logger: false, cors: true });
    await adapter.compileControllers([SerializeController]);

    // 1. Native Response passthrough
    const nativeRes = await adapter.fetch(
      new Request("http://localhost/serialize/native", {
        headers: { origin: "https://web.test" },
      }),
    );
    expect(nativeRes.status).toBe(202);
    expect(await nativeRes.text()).toBe("native-body");
    expect(nativeRes.headers.get("content-type")).toBe("text/custom");
    expect(nativeRes.headers.get("x-static")).toBe("from-decorator");
    expect(nativeRes.headers.get("x-override")).toBe("native-wins");
    expect(nativeRes.headers.get("access-control-allow-origin")).toBe("*");
    expect(nativeRes.headers.getSetCookie()[0]).toContain("from_res=yes");

    // 2. @Redirect static & dynamic
    const redir1 = await adapter.fetch(
      new Request("http://localhost/serialize/redirect-static"),
    );
    expect(redir1.status).toBe(301);
    expect(redir1.headers.get("location")).toBe("https://bun.sh");

    const redir2 = await adapter.fetch(
      new Request("http://localhost/serialize/redirect-dynamic"),
    );
    expect(redir2.status).toBe(307);
    expect(redir2.headers.get("location")).toBe("https://dynamic.test/next");

    // 4. ReadableStream
    const streamRes = await adapter.fetch(
      new Request("http://localhost/serialize/stream"),
    );
    expect(streamRes.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(await streamRes.text()).toBe("chunk-1-chunk-2");

    // 5. Blob
    const blobRes = await adapter.fetch(
      new Request("http://localhost/serialize/blob"),
    );
    expect(blobRes.headers.get("content-type")).toBe("application/x-demo");
    expect(await blobRes.text()).toBe("blob-data");

    // 6. Uint8Array
    const bytesRes = await adapter.fetch(
      new Request("http://localhost/serialize/bytes"),
    );
    expect(bytesRes.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(await bytesRes.text()).toBe("ABC");

    // 7. null & 204 RFC 9110 empty body
    const nullRes = await adapter.fetch(
      new Request("http://localhost/serialize/null"),
    );
    expect(nullRes.status).toBe(200);
    expect(await nullRes.text()).toBe("");

    const noContentRes = await adapter.fetch(
      new Request("http://localhost/serialize/void"),
    );
    expect(noContentRes.status).toBe(204);
    expect(await noContentRes.text()).toBe("");

    // 8. string
    const strRes = await adapter.fetch(
      new Request("http://localhost/serialize/string"),
    );
    expect(strRes.headers.get("content-type")).toBe(
      "text/plain; charset=utf-8",
    );
    expect(await strRes.text()).toBe("hello text");

    // 9. number & boolean
    const numRes = await adapter.fetch(
      new Request("http://localhost/serialize/number"),
    );
    expect(numRes.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    expect(await numRes.json()).toBe(42);

    const boolRes = await adapter.fetch(
      new Request("http://localhost/serialize/boolean"),
    );
    expect(await boolRes.json()).toBe(true);

    // 10. POST default 201 + circular -> 500
    const createdRes = await adapter.fetch(
      new Request("http://localhost/serialize/created", { method: "POST" }),
    );
    expect(createdRes.status).toBe(201);
    expect(await createdRes.json()).toEqual({ created: true });

    const circularRes = await adapter.fetch(
      new Request("http://localhost/serialize/circular"),
    );
    expect(circularRes.status).toBe(500);
  });

  test("streams @Sse() events cleanly and cancels upstream generator on AbortSignal", async () => {
    let generatorCleanedUp = false;

    @Controller("/events")
    class EventsController {
      @Sse("stream")
      async *stream(): AsyncGenerator<SseMessageEvent> {
        try {
          yield {
            id: "1",
            type: "greeting",
            retry: 1500,
            data: "line1\nline2",
          };
          yield { id: "2", data: { count: 2 } };
          await new Promise((resolve) => setTimeout(resolve, 2000));
          yield { id: "3", data: "never-reached" };
        } finally {
          generatorCleanedUp = true;
        }
      }
    }

    const adapter = new BunHttpAdapter({ logger: false });
    await adapter.compileControllers([EventsController]);

    const abortController = new AbortController();
    const res = await adapter.fetch(
      new Request("http://localhost/events/stream", {
        signal: abortController.signal,
      }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "text/event-stream; charset=utf-8",
    );
    expect(res.headers.get("cache-control")).toBe("no-cache, no-transform");

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(decoder.decode(first.value)).toBe(
      "id: 1\nevent: greeting\nretry: 1500\ndata: line1\ndata: line2\n\n",
    );

    const second = await reader.read();
    expect(second.done).toBe(false);
    expect(decoder.decode(second.value)).toBe('id: 2\ndata: {"count":2}\n\n');

    // Abort client signal -> upstream generator cleanup MUST trigger
    abortController.abort();
    await reader.cancel();
    // Yield microtasks so iterator.return() completes
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(generatorCleanedUp).toBe(true);
  });
});

describe("Live Bun.serve({ port: 0 }) End-to-End Tests", () => {
  const activeAdapters: BunHttpAdapter[] = [];

  afterEach(async () => {
    while (activeAdapters.length > 0) {
      const adapter = activeAdapters.pop();
      if (adapter) {
        await adapter.close(true);
      }
    }
  });

  test("serves native routes, 405 + Allow, HEAD -> GET, explicit HEAD, 404, CORS, cookies, uploads, IP, and concurrency", async () => {
    @Controller("/users")
    class UsersController {
      @Get()
      list() {
        return [{ id: "1" }];
      }

      @Post()
      create(@Body() body: { name: string }) {
        return { id: "new", name: body.name };
      }

      @Get(":id")
      @Header("X-Resource", "user")
      getOne(@Param("id") id: string, @Ip() ip: string) {
        return { id, ip };
      }

      @Put("explicit-head")
      putExplicit() {
        return { ok: true };
      }

      @Head("explicit-head")
      @Header("X-Explicit-Head", "yes")
      explicitHead() {
        return "body-must-be-stripped";
      }

      @Get("isolated/:reqId")
      async isolated(@Param("reqId") reqId: string) {
        const delayMs = Math.floor(Math.random() * 15);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        const store = getCurrentRequestContext();
        return {
          paramId: reqId,
          alsParamId: store?.params.reqId,
          headerId: store?.request.headers.get("x-req-id"),
        };
      }

      @Get("cookies")
      cookies(@Cookies("token") token: string, @Res() res: ResponseContext) {
        res.cookie("a", "1", { path: "/" });
        res.cookie("b", "2", { path: "/" });
        return { receivedToken: token };
      }

      @Post("upload")
      upload(@UploadedFile("file") file: UploadedFileInfo) {
        return {
          name: file.originalname,
          size: file.size,
          content: new TextDecoder().decode(file.buffer),
        };
      }

      @Delete(":id")
      remove(@Param("id") id: string) {
        return { deleted: id };
      }
    }

    const adapter = new BunHttpAdapter({
      logger: false,
      cors: { origin: "https://frontend.test", credentials: true },
      ignoreTrailingSlash: true,
    });
    activeAdapters.push(adapter);

    await adapter.compileControllers([UsersController]);
    const info = await adapter.listen({ port: 0, hostname: "127.0.0.1" });
    expect(info.port).toBeGreaterThan(0);

    const base = `http://127.0.0.1:${info.port}`;

    // Native :param route with URL decoding (%20 -> space) + server.requestIP()
    const userRes = await fetch(`${base}/users/john%20doe`);
    expect(userRes.status).toBe(200);
    expect(userRes.headers.get("x-resource")).toBe("user");
    const userJson = (await userRes.json()) as { id: string; ip: string };
    expect(userJson.id).toBe("john doe");
    expect(userJson.ip.length).toBeGreaterThan(0);

    // Implicit HEAD -> GET (200, header preserved, empty body)
    const headRes = await fetch(`${base}/users/42`, { method: "HEAD" });
    expect(headRes.status).toBe(200);
    expect(headRes.headers.get("x-resource")).toBe("user");
    expect(await headRes.text()).toBe("");

    // Explicit @Head() override
    const explicitHead = await fetch(`${base}/users/explicit-head`, {
      method: "HEAD",
    });
    expect(explicitHead.status).toBe(200);
    expect(explicitHead.headers.get("x-explicit-head")).toBe("yes");
    expect(await explicitHead.text()).toBe("");

    // 405 Method Not Allowed + sorted Allow header + CORS headers
    const res405 = await fetch(`${base}/users`, {
      method: "PATCH",
      headers: { origin: "https://frontend.test" },
    });
    expect(res405.status).toBe(405);
    expect(res405.headers.get("allow")).toBe("GET, HEAD, POST");
    expect(res405.headers.get("access-control-allow-origin")).toBe(
      "https://frontend.test",
    );

    // Live CORS preflight OPTIONS on matched native route
    const preflight = await fetch(`${base}/users`, {
      method: "OPTIONS",
      headers: {
        origin: "https://frontend.test",
        "access-control-request-method": "POST",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(
      "https://frontend.test",
    );
    expect(preflight.headers.get("access-control-allow-methods")).toBe(
      "GET, HEAD, POST",
    );

    // ignoreTrailingSlash: true re-dispatches `/users/` to `/users`
    const trailingRes = await fetch(`${base}/users/`);
    expect(trailingRes.status).toBe(200);
    expect(await trailingRes.json()).toEqual([{ id: "1" }]);

    // 404 Not Found with CORS headers
    const res404 = await fetch(`${base}/unknown-route`, {
      headers: { origin: "https://frontend.test" },
    });
    expect(res404.status).toBe(404);
    expect(res404.headers.get("access-control-allow-origin")).toBe(
      "https://frontend.test",
    );

    // Live cookies round-trip
    const cookieRes = await fetch(`${base}/users/cookies`, {
      headers: { cookie: "token=live-secret" },
    });
    expect(cookieRes.status).toBe(200);
    expect(await cookieRes.json()).toEqual({ receivedToken: "live-secret" });
    expect(cookieRes.headers.getSetCookie()).toHaveLength(2);

    // Live multipart upload
    const form = new FormData();
    form.append("file", new File(["live-bytes"], "demo.bin"));
    const uploadRes = await fetch(`${base}/users/upload`, {
      method: "POST",
      body: form,
    });
    expect(uploadRes.status).toBe(201);
    expect(await uploadRes.json()).toEqual({
      name: "demo.bin",
      size: 10,
      content: "live-bytes",
    });

    // 50 concurrent requests verifying zero cross-request state leakage
    const concurrentResults = await Promise.all(
      Array.from({ length: 50 }, async (_, idx) => {
        const id = `req-${idx}`;
        const r = await fetch(`${base}/users/isolated/${id}`, {
          headers: { "x-req-id": id },
        });
        expect(r.status).toBe(200);
        return (await r.json()) as {
          paramId: string;
          alsParamId: string;
          headerId: string;
        };
      }),
    );

    for (let i = 0; i < 50; i++) {
      const expected = `req-${i}`;
      expect(concurrentResults[i]).toEqual({
        paramId: expected,
        alsParamId: expected,
        headerId: expected,
      });
    }
  });

  test("streams SSE over live Bun.serve and aborts cleanly when client disconnects", async () => {
    let cleanedUp = false;

    @Controller("/live-sse")
    class LiveSseController {
      @Sse()
      async *ticks(): AsyncGenerator<SseMessageEvent> {
        try {
          let i = 0;
          while (true) {
            yield { id: String(i), data: { tick: i } };
            i++;
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
        } finally {
          cleanedUp = true;
        }
      }
    }

    const adapter = new BunHttpAdapter({ logger: false });
    activeAdapters.push(adapter);
    await adapter.compileControllers([LiveSseController]);
    const info = await adapter.listen({ port: 0, hostname: "127.0.0.1" });

    const abortController = new AbortController();
    const res = await fetch(`http://127.0.0.1:${info.port}/live-sse`, {
      signal: abortController.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "text/event-stream; charset=utf-8",
    );

    const reader = res.body!.getReader();
    const chunk = await reader.read();
    expect(chunk.done).toBe(false);
    expect(new TextDecoder().decode(chunk.value)).toContain('"tick":0');

    abortController.abort();
    await reader.cancel().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(cleanedUp).toBe(true);
  });

  test("upgrades WebSocket connections on /ws even when a catch-all HTTP route /* is registered", async () => {
    @Controller()
    class CatchAllController {
      @Get("*")
      catchAll() {
        return { caught: "wildcard" };
      }
    }

    const adapter = new BunHttpAdapter({ logger: false });
    activeAdapters.push(adapter);

    adapter.registerWebsocketHandler(
      "/ws",
      (req, server) => {
        const upgraded = server.upgrade?.(req, { data: { channel: "demo" } });
        if (upgraded) return undefined;
        return new Response("Upgrade failed", { status: 400 });
      },
      {
        message(ws: { send(msg: string): void }, message: string | Uint8Array) {
          ws.send(`echo:${String(message)}`);
        },
      },
    );

    await adapter.compileControllers([CatchAllController]);
    const info = await adapter.listen({ port: 0, hostname: "127.0.0.1" });

    // Non-upgrade HTTP request to /ws still falls through to catch-all HTTP route
    const httpRes = await fetch(`http://127.0.0.1:${info.port}/ws`);
    expect(httpRes.status).toBe(200);
    expect(await httpRes.json()).toEqual({ caught: "wildcard" });

    // WebSocket upgrade to /ws succeeds cleanly without being shadowed by /*
    const reply = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${info.port}/ws`);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error("WebSocket echo timed out"));
      }, 3000);
      ws.addEventListener("open", () => {
        ws.send("hello-bunest");
      });
      ws.addEventListener("message", (event) => {
        clearTimeout(timer);
        const text = String(event.data);
        ws.close();
        resolve(text);
      });
      ws.addEventListener("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    expect(reply).toBe("echo:hello-bunest");
  });
});
