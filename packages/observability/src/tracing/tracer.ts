import {
  Inject,
  Injectable,
  Optional,
  type OnModuleDestroy,
} from "@bunest/core";
import {
  Span,
  type SpanAttributeValue,
  type SpanData,
  type SpanKind,
} from "./span";
import type { SpanExporter } from "./span-exporters";
import {
  generateSpanId,
  generateTraceId,
  traceContextStorage,
  type SpanContext,
} from "./trace-context";

export const TRACER_OPTIONS = Symbol.for("bunest:observability:tracer_options");

export interface TracerOptions {
  serviceName?: string;
  serviceVersion?: string;
  exporter?: SpanExporter;
  exporters?: readonly SpanExporter[];
  resourceAttributes?: Readonly<Record<string, SpanAttributeValue>>;
  sampler?: (input: { name: string; parentContext?: SpanContext }) => boolean;
}

export interface StartSpanOptions {
  kind?: SpanKind;
  attributes?: Readonly<Record<string, SpanAttributeValue>>;
  parentContext?: SpanContext;
  requestId?: string;
}

/**
 * Distributed tracer producing OpenTelemetry-compatible spans and propagating
 * active W3C SpanContext through `TraceContextStorage`.
 */
@Injectable()
export class Tracer implements OnModuleDestroy {
  private readonly exporters: SpanExporter[];
  private readonly resource: Readonly<Record<string, SpanAttributeValue>>;
  private readonly sampler?: TracerOptions["sampler"];

  constructor(
    @Optional()
    @Inject(TRACER_OPTIONS)
    options: TracerOptions = {},
  ) {
    const list: SpanExporter[] = [];
    if (options.exporter) {
      list.push(options.exporter);
    }
    if (options.exporters) {
      list.push(...options.exporters);
    }
    this.exporters = list;
    this.sampler = options.sampler;
    this.resource = {
      "service.name": options.serviceName ?? "bunest-service",
      ...(options.serviceVersion
        ? { "service.version": options.serviceVersion }
        : {}),
      ...(options.resourceAttributes ?? {}),
    };
  }

  addExporter(exporter: SpanExporter): void {
    this.exporters.push(exporter);
  }

  startSpan(name: string, options: StartSpanOptions = {}): Span {
    const parent =
      options.parentContext ?? traceContextStorage.getCurrentSpanContext();
    const traceId = parent?.traceId ?? generateTraceId();
    const spanId = generateSpanId();
    let sampled: boolean;
    if (this.sampler) {
      try {
        sampled = Boolean(this.sampler({ name, parentContext: parent }));
      } catch {
        sampled = false;
      }
    } else {
      sampled = parent?.sampled ?? true;
    }
    const traceFlags = sampled ? 0x01 : 0x00;

    const context: SpanContext = {
      traceId,
      spanId,
      parentSpanId: parent?.spanId,
      traceFlags,
      sampled,
      traceState: parent?.traceState,
      baggage: parent?.baggage,
      requestId: options.requestId ?? parent?.requestId,
    };

    const onEnd = (data: SpanData) => {
      if (!sampled) {
        return;
      }
      for (const exporter of this.exporters) {
        try {
          void Promise.resolve(exporter.export([data])).catch(() => {});
        } catch {
          // Never crash application code on telemetry export errors
        }
      }
    };

    return new Span(
      name,
      options.kind ?? "INTERNAL",
      context,
      this.resource,
      onEnd,
      options.attributes,
    );
  }

  async startActiveSpan<T>(
    name: string,
    fn: (span: Span) => T | Promise<T>,
  ): Promise<T>;
  async startActiveSpan<T>(
    name: string,
    options: StartSpanOptions,
    fn: (span: Span) => T | Promise<T>,
  ): Promise<T>;
  async startActiveSpan<T>(
    name: string,
    optionsOrFn: StartSpanOptions | ((span: Span) => T | Promise<T>),
    maybeFn?: (span: Span) => T | Promise<T>,
  ): Promise<T> {
    const options = typeof optionsOrFn === "function" ? {} : optionsOrFn;
    const fn = typeof optionsOrFn === "function" ? optionsOrFn : maybeFn!;

    const span = this.startSpan(name, options);
    return traceContextStorage.run(span.context, async () => {
      try {
        const result = await fn(span);
        if (span.getStatus().code === "UNSET") {
          span.setStatus("OK");
        }
        return result;
      } catch (err) {
        span.recordException(err);
        throw err;
      } finally {
        span.end();
      }
    });
  }

  async flush(): Promise<void> {
    await Promise.all(
      this.exporters.map((exp) => Promise.resolve(exp.flush?.())),
    );
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all(
      this.exporters.map((exp) => Promise.resolve(exp.shutdown?.())),
    );
  }
}
