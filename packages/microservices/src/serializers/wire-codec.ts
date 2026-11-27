import type { SerializedRpcError } from "../exceptions";
import {
  normalizePattern,
  type PatternInput,
  type RpcEnvelope,
  type RpcEventEnvelope,
  type RpcRequestEnvelope,
  type RpcResponseEnvelope,
  type WireFormat,
} from "../interfaces";
import type { Deserializer, Serializer } from "../packets";
import {
  CloudEventsDeserializer,
  CloudEventsSerializer,
  isCloudEvent,
  type CloudEvent,
} from "./cloudevents.serializer";

const sharedCeSerializer = new CloudEventsSerializer();
const sharedCeDeserializer = new CloudEventsDeserializer();
const utf8Decoder = new TextDecoder();

export type ResponseWireStyle =
  | "bunest"
  | "raw-json"
  | "nest-tcp"
  | "cloudevents";

export type DecodedInboundMessage =
  | {
      readonly kind: "event";
      readonly pattern: string;
      readonly data: unknown;
      readonly cloudEvent?: CloudEvent;
      readonly metadata?: Record<string, unknown>;
    }
  | {
      readonly kind: "request";
      readonly id: string;
      readonly pattern: string;
      readonly data: unknown;
      readonly replyTo?: string;
      readonly cloudEvent?: CloudEvent;
      readonly metadata?: Record<string, unknown>;
      readonly responseWireStyle: ResponseWireStyle;
    }
  | {
      readonly kind: "response";
      readonly id?: string;
      readonly response?: unknown;
      readonly error?: SerializedRpcError;
      readonly isDisposed?: boolean;
    };

export interface DecodedInboundResponse {
  readonly id?: string;
  readonly response?: unknown;
  readonly error?: SerializedRpcError;
  readonly isDisposed?: boolean;
}

export function isBunestEnvelope(value: unknown): value is RpcEnvelope {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const type = (value as { type?: unknown }).type;
  return type === "request" || type === "response" || type === "event";
}

function isSerializedErrorLike(value: unknown): value is SerializedRpcError {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as { message?: unknown }).message === "string"
  );
}

function toSerializedError(err: unknown): SerializedRpcError {
  if (isSerializedErrorLike(err)) {
    return err;
  }
  if (err instanceof Error) {
    return {
      message: err.message,
      name: err.name,
      isRpcException: false,
    };
  }
  return {
    message: typeof err === "string" ? err : JSON.stringify(err),
    isRpcException: false,
  };
}

export function parseRawWireInput(raw: unknown): {
  readonly ok: boolean;
  readonly value: unknown;
  readonly text?: string;
} {
  if (raw instanceof Uint8Array) {
    const text = utf8Decoder.decode(raw);
    try {
      return { ok: true, value: JSON.parse(text), text };
    } catch {
      return { ok: false, value: text, text };
    }
  }
  if (typeof raw === "string") {
    try {
      return { ok: true, value: JSON.parse(raw), text: raw };
    } catch {
      return { ok: false, value: raw, text: raw };
    }
  }
  return { ok: true, value: raw };
}

export function stringifyWirePayload(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Uint8Array) {
    return utf8Decoder.decode(value);
  }
  if (value === undefined) {
    return "null";
  }
  return JSON.stringify(value);
}

export interface DecodeInboundOptions {
  readonly raw: unknown;
  readonly wireFormat: WireFormat;
  readonly deserializer?: Deserializer;
  readonly channel: string;
  readonly replyTo?: string;
  readonly correlationId?: string;
  readonly headers?: Record<string, unknown>;
  readonly isTcp?: boolean;
  readonly allowNonJsonText?: boolean;
  readonly hasMessageHandler: (pattern: string) => boolean;
  readonly hasEventHandler: (pattern: string) => boolean;
  readonly registeredPatterns?: readonly string[];
}

