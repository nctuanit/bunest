import {
  type ArgumentsHost,
  type ExceptionFilter,
  type ExceptionFilterLike,
  HttpException,
  HttpStatus,
  IntrinsicException,
  Logger,
  type LoggerService,
  METADATA_KEYS,
  MetadataRegistry,
  type Type,
} from "../../common/index";
import type { RequestContext } from "../context/request-context";
import { mergeCorsHeaders } from "../security/cors";
import {
  mergeHeadersOntoNativeResponse,
  serializeResponse,
} from "./response-serializer";

export interface CompiledExceptionFilter {
  readonly filter: ExceptionFilter;
  readonly catchTypes: readonly Type<any>[];
}

export interface DefaultExceptionFilterOptions {
  readonly development?: boolean | (() => boolean | undefined);
  readonly logger?: LoggerService | (() => LoggerService);
}

/**
 * Reads `@Catch(...)` metadata once at bootstrap so the hot error path performs
 * zero `Reflect.getMetadata()` lookups.
 */
export function extractFilterCatchTypes(
  filterOrClass: ExceptionFilterLike,
): readonly Type<any>[] {
  const ctor =
    typeof filterOrClass === "function"
      ? filterOrClass
      : (filterOrClass as object).constructor;

  if (typeof ctor !== "function") {
    return [];
  }

  const types = MetadataRegistry.get<readonly Type<any>[]>(
    METADATA_KEYS.CATCH_EXCEPTIONS,
    ctor,
  );
  return types ? [...types] : [];
}

function isProductionRuntime(developmentOption: boolean | undefined): boolean {
  if (process.env.NODE_ENV === "production") {
    return true;
  }
  if (developmentOption === false) {
    return true;
  }
  return false;
}

function buildErrorHeaders(
  ctx: RequestContext,
  extraHeaders?: Record<string, string>,
): Headers {
  const headers = new Headers();
  headers.set("Content-Type", "application/json; charset=utf-8");

  // Preserve CORS headers on error responses (ADR-008 §2.2 & §2.10)
  if (ctx.hasCorsHeaders()) {
    mergeCorsHeaders(headers, ctx.corsHeaders);
  }

  // Preserve any ResponseContext headers/cookies
  if (ctx.hasResponseContext()) {
    const resCtx = ctx.responseContext;
    const resHeaders = resCtx.getHeadersIfInitialized();
    if (resHeaders) {
      resHeaders.forEach((value, key) => {
        if (key.toLowerCase() === "set-cookie") return;
        headers.set(key, value);
      });
    }
    for (const cookie of resCtx.getSetCookies()) {
      headers.append("Set-Cookie", cookie);
    }
  }

  // Apply exception-specific headers (e.g. `Allow` on 405 Method Not Allowed)
  if (extraHeaders) {
    for (const [name, value] of Object.entries(extraHeaders)) {
      if (name.toLowerCase() === "set-cookie") {
        headers.append("Set-Cookie", value);
      } else {
        headers.set(name, value);
      }
    }
  }

  return headers;
}

/**
 * Built-in lowest-precedence exception filter (ADR-008 §2.10).
 * Normalizes `HttpException` responses, preserves exception headers (`Allow`, etc.)
 * and CORS headers, and never leaks stack traces or internal messages in production.
 */
export class DefaultExceptionFilter implements ExceptionFilter {
  private readonly development?: boolean | (() => boolean | undefined);
  private readonly logger: LoggerService | (() => LoggerService);

  constructor(options: DefaultExceptionFilterOptions = {}) {
    this.development = options.development;
    this.logger = options.logger ?? new Logger("ExceptionHandler");
  }

  private resolveDevelopmentFlag(): boolean | undefined {
    return typeof this.development === "function"
      ? this.development()
      : this.development;
  }

  private resolveLogger(): LoggerService {
    return typeof this.logger === "function" ? this.logger() : this.logger;
  }

