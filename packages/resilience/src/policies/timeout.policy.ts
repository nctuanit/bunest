import { ResilienceTimeoutError } from "../errors/resilience-timeout.error";
import type { Duration } from "../interfaces/duration.interface";
import type { TimeoutOptions } from "../interfaces/timeout-options.interface";
import { durationOption } from "../utils/options.util";
import { linkSignal, setTimer } from "../utils/timers.util";
import {
  call,
  ResiliencePolicy,
  type Execution,
  type Next,
} from "./resilience.policy";

/**
 * Rejects with `ResilienceTimeoutError` once `timeout` passes, and aborts the
 * signal the call received with that same error. Cancellation is
 * cooperative: a call that ignores the signal keeps running in the
 * background, but its result is dropped.
 */
export class TimeoutPolicy extends ResiliencePolicy {
  /** In milliseconds. */
  readonly timeout: number;

  /** `new TimeoutPolicy('2s')` or `new TimeoutPolicy({ timeout: '2s', name })`. */
  constructor(options: Duration | TimeoutOptions) {
    const { timeout, name } =
      typeof options === "object"
        ? options
        : { timeout: options, name: undefined };
    super(name ?? "timeout");
    this.timeout = durationOption(timeout, "", true);
  }

  /** @internal */
  override run<T>(next: Next<T>, execution: Execution): Promise<T> {
    if (execution.signal.aborted) {
      return Promise.reject(execution.signal.reason);
    }
    const controller = new AbortController();
    const unlink = linkSignal(execution.signal, controller);

    return new Promise<T>((resolve, reject) => {
      const timer = setTimer(() => {
        if (execution.committed()) {
          return;
        }
        const error = new ResilienceTimeoutError(this.timeout, this.name);
        this.emit({
          type: "timeout",
          policy: this.name,
          source: execution.source,
          timeoutMs: this.timeout,
        });
        controller.abort(error);
        unlink();
        reject(error);
      }, this.timeout);

      call(next, { ...execution, signal: controller.signal })
        .then(resolve, reject)
        .finally(() => {
          clearTimeout(timer);
          unlink();
        });
    });
  }
}
