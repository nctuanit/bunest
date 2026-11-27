import type { OnModuleDestroy } from "@bunest/core";
import {
  toOtlpAttributes,
  type OtlpKeyValue,
  type SpanAttributeValue,
} from "../tracing/span";
import {
  Counter,
  Gauge,
  Histogram,
  MetricsRegistry,
} from "./metrics.registry";

/** OpenTelemetry OTLP AggregationTemporality enum values. */
export const OTLP_AGGREGATION_TEMPORALITY_DELTA = 1 as const;
export const OTLP_AGGREGATION_TEMPORALITY_CUMULATIVE = 2 as const;

export interface OtlpNumberDataPoint {
  attributes: OtlpKeyValue[];
  startTimeUnixNano?: string;
  timeUnixNano: string;
  asDouble?: number;
  asInt?: string;
}

export interface OtlpHistogramDataPoint {
  attributes: OtlpKeyValue[];
  startTimeUnixNano: string;
  timeUnixNano: string;
  count: string;
  sum: number;
  bucketCounts: string[];
  explicitBounds: number[];
}

export interface OtlpSumMetricData {
  dataPoints: OtlpNumberDataPoint[];
  aggregationTemporality: number;
  isMonotonic: boolean;
}

export interface OtlpGaugeMetricData {
  dataPoints: OtlpNumberDataPoint[];
}

export interface OtlpHistogramMetricData {
  dataPoints: OtlpHistogramDataPoint[];
  aggregationTemporality: number;
}

export interface OtlpMetric {
  name: string;
  description: string;
  unit?: string;
  sum?: OtlpSumMetricData;
  gauge?: OtlpGaugeMetricData;
  histogram?: OtlpHistogramMetricData;
}

export interface OtlpExportMetricsServiceRequest {
  resourceMetrics: Array<{
    resource: {
      attributes: OtlpKeyValue[];
    };
    scopeMetrics: Array<{
      scope: {
        name: string;
        version: string;
      };
      metrics: OtlpMetric[];
    }>;
  }>;
}

export interface OtlpHttpMetricsExporterOptions {
  readonly endpoint: string;
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * Periodic push interval in milliseconds. Pass `0` to disable automatic background
   * pushing and call `flush()` manually.
   * @default 60000
   */
  readonly intervalMs?: number;
  readonly serviceName?: string;
  readonly serviceVersion?: string;
  readonly resourceAttributes?: Readonly<Record<string, SpanAttributeValue>>;
  readonly scopeName?: string;
  readonly scopeVersion?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly onError?: (error: unknown) => void;
  readonly registry?: MetricsRegistry;
}

function nowUnixNanoString(epochMs: number): string {
  return (BigInt(Math.round(epochMs * 1_000)) * 1_000n).toString();
}

function toMetricAttributes(
  labels: Readonly<Record<string, string>>,
): OtlpKeyValue[] {
  return Object.entries(labels).map(([key, value]) => ({
    key,
    value: { stringValue: value },
  }));
}

/**
 * Zero-dependency OTLP/HTTP JSON (`ExportMetricsServiceRequest`) metrics exporter
 * pushing `MetricsRegistry` Counters (`sum`), Gauges (`gauge`), and Histograms
 * (`histogram`) via native `fetch` to OpenTelemetry Collector, Grafana Mimir/OTLP,
 * Datadog OTLP, or Honeycomb.
 */
export class OtlpHttpMetricsExporter implements OnModuleDestroy {
  private readonly endpoint: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly scopeName: string;
  private readonly scopeVersion: string;
  private readonly resourceAttributes: Readonly<
    Record<string, SpanAttributeValue>
  >;
  private readonly fetchImpl: typeof fetch;
  private readonly onError?: (error: unknown) => void;
  private readonly startTimeUnixNano: string;
  private registry?: MetricsRegistry;

  private readonly inFlight = new Set<Promise<void>>();
  private flushTimer?: ReturnType<typeof setInterval>;
  private isShutDown = false;

  constructor(options: OtlpHttpMetricsExporterOptions);
  constructor(
    registry: MetricsRegistry,
    options: Omit<OtlpHttpMetricsExporterOptions, "registry">,
  );
  constructor(
    registryOrOptions: MetricsRegistry | OtlpHttpMetricsExporterOptions,
    maybeOptions?: Omit<OtlpHttpMetricsExporterOptions, "registry">,
  ) {
    const options: OtlpHttpMetricsExporterOptions =
      registryOrOptions instanceof MetricsRegistry
        ? { ...(maybeOptions as OtlpHttpMetricsExporterOptions), registry: registryOrOptions }
        : registryOrOptions;

    this.endpoint = options.endpoint;
    this.headers = { ...(options.headers ?? {}) };
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.scopeName = options.scopeName ?? "@bunest/observability";
    this.scopeVersion = options.scopeVersion ?? "0.1.0";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.onError = options.onError;
    this.registry = options.registry;
    this.startTimeUnixNano = nowUnixNanoString(Date.now());
    this.resourceAttributes = {
      "service.name": options.serviceName ?? "bunest-service",
      ...(options.serviceVersion
        ? { "service.version": options.serviceVersion }
        : {}),
      ...(options.resourceAttributes ?? {}),
    };

    const intervalMs = options.intervalMs ?? 60_000;
    if (intervalMs > 0) {
      this.flushTimer = setInterval(() => {
        void this.flush();
      }, intervalMs);
      if (
        typeof this.flushTimer === "object" &&
        this.flushTimer !== null &&
        "unref" in this.flushTimer &&
        typeof this.flushTimer.unref === "function"
      ) {
        this.flushTimer.unref();
      }
    }
  }