  catch(
    exception: unknown,
    _host: ArgumentsHost,
    ctx?: RequestContext,
  ): Response {
    const reqCtx = ctx;
    const devFlag = this.resolveDevelopmentFlag();
    const isProd = isProductionRuntime(devFlag);
    const timestamp = new Date().toISOString();
    const path = reqCtx?.pathname ?? "/";

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const rawJson = exception.toJSON();
      const body: Record<string, unknown> = {
        ...rawJson,
        timestamp: rawJson.timestamp ?? timestamp,
        path: rawJson.path ?? path,
      };
      // Ensure stack trace is never accidentally exposed in production
      if (isProd && "stack" in body) {
        delete body.stack;
      }

      const headers = reqCtx
        ? buildErrorHeaders(reqCtx, exception.getHeaders())
        : new Headers({
            "Content-Type": "application/json; charset=utf-8",
            ...(exception.getHeaders() ?? {}),
          });

      if (
        reqCtx?.request.method === "HEAD" ||
        status === HttpStatus.NO_CONTENT ||
        status === HttpStatus.NOT_MODIFIED
      ) {
        return new Response(null, { status, headers });
      }

      return new Response(JSON.stringify(body), { status, headers });
    }

    // Unknown / non-HttpException error -> log internally (unless IntrinsicException), return safe 500
    if (!(exception instanceof IntrinsicException)) {
      const activeLogger = this.resolveLogger();
      if (exception instanceof Error) {
        activeLogger.error(exception.message, exception.stack);
      } else {
        activeLogger.error("Unhandled non-Error exception", exception);
      }
    }

    const exposeDetails = !isProd && devFlag === true;
    const payload: Record<string, unknown> = {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message:
        exposeDetails && exception instanceof Error
          ? exception.message
          : "Internal server error",
      error: "Internal Server Error",
      timestamp,
      path,
    };

    if (exposeDetails && exception instanceof Error && exception.stack) {
      payload.stack = exception.stack;
    }

    const headers = reqCtx
      ? buildErrorHeaders(reqCtx)
      : new Headers({ "Content-Type": "application/json; charset=utf-8" });

    if (reqCtx?.request.method === "HEAD") {
      return new Response(null, {
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        headers,
      });
    }

    return new Response(JSON.stringify(payload), {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      headers,
    });
  }
}

function matchesExceptionFilter(
  error: unknown,
  catchTypes: readonly Type<any>[],
): boolean {
  if (catchTypes.length === 0) {
    return true;
  }
  for (let i = 0; i < catchTypes.length; i++) {
    const ExceptionCtor = catchTypes[i];
    if (typeof ExceptionCtor === "function" && error instanceof ExceptionCtor) {
      return true;
    }
  }
  return false;
}

/**
 * Runs exception filters in strict ADR-008 precedence order:
 * `Method -> Controller -> Global -> DefaultExceptionFilter`.
 */
export async function executeExceptionFilters(
  error: unknown,
  compiledFilters: readonly CompiledExceptionFilter[],
  defaultFilter: DefaultExceptionFilter,
  ctx: RequestContext,
  host: ArgumentsHost,
): Promise<Response> {
  for (let i = 0; i < compiledFilters.length; i++) {
    const entry = compiledFilters[i];
    if (!entry || !matchesExceptionFilter(error, entry.catchTypes)) {
      continue;
    }

    try {
      const result = await entry.filter.catch(error, host);

      if (result instanceof Response) {
        return mergeHeadersOntoNativeResponse(result, ctx);
      }

      const fallbackStatus =
        ctx.responseContext.getStatus() ??
        (error instanceof HttpException
          ? error.getStatus()
          : HttpStatus.INTERNAL_SERVER_ERROR);

      if (result !== undefined) {
        return serializeResponse(
          result,
          { method: "GET", httpCode: fallbackStatus },
          ctx,
        );
      }

      // Filter returned void after configuring ResponseContext
      const headers = buildErrorHeaders(
        ctx,
        error instanceof HttpException ? error.getHeaders() : undefined,
      );
      return new Response(null, { status: fallbackStatus, headers });
    } catch (filterError) {
      return defaultFilter.catch(filterError, host, ctx);
    }
  }

  return defaultFilter.catch(error, host, ctx);
}
