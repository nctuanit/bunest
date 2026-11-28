import { describe, expect, it } from "bun:test";
import {
  concatBytes,
  crc32,
  deepEqual,
  deferred,
  escapeHtml,
  fastHash,
  isPromiseFulfilled,
  md5,
  peekPromise,
  sha512,
  sleep,
  streamToBytes,
  streamToJson,
  streamToText,
  stringWidth,
  stripAnsi,
  withTimeout,
} from "../../src/common/utils/index";
import * as commonExports from "../../src/common/index";
import * as coreExports from "../../src/index";

describe("Bun-native core utilities", () => {
  describe("crypto & fast hashing", () => {
    it("computes sha512 and md5 in hex, base64, and base64url", () => {
      expect(sha512("hello")).toHaveLength(128);
      expect(sha512("hello", "base64")).toBe(
        Buffer.from(sha512("hello", "hex"), "hex").toString("base64"),
      );
      expect(sha512("hello", "base64url")).toBe(
        Buffer.from(sha512("hello", "hex"), "hex").toString("base64url"),
      );
      expect(md5("hello")).toBe("5d41402abc4b2a76b9719d911017c592");
      expect(md5(new TextEncoder().encode("hello"))).toBe(
        "5d41402abc4b2a76b9719d911017c592",
      );
    });

    it("computes deterministic fastHash (xxHash64) and crc32", () => {
      const h1 = fastHash("bunest-cache-key");
      const h2 = fastHash(new TextEncoder().encode("bunest-cache-key"));
      const h3 = fastHash("bunest-cache-key", 42n);
      expect(typeof h1).toBe("bigint");
      expect(h1).toBe(h2);
      expect(h1).not.toBe(h3);

      expect(crc32("123456789")).toBe(0xcbf43926);
      expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    });
  });

  describe("SIMD string helpers", () => {
    it("escapes HTML, strips ANSI codes, and measures terminal width", () => {
      expect(escapeHtml(`<script>"a" & 'b'</script>`)).toBe(
        "&lt;script&gt;&quot;a&quot; &amp; &#x27;b&#x27;&lt;/script&gt;",
      );
      expect(stripAnsi("\u001b[32mOK\u001b[0m bunest")).toBe("OK bunest");
      expect(stringWidth("\u001b[31mhello\u001b[0m")).toBe(5);
      expect(stringWidth("日本語")).toBe(6);
    });
  });

  describe("native async helpers", () => {
    it("creates deferred via Promise.withResolvers and peeks settled promises", async () => {
      const d = deferred<number>();
      expect(isPromiseFulfilled(d.promise)).toBe(false);
      expect(peekPromise(d.promise)).toBe(d.promise);

      d.resolve(42);
      expect(await d.promise).toBe(42);
      expect(isPromiseFulfilled(d.promise)).toBe(true);
      expect(peekPromise(d.promise)).toBe(42);
      expect(peekPromise("sync-value")).toBe("sync-value");
    });

    it("sleeps cleanly without AbortSignal using Bun.sleep", async () => {
      const start = performance.now();
      await sleep(10);
      expect(performance.now() - start).toBeGreaterThanOrEqual(5);
    });
  });

  describe("native stream & binary helpers", () => {
    it("consumes ReadableStream to bytes, text, and JSON", async () => {
      const makeStream = (text: string) =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(text.slice(0, 4)));
            controller.enqueue(new TextEncoder().encode(text.slice(4)));
            controller.close();
          },
        });

      const bytes = await streamToBytes(makeStream("hello world"));
      expect(bytes).toBeInstanceOf(Uint8Array);
      expect(new TextDecoder().decode(bytes)).toBe("hello world");

      expect(await streamToText(makeStream("bunest native"))).toBe(
        "bunest native",
      );
      expect(
        await streamToJson<{ ok: boolean; count: number }>(
          makeStream('{"ok":true,"count":7}'),
        ),
      ).toEqual({ ok: true, count: 7 });
    });

    it("concatenates Uint8Array and ArrayBuffer chunks via Bun.concatArrayBuffers", () => {
      expect(concatBytes([])).toEqual(new Uint8Array(0));
      const a = new Uint8Array([1, 2, 3]);
      const b = new Uint8Array([4, 5]).buffer;
      const c = new Uint8Array([6]);
      expect(concatBytes([a, b, c])).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]));
    });

    it("compares Uint8Array and Buffer structurally in deepEqual", () => {
      expect(
        deepEqual(new Uint8Array([1, 2, 3]), Buffer.from([1, 2, 3])),
      ).toBe(true);
      expect(deepEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(
        false,
      );
      expect(deepEqual(+0, -0)).toBe(true);
      expect(deepEqual(new Date(Number.NaN), new Date(Number.NaN))).toBe(true);
    });
  });

  it("re-exports all Bun-native utils and unified withTimeout identically from @bunest/core/common and @bunest/core", () => {
    const names = [
      "concatBytes",
      "crc32",
      "escapeHtml",
      "fastHash",
      "isPromiseFulfilled",
      "md5",
      "peekPromise",
      "sha512",
      "streamToBytes",
      "streamToJson",
      "streamToText",
      "stringWidth",
      "stripAnsi",
      "withTimeout",
    ] as const;
    const expected: Record<(typeof names)[number], unknown> = {
      concatBytes,
      crc32,
      escapeHtml,
      fastHash,
      isPromiseFulfilled,
      md5,
      peekPromise,
      sha512,
      streamToBytes,
      streamToJson,
      streamToText,
      stringWidth,
      stripAnsi,
      withTimeout,
    };
    for (const name of names) {
      expect<unknown>(commonExports[name]).toBe(expected[name]);
      expect<unknown>(coreExports[name]).toBe(expected[name]);
    }
  });
});
