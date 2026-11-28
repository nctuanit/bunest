import { clamp } from "@bunest/core/common";
import type {
  LockClock,
  LockTimerOptions,
} from "../interfaces/lock-clock.interface";

/** The largest delay `setTimeout` takes; a longer one fires at once. */
const MAX_TIMEOUT = 2 ** 31 - 1;

/**
 * `Date.now()` and runtime timers. Timers are `unref()`'d unless asked otherwise, so a
 * renewal never keeps the process alive, and capped at the largest delay `setTimeout` takes
 * (callers re-check their deadline when a timer fires, so an early one is harmless).
 */
export const systemClock: LockClock = {
  now: () => Date.now(),
  setTimeout: (
    callback: () => unknown,
    ms: number,
    options?: LockTimerOptions,
  ) => {
    const timer = setTimeout(callback, clamp(ms, 0, MAX_TIMEOUT));
    if (!options?.ref) {
      timer.unref?.();
    }
    return timer;
  },
  clearTimeout: (handle: unknown) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};
