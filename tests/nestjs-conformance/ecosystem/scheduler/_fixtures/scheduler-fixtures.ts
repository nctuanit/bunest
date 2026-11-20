import "reflect-metadata";
import { jest } from "bun:test";
import {
  Injectable,
  Module,
  Scope,
  type DynamicModule,
  type Provider,
} from "../../../../../packages/common/src";
import {
  Cron,
  CronExpression,
  CronJob,
  Interval,
  ScheduleModule,
  SchedulerRegistry,
  Timeout,
  type ScheduleModuleOptions,
} from "../../../../../packages/scheduler/src";

export const DUPLICATE_SCHEDULER = (schedulerName: string, name: string) =>
  `${schedulerName} with the given name (${name}) already exists. Ignored.`;

export const nullPrototypeObjectProvider: Provider = {
  provide: "NULL_PROTOTYPE_OBJECT",
  useValue: Object.create(null),
};

export async function flushMicrotasks(ticks = 6): Promise<void> {
  for (let i = 0; i < ticks; i += 1) {
    await Promise.resolve();
  }
}

export async function advanceTimersByTimeAsync(ms: number): Promise<void> {
  jest.advanceTimersByTime(ms);
  await flushMicrotasks();
}

export async function runAllTimersAsync(maxRounds = 12): Promise<void> {
  for (let i = 0; i < maxRounds; i += 1) {
    await flushMicrotasks();
    if (jest.getTimerCount() === 0) {
      break;
    }
    jest.runOnlyPendingTimers();
    await flushMicrotasks();
  }
}

@Injectable()
export class CronService {
  callsCount = 0;
  callsFinishedCount = 0;
  dynamicCallsCount = 0;
  initialDelayCalls = 0;

  constructor(private readonly schedulerRegistry: SchedulerRegistry) {}

  @Cron(CronExpression.EVERY_SECOND, {
    name: "EXECUTES_EVERY_SECOND",
    utcOffset: 0,
  })
  handleCron() {
    ++this.callsCount;
    if (this.callsCount > 2) {
      const ref = this.schedulerRegistry.getCronJob("EXECUTES_EVERY_SECOND");
      ref.stop();
    }
  }

  @Cron(CronExpression.EVERY_30_SECONDS, {
    name: "EXECUTES_EVERY_30_SECONDS",
    utcOffset: 0,
  })
  handleCronEvery30Seconds() {
    ++this.callsCount;
    if (this.callsCount === 1) {
      const ref = this.schedulerRegistry.getCronJob(
        "EXECUTES_EVERY_30_SECONDS",
      );
      ref.stop();
    }
  }

  @Cron(CronExpression.EVERY_MINUTE, {
    name: "EXECUTES_EVERY_MINUTE",
    utcOffset: 0,
  })
  handleCronEveryMinute() {
    ++this.callsCount;
    if (this.callsCount > 2) {
      const ref = this.schedulerRegistry.getCronJob("EXECUTES_EVERY_MINUTE");
      ref.stop();
    }
  }

  @Cron(CronExpression.EVERY_HOUR, {
    name: "EXECUTES_EVERY_HOUR",
    utcOffset: 0,
  })
  handleCronEveryHour() {
    ++this.callsCount;
    if (this.callsCount > 2) {
      const ref = this.schedulerRegistry.getCronJob("EXECUTES_EVERY_HOUR");
      ref.stop();
    }
  }

  @Cron(CronExpression.EVERY_30_SECONDS, {
    name: "DISABLED",
    disabled: true,
    utcOffset: 0,
  })
  handleDisabledCron() {}

  @Cron(CronExpression.EVERY_SECOND, {
    name: "INITIAL_DELAY",
    initialDelay: 5000,
    utcOffset: 0,
  })
  handleCronWithInitialDelay() {
    ++this.initialDelayCalls;
  }

  @Cron(CronExpression.EVERY_SECOND, {
    name: "DISABLED_WITH_INITIAL_DELAY",
    disabled: true,
    initialDelay: 1000,
    utcOffset: 0,
  })
  handleDisabledCronWithInitialDelay() {
    ++this.initialDelayCalls;
  }

  addCronJob(): CronJob {
    const job = new CronJob(CronExpression.EVERY_SECOND, () => {
      ++this.dynamicCallsCount;
      if (this.dynamicCallsCount > 2) {
        const ref = this.schedulerRegistry.getCronJob("dynamic");
        ref.stop();
      }
    });
    this.schedulerRegistry.addCronJob("dynamic", job);
    return job;
  }

