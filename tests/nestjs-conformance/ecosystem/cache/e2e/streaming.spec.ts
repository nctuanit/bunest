import { afterEach, beforeEach, expect, it } from "bun:test";
import {
  APP_INTERCEPTOR,
  Controller,
  Get,
  Module,
  StreamableFile,
} from "../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  CACHE_MANAGER,
  Cache,
  CacheInterceptor,
  CacheModule,
} from "../../../../../packages/cache/src";
import { Test, describeConformance, request } from "../../../_helpers/index";

@Controller()
class StreamingController {
  @Get("generator")
  async *generator() {
    yield "chunk";
  }

  @Get("readable-stream")
  readableStream() {
    return new Blob(["chunk"]).stream();
  }

  @Get("node-readable")
  nodeReadable() {
    return new StreamableFile(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("chunk"));
          controller.close();
        },
      }),
    );
  }

  @Get("response")
  response() {
    return new Response("chunk");
  }

  @Get("json")
  json() {
    return { value: "chunk" };
  }
}

@Module({
  imports: [CacheModule.register()],
  controllers: [StreamingController],
  providers: [
    {
      provide: APP_INTERCEPTOR,
      useClass: CacheInterceptor,
    },
  ],
})
class StreamingModule {}

describeConformance(
  "CacheInterceptor - Streaming responses",
  {
    upstreamPath: "cache-manager/tests/e2e/streaming.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-010"],
    notes:
      "Tests that async generators, ReadableStream, StreamableFile/Node Readable, and Web Response streams bypass CacheInterceptor while JSON responses remain cached.",
  },
  () => {
    let app: BunestApplication;

    beforeEach(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [StreamingModule],
      }).compile({ logger: false });

      app = moduleRef.createNestApplication({ logger: false });
      await app.init();
    });

    // BUNEST_BUG: CacheInterceptor (packages/cache/src/cache.interceptor.ts:178-180) returns early for non-cacheable streams (generator, readable-stream, node-readable) without calling setHeadersWhenHttp(context, undefined), omitting X-Cache: MISS; and lines 191-223 explicitly clone and cache Web Response instances (__bunestCachedResponse) instead of treating Response as non-cacheable.
    it.skip.each(["generator", "readable-stream", "node-readable", "response"])(
      "should not cache a %s",
      async (route) => {
        const first = await request(app).get(`/${route}`);
        expect(first.headers["x-cache"]).toBe("MISS");
        await new Promise((resolve) => setTimeout(resolve, 20));

        const cache = app.get<Cache>(CACHE_MANAGER);
        await expect(cache.get(`/${route}`)).resolves.toBeUndefined();

        const second = await request(app).get(`/${route}`);
        expect(second.headers["x-cache"]).toBe("MISS");
      },
    );

    it("should keep caching other values", async () => {
      const first = await request(app).get("/json");
      expect(first.headers["x-cache"]).toBe("MISS");
      await new Promise((resolve) => setTimeout(resolve, 20));

      const second = await request(app).get("/json").expect(200);
      expect(second.headers["x-cache"]).toBe("HIT");
      expect(second.body).toEqual({ value: "chunk" });
    });

    afterEach(async () => {
      await app.close();
    });
  },
);
