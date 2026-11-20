import {
  Inject,
  Injectable,
  Optional,
  Reflector,
  type BunestInterceptor,
  type CallHandler,
  type ExecutionContext,
  type ResponseContext,
} from "@bunest/common";
import { Cache } from "./cache.abstract";
import {
  CACHE_KEY_METADATA,
  CACHE_MANAGER,
  CACHE_TTL_METADATA,
  NO_CACHE_METADATA,
} from "./constants";
import type {
  CacheKeyMetadataValue,
  CacheTtlMetadataValue,
} from "./interfaces/cache.interface";

interface CachedHttpResponseEnvelope {
  readonly __bunestCachedResponse: true;
  readonly status: number;
  readonly statusText: string;
  readonly headers: ReadonlyArray<readonly [string, string]>;
  readonly bodyBase64: string;
}

function isCachedResponseEnvelope(
  value: unknown,
): value is CachedHttpResponseEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Partial<CachedHttpResponseEnvelope>).__bunestCachedResponse ===
      true
  );
}

function hasCacheControlDirective(
  headerValue: string | null | undefined,
  directive: string,
): boolean {
  if (!headerValue) {
    return false;
  }
  return headerValue
    .toLowerCase()
    .split(",")
    .some((part) => part.trim().split("=")[0]?.trim() === directive);
}

function hasSetCookieHeader(headers: Headers | undefined): boolean {
  if (!headers) {
    return false;
  }
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie().length > 0;
  }
  return headers.has("set-cookie");
}

function isNonCacheableStreamOrBinary(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (
    typeof ReadableStream !== "undefined" &&
    value instanceof ReadableStream
  ) {
    return true;
  }
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return true;
  }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return true;
  }
  if (
    typeof (value as { [Symbol.asyncIterator]?: unknown })[
      Symbol.asyncIterator
    ] === "function"
  ) {
    return true;
  }
  return false;
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function base64ToBytes(encoded: string): Uint8Array {
  return new Uint8Array(Buffer.from(encoded, "base64"));
}

/**
 * HTTP response caching interceptor supporting `@CacheKey()` (static or factory),
 * `@CacheTTL()` (static ms or `CacheTTLFactory`), and `@NoCache()`. Safely
 * caches only allowed HTTP methods (default `GET`), skips error responses and
 * streams/SSE/binary payloads, honors `Cache-Control: no-store`, and exposes
 * NestJS subclassing hooks (`trackBy`, `isRequestCacheable`, `setHeadersWhenHttp`).
 */
@Injectable()
export class CacheInterceptor implements BunestInterceptor {
  protected readonly cacheManager: Cache;
  protected readonly reflector: Reflector;
  protected allowedMethods: string[] = ["GET"];

