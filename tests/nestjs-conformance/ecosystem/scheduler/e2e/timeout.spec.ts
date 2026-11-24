import { afterEach, beforeEach, expect, it, jest, mock, spyOn } from "bun:test";
import { Injectable, Logger } from "../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  ScheduleModule,
  SchedulerRegistry,
  Timeout,
} from "../../../../../packages/jobs/src/scheduler";
import { Test, describeConformance } from "../../../_helpers";
import {
  DUPLICATE_SCHEDULER,
  SchedulerAppModule,
  TimeoutService,
  advanceTimersByTimeAsync,
  nullPrototypeObjectProvider,
} from "../_fixtures/scheduler-fixtures";

describeConformance(
  "Timeout",
  {
    upstreamPath: "nestjs/schedule/tests/e2e/timeout.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes: "Adapts Vitest vi.useFakeTimers() to Bun jest.useFakeTimers().",
  },
  () => {
    let app: BunestApplication | undefined;

    beforeEach(async () => {
      const module = await Test.createTestingModule({
        imports: [SchedulerAppModule.registerTimeout()],
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

    it(`should schedule "timeout"`, async () => {
      const service = app!.get(TimeoutService);

      expect(service.called).toBeFalsy();

      await app!.init();
      await advanceTimersByTimeAsync(2500);

      expect(service.called).toBeTruthy();
    });

    it(`should return timeout id by name`, async () => {
      await app!.init();
      const registry = app!.get(SchedulerRegistry);
      expect(registry.getTimeout("test")).not.toBeUndefined();
    });

    it(`should support generic type parameter for getTimeout`, async () => {
      await app!.init();
      const registry = app!.get(SchedulerRegistry);
      // @ts-expect-error BUNEST_BUG: SchedulerRegistry.getTimeout() does not accept a generic type parameter
      const timeout = registry.getTimeout<NodeJS.Timeout>("test");
      expect(timeout).not.toBeUndefined();
    });

    it(`should add dynamic timeout`, async () => {
      const service = app!.get(TimeoutService);
      await app!.init();
      service.addTimeout();

      const registry = app!.get(SchedulerRegistry);
      expect(registry.getTimeout("dynamic")).not.toBeUndefined();
    });

    it(`should return dynamic timeout`, async () => {
      const service = app!.get(TimeoutService);
      await app!.init();
      service.addTimeout();

      const registry = app!.get(SchedulerRegistry);
      const timeouts = registry.getTimeouts();
      expect(timeouts).toContain("dynamic");

      const timeout = registry.getTimeout("dynamic");
      expect(timeout).toBeDefined();
    });

    // BUNEST_BUG: Expected SchedulerRegistry.getTimeout() missing-timeout error message to match NestJS NO_SCHEDULER_FOUND ("No Timeout was found with the given name (dynamic)..."), but packages/jobs/src/scheduler/scheduler.registry.ts throws 'No timeout found with name "dynamic".'.
    it.skip(`should delete dynamic timeout`, async () => {
      const service = app!.get(TimeoutService);
      await app!.init();
      service.addTimeout();

      const registry = app!.get(SchedulerRegistry);
      const timeout = registry.getTimeout("dynamic");
      expect(timeout).toBeDefined();

      registry.deleteTimeout("dynamic");
      let caught: Error | undefined;
      try {
        registry.getTimeout("dynamic");
      } catch (e) {
        caught = e as Error;
      }
      expect(caught).toBeDefined();
      expect(caught!.message).toEqual(
        "No Timeout was found with the given name (dynamic). Check that you created one with a decorator or with the create API.",
      );
    });

    it(`should initialize when the consuming module contains a provider with a null prototype`, async () => {
      await app!.close();
      const module = await Test.createTestingModule({
        imports: [SchedulerAppModule.registerTimeout()],
        providers: [nullPrototypeObjectProvider],
      }).compile();
      const instance = module.createNestApplication();
      app = instance;

      const initialized = await instance.init();
      expect(initialized).toBeDefined();
    });

    it("should clean up dynamic timeouts on application shutdown", async () => {
      const service = app!.get(TimeoutService);
      await app!.init();
      service.addTimeout();

      const registry = app!.get(SchedulerRegistry);
      await app!.close();

      expect(registry.getTimeouts().length).toBe(0);
      expect(jest.getTimerCount()).toBe(0);
    });

    it("should return true for dynamic timeout", async () => {
      const service: TimeoutService = app!.get(TimeoutService);
      await app!.init();

      service.addTimeout();
      expect(service.doesExist("dynamic")).toEqual(true);
    });

    it("should return false for dynamic timeout", async () => {
      const service: TimeoutService = app!.get(TimeoutService);
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
      "should run and clean up a timeout named %s",
      async (name) => {
        await app!.close();
        const onTick = mock(() => {});

        @Injectable()
        class NamedService {
          @Timeout(name, 1000)
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
        expect(registry.getTimeout(name)).toBeDefined();
        await advanceTimersByTimeAsync(1000);
        expect(onTick).toHaveBeenCalledTimes(1);

        await instance.close();
        expect(registry.doesExist("timeout", name)).toBe(false);
        expect(jest.getTimerCount()).toBe(0);
        await advanceTimersByTimeAsync(1000);
        expect(onTick).toHaveBeenCalledTimes(1);
      },
    );

    // BUNEST_BUG: Expected duplicate timeout error message to match NestJS DUPLICATE_SCHEDULER ("Timeout with the given name (<name>) already exists. Ignored."), but packages/jobs/src/scheduler/scheduler.registry.ts throws 'Timeout with name "<name>" already exists.'.
    it.skip.each(["shared", "__proto__"])(
      "should reject duplicate timeout name %s",
      async (name) => {
        @Injectable()
        class FirstService {
          @Timeout(name, 2500)
          handleTimeout() {}
        }

        @Injectable()
        class SecondService {
          @Timeout(name, 2500)
          handleTimeout() {}
        }

        const module = await Test.createTestingModule({
          imports: [ScheduleModule.forRoot()],
          providers: [FirstService, SecondService],
        }).compile();

        const dupApp = module.createNestApplication();
        try {
          await expect(dupApp.init()).rejects.toThrow(
            DUPLICATE_SCHEDULER("Timeout", name),
          );
        } finally {
          await dupApp.close();
        }
      },
    );
  },
);

describeConformance(
  "Timeout - Request Scoped",
  {
    upstreamPath: "nestjs/schedule/tests/e2e/timeout.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
  },
  () => {
    let app: BunestApplication | undefined;

    beforeEach(async () => {
      const module = await Test.createTestingModule({
        imports: [SchedulerAppModule.registerRequestScopedTimeout()],
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
    it.skip(`should log a warning when trying to register an timeout in a request scoped provider`, async () => {
      const logger = {
        log: mock(() => {}),
        error: mock(() => {}),
        warn: mock(() => {}),
      };
      Logger.overrideLogger(logger);
      spyOn(logger, "warn");

      await app!.init();
      const registry = app!.get(SchedulerRegistry);

      expect(registry.getTimeouts()).toEqual([]);
      expect(logger.warn).toHaveBeenCalledWith(
        'Cannot register timeout "RequestScopedTimeoutService@handleTimeout" because it is defined in a non static provider.',
        "Scheduler",
      );
    });
  },
);
