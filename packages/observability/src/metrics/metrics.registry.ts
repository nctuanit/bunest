import { Injectable } from "@bunest/core";

export type MetricType = "counter" | "gauge" | "histogram";
export type MetricLabels = Readonly<Record<string, string | number | boolean>>;

export interface MetricOptions {
  readonly name: string;
  readonly help: string;
  readonly labelNames?: readonly string[];
}

export interface HistogramOptions extends MetricOptions {
  readonly buckets?: readonly number[];
}

export const DEFAULT_HTTP_BUCKETS: readonly number[] = Object.freeze([
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
]);

const METRIC_NAME_REGEX = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function assertMetricName(name: string): void {
  if (!METRIC_NAME_REGEX.test(name)) {
    throw new Error(`Invalid Prometheus metric name: "${name}"`);
  }
}

function assertLabelNames(
  labelNames: readonly string[],
  forbidLe = false,
): string[] {
  const seen = new Set<string>();
  const list: string[] = [];
  for (const label of labelNames) {
    if (!LABEL_NAME_REGEX.test(label) || label.startsWith("__")) {
      throw new Error(`Invalid Prometheus label name: "${label}"`);
    }
    if (forbidLe && label === "le") {
      throw new Error(
        `Histogram label name "le" is reserved by Prometheus exposition format`,
      );
    }
    if (!seen.has(label)) {
      seen.add(label);
      list.push(label);
    }
  }
  return list;
}

function escapeHelpText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

function escapeLabelValue(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
}

function normalizeAndKeyLabels(
  allowedNames: readonly string[],
  labels: MetricLabels | undefined,
): { key: string; pairs: Array<[string, string]> } {
  const pairs: Array<[string, string]> = [];
  if (labels) {
    for (const k of Object.keys(labels)) {
      if (!allowedNames.includes(k)) {
        throw new Error(
          `Unknown metric label "${k}". Declared labels: [${allowedNames.join(", ")}]`,
        );
      }
    }
  }

  for (const name of allowedNames) {
    const raw = labels?.[name];
    pairs.push([name, raw === undefined ? "" : String(raw)]);
  }

  const key = JSON.stringify(pairs);
  return { key, pairs };
}

function formatLabelSet(
  pairs: ReadonlyArray<[string, string]>,
  extra?: [string, string],
): string {
  const all = extra ? [...pairs, extra] : pairs;
  if (all.length === 0) {
    return "";
  }
  return `{${all.map(([k, v]) => `${k}="${escapeLabelValue(v)}"`).join(",")}}`;
}

function formatNumber(n: number): string {
  if (Number.isNaN(n)) return "NaN";
  if (n === Number.POSITIVE_INFINITY) return "+Inf";
  if (n === Number.NEGATIVE_INFINITY) return "-Inf";
  return Object.is(n, -0) ? "0" : String(n);
}

export interface PrometheusMetric {
  readonly name: string;
  readonly help: string;
  readonly type: MetricType;
  readonly labelNames: readonly string[];
  reset(): void;
  formatPrometheus(): string;
}

export class Counter implements PrometheusMetric {
  public readonly type: MetricType = "counter";
  public readonly name: string;
  public readonly help: string;
  public readonly labelNames: readonly string[];
  private readonly values = new Map<
    string,
    { pairs: Array<[string, string]>; value: number }
  >();

  constructor(options: MetricOptions) {
    assertMetricName(options.name);
    this.name = options.name;
    this.help = options.help;
    this.labelNames = assertLabelNames(options.labelNames ?? []);
  }

  inc(value?: number): void;
  inc(labels: MetricLabels, value?: number): void;
  inc(labelsOrValue?: MetricLabels | number, maybeValue?: number): void {
    const labels =
      typeof labelsOrValue === "object" && labelsOrValue !== null
        ? labelsOrValue
        : undefined;
    const delta =
      typeof labelsOrValue === "number" ? labelsOrValue : (maybeValue ?? 1);

    if (!Number.isFinite(delta) || delta < 0) {
      throw new Error(
        `Counter "${this.name}" cannot be incremented by negative or non-finite value (${delta})`,
      );
    }

    const { key, pairs } = normalizeAndKeyLabels(this.labelNames, labels);
    const existing = this.values.get(key);
    if (existing) {
      existing.value += delta;
    } else {
      this.values.set(key, { pairs, value: delta });
    }
  }

  get(labels?: MetricLabels): number {
    const { key } = normalizeAndKeyLabels(this.labelNames, labels);
    return this.values.get(key)?.value ?? 0;
  }

  reset(): void {
    this.values.clear();
  }

