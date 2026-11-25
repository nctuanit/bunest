import { parseDuration, type Duration as CoreDuration } from "@bunest/core";
import type { Duration } from "@bunest/resilience";
import { AiConfigurationError } from "../errors/ai.errors";

/** A duration in milliseconds. */
export function toMilliseconds(
  value: Duration | string,
  option: string,
): number {
  if (typeof value === "number") {
    try {
      return parseDuration(value);
    } catch {
      throw new AiConfigurationError(
        `Invalid duration for \`${option}\`: ${String(value)}`,
      );
    }
  }
  const normalized = String(value).trim().replace(/\s+/g, "").toLowerCase();
  if (normalized.endsWith("w")) {
    throw new AiConfigurationError(
      `Invalid duration for \`${option}\`: ${String(value)}`,
    );
  }
  try {
    return parseDuration(normalized as CoreDuration);
  } catch {
    throw new AiConfigurationError(
      `Invalid duration for \`${option}\`: ${String(value)}`,
    );
  }
}
