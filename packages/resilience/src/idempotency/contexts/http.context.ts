import {
  HttpException,
  METADATA_KEYS,
  MetadataRegistry,
  type ExecutionContext,
  type HeaderMetadata,
  type ParameterMetadata,
  type RedirectMetadata,
  type ResponseContext,
  type RouteHttpMethod,
} from "@bunest/core";
import type { HttpAdapterHost } from "@bunest/core";
import {
  getCurrentRequestContext,
  HttpResponseContext,
  type HttpExecutionContext,
  type RequestContext,
} from "@bunest/core/http";
import { REPLAYED_HEADER } from "../idempotency.constants";
import type { IdempotencyStoredResponse } from "../interfaces/idempotency-store.interface";
import {
  decodeResult,
  encodeResult,
  unreplayableReason,
} from "../utils/result.util";
import {
  captureHttpOrUnknownError,
  getHeaderFromRequest,
  rebuildHttpException,
  Unreplayable,
  unsupportedSource,
  type CallDescription,
  type Capture,
  type CaptureOptions,
  type DeclarativeKeySource,
  type IdempotencyContextAdapter,
  type IdempotencyRejection,
} from "./context.adapter";

const REASON: Record<number, string> = {
  400: "Bad Request",
  409: "Conflict",
  422: "Unprocessable Entity",
  500: "Internal Server Error",
};

/** Methods that don't change state (RFC 9110 "safe"). */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Legacy NestJS metadata keys for compatibility with plain mock tests. */
const NEST_SSE_METADATA = "__sse__";
const NEST_REDIRECT_METADATA = "__redirect__";
const NEST_HTTP_CODE_METADATA = "__httpCode__";
const NEST_ROUTE_ARGS_METADATA = "__routeArguments__";
const NEST_RESPONSE_PASSTHROUGH_METADATA = "__responsePassthrough__";
/** NestJS RouteParamtypes.RESPONSE = 1, RouteParamtypes.NEXT = 2. */
const NEST_RESPONSE_PARAMS = new Set(["1", "2"]);

interface HttpAdapterSubset {
  getRequestMethod?(req: unknown): string;
  getRequestUrl?(req: unknown): string;
  isHeadersSent?(res: unknown): boolean;
  getHeader?(res: unknown, name: string): unknown;
  setHeader?(res: unknown, name: string, value: string | string[]): unknown;
  status?(res: unknown, statusCode: number): unknown;
}

function getRequestMethod(
  req: unknown,
  adapter: HttpAdapterSubset | undefined,
): string {
  if (adapter && typeof adapter.getRequestMethod === "function") {
    try {
      const method = adapter.getRequestMethod(req);
      if (typeof method === "string" && method.length > 0) {
        return method.toUpperCase();
      }
    } catch {
      // Fallback below
    }
  }
  const raw = (req as { method?: unknown } | undefined)?.method;
  return typeof raw === "string" ? raw.toUpperCase() : "";
}

function getRequestUrl(
  req: unknown,
  adapter: HttpAdapterSubset | undefined,
): string {
  if (adapter && typeof adapter.getRequestUrl === "function") {
    try {
      const url = adapter.getRequestUrl(req);
      if (typeof url === "string") {
        return url;
      }
    } catch {
      // Fallback below
    }
  }
  const r = req as { originalUrl?: unknown; url?: unknown } | undefined;
  if (typeof r?.originalUrl === "string") return r.originalUrl;
  if (typeof r?.url === "string") return r.url;
  return "";
}

function isResponseHeadersSent(
  res: unknown,
  adapter: HttpAdapterSubset | undefined,
): boolean {
  if (!res || typeof res !== "object") {
    return false;
  }
  if (res instanceof HttpResponseContext) {
    return res.isHeadersSent();
  }
  if (adapter && typeof adapter.isHeadersSent === "function") {
    return Boolean(adapter.isHeadersSent(res));
  }
  const obj = res as { isHeadersSent?: () => boolean; headersSent?: unknown };
  if (typeof obj.isHeadersSent === "function") {
    return Boolean(obj.isHeadersSent());
  }
  return Boolean(obj.headersSent);
}

