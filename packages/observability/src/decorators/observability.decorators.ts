import {
  Injectable,
  Optional,
  createMethodAspectDecorator,
  type MethodAspectContext,
  type MethodAspectHandler,
} from "@bunest/common";
import {
  Counter,
  Histogram,
  MetricsRegistry,
  type MetricLabels,
} from "../metrics/metrics.registry";
import {
  Span as TraceSpan,
  type SpanAttributeValue,
  type SpanData,
  type SpanKind,
} from "../tracing/span";
import {
  traceContextStorage,
  type SpanContext,
} from "../tracing/trace-context";
import { Tracer } from "../tracing/tracer";

export type SpanAttributesMap = Record<string, string | number | boolean>;

export interface SpanDecoratorOptions {
  /** Optional custom span name (defaults to `ClassName.methodName`). */
  name?: string;
  /** OpenTelemetry span kind (defaults to `"INTERNAL"`). */
  kind?: SpanKind;
  /** Static span attributes or dynamic factory computed from method arguments. */
  attributes?: SpanAttributesMap | ((...args: any[]) => SpanAttributesMap);
  /** Whether to record thrown/rejected errors via `span.recordException(err)`. Defaults to `true`. */
  recordException?: boolean;
}

export interface TimedDecoratorOptions {
  metricName?: string;
  labels?: Record<string, string>;
  buckets?: readonly number[];
}

export interface CountedDecoratorOptions {
  metricName?: string;
  labels?: Record<string, string>;
}

/**
 * Dual-purpose `Span` export preserving 100% compatibility with `new Span(...)`,
 * `instanceof Span`, and `Span` type annotations while also allowing `@Span(...)`
 * declarative method/class tracing!
 */
