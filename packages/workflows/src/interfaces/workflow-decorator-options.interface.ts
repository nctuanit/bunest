import type {
  ConcurrencyLimit,
  RateLimit,
  RateWindow,
  ResolvedConcurrency,
  ResolvedRateLimit,
} from "../core/interfaces/limits.interface";
import type { Duration } from "../core/time/duration";
import type {
  WorkflowScheduleDeclaration,
  WorkflowScheduleSpec,
} from "./workflow-schedule.interface";

export interface WorkflowMetadata {
  name: string;
  version: number;
  /** In milliseconds. */
  timeout?: number;
  /** `null`: no limit. `undefined`: not known here (a workflow started by name that this process doesn't register). */
  concurrency?: WorkflowConcurrencyMetadata | null;
  /** `null`: no limit. `undefined`: not known here, as for `concurrency`. */
  rateLimit?: WorkflowRateLimitMetadata | null;
  /** `@Workflow(name, { schedules })`, validated. */
  schedules?: WorkflowDeclaredSchedule[];
}

/** One of `@Workflow(name, { schedules })`, validated: its spec (as the store keeps it) and its input. */
export interface WorkflowDeclaredSchedule {
  id: string;
  spec: WorkflowScheduleSpec;
  /** A JSON value (normalized), or a function of the occurrence. */
  input: unknown;
}

/** `@Workflow(name, { concurrency })`, validated. */
export type WorkflowConcurrencyMetadata = ResolvedConcurrency;

/** `@Workflow(name, { rateLimit })`, validated. */
export type WorkflowRateLimitMetadata = ResolvedRateLimit;

/** At most `max` executions start per window of `duration` milliseconds. */
export type WorkflowRateWindow = RateWindow;

/** One limit of `@Workflow(name, { concurrency })`. */
export interface WorkflowConcurrency extends ConcurrencyLimit {
  /** A positive integer: how many instances may run at once, of the workflow, or with `key`, per key. */
  limit: number;
  /**
   * Makes `limit` a limit per key: the key of an instance, computed from its (JSON) input when
   * it starts, such as `(order) => order.customerId`. `null` or `undefined` leaves the instance
   * out of every key. `start()`'s `concurrencyKey` option overrides it.
   */
  key?: (input: any) => string | null | undefined;
}

/** One limit of `@Workflow(name, { rateLimit })`. */
export interface WorkflowRateLimit extends RateLimit {
  /** A positive integer: how many executions may start per `duration`, of the workflow, or with `key`, per key. */
  max: number;
  /** The window, such as `'1m'`. */
  duration: Duration;
  /**
   * Makes the limit a limit per key: the key of an instance, computed from its (JSON) input when it starts, such
   * as `(order) => order.customerId`. `null` or `undefined` leaves the instance out of every key. `start()`'s
   * `rateLimitKey` option overrides it.
   */
  key?: (input: any) => string | null | undefined;
}

export interface WorkflowDecoratorOptions {
  /**
   * Bump when a change would not replay against journals written by the
   * previous code (renamed, removed, reordered or inserted steps). Keep the old
   * class registered until its instances finish. Default 1.
   */
  version?: number;
  /**
   * How long an instance may run, from its start to its end, sleeps and waits included.
   */
  timeout?: Duration;
  /**
   * How many instances may run at once, across every worker.
   */
  concurrency?: WorkflowConcurrency | WorkflowConcurrency[];
  /**
   * How many executions may start per window, across every worker.
   */
  rateLimit?: WorkflowRateLimit | WorkflowRateLimit[];
  /**
   * Starts instances on a schedule: a `cron` expression, an interval (`every`) or an RFC 5545 `rrule`, in a
   * time zone (`tz`), with an `id` unique across the application.
   */
  schedules?: WorkflowScheduleDeclaration[];
}
