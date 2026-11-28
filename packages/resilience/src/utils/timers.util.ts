import { clamp, sleep as coreSleep } from "@bunest/core/common";

/**
 * The longest delay `setTimeout` supports: 2^31 - 1 ms, about 24.8 days.
 */
const MAX_TIMER_DELAY = 2 ** 31 - 1;

/** @internal `setTimeout`, with delays beyond what timers support treated as the longest one. */
export function setTimer(
  callback: () => void,
  ms: number,
): ReturnType<typeof setTimeout> {
  return setTimeout(callback, Math.min(ms, MAX_TIMER_DELAY));
}

/**
 * @internal Aborts `controller` with `source`'s reason when `source` aborts,
 * until the returned function is called.
 */
export function linkSignal(
  source: AbortSignal,
  controller: AbortController,
): () => void {
  if (source.aborted) {
    controller.abort(source.reason);
    return () => undefined;
  }
  const onAbort = () => controller.abort(source.reason);
  source.addEventListener("abort", onAbort, { once: true });
  return () => source.removeEventListener("abort", onAbort);
}

/** @internal `setTimeout` as a promise that rejects with `signal.reason` on abort. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return coreSleep(clamp(ms, 0, MAX_TIMER_DELAY), signal);
}
