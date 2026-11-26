import { describe, expect, it } from "bun:test";
import {
  Body,
  BunestFactory,
  Catch,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Post,
  Query,
  REQUEST,
  Scope,
  UnauthorizedException,
  UseFilters,
  UseGuards,
  UseInterceptors,
  UsePipes,
  type ArgumentMetadata,
  type ArgumentsHost,
  type BunestApplication,
  type BunestInterceptor,
  type CallHandler,
  type CanActivate,
  type ExceptionFilter,
  type ExecutionContext,
  type OnRequestDestroy,
  type PipeTransform,
} from "../../packages/core/src";
import { ValidationPipe } from "../../packages/validation/src";
import {
  IsInt,
  IsString,
  Min,
  MinLength,
} from "../../packages/validation/src/validator";

type RoutingMode = "native" | "fallback";

class DomainException extends HttpException {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message, HttpStatus.UNPROCESSABLE_ENTITY);
  }
}

class CreateItemDto {
  @IsString()
  @MinLength(2)
  name!: string;

  @IsInt()
  @Min(1)
  quantity!: number;
}

@Catch(DomainException)
class DomainExceptionFilter implements ExceptionFilter<DomainException> {
  catch(exception: DomainException, _host: ArgumentsHost) {
    return new Response(
      JSON.stringify({
        handledBy: "DomainExceptionFilter",
        statusCode: exception.getStatus(),
        code: exception.code,
        message: exception.message,
      }),
      {
        status: exception.getStatus(),
        headers: { "content-type": "application/json; charset=utf-8" },
      },
    );
  }
}

interface ParityFixture {
  readonly mode: RoutingMode;
  readonly app: BunestApplication;
  readonly baseUrl: string;
  readonly nativeRouteKeys: string[];
  getDestroyedCount(): number;
  resetDestroyedCount(): void;
  waitForSlowEntry(): Promise<void>;
  resetSlowEntry(): void;
}