  formatPrometheus(): string {
    const lines = [
      `# HELP ${this.name} ${escapeHelpText(this.help)}`,
      `# TYPE ${this.name} counter`,
    ];

    if (this.values.size === 0 && this.labelNames.length === 0) {
      lines.push(`${this.name} 0`);
    } else {
      for (const entry of this.values.values()) {
        lines.push(
          `${this.name}${formatLabelSet(entry.pairs)} ${formatNumber(entry.value)}`,
        );
      }
    }

    return lines.join("\n");
  }
}

export class Gauge implements PrometheusMetric {
  public readonly type: MetricType = "gauge";
  public readonly name: string;
  public readonly help: string;
  public readonly labelNames: readonly string[];
  private readonly values = new Map<
    string,
    { pairs: Array<[string, string]>; value: number }
  >();

  constructor(options: MetricOptions) {
    assertMetricName(options.name);
    this.name = options.name;
    this.help = options.help;
    this.labelNames = assertLabelNames(options.labelNames ?? []);
  }

  set(value: number): void;
  set(labels: MetricLabels, value: number): void;
  set(labelsOrValue: MetricLabels | number, maybeValue?: number): void {
    const labels =
      typeof labelsOrValue === "object" && labelsOrValue !== null
        ? labelsOrValue
        : undefined;
    const value =
      typeof labelsOrValue === "number" ? labelsOrValue : maybeValue!;

    const { key, pairs } = normalizeAndKeyLabels(this.labelNames, labels);
    this.values.set(key, { pairs, value });
  }

  inc(value?: number): void;
  inc(labels: MetricLabels, value?: number): void;
  inc(labelsOrValue?: MetricLabels | number, maybeValue?: number): void {
    const labels =
      typeof labelsOrValue === "object" && labelsOrValue !== null
        ? labelsOrValue
        : undefined;
    const delta =
      typeof labelsOrValue === "number" ? labelsOrValue : (maybeValue ?? 1);
    const { key, pairs } = normalizeAndKeyLabels(this.labelNames, labels);
    const existing = this.values.get(key);
    if (existing) {
      existing.value += delta;
    } else {
      this.values.set(key, { pairs, value: delta });
    }
  }

  dec(value?: number): void;
  dec(labels: MetricLabels, value?: number): void;
  dec(labelsOrValue?: MetricLabels | number, maybeValue?: number): void {
    const labels =
      typeof labelsOrValue === "object" && labelsOrValue !== null
        ? labelsOrValue
        : undefined;
    const delta =
      typeof labelsOrValue === "number" ? labelsOrValue : (maybeValue ?? 1);
    if (labels) {
      this.inc(labels, -delta);
    } else {
      this.inc(-delta);
    }
  }

  get(labels?: MetricLabels): number {
    const { key } = normalizeAndKeyLabels(this.labelNames, labels);
    return this.values.get(key)?.value ?? 0;
  }

  reset(): void {
    this.values.clear();
  }

  formatPrometheus(): string {
    const lines = [
      `# HELP ${this.name} ${escapeHelpText(this.help)}`,
      `# TYPE ${this.name} gauge`,
    ];

    if (this.values.size === 0 && this.labelNames.length === 0) {
      lines.push(`${this.name} 0`);
    } else {
      for (const entry of this.values.values()) {
        lines.push(
          `${this.name}${formatLabelSet(entry.pairs)} ${formatNumber(entry.value)}`,
        );
      }
    }

    return lines.join("\n");
  }
}

interface HistogramEntry {
  pairs: Array<[string, string]>;
  bucketCounts: number[];
  sum: number;
  count: number;
}

export class Histogram implements PrometheusMetric {
  public readonly type: MetricType = "histogram";
  public readonly name: string;
  public readonly help: string;
  public readonly labelNames: readonly string[];
  public readonly buckets: readonly number[];
  private readonly entries = new Map<string, HistogramEntry>();

  constructor(options: HistogramOptions) {
    assertMetricName(options.name);
    this.name = options.name;
    this.help = options.help;
    this.labelNames = assertLabelNames(options.labelNames ?? [], true);

    const rawBuckets = options.buckets ?? DEFAULT_HTTP_BUCKETS;
    const valid = [
      ...new Set(rawBuckets.filter((b) => Number.isFinite(b))),
    ].sort((a, b) => a - b);
    this.buckets = Object.freeze(valid);
  }

