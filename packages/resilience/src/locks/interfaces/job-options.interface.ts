import type { Duration } from "./duration.interface";

export interface OnOneInstanceOptions {
  /**
   * The job's lock key, shared with `@WithoutOverlapping()` on the same method (set it on
   * either). Default: `ClassName.methodName`.
   */
  key?: string;
  /**
   * How long the instance that runs the job keeps it without renewing: after a crash,
   * another instance takes the job over at its first tick after `ttl`. Default: the module's
   * `ttl` (`'30s'`).
   */
  ttl?: Duration;
}

export interface WithoutOverlappingOptions {
  /**
   * The key of the lock a run holds, shared with `@OnOneInstance()` (set it on either).
   * Default: `ClassName.methodName`.
   */
  key?: string;
  /** How long a run's lock lives without a renewal (a crashed run). Default: the module's `ttl`. */
  ttl?: Duration;
}
