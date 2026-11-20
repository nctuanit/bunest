import "reflect-metadata";
import { afterEach, beforeEach, expect } from "bun:test";
import * as http from "node:http";
import {
  Catch,
  Controller,
  Get,
  Injectable,
  Module,
  Req,
  Sse,
  UseInterceptors,
  type ArgumentsHost,
  type BunestInterceptor,
  type CallHandler,
  type ExceptionFilter,
  type ExecutionContext,
  type SseMessageEvent,
} from "../../../../../../packages/common/src";
import {
  APP_FILTER,
  HttpAdapterHost,
  type BunestApplication,
} from "../../../../../../packages/core/src";
import {
  Test,
  describeConformance,
  itAdapted,
} from "../../../../_helpers";

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

let ticks = 0;
let events: string[] = [];

function resetState() {
  ticks = 0;
  events = [];
}

function readTicks() {
  return ticks;
}

function readEvents() {
  return events;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1500,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      return false;
    }
    await sleep(5);
  }
  return true;
}

function startRequest(port: number, path: string): () => void {
  const req = http.get({ host: "127.0.0.1", port, path }, (res) => {
    res.on("data", () => undefined);
    res.on("error", () => undefined);
  });
  req.on("error", () => undefined);
  return () => req.destroy();
}

function requestAndAbort(
  port: number,
  path: string,
  killAfterMs: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path }, (res) => {
      res.on("data", () => undefined);
      res.on("error", () => undefined);
    });
    req.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code !== "ECONNRESET") {
        reject(err);
      }
    });
    setTimeout(() => {
      req.destroy();
      resolve();
    }, killAfterMs);
  });
}

function getJson<T = unknown>(port: number, path: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path }, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body) as T);
          } catch (err) {
            reject(err);
          }
        });
      })
      .on("error", reject);
  });
}

@Catch()
class RecordingExceptionFilter implements ExceptionFilter {
  constructor(private readonly adapterHost: HttpAdapterHost) {}

  catch(exception: Error, host: ArgumentsHost) {
    events.push(`filter:${exception.message}`);
    const response = host.switchToHttp().getResponse();
    return this.adapterHost.httpAdapter.reply(
      response,
      { failed: true },
      500,
    );
  }
}

@Injectable()
class CommitInterceptor implements BunestInterceptor {
  async intercept(_: ExecutionContext, next: CallHandler): Promise<unknown> {
    try {
      const value = await next.handle();
      await sleep(10);
      events.push("commit");
      return value;
    } finally {
      events.push("finalize");
    }
  }
}

@Injectable()
class WrapInterceptor implements BunestInterceptor {
  async intercept(_: ExecutionContext, next: CallHandler): Promise<unknown> {
    const value = await next.handle();
    if (
      typeof value === "object" &&
      value !== null &&
      Symbol.asyncIterator in value
    ) {
      async function* wrapStream(src: AsyncIterable<SseMessageEvent>) {
        try {
          for await (const item of src) {
            yield { data: { value: item.data } };
          }
        } finally {
          // Propagate cancellation to inner async generator
        }
      }
      return wrapStream(value as AsyncIterable<SseMessageEvent>);
    }
    return { value };
  }
}

@Controller()
class AppController {
  @Sse("observable")
  async *stream(@Req() req: Request): AsyncGenerator<SseMessageEvent> {
    try {
      while (!req.signal.aborted) {
        await sleep(20);
        if (req.signal.aborted) {
          break;
        }
        ticks++;
        yield { data: { tick: ticks } };
      }
    } finally {
      events.push("producer-stopped");
    }
  }

  @Sse("observable-intercepted")
  @UseInterceptors(WrapInterceptor)
  interceptedStream(@Req() req: Request): AsyncGenerator<SseMessageEvent> {
    return this.stream(req);
  }

  @Get("ticks")
  countTicks() {
    return { ticks };
  }

  @Get("final")
  async final() {
    return { ok: true };
  }

  @Get("final-intercepted")
  @UseInterceptors(WrapInterceptor)
  async finalIntercepted() {
    await sleep(5);
    return 3;
  }

