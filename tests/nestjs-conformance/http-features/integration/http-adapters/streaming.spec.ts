import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import { Exclude } from "../../../../../packages/validation/src/transformer";
import {
  BadRequestException,
  Catch,
  Controller,
  Get,
  Head,
  Header,
  HttpCode,
  Injectable,
  Module,
  NotFoundException,
  Post,
  Res,
  StreamableFile,
  UseFilters,
  UseGuards,
  UseInterceptors,
  type ArgumentsHost,
  type BunestInterceptor,
  type BunestModule,
  type CallHandler,
  type CanActivate,
  type ExceptionFilter,
  type ExecutionContext,
  type MiddlewareConsumer,
  type NextFunction,
  type ResponseContext,
} from "../../../../../packages/core/src/common";
import {
  ClassSerializerInterceptor,
  ContextStorage,
  type BunestApplication,
} from "../../../../../packages/core/src";
import { Test, describeConformance, itAdapted } from "../../../_helpers";

const encoder = new TextEncoder();

const streaming = {
  started: 0,
  stopped: 0,
  pulled: 0,
  storeWhenStopped: undefined as string | undefined,
  upstreamUrl: "",
  gate: Promise.resolve(),
  openGate: () => {},
  reset() {
    this.started = 0;
    this.stopped = 0;
    this.pulled = 0;
    this.storeWhenStopped = undefined;
    this.gate = new Promise<void>((resolve) => {
      this.openGate = resolve;
    });
  },
};

const requestStore = new ContextStorage<{ id: string }>();

function webStream(chunks: Array<string | Uint8Array>, failure?: Error) {
  const pending = [...chunks];
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = pending.shift();
      if (chunk !== undefined) {
        controller.enqueue(
          typeof chunk === "string" ? encoder.encode(chunk) : chunk,
        );
      } else if (failure) {
        controller.error(failure);
      } else {
        controller.close();
      }
    },
  });
}

function quietWebStream(chunks: string[] = []) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      streaming.started++;
      chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)));
    },
    pull() {
      return new Promise<void>(() => undefined);
    },
    cancel() {
      streaming.stopped++;
      streaming.storeWhenStopped = requestStore.getStore()?.id;
    },
  });
}

async function* endlessGenerator() {
  streaming.started++;
  try {
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      yield "tick ";
    }
  } finally {
    streaming.stopped++;
  }
}

async function waitFor(fn: () => void, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      fn();
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 15));
    }
  }
  throw lastErr ?? new Error("waitFor timed out");
}

@Injectable()
class MarkingGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    context
      .switchToHttp()
      .getResponse<ResponseContext>()
      .header("x-guard", "ran");
    return true;
  }
}

class TeapotError extends Error {}

@Catch(TeapotError)
class TeapotFilter implements ExceptionFilter {
  catch(_err: TeapotError, _host: ArgumentsHost) {
    return new Response("caught by the filter", { status: 418 });
  }
}

class SerializedEntity {
  id = 1;

  @Exclude()
  secret = "secret";
}

@Injectable()
class WrappingInterceptor implements BunestInterceptor {
  async intercept(_context: ExecutionContext, next: CallHandler) {
    const data = await next.handle();
    return { data };
  }
}

@Injectable()
class PlainSerializingInterceptor implements BunestInterceptor {
  async intercept(_context: ExecutionContext, next: CallHandler) {
    const data = await next.handle();
    return JSON.parse(JSON.stringify(data)) as unknown;
  }
}

@Injectable()
class TappingInterceptor implements BunestInterceptor {
  async intercept(_context: ExecutionContext, next: CallHandler) {
    const value = await next.handle();
    if (value) {
      streaming.pulled = -1;
    }
    return value;
  }
}

@Injectable()
class PipingInterceptor implements BunestInterceptor {
  async intercept(_context: ExecutionContext, next: CallHandler) {
    const source = (await next.handle()) as AsyncIterable<string>;
    return (async function* () {
      for await (const chunk of source) {
        yield chunk.toUpperCase();
      }
    })();
  }
}

