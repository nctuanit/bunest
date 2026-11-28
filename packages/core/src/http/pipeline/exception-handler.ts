import {
  type ArgumentsHost,
  DomainException,
  type ExceptionFilter,
  type ExceptionFilterLike,
  HttpException,
  HttpStatus,
  IntrinsicException,
  isFunction,
  isInstanceof,
  isNumber,
  Logger,
  type LoggerService,
  METADATA_KEYS,
  MetadataRegistry,
  ternaryFor,
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
  if (Reflect.get(process.env, "NODE_ENV") === "production") {
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
const LOG_HTTP_ERROR_SYMBOL = Symbol.for("bunest.http.logHttpError");

const HTTP_STATUS_PHRASES: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  402: "Payment Required",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  406: "Not Acceptable",
  408: "Request Timeout",
  409: "Conflict",
  410: "Gone",
  411: "Length Required",
  412: "Precondition Failed",
  413: "Payload Too Large",
  414: "URI Too Long",
  415: "Unsupported Media Type",
  416: "Range Not Satisfiable",
  417: "Expectation Failed",
  418: "I'm a teapot",
  422: "Unprocessable Entity",
  423: "Locked",
  425: "Too Early",
  429: "Too Many Requests",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

/**
 * Wraps `http-errors`-shaped objects (`{ statusCode | status, message?, expose? }`)
 * thrown by middleware into an `HttpException` with `{ cause }` so NestJS
 * `@Catch(HttpException)` filters and `DefaultExceptionFilter` handle them uniformly.
 */
export function wrapHttpLikeMiddlewareError(err: unknown): unknown {
  if (err instanceof HttpException) {
    return err;
  }
  if (err === null || typeof err !== "object") {
    return err;
  }
  const obj = err as {
    statusCode?: unknown;
    status?: unknown;
    message?: unknown;
    expose?: unknown;
  };
  const rawStatus = [obj.statusCode, obj.status].find(isNumber);
  if (
    rawStatus === undefined ||
    !Number.isInteger(rawStatus) ||
    rawStatus < 400 ||
    rawStatus > 599
  ) {
    return err;
  }

  const phrase = HTTP_STATUS_PHRASES[rawStatus] ?? "Http Exception";
  const shouldExpose =
    obj.expose === true || (obj.expose !== false && rawStatus < 500);
  const message =
    shouldExpose && typeof obj.message === "string" && obj.message.length > 0
      ? obj.message
      : phrase;

  const wrapped = new HttpException(
    {
      statusCode: rawStatus,
      message,
      error: phrase,
    },
    rawStatus,
    { cause: err },
  );
  if (rawStatus >= 500 || obj.expose === false) {
    Object.defineProperty(wrapped, LOG_HTTP_ERROR_SYMBOL, {
      value: true,
      enumerable: false,
    });
  }
  return wrapped;
}

const STANDARD_ERROR_KEYS = new Set(["name", "message", "stack", "cause"]);
const MAX_ERROR_CAUSE_DEPTH = 10;

function safeSerializeValue(value: unknown, seen = new WeakSet<object>()): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null ||
    value === undefined
  ) {
    return String(value);
  }
  if (typeof value === "bigint") {
    return `${value.toString()}n`;
  }
  if (typeof value === "symbol" || typeof value === "function") {
    return String(value);
  }
  try {
    return JSON.stringify(value, (_k, v: unknown) => {
      if (typeof v === "bigint") return `${v.toString()}n`;
      if (typeof v === "object" && v !== null) {
        if (seen.has(v)) return "[Circular]";
        seen.add(v);
      }
      return v;
    });
  } catch {
    return String(value);
  }
}

function extractEnumerableErrorProperties(
  err: Error,
): Record<string, unknown> | undefined {
  const keys = Object.keys(err);
  let customProps: Record<string, unknown> | undefined;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!;
    if (STANDARD_ERROR_KEYS.has(key)) continue;
    customProps ??= {};
    try {
      customProps[key] = (err as unknown as Record<string, unknown>)[key];
    } catch {
      customProps[key] = "[Unreadable]";
    }
  }
  return customProps;
}

/**
 * Formats an `Error` for internal server error logging, appending any enumerable
 * custom properties (e.g. `code`, `detail`) and walking the ES2022 `error.cause`
 * chain with cycle detection and depth bounding.
 */
