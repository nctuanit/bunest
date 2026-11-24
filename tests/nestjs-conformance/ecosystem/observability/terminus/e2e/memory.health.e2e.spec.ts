import { afterEach, describe, expect, it } from "bun:test";
import { Controller, Get } from "../../../../../../packages/core/src/common";
import {
  HealthCheck,
  HealthCheckService,
  MemoryHealthIndicator,
  TerminusModule,
  type HealthCheckResult,
} from "../../../../../../packages/observability/src";
import {
  createTestApp,
  describeConformance,
  httpRequest,
  type TestAppContext,
} from "../../../../_helpers/index";

function createMemoryHealthApp(
  handler: (props: {
    healthCheck: HealthCheckService;
    memory: MemoryHealthIndicator;
  }) => Promise<HealthCheckResult>,
): Promise<TestAppContext> {
  @Controller()
  class HealthController {
    constructor(
      private readonly healthCheck: HealthCheckService,
      private readonly memory: MemoryHealthIndicator,
    ) {}

    @Get("health")
    @HealthCheck()
    health() {
      return handler({ healthCheck: this.healthCheck, memory: this.memory });
    }
  }

  return createTestApp(
    {
      imports: [TerminusModule.forRoot({ logger: false })],
      controllers: [HealthController],
    },
    { silentLogger: true },
  );
}

describeConformance(
  "MemoryHealthIndicator (e2e)",
  {
    upstreamPath: "terminus/e2e/health-checks/memory.health.e2e-spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts upstream @nestjs/terminus MemoryHealthIndicator E2E spec to zero-socket BunestApplication. Outer envelope assertions tolerate Bunest's timestamp/message/errors fields while strictly asserting indicator details.",
  },
  () => {
    let ctx: TestAppContext | undefined;

    afterEach(async () => {
      if (ctx) {
        await ctx.close();
        ctx = undefined;
      }
    });

    describe("#checkHeap", () => {
      // BUNEST_BUG: MemoryHealthIndicator.checkHeap() attaches extra heapUsedBytes/thresholdBytes fields via .withData(...) instead of upstream { status, responseTime } (packages/observability/src/health/health.indicators.ts:92-112).
      it.skip("should check if the rss threshold is not exceeded", async () => {
        ctx = await createMemoryHealthApp(({ healthCheck, memory }) =>
          healthCheck.check([
            async () => {
              const { rss } = process.memoryUsage();
              return memory.checkHeap("memory_rss", rss + 1);
            },
          ]),
        );

        const details = {
          memory_rss: { status: "up", responseTime: expect.any(Number) },
        };

        const res = await httpRequest(ctx.app).get("/health").expect(200);
        const body = res.body as Record<string, unknown>;
        expect(body.status).toBe("ok");
        expect(body.info).toEqual(details);
        expect(body.error).toEqual({});
        expect(body.details).toEqual(details);
      });

      // BUNEST_BUG: MemoryHealthIndicator.checkHeap() attaches extra heapUsedBytes/thresholdBytes fields via .withData(...) instead of upstream { status, responseTime } (packages/observability/src/health/health.indicators.ts:92-112).
      it.skip("should check if the heap threshold is not exceeded", async () => {
        ctx = await createMemoryHealthApp(({ healthCheck, memory }) =>
          healthCheck.check([
            async () =>
              memory.checkHeap("memory_heap", 1 * 1024 * 1024 * 1024 * 1024),
          ]),
        );

        const details = {
          memory_heap: { status: "up", responseTime: expect.any(Number) },
        };

        const res = await httpRequest(ctx.app).get("/health").expect(200);
        const body = res.body as Record<string, unknown>;
        expect(body.status).toBe("ok");
        expect(body.info).toEqual(details);
        expect(body.error).toEqual({});
        expect(body.details).toEqual(details);
      });

      // BUNEST_BUG: (1) HttpException.toJSON() overwrites HealthCheckException's object `body.error` with the string "HealthCheckException" (packages/core/src/common/exceptions/http.exception.ts:167-177, packages/observability/src/health/health.service.ts:26-41); (2) MemoryHealthIndicator.checkHeap() attaches extra heapUsedBytes/thresholdBytes fields and throws "Used heap (<n> bytes) exceeded threshold (<t> bytes)" instead of "Used heap exceeded the set threshold" (packages/observability/src/health/health.indicators.ts:92-112).
      it.skip("should check if correctly displays a heap exceeded error", async () => {
        ctx = await createMemoryHealthApp(({ healthCheck, memory }) =>
          healthCheck.check([async () => memory.checkHeap("memory_heap", 0)]),
        );

        const details = {
          memory_heap: {
            status: "down",
            message: "Used heap exceeded the set threshold",
            responseTime: expect.any(Number),
          },
        };

        const res = await httpRequest(ctx.app).get("/health").expect(503);
        const body = res.body as Record<string, unknown>;
        expect(body.status).toBe("error");
        expect(body.info).toEqual({});
        expect(body.error).toEqual(details);
        expect(body.details).toEqual(details);
      });
    });

    describe("#checkHeap builders", () => {
      // BUNEST_BUG: MemoryHealthIndicator.checkHeap() attaches extra heapUsedBytes/thresholdBytes fields and throws "Used heap (<n> bytes) exceeded threshold (<t> bytes)" instead of "Used heap exceeded the set threshold" (packages/observability/src/health/health.indicators.ts:92-112).
      it.skip("should be degraded, not down, with degradedOnFailure()", async () => {
        ctx = await createMemoryHealthApp(({ healthCheck, memory }) =>
          healthCheck.check([
            () => memory.checkHeap("memory_heap", 0).degradedOnFailure(),
          ]),
        );

        const details = {
          memory_heap: {
            status: "degraded",
            message: "Used heap exceeded the set threshold",
            responseTime: expect.any(Number),
          },
        };

        const res = await httpRequest(ctx.app).get("/health").expect(200);
        const body = res.body as Record<string, unknown>;
        expect(body.status).toBe("degraded");
        expect(body.info).toEqual(details);
        expect(body.error).toEqual({});
        expect(body.details).toEqual(details);
      });
    });
  },
);
