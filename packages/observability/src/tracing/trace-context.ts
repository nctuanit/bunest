import { ContextStorage as AsyncLocalStorage } from "@bunest/core";

export interface ParsedTraceParent {
  readonly version: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly traceFlags: number;
  readonly sampled: boolean;
}

export interface SpanContext {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly traceFlags: number;
  readonly sampled: boolean;
  readonly traceState?: Readonly<Record<string, string>>;
  readonly baggage?: Readonly<Record<string, string>>;
  readonly requestId?: string;
}

export type TraceCarrier =
  Headers | Map<string, string> | Record<string, string | undefined>;

const HEX_2 = /^[0-9a-f]{2}$/;
const HEX_16 = /^[0-9a-f]{16}$/;
const HEX_32 = /^[0-9a-f]{32}$/;
const ZERO_TRACE_ID = "00000000000000000000000000000000";
const ZERO_SPAN_ID = "0000000000000000";

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * Generates a cryptographically random non-zero 32-hex-char W3C traceId (128-bit).
 */
export function generateTraceId(): string {
  const bytes = new Uint8Array(16);
  for (;;) {
    crypto.getRandomValues(bytes);
    const hex = bytesToHex(bytes);
    if (hex !== ZERO_TRACE_ID) {
      return hex;
    }
  }
}

/**
 * Generates a cryptographically random non-zero 16-hex-char W3C spanId (64-bit).
 */
export function generateSpanId(): string {
  const bytes = new Uint8Array(8);
  for (;;) {
    crypto.getRandomValues(bytes);
    const hex = bytesToHex(bytes);
    if (hex !== ZERO_SPAN_ID) {
      return hex;
    }
  }
}

/**
 * Parses a W3C Trace Context `traceparent` header:
 * `00-<32-hex-traceId>-<16-hex-spanId>-<2-hex-flags>`
 */
export function parseTraceParent(
  header: string | null | undefined,
): ParsedTraceParent | null {
  if (typeof header !== "string") {
    return null;
  }
  const trimmed = header.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const parts = trimmed.split("-");
  if (parts.length < 4) {
    return null;
  }

  const version = parts[0]!;
  const traceId = parts[1]!;
  const spanId = parts[2]!;
  const flagsHex = parts[3]!;

  // Version "ff" is strictly forbidden by W3C Trace Context spec
  if (!HEX_2.test(version) || version === "ff") {
    return null;
  }
  // Version "00" MUST have strictly 4 dash-separated segments
  if (version === "00" && parts.length !== 4) {
    return null;
  }
  if (!HEX_32.test(traceId) || traceId === ZERO_TRACE_ID) {
    return null;
  }
  if (!HEX_16.test(spanId) || spanId === ZERO_SPAN_ID) {
    return null;
  }
  if (!HEX_2.test(flagsHex)) {
    return null;
  }

  const traceFlags = Number.parseInt(flagsHex, 16);
  return {
    version,
    traceId,
    spanId,
    traceFlags,
    sampled: (traceFlags & 0x01) === 1,
  };
}

/**
 * Formats a W3C `traceparent` header string (`00-<traceId>-<spanId>-<flags>`).
 */
export function formatTraceParent(context: {
  traceId: string;
  spanId: string;
  traceFlags?: number;
  sampled?: boolean;
}): string {
  const flags =
    context.traceFlags !== undefined
      ? context.traceFlags & 0xff
      : context.sampled === false
        ? 0x00
        : 0x01;
  const flagsHex = flags.toString(16).padStart(2, "0");
  return `00-${context.traceId.toLowerCase()}-${context.spanId.toLowerCase()}-${flagsHex}`;
}

const DANGEROUS_HEADER_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

export function parseTraceState(
  header: string | null | undefined,
): Record<string, string> {
  const result: Record<string, string> = {};
  if (
    typeof header !== "string" ||
    header.trim().length === 0 ||
    /[\r\n]/.test(header)
  ) {
    return result;
  }
  for (const member of header.split(",")) {
    const trimmed = member.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (key && val && !DANGEROUS_HEADER_KEYS.has(key)) {
      result[key] = val;
    }
  }
  return result;
}

export function formatTraceState(
  state: Readonly<Record<string, string>> | undefined,
): string {
  if (!state) return "";
  return Object.entries(state)
    .filter(([k, v]) => k.length > 0 && v.length > 0)
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
}

