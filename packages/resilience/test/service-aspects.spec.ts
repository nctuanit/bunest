import { describe, expect, test } from "bun:test";
import {
  BadRequestException,
  Controller,
  Get,
  Injectable,
  Module,
  Post,
  Scope,
} from "@bunest/core";
import { BunestFactory } from "@bunest/core";
import {
  Bulkhead,
  BulkheadFullError,
  CircuitBreaker,
  CircuitOpenError,
  Fallback,
  Resilience,
  ResilienceContext,
  ResilienceModule,
  ResilienceService,
  ResilienceTimeoutError,
  Retry,
  Timeout,
} from "../src";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("@bunest/resilience Service-Level Method Aspect Integration", () => {
  test("executes @Retry, @Timeout, @CircuitBreaker, @Bulkhead, @Fallback, and @Resilience directly on @Injectable() services", async () => {
    let flakyAttempts = 0;
    let stackedAttempts = 0;
    let timeoutSignalAborted = false;
    let releaseBulkhead!: () => void;

    @Injectable()
    class DownstreamService {
      constructor(private readonly ctx: ResilienceContext) {}

      @Retry({ attempts: 3, backoff: { delay: 1, factor: 1, jitter: "none" } })
      async fetchWithRetry(): Promise<{
        attempts: number;
        ctxAttempt: number | undefined;
      }> {
        flakyAttempts += 1;
        if (flakyAttempts < 3) {
          throw new Error("transient network error");
        }
        return { attempts: flakyAttempts, ctxAttempt: this.ctx.attempt };
      }

      @Timeout("25ms")
      async slowCall(): Promise<string> {
        this.ctx.signal?.addEventListener("abort", () => {
          timeoutSignalAborted = true;
        });
        await delay(100);
        return "too-late";
      }

      @CircuitBreaker({
        name: "svc-cb",
        minimumCalls: 2,
        failureRateThreshold: 50,
        openDuration: "5s",
      })
      async unstableCall(): Promise<never> {
        throw new Error("downstream-500");
      }

      @Bulkhead({ name: "svc-bh", maxConcurrent: 1, maxQueue: 0 })
      async limitedCall(): Promise<string> {
        await new Promise<void>((resolve) => {
          releaseBulkhead = resolve;
        });
        return "done";
      }

      @Fallback("recoverFetch")
      async failingWithMethodFallback(input: string): Promise<string> {
        throw new Error(`failed:${input}`);
      }

      recoverFetch(err: unknown): string {
        return `recovered:${(err as Error).message}`;
      }

      @Fallback((err) => `fn-fallback:${(err as Error).message}`)
      async failingWithFnFallback(): Promise<string> {
        throw new Error("boom");
      }

      @Fallback(() => "should-not-recover-4xx")
      async clientFault(): Promise<string> {
        throw new BadRequestException("invalid input");
      }

      // Stacked decorators must compose ONCE (NOT multiply retries!)
      @Fallback(() => "stacked-fallback")
      @Retry({ attempts: 3, backoff: { delay: 1, factor: 1, jitter: "none" } })
      @CircuitBreaker({
        name: "stacked-cb",
        minimumCalls: 5,
        failureRateThreshold: 100,
      })
      @Timeout("500ms")
      async stackedFailure(): Promise<string> {
        stackedAttempts += 1;
        throw new Error("always fails");
      }

      @Resilience("external-api")
      async presetCall(): Promise<string> {
        return "from-preset";
      }
    }

    @Module({
      imports: [
        ResilienceModule.forRoot({
          presets: {
            "external-api": {
              retry: {
                attempts: 2,
                backoff: { delay: 1, factor: 1, jitter: "none" },
              },
              circuitBreaker: {
                minimumCalls: 2,
                failureRateThreshold: 50,
                openDuration: "5s",
              },
              timeout: "500ms",
            },
          },
        }),
      ],
      providers: [DownstreamService],
    })
    class AppModule {}

    const ctx = await BunestFactory.createApplicationContext(AppModule, {
      logger: false,
    });

    try {
      const svc = ctx.get(DownstreamService);
      const resilience = ctx.get(ResilienceService);

      // 1. @Retry on service method
      expect(await svc.fetchWithRetry()).toEqual({
        attempts: 3,
        ctxAttempt: 3,
      });

      // 2. @Timeout on service method + ResilienceContext.signal abort
      await expect(svc.slowCall()).rejects.toBeInstanceOf(
        ResilienceTimeoutError,
      );
      expect(timeoutSignalAborted).toBe(true);

      // 3. @CircuitBreaker on service method opens and throws CircuitOpenError
      await expect(svc.unstableCall()).rejects.toThrow("downstream-500");
      await expect(svc.unstableCall()).rejects.toThrow("downstream-500");
      await expect(svc.unstableCall()).rejects.toBeInstanceOf(CircuitOpenError);
      expect(resilience.circuitBreaker("svc-cb").state).toBe("open");

      // 4. @Bulkhead on service method rejects excess concurrency with BulkheadFullError
      const p1 = svc.limitedCall();
      await delay(10);
      await expect(svc.limitedCall()).rejects.toBeInstanceOf(BulkheadFullError);
      expect(resilience.bulkhead("svc-bh").active).toBe(1);
      releaseBulkhead();
      expect(await p1).toBe("done");

      // 5. @Fallback method & function recovery, skipping 4xx client errors
      expect(await svc.failingWithMethodFallback("x")).toBe(
        "recovered:failed:x",
      );
      expect(await svc.failingWithFnFallback()).toBe("fn-fallback:boom");
      await expect(svc.clientFault()).rejects.toBeInstanceOf(
        BadRequestException,
      );

      // 6. Stacked decorators run ONCE (exactly 3 attempts, then fallback)
      expect(await svc.stackedFailure()).toBe("stacked-fallback");
      expect(stackedAttempts).toBe(3);

      // 7. @Resilience preset executes and shares breaker with ResilienceService
      expect(await svc.presetCall()).toBe("from-preset");
      expect(resilience.circuitBreaker("external-api").state).toBe("closed");
    } finally {
      await ctx.close();
    }
  });

  test("supports class-level resilience, TRANSIENT scope with @Fallback method, and does NOT double-wrap HTTP controller handlers", async () => {
    let classServiceAttempts = 0;
    let httpGetAttempts = 0;
    let httpPostAttempts = 0;

    @Injectable({ scope: Scope.TRANSIENT })
    @Retry({ attempts: 2, backoff: { delay: 1, factor: 1, jitter: "none" } })
    class TransientPolicyService {
      readonly tag = Math.random();

      @Fallback("recover")
      async run(shouldFail: boolean): Promise<string> {
        classServiceAttempts += 1;
        if (shouldFail) {
          throw new Error("transient-fail");
        }
        return "ok";
      }

      recover(err: unknown): string {
        return `transient-recovered:${(err as Error).message}:${this.tag}`;
      }
    }

    @Controller("check")
    class CheckController {
      @Get("retry")
      @Retry({ attempts: 3, backoff: { delay: 1, factor: 1, jitter: "none" } })
      flakyGet() {
        httpGetAttempts += 1;
        if (httpGetAttempts < 3) {
          throw new Error("retry-http");
        }
        return { attempts: httpGetAttempts };
      }

      @Post("no-retry")
      @Retry({ attempts: 3, backoff: { delay: 1, factor: 1, jitter: "none" } })
      unsafePost() {
        httpPostAttempts += 1;
        throw new Error("unsafe-post");
      }
    }

    @Module({
      imports: [ResilienceModule.forRoot()],
      controllers: [CheckController],
      providers: [TransientPolicyService],
    })
    class AppModule {}

    const app = await BunestFactory.create(AppModule, { logger: false });
    await app.init();

    try {
      // Transient service with class-level @Retry + method @Fallback("recover")
      const inst = await app.resolve(TransientPolicyService);
      const recovered = await inst.run(true);
      expect(recovered).toBe(`transient-recovered:transient-fail:${inst.tag}`);
      expect(classServiceAttempts).toBe(2);

      // HTTP GET retries exactly 3 times (no double-wrapping with aspect!)
      const r1 = await app.inject({ method: "GET", url: "/check/retry" });
      expect(r1.statusCode).toBe(200);
      expect(r1.json()).toEqual({ attempts: 3 });
      expect(httpGetAttempts).toBe(3);

      // HTTP POST without idempotent: true still runs ONCE (ResilienceInterceptor rules intact!)
      const r2 = await app.inject({ method: "POST", url: "/check/no-retry" });
      expect(r2.statusCode).toBe(500);
      expect(httpPostAttempts).toBe(1);
    } finally {
      await app.close();
    }
  });

  test("fails fast at bootstrap on invalid resilience config on @Injectable() services", async () => {
    @Injectable()
    class BrokenService {
      @Fallback("nonExistentMethod" as never)
      async doWork(): Promise<string> {
        return "x";
      }
    }

    @Module({
      imports: [ResilienceModule.forRoot()],
      providers: [BrokenService],
    })
    class BrokenModule {}

    const app = await BunestFactory.create(BrokenModule, { logger: false });
    await expect(app.init()).rejects.toThrow(
      /has no method "nonExistentMethod"/,
    );
  });
});