  @Get("slow-intercepted")
  @UseInterceptors(CommitInterceptor)
  async slowIntercepted() {
    events.push("handler-start");
    await sleep(150);
    events.push("handler-done");
    return { ok: true };
  }

  @Get("slow-intercepted-error")
  @UseInterceptors(WrapInterceptor)
  async slowInterceptedError() {
    events.push("handler-start");
    await sleep(150);
    throw new Error("late failure");
  }
}

@Module({
  controllers: [AppController],
  providers: [{ provide: APP_FILTER, useClass: RecordingExceptionFilter }],
})
class AppModule {}

describeConformance(
  "Streaming / async response lifecycle (Bunest Application)",
  {
    upstreamPath:
      "integration/nest-application/observable-response/e2e/express.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008", "ADR-010"],
    notes:
      "Adapts RxJS Observable response cancellation and interceptor finalization tests to Bunest AsyncGenerator/@Sse/Request.signal + Promise onion interceptors.",
  },
  () => {
    let app: BunestApplication;
    let port: number;

    beforeEach(async () => {
      const moduleFixture = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();

      app = moduleFixture.createNestApplication({ logger: false });
      const info = await app.listen(0, "127.0.0.1");
      port = info.port;
      resetState();
    });

    afterEach(async () => {
      await app.close();
    });

    itAdapted(
      ["ADR-008", "ADR-010"],
      "stops the streaming producer once the client disconnects",
      async () => {
        await requestAndAbort(port, "/observable", 100);

        expect(
          await waitFor(() => readEvents().includes("producer-stopped")),
        ).toBe(true);
        const ticksAtStop = readTicks();
        expect(ticksAtStop).toBeGreaterThan(0);

        await sleep(200);
        expect(readTicks()).toBe(ticksAtStop);
      },
      "AsyncGenerator + @Sse + Request.signal replaces RxJS interval() Observable",
    );

    itAdapted(
      "ADR-008",
      "still replies normally when an async handler completes",
      async () => {
        expect(await getJson(port, "/final")).toEqual({ ok: true });
      },
      "Promise replaces RxJS of()",
    );

    itAdapted(
      ["ADR-008", "ADR-010"],
      "stops an intercepted streaming producer once the client disconnects",
      async () => {
        await requestAndAbort(port, "/observable-intercepted", 100);

        expect(
          await waitFor(() => readEvents().includes("producer-stopped")),
        ).toBe(true);
        const ticksAtStop = readTicks();
        expect(ticksAtStop).toBeGreaterThan(0);

        await sleep(200);
        expect(readTicks()).toBe(ticksAtStop);
      },
      "Intercepted AsyncGenerator + @Sse replaces RxJS Observable pipe",
    );

    itAdapted(
      "ADR-008",
      "still replies normally when an intercepted async handler completes",
      async () => {
        expect(await getJson(port, "/final-intercepted")).toEqual({
          value: 3,
        });
      },
      "Promise interceptor replaces RxJS map()",
    );

    itAdapted(
      "ADR-008",
      "lets interceptors finish after a disconnect when the handler returns a Promise",
      async () => {
        const abort = startRequest(port, "/slow-intercepted");
        await waitFor(() => readEvents().includes("handler-start"));
        abort();

        await waitFor(
          () =>
            readEvents().includes("handler-done") &&
            readEvents().includes("finalize"),
        );
        expect(readEvents()).toEqual([
          "handler-start",
          "handler-done",
          "commit",
          "finalize",
        ]);
      },
      "Promise try/finally interceptor replaces RxJS concatMap + finalize",
    );

    itAdapted(
      "ADR-008",
      "routes a late error to the exception filters after a disconnect when the handler returns a Promise",
      async () => {
        const abort = startRequest(port, "/slow-intercepted-error");
        await waitFor(() => readEvents().includes("handler-start"));
        abort();

        await waitFor(() => readEvents().includes("filter:late failure"));
        expect(readEvents()).toEqual(["handler-start", "filter:late failure"]);
      },
      "Promise error path invokes RecordingExceptionFilter via HttpAdapterHost",
    );
  },
);
