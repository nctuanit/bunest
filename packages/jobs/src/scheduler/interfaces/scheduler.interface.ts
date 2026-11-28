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

/**
 * Execution engine backing a `CronJob`:
 * - `"auto"` (default): uses native Bun 1.4.5 `Bun.cron(expr, cb, { tz })` for compatible
 *   5-field / nickname expressions (local timezone, IANA `timeZone`, or `utcOffset: 0`)
 *   and falls back seamlessly to the self-rescheduling timer engine for 6-field seconds,
 *   wrap-around ranges, one-shot `Date` schedules, and non-zero `utcOffset`.
 * - `"native"`: requires native `Bun.cron(expr, cb, { tz })` and throws `CronExpressionError`
 *   if the schedule cannot be executed natively.
 * - `"timer"`: always uses the pure-TS self-rescheduling `setTimeout` engine.
 */
export type CronEngine = "auto" | "native" | "timer";

/**
 * Controller object passed to OS-level `scheduled(controller)` handlers invoked by Bun
 * (compatible with Cloudflare Workers `ScheduledController` and `Bun.CronController`).
 */
export interface OsCronController {
  readonly type: "scheduled";
  readonly cron: string;
  readonly scheduledTime: number;
}

/**
 * Module default export contract expected by `Bun.cron(path, schedule, title)`.
 */
export interface OsCronModuleExport {
  scheduled(controller: OsCronController): unknown | Promise<unknown>;
}

/**
 * Handler callback for lightweight OS-level cron jobs (`defineOsCronJob`).
 */
export type OsCronHandler = (
  controller: OsCronController,
) => unknown | Promise<unknown>;

/**
 * Declarative registration descriptor for an OS-level cron job
 * (`crontab` on Linux, `launchd` on macOS, Task Scheduler on Windows).
 */
export interface OsCronJobDefinition {
  /**
   * Unique identifier (alphanumeric, hyphens, underscores only: `/^[A-Za-z0-9_-]+$/`).
   */
  readonly title: string;
  /**
   * 5-field cron expression or Bun nickname (`@yearly`, `@monthly`, `@weekly`, `@daily`, `@midnight`, `@hourly`).
   */
  readonly schedule: string;
  /**
   * Path to the JS/TS module exporting `default: { scheduled(controller) }`.
   */
  readonly path: string;
}

/**
 * Low-level runtime adapter for OS-level cron operations.
 * Defaults to native `Bun.cron(path, schedule, title)` and `Bun.cron.remove(title)`.
 * Injectable for deterministic unit testing without mutating host OS schedulers.
 */
export interface OsCronRuntimeAdapter {
  register(path: string, schedule: string, title: string): Promise<void>;
  remove(title: string): Promise<void>;
}

export interface OsCronOptions {
  /**
   * Unique OS cron title (`/^[A-Za-z0-9_-]+$/`).
   * Defaults to a normalized `<className>-<methodName>` identifier.
   */
  readonly title?: string;
  /**
   * Optional path to the module entrypoint for OS-level registration.
   */
  readonly path?: string;
}

export interface OsCronMetadata {
  readonly schedule: string;
  readonly methodName: string | symbol;
  readonly options: OsCronOptions;
}

export type CronOptions = {
  /**
   * Unique name used to register and look up the job in `SchedulerRegistry`.
   */
  name?: string;
  /**
   * Execution engine for this job (`"auto"` | `"native"` | `"timer"`).
   * @default "auto"
   */
  engine?: CronEngine;
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
  /**
   * Normalized 5-field cron expression or Bun nickname accepted directly by
   * native `Bun.cron` / `Bun.cron.parse`, or `undefined` when the expression
   * uses 6-field seconds or wrap-around ranges requiring the pure-TS evaluator.
   */
  readonly nativeExpression?: string;
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
   * Default execution engine for discovered `@Cron()` jobs (`"auto"` | `"native"` | `"timer"`).
   * @default "auto"
   */
  defaultEngine?: CronEngine;
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
  /**
   * Optional custom runtime adapter for OS-level `Bun.cron` / `Bun.cron.remove` calls
   * managed by `OsCronService`. Defaults to native `Bun.cron`.
   */
  osCronAdapter?: OsCronRuntimeAdapter;
  /**
   * Declarative OS-level cron jobs managed by `OsCronService`.
   * Not registered automatically on boot unless `registerOsCronOnInit: true` is set;
   * call `osCronService.syncConfigured()` explicitly or set `registerOsCronOnInit: true`.
   */
  osCronJobs?: readonly OsCronJobDefinition[];
  /**
   * When `true`, `OsCronService` registers `osCronJobs` automatically during `onModuleInit()`.
   * @default false
   */
  registerOsCronOnInit?: boolean;
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