export function formatErrorForInternalLog(error: Error): string | undefined {
  const baseStack = error.stack;
  const rootProps = extractEnumerableErrorProperties(error);
  const rootCause = (error as { cause?: unknown }).cause;

  if (rootProps === undefined && rootCause === undefined) {
    return baseStack;
  }

  const parts: string[] = [];
  if (baseStack) {
    parts.push(baseStack);
  } else {
    parts.push(`${error.name || "Error"}: ${error.message}`);
  }

  if (rootProps !== undefined) {
    parts.push(`  [properties]: ${safeSerializeValue(rootProps)}`);
  }

  if (rootCause !== undefined) {
    const seen = new Set<object>([error]);
    let current: unknown = rootCause;
    let depth = 0;

    while (current !== undefined) {
      if (depth >= MAX_ERROR_CAUSE_DEPTH) {
        parts.push("Caused by: [Max cause depth reached]");
        break;
      }
      depth += 1;

      if (typeof current === "object" && current !== null) {
        if (seen.has(current)) {
          parts.push("Caused by: [Circular]");
          break;
        }
        seen.add(current);
      }

      if (current instanceof Error) {
        const causeHeader =
          current.stack || `${current.name || "Error"}: ${current.message}`;
        parts.push(`Caused by: ${causeHeader}`);
        const causeProps = extractEnumerableErrorProperties(current);
        if (causeProps !== undefined) {
          parts.push(`  [properties]: ${safeSerializeValue(causeProps)}`);
        }
        current = (current as { cause?: unknown }).cause;
      } else {
        parts.push(`Caused by: ${safeSerializeValue(current)}`);
        break;
      }
    }
  }

  return parts.join("\n");
}

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
      if (
        (exception as unknown as Record<symbol, unknown>)[
          LOG_HTTP_ERROR_SYMBOL
        ] === true
      ) {
        const activeLogger = this.resolveLogger();
        const rootCause =
          (exception as { cause?: unknown }).cause ?? exception;
        if (rootCause instanceof Error) {
          activeLogger.error(
            rootCause.message,
            formatErrorForInternalLog(rootCause),
          );
        } else {
          activeLogger.error(
            exception.message,
            formatErrorForInternalLog(exception),
          );
        }
      }
      const status = exception.getStatus();
      const rawResponse = exception.getResponse();
      const rawJson = exception.toJSON();
      const hasCustomToJSON =
        exception.toJSON !== HttpException.prototype.toJSON;
      const body: Record<string, unknown> = hasCustomToJSON
        ? { ...rawJson }
        : {
            ...rawJson,
            ...(rawResponse instanceof Error
              ? { message: HTTP_STATUS_PHRASES[status] ?? "Http Exception" }
              : {}),
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

    if (exception instanceof DomainException) {
      const status = exception.httpStatus;
      if (exception.kind === "internal") {
        const activeLogger = this.resolveLogger();
        activeLogger.error(
          exception.message,
          formatErrorForInternalLog(exception),
        );
      }

      const hideInternal = exception.kind === "internal" && isProd;
      const body: Record<string, unknown> = {
        statusCode: status,
        error: HTTP_STATUS_PHRASES[status] ?? "Error",
        code: exception.code,
        message: hideInternal ? "Internal Server Error" : exception.message,
        ...(!hideInternal && exception.details !== undefined
          ? { details: exception.details }
          : {}),
        timestamp,
        path,
      };

      const headers = reqCtx
        ? buildErrorHeaders(reqCtx)
        : new Headers({ "Content-Type": "application/json; charset=utf-8" });

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
        activeLogger.error(
          exception.message,
          formatErrorForInternalLog(exception),
        );
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
      const filterObj = entry.filter as {
        catch?: (e: unknown, h: ArgumentsHost) => unknown;
        constructor?: { catch?: (e: unknown, h: ArgumentsHost) => unknown };
      };
      const result = isFunction(filterObj.catch)
        ? await filterObj.catch(error, host)
        : await (
            isFunction(filterObj.constructor?.catch)
              ? filterObj.constructor.catch(error, host)
              : entry.filter.catch(error, host)
          );

      if (result instanceof Response) {
        return mergeHeadersOntoNativeResponse(result, ctx);
      }

      const fallbackStatus =
        ctx.responseContext.getStatus() ??
        ternaryFor(error)
          .when(isInstanceof(HttpException), (e) => e.getStatus())
          .when(isInstanceof(DomainException), (e) => e.httpStatus)
          .elseEval(HttpStatus.INTERNAL_SERVER_ERROR);

      if (result !== undefined) {
        return serializeResponse(
          result,
          { method: "GET", httpCode: fallbackStatus },
          ctx,
        );
      }

      // Filter returned undefined: if it sent a response or mutated ResponseContext, respect it;
      // otherwise (e.g. a foreign/non-HTTP filter returning undefined), delegate to defaultFilter.
      const sent = ctx.hasResponseContext()
        ? ctx.responseContext.getSentResponse()
        : undefined;
      if (sent) {
        return mergeHeadersOntoNativeResponse(sent, ctx);
      }
      if (
        !ctx.hasResponseContext() ||
        (ctx.responseContext.getStatus() === undefined &&
          !ctx.responseContext.hasHeaderMutations())
      ) {
        return defaultFilter.catch(error, host, ctx);
      }
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
