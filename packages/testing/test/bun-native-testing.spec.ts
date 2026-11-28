import { describe, expect, it } from "bun:test";
import { AssertionError } from "@bunest/core/common";
import {
  assertDeepMatch,
  createWebViewHarness,
  isWebViewAvailable,
  matchShape,
  readSseEvents,
} from "../src/index";

describe("Wave 7 — @bunest/testing Bun 1.4.5 Helpers (Bun.deepMatch, Bun.indexOfLine SSE, Bun.WebView)", () => {
  it("matchShape and assertDeepMatch validate nested subsets and emit structured AssertionError", () => {
    const payload = {
      status: "ok",
      user: { id: 7, role: "admin", tags: ["core", "bun"] },
    };
    expect(matchShape(payload, { status: "ok", user: { role: "admin" } })).toBe(
      true,
    );
    expect(matchShape(payload, { user: { role: "guest" } })).toBe(false);

    expect(() =>
      assertDeepMatch(payload, { status: "ok", user: { id: 7 } }),
    ).not.toThrow();

    let caught: unknown;
    try {
      assertDeepMatch(payload, { status: "error" }, "custom mismatch msg");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AssertionError);
    const ae = caught as AssertionError;
    expect(ae.message).toBe("custom mismatch msg");
    expect(ae.actual).toEqual(payload);
    expect(ae.expected).toEqual({ status: "error" });
    expect(ae.operator).toBe("deepMatch");
  });

  it("readSseEvents uses Bun.indexOfLine() and handles split UTF-8, split CRLF, standalone CR, and maxEvents", async () => {
    const encoder = new TextEncoder();
    const utf8Frame = encoder.encode("event: msg\r\ndata: hello 😀\r");
    const splitPoint = utf8Frame.length - 3; // cuts inside 4-byte emoji

    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(utf8Frame.subarray(0, splitPoint));
        c.enqueue(utf8Frame.subarray(splitPoint));
        c.enqueue(encoder.encode("\n\r\ndata: cr-only\r\rdata: third\n\n"));
        c.close();
      },
    });
    const res = new Response(stream, {
      headers: { "content-type": "text/event-stream" },
    });

    const events = await readSseEvents(res, { maxEvents: 2 });
    expect(events).toEqual([
      { event: "msg", data: "hello 😀" },
      { data: "cr-only" },
    ]);
  });

  it("createWebViewHarness wraps Bun.WebView lifecycle (navigate, evaluate, idempotent close, Symbol.dispose) and errors cleanly when unavailable", async () => {
    expect(typeof isWebViewAvailable()).toBe("boolean");

    const navigated: string[] = [];
    let closeCount = 0;

    class MockWebView {
      async navigate(url: string): Promise<void> {
        navigated.push(url);
      }
      async evaluate(script: string): Promise<unknown> {
        return `eval:${script}`;
      }
      close(): void {
        closeCount += 1;
      }
    }

    {
      using harness = createWebViewHarness({
        width: 800,
        height: 600,
        webViewConstructor: MockWebView,
      });
      await harness.navigate("http://127.0.0.1:3000/docs");
      expect(await harness.evaluate<string>("document.title")).toBe(
        "eval:document.title",
      );
      harness.close();
    }
    expect(navigated).toEqual(["http://127.0.0.1:3000/docs"]);
    // close() called manually + [Symbol.dispose]() at block exit -> idempotent (1 underlying close)
    expect(closeCount).toBe(1);

    expect(() =>
      createWebViewHarness({ webViewConstructor: null }),
    ).toThrow(/Bun\.WebView is unavailable/);
  });
});
