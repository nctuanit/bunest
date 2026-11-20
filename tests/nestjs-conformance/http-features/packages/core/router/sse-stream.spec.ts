import "reflect-metadata";
import { expect, it } from "bun:test";
import type { SseMessageEvent } from "../../../../../../packages/common/src";
import {
  RequestContext,
  formatSseEvent,
  serializeResponse,
  type RouteResponseMeta,
} from "../../../../../../packages/http/src";
import {
  describeConformance,
  itAdapted,
  readSseEvents,
} from "../../../../_helpers";

function createSseCtx(url = "http://localhost/sse"): RequestContext {
  return new RequestContext({
    request: new Request(url, {
      headers: { accept: "text/event-stream" },
    }),
  });
}

function createSseMeta(
  overrides: Partial<RouteResponseMeta> = {},
): RouteResponseMeta {
  return {
    method: "GET",
    isSse: true,
    ...overrides,
  };
}

describeConformance(
  "SseStream (Bunest formatSseEvent + serializeResponse Web ReadableStream)",
  {
    upstreamPath: "packages/core/test/router/sse-stream.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008", "ADR-010"],
    notes:
      "Adapts NestJS Node Transform SseStream unit tests to Bunest formatSseEvent() and serializeResponse() Web ReadableStream SSE pipeline.",
  },
  () => {
    itAdapted(
      ["ADR-001", "ADR-010"],
      "writes multiple multiline messages",
      async () => {
        async function* gen(): AsyncIterable<SseMessageEvent> {
          yield { id: "1", data: "hello\nworld" };
          yield { id: "2", data: "bonjour\nmonde" };
        }
        const res = serializeResponse(gen(), createSseMeta(), createSseCtx());
        const text = await res.text();
        expect(text).toBe(
          "id: 1\ndata: hello\ndata: world\n\nid: 2\ndata: bonjour\ndata: monde\n\n",
        );
      },
      "formatSseEvent emits explicit id + multiline data frames",
    );

    it("writes object messages as JSON", () => {
      const formatted = formatSseEvent({ data: { hello: "world" } });
      expect(formatted).toBe('data: {"hello":"world"}\n\n');
    });

    it("writes all message attributes", () => {
      const formatted = formatSseEvent({
        type: "tea-time",
        id: "the-id",
        retry: 222,
        data: "hello",
      });
      expect(formatted).toBe(
        "id: the-id\nevent: tea-time\nretry: 222\ndata: hello\n\n",
      );
    });

    it("writes retry even when the value is zero", () => {
      const formatted = formatSseEvent({
        id: "the-id",
        retry: 0,
        data: "hello",
      });
      expect(formatted).toBe("id: the-id\nretry: 0\ndata: hello\n\n");
    });

    // BUNEST_BUG: createSseStream / formatSseEvent does not auto-generate monotonic event ids when MessageEvent.id is omitted (packages/http/src/pipeline/response-serializer.ts:87-116).
    it.skip("auto-generates monotonic event ids when omitted", () => {
      async function* gen() {
        yield { data: "first" };
        yield { data: "second" };
      }
      const res = serializeResponse(gen(), createSseMeta(), createSseCtx());
      return res.text().then((text) => {
        expect(text).toContain("id: 1\n");
        expect(text).toContain("id: 2\n");
      });
    });

    // BUNEST_BUG: formatSseEvent ignores SseMessageEvent.comment and serializes comment-only events as JSON data instead of `: <comment>` lines (packages/http/src/pipeline/response-serializer.ts:87-116).
    it.skip("writes comment-only and comment-with-field SSE frames", () => {
      const commentOnly = formatSseEvent({
        comment: "comment-only",
      } as unknown as SseMessageEvent);
      expect(commentOnly).toBe(": comment-only\n\n");

      const commentWithData = formatSseEvent({
        comment: "with-data",
        data: "hello",
      } as unknown as SseMessageEvent);
      expect(commentWithData).toContain(": with-data\n");
      expect(commentWithData).toContain("data: hello\n");
    });

    // BUNEST_BUG: formatSseEvent ignores SseMessageEvent.comment and does not emit `: ` lines for empty or multiline comments (packages/http/src/pipeline/response-serializer.ts:87-116).
    it.skip("writes empty and multiline comments", () => {
      const empty = formatSseEvent({
        comment: "",
      } as unknown as SseMessageEvent);
      expect(empty).toBe(": \n\n");

      const multiline = formatSseEvent({
        comment: "first\r\nsecond\rthird\n\nfourth",
      } as unknown as SseMessageEvent);
      expect(multiline).toBe(
        ": first\n: second\n: third\n: \n: fourth\n\n",
      );
    });

    it("serializes empty data strings", () => {
      const formatted = formatSseEvent({ id: "1", data: "" });
      expect(formatted).toBe("id: 1\ndata: \n\n");
    });

    it("strips CR/LF from id and event fields to prevent SSE header injection", () => {
      const formatted = formatSseEvent({
        id: "1\r\nevent: forged",
        type: "update\ndata: injected",
        data: "safe",
      });
      expect(formatted).toBe(
        "id: 1event: forged\nevent: updatedata: injected\ndata: safe\n\n",
      );
    });

    itAdapted(
      ["ADR-001", "ADR-010"],
      "sets default SSE headers on the serialized Web Response",
      () => {
        async function* gen() {
          yield { data: "trigger" };
        }
        const res = serializeResponse(gen(), createSseMeta(), createSseCtx());
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe(
          "text/event-stream; charset=utf-8",
        );
        expect(res.headers.get("cache-control")).toBe("no-cache, no-transform");
        expect(res.headers.get("connection")).toBe("keep-alive");
      },
      "ADR-010 Web Response SSE headers",
    );

    itAdapted(
      ["ADR-001", "ADR-010"],
      "sets additional headers from @Header() and ResponseContext",
      () => {
        const ctx = createSseCtx();
        ctx.responseContext.header("x-late", "set");
        const res = serializeResponse(
          [{ data: "trigger" }],
          createSseMeta({
            headers: [
              { name: "access-control-headers", value: "some-cors-value" },
            ],
          }),
          ctx,
        );
        expect(res.headers.get("access-control-headers")).toBe(
          "some-cors-value",
        );
        expect(res.headers.get("x-late")).toBe("set");
      },
      "ResponseContext + @Header merge",
    );

    // BUNEST_BUG: serializeResponse sets "text/event-stream; charset=utf-8" as lowest-precedence default Content-Type so @Header() or ResponseContext.header('Content-Type', ...) overrides it (packages/http/src/pipeline/response-serializer.ts:554-563).
    it.skip("keeps the event stream content type over an additional one", () => {
      const ctx = createSseCtx();
      ctx.responseContext.header("Content-Type", "application/json");
      const res = serializeResponse(
        [{ data: "trigger" }],
        createSseMeta({
          headers: [{ name: "Content-Type", value: "application/json" }],
        }),
        ctx,
      );
      expect(res.headers.get("content-type")).toContain("text/event-stream");
    });

    it("sets custom status code via @HttpCode() or ResponseContext.status()", () => {
      const ctx1 = createSseCtx();
      const res1 = serializeResponse(
        [{ data: "trigger" }],
        createSseMeta({ httpCode: 202 }),
        ctx1,
      );
      expect(res1.status).toBe(202);

      const ctx2 = createSseCtx();
      ctx2.responseContext.status(404);
      const res2 = serializeResponse(
        [{ data: "trigger" }],
        createSseMeta(),
        ctx2,
      );
      expect(res2.status).toBe(404);
    });

    it("defaults to 200 status code when not provided", () => {
      const res = serializeResponse(
        [{ data: "trigger" }],
        createSseMeta(),
        createSseCtx(),
      );
      expect(res.status).toBe(200);
    });

    it("preserves explicit id of 0", () => {
      const formatted = formatSseEvent({ id: "0", data: "first" });
      expect(formatted).toBe("id: 0\ndata: first\n\n");
    });

    it("does not mutate a reused or frozen message object", () => {
      const ping = Object.freeze({ data: "ping" });
      expect(formatSseEvent(ping)).toBe("data: ping\n\n");
      expect(formatSseEvent(ping)).toBe("data: ping\n\n");
      expect(ping).toEqual({ data: "ping" });
    });

    it("reads the getters of a message class instance", () => {
      class Ping {
        get type() {
          return "ping";
        }
        get data() {
          return "pong";
        }
      }
      const formatted = formatSseEvent(new Ping());
      expect(formatted).toBe("event: ping\ndata: pong\n\n");
    });

    it("streams Web ReadableStream of SseMessageEvents and raw Uint8Array chunks", async () => {
      const source = new ReadableStream<SseMessageEvent | Uint8Array>({
        start(controller) {
          controller.enqueue({ id: "1", type: "msg", data: { ok: true } });
          controller.enqueue(new TextEncoder().encode("data: raw-chunk\n\n"));
          controller.close();
        },
      });
      const res = serializeResponse(source, createSseMeta(), createSseCtx());
      const events = await readSseEvents(res);
      expect(events).toEqual([
        { id: "1", event: "msg", data: '{"ok":true}' },
        { data: "raw-chunk" },
      ]);
    });

    it("streams synchronous iterables and single fallback event values", async () => {
      const resSync = serializeResponse(
        [{ data: "one" }, { data: "two" }],
        createSseMeta(),
        createSseCtx(),
      );
      expect(await readSseEvents(resSync)).toEqual([
        { data: "one" },
        { data: "two" },
      ]);

      const resSingle = serializeResponse(
        { data: "only" },
        createSseMeta(),
        createSseCtx(),
      );
      expect(await readSseEvents(resSingle)).toEqual([{ data: "only" }]);
    });

    it("cancels upstream AsyncIterable and calls return() when request signal aborts or reader cancels", async () => {
      let cleanedUp = false;
      const ac = new AbortController();
      const ctx = new RequestContext({
        request: new Request("http://localhost/sse", { signal: ac.signal }),
      });

      async function* endless(): AsyncIterable<SseMessageEvent> {
        try {
          let i = 0;
          while (true) {
            yield { id: String(++i), data: `tick-${i}` };
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        } finally {
          cleanedUp = true;
        }
      }

      const res = serializeResponse(endless(), createSseMeta(), ctx);
      const events = await readSseEvents(res, { maxEvents: 2 });
      expect(events).toHaveLength(2);
      expect(events[0]?.data).toBe("tick-1");
      expect(events[1]?.data).toBe("tick-2");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(cleanedUp).toBe(true);
    });

    it("allows a real HTTP client to consume SSE events over Bun.serve", async () => {
      async function* gen(): AsyncIterable<SseMessageEvent> {
        yield { id: "1", data: "hello" };
      }
      const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch(req) {
          return serializeResponse(
            gen(),
            createSseMeta(),
            new RequestContext({ request: req }),
          );
        },
      });
      try {
        const res = await fetch(server.url.toString());
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("text/event-stream");
        const events = await readSseEvents(res);
        expect(events).toEqual([{ id: "1", data: "hello" }]);
      } finally {
        await server.stop(true);
      }
    });
  },
);