  constructor(
    @Inject(CACHE_MANAGER)
    cacheManager: Cache,
    @Optional()
    @Inject(Reflector)
    reflector?: Reflector,
  ) {
    this.cacheManager = cacheManager;
    this.reflector = reflector ?? new Reflector();
  }

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<unknown> {
    if (context.getType() !== "http") {
      return await next.handle();
    }

    const targets = [context.getHandler(), context.getClass()];
    const noCache = this.reflector.getAllAndOverride<boolean>(
      NO_CACHE_METADATA,
      targets,
    );
    if (noCache) {
      return await next.handle();
    }

    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const responseContext = http.getResponse<ResponseContext>();

    if (!request || !this.isRequestCacheable(context)) {
      return await next.handle();
    }

    const reqCacheControl = request.headers.get("cache-control");
    if (hasCacheControlDirective(reqCacheControl, "no-store")) {
      return await next.handle();
    }

    const bypassRead = hasCacheControlDirective(reqCacheControl, "no-cache");
    const cacheKey = await this.trackBy(context);
    if (!cacheKey) {
      return await next.handle();
    }

    if (!bypassRead) {
      const cached = await this.cacheManager.get(cacheKey);
      if (cached !== undefined) {
        this.setHeadersWhenHttp(context, cached);
        if (isCachedResponseEnvelope(cached)) {
          const headers = new Headers(cached.headers as [string, string][]);
          headers.set("X-Cache", "HIT");
          return new Response(base64ToBytes(cached.bodyBase64), {
            status: cached.status,
            statusText: cached.statusText,
            headers,
          });
        }
        return cached;
      }
    }

    const result = await next.handle();

    if (result === undefined || isNonCacheableStreamOrBinary(result)) {
      return result;
    }

    const ttlMeta = this.reflector.getAllAndOverride<CacheTtlMetadataValue>(
      CACHE_TTL_METADATA,
      targets,
    );
    const ttlMs =
      typeof ttlMeta === "function" ? await ttlMeta(context) : ttlMeta;

    const responseHeaders = responseContext?.getHeaders?.();

    if (typeof Response !== "undefined" && result instanceof Response) {
      const resCacheControl = result.headers.get("cache-control");
      const contentType = result.headers.get("content-type") ?? "";

      if (
        result.status < 200 ||
        result.status >= 300 ||
        hasSetCookieHeader(result.headers) ||
        hasSetCookieHeader(responseHeaders) ||
        hasCacheControlDirective(resCacheControl, "no-store") ||
        hasCacheControlDirective(resCacheControl, "private") ||
        contentType.toLowerCase().includes("text/event-stream")
      ) {
        return result;
      }

      const cloned = result.clone();
      const bodyBytes = new Uint8Array(await cloned.arrayBuffer());
      const headersList: Array<[string, string]> = [];
      result.headers.forEach((v, k) => headersList.push([k, v]));

      const envelope: CachedHttpResponseEnvelope = {
        __bunestCachedResponse: true,
        status: result.status,
        statusText: result.statusText,
        headers: headersList,
        bodyBase64: bytesToBase64(bodyBytes),
      };

      await this.cacheManager.set(cacheKey, envelope, ttlMs);
      this.setHeadersWhenHttp(context, undefined);
      return result;
    }

    const explicitStatus = responseContext?.getStatus?.();
    const resHeaderCacheControl = responseHeaders?.get("cache-control");

    if (
      (explicitStatus !== undefined &&
        (explicitStatus < 200 || explicitStatus >= 300)) ||
      hasSetCookieHeader(responseHeaders) ||
      hasCacheControlDirective(resHeaderCacheControl, "no-store") ||
      hasCacheControlDirective(resHeaderCacheControl, "private")
    ) {
      return result;
    }

    await this.cacheManager.set(cacheKey, result, ttlMs);
    this.setHeadersWhenHttp(context, undefined);
    return result;
  }

  protected async trackBy(
    context: ExecutionContext,
  ): Promise<string | undefined | null> {
    const request = context.switchToHttp().getRequest<Request>();
    const customKey = this.reflector.getAllAndOverride<CacheKeyMetadataValue>(
      CACHE_KEY_METADATA,
      [context.getHandler(), context.getClass()],
    );

    if (typeof customKey === "function") {
      return await customKey(context);
    }
    if (typeof customKey === "string" && customKey.length > 0) {
      return customKey;
    }

    if (!request || !this.isRequestCacheable(context)) {
      return undefined;
    }

    return this.resolveCacheKey(context, request);
  }

  protected isRequestCacheable(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (!request) {
      return false;
    }
    return this.allowedMethods.includes(request.method.toUpperCase());
  }

  protected setHeadersWhenHttp(context: ExecutionContext, value: unknown): void {
    if (context.getType() !== "http") {
      return;
    }
    const responseContext = context
      .switchToHttp()
      .getResponse<ResponseContext>();
    responseContext?.header?.(
      "X-Cache",
      value === undefined || value === null ? "MISS" : "HIT",
    );
  }

  protected resolveCacheKey(
    context: ExecutionContext,
    request: Request,
  ): string {
    const customKey = this.reflector.getAllAndOverride<CacheKeyMetadataValue>(
      CACHE_KEY_METADATA,
      [context.getHandler(), context.getClass()],
    );

    if (typeof customKey === "string" && customKey.length > 0) {
      return customKey;
    }

    const url = new URL(request.url);
    return `${url.pathname}${url.search}`;
  }
}
