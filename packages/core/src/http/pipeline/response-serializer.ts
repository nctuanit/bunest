import {
  type HeaderMetadata,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  NotFoundException,
  type RedirectMetadata,
  type RouteHttpMethod,
  type SseMessageEvent,
  type SseOptions,
  StreamableFile,
  type StreamableHandlerResponse,
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
  autoId?: number,
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
  const hasData =
    normalized.data !== undefined || normalized.comment === undefined;
  const effectiveId =
    normalized.id !== undefined
      ? normalized.id
      : autoId !== undefined && hasData
        ? String(autoId)
        : undefined;
  if (effectiveId !== undefined) {
    output += `id: ${String(effectiveId).replace(/[\r\n]/g, "")}\n`;
  }
  if (normalized.type !== undefined) {
    output += `event: ${String(normalized.type).replace(/[\r\n]/g, "")}\n`;
  }
  if (normalized.retry !== undefined && Number.isFinite(normalized.retry)) {
    output += `retry: ${Math.floor(normalized.retry)}\n`;
  }

  if (hasData) {
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

function formatSseErrorEvent(err: unknown): Uint8Array {
  const message = err instanceof Error ? err.message : String(err);
  return textEncoder.encode(`event: error\ndata: ${JSON.stringify(message)}\n\n`);
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

  if (response.body !== null && !baseHeaders.has("content-type")) {
    baseHeaders.set("Content-Type", "application/octet-stream");
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

interface PrefetchedSseState {
  readonly iterator: AsyncIterator<unknown>;
  firstChunk?: Uint8Array;
  pendingFirstStep?: Promise<IteratorResult<unknown>>;
  nextAutoId: number;
}

function createSseStream(
  source: unknown,
  signal: AbortSignal,
  sseOptions?: SseOptions,
  onEnd?: () => void,
  prefetched?: PrefetchedSseState,
): ReadableStream<Uint8Array> {
  const maxPendingLimit = resolveSseMaxPendingLimit(sseOptions);
  let pendingChars = 0;
  let nextAutoId = prefetched ? prefetched.nextAutoId : 1;

  const formatWithAutoId = (event: unknown): Uint8Array => {
    const isStructured =
      typeof event === "object" &&
      event !== null &&
      ("data" in event || "comment" in event);
    const ev = isStructured ? (event as SseMessageEvent) : { data: event };
    const hasData = ev.data !== undefined || ev.comment === undefined;
    const autoId =
      ev.id === undefined && hasData ? nextAutoId++ : undefined;
    return textEncoder.encode(formatSseEvent(event as SseMessageEvent, autoId));
  };

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
      onEnd?.();
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
              formatWithAutoId(value),
              cleanup,
            );
          }
        } catch (err) {
          if (!signal.aborted) {
            try {
              controller.enqueue(formatSseErrorEvent(err));
              controller.close();
            } catch {
              // Already closed
            }
          }
          cleanup();
        }
      },
      cancel() {
        cleanup();
      },
    });
  }

  if (prefetched || isAsyncIterable(source)) {
    let iterator: AsyncIterator<unknown> | undefined = prefetched?.iterator;
    let firstChunk: Uint8Array | undefined = prefetched?.firstChunk;
    let pendingFirstStep: Promise<IteratorResult<unknown>> | undefined =
      prefetched?.pendingFirstStep;
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
      onEnd?.();
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
        if (!iterator && isAsyncIterable(source)) {
          iterator = source[Symbol.asyncIterator]();
        }
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
        if (firstChunk !== undefined) {
          const chunk = firstChunk;
          firstChunk = undefined;
          enqueueWithBackpressure(controller, chunk, cleanup);
        }
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
          const step = pendingFirstStep
            ? await pendingFirstStep
            : await iterator.next();
          pendingFirstStep = undefined;
          if (step.done || cleanedUp || signal.aborted) {
            cleanup();
            try {
              controller.close();
            } catch {
              // Already closed
            }
            return;
          }
          const formatted = formatWithAutoId(step.value);
          enqueueWithBackpressure(controller, formatted, cleanup);
        } catch (err) {
          if (!signal.aborted) {
            try {
              controller.enqueue(formatSseErrorEvent(err));
              controller.close();
            } catch {
              // Already closed
            }
          }
          cleanup();
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
      onEnd?.();
    };

    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (cleanedUp || signal.aborted) {
          cleanup();
          controller.close();
          return;
        }
        try {
          const step = iterator.next();
          if (step.done) {
            cleanup();
            controller.close();
            return;
          }
          controller.enqueue(
            textEncoder.encode(formatSseEvent(step.value as SseMessageEvent)),
          );
        } catch (err) {
          try {
            controller.enqueue(formatSseErrorEvent(err));
            controller.close();
          } catch {
            // Already closed
          }
          cleanup();
        }
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
      onEnd?.();
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
    // SSE always enforces text/event-stream Content-Type over @Header() or interceptor overrides
    headers.set("Content-Type", "text/event-stream; charset=utf-8");
    if (isEmptyBodyStatus(status, reqMethod)) {
      return new Response(null, { status, headers });
    }
    const stream = createSseStream(
      value,
      ctx.signal,
      route.sseOptions,
      () => ctx.abortSseSignal(),
    );
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
    const forceChunked =
      headers.get("transfer-encoding")?.toLowerCase().includes("chunked") ??
      false;
    if (forceChunked) {
      headers.delete("content-length");
      headers.delete("transfer-encoding");
    }
    if (isEmptyBodyStatus(status, reqMethod)) {
      const src = value.getSource();
      if (src instanceof ReadableStream) {
        void src.cancel().catch(() => {});
      }
      return new Response(null, { status, headers });
    }
    const rawStream = value.getStream();
    if (forceChunked) {
      const reader = rawStream.getReader();
      const chunkedStream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          const step = await reader.read();
          if (step.done) {
            await new Promise((r) => setTimeout(r, 0));
            controller.close();
            return;
          }
          controller.enqueue(step.value);
        },
        cancel() {
          void reader.cancel().catch(() => {});
        },
      });
      return new Response(chunkedStream, { status, headers });
    }
    return new Response(rawStream, { status, headers });
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
    return createBufferedOrChunkedResponse(value, status, headers);
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
    return createBufferedOrChunkedResponse(
      JSON.stringify(value),
      status,
      headers,
    );
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
  return createBufferedOrChunkedResponse(serialized, status, headers);
}

