import { afterEach, describe, expect, it } from "bun:test";
import { Controller, Get } from "../../../../../../packages/core/src/common";
import {
  CHECK_DISK_SPACE_LIB,
  DiskHealthIndicator,
  HealthCheck,
  HealthCheckService,
  TerminusModule,
  type CheckDiskSpaceFn,
  type HealthCheckResult,
} from "../../../../../../packages/observability/src";
import {
  Test,
  describeConformance,
  httpRequest,
  type TestAppContext,
} from "../../../../_helpers/index";

const GB = 1024 * 1024 * 1024;
/**
 * Fixed filesystem stats (100 GB total, 60 GB free => 40 GB / 40% used)
 * so threshold assertions never assume host `/` has >0 used bytes.
 */
const FIXED_DISK_STATS = { size: 100 * GB, free: 60 * GB };
const fixedCheckDiskSpace: CheckDiskSpaceFn = async () => FIXED_DISK_STATS;

async function createDiskHealthApp(
  handler: (props: {
    healthCheck: HealthCheckService;
    disk: DiskHealthIndicator;
  }) => Promise<HealthCheckResult>,
  options?: { checkDiskSpace?: CheckDiskSpaceFn },
): Promise<TestAppContext> {
  @Controller()
  class HealthController {
    constructor(
      private readonly healthCheck: HealthCheckService,
      private readonly disk: DiskHealthIndicator,
    ) {}

    @Get("health")
    @HealthCheck()
    health() {
      return handler({ healthCheck: this.healthCheck, disk: this.disk });
    }
  }

  let builder = Test.createTestingModule({
    imports: [TerminusModule.forRoot({ logger: false })],
    controllers: [HealthController],
  });
  if (options?.checkDiskSpace) {
    builder = builder
      .overrideProvider(CHECK_DISK_SPACE_LIB)
      .useValue(options.checkDiskSpace);
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createBunestApplication({ logger: false });
  await app.init();
  return {
    app,
    moduleRef,
    close: async () => {
      await app.close();
    },
  };
}

describeConformance(
  "DiskHealthIndicator (e2e)",
  {
    upstreamPath: "terminus/e2e/health-checks/disk.health.e2e-spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts upstream @nestjs/terminus DiskHealthIndicator E2E spec to zero-socket BunestApplication with deterministic fixed filesystem metrics for threshold assertions and real statfs ENOENT verification for non-existent paths.",
  },
  () => {
    let ctx: TestAppContext | undefined;

    afterEach(async () => {
      if (ctx) {
        await ctx.close();
        ctx = undefined;
      }
    });

    describe("#checkStorage", () => {
      it("should check if the disk threshold has not exceeded", async () => {
        const { free, size } = FIXED_DISK_STATS;
        ctx = await createDiskHealthApp(
          ({ healthCheck, disk }) =>
            healthCheck.check([
              () =>
                disk.checkStorage("disk", {
                  path: "/",
                  threshold: size - free + GB,
                }),
            ]),
          { checkDiskSpace: fixedCheckDiskSpace },
        );

        const details = {
          disk: { status: "up", responseTime: expect.any(Number) },
        };

        const res = await httpRequest(ctx.app).get("/health").expect(200);
        const body = res.body as Record<string, unknown>;
        expect(body.status).toBe("ok");
        expect(body.info).toEqual(details);
        expect(body.error).toEqual({});
        expect(body.details).toEqual(details);
      });

      it("should check if correctly displays a threshold exceeded error", async () => {
        ctx = await createDiskHealthApp(
          ({ healthCheck, disk }) =>
            healthCheck.check([
              () => disk.checkStorage("disk", { path: "/", threshold: 0 }),
            ]),
          { checkDiskSpace: fixedCheckDiskSpace },
        );

        const details = {
          disk: {
            status: "down",
            message: "Used disk storage exceeded the set threshold",
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

      it("should check if the disk thresholdPercent has not exceeded", async () => {
        const { free, size } = FIXED_DISK_STATS;
        const thresholdPercent = (size - free) / size;
        ctx = await createDiskHealthApp(
          ({ healthCheck, disk }) =>
            healthCheck.check([
              async () =>
                disk.checkStorage("disk", {
                  path: "/",
                  thresholdPercent: thresholdPercent + 0.2,
                }),
            ]),
          { checkDiskSpace: fixedCheckDiskSpace },
        );

        const details = {
          disk: { status: "up", responseTime: expect.any(Number) },
        };

        const res = await httpRequest(ctx.app).get("/health").expect(200);
        const body = res.body as Record<string, unknown>;
        expect(body.status).toBe("ok");
        expect(body.info).toEqual(details);
        expect(body.error).toEqual({});
        expect(body.details).toEqual(details);
      });

      it("should check if correctly displays a thresholdPercent exceeded error", async () => {
        const { free, size } = FIXED_DISK_STATS;
        const thresholdPercent = (size - free) / size;
        ctx = await createDiskHealthApp(
          ({ healthCheck, disk }) =>
            healthCheck.check([
              async () =>
                disk.checkStorage("disk", {
                  path: "/",
                  thresholdPercent: thresholdPercent - 0.2,
                }),
            ]),
          { checkDiskSpace: fixedCheckDiskSpace },
        );

        const details = {
          disk: {
            status: "down",
            message: "Used disk storage exceeded the set threshold",
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

    describe("#checkStorage builders", () => {
      it("should be down, not a 500, when the path does not exist", async () => {
        ctx = await createDiskHealthApp(({ healthCheck, disk }) =>
          healthCheck.check([
            () =>
              disk.checkStorage("disk", {
                path: "/does/not/exist",
                threshold: 1,
              }),
          ]),
        );

        const res = await httpRequest(ctx.app).get("/health").expect(503);
        const body = res.body as { details: { disk: unknown } };
        expect(body.details.disk).toEqual({
          status: "down",
          message: expect.stringContaining("ENOENT"),
          responseTime: expect.any(Number),
        });
      });
    });
  },
);
