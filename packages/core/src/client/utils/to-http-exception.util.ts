import {
  BadGatewayException,
  GatewayTimeoutException,
  HttpException,
  Logger,
} from "../../common/index";
import { HttpClientError } from "../errors/http-client.error";
import { HttpResponseError } from "../errors/http-response.error";
import { HttpTimeoutError } from "../errors/http-timeout.error";

const HTTP_STATUS_TEXT: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  408: "Request Timeout",
  409: "Conflict",
  410: "Gone",
  413: "Payload Too Large",
  415: "Unsupported Media Type",
  422: "Unprocessable Entity",
  429: "Too Many Requests",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

export interface ToHttpExceptionOptions {
  /**
   * Upstream statuses to pass through with the upstream body (`true` = all).
   * Default none: an upstream failure is *our* 502, and the upstream body
   * (which may describe internals) is not sent to the caller.
   */
  forward?: boolean | number[] | undefined;
  /**
   * Log the failure (`Logger.error`, context `HttpClient`) when it becomes a
   * 5xx. Default `true`: Nest's exception filter never logs an
   * `HttpException`, so the 502/504 would otherwise go unrecorded.
   */
  log?: boolean | undefined;
}

const logger = new Logger("HttpClient");

/**
 * The exception a handler should throw for a failed upstream call:
 * `HttpResponseError` -> 502 (or the upstream status and body, when
 * forwarded), `HttpTimeoutError` and an `AbortSignal.timeout()` deadline -> 504,
 * `HttpNetworkError` and `HttpParseError` -> 502. The original error is the
 * `cause`, and mappings to a 5xx are logged unless `log: false`.
 *
 * Any other error, including an `HttpException`, is returned unchanged, so
 * Bunest's exception filters handle it as usual.
 */
export function toHttpException(
  error: HttpClientError,
  options?: ToHttpExceptionOptions,
): HttpException;
export function toHttpException(
  error: unknown,
  options?: ToHttpExceptionOptions,
): unknown;
export function toHttpException(
  error: unknown,
  options: ToHttpExceptionOptions = {},
): unknown {
  const exception = map(error, options.forward);
  if (!exception) {
    return error;
  }
  if (options.log !== false && exception.getStatus() >= 500) {
    const status = exception.getStatus();
    const answer =
      `answering ${status} ${HTTP_STATUS_TEXT[status] ?? ""}`.trimEnd();
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`${message}; ${answer}`);
  }
  return exception;
}

export function map(
  error: unknown,
  forward: ToHttpExceptionOptions["forward"],
): HttpException | undefined {
  if (error instanceof HttpResponseError) {
    if (
      forward === true ||
      (Array.isArray(forward) && forward.includes(error.status))
    ) {
      return new HttpException(
        (error.body ?? error.statusText) as string | Record<string, unknown>,
        error.status,
        { cause: error },
      );
    }
    return new BadGatewayException(undefined, { cause: error });
  }
  if (error instanceof HttpTimeoutError || isDeadline(error)) {
    return new GatewayTimeoutException(undefined, { cause: error });
  }
  if (error instanceof HttpClientError) {
    return new BadGatewayException(undefined, { cause: error });
  }
  return undefined;
}

/** A deadline passed as `signal: AbortSignal.timeout(ms)` rejects with this. */
function isDeadline(error: unknown): boolean {
  return error instanceof DOMException && error.name === "TimeoutError";
}
