import { afterEach, beforeEach, expect, it } from "bun:test";
import type { BunestApplication } from "../../../../../packages/core/src";
import { SchedulerRegistry } from "../../../../../packages/jobs/src/scheduler";
import { Test, describeConformance } from "../../../_helpers";
import { SchedulerAppModule } from "../_fixtures/scheduler-fixtures";

describeConformance(
  "Disabled Discovery - Cron",
  {
    upstreamPath: "nestjs/schedule/tests/e2e/disabled-discovery.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    let app: BunestApplication | undefined;

    beforeEach(async () => {
      const module = await Test.createTestingModule({
        imports: [
          SchedulerAppModule.registerCron({
            cronJobs: false,
            intervals: true,
            timeouts: true,
          }),
        ],
      }).compile();

      app = module.createNestApplication();
    });

    afterEach(async () => {
      await app?.close();
      app = undefined;
    });

    it("should not register cron", async () => {
      await app!.init();
      const registry = app!.get(SchedulerRegistry);
      const count = Array.from(registry.getCronJobs().keys()).length;
      expect(count).toBe(0);
    });
  },
);

describeConformance(
  "Disabled Discovery - Interval",
  {
    upstreamPath: "nestjs/schedule/tests/e2e/disabled-discovery.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    let app: BunestApplication | undefined;

    beforeEach(async () => {
      const module = await Test.createTestingModule({
        imports: [
          SchedulerAppModule.registerInterval({
            cronJobs: true,
            intervals: false,
            timeouts: true,
          }),
        ],
      }).compile();

      app = module.createNestApplication();
    });

    afterEach(async () => {
      await app?.close();
      app = undefined;
    });

    it("should not register interval", async () => {
      await app!.init();
      const registry = app!.get(SchedulerRegistry);
      const count = registry.getIntervals().length;
      expect(count).toBe(0);
    });
  },
);

describeConformance(
  "Disabled Discovery - Timeout",
  {
    upstreamPath: "nestjs/schedule/tests/e2e/disabled-discovery.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    let app: BunestApplication | undefined;

    beforeEach(async () => {
      const module = await Test.createTestingModule({
        imports: [
          SchedulerAppModule.registerTimeout({
            cronJobs: true,
            intervals: true,
            timeouts: false,
          }),
        ],
      }).compile();

      app = module.createNestApplication();
    });

    afterEach(async () => {
      await app?.close();
      app = undefined;
    });

    it("should not register timeout", async () => {
      await app!.init();
      const registry = app!.get(SchedulerRegistry);
      const count = registry.getTimeouts().length;
      expect(count).toBe(0);
    });
  },
);