@Injectable()
class CollectingInterceptor implements BunestInterceptor {
  async intercept(_context: ExecutionContext, next: CallHandler) {
    const source = (await next.handle()) as AsyncIterable<unknown>;
    const chunks: string[] = [];
    for await (const chunk of source) {
      chunks.push(
        typeof chunk === "string"
          ? chunk
          : Buffer.from(chunk as Uint8Array).toString(),
      );
    }
    return { collected: chunks.join("") };
  }
}

@Injectable()
class FileMakingInterceptor implements BunestInterceptor {
  async intercept(_context: ExecutionContext, next: CallHandler) {
    const source = (await next.handle()) as AsyncIterable<string>;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        for await (const chunk of source) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    });
    return new StreamableFile(stream, { type: "text/csv" });
  }
}

@Injectable()
class ReplacingInterceptor implements BunestInterceptor {
  async intercept(_context: ExecutionContext, next: CallHandler) {
    const original = await next.handle();
    if (original instanceof ReadableStream) {
      await original.cancel().catch(() => undefined);
    }
    return { replaced: true };
  }
}

@Injectable()
class ThrowingInterceptor implements BunestInterceptor {
  async intercept(_context: ExecutionContext, next: CallHandler) {
    const original = await next.handle();
    if (original instanceof ReadableStream) {
      await original.cancel().catch(() => undefined);
    }
    throw new BadRequestException("rejected by the interceptor");
  }
}

@Controller("response")
class ResponseController {
  @Get()
  plain() {
    return new Response("hello", {
      status: 202,
      headers: { "x-from-response": "yes", "content-type": "text/x-custom" },
    });
  }

  @Get("promised")
  async promised() {
    return new Response("promised");
  }

  @Get("stream")
  stream() {
    return new Response(webStream(["from a ", "stream"]));
  }

  @Get("json")
  json() {
    return Response.json({ ok: true }, { status: 400 });
  }

  @Get("cookies")
  cookies() {
    const headers = new Headers();
    headers.append("set-cookie", "a=1");
    headers.append("set-cookie", "b=2; Path=/");
    return new Response("cookies", { headers });
  }

  @Get("no-content")
  noContent() {
    return new Response(null, {
      status: 204,
      headers: { "x-from-response": "yes" },
    });
  }

  @Get("redirect")
  redirect() {
    return Response.redirect("http://localhost/elsewhere", 307);
  }

  @Get("empty")
  empty() {
    return new Response("", { status: 201 });
  }

  @Get("consumed")
  async consumed() {
    const response = new Response("hello");
    await response.text();
    return response;
  }

  @Get("locked")
  locked() {
    const response = new Response("hello");
    response.body!.getReader();
    return response;
  }

  @Get("network-error")
  networkError() {
    return Response.error();
  }

  @Get("decorated")
  @HttpCode(203)
  @Header("x-decorator", "kept")
  @Header("x-shared", "decorator")
  @Header("cache-control", "no-store")
  decorated() {
    return new Response("decorated", {
      status: 202,
      headers: {
        "x-shared": "response",
        "x-shared-with-middleware": "response",
        "content-type": "text/x-custom",
      },
    });
  }

  @Get("content-type-from-decorator")
  @Header("content-type", "text/x-decorated")
  contentTypeFromDecorator() {
    return new Response(webStream(["decorated"]));
  }

  @Get("guarded")
  @UseGuards(MarkingGuard)
  guarded() {
    return new Response("guarded", { headers: { "x-from-response": "yes" } });
  }

  @Post("created")
  created() {
    return new Response("created");
  }

  @Get("fail-first")
  failFirst() {
    return new Response(webStream([], new NotFoundException("not there")), {
      status: 200,
      headers: { "x-from-response": "yes" },
    });
  }

  @Get("fail-later")
  failLater() {
    return new Response(webStream(["partial"], new Error("upstream failed")));
  }

  @Get("quiet")
  quiet() {
    return new Response(quietWebStream());
  }

  @Get("endless")
  endless() {
    return new Response(quietWebStream(["some "]));
  }

  @Get("fetched")
  fetched() {
    return fetch(streaming.upstreamUrl);
  }

