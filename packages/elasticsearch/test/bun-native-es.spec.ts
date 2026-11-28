import { describe, expect, it } from "bun:test";
import { ElasticsearchTransport } from "../src/transport/elasticsearch-transport";

describe("Wave 7 — @bunest/elasticsearch Bun 1.4.5 Native APIs (Bun.zstdCompress, Bun.JSONL)", () => {
  it("compresses request bodies with zstd when compression: 'zstd' and parses application/x-ndjson responses via Bun.JSONL", async () => {
    let seenEncoding: string | null = null;
    let decompressedReqBody = "";

    const transport = new ElasticsearchTransport({
      node: "http://localhost:9200",
      compression: "zstd",
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        seenEncoding = headers.get("content-encoding");
        if (init?.body instanceof Uint8Array) {
          decompressedReqBody = new TextDecoder().decode(
            await Bun.zstdDecompress(init.body),
          );
        }
        return new Response('{"took":1,"id":"a"}\n{"took":2,"id":"b"}\n', {
          status: 200,
          headers: { "content-type": "application/x-ndjson" },
        });
      }) as typeof fetch,
    });

    const res = await transport.request<Array<{ took: number; id: string }>>({
      method: "POST",
      path: "/_bulk",
      body: [{ index: { _index: "docs" } }, { title: "Bunest" }],
      ndjson: true,
    });

    expect(seenEncoding as string | null).toBe("zstd");
    expect(decompressedReqBody).toContain('"title":"Bunest"');
    expect(res.body).toEqual([
      { took: 1, id: "a" },
      { took: 2, id: "b" },
    ]);
  });

  it("supports gzip compression, per-request overrides, application/jsonl, ndjsonResponse, malformed fallback, prototype protection, and omits body headers on GET", async () => {
    const seenEncodings: Array<string | null> = [];
    let getContentType: string | null = null;
    let getContentEncoding: string | null = null;

    const transport = new ElasticsearchTransport({
      node: "http://localhost:9200",
      compression: true,
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        const u = String(url);
        const headers = new Headers(init?.headers);
        seenEncodings.push(headers.get("content-encoding"));

        if (u.includes("/_get-with-body")) {
          getContentType = headers.get("content-type");
          getContentEncoding = headers.get("content-encoding");
          return new Response('{"ok":true}', {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (u.includes("/_jsonl")) {
          return new Response(
            '{"__proto__":{"polluted":true},"id":1}\n{"constructor":{"x":1},"id":2}\n',
            {
              status: 200,
              headers: { "content-type": "application/jsonl" },
            },
          );
        }
        if (u.includes("/_forced-ndjson")) {
          return new Response('{"n":10}\n{"n":20}\n', {
            status: 200,
            headers: { "content-type": "text/plain" },
          });
        }
        if (u.includes("/_bad-ndjson")) {
          return new Response("{not valid jsonl\n", {
            status: 200,
            headers: { "content-type": "application/x-ndjson" },
          });
        }
        if (init?.body instanceof Uint8Array && headers.get("content-encoding") === "gzip") {
          const inflated = new TextDecoder().decode(
            Bun.gunzipSync(init.body as Uint8Array<ArrayBuffer>),
          );
          return new Response(JSON.stringify({ inflated }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response('{"ok":true}', {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    });

    // Default `compression: true` -> gzip
    const gzipRes = await transport.request<{ inflated: string }>({
      method: "POST",
      path: "/_doc",
      body: { msg: "hello-gzip" },
    });
    expect(seenEncodings[0]).toBe("gzip");
    expect(gzipRes.body.inflated).toBe('{"msg":"hello-gzip"}');

    // Per-request override to zstd
    await transport.request(
      { method: "POST", path: "/_doc", body: { msg: "override" } },
      { compression: "zstd" },
    );
    expect(seenEncodings[1]).toBe("zstd");

    // GET request with body + compression must NOT send content-encoding or content-type
    await transport.request(
      { method: "GET", path: "/_get-with-body", body: { query: {} } },
      { compression: "zstd" },
    );
    expect(getContentEncoding).toBeNull();
    expect(getContentType).toBeNull();

    // application/jsonl strips dangerous __proto__ / constructor keys
    const jsonlRes = await transport.request<Array<Record<string, unknown>>>({
      method: "GET",
      path: "/_jsonl",
    });
    expect(jsonlRes.body.length).toBe(2);
    expect(Object.prototype.hasOwnProperty.call(jsonlRes.body[0], "__proto__")).toBe(
      false,
    );
    expect(
      Object.prototype.hasOwnProperty.call(jsonlRes.body[1], "constructor"),
    ).toBe(false);

    // Explicit ndjsonResponse: true parses non-ndjson content-type as JSONL
    const forced = await transport.request<Array<{ n: number }>>(
      { method: "GET", path: "/_forced-ndjson" },
      { ndjsonResponse: true },
    );
    expect(forced.body).toEqual([{ n: 10 }, { n: 20 }]);

    // Malformed NDJSON falls back cleanly to raw string
    const malformed = await transport.request<string>({
      method: "GET",
      path: "/_bad-ndjson",
    });
    expect(malformed.body).toBe("{not valid jsonl\n");
  });
});
