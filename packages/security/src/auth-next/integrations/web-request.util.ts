import type { ExecutionContext } from "@bunest/core";
import { getRequestHeaders, requestOf } from "../utils/auth-state.util";
import { bearerToken } from "../utils/bearer.util";

/**
 * Normalizes a mount path (such as `/api/auth`) for `@Controller(...)` registration.
 */
export function normalizeAuthMountPath(
  basePath: string | undefined,
  fallback = "/api/auth",
): string {
  const raw = (basePath ?? fallback).trim();
  const trimmed = raw.replace(/^\/+|\/+$/g, "");
  return trimmed.length > 0 ? `/${trimmed}` : "/";
}

/**
 * Extracts a standard Web `Headers` instance from any Bunest `ExecutionContext`
 * (HTTP, WebSocket handshake, GraphQL, or MCP/AI calls).
 */
export function extractWebHeaders(context: ExecutionContext): Headers {
  if (context.getType<string>() === "http") {
    const req = context.switchToHttp().getRequest() as
      | { headers?: unknown }
      | undefined;
    if (req?.headers instanceof Headers) {
      return new Headers(req.headers);
    }
  }

  const headerMap = getRequestHeaders(context);
  const out = new Headers();
  if (!headerMap) {
    return out;
  }

  for (const [key, value] of Object.entries(headerMap)) {
    if (typeof value === "string") {
      out.append(key, value);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string") {
          out.append(key, item);
        }
      }
    }
  }
  return out;
}

/**
 * Parses a `Cookie` header string into a key-value map.
 */
export function parseCookieHeader(
  cookieHeader: string | null | undefined,
): Record<string, string> {
  const result: Record<string, string> = {};
  if (!cookieHeader) {
    return result;
  }
  for (const part of cookieHeader.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    if (!name || name in result) continue;
    let value = part.slice(idx + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1);
    }
    try {
      result[name] = decodeURIComponent(value);
    } catch {
      result[name] = value;
    }
  }
  return result;
}

/**
 * Reads a single named cookie from any `ExecutionContext` carrying a `Cookie` header.
 */
export function extractCookieValue(
  context: ExecutionContext,
  name: string,
): string | undefined {
  const headers = getRequestHeaders(context);
  const raw = headers?.cookie;
  const header = Array.isArray(raw) ? raw.join("; ") : raw;
  if (!header) {
    return undefined;
  }
  return parseCookieHeader(header)[name];
}

/**
 * Reads a Bearer token from `Authorization: Bearer <token>` (or WebSocket handshake auth).
 */
export function extractBearerToken(
  context: ExecutionContext,
): string | null | undefined {
  const headers = getRequestHeaders(context);
  const raw = headers?.authorization;
  const authHeader = Array.isArray(raw) ? raw[0] : raw;
  return bearerToken(context, authHeader);
}

/**
 * Returns the underlying Web `Request` when the active execution context is HTTP.
 */
export function extractHttpRequest(
  context: ExecutionContext,
): Request | undefined {
  if (context.getType<string>() !== "http") {
    return undefined;
  }
  const req = context.switchToHttp().getRequest();
  return req instanceof Request ? req : undefined;
}

/**
 * Returns normalized request metadata (`headers`, `method`, `url`, `ip`) across transports.
 */
export function extractTransportRequest(context: ExecutionContext) {
  return requestOf(context);
}
