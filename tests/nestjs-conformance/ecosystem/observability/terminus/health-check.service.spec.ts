import "reflect-metadata";
import { afterEach, beforeEach, expect, mock } from "bun:test";
import {
  ServiceUnavailableException,
  type LoggerService,
} from "../../../../../packages/common/src";
import {
  HealthCheckException,
  HealthCheckService,
  HealthIndicatorService,
  TERMINUS_LOGGER,
  TERMINUS_MODULE_OPTIONS,
} from "../../../../../packages/observability/src";
import {
  Test,
  type TestingModule,
  describeConformance,
  itAdapted,
} from "../../../_helpers/index";

describeConformance(
  "HealthCheckService",
  {
    upstreamPath: "terminus/lib/health-check/health-check.service.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Bunest folds HealthCheckExecutor and error formatting into HealthCheckService directly rather than injecting separate HealthCheckExecutor and ERROR_LOGGER providers.",
  },
  () => {
    let healthCheckService: HealthCheckService;
    let healthIndicatorService: HealthIndicatorService;
    let errorSpy: ReturnType<typeof mock>;
    const modules: TestingModule[] = [];

    beforeEach(async () => {
      errorSpy = mock(() => {});
      const loggerMock: LoggerService = {
        log: mock(() => {}),
        error: errorSpy,
        warn: mock(() => {}),
        debug: mock(() => {}),
      };

      const moduleRef = await Test.createTestingModule({
        providers: [
          HealthCheckService,
          HealthIndicatorService,
          {
            provide: TERMINUS_MODULE_OPTIONS,
            useValue: {},
          },
          {
            provide: TERMINUS_LOGGER,
            useValue: loggerMock,
          },
        ],
      }).compile({ logger: false });
      modules.push(moduleRef);

      healthCheckService = moduleRef.get(HealthCheckService);
      healthIndicatorService = moduleRef.get(HealthIndicatorService);
    });

    afterEach(async () => {
      await Promise.all(modules.splice(0).map((m) => m.close()));
    });

    itAdapted(
      ["ADR-001"],
      "should return the result",
      async () => {
        const result = await healthCheckService.check([
          () => Promise.resolve(healthIndicatorService.check("db").up()),
        ]);
        expect(result).toEqual({
          status: "ok",
          info: { db: { status: "up" } },
          error: {},
          details: { db: { status: "up" } },
          timestamp: expect.any(String),
        });
      },
      "HealthCheckService runs indicators directly without a mocked HealthCheckExecutor",
    );

    itAdapted(
      ["ADR-001"],
      "should return the result when degraded",
      async () => {
        const result = await healthCheckService.check([
          () => Promise.resolve(healthIndicatorService.check("db").degraded()),
        ]);
        expect(result).toEqual({
          status: "degraded",
          info: { db: { status: "degraded" } },
          error: {},
          details: { db: { status: "degraded" } },
          timestamp: expect.any(String),
        });
      },
      "HealthCheckService returns degraded result without throwing (HTTP 200)",
    );

    itAdapted(
      ["ADR-001"],
      "should throw a ServiceUnavailableException",
      async () => {
        let caught: unknown;
        try {
          await healthCheckService.check([
            () => Promise.resolve(healthIndicatorService.check("db").down()),
          ]);
        } catch (error) {
          caught = error;
        }

        expect(caught).toBeInstanceOf(ServiceUnavailableException);
        expect(caught).toBeInstanceOf(HealthCheckException);
        const err = caught as HealthCheckException;
        expect(err.getStatus()).toBe(503);
        expect(err.result).toEqual({
          status: "error",
          info: {},
          error: { db: { status: "down" } },
          details: { db: { status: "down" } },
          timestamp: expect.any(String),
        });
        expect(err.getResponse()).toMatchObject({
          status: "error",
          info: {},
          error: { db: { status: "down" } },
          details: { db: { status: "down" } },
        });
      },
      "HealthCheckService throws HealthCheckException (subclass of ServiceUnavailableException) exposing getStatus() and result",
    );

    itAdapted(
      ["ADR-001"],
      "should print an error message",
      async () => {
        let threw = false;
        try {
          await healthCheckService.check([
            () => Promise.resolve(healthIndicatorService.check("db").down()),
          ]);
        } catch {
          threw = true;
        }

        expect(threw).toBe(true);
        expect(errorSpy).toHaveBeenCalledWith(
          'Health Check has failed! {"db":{"status":"down"}}',
        );
      },
      "HealthCheckService formats error logs internally via errorLogStyle ('json' by default) instead of separate ERROR_LOGGER",
    );
  },
);
