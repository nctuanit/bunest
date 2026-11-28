import { describe, expect, it } from "bun:test";
import {
  Controller,
  Cookies,
  DiscoveryService,
  ExternalContextCreator,
  Get,
  MetadataRegistry,
} from "@bunest/core";
import { McpExpose, parseJsonlStream } from "../src/index";
import { buildBridgedRestToolsForController } from "../src/mcp/services/rest-mcp-bridge";
import { resolveLanguageModel } from "../src/providers/http-provider";

describe("Wave 7 — @bunest/ai Bun 1.4.5 Native Streaming (Bun.JSONL.parseChunk, Bun.indexOfLine, extractRequestCookies)", () => {
  it("parseJsonlStream incrementally yields NDJSON objects across split UTF-8 byte chunks", async () => {
    const encoder = new TextEncoder();
    const emojiLine = encoder.encode('{"delta":"hi 😀"}\n');
    // Split directly inside the 4-byte UTF-8 sequence of 😀
    const part1 = emojiLine.subarray(0, 15);
    const part2 = emojiLine.subarray(15);

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(part1);
        controller.enqueue(part2);
        controller.enqueue(encoder.encode('{"delta":"world"}\n{"done":true}'));
        controller.close();
      },
    });

    const items: unknown[] = [];
    for await (const item of parseJsonlStream(stream)) {
      items.push(item);
    }
    expect(items).toEqual([
      { delta: "hi 😀" },
      { delta: "world" },
      { done: true },
    ]);
  });

  it("parseJsonlStream throws SyntaxError on malformed mid-stream JSON and truncated trailing EOF JSON, and cancels stream on AbortSignal or early break", async () => {
    const encoder = new TextEncoder();

    const badMid = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(encoder.encode('{"ok":1}\n{bad}\n'));
        c.close();
      },
    });
    const seenMid: unknown[] = [];
    await expect(async () => {
      for await (const item of parseJsonlStream(badMid)) {
        seenMid.push(item);
      }
    }).toThrow(SyntaxError);
    expect(seenMid).toEqual([{ ok: 1 }]);

    const truncatedEof = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(encoder.encode('{"ok":1}\n{"truncated":'));
        c.close();
      },
    });
    const seenTrunc: unknown[] = [];
    await expect(async () => {
      for await (const item of parseJsonlStream(truncatedEof)) {
        seenTrunc.push(item);
      }
    }).toThrow(SyntaxError);
    expect(seenTrunc).toEqual([{ ok: 1 }]);

    let cancelledOnBreak = false;
    const infiniteStream = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(encoder.encode('{"tick":1}\n'));
      },
      cancel() {
        cancelledOnBreak = true;
      },
    });
    for await (const item of parseJsonlStream<{ tick: number }>(infiniteStream)) {
      expect(item.tick).toBe(1);
      break;
    }
    expect(cancelledOnBreak).toBe(true);

    let cancelledOnAbort = false;
    const ac = new AbortController();
    const abortableStream = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise(() => {});
      },
      cancel() {
        cancelledOnAbort = true;
      },
    });
    setTimeout(() => ac.abort(new Error("stop-jsonl")), 10);
    await expect(async () => {
      for await (const _item of parseJsonlStream(abortableStream, ac.signal)) {
        // never reached
      }
    }).toThrow();
    expect(cancelledOnAbort).toBe(true);
  });

  it("parseSseEvents via resolveLanguageModel().doStream handles split 4-byte UTF-8, split CRLF, comments, single-space stripping, and cancels on [DONE]", async () => {
    const origFetch = globalThis.fetch;
    let streamCancelled = false;

    const encoder = new TextEncoder();
    const emojiPayload = encoder.encode(
      ': keepalive comment\r\ndata: {"choices":[{"delta":{"content":"Hi 😀"}}]}\r',
    );
    const splitIdx = emojiPayload.length - 7; // splits inside UTF-8 emoji before trailing \r

    try {
      globalThis.fetch = (async () => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(emojiPayload.subarray(0, splitIdx));
            controller.enqueue(emojiPayload.subarray(splitIdx));
            controller.enqueue(
              encoder.encode(
                '\n\r\ndata: {"choices":[{"delta":{"content":"!"}}]}\n\ndata: [DONE]\n\ndata: {"ignored":true}\n\n',
              ),
            );
            // Intentionally leave stream open to confirm [DONE] cancels reader
          },
          cancel() {
            streamCancelled = true;
          },
        });
        return new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }) as unknown as typeof fetch;

      const model = resolveLanguageModel("openai/gpt-4o-mini");
      expect(model.doStream).toBeDefined();
      const { stream } = await model.doStream!({
        prompt: [{ role: "user", content: "hello" }],
        providerOptions: { openai: { apiKey: "test-key", baseURL: "http://mock.local/v1" } },
      });

      const deltas: string[] = [];
      const reader = stream.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value.type === "text-delta") {
          deltas.push(value.delta);
        }
      }
      expect(deltas.join("")).toBe("Hi 😀!");
      expect(streamCancelled).toBe(true);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("rest-mcp-bridge extracts @Cookies() via @bunest/core/http extractRequestCookies", async () => {
    @Controller("profile")
    @McpExpose()
    class ProfileController {
      @Get("me")
      me(@Cookies("sid") sid?: string) {
        return { sid };
      }
    }

    MetadataRegistry.precompileController(ProfileController);
    const tools = buildBridgedRestToolsForController(
      new ProfileController(),
      ProfileController,
      { name: "test-mcp", version: "1.0.0" },
      {
        discovery: new DiscoveryService({
          discoverProviders: () => [],
          discoverControllers: () => [],
          discoverModules: () => [],
          discoverProviderByToken: () => undefined,
        }),
        externalContextCreator: new ExternalContextCreator(),
      },
    );

    expect(tools.length).toBe(1);
    const result = await tools[0]!.handler(
      {},
      {
        requestInfo: new Request("http://localhost/profile/me", {
          headers: { cookie: "sid=abc%20123; other=val" },
        }),
      } as Parameters<(typeof tools)[0]["handler"]>[1],
    );
    expect(result).toEqual({ sid: "abc 123" });
  });
});