export async function decodeInboundMessage(
  opts: DecodeInboundOptions,
): Promise<DecodedInboundMessage | null> {
  const {
    raw,
    wireFormat,
    deserializer,
    channel,
    replyTo,
    correlationId,
    headers,
    isTcp = false,
    allowNonJsonText = false,
    hasMessageHandler,
    hasEventHandler,
    registeredPatterns,
  } = opts;

  const parsedResult = parseRawWireInput(raw);
  if (!parsedResult.ok) {
    if (deserializer) {
      return await decodeViaCustomDeserializer(
        parsedResult.value,
        deserializer,
        {
          channel,
          replyTo,
          correlationId,
          headers,
          hasMessageHandler,
          hasEventHandler,
          defaultResponseStyle:
            wireFormat === "cloudevents"
              ? "cloudevents"
              : wireFormat === "raw-json"
                ? isTcp
                  ? "nest-tcp"
                  : "raw-json"
                : "bunest",
        },
      );
    }
    if (allowNonJsonText) {
      return {
        kind: "event",
        pattern: channel,
        data: parsedResult.value,
      };
    }
    return null;
  }

  const parsed = parsedResult.value;

  // 1. Default "bunest" wireFormat with no custom deserializer (100% backward-compatible)
  if (wireFormat === "bunest" && !deserializer) {
    if (isBunestEnvelope(parsed)) {
      if (parsed.type === "response") {
        return {
          kind: "response",
          id: parsed.id,
          response: parsed.response,
          error: parsed.error,
          isDisposed: parsed.isDisposed,
        };
      }
      if (parsed.type === "event") {
        return {
          kind: "event",
          pattern: parsed.pattern || channel,
          data: parsed.data,
          metadata: parsed.metadata,
        };
      }
      return {
        kind: "request",
        id: String(parsed.id ?? correlationId ?? ""),
        pattern: parsed.pattern || channel,
        data: parsed.data,
        replyTo: parsed.replyTo ?? replyTo,
        metadata: parsed.metadata,
        responseWireStyle: "bunest",
      };
    }
    if (allowNonJsonText) {
      return {
        kind: "event",
        pattern: channel,
        data: parsed,
      };
    }
    return null;
  }

  // 2. CloudEvents v1.0 wireFormat
  if (wireFormat === "cloudevents") {
    const activeDeserializer = deserializer ?? sharedCeDeserializer;
    const deserialized = (await activeDeserializer.deserialize(parsed, {
      channel,
      headers,
    })) as Record<string, unknown> | null | undefined;

    if (!deserialized || typeof deserialized !== "object") {
      return null;
    }

    const ce = isCloudEvent(parsed)
      ? parsed
      : isCloudEvent(deserialized.cloudEvent)
        ? deserialized.cloudEvent
        : undefined;

    const rawPattern =
      deserialized.pattern !== undefined && deserialized.pattern !== ""
        ? normalizePattern(deserialized.pattern as PatternInput)
        : (ce?.type ?? "");

    // Prefer ce.type if a handler is registered for it; otherwise fall back to channel
    const targetPattern =
      rawPattern &&
      (hasMessageHandler(rawPattern) || hasEventHandler(rawPattern))
        ? rawPattern
        : channel && (hasMessageHandler(channel) || hasEventHandler(channel))
          ? channel
          : rawPattern || channel;

    const metaObj: Record<string, unknown> = {
      ...(deserialized.metadata && typeof deserialized.metadata === "object"
        ? (deserialized.metadata as Record<string, unknown>)
        : {}),
      ...(ce ? { cloudEvent: ce } : {}),
      ...(ce?.traceparent ? { traceparent: ce.traceparent } : {}),
      ...(ce?.tracestate ? { tracestate: ce.tracestate } : {}),
    };

    const resolvedReplyTo =
      replyTo ??
      (typeof deserialized.replyTo === "string"
        ? deserialized.replyTo
        : typeof ce?.replyto === "string"
          ? ce.replyto
          : undefined);

    const id =
      correlationId ??
      (typeof deserialized.id === "string" ? deserialized.id : ce?.id ?? "");

    const payloadData = "data" in deserialized ? deserialized.data : parsed;

    if (
      resolvedReplyTo !== undefined ||
      (hasMessageHandler(targetPattern) && !hasEventHandler(targetPattern))
    ) {
      return {
        kind: "request",
        id,
        pattern: targetPattern,
        data: payloadData,
        replyTo: resolvedReplyTo,
        cloudEvent: ce,
        metadata: metaObj,
        responseWireStyle: "cloudevents",
      };
    }

    return {
      kind: "event",
      pattern: targetPattern,
      data: payloadData,
      cloudEvent: ce,
      metadata: metaObj,
    };
  }

  // 3. Raw JSON cross-language wireFormat
  if (wireFormat === "raw-json") {
    if (deserializer) {
      return await decodeViaCustomDeserializer(parsed, deserializer, {
        channel,
        replyTo,
        correlationId,
        headers,
        hasMessageHandler,
        hasEventHandler,
        defaultResponseStyle: isTcp ? "nest-tcp" : "raw-json",
      });
    }

    if (isTcp) {
      // TCP has no out-of-band channel/topic header: inspect structured raw JSON frames
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        const rec = parsed as Record<string, unknown>;
        if (rec.type === "response") {
          return {
            kind: "response",
            id: typeof rec.id === "string" ? rec.id : undefined,
            response: rec.response,
            error: rec.error as SerializedRpcError | undefined,
            isDisposed: rec.isDisposed as boolean | undefined,
          };
        }

        let resolvedPattern = "";
        let payloadData: unknown = parsed;
        if (rec.pattern !== undefined) {
          resolvedPattern = normalizePattern(rec.pattern as PatternInput);
          payloadData = "data" in rec ? rec.data : parsed;
        } else if (typeof rec.event === "string") {
          resolvedPattern = rec.event;
          payloadData = "data" in rec ? rec.data : parsed;
        } else if (typeof rec.cmd === "string") {
          const objKey = normalizePattern({ cmd: rec.cmd });
          resolvedPattern =
            hasMessageHandler(objKey) || hasEventHandler(objKey)
              ? objKey
              : rec.cmd;
          payloadData = "data" in rec ? rec.data : parsed;
        } else if (registeredPatterns && registeredPatterns.length === 1) {
          resolvedPattern = registeredPatterns[0]!;
        } else if (hasMessageHandler("*") || hasEventHandler("*")) {
          resolvedPattern = "*";
        }

        if (!resolvedPattern) {
          return null;
        }

        const hasExplicitId =
          rec.id !== undefined &&
          (typeof rec.id === "string" || typeof rec.id === "number");
        const isBunestReq = rec.type === "request" && hasExplicitId;
        if (
          isBunestReq ||
          hasExplicitId ||
          (hasMessageHandler(resolvedPattern) && !hasEventHandler(resolvedPattern))
        ) {
          return {
            kind: "request",
            id: hasExplicitId ? String(rec.id) : "",
            pattern: resolvedPattern,
            data: payloadData,
            metadata:
              rec.metadata && typeof rec.metadata === "object"
                ? (rec.metadata as Record<string, unknown>)
                : undefined,
            responseWireStyle: isBunestReq ? "bunest" : "nest-tcp",
          };
        }

        return {
          kind: "event",
          pattern: resolvedPattern,
          data: payloadData,
          metadata:
            rec.metadata && typeof rec.metadata === "object"
              ? (rec.metadata as Record<string, unknown>)
              : undefined,
        };
      }

      if (registeredPatterns && registeredPatterns.length === 1) {
        const onlyPattern = registeredPatterns[0]!;
        if (hasEventHandler(onlyPattern)) {
          return { kind: "event", pattern: onlyPattern, data: parsed };
        }
        return {
          kind: "request",
          id: "",
          pattern: onlyPattern,
          data: parsed,
          responseWireStyle: "nest-tcp",
        };
      }
      return null;
    }

    // Broker / MQTT transport in raw-json mode: dispatch directly by channel/subject/routingKey/topic!
    if (
      replyTo !== undefined ||
      (hasMessageHandler(channel) && !hasEventHandler(channel))
    ) {
      return {
        kind: "request",
        id: correlationId ?? "",
        pattern: channel,
        data: parsed,
        replyTo,
        responseWireStyle: "raw-json",
      };
    }

    return {
      kind: "event",
      pattern: channel,
      data: parsed,
    };
  }

  // 4. Default "bunest" wireFormat WITH a custom deserializer
  return await decodeViaCustomDeserializer(parsed, deserializer!, {
    channel,
    replyTo,
    correlationId,
    headers,
    hasMessageHandler,
    hasEventHandler,
    defaultResponseStyle: isTcp ? "nest-tcp" : "bunest",
  });
}