function getResponseHeader(
  res: unknown,
  name: string,
  adapter: HttpAdapterSubset | undefined,
): unknown {
  if (!res || typeof res !== "object") {
    return undefined;
  }
  if (res instanceof HttpResponseContext) {
    return res.getHeader(name);
  }
  if (adapter && typeof adapter.getHeader === "function") {
    return adapter.getHeader(res, name);
  }
  const obj = res as {
    getHeader?: (n: string) => unknown;
    getHeaders?: () => Headers | Record<string, unknown>;
  };
  if (typeof obj.getHeader === "function") {
    return obj.getHeader(name);
  }
  if (typeof obj.getHeaders === "function") {
    const hdrs = obj.getHeaders();
    if (hdrs instanceof Headers) {
      return hdrs.get(name) ?? undefined;
    }
    if (hdrs && typeof hdrs === "object") {
      return hdrs[name.toLowerCase()] ?? hdrs[name];
    }
  }
  return undefined;
}

function setResponseHeader(
  res: unknown,
  name: string,
  value: string | string[],
  adapter: HttpAdapterSubset | undefined,
): void {
  if (!res || typeof res !== "object") {
    return;
  }
  if (
    res instanceof HttpResponseContext ||
    typeof (res as ResponseContext).header === "function"
  ) {
    const resCtx = res as ResponseContext;
    if (Array.isArray(value)) {
      resCtx.removeHeader(name);
      for (const item of value) {
        resCtx.appendHeader(name, String(item));
      }
    } else {
      resCtx.header(name, String(value));
    }
    return;
  }
  if (adapter && typeof adapter.setHeader === "function") {
    adapter.setHeader(res, name, value);
    return;
  }
  const obj = res as { setHeader?: (n: string, v: string | string[]) => void };
  if (typeof obj.setHeader === "function") {
    obj.setHeader(name, value);
  }
}

function setResponseStatus(
  res: unknown,
  status: number,
  adapter: HttpAdapterSubset | undefined,
): void {
  if (!res || typeof res !== "object") {
    return;
  }
  if (
    res instanceof HttpResponseContext ||
    typeof (res as ResponseContext).status === "function"
  ) {
    (res as ResponseContext).status(status);
    return;
  }
  if (adapter && typeof adapter.status === "function") {
    adapter.status(res, status);
    return;
  }
  (res as { statusCode?: number }).statusCode = status;
}

export class HttpContextAdapter implements IdempotencyContextAdapter {
  readonly type = "http" as const;

  constructor(
    private readonly adapterHost: HttpAdapterHost | undefined,
    private readonly replayHeaders: string[],
  ) {}

  private get adapter() {
    return this.adapterHost?.httpAdapter;
  }

  coveredByClass(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<unknown>();
    return !SAFE_METHODS.has(getRequestMethod(req, this.adapter));
  }

  passThrough(context: ExecutionContext): string | undefined {
    const handler = context.getHandler();
    if (
      MetadataRegistry.get<boolean>(METADATA_KEYS.SSE, handler) ||
      MetadataRegistry.get(NEST_SSE_METADATA, handler)
    ) {
      return "Server-Sent Events are a stream, which can't be replayed";
    }
    return undefined;
  }

  userLocation(context: ExecutionContext): string | undefined {
    const req = context.switchToHttp().getRequest<{ user?: unknown }>();
    return req?.user ? "req.user" : undefined;
  }

  readKey(
    context: ExecutionContext,
    source: DeclarativeKeySource,
    header: string,
  ): unknown {
    const req = context.switchToHttp().getRequest<unknown>();
    if (source === "default") {
      return getHeaderFromRequest(req, header);
    }
    if ("header" in source) {
      return getHeaderFromRequest(req, source.header);
    }
    throw unsupportedSource(this.type, source);
  }

  target(context: ExecutionContext): unknown {
    return context.switchToHttp().getRequest();
  }

  async describe(context: ExecutionContext): Promise<CallDescription> {
    const req = context.switchToHttp().getRequest<unknown>();
    const method = getRequestMethod(req, this.adapter);
    const url = getRequestUrl(req, this.adapter);

    let payload: unknown;
    const reqCtx = this.getRequestContext(context, req);
    if (reqCtx) {
      payload = await reqCtx.getBody();
    } else if (typeof Request !== "undefined" && req instanceof Request) {
      payload = undefined;
    } else {
      payload = (req as { body?: unknown } | undefined)?.body;
    }

    return {
      // The concrete URL (not the route pattern), so the same key sent to
      // `/orders/1/refund` and `/orders/2/refund` is detected as misuse.
      identity: [method, url],
      payload,
    };
  }

