import { normalizePattern, type PatternInput } from "../interfaces";
import type {
  Deserializer,
  IncomingEvent,
  PacketMetadata,
  Serializer,
} from "../packets";

export const CLOUD_EVENTS_SPEC_VERSION = "1.0" as const;

/**
 * CloudEvents v1.0 structured JSON representation with W3C Trace Context
 * Distributed Tracing extension (`traceparent` / `tracestate`).
 */
export interface CloudEvent<T = unknown> {
  readonly specversion: "1.0";
  readonly id: string;
  readonly source: string;
  readonly type: string;
  readonly time?: string;
  readonly datacontenttype?: string;
  readonly dataschema?: string;
  readonly subject?: string;
  readonly data?: T;
  /** W3C Trace Context Distributed Tracing extension */
  readonly traceparent?: string;
  /** W3C Trace Context Distributed Tracing extension */
  readonly tracestate?: string;
  /** Additional CloudEvents v1.0 extension attributes */
  readonly [extension: string]: unknown;
}

export interface CloudEventIncomingPacket<T = unknown> extends IncomingEvent {
  readonly id?: string;
  readonly pattern: string;
  readonly data: T;
  readonly cloudEvent?: CloudEvent;
  readonly metadata?: PacketMetadata;
  readonly replyTo?: string;
  readonly error?: unknown;
}

export interface CloudEventsSerializerOptions {
  /**
   * Default CloudEvents `source` URI-reference.
   * @default "urn:bunest:service"
   */
  readonly source?: string;
  /**
   * Default `datacontenttype` MIME media type.
   * @default "application/json"
   */
  readonly dataContentType?: string;
  /**
   * Optional custom event ID generator (defaults to `crypto.randomUUID()`).
   */
  readonly idGenerator?: () => string;
  /**
   * Optional custom ISO-8601 timestamp generator (defaults to `new Date().toISOString()`).
   */
  readonly timeGenerator?: () => string;
  /**
   * Optional callback returning the active W3C `traceparent` header when not
   * explicitly provided on the outgoing packet metadata/headers.
   */
  readonly getTraceparent?: () => string | undefined;
  /**
   * Optional static extension attributes attached to every emitted CloudEvent.
   */
  readonly extensions?: Readonly<Record<string, unknown>>;
}

export interface CloudEventsDeserializerOptions {
  /**
   * Controls the `data` field returned by `CloudEventsDeserializer.deserialize()`:
   * - `"data"` (default): passes `ce.data` directly as handler payload while
   *   attaching full `cloudEvent` and `traceparent` in packet & RPC context metadata.
   * - `"envelope"`: passes `{ data: ce.data, cloudEvent: ce }` directly as payload.
   * @default "data"
   */
  readonly payloadMode?: "data" | "envelope";
}

const utf8Decoder = new TextDecoder();

/**
 * Type guard checking whether `value` conforms to the CloudEvents v1.0
 * structured JSON format (`specversion: "1.0"`, `id`, `source`, `type`).
 */
export function isCloudEvent(value: unknown): value is CloudEvent {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const rec = value as Record<string, unknown>;
  return (
    rec.specversion === CLOUD_EVENTS_SPEC_VERSION &&
    typeof rec.id === "string" &&
    rec.id.length > 0 &&
    typeof rec.source === "string" &&
    rec.source.length > 0 &&
    typeof rec.type === "string" &&
    rec.type.length > 0
  );
}

function findStringHeader(
  record: unknown,
  targetKey: string,
): string | undefined {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return undefined;
  }
  const lower = targetKey.toLowerCase();
  for (const [k, v] of Object.entries(record as Record<string, unknown>)) {
    if (k.toLowerCase() === lower && typeof v === "string" && v.length > 0) {
      return v;
    }
  }
  return undefined;
}

function extractTraceHeader(
  key: "traceparent" | "tracestate",
  rec: Record<string, unknown> | undefined,
  options: Record<string, unknown> | undefined,
): string | undefined {
  if (rec) {
    const direct = findStringHeader(rec, key);
    if (direct) return direct;
    const fromMeta = findStringHeader(rec.metadata, key);
    if (fromMeta) return fromMeta;
    const fromHeaders = findStringHeader(rec.headers, key);
    if (fromHeaders) return fromHeaders;
  }
  if (options) {
    const direct = findStringHeader(options, key);
    if (direct) return direct;
    const fromMeta = findStringHeader(options.metadata, key);
    if (fromMeta) return fromMeta;
    const fromHeaders = findStringHeader(options.headers, key);
    if (fromHeaders) return fromHeaders;
  }
  return undefined;
}

/**
 * Zero-dependency CloudEvents v1.0 structured JSON serializer with automatic
 * W3C `traceparent` / `tracestate` extension propagation.
 */
export class CloudEventsSerializer implements Serializer<unknown, CloudEvent> {
  private readonly source: string;
  private readonly dataContentType: string;
  private readonly idGenerator: () => string;
  private readonly timeGenerator: () => string;
  private readonly getTraceparent?: () => string | undefined;
  private readonly extensions?: Readonly<Record<string, unknown>>;

  constructor(options: CloudEventsSerializerOptions = {}) {
    this.source = options.source ?? "urn:bunest:service";
    this.dataContentType = options.dataContentType ?? "application/json";
    this.idGenerator = options.idGenerator ?? (() => crypto.randomUUID());
    this.timeGenerator = options.timeGenerator ?? (() => new Date().toISOString());
    this.getTraceparent = options.getTraceparent;
    this.extensions = options.extensions;
  }

