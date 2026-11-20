import type { HttpAdapterHost } from "@bunest/core";

export type HeaderMap = Record<string, string | string[] | undefined>;
export type HeadersInput = HeaderMap | Headers | undefined;

const headersRecordCache = new WeakMap<Headers, HeaderMap>();

/**
 * Normalizes Web `Headers` (native Bun `Request.headers`) or plain Node
 * header maps into a lowercase `Record<string, string | string[] | undefined>`.
 */
export function toHeaderMap(headers: HeadersInput): HeaderMap | undefined {
  if (!headers) {
    return undefined;
  }
  if (typeof (headers as Headers).get === "function" && typeof (headers as Headers).forEach === "function") {
    const webHeaders = headers as Headers;
    const cached = headersRecordCache.get(webHeaders);
    if (cached) {
      return cached;
    }
    const record: HeaderMap = {};
    webHeaders.forEach((value, key) => {
      const lower = key.toLowerCase();
      const existing = record[lower];
      if (existing === undefined) {
        record[lower] = value;
      } else if (Array.isArray(existing)) {
        existing.push(value);
      } else {
        record[lower] = [existing, value];
      }
    });
    headersRecordCache.set(webHeaders, record);
    return record;
  }
  return headers as HeaderMap;
}

/**
 * Reads the first value of header `name` (case-insensitive) from either
 * Web `Headers` or a plain Node `IncomingHttpHeaders` object.
 */
export function readFirstHeader(
  headers: HeadersInput,
  name: string,
): string | undefined {
  if (!headers) {
    return undefined;
  }
  if (typeof (headers as Headers).get === "function") {
    const val = (headers as Headers).get(name);
    return val === null ? undefined : val;
  }
  const map = headers as HeaderMap;
  const lower = name.toLowerCase();
  const direct = map[lower] ?? map[name];
  if (direct !== undefined) {
    return Array.isArray(direct) ? direct[0] : direct;
  }
  for (const [k, v] of Object.entries(map)) {
    if (k.toLowerCase() === lower) {
      return Array.isArray(v) ? v[0] : v;
    }
  }
  return undefined;
}

/**
 * Reads all values of header `name` joined with `", "` (preserving conflicting values
 * so repeated headers never satisfy single-value security checks).
 */
export function readJoinedHeader(
  headers: HeadersInput,
  name: string,
): string | undefined {
  if (!headers) {
    return undefined;
  }
  if (typeof (headers as Headers).get === "function") {
    const val = (headers as Headers).get(name);
    return val === null ? undefined : val;
  }
  const map = headers as HeaderMap;
  const lower = name.toLowerCase();
  const direct = map[lower] ?? map[name];
  if (direct !== undefined) {
    return Array.isArray(direct) ? direct.join(", ") : direct;
  }
  for (const [k, v] of Object.entries(map)) {
    if (k.toLowerCase() === lower) {
      return Array.isArray(v) ? v.join(", ") : v;
    }
  }
  return undefined;
}

/**
 * Appends a response header via `HttpAdapterHost.httpAdapter` or directly on
 * Bunest's `HttpResponseContext` / Node's `ServerResponse`.
 */
export function appendResponseHeader(
  adapterHost: HttpAdapterHost | undefined,
  response: unknown,
  name: string,
  value: string,
): void {
  if (!response) {
    return;
  }
  const adapter = adapterHost?.httpAdapter;
  if (adapter && typeof adapter.appendHeader === "function") {
    adapter.appendHeader(response as any, name, value);
    return;
  }
  const res = response as Record<string, unknown>;
  if (typeof res.appendHeader === "function") {
    (res.appendHeader as (n: string, v: string) => void)(name, value);
  } else if (typeof res.header === "function") {
    (res.header as (n: string, v: string) => void)(name, value);
  } else if (typeof res.setHeader === "function") {
    const prev =
      typeof res.getHeader === "function"
        ? (res.getHeader as (n: string) => unknown)(name)
        : undefined;
    if (prev !== undefined) {
      const next = Array.isArray(prev) ? [...prev, value] : [String(prev), value];
      (res.setHeader as (n: string, v: string | string[]) => void)(name, next);
    } else {
      (res.setHeader as (n: string, v: string) => void)(name, value);
    }
  }
}

/**
 * Sets a response header via `HttpAdapterHost.httpAdapter` or directly on
 * Bunest's `HttpResponseContext` / Node's `ServerResponse`.
 */
export function setResponseHeader(
  adapterHost: HttpAdapterHost | undefined,
  response: unknown,
  name: string,
  value: string,
): void {
  if (!response) {
    return;
  }
  const adapter = adapterHost?.httpAdapter;
  if (adapter && typeof adapter.setHeader === "function") {
    adapter.setHeader(response as any, name, value);
    return;
  }
  const res = response as Record<string, unknown>;
  if (typeof res.header === "function") {
    (res.header as (n: string, v: string) => void)(name, value);
  } else if (typeof res.setHeader === "function") {
    (res.setHeader as (n: string, v: string) => void)(name, value);
  }
}
