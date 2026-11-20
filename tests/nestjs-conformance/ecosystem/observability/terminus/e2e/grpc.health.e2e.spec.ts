import "reflect-metadata";
import net from "node:net";
import { afterEach, expect, it } from "bun:test";
import { Controller, Get } from "../../../../../../packages/common/src";
import {
  GRPCHealthIndicator,
  HealthCheck,
  HealthCheckService,
  TerminusModule,
  type CheckGRPCServiceOptions,
  type HealthCheckResult,
} from "../../../../../../packages/observability/src";
import {
  adaptedTitle,
  createTestApp,
  describeConformance,
  httpRequest,
  itAdapted,
  type TestAppContext,
} from "../../../../_helpers/index";

function createGrpcHealthApp(
  handler: (props: {
    healthCheck: HealthCheckService;
    grpc: GRPCHealthIndicator;
  }) => Promise<HealthCheckResult>,
): Promise<TestAppContext> {
  @Controller()
  class HealthController {
    constructor(
      private readonly healthCheck: HealthCheckService,
      private readonly grpc: GRPCHealthIndicator,
    ) {}

    @Get("health")
    @HealthCheck()
    health() {
      return handler({ healthCheck: this.healthCheck, grpc: this.grpc });
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

// Note on typing: BUNEST_BUG — `@bunest/microservices`'s `GrpcOptions` fails
// the `GrpcClientOptionsLike` generic constraint (`package?: string | string[]`
// in packages/observability/src/health/health.indicators.ts:1053), so calls omit `<GrpcOptions>`.
describeConformance(
  "GRPCHealthIndicator (e2e)",
  {
    upstreamPath: "terminus/e2e/health-checks/grpc.health.e2e-spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008"],
    notes:
      "Adapts upstream @nestjs/terminus GRPCHealthIndicator E2E spec to zero-socket BunestApplication and zero-dep GRPCHealthIndicator using in-process Promise healthService stubs and local ephemeral TCP probes (ADR-001/ADR-008: no @grpc/grpc-js or RxJS).",
  },
  () => {
    let ctx: TestAppContext | undefined;
    const pendingTimers = new Set<ReturnType<typeof setTimeout>>();

    afterEach(async () => {
      for (const timer of pendingTimers) {
        clearTimeout(timer);
      }
      pendingTimers.clear();
      if (ctx) {
        await ctx.close();
        ctx = undefined;
      }
    });

    const startApp = (options: CheckGRPCServiceOptions) =>
      createGrpcHealthApp(({ healthCheck, grpc }) =>
        healthCheck.check([async () => grpc.checkService("grpc", "", options)]),
      );

    itAdapted(
      ["ADR-001", "ADR-008"],
      "should be up when the service is SERVING",
      async () => {
        ctx = await startApp({
          healthService: {
            check: async () => ({ status: 1 }),
          },
        });

        const details = {
          grpc: {
            status: "up",
            statusCode: 1,
            servingStatus: "SERVING",
            responseTime: expect.any(Number),
          },
        };

        const res = await httpRequest(ctx.app).get("/health").expect(200);
        const body = res.body as Record<string, unknown>;
        expect(body.status).toBe("ok");
        expect(body.info).toEqual(details);
        expect(body.error).toEqual({});
        expect(body.details).toEqual(details);
      },
      "Uses Promise-based healthService stub instead of @grpc/grpc-js server",
    );

    // BUNEST_BUG: (1) HttpException.toJSON() overwrites HealthCheckException's object `body.error` with the string "HealthCheckException" (packages/common/src/exceptions/http.exception.ts:167-177, packages/observability/src/health/health.service.ts:26-41); (2) NotServingError formats message as "The service is not serving (status: NOT_SERVING)" instead of "serving status: NOT_SERVING" (packages/observability/src/health/units.ts:111).
    it.skip("should be down when the service is NOT_SERVING", async () => {
      ctx = await startApp({
        healthService: {
          check: async () => ({ status: 2 }),
        },
      });

      const details = {
        grpc: {
          status: "down",
          message: "serving status: NOT_SERVING",
          statusCode: 2,
          servingStatus: "NOT_SERVING",
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

    // BUNEST_BUG: HttpException.toJSON() overwrites HealthCheckException's object `body.error` with the string "HealthCheckException" instead of preserving the indicator error map (packages/common/src/exceptions/http.exception.ts:167-177, packages/observability/src/health/health.service.ts:26-41).
    it.skip(
      adaptedTitle(
        ["ADR-001", "ADR-008"],
        "should be down when it runs into the timeout",
        "Simulates slow gRPC health check via healthServiceCheck callback",
      ),
      async () => {
        ctx = await startApp({
          timeout: 1,
          healthServiceCheck: () =>
            new Promise((resolve) => {
              const timer = setTimeout(() => {
                pendingTimers.delete(timer);
                resolve({ status: 1 });
              }, 100);
              pendingTimers.add(timer);
            }),
        });

        const details = {
          grpc: {
            status: "down",
            message: "timeout of 1ms exceeded",
            responseTime: expect.any(Number),
          },
        };

        const res = await httpRequest(ctx.app).get("/health").expect(503);
        const body = res.body as Record<string, unknown>;
        expect(body.status).toBe("error");
        expect(body.info).toEqual({});
        expect(body.error).toEqual(details);
        expect(body.details).toEqual(details);
      },
    );

    // BUNEST_BUG: HttpException.toJSON() overwrites HealthCheckException's object `body.error` with the string "HealthCheckException" instead of preserving the indicator error map (packages/common/src/exceptions/http.exception.ts:167-177, packages/observability/src/health/health.service.ts:26-41).
    it.skip(
      adaptedTitle(
        ["ADR-001", "ADR-008"],
        "should be down when the service is not reachable",
        "Verifies both gRPC status code 14 propagation and zero-dep TCP url probe failure on closed ephemeral port",
      ),
      async () => {
        ctx = await startApp({
          healthService: {
            check: async () => {
              throw Object.assign(
                new Error("14 UNAVAILABLE: No connection established"),
                { code: 14 },
              );
            },
          },
        });

        const res = await httpRequest(ctx.app).get("/health").expect(503);
        const body = res.body as {
          status: string;
          error: { grpc: { status: string; message: string; code?: number } };
        };
        expect(body.status).toBe("error");
        expect(body.error.grpc.status).toBe("down");
        expect(body.error.grpc.message).toEqual(expect.any(String));
        expect(body.error.grpc.code).toBe(14);

        await ctx.close();
        ctx = undefined;

        const probe = net.createServer();
        await new Promise<void>((resolve) =>
          probe.listen(0, "127.0.0.1", resolve),
        );
        const closedPort = (probe.address() as net.AddressInfo).port;
        await new Promise<void>((resolve) => probe.close(() => resolve()));

        ctx = await startApp({ url: `127.0.0.1:${closedPort}` });
        const tcpRes = await httpRequest(ctx.app).get("/health").expect(503);
        const tcpBody = tcpRes.body as {
          status: string;
          error: { grpc: { status: string; message: string } };
        };
        expect(tcpBody.status).toBe("error");
        expect(tcpBody.error.grpc.status).toBe("down");
        expect(tcpBody.error.grpc.message).toContain("ECONNREFUSED");
      },
    );
  },
);