export function parseBaggage(
  header: string | null | undefined,
): Record<string, string> {
  const result: Record<string, string> = {};
  if (typeof header !== "string" || header.trim().length === 0) {
    return result;
  }
  for (const pair of header.split(",")) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const rawKey = trimmed.slice(0, eq).trim();
    const rawVal =
      trimmed
        .slice(eq + 1)
        .split(";")[0]
        ?.trim() ?? "";
    try {
      const key = decodeURIComponent(rawKey);
      const val = decodeURIComponent(rawVal);
      if (key && !DANGEROUS_HEADER_KEYS.has(key)) {
        result[key] = val;
      }
    } catch {
      if (rawKey && !DANGEROUS_HEADER_KEYS.has(rawKey)) {
        result[rawKey] = rawVal;
      }
    }
  }
  return result;
}

export function formatBaggage(
  baggage: Readonly<Record<string, string>> | undefined,
): string {
  if (!baggage) return "";
  return Object.entries(baggage)
    .filter(([k]) => k.length > 0)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join(",");
}

/**
 * AsyncLocalStorage-backed storage propagating active W3C SpanContext across
 * async boundaries (HTTP -> DB -> Queue -> Workers).
 */
export class TraceContextStorage {
  private readonly als = new AsyncLocalStorage<SpanContext>();

  run<T>(context: SpanContext, fn: () => T): T {
    return this.als.run(context, fn);
  }

  getStore(): SpanContext | undefined {
    return this.als.getStore();
  }

  getCurrentSpanContext(): SpanContext | undefined {
    return this.als.getStore();
  }

  getTraceId(): string | undefined {
    return this.als.getStore()?.traceId;
  }

  getSpanId(): string | undefined {
    return this.als.getStore()?.spanId;
  }

  getParentSpanId(): string | undefined {
    return this.als.getStore()?.parentSpanId;
  }

  getRequestId(): string | undefined {
    return this.als.getStore()?.requestId;
  }

  withBaggage<T>(entries: Record<string, string>, fn: () => T): T {
    const current = this.als.getStore();
    if (!current) {
      return fn();
    }
    const next: SpanContext = {
      ...current,
      baggage: { ...(current.baggage ?? {}), ...entries },
    };
    return this.als.run(next, fn);
  }
}

export const traceContextStorage = new TraceContextStorage();

function getCarrierHeader(
  carrier: TraceCarrier,
  name: string,
): string | undefined {
  if (carrier instanceof Headers) {
    return carrier.get(name) ?? undefined;
  }
  if (carrier instanceof Map) {
    const exact = carrier.get(name);
    if (exact !== undefined) return exact;
    const lower = name.toLowerCase();
    for (const [k, v] of carrier.entries()) {
      if (k.toLowerCase() === lower) return v;
    }
    return undefined;
  }
  if (carrier[name] !== undefined) {
    return carrier[name];
  }
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(carrier)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

function setCarrierHeader(
  carrier: TraceCarrier,
  name: string,
  value: string,
): void {
  if (carrier instanceof Headers) {
    carrier.set(name, value);
    return;
  }
  if (carrier instanceof Map) {
    carrier.set(name, value);
    return;
  }
  carrier[name] = value;
}

/**
 * Injects W3C `traceparent` (plus `tracestate` & `baggage` if present) from the
 * active or supplied `SpanContext` into HTTP headers, queue job metadata, or RPC carriers.
 */
export function injectTraceContext(
  carrier: TraceCarrier,
  context:
    SpanContext | undefined = traceContextStorage.getCurrentSpanContext(),
): void {
  if (!context) {
    return;
  }
  setCarrierHeader(carrier, "traceparent", formatTraceParent(context));

  const traceState = formatTraceState(context.traceState);
  if (traceState) {
    setCarrierHeader(carrier, "tracestate", traceState);
  }

  const baggage = formatBaggage(context.baggage);
  if (baggage) {
    setCarrierHeader(carrier, "baggage", baggage);
  }

  if (context.requestId) {
    setCarrierHeader(carrier, "x-request-id", context.requestId);
  }
}

/**
 * Extracts a W3C `SpanContext` from incoming HTTP headers, queue job payloads, or RPC carriers.
 */
export function extractTraceContext(
  carrier: TraceCarrier,
): SpanContext | undefined {
  const traceparent = getCarrierHeader(carrier, "traceparent");
  const parsed = parseTraceParent(traceparent);
  if (!parsed) {
    return undefined;
  }

  const traceState = parseTraceState(getCarrierHeader(carrier, "tracestate"));
  const baggage = parseBaggage(getCarrierHeader(carrier, "baggage"));
  const requestId = getCarrierHeader(carrier, "x-request-id");

  return {
    traceId: parsed.traceId,
    spanId: parsed.spanId,
    traceFlags: parsed.traceFlags,
    sampled: parsed.sampled,
    traceState: Object.keys(traceState).length > 0 ? traceState : undefined,
    baggage: Object.keys(baggage).length > 0 ? baggage : undefined,
    requestId,
  };
}
