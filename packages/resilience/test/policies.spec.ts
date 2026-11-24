import { describe, expect, it } from "bun:test";
import {
  BadRequestException,
  InternalServerErrorException,
  subscribe,
  unsubscribe,
} from "@bunest/core";
import {
  BulkheadFullError,
  BulkheadPolicy,
  CircuitBreakerPolicy,
  CircuitOpenError,
  FallbackPolicy,
  isClientError,
  OutboundRateLimitError,
  OutboundRateLimitPolicy,
  ResilienceContext,
  ResiliencePolicy,
  ResilienceTimeoutError,
  RetryPolicy,
  TimeoutPolicy,
  type ResilienceEvent,
} from "../src/index";
import { createColdStream } from "../src/utils/reactive.util";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("@bunest/resilience policies", () => {
  describe("isClientError", () => {
    it("classifies 4xx HttpException and 4xx status errors except 408 and 429", () => {
      expect(isClientError(new BadRequestException("bad"))).toBe(true);
      expect(isClientError(new InternalServerErrorException("boom"))).toBe(
        false,
      );
      expect(isClientError({ status: 422 })).toBe(true);
      expect(isClientError({ statusCode: 404 })).toBe(true);
      expect(isClientError({ status: 408 })).toBe(false);
      expect(isClientError({ status: 429 })).toBe(false);
      expect(isClientError({ status: 503 })).toBe(false);
      expect(isClientError(new Error("boom"))).toBe(false);
      expect(isClientError(null)).toBe(false);
    });
  });

  describe("RetryPolicy", () => {
    it("retries transient errors and returns on eventual success", async () => {
      const policy = new RetryPolicy({
        attempts: 3,
        backoff: { delay: 1, factor: 1, jitter: "none" },
      });
      const seenAttempts: number[] = [];
      const result = await policy.execute(({ attempt }) => {
        seenAttempts.push(attempt);
        if (attempt < 3) throw new Error(`fail-${attempt}`);
        return "ok";
      });
      expect(result).toBe("ok");
      expect(seenAttempts).toEqual([1, 2, 3]);
    });

    it("does not retry client errors by default, but does retry 429/408", async () => {
      const policy = new RetryPolicy({
        attempts: 3,
        backoff: { delay: 1, factor: 1, jitter: "none" },
      });
      let calls = 0;
      await expect(
        policy.execute(() => {
          calls++;
          throw new BadRequestException("invalid");
        }),
      ).rejects.toThrow(BadRequestException);
      expect(calls).toBe(1);

      let rateLimitCalls = 0;
      const res = await policy.execute(() => {
        rateLimitCalls++;
        if (rateLimitCalls < 2)
          throw Object.assign(new Error("slow down"), { status: 429 });
        return "recovered";
      });
      expect(res).toBe("recovered");
      expect(rateLimitCalls).toBe(2);
    });

    it("supports retryOnResult and custom backoff function", async () => {
      const waits: number[] = [];
      const policy = new RetryPolicy({
        attempts: 3,
        backoff: (attempt) => {
          waits.push(attempt);
          return attempt === 1 ? -1 : 1;
        },
        retryOnResult: (val) => val === "pending",
      });
      let count = 0;
      const res = await policy.execute(() =>
        ++count < 3 ? "pending" : "ready",
      );
      expect(res).toBe("ready");
      expect(count).toBe(3);
      expect(waits).toEqual([1, 2]);
    });

    it("stops retrying immediately on caller abort and never retries RejectionError", async () => {
      const ac = new AbortController();
      const policy = new RetryPolicy({
        attempts: 5,
        backoff: { delay: 50, factor: 1, jitter: "none" },
      });
      let calls = 0;
      const promise = policy.execute(
        () => {
          calls++;
          setTimeout(() => ac.abort(new Error("cancelled")), 5);
          throw new Error("transient");
        },
        { signal: ac.signal },
      );
      await expect(promise).rejects.toThrow("cancelled");
      expect(calls).toBe(1);

      let rejCalls = 0;
      await expect(
        policy.execute(() => {
          rejCalls++;
          throw new CircuitOpenError("db", 1000);
        }),
      ).rejects.toThrow(CircuitOpenError);
      expect(rejCalls).toBe(1);
    });

    it("rejects async retryIf predicate with TypeError", async () => {
      const policy = new RetryPolicy({
        attempts: 2,
        retryIf: (async () => true) as unknown as (e: unknown) => boolean,
      });
      await expect(
        policy.execute(() => {
          throw new Error("boom");
        }),
      ).rejects.toThrow(TypeError);
    });
  });

  describe("TimeoutPolicy", () => {
    it("aborts attempt signal with ResilienceTimeoutError when budget expires", async () => {
      const policy = new TimeoutPolicy({ timeout: "25ms", name: "slow-op" });
      let observedSignal: AbortSignal | undefined;
      await expect(
        policy.execute(async ({ signal }) => {
          observedSignal = signal;
          await delay(100);
          return "too-late";
        }),
      ).rejects.toThrow(ResilienceTimeoutError);

      expect(observedSignal?.aborted).toBe(true);
      expect(observedSignal?.reason).toBeInstanceOf(ResilienceTimeoutError);
      expect((observedSignal?.reason as ResilienceTimeoutError).timeoutMs).toBe(
        25,
      );
      expect((observedSignal?.reason as ResilienceTimeoutError).policy).toBe(
        "slow-op",
      );
    });

    it("rejects zero or negative duration options", () => {
      expect(() => new TimeoutPolicy(0)).toThrow(TypeError);
      expect(() => new TimeoutPolicy(-5)).toThrow(TypeError);
    });
  });

  describe("CircuitBreakerPolicy", () => {
    it("transitions closed -> open -> half-open -> closed", async () => {
      const breaker = new CircuitBreakerPolicy({
        name: "payments",
        minimumCalls: 2,
        failureRateThreshold: 50,
        slidingWindow: { type: "count", size: 4 },
        openDuration: "30ms",
        halfOpenMaxCalls: 1,
      });

      expect(breaker.state).toBe("closed");
      await expect(
        breaker.execute(() => {
          throw new Error("err1");
        }),
      ).rejects.toThrow("err1");
      expect(breaker.state).toBe("closed");
      expect(breaker.stats).toEqual({
        total: 1,
        failures: 1,
        failureRate: 100,
      });

      await expect(
        breaker.execute(() => {
          throw new Error("err2");
        }),
      ).rejects.toThrow("err2");
      expect(breaker.state).toBe("open");

      await expect(breaker.execute(() => "blocked")).rejects.toThrow(
        CircuitOpenError,
      );

      await delay(35);
      expect(breaker.state).toBe("half-open");

      // Concurrent second probe while first probe is running should be rejected
      let releaseProbe!: () => void;
      const probePromise = breaker.execute(
        () =>
          new Promise<string>((r) => {
            releaseProbe = () => r("probe-ok");
          }),
      );
      await expect(breaker.execute(() => "extra-probe")).rejects.toThrow(
        CircuitOpenError,
      );

      releaseProbe();
      expect(await probePromise).toBe("probe-ok");
      expect(breaker.state).toBe("closed");
      expect(breaker.stats).toEqual({ total: 0, failures: 0, failureRate: 0 });
    });

    it("supports time sliding window, trip(), and reset()", async () => {
      const breaker = new CircuitBreakerPolicy({
        name: "time-cb",
        minimumCalls: 2,
        failureRateThreshold: 50,
        slidingWindow: { type: "time", size: "50ms" },
        openDuration: "500ms",
      });
      await breaker.execute(() => "ok");
      expect(breaker.stats.total).toBe(1);
      breaker.trip();
      expect(breaker.state).toBe("open");
      breaker.reset();
      expect(breaker.state).toBe("closed");
      expect(breaker.stats.total).toBe(0);
    });

    it("validates minimumCalls <= slidingWindow.size for count windows", () => {
      expect(
        () =>
          new CircuitBreakerPolicy({
            minimumCalls: 10,
            slidingWindow: { type: "count", size: 5 },
          }),
      ).toThrow(TypeError);
    });
  });

  describe("BulkheadPolicy", () => {
    it("enforces maxConcurrent, queues up to maxQueue, and rejects excess or timed-out waiters", async () => {
      const bulkhead = new BulkheadPolicy({
        name: "db-pool",
        maxConcurrent: 1,
        maxQueue: 1,
        queueTimeout: "30ms",
      });

      let finishFirst!: () => void;
      const first = bulkhead.execute(
        () =>
          new Promise<string>((r) => {
            finishFirst = () => r("first");
          }),
      );
      expect(bulkhead.active).toBe(1);
      expect(bulkhead.queued).toBe(0);

      const second = bulkhead.execute(() => "second");
      expect(bulkhead.queued).toBe(1);

      // Third call exceeds maxQueue -> immediate 'full' rejection
      let thirdErr: unknown;
      try {
        await bulkhead.execute(() => "third");
      } catch (e) {
        thirdErr = e;
      }
      expect(thirdErr).toBeInstanceOf(BulkheadFullError);
      expect((thirdErr as BulkheadFullError).reason).toBe("full");

      // Second call waits longer than queueTimeout -> 'queue-timeout'
      let secondErr: unknown;
      try {
        await second;
      } catch (e) {
        secondErr = e;
      }
      expect(secondErr).toBeInstanceOf(BulkheadFullError);
      expect((secondErr as BulkheadFullError).reason).toBe("queue-timeout");
      expect(bulkhead.queued).toBe(0);

      finishFirst();
      expect(await first).toBe("first");
      expect(bulkhead.active).toBe(0);
    });
  });

  describe("OutboundRateLimitPolicy", () => {
    it("allows burst up to limit, queues within maxWait, and rejects beyond maxWait", async () => {
      const limiter = new OutboundRateLimitPolicy({
        name: "partner-api",
        limit: 2,
        interval: "40ms",
        maxWait: "10ms",
      });

      expect(limiter.available).toBe(2);
      expect(await limiter.execute(() => 1)).toBe(1);
      expect(await limiter.execute(() => 2)).toBe(2);
      expect(limiter.available).toBe(0);

      await expect(limiter.execute(() => 3)).rejects.toThrow(
        OutboundRateLimitError,
      );

      await delay(45);
      expect(await limiter.execute(() => 4)).toBe(4);
    });

    it("refunds reserved token on abort while waiting and does not count as circuit breaker failure", async () => {
      const breaker = new CircuitBreakerPolicy({
        name: "outer-cb",
        minimumCalls: 1,
        failureRateThreshold: 50,
      });
      const limiter = new OutboundRateLimitPolicy({
        name: "inner-rl",
        limit: 1,
        interval: "200ms",
        maxWait: "500ms",
      });
      const timeout = new TimeoutPolicy("20ms");
      const wrapped = ResiliencePolicy.wrap(timeout, breaker, limiter);

      await wrapped.execute(() => "first");
      await expect(wrapped.execute(() => "second")).rejects.toThrow(
        ResilienceTimeoutError,
      );
      expect(breaker.state).toBe("closed");
      expect(breaker.stats.failures).toBe(0);
    });
  });

  describe("FallbackPolicy & Policy.wrap", () => {
    it("replaces transient failures and composes outermost-first", async () => {
      const order: string[] = [];
      const fallback = new FallbackPolicy(
        (err) => {
          order.push(`fallback:${(err as Error).message}`);
          return "cached";
        },
        { name: "fb" },
      );
      const retry = new RetryPolicy({
        attempts: 2,
        backoff: { delay: 1, factor: 1, jitter: "none" },
      });
      const wrapped = ResiliencePolicy.wrap(fallback, retry);

      const res = await wrapped.execute<string>(({ attempt }) => {
        order.push(`attempt:${attempt}`);
        throw new Error("down");
      });
      expect(res).toBe("cached");
      expect(order).toEqual(["attempt:1", "attempt:2", "fallback:down"]);

      // Client error bypasses fallback
      await expect(
        wrapped.execute(() => {
          throw new BadRequestException("bad-input");
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("executeObservable (zero-RxJS Subscribable & AsyncIterable)", () => {
    it("retries before emission, commits on first emission, and cancels on unsubscribe", async () => {
      const retry = new RetryPolicy({
        attempts: 3,
        backoff: { delay: 1, factor: 1, jitter: "none" },
      });
      let attempts = 0;
      const stream = retry.executeObservable(() =>
        createColdStream<string>((sub) => {
          attempts++;
          if (attempts < 2) {
            sub.error(new Error("early-fail"));
            return;
          }
          sub.next("hello");
          sub.next("world");
          sub.complete();
        }),
      );

      const values: string[] = [];
      for await (const val of stream) {
        values.push(val);
      }
      expect(values).toEqual(["hello", "world"]);
      expect(attempts).toBe(2);

      // Unsubscribing cancels in-flight attempt signal
      let aborted = false;
      const cancelStream = retry.executeObservable(({ signal }) =>
        createColdStream<string>(() => {
          signal.addEventListener("abort", () => {
            aborted = true;
          });
        }),
      );
      const sub = cancelStream.subscribe(() => undefined);
      sub.unsubscribe();
      expect(aborted).toBe(true);
    });
  });

  describe("ResilienceContext & diagnostics_channel", () => {
    it("propagates signal and attempt through AsyncLocalStorage and publishes events", async () => {
      const ctx = new ResilienceContext();
      expect(ctx.signal).toBeUndefined();
      expect(ctx.attempt).toBeUndefined();

      const observed: ResilienceEvent[] = [];
      const listener = (msg: unknown) => observed.push(msg as ResilienceEvent);
      subscribe("nestjs:resilience:retry", listener);

      try {
        const retry = new RetryPolicy({
          name: "ctx-retry",
          attempts: 2,
          backoff: { delay: 1, factor: 1, jitter: "none" },
        });
        const ac = new AbortController();
        const attemptsSeen: number[] = [];

        const result = await ctx.run({ signal: ac.signal }, () =>
          retry.execute(async () => {
            attemptsSeen.push(ctx.attempt ?? -1);
            expect(ctx.signal).toBeDefined();
            if (ctx.attempt === 1) throw new Error("once");
            return "done";
          }),
        );

        expect(result).toBe("done");
        expect(attemptsSeen).toEqual([1, 2]);
        expect(observed.length).toBeGreaterThanOrEqual(1);
        expect(observed[0]?.type).toBe("retry");
        expect(observed[0]?.policy).toBe("ctx-retry");
      } finally {
        unsubscribe("nestjs:resilience:retry", listener);
      }
    });
  });
});
