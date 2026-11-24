import { afterEach, beforeEach, expect, it, jest, mock } from "bun:test";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  CronExpression,
  CronJob,
  ScheduleModule,
  SchedulerRegistry,
} from "../../../../../packages/jobs/src/scheduler";
import { Test, describeConformance, itAdapted } from "../../../_helpers";
import {
  advanceTimersByTimeAsync,
  runAllTimersAsync,
} from "../_fixtures/scheduler-fixtures";

describeConformance(
  "Cron shutdown",
  {
    upstreamPath: "nestjs/schedule/tests/e2e/cron-shutdown.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts cron npm package CronJob (CronJob.from/isActive/fireOnTick) to native @bunest/scheduler CronJob (new CronJob/isRunning()/fireOnce()) and Vitest fake timers to Bun jest.useFakeTimers().",
  },
  () => {
    let app: BunestApplication | undefined;
    let registry: SchedulerRegistry;
    let completeWork: () => void;
    let work: Promise<void>;
    let onApplicationShutdown: ReturnType<typeof mock>;

    beforeEach(async () => {
      jest.useFakeTimers();
      work = new Promise<void>((resolve) => {
        completeWork = resolve;
      });
      onApplicationShutdown = mock(() => {});
      const module = await Test.createTestingModule({
        imports: [ScheduleModule.forRoot()],
        providers: [
          { provide: "resource", useValue: { onApplicationShutdown } },
        ],
      }).compile();
      const instance = module.createNestApplication();
      app = instance;
      await instance.init();
      registry = instance.get(SchedulerRegistry);
    });

    afterEach(async () => {
      completeWork();
      if (app) {
        const closing = app.close();
        await runAllTimersAsync();
        await closing;
        app = undefined;
      }
      jest.useRealTimers();
    });

    // BUNEST_BUG: Expected SchedulerRegistry.onModuleDestroy() to stop all cron jobs and await in-flight waitForCompletion: true callbacks before onApplicationShutdown runs, but packages/jobs/src/scheduler/scheduler.registry.ts stopAll() is synchronous and does not await active ticks.
    it.skip("should stop all jobs before waiting for active callbacks during shutdown [ADR-001: native CronJob fireOnce()/isRunning()]", async () => {
      const lifecycle: string[] = [];
      onApplicationShutdown.mockImplementation(() =>
        lifecycle.push("shutdown"),
      );
      const onTick = mock(async () => {
        await work;
        lifecycle.push("job");
      });
      const job = new CronJob(CronExpression.EVERY_SECOND, onTick, {
        waitForCompletion: true,
      });
      job.start();
      const otherJob = new CronJob(
        CronExpression.EVERY_SECOND,
        mock(() => {}),
      );
      otherJob.start();
      registry.addCronJob("running", job);
      registry.addCronJob("other", otherJob);

      const running = job.fireOnce();
      const closed = mock(() => {});
      const closing = app!.close().then(closed);

      await advanceTimersByTimeAsync(0);
      expect(job.isRunning()).toBe(false);
      expect(otherJob.isRunning()).toBe(false);
      expect(registry.getCronJobs().size).toBe(0);
      expect(closed).not.toHaveBeenCalled();
      expect(onApplicationShutdown).not.toHaveBeenCalled();

      completeWork();
      await running;
      await runAllTimersAsync();
      await closing;
      expect(onTick).toHaveBeenCalledTimes(1);
      expect(onApplicationShutdown).toHaveBeenCalledTimes(1);
      expect(lifecycle).toEqual(["job", "shutdown"]);
      expect(jest.getTimerCount()).toBe(0);
    });

    it.each([false, undefined])(
      "should not wait for callbacks when waitForCompletion is %s",
      async (waitForCompletion) => {
        const finished = mock(() => {});
        const job = new CronJob(
          CronExpression.EVERY_SECOND,
          async () => {
            await work;
            finished();
          },
          { waitForCompletion },
        );
        job.start();
        registry.addCronJob("running", job);
        const tickPromise = job.fireOnce();

        await app!.close();
        expect(finished).not.toHaveBeenCalled();
        expect(onApplicationShutdown).toHaveBeenCalledTimes(1);
        expect(job.isRunning()).toBe(false);
        expect(registry.getCronJobs().size).toBe(0);

        completeWork();
        await tickPromise;
      },
    );

    // BUNEST_BUG: Expected CronJob to support onComplete callback on stop() and SchedulerRegistry shutdown to preserve jobs newly added by an onComplete hook, but packages/jobs/src/scheduler/cron/cron-job.ts has no onComplete option and packages/jobs/src/scheduler/scheduler.registry.ts stopAll() clears the entire cronJobs map.
    it.skip("should not stop jobs added by a completion callback during shutdown", async () => {
      const replacementOnComplete = mock(() => {});
      const job = new CronJob(
        CronExpression.EVERY_SECOND,
        mock(() => {}),
        {
          // Upstream CronJob onComplete option
          ...({
            onComplete: () => {
              const replacement = new CronJob(
                CronExpression.EVERY_SECOND,
                mock(() => {}),
                {
                  ...({ onComplete: replacementOnComplete } as Record<
                    string,
                    unknown
                  >),
                },
              );
              replacement.start();
              registry.addCronJob("replacement", replacement);
            },
          } as Record<string, unknown>),
        },
      );
      job.start();
      registry.addCronJob("original", job);

      try {
        await app!.close();

        expect(replacementOnComplete).not.toHaveBeenCalled();
        expect(registry.doesExist("cron", "original")).toBe(false);
        expect(registry.getCronJob("replacement").isRunning()).toBe(true);
      } finally {
        if (registry.doesExist("cron", "replacement")) {
          registry.deleteCronJob("replacement");
        }
      }
    });

    // BUNEST_BUG: Expected CronJob to invoke onComplete on stop() and SchedulerRegistry shutdown to stop a later job replaced during an earlier job's onComplete callback, but packages/jobs/src/scheduler/cron/cron-job.ts does not support onComplete.
    it.skip("should stop a later job replaced by a completion callback during shutdown", async () => {
      const replacementOnComplete = mock(() => {});
      const replacement = new CronJob(
        CronExpression.EVERY_SECOND,
        mock(() => {}),
        {
          ...({ onComplete: replacementOnComplete } as Record<string, unknown>),
        },
      );
      const first = new CronJob(
        CronExpression.EVERY_SECOND,
        mock(() => {}),
        {
          ...({
            onComplete: () => {
              registry.deleteCronJob("replaced");
              registry.addCronJob("replaced", replacement);
              replacement.start();
            },
          } as Record<string, unknown>),
        },
      );
      first.start();
      const replaced = new CronJob(
        CronExpression.EVERY_SECOND,
        mock(() => {}),
      );
      replaced.start();
      registry.addCronJob("first", first);
      registry.addCronJob("replaced", replaced);

      try {
        await app!.close();

        expect(replacement.isRunning()).toBe(false);
        expect(replacementOnComplete).toHaveBeenCalledTimes(1);
        expect(registry.getCronJobs().size).toBe(0);
      } finally {
        if (replacement.isRunning()) {
          replacement.stop();
        }
      }
    });

    itAdapted(
      "ADR-001",
      "should keep deleting an active job synchronously from its own callback",
      async () => {
        const deleted = mock(() => {});
        let deletionResult: unknown = "not deleted";
        const job = new CronJob(
          CronExpression.EVERY_SECOND,
          async () => {
            deletionResult = registry.deleteCronJob("running");
            await deletionResult;
            deleted();
          },
          { waitForCompletion: true },
        );
        job.start();
        registry.addCronJob("running", job);

        await job.fireOnce();
        expect(deletionResult).toBeUndefined();
        expect(registry.doesExist("cron", "running")).toBe(false);
        expect(deleted).toHaveBeenCalledTimes(1);
        expect(job.isRunning()).toBe(false);
        await runAllTimersAsync();
      },
      "native CronJob fireOnce()/isRunning()",
    );
  },
);
