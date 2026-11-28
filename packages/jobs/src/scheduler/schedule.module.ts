import { Module, type DynamicModule, type Provider } from "@bunest/core";
import { OS_CRON_ADAPTER, SCHEDULE_MODULE_OPTIONS } from "./constants";
import type {
  ScheduleModuleAsyncOptions,
  ScheduleModuleOptions,
  ScheduleModuleOptionsFactory,
} from "./interfaces/scheduler.interface";
import { createDefaultOsCronAdapter, OsCronService } from "./os-cron";
import {
  InMemorySchedulerLockDriver,
  SCHEDULER_LOCK_DRIVER,
} from "./scheduler-lock";
import { SchedulerExplorer } from "./scheduler.explorer";
import { SchedulerRegistry } from "./scheduler.registry";

function withDefaultScheduleOptions(
  options?: ScheduleModuleOptions,
): ScheduleModuleOptions {
  return {
    cronJobs: true,
    intervals: true,
    timeouts: true,
    ...options,
  };
}

@Module({})
export class ScheduleModule {
  static forRoot(options: ScheduleModuleOptions = {}): DynamicModule {
    const resolvedOptions = withDefaultScheduleOptions(options);
    const lockDriver =
      resolvedOptions.lockDriver ?? new InMemorySchedulerLockDriver();
    const osCronAdapter =
      resolvedOptions.osCronAdapter ?? createDefaultOsCronAdapter();
    return {
      module: ScheduleModule,
      global: options.global ?? true,
      providers: [
        {
          provide: SCHEDULE_MODULE_OPTIONS,
          useValue: resolvedOptions,
        },
        {
          provide: SCHEDULER_LOCK_DRIVER,
          useValue: lockDriver,
        },
        {
          provide: OS_CRON_ADAPTER,
          useValue: osCronAdapter,
        },
        SchedulerRegistry,
        SchedulerExplorer,
        OsCronService,
      ],
      exports: [
        SCHEDULE_MODULE_OPTIONS,
        SCHEDULER_LOCK_DRIVER,
        OS_CRON_ADAPTER,
        SchedulerRegistry,
        OsCronService,
      ],
    };
  }

  static forRootAsync(options: ScheduleModuleAsyncOptions): DynamicModule {
    const asyncProviders = ScheduleModule.createAsyncProviders(options);
    return {
      module: ScheduleModule,
      global: options.global ?? true,
      imports: options.imports ?? [],
      providers: [
        ...asyncProviders,
        {
          provide: SCHEDULER_LOCK_DRIVER,
          useFactory: (opts: ScheduleModuleOptions) =>
            opts?.lockDriver ?? new InMemorySchedulerLockDriver(),
          inject: [SCHEDULE_MODULE_OPTIONS],
        },
        {
          provide: OS_CRON_ADAPTER,
          useFactory: (opts: ScheduleModuleOptions) =>
            opts?.osCronAdapter ?? createDefaultOsCronAdapter(),
          inject: [SCHEDULE_MODULE_OPTIONS],
        },
        SchedulerRegistry,
        SchedulerExplorer,
        OsCronService,
      ],
      exports: [
        SCHEDULE_MODULE_OPTIONS,
        SCHEDULER_LOCK_DRIVER,
        OS_CRON_ADAPTER,
        SchedulerRegistry,
        OsCronService,
      ],
    };
  }

  private static createAsyncProviders(
    options: ScheduleModuleAsyncOptions,
  ): Provider[] {
    if (options.useFactory) {
      return [
        {
          provide: SCHEDULE_MODULE_OPTIONS,
          useFactory: async (...args: any[]) => {
            const config = await options.useFactory!(...args);
            return withDefaultScheduleOptions(config);
          },
          inject: options.inject ?? [],
        },
      ];
    }

    if (options.useClass) {
      return [
        {
          provide: options.useClass,
          useClass: options.useClass,
        },
        {
          provide: SCHEDULE_MODULE_OPTIONS,
          useFactory: async (factory: ScheduleModuleOptionsFactory) => {
            const config = await factory.createScheduleOptions();
            return withDefaultScheduleOptions(config);
          },
          inject: [options.useClass],
        },
      ];
    }

    if (options.useExisting) {
      return [
        {
          provide: SCHEDULE_MODULE_OPTIONS,
          useFactory: async (factory: ScheduleModuleOptionsFactory) => {
            const config = await factory.createScheduleOptions();
            return withDefaultScheduleOptions(config);
          },
          inject: [options.useExisting],
        },
      ];
    }

    throw new Error(
      "ScheduleModule.forRootAsync() requires one of useFactory, useClass, or useExisting.",
    );
  }
}
