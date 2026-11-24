import type { TestRequestOptions } from "../interfaces/testing.interface";

export const DEFAULT_TEST_BASE_URL = "http://bunest.test";

/**
 * Joins a base URL (preserving any base path prefix like `/api/v1`) with a
 * relative or absolute request path and optional query parameters.
 */
export function buildRequestUrl(
  baseUrl: string,
  path: string,
  query?: TestRequestOptions["query"],
): string {
  const isAbsolute = /^https?:\/\//i.test(path);
  let url: URL;

  if (isAbsolute) {
    url = new URL(path);
  } else {
    const base = new URL(baseUrl);
    const basePath = base.pathname.replace(/\/+$/, "");
    const relative = new URL(
      path.startsWith("/") ? path : `/${path}`,
      "http://bunest.placeholder",
    );
    base.pathname = `${basePath}${relative.pathname}` || "/";
    base.search = relative.search;
    base.hash = relative.hash;
    url = base;
  }

  if (query) {
    for (const [key, rawValue] of Object.entries(query)) {
      if (rawValue === undefined) {
        continue;
      }
      if (Array.isArray(rawValue)) {
        for (const item of rawValue) {
          url.searchParams.append(key, String(item));
        }
      } else {
        url.searchParams.append(key, String(rawValue));
      }
    }
  }

  return url.toString();
}

/**
 * Merges default headers, per-request headers, and serialized `Cookie` pairs
 * into a fresh `Headers` instance.
 */
export function mergeRequestHeaders(
  defaultHeaders: Readonly<Record<string, string>>,
  requestHeaders?: Record<string, string | string[]> | Headers,
  cookies?: Record<string, string>,
): Headers {
  const headers = new Headers();

  for (const [key, value] of Object.entries(defaultHeaders)) {
    headers.set(key, value);
  }

  if (requestHeaders instanceof Headers) {
    requestHeaders.forEach((value, key) => {
      headers.set(key, value);
    });
  } else if (requestHeaders) {
    for (const [key, value] of Object.entries(requestHeaders)) {
      if (Array.isArray(value)) {
        headers.delete(key);
        for (const item of value) {
          headers.append(key, item);
        }
      } else {
        headers.set(key, value);
      }
    }
  }

  if (cookies) {
    const pairs = Object.entries(cookies).map(
      ([name, value]) =>
        `${encodeURIComponent(name)}=${encodeURIComponent(value)}`,
    );
    if (pairs.length > 0) {
      const existingCookie = headers.get("cookie");
      headers.set(
        "cookie",
        existingCookie
          ? `${existingCookie}; ${pairs.join("; ")}`
          : pairs.join("; "),
      );
    }
  }

  return headers;
}

/**
 * Builds a native Web `Request` from a method, URL, default headers, and
 * `TestRequestOptions`. Defaults `redirect` to `"manual"` so in-memory and
 * live network clients behave identically on 3xx redirects.
 */
export function buildTestRequest(
  method: string,
  baseUrl: string,
  path: string,
  defaultHeaders: Readonly<Record<string, string>>,
  options: TestRequestOptions = {},
): Request {
  const url = buildRequestUrl(baseUrl, path, options.query);
  const headers = mergeRequestHeaders(
    defaultHeaders,
    options.headers,
    options.cookies,
  );

  const upperMethod = method.toUpperCase();
  let body: RequestInit["body"];

  if (options.json !== undefined) {
    body = JSON.stringify(options.json);
    if (!headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
  } else if (options.formData !== undefined) {
    body = options.formData;
  } else if (options.body !== undefined) {
    body = options.body;
  }

  const init: RequestInit = {
    method: upperMethod,
    headers,
    signal: options.signal,
    redirect: options.redirect ?? "manual",
  };

  if (body !== undefined && upperMethod !== "GET" && upperMethod !== "HEAD") {
    init.body = body;
  }

  return new Request(url, init);
}

/**
 * Bun-native Zig structural deep equality helper for JSON/body assertions.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  return Bun.deepEquals(a, b, true);
}