async function decodeViaCustomDeserializer(
  input: unknown,
  deserializer: Deserializer,
  ctx: {
    readonly channel: string;
    readonly replyTo?: string;
    readonly correlationId?: string;
    readonly headers?: Record<string, unknown>;
    readonly hasMessageHandler: (pattern: string) => boolean;
    readonly hasEventHandler: (pattern: string) => boolean;
    readonly defaultResponseStyle: ResponseWireStyle;
  },
): Promise<DecodedInboundMessage | null> {
  const res = await deserializer.deserialize(input, {
    channel: ctx.channel,
    headers: ctx.headers,
  });

  if (res === null || res === undefined) {
    return null;
  }

  if (isBunestEnvelope(res)) {
    if (res.type === "response") {
      return {
        kind: "response",
        id: res.id,
        response: res.response,
        error: res.error,
        isDisposed: res.isDisposed,
      };
    }
    if (res.type === "event") {
      return {
        kind: "event",
        pattern: res.pattern || ctx.channel,
        data: res.data,
        metadata: res.metadata,
      };
    }
    return {
      kind: "request",
      id: String(res.id ?? ctx.correlationId ?? ""),
      pattern: res.pattern || ctx.channel,
      data: res.data,
      replyTo: res.replyTo ?? ctx.replyTo,
      metadata: res.metadata,
      responseWireStyle: "bunest",
    };
  }

  if (typeof res === "object" && !Array.isArray(res)) {
    const rec = res as Record<string, unknown>;
    const ce = isCloudEvent(rec.cloudEvent) ? rec.cloudEvent : undefined;
    const rawPattern =
      rec.pattern !== undefined && rec.pattern !== ""
        ? normalizePattern(rec.pattern as PatternInput)
        : "";

    const targetPattern =
      rawPattern &&
      (ctx.hasMessageHandler(rawPattern) || ctx.hasEventHandler(rawPattern))
        ? rawPattern
        : ctx.channel &&
            (ctx.hasMessageHandler(ctx.channel) ||
              ctx.hasEventHandler(ctx.channel))
          ? ctx.channel
          : rawPattern || ctx.channel;

    const payloadData = "data" in rec ? rec.data : res;
    const resolvedReplyTo =
      ctx.replyTo ??
      (typeof rec.replyTo === "string" ? rec.replyTo : undefined);
    const metaObj: Record<string, unknown> | undefined =
      rec.metadata || ce
        ? {
            ...(rec.metadata && typeof rec.metadata === "object"
              ? (rec.metadata as Record<string, unknown>)
              : {}),
            ...(ce ? { cloudEvent: ce } : {}),
            ...(ce?.traceparent ? { traceparent: ce.traceparent } : {}),
          }
        : undefined;

    const hasId =
      rec.id !== undefined &&
      (typeof rec.id === "string" || typeof rec.id === "number");

    if (
      resolvedReplyTo !== undefined ||
      (ctx.hasMessageHandler(targetPattern) &&
        !ctx.hasEventHandler(targetPattern))
    ) {
      return {
        kind: "request",
        id: hasId ? String(rec.id) : (ctx.correlationId ?? ""),
        pattern: targetPattern,
        data: payloadData,
        replyTo: resolvedReplyTo,
        cloudEvent: ce,
        metadata: metaObj,
        responseWireStyle: ce ? "cloudevents" : ctx.defaultResponseStyle,
      };
    }

    return {
      kind: "event",
      pattern: targetPattern,
      data: payloadData,
      cloudEvent: ce,
      metadata: metaObj,
    };
  }

  if (ctx.hasMessageHandler(ctx.channel) && !ctx.hasEventHandler(ctx.channel)) {
    return {
      kind: "request",
      id: ctx.correlationId ?? "",
      pattern: ctx.channel,
      data: res,
      replyTo: ctx.replyTo,
      responseWireStyle: ctx.defaultResponseStyle,
    };
  }

  return {
    kind: "event",
    pattern: ctx.channel,
    data: res,
  };
}

