import "reflect-metadata";
import { afterEach, expect, it } from "bun:test";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  ScheduleModule,
  SchedulerRegistry,
} from "../../../../../packages/scheduler/src";
import { Test, describeConformance } from "../../../_helpers";
import { CronService } from "../_fixtures/scheduler-fixtures";

describeConformance(
  "Async Configuration",
  {
    upstreamPath: "nestjs/schedule/tests/e2e/async-config.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    let app: BunestApplication | undefined;

    afterEach(async () => {
      await app?.close();
      app = undefined;
    });

    it("should provide options using useFactory", async () => {
      const module = await Test.createTestingModule({
        imports: [
          ScheduleModule.forRootAsync({
            useFactory: () => ({
              cronJobs: false,
            }),
          }),
        ],
        providers: [CronService],
      }).compile();

      const instance = module.createNestApplication();
      app = instance;
      await instance.init();

      const registry = instance.get(SchedulerRegistry);
      expect(registry.doesExist("cron", "EXECUTES_EVERY_SECOND")).toBeFalsy();
    });

    it("should enable cron jobs by default when using async config", async () => {
      const module = await Test.createTestingModule({
        imports: [
          ScheduleModule.forRootAsync({
            useFactory: () => ({}),
          }),
        ],
        providers: [CronService],
      }).compile();

      const instance = module.createNestApplication();
      app = instance;
      await instance.init();

      const registry = instance.get(SchedulerRegistry);
      expect(registry.doesExist("cron", "EXECUTES_EVERY_SECOND")).toBeTruthy();
    });

    it("should provide options using useClass", async () => {
      class ConfigService {
        createScheduleOptions() {
          return {
            cronJobs: false,
          };
        }
      }

      const module = await Test.createTestingModule({
        imports: [
          ScheduleModule.forRootAsync({
            useClass: ConfigService,
          }),
        ],
        providers: [CronService],
      }).compile();

      const instance = module.createNestApplication();
      app = instance;
      await instance.init();

      const registry = instance.get(SchedulerRegistry);
      expect(registry.doesExist("cron", "EXECUTES_EVERY_SECOND")).toBeFalsy();
    });
  },
);
