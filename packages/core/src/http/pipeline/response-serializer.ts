import {
  type HeaderMetadata,
  HttpStatus,
  InternalServerErrorException,
  type RedirectMetadata,
  type RouteHttpMethod,
  type SseMessageEvent,
  type SseOptions,
  StreamableFile,
} from "../../common/index";
import type { RequestContext } from "../context/request-context";
import { mergeCorsHeaders } from "../security/cors";

export interface RouteResponseMeta {
  readonly method: RouteHttpMethod;
  readonly httpCode?: number;
  readonly headers?: readonly HeaderMetadata[];
  readonly redirect?: RedirectMetadata;
  readonly renderTemplate?: string;
  readonly isSse?: boolean;
  readonly sseOptions?: SseOptions;
}

const textEncoder = new TextEncoder();

const STATUS_200_INIT = { status: 200 };
const STATUS_201_INIT = { status: 201 };
const TEXT_PLAIN_200_INIT = {
  status: 200,
  headers: { "content-type": "text/plain; charset=utf-8" },
};
const TEXT_PLAIN_201_INIT = {
  status: 201,
  headers: { "content-type": "text/plain; charset=utf-8" },
};

function isEmptyBodyStatus(status: number, requestMethod: string): boolean {
  return (
    requestMethod === "HEAD" ||
    status === HttpStatus.NO_CONTENT ||
    status === HttpStatus.NOT_MODIFIED ||
    (status >= 100 && status < 200)
  );
}

function getDefaultStatusForMethod(
  routeMethod: RouteHttpMethod,
  requestMethod: string,
): number {
  const effectiveMethod =
    routeMethod === "ALL" ? requestMethod.toUpperCase() : routeMethod;
  return effectiveMethod === "POST" ? HttpStatus.CREATED : HttpStatus.OK;
}

function isRedirectResult(
  value: unknown,
): value is { url: string; statusCode?: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    "url" in value &&
    typeof (value as { url?: unknown }).url === "string" &&
    (value as { url: string }).url.length > 0
  );
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] ===
      "function"
  );
}

function isSyncIterable(value: unknown): value is Iterable<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof value !== "string" &&
    typeof (value as Iterable<unknown>)[Symbol.iterator] === "function"
  );
}

/**
 * Formats a single `SseMessageEvent` according to ADR-010 §6 SSE wire format
 * (including NestJS v12 `comment` lines: `: <comment>\n`).
 */
export function formatSseEvent(
  event: SseMessageEvent | string | object,
): string {
  const isStructuredEvent =
    typeof event === "object" &&
    event !== null &&
    ("data" in event || "comment" in event);
  const normalized: SseMessageEvent = isStructuredEvent
    ? (event as SseMessageEvent)
    : { data: event };

  let output = "";

  if (normalized.comment !== undefined) {
    const commentLines = String(normalized.comment).split(/\r\n|\r|\n/);
    for (let i = 0; i < commentLines.length; i++) {
      output += `: ${commentLines[i] ?? ""}\n`;
    }
  }
  if (normalized.id !== undefined) {
    output += `id: ${String(normalized.id).replace(/[\r\n]/g, "")}\n`;
  }
  if (normalized.type !== undefined) {
    output += `event: ${String(normalized.type).replace(/[\r\n]/g, "")}\n`;
  }
  if (normalized.retry !== undefined && Number.isFinite(normalized.retry)) {
    output += `retry: ${Math.floor(normalized.retry)}\n`;
  }

  if (normalized.data !== undefined || normalized.comment === undefined) {
    const rawData =
      typeof normalized.data === "string"
        ? normalized.data
        : JSON.stringify(normalized.data ?? "");
    const lines = rawData.split(/\r\n|\r|\n/);
    for (let i = 0; i < lines.length; i++) {
      output += `data: ${lines[i] ?? ""}\n`;
    }
  }

  output += "\n";
  return output;
}

