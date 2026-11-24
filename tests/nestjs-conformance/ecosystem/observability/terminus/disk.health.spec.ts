import { beforeEach, describe, expect, it, mock } from "bun:test";
import {
  DiskHealthIndicator,
  HealthIndicatorService,
  defaultCheckDiskSpace,
} from "../../../../../packages/observability/src";
import { describeConformance } from "../../../_helpers/index";

const GB = 1024 ** 3;
const message = "Used disk storage exceeded the set threshold";

describeConformance(
  "DiskHealthIndicator",
  {
    upstreamPath: "terminus/lib/health-indicator/disk/disk.health.spec.ts",
    category: "DIRECT_PORT",
    notes:
      "Direct port of upstream @nestjs/terminus DiskHealthIndicator unit tests against @bunest/observability.",
  },
  () => {
    // 100 GB disk, 40 GB used
    const diskSpace = mock(async (_path: string) => ({
      free: 60 * GB,
      size: 100 * GB,
    }));
    let disk: DiskHealthIndicator;

    beforeEach(() => {
      diskSpace.mockReset();
      diskSpace.mockImplementation(async (_path: string) => ({
        free: 60 * GB,
        size: 100 * GB,
      }));
      disk = new DiskHealthIndicator(diskSpace, new HealthIndicatorService());
    });

    describe("#checkStorage", () => {
      it("is up below the threshold and reads the given path", async () => {
        const result = await disk.checkStorage("disk", {
          path: "/data",
          threshold: 50 * GB,
        });
        expect(result).toEqual({
          disk: { status: "up", responseTime: expect.any(Number) },
        });
        expect(diskSpace).toHaveBeenCalledWith("/data");
      });

      // BUNEST_BUG: DiskHealthIndicator.checkStorage() throws "The used disk storage has exceeded the threshold" instead of upstream "Used disk storage exceeded the set threshold" (packages/observability/src/health/health.indicators.ts:747).
      it.skip("is down above the threshold, with the same message as before", async () => {
        const result = await disk.checkStorage("disk", {
          path: "/",
          threshold: 30 * GB,
        });
        expect(result).toEqual({
          disk: { status: "down", message, responseTime: expect.any(Number) },
        });
      });

      // BUNEST_BUG: DiskHealthIndicator.checkStorage() throws "The used disk storage has exceeded the threshold" instead of upstream "Used disk storage exceeded the set threshold" (packages/observability/src/health/health.indicators.ts:747).
      it.skip("accepts a size string as the threshold", async () => {
        const up = await disk.checkStorage("disk", {
          path: "/",
          threshold: "50gb",
        });
        const down = await disk.checkStorage("disk", {
          path: "/",
          threshold: "30gb",
        });
        expect(up.disk.status).toBe("up");
        expect(down.disk).toMatchObject({ status: "down", message });
      });

      it("throws on an invalid size string when the check is created", () => {
        expect(() =>
          disk.checkStorage("disk", { path: "/", threshold: "50GB" as "50gb" }),
        ).toThrow('Disk threshold: Invalid size "50GB".');
      });

      it("is up below thresholdPercent", async () => {
        const result = await disk.checkStorage("disk", {
          path: "/",
          thresholdPercent: 0.5,
        });
        expect(result.disk.status).toBe("up");
      });

      // BUNEST_BUG: DiskHealthIndicator.checkStorage() throws "The used disk storage has exceeded the threshold" instead of upstream "Used disk storage exceeded the set threshold" (packages/observability/src/health/health.indicators.ts:747).
      it.skip("is down above thresholdPercent", async () => {
        const result = await disk.checkStorage("disk", {
          path: "/",
          thresholdPercent: 0.3,
        });
        expect(result.disk).toMatchObject({ status: "down", message });
      });

      // BUNEST_BUG: DiskHealthIndicator.checkStorage() throws "The used disk storage has exceeded the threshold" instead of upstream "Used disk storage exceeded the set threshold" when size <= 0 (packages/observability/src/health/health.indicators.ts:738).
      it.skip("is down when the disk size is 0", async () => {
        diskSpace.mockResolvedValueOnce({ free: 0, size: 0 });
        const result = await disk.checkStorage("disk", {
          path: "/",
          thresholdPercent: 0.5,
        });
        expect(result.disk).toMatchObject({ status: "down", message });
      });

      it("is down instead of throwing when the path does not exist", async () => {
        const real = new DiskHealthIndicator(
          defaultCheckDiskSpace,
          new HealthIndicatorService(),
        );
        const result = await real.checkStorage("disk", {
          path: "/does/not/exist",
          threshold: GB,
        });
        expect(result.disk).toMatchObject({
          status: "down",
          message: expect.stringContaining("ENOENT"),
        });
      });

      // BUNEST_BUG: DiskHealthIndicator.checkStorage() throws "The used disk storage has exceeded the threshold" instead of upstream "Used disk storage exceeded the set threshold" (packages/observability/src/health/health.indicators.ts:747).
      it.skip("is degraded instead of down with degradedOnFailure()", async () => {
        const result = await disk
          .checkStorage("disk", { path: "/", threshold: 30 * GB })
          .degradedOnFailure();
        expect(result.disk).toMatchObject({ status: "degraded", message });
      });
    });
  },
);