  serialize(value: unknown, options?: Record<string, unknown>): CloudEvent {
    if (isCloudEvent(value)) {
      const traceparent =
        value.traceparent ??
        extractTraceHeader("traceparent", undefined, options) ??
        this.getTraceparent?.();
      const tracestate =
        value.tracestate ??
        extractTraceHeader("tracestate", undefined, options);
      return {
        ...this.extensions,
        ...value,
        ...(traceparent !== undefined ? { traceparent } : {}),
        ...(tracestate !== undefined ? { tracestate } : {}),
      };
    }

    const isObj =
      value !== null && typeof value === "object" && !Array.isArray(value);
    const rec = isObj ? (value as Record<string, unknown>) : undefined;
    const isPacket =
      rec !== undefined && ("pattern" in rec || "data" in rec || "response" in rec);

    const rawPattern =
      rec?.pattern ?? options?.pattern ?? options?.channel ?? "bunest.event";
    const type =
      typeof rawPattern === "string"
        ? rawPattern
        : normalizePattern(rawPattern as PatternInput);

    const id =
      typeof rec?.id === "string" && rec.id.length > 0
        ? rec.id
        : this.idGenerator();

    const source =
      typeof options?.source === "string" && options.source.length > 0
        ? options.source
        : typeof rec?.source === "string" && rec.source.length > 0
          ? rec.source
          : this.source;

    const dataContentType =
      typeof options?.datacontenttype === "string"
        ? options.datacontenttype
        : this.dataContentType;

    const data = isPacket
      ? "data" in rec!
        ? rec!.data
        : rec!.response
      : value;

    const traceparent =
      extractTraceHeader("traceparent", rec, options) ??
      this.getTraceparent?.();
    const tracestate = extractTraceHeader("tracestate", rec, options);

    const subject =
      typeof options?.subject === "string"
        ? options.subject
        : typeof rec?.subject === "string"
          ? rec.subject
          : undefined;

    const replyTo =
      typeof rec?.replyTo === "string"
        ? rec.replyTo
        : typeof options?.replyTo === "string"
          ? options.replyTo
          : undefined;

    const errorVal = rec?.error ?? rec?.err;

    return {
      ...(this.extensions ?? {}),
      specversion: CLOUD_EVENTS_SPEC_VERSION,
      id,
      source,
      type,
      time: this.timeGenerator(),
      datacontenttype: dataContentType,
      ...(subject !== undefined ? { subject } : {}),
      ...(data !== undefined ? { data } : {}),
      ...(traceparent !== undefined ? { traceparent } : {}),
      ...(tracestate !== undefined ? { tracestate } : {}),
      ...(replyTo !== undefined ? { replyto: replyTo } : {}),
      ...(errorVal !== undefined ? { error: errorVal } : {}),
    };
  }
}

/**
 * Zero-dependency CloudEvents v1.0 structured JSON deserializer supporting
 * W3C `traceparent` extraction, channel fallback, and configurable payload mode
 * (`"data"` vs `"envelope"`).
 */
export class CloudEventsDeserializer implements Deserializer<
  unknown,
  CloudEventIncomingPacket
> {
  private readonly payloadMode: "data" | "envelope";

  constructor(options: CloudEventsDeserializerOptions = {}) {
    this.payloadMode = options.payloadMode ?? "data";
  }

  deserialize(
    value: unknown,
    options?: Record<string, unknown>,
  ): CloudEventIncomingPacket {
    let parsed: unknown = value;
    if (value instanceof Uint8Array) {
      const text = utf8Decoder.decode(value);
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    } else if (typeof value === "string") {
      try {
        parsed = JSON.parse(value);
      } catch {
        parsed = value;
      }
    }

    const fallbackChannel =
      typeof options?.channel === "string" ? options.channel : "";

    if (!isCloudEvent(parsed)) {
      return {
        pattern: fallbackChannel,
        data: parsed,
      };
    }

    const ce = parsed;
    const traceparent =
      ce.traceparent ?? extractTraceHeader("traceparent", undefined, options);
    const tracestate =
      ce.tracestate ?? extractTraceHeader("tracestate", undefined, options);

    const metadata: PacketMetadata = {
      "ce-specversion": ce.specversion,
      "ce-id": ce.id,
      "ce-source": ce.source,
      "ce-type": ce.type,
      ...(typeof ce.time === "string" ? { "ce-time": ce.time } : {}),
      ...(typeof ce.datacontenttype === "string"
        ? { "ce-datacontenttype": ce.datacontenttype }
        : {}),
      ...(typeof ce.subject === "string" ? { "ce-subject": ce.subject } : {}),
      ...(traceparent !== undefined ? { traceparent } : {}),
      ...(tracestate !== undefined ? { tracestate } : {}),
    };

    const payload =
      this.payloadMode === "envelope"
        ? { data: ce.data, cloudEvent: ce }
        : ce.data;

    const replyTo =
      typeof ce.replyto === "string"
        ? ce.replyto
        : typeof ce.replyTo === "string"
          ? ce.replyTo
          : undefined;

    return {
      id: ce.id,
      pattern: ce.type || fallbackChannel,
      data: payload,
      cloudEvent: ce,
      metadata,
      ...(replyTo !== undefined ? { replyTo } : {}),
      ...(ce.error !== undefined ? { error: ce.error } : {}),
    };
  }
}
