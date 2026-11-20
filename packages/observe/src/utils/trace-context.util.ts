import { createHash } from "node:crypto";
import {
  formatTraceParent,
  generateSpanId,
  parseTraceParent,
} from "@bunest/observability";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX32_RE = /^[0-9a-f]{32}$/i;

export interface TraceContext {
  traceId: string;
  parentSpanId: string;
  sampled: boolean;
}

export function hex32ToUuid(hex: string): string {
  const lower = hex.toLowerCase();
  return `${lower.slice(0, 8)}-${lower.slice(8, 12)}-${lower.slice(12, 16)}-${lower.slice(16, 20)}-${lower.slice(20, 32)}`;
}

/** Converts an Observe trace ID (UUID, 32-hex, or arbitrary string) into a W3C 32-hex trace ID. */
export function w3cTraceIdOf(traceId: string): string {
  if (UUID_RE.test(traceId)) {
    return traceId.replace(/-/g, "").toLowerCase();
  }
  if (HEX32_RE.test(traceId)) {
    return traceId.toLowerCase();
  }
  return createHash("sha256").update(traceId, "utf8").digest("hex").slice(0, 32);
}

/** Converts an Observe span ID into a W3C 16-hex span ID (low 64 bits for UUIDv7). */
export function w3cSpanIdOf(spanId: string): string {
  if (UUID_RE.test(spanId)) {
    return spanId.replace(/-/g, "").toLowerCase().slice(16, 32);
  }
  return createHash("sha256").update(spanId, "utf8").digest("hex").slice(0, 16);
}

export function randomSpanId(): string {
  return generateSpanId();
}

export function formatTraceparent(
  traceId: string,
  spanId: string,
  sampled: boolean,
): string {
  return formatTraceParent({
    traceId: w3cTraceIdOf(traceId),
    spanId: spanId.length === 16 ? spanId : w3cSpanIdOf(spanId),
    traceFlags: sampled ? 1 : 0,
  });
}

function readHeaderValue(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== "object") {
    return undefined;
  }
  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }
  const rec = headers as Record<string, unknown>;
  const direct = rec[name] ?? rec[name.toLowerCase()];
  if (typeof direct === "string") {
    return direct;
  }
  return undefined;
}

export function readTraceContext(headers: unknown): TraceContext | undefined {
  const raw = readHeaderValue(headers, "traceparent");
  if (!raw) {
    return undefined;
  }
  const parsed = parseTraceParent(raw);
  if (!parsed) {
    return undefined;
  }
  return {
    traceId: parsed.traceId,
    parentSpanId: parsed.spanId,
    sampled: (parsed.traceFlags & 1) === 1,
  };
}

export function inboundTraceId(headers: unknown): string | undefined {
  const ctx = readTraceContext(headers);
  if (!ctx) {
    return undefined;
  }
  return hex32ToUuid(ctx.traceId);
}
