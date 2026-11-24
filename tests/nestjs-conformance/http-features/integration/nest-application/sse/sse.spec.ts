import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Type } from "../../../../../../packages/validation/src/transformer";
import { IsInt } from "../../../../../../packages/validation/src/validator";
import {
  Body,
  Catch,
  Controller,
  Get,
  Injectable,
  Module,
  Post,
  Query,
  Req,
  RequestMethod,
  Sse,
  SseSignal,
  UseFilters,
  UseInterceptors,
  type ArgumentsHost,
  type BunestInterceptor,
  type CallHandler,
  type ExecutionContext,
  type ExceptionFilter,
  type SseMessageEvent,
} from "../../../../../../packages/core/src/common";
import {
  BaseExceptionFilter,
  type BunestApplication,
} from "../../../../../../packages/core/src";
import {
  Test,
  describeConformance,
  itAdapted,
  nestCompatibleValidationPipe,
  parseSseJson,
  readSseEvents,
} from "../../../../_helpers";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class SseQueryDto {
  @Type(() => Number)
  @IsInt()
  limit!: number;
}

@Injectable()
class PassthroughInterceptor implements BunestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Promise<unknown> {
    return next.handle();
  }
}

@Catch()
class DeferredExceptionFilter implements ExceptionFilter {
  private readonly base = new BaseExceptionFilter();

  async catch(exception: unknown, host: ArgumentsHost) {
    await sleep(5);
    return this.base.catch(exception, host);
  }
}

@Controller()
class AppController {
  private promiseDelayedRequestsStarted = 0;
  private promiseDelayedSubscriptionsStarted = 0;
  private promiseDelayedCloseEventsObserved = 0;
  private promiseDelayedTeardownsObserved = 0;
  private promiseDelayedRunningStreams = 0;
  private readonly promiseDelayedResolvers: Array<() => void> = [];

  private interceptorDelayedRequestsStarted = 0;
  private interceptorDelayedSubscriptionsStarted = 0;
  private interceptorDelayedCloseEventsObserved = 0;
  private interceptorDelayedTeardownsObserved = 0;
  private interceptorDelayedRunningStreams = 0;
  private readonly interceptorDelayedResolvers: Array<() => void> = [];

  private signalRequestsStarted = 0;
  private signalResourcesAllocated = 0;
  private signalResourcesCleaned = 0;
  private signalSubscriptionsStarted = 0;

  private completingSubscriptionsStarted = 0;
  private completingAbortsObserved = 0;
  private completingTeardownsObserved = 0;

  private streamingSubscriptionsStarted = 0;
  private streamingAbortsObserved = 0;
  private streamingTeardownsObserved = 0;

  @Sse("sse")
  async *sse(@SseSignal() signal: AbortSignal): AsyncIterable<SseMessageEvent> {
    while (!signal.aborted) {
      yield { data: { hello: "world" } };
      await sleep(50);
    }
  }

  @Sse("sse/validated")
  async *sseWithValidatedQuery(
    @Query() query: SseQueryDto,
  ): AsyncIterable<SseMessageEvent> {
    yield { data: { limit: query.limit } };
  }

  @Sse("sse/validated/deferred-filter")
  @UseInterceptors(PassthroughInterceptor)
  @UseFilters(DeferredExceptionFilter)
  async *sseWithDeferredFilter(
    @Query() query: SseQueryDto,
  ): AsyncIterable<SseMessageEvent> {
    yield { data: { limit: query.limit } };
  }

  @Sse("sse/empty")
  async *sseEmpty(): AsyncIterable<SseMessageEvent> {
    // Completes without emitting any events
  }

  @Sse("sse/burst")
  async *sseBurst(
    @Query("n") n = "20",
    @Query("size") size = "65536",
  ): AsyncIterable<SseMessageEvent> {
    const count = Number.parseInt(n, 10);
    const payload = "X".repeat(Number.parseInt(size, 10));
    for (let i = 0; i < count; i++) {
      yield { data: payload };
    }
  }

  @Sse("sse/primitives")
  async *ssePrimitives(): AsyncIterable<unknown> {
    yield 1;
    yield { data: 0 };
    yield { data: true };
  }

