import { describe, expect, it } from "bun:test";
import {
  BadRequestException,
  Controller,
  Get,
  Injectable,
  Module,
  Post,
} from "@bunest/common";
import { BunestFactory } from "@bunest/core";
import {
  Bulkhead,
  CircuitBreaker,
  Fallback,
  Resilience,
  ResilienceContext,
  ResilienceEvents,
  ResilienceModule,
  ResilienceService,
  Retry,
  Signal,
  Timeout,
  type ResilienceEvent,
  type ResilienceModuleOptions,
  type ResilienceOptionsFactory,
} from "../src/index";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("@bunest/resilience module & HTTP integration", () => {
  it("applies @Retry, @Timeout, @Signal, @Fallback, @CircuitBreaker, @Bulkhead, and @Resilience presets over HTTP", async () => {
    let getAttempts = 0;
    let postAttempts = 0;
    let idempotentPostAttempts = 0;
    let timeoutSignalAborted = false;
    let releaseBulkhead!: () => void;

    @Controller("items")
    class ItemsController {
      constructor(private readonly ctx: ResilienceContext) {}

      @Get("flaky")
      @Retry({ attempts: 3, backoff: { delay: 1, factor: 1, jitter: "none" } })
      flakyGet() {
        getAttempts++;
        if (getAttempts < 3) throw new Error("transient");
        return { attempts: getAttempts, ctxAttempt: this.ctx.attempt };
      }

      @Post("unsafe")
      @Retry({ attempts: 3, backoff: { delay: 1, factor: 1, jitter: "none" } })
      unsafePost() {
        postAttempts++;
        throw new Error("no-retry");
      }

      @Post("idempotent")
      @Retry({
        attempts: 3,
        idempotent: true,
        backoff: { delay: 1, factor: 1, jitter: "none" },
      })
      idempotentPost() {
        idempotentPostAttempts++;
        if (idempotentPostAttempts < 2) throw new Error("retry-me");
        return { ok: true, attempts: idempotentPostAttempts };
      }

      @Get("slow")
      @Timeout("25ms")
      async slow(@Signal() signal: AbortSignal) {
        signal?.addEventListener("abort", () => {
          timeoutSignalAborted = true;
        });
        await delay(100);
        return { ok: true };
      }

      @Get("fallback-method")
      @Fallback("recover")
      failingWithMethod() {
        throw new Error("upstream-down");
      }

      recover(err: unknown) {
        return { recovered: (err as Error).message };
      }

      @Get("fallback-client-error")
      @Fallback(() => ({ recovered: true }))
      failingWithClientError() {
        throw new BadRequestException("client-fault");
      }

      @Get("breaker")
      @CircuitBreaker({
        name: "shared-cb",
        minimumCalls: 2,
        failureRateThreshold: 50,
        openDuration: "5s",
      })
      breakerRoute() {
        throw new Error("downstream-500");
      }

      @Get("bulkhead")
      @Bulkhead({ name: "shared-bh", maxConcurrent: 1, maxQueue: 0 })
      async bulkheadRoute() {
        await new Promise<void>((r) => {
          releaseBulkhead = r;
        });
        return { ok: true };
      }

      @Get("preset")
      @Resilience("external")
      presetRoute() {
        return { fromPreset: true };
      }
    }

    @Module({
      imports: [
        ResilienceModule.forRoot({
          defaults: { timeout: "2s" },
          presets: {
            external: {
              retry: { attempts: 2, backoff: { delay: 1, factor: 1, jitter: "none" } },
              circuitBreaker: { minimumCalls: 2, failureRateThreshold: 50, openDuration: "5s" },
              timeout: "500ms",
            },
          },
        }),
      ],
      controllers: [ItemsController],
    })
    class AppModule {}

    const app = await BunestFactory.create(AppModule, { logger: false });
    await app.init();

    const events = app.get(ResilienceEvents);
    const service = app.get(ResilienceService);
    const captured: ResilienceEvent[] = [];
    let completed = false;
    events.events$.subscribe({
      next: (e) => captured.push(e),
      complete: () => {
        completed = true;
      },
    });

    // 1. GET retries automatically
    const r1 = await app.inject({ method: "GET", url: "/items/flaky" });
    expect(r1.statusCode).toBe(200);
    expect(r1.json()).toEqual({ attempts: 3, ctxAttempt: 3 });

    // 2. POST does NOT retry without idempotent: true
    const r2 = await app.inject({ method: "POST", url: "/items/unsafe" });
    expect(r2.statusCode).toBe(500);
    expect(postAttempts).toBe(1);

    // 3. POST with idempotent: true DOES retry
    const r3 = await app.inject({ method: "POST", url: "/items/idempotent" });
    expect(r3.statusCode).toBe(201);
    expect(r3.json()).toEqual({ ok: true, attempts: 2 });

    // 4. @Timeout returns 504 Gateway Timeout and aborts @Signal()
    const r4 = await app.inject({ method: "GET", url: "/items/slow" });
    expect(r4.statusCode).toBe(504);
    expect(r4.json()).toMatchObject({ statusCode: 504, code: "TIMEOUT" });
    expect(timeoutSignalAborted).toBe(true);

    // 5. @Fallback method recovers server error
    const r5 = await app.inject({ method: "GET", url: "/items/fallback-method" });
    expect(r5.statusCode).toBe(200);
    expect(r5.json()).toEqual({ recovered: "upstream-down" });

    // 6. @Fallback skips 4xx client error
    const r6 = await app.inject({
      method: "GET",
      url: "/items/fallback-client-error",
    });
    expect(r6.statusCode).toBe(400);

    // 7. @CircuitBreaker opens after 2 failures and responds 503 with Retry-After
    expect((await app.inject({ method: "GET", url: "/items/breaker" })).statusCode).toBe(500);
    expect((await app.inject({ method: "GET", url: "/items/breaker" })).statusCode).toBe(500);
    const r7 = await app.inject({ method: "GET", url: "/items/breaker" });
    expect(r7.statusCode).toBe(503);
    expect(r7.headers["retry-after"]).toBeDefined();
    expect(r7.json()).toMatchObject({ statusCode: 503, code: "CIRCUIT_OPEN" });
    expect(service.circuitBreaker("shared-cb").state).toBe("open");
    expect(service.circuitBreakers().length).toBeGreaterThanOrEqual(1);

    // 8. @Bulkhead returns 503 when saturated
    const bh1Promise = app.inject({ method: "GET", url: "/items/bulkhead" });
    await delay(10);
    const bh2 = await app.inject({ method: "GET", url: "/items/bulkhead" });
    expect(bh2.statusCode).toBe(503);
    expect(bh2.json()).toMatchObject({ statusCode: 503, code: "BULKHEAD_FULL" });
    expect(service.bulkhead("shared-bh").active).toBe(1);
    expect(service.bulkheads().length).toBeGreaterThanOrEqual(1);
    releaseBulkhead();
    expect((await bh1Promise).statusCode).toBe(200);

    // 9. Preset route & ResilienceService.preset() share breaker
    expect((await app.inject({ method: "GET", url: "/items/preset" })).statusCode).toBe(200);
    const presetPolicy = service.preset("external");
    expect(await presetPolicy.execute(() => "ok")).toBe("ok");
    expect(service.circuitBreaker("external").state).toBe("closed");

    // 10. Inline policy via ResilienceService.create()
    const inline = service.create({ retry: 2, timeout: "100ms" }, "inline-job");
    expect(await inline.execute(() => 42)).toBe(42);

    // 11. Events captured and completed on shutdown
    expect(captured.some((e) => e.type === "retry")).toBe(true);
    expect(captured.some((e) => e.type === "timeout")).toBe(true);
    expect(captured.some((e) => e.type === "circuit-open")).toBe(true);
    expect(captured.some((e) => e.type === "bulkhead-rejected")).toBe(true);
    expect(captured.some((e) => e.type === "fallback")).toBe(true);

    await app.close();
    expect(completed).toBe(true);
  });

  it("supports forRootAsync with useFactory and useClass", async () => {
    @Injectable()
    class MyResilienceConfig implements ResilienceOptionsFactory {
      createResilienceOptions(): ResilienceModuleOptions {
        return {
          presets: {
            billing: { timeout: "500ms", retry: 2 },
          },
        };
      }
    }

    @Module({
      imports: [
        ResilienceModule.forRootAsync({
          useClass: MyResilienceConfig,
        }),
      ],
    })
    class AsyncAppModule {}

    const app = await BunestFactory.create(AsyncAppModule, { logger: false });
    await app.init();
    const service = app.get(ResilienceService);
    expect(await service.preset("billing").execute(() => "paid")).toBe("paid");
    expect(() => service.preset("missing")).toThrow(/Unknown resilience preset/);
    expect(() => service.circuitBreaker("missing")).toThrow(/Unknown circuit breaker/);
    expect(() => service.bulkhead("missing")).toThrow(/Unknown bulkhead/);
    await app.close();

    @Module({
      imports: [
        ResilienceModule.forRootAsync({
          useFactory: async () => ({
            presets: {
              fast: { timeout: "200ms" },
            },
          }),
        }),
      ],
    })
    class FactoryAppModule {}

    const factoryApp = await BunestFactory.create(FactoryAppModule, { logger: false });
    await factoryApp.init();
    const factoryEvents = factoryApp.get(ResilienceEvents);
    const factorySvc = factoryApp.get(ResilienceService);
    const iterEvents: ResilienceEvent[] = [];
    const reader = (async () => {
      for await (const ev of factoryEvents.events$) {
        iterEvents.push(ev);
      }
    })();
    const retryP = factorySvc.create({
      retry: { attempts: 2, backoff: { delay: 1, factor: 1, jitter: "none" } },
    }, "iter-test");
    let n = 0;
    expect(await retryP.execute(() => (++n === 1 ? Promise.reject(new Error("once")) : "ok"))).toBe("ok");
    await factoryApp.close();
    await reader;
    expect(iterEvents.length).toBe(1);
    expect(iterEvents[0]?.type).toBe("retry");
  });

  it("fails bootstrap on invalid configuration (missing fallback method, bare @Timeout without default, conflicting named breakers)", async () => {
    @Controller("bad-fallback")
    class BadFallbackController {
      @Get()
      @Fallback("doesNotExist" as never)
      index() {
        return "hi";
      }
    }

    @Module({
      imports: [ResilienceModule.forRoot()],
      controllers: [BadFallbackController],
    })
    class BadFallbackModule {}

    const app1 = await BunestFactory.create(BadFallbackModule, { logger: false });
    await expect(app1.init()).rejects.toThrow(/has no method "doesNotExist"/);

    @Controller("bad-timeout")
    class BadTimeoutController {
      @Get()
      @Timeout()
      index() {
        return "hi";
      }
    }

    @Module({
      imports: [ResilienceModule.forRoot()],
      controllers: [BadTimeoutController],
    })
    class BadTimeoutModule {}

    const app2 = await BunestFactory.create(BadTimeoutModule, { logger: false });
    await expect(app2.init()).rejects.toThrow(/no defaults\.timeout/);

    @Controller("conflict")
    class ConflictController {
      @Get("a")
      @CircuitBreaker({ name: "dup", minimumCalls: 5 })
      a() {
        return "a";
      }

      @Get("b")
      @CircuitBreaker({ name: "dup", minimumCalls: 10 })
      b() {
        return "b";
      }
    }

    @Module({
      imports: [ResilienceModule.forRoot()],
      controllers: [ConflictController],
    })
    class ConflictModule {}

    const app3 = await BunestFactory.create(ConflictModule, { logger: false });
    await expect(app3.init()).rejects.toThrow(/configured differently/);
  });
});
