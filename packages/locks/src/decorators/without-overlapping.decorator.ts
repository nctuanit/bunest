import type { WithoutOverlappingOptions } from "../interfaces/job-options.interface";
import { decorateJob } from "../utils/job-decorator.util";

/**
 * Skips a call while a run of the method holds its lock (`key`), on this instance or any
 * other: a long run makes the next ticks skip instead of piling up. The lock is renewed
 * while the run lasts and released when it ends. Inside the method, `LocksContext` has the
 * run's fencing token (a new, higher one per run) and a signal that aborts if the lock is
 * lost.
 */
export function WithoutOverlapping(
  options: WithoutOverlappingOptions = {},
): MethodDecorator {
  return decorateJob("withoutOverlapping", "@WithoutOverlapping()", options);
}
