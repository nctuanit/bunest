import "reflect-metadata";
import { afterEach, beforeEach, expect, jest } from "bun:test";
import { Injectable } from "../../../../../packages/common/src";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  Cron,
  CronExpression,
  CronJob,
  ScheduleModule,
  SchedulerRegistry,
} from "../../../../../packages/scheduler/src";
import { Test, describeConformance, itAdapted } from "../../../_helpers";

@Injectable()
class ResurrectionService {
  oldJobCalls = 0;

  @Cron(CronExpression.EVERY_SECOND, {
    name: "RESURRECT_ME",
    initialDelay: 5000,
  })
  oldJob() {
    ++this.oldJobCalls;
  }
}

describeConformance(
  "Cron initialDelay resurrection",
  {
    upstreamPath: "nestjs/schedule/tests/e2e/cron-initial-delay.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts cron npm package CronJob.from() to native @bunest/scheduler new CronJob() and Vitest vi.useFakeTimers() to Bun jest.useFakeTimers().",
  },
  () => {
    let app: BunestApplication | undefined;

    beforeEach(async () => {
      const module = await Test.createTestingModule({
        imports: [ScheduleModule.forRoot()],
        providers: [ResurrectionService],
      }).compile();

      app = module.createNestApplication();
      jest.useFakeTimers({ now: 1577836800000 }); // 2020-01-01T00:00:00.000Z
    });

    afterEach(async () => {
      await app?.close();
      app = undefined;
      jest.useRealTimers();
    });

    itAdapted(
      "ADR-001",
      "does not resurrect a deleted initialDelay job when its name is re-registered",
      async () => {
        const service = app!.get(ResurrectionService);
        const registry = app!.get(SchedulerRegistry);
        await app!.init();

        // Delete the job while its initialDelay timer is still pending.
        registry.deleteCronJob("RESURRECT_ME");

        // Register a brand-new job under the same name.
        let newCalls = 0;
        const replacement = new CronJob(CronExpression.EVERY_SECOND, () => {
          ++newCalls;
        });
        registry.addCronJob("RESURRECT_ME", replacement);
        replacement.start();

        // Advance well past the original 5s initialDelay deadline.
        jest.advanceTimersByTime(7000);

        // The new job keeps ticking...
        expect(newCalls).toBeGreaterThan(0);
        // ...while the deleted job must never execute again.
        expect(service.oldJobCalls).toEqual(0);
      },
      "native @bunest/scheduler CronJob + Bun fake timers",
    );
  },
);
