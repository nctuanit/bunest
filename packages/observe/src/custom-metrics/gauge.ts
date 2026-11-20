import type { CustomMetric, GaugeKind } from "../interfaces/observe-types";
import { admitsSeries, stringifyLabel } from "./counter";
import {
  admitsFinite,
  admitsLabelValues,
  isLabelSet,
} from "./label-values.util";

const DEFAULT_LABEL = "default" as const;

export class Gauge<TLabel extends string = typeof DEFAULT_LABEL>
  implements CustomMetric<TLabel>
{
  private readonly seriesLimit: { warned: boolean; longKeyWarned?: boolean } = {
    warned: false,
  };
  private readonly nonFinite = { warned: false };
  private readonly labelValues = { warned: false };

  readonly name: string;
  readonly type = "gauge" as const;
  readonly description?: string;
  readonly value: Record<string, number> = {};
  readonly labels?: TLabel[];
  readonly kind?: GaugeKind;

  private _tags?: Record<string, string>;
  private _onChange?: () => void;
  private _initialValue = 0;
  private _lastUpdated = Date.now();

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
  constructor(
    name: string,
    attributes: {
      description?: string;
      initialValue?: number;
      labels?: TLabel[];
      kind?: GaugeKind;
    },
  );
  constructor(
    name: string,
    attributes?: {
      description?: string;
      initialValue?: number;
      labels?: TLabel[];
      kind?: GaugeKind;
    },
  ) {
    this.name = name;
    this.description = attributes?.description;
    this.labels = attributes?.labels;
    this.kind = attributes?.kind ?? "ratio";
    this._initialValue =
      typeof attributes?.initialValue === "number" &&
      Number.isFinite(attributes.initialValue)
        ? attributes.initialValue
        : 0;
    if (!this.labels || this.labels.length === 0) {
      this.value[DEFAULT_LABEL] = this._initialValue;
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
    this.adjust(labelOrValue, maybeValue, 1);
  }

  decrement(): void;
  decrement(label: Record<TLabel, string | number>): void;
  decrement(value: number): void;
  decrement(label: Record<TLabel, string | number>, value: number): void;
  decrement(
    labelOrValue?: Record<TLabel, string | number> | number,
    maybeValue?: number,
  ): void {
    this.adjust(labelOrValue, maybeValue, -1);
  }

  setValue(value: number): void;
  setValue(label: Record<TLabel, string | number>, value: number): void;
  setValue(
    labelOrValue: Record<TLabel, string | number> | number,
    maybeValue?: number,
  ): void {
    let key: string = DEFAULT_LABEL;
    let next: number;

    if (isLabelSet(labelOrValue)) {
      if (!admitsLabelValues(this.name, labelOrValue, this.labelValues)) {
        return;
      }
      this.validateLabels(labelOrValue);
      key = stringifyLabel(labelOrValue);
      next = maybeValue as number;
    } else {
      next = labelOrValue;
    }

    if (!admitsFinite(this.name, next, this.nonFinite)) {
      return;
    }
    if (!admitsSeries(this.name, this.value, key, this.seriesLimit)) {
      return;
    }
    this.value[key] = next;
    this._lastUpdated = Date.now();
    this._onChange?.();
  }

  private adjust(
    labelOrValue: Record<TLabel, string | number> | number | undefined,
    maybeValue: number | undefined,
    sign: 1 | -1,
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
    const next = current + sign * delta;
    if (!admitsFinite(this.name, next, this.nonFinite)) {
      return;
    }
    this.value[key] = next;
    this._lastUpdated = Date.now();
    this._onChange?.();
  }

  private validateLabels(label: Record<string, string | number>): void {
    if (!this.labels || this.labels.length === 0) {
      return;
    }
    for (const required of this.labels) {
      if (!(required in label)) {
        throw new Error(
          `Gauge "${this.name}" is missing required label "${required}"`,
        );
      }
    }
  }
}
