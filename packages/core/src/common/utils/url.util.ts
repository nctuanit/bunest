import { include, not } from "./predicate.util";
import {
  isArray,
  isNotNull,
  isNullish,
  isString,
  isUndefined,
} from "./type-guards.util";

export type QueryParamValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly (string | number | boolean | null | undefined)[];

/**
 * Normalizes a URL path by collapsing duplicate slashes, ensuring a single leading `/`,
 * and stripping trailing slashes (except root `"/"`).
 */
export function normalizePath(path: string): string {
  const collapsed = path.replace(/\/+/g, "/").trim();
  if (collapsed.length === 0 || collapsed === "/") {
    return "/";
  }
  const withLeading = collapsed.startsWith("/") ? collapsed : `/${collapsed}`;
  return withLeading.length > 1 && withLeading.endsWith("/")
    ? withLeading.slice(0, -1)
    : withLeading;
}

/**
 * Safely joins a base URL (or path) and subsequent path segments without duplicate slashes
 * while preserving the protocol (`https://`) and query/hash on the final segment.
 */
export function joinUrl(base: string, ...segments: readonly string[]): string {
  const cleanedBase = base.replace(/\/+$/, "");
  const cleanedSegments = segments
    .map((seg) => seg.trim())
    .filter((seg) => seg.length > 0)
    .map((seg, idx, arr) => {
      const noLeading = seg.replace(/^\/+/, "");
      return idx < arr.length - 1 ? noLeading.replace(/\/+$/, "") : noLeading;
    })
    .filter((seg) => seg.length > 0);

  if (cleanedSegments.length === 0) {
    return cleanedBase || "/";
  }
  if (cleanedBase.length === 0) {
    return `/${cleanedSegments.join("/")}`;
  }
  return `${cleanedBase}/${cleanedSegments.join("/")}`;
}

/**
 * Serializes a parameter record into a URL-encoded query string (without leading `?`).
 * Skips `null` and `undefined` entries and expands array values as repeated keys.
 */
export function buildQueryString(
  params: Record<string, QueryParamValue>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (isNullish(value)) {
      continue;
    }
    if (isArray(value)) {
      for (const item of value) {
        if (not(isNullish(item))) {
          search.append(key, String(item));
        }
      }
      continue;
    }
    search.append(key, String(value));
  }
  return search.toString();
}

/**
 * Parses a URL query string (with or without leading `?`) into a plain dictionary.
 * Repeated keys are collected into `string[]`.
 */
export function parseQueryString(
  query: string,
): Record<string, string | string[]> {
  const trimmed = query.startsWith("?") ? query.slice(1) : query;
  const search = new URLSearchParams(trimmed);
  const out: Record<string, string | string[]> = {};

  for (const [key, value] of search.entries()) {
    const existing = out[key];
    if (isUndefined(existing)) {
      out[key] = value;
    } else if (isArray(existing)) {
      existing.push(value);
    } else {
      out[key] = [existing, value];
    }
  }
  return out;
}

const DEFAULT_ALLOWED_PROTOCOLS: ReadonlySet<string> = new Set([
  "http:",
  "https:",
]);

/**
 * Validates that `input` is a syntactically valid URL using an allowed protocol
 * (defaults to `http:` and `https:`, blocking `javascript:`, `data:`, `file:`, etc.).
 */
export function isSafeUrl(
  input: unknown,
  allowedProtocols: readonly string[] = ["http:", "https:"],
): input is string {
  if (!isString(input) || input.trim().length === 0) {
    return false;
  }
  try {
    const parsed = new URL(input);
    const allowed =
      allowedProtocols.length === 2 &&
      allowedProtocols[0] === "http:" &&
      allowedProtocols[1] === "https:"
        ? DEFAULT_ALLOWED_PROTOCOLS
        : new Set(
            allowedProtocols.map((p) => (p.endsWith(":") ? p.toLowerCase() : `${p.toLowerCase()}:`)),
          );
    return include(allowed, parsed.protocol.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Normalizes HTTP header records into lowercase keys with string values, skipping nullish entries.
 */
export function normalizeHeaders(
  headers: Record<string, string | number | readonly string[] | null | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (isNullish(value)) {
      continue;
    }
    const lower = key.trim().toLowerCase();
    if (lower.length === 0) {
      continue;
    }
    if (isArray(value)) {
      out[lower] = value.join(", ");
    } else if (isNotNull(value)) {
      out[lower] = String(value);
    }
  }
  return out;
}