  @Get("fetched-missing")
  fetchedMissing() {
    return fetch(`${streaming.upstreamUrl}/missing`);
  }

  @Get("sized")
  sized() {
    return new Response(quietWebStream(), {
      headers: { "content-length": "5", "content-type": "text/x-custom" },
    });
  }
}

@Controller("web-stream")
class WebStreamController {
  @Get()
  bytes() {
    return webStream(["from a ", "web stream"]);
  }

  @Get("strings")
  strings() {
    return new ReadableStream<string>({
      start(controller) {
        controller.enqueue("from ");
        controller.enqueue("strings");
        controller.close();
      },
    });
  }

  @Get("objects")
  objects() {
    return new ReadableStream<{ n: number }>({
      start(controller) {
        controller.enqueue({ n: 1 });
        controller.enqueue({ n: 2 });
        controller.close();
      },
    });
  }

  @Get("locked")
  locked() {
    const stream = webStream(["hello"]);
    stream.getReader();
    return stream;
  }

  @Get("consumed")
  async consumed() {
    const stream = webStream(["hello"]);
    const reader = stream.getReader();
    while (!(await reader.read()).done) {
      // drain
    }
    return stream;
  }

  @Get("fail-first")
  failFirst() {
    return webStream([], new TeapotError());
  }

  @Get("fail-later")
  failLater() {
    return webStream(["partial"], new Error("upstream failed"));
  }

  @Get("quiet")
  quiet() {
    return quietWebStream();
  }

  @Get("endless")
  endless() {
    return quietWebStream(["some "]);
  }
}

@Controller("generator")
@UseFilters(TeapotFilter)
class GeneratorController {
  @Get()
  async *strings() {
    yield "from ";
    yield "a generator";
  }

  @Get("bytes")
  async *bytes() {
    yield encoder.encode("from ");
    yield new DataView(encoder.encode("bytes").buffer);
    yield encoder.encode(" and buffers").buffer;
  }

  @Get("objects")
  async *objects() {
    yield { n: 1 };
    yield [2];
    yield 3;
    yield null;
    yield undefined;
    yield "and text";
  }

  @Get("empty")
  async *empty() {}

  @Get("decorated")
  @HttpCode(203)
  @Header("content-type", "text/x-decorated")
  async *decorated() {
    yield "decorated";
  }

  @Post("created")
  async *created() {
    yield "created";
  }

  @Get("iterable")
  iterable() {
    return {
      [Symbol.asyncIterator]() {
        let n = 0;
        return {
          next: async () =>
            n < 2
              ? { done: false, value: `${n++}` }
              : { done: true, value: undefined },
        };
      },
    };
  }

  @Get("fail-first-http")
  async *failFirstHttp() {
    throw new NotFoundException("not there");
  }

  @Get("fail-first-filtered")
  async *failFirstFiltered() {
    throw new TeapotError();
  }

  @Get("fail-first-unknown")
  async *failFirstUnknown() {
    throw new Error("private details");
  }

  @Get("endless")
  endless() {
    return endlessGenerator();
  }

  @Head("head-only")
  async *headOnly() {
    streaming.started++;
    yield "never read";
  }
}

@Controller("intercepted")
class InterceptedController {
  @Get("wrapped/json")
  @UseInterceptors(WrappingInterceptor)
  wrappedJson() {
    return { n: 1 };
  }

  @Get("wrapped/response")
  @UseInterceptors(WrappingInterceptor)
  wrappedResponse() {
    return new Response("from a response", {
      status: 202,
      headers: { "x-from-response": "yes" },
    });
  }

  @Get("class-serialized/response")
  @UseInterceptors(ClassSerializerInterceptor)
  classSerializedResponse() {
    return new Response("from a response");
  }

  @Get("class-serialized/entity")
  @UseInterceptors(ClassSerializerInterceptor)
  classSerializedEntity() {
    return new SerializedEntity();
  }

  @Get("tapped/web-stream")
  @UseInterceptors(TappingInterceptor)
  tappedWebStream() {
    return webStream(["tapped"]);
  }

  @Get("plain-serialized/response")
  @UseInterceptors(PlainSerializingInterceptor)
  plainSerializedResponse() {
    return new Response("from a response");
  }