  /**
   * Attaches or replaces the `MetricsRegistry` read on periodic & manual flushes.
   */
  attachRegistry(registry: MetricsRegistry): this {
    this.registry = registry;
    return this;
  }

  /**
   * Serializes all metrics in `registry` into an OTel OTLP/HTTP protobuf-JSON
   * `ExportMetricsServiceRequest` payload.
   */
  buildOtlpPayload(
    registry: MetricsRegistry | undefined = this.registry,
    nowEpochMs: number = Date.now(),
  ): OtlpExportMetricsServiceRequest {
    const timeUnixNano = nowUnixNanoString(nowEpochMs);
    const metrics: OtlpMetric[] = [];

    if (registry) {
      for (const metric of registry.getMetrics()) {
        if (metric instanceof Counter) {
          const samples = metric.collect();
          if (samples.length === 0) continue;
          metrics.push({
            name: metric.name,
            description: metric.help,
            sum: {
              aggregationTemporality: OTLP_AGGREGATION_TEMPORALITY_CUMULATIVE,
              isMonotonic: true,
              dataPoints: samples.map((sample) => ({
                attributes: toMetricAttributes(sample.labels),
                startTimeUnixNano: this.startTimeUnixNano,
                timeUnixNano,
                asDouble: sample.value,
              })),
            },
          });
        } else if (metric instanceof Gauge) {
          const samples = metric.collect();
          if (samples.length === 0) continue;
          metrics.push({
            name: metric.name,
            description: metric.help,
            gauge: {
              dataPoints: samples.map((sample) => ({
                attributes: toMetricAttributes(sample.labels),
                timeUnixNano,
                asDouble: sample.value,
              })),
            },
          });
        } else if (metric instanceof Histogram) {
          const samples = metric.collect();
          if (samples.length === 0) continue;
          const explicitBounds = [...metric.buckets];
          metrics.push({
            name: metric.name,
            description: metric.help,
            histogram: {
              aggregationTemporality: OTLP_AGGREGATION_TEMPORALITY_CUMULATIVE,
              dataPoints: samples.map((sample) => {
                // Convert Prometheus cumulative bucket counts into OTel per-bucket counts
                // of length explicitBounds.length + 1.
                const bucketCounts: string[] = [];
                let prevCumulative = 0;
                for (let i = 0; i < explicitBounds.length; i++) {
                  const cum = sample.cumulativeBucketCounts[i] ?? prevCumulative;
                  const delta = Math.max(0, cum - prevCumulative);
                  bucketCounts.push(String(delta));
                  prevCumulative = cum;
                }
                const overflow = Math.max(0, sample.count - prevCumulative);
                bucketCounts.push(String(overflow));

                return {
                  attributes: toMetricAttributes(sample.labels),
                  startTimeUnixNano: this.startTimeUnixNano,
                  timeUnixNano,
                  count: String(sample.count),
                  sum: sample.sum,
                  bucketCounts,
                  explicitBounds,
                };
              }),
            },
          });
        }
      }
    }

    return {
      resourceMetrics: [
        {
          resource: {
            attributes: toOtlpAttributes(this.resourceAttributes),
          },
          scopeMetrics: [
            {
              scope: {
                name: this.scopeName,
                version: this.scopeVersion,
              },
              metrics,
            },
          ],
        },
      ],
    };
  }

  /**
   * Immediately serializes and POSTs current metrics to the configured OTLP endpoint.
   */
  async flush(registry?: MetricsRegistry): Promise<void> {
    const targetRegistry = registry ?? this.registry;
    if (targetRegistry) {
      const payload = this.buildOtlpPayload(targetRegistry);
      const metricList = payload.resourceMetrics[0]?.scopeMetrics[0]?.metrics ?? [];
      if (metricList.length > 0) {
        const task = this.sendPayload(payload).finally(() => {
          this.inFlight.delete(task);
        });
        this.inFlight.add(task);
        await task;
      }
    }

    if (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  /**
   * Stops the periodic export timer and performs a final graceful flush.
   */
  async shutdown(): Promise<void> {
    if (this.isShutDown) {
      return;
    }
    this.isShutDown = true;
    if (this.flushTimer !== undefined) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
    await this.flush();
  }

  async onModuleDestroy(): Promise<void> {
    await this.shutdown();
  }

  private async sendPayload(
    payload: OtlpExportMetricsServiceRequest,
  ): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    if (
      typeof timer === "object" &&
      timer !== null &&
      "unref" in timer &&
      typeof timer.unref === "function"
    ) {
      timer.unref();
    }

    try {
      const res = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...this.headers,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!res.ok) {
        this.onError?.(
          new Error(`OTLP metrics export failed with HTTP ${res.status}`),
        );
      }
    } catch (err) {
      this.onError?.(err);
    } finally {
      clearTimeout(timer);
    }
  }
}