  @Sse("sse/unserializable")
  async *sseUnserializable(): AsyncIterable<SseMessageEvent> {
    yield { data: { n: 1 } };
    yield { data: { n: BigInt(2) } };
    yield { data: { n: 3 } };
  }

  @Sse("sse/unserializable-first")
  async *sseUnserializableFirst(): AsyncIterable<SseMessageEvent> {
    yield { data: { n: BigInt(1) } };
  }

  @Sse("sse/post", { method: RequestMethod.POST })
  async *ssePost(
    @Body() body: { content?: string },
  ): AsyncIterable<SseMessageEvent> {
    yield { data: { content: body?.content ?? "default" } };
  }

  @Sse("sse/promise-delayed")
  ssePromiseDelayed(
    @Req() req: Request,
  ): Promise<AsyncIterable<SseMessageEvent>> {
    return this.createPromiseDelayedSse(req);
  }

  @Sse("sse/post/promise-delayed", { method: RequestMethod.POST })
  ssePostPromiseDelayed(
    @Req() req: Request,
    @Body() _body: { content?: string },
  ): Promise<AsyncIterable<SseMessageEvent>> {
    return this.createPromiseDelayedSse(req);
  }

  private createPromiseDelayedSse(
    req: Request,
  ): Promise<AsyncIterable<SseMessageEvent>> {
    this.promiseDelayedRequestsStarted += 1;
    this.promiseDelayedRunningStreams += 1;

    let subscribed = false;
    let released = false;
    const releaseStream = () => {
      if (released) return;
      released = true;
      this.promiseDelayedRunningStreams -= 1;
    };

    req.signal.addEventListener(
      "abort",
      () => {
        this.promiseDelayedCloseEventsObserved += 1;
        if (!subscribed) {
          releaseStream();
        }
      },
      { once: true },
    );

    const self = this;
    return new Promise((resolve) => {
      this.promiseDelayedResolvers.push(() =>
        resolve({
          async *[Symbol.asyncIterator]() {
            if (req.signal.aborted) {
              return;
            }
            subscribed = true;
            self.promiseDelayedSubscriptionsStarted += 1;
            try {
              while (!req.signal.aborted) {
                yield { data: { hello: "world" } };
                await sleep(50);
              }
            } finally {
              self.promiseDelayedTeardownsObserved += 1;
              releaseStream();
            }
          },
        }),
      );
    });
  }

  @Post("sse/promise-delayed/release")
  releaseSsePromiseDelayed() {
    const pendingResolvers = this.promiseDelayedResolvers.splice(0);
    pendingResolvers.forEach((resolve) => resolve());
    return { released: pendingResolvers.length };
  }

  @Get("sse/promise-delayed/stats")
  getSsePromiseDelayedStats() {
    return {
      closeEventsObserved: this.promiseDelayedCloseEventsObserved,
      requestsStarted: this.promiseDelayedRequestsStarted,
      runningStreams: this.promiseDelayedRunningStreams,
      subscriptionsStarted: this.promiseDelayedSubscriptionsStarted,
      teardownsObserved: this.promiseDelayedTeardownsObserved,
    };
  }

  @UseInterceptors(PassthroughInterceptor)
  @Sse("sse/interceptor/promise-delayed")
  sseInterceptorPromiseDelayed(
    @Req() req: Request,
  ): Promise<AsyncIterable<SseMessageEvent>> {
    return this.createInterceptorDelayedSse(req);
  }

  @UseInterceptors(PassthroughInterceptor)
  @Sse("sse/post/interceptor/promise-delayed", { method: RequestMethod.POST })
  ssePostInterceptorPromiseDelayed(
    @Req() req: Request,
    @Body() _body: { content?: string },
  ): Promise<AsyncIterable<SseMessageEvent>> {
    return this.createInterceptorDelayedSse(req);
  }