export async function encodeOutboundEvent(opts: {
  readonly pattern: string;
  readonly data: unknown;
  readonly wireFormat: WireFormat;
  readonly serializer?: Serializer;
  readonly metadata?: Record<string, unknown>;
  readonly headers?: Record<string, unknown>;
  readonly includeHeadersInEnvelope?: boolean;
  readonly isTcp?: boolean;
}): Promise<unknown> {
  const {
    pattern,
    data,
    wireFormat,
    serializer,
    metadata,
    headers,
    includeHeadersInEnvelope = false,
    isTcp,
  } = opts;

  if (serializer) {
    return await serializer.serialize(
      {
        pattern,
        data,
        ...(metadata !== undefined ? { metadata } : {}),
        ...(headers !== undefined ? { headers } : {}),
      },
      { pattern, channel: pattern },
    );
  }

  if (wireFormat === "cloudevents") {
    return sharedCeSerializer.serialize(
      {
        pattern,
        data,
        ...(metadata !== undefined ? { metadata } : {}),
        ...(headers !== undefined ? { headers } : {}),
      },
      { pattern, channel: pattern },
    );
  }

  if (wireFormat === "raw-json") {
    return isTcp ? { pattern, data } : data;
  }

  const envelope: RpcEventEnvelope & { headers?: Record<string, unknown> } = {
    type: "event",
    pattern,
    data,
    ...(metadata !== undefined ? { metadata } : {}),
    ...(includeHeadersInEnvelope && headers !== undefined ? { headers } : {}),
  };
  return envelope;
}

