import "reflect-metadata";
import { afterEach, expect, spyOn } from "bun:test";
import {
  Controller,
  Get,
  ShutdownSignal,
} from "../../../../../../packages/common/src";
import {
  HealthCheck,
  HealthCheckService,
  TerminusModule,
  type HealthCheckResult,
  type TerminusModuleOptions,
} from "../../../../../../packages/observability/src";
import {
  createTestApp,
  describeConformance,
  httpRequest,
  itAdapted,
  type TestAppContext,
} from "../../../../_helpers/index";

function createHealthEndpointApp(
  terminusOptions: TerminusModuleOptions,
  handler: (healthCheck: HealthCheckService) => Promise<HealthCheckResult>,
): Promise<TestAppContext> {
  @Controller()
  class HealthController {
    constructor(private readonly healthCheck: HealthCheckService) {}

    @Get("health")
    @HealthCheck()
    health() {
      return handler(this.healthCheck);
    }
  }

  return createTestApp(
    {
      imports: [
        TerminusModule.forRoot({ logger: false, ...terminusOptions }),
      ],
      controllers: [HealthController],
    },
    { silentLogger: true },
  );
}

describeConformance(
  "Graceful shutdown",
  {
    upstreamPath: "terminus/e2e/graceful-shutdown.e2e-spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts upstream @nestjs/terminus graceful-shutdown E2E spec to zero-socket BunestApplication (ADR-001) and Bun global setTimeout instead of node:timers/promises.",
  },
  () => {
    let ctx: TestAppContext | undefined;

    afterEach(async () => {
      if (ctx) {
        await ctx.close();
        ctx = undefined;
      }
    });

    itAdapted(
      ["ADR-001"],
      "should gracefully shutdown the application",
      async () => {
        ctx = await createHealthEndpointApp(
          { gracefulShutdownTimeoutMs: 64 },
          (healthCheck) => healthCheck.check([]),
        );

        const { status } = await httpRequest(ctx.app).get("/health");
        expect(status).toBe(200);

        let isClosed = false;
        const closePromise = ctx.app.close(ShutdownSignal.SIGTERM).then(() => {
          isClosed = true;
        });

        await Bun.sleep(16);
        expect(isClosed).toBe(false);

        const drain = await httpRequest(ctx.app).get("/health");
        expect(drain.status).toBe(503);
        expect((drain.body as { status?: string }).status).toBe(
          "shutting_down",
        );

        await Bun.sleep(16);
        expect(isClosed).toBe(false);

        await Bun.sleep(80);
        await closePromise;
        expect(isClosed).toBe(true);
      },
      "Uses zero-socket BunHttpAdapter and Bun.sleep for drain-window verification",
    );

    itAdapted(
      ["ADR-001"],
      "should not delay the shutdown if the timeout is 0",
      async () => {
        ctx = await createHealthEndpointApp(
          { gracefulShutdownTimeoutMs: 0 },
          (healthCheck) => healthCheck.check([]),
        );

        const { status } = await httpRequest(ctx.app).get("/health");
        expect(status).toBe(200);

        const timeoutSpy = spyOn(globalThis, "setTimeout");
        try {
          await ctx.app.close(ShutdownSignal.SIGTERM);
          expect(timeoutSpy).not.toHaveBeenCalled();
        } finally {
          timeoutSpy.mockRestore();
        }
      },
      "Spies on globalThis.setTimeout used by Bunest HealthCheckService instead of node:timers/promises",
    );
  },
);