  observe(value: number): void;
  observe(labels: MetricLabels, value: number): void;
  observe(labelsOrValue: MetricLabels | number, maybeValue?: number): void {
    const labels =
      typeof labelsOrValue === "object" && labelsOrValue !== null
        ? labelsOrValue
        : undefined;
    const value =
      typeof labelsOrValue === "number" ? labelsOrValue : maybeValue!;

    if (!Number.isFinite(value)) {
      return;
    }

    const { key, pairs } = normalizeAndKeyLabels(this.labelNames, labels);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        pairs,
        bucketCounts: new Array<number>(this.buckets.length).fill(0),
        sum: 0,
        count: 0,
      };
      this.entries.set(key, entry);
    }

    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]!) {
        entry.bucketCounts[i] = (entry.bucketCounts[i] ?? 0) + 1;
      }
    }
    entry.sum += value;
    entry.count += 1;
  }

  startTimer(labels?: MetricLabels): (overrideLabels?: MetricLabels) => number {
    const start = performance.now();
    return (overrideLabels?: MetricLabels) => {
      const durationSec = Math.max(0, (performance.now() - start) / 1000);
      const merged = overrideLabels
        ? { ...(labels ?? {}), ...overrideLabels }
        : labels;
      if (merged) {
        this.observe(merged, durationSec);
      } else {
        this.observe(durationSec);
      }
      return durationSec;
    };
  }

  get(
    labels?: MetricLabels,
  ):
    | { count: number; sum: number; buckets: Record<string, number> }
    | undefined {
    const { key } = normalizeAndKeyLabels(this.labelNames, labels);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    const bucketMap: Record<string, number> = {};
    for (let i = 0; i < this.buckets.length; i++) {
      bucketMap[String(this.buckets[i]!)] = entry.bucketCounts[i] ?? 0;
    }
    bucketMap["+Inf"] = entry.count;
    return { count: entry.count, sum: entry.sum, buckets: bucketMap };
  }

  reset(): void {
    this.entries.clear();
  }

  formatPrometheus(): string {
    const lines = [
      `# HELP ${this.name} ${escapeHelpText(this.help)}`,
      `# TYPE ${this.name} histogram`,
    ];

    for (const entry of this.entries.values()) {
      for (let i = 0; i < this.buckets.length; i++) {
        lines.push(
          `${this.name}_bucket${formatLabelSet(entry.pairs, ["le", String(this.buckets[i]!)])} ${entry.bucketCounts[i] ?? 0}`,
        );
      }
      lines.push(
        `${this.name}_bucket${formatLabelSet(entry.pairs, ["le", "+Inf"])} ${entry.count}`,
      );
      lines.push(
        `${this.name}_sum${formatLabelSet(entry.pairs)} ${formatNumber(entry.sum)}`,
      );
      lines.push(
        `${this.name}_count${formatLabelSet(entry.pairs)} ${entry.count}`,
      );
    }

    return lines.join("\n");
  }
}

export const PROMETHEUS_CONTENT_TYPE =
  "text/plain; version=0.0.4; charset=utf-8";

/**
 * Registry managing Counters, Gauges, and Histograms with Prometheus 0.0.4 exposition.
 */
@Injectable()
export class MetricsRegistry {
  private readonly metrics = new Map<string, PrometheusMetric>();

  createCounter(options: MetricOptions): Counter {
    const existing = this.metrics.get(options.name);
    if (existing) {
      if (existing.type !== "counter") {
        throw new Error(
          `Metric "${options.name}" already registered as "${existing.type}"`,
        );
      }
      return existing as Counter;
    }
    const counter = new Counter(options);
    this.metrics.set(counter.name, counter);
    return counter;
  }

  createGauge(options: MetricOptions): Gauge {
    const existing = this.metrics.get(options.name);
    if (existing) {
      if (existing.type !== "gauge") {
        throw new Error(
          `Metric "${options.name}" already registered as "${existing.type}"`,
        );
      }
      return existing as Gauge;
    }
    const gauge = new Gauge(options);
    this.metrics.set(gauge.name, gauge);
    return gauge;
  }

  createHistogram(options: HistogramOptions): Histogram {
    const existing = this.metrics.get(options.name);
    if (existing) {
      if (existing.type !== "histogram") {
        throw new Error(
          `Metric "${options.name}" already registered as "${existing.type}"`,
        );
      }
      return existing as Histogram;
    }
    const histogram = new Histogram(options);
    this.metrics.set(histogram.name, histogram);
    return histogram;
  }

  getMetric<T extends PrometheusMetric = PrometheusMetric>(
    name: string,
  ): T | undefined {
    return this.metrics.get(name) as T | undefined;
  }

  getMetrics(): PrometheusMetric[] {
    return [...this.metrics.values()];
  }

  removeMetric(name: string): boolean {
    return this.metrics.delete(name);
  }

  resetAll(): void {
    for (const metric of this.metrics.values()) {
      metric.reset();
    }
  }

  clear(): void {
    this.metrics.clear();
  }

  toPrometheusText(): string {
    const blocks: string[] = [];
    for (const metric of this.metrics.values()) {
      blocks.push(metric.formatPrometheus());
    }
    return blocks.length > 0 ? `${blocks.join("\n\n")}\n` : "";
  }
}
