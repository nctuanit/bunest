import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from "bun:test";
import { Logger } from "../../../../../packages/core/src/common";
import { HealthIndicatorService } from "../../../../../packages/observability/src";
import { describeConformance, itAdapted } from "../../../_helpers/index";

function sleep(
  ms: number,
  _value?: undefined,
  options?: { signal?: AbortSignal },
): Promise<void> {
  const signal = options?.signal;
  if (!signal) {
    return Bun.sleep(ms);
  }
  if (signal.aborted) {
    return Promise.reject(
      signal.reason ?? new DOMException("The operation was aborted.", "AbortError"),
    );
  }
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(
        signal.reason ??
          new DOMException("The operation was aborted.", "AbortError"),
      );
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

describeConformance(
  "AttemptData",
  {
    upstreamPath: "terminus/lib/health-indicator/service/attempt-data.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Bunest integrates AttemptData directly inside HealthCheckAttempt (withData, withSuccessData, withFailureData) rather than exporting a standalone AttemptData class.",
  },
  () => {
    let warnSpy: ReturnType<typeof spyOn>;
    let svc: HealthIndicatorService;
    let keyCounter = 0;
    let currentKey = "";
    let cleanupController: AbortController;

    // Warnings are logged once per indicator key for the whole process, so each
    // test uses its own unique indicator key.
    const key = () => currentKey;
    const warnings = (text: string): string[] =>
      warnSpy.mock.calls
        .map(([msg]: unknown[]) => String(msg))
        .filter((m: string) => m.includes(text));
    const reserved = { status: "x", responseTime: "x", cachedResponse: "x" };

    beforeEach(() => {
      keyCounter += 1;
      currentKey = `attempt-data-test-${keyCounter}`;
      cleanupController = new AbortController();
      warnSpy = spyOn(Logger.prototype, "warn").mockImplementation(() => {});
      svc = new HealthIndicatorService();
    });

    afterEach(() => {
      cleanupController.abort();
      warnSpy.mockRestore();
    });

    describe("static data", () => {
      itAdapted(
        ["ADR-001"],
        "should merge calls, the last one wins",
        async () => {
          const result = await svc
            .check(key())
            .attempt(() => {})
            .withData({ owner: "asdf", a: "a" })
            .withData({ b: "b", owner: "b" });
          const entry = result[key()];
          expect(entry).toBeDefined();
          const staticEntries = Object.entries(entry!).filter(
            ([k]) => k !== "status" && k !== "responseTime",
          );
          expect(staticEntries).toEqual([
            ["owner", "b"],
            ["a", "a"],
            ["b", "b"],
          ]);
        },
        "Verified via HealthCheckAttempt.withData() since AttemptData is internal",
      );

      itAdapted(
        ["ADR-001"],
        "should copy the object, so changing it later has no effect",
        async () => {
          const labels = { owner: "a" };
          const attempt = svc
            .check(key())
            .attempt(() => {})
            .withData(labels);
          labels.owner = "b";
          const result = await attempt;
          expect(result[key()]?.owner).toBe("a");
        },
        "Verified via HealthCheckAttempt.withData()",
      );

      for (const reservedKey of [
        "status",
        "responseTime",
        "cachedResponse",
      ] as const) {
        itAdapted(
          ["ADR-001"],
          `should drop the reserved key "${reservedKey}" with a warning once per indicator`,
          async () => {
            const k = `${key()}:${reservedKey}`;
            const result = await svc
              .check(k)
              .attempt(() => {})
              .withData({ [reservedKey]: "x", foo: "bar" })
              .withData({ [reservedKey]: "x", baz: 1 });

            expect(result[k]).toEqual({
              status: "up",
              foo: "bar",
              baz: 1,
              responseTime: expect.any(Number),
            });
            expect(warnings("reserved key")).toEqual([
              `Ignoring reserved key(s) "${reservedKey}" in the data of health indicator "${k}".`,
            ]);
          },
          "Bunest omits the second hint sentence in the reserved-key warning",
        );
      }
    });

    describe("success data", () => {
      itAdapted(
        ["ADR-001"],
        "should run every function with the result and merge the data in call order",
        async () => {
          const first = mock((res: { a: number; secret: string }) => ({
            a: res.a,
            x: 1,
          }));
          const result = await svc
            .check(key())
            .attempt(() => ({ a: 1, secret: "shh" }))
            .withSuccessData(first)
            .withSuccessData({ b: 2 })
            .withSuccessData(async () => ({ x: 2 }));

          expect(first).toHaveBeenCalledWith({ a: 1, secret: "shh" });
          expect(result[key()]).toEqual({
            status: "up",
            a: 1,
            x: 2,
            b: 2,
            responseTime: expect.any(Number),
          });
        },
        "Verified via HealthCheckAttempt.withSuccessData()",
      );

      it.each([
        [
          "throws",
          () => {
            throw new Error("pick failed");
          },
        ],
        [
          "rejects",
          async () => {
            throw new Error("pick failed");
          },
        ],
      ])("should fail the attempt when a function %s", async (_label, pick) => {
        const result = await svc
          .check(key())
          .attempt(() => ({}))
          .withSuccessData(() => ({ a: 1 }))
          .withSuccessData(pick);

        expect(result[key()]).toEqual({
          status: "down",
          message: "pick failed",
          responseTime: expect.any(Number),
        });
      });

      itAdapted(
        ["ADR-001"],
        "should drop the reserved keys",
        async () => {
          const result = await svc
            .check(key())
            .attempt(() => undefined)
            .withSuccessData(() => ({ ...reserved, foo: "bar" }));
          expect<unknown>(result[key()]).toEqual({
            status: "up",
            foo: "bar",
            responseTime: expect.any(Number),
          });
        },
        "Verified via HealthCheckAttempt.withSuccessData()",
      );

      it("should warn about reserved keys once per indicator", async () => {
        for (const suffix of ["", "", ":b"]) {
          await svc
            .check(key() + suffix)
            .attempt(() => undefined)
            .withSuccessData({ status: 200 });
        }
        const reservedWarnings = warnings("reserved key");
        expect(reservedWarnings).toHaveLength(2);
        expect(reservedWarnings[0]).toContain('"status"');
        expect(reservedWarnings[1]).toContain(`indicator "${key()}:b"`);
      });

      // FIXME: Remove this in v13, the returned value is ignored (#2796)
      describe("without withSuccessData() (deprecated)", () => {
        it("should add the returned value, with a warning once per indicator", async () => {
          const first = await svc.check(key()).attempt(() => ({ ok: 1 }));
          expect(first[key()]).toEqual({
            status: "up",
            ok: 1,
            responseTime: expect.any(Number),
          });
          await svc.check(key()).attempt(() => ({ ok: 1 }));
          await svc.check(`${key()}:b`).attempt(() => ({ ok: 1 }));

          const deprecation = warnings("withSuccessData()");
          expect(deprecation).toEqual([
            `The value returned by attempt() for health indicator "${key()}" is added to the health check result. ` +
              "This is deprecated: the next major version ignores it. Use .withSuccessData() to choose the data to add, or return nothing.",
            expect.stringContaining(`"${key()}:b"`),
          ]);
        });

        it("should still add the returned value when only static data is set", async () => {
          const result = await svc
            .check(key())
            .attempt(() => ({ ok: 1 }))
            .withData({ owner: "x" });
          expect(result[key()]).toEqual({
            status: "up",
            owner: "x",
            ok: 1,
            responseTime: expect.any(Number),
          });
          expect(warnings("withSuccessData()")).toHaveLength(1);
        });

        it("should use withSuccessData() instead of the returned value, without a warning", async () => {
          const result = await svc
            .check(key())
            .attempt(() => ({ ok: 1 }))
            .withSuccessData(() => ({}));
          expect(result[key()]).toEqual({
            status: "up",
            responseTime: expect.any(Number),
          });
          expect(warnings("withSuccessData()")).toHaveLength(0);
        });

        it.each([undefined, {}, null, "ok", 42, true, [1, 2]])(
          "should add nothing and not warn for %p",
          async (value) => {
            const result = await svc.check(key()).attempt(() => value);
            expect(result[key()]).toEqual({
              status: "up",
              responseTime: expect.any(Number),
            });
            expect(warnSpy).not.toHaveBeenCalled();
          },
        );

        it("should drop the reserved keys", async () => {
          const result = await svc
            .check(key())
            .attempt(() => ({ ...reserved, foo: "bar" }));
          expect(result[key()]).toEqual({
            status: "up",
            foo: "bar",
            responseTime: expect.any(Number),
          });
        });

        it("should handle a circular reference with a reserved key (e.g. an axios response)", async () => {
          const response: Record<string, unknown> = { status: 200, data: "ok" };
          response.request = { res: response };
          const result = await svc.check(key()).attempt(() => response);
          expect(result[key()]).toEqual({
            status: "up",
            data: "ok",
            request: { res: response },
            responseTime: expect.any(Number),
          });
        });
      });
    });

    describe("failure data", () => {
      const error = new Error("boom");
      const throwBoom = () => {
        throw error;
      };

      itAdapted(
        ["ADR-001"],
        "should run every function with the error and merge the data in call order",
        async () => {
          const pick = mock((err: unknown) => ({
            reason: (err as Error).message,
            code: "a",
          }));
          const result = await svc
            .check(key())
            .attempt(throwBoom)
            .withFailureData(pick)
            .withFailureData({ code: "b", a: 1 })
            .withFailureData(async () => ({ code: "c" }));

          expect(pick).toHaveBeenCalledWith(error);
          expect(result[key()]).toEqual({
            status: "down",
            message: "boom",
            reason: "boom",
            code: "c",
            a: 1,
            responseTime: expect.any(Number),
          });
        },
        "Verified via HealthCheckAttempt.withFailureData()",
      );

      itAdapted(
        ["ADR-001"],
        "should drop the reserved keys",
        async () => {
          const result = await svc
            .check(key())
            .attempt(throwBoom)
            .withFailureData(() => ({ ...reserved, foo: "bar" }));
          expect<unknown>(result[key()]).toEqual({
            status: "down",
            message: "boom",
            foo: "bar",
            responseTime: expect.any(Number),
          });
        },
        "Verified via HealthCheckAttempt.withFailureData()",
      );

      it.each([
        [
          "throws",
          () => {
            throw new Error("pick failed");
          },
        ],
        [
          "rejects",
          async () => {
            throw new Error("pick failed");
          },
        ],
        ["returns null", () => null as unknown as Record<string, unknown>],
        [
          "returns a string",
          () => "oops" as unknown as Record<string, unknown>,
        ],
        ["returns an array", () => [1] as unknown as Record<string, unknown>],
      ])(
        "should skip a function that %s and keep the other data",
        async (_label, pick) => {
          const result = await svc
            .check(key())
            .attempt(throwBoom)
            .withFailureData({ a: 1 })
            .withFailureData(pick)
            .withFailureData({ b: 2 });
          expect(result[key()]).toEqual({
            status: "down",
            message: "boom",
            a: 1,
            b: 2,
            responseTime: expect.any(Number),
          });
        },
      );

      itAdapted(
        ["ADR-001"],
        "should warn once per indicator when a function fails",
        async () => {
          const failingPick = () => {
            throw new Error("pick failed");
          };
          await svc
            .check(key())
            .attempt(throwBoom)
            .withFailureData(failingPick);
          await svc
            .check(key())
            .attempt(throwBoom)
            .withFailureData(failingPick);

          expect(warnings("failure data")).toEqual([
            `Could not add failure data to health indicator "${key()}": pick failed`,
          ]);
        },
        "Bunest formats failure-data warning as 'Could not add failure data to health indicator \"<key>\": <msg>'",
      );

      itAdapted(
        ["ADR-001"],
        "should run each function in what is left of the timeout",
        async () => {
          const start = performance.now();
          // Use ~30ms of a 60ms timeout before throwing, leaving ~30ms for failure data
          const result = await svc
            .check(key())
            .attempt(async () => {
              await sleep(25, undefined, { signal: cleanupController.signal });
              throw error;
            })
            .withTimeout(60)
            .withFailureData(() =>
              sleep(5000, undefined, { signal: cleanupController.signal })
                .then(() => ({ late: true }))
                .catch(() => ({ late: true })),
            )
            .withFailureData({ code: "x" });

          expect<unknown>(result[key()]).toEqual({
            status: "down",
            message: "boom",
            code: "x",
            responseTime: expect.any(Number),
          });
          expect(performance.now() - start).toBeLessThan(500);
          const failureWarn = warnings("failure data")[0];
          expect(failureWarn).toBeDefined();
          const match = /timeout of (\d+)ms/.exec(failureWarn!);
          expect(match).not.toBeNull();
          const remainingMs = Number(match![1]);
          expect(remainingMs).toBeGreaterThan(0);
          expect(remainingMs).toBeLessThanOrEqual(45);
        },
        "Verified end-to-end through HealthCheckAttempt.withTimeout() + withFailureData()",
      );

      itAdapted(
        ["ADR-001"],
        "should still run a sync function when the timeout has passed",
        async () => {
          const result = await svc
            .check(key())
            .attempt(async ({ signal }) => {
              await sleep(5000, undefined, { signal });
            })
            .withTimeout(20)
            .withFailureData(() => ({ sync: true }))
            .withFailureData(async () => ({ async: true }));

          expect(result[key()]).toEqual({
            status: "down",
            message: "timeout of 20ms exceeded",
            sync: true,
            async: true,
            responseTime: expect.any(Number),
          });
        },
        "Verified via timed-out HealthCheckAttempt where remaining timeout is 0ms",
      );
    });
  },
);
