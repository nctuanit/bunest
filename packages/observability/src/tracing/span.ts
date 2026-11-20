import type { SpanContext } from "./trace-context";

export type SpanKind = "INTERNAL" | "SERVER" | "CLIENT" | "PRODUCER" | "CONSUMER";
export type SpanStatusCode = "UNSET" | "OK" | "ERROR";

export type SpanAttributeValue =
  | string
  | number
  | boolean
  | readonly string[]
  | readonly number[]
  | readonly boolean[];

export interface SpanEvent {
  readonly name: string;
  readonly timeUnixNano: string;
  readonly attributes?: Readonly<Record<string, SpanAttributeValue>>;
}

export interface SpanStatus {
  readonly code: SpanStatusCode;
  readonly message?: string;
}

export interface SpanData {
  readonly name: string;
  readonly kind: SpanKind;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly traceFlags: number;
  readonly startTimeUnixNano: string;
  readonly endTimeUnixNano: string;
  readonly durationMs: number;
  readonly attributes: Readonly<Record<string, SpanAttributeValue>>;
  readonly events: readonly SpanEvent[];
  readonly status: SpanStatus;
  readonly resource: Readonly<Record<string, SpanAttributeValue>>;
}

export interface OtlpAnyValue {
  stringValue?: string;
  intValue?: string;
  doubleValue?: number;
  boolValue?: boolean;
  arrayValue?: { values: OtlpAnyValue[] };
}

export interface OtlpKeyValue {
  key: string;
  value: OtlpAnyValue;
}

export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpKeyValue[];
  events: Array<{
    timeUnixNano: string;
    name: string;
    attributes: OtlpKeyValue[];
  }>;
  status: {
    code: number;
    message?: string;
  };
}

const SPAN_KIND_OTLP: Record<SpanKind, number> = {
  INTERNAL: 1,
  SERVER: 2,
  CLIENT: 3,
  PRODUCER: 4,
  CONSUMER: 5,
};

const SPAN_STATUS_OTLP: Record<SpanStatusCode, number> = {
  UNSET: 0,
  OK: 1,
  ERROR: 2,
};

function toOtlpAnyValue(val: SpanAttributeValue): OtlpAnyValue {
  if (typeof val === "string") {
    return { stringValue: val };
  }
  if (typeof val === "boolean") {
    return { boolValue: val };
  }
  if (typeof val === "number") {
    return Number.isInteger(val)
      ? { intValue: String(val) }
      : { doubleValue: val };
  }
  return {
    arrayValue: {
      values: val.map((item) => toOtlpAnyValue(item)),
    },
  };
}

export function toOtlpAttributes(
  attrs: Readonly<Record<string, SpanAttributeValue>>,
): OtlpKeyValue[] {
  return Object.entries(attrs).map(([key, value]) => ({
    key,
    value: toOtlpAnyValue(value),
  }));
}

export function spanDataToOtlp(span: SpanData): OtlpSpan {
  return {
    traceId: span.traceId,
    spanId: span.spanId,
    ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
    name: span.name,
    kind: SPAN_KIND_OTLP[span.kind],
    startTimeUnixNano: span.startTimeUnixNano,
    endTimeUnixNano: span.endTimeUnixNano,
    attributes: toOtlpAttributes(span.attributes),
    events: span.events.map((ev) => ({
      timeUnixNano: ev.timeUnixNano,
      name: ev.name,
      attributes: ev.attributes ? toOtlpAttributes(ev.attributes) : [],
    })),
    status: {
      code: SPAN_STATUS_OTLP[span.status.code],
      ...(span.status.message ? { message: span.status.message } : {}),
    },
  };
}

function nowUnixNanoString(epochMs: number): string {
  return (BigInt(Math.round(epochMs * 1_000)) * 1_000n).toString();
}

export class Span {
  public readonly context: SpanContext;
  private readonly attributes: Record<string, SpanAttributeValue> = {};
  private readonly events: SpanEvent[] = [];
  private readonly startEpochMs: number;
  private readonly startPerfMs: number;
  private endEpochMs?: number;
  private durationMs = 0;
  private status: SpanStatus = { code: "UNSET" };
  private ended = false;
  private finalData?: SpanData;