function createParityFixtureFactory() {
  return async function createParityApp(
    mode: RoutingMode,
  ): Promise<ParityFixture> {
    let destroyedCount = 0;
    let instanceSeq = 0;
    const requestTraces = new WeakMap<Request, string[]>();

    let slowEntryResolve: (() => void) | undefined;
    let slowEntryPromise = new Promise<void>((resolve) => {
      slowEntryResolve = resolve;
    });

    const getTrace = (req: Request): string[] => {
      let trace = requestTraces.get(req);
      if (!trace) {
        trace = [];
        requestTraces.set(req, trace);
      }
      return trace;
    };

    @Injectable({ scope: Scope.REQUEST })
    class RequestTrackerService implements OnRequestDestroy {
      readonly requestId: string;
      readonly instanceId: number;

      constructor(@Inject(REQUEST) private readonly req: Request) {
        this.requestId = this.req.headers.get("x-request-id") ?? "anonymous";
        this.instanceId = ++instanceSeq;
      }

      getRequest(): Request {
        return this.req;
      }

      onRequestDestroy(): void {
        destroyedCount += 1;
      }
    }

    @Injectable()
    class AuditGuard implements CanActivate {
      canActivate(context: ExecutionContext): boolean {
        const req = context.switchToHttp().getRequest<Request>();
        const auth = req.headers.get("x-auth");
        if (auth === "unauthorized") {
          throw new UnauthorizedException("Missing or invalid token");
        }
        if (auth === "forbidden") {
          return false;
        }
        getTrace(req).push("guard");
        return true;
      }
    }

    @Injectable()
    class TraceInterceptor implements BunestInterceptor {
      async intercept(
        context: ExecutionContext,
        next: CallHandler,
      ): Promise<unknown> {
        const req = context.switchToHttp().getRequest<Request>();
        const trace = getTrace(req);
        trace.push("interceptor:before");
        const result = await next.handle();
        trace.push("interceptor:after");
        if (
          result !== null &&
          typeof result === "object" &&
          "includeTrace" in result
        ) {
          const { includeTrace: _ignore, ...rest } = result as Record<
            string,
            unknown
          >;
          return { ...rest, trace: [...trace] };
        }
        return result;
      }
    }

    @Injectable({ scope: Scope.REQUEST })
    class TracePipe implements PipeTransform<unknown, unknown> {
      constructor(private readonly tracker: RequestTrackerService) {}

      transform(value: unknown, _metadata: ArgumentMetadata): unknown {
        getTrace(this.tracker.getRequest()).push("pipe");
        return typeof value === "string" ? value.trim() : value;
      }
    }

    const controllerOptions =
      mode === "native"
        ? { path: "/parity", scope: Scope.REQUEST }
        : { path: "/parity", host: "127.0.0.1", scope: Scope.REQUEST };

    @Controller(controllerOptions)
    @UseFilters(DomainExceptionFilter)
    class ParityController {
      constructor(private readonly tracker: RequestTrackerService) {}

      @Get("items/:id")
      getItem(@Param("id") id: string) {
        if (id === "missing") {
          throw new NotFoundException(`Item ${id} not found`);
        }
        if (id === "domain-err") {
          throw new DomainException("ITEM_LOCKED", "Item is locked");
        }
        return {
          id,
          requestId: this.tracker.requestId,
        };
      }

      @Post("items")
      @UsePipes(
        new ValidationPipe({
          whitelist: true,
          forbidNonWhitelisted: true,
          transform: true,
        }),
      )
      createItem(@Body() dto: CreateItemDto) {
        return {
          created: {
            name: dto.name,
            quantity: dto.quantity,
          },
          requestId: this.tracker.requestId,
        };
      }

      @Get("pipeline/:slug")
      @UseGuards(AuditGuard)
      @UseInterceptors(TraceInterceptor)
      @UsePipes(TracePipe)
      runPipeline(@Param("slug") slug: string) {
        getTrace(this.tracker.getRequest()).push("handler");
        return {
          includeTrace: true,
          slug,
          requestId: this.tracker.requestId,
        };
      }

      @Get("isolated")
      async getIsolated(@Query("delay") delayRaw?: string) {
        const beforeRequestId = this.tracker.requestId;
        const beforeInstanceId = this.tracker.instanceId;
        const delayMs = Math.max(0, Math.min(50, Number(delayRaw ?? "5") || 0));
        await Bun.sleep(delayMs);
        return {
          beforeRequestId,
          afterRequestId: this.tracker.requestId,
          beforeInstanceId,
          afterInstanceId: this.tracker.instanceId,
        };
      }

      @Get("slow")
      async getSlow(@Query("ms") msRaw?: string) {
        const waitedMs = Math.max(
          10,
          Math.min(2000, Number(msRaw ?? "150") || 150),
        );
        slowEntryResolve?.();
        await Bun.sleep(waitedMs);
        return {
          ok: true,
          waitedMs,
          requestId: this.tracker.requestId,
        };
      }

      @Get("stream")
      getStream() {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let sent = 0;
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            return new Promise<void>((resolve) => {
              timer = setTimeout(() => {
                sent += 1;
                controller.enqueue(
                  new TextEncoder().encode(`chunk-${sent}\n`),
                );
                if (sent >= 3) {
                  controller.close();
                }
                resolve();
              }, 40);
            });
          },
          cancel() {
            if (timer !== undefined) {
              clearTimeout(timer);
            }
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
    }

    @Module({
      controllers: [ParityController],
      providers: [
        RequestTrackerService,
        AuditGuard,
        TraceInterceptor,
        TracePipe,
      ],
    })
    class ParityModule {}

    const app = await BunestFactory.create(ParityModule, { logger: false });
    const info = await app.listen({ hostname: "127.0.0.1", port: 0 });
    const baseUrl = info.url.replace(/\/$/, "");

    const adapter = app.getHttpAdapter() as unknown as {
      compiledTable?: { bunRoutes: Record<string, unknown> };
    };
    const nativeRouteKeys = Object.keys(adapter.compiledTable?.bunRoutes ?? {});

    return {
      mode,
      app,
      baseUrl,
      nativeRouteKeys,
      getDestroyedCount: () => destroyedCount,
      resetDestroyedCount: () => {
        destroyedCount = 0;
      },
      waitForSlowEntry: () => slowEntryPromise,
      resetSlowEntry: () => {
        slowEntryPromise = new Promise<void>((resolve) => {
          slowEntryResolve = resolve;
        });
      },
    };
  };
}

const createParityApp = createParityFixtureFactory();

function normalizeVolatileFields(body: unknown): unknown {
  if (body !== null && typeof body === "object" && !Array.isArray(body)) {
    const record = body as Record<string, unknown>;
    if (typeof record.timestamp === "string") {
      expect(Number.isNaN(Date.parse(record.timestamp))).toBe(false);
      return { ...record, timestamp: "<ISO_TIMESTAMP>" };
    }
  }
  return body;
}

async function fetchJsonSnapshot(
  url: string,
  init?: RequestInit,
): Promise<{ status: number; body: unknown; allow: string | null }> {
  const res = await fetch(url, init);
  const body = normalizeVolatileFields(await res.json());
  return {
    status: res.status,
    body,
    allow: res.headers.get("allow"),
  };
}

describe("Native Bun.serve({ routes }) vs Fallback fetch parity", () => {
  it("verifies native mode uses Bun.serve({ routes }) while fallback mode uses 0 native routes", async () => {
    const nativeFx = await createParityApp("native");
    const fallbackFx = await createParityApp("fallback");
    try {
      expect(nativeFx.nativeRouteKeys.length).toBeGreaterThanOrEqual(6);
      expect(nativeFx.nativeRouteKeys).toContain("/parity/items/:id");
      expect(nativeFx.nativeRouteKeys).toContain("/parity/items");
      expect(nativeFx.nativeRouteKeys).toContain("/parity/pipeline/:slug");
      expect(nativeFx.nativeRouteKeys).toContain("/parity/isolated");
      expect(nativeFx.nativeRouteKeys).toContain("/parity/slow");
      expect(nativeFx.nativeRouteKeys).toContain("/parity/stream");

      expect(fallbackFx.nativeRouteKeys).toEqual([]);
    } finally {
      await Promise.all([nativeFx.app.close(), fallbackFx.app.close()]);
    }
  });

  it("produces 100% identical status codes and JSON bodies across 200, 201, 400, 401, 403, 404, 405, and custom filter", async () => {
    const nativeFx = await createParityApp("native");
    const fallbackFx = await createParityApp("fallback");

    try {
      const scenarios: Array<{
        label: string;
        path: string;
        init?: RequestInit;
        expectedStatus: number;
      }> = [
        {
          label: "200 GET param route",
          path: "/parity/items/42",
          init: { headers: { "x-request-id": "req-200" } },
          expectedStatus: 200,
        },
        {
          label: "201 POST validated DTO",
          path: "/parity/items",
          init: {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-request-id": "req-201",
            },
            body: JSON.stringify({ name: "Widget", quantity: 3 }),
          },
          expectedStatus: 201,
        },
        {
          label: "400 POST validation error",
          path: "/parity/items",
          init: {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-request-id": "req-400",
            },
            body: JSON.stringify({
              name: "A",
              quantity: 0,
              unexpected: true,
            }),
          },
          expectedStatus: 400,
        },
        {
          label: "401 Guard UnauthorizedException",
          path: "/parity/pipeline/secret",
          init: {
            headers: {
              "x-auth": "unauthorized",
              "x-request-id": "req-401",
            },
          },
          expectedStatus: 401,
        },
        {
          label: "403 Guard false rejection",
          path: "/parity/pipeline/secret",
          init: {
            headers: {
              "x-auth": "forbidden",
              "x-request-id": "req-403",
            },
          },
          expectedStatus: 403,
        },
        {
          label: "404 NotFoundException thrown by handler",
          path: "/parity/items/missing",
          init: { headers: { "x-request-id": "req-404-handler" } },
          expectedStatus: 404,
        },
        {
          label: "404 Unmatched route",
          path: "/parity/no-such-route",
          init: { headers: { "x-request-id": "req-404-router" } },
          expectedStatus: 404,
        },
        {
          label: "422 Custom @Catch() ExceptionFilter",
          path: "/parity/items/domain-err",
          init: { headers: { "x-request-id": "req-422-filter" } },
          expectedStatus: 422,
        },
        {
          label: "405 Method Not Allowed",
          path: "/parity/items/42",
          init: {
            method: "DELETE",
            headers: { "x-request-id": "req-405" },
          },
          expectedStatus: 405,
        },
      ];

      for (const scenario of scenarios) {
        const nativeSnap = await fetchJsonSnapshot(
          `${nativeFx.baseUrl}${scenario.path}`,
          scenario.init,
        );
        const fallbackSnap = await fetchJsonSnapshot(
          `${fallbackFx.baseUrl}${scenario.path}`,
          scenario.init,
        );

        expect(nativeSnap.status).toBe(scenario.expectedStatus);
        expect(fallbackSnap.status).toBe(scenario.expectedStatus);
        expect(fallbackSnap).toEqual(nativeSnap);
      }
    } finally {
      await Promise.all([nativeFx.app.close(), fallbackFx.app.close()]);
    }
  });

  it("enforces exact execution order Guard -> Interceptor (before) -> Pipe -> Handler -> Interceptor (after) in both modes", async () => {
    const nativeFx = await createParityApp("native");
    const fallbackFx = await createParityApp("fallback");

    try {
      const expectedOrder = [
        "guard",
        "interceptor:before",
        "pipe",
        "handler",
        "interceptor:after",
      ];

      const nativeSnap = await fetchJsonSnapshot(
        `${nativeFx.baseUrl}/parity/pipeline/hello`,
        { headers: { "x-request-id": "trace-1" } },
      );
      const fallbackSnap = await fetchJsonSnapshot(
        `${fallbackFx.baseUrl}/parity/pipeline/hello`,
        { headers: { "x-request-id": "trace-1" } },
      );

      expect(nativeSnap.status).toBe(200);
      expect(fallbackSnap.status).toBe(200);
      expect(nativeSnap.body).toEqual({
        slug: "hello",
        requestId: "trace-1",
        trace: expectedOrder,
      });
      expect(fallbackSnap.body).toEqual(nativeSnap.body);
    } finally {
      await Promise.all([nativeFx.app.close(), fallbackFx.app.close()]);
    }
  });

  for (const mode of ["native", "fallback"] as const) {
    it(`[${mode}] isolates request-scoped DI state across 20 concurrent requests with zero leaks`, async () => {
      const fx = await createParityApp(mode);
      try {
        fx.resetDestroyedCount();

        const concurrency = 20;
        const responses = await Promise.all(
          Array.from({ length: concurrency }, async (_, idx) => {
            const reqId = `iso-${mode}-${idx}`;
            const delay = ((concurrency - idx) % 5) * 5;
            const res = await fetch(
              `${fx.baseUrl}/parity/isolated?delay=${delay}`,
              { headers: { "x-request-id": reqId } },
            );
            expect(res.status).toBe(200);
            const data = (await res.json()) as {
              beforeRequestId: string;
              afterRequestId: string;
              beforeInstanceId: number;
              afterInstanceId: number;
            };
            return { expectedReqId: reqId, data };
          }),
        );

        const instanceIds = new Set<number>();
        for (const { expectedReqId, data } of responses) {
          expect(data.beforeRequestId).toBe(expectedReqId);
          expect(data.afterRequestId).toBe(expectedReqId);
          expect(data.beforeInstanceId).toBe(data.afterInstanceId);
          instanceIds.add(data.beforeInstanceId);
        }

        expect(instanceIds.size).toBe(concurrency);
        expect(fx.getDestroyedCount()).toBe(concurrency);
      } finally {
        await fx.app.close();
      }
    });

    it(`[${mode}] survives client AbortController cancellation on slow & streaming routes without corrupting subsequent requests`, async () => {
      const fx = await createParityApp(mode);
      try {
        // 1. Cancel an in-flight delayed JSON request
        const slowAbort = new AbortController();
        const slowPromise = fetch(`${fx.baseUrl}/parity/slow?ms=400`, {
          headers: { "x-request-id": `abort-slow-${mode}` },
          signal: slowAbort.signal,
        });
        await fx.waitForSlowEntry();
        slowAbort.abort();

        let slowAborted = false;
        try {
          await slowPromise;
        } catch (err) {
          slowAborted =
            err instanceof Error &&
            (err.name === "AbortError" ||
              err.message.toLowerCase().includes("abort"));
        }
        expect(slowAborted).toBe(true);

        // 2. Cancel an in-flight streaming response mid-stream
        const streamAbort = new AbortController();
        const streamRes = await fetch(`${fx.baseUrl}/parity/stream`, {
          headers: { "x-request-id": `abort-stream-${mode}` },
          signal: streamAbort.signal,
        });
        expect(streamRes.status).toBe(200);
        const reader = streamRes.body?.getReader();
        expect(reader).toBeDefined();
        const firstChunk = await reader!.read();
        expect(firstChunk.done).toBe(false);
        streamAbort.abort();
        await reader!.cancel().catch(() => {});

        // 3. Subsequent GET and POST requests must succeed cleanly
        const afterGet = await fetchJsonSnapshot(
          `${fx.baseUrl}/parity/items/99`,
          { headers: { "x-request-id": `post-abort-get-${mode}` } },
        );
        expect(afterGet.status).toBe(200);
        expect(afterGet.body).toEqual({
          id: "99",
          requestId: `post-abort-get-${mode}`,
        });

        const afterPost = await fetchJsonSnapshot(`${fx.baseUrl}/parity/items`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-request-id": `post-abort-post-${mode}`,
          },
          body: JSON.stringify({ name: "Recovered", quantity: 7 }),
        });
        expect(afterPost.status).toBe(201);
        expect(afterPost.body).toEqual({
          created: { name: "Recovered", quantity: 7 },
          requestId: `post-abort-post-${mode}`,
        });
      } finally {
        await fx.app.close();
      }
    });

    it(`[${mode}] drains in-flight request cleanly on app.close() with 200 and rejects subsequent requests`, async () => {
      const fx = await createParityApp(mode);
      let closed = false;
      try {
        fx.resetSlowEntry();

        const inFlightPromise = fetch(`${fx.baseUrl}/parity/slow?ms=120`, {
          headers: { "x-request-id": `drain-${mode}` },
        });

        // Wait until the handler is actively executing before initiating shutdown
        await fx.waitForSlowEntry();

        const closePromise = fx.app.close().then(() => {
          closed = true;
        });

        const inFlightRes = await inFlightPromise;
        expect(inFlightRes.status).toBe(200);
        const inFlightBody = (await inFlightRes.json()) as {
          ok: boolean;
          waitedMs: number;
          requestId: string;
        };
        expect(inFlightBody).toEqual({
          ok: true,
          waitedMs: 120,
          requestId: `drain-${mode}`,
        });

        await closePromise;
        expect(closed).toBe(true);
        expect(fx.app.getUrl()).toBeUndefined();

        // Subsequent request after close must fail cleanly
        let rejectedAfterClose = false;
        try {
          await fetch(`${fx.baseUrl}/parity/items/1`);
        } catch {
          rejectedAfterClose = true;
        }
        expect(rejectedAfterClose).toBe(true);
      } finally {
        if (!closed) {
          await fx.app.close().catch(() => {});
        }
      }
    });
  }
});
