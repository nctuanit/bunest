import { afterEach, beforeEach, expect, it } from "bun:test";
import {
  Controller,
  Header,
  HttpStatus,
  Injectable,
  Module,
  Res,
  Sse,
  UseInterceptors,
  type BunestInterceptor,
  type CallHandler,
  type ExecutionContext,
  type ResponseContext,
  type SseMessageEvent,
} from "../../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../../packages/core/src";
import { Test, describeConformance } from "../../../../_helpers";

async function* helloStream(): AsyncIterable<SseMessageEvent> {
  yield { data: "hello" };
}

async function* neverStream(): AsyncIterable<SseMessageEvent> {
  await new Promise(() => undefined);
}

@Injectable()
class ReplyHeaderInterceptor implements BunestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    context
      .switchToHttp()
      .getResponse<ResponseContext>()
      .header("x-interceptor", "set");
    return next.handle();
  }
}

@Injectable()
class ReplyContentTypeInterceptor implements BunestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    context
      .switchToHttp()
      .getResponse<ResponseContext>()
      .header("content-type", "application/json");
    return next.handle();
  }
}

@Injectable()
class ReplyQueryHeaderInterceptor implements BunestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const value = new URL(req.url).searchParams.get("value") ?? "";
    http.getResponse<ResponseContext>().header("x-query", value);
    return next.handle();
  }
}

@Injectable()
class ReplyStatusInterceptor implements BunestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    context
      .switchToHttp()
      .getResponse<ResponseContext>()
      .status(HttpStatus.ACCEPTED);
    return next.handle();
  }
}

@Controller("late-headers")
class LateHeadersController {
  @Sse("decorator")
  @Header("x-decorator", "set")
  decorator(): AsyncIterable<SseMessageEvent> {
    return helloStream();
  }

  @Sse("interceptor")
  @UseInterceptors(ReplyHeaderInterceptor)
  interceptor(): AsyncIterable<SseMessageEvent> {
    return helloStream();
  }

  @Sse("handler")
  handler(@Res({ passthrough: true }) reply: ResponseContext) {
    reply.header("x-handler", "set");
    return helloStream();
  }

  @Sse("async-handler")
  async asyncHandler(@Res({ passthrough: true }) reply: ResponseContext) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    reply.status(HttpStatus.ACCEPTED);
    reply.header("x-async-handler", "set");
    return helloStream();
  }

  @Sse("header-content-type")
  @Header("Content-Type", "application/json")
  headerContentType(): AsyncIterable<SseMessageEvent> {
    return helloStream();
  }

  @Sse("content-type")
  @UseInterceptors(ReplyContentTypeInterceptor)
  contentType(): AsyncIterable<SseMessageEvent> {
    return helloStream();
  }

  @Sse("status")
  @UseInterceptors(ReplyStatusInterceptor)
  status(): AsyncIterable<SseMessageEvent> {
    return helloStream();
  }

  @Sse("query-header")
  @UseInterceptors(ReplyQueryHeaderInterceptor)
  queryHeader(): AsyncIterable<SseMessageEvent> {
    return neverStream();
  }
}

@Module({
  controllers: [LateHeadersController],
  providers: [
    ReplyHeaderInterceptor,
    ReplyContentTypeInterceptor,
    ReplyQueryHeaderInterceptor,
    ReplyStatusInterceptor,
  ],
})
class LateHeadersModule {}

describeConformance(
  "SSE late headers E2E (BunHttpAdapter)",
  {
    upstreamPath: "integration/nest-application/sse/e2e/late-headers.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008", "ADR-010"],
    notes:
      "Adapts NestJS SSE late headers/status E2E tests to BunHttpAdapter + ResponseContext + AsyncIterable.",
  },
  () => {
    let app: BunestApplication;
    let abortController: AbortController;

    beforeEach(async () => {
      const moduleFixture = await Test.createTestingModule({
        imports: [LateHeadersModule],
      }).compile();
      app = moduleFixture.createNestApplication({ logger: false });
      abortController = new AbortController();
      await app.listen(0, "127.0.0.1");
    });

    afterEach(async () => {
      abortController.abort();
      await app.close();
    });

    const openStream = async (route: string) =>
      fetch(`${app.getUrl()}late-headers/${route}`, {
        signal: abortController.signal,
      });

    it("sends a header set with @Header()", async () => {
      const response = await openStream("decorator");
      expect(response.headers.get("x-decorator")).toBe("set");
    });

    it("sends a header that an interceptor sets on the reply", async () => {
      const response = await openStream("interceptor");
      expect(response.headers.get("x-interceptor")).toBe("set");
    });

    it("sends a header that the handler sets on the reply", async () => {
      const response = await openStream("handler");
      expect(response.headers.get("x-handler")).toBe("set");
    });

    it("keeps the event stream content type over one that an interceptor sets", async () => {
      const response = await openStream("content-type");
      expect(response.headers.get("content-type")).toContain(
        "text/event-stream",
      );
    });

    it("sends the status code that an interceptor sets on the reply", async () => {
      const response = await openStream("status");
      expect(response.status).toBe(202);
    });

    it("sends the status and header that an async handler sets before returning the stream", async () => {
      const response = await openStream("async-handler");
      expect(response.status).toBe(202);
      expect(response.headers.get("x-async-handler")).toBe("set");
    });

    it("keeps the event stream content type over one set with @Header()", async () => {
      const response = await openStream("header-content-type");
      expect(response.headers.get("content-type")).toContain(
        "text/event-stream",
      );
    });

    it("answers 500 when a header set on the reply is not a valid header value", async () => {
      const response = await openStream("query-header?value=%E2%82%AC");
      expect(response.status).toBe(500);
      expect((await openStream("decorator")).status).toBe(200);
    });
  },
);