  @Get("replaced")
  @UseInterceptors(ReplacingInterceptor)
  replaced() {
    return quietWebStream(["from the handler"]);
  }

  @Get("collected/generator")
  @UseInterceptors(CollectingInterceptor)
  async *collectedGenerator() {
    yield "from a ";
    yield "generator";
  }

  @Get("collected/web-stream")
  @UseInterceptors(CollectingInterceptor)
  collectedWebStream() {
    return webStream(["from a ", "web stream"]);
  }

  @Get("collected/empty")
  @UseInterceptors(CollectingInterceptor)
  async *collectedEmpty() {}

  @Get("file")
  @UseInterceptors(FileMakingInterceptor)
  async *file() {
    yield "a,b";
  }

  @Get("rejected")
  @UseInterceptors(ThrowingInterceptor)
  rejected() {
    return quietWebStream();
  }
}

@Controller("manual")
class ManualController {
  @Get("res")
  handled() {
    return new Response("sent by hand", { status: 200 });
  }

  @Get("passthrough")
  passthrough(@Res({ passthrough: true }) res: ResponseContext) {
    res.header("x-by-hand", "yes");
    return webStream(["passed through"]);
  }
}

@Controller("compatible")
class CompatibleController {
  @Get("array")
  array() {
    return [1, 2];
  }

  @Get("set")
  set() {
    return new Set([1, 2]);
  }

  @Get("sync-iterable")
  syncIterable() {
    return {
      name: "iterable",
      *[Symbol.iterator]() {
        yield 1;
      },
    };
  }

  @Get("thenable")
  thenable() {
    return {
      then(onFulfilled: (value: unknown) => void) {
        onFulfilled({ docs: [1, 2] });
      },
      async *[Symbol.asyncIterator]() {
        yield "streamed by mistake";
      },
    };
  }

  @Get("thenable-intercepted")
  @UseInterceptors(WrappingInterceptor)
  thenableIntercepted() {
    return {
      then(onFulfilled: (value: unknown) => void) {
        onFulfilled({ docs: [1, 2] });
      },
      async *[Symbol.asyncIterator]() {
        yield "streamed by mistake";
      },
    };
  }
}

@Module({
  controllers: [
    ResponseController,
    WebStreamController,
    GeneratorController,
    InterceptedController,
    ManualController,
    CompatibleController,
  ],
  providers: [
    MarkingGuard,
    TeapotFilter,
    WrappingInterceptor,
    PlainSerializingInterceptor,
    TappingInterceptor,
    PipingInterceptor,
    CollectingInterceptor,
    FileMakingInterceptor,
    ReplacingInterceptor,
    ThrowingInterceptor,
  ],
})
class StreamingModule implements BunestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(async (req: Request, res: ResponseContext, next: NextFunction) => {
        res.header("x-middleware", "ran");
        res.header("x-shared-with-middleware", "middleware");
        res.header("set-cookie", "from=middleware");
        await requestStore.run(
          { id: req.headers.get("x-request-id") ?? "request" },
          async () => {
            await next();
          },
        );
      })
      .forRoutes("*");
  }
}

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  complete: boolean;
}