function createBufferedOrChunkedResponse(
  body: string | Uint8Array,
  status: number,
  headers: Headers,
): Response {
  const te = headers.get("transfer-encoding");
  if (te && te.toLowerCase().includes("chunked")) {
    headers.delete("content-length");
    headers.delete("transfer-encoding");
    const bytes = typeof body === "string" ? textEncoder.encode(body) : body;
    let sent = false;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (!sent) {
          sent = true;
          if (bytes.byteLength > 0) {
            controller.enqueue(bytes);
          }
        } else {
          await new Promise((r) => setTimeout(r, 0));
          controller.close();
        }
      },
    });
    return new Response(stream, { status, headers });
  }
  return new Response(body, { status, headers });
}

function isBinaryChunk(chunk: unknown): chunk is Uint8Array | ArrayBuffer | ArrayBufferView {
  return (
    chunk instanceof Uint8Array ||
    chunk instanceof ArrayBuffer ||
    ArrayBuffer.isView(chunk)
  );
}

function inferStreamContentType(firstChunk: unknown): string {
  if (typeof firstChunk === "string") {
    return "text/plain; charset=utf-8";
  }
  if (isBinaryChunk(firstChunk)) {
    return "application/octet-stream";
  }
  return "application/x-ndjson";
}

function encodeStreamChunk(chunk: unknown): Uint8Array {
  if (chunk === undefined) {
    return new Uint8Array(0);
  }
  if (chunk instanceof Uint8Array) {
    return chunk;
  }
  if (chunk instanceof ArrayBuffer) {
    return new Uint8Array(chunk);
  }
  if (ArrayBuffer.isView(chunk)) {
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  if (typeof chunk === "string") {
    return textEncoder.encode(chunk);
  }
  return textEncoder.encode(`${JSON.stringify(chunk)}\n`);
}

const ABORTED_SENTINEL = Symbol("aborted");
const PENDING_SENTINEL = Symbol("pending");

function raceWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T | typeof ABORTED_SENTINEL> {
  if (signal.aborted) {
    return Promise.resolve(ABORTED_SENTINEL);
  }
  return new Promise<T | typeof ABORTED_SENTINEL>((resolve, reject) => {
    const onAbort = () => {
      resolve(ABORTED_SENTINEL);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (val) => {
        signal.removeEventListener("abort", onAbort);
        resolve(val);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

interface ResumedReaderStreamOptions {
  readonly delayClose?: boolean;
  readonly onError?: (err: unknown) => "close" | "error" | void;
}

function invokeStreamablePreHeaderErrorHandler(
  file: StreamableFile,
  err: unknown,
  ctx: RequestContext,
  staticHeaders?: readonly HeaderMetadata[],
): Response {
  const errorObj = err instanceof Error ? err : new Error(String(err));
  let responseBody: unknown = undefined;
  const extraHeaders = new Map<string, string>();

  const adapterRes: StreamableHandlerResponse = {
    headersSent: false,
    destroyed: false,
    closed: false,
    statusCode: undefined,
    statusMessage: undefined,
    status(code: number) {
      adapterRes.statusCode = code;
      return adapterRes;
    },
    setHeader(name: string, val: string) {
      extraHeaders.set(name, String(val));
      return adapterRes;
    },
    header(name: string, val: string) {
      extraHeaders.set(name, String(val));
      return adapterRes;
    },
    send(body?: unknown) {
      responseBody = body;
      return adapterRes;
    },
    end(chunk?: unknown) {
      if (chunk !== undefined) {
        responseBody = chunk;
      }
      adapterRes.closed = true;
      return adapterRes;
    },
    destroy() {
      adapterRes.destroyed = true;
      adapterRes.closed = true;
      return adapterRes;
    },
  };

  file.errorHandler(errorObj, adapterRes);

  const status = adapterRes.statusCode ?? HttpStatus.BAD_REQUEST;
  const statusText = adapterRes.statusMessage;
  const applyExtraHeaders = (headers: Headers): Headers => {
    for (const [k, v] of extraHeaders.entries()) {
      headers.set(k, v);
    }
    return headers;
  };

  if (responseBody === undefined || responseBody === null) {
    const headers = applyExtraHeaders(buildMergedHeaders(ctx, staticHeaders));
    return new Response(null, {
      status,
      ...(statusText !== undefined ? { statusText } : {}),
      headers,
    });
  }

  if (typeof responseBody === "string") {
    const headers = applyExtraHeaders(
      buildMergedHeaders(ctx, staticHeaders, "text/plain; charset=utf-8"),
    );
    return new Response(responseBody, {
      status,
      ...(statusText !== undefined ? { statusText } : {}),
      headers,
    });
  }

  if (
    responseBody instanceof Uint8Array ||
    responseBody instanceof ArrayBuffer ||
    ArrayBuffer.isView(responseBody)
  ) {
    const headers = applyExtraHeaders(
      buildMergedHeaders(ctx, staticHeaders, "application/octet-stream"),
    );
    const binary =
      responseBody instanceof Uint8Array || responseBody instanceof ArrayBuffer
        ? responseBody
        : new Uint8Array(
            responseBody.buffer,
            responseBody.byteOffset,
            responseBody.byteLength,
          );
    return new Response(binary, {
      status,
      ...(statusText !== undefined ? { statusText } : {}),
      headers,
    });
  }

  const headers = applyExtraHeaders(
    buildMergedHeaders(ctx, staticHeaders, "application/json; charset=utf-8"),
  );
  return new Response(JSON.stringify(responseBody), {
    status,
    ...(statusText !== undefined ? { statusText } : {}),
    headers,
  });
}

function invokeStreamableMidStreamErrorHandler(
  file: StreamableFile,
  err: unknown,
): "close" | "error" {
  const errorObj = err instanceof Error ? err : new Error(String(err));
  let shouldDestroy = false;
  let shouldEnd = false;

  const midStreamRes: StreamableHandlerResponse = {
    headersSent: true,
    destroyed: false,
    closed: false,
    destroy() {
      shouldDestroy = true;
      midStreamRes.destroyed = true;
      midStreamRes.closed = true;
      return midStreamRes;
    },
    end() {
      shouldEnd = true;
      midStreamRes.closed = true;
      return midStreamRes;
    },
  };

  try {
    file.errorHandler(errorObj, midStreamRes);
  } catch {
    // Never leave the outgoing stream hanging if a custom errorHandler throws
  }

  return shouldEnd && !shouldDestroy ? "close" : "error";
}

function createStreamableForwardingStream(
  reader: {
    read(): Promise<{ done: boolean; value?: unknown }>;
    cancel(): Promise<void>;
  },
  signal: AbortSignal,
  options?: ResumedReaderStreamOptions,
): ReadableStream<Uint8Array> {
  let cleanedUp = false;
  let streamController:
    | ReadableStreamDefaultController<Uint8Array>
    | undefined;

  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    signal.removeEventListener("abort", onAbort);
    void reader.cancel().catch(() => {});
  };

  const onAbort = () => {
    cleanup();
    try {
      streamController?.close();
    } catch {
      // Already closed
    }
  };

  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        streamController = controller;
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      },
      async pull(controller) {
        if (cleanedUp || signal.aborted) {
          cleanup();
          try {
            controller.close();
          } catch {
            // Already closed
          }
          return;
        }
        try {
          const step = await reader.read();
          if (step.done || cleanedUp || signal.aborted) {
            cleanup();
            if (options?.delayClose) {
              await new Promise((r) => setTimeout(r, 0));
            }
            try {
              controller.close();
            } catch {
              // Already closed
            }
            return;
          }
          const bytes = encodeStreamChunk(step.value);
          if (bytes.byteLength > 0) {
            controller.enqueue(bytes);
          }
        } catch (err) {
          cleanedUp = true;
          signal.removeEventListener("abort", onAbort);
          void reader.cancel().catch(() => {});
          const action = options?.onError ? options.onError(err) : "error";
          await new Promise((r) => setTimeout(r, 5));
          try {
            if (action === "close") {
              controller.close();
            } else {
              controller.error(err);
            }
          } catch {
            // Already closed
          }
        }
      },
      cancel() {
        cleanup();
      },
    },
    { highWaterMark: 0 },
  );
}

function createResumedReaderStream(
  firstBytes: Uint8Array,
  reader: {
    read(): Promise<{ done: boolean; value?: unknown }>;
    cancel(): Promise<void>;
  },
  signal: AbortSignal,
  options?: ResumedReaderStreamOptions,
): ReadableStream<Uint8Array> {
  let sentFirst = false;
  let cleanedUp = false;
  let streamController:
    | ReadableStreamDefaultController<Uint8Array>
    | undefined;

  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    signal.removeEventListener("abort", onAbort);
    void reader.cancel().catch(() => {});
  };

  const onAbort = () => {
    cleanup();
    try {
      streamController?.close();
    } catch {
      // Already closed
    }
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    },
    async pull(controller) {
      if (!sentFirst) {
        sentFirst = true;
        if (firstBytes.byteLength > 0) {
          controller.enqueue(firstBytes);
        }
        return;
      }
      if (cleanedUp || signal.aborted) {
        cleanup();
        try {
          controller.close();
        } catch {
          // Already closed
        }
        return;
      }
      try {
        const step = await reader.read();
        if (step.done || cleanedUp || signal.aborted) {
          cleanup();
          if (options?.delayClose) {
            await new Promise((r) => setTimeout(r, 0));
          }
          try {
            controller.close();
          } catch {
            // Already closed
          }
          return;
        }
        const bytes = encodeStreamChunk(step.value);
        if (bytes.byteLength > 0) {
          controller.enqueue(bytes);
        }
      } catch (err) {
        cleanedUp = true;
        signal.removeEventListener("abort", onAbort);
        void reader.cancel().catch(() => {});
        const action = options?.onError ? options.onError(err) : "error";
        // Allow Bun.serve to flush any already-enqueued first chunk before aborting the stream
        await new Promise((r) => setTimeout(r, 5));
        try {
          if (action === "close") {
            controller.close();
          } else {
            controller.error(err);
          }
        } catch {
          // Already closed
        }
      }
    },
    cancel() {
      cleanup();
    },
  });
}

