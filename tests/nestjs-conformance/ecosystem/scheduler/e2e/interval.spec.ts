import { afterEach, beforeEach, expect, it, jest, mock, spyOn } from "bun:test";
import { Injectable, Logger } from "../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  Interval,
  ScheduleModule,
  SchedulerRegistry,
} from "../../../../../packages/jobs/src/scheduler";
import { Test, describeConformance } from "../../../_helpers";
import {
  DUPLICATE_SCHEDULER,
  IntervalService,
  SchedulerAppModule,
  advanceTimersByTimeAsync,
  nullPrototypeObjectProvider,
} from "../_fixtures/scheduler-fixtures";

describeConformance(
  "Interval",
  {
    upstreamPath: "nestjs/schedule/tests/e2e/interval.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes: "Adapts Vitest vi.useFakeTimers() to Bun jest.useFakeTimers().",
  },
  () => {
    let app: BunestApplication | undefined;

    beforeEach(async () => {
      const module = await Test.createTestingModule({
        imports: [SchedulerAppModule.registerInterval()],
      }).compile();

      app = module.createNestApplication();
      jest.useFakeTimers();
    });

    afterEach(async () => {
      Logger.overrideLogger(true);
      await app?.close();
      app = undefined;
      jest.useRealTimers();
    });

    it(`should schedule "interval"`, async () => {
      const service = app!.get(IntervalService);

      expect(service.called).toBeFalsy();

      await app!.init();
      await advanceTimersByTimeAsync(2500);

      expect(service.called).toBeTruthy();
    });

    it(`should return interval id by name`, async () => {
      await app!.init();
      const registry = app!.get(SchedulerRegistry);
      expect(registry.getInterval("test")).not.toBeUndefined();
    });

    it(`should support generic type parameter for getInterval`, async () => {
      await app!.init();
      const registry = app!.get(SchedulerRegistry);
      // @ts-expect-error BUNEST_BUG: SchedulerRegistry.getInterval() does not accept a generic type parameter
      const interval = registry.getInterval<NodeJS.Timeout>("test");
      expect(interval).not.toBeUndefined();
    });

    it(`should add dynamic interval`, async () => {
      const service = app!.get(IntervalService);
      await app!.init();
      service.addInterval();
      const registry = app!.get(SchedulerRegistry);
      expect(registry.getInterval("dynamic")).not.toBeUndefined();
    });

    it(`should return dynamic interval`, async () => {
      const service = app!.get(IntervalService);
      await app!.init();
      service.addInterval();

      const registry = app!.get(SchedulerRegistry);
      const intervals = registry.getIntervals();
      expect(intervals).toContain("dynamic");

      const interval = registry.getInterval("dynamic");
      expect(interval).toBeDefined();
    });

    // BUNEST_BUG: Expected SchedulerRegistry.getInterval() missing-interval error message to match NestJS NO_SCHEDULER_FOUND ("No Interval was found with the given name (dynamic)..."), but packages/jobs/src/scheduler/scheduler.registry.ts throws 'No interval found with name "dynamic".'.
    it.skip(`should delete dynamic interval`, async () => {
      const service = app!.get(IntervalService);
      await app!.init();
      service.addInterval();

      const registry = app!.get(SchedulerRegistry);
      const interval = registry.getInterval("dynamic");
      expect(interval).toBeDefined();

      registry.deleteInterval("dynamic");
      let caught: Error | undefined;
      try {
        registry.getInterval("dynamic");
      } catch (e) {
        caught = e as Error;
      }
      expect(caught).toBeDefined();
      expect(caught!.message).toEqual(
        "No Interval was found with the given name (dynamic). Check that you created one with a decorator or with the create API.",
      );
    });

    it(`should initialize when the consuming module contains a provider with a null prototype`, async () => {
      await app!.close();
      const module = await Test.createTestingModule({
        imports: [SchedulerAppModule.registerInterval()],
        providers: [nullPrototypeObjectProvider],
      }).compile();
      const instance = module.createNestApplication();
      app = instance;

      const initialized = await instance.init();
      expect(initialized).toBeDefined();
    });

    it("should register a named interval once when the provider has a useExisting alias", async () => {
      await app!.close();

      @Injectable()
      class NamedService {
        @Interval("aliased", 1000)
        handleInterval() {}
      }

      const module = await Test.createTestingModule({
        imports: [ScheduleModule.forRoot()],
        providers: [
          NamedService,
          { provide: "ALIAS", useExisting: NamedService },
        ],
      }).compile();
      const instance = module.createNestApplication();
      app = instance;
      await instance.init();

      expect(instance.get(SchedulerRegistry).getIntervals()).toEqual([
        "aliased",
      ]);
    });

    it("should register an unnamed interval once when the provider has a useExisting alias", async () => {
      await app!.close();

      @Injectable()
      class UnnamedService {
        @Interval(1000)
        handleInterval() {}
      }

      const module = await Test.createTestingModule({
        imports: [ScheduleModule.forRoot()],
        providers: [
          UnnamedService,
          { provide: "ALIAS", useExisting: UnnamedService },
        ],
      }).compile();
      const instance = module.createNestApplication();
      app = instance;
      await instance.init();

      expect(instance.get(SchedulerRegistry).getIntervals()).toHaveLength(1);
    });

    it("should clean up dynamic intervals on application shutdown", async () => {
      const service = app!.get(IntervalService);
      await app!.init();
      service.addInterval();

      const registry = app!.get(SchedulerRegistry);

      await app!.close();

      expect(registry.getIntervals().length).toBe(0);
      expect(jest.getTimerCount()).toBe(0);
    });

    it("should return true for dynamic interval", async () => {
      const service: IntervalService = app!.get(IntervalService);
      await app!.init();

      service.addInterval();
      expect(service.doesExist("dynamic")).toEqual(true);
    });

    it("should return false for dynamic interval", async () => {
      const service: IntervalService = app!.get(IntervalService);
      await app!.init();
      expect(service.doesExist("dynamic")).toEqual(false);
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
      "should run and clean up an interval named %s",
      async (name) => {
        await app!.close();
        const onTick = mock(() => {});

        @Injectable()
        class NamedService {
          @Interval(name, 1000)
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
        expect(registry.getInterval(name)).toBeDefined();
        await advanceTimersByTimeAsync(1000);
        expect(onTick).toHaveBeenCalledTimes(1);

        await instance.close();
        expect(registry.doesExist("interval", name)).toBe(false);
        expect(jest.getTimerCount()).toBe(0);
        await advanceTimersByTimeAsync(1000);
        expect(onTick).toHaveBeenCalledTimes(1);
      },
    );

    // BUNEST_BUG: Expected duplicate interval error message to match NestJS DUPLICATE_SCHEDULER ("Interval with the given name (<name>) already exists. Ignored."), but packages/jobs/src/scheduler/scheduler.registry.ts throws 'Interval with name "<name>" already exists.'.
    it.skip.each(["shared", "__proto__"])(
      "should reject duplicate interval name %s",
      async (name) => {
        @Injectable()
        class FirstService {
          @Interval(name, 2500)
          handleInterval() {}
        }

        @Injectable()
        class SecondService {
          @Interval(name, 2500)
          handleInterval() {}
        }

        const module = await Test.createTestingModule({
          imports: [ScheduleModule.forRoot()],
          providers: [FirstService, SecondService],
        }).compile();

        const dupApp = module.createNestApplication();
        try {
          await expect(dupApp.init()).rejects.toThrow(
            DUPLICATE_SCHEDULER("Interval", name),
          );
        } finally {
          await dupApp.close();
        }
      },
    );
  },
);

describeConformance(
  "Interval - Request Scoped",
  {
    upstreamPath: "nestjs/schedule/tests/e2e/interval.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
  },
  () => {
    let app: BunestApplication | undefined;

    beforeEach(async () => {
      const module = await Test.createTestingModule({
        imports: [SchedulerAppModule.registerRequestScopedInterval()],
      }).compile();

      app = module.createNestApplication();
      jest.useFakeTimers();
    });

    afterEach(async () => {
      Logger.overrideLogger(true);
      await app?.close();
      app = undefined;
      jest.useRealTimers();
    });

    // BUNEST_BUG: Expected Logger.overrideLogger(logger) to intercept SchedulerExplorer instance logger warnings with context "Scheduler", but packages/core/src/common/logger/logger.ts instance methods ignore Logger.overrideLogger() and packages/jobs/src/scheduler/scheduler.explorer.ts uses context "SchedulerExplorer".
    it.skip(`should log a warning when trying to register an interval in a request scoped provider`, async () => {
      const logger = {
        log: mock(() => {}),
        error: mock(() => {}),
        warn: mock(() => {}),
      };
      Logger.overrideLogger(logger);
      spyOn(logger, "warn");

      await app!.init();
      const registry = app!.get(SchedulerRegistry);

      expect(registry.getIntervals()).toEqual([]);
      expect(logger.warn).toHaveBeenCalledWith(
        'Cannot register interval "RequestScopedIntervalService@handleInterval" because it is defined in a non static provider.',
        "Scheduler",
      );
    });
  },
);