export interface SpanConstructorAndDecorator {
  new (
    name: string,
    kind: SpanKind,
    context: SpanContext,
    resource: Readonly<Record<string, SpanAttributeValue>>,
    onEnd?: (data: SpanData) => void,
    initialAttributes?: Readonly<Record<string, SpanAttributeValue>>,
  ): TraceSpan;
  readonly prototype: TraceSpan;
  (
    name?: string,
    options?: SpanDecoratorOptions,
  ): ClassDecorator & MethodDecorator;
  (options: SpanDecoratorOptions): ClassDecorator & MethodDecorator;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function toSnakeMetricSegment(raw: string): string {
  return raw
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function sanitizeMetricName(raw: string): string {
  const cleaned = raw
    .replace(/[^a-zA-Z0-9_:]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+/, "");
  if (!cleaned) {
    return "method_metric";
  }
  return /^[a-zA-Z_:]/.test(cleaned) ? cleaned : `m_${cleaned}`;
}

function deriveDefaultMetricBase(ctx: MethodAspectContext<unknown>): string {
  const clsPart = toSnakeMetricSegment(ctx.targetClass.name || "service");
  const methodPart = toSnakeMetricSegment(String(ctx.methodName));
  return sanitizeMetricName(`${clsPart}_${methodPart}`);
}

function filterLabelsForMetric(
  allowedLabelNames: readonly string[],
  labels: Record<string, string> | undefined,
): MetricLabels | undefined {
  if (allowedLabelNames.length === 0) {
    return undefined;
  }
  const filtered: Record<string, string> = {};
  for (const name of allowedLabelNames) {
    const val = labels?.[name];
    if (val !== undefined) {
      filtered[name] = val;
    }
  }
  return filtered;
}

function deriveErrorCounterName(invocationMetricName: string): string {
  if (invocationMetricName.endsWith("_total")) {
    return `${invocationMetricName.slice(0, -6)}_errors_total`;
  }
  return `${invocationMetricName}_errors_total`;
}

/**
 * Core Method Aspect handler backing `@Span(...)` and `@Trace(...)`.
 * Propagates active `SpanContext` through `traceContextStorage` and preserves
 * synchronous execution for synchronous service methods.
 */
@Injectable()
export class SpanAspectHandler
  implements MethodAspectHandler<SpanDecoratorOptions>
{
  constructor(@Optional() private readonly tracer?: Tracer) {}

  intercept(ctx: MethodAspectContext<SpanDecoratorOptions>): unknown {
    if (!this.tracer) {
      return ctx.proceed();
    }

    const options = ctx.options ?? {};
    const className = ctx.targetClass.name || "Service";
    const methodStr = String(ctx.methodName);
    const spanName = options.name || `${className}.${methodStr}`;

    const resolvedAttrs =
      typeof options.attributes === "function"
        ? options.attributes(...ctx.args)
        : options.attributes;

    const attributes: Record<string, SpanAttributeValue> = {
      "code.namespace": className,
      "code.function": methodStr,
      ...(resolvedAttrs ?? {}),
    };

    const span = this.tracer.startSpan(spanName, {
      kind: options.kind ?? "INTERNAL",
      attributes,
    });
    const shouldRecordException = options.recordException !== false;

    const finalizeError = (err: unknown): never => {
      if (shouldRecordException) {
        span.recordException(err);
      } else {
        span.setStatus("ERROR", err instanceof Error ? err.message : String(err));
      }
      span.end();
      throw err;
    };

    return traceContextStorage.run(span.context, () => {
      try {
        const result = ctx.proceed();
        if (isPromiseLike(result)) {
          return result.then(
            (value) => {
              if (span.getStatus().code === "UNSET") {
                span.setStatus("OK");
              }
              span.end();
              return value;
            },
            (err) => finalizeError(err),
          );
        }
        if (span.getStatus().code === "UNSET") {
          span.setStatus("OK");
        }
        span.end();
        return result;
      } catch (err) {
        return finalizeError(err);
      }
    });
  }
}

/**
 * Core Method Aspect handler backing `@Timed(metricName?, labels?)`.
 * Records method execution latency in seconds onto a Prometheus `Histogram`.
 */
@Injectable()
export class TimedAspectHandler
  implements MethodAspectHandler<TimedDecoratorOptions>
{
  constructor(@Optional() private readonly registry?: MetricsRegistry) {}

  intercept(ctx: MethodAspectContext<TimedDecoratorOptions>): unknown {
    if (!this.registry) {
      return ctx.proceed();
    }

    const options = ctx.options ?? {};
    const metricName =
      options.metricName ?? `${deriveDefaultMetricBase(ctx)}_duration_seconds`;
    const labelKeys = options.labels ? Object.keys(options.labels) : [];

    const histogram: Histogram = this.registry.createHistogram({
      name: metricName,
      help: `Execution duration in seconds for ${ctx.targetClass.name || "Service"}.${String(ctx.methodName)}`,
      labelNames: labelKeys,
      ...(options.buckets ? { buckets: options.buckets } : {}),
    });

    const observeLabels = filterLabelsForMetric(
      histogram.labelNames,
      options.labels,
    );
    const start = performance.now();

    const recordDuration = () => {
      const durationSec = Math.max(0, (performance.now() - start) / 1000);
      if (observeLabels) {
        histogram.observe(observeLabels, durationSec);
      } else {
        histogram.observe(durationSec);
      }
    };

    try {
      const result = ctx.proceed();
      if (isPromiseLike(result)) {
        return result.then(
          (value) => {
            recordDuration();
            return value;
          },
          (err) => {
            recordDuration();
            throw err;
          },
        );
      }
      recordDuration();
      return result;
    } catch (err) {
      recordDuration();
      throw err;
    }
  }
}

/**
 * Core Method Aspect handler backing `@Counted(metricName?, labels?)`.
 * Increments invocation and error Prometheus `Counter` metrics.
 */
@Injectable()
export class CountedAspectHandler
  implements MethodAspectHandler<CountedDecoratorOptions>
{
  constructor(@Optional() private readonly registry?: MetricsRegistry) {}

  intercept(ctx: MethodAspectContext<CountedDecoratorOptions>): unknown {
    if (!this.registry) {
      return ctx.proceed();
    }

    const options = ctx.options ?? {};
    const invocationMetricName =
      options.metricName ?? `${deriveDefaultMetricBase(ctx)}_total`;
    const errorMetricName = deriveErrorCounterName(invocationMetricName);
    const labelKeys = options.labels ? Object.keys(options.labels) : [];
    const displayTarget = `${ctx.targetClass.name || "Service"}.${String(ctx.methodName)}`;

    const invocationCounter: Counter = this.registry.createCounter({
      name: invocationMetricName,
      help: `Total number of invocations of ${displayTarget}`,
      labelNames: labelKeys,
    });
    const errorCounter: Counter = this.registry.createCounter({
      name: errorMetricName,
      help: `Total number of failed invocations of ${displayTarget}`,
      labelNames: labelKeys,
    });

    const incLabels = filterLabelsForMetric(
      invocationCounter.labelNames,
      options.labels,
    );
    const errLabels = filterLabelsForMetric(
      errorCounter.labelNames,
      options.labels,
    );

    if (incLabels) {
      invocationCounter.inc(incLabels);
    } else {
      invocationCounter.inc();
    }

    const recordError = () => {
      if (errLabels) {
        errorCounter.inc(errLabels);
      } else {
        errorCounter.inc();
      }
    };

    try {
      const result = ctx.proceed();
      if (isPromiseLike(result)) {
        return result.then(
          (value) => value,
          (err) => {
            recordError();
            throw err;
          },
        );
      }
      return result;
    } catch (err) {
      recordError();
      throw err;
    }
  }
}

function createSpanDecorator(
  nameOrOptions?: string | SpanDecoratorOptions,
  options?: SpanDecoratorOptions,
): ClassDecorator & MethodDecorator {
  const normalized: SpanDecoratorOptions =
    typeof nameOrOptions === "string"
      ? { ...(options ?? {}), name: nameOrOptions }
      : { ...(nameOrOptions ?? {}) };
  return createMethodAspectDecorator(SpanAspectHandler, normalized);
}

/**
 * Declaratively wraps a service method (or class) in a distributed trace span
 * managed by `Tracer` with automatic W3C `TraceContextStorage` propagation.
 */
export function Trace(
  name?: string,
  options?: SpanDecoratorOptions,
): ClassDecorator & MethodDecorator;
export function Trace(
  options: SpanDecoratorOptions,
): ClassDecorator & MethodDecorator;
export function Trace(
  nameOrOptions?: string | SpanDecoratorOptions,
  options?: SpanDecoratorOptions,
): ClassDecorator & MethodDecorator {
  return createSpanDecorator(nameOrOptions, options);
}

/**
 * `Span` class (constructible with `new Span(...)` and compatible with `instanceof Span`)
 * AND callable decorator `@Span(name?, options?)` (alias of `@Trace`).
 */
export type Span = TraceSpan;
export const Span: SpanConstructorAndDecorator = new Proxy(TraceSpan, {
  apply(
    _target,
    _thisArg,
    argArray: [string | SpanDecoratorOptions | undefined, SpanDecoratorOptions?],
  ) {
    return createSpanDecorator(argArray[0], argArray[1]);
  },
}) as unknown as SpanConstructorAndDecorator;

export { TraceSpan };

/**
 * Records method execution latency onto a Prometheus `Histogram` in `MetricsRegistry`.
 */
export function Timed(
  metricName?: string,
  labels?: Record<string, string>,
): ClassDecorator & MethodDecorator {
  return createMethodAspectDecorator(TimedAspectHandler, {
    metricName,
    labels,
  });
}

/**
 * Increments invocation and error Prometheus `Counter` metrics in `MetricsRegistry`.
 */
export function Counted(
  metricName?: string,
  labels?: Record<string, string>,
): ClassDecorator & MethodDecorator {
  return createMethodAspectDecorator(CountedAspectHandler, {
    metricName,
    labels,
  });
}