function createResumedAsyncIteratorStream(
  firstBytes: Uint8Array,
  iterator: AsyncIterator<unknown>,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  let sentFirst = false;
  let cleanedUp = false;
  let streamController:
    | ReadableStreamDefaultController<Uint8Array>
    | undefined;

  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    signal.removeEventListener("abort", onAbort);
    if (typeof iterator.return === "function") {
      void Promise.resolve(iterator.return()).catch(() => {});
    }
  };

  const onAbort = () => {
    cleanup();
    try {
      streamController?.close();
    } catch {
      // Already closed
    }
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    },
    async pull(controller) {
      if (!sentFirst) {
        sentFirst = true;
        if (firstBytes.byteLength > 0) {
          controller.enqueue(firstBytes);
        }
        return;
      }
      if (cleanedUp || signal.aborted) {
        cleanup();
        try {
          controller.close();
        } catch {
          // Already closed
        }
        return;
      }
      try {
        while (true) {
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
          const bytes = encodeStreamChunk(step.value);
          if (bytes.byteLength > 0) {
            controller.enqueue(bytes);
            return;
          }
        }
      } catch (err) {
        cleanup();
        try {
          controller.error(err);
        } catch {
          // Already closed
        }
      }
    },
    cancel() {
      cleanup();
    },
  });
}