  constructor(
    public name: string,
    public readonly kind: SpanKind,
    context: SpanContext,
    private readonly resource: Readonly<Record<string, SpanAttributeValue>>,
    private readonly onEnd?: (data: SpanData) => void,
    initialAttributes?: Readonly<Record<string, SpanAttributeValue>>,
  ) {
    this.context = context;
    this.startEpochMs = Date.now();
    this.startPerfMs = performance.now();
    if (initialAttributes) {
      Object.assign(this.attributes, initialAttributes);
    }
  }

  get traceId(): string {
    return this.context.traceId;
  }

  get spanId(): string {
    return this.context.spanId;
  }

  get parentSpanId(): string | undefined {
    return this.context.parentSpanId;
  }

  setAttribute(key: string, value: SpanAttributeValue): this {
    if (!this.ended) {
      this.attributes[key] = value;
    }
    return this;
  }

  setAttributes(attrs: Readonly<Record<string, SpanAttributeValue>>): this {
    if (!this.ended) {
      Object.assign(this.attributes, attrs);
    }
    return this;
  }

  addEvent(
    name: string,
    attributes?: Readonly<Record<string, SpanAttributeValue>>,
  ): this {
    if (!this.ended) {
      this.events.push({
        name,
        timeUnixNano: nowUnixNanoString(Date.now()),
        attributes: attributes ? { ...attributes } : undefined,
      });
    }
    return this;
  }

  recordException(error: unknown): this {
    if (this.ended) {
      return this;
    }
    const isErr = error instanceof Error;
    const message = isErr ? error.message : String(error);
    const attrs: Record<string, SpanAttributeValue> = {
      "exception.type": isErr ? error.name : typeof error,
      "exception.message": message,
    };
    if (isErr && error.stack) {
      attrs["exception.stacktrace"] = error.stack;
    }
    this.addEvent("exception", attrs);
    this.setStatus("ERROR", message);
    return this;
  }

  setStatus(code: SpanStatusCode, message?: string): this {
    if (!this.ended) {
      this.status = message ? { code, message } : { code };
    }
    return this;
  }

  getStatus(): SpanStatus {
    return this.status;
  }

  isEnded(): boolean {
    return this.ended;
  }

  end(endTimeMs?: number): SpanData {
    if (this.ended && this.finalData) {
      return this.finalData;
    }
    this.ended = true;
    const elapsed = Math.max(0, performance.now() - this.startPerfMs);
    this.durationMs = elapsed;
    this.endEpochMs = endTimeMs ?? this.startEpochMs + elapsed;

    const data: SpanData = {
      name: this.name,
      kind: this.kind,
      traceId: this.context.traceId,
      spanId: this.context.spanId,
      parentSpanId: this.context.parentSpanId,
      traceFlags: this.context.traceFlags,
      startTimeUnixNano: nowUnixNanoString(this.startEpochMs),
      endTimeUnixNano: nowUnixNanoString(this.endEpochMs),
      durationMs: this.durationMs,
      attributes: { ...this.attributes },
      events: [...this.events],
      status: { ...this.status },
      resource: { ...this.resource },
    };

    this.finalData = data;
    this.onEnd?.(data);
    return data;
  }

  toSpanData(): SpanData {
    if (this.finalData) {
      return this.finalData;
    }
    const nowMs = Date.now();
    return {
      name: this.name,
      kind: this.kind,
      traceId: this.context.traceId,
      spanId: this.context.spanId,
      parentSpanId: this.context.parentSpanId,
      traceFlags: this.context.traceFlags,
      startTimeUnixNano: nowUnixNanoString(this.startEpochMs),
      endTimeUnixNano: nowUnixNanoString(nowMs),
      durationMs: Math.max(0, performance.now() - this.startPerfMs),
      attributes: { ...this.attributes },
      events: [...this.events],
      status: { ...this.status },
      resource: { ...this.resource },
    };
  }

  toOtlpSpan(): OtlpSpan {
    return spanDataToOtlp(this.toSpanData());
  }
}