/**
 * Builds merged headers following ADR-010 §4 strict precedence (low -> high):
 * 1. Serializer default `Content-Type`
 * 2. Configured CORS headers
 * 3. Static `@Header(name, value)` decorator entries
 * 4. Dynamic headers and cookies from `ResponseContext`
 * 5. Explicit headers on a returned native `Response` (handled separately when present)
 */
function buildMergedHeaders(
  ctx: RequestContext,
  staticHeaders: readonly HeaderMetadata[] | undefined,
  defaultContentType?: string,
  extraDefaults?: Record<string, string>,
): Headers {
  const headers = new Headers();

  // 1. Serializer default Content-Type & extra defaults (e.g. SSE Cache-Control)
  if (defaultContentType) {
    headers.set("Content-Type", defaultContentType);
  }
  if (extraDefaults) {
    for (const [k, v] of Object.entries(extraDefaults)) {
      headers.set(k, v);
    }
  }

  // 2. Configured CORS headers
  if (ctx.hasCorsHeaders()) {
    mergeCorsHeaders(headers, ctx.corsHeaders);
  }

  // 3. Static @Header(name, value) entries (declaration order; preserve multi Set-Cookie)
  if (staticHeaders) {
    for (let i = 0; i < staticHeaders.length; i++) {
      const entry = staticHeaders[i];
      if (!entry) continue;
      if (entry.name.toLowerCase() === "set-cookie") {
        headers.append("Set-Cookie", entry.value);
      } else {
        headers.set(entry.name, entry.value);
      }
    }
  }

  // 4. Dynamic headers from ResponseContext
  if (ctx.hasResponseContext()) {
    const resCtx = ctx.responseContext;
    const resHeaders = resCtx.getHeadersIfInitialized();
    if (resHeaders) {
      resHeaders.forEach((value, key) => {
        if (key.toLowerCase() === "set-cookie") {
          return;
        }
        headers.set(key, value);
      });
    }

    // Preserve every Set-Cookie added via ResponseContext.cookie / clearCookie / appendHeader
    const setCookies = resCtx.getSetCookies();
    for (let i = 0; i < setCookies.length; i++) {
      const cookie = setCookies[i];
      if (cookie !== undefined) {
        headers.append("Set-Cookie", cookie);
      }
    }
  }

  return headers;
}

/**
 * Merges CORS, static `@Header`, and `ResponseContext` headers onto an
 * explicit native `Response` without clobbering headers already set on it (ADR-010 §2.1 & §4).
 */
export function mergeHeadersOntoNativeResponse(
  response: Response,
  ctx: RequestContext,
  staticHeaders?: readonly HeaderMetadata[],
): Response {
  const status = response.status;
  const baseHeaders = buildMergedHeaders(ctx, staticHeaders);

  // Apply explicit Response headers at highest precedence (#5)
  response.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower === "set-cookie") {
      return;
    }
    if (lower === "vary") {
      const existingVary = baseHeaders.get("vary");
      if (!existingVary) {
        baseHeaders.set("Vary", value);
      } else {
        const mergedTokens = new Set(
          existingVary.split(",").map((s) => s.trim()),
        );
        for (const token of value.split(",")) {
          const trimmed = token.trim();
          if (trimmed) mergedTokens.add(trimmed);
        }
        baseHeaders.set("Vary", [...mergedTokens].join(", "));
      }
      return;
    }
    baseHeaders.set(key, value);
  });

  // Append any Set-Cookie headers present on the native Response
  const responseCookies =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [];
  for (let i = 0; i < responseCookies.length; i++) {
    const cookie = responseCookies[i];
    if (cookie !== undefined) {
      baseHeaders.append("Set-Cookie", cookie);
    }
  }

  if (isEmptyBodyStatus(status, ctx.request.method)) {
    if (response.body) {
      void response.body.cancel().catch(() => {});
    }
    return new Response(null, { status, headers: baseHeaders });
  }

  return new Response(response.body, {
    status,
    statusText: response.statusText,
    headers: baseHeaders,
  });
}

const DEFAULT_SSE_MAX_PENDING_DATA_LENGTH = 4 * 1024 * 1024;