/**
 * Async-capable response serializer used by the HTTP execution pipeline.
 * Returns a `Response` synchronously for non-streaming values (zero overhead),
 * and returns a `Promise<Response>` for streaming values (`Response` with body,
 * `StreamableFile`, `ReadableStream`, `AsyncIterable`, `@Sse()`) so pre-first-chunk
 * errors route through NestJS exception filters before HTTP headers are committed.
 */
export function serializeResponseMaybeAsync(
  value: unknown,
  route: RouteResponseMeta,
  ctx: RequestContext,
): Response | Promise<Response> {
  const reqMethod = ctx.request.method;

  // 1. Native Response with ReadableStream body: pre-pull first chunk to catch pre-commit errors
  if (value instanceof Response) {
    const merged = mergeHeadersOntoNativeResponse(value, ctx, route.headers);
    if (
      merged.body === null ||
      isEmptyBodyStatus(merged.status, reqMethod)
    ) {
      return merged;
    }
    return (async () => {
      const reader = merged.body!.getReader();
      const first = await raceWithAbort(reader.read(), ctx.signal);
      if (first === ABORTED_SENTINEL) {
        void reader.cancel().catch(() => {});
        return new Response(null, { status: merged.status, headers: merged.headers });
      }
      if (first.done) {
        return new Response(null, { status: merged.status, headers: merged.headers });
      }
      const firstBytes = encodeStreamChunk(first.value);
      const resumed = createResumedReaderStream(firstBytes, reader, ctx.signal);
      return new Response(resumed, {
        status: merged.status,
        statusText: merged.statusText,
        headers: merged.headers,
      });
    })();
  }

  const hasResCtx = ctx.hasResponseContext();
  const dynamicStatus = hasResCtx ? ctx.responseContext.getStatus() : undefined;
  const status =
    dynamicStatus ??
    route.httpCode ??
    getDefaultStatusForMethod(route.method, reqMethod);

  // 2. @Sse() with AsyncIterable: opportunistically check if first event is immediately ready
  //    so synchronous/immediate serialization errors (e.g. BigInt) return 500 JSON before committing SSE headers
  if (
    route.isSse &&
    !isEmptyBodyStatus(status, reqMethod) &&
    isAsyncIterable(value)
  ) {
    return (async () => {
      const headers = buildMergedHeaders(
        ctx,
        route.headers,
        "text/event-stream; charset=utf-8",
        {
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
        },
      );
      headers.set("Content-Type", "text/event-stream; charset=utf-8");

      const iterator = value[Symbol.asyncIterator]();
      const firstStepPromise = iterator.next();
      const raced = await Promise.race([
        firstStepPromise,
        new Promise<typeof PENDING_SENTINEL>((resolve) =>
          setTimeout(() => resolve(PENDING_SENTINEL), 0),
        ),
      ]);

      if (raced === PENDING_SENTINEL) {
        const stream = createSseStream(
          value,
          ctx.signal,
          route.sseOptions,
          () => ctx.abortSseSignal(),
          { iterator, pendingFirstStep: firstStepPromise, nextAutoId: 1 },
        );
        return new Response(stream, { status, headers });
      }

      if (raced.done) {
        ctx.abortSseSignal();
        return new Response(null, { status, headers });
      }

      // Format first event before committing HTTP 200 SSE headers
      let firstChunk: Uint8Array;
      let nextAutoId = 1;
      try {
        const ev =
          typeof raced.value === "object" &&
          raced.value !== null &&
          ("data" in raced.value || "comment" in raced.value)
            ? (raced.value as SseMessageEvent)
            : { data: raced.value };
        const hasData = ev.data !== undefined || ev.comment === undefined;
        const autoId = ev.id === undefined && hasData ? nextAutoId++ : undefined;
        firstChunk = textEncoder.encode(
          formatSseEvent(raced.value as SseMessageEvent, autoId),
        );
      } catch (err) {
        if (typeof iterator.return === "function") {
          void Promise.resolve(iterator.return()).catch(() => {});
        }
        ctx.abortSseSignal();
        if (err instanceof HttpException) throw err;
        throw new InternalServerErrorException("Failed to serialize SSE event", {
          cause: err,
        });
      }

      const stream = createSseStream(
        value,
        ctx.signal,
        route.sseOptions,
        () => ctx.abortSseSignal(),
        { iterator, firstChunk, nextAutoId },
      );
      return new Response(stream, { status, headers });
    })();
  }

  // 3. StreamableFile:
  //    - BunFile: verify file exists before committing 200 headers
  //    - ReadableStream: pre-pull first chunk so pre-header failures invoke
  //      `value.errorHandler(err, adapterRes)` and mid-stream failures invoke
  //      `value.errorHandler(err, { headersSent: true, ... })`
  if (value instanceof StreamableFile) {
    const src = value.getSource();
    if (
      src &&
      typeof (src as unknown as { exists?: () => Promise<boolean> }).exists ===
        "function"
    ) {
      return (async () => {
        const exists = await (
          src as unknown as { exists: () => Promise<boolean> }
        ).exists();
        if (!exists) {
          throw new NotFoundException("File not found");
        }
        return serializeResponse(value, route, ctx);
      })();
    }
    if (src instanceof ReadableStream) {
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
      const forceChunked =
        headers.get("transfer-encoding")?.toLowerCase().includes("chunked") ??
        false;
      if (forceChunked) {
        headers.delete("content-length");
        headers.delete("transfer-encoding");
      }
      if (isEmptyBodyStatus(status, reqMethod)) {
        void src.cancel().catch(() => {});
        return new Response(null, { status, headers });
      }
      return (async () => {
        let reader:
          | {
              read(): Promise<{ done: boolean; value?: unknown }>;
              cancel(): Promise<void>;
              closed: Promise<unknown>;
            }
          | undefined;
        try {
          reader = src.getReader();
        } catch (err) {
          return invokeStreamablePreHeaderErrorHandler(
            value,
            err,
            ctx,
            route.headers,
          );
        }

        const activeReader = reader;
        const preflight = await Promise.race<
          "closed" | "ready" | { readonly error: unknown }
        >([
          activeReader.closed.then(
            () => "closed" as const,
            (err: unknown) => ({ error: err }),
          ),
          new Promise<"ready">((resolve) => setTimeout(() => resolve("ready"), 0)),
        ]);

        if (typeof preflight === "object" && "error" in preflight) {
          void activeReader.cancel().catch(() => {});
          return invokeStreamablePreHeaderErrorHandler(
            value,
            preflight.error,
            ctx,
            route.headers,
          );
        }

        if (preflight === "closed") {
          return new Response(null, { status, headers });
        }

        const forwarded = createStreamableForwardingStream(
          activeReader,
          ctx.signal,
          {
            delayClose: forceChunked,
            onError: (err) => invokeStreamableMidStreamErrorHandler(value, err),
          },
        );
        return new Response(forwarded, { status, headers });
      })();
    }
    return serializeResponse(value, route, ctx);
  }

  // 4. Non-SSE ReadableStream: pre-pull first chunk, infer Content-Type, catch pre-commit errors
  if (!route.isSse && !route.redirect && value instanceof ReadableStream) {
    if (isEmptyBodyStatus(status, reqMethod)) {
      void value.cancel().catch(() => {});
      const headers = buildMergedHeaders(
        ctx,
        route.headers,
        "application/octet-stream",
      );
      return new Response(null, { status, headers });
    }
    if (value.locked) {
      throw new InternalServerErrorException("ReadableStream is already locked");
    }
    return (async () => {
      const reader = value.getReader();
      let first: { done: boolean; value?: unknown } | typeof ABORTED_SENTINEL;
      try {
        first = await raceWithAbort(reader.read(), ctx.signal);
      } catch (err) {
        void reader.cancel().catch(() => {});
        throw err;
      }
      if (first === ABORTED_SENTINEL) {
        void reader.cancel().catch(() => {});
        const headers = buildMergedHeaders(
          ctx,
          route.headers,
          "application/octet-stream",
        );
        return new Response(null, { status, headers });
      }
      if (first.done) {
        const headers = buildMergedHeaders(
          ctx,
          route.headers,
          "application/octet-stream",
        );
        return new Response(null, { status, headers });
      }
      const defaultCt = inferStreamContentType(first.value);
      const headers = buildMergedHeaders(ctx, route.headers, defaultCt);
      const firstBytes = encodeStreamChunk(first.value);
      const resumed = createResumedReaderStream(firstBytes, reader, ctx.signal);
      return new Response(resumed, { status, headers });
    })();
  }

  // 5. Non-SSE AsyncIterable / AsyncGenerator: pre-pull first item, infer Content-Type, stream
  if (
    !route.isSse &&
    !route.redirect &&
    !(value instanceof Blob) &&
    !isBinaryChunk(value) &&
    isAsyncIterable(value)
  ) {
    if (isEmptyBodyStatus(status, reqMethod)) {
      const headers = buildMergedHeaders(
        ctx,
        route.headers,
        "application/octet-stream",
      );
      return new Response(null, { status, headers });
    }
    return (async () => {
      const iterator = value[Symbol.asyncIterator]();
      const first = await raceWithAbort(iterator.next(), ctx.signal);
      if (first === ABORTED_SENTINEL) {
        if (typeof iterator.return === "function") {
          void Promise.resolve(iterator.return()).catch(() => {});
        }
        const headers = buildMergedHeaders(ctx, route.headers);
        return new Response(null, { status, headers });
      }
      if (first.done) {
        const headers = buildMergedHeaders(ctx, route.headers);
        return new Response(null, { status, headers });
      }
      const defaultCt = inferStreamContentType(first.value);
      const headers = buildMergedHeaders(ctx, route.headers, defaultCt);
      const firstBytes = encodeStreamChunk(first.value);
      const resumed = createResumedAsyncIteratorStream(
        firstBytes,
        iterator,
        ctx.signal,
      );
      return new Response(resumed, { status, headers });
    })();
  }

  return serializeResponse(value, route, ctx);
}
