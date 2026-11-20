import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { Injectable, Module, Scope } from "@bunest/common";
import { BunestFactory } from "@bunest/core";
import {
  Cron,
  CronExpression,
  CronExpressionError,
  CronJob,
  Interval,
  ScheduleExplorer,
  ScheduleModule,
  SchedulerExplorer,
  SchedulerRegistry,
  Timeout,
  getNextCronDate,
  parseCronExpression,
  validateUtcOffset,
  type ScheduleModuleOptions,
  type ScheduleModuleOptionsFactory,
} from "../src";

describe("@bunest/scheduler", () => {
  describe("pure TypeScript cron parser & next-tick calculator", () => {
    it("parses 5-field and 6-field expressions, steps, ranges, wrap-around, named days/months, and presets", () => {
      const p5 = parseCronExpression("*/15 9-17 * JAN-MAR MON-FRI");
      expect(p5.hasSeconds).toBe(false);
      expect(p5.seconds).toEqual([0]);
      expect(p5.minutes).toEqual([0, 15, 30, 45]);
      expect(p5.hours).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
      expect(p5.months).toEqual([1, 2, 3]);
      expect(p5.daysOfWeek).toEqual([1, 2, 3, 4, 5]);

      const p6 = parseCronExpression("0,30 */10 22-2 * * FRI-MON");
      expect(p6.hasSeconds).toBe(true);
      expect(p6.seconds).toEqual([0, 30]);
      expect(p6.minutes).toEqual([0, 10, 20, 30, 40, 50]);
      // Wrap-around hours 22-2 -> 0, 1, 2, 22, 23
      expect(p6.hours).toEqual([0, 1, 2, 22, 23]);
      // Wrap-around days FRI-MON -> 0(SUN), 1(MON), 5(FRI), 6(SAT)
      expect(p6.daysOfWeek).toEqual([0, 1, 5, 6]);

      // Sunday as 7 and stepped range
      const sun = parseCronExpression("0 0 * * 5-7");
      expect(sun.daysOfWeek).toEqual([0, 5, 6]);

      // Presets & CronExpression enum
      expect(parseCronExpression("@yearly").months).toEqual([1]);
      expect(parseCronExpression("@yearly").daysOfMonth).toEqual([1]);
      expect(parseCronExpression("@monthly").daysOfMonth).toEqual([1]);
      expect(parseCronExpression("@weekly").daysOfWeek).toEqual([0]);
      expect(parseCronExpression("@daily").hours).toEqual([0]);
      expect(parseCronExpression("@hourly").minutes).toEqual([0]);
      expect(parseCronExpression("@every_second").seconds).toHaveLength(60);
      expect(parseCronExpression(CronExpression.EVERY_5_SECONDS).seconds).toEqual([
        0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55,
      ]);
    });

    it("computes accurate next dates including leap-year Feb 29 and UTC timeZone", () => {
      // Every 5 seconds in UTC
      const base = new Date("2026-06-15T10:00:02.500Z");
      const next5s = getNextCronDate("*/5 * * * * *", base, "UTC");
      expect(next5s.toISOString()).toBe("2026-06-15T10:00:05.000Z");

      // Wrap-around hours in UTC
      const beforeMidnight = new Date("2026-06-15T23:30:00.000Z");
      const nextWrap = getNextCronDate("0 22-2 * * *", beforeMidnight, "UTC");
      expect(nextWrap.toISOString()).toBe("2026-06-16T00:00:00.000Z");

      // Leap year Feb 29
      const nonLeap = new Date("2026-03-01T00:00:00.000Z");
      const nextLeap = getNextCronDate("0 0 29 2 *", nonLeap, "UTC");
      expect(nextLeap.toISOString()).toBe("2028-02-29T00:00:00.000Z");

      // Named weekdays MON-FRI at 09:00 UTC from Saturday 2026-06-13
      const saturday = new Date("2026-06-13T10:00:00.000Z");
      const nextMon = getNextCronDate(
        CronExpression.MONDAY_TO_FRIDAY_AT_9AM,
        saturday,
        "UTC",
      );
      expect(nextMon.toISOString()).toBe("2026-06-15T09:00:00.000Z");

      // DST fall-back (25-hour day: 2026-11-01 in America/New_York) & spring-forward (2026-03-08)
      const dstFallBack = new Date("2026-11-01T04:30:00.000Z"); // 00:30 EDT on Nov 1 (Sunday)
      const nextAfterFallBack = getNextCronDate(
        "0 9 * * MON",
        dstFallBack,
        "America/New_York",
      );
      // Monday Nov 2 09:00 EST === 14:00 UTC
      expect(nextAfterFallBack.toISOString()).toBe("2026-11-02T14:00:00.000Z");

      const dstSpringFwd = new Date("2026-03-08T05:30:00.000Z"); // 00:30 EST on Mar 8 (Sunday)
      const nextAfterSpring = getNextCronDate(
        "0 9 * * MON",
        dstSpringFwd,
        "America/New_York",
      );
      // Monday Mar 9 09:00 EDT === 13:00 UTC
      expect(nextAfterSpring.toISOString()).toBe("2026-03-09T13:00:00.000Z");

      // Same-day DST spring-forward hour jumps MUST NOT overshoot onto next day
      expect(
        getNextCronDate(
          "0 0 4 * * *",
          new Date("2026-03-08T05:00:00.000Z"),
          "America/New_York",
        ).toISOString(),
      ).toBe("2026-03-08T08:00:00.000Z");

      expect(
        getNextCronDate(
          "0 30 3 * * *",
          new Date("2026-03-08T06:00:00.000Z"),
          "America/New_York",
        ).toISOString(),
      ).toBe("2026-03-08T07:30:00.000Z");

      // Non-existent spring-forward hour (02:30 on Mar 8) advances cleanly to Mar 9 02:30 EDT (06:30 UTC)
      expect(
        getNextCronDate(
          "0 30 2 * * *",
          new Date("2026-03-08T06:00:00.000Z"),
          "America/New_York",
        ).toISOString(),
      ).toBe("2026-03-09T06:30:00.000Z");
    });

    it("fails fast on invalid cron expressions, impossible dates, and invalid timeZones", () => {
      for (const bad of [
        "",
        "* * *",
        "* * * * * * *",
        "60 * * * *",
        "0 24 * * *",
        "0 0 0 * *",
        "0 0 32 * *",
        "0 0 * 13 *",
        "0 0 * * 8",
        "*/0 * * * *",
        "0-5/0 * * * *",
        "abc * * * *",
        "1,,3 * * * *",
      ]) {
        expect(() => parseCronExpression(bad)).toThrow(CronExpressionError);
      }

      // Impossible date (Feb 30)
      expect(() =>
        getNextCronDate("0 0 30 2 *", new Date("2026-01-01T00:00:00Z"), "UTC"),
      ).toThrow(CronExpressionError);

      // Invalid timezone
      expect(() =>
        getNextCronDate("* * * * *", new Date(), "Mars/Olympus_Mons"),
      ).toThrow(CronExpressionError);
    });
  });

  describe("waitForCompletion overlap protection & dynamic SchedulerRegistry CRUD", () => {
    it("skips overlapping ticks when waitForCompletion is true", async () => {
      let concurrent = 0;
      let maxConcurrent = 0;
      let completed = 0;

      const job = new CronJob(
        CronExpression.EVERY_SECOND,
        async () => {
          concurrent += 1;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await Bun.sleep(40);
          concurrent -= 1;
          completed += 1;
        },
        { name: "slow-job", waitForCompletion: true },
      );

      // Fire 3 overlapping ticks back-to-back
      const p1 = job.fireOnce();
      const p2 = job.fireOnce();
      const p3 = job.fireOnce();
      await Promise.all([p1, p2, p3]);

      expect(maxConcurrent).toBe(1);
      expect(completed).toBe(1);
      expect(job.skippedTicks).toBe(2);
      expect(job.isInFlight()).toBe(false);

      // Next tick after completion executes normally
      await job.fireOnce();
      expect(completed).toBe(2);
    });

    it("manages dynamic cron jobs, intervals, and timeouts via SchedulerRegistry", async () => {
      const registry = new SchedulerRegistry();
      let cronHits = 0;
      const job = new CronJob(
        CronExpression.EVERY_MINUTE,
        () => {
          cronHits += 1;
        },
        { name: "dyn-cron" },
      );

      registry.addCronJob("dyn-cron", job);
      expect(registry.doesExist("cron", "dyn-cron")).toBe(true);
      expect(registry.getCronJob("dyn-cron")).toBe(job);
      expect(registry.getCronJobs().size).toBe(1);
      expect(() => registry.addCronJob("dyn-cron", job)).toThrow(/already exists/);

      await registry.getCronJob("dyn-cron").fireOnce();
      expect(cronHits).toBe(1);

      registry.deleteCronJob("dyn-cron");
      expect(registry.doesExist("cron", "dyn-cron")).toBe(false);
      expect(() => registry.getCronJob("dyn-cron")).toThrow(/No cron job/);

      let intervalHits = 0;
      registry.scheduleInterval("dyn-int", 15, () => {
        intervalHits += 1;
      });
      expect(registry.getIntervals()).toEqual(["dyn-int"]);
      await Bun.sleep(45);
      expect(intervalHits).toBeGreaterThanOrEqual(1);
      registry.deleteInterval("dyn-int");
      const frozenIntervalHits = intervalHits;
      await Bun.sleep(35);
      expect(intervalHits).toBe(frozenIntervalHits);

      let timeoutHit = false;
      registry.scheduleTimeout("dyn-to", 15, () => {
        timeoutHit = true;
      });
      expect(registry.getTimeouts()).toEqual(["dyn-to"]);
      await Bun.sleep(35);
      expect(timeoutHit).toBe(true);
      registry.deleteTimeout("dyn-to");
      expect(registry.getTimeouts()).toEqual([]);

      registry.onModuleDestroy();
    });
  });

  describe("ScheduleModule auto-discovery & graceful shutdown", () => {
    it("discovers @Cron, @Interval, and @Timeout methods and guarantees zero ticks fire after app.close()", async () => {
      let intervalCount = 0;
      let timeoutCount = 0;
      let cronCount = 0;
      let disabledCronCount = 0;

      @Injectable()
      class JobsService {
        @Interval("heartbeat", 20, { waitForCompletion: true })
        onHeartbeat() {
          intervalCount += 1;
        }

        @Timeout("startup-once", 15)
        onStartupOnce() {
          timeoutCount += 1;
        }

        @Cron(CronExpression.EVERY_SECOND, { name: "per-second-job" })
        onSecond() {
          cronCount += 1;
        }

        @Cron(CronExpression.EVERY_SECOND, {
          name: "disabled-job",
          disabled: true,
        })
        onDisabled() {
          disabledCronCount += 1;
        }
      }

      @Module({
        imports: [ScheduleModule.forRoot()],
        providers: [JobsService],
      })
      class AppModule {}

      const app = await BunestFactory.createApplicationContext(AppModule);
      const registry = app.get(SchedulerRegistry);

      expect(registry.doesExist("interval", "heartbeat")).toBe(true);
      expect(registry.doesExist("timeout", "startup-once")).toBe(true);
      expect(registry.doesExist("cron", "per-second-job")).toBe(true);
      expect(registry.getCronJob("per-second-job").isRunning()).toBe(true);
      expect(registry.getCronJob("disabled-job").isRunning()).toBe(false);

      await Bun.sleep(65);
      expect(intervalCount).toBeGreaterThanOrEqual(2);
      expect(timeoutCount).toBe(1);
      expect(disabledCronCount).toBe(0);

      // Trigger cron job explicitly too
      await registry.getCronJob("per-second-job").fireOnce();
      expect(cronCount).toBeGreaterThanOrEqual(1);

      // Graceful shutdown MUST stop every timer immediately
      await app.close();

      expect(registry.getCronJobs().size).toBe(0);
      expect(registry.getIntervals()).toEqual([]);
      expect(registry.getTimeouts()).toEqual([]);

      const countAtClose = intervalCount;
      const cronAtClose = cronCount;
      await Bun.sleep(80);
      expect(intervalCount).toBe(countAtClose);
      expect(cronCount).toBe(cronAtClose);
    });
  });

  describe("NestJS v12 parity: 83 CronExpressions, utcOffset, Date cronTime, initialDelay, threshold, ScheduleModule.forRootAsync, options flags & ScheduleExplorer", () => {
    it("exports all 83 CronExpression presets and parses/schedules every single one cleanly", () => {
      const entries = Object.entries(CronExpression);
      expect(entries.length).toBe(83);

      const base = new Date("2026-06-15T08:15:00.000Z"); // Monday
      for (const [, expr] of entries) {
        const parsed = parseCronExpression(expr);
        expect(parsed.expression.length).toBeGreaterThan(0);
        const next = getNextCronDate(parsed, base, "UTC");
        expect(next.getTime()).toBeGreaterThan(base.getTime());
      }

      // Spot-check newly added presets
      expect(
        getNextCronDate(
          CronExpression.EVERY_DAY_AT_5PM,
          base,
          "UTC",
        ).toISOString(),
      ).toBe("2026-06-15T17:00:00.000Z");
      expect(
        getNextCronDate(
          CronExpression.MONDAY_TO_FRIDAY_AT_09_30AM,
          base,
          "UTC",
        ).toISOString(),
      ).toBe("2026-06-15T09:30:00.000Z");
      expect(
        getNextCronDate(
          CronExpression.EVERY_1ST_DAY_OF_MONTH_AT_NOON,
          base,
          "UTC",
        ).toISOString(),
      ).toBe("2026-07-01T12:00:00.000Z");
      expect(
        getNextCronDate(
          CronExpression.EVERY_QUARTER,
          base,
          "UTC",
        ).toISOString(),
      ).toBe("2026-07-01T00:00:00.000Z");
      expect(
        getNextCronDate(
          CronExpression.EVERY_6_MONTHS,
          base,
          "UTC",
        ).toISOString(),
      ).toBe("2026-07-01T00:00:00.000Z");
    });

    it("supports fixed utcOffset, mutual exclusion with timeZone, Date one-shot schedules, unrefTimeout, and threshold", async () => {
      // utcOffset in hours (+2 -> 09:00 local === 07:00 UTC) and minutes (+330 -> UTC+5:30)
      const base = new Date("2026-06-15T06:00:00.000Z");
      expect(
        getNextCronDate("0 9 * * *", base, undefined, 2).toISOString(),
      ).toBe("2026-06-15T07:00:00.000Z");
      expect(
        getNextCronDate("0 12 * * *", base, undefined, 330).toISOString(),
      ).toBe("2026-06-15T06:30:00.000Z");
      expect(validateUtcOffset(-5)).toBe(-300);
      expect(validateUtcOffset(330)).toBe(330);
      expect(() => validateUtcOffset(1500)).toThrow(CronExpressionError);

      // timeZone + utcOffset together throws fast
      expect(
        () =>
          new CronJob("* * * * *", () => {}, {
            timeZone: "UTC",
            utcOffset: 2,
          }),
      ).toThrow(CronExpressionError);

      // Invalid Date throws fast
      expect(() => new CronJob(new Date("not-a-date"), () => {})).toThrow(
        CronExpressionError,
      );

      // One-shot future Date runs once and stops
      let oneShotRuns = 0;
      const futureDate = new Date(Date.now() + 35);
      const dateJob = new CronJob(
        futureDate,
        () => {
          oneShotRuns += 1;
        },
        { name: "oneshot-future", unrefTimeout: true, threshold: 500 },
      );
      expect(dateJob.unrefTimeout).toBe(true);
      expect(dateJob.nextDate().getTime()).toBe(futureDate.getTime());
      dateJob.start();
      await Bun.sleep(75);
      expect(oneShotRuns).toBe(1);
      expect(dateJob.isRunning()).toBe(false);

      // Past Date beyond threshold is skipped
      let skippedRuns = 0;
      const pastJob = new CronJob(
        new Date(Date.now() - 1000),
        () => {
          skippedRuns += 1;
        },
        { name: "oneshot-missed", threshold: 50 },
      );
      pastJob.start();
      await Bun.sleep(20);
      expect(skippedRuns).toBe(0);
      expect(pastJob.skippedTicks).toBe(1);
      expect(pastJob.isRunning()).toBe(false);
    });

    it("supports @Cron(Date), initialDelay (including deletion cancellation), and ScheduleModuleOptions feature toggles", async () => {
      let dateCronHits = 0;
      let intervalHits = 0;
      let timeoutHits = 0;
      const oneShotAt = new Date(Date.now() + 45);

      @Injectable()
      class ToggleAndDelayJobs {
        @Cron(oneShotAt, { name: "date-cron" })
        onDateCron() {
          dateCronHits += 1;
        }

        @Cron(CronExpression.EVERY_SECOND, {
          name: "delayed-cron",
          initialDelay: 60,
        })
        onDelayedCron() {}

        @Cron(CronExpression.EVERY_SECOND, {
          name: "cancelled-delayed-cron",
          initialDelay: 50,
        })
        onCancelledDelayedCron() {}

        @Interval("toggled-interval", 20)
        onInterval() {
          intervalHits += 1;
        }

        @Timeout("toggled-timeout", 15)
        onTimeout() {
          timeoutHits += 1;
        }
      }

      // Disable intervals & timeouts via ScheduleModule.forRoot options
      @Module({
        imports: [
          ScheduleModule.forRoot({
            cronJobs: true,
            intervals: false,
            timeouts: false,
          }),
        ],
        providers: [ToggleAndDelayJobs],
      })
      class AppModule {}

      const app = await BunestFactory.createApplicationContext(AppModule);
      try {
        const registry = app.get(SchedulerRegistry);
        expect(ScheduleExplorer).toBe(SchedulerExplorer);

        expect(registry.doesExist("cron", "date-cron")).toBe(true);
        expect(registry.doesExist("cron", "delayed-cron")).toBe(true);
        expect(registry.doesExist("interval", "toggled-interval")).toBe(false);
        expect(registry.doesExist("timeout", "toggled-timeout")).toBe(false);

        // Delayed jobs are registered but NOT running until initialDelay elapses
        expect(registry.getCronJob("delayed-cron").isRunning()).toBe(false);
        expect(registry.getCronJob("cancelled-delayed-cron").isRunning()).toBe(
          false,
        );

        // Deleting a delayed job before initialDelay prevents it from starting
        const cancelledRef = registry.getCronJob("cancelled-delayed-cron");
        registry.deleteCronJob("cancelled-delayed-cron");

        await Bun.sleep(90);
        expect(dateCronHits).toBe(1);
        expect(registry.getCronJob("delayed-cron").isRunning()).toBe(true);
        expect(cancelledRef.isRunning()).toBe(false);
        expect(intervalHits).toBe(0);
        expect(timeoutHits).toBe(0);
      } finally {
        await app.close();
      }
    });

    it("supports ScheduleModule.forRootAsync with useFactory, useClass, and useExisting plus non-static provider warning", async () => {
      @Injectable()
      class SampleJobs {
        @Cron(CronExpression.EVERY_HOUR, { name: "async-cron" })
        runCron() {}

        @Interval("async-int", 50)
        runInt() {}

        @Timeout("async-to", 50)
        runTo() {}
      }

      @Injectable({ scope: Scope.REQUEST })
      class NonStaticJobs {
        @Cron(CronExpression.EVERY_HOUR, { name: "ignored-non-static" })
        neverRegistered() {}
      }

      // 1. useFactory
      @Module({
        imports: [
          ScheduleModule.forRootAsync({
            useFactory: async () => {
              await Bun.sleep(1);
              return { cronJobs: false, intervals: true, timeouts: false };
            },
          }),
        ],
        providers: [SampleJobs, NonStaticJobs],
      })
      class FactoryApp {}

      const app1 = await BunestFactory.createApplicationContext(FactoryApp);
      try {
        const reg = app1.get(SchedulerRegistry);
        expect(reg.doesExist("cron", "async-cron")).toBe(false);
        expect(reg.doesExist("cron", "ignored-non-static")).toBe(false);
        expect(reg.doesExist("interval", "async-int")).toBe(true);
        expect(reg.doesExist("timeout", "async-to")).toBe(false);
      } finally {
        await app1.close();
      }

      // 2. useClass
      @Injectable()
      class ScheduleConfigClass implements ScheduleModuleOptionsFactory {
        createScheduleOptions(): ScheduleModuleOptions {
          return { cronJobs: true, intervals: false, timeouts: true };
        }
      }

      @Module({
        imports: [
          ScheduleModule.forRootAsync({
            useClass: ScheduleConfigClass,
          }),
        ],
        providers: [SampleJobs],
      })
      class ClassApp {}

      const app2 = await BunestFactory.createApplicationContext(ClassApp);
      try {
        const reg = app2.get(SchedulerRegistry);
        expect(reg.doesExist("cron", "async-cron")).toBe(true);
        expect(reg.doesExist("interval", "async-int")).toBe(false);
        expect(reg.doesExist("timeout", "async-to")).toBe(true);
      } finally {
        await app2.close();
      }

      // 3. useExisting
      @Injectable()
      class SharedScheduleConfig implements ScheduleModuleOptionsFactory {
        async createScheduleOptions(): Promise<ScheduleModuleOptions> {
          return { cronJobs: false, intervals: false, timeouts: true };
        }
      }

      @Module({
        providers: [SharedScheduleConfig],
        exports: [SharedScheduleConfig],
      })
      class ConfigModule {}

      @Module({
        imports: [
          ScheduleModule.forRootAsync({
            imports: [ConfigModule],
            useExisting: SharedScheduleConfig,
          }),
        ],
        providers: [SampleJobs],
      })
      class ExistingApp {}

      const app3 = await BunestFactory.createApplicationContext(ExistingApp);
      try {
        const reg = app3.get(SchedulerRegistry);
        expect(reg.doesExist("cron", "async-cron")).toBe(false);
        expect(reg.doesExist("interval", "async-int")).toBe(false);
        expect(reg.doesExist("timeout", "async-to")).toBe(true);
      } finally {
        await app3.close();
      }
    });
  });
});
