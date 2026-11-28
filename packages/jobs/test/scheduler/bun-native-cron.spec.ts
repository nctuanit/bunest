import { afterEach, describe, expect, it, jest, spyOn } from "bun:test";
import {
  BunestFactory,
  ClsModule,
  ClsService,
  Injectable,
  Module,
  type OnModuleDestroy,
} from "@bunest/core";
import {
  Cron,
  CronExpression,
  CronExpressionError,
  CronJob,
  OS_CRON_ADAPTER,
  OS_CRON_METADATA,
  OS_CRON_TITLE_PATTERN,
  OsCron,
  OsCronService,
  ScheduleModule,
  SchedulerRegistry,
  bootstrapCronApplication,
  createDefaultOsCronAdapter,
  defineOsCronJob,
  getNextCronDate,
  getNextCronDates,
  getOsCronMetadata,
  isNativeCronExpression,
  parseCronExpression,
  registerOsCronJob,
  removeOsCronJob,
  syncOsCronJobs,
  validateOsCronSchedule,
  validateOsCronTitle,
  type OsCronController,
  type OsCronRuntimeAdapter,
} from "../../src";

describe("Bun 1.4.5 Native Bun.cron Full Integration", () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe("Part 1: Bun.cron.parse fast-path (string + ParsedCronExpression + timeZone + presets + getNextCronDates)", () => {
    it("identifies native-compatible expressions and populates ParsedCronExpression.nativeExpression", () => {
      expect(isNativeCronExpression("*/15 9-17 * JAN-MAR MON-FRI")).toBe(true);
      expect(isNativeCronExpression("@hourly")).toBe(true);
      expect(isNativeCronExpression("@DAILY")).toBe(true);
      expect(isNativeCronExpression("@yearly")).toBe(true);
      expect(isNativeCronExpression("@every_minute")).toBe(true);

      expect(isNativeCronExpression(CronExpression.EVERY_SECOND)).toBe(false);
      expect(isNativeCronExpression("0 30 2 * * *")).toBe(false);
      expect(isNativeCronExpression("0 22-2 * * *")).toBe(false);
      expect(isNativeCronExpression("0 0 * * FRI-MON")).toBe(false);
      expect(isNativeCronExpression("@every_second")).toBe(false);
      expect(isNativeCronExpression("not a cron")).toBe(false);

      expect(parseCronExpression("*/5 * * * *").nativeExpression).toBe(
        "*/5 * * * *",
      );
      expect(parseCronExpression("@every_minute").nativeExpression).toBe(
        "* * * * *",
      );
      expect(parseCronExpression("@weekly").nativeExpression).toBe("@weekly");
      expect(parseCronExpression("0 22-2 * * *").nativeExpression).toBeUndefined();
      expect(parseCronExpression("*/5 * * * * *").nativeExpression).toBeUndefined();
    });

    it("routes both string and ParsedCronExpression inputs with IANA timeZone and utcOffset=0 through Bun.cron.parse", () => {
      const parseSpy = spyOn(Bun.cron, "parse");
      const base = new Date("2026-06-15T08:15:00.000Z");

      // 1. ParsedCronExpression with IANA timeZone (previously bypassed fast-path!)
      const parsed = parseCronExpression("30 9 * * MON-FRI");
      const nyNext = getNextCronDate(parsed, base, "America/New_York");
      expect(nyNext.toISOString()).toBe("2026-06-15T13:30:00.000Z");
      expect(parseSpy).toHaveBeenCalledWith("30 9 * * MON-FRI", base, {
        tz: "America/New_York",
      });

      // 2. Nickname with IANA timeZone
      const vnDaily = getNextCronDate("@daily", base, "Asia/Ho_Chi_Minh");
      expect(vnDaily.toISOString()).toBe("2026-06-15T17:00:00.000Z");

      // 3. utcOffset: 0 maps cleanly to { tz: "UTC" }
      const utcNext = getNextCronDate(parsed, base, undefined, 0);
      expect(utcNext.toISOString()).toBe("2026-06-15T09:30:00.000Z");
      expect(parseSpy).toHaveBeenCalledWith("30 9 * * MON-FRI", base, {
        tz: "UTC",
      });

      // 4. Local timezone via ParsedCronExpression
      const localNext = getNextCronDate(parsed, base);
      expect(localNext.getTime()).toBeGreaterThan(base.getTime());

      // 5. Impossible date fails fast with CronExpressionError
      expect(() =>
        getNextCronDate("0 0 30 2 *", base, "UTC"),
      ).toThrow(CronExpressionError);
    });

    it("computes chained upcoming dates with getNextCronDates and CronJob.nextDates", () => {
      const base = new Date("2026-06-15T08:15:00.000Z");
      const next3 = getNextCronDates("@hourly", 3, base, "UTC");
      expect(next3.map((d) => d.toISOString())).toEqual([
        "2026-06-15T09:00:00.000Z",
        "2026-06-15T10:00:00.000Z",
        "2026-06-15T11:00:00.000Z",
      ]);

      expect(getNextCronDates("@hourly", 0, base, "UTC")).toEqual([]);
      expect(() => getNextCronDates("@hourly", -1, base, "UTC")).toThrow(
        CronExpressionError,
      );
      expect(() => getNextCronDates("@hourly", 1.5, base, "UTC")).toThrow(
        CronExpressionError,
      );

      const job = new CronJob("0 9 * * MON-FRI", () => {}, {
        timeZone: "UTC",
      });
      expect(job.nextDates(2, base).map((d) => d.toISOString())).toEqual([
        "2026-06-15T09:00:00.000Z",
        "2026-06-16T09:00:00.000Z",
      ]);

      const oneShot = new CronJob(new Date("2026-06-15T09:00:00.000Z"), () => {});
      expect(oneShot.nextDates(3, base).map((d) => d.toISOString())).toEqual([
        "2026-06-15T09:00:00.000Z",
      ]);
      expect(
        oneShot.nextDates(3, new Date("2026-06-15T10:00:00.000Z")),
      ).toEqual([]);
    });
  });

  describe("Part 2: Native in-process Bun.cron(expr, handler, { tz }) engine in CronJob & ScheduleModule", () => {
    it("selects native vs timer engine automatically and enforces explicit engine overrides", () => {
      expect(new CronJob("*/5 * * * *", () => {}).engine).toBe("native");
      expect(
        new CronJob("@hourly", () => {}, { timeZone: "Asia/Ho_Chi_Minh" }).engine,
      ).toBe("native");
      expect(new CronJob("*/1 * * * *", () => {}, { utcOffset: 0 }).engine).toBe(
        "native",
      );

      // Automatic fallback to pure-TS timer engine
      expect(new CronJob(CronExpression.EVERY_SECOND, () => {}).engine).toBe(
        "timer",
      );
      expect(new CronJob("0 22-2 * * *", () => {}).engine).toBe("timer");
      expect(new CronJob("0 9 * * *", () => {}, { utcOffset: 2 }).engine).toBe(
        "timer",
      );
      expect(new CronJob(new Date(Date.now() + 60_000), () => {}).engine).toBe(
        "timer",
      );

      // Explicit timer override
      expect(
        new CronJob("*/5 * * * *", () => {}, { engine: "timer" }).engine,
      ).toBe("timer");

      // Explicit native override rejects incompatible schedules with actionable CronExpressionError
      expect(
        () =>
          new CronJob(CronExpression.EVERY_SECOND, () => {}, {
            engine: "native",
          }),
      ).toThrow(CronExpressionError);
      expect(
        () =>
          new CronJob("0 22-2 * * *", () => {}, {
            engine: "native",
          }),
      ).toThrow(CronExpressionError);
      expect(
        () =>
          new CronJob("0 9 * * *", () => {}, {
            utcOffset: 2,
            engine: "native",
          }),
      ).toThrow(CronExpressionError);
      expect(
        () =>
          new CronJob(new Date(Date.now() + 60_000), () => {}, {
            engine: "native",
          }),
      ).toThrow(CronExpressionError);
    });

    it("executes native Bun.cron ticks on schedule, handles errors, ref/unref, and Symbol.dispose", async () => {
      jest.useFakeTimers({ now: Date.UTC(2026, 5, 15, 10, 0, 0) });

      const firedAt: string[] = [];
      const errors: unknown[] = [];
      let completed = false;

      const job = new CronJob(
        "*/5 * * * *",
        () => {
          firedAt.push(new Date().toISOString());
          if (firedAt.length === 2) {
            throw new Error("tick-2-boom");
          }
        },
        {
          name: "native-5m",
          timeZone: "UTC",
          engine: "native",
          onError: (err) => errors.push(err),
          onComplete: () => {
            completed = true;
          },
        },
      );

      expect(job.engine).toBe("native");
      job.start();
      expect(job.ref()).toBe(job);
      expect(job.unref()).toBe(job);
      expect(job.isRunning()).toBe(true);
      expect(jest.getTimerCount()).toBe(1);

      jest.advanceTimersByTime(15 * 60_000);
      await Promise.resolve();

      expect(firedAt).toEqual([
        "2026-06-15T10:05:00.000Z",
        "2026-06-15T10:10:00.000Z",
        "2026-06-15T10:15:00.000Z",
      ]);
      expect(errors).toHaveLength(1);
      expect((errors[0] as Error).message).toBe("tick-2-boom");
      expect(job.lastDate()?.toISOString()).toBe("2026-06-15T10:15:00.000Z");

      // Disposable cleanup stops native Bun.cron handle cleanly
      job[Symbol.dispose]();
      expect(job.isRunning()).toBe(false);
      expect(completed).toBe(true);
      expect(jest.getTimerCount()).toBe(0);

      jest.advanceTimersByTime(15 * 60_000);
      expect(firedAt).toHaveLength(3);
    });

    it("throws CronExpressionError when starting a native CronJob with an impossible date", () => {
      const impossible = new CronJob("0 0 30 2 *", () => {}, {
        name: "feb-30",
        engine: "native",
      });
      expect(() => impossible.start()).toThrow(CronExpressionError);
      expect(impossible.isRunning()).toBe(false);
    });

    it("propagates ScheduleModuleOptions.defaultEngine and per-decorator engine overrides", async () => {
      @Injectable()
      class EngineJobs {
        @Cron("*/5 * * * *", { name: "uses-default", disabled: true })
        defaultJob() {}

        @Cron("*/5 * * * *", {
          name: "explicit-native",
          engine: "native",
          disabled: true,
        })
        nativeJob() {}
      }

      @Module({
        imports: [ScheduleModule.forRoot({ defaultEngine: "timer" })],
        providers: [EngineJobs],
      })
      class AppModule {}

      const app = await BunestFactory.createApplicationContext(AppModule);
      try {
        const registry = app.get(SchedulerRegistry);
        expect(registry.getCronJob("uses-default").engine).toBe("timer");
        expect(registry.getCronJob("explicit-native").engine).toBe("native");
      } finally {
        await app.close();
      }
    });
  });

  describe("Part 3: OS-level Bun.cron(path, schedule, title), Bun.cron.remove, defineOsCronJob, bootstrapCronApplication & OsCronService", () => {
    it("validates OS cron titles and schedules strictly", () => {
      expect(OS_CRON_TITLE_PATTERN.test("weekly-report_01")).toBe(true);
      expect(validateOsCronTitle("  weekly-report_01  ")).toBe(
        "weekly-report_01",
      );
      for (const badTitle of ["", "   ", "has space", "a/b", "a.b", "a;rm"]) {
        expect(() => validateOsCronTitle(badTitle)).toThrow(CronExpressionError);
      }

      expect(validateOsCronSchedule("30 2 * * MON")).toBe("30 2 * * MON");
      expect(validateOsCronSchedule("@daily")).toBe("@daily");
      expect(validateOsCronSchedule("@every_minute")).toBe("* * * * *");

      for (const badSched of [
        "*/5 * * * * *",
        "0 22-2 * * *",
        "0 0 30 2 *",
        "bad cron",
      ]) {
        expect(() => validateOsCronSchedule(badSched)).toThrow(
          CronExpressionError,
        );
      }
    });

    it("registers, removes, and syncs OS cron jobs via injectable adapter without mutating host OS", async () => {
      const registeredCalls: Array<{
        path: string;
        schedule: string;
        title: string;
      }> = [];
      const removedCalls: string[] = [];

      const mockAdapter: OsCronRuntimeAdapter = {
        async register(path, schedule, title) {
          registeredCalls.push({ path, schedule, title });
        },
        async remove(title) {
          removedCalls.push(title);
        },
      };

      const defaultAdapter = createDefaultOsCronAdapter();
      expect(typeof defaultAdapter.register).toBe("function");
      expect(typeof defaultAdapter.remove).toBe("function");

      const reg = await registerOsCronJob(
        {
          title: "weekly-report",
          schedule: "30 2 * * MON",
          path: "./jobs/weekly-report.cron.ts",
        },
        mockAdapter,
      );
      expect(reg).toEqual({
        title: "weekly-report",
        schedule: "30 2 * * MON",
        path: "./jobs/weekly-report.cron.ts",
      });
      expect(registeredCalls).toEqual([
        {
          path: "./jobs/weekly-report.cron.ts",
          schedule: "30 2 * * MON",
          title: "weekly-report",
        },
      ]);

      await removeOsCronJob("weekly-report", mockAdapter);
      expect(removedCalls).toEqual(["weekly-report"]);

      const syncRes = await syncOsCronJobs(
        [
          {
            title: "daily-cleanup",
            schedule: "@daily",
            path: "./jobs/cleanup.cron.ts",
          },
          {
            title: "hourly-ping",
            schedule: "@hourly",
            path: "./jobs/ping.cron.ts",
          },
        ],
        {
          removeTitles: ["legacy-job"],
          adapter: mockAdapter,
        },
      );
      expect(syncRes.removed).toEqual(["legacy-job"]);
      expect(syncRes.registered).toHaveLength(2);
      expect(removedCalls).toEqual(["weekly-report", "legacy-job"]);
      expect(registeredCalls).toHaveLength(3);

      // Fail-fast on duplicate titles before calling adapter
      const callsBefore = registeredCalls.length;
      await expect(
        syncOsCronJobs(
          [
            { title: "dup", schedule: "@daily", path: "./a.ts" },
            { title: "dup", schedule: "@hourly", path: "./b.ts" },
          ],
          { adapter: mockAdapter },
        ),
      ).rejects.toThrow(CronExpressionError);
      expect(registeredCalls.length).toBe(callsBefore);
    });

    it("defineOsCronJob exposes Cloudflare/Bun scheduled(controller) contract with error hooks", async () => {
      const received: OsCronController[] = [];
      const mod = defineOsCronJob(async (controller) => {
        received.push(controller);
      });

      const ctrl: OsCronController = {
        type: "scheduled",
        cron: "30 2 * * MON",
        scheduledTime: 1737340200000,
      };
      await mod.scheduled(ctrl);
      expect(received).toEqual([ctrl]);

      // Error handling with rethrow: false and rethrow: true (default)
      const seenErrors: string[] = [];
      const swallowed = defineOsCronJob(
        () => {
          throw new Error("soft-fail");
        },
        {
          rethrow: false,
          onError: (err) => {
            seenErrors.push((err as Error).message);
          },
        },
      );
      await swallowed.scheduled(ctrl);
      expect(seenErrors).toEqual(["soft-fail"]);

      const strict = defineOsCronJob(() => {
        throw new Error("hard-fail");
      });
      await expect(strict.scheduled(ctrl)).rejects.toThrow("hard-fail");
    });

    it("bootstrapCronApplication executes callback, provider/method, @Cron jobName, and @OsCron title with CLS & clean shutdown", async () => {
      const events: string[] = [];
      const clsSnapshots: Array<{
        requestId?: string;
        cron?: string;
        scheduledTime?: number;
      }> = [];
      let destroyedCount = 0;

      @Injectable()
      class ReportService implements OnModuleDestroy {
        constructor(private readonly cls: ClsService) {}

        onModuleDestroy() {
          destroyedCount += 1;
        }

        async runDirect(controller: OsCronController) {
          events.push(`direct:${controller.cron}`);
          clsSnapshots.push({
            requestId: this.cls.get<string>("requestId"),
            cron: this.cls.get<string>("cron"),
            scheduledTime: this.cls.get<number>("scheduledTime"),
          });
        }

        @Cron("@daily", { name: "daily-summary", disabled: true })
        async runDailySummary() {
          events.push("cron-job:daily-summary");
        }

        @OsCron("30 2 * * MON", {
          title: "weekly-os-report",
          path: "./jobs/weekly.cron.ts",
        })
        async runWeeklyOsReport(controller: OsCronController) {
          events.push(`os-cron:${controller.cron}`);
        }
      }

      expect(getOsCronMetadata(ReportService)).toHaveLength(1);
      expect<symbol>(OS_CRON_METADATA).toBe(
        Symbol.for("bunest:scheduler:os_cron"),
      );
      expect(() =>
        OsCron("@daily", { title: "invalid title!" }),
      ).toThrow(/alphanumeric/);

      @Module({
        imports: [ClsModule.forRoot({ global: true }), ScheduleModule.forRoot()],
        providers: [ReportService],
        exports: [ReportService],
      })
      class ReportAppModule {}

      const controller: OsCronController = {
        type: "scheduled",
        cron: "30 2 * * MON",
        scheduledTime: 1737340200000,
      };

      // 1. Callback mode
      const byCallback = bootstrapCronApplication(
        ReportAppModule,
        async (app, ctrl) => {
          await app.get(ReportService).runDirect(ctrl);
        },
      );
      await byCallback.scheduled(controller);

      // 2. Provider + method mode
      const byProvider = bootstrapCronApplication(ReportAppModule, {
        provider: ReportService,
        method: "runDirect",
      });
      await byProvider.scheduled(controller);

      // 3. @Cron jobName mode
      const byJobName = bootstrapCronApplication(ReportAppModule, {
        jobName: "daily-summary",
      });
      await byJobName.scheduled(controller);

      // 4. @OsCron title discovery mode
      const byOsTitle = bootstrapCronApplication(ReportAppModule, {
        osCronTitle: "weekly-os-report",
      });
      await byOsTitle.scheduled(controller);

      // 5. Cleanup still runs even when target throws
      const failing = bootstrapCronApplication(ReportAppModule, () => {
        throw new Error("boom-in-bootstrap");
      });
      await expect(failing.scheduled(controller)).rejects.toThrow(
        "boom-in-bootstrap",
      );

      expect(events).toEqual([
        "direct:30 2 * * MON",
        "direct:30 2 * * MON",
        "cron-job:daily-summary",
        "os-cron:30 2 * * MON",
      ]);
      expect(destroyedCount).toBe(5);
      expect(clsSnapshots).toHaveLength(2);
      expect(clsSnapshots[0]!.cron).toBe("30 2 * * MON");
      expect(clsSnapshots[0]!.scheduledTime).toBe(1737340200000);
      expect(clsSnapshots[0]!.requestId).toContain("os-cron:");
    });

    it("wires OsCronService in ScheduleModule.forRoot & forRootAsync with opt-in registerOsCronOnInit and @OsCron discovery", async () => {
      const calls: string[] = [];
      const adapter: OsCronRuntimeAdapter = {
        async register(path, schedule, title) {
          calls.push(`reg:${title}:${schedule}:${path}`);
        },
        async remove(title) {
          calls.push(`rm:${title}`);
        },
      };

      @Injectable()
      class BillingCronProvider {
        @OsCron("0 3 * * *", {
          title: "nightly-billing",
          path: "./jobs/billing.cron.ts",
        })
        runBilling() {}

        @OsCron("@hourly")
        runWithDefaultPath() {}
      }

      // Default registerOsCronOnInit = false does NOT mutate OS scheduler on boot
      @Module({
        imports: [
          ScheduleModule.forRoot({
            osCronAdapter: adapter,
            osCronJobs: [
              {
                title: "cfg-cleanup",
                schedule: "@daily",
                path: "./jobs/cleanup.cron.ts",
              },
            ],
          }),
        ],
        providers: [BillingCronProvider],
      })
      class PassiveModule {}

      const app1 = await BunestFactory.createApplicationContext(PassiveModule);
      try {
        expect(calls).toEqual([]);
        expect(app1.get(OS_CRON_ADAPTER)).toBe(adapter);
        const osCron = app1.get(OsCronService);

        // Discover @OsCron handlers (deterministically ordered by title)
        const discovered = osCron.discoverDecoratedJobs("./jobs/default.cron.ts");
        expect(discovered).toEqual([
          {
            title: "billing-cron-provider-run-with-default-path",
            schedule: "@hourly",
            path: "./jobs/default.cron.ts",
          },
          {
            title: "nightly-billing",
            schedule: "0 3 * * *",
            path: "./jobs/billing.cron.ts",
          },
        ]);

        // Explicit syncConfigured + remove + parseNext
        await osCron.syncConfigured();
        expect(osCron.getRegisteredJobs().has("cfg-cleanup")).toBe(true);
        await osCron.remove("cfg-cleanup");
        expect(osCron.getRegisteredJobs().has("cfg-cleanup")).toBe(false);
        expect(
          osCron
            .parseNext("@hourly", new Date("2026-06-15T10:15:00.000Z"), "UTC")
            .toISOString(),
        ).toBe("2026-06-15T11:00:00.000Z");

        // Preview helper
        const preview = osCron.preview(
          "@hourly",
          2,
          new Date("2026-06-15T10:15:00.000Z"),
          "UTC",
        );
        expect(preview.map((d) => d.toISOString())).toEqual([
          "2026-06-15T11:00:00.000Z",
          "2026-06-15T12:00:00.000Z",
        ]);
      } finally {
        await app1.close();
      }

      // Opt-in registerOsCronOnInit: true via forRootAsync
      calls.length = 0;
      @Module({
        imports: [
          ScheduleModule.forRootAsync({
            useFactory: async () => ({
              osCronAdapter: adapter,
              registerOsCronOnInit: true,
              osCronJobs: [
                {
                  title: "boot-sync-job",
                  schedule: "@weekly",
                  path: "./jobs/boot.cron.ts",
                },
              ],
            }),
          }),
        ],
      })
      class ActiveAsyncModule {}

      const app2 = await BunestFactory.createApplicationContext(ActiveAsyncModule);
      try {
        expect(calls).toEqual([
          "reg:boot-sync-job:@weekly:./jobs/boot.cron.ts",
        ]);
      } finally {
        await app2.close();
      }
    });
  });
});
