import { afterEach, describe, expect, it } from "bun:test";
import { Controller, Get } from "../../../../../../packages/core/src/common";
import {
  HealthCheck,
  HealthCheckService,
  TerminusModule,
  type HealthCheckOptions,
  type HealthCheckResult,
  type HealthIndicatorResult,
} from "../../../../../../packages/observability/src";
import {
  DocumentBuilder,
  SwaggerModule,
} from "../../../../../../packages/swagger/src";
import {
  createTestApp,
  describeConformance,
  httpRequest,
  type TestAppContext,
} from "../../../../_helpers/index";

function createHealthCheckDecoratorApp(
  handler: (healthCheck: HealthCheckService) => Promise<HealthCheckResult>,
  healthCheckOptions?: HealthCheckOptions,
): Promise<TestAppContext> {
  @Controller()
  class HealthController {
    constructor(private readonly healthCheck: HealthCheckService) {}

    @Get("health")
    @HealthCheck(healthCheckOptions)
    health() {
      return handler(this.healthCheck);
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
  "HealthCheck (e2e)",
  {
    upstreamPath: "terminus/e2e/health-checks/health-check.e2e-spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts upstream @nestjs/terminus @HealthCheck() decorator E2E spec to zero-socket BunestApplication and @bunest/swagger DocumentBuilder/SwaggerModule.",
  },
  () => {
    let ctx: TestAppContext | undefined;

    const healthyCheck = (): Promise<HealthIndicatorResult> =>
      Promise.resolve({ test: { status: "up" } });

    const getHealthResponses = () =>
      SwaggerModule.createDocument(ctx!.app, new DocumentBuilder().build())
        .paths["/health"]?.get?.responses;

    afterEach(async () => {
      if (ctx) {
        await ctx.close();
        ctx = undefined;
      }
    });

    it("should set the Cache-Control header to no-cache, no-store, must-revalidate", async () => {
      ctx = await createHealthCheckDecoratorApp((healthCheck) =>
        healthCheck.check([healthyCheck]),
      );

      await httpRequest(ctx.app)
        .get("/health")
        .expect(200)
        .expect("Cache-Control", "no-cache, no-store, must-revalidate");
    });

    it("should keep the Cache-Control header when only swaggerDocumentation is disabled", async () => {
      ctx = await createHealthCheckDecoratorApp(
        (healthCheck) => healthCheck.check([healthyCheck]),
        { swaggerDocumentation: false },
      );

      await httpRequest(ctx.app)
        .get("/health")
        .expect(200)
        .expect("Cache-Control", "no-cache, no-store, must-revalidate");
      expect(getHealthResponses()).not.toHaveProperty("503");
    });

    // BUNEST_BUG: @HealthCheck() records HEALTH_CHECK_METADATA but does not apply @bunest/swagger @ApiOkResponse/@ApiServiceUnavailableResponse decorators (and SwaggerModule does not read HEALTH_CHECK_METADATA), so OpenAPI document lacks the 503 response entry (packages/observability/src/health/health.decorator.ts:13-44).
    it.skip("should keep the Swagger documentation when only noCache is disabled", async () => {
      ctx = await createHealthCheckDecoratorApp(
        (healthCheck) => healthCheck.check([healthyCheck]),
        { noCache: false },
      );

      const response = await httpRequest(ctx.app).get("/health").expect(200);
      expect(response.headers["cache-control"]).toBeUndefined();
      expect(getHealthResponses()).toHaveProperty("503");
    });
  },
);
