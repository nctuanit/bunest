import type { SpanAttributeValue } from "./span";
import {
  injectTraceContext,
  traceContextStorage,
} from "./trace-context";
import { Tracer } from "./tracer";

/**
 * Structural `fetch` function signature compatible with `globalThis.fetch`
 * and custom HTTP client doubles.
 */
export type TracedFetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface TracedFetchOptions {
  /**
   * Tracer used to start and export outbound HTTP `CLIENT` spans.
   * When omitted, a lightweight default `Tracer` is used so W3C trace headers
   * are still generated and propagated.
   */
  tracer?: Tracer;
  /**
   * Underlying `fetch` implementation to wrap.
   * @default globalThis.fetch
   */
  fetchImpl?: TracedFetchLike;
  /**
   * Optional custom span name formatter.
   * Defaults to `"HTTP <METHOD> <pathname>"`.
   */
  spanName?: (info: {
    method: string;
    url: URL;
    input: string | URL | Request;
  }) => string;
  /**
   * Whether to inject W3C `traceparent` / `tracestate` / `baggage` / `x-request-id`
   * headers onto outbound requests.
   * @default true
   */
  propagateContext?: boolean;
  /**
   * Optional predicate returning `true` for URLs that should bypass tracing
   * (e.g. telemetry collector endpoints).
   */
  ignoreUrl?: (url: string) => boolean;
  /**
   * Optional static attributes attached to every outbound `CLIENT` span.
   */
  attributes?: Readonly<Record<string, SpanAttributeValue>>;
}

function parseTargetUrl(rawUrl: string): URL {
  try {
    return new URL(rawUrl);
  } catch {
    return new URL(rawUrl, "http://localhost");
  }
}

function resolveRequestMeta(
  input: string | URL | Request,
  init?: RequestInit,
): { rawUrl: string; method: string; url: URL } {
  const rawUrl =
    input instanceof Request
      ? input.url
      : input instanceof URL
        ? input.toString()
        : String(input);
  const method = (
    init?.method ??
    (input instanceof Request ? input.method : "GET") ??
    "GET"
  ).toUpperCase();
  const url = parseTargetUrl(rawUrl);
  return { rawUrl, method, url };
}

/**
 * Wraps `fetch` (or a custom `fetchImpl`) so every outbound HTTP request:
 * 1. Starts a `CLIENT` span linked to the active `traceContextStorage` parent span;
 * 2. Injects W3C `traceparent`, `tracestate`, `baggage`, and `x-request-id` headers;
 * 3. Records `http.status_code` / `http.response.status_code` and exceptions;
 * 4. Ends the span cleanly in `finally`.
 */
export function createTracedFetch(
  options: TracedFetchOptions = {},
): TracedFetchLike {
  const tracer = options.tracer ?? new Tracer();
  const baseFetch: TracedFetchLike =
    options.fetchImpl ??
    ((input, init) => globalThis.fetch(input, init));
  const propagate = options.propagateContext !== false;

  return async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const { rawUrl, method, url } = resolveRequestMeta(input, init);
    if (options.ignoreUrl?.(rawUrl)) {
      return baseFetch(input, init);
    }

    const parentContext = traceContextStorage.getCurrentSpanContext();
    const name = options.spanName
      ? options.spanName({ method, url, input })
      : `HTTP ${method} ${url.pathname}`;

    const attributes: Record<string, SpanAttributeValue> = {
      "http.method": method,
      "http.request.method": method,
      "url.full": rawUrl,
      "url.path": url.pathname,
      "server.address": url.hostname,
      ...(url.port ? { "server.port": Number(url.port) } : {}),
      ...(options.attributes ?? {}),
    };

    const span = tracer.startSpan(name, {
      kind: "CLIENT",
      parentContext,
      attributes,
    });

    const headers = new Headers(
      input instanceof Request ? input.headers : undefined,
    );
    if (init?.headers) {
      new Headers(init.headers).forEach((value, key) => {
        headers.set(key, value);
      });
    }

    if (propagate) {
      injectTraceContext(headers, span.context);
    }

    const nextInit: RequestInit = {
      ...init,
      headers,
    };

    return traceContextStorage.run(span.context, async () => {
      try {
        const response = await baseFetch(input, nextInit);
        span.setAttribute("http.status_code", response.status);
        span.setAttribute("http.response.status_code", response.status);
        if (response.status >= 400) {
          span.setStatus("ERROR", `HTTP ${response.status}`);
        } else {
          span.setStatus("OK");
        }
        return response;
      } catch (err) {
        span.recordException(err);
        throw err;
      } finally {
        span.end();
      }
    });
  };
}
