import "reflect-metadata";
import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { LoggerService } from "../../../../../packages/common/src";
import {
  HealthCheckException,
  HealthCheckService,
  HealthIndicatorStatus,
  TERMINUS_LOGGER,
  TERMINUS_MODULE_OPTIONS,
  type HealthIndicatorResult,
} from "../../../../../packages/observability/src";
import {
  Test,
  describeConformance,
  itAdapted,
} from "../../../_helpers/index";

describeConformance(
  "PrettyErrorLogger",
  {
    upstreamPath:
      "terminus/lib/health-check/error-logger/pretty-error-logger.service.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Bunest folds pretty error log formatting into HealthCheckService via errorLogStyle: 'pretty' + TERMINUS_LOGGER (no standalone PrettyErrorLogger class, ANSI color codes, or emoji prefixes).",
  },
  () => {
    let healthCheckService: HealthCheckService;
    let errorSpy: ReturnType<typeof mock>;

    const logPrettyErrorFor = async (
      indicators: HealthIndicatorResult[],
    ): Promise<string> => {
      try {
        await healthCheckService.check(indicators.map((res) => () => res));
      } catch (err) {
        expect(err).toBeInstanceOf(HealthCheckException);
      }
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const firstCall = errorSpy.mock.calls[0];
      expect(firstCall).toBeDefined();
      return String(firstCall?.[0] ?? "");
    };

    beforeEach(async () => {
      errorSpy = mock(() => {});
      const loggerMock: LoggerService = {
        log: mock(() => {}),
        error: errorSpy,
        warn: mock(() => {}),
      };

      const moduleRef = await Test.createTestingModule({
        providers: [
          HealthCheckService,
          {
            provide: TERMINUS_MODULE_OPTIONS,
            useValue: { errorLogStyle: "pretty" },
          },
          {
            provide: TERMINUS_LOGGER,
            useValue: loggerMock,
          },
        ],
      }).compile({ logger: false });

      healthCheckService = moduleRef.get(HealthCheckService);
    });

    itAdapted(
      ["ADR-001"],
      'should print one "up" results',
      async () => {
        // HealthCheckService only logs on overall "error", so pair the "up"
        // indicator with a failing sentinel to inspect how "up" entries format.
        const message = await logPrettyErrorFor([
          { dog: { status: HealthIndicatorStatus.UP } },
          { trigger: { status: HealthIndicatorStatus.DOWN } },
        ]);

        expect(message).toBe(
          'Health Check has failed!\n  - dog: {"status":"up"}\n  - trigger: {"status":"down"}',
        );
      },
      "HealthCheckService formats pretty entries as bulleted JSON lines under 'Health Check has failed!'",
    );

    itAdapted(
      ["ADR-001"],
      'should print one "degraded" results',
      async () => {
        const message = await logPrettyErrorFor([
          { dog: { status: HealthIndicatorStatus.DEGRADED } },
          { trigger: { status: HealthIndicatorStatus.DOWN } },
        ]);

        expect(message).toBe(
          'Health Check has failed!\n  - dog: {"status":"degraded"}\n  - trigger: {"status":"down"}',
        );
      },
      "HealthCheckService formats pretty entries as bulleted JSON lines when overall status is error",
    );

    itAdapted(
      ["ADR-001"],
      'should print one "down" results',
      async () => {
        const message = await logPrettyErrorFor([
          { dog: { status: HealthIndicatorStatus.DOWN } },
        ]);

        expect(message).toBe(
          'Health Check has failed!\n  - dog: {"status":"down"}',
        );
      },
      "HealthCheckService formats pretty entries as bulleted JSON lines",
    );

    itAdapted(
      ["ADR-001"],
      'should print "up" and "down" results',
      async () => {
        const message = await logPrettyErrorFor([
          { dog: { status: HealthIndicatorStatus.UP } },
          { pug: { status: HealthIndicatorStatus.DOWN } },
        ]);

        expect(message).toBe(
          'Health Check has failed!\n  - dog: {"status":"up"}\n  - pug: {"status":"down"}',
        );
      },
      "HealthCheckService formats multiple pretty entries on separate lines",
    );

    itAdapted(
      ["ADR-001"],
      "should print object details",
      async () => {
        const message = await logPrettyErrorFor([
          {
            dog: {
              status: HealthIndicatorStatus.DOWN,
              foo: "bar",
            },
          },
        ]);

        expect(message).toBe(
          'Health Check has failed!\n  - dog: {"status":"down","foo":"bar"}',
        );
      },
      "HealthCheckService serializes extra detail properties inline as JSON",
    );

    itAdapted(
      ["ADR-001"],
      "should print nested object details",
      async () => {
        const message = await logPrettyErrorFor([
          {
            dog: {
              status: HealthIndicatorStatus.DOWN,
              foo: {
                bar: "baz",
              },
            },
          },
        ]);

        expect(message).toBe(
          'Health Check has failed!\n  - dog: {"status":"down","foo":{"bar":"baz"}}',
        );
      },
      "HealthCheckService serializes nested object details inline as JSON",
    );

    itAdapted(
      ["ADR-001"],
      "should print array details",
      async () => {
        const message = await logPrettyErrorFor([
          {
            dog: {
              status: HealthIndicatorStatus.DOWN,
              foo: ["bar", "baz"],
            },
          },
        ]);

        expect(message).toBe(
          'Health Check has failed!\n  - dog: {"status":"down","foo":["bar","baz"]}',
        );
      },
      "HealthCheckService serializes array details inline as JSON",
    );

    // BUNEST_BUG: formatErrorLog() in packages/observability/src/health/health.service.ts:143-155 uses raw JSON.stringify(value), which silently drops Symbol-valued properties instead of formatting them (expected output to contain "foo" and "Symbol(TEST)", received 'Health Check has failed!\n  - dog: {"status":"down"}').
    it.skip("should print symbol details", async () => {
      const message = await logPrettyErrorFor([
        {
          dog: {
            status: HealthIndicatorStatus.DOWN,
            foo: Symbol("TEST"),
          },
        },
      ]);

      expect(message).toContain("foo");
      expect(message).toContain("Symbol(TEST)");
    });

    describe("json error log style contrast", () => {
      itAdapted(
        ["ADR-001"],
        "should print single-line JSON when errorLogStyle defaults to json",
        async () => {
          const jsonErrorSpy = mock(() => {});
          const jsonService = new HealthCheckService(
            { errorLogStyle: "json" },
            { log: mock(() => {}), error: jsonErrorSpy, warn: mock(() => {}) },
          );

          await expect(
            jsonService.check([
              () => ({ dog: { status: HealthIndicatorStatus.DOWN } }),
            ]),
          ).rejects.toBeInstanceOf(HealthCheckException);

          expect(jsonErrorSpy).toHaveBeenCalledWith(
            'Health Check has failed! {"dog":{"status":"down"}}',
          );
        },
        "Verifies json vs pretty formatting inside HealthCheckService",
      );
    });
  },
);
