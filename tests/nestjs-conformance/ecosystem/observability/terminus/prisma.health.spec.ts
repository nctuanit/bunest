import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  HealthIndicatorService,
  PrismaHealthIndicator,
} from "../../../../../packages/observability/src";
import {
  Test,
  type TestingModule,
  describeConformance,
} from "../../../_helpers/index";

type AssertEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

describeConformance(
  "PrismaHealthIndicator",
  {
    upstreamPath:
      "terminus/lib/health-indicator/database/prisma.health.spec.ts",
    category: "DIRECT_PORT",
    notes:
      "Direct port of upstream @nestjs/terminus PrismaHealthIndicator unit tests against @bunest/observability.",
  },
  () => {
    it("types the code on a failed result", () => {
      type Entry = Awaited<
        ReturnType<PrismaHealthIndicator["pingCheck"]>
      >[string];
      const _codeIsTyped: AssertEqual<
        Extract<Entry, { message: string }>["code"],
        string | number | undefined
      > = true;
      expect(_codeIsTyped).toBe(true);
    });

    let moduleRef: TestingModule;
    let prisma: PrismaHealthIndicator;
    // A SQL client: the MongoDB command fails, so the raw query is used
    const client = {
      $runCommandRaw: mock(),
      $queryRawUnsafe: mock(),
    };

    beforeEach(async () => {
      client.$runCommandRaw
        .mockReset()
        .mockRejectedValue(new Error("Use the mongodb provider"));
      client.$queryRawUnsafe.mockReset();

      moduleRef = await Test.createTestingModule({
        providers: [PrismaHealthIndicator, HealthIndicatorService],
      }).compile({ logger: false });
      prisma = await moduleRef.resolve(PrismaHealthIndicator);
    });

    afterEach(async () => {
      await moduleRef.close();
    });

    it("is up when the raw query succeeds", async () => {
      client.$queryRawUnsafe.mockResolvedValue([{ 1: 1 }]);

      const result = await prisma.pingCheck("db", client as any);

      expect(result).toEqual({
        db: { status: "up", responseTime: expect.any(Number) },
      });
    });

    it("adds the Prisma error code to a failed result", async () => {
      client.$queryRawUnsafe.mockRejectedValue(
        Object.assign(new Error("Raw query failed"), { code: "P2010" }),
      );

      const result = await prisma.pingCheck("db", client as any);

      expect(result).toEqual({
        db: {
          status: "down",
          message: "Raw query failed",
          code: "P2010",
          responseTime: expect.any(Number),
        },
      });
    });
  },
);
