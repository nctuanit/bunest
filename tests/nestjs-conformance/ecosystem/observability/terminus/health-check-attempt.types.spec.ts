import { beforeEach, expect, it, mock } from "bun:test";
import {
  DiskHealthIndicator,
  HealthIndicatorService,
  HealthIndicatorSession,
  MemoryHealthIndicator,
  type HealthCheckAttempt,
  type HealthIndicatorResult,
} from "../../../../../packages/observability/src";
import { describeConformance } from "../../../_helpers/index";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Extends<A, B> = A extends B ? true : false;

function assertEqualType<A, B>(
  ..._check: Equal<A, B> extends true ? [] : [never]
): void {}

function assertValueType<Expected>() {
  return <Actual>(
    _value: Actual,
    ..._check: Equal<Actual, Expected> extends true ? [] : [never]
  ): void => {};
}

function assertExtends<Actual, Expected>(
  _value: Actual,
  ..._check: Extends<Actual, Expected> extends true ? [] : [never]
): void {}

class PaymentError extends Error {
  constructor(public readonly code: string) {
    super(`payment failed: ${code}`);
  }
}

describeConformance(
  "HealthCheckAttempt types",
  {
    upstreamPath:
      "terminus/lib/health-indicator/service/health-check-attempt.types.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-002"],
    notes:
      "Converts Vitest expectTypeOf assertions to strict compile-time TypeScript assertions verified by `bun check`, paired with runtime shape checks.",
  },
  () => {
    let session: HealthIndicatorSession<"test">;

    beforeEach(() => {
      session = new HealthIndicatorSession("test");
    });

    it("should type the success and the failure entry", async () => {
      const result = await session
        .attempt(() => ({ region: "eu" as string, secret: "shh" }))
        .withData({ owner: "team-billing" })
        .withSuccessData((res) => ({ region: res.region }))
        .withFailureData((error) => ({ code: (error as PaymentError).code }));

      assertValueType<"team-billing">()(result.test.owner);
      assertValueType<number>()(result.test.responseTime);
      assertValueType<true | undefined>()(result.test.cachedResponse);

      if (result.test.status === "up") {
        assertValueType<string>()(result.test.region);
        // @ts-expect-error the raw return value is not part of the result
        void result.test.secret;
        // @ts-expect-error the failure data is not in a successful result
        void result.test.code;
        // @ts-expect-error a successful result has no message
        void result.test.message;
      }
      if (result.test.status === "down") {
        assertValueType<string>()(result.test.message);
        assertValueType<string>()(result.test.code);
        // @ts-expect-error the success data is not in a failed result
        void result.test.region;
      }
      if (result.test.status === "degraded") {
        // a slow success or a degraded failure: only the shared fields are known
        assertValueType<"team-billing">()(result.test.owner);
        // @ts-expect-error only a failed result has a message
        void result.test.message;
      }

      expect(result.test).toEqual({
        status: "up",
        owner: "team-billing",
        region: "eu",
        responseTime: expect.any(Number),
      });
    });

    it("should type async and literal success data", async () => {
      const asyncResult = await session
        .attempt(() => ({ ok: 1 }))
        .withSuccessData(async (res) => ({ ok: res.ok === 1 }));
      if (asyncResult.test.status === "up") {
        assertValueType<boolean>()(asyncResult.test.ok);
        expect(asyncResult.test.ok).toBe(true);
      }

      const literalResult = await session
        .attempt(() => {})
        .withSuccessData(() => ({ region: "eu", tags: ["a", "b"] }));
      if (literalResult.test.status === "up") {
        assertValueType<"eu">()(literalResult.test.region);
        assertValueType<readonly ["a", "b"]>()(literalResult.test.tags);
        expect(literalResult.test.region).toBe("eu");
        expect(literalResult.test.tags).toEqual(["a", "b"]);
      }
    });

    it("should type merged calls: the later type replaces the earlier key", async () => {
      const clash = await session
        .attempt(() => {})
        .withData({ owner: "asdf", a: "a" })
        .withData({ b: "b", owner: "b" });
      assertValueType<"b">()(clash.test.owner);
      assertValueType<"a">()(clash.test.a);
      expect(clash.test).toMatchObject({ owner: "b", a: "a", b: "b" });

      const three = await session
        .attempt(() => {})
        .withSuccessData({ a: 1, keep: true })
        .withSuccessData(() => ({ b: 2 }))
        .withSuccessData(async () => ({ a: "x" }));
      if (three.test.status === "up") {
        assertValueType<"x">()(three.test.a);
        assertValueType<2>()(three.test.b);
        assertValueType<true>()(three.test.keep);
        expect(three.test).toMatchObject({ a: "x", b: 2, keep: true });
      }

      const failure = await session
        .attempt(() => {})
        .withData({ code: 1 })
        .withFailureData({ code: "a" })
        .withFailureData({ code: "b", extra: 1 })
        .withFailureData({ more: 2 });
      if (failure.test.status === "down") {
        assertValueType<"b">()(failure.test.code);
        assertValueType<1>()(failure.test.extra);
        assertValueType<2>()(failure.test.more);
      }
      if (failure.test.status === "up") {
        // the success data has no `code`, so the static one stays
        assertValueType<1>()(failure.test.code);
        expect(failure.test.code).toBe(1);
      }
    });

    it("should not change the type with cacheFor, degradedAfter and degradedOnFailure", async () => {
      const plain = session.attempt(() => {}).withData({ owner: "x" });
      const built = session
        .attempt(() => {})
        .withData({ owner: "x" })
        .cacheFor(1000)
        .degradedAfter(200)
        .degradedOnFailure()
        .withTimeout(1000);
      assertEqualType<typeof built, typeof plain>();

      const result = await built;
      assertValueType<"up" | "degraded" | "down">()(result.test.status);
      assertValueType<true | undefined>()(result.test.cachedResponse);
      assertValueType<"x">()(result.test.owner);
      expect(result.test.status).toBe("up");
      expect(result.test.owner).toBe("x");
    });

    it("should infer the result type from the attempt function", async () => {
      const r1 = await session
        .attempt(async () => ({ ok: 1 as const }))
        .withSuccessData((res) => {
          assertValueType<{ ok: 1 }>()(res);
          return {};
        });
      expect(r1.test.status).toBe("up");

      const r2 = await session
        .attempt(() => {})
        .withFailureData((error) => {
          assertValueType<unknown>()(error);
          return {};
        });
      expect(r2.test.status).toBe("up");

      interface ServerInfo {
        version: string;
      }
      const info = {
        ok: true as boolean,
        server: { version: "1" } as ServerInfo,
      };
      // unions and interfaces are allowed
      const r3 = await session
        .attempt(() => info)
        .withSuccessData((res) =>
          res.ok ? { ok: true } : { ok: false, reason: "x" },
        );
      expect(r3.test).toMatchObject({ status: "up", ok: true });

      const r4 = await session
        .attempt(() => info)
        .withSuccessData((res) => res.server);
      expect(r4.test).toMatchObject({ status: "up", version: "1" });

      const r5 = await session
        .attempt(() => info)
        .withSuccessData(async (res) => res.server);
      expect(r5.test).toMatchObject({ status: "up", version: "1" });

      // the success data can use message
      const r6 = await session
        .attempt(() => {})
        .withSuccessData(() => ({ message: "x" }));
      expect(r6.test).toMatchObject({ status: "up", message: "x" });
    });

    it("should not allow primitives as data", () => {
      // @ts-expect-error primitives are not allowed
      const a1 = session.attempt(() => {}).withData("x");
      // @ts-expect-error primitives are not allowed
      const a2 = session.attempt(() => {}).withSuccessData(1);
      // @ts-expect-error primitives are not allowed
      const a3 = session.attempt(() => {}).withFailureData("x");
      expect(a1).toBeDefined();
      expect(a2).toBeDefined();
      expect(a3).toBeDefined();
    });

    it("should keep any attempt assignable to the untyped types", () => {
      const typed = session.attempt(() => 1).withData({ owner: "x" });
      const attempts = [
        typed,
        typed.cacheFor(1000),
        typed.degradedAfter(200),
        typed.degradedOnFailure(),
        typed
          .withSuccessData((n) => ({ n }))
          .withFailureData({ code: "x" })
          .cacheFor(1000)
          .degradedOnFailure()
          .degradedAfter(10),
      ];
      for (const attempt of attempts) {
        assertExtends<typeof attempt, HealthCheckAttempt<"test">>(attempt);
        assertExtends<
          typeof attempt,
          PromiseLike<HealthIndicatorResult<"test">>
        >(attempt);
        expect(typeof attempt.then).toBe("function");
      }
    });

    it("should let a user add data to an untyped (built-in) attempt", async () => {
      const builtIn: HealthCheckAttempt<"test"> = session
        .attempt(() => ({ statusCode: 1 }))
        .withSuccessData((res) => res);
      const result = await builtIn
        .withData({ owner: "x" })
        .withSuccessData({ extra: 1 });
      expect<unknown>(result.test).toEqual({
        status: "up",
        statusCode: 1,
        owner: "x",
        extra: 1,
        responseTime: expect.any(Number),
      });
      assertValueType<"x">()(result.test.owner);
    });

    it("should accept duration strings with a known unit only", () => {
      const attempt = session.attempt(() => {});
      attempt.withTimeout("2s").cacheFor("1.5m").degradedAfter(300);
      // @ts-expect-error not a unit
      expect(() => attempt.withTimeout("2 seconds")).toThrow();
      // @ts-expect-error units are lower case
      expect(() => attempt.cacheFor("2S")).toThrow();
      // @ts-expect-error a plain string needs a cast
      attempt.degradedAfter("300ms" as string);
    });

    it("should accept size strings with a known unit only", () => {
      const memory = new MemoryHealthIndicator(new HealthIndicatorService());
      const disk = new DiskHealthIndicator(
        mock(async () => ({ free: 100, size: 100 })),
        new HealthIndicatorService(),
      );
      memory.checkHeap("heap", "150mb");
      memory.checkRSS("rss", 1024);
      disk.checkStorage("disk", { path: "/", threshold: "250gb" });
      // @ts-expect-error units are lower case
      expect(() => memory.checkHeap("heap", "150MB")).toThrow();
      // @ts-expect-error not a unit
      expect(() => memory.checkRSS("rss", "150 megabytes")).toThrow();
      expect(() =>
        // @ts-expect-error a duration is not a size
        disk.checkStorage("disk", { path: "/", threshold: "2s" }),
      ).toThrow();
    });
  },
);
