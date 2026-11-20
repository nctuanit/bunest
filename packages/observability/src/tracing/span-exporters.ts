import {
  spanDataToOtlp,
  toOtlpAttributes,
  type OtlpKeyValue,
  type OtlpSpan,
  type SpanData,
} from "./span";

export interface SpanExporter {
  export(spans: readonly SpanData[]): Promise<void> | void;
  flush?(): Promise<void> | void;
  shutdown?(): Promise<void> | void;
}

export interface OtlpExportTraceServiceRequest {
  resourceSpans: Array<{
    resource: { attributes: OtlpKeyValue[] };
    scopeSpans: Array<{
      scope: { name: string; version: string };
      spans: OtlpSpan[];
    }>;
  }>;
}

/**
 * In-memory span collector for deterministic unit and integration testing.
 */
export class InMemorySpanExporter implements SpanExporter {
  private readonly spans: SpanData[] = [];

  export(spans: readonly SpanData[]): void {
    this.spans.push(...spans);
  }

  getFinishedSpans(): readonly SpanData[] {
    return [...this.spans];
  }

  findByName(name: string): SpanData[] {
    return this.spans.filter((s) => s.name === name);
  }

  findByTraceId(traceId: string): SpanData[] {
    return this.spans.filter((s) => s.traceId === traceId);
  }

  reset(): void {
    this.spans.length = 0;
  }

  shutdown(): void {
    // Keep collected spans inspectable after shutdown unless reset() is called
  }
}

export interface ConsoleSpanExporterOptions {
  pretty?: boolean;
  writer?: (line: string) => void;
}

export class ConsoleSpanExporter implements SpanExporter {
  private readonly pretty: boolean;
  private readonly writer: (line: string) => void;

  constructor(options: ConsoleSpanExporterOptions = {}) {
    this.pretty = options.pretty ?? false;
    this.writer = options.writer ?? ((line) => console.log(line));
  }

  export(spans: readonly SpanData[]): void {
    for (const span of spans) {
      const payload = spanDataToOtlp(span);
      this.writer(
        this.pretty
          ? JSON.stringify(payload, null, 2)
          : JSON.stringify(payload),
      );
    }
  }
}

export interface OtlpHttpSpanExporterOptions {
  endpoint: string;
  headers?: Record<string, string>;
  maxBatchSize?: number;
  flushIntervalMs?: number;
  timeoutMs?: number;
  scopeName?: string;
  scopeVersion?: string;
  fetchImpl?: typeof fetch;
  onError?: (error: unknown) => void;
}

/**
 * Batched non-blocking OTLP/HTTP JSON span exporter compatible with
 * OpenTelemetry Collector, Jaeger, Grafana Tempo, and Honeycomb.
 */
export class OtlpHttpSpanExporter implements SpanExporter {
  private readonly endpoint: string;
  private readonly headers: Record<string, string>;
  private readonly maxBatchSize: number;
  private readonly timeoutMs: number;
  private readonly scopeName: string;
  private readonly scopeVersion: string;
  private readonly fetchImpl: typeof fetch;
  private readonly onError?: (error: unknown) => void;

  private readonly queue: SpanData[] = [];
  private readonly inFlight = new Set<Promise<void>>();
  private flushTimer?: ReturnType<typeof setInterval>;
  private isShutDown = false;

  constructor(options: OtlpHttpSpanExporterOptions) {
    this.endpoint = options.endpoint;
    this.headers = { ...(options.headers ?? {}) };
    this.maxBatchSize = Math.max(1, options.maxBatchSize ?? 50);
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.scopeName = options.scopeName ?? "@bunest/observability";
    this.scopeVersion = options.scopeVersion ?? "0.1.0";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.onError = options.onError;

    const flushIntervalMs = options.flushIntervalMs ?? 5_000;
    if (flushIntervalMs > 0) {
      this.flushTimer = setInterval(() => {
        void this.flush();
      }, flushIntervalMs);
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

  export(spans: readonly SpanData[]): void {
    if (this.isShutDown || spans.length === 0) {
      return;
    }
    this.queue.push(...spans);
    if (this.queue.length >= this.maxBatchSize) {
      void this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.queue.length > 0) {
      const batch = this.queue.splice(0, this.queue.length);
      const task = this.sendBatch(batch).finally(() => {
        this.inFlight.delete(task);
      });
      this.inFlight.add(task);
      await task;
    }

    if (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

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

  buildOtlpPayload(spans: readonly SpanData[]): OtlpExportTraceServiceRequest {
    const firstResource = spans[0]?.resource ?? {};
    return {
      resourceSpans: [
        {
          resource: {
            attributes: toOtlpAttributes(firstResource),
          },
          scopeSpans: [
            {
              scope: {
                name: this.scopeName,
                version: this.scopeVersion,
              },
              spans: spans.map(spanDataToOtlp),
            },
          ],
        },
      ],
    };
  }

  private async sendBatch(batch: readonly SpanData[]): Promise<void> {
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
      const payload = this.buildOtlpPayload(batch);
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
          new Error(`OTLP export failed with HTTP ${res.status}`),
        );
      }
    } catch (err) {
      this.onError?.(err);
    } finally {
      clearTimeout(timer);
    }
  }
}