  @Cron(CronExpression.EVERY_MINUTE, {
    name: "WAIT_FOR_COMPLETION",
    waitForCompletion: true,
    utcOffset: 0,
  })
  async handleLongRunningCron() {
    ++this.callsCount;
    await new Promise((r) => setTimeout(r, 61 * 1000));
    ++this.callsFinishedCount;

    if (this.callsCount > 2) {
      const ref = this.schedulerRegistry.getCronJob("WAIT_FOR_COMPLETION");
      ref.stop();
    }
  }

  doesExist(name: string): boolean {
    return this.schedulerRegistry.doesExist("cron", name);
  }
}

@Injectable()
export class IntervalService {
  called = false;
  calledDynamic = false;

  constructor(private readonly schedulerRegistry: SchedulerRegistry) {}

  @Interval("test", 2500)
  handleInterval() {
    this.called = true;
    clearInterval(this.schedulerRegistry.getInterval("test"));
  }

  addInterval() {
    const intervalRef = setInterval(() => {
      this.calledDynamic = true;
      clearInterval(this.schedulerRegistry.getInterval("dynamic"));
    }, 2500);

    this.schedulerRegistry.addInterval("dynamic", intervalRef);
  }

  doesExist(name: string): boolean {
    return this.schedulerRegistry.doesExist("interval", name);
  }
}

@Injectable()
export class TimeoutService {
  called = false;
  calledDynamic = false;

  constructor(private readonly schedulerRegistry: SchedulerRegistry) {}

  @Timeout("test", 2500)
  handleTimeout() {
    this.called = true;
  }

  addTimeout() {
    const timeoutRef = setTimeout(() => {
      this.calledDynamic = true;
      clearTimeout(this.schedulerRegistry.getTimeout("dynamic"));
    }, 2500);

    this.schedulerRegistry.addTimeout("dynamic", timeoutRef);
  }

  doesExist(name: string): boolean {
    return this.schedulerRegistry.doesExist("timeout", name);
  }
}

@Injectable({ scope: Scope.REQUEST })
export class RequestScopedCronService {
  @Cron(CronExpression.EVERY_MINUTE)
  handleCron() {}
}

@Injectable({ scope: Scope.REQUEST })
export class RequestScopedIntervalService {
  @Interval("test", 2500)
  handleInterval() {}
}

@Injectable({ scope: Scope.REQUEST })
export class RequestScopedTimeoutService {
  @Timeout("test", 2500)
  handleTimeout() {}
}

@Module({})
export class SchedulerAppModule {
  static registerTimeout(
    scheduleModuleOptions?: ScheduleModuleOptions,
  ): DynamicModule {
    return {
      module: SchedulerAppModule,
      imports: [ScheduleModule.forRoot(scheduleModuleOptions)],
      providers: [TimeoutService],
    };
  }

  static registerRequestScopedTimeout(
    scheduleModuleOptions?: ScheduleModuleOptions,
  ): DynamicModule {
    return {
      module: SchedulerAppModule,
      imports: [ScheduleModule.forRoot(scheduleModuleOptions)],
      providers: [RequestScopedTimeoutService],
    };
  }

  static registerInterval(
    scheduleModuleOptions?: ScheduleModuleOptions,
  ): DynamicModule {
    return {
      module: SchedulerAppModule,
      imports: [ScheduleModule.forRoot(scheduleModuleOptions)],
      providers: [IntervalService],
    };
  }

  static registerRequestScopedInterval(
    scheduleModuleOptions?: ScheduleModuleOptions,
  ): DynamicModule {
    return {
      module: SchedulerAppModule,
      imports: [ScheduleModule.forRoot(scheduleModuleOptions)],
      providers: [RequestScopedIntervalService],
    };
  }

  static registerCron(
    scheduleModuleOptions?: ScheduleModuleOptions,
  ): DynamicModule {
    return {
      module: SchedulerAppModule,
      imports: [ScheduleModule.forRoot(scheduleModuleOptions)],
      providers: [CronService],
    };
  }

  static registerRequestScopedCron(
    scheduleModuleOptions?: ScheduleModuleOptions,
  ): DynamicModule {
    return {
      module: SchedulerAppModule,
      imports: [ScheduleModule.forRoot(scheduleModuleOptions)],
      providers: [RequestScopedCronService],
    };
  }
}
