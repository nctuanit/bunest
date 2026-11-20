import { Logger } from "@bunest/common";
import type { CustomMetric } from "../interfaces/observe-types";
import {
  admitsFinite,
  admitsLabelValues,
  isLabelSet,
  MAX_SERIES_KEY_LENGTH,
} from "./label-values.util";

const DEFAULT_LABEL = "default" as const;
const logger = new Logger("ObserveMetrics");

/**
 * Serialises a label object into a deterministic sorted JSON map key.
 */
export function stringifyLabel(
  label: Record<string, string | number>,
): string {
  const keys = Object.keys(label).sort();
  const sorted: Record<string, string | number> = {};
  for (const key of keys) {
    sorted[key] = label[key]!;
  }
  return JSON.stringify(sorted);
}

/** Distinct label combinations one metric may hold. */
export const MAX_SERIES_PER_METRIC = 1000;

/**
 * Whether a metric may record under `key`: an existing series, or a new one within
 * `MAX_SERIES_PER_METRIC` and `MAX_SERIES_KEY_LENGTH`.
 */
export function admitsSeries(
  metricName: string,
  values: Record<string, unknown>,
  key: string,
  state: { warned: boolean; longKeyWarned?: boolean },
): boolean {
  if (Object.prototype.hasOwnProperty.call(values, key)) {
    return true;
  }
  if (key.length > MAX_SERIES_KEY_LENGTH) {
    if (!state.longKeyWarned) {
      state.longKeyWarned = true;
      logger.warn(
        `Metric "${metricName}" label key exceeds ${MAX_SERIES_KEY_LENGTH} characters; dropping series.`,
      );
    }
    return false;
  }
  if (Object.keys(values).length >= MAX_SERIES_PER_METRIC) {
    if (!state.warned) {
      state.warned = true;
      logger.warn(
        `Metric "${metricName}" reached the limit of ${MAX_SERIES_PER_METRIC} distinct label series; dropping new series.`,
      );
    }
    return false;
  }
  return true;
}

export class Counter<TLabel extends string = typeof DEFAULT_LABEL>
  implements CustomMetric<TLabel>
{
  private readonly seriesLimit: { warned: boolean; longKeyWarned?: boolean } = {
    warned: false,
  };
  private readonly nonFinite = { warned: false };
  private readonly labelValues = { warned: false };

  readonly name: string;
  readonly type = "counter" as const;
  readonly description?: string;
  readonly value: Record<string, number> = {};
  readonly labels?: TLabel[];

  private _tags?: Record<string, string>;
  private _onChange?: () => void;
  private _initialValue = 0;
  private _lastUpdated = Date.now();
  private _lastFlushedValue: Record<string, number> = {};

  get increase(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(this.value)) {
      const prev = this._lastFlushedValue[k] ?? 0;
      const diff = v - prev;
      if (diff !== 0) {
        out[k] = diff;
      }
    }
    return out;
  }

  markFlushed(): void {
    for (const [k, v] of Object.entries(this.value)) {
      this._lastFlushedValue[k] = v;
    }
  }

  get lastUpdated(): number {
    return this._lastUpdated;
  }

  get tags(): Record<string, string> | undefined {
    return this._tags;
  }

  set tags(tags: Record<string, string> | undefined) {
    this._tags = tags;
  }

  constructor(name: string);
  constructor(name: string, description: string);
  constructor(name: string, description: string, initialValue: number);
  constructor(name: string, description: string, labels: TLabel[]);
  constructor(
    name: string,
    description: string,
    initialValue: number,
    labels: TLabel[],
  );
  constructor(
    name: string,
    description?: string,
    initialValue?: number,
    labels?: TLabel[],
  );
  constructor(
    name: string,
    description?: string,
    initialValueOrLabels?: number | TLabel[],
    maybeLabels?: TLabel[],
  ) {
    this.name = name;
    this.description = description;
    if (Array.isArray(initialValueOrLabels)) {
      this.labels = initialValueOrLabels;
      this._initialValue = 0;
    } else {
      this._initialValue =
        typeof initialValueOrLabels === "number" &&
        Number.isFinite(initialValueOrLabels)
          ? initialValueOrLabels
          : 0;
      this.labels = maybeLabels;
    }
    if (!this.labels || this.labels.length === 0) {
      this.value[DEFAULT_LABEL] = this._initialValue;
      this._lastFlushedValue[DEFAULT_LABEL] = this._initialValue;
    }
  }

  getValue(): number;
  getValue(label: Record<TLabel, string | number>): number;
  getValue(label?: Record<TLabel, string | number>): number {
    if (!label) {
      return this.value[DEFAULT_LABEL] ?? this._initialValue;
    }
    this.validateLabels(label);
    const key = stringifyLabel(label);
    return this.value[key] ?? this._initialValue;
  }

  increment(): void;
  increment(label: Record<TLabel, string | number>): void;
  increment(value: number): void;
  increment(label: Record<TLabel, string | number>, value: number): void;
  increment(
    labelOrValue?: Record<TLabel, string | number> | number,
    maybeValue?: number,
  ): void {
    let key: string = DEFAULT_LABEL;
    let delta = 1;

    if (isLabelSet(labelOrValue)) {
      if (!admitsLabelValues(this.name, labelOrValue, this.labelValues)) {
        return;
      }
      this.validateLabels(labelOrValue);
      key = stringifyLabel(labelOrValue);
      delta = maybeValue ?? 1;
    } else if (labelOrValue !== undefined) {
      delta = labelOrValue;
    }

    if (!admitsFinite(this.name, delta, this.nonFinite)) {
      return;
    }
    if (!admitsSeries(this.name, this.value, key, this.seriesLimit)) {
      return;
    }

    const current = this.value[key] ?? this._initialValue;
    const next = current + delta;
    if (!this.admitsNewReading(key, next)) {
      return;
    }
    this.value[key] = next;
    this._lastUpdated = Date.now();
    this._onChange?.();
  }

  private admitsNewReading(key: string, reading: number): boolean {
    if (!admitsFinite(this.name, reading, this.nonFinite)) {
      return false;
    }
    const baseline = this._lastFlushedValue[key] ?? 0;
    if (!Number.isFinite(reading - baseline)) {
      return admitsFinite(this.name, reading - baseline, this.nonFinite);
    }
    return true;
  }

  private validateLabels(label: Record<string, string | number>): void {
    if (!this.labels || this.labels.length === 0) {
      return;
    }
    for (const required of this.labels) {
      if (!(required in label)) {
        throw new Error(
          `Counter "${this.name}" is missing required label "${required}"`,
        );
      }
    }
  }
}