function resolveSseMaxPendingLimit(sseOptions?: SseOptions): number {
  const raw = sseOptions?.maxPendingDataLength;
  if (raw === undefined) {
    return DEFAULT_SSE_MAX_PENDING_DATA_LENGTH;
  }
  if (raw <= 0 || !Number.isFinite(raw)) {
    return Infinity;
  }
  return raw;
}

function createSseStream(
  source: unknown,
  signal: AbortSignal,
  sseOptions?: SseOptions,
): ReadableStream<Uint8Array> {
  const maxPendingLimit = resolveSseMaxPendingLimit(sseOptions);
  let pendingChars = 0;

  const enqueueWithBackpressure = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    chunk: Uint8Array,
    cleanupFn: () => void,
  ): boolean => {
    if (Number.isFinite(maxPendingLimit)) {
      const desired = controller.desiredSize;
      if (desired !== null && desired <= 0) {
        pendingChars += Math.max(16, chunk.byteLength);
        if (pendingChars > maxPendingLimit) {
          cleanupFn();
          try {
            controller.close();
          } catch {
            // Already closed
          }
          return false;
        }
      } else {
        pendingChars = 0;
      }
    }
    controller.enqueue(chunk);
    return true;
  };
  if (source instanceof ReadableStream) {
    let reader:
      | {
          read(): Promise<{ done: boolean; value?: unknown }>;
          cancel(): Promise<void>;
        }
      | undefined;
    let cleanedUp = false;

    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      signal.removeEventListener("abort", onAbort);
      if (reader) {
        void reader.cancel().catch(() => {});
      }
    };

    let streamController:
      ReadableStreamDefaultController<Uint8Array> | undefined;
    const onAbort = () => {
      cleanup();
      try {
        streamController?.close();
      } catch {
        // Stream already closed or errored
      }
    };

    return new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        reader = source.getReader();
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      },
      async pull(controller) {
        if (cleanedUp || signal.aborted || !reader) {
          cleanup();
          try {
            controller.close();
          } catch {
            // Already closed
          }
          return;
        }
        try {
          const { done, value } = await reader.read();
          if (done || cleanedUp || signal.aborted) {
            cleanup();
            try {
              controller.close();
            } catch {
              // Already closed
            }
            return;
          }
          if (value instanceof Uint8Array) {
            enqueueWithBackpressure(controller, value, cleanup);
          } else {
            enqueueWithBackpressure(
              controller,
              textEncoder.encode(formatSseEvent(value as SseMessageEvent)),
              cleanup,
            );
          }
        } catch (err) {
          cleanup();
          if (!signal.aborted) {
            controller.error(err);
          }
        }
      },
      cancel() {
        cleanup();
      },
    });
  }

  if (isAsyncIterable(source)) {
    let iterator: AsyncIterator<unknown> | undefined;
    let cleanedUp = false;
    let streamController:
      ReadableStreamDefaultController<Uint8Array> | undefined;

    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      signal.removeEventListener("abort", onAbort);
      if (iterator && typeof iterator.return === "function") {
        void Promise.resolve(iterator.return()).catch(() => {});
      }
    };

    const onAbort = () => {
      cleanup();
      try {
        streamController?.close();
      } catch {
        // Stream already closed
      }
    };

    return new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        iterator = source[Symbol.asyncIterator]();
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      },
      async pull(controller) {
        if (cleanedUp || signal.aborted || !iterator) {
          cleanup();
          try {
            controller.close();
          } catch {
            // Already closed
          }
          return;
        }
        try {
          const step = await iterator.next();
          if (step.done || cleanedUp || signal.aborted) {
            cleanup();
            try {
              controller.close();
            } catch {
              // Already closed
            }
            return;
          }
          enqueueWithBackpressure(
            controller,
            textEncoder.encode(formatSseEvent(step.value as SseMessageEvent)),
            cleanup,
          );
        } catch (err) {
          cleanup();
          if (!signal.aborted) {
            controller.error(err);
          }
        }
      },
      cancel() {
        cleanup();
      },
    });
  }

  if (isSyncIterable(source)) {
    const iterator = source[Symbol.iterator]();
    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      if (typeof iterator.return === "function") {
        try {
          iterator.return();
        } catch {
          // Ignore cleanup errors
        }
      }
    };

    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (cleanedUp || signal.aborted) {
          cleanup();
          controller.close();
          return;
        }
        const step = iterator.next();
        if (step.done) {
          cleanup();
          controller.close();
          return;
        }
        controller.enqueue(
          textEncoder.encode(formatSseEvent(step.value as SseMessageEvent)),
        );
      },
      cancel() {
        cleanup();
      },
    });
  }

  // Single event value fallback
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (source !== undefined && source !== null) {
        controller.enqueue(
          textEncoder.encode(formatSseEvent(source as SseMessageEvent)),
        );
      }
      controller.close();
    },
  });
}