  unreadBody(context: ExecutionContext, payload: unknown): string | undefined {
    const req = context.switchToHttp().getRequest<unknown>();
    const contentLength = getHeaderFromRequest(req, "content-length");
    const transferEncoding = getHeaderFromRequest(req, "transfer-encoding");
    const length = Number(contentLength);
    if (!(length > 0) && transferEncoding === undefined) {
      return undefined; // no body
    }

    const contentType = getHeaderFromRequest(req, "content-type");
    const type = String(contentType ?? "")
      .split(";")[0]!
      .trim()
      .toLowerCase();

    if (payload === undefined || payload === null) {
      return type || "no content type";
    }

    const proto =
      typeof payload === "object" ? Object.getPrototypeOf(payload) : undefined;
    const empty =
      (proto === Object.prototype || proto === null) &&
      Object.keys(payload as Record<string, unknown>).length === 0;
    return empty && type.startsWith("multipart/") ? type : undefined;
  }

  captureSuccess(
    context: ExecutionContext,
    value: unknown,
    opts: CaptureOptions,
  ): Capture {
    const res = context.switchToHttp().getResponse<unknown>();
    if (
      this.handlerWritesResponse(context, res) ||
      isResponseHeadersSent(res, this.adapter)
    ) {
      return new Unreplayable("it writes the response itself, with @Res()");
    }
    const reason = unreplayableReason(value);
    if (reason) {
      return new Unreplayable(reason);
    }

    const handler = context.getHandler();
    const dynamicStatus = this.getDynamicStatus(res);
    const httpCode =
      MetadataRegistry.get<number>(METADATA_KEYS.HTTP_CODE, handler) ??
      MetadataRegistry.get<number>(NEST_HTTP_CODE_METADATA, handler);

    let status =
      dynamicStatus ?? httpCode ?? this.getDefaultStatus(context, handler);
    const headers: Record<string, string | string[]> = {};

    const redirect =
      MetadataRegistry.get<RedirectMetadata>(METADATA_KEYS.REDIRECT, handler) ??
      MetadataRegistry.get<RedirectMetadata>(NEST_REDIRECT_METADATA, handler);

    if (redirect) {
      const r =
        value !== null && typeof value === "object"
          ? (value as { statusCode?: number; url?: string })
          : undefined;
      status =
        dynamicStatus ??
        r?.statusCode ??
        httpCode ??
        redirect.statusCode ??
        302;
      const locationUrl = r?.url ?? redirect.url;
      if (locationUrl) {
        headers.location = locationUrl;
      }
    }

    if (!opts.storeIf(status)) {
      return null;
    }

    const staticHeaders = MetadataRegistry.get<readonly HeaderMetadata[]>(
      METADATA_KEYS.HEADERS,
      handler,
    );

    for (const name of this.replayHeaders) {
      if (headers[name] !== undefined) {
        continue;
      }
      const dynamicVal = getResponseHeader(res, name, this.adapter);
      if (dynamicVal !== undefined && dynamicVal !== null) {
        headers[name] = Array.isArray(dynamicVal)
          ? dynamicVal.map(String)
          : String(dynamicVal);
        continue;
      }
      if (staticHeaders) {
        for (const entry of staticHeaders) {
          if (entry.name.toLowerCase() === name) {
            headers[name] = entry.value;
          }
        }
      }
    }

    return { status, headers, body: encodeResult(value) };
  }

  captureError(
    error: unknown,
    opts: CaptureOptions,
  ): IdempotencyStoredResponse | null {
    return captureHttpOrUnknownError(error, opts);
  }

  replay(
    context: ExecutionContext,
    stored: IdempotencyStoredResponse,
  ): unknown {
    const res = context.switchToHttp().getResponse<unknown>();
    for (const [name, value] of Object.entries(stored.headers)) {
      setResponseHeader(res, name, value, this.adapter);
    }
    setResponseHeader(res, REPLAYED_HEADER, "true", this.adapter);
    if (stored.error) {
      throw rebuildHttpException(stored);
    }
    setResponseStatus(res, stored.status, this.adapter);
    return decodeResult(stored.body);
  }