  private createInterceptorDelayedSse(
    req: Request,
  ): Promise<AsyncIterable<SseMessageEvent>> {
    this.interceptorDelayedRequestsStarted += 1;
    this.interceptorDelayedRunningStreams += 1;

    let subscribed = false;
    let released = false;
    const releaseStream = () => {
      if (released) return;
      released = true;
      this.interceptorDelayedRunningStreams -= 1;
    };

    req.signal.addEventListener(
      "abort",
      () => {
        this.interceptorDelayedCloseEventsObserved += 1;
        if (!subscribed) {
          releaseStream();
        }
      },
      { once: true },
    );

    const self = this;
    return new Promise((resolve) => {
      this.interceptorDelayedResolvers.push(() =>
        resolve({
          async *[Symbol.asyncIterator]() {
            if (req.signal.aborted) {
              return;
            }
            subscribed = true;
            self.interceptorDelayedSubscriptionsStarted += 1;
            try {
              while (!req.signal.aborted) {
                yield { data: { hello: "world" } };
                await sleep(50);
              }
            } finally {
              self.interceptorDelayedTeardownsObserved += 1;
              releaseStream();
            }
          },
        }),
      );
    });
  }

  @Post("sse/interceptor/promise-delayed/release")
  releaseInterceptorDelayedSse() {
    const pendingResolvers = this.interceptorDelayedResolvers.splice(0);
    pendingResolvers.forEach((resolve) => resolve());
    return { released: pendingResolvers.length };
  }

  @Get("sse/interceptor/promise-delayed/stats")
  getInterceptorDelayedSseStats() {
    return {
      closeEventsObserved: this.interceptorDelayedCloseEventsObserved,
      requestsStarted: this.interceptorDelayedRequestsStarted,
      runningStreams: this.interceptorDelayedRunningStreams,
      subscriptionsStarted: this.interceptorDelayedSubscriptionsStarted,
      teardownsObserved: this.interceptorDelayedTeardownsObserved,
    };
  }

  @UseInterceptors(PassthroughInterceptor)
  @Sse("sse/signal/promise-delayed")
  async sseSignalPromiseDelayed(
    @SseSignal() signal: AbortSignal,
  ): Promise<AsyncIterable<SseMessageEvent>> {
    this.signalRequestsStarted += 1;
    this.signalResourcesAllocated += 1;

    await sleep(80);

    if (signal.aborted) {
      this.signalResourcesCleaned += 1;
      return (async function* () {})();
    }

    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        self.signalSubscriptionsStarted += 1;
        try {
          while (!signal.aborted) {
            yield { data: { hello: "world" } };
            await sleep(50);
          }
        } finally {
          self.signalResourcesCleaned += 1;
        }
      },
    };
  }

  @Get("sse/signal/promise-delayed/stats")
  getSignalDelayedSseStats() {
    return {
      requestsStarted: this.signalRequestsStarted,
      resourcesAllocated: this.signalResourcesAllocated,
      resourcesCleaned: this.signalResourcesCleaned,
      subscriptionsStarted: this.signalSubscriptionsStarted,
    };
  }

  @Sse("sse/signal/completing")
  sseSignalCompleting(
    @SseSignal() signal: AbortSignal,
  ): AsyncIterable<SseMessageEvent> {
    signal.addEventListener(
      "abort",
      () => {
        this.completingAbortsObserved += 1;
      },
      { once: true },
    );
    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        self.completingSubscriptionsStarted += 1;
        try {
          yield { data: { chunk: 0 } };
          yield { data: { chunk: 1 } };
        } finally {
          self.completingTeardownsObserved += 1;
        }
      },
    };
  }

  @Get("sse/signal/completing/stats")
  getSignalCompletingSseStats() {
    return {
      abortsObserved: this.completingAbortsObserved,
      subscriptionsStarted: this.completingSubscriptionsStarted,
      teardownsObserved: this.completingTeardownsObserved,
    };
  }

  @Sse("sse/signal/streaming")
  sseSignalStreaming(
    @SseSignal() signal: AbortSignal,
  ): AsyncIterable<SseMessageEvent> {
    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        self.streamingSubscriptionsStarted += 1;
        const onAbort = () => {
          self.streamingAbortsObserved += 1;
        };
        signal.addEventListener("abort", onAbort, { once: true });
        try {
          while (!signal.aborted) {
            yield { data: { hello: "world" } };
            await sleep(30);
          }
        } finally {
          signal.removeEventListener("abort", onAbort);
          self.streamingTeardownsObserved += 1;
        }
      },
    };
  }

  @Get("sse/signal/streaming/stats")
  getSignalStreamingSseStats() {
    return {
      abortsObserved: this.streamingAbortsObserved,
      subscriptionsStarted: this.streamingSubscriptionsStarted,
      teardownsObserved: this.streamingTeardownsObserved,
    };
  }
}

