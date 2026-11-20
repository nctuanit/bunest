import type { OnOneInstanceOptions } from "../interfaces/job-options.interface";
import { decorateJob } from "../utils/job-decorator.util";

/**
 * Runs the method on one instance of the application at a time: the first instance to
 * call it takes the job's lease (`<key>:owner`), keeps renewing it while it is up, and runs
 * every call; on the other instances a call is skipped (it resolves `undefined`), never
 * queued. After the owner crashes, the first instance whose call comes `ttl` later takes
 * over. For `@Cron()`, `@Interval()` and `@Timeout()` jobs, in either decorator order.
 */
export function OnOneInstance(
  options: OnOneInstanceOptions = {},
): MethodDecorator {
  return decorateJob("oneInstance", "@OnOneInstance()", options);
}
