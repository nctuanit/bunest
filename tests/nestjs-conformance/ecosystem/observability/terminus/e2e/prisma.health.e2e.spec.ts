import { afterEach, describe, expect, it } from "bun:test";
import { Controller, Get } from "../../../../../../packages/core/src/common";
import {
  HealthCheck,
  HealthCheckService,
  PrismaHealthIndicator,
  TerminusModule,
  type HealthCheckResult,
  type PrismaHealthClient,
} from "../../../../../../packages/observability/src";
import {
  adaptedTitle,
  createTestApp,
  describeConformance,
  httpRequest,
  itAdapted,
  type TestAppContext,
} from "../../../../_helpers/index";

function createPrismaHealthApp(
  handler: (props: {
    healthCheck: HealthCheckService;
    prisma: PrismaHealthIndicator;
  }) => Promise<HealthCheckResult>,
): Promise<TestAppContext> {
  @Controller()
  class HealthController {
    constructor(
      private readonly healthCheck: HealthCheckService,
      private readonly prisma: PrismaHealthIndicator,
    ) {}

    @Get("health")
    @HealthCheck()
    health() {
      return handler({ healthCheck: this.healthCheck, prisma: this.prisma });
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
  "PrismaHealthIndicator (e2e)",
  {
    upstreamPath: "terminus/e2e/health-checks/prisma.health.e2e-spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts upstream @nestjs/terminus PrismaHealthIndicator E2E spec to zero-socket BunestApplication and in-process duck-typed Prisma clients ($runCommandRaw / $queryRawUnsafe) without Docker or generated Prisma binaries.",
  },
  () => {
    let ctx: TestAppContext | undefined;
    const pendingTimers = new Set<ReturnType<typeof setTimeout>>();

    const createDelayedPromise = <T>(ms: number, value: T): Promise<T> =>
      new Promise<T>((resolve) => {
        const timer = setTimeout(() => {
          pendingTimers.delete(timer);
          resolve(value);
        }, ms);
        pendingTimers.add(timer);
      });

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

    describe("mongodb", () => {
      describe("#pingCheck", () => {
        itAdapted(
          ["ADR-001"],
          "should check if the prisma is available",
          async () => {
            const mongoClient: PrismaHealthClient = {
              $runCommandRaw: async (cmd) => {
                expect(cmd).toEqual({ ping: 1 });
                return { ok: 1 };
              },
            };

            ctx = await createPrismaHealthApp(({ healthCheck, prisma }) =>
              healthCheck.check([
                async () => prisma.pingCheck("prismamongo", mongoClient),
              ]),
            );

            const details = {
              prismamongo: { status: "up", responseTime: expect.any(Number) },
            };

            const res = await httpRequest(ctx.app).get("/health").expect(200);
            const body = res.body as Record<string, unknown>;
            expect(body.status).toBe("ok");
            expect(body.info).toEqual(details);
            expect(body.error).toEqual({});
            expect(body.details).toEqual(details);
          },
          "Uses in-process duck-typed MongoDB Prisma client ($runCommandRaw)",
        );

        // BUNEST_BUG: HttpException.toJSON() overwrites HealthCheckException's object `body.error` with the string "HealthCheckException" instead of preserving the indicator error map (packages/core/src/common/exceptions/http.exception.ts:167-177, packages/observability/src/health/health.service.ts:26-41).
        it.skip(
          adaptedTitle(
            ["ADR-001"],
            "should throw an error if runs into timeout error",
            "Uses slow in-process MongoDB Prisma client stub without Docker",
          ),
          async () => {
            const slowMongoClient: PrismaHealthClient = {
              $runCommandRaw: () => createDelayedPromise(100, { ok: 1 }),
            };

            ctx = await createPrismaHealthApp(({ healthCheck, prisma }) =>
              healthCheck.check([
                async () =>
                  prisma.pingCheck("prismamongo", slowMongoClient, {
                    timeout: 1,
                  }),
              ]),
            );

            const details = {
              prismamongo: {
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
      });
    });

    describe("mysql", () => {
      describe("#pingCheck", () => {
        itAdapted(
          ["ADR-001"],
          "should check if the prisma is available",
          async () => {
            const mysqlClient: PrismaHealthClient = {
              $queryRawUnsafe: async (sql) => {
                expect(sql).toBe("SELECT 1");
                return [{ 1: 1 }];
              },
            };

            ctx = await createPrismaHealthApp(({ healthCheck, prisma }) =>
              healthCheck.check([
                async () => prisma.pingCheck("prisma", mysqlClient),
              ]),
            );

            const details = {
              prisma: { status: "up", responseTime: expect.any(Number) },
            };

            const res = await httpRequest(ctx.app).get("/health").expect(200);
            const body = res.body as Record<string, unknown>;
            expect(body.status).toBe("ok");
            expect(body.info).toEqual(details);
            expect(body.error).toEqual({});
            expect(body.details).toEqual(details);
          },
          "Uses in-process duck-typed SQL Prisma client ($queryRawUnsafe)",
        );

        // BUNEST_BUG: HttpException.toJSON() overwrites HealthCheckException's object `body.error` with the string "HealthCheckException" instead of preserving the indicator error map (packages/core/src/common/exceptions/http.exception.ts:167-177, packages/observability/src/health/health.service.ts:26-41).
        it.skip(
          adaptedTitle(
            ["ADR-001"],
            "should throw an error if runs into timeout error",
            "Uses slow in-process SQL Prisma client stub without Docker",
          ),
          async () => {
            const slowMysqlClient: PrismaHealthClient = {
              $queryRawUnsafe: () => createDelayedPromise(100, [{ 1: 1 }]),
            };

            ctx = await createPrismaHealthApp(({ healthCheck, prisma }) =>
              healthCheck.check([
                async () =>
                  prisma.pingCheck("prisma", slowMysqlClient, {
                    timeout: 1,
                  }),
              ]),
            );

            const details = {
              prisma: {
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
      });
    });
  },
);
