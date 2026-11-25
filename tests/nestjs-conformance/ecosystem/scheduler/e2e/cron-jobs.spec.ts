import { afterEach, beforeEach, expect, it, jest, mock, spyOn } from "bun:test";
import { Injectable, Logger } from "../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  Cron,
  CronExpression,
  CronJob,
  ScheduleModule,
  SchedulerRegistry,
} from "../../../../../packages/jobs/src/scheduler";
import { Test, describeConformance, itAdapted } from "../../../_helpers";
import {
  CronService,
  DUPLICATE_SCHEDULER,
  SchedulerAppModule,
  advanceTimersByTimeAsync,
  nullPrototypeObjectProvider,
} from "../_fixtures/scheduler-fixtures";

const deleteAllRegisteredJobsExceptOne = (
  registry: SchedulerRegistry,
  name: string,
) => {
  Array.from(registry.getCronJobs().keys())
    .filter((key) => key !== name)
    .forEach((item) => registry.deleteCronJob(item));
};

describeConformance(
  "Cron",
  {
    upstreamPath: "nestjs/schedule/tests/e2e/cron-jobs.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts cron npm package CronJob (CronJob.from/isActive/errorHandler) to native @bunest/scheduler CronJob (new CronJob/isRunning()/onError) and Vitest fake timers to Bun jest.useFakeTimers().",
  },
  () => {
    let app: BunestApplication | undefined;

    beforeEach(async () => {
      const module = await Test.createTestingModule({
        imports: [SchedulerAppModule.registerCron()],
      }).compile();

      app = module.createNestApplication();
      jest.useFakeTimers({ now: 1577836800000 }); // 2020-01-01T00:00:00.000Z
    });

    afterEach(async () => {
      Logger.overrideLogger(true);
      await app?.close();
      app = undefined;
      jest.useRealTimers();
    });

    it(`should schedule "cron"`, async () => {
      const service = app!.get(CronService);

      expect(service.callsCount).toEqual(0);

      await app!.init();
      jest.advanceTimersByTime(3000);

      expect(service.callsCount).toEqual(3);
    });

    itAdapted(
      "ADR-001",
      `should catch and log exception inside cron-function added by scheduler`,
      async () => {
        await app!.init();
        const registry = app!.get(SchedulerRegistry);
        const errorHandlerSpy = mock(() => {});

        const job = new CronJob(
          CronExpression.EVERY_SECOND,
          () => {
            throw new Error("ERROR IN CRONJOB GOT CATCHED");
          },
          { onError: errorHandlerSpy },
        );
        registry.addCronJob("THROWS_EXCEPTION_INSIDE", job);
        job.start();
        await advanceTimersByTimeAsync(1_000);

        expect(errorHandlerSpy).toHaveBeenCalledWith(
          new Error("ERROR IN CRONJOB GOT CATCHED"),
          CronExpression.EVERY_SECOND,
        );
      },
      "native CronJob onError callback",
    );

    itAdapted(
      "ADR-001",
      `should run "cron" once after 30 seconds`,
      async () => {
        const service = app!.get(CronService);

        await app!.init();
        const registry = app!.get(SchedulerRegistry);
        const job = registry.getCronJob("EXECUTES_EVERY_30_SECONDS");
        deleteAllRegisteredJobsExceptOne(registry, "EXECUTES_EVERY_30_SECONDS");

        expect(job.isRunning()).toBe(true);
        expect(service.callsCount).toEqual(0);

        jest.advanceTimersByTime(30_000);
        expect(service.callsCount).toEqual(1);
        expect(job.lastDate()).toEqual(new Date("2020-01-01T00:00:30.000Z"));

        jest.advanceTimersByTime(31_000);
        expect(job.isRunning()).toBe(false);
      },
      "native CronJob.isRunning()",
    );

    it(`should wait for "cron" to complete [ADR-001: native CronJob.isRunning() + Bun fake timers]`, async () => {
      const service = app!.get(CronService);

      await app!.init();
      const registry = app!.get(SchedulerRegistry);
      const job = registry.getCronJob("WAIT_FOR_COMPLETION");
      deleteAllRegisteredJobsExceptOne(registry, "WAIT_FOR_COMPLETION");

      expect(job.isRunning()).toBe(true);
      expect(service.callsCount).toEqual(0);

      await advanceTimersByTimeAsync(60_000);
      // 00:01:00
      expect(service.callsCount).toEqual(1);
      expect(service.callsFinishedCount).toEqual(0);
      expect(job.lastDate()).toEqual(new Date("2020-01-01T00:01:00.000Z"));

      await advanceTimersByTimeAsync(1_000);
      // 00:01:01
      expect(service.callsCount).toEqual(1);
      expect(service.callsFinishedCount).toEqual(0);

      await advanceTimersByTimeAsync(59_000);
      // 00:02:00
      expect(service.callsCount).toEqual(1);
      expect(service.callsFinishedCount).toEqual(0);

      await advanceTimersByTimeAsync(1_000);
      // 00:02:01
      expect(service.callsCount).toEqual(1);
      expect(service.callsFinishedCount).toEqual(1);
      expect(job.lastDate()).toEqual(new Date("2020-01-01T00:02:00.000Z"));

      await advanceTimersByTimeAsync(59_000);
      // 00:03:00
      expect(service.callsCount).toEqual(2);
      expect(service.callsFinishedCount).toEqual(1);

      await advanceTimersByTimeAsync(1_000);
      // 00:03:01
      expect(service.callsCount).toEqual(2);
      expect(service.callsFinishedCount).toEqual(1);
      expect(job.lastDate()).toEqual(new Date("2020-01-01T00:03:00.000Z"));

      await advanceTimersByTimeAsync(59_000);
      // 00:04:00
      expect(service.callsCount).toEqual(2);
      expect(service.callsFinishedCount).toEqual(1);

      await advanceTimersByTimeAsync(1_000);
      // 00:04:01
      expect(service.callsCount).toEqual(2);
      expect(service.callsFinishedCount).toEqual(2);
      expect(job.lastDate()).toEqual(new Date("2020-01-01T00:04:00.000Z"));

      await advanceTimersByTimeAsync(59_000);
      // 00:05:00
      expect(service.callsCount).toEqual(3);
      expect(service.callsFinishedCount).toEqual(2);

      await advanceTimersByTimeAsync(61_000);
      // 00:06:01
      expect(service.callsCount).toEqual(3);
      expect(service.callsFinishedCount).toEqual(3);
      expect(job.isRunning()).toBe(false);
    });

    itAdapted(
      "ADR-001",
      `should run "cron" 3 times every 60 seconds`,
      async () => {
        const service = app!.get(CronService);

        await app!.init();
        expect(service.callsCount).toEqual(0);

        const registry = app!.get(SchedulerRegistry);
        const job = registry.getCronJob("EXECUTES_EVERY_MINUTE");
        deleteAllRegisteredJobsExceptOne(registry, "EXECUTES_EVERY_MINUTE");

        jest.advanceTimersByTime(180_000);
        expect(service.callsCount).toEqual(3);
        expect(job.lastDate()).toEqual(new Date("2020-01-01T00:03:00.000Z"));

        jest.advanceTimersByTime(181_000);
        expect(job.isRunning()).toBe(false);
      },
      "native CronJob.isRunning()",
    );

    itAdapted(
      "ADR-001",
      `should run "cron" 3 times every hour`,
      async () => {
        const service = app!.get(CronService);

        await app!.init();
        expect(service.callsCount).toEqual(0);

        const registry = app!.get(SchedulerRegistry);
        const job = registry.getCronJob("EXECUTES_EVERY_HOUR");
        deleteAllRegisteredJobsExceptOne(registry, "EXECUTES_EVERY_HOUR");

        jest.advanceTimersByTime(10_800_000);
        expect(service.callsCount).toEqual(3);
        expect(job.lastDate()).toEqual(new Date("2020-01-01T03:00:00.000Z"));

        jest.advanceTimersByTime(10_801_000);
        expect(job.isRunning()).toBe(false);
      },
      "native CronJob.isRunning()",
    );

    itAdapted(
      "ADR-001",
      `should not run "cron" at all`,
      async () => {
        await app!.init();
        const registry = app!.get(SchedulerRegistry);

        expect(registry.getCronJob("DISABLED").isRunning()).toBeFalsy();
      },
      "native CronJob.isRunning()",
    );

    it(`should return cron id by name`, async () => {
      await app!.init();
      const registry = app!.get(SchedulerRegistry);
      expect(registry.getCronJob("EXECUTES_EVERY_SECOND")).not.toBeUndefined();
    });

    it(`should add dynamic cron job`, async () => {
      const service = app!.get(CronService);
      await app!.init();
      service.addCronJob();
      const registry = app!.get(SchedulerRegistry);
      expect(registry.getCronJob("dynamic")).not.toBeUndefined();
    });

    itAdapted(
      "ADR-001",
      `should return and start dynamic cron job`,
      async () => {
        const service = app!.get(CronService);
        await app!.init();
        const addedJob = service.addCronJob();
        const registry = app!.get(SchedulerRegistry);
        const jobs = registry.getCronJobs();

        expect(jobs.get("dynamic")).toEqual(addedJob);

        const job = registry.getCronJob("dynamic");
        expect(job).toBeDefined();
        expect(job.isRunning()).toBe(false);

        job.start();
        expect(job.isRunning()).toBe(true);

        jest.advanceTimersByTime(3000);
        expect(service.dynamicCallsCount).toEqual(3);
      },
      "native CronJob.isRunning()",
    );

    it(`should delete dynamic cron job`, async () => {
      const service = app!.get(CronService);
      await app!.init();

      service.addCronJob();

      const registry = app!.get(SchedulerRegistry);
      let job = registry.getCronJob("dynamic");
      expect(job).toBeDefined();

      registry.deleteCronJob("dynamic");
      let caught: Error | undefined;
      try {
        job = registry.getCronJob("dynamic");
      } catch (e) {
        caught = e as Error;
      }
      expect(caught).toBeDefined();
      expect(caught!.message).toEqual(
        "No Cron Job was found with the given name (dynamic). Check that you created one with a decorator or with the create API.",
      );
    });

    it(`should initialize when the consuming module contains a provider with a null prototype`, async () => {
      await app!.close();
      const module = await Test.createTestingModule({
        imports: [SchedulerAppModule.registerCron()],
        providers: [nullPrototypeObjectProvider],
      }).compile();
      const instance = module.createNestApplication();
      app = instance;

      const initialized = await instance.init();
      expect(initialized).toBeDefined();
    });

    it("should clean up dynamic cron jobs on application shutdown", async () => {
      const service = app!.get(CronService);
      await app!.init();
      service.addCronJob();

      const registry = app!.get(SchedulerRegistry);

      await app!.close();

      expect(registry.getCronJobs().size).toBe(0);
      expect(jest.getTimerCount()).toBe(0);
    });

    it("should return true for dynamic cron job", async () => {
      const service: CronService = app!.get(CronService);
      await app!.init();

      service.addCronJob();
      expect(service.doesExist("dynamic")).toEqual(true);
    });

    it("should return false for dynamic cron job", async () => {
      const service: CronService = app!.get(CronService);
      await app!.init();
      expect(service.doesExist("dynamic")).toEqual(false);
    });

    it('should not execute "cron" before initialDelay elapses', async () => {
      const service = app!.get(CronService);
      await app!.init();
      const registry = app!.get(SchedulerRegistry);
      deleteAllRegisteredJobsExceptOne(registry, "INITIAL_DELAY");

      // Job should not have fired yet
      jest.advanceTimersByTime(4999);
      expect(service.initialDelayCalls).toEqual(0);

      // After initialDelay (5000ms) the cron starts; one tick at t=6000ms
      jest.advanceTimersByTime(1001);
      expect(service.initialDelayCalls).toEqual(1);
    });

    it('should execute "cron" on schedule after initialDelay', async () => {
      const service = app!.get(CronService);
      await app!.init();
      const registry = app!.get(SchedulerRegistry);
      deleteAllRegisteredJobsExceptOne(registry, "INITIAL_DELAY");

      // No ticks before the delay
      jest.advanceTimersByTime(5000);
      // Cron fires every second; advance 3 more seconds
      jest.advanceTimersByTime(3000);
      expect(service.initialDelayCalls).toEqual(3);
    });

    itAdapted(
      "ADR-001",
      'should not start "cron" when both disabled and initialDelay are set',
      async () => {
        const service = app!.get(CronService);
        await app!.init();
        const registry = app!.get(SchedulerRegistry);

        expect(
          registry.getCronJob("DISABLED_WITH_INITIAL_DELAY").isRunning(),
        ).toBeFalsy();

        jest.advanceTimersByTime(5000);
        expect(service.initialDelayCalls).toEqual(0);
        expect(
          registry.getCronJob("DISABLED_WITH_INITIAL_DELAY").isRunning(),
        ).toBeFalsy();
      },
      "native CronJob.isRunning()",
    );

    it('should not start "cron" after shutdown when initialDelay is pending', async () => {
      const service = app!.get(CronService);
      await app!.init();

      // Close the app before the 5s delay elapses
      jest.advanceTimersByTime(2000);
      await app!.close();

      // Advance past the original delay — timeout must have been cleared
      jest.advanceTimersByTime(5000);
      expect(service.initialDelayCalls).toEqual(0);
    });

    it(`should not log a warning when the provider is not request scoped`, async () => {
      const logger = {
        log: mock(() => {}),
        error: mock(() => {}),
        warn: mock(() => {}),
      };
      Logger.overrideLogger(logger);
      spyOn(logger, "warn");

      await app!.init();

      expect(logger.warn).not.toHaveBeenCalled();
    });

    it.each(["__proto__", "constructor", "toString"])(
      "should run and clean up a cron named %s",
      async (name) => {
        await app!.close();
        const onTick = mock(() => {});

        @Injectable()
        class NamedService {
          @Cron(CronExpression.EVERY_SECOND, { name })
          handleTick() {
            onTick();
          }
        }

        const module = await Test.createTestingModule({
          imports: [ScheduleModule.forRoot()],
          providers: [NamedService],
        }).compile();
        const instance = module.createNestApplication();
        app = instance;
        await instance.init();

        const registry = instance.get(SchedulerRegistry);
        expect(registry.getCronJob(name)).toBeDefined();
        await advanceTimersByTimeAsync(1000);
        expect(onTick).toHaveBeenCalledTimes(1);

        await instance.close();
        expect(registry.doesExist("cron", name)).toBe(false);
        expect(jest.getTimerCount()).toBe(0);
        await advanceTimersByTimeAsync(1000);
        expect(onTick).toHaveBeenCalledTimes(1);
      },
    );

    it.each(["shared", "__proto__"])(
      "should reject duplicate cron name %s",
      async (name) => {
        @Injectable()
        class FirstService {
          @Cron(CronExpression.EVERY_SECOND, { name })
          handleCron() {}
        }

        @Injectable()
        class SecondService {
          @Cron(CronExpression.EVERY_SECOND, { name })
          handleCron() {}
        }

        const module = await Test.createTestingModule({
          imports: [ScheduleModule.forRoot()],
          providers: [FirstService, SecondService],
        }).compile();

        const dupApp = module.createNestApplication();
        try {
          await expect(dupApp.init()).rejects.toThrow(
            DUPLICATE_SCHEDULER("Cron Job", name),
          );
        } finally {
          await dupApp.close();
        }
      },
    );
  },
);

describeConformance(
  "Cron - Request Scoped Provider",
  {
    upstreamPath: "nestjs/schedule/tests/e2e/cron-jobs.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
  },
  () => {
    let app: BunestApplication | undefined;

    beforeEach(async () => {
      const module = await Test.createTestingModule({
        imports: [SchedulerAppModule.registerRequestScopedCron()],
      }).compile();

      app = module.createNestApplication();
      jest.useFakeTimers({ now: 1577836800000 });
    });

    afterEach(async () => {
      Logger.overrideLogger(true);
      await app?.close();
      app = undefined;
      jest.useRealTimers();
    });

    it(`should log a warning when trying to register a cron in a request scoped provider`, async () => {
      const logger = {
        log: mock(() => {}),
        error: mock(() => {}),
        warn: mock(() => {}),
      };
      Logger.overrideLogger(logger);
      spyOn(logger, "warn");

      await app!.init();
      const registry = app!.get(SchedulerRegistry);

      expect(registry.getCronJobs()).toEqual(new Map());
      expect(logger.warn).toHaveBeenCalledWith(
        'Cannot register cron job "RequestScopedCronService@handleCron" because it is defined in a non static provider.',
        "Scheduler",
      );
    });
  },
);
