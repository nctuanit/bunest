import { parseDuration, type Duration as CoreDuration } from "@bunest/core";
import type { Duration } from "../interfaces/storage-types";

export function toMs(duration: Duration): number {
  if (typeof duration !== "number" && typeof duration !== "string") {
    throw new TypeError("Duration must be a number or duration string");
  }
  const normalized =
    typeof duration === "string" ? (duration.trim() as CoreDuration) : duration;
  try {
    return parseDuration(normalized);
  } catch {
    throw new RangeError(
      typeof duration === "string"
        ? `Invalid duration string: "${duration}"`
        : `Invalid duration: ${duration}`,
    );
  }
}
