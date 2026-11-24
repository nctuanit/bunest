import {
  Inject,
  Injectable,
  Optional,
  Reflector,
  StreamableFile,
  type BunestInterceptor,
  type CallHandler,
  type ExecutionContext,
  type ResponseContext,
} from "@bunest/core";
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
  if (value instanceof StreamableFile) {
    return true;
  }
  if (typeof Response !== "undefined" && value instanceof Response) {
    return true;
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
    const targets = [context.getHandler(), context.getClass()];
    const noCache = this.reflector.getAllAndOverride<boolean>(
      NO_CACHE_METADATA,
      targets,
    );
    if (noCache) {
      return await next.handle();
    }

    const isHttp = context.getType() === "http";
    let responseContext: ResponseContext | undefined;
    let bypassRead = false;

    if (isHttp) {
      const http = context.switchToHttp();
      const request = http.getRequest<Request>();
      responseContext = http.getResponse<ResponseContext>();

      if (!request || !this.isRequestCacheable(context)) {
        return await next.handle();
      }

      const reqCacheControl = request.headers.get("cache-control");
      if (hasCacheControlDirective(reqCacheControl, "no-store")) {
        return await next.handle();
      }

      bypassRead = hasCacheControlDirective(reqCacheControl, "no-cache");
    }

    const cacheKey = await this.trackBy(context);
    if (!cacheKey) {
      return await next.handle();
    }

    if (!bypassRead) {
      const cached = await this.cacheManager.get(cacheKey);
      if (cached !== undefined) {
        this.setHeadersWhenHttp(context, cached);
        return cached;
      }
    }

    const result = await next.handle();

    if (result === undefined || isNonCacheableStreamOrBinary(result)) {
      this.setHeadersWhenHttp(context, undefined);
      if (
        isHttp &&
        typeof Response !== "undefined" &&
        result instanceof Response &&
        !result.headers.has("x-cache")
      ) {
        try {
          result.headers.set("X-Cache", "MISS");
        } catch {
          // Response headers may be immutable
        }
      }
      return result;
    }

    const ttlMeta = this.reflector.getAllAndOverride<CacheTtlMetadataValue>(
      CACHE_TTL_METADATA,
      targets,
    );
    const ttlMs =
      typeof ttlMeta === "function" ? await ttlMeta(context) : ttlMeta;

    const responseHeaders = responseContext?.getHeaders?.();

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

    if (context.getType() !== "http") {
      return undefined;
    }

    const request = context.switchToHttp().getRequest<Request>();
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

  protected setHeadersWhenHttp(
    context: ExecutionContext,
    value: unknown,
  ): void {
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