export async function encodeOutboundRequest(opts: {
  readonly id: string;
  readonly pattern: string;
  readonly data: unknown;
  readonly wireFormat: WireFormat;
  readonly serializer?: Serializer;
  readonly replyTo?: string;
  readonly metadata?: Record<string, unknown>;
  readonly headers?: Record<string, unknown>;
  readonly includeHeadersInEnvelope?: boolean;
  readonly isTcp?: boolean;
}): Promise<unknown> {
  const {
    id,
    pattern,
    data,
    wireFormat,
    serializer,
    replyTo,
    metadata,
    headers,
    includeHeadersInEnvelope = false,
    isTcp,
  } = opts;

  if (serializer) {
    return await serializer.serialize(
      {
        id,
        pattern,
        data,
        ...(replyTo !== undefined ? { replyTo } : {}),
        ...(metadata !== undefined ? { metadata } : {}),
        ...(headers !== undefined ? { headers } : {}),
      },
      { pattern, channel: pattern, replyTo },
    );
  }

  if (wireFormat === "cloudevents") {
    return sharedCeSerializer.serialize(
      {
        id,
        pattern,
        data,
        ...(replyTo !== undefined ? { replyTo } : {}),
        ...(metadata !== undefined ? { metadata } : {}),
        ...(headers !== undefined ? { headers } : {}),
      },
      { pattern, channel: pattern, replyTo },
    );
  }

  if (wireFormat === "raw-json") {
    return isTcp ? { pattern, data, id } : data;
  }

  const envelope: RpcRequestEnvelope & { headers?: Record<string, unknown> } = {
    type: "request",
    id,
    pattern,
    data,
    ...(replyTo !== undefined ? { replyTo } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
    ...(includeHeadersInEnvelope && headers !== undefined ? { headers } : {}),
  };
  return envelope;
}

export async function encodeOutboundResponse(opts: {
  readonly id: string;
  readonly pattern: string;
  readonly response?: unknown;
  readonly error?: SerializedRpcError;
  readonly isDisposed?: boolean;
  readonly wireFormat: WireFormat;
  readonly responseWireStyle?: ResponseWireStyle;
  readonly serializer?: Serializer;
}): Promise<unknown> {
  const {
    id,
    pattern,
    response,
    error,
    isDisposed = true,
    wireFormat,
    responseWireStyle,
    serializer,
  } = opts;

  if (serializer) {
    return await serializer.serialize(
      {
        id,
        pattern: `${pattern}.response`,
        response,
        data: response,
        ...(error !== undefined ? { error, err: error } : {}),
        isDisposed,
      },
      { pattern: `${pattern}.response`, response: true },
    );
  }

  const effectiveStyle =
    responseWireStyle ??
    (wireFormat === "cloudevents"
      ? "cloudevents"
      : wireFormat === "raw-json"
        ? "raw-json"
        : "bunest");

  if (effectiveStyle === "cloudevents") {
    return sharedCeSerializer.serialize(
      {
        id,
        pattern: `${pattern}.response`,
        data: response,
        ...(error !== undefined ? { error } : {}),
      },
      { pattern: `${pattern}.response` },
    );
  }

  if (effectiveStyle === "raw-json") {
    if (error !== undefined) {
      return { error };
    }
    return response;
  }

  if (effectiveStyle === "nest-tcp") {
    return {
      id,
      ...(response !== undefined ? { response } : {}),
      ...(error !== undefined ? { err: error, error } : {}),
      isDisposed,
    };
  }

  const envelope: RpcResponseEnvelope = {
    type: "response",
    id,
    response,
    error,
    isDisposed,
  };
  return envelope;
}

export async function decodeInboundResponse(opts: {
  readonly raw: unknown;
  readonly wireFormat: WireFormat;
  readonly deserializer?: Deserializer;
  readonly fallbackId?: string;
}): Promise<DecodedInboundResponse | null> {
  const { raw, wireFormat, deserializer, fallbackId } = opts;

  const parsedResult = parseRawWireInput(raw);
  if (!parsedResult.ok) {
    if (deserializer) {
      const res = await deserializer.deserialize(parsedResult.value);
      return normalizeDeserializedResponse(res, fallbackId);
    }
    return null;
  }

  const parsed = parsedResult.value;

  if (deserializer) {
    const res = await deserializer.deserialize(parsed);
    return normalizeDeserializedResponse(res, fallbackId);
  }

  if (wireFormat === "bunest") {
    if (!isBunestEnvelope(parsed) || parsed.type !== "response") {
      return null;
    }
    return {
      id: parsed.id,
      response: parsed.response,
      error: parsed.error,
      isDisposed: parsed.isDisposed,
    };
  }

  if (wireFormat === "cloudevents") {
    if (isCloudEvent(parsed)) {
      return {
        id: parsed.id || fallbackId,
        response: parsed.data,
        error:
          parsed.error !== undefined
            ? toSerializedError(parsed.error)
            : undefined,
        isDisposed: true,
      };
    }
    if (isBunestEnvelope(parsed) && parsed.type === "response") {
      return {
        id: parsed.id || fallbackId,
        response: parsed.response,
        error: parsed.error,
        isDisposed: parsed.isDisposed,
      };
    }
    return {
      id: fallbackId,
      response: parsed,
      isDisposed: true,
    };
  }

  // wireFormat === "raw-json"
  if (isBunestEnvelope(parsed) && parsed.type === "response") {
    return {
      id: parsed.id || fallbackId,
      response: parsed.response,
      error: parsed.error,
      isDisposed: parsed.isDisposed,
    };
  }

  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    const rec = parsed as Record<string, unknown>;
    if (
      rec.id !== undefined &&
      ("response" in rec || "err" in rec || "error" in rec || "isDisposed" in rec)
    ) {
      const rawErr = rec.error ?? rec.err;
      return {
        id: String(rec.id),
        response: rec.response,
        error: rawErr !== undefined ? toSerializedError(rawErr) : undefined,
        isDisposed:
          typeof rec.isDisposed === "boolean" ? rec.isDisposed : true,
      };
    }
    const keys = Object.keys(rec);
    if (
      keys.length === 1 &&
      keys[0] === "error" &&
      isSerializedErrorLike(rec.error)
    ) {
      return {
        id: fallbackId,
        error: rec.error,
        isDisposed: true,
      };
    }
  }

  return {
    id: fallbackId,
    response: parsed,
    isDisposed: true,
  };
}

