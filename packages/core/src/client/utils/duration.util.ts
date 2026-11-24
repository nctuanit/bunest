import { parseDuration } from "../../common/utils/duration.util";
import type { Duration } from "../types/duration.type";
import { MAX_TIMER_MS } from "./timers.util";

/**
 * `toMs()` with the option's name in the error, e.g. "HttpClient `timeout`:
 * Invalid duration …". `cause`, when given, becomes the TypeError's `cause`.
 */
export function durationOption(
  value: Duration,
  option: string,
  cause?: unknown,
): number {
  const options = cause === undefined ? undefined : { cause };
  let ms: number;
  try {
    ms = parseDuration(value);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new TypeError(`HttpClient \`${option}\`: ${msg}`, options);
  }
  if (ms > MAX_TIMER_MS) {
    throw new TypeError(
      `HttpClient \`${option}\`: ${JSON.stringify(value)} is longer than a timer can wait (about 24.8 days)`,
      options,
    );
  }
  return ms;
}

export { parseDuration as toMs };