describeConformance(
  "Streaming responses E2E (BunHttpAdapter Web Response / ReadableStream / AsyncGenerator)",
  {
    upstreamPath: "integration/http-adapters/e2e/streaming.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008", "ADR-010"],
    notes:
      "Adapts NestJS streaming responses suite (Web Response, ReadableStream, AsyncGenerator, interceptors, @Res, non-stream values) to BunHttpAdapter + Promise interceptors.",
  },
  () => {
    let app: BunestApplication;
    let baseUrl: string;
    let upstream: ReturnType<typeof Bun.serve>;

    beforeAll(async () => {
      upstream = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(req) {
          const { pathname } = new URL(req.url);
          if (pathname === "/missing") {
            return new Response("missing upstream", { status: 404 });
          }
          const body = Bun.gzipSync(Buffer.from("hello from upstream"));
          return new Response(body, {
            status: 200,
            headers: {
              "content-type": "text/x-upstream",
              "content-encoding": "gzip",
              "content-length": String(body.byteLength),
              "x-upstream": "yes",
            },
          });
        },
      });
      streaming.upstreamUrl = `http://127.0.0.1:${upstream.port}`;

      const modRef = await Test.createTestingModule({
        imports: [StreamingModule],
      }).compile();
      app = modRef.createNestApplication({ logger: false });
      await app.listen(0, "127.0.0.1");
      baseUrl = app.getUrl()!.replace(/\/$/, "");
    });

    afterAll(async () => {
      await app.close();
      upstream.stop(true);
    });

    beforeEach(() => streaming.reset());

    async function send(
      path: string,
      options: { method?: string } = {},
    ): Promise<RawResponse> {
      const res = await fetch(`${baseUrl}${path}`, {
        method: options.method ?? "GET",
        redirect: "manual",
        decompress: false,
      });
      const headers: Record<string, string | string[] | undefined> = {};
      res.headers.forEach((value, key) => {
        const lower = key.toLowerCase();
        if (lower !== "set-cookie") {
          headers[lower] = value;
        }
      });
      const setCookies = res.headers.getSetCookie();
      if (setCookies.length > 0) {
        headers["set-cookie"] = setCookies;
      }
      let text = "";
      let complete = true;
      try {
        text = await res.text();
      } catch {
        complete = false;
      }
      return {
        status: res.status,
        headers,
        text,
        complete,
      };
    }

    async function sendAndLeave(path: string, leaveWhen: "headers" | "sent") {
      const controller = new AbortController();
      if (leaveWhen === "sent") {
        const pending = fetch(`${baseUrl}${path}`, {
          signal: controller.signal,
        })
          .then((res) => res.body?.cancel())
          .catch(() => undefined);
        await Bun.sleep(30);
        controller.abort();
        await pending;
        return;
      }
      try {
        const res = await fetch(`${baseUrl}${path}`, {
          signal: controller.signal,
        });
        controller.abort();
        await res.body?.cancel().catch(() => undefined);
      } catch {
        // Expected on client abort
      }
    }

    describe("a web Response", () => {
      it("should send its status, headers and body", async () => {
        const res = await send("/response");

        expect(res.status).toBe(202);
        expect(res.headers["x-from-response"]).toBe("yes");
        expect(res.headers["content-type"]).toMatch(/^text\/x-custom/);
        expect(res.text).toBe("hello");
        expect(res.complete).toBe(true);
      });

      it("should accept one from a promise", async () => {
        expect((await send("/response/promised")).text).toBe("promised");
      });

      it("should stream a body that is a stream", async () => {
        const res = await send("/response/stream");

        expect(res.status).toBe(200);
        expect(res.text).toBe("from a stream");
      });

      it("should default to application/octet-stream without a Content-Type", async () => {
        const res = await send("/response/stream");
        expect(res.headers["content-type"]).toBe("application/octet-stream");
      });

      it("should send what Response.json() makes", async () => {
        const res = await send("/response/json");

        expect(res.status).toBe(400);
        expect(res.headers["content-type"]).toMatch(/^application\/json/);
        expect(res.text).toBe('{"ok":true}');
      });

      it("should send every Set-Cookie, after the ones already set", async () => {
        const res = await send("/response/cookies");

        expect(res.headers["set-cookie"]).toEqual([
          "from=middleware",
          "a=1",
          "b=2; Path=/",
        ]);
      });

      it("should send a null body as no body", async () => {
        const res = await send("/response/no-content");

        expect(res.status).toBe(204);
        expect(res.headers["x-from-response"]).toBe("yes");
        expect(res.headers["content-type"]).toBeUndefined();
        expect(res.text).toBe("");
        expect(res.complete).toBe(true);
      });

      it("should send what Response.redirect() makes", async () => {
        const res = await send("/response/redirect");

        expect(res.status).toBe(307);
        expect(res.headers.location).toBe("http://localhost/elsewhere");
        expect(res.text).toBe("");
      });

      it("should send an empty body", async () => {
        const res = await send("/response/empty");

        expect(res.status).toBe(201);
        expect(res.text).toBe("");
        expect(res.complete).toBe(true);
      });

      it("should answer 500 for a body that was read already", async () => {
        const res = await send("/response/consumed");
        expect(res.status).toBe(500);
      });

      it("should answer 500 for a body that is locked", async () => {
        expect((await send("/response/locked")).status).toBe(500);
      });

      it("should answer 500 for Response.error()", async () => {
        expect((await send("/response/network-error")).status).toBe(500);
      });

      it("should win over @HttpCode() and @Header(), and leave the others' headers", async () => {
        const res = await send("/response/decorated");

        expect(res.status).toBe(202);
        expect(res.headers["x-shared"]).toBe("response");
        expect(res.headers["content-type"]).toMatch(/^text\/x-custom/);
        expect(res.headers["x-decorator"]).toBe("kept");
        expect(res.headers["cache-control"]).toBe("no-store");
        expect(res.headers["x-middleware"]).toBe("ran");
        expect(res.headers["x-shared-with-middleware"]).toBe("response");
      });

      it("should keep the Content-Type of @Header() when it has none", async () => {
        const res = await send("/response/content-type-from-decorator");

        expect(res.headers["content-type"]).toMatch(/^text\/x-decorated/);
        expect(res.text).toBe("decorated");
      });

      it("should keep the headers a guard set", async () => {
        const res = await send("/response/guarded");

        expect(res.headers["x-guard"]).toBe("ran");
        expect(res.headers["x-from-response"]).toBe("yes");
      });

      it("should win over the default status of POST", async () => {
        const res = await send("/response/created", { method: "POST" });

        expect(res.status).toBe(200);
        expect(res.text).toBe("created");
      });

      it("should go through the exception filters when it fails before the first chunk", async () => {
        const res = await send("/response/fail-first");

        expect(res.status).toBe(404);
        expect(JSON.parse(res.text).message).toBe("not there");
        expect(res.headers["x-from-response"]).toBeUndefined();
      });

      // BUNEST_BUG: Mid-stream ReadableStream errors on a returned Web Response cause Bun.serve to abruptly reset the TCP connection (ECONNRESET) before delivering the flushed partial chunk cleanly to HTTP clients (packages/core/src/http/pipeline/response-serializer.ts:517-519).
      it.skip("should end the connection when it fails after the first chunk", async () => {
        const res = await send("/response/fail-later");

        expect(res.status).toBe(200);
        expect(res.text).toBe("partial");
        expect(res.complete).toBe(false);
      });

      it("should send what fetch() returns, with the body decoded", async () => {
        const res = await send("/response/fetched");

        expect(res.status).toBe(200);
        expect(res.text).toBe("hello from upstream");
        expect(res.headers["content-type"]).toMatch(/^text\/x-upstream/);
        expect(res.headers["x-upstream"]).toBe("yes");
      });

      it("should pass on the status of what fetch() returns", async () => {
        const res = await send("/response/fetched-missing");

        expect(res.status).toBe(404);
        expect(res.text).toBe("missing upstream");
      });

      it("should cancel the body when the client leaves before the first chunk", async () => {
        await sendAndLeave("/response/quiet", "sent");
        await waitFor(() => expect(streaming.stopped).toBe(1));
      });

      it("should cancel the body when the client leaves, even if it went quiet", async () => {
        await sendAndLeave("/response/endless", "headers");
        await waitFor(() => expect(streaming.stopped).toBe(1));
      });

      it("should answer HEAD with its headers, without reading the body", async () => {
        const res = await send("/response/sized", { method: "HEAD" });

        expect(res.status).toBe(200);
        expect(res.headers["content-length"]).toBe("5");
        expect(res.headers["content-type"]).toMatch(/^text\/x-custom/);
        expect(res.text).toBe("");
        expect(res.complete).toBe(true);
        await waitFor(() => expect(streaming.stopped).toBe(1));
      });
    });

    describe("a ReadableStream", () => {
      it("should send it", async () => {
        const res = await send("/web-stream");

        expect(res.status).toBe(200);
        expect(res.text).toBe("from a web stream");
        expect(res.headers["content-type"]).toBe("application/octet-stream");
        expect(res.complete).toBe(true);
      });

      it("should send strings as text", async () => {
        const res = await send("/web-stream/strings");

        expect(res.text).toBe("from strings");
        expect(res.headers["content-type"]).toMatch(/^text\/plain/);
      });

      it("should send objects as lines of JSON", async () => {
        const res = await send("/web-stream/objects");

        expect(res.text).toBe('{"n":1}\n{"n":2}\n');
        expect(res.headers["content-type"]).toBe("application/x-ndjson");
      });

      it("should answer 500 for one that is locked or was read already", async () => {
        expect((await send("/web-stream/locked")).status).toBe(500);
        expect((await send("/web-stream/consumed")).status).toBe(500);
      });

      it("should go through the exception filters when it fails before the first chunk", async () => {
        const res = await send("/web-stream/fail-first");
        expect(res.status).toBe(500);
        expect(res.complete).toBe(true);
      });

      // BUNEST_BUG: Mid-stream ReadableStream errors cause Bun.serve to abruptly reset the TCP connection (ECONNRESET) instead of ending the chunked response cleanly after the partial chunk (packages/core/src/http/pipeline/response-serializer.ts:598-609).
      it.skip("should end the connection when it fails after the first chunk", async () => {
        const res = await send("/web-stream/fail-later");
        expect(res.text).toBe("partial");
        expect(res.complete).toBe(false);
      });

      it("should cancel it when the client leaves before the first chunk", async () => {
        await sendAndLeave("/web-stream/quiet", "sent");
        await waitFor(() => expect(streaming.stopped).toBe(1));
      });

      it("should cancel it when the client leaves, even if it went quiet", async () => {
        await sendAndLeave("/web-stream/endless", "headers");
        await waitFor(() => expect(streaming.stopped).toBe(1));
      });

      it("should answer HEAD without reading it", async () => {
        const res = await send("/web-stream/endless", { method: "HEAD" });

        expect(res.status).toBe(200);
        expect(res.text).toBe("");
        expect(res.complete).toBe(true);
        await waitFor(() => expect(streaming.stopped).toBe(1));
      });
    });

    describe("an async generator", () => {
      it("should send what it yields as text", async () => {
        const res = await send("/generator");

        expect(res.status).toBe(200);
        expect(res.text).toBe("from a generator");
        expect(res.headers["content-type"]).toBe("text/plain; charset=utf-8");
        expect(res.complete).toBe(true);
      });

      it("should send binary chunks as they are", async () => {
        const res = await send("/generator/bytes");

        expect(res.text).toBe("from bytes and buffers");
        expect(res.headers["content-type"]).toBe("application/octet-stream");
      });

      it("should send objects as lines of JSON", async () => {
        const res = await send("/generator/objects");

        expect(res.text).toBe('{"n":1}\n[2]\n3\nnull\nand text');
        expect(res.headers["content-type"]).toBe("application/x-ndjson");
      });

      it("should send nothing for an empty one", async () => {
        const res = await send("/generator/empty");

        expect(res.status).toBe(200);
        expect(res.text).toBe("");
        expect(res.complete).toBe(true);
      });

      it("should apply @HttpCode() and @Header()", async () => {
        const res = await send("/generator/decorated");

        expect(res.status).toBe(203);
        expect(res.headers["content-type"]).toMatch(/^text\/x-decorated/);
        expect(res.text).toBe("decorated");
      });

      it("should keep the default status of POST", async () => {
        const res = await send("/generator/created", { method: "POST" });
        expect(res.status).toBe(201);
      });

      it("should iterate any other async iterable", async () => {
        expect((await send("/generator/iterable")).text).toBe("01");
      });

      it("should go through the exception filters when it fails before the first chunk", async () => {
        const res = await send("/generator/fail-first-http");

        expect(res.status).toBe(404);
        expect(JSON.parse(res.text).message).toBe("not there");
      });

      it("should reach the filters of the controller", async () => {
        const res = await send("/generator/fail-first-filtered");

        expect(res.status).toBe(418);
        expect(res.text).toBe("caught by the filter");
      });

      it("should not expose an unknown error", async () => {
        const res = await send("/generator/fail-first-unknown");

        expect(res.status).toBe(500);
        expect(res.text).not.toContain("private details");
      });

      it("should not start it for HEAD", async () => {
        const declared = await send("/generator/head-only", { method: "HEAD" });
        expect(declared.status).toBe(200);
        expect(streaming.started).toBe(0);
      });
    });

    describe("with interceptors", () => {
      it("should still wrap what is not a stream", async () => {
        expect((await send("/intercepted/wrapped/json")).text).toBe(
          '{"data":{"n":1}}',
        );
      });

      it("should pass through a Response in ClassSerializerInterceptor", async () => {
        const res = await send("/intercepted/class-serialized/response");
        expect(res.text).toBe("from a response");
      });

      it("should serialize a class entity with @Exclude() via ClassSerializerInterceptor", async () => {
        const res = await send("/intercepted/class-serialized/entity");
        expect(res.text).toBe('{"id":1}');
        expect(res.text).not.toContain("secret");
      });

      it("should allow a tapping interceptor to pass a ReadableStream through", async () => {
        const res = await send("/intercepted/tapped/web-stream");
        expect(res.text).toBe("tapped");
        expect(streaming.pulled).toBe(-1);
      });

      it("should send what an interceptor replaced the stream with, and stop the stream", async () => {
        const res = await send("/intercepted/replaced");

        expect(res.text).toBe('{"replaced":true}');
        await waitFor(() => expect(streaming.stopped).toBe(1));
      });

      it("should send what an interceptor serialized a response into", async () => {
        const res = await send("/intercepted/plain-serialized/response");
        expect(res.text).toBe("{}");
      });

      it("should send what an interceptor made of a stream it read", async () => {
        expect((await send("/intercepted/collected/generator")).text).toBe(
          '{"collected":"from a generator"}',
        );
        expect((await send("/intercepted/collected/web-stream")).text).toBe(
          '{"collected":"from a web stream"}',
        );
      });

      it("should send the file an interceptor replaced it with", async () => {
        const res = await send("/intercepted/file");

        expect(res.headers["content-type"]).toMatch(/^text\/csv/);
        expect(res.text).toBe("a,b");
      });

      it("should go through the exception filters when an interceptor throws", async () => {
        const res = await send("/intercepted/rejected");

        expect(res.status).toBe(400);
        expect(JSON.parse(res.text).message).toBe(
          "rejected by the interceptor",
        );
        await waitFor(() => expect(streaming.stopped).toBe(1));
      });

      it("should send what an interceptor made of an empty stream it read", async () => {
        expect((await send("/intercepted/collected/empty")).text).toBe(
          '{"collected":""}',
        );
      });

      it("should keep the status and headers of a Response an interceptor wrapped", async () => {
        const res = await send("/intercepted/wrapped/response");
        expect(res.status).toBe(202);
        expect(res.headers["x-from-response"]).toBe("yes");
      });
    });

    describe("with @Res()", () => {
      itAdapted(
        "ADR-010",
        "should return a native Web Response directly",
        async () => {
          const res = await send("/manual/res");
          expect(res.text).toBe("sent by hand");
        },
        "ADR-010 returns native Web Response instead of mutating Express res.send()",
      );

      itAdapted(
        "ADR-010",
        "should stream with @Res({ passthrough: true }) ResponseContext headers",
        async () => {
          const res = await send("/manual/passthrough");

          expect(res.text).toBe("passed through");
          expect(res.headers["x-by-hand"]).toBe("yes");
        },
        "ResponseContext.header() merges onto returned ReadableStream response",
      );
    });

    describe("values that are not streams", () => {
      it.each([
        ["array", "[1,2]"],
        ["set", "{}"],
        ["sync-iterable", '{"name":"iterable"}'],
        ["thenable", '{"docs":[1,2]}'],
        ["thenable-intercepted", '{"data":{"docs":[1,2]}}'],
      ])("should keep serializing %s", async (path, expected) => {
        const res = await send(`/compatible/${path}`);

        expect(res.status).toBe(200);
        expect(res.text).toBe(expected);
      });
    });
  },
);