function normalizeDeserializedResponse(
  res: unknown,
  fallbackId?: string,
): DecodedInboundResponse | null {
  if (res === null || res === undefined) {
    return null;
  }
  if (isBunestEnvelope(res) && res.type === "response") {
    return {
      id: res.id || fallbackId,
      response: res.response,
      error: res.error,
      isDisposed: res.isDisposed,
    };
  }
  if (isCloudEvent(res)) {
    return {
      id: res.id || fallbackId,
      response: res.data,
      error:
        res.error !== undefined ? toSerializedError(res.error) : undefined,
      isDisposed: true,
    };
  }
  if (typeof res === "object" && !Array.isArray(res)) {
    const rec = res as Record<string, unknown>;
    const rawErr = rec.error ?? rec.err;
    const hasResponseField = "response" in rec;
    const hasDataField = "data" in rec;
    return {
      id:
        typeof rec.id === "string" || typeof rec.id === "number"
          ? String(rec.id)
          : fallbackId,
      response: hasResponseField
        ? rec.response
        : hasDataField
          ? rec.data
          : res,
      error: rawErr !== undefined ? toSerializedError(rawErr) : undefined,
      isDisposed: typeof rec.isDisposed === "boolean" ? rec.isDisposed : true,
    };
  }
  return {
    id: fallbackId,
    response: res,
    isDisposed: true,
  };
}