@Module({
  controllers: [AppController],
  providers: [PassthroughInterceptor, DeferredExceptionFilter],
})
class AppModule {}

async function pollUntil<T>(
  fetcher: () => Promise<T>,
  predicate: (val: T) => boolean,
  errorMsg: string,
  timeoutMs = 2000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = await fetcher();
    if (predicate(val)) {
      return val;
    }
    await sleep(20);
  }
  throw new Error(errorMsg);
}

describeConformance(
  "SSE E2E (BunHttpAdapter AsyncIterable + @SseSignal)",
  {
    upstreamPath: "integration/nest-application/sse/e2e/express.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008", "ADR-009", "ADR-010"],
    notes:
      "Adapts NestJS @Sse() E2E suite from RxJS Observable + EventSource to Bunest AsyncIterable<SseMessageEvent> + native fetch() + readSseEvents() + @SseSignal().",
  },
  () => {
    let app: BunestApplication;

    describe("without forceCloseConnections", () => {
      beforeEach(async () => {
        const moduleFixture = await Test.createTestingModule({
          imports: [AppModule],
        }).compile();

        app = moduleFixture.createNestApplication({
          logger: false,
          forceCloseConnections: false,
        });
        app.useGlobalPipes(nestCompatibleValidationPipe({ transform: true }));
        await app.listen(0, "127.0.0.1");
      });

      afterEach(async () => {
        await app.close();
      });

      itAdapted(
        ["ADR-001", "ADR-008"],
        "receives events from server",
        async () => {
          const response = await fetch(`${app.getUrl()}sse`, {
            headers: { accept: "text/event-stream" },
          });
          expect(response.status).toBe(200);
          const events = await readSseEvents(response, { maxEvents: 1 });
          expect(events).toHaveLength(1);
          expect(parseSseJson(events[0]!)).toEqual({ hello: "world" });
        },
        "readSseEvents() consumes AsyncIterable SSE stream",
      );

      it("returns a validation error status before opening the SSE stream", async () => {
        const response = await fetch(
          `${app.getUrl()}sse/validated?limit=invalid`,
          {
            headers: { accept: "text/event-stream" },
          },
        );
        expect(response.status).toBe(400);
        expect(response.headers.get("content-type")).toContain(
          "application/json",
        );
      });

      it("returns the status that an asynchronous exception filter sets before opening the SSE stream", async () => {
        const response = await fetch(
          `${app.getUrl()}sse/validated/deferred-filter?limit=invalid`,
          {
            headers: { accept: "text/event-stream" },
          },
        );
        expect(response.status).toBe(400);
        expect(response.headers.get("content-type")).toContain(
          "application/json",
        );
      });
    });

    describe("with forceCloseConnections", () => {
      beforeEach(async () => {
        const moduleFixture = await Test.createTestingModule({
          imports: [AppModule],
        }).compile();

        app = moduleFixture.createNestApplication({
          logger: false,
          forceCloseConnections: true,
        });
        app.useGlobalPipes(nestCompatibleValidationPipe({ transform: true }));
        await app.listen(0, "127.0.0.1");
      });

      afterEach(async () => {
        await app.close();
      });

      it("receives events from server", async () => {
        const response = await fetch(`${app.getUrl()}sse`, {
          headers: { accept: "text/event-stream" },
        });
        const events = await readSseEvents(response, { maxEvents: 1 });
        expect(parseSseJson(events[0]!)).toEqual({ hello: "world" });
      });

      it("returns a validation error status before opening the SSE stream", async () => {
        const response = await fetch(
          `${app.getUrl()}sse/validated?limit=invalid`,
          {
            headers: { accept: "text/event-stream" },
          },
        );
        expect(response.status).toBe(400);
        expect(response.headers.get("content-type")).toContain(
          "application/json",
        );
      });
    });

    describe("backpressure", () => {
      beforeEach(async () => {
        const moduleFixture = await Test.createTestingModule({
          imports: [AppModule],
        }).compile();
        app = moduleFixture.createNestApplication({
          logger: false,
          forceCloseConnections: true,
        });
        await app.listen(0, "127.0.0.1");
      });

      afterEach(async () => {
        await app.close();
      });

      it("should return SSE headers when the producer completes without events", async () => {
        const response = await fetch(`${app.getUrl()}sse/empty`);
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain(
          "text/event-stream",
        );
        expect(response.headers.get("cache-control")).toContain("no-cache");
        expect(await response.text()).toBe("");
      });

      it("should deliver all events when bursting large payloads", async () => {
        const n = 50;
        const size = 65536;
        const response = await fetch(
          `${app.getUrl()}sse/burst?n=${n}&size=${size}`,
        );
        const body = await response.text();
        const dataLines = body
          .split("\n")
          .filter((line) => line.startsWith("data: "));
        expect(dataLines).toHaveLength(n);
      });

      it("should stream events from POST SSE routes with a request body", async () => {
        const response = await fetch(`${app.getUrl()}sse/post`, {
          method: "POST",
          headers: {
            accept: "text/event-stream",
            "content-type": "application/json",
          },
          body: JSON.stringify({ content: "chunk-0" }),
        });
        expect(response.status).toBe(201);
        expect(response.headers.get("content-type")).toContain(
          "text/event-stream",
        );
        expect(await response.text()).toContain('data: {"content":"chunk-0"}');
      });
    });

    describe("event data serialization & unserializable values", () => {
      beforeEach(async () => {
        const moduleFixture = await Test.createTestingModule({
          imports: [AppModule],
        }).compile();
        app = moduleFixture.createNestApplication({
          logger: false,
          forceCloseConnections: true,
        });
        await app.listen(0, "127.0.0.1");
      });

      afterEach(async () => {
        await app.close();
      });

      it("should send number and boolean data as JSON", async () => {
        const response = await fetch(`${app.getUrl()}sse/primitives`, {
          signal: AbortSignal.timeout(2000),
        });
        const events = await readSseEvents(response);
        expect(events.map((e) => e.data)).toEqual(["1", "0", "true"]);
      });

      it("should send an error event and end the stream when a later event cannot be serialized", async () => {
        const response = await fetch(`${app.getUrl()}sse/unserializable`, {
          signal: AbortSignal.timeout(2000),
        });
        const body = await response.text();
        expect(response.status).toBe(200);
        expect(body).toContain('data: {"n":1}');
        expect(body).toContain("event: error");
        expect(body).not.toContain('data: {"n":3}');
      });

      it("should return an error status when the first event cannot be serialized", async () => {
        const response = await fetch(
          `${app.getUrl()}sse/unserializable-first`,
          { signal: AbortSignal.timeout(2000) },
        );
        expect(response.status).toBe(500);
        expect(response.headers.get("content-type")).not.toContain(
          "text/event-stream",
        );
      });
    });

    describe("Promise<AsyncIterable> disconnect handling", () => {
      beforeEach(async () => {
        const moduleFixture = await Test.createTestingModule({
          imports: [AppModule],
        }).compile();
        app = moduleFixture.createNestApplication({
          logger: false,
          forceCloseConnections: true,
        });
        await app.listen(0, "127.0.0.1");
      });

      afterEach(async () => {
        await app.close();
      });

      it("should not subscribe the producer if the GET SSE client disconnects before the promise resolves", async () => {
        const base = app.getUrl()!;
        const ac = new AbortController();
        const responsePromise = fetch(`${base}sse/promise-delayed`, {
          headers: { accept: "text/event-stream" },
          signal: ac.signal,
        });

        await pollUntil(
          async () => (await fetch(`${base}sse/promise-delayed/stats`)).json(),
          (s: any) => s.requestsStarted > 0,
          "Timed out waiting for request start",
        );
        ac.abort();
        await responsePromise.catch(() => undefined);

        await pollUntil(
          async () => (await fetch(`${base}sse/promise-delayed/stats`)).json(),
          (s: any) => s.closeEventsObserved > 0,
          "Timed out waiting for close event",
        );

        const releaseRes = await fetch(`${base}sse/promise-delayed/release`, {
          method: "POST",
        });
        expect(((await releaseRes.json()) as any).released).toBe(1);
        await sleep(20);

        const stats: any = await (
          await fetch(`${base}sse/promise-delayed/stats`)
        ).json();
        expect(stats.closeEventsObserved).toBe(1);
        expect(stats.requestsStarted).toBe(1);
        expect(stats.runningStreams).toBe(0);
        expect(stats.subscriptionsStarted).toBe(0);
        expect(stats.teardownsObserved).toBe(0);
      });

      it("should not subscribe the producer if the POST SSE client disconnects before the promise resolves", async () => {
        const base = app.getUrl()!;
        const ac = new AbortController();
        const responsePromise = fetch(`${base}sse/post/promise-delayed`, {
          method: "POST",
          headers: {
            accept: "text/event-stream",
            "content-type": "application/json",
          },
          body: JSON.stringify({ content: "chunk-0" }),
          signal: ac.signal,
        });

        await pollUntil(
          async () => (await fetch(`${base}sse/promise-delayed/stats`)).json(),
          (s: any) => s.requestsStarted > 0,
          "Timed out waiting for POST request start",
        );
        ac.abort();
        await responsePromise.catch(() => undefined);

        await pollUntil(
          async () => (await fetch(`${base}sse/promise-delayed/stats`)).json(),
          (s: any) => s.closeEventsObserved > 0,
          "Timed out waiting for POST close event",
        );

        const releaseRes = await fetch(`${base}sse/promise-delayed/release`, {
          method: "POST",
        });
        expect(((await releaseRes.json()) as any).released).toBe(1);
        await sleep(20);

        const stats: any = await (
          await fetch(`${base}sse/promise-delayed/stats`)
        ).json();
        expect(stats.closeEventsObserved).toBe(1);
        expect(stats.requestsStarted).toBe(1);
        expect(stats.runningStreams).toBe(0);
        expect(stats.subscriptionsStarted).toBe(0);
        expect(stats.teardownsObserved).toBe(0);
      });
    });

    describe("Promise<AsyncIterable> disconnect handling with interceptor", () => {
      beforeEach(async () => {
        const moduleFixture = await Test.createTestingModule({
          imports: [AppModule],
        }).compile();
        app = moduleFixture.createNestApplication({
          logger: false,
          forceCloseConnections: true,
        });
        await app.listen(0, "127.0.0.1");
      });

      afterEach(async () => {
        await app.close();
      });

      it("should not subscribe the producer if the GET SSE client disconnects before the promise resolves", async () => {
        const base = app.getUrl()!;
        const ac = new AbortController();
        const responsePromise = fetch(
          `${base}sse/interceptor/promise-delayed`,
          {
            headers: { accept: "text/event-stream" },
            signal: ac.signal,
          },
        );

        await pollUntil(
          async () =>
            (
              await fetch(`${base}sse/interceptor/promise-delayed/stats`)
            ).json(),
          (s: any) => s.requestsStarted > 0,
          "Timed out waiting for interceptor request start",
        );
        ac.abort();
        await responsePromise.catch(() => undefined);

        await pollUntil(
          async () =>
            (
              await fetch(`${base}sse/interceptor/promise-delayed/stats`)
            ).json(),
          (s: any) => s.closeEventsObserved > 0,
          "Timed out waiting for interceptor close event",
        );

        const releaseRes = await fetch(
          `${base}sse/interceptor/promise-delayed/release`,
          { method: "POST" },
        );
        expect(((await releaseRes.json()) as any).released).toBe(1);
        await sleep(20);

        const stats: any = await (
          await fetch(`${base}sse/interceptor/promise-delayed/stats`)
        ).json();
        expect(stats.closeEventsObserved).toBe(1);
        expect(stats.requestsStarted).toBe(1);
        expect(stats.runningStreams).toBe(0);
        expect(stats.subscriptionsStarted).toBe(0);
        expect(stats.teardownsObserved).toBe(0);
      });

      it("should not subscribe the producer if the POST SSE client disconnects before the promise resolves", async () => {
        const base = app.getUrl()!;
        const ac = new AbortController();
        const responsePromise = fetch(
          `${base}sse/post/interceptor/promise-delayed`,
          {
            method: "POST",
            headers: {
              accept: "text/event-stream",
              "content-type": "application/json",
            },
            body: JSON.stringify({ content: "chunk-0" }),
            signal: ac.signal,
          },
        );

        await pollUntil(
          async () =>
            (
              await fetch(`${base}sse/interceptor/promise-delayed/stats`)
            ).json(),
          (s: any) => s.requestsStarted > 0,
          "Timed out waiting for POST interceptor request start",
        );
        ac.abort();
        await responsePromise.catch(() => undefined);

        await pollUntil(
          async () =>
            (
              await fetch(`${base}sse/interceptor/promise-delayed/stats`)
            ).json(),
          (s: any) => s.closeEventsObserved > 0,
          "Timed out waiting for POST interceptor close event",
        );

        const releaseRes = await fetch(
          `${base}sse/interceptor/promise-delayed/release`,
          { method: "POST" },
        );
        expect(((await releaseRes.json()) as any).released).toBe(1);
        await sleep(20);

        const stats: any = await (
          await fetch(`${base}sse/interceptor/promise-delayed/stats`)
        ).json();
        expect(stats.closeEventsObserved).toBe(1);
        expect(stats.requestsStarted).toBe(1);
        expect(stats.runningStreams).toBe(0);
        expect(stats.subscriptionsStarted).toBe(0);
        expect(stats.teardownsObserved).toBe(0);
      });

      it("should clean up setup-phase resources via @SseSignal() AbortSignal when client disconnects mid-await", async () => {
        const base = app.getUrl()!;
        const ac = new AbortController();
        const responsePromise = fetch(`${base}sse/signal/promise-delayed`, {
          headers: { accept: "text/event-stream" },
          signal: ac.signal,
        });

        await pollUntil(
          async () =>
            (await fetch(`${base}sse/signal/promise-delayed/stats`)).json(),
          (s: any) => s.requestsStarted > 0,
          "Timed out waiting for signal request start",
        );
        ac.abort();
        await responsePromise.catch(() => undefined);

        const stats: any = await pollUntil(
          async () =>
            (await fetch(`${base}sse/signal/promise-delayed/stats`)).json(),
          (s: any) => s.resourcesCleaned > 0,
          "Timed out waiting for setup-phase resource cleanup",
        );
        expect(stats.requestsStarted).toBe(1);
        expect(stats.resourcesAllocated).toBe(1);
        expect(stats.resourcesCleaned).toBe(1);
        expect(stats.subscriptionsStarted).toBe(0);
      });
    });

    describe("SseSignal lifetime", () => {
      beforeEach(async () => {
        const moduleFixture = await Test.createTestingModule({
          imports: [AppModule],
        }).compile();
        app = moduleFixture.createNestApplication({
          logger: false,
          forceCloseConnections: true,
        });
        await app.listen(0, "127.0.0.1");
      });

      afterEach(async () => {
        await app.close();
      });

      it("aborts the signal once a stream that runs to completion has ended", async () => {
        const base = app.getUrl()!;
        const response = await fetch(`${base}sse/signal/completing`, {
          headers: { accept: "text/event-stream" },
        });
        const body = await response.text();
        expect(body).toContain('data: {"chunk":0}');
        expect(body).toContain('data: {"chunk":1}');

        const stats: any = await pollUntil(
          async () =>
            (await fetch(`${base}sse/signal/completing/stats`)).json(),
          (s: any) => s.abortsObserved > 0,
          "Timed out waiting for completing SSE signal abort",
        );
        expect(stats.subscriptionsStarted).toBe(1);
        expect(stats.teardownsObserved).toBe(1);
        expect(stats.abortsObserved).toBe(1);
      });

      it("aborts the signal when the client disconnects after the producer is subscribed", async () => {
        const base = app.getUrl()!;
        const ac = new AbortController();
        const response = await fetch(`${base}sse/signal/streaming`, {
          headers: { accept: "text/event-stream" },
          signal: ac.signal,
        });

        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let received = "";
        while (!received.includes("data:")) {
          const { done, value } = await reader.read();
          if (done) break;
          received += decoder.decode(value, { stream: true });
        }
        expect(received).toContain("data:");

        ac.abort();
        await reader.cancel().catch(() => undefined);

        const stats: any = await pollUntil(
          async () => (await fetch(`${base}sse/signal/streaming/stats`)).json(),
          (s: any) => s.teardownsObserved > 0,
          "Timed out waiting for streaming SSE teardown",
        );
        expect(stats.subscriptionsStarted).toBe(1);
        expect(stats.abortsObserved).toBe(1);
        expect(stats.teardownsObserved).toBe(1);
      });
    });
  },
);
