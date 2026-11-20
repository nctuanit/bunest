import type {
  CustomMetric,
  JobSnapshot,
  NodeRuntimeMetrics,
  ObserveModuleOptionsWithDefaults,
  RequestSnapshot,
} from "../interfaces/observe-types";
import { w3cSpanIdOf, w3cTraceIdOf } from "../utils/trace-context.util";

export class ObserveAgentSharedBuffer {
  private readonly traces: Array<RequestSnapshot | JobSnapshot> = [];
  private readonly metrics = new Map<string, CustomMetric<any>>();
  private readonly runtimeSamples: NodeRuntimeMetrics[] = [];
  private reporting = false;
  private options?: ObserveModuleOptionsWithDefaults;
  private flushTimer?: ReturnType<typeof setInterval>;

  configure(options: ObserveModuleOptionsWithDefaults): void {
    this.options = options;
    this.reporting = options.enabled !== false;
  }

  isReporting(): boolean {
    return this.reporting;
  }

  pushTrace(snapshot: RequestSnapshot | JobSnapshot): void {
    if (!this.reporting) return;
    const maxBatch = Math.min(5000, this.options?.maxTracesPerBatch ?? 1000);
    if (this.traces.length >= maxBatch) {
      this.traces.shift();
    }
    this.traces.push(snapshot);
  }

  registerMetric(metric: CustomMetric<any>): void {
    this.metrics.set(metric.name, metric);
  }

  pushRuntimeMetrics(sample: NodeRuntimeMetrics): void {
    if (!this.reporting) return;
    this.runtimeSamples.push(sample);
    if (this.runtimeSamples.length > 60) {
      this.runtimeSamples.shift();
    }
  }

  getBufferedTraces(): ReadonlyArray<RequestSnapshot | JobSnapshot> {
    return this.traces;
  }

  getBufferedRuntimeMetrics(): ReadonlyArray<NodeRuntimeMetrics> {
    return this.runtimeSamples;
  }

  startPeriodicFlush(): void {
    if (!this.reporting || this.flushTimer) return;
    const interval = this.options?.flushInterval ?? 5000;
    if (interval <= 0) return;
    this.flushTimer = setInterval(() => {
      void this.flush().catch(() => {});
    }, interval);
    this.flushTimer.unref?.();
  }

  stopPeriodicFlush(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
  }

  async flush(): Promise<void> {
    if (!this.reporting || !this.options) return;
    const tracesToSend = this.traces.splice(0, this.traces.length);
    const runtimeToSend = this.runtimeSamples.splice(
      0,
      this.runtimeSamples.length,
    );
    const metricsList = [...this.metrics.values()];

    if (
      tracesToSend.length === 0 &&
      runtimeToSend.length === 0 &&
      metricsList.length === 0
    ) {
      return;
    }

    const endpoint =
      this.options.endpoint ?? process.env.OBSERVE_ENDPOINT;
    const appKey = this.options.appKey ?? process.env.OBSERVE_APP_KEY;
    const appSecret = this.options.appSecret ?? process.env.OBSERVE_APP_SECRET;

    if (endpoint && (appKey || !endpoint.includes("observe-api.nestjs.com"))) {
      try {
        const headers: Record<string, string> = {
          "content-type": "application/json",
        };
        if (appKey) headers["x-api-key"] = appKey;
        if (appSecret) headers["x-api-secret"] = appSecret;

        const res = await fetch(`${endpoint.replace(/\/+$/, "")}/v1/ingest`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            serviceId: this.options.serviceId,
            serviceVersion: this.options.serviceVersion || undefined,
            traces: tracesToSend,
            metrics: metricsList.map((m) => ({
              name: m.name,
              type: m.type,
              description: m.description,
              value: m.value,
              increase: m.increase,
              p50: m.p50,
              p95: m.p95,
              p99: m.p99,
              observations: m.observations,
              total: m.total,
              maximum: m.maximum,
              tags: m.tags,
              lastUpdated: m.lastUpdated,
            })),
            runtimeMetrics: runtimeToSend,
          }),
        });
        if (res.ok) {
          for (const m of metricsList) {
            if (
              "markFlushed" in m &&
              typeof (m as { markFlushed?: () => void }).markFlushed ===
                "function"
            ) {
              (m as { markFlushed: () => void }).markFlushed();
            }
          }
        }
      } catch {
        // Swallow network errors to never impact host application
      }
    }

    if (this.options.otlp && this.options.openTelemetry && tracesToSend.length > 0) {
      const otlpCfg =
        typeof this.options.otlp === "object" ? this.options.otlp : {};
      const base =
        otlpCfg.endpoint ??
        process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ??
        process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??
        "http://localhost:4318";
      const targetUrl = base.endsWith("/v1/traces")
        ? base
        : `${base.replace(/\/+$/, "")}/v1/traces`;

      const spans = tracesToSend.map((snap) => ({
        traceId: w3cTraceIdOf(snap.traceId),
        spanId: w3cSpanIdOf(snap.traceId),
        name: "protocol" in snap ? (snap.operationId ?? snap.protocol) : snap.name,
        kind: "protocol" in snap ? 2 : 5,
        startTimeUnixNano: String(
          Math.floor((Date.parse(snap.calledAt ?? new Date().toISOString())) * 1_000_000),
        ),
        endTimeUnixNano: String(
          Math.floor(
            (Date.parse(snap.calledAt ?? new Date().toISOString()) +
              (snap.duration ?? 0)) *
              1_000_000,
          ),
        ),
        attributes: [
          {
            key: "service.name",
            value: { stringValue: otlpCfg.serviceName ?? this.options!.serviceId },
          },
        ],
      }));

      await fetch(targetUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(otlpCfg.headers ?? {}),
        },
        body: JSON.stringify({
          resourceSpans: [
            {
              resource: {
                attributes: [
                  {
                    key: "service.name",
                    value: {
                      stringValue: otlpCfg.serviceName ?? this.options.serviceId,
                    },
                  },
                ],
              },
              scopeSpans: [
                {
                  scope: { name: "@bunest/observe" },
                  spans,
                },
              ],
            },
          ],
        }),
      }).catch(() => {});
    }
  }
}
