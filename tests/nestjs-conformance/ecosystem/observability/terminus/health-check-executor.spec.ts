import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { LoggerService } from "../../../../../packages/core/src/common";
import {
  HealthCheckException,
  HealthCheckService,
  HealthIndicatorService,
  TERMINUS_LOGGER,
  TERMINUS_MODULE_OPTIONS,
  type HealthCheckResult,
  type InferHealthIndicatorResult,
  type TerminusAsyncModuleOptions,
} from "../../../../../packages/observability/src";
import {
  Test,
  type TestingModule,
  describeConformance,
  itAdapted,
} from "../../../_helpers/index";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Assert<T extends true> = T;

const healthIndicator = async (h: HealthIndicatorService) =>
  h.check("healthy").up();

const unhealthyHealthIndicator = async (h: HealthIndicatorService) =>
  h.check("unhealthy").down();

const unhealthyHealthIndicatorSync = (h: HealthIndicatorService) =>
  h.check("unhealthy").down();

describeConformance(
  "HealthCheckExecutorService",
  {
    upstreamPath:
      "terminus/lib/health-check/health-check-executor.service.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Bunest folds HealthCheckExecutor logic directly into HealthCheckService (parallel indicator execution, degraded aggregation, HealthCheckException on error/shutting_down, and beforeApplicationShutdown delay).",
  },
  () => {
    let healthCheckService: HealthCheckService;
    let h: HealthIndicatorService;
    let logMock: ReturnType<typeof mock>;
    let errorMock: ReturnType<typeof mock>;
    let warnMock: ReturnType<typeof mock>;
    const modules: TestingModule[] = [];

    const executeAndCapture = async (
      indicators: Parameters<HealthCheckService["check"]>[0],
    ): Promise<HealthCheckResult> => {
      try {
        return await healthCheckService.check(indicators);
      } catch (err) {
        if (err instanceof HealthCheckException) {
          return err.result;
        }
        throw err;
      }
    };

    const bootstrap = async (options: TerminusAsyncModuleOptions = {}) => {
      logMock = mock(() => {});
      errorMock = mock(() => {});
      warnMock = mock(() => {});
      const loggerMock: LoggerService = {
        log: logMock,
        error: errorMock,
        warn: warnMock,
      };

      const context = await Test.createTestingModule({
        providers: [
          HealthCheckService,
          HealthIndicatorService,
          { provide: TERMINUS_LOGGER, useValue: loggerMock },
          { provide: TERMINUS_MODULE_OPTIONS, useValue: options },
        ],
      }).compile({ logger: false });
      modules.push(context);
      healthCheckService = context.get(HealthCheckService);
      h = context.get(HealthIndicatorService);
    };

    beforeEach(async () => {
      await bootstrap();
    });

    afterEach(async () => {
      await Promise.all(modules.splice(0).map((m) => m.close("SIGINT")));
    });

    describe("execute", () => {
      itAdapted(
        ["ADR-001"],
        "should support HealthCheckAttempt in the health indicators array",
        async () => {
          const attempt = h
            .check("db")
            .attempt(async () => {})
            .withData({ owner: "team-db" });
          const result = await healthCheckService.check([attempt]);

          // Compile-time assertions matching upstream expectTypeOf checks:
          // A bare attempt keeps its key and its data types, like `() => attempt`
          type _CheckOwner = Assert<
            Equal<
              InferHealthIndicatorResult<typeof attempt>["db"]["owner"],
              "team-db"
            >
          >;
          type _CheckFnEquiv = Assert<
            Equal<
              InferHealthIndicatorResult<() => typeof attempt>,
              InferHealthIndicatorResult<typeof attempt>
            >
          >;
          const _typeGuard: [_CheckOwner, _CheckFnEquiv] = [true, true];
          expect(_typeGuard).toEqual([true, true]);

          expect(result).toEqual({
            status: "ok",
            info: {
              db: {
                status: "up",
                owner: "team-db",
                responseTime: expect.any(Number),
              },
            },
            error: {},
            details: {
              db: {
                status: "up",
                owner: "team-db",
                responseTime: expect.any(Number),
              },
            },
            timestamp: expect.any(String),
          });
        },
        "Executed via HealthCheckService.check() which adds ISO timestamp",
      );

      itAdapted(
        ["ADR-001"],
        "should support a failing HealthCheckAttempt",
        async () => {
          const attempt = h.check("db").attempt(async () => {
            throw new Error("Connection refused");
          });
          const result = await executeAndCapture([attempt]);
          expect(result).toEqual({
            status: "error",
            info: {},
            error: {
              db: {
                status: "down",
                message: "Connection refused",
                responseTime: expect.any(Number),
              },
            },
            details: {
              db: {
                status: "down",
                message: "Connection refused",
                responseTime: expect.any(Number),
              },
            },
            timestamp: expect.any(String),
          });
        },
        "HealthCheckService.check() throws HealthCheckException carrying the HealthCheckResult",
      );

      itAdapted(
        ["ADR-001"],
        "should support mixing HealthCheckAttempt with regular functions",
        async () => {
          const attempt = h.check("db").attempt(async () => {});
          const result = await healthCheckService.check([
            () => healthIndicator(h),
            attempt,
          ]);
          expect(result).toEqual({
            status: "ok",
            info: {
              healthy: { status: "up" },
              db: { status: "up", responseTime: expect.any(Number) },
            },
            error: {},
            details: {
              healthy: { status: "up" },
              db: { status: "up", responseTime: expect.any(Number) },
            },
            timestamp: expect.any(String),
          });
        },
        "Executed via HealthCheckService.check() with ISO timestamp",
      );

      itAdapted(
        ["ADR-001"],
        "should return a result object without errors",
        async () => {
          const result = await healthCheckService.check([
            () => healthIndicator(h),
          ]);
          expect(result).toEqual({
            status: "ok",
            info: {
              healthy: {
                status: "up",
              },
            },
            error: {},
            details: {
              healthy: {
                status: "up",
              },
            },
            timestamp: expect.any(String),
          });
        },
        "Executed via HealthCheckService.check() with ISO timestamp",
      );

      itAdapted(
        ["ADR-001"],
        "should return a result object with errors",
        async () => {
          const result = await executeAndCapture([
            () => unhealthyHealthIndicator(h),
          ]);
          expect(result).toEqual({
            status: "error",
            info: {},
            error: {
              unhealthy: {
                status: "down",
              },
            },
            details: {
              unhealthy: {
                status: "down",
              },
            },
            timestamp: expect.any(String),
          });
        },
        "HealthCheckService.check() throws HealthCheckException carrying result",
      );

      itAdapted(
        ["ADR-001"],
        "should return a result object with errors with sync indicator function",
        async () => {
          const result = await executeAndCapture([
            () => unhealthyHealthIndicatorSync(h),
          ]);
          expect(result).toEqual({
            status: "error",
            info: {},
            error: {
              unhealthy: {
                status: "down",
              },
            },
            details: {
              unhealthy: {
                status: "down",
              },
            },
            timestamp: expect.any(String),
          });
        },
        "HealthCheckService.check() throws HealthCheckException carrying result",
      );

      itAdapted(
        ["ADR-001"],
        "should return a result object without errors and with errors",
        async () => {
          const result = await executeAndCapture([
            () => unhealthyHealthIndicator(h),
            () => healthIndicator(h),
          ]);
          expect(result).toEqual({
            status: "error",
            info: {
              healthy: {
                status: "up",
              },
            },
            error: {
              unhealthy: {
                status: "down",
              },
            },
            details: {
              healthy: {
                status: "up",
              },
              unhealthy: {
                status: "down",
              },
            },
            timestamp: expect.any(String),
          });
        },
        "HealthCheckService.check() executes indicators in parallel and separates info/error buckets",
      );

      it("should execute indicators in parallel", async () => {
        const start = performance.now();
        const delay = (ms: number) =>
          new Promise<void>((resolve) => setTimeout(resolve, ms));

        const result = await healthCheckService.check([
          async () => {
            await delay(40);
            return h.check("first").up();
          },
          async () => {
            await delay(40);
            return h.check("second").up();
          },
          async () => {
            await delay(40);
            return h.check("third").up();
          },
        ]);

        const elapsed = performance.now() - start;
        expect(result.status).toBe("ok");
        expect(Object.keys(result.details)).toEqual([
          "first",
          "second",
          "third",
        ]);
        expect(elapsed).toBeLessThan(110);
      });
    });

    describe("degraded indicators", () => {
      itAdapted(
        ["ADR-001"],
        "should aggregate a degraded indicator into a degraded status with HTTP-safe buckets",
        async () => {
          const result = await healthCheckService.check([
            () => h.check("db").degraded("slow"),
            () => h.check("redis").up(),
          ]);
          expect(result).toEqual({
            status: "degraded",
            info: {
              db: { status: "degraded", message: "slow" },
              redis: { status: "up" },
            },
            error: {},
            details: {
              db: { status: "degraded", message: "slow" },
              redis: { status: "up" },
            },
            timestamp: expect.any(String),
          });
        },
        "Executed via HealthCheckService.check() with ISO timestamp",
      );

      itAdapted(
        ["ADR-001"],
        "should report error when a down indicator accompanies a degraded one",
        async () => {
          const result = await executeAndCapture([
            () => h.check("db").degraded(),
            () => h.check("redis").down(),
          ]);
          expect(result.status).toBe("error");
        },
        "HealthCheckService.check() throws HealthCheckException with status 'error'",
      );
    });

    describe("beforeApplicationShutdown", () => {
      itAdapted(
        ["ADR-001"],
        "should report shutting_down before the graceful timeout elapses",
        async () => {
          await bootstrap({ gracefulShutdownTimeoutMs: 60 });
          const start = performance.now();
          const shutdownPromise =
            healthCheckService.beforeApplicationShutdown("SIGTERM");

          const statusDuringWait = (await executeAndCapture([])).status;
          await shutdownPromise;
          const elapsed = performance.now() - start;

          expect(elapsed).toBeGreaterThanOrEqual(40);
          expect(statusDuringWait).toBe("shutting_down");
          expect(logMock).toHaveBeenCalledWith(
            "Received termination signal SIGTERM",
          );
          expect(logMock).toHaveBeenCalledWith("Awaiting 60ms before shutdown");
          expect(logMock).toHaveBeenCalledWith(
            "Timeout reached, shutting down now",
          );
        },
        "Uses real short timeout because Bunest awaits native global setTimeout instead of node:timers/promises",
      );

      itAdapted(
        ["ADR-001"],
        "should not wait if the signal is not SIGTERM",
        async () => {
          await bootstrap({ gracefulShutdownTimeoutMs: 1000 });
          const start = performance.now();
          await healthCheckService.beforeApplicationShutdown("SIGINT");
          const elapsed = performance.now() - start;

          expect(elapsed).toBeLessThan(200);
          expect(logMock).not.toHaveBeenCalledWith(
            "Awaiting 1000ms before shutdown",
          );
          expect((await executeAndCapture([])).status).toBe("shutting_down");
        },
        "Verifies non-SIGTERM completes immediately without awaiting gracefulShutdownTimeoutMs",
      );

      it.each([{ gracefulShutdownTimeoutMs: 0 }, {}])(
        "should not wait nor log with options %j",
        async (options) => {
          await bootstrap(options);
          const start = performance.now();
          await healthCheckService.beforeApplicationShutdown("SIGTERM");
          const elapsed = performance.now() - start;

          expect(elapsed).toBeLessThan(200);
          expect(logMock).not.toHaveBeenCalled();
        },
      );
    });
  },
);
