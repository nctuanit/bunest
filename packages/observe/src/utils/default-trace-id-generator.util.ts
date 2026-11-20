import { inboundTraceId, w3cTraceIdOf } from "./trace-context.util";
import { uuidv7 } from "./uuid-v7.util";

/**
 * What an inbound `x-request-id` must look like to be adopted as the trace id.
 */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

function readHeader(req: unknown, name: string): string | undefined {
  if (typeof req !== "object" || req === null || !("headers" in req)) {
    return undefined;
  }
  const headers = (req as { headers: unknown }).headers;
  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }
  if (headers && typeof headers === "object") {
    const val = (headers as Record<string, unknown>)[name];
    return typeof val === "string" ? val : undefined;
  }
  return undefined;
}

function readMetadataRequestId(req: unknown): string | undefined {
  if (typeof req !== "object" || req === null) {
    return undefined;
  }
  const fn = (req as { getMetadata?: unknown }).getMetadata;
  if (typeof fn !== "function") {
    return undefined;
  }
  try {
    const meta = (fn as () => unknown).call(req);
    if (meta && typeof meta === "object") {
      const val = (meta as Record<string, unknown>)["x-request-id"];
      if (typeof val === "string") {
        return val;
      }
    }
  } catch {
    // Ignore failing accessor
  }
  return undefined;
}

export function defaultTraceIdGenerator(req: unknown): string {
  const headerId = readHeader(req, "x-request-id");
  if (typeof headerId === "string" && REQUEST_ID_PATTERN.test(headerId)) {
    return headerId;
  }
  const metaId = readMetadataRequestId(req);
  if (typeof metaId === "string" && REQUEST_ID_PATTERN.test(metaId)) {
    return metaId;
  }
  return uuidv7();
}

/**
 * The default `traceIdGenerator` with `openTelemetry` on.
 */
export function openTelemetryTraceIdGenerator(req: unknown): string {
  if (typeof req === "object" && req !== null && "headers" in req) {
    const headers = (req as { headers: unknown }).headers;
    const fromTraceContext = inboundTraceId(headers);
    if (fromTraceContext) {
      const requestId = readHeader(req, "x-request-id");
      return typeof requestId === "string" &&
        REQUEST_ID_PATTERN.test(requestId) &&
        w3cTraceIdOf(requestId) === w3cTraceIdOf(fromTraceContext)
        ? requestId
        : fromTraceContext;
    }
  }
  return defaultTraceIdGenerator(req);
}
