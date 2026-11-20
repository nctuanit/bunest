import { Logger } from "@bunest/common";
import type { CustomMetric } from "../interfaces/observe-types";
import { MAX_SERIES_PER_METRIC } from "./counter";
import { admitsFinite, MAX_SERIES_KEY_LENGTH } from "./label-values.util";

const DEFAULT_LABEL = "default" as const;
const DEFAULT_SAMPLE_SIZE = 1024;
const logger = new Logger("ObserveMetrics");

export class Summary<TLabel extends string = typeof DEFAULT_LABEL>
  implements CustomMetric<TLabel>
{
  private readonly nonFinite = { warned: false };
  private readonly labelLimit = { warned: false };
  private _windowLabels = 0;

  readonly name: string;
  readonly type = "summary" as const;
  readonly description?: string;
  readonly labels?: TLabel[];

  private _tags?: Record<string, string>;
  private _onChange?: () => void;
  private _lastUpdated = Date.now();
  private readonly _sampleSize: number;

  private _count: Record<string, number> = {};
  private _sum: Record<string, number> = {};
  private _max: Record<string, number> = {};
  private _samples: Record<string, number[]> = {};

  get value(): Record<string, number> {
    return this.p50;
  }

  get p50(): Record<string, number> {
    return this.quantile(0.5);
  }

  get p95(): Record<string, number> {
    return this.quantile(0.95);
  }

  get p99(): Record<string, number> {
    return this.quantile(0.99);
  }

  get observations(): Record<string, number> {
    return { ...this._count };
  }

  get total(): Record<string, number> {
    return { ...this._sum };
  }

  get maximum(): Record<string, number> {
    return { ...this._max };
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
  constructor(
    name: string,
    attributes: {
      description?: string;
      labels?: TLabel[];
      sampleSize?: number;
    },
  );
  constructor(
    name: string,
    attributes?: {
      description?: string;
      labels?: TLabel[];
      sampleSize?: number;
    },
  ) {
    this.name = name;
    this.description = attributes?.description;
    this.labels = attributes?.labels;
    const sampleSize = attributes?.sampleSize ?? DEFAULT_SAMPLE_SIZE;
    this._sampleSize =
      Number.isInteger(sampleSize) && sampleSize > 0
        ? sampleSize
        : DEFAULT_SAMPLE_SIZE;
  }

  observe(value: number): void;
  observe(value: number, label: TLabel): void;
  observe(value: number, label?: TLabel): void {
    if (!admitsFinite(this.name, value, this.nonFinite)) {
      return;
    }
    const key = label ?? DEFAULT_LABEL;
    if (this.labels && this.labels.length > 0) {
      if (!this.labels.includes(key as TLabel)) {
        throw new Error(
          `Summary "${this.name}" received undeclared label "${String(key)}"`,
        );
      }
    } else if (!this.admitsLabel(key)) {
      return;
    }

    const prevCount = this._count[key] ?? 0;
    if (prevCount === 0) {
      this._windowLabels++;
      this._count[key] = 1;
      this._sum[key] = value;
      this._max[key] = value;
      this._samples[key] = [value];
    } else {
      const nextCount = prevCount + 1;
      this._count[key] = nextCount;
      this._sum[key] = (this._sum[key] ?? 0) + value;
      if (value > (this._max[key] ?? -Infinity)) {
        this._max[key] = value;
      }
      this.sample(key, value, nextCount);
    }

    this._lastUpdated = Date.now();
    this._onChange?.();
  }

  markFlushed(): void {
    this._count = {};
    this._sum = {};
    this._max = {};
    this._samples = {};
    this._windowLabels = 0;
  }

  private admitsLabel(label: unknown): label is string {
    if (typeof label !== "string") {
      if (!this.labelLimit.warned) {
        this.labelLimit.warned = true;
        logger.warn(
          `Summary "${this.name}" received a non-string label; dropping observation.`,
        );
      }
      return false;
    }
    if (Object.prototype.hasOwnProperty.call(this._count, label)) {
      return true;
    }
    if (
      label.length > MAX_SERIES_KEY_LENGTH ||
      this._windowLabels >= MAX_SERIES_PER_METRIC
    ) {
      if (!this.labelLimit.warned) {
        this.labelLimit.warned = true;
        logger.warn(
          `Summary "${this.name}" exceeded label limit (${MAX_SERIES_PER_METRIC}) or length (${MAX_SERIES_KEY_LENGTH}); dropping label.`,
        );
      }
      return false;
    }
    return true;
  }

  /** Algorithm R reservoir sampling for bounded memory. */
  private sample(key: string, value: number, count: number): void {
    const reservoir = this._samples[key];
    if (!reservoir) return;
    if (reservoir.length < this._sampleSize) {
      reservoir.push(value);
      return;
    }
    const slot = Math.floor(Math.random() * count);
    if (slot < this._sampleSize) {
      reservoir[slot] = value;
    }
  }

  /** Nearest-rank quantile per label. */
  private quantile(q: number): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [key, samples] of Object.entries(this._samples)) {
      if (samples.length === 0) continue;
      const sorted = [...samples].sort((a, b) => a - b);
      const idx = Math.min(
        sorted.length - 1,
        Math.max(0, Math.ceil(q * sorted.length) - 1),
      );
      out[key] = sorted[idx]!;
    }
    return out;
  }
}
