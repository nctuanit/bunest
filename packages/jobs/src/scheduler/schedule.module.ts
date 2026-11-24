import { Module, type DynamicModule, type Provider } from "@bunest/core";
import { SCHEDULE_MODULE_OPTIONS } from "./constants";
import type {
  ScheduleModuleAsyncOptions,
  ScheduleModuleOptions,
  ScheduleModuleOptionsFactory,
} from "./interfaces/scheduler.interface";
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
    return {
      module: ScheduleModule,
      global: options.global ?? true,
      providers: [
        {
          provide: SCHEDULE_MODULE_OPTIONS,
          useValue: resolvedOptions,
        },
        SchedulerRegistry,
        SchedulerExplorer,
      ],
      exports: [SCHEDULE_MODULE_OPTIONS, SchedulerRegistry],
    };
  }

  static forRootAsync(options: ScheduleModuleAsyncOptions): DynamicModule {
    const asyncProviders = ScheduleModule.createAsyncProviders(options);
    return {
      module: ScheduleModule,
      global: options.global ?? true,
      imports: options.imports ?? [],
      providers: [...asyncProviders, SchedulerRegistry, SchedulerExplorer],
      exports: [SCHEDULE_MODULE_OPTIONS, SchedulerRegistry],
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
