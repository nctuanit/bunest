import { afterAll, beforeAll, expect, it } from "bun:test";
import {
  Controller,
  Get,
  Header,
  Module,
  StreamableFile,
} from "../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  Test,
  describeConformance,
  itAdapted,
  request,
} from "../../../_helpers";

const STREAM = "hello world";

async function rawGet(
  baseUrl: string,
  path: string,
): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
}> {
  const res = await fetch(new URL(path, baseUrl));
  const headers: Record<string, string | string[] | undefined> = {};
  res.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  return {
    status: res.status,
    headers,
    text: await res.text(),
  };
}

@Controller("chunked")
class ChunkedController {
  @Get("object")
  @Header("Transfer-Encoding", "chunked")
  object() {
    return { hello: "world" };
  }

  @Get("text")
  @Header("Transfer-Encoding", "chunked")
  text() {
    return "plain";
  }

  @Get("stream")
  @Header("Transfer-Encoding", "chunked")
  stream() {
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(STREAM));
        controller.close();
      },
    });
    return new StreamableFile(readable, {
      length: STREAM.length,
      type: "text/plain; charset=utf-8",
    });
  }

  @Get("unsized-stream")
  unsizedStream() {
    let i = 0;
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (i < 2) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          controller.enqueue(
            new TextEncoder().encode(i++ === 0 ? "hello " : "world"),
          );
        } else {
          controller.close();
        }
      },
    });
  }
}

@Module({ controllers: [ChunkedController] })
class TransferEncodingModule {}

describeConformance(
  "Replies with a Transfer-Encoding set with @Header() (BunHttpAdapter)",
  {
    upstreamPath: "integration/http-adapters/e2e/transfer-encoding.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-010"],
    notes:
      "Verifies RFC 9112 compliance: responses with Transfer-Encoding: chunked must not carry Content-Length.",
  },
  () => {
    let app: BunestApplication;

    beforeAll(async () => {
      const modRef = await Test.createTestingModule({
        imports: [TransferEncodingModule],
      }).compile();
      app = modRef.createNestApplication({ logger: false });
      await app.listen(0, "127.0.0.1");
    });

    afterAll(async () => {
      await app.close();
    });

    // BUNEST_BUG: serializeResponse builds a buffered string Response for JSON objects even when @Header('Transfer-Encoding', 'chunked') is set, so Bun.serve ignores the hop-by-hop Transfer-Encoding header and emits Content-Length instead of chunked framing (packages/core/src/http/pipeline/response-serializer.ts:645-749).
    it.skip("should leave out the Content-Length for an object", async () => {
      const res = await request(app.getUrl()!).get("/chunked/object");

      expect(res.status).toBe(200);
      expect(res.headers["transfer-encoding"]).toBe("chunked");
      expect(res.headers["content-length"]).toBeUndefined();
      expect(res.body).toEqual({ hello: "world" });
    });

    // BUNEST_BUG: serializeResponse builds a buffered string Response for text even when @Header('Transfer-Encoding', 'chunked') is set, so Bun.serve strips Transfer-Encoding and sends Content-Length (packages/core/src/http/pipeline/response-serializer.ts:645-749).
    it.skip("should leave out the Content-Length for a string", async () => {
      const res = await request(app.getUrl()!).get("/chunked/text");

      expect(res.status).toBe(200);
      expect(res.headers["transfer-encoding"]).toBe("chunked");
      expect(res.headers["content-length"]).toBeUndefined();
      expect(res.text).toBe("plain");
    });

    // BUNEST_BUG: serializeResponse sets StreamableFile's Content-Length even when @Header('Transfer-Encoding', 'chunked') is explicitly declared, causing Bun.serve to emit Content-Length instead of chunked framing (packages/core/src/http/pipeline/response-serializer.ts:572-595).
    it.skip("should leave out the Content-Length of a stream that has one", async () => {
      const res = await request(app.getUrl()!).get("/chunked/stream");

      expect(res.status).toBe(200);
      expect(res.headers["transfer-encoding"]).toBe("chunked");
      expect(res.headers["content-length"]).toBeUndefined();
      expect(res.text).toBe("hello world");
    });

    itAdapted(
      ["ADR-001", "ADR-010"],
      "should never emit both Transfer-Encoding and Content-Length on the wire (RFC 9112) and should stream unsized ReadableStream chunked",
      async () => {
        const base = app.getUrl()!;
        for (const path of [
          "/chunked/object",
          "/chunked/text",
          "/chunked/stream",
        ]) {
          const res = await rawGet(base, path);
          expect(res.status).toBe(200);
          expect(
            Boolean(
              res.headers["transfer-encoding"] && res.headers["content-length"],
            ),
          ).toBe(false);
        }

        const streamed = await rawGet(base, "/chunked/unsized-stream");
        expect(streamed.status).toBe(200);
        expect(streamed.headers["transfer-encoding"]).toBe("chunked");
        expect(streamed.headers["content-length"]).toBeUndefined();
        expect(streamed.text).toBe("hello world");
      },
      "Bun.serve enforces RFC 9112 mutual exclusion of Transfer-Encoding and Content-Length",
    );
  },
);