/**
 * Serializes a controller/interceptor return value into a native Web `Response`
 * strictly following ADR-010 priority order, status code precedence, header
 * merge precedence, and RFC 9110 empty-body enforcement.
 *
 * Uses zero-`Headers` fast path (`Response.json()`) when no CORS, static `@Header`,
 * or `ResponseContext` header mutations are present.
 */
export function serializeResponse(
  value: unknown,
  route: RouteResponseMeta,
  ctx: RequestContext,
): Response {
  const reqMethod = ctx.request.method;

  // Priority 1: Native Response passthrough
  if (value instanceof Response) {
    return mergeHeadersOntoNativeResponse(value, ctx, route.headers);
  }

  const hasResCtx = ctx.hasResponseContext();
  const dynamicStatus = hasResCtx ? ctx.responseContext.getStatus() : undefined;

  // Priority 2: @Redirect() route
  if (route.redirect) {
    const dynamic = isRedirectResult(value) ? value : undefined;
    const targetUrl = dynamic?.url ?? route.redirect.url;
    const status =
      dynamicStatus ??
      dynamic?.statusCode ??
      route.httpCode ??
      route.redirect.statusCode ??
      HttpStatus.FOUND;

    const headers = buildMergedHeaders(ctx, route.headers);
    if (targetUrl) {
      headers.set("Location", targetUrl);
    }
    return new Response(null, { status, headers });
  }

  const status =
    dynamicStatus ??
    route.httpCode ??
    getDefaultStatusForMethod(route.method, reqMethod);

  // Fast zero-Headers path when no CORS, static @Header, or ResponseContext header mutations exist
  const hasCustomHeaders =
    ctx.hasCorsHeaders() ||
    (route.headers !== undefined && route.headers.length > 0) ||
    (hasResCtx && ctx.responseContext.hasHeaderMutations());

  // Priority 3: @Sse() route
  if (route.isSse) {
    const headers = buildMergedHeaders(
      ctx,
      route.headers,
      "text/event-stream; charset=utf-8",
      {
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    );
    if (isEmptyBodyStatus(status, reqMethod)) {
      return new Response(null, { status, headers });
    }
    const stream = createSseStream(value, ctx.signal, route.sseOptions);
    return new Response(stream, { status, headers });
  }

  // Priority 3.5: StreamableFile (streams directly without buffering into RAM)
  if (value instanceof StreamableFile) {
    const fileHeaders = value.getHeaders();
    const extraDefaults: Record<string, string> = {};
    if (fileHeaders.disposition !== undefined) {
      extraDefaults["Content-Disposition"] = fileHeaders.disposition;
    }
    if (fileHeaders.length !== undefined) {
      extraDefaults["Content-Length"] = String(fileHeaders.length);
    }
    const headers = buildMergedHeaders(
      ctx,
      route.headers,
      fileHeaders.type,
      extraDefaults,
    );
    if (isEmptyBodyStatus(status, reqMethod)) {
      const src = value.getSource();
      if (src instanceof ReadableStream) {
        void src.cancel().catch(() => {});
      }
      return new Response(null, { status, headers });
    }
    return new Response(value.getStream(), { status, headers });
  }

  // Priority 4: ReadableStream
  if (value instanceof ReadableStream) {
    const headers = buildMergedHeaders(
      ctx,
      route.headers,
      "application/octet-stream",
    );
    if (isEmptyBodyStatus(status, reqMethod)) {
      void value.cancel().catch(() => {});
      return new Response(null, { status, headers });
    }
    return new Response(value, { status, headers });
  }

  // Priority 5: Blob (includes BunFile from Bun.file())
  if (value instanceof Blob) {
    const headers = buildMergedHeaders(
      ctx,
      route.headers,
      value.type || "application/octet-stream",
    );
    if (isEmptyBodyStatus(status, reqMethod)) {
      return new Response(null, { status, headers });
    }
    return new Response(value, { status, headers });
  }

  // Priority 6: Uint8Array / ArrayBuffer / ArrayBufferView
  if (
    value instanceof Uint8Array ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value)
  ) {
    const headers = buildMergedHeaders(
      ctx,
      route.headers,
      "application/octet-stream",
    );
    if (isEmptyBodyStatus(status, reqMethod)) {
      return new Response(null, { status, headers });
    }
    const binaryBody =
      value instanceof Uint8Array || value instanceof ArrayBuffer
        ? value
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return new Response(binaryBody, { status, headers });
  }

  // Priority 7: null or undefined
  if (value === null || value === undefined) {
    if (!hasCustomHeaders) {
      return new Response(
        null,
        status === 200
          ? STATUS_200_INIT
          : status === 201
            ? STATUS_201_INIT
            : { status },
      );
    }
    const headers = buildMergedHeaders(ctx, route.headers);
    return new Response(null, { status, headers });
  }

  // Priority 8: string
  if (typeof value === "string") {
    if (!hasCustomHeaders) {
      const init =
        status === 200
          ? TEXT_PLAIN_200_INIT
          : status === 201
            ? TEXT_PLAIN_201_INIT
            : {
                status,
                headers: { "content-type": "text/plain; charset=utf-8" },
              };
      if (isEmptyBodyStatus(status, reqMethod)) {
        return new Response(null, init);
      }
      return new Response(value, init);
    }
    const headers = buildMergedHeaders(
      ctx,
      route.headers,
      "text/plain; charset=utf-8",
    );
    if (isEmptyBodyStatus(status, reqMethod)) {
      return new Response(null, { status, headers });
    }
    return new Response(value, { status, headers });
  }

  // Priority 9: number or boolean
  if (typeof value === "number" || typeof value === "boolean") {
    if (!hasCustomHeaders && !isEmptyBodyStatus(status, reqMethod)) {
      return Response.json(
        value,
        status === 200
          ? STATUS_200_INIT
          : status === 201
            ? STATUS_201_INIT
            : { status },
      );
    }
    const headers = buildMergedHeaders(
      ctx,
      route.headers,
      "application/json; charset=utf-8",
    );
    if (isEmptyBodyStatus(status, reqMethod)) {
      return new Response(null, { status, headers });
    }
    return new Response(JSON.stringify(value), { status, headers });
  }

  // Priority 10: Plain object / Array / Class instance (JSON)
  if (!hasCustomHeaders && !isEmptyBodyStatus(status, reqMethod)) {
    try {
      return Response.json(
        value,
        status === 200
          ? STATUS_200_INIT
          : status === 201
            ? STATUS_201_INIT
            : { status },
      );
    } catch (err) {
      throw new InternalServerErrorException(
        "Failed to serialize response body",
        { cause: err },
      );
    }
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch (err) {
    throw new InternalServerErrorException(
      "Failed to serialize response body",
      {
        cause: err,
      },
    );
  }

  const headers = buildMergedHeaders(
    ctx,
    route.headers,
    "application/json; charset=utf-8",
  );
  if (isEmptyBodyStatus(status, reqMethod)) {
    return new Response(null, { status, headers });
  }
  return new Response(serialized, { status, headers });
}
