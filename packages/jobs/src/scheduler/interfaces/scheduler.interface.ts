import type {
  FactoryDependency,
  InjectionToken,
  ModuleImport,
  Type,
} from "@bunest/core";
import type {
  CronLockOptions,
  SchedulerLockDriver,
  SchedulerLockOptions,
} from "../scheduler-lock";

export type CronTime = string | Date;

export type CronOptions = {
  /**
   * Unique name used to register and look up the job in `SchedulerRegistry`.
   */
  name?: string;
  /**
   * IANA time zone identifier (e.g. `"UTC"`, `"America/New_York"`, `"Asia/Ho_Chi_Minh"`).
   * Mutually exclusive with `utcOffset`.
   */
  timeZone?: string;
  /**
   * Fixed UTC offset in hours (when `|utcOffset| < 16`, e.g. `-5`, `2`) or minutes
   * (e.g. `-300`, `330`). Mutually exclusive with `timeZone`.
   */
  utcOffset?: number;
  /**
   * Unrefs the underlying timer so it does not keep the event loop alive.
   * Matches `@nestjs/schedule` `unrefTimeout`. Defaults to `unref ?? true`.
   */
  unrefTimeout?: boolean;
  /**
   * When true, skips overlapping ticks while a previous async invocation is still running.
   * @default false
   */
  waitForCompletion?: boolean;
  /**
   * When true, registers the job without starting it automatically.
   * @default false
   */
  disabled?: boolean;
  /**
   * Threshold in ms to control whether missed execution deadlines execute
   * immediately or are skipped with a warning.
   * @default 250
   */
  threshold?: number;
  /**
   * Delay in milliseconds before starting the cron job after application bootstrap.
   */
  initialDelay?: number;
  /**
   * Bunest alias for `unrefTimeout`. Unrefs the underlying timer so it never prevents graceful process exit.
   * @default true
   */
  unref?: boolean;
  /**
   * Optional error hook invoked when a job tick throws/rejects.
   */
  onError?: (error: unknown, jobName: string) => void;
  /**
   * Optional completion hook invoked when the cron job is stopped.
   */
  onComplete?: () => unknown | Promise<unknown>;
  /**
   * Optional distributed lock configuration for multi-replica cluster safety
   * (`"skip"` per-tick locking or `"leader"` lease election).
   * Pass `false` to explicitly opt out of `ScheduleModuleOptions.defaultLock`.
   */
  lock?: CronLockOptions | false;
  /**
   * Optional explicit lock driver overriding the module-level `SCHEDULER_LOCK_DRIVER`.
   */
  lockDriver?: SchedulerLockDriver;
};

export interface IntervalOptions {
  name?: string;
  waitForCompletion?: boolean;
  unref?: boolean;
  onError?: (error: unknown, name: string) => void;
}

export interface TimeoutOptions {
  name?: string;
  unref?: boolean;
  onError?: (error: unknown, name: string) => void;
}

export interface CronMetadata {
  readonly expression: CronTime;
  readonly methodName: string | symbol;
  readonly options: CronOptions;
}

export interface IntervalMetadata {
  readonly timeoutMs: number;
  readonly methodName: string | symbol;
  readonly options: IntervalOptions;
}

export interface TimeoutMetadata {
  readonly timeoutMs: number;
  readonly methodName: string | symbol;
  readonly options: TimeoutOptions;
}

export interface ParsedCronExpression {
  readonly expression: string;
  readonly hasSeconds: boolean;
  readonly seconds: readonly number[];
  readonly minutes: readonly number[];
  readonly hours: readonly number[];
  readonly daysOfMonth: readonly number[];
  readonly months: readonly number[];
  readonly daysOfWeek: readonly number[];
  readonly dayOfMonthWildcard: boolean;
  readonly dayOfWeekWildcard: boolean;
}

export interface ScheduleModuleOptions {
  /**
   * Registers ScheduleModule globally across all modules.
   * @default true
   */
  global?: boolean;
  /**
   * Enables automatic discovery & registration of `@Cron()` handlers.
   * @default true
   */
  cronJobs?: boolean;
  /**
   * Enables automatic discovery & registration of `@Interval()` handlers.
   * @default true
   */
  intervals?: boolean;
  /**
   * Enables automatic discovery & registration of `@Timeout()` handlers.
   * @default true
   */
  timeouts?: boolean;
  /**
   * Distributed lock driver registered under `SCHEDULER_LOCK_DRIVER` and used by
   * `@Cron(..., { lock: ... })` jobs. Defaults to `InMemorySchedulerLockDriver`.
   */
  lockDriver?: SchedulerLockDriver;
  /**
   * Cluster-wide default distributed lock applied automatically to every `@Cron()`
   * handler unless the handler opts out via `@Cron(expr, { lock: false })` or
   * overrides with its own `lock: { ... }`.
   */
  defaultLock?: SchedulerLockOptions | false;
}

export interface ScheduleModuleOptionsFactory {
  createScheduleOptions():
    Promise<ScheduleModuleOptions> | ScheduleModuleOptions;
}

export interface ScheduleModuleAsyncOptions {
  /**
   * Registers ScheduleModule globally across all modules.
   * @default true
   */
  global?: boolean;
  imports?: ModuleImport[];
  useExisting?: InjectionToken<ScheduleModuleOptionsFactory>;
  useClass?: Type<ScheduleModuleOptionsFactory>;
  useFactory?: (
    ...args: any[]
  ) => Promise<ScheduleModuleOptions> | ScheduleModuleOptions;
  inject?: FactoryDependency[];
}
