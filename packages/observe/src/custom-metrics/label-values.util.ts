import { Logger } from "@bunest/common";

export const MAX_SERIES_KEY_LENGTH = 255;

const logger = new Logger("ObserveMetrics");

export function admitsLabelValues(
  metricName: string,
  label: object,
  state: { warned: boolean },
): boolean {
  for (const val of Object.values(label)) {
    const t = typeof val;
    if (
      val !== null &&
      t !== "string" &&
      t !== "number" &&
      t !== "boolean"
    ) {
      if (!state.warned) {
        state.warned = true;
        logger.warn(
          `Metric "${metricName}" received an invalid label value of type "${t}"; ignoring observation.`,
        );
      }
      return false;
    }
  }
  return true;
}

export function isLabelSet<TLabels extends object>(
  labelOrValue: TLabels | number | null | undefined,
): labelOrValue is TLabels {
  return (
    typeof labelOrValue === "object" &&
    labelOrValue !== null &&
    !Array.isArray(labelOrValue)
  );
}

export function admitsFinite(
  metricName: string,
  value: number,
  state: { warned: boolean },
): boolean {
  if (typeof value === "number" && Number.isFinite(value)) {
    return true;
  }
  if (!state.warned) {
    state.warned = true;
    logger.warn(
      `Metric "${metricName}" received a non-finite value (${String(value)}); ignoring update.`,
    );
  }
  return false;
}