  reject(context: ExecutionContext, rejection: IdempotencyRejection): Error {
    let extraHeaders: Record<string, string> | undefined;
    if (rejection.retryAfter !== undefined) {
      const retryAfterStr = String(rejection.retryAfter);
      const res = context.switchToHttp().getResponse<unknown>();
      setResponseHeader(res, "Retry-After", retryAfterStr, this.adapter);
      extraHeaders = { "Retry-After": retryAfterStr };
    }
    return new HttpException(
      {
        statusCode: rejection.status,
        error: REASON[rejection.status] ?? "Error",
        code: rejection.code,
        message: rejection.message,
      },
      rejection.status,
      extraHeaders ? { headers: extraHeaders } : undefined,
    );
  }

  private getRequestContext(
    context: ExecutionContext,
    req: unknown,
  ): RequestContext | undefined {
    const fromExecCtx = (context as Partial<HttpExecutionContext>)
      .requestContext;
    if (fromExecCtx && fromExecCtx.request === req) {
      return fromExecCtx;
    }
    const fromAls = getCurrentRequestContext();
    if (fromAls && fromAls.request === req) {
      return fromAls;
    }
    return undefined;
  }

  private getDynamicStatus(res: unknown): number | undefined {
    if (!res || typeof res !== "object") {
      return undefined;
    }
    if (typeof (res as ResponseContext).getStatus === "function") {
      return (res as ResponseContext).getStatus();
    }
    const sc = (res as { statusCode?: unknown }).statusCode;
    return typeof sc === "number" ? sc : undefined;
  }

  private getDefaultStatus(
    context: ExecutionContext,
    handler: Function,
  ): number {
    const routeMethod = MetadataRegistry.get<RouteHttpMethod>(
      METADATA_KEYS.ROUTE_METHOD,
      handler,
    );
    const reqMethod = getRequestMethod(
      context.switchToHttp().getRequest<unknown>(),
      this.adapter,
    );
    const effective =
      routeMethod && routeMethod !== "ALL" ? routeMethod : reqMethod;
    return effective === "POST" ? 201 : 200;
  }

  /**
   * Detects handlers that bypass framework response serialization:
   * - NestJS-style `@Res()` / `@Next()` without `passthrough: true`
   * - Bunest `@Res({ passthrough: false })` explicitly set, or `@Next()`
   * Note: In Bunest, bare `@Res()` injects `HttpResponseContext` (header/status builder)
   * and handlers still return their body normally unless `markHeadersSent` is triggered.
   */
  private handlerWritesResponse(
    context: ExecutionContext,
    res: unknown,
  ): boolean {
    const handler = context.getHandler();
    const ctrlClass = context.getClass();
    const handlerKey = context.getHandlerKey?.() ?? handler.name;

    // 1. Check Bunest route parameter metadata
    const bunestParams = MetadataRegistry.get<readonly ParameterMetadata[]>(
      METADATA_KEYS.ROUTE_PARAMS,
      ctrlClass.prototype,
      handlerKey,
    );
    if (bunestParams && bunestParams.length > 0) {
      const explicitNonPassthrough = bunestParams.some(
        (p) =>
          p.source === "next" ||
          (p.source === "response" && p.passthrough === false),
      );
      if (explicitNonPassthrough) {
        return true;
      }
      // If using a non-Bunest response object (e.g., Express/Fastify mock) with @Res() without passthrough: true
      if (
        res &&
        !(res instanceof HttpResponseContext) &&
        typeof (res as ResponseContext).getStatus !== "function"
      ) {
        const takesResWithoutPassthrough = bunestParams.some(
          (p) => p.source === "response" && p.passthrough !== true,
        );
        if (takesResWithoutPassthrough) {
          return true;
        }
      }
    }

    // 2. Check legacy NestJS metadata format (for mock compatibility)
    const legacyParams =
      MetadataRegistry.get<Record<string, unknown>>(
        NEST_ROUTE_ARGS_METADATA,
        ctrlClass,
        handler.name,
      ) ?? {};
    const takesLegacyResponse = Object.keys(legacyParams).some((key) =>
      NEST_RESPONSE_PARAMS.has(key.split(":")[0] ?? ""),
    );
    if (
      takesLegacyResponse &&
      !MetadataRegistry.get(
        NEST_RESPONSE_PASSTHROUGH_METADATA,
        ctrlClass,
        handler.name,
      )
    ) {
      return true;
    }

    return false;
  }
}
