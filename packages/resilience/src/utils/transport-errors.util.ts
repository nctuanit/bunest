import {
  HttpException,
  HttpStatus,
  type ExecutionContext,
} from "@bunest/core";
import type { HttpAdapterHost } from "@bunest/core";
import { BulkheadFullError } from "../errors/bulkhead-full.error";
import { CircuitOpenError } from "../errors/circuit-open.error";
import { OutboundRateLimitError } from "../errors/outbound-rate-limit.error";
import { RejectionError } from "../errors/rejection.error";
import { ResilienceTimeoutError } from "../errors/resilience-timeout.error";

export interface ResilienceErrorDescription {
  code: string;
  statusCode: HttpStatus.SERVICE_UNAVAILABLE | HttpStatus.GATEWAY_TIMEOUT;
  /** Generic on purpose: breaker and bulkhead names are internals. */
  message: string;
  /** Whole seconds, when the policy knows. */
  retryAfter?: number;
}

const HttpStatusText: Record<number, string> = {
  [HttpStatus.SERVICE_UNAVAILABLE]: "Service Unavailable",
  [HttpStatus.GATEWAY_TIMEOUT]: "Gateway Timeout",
};

/**
 * - `ResilienceTimeoutError` -> 504. The handler ran out of time, usually waiting on a
 *   dependency, which is what 504 says.
 * - `CircuitOpenError`, `BulkheadFullError`, `OutboundRateLimitError` -> 503.
 *   The server (or a dependency) is temporarily unable to serve anyone.
 */
export function describeResilienceError(
  error: ResilienceTimeoutError | RejectionError,
): ResilienceErrorDescription {
  if (error instanceof ResilienceTimeoutError) {
    return {
      code: error.code,
      statusCode: HttpStatus.GATEWAY_TIMEOUT,
      message: "The operation timed out",
    };
  }
  const retryAfter =
    error.retryAfterMs === undefined
      ? undefined
      : Math.max(1, Math.ceil(error.retryAfterMs / 1000));
  const message =
    error instanceof CircuitOpenError
      ? "Service temporarily unavailable"
      : error instanceof BulkheadFullError
        ? "Server is at capacity"
        : error instanceof OutboundRateLimitError
          ? "Rate limit of a dependency exceeded"
          : error.message;
  return {
    code: error.code,
    statusCode: HttpStatus.SERVICE_UNAVAILABLE,
    message,
    retryAfter,
  };
}

/**
 * Converts resilience errors into the error type each transport's exception
 * filters understand. Other errors pass through untouched. Optional transport
 * packages are imported lazily only when a context of that type exists.
 */
export class TransportErrorMapper {
  private readonly adapterHost?: HttpAdapterHost;
  private microservices?: { RpcException?: new (error: unknown) => Error };
  private websockets?: { WsException?: new (error: unknown) => Error };
  private graphql?: {
    GraphQLError?: new (
      message: string,
      options?: Record<string, unknown>,
    ) => Error;
  };

  constructor(adapterHost?: HttpAdapterHost) {
    this.adapterHost = adapterHost;
  }

  async map(error: unknown, context: ExecutionContext): Promise<unknown> {
    if (!(
      error instanceof ResilienceTimeoutError || error instanceof RejectionError
    )) {
      return error;
    }
    const { code, statusCode, message, retryAfter } =
      describeResilienceError(error);
    const extra = retryAfter === undefined ? {} : { retryAfter };

    switch (context.getType<string>()) {
      case "http": {
        const adapter = this.adapterHost?.httpAdapter;
        const response = context.switchToHttp().getResponse<unknown>();
        if (retryAfter !== undefined && !headersSent(response, adapter)) {
          if (adapter && typeof adapter.setHeader === "function") {
            adapter.setHeader(
              response as never,
              "Retry-After",
              String(retryAfter),
            );
          } else if (
            response &&
            typeof (response as { header?: unknown }).header === "function"
          ) {
            (response as { header(n: string, v: string): unknown }).header(
              "Retry-After",
              String(retryAfter),
            );
          } else if (
            response &&
            typeof (response as { setHeader?: unknown }).setHeader ===
              "function"
          ) {
            (
              response as { setHeader(n: string, v: string): unknown }
            ).setHeader("Retry-After", String(retryAfter));
          }
        }
        return new HttpException(
          {
            statusCode,
            error: HttpStatusText[statusCode],
            message,
            code,
          },
          statusCode,
          { cause: error },
        );
      }
      case "rpc": {
        if (!this.microservices) {
          this.microservices = await loadOptionalModule(
            "@bunest/microservices",
          );
        }
        const payload = {
          status: "error",
          code,
          statusCode,
          message,
          ...extra,
        };
        if (this.microservices?.RpcException) {
          return new this.microservices.RpcException(payload);
        }
        return Object.assign(new Error(message, { cause: error }), payload);
      }
      case "ws": {
        if (!this.websockets) {
          this.websockets = await loadOptionalModule("@bunest/core/ws");
        }
        const payload = {
          status: "error",
          code,
          statusCode,
          message,
          ...extra,
        };
        if (this.websockets?.WsException) {
          return new this.websockets.WsException(payload);
        }
        return Object.assign(new Error(message, { cause: error }), payload);
      }
      case "graphql": {
        if (!this.graphql) {
          this.graphql = await loadOptionalModule("graphql");
        }
        if (this.graphql?.GraphQLError) {
          return new this.graphql.GraphQLError(message, {
            originalError: error,
            extensions: { code, httpStatus: statusCode, ...extra },
          });
        }
        return Object.assign(new Error(message, { cause: error }), {
          extensions: { code, httpStatus: statusCode, ...extra },
        });
      }
      default:
        return error;
    }
  }
}

async function loadOptionalModule<T>(
  specifier: string,
): Promise<T | undefined> {
  try {
    return (await import(specifier)) as T;
  } catch {
    return undefined;
  }
}

/**
 * @internal Whether an HTTP response's headers went out.
 */
export function headersSent(
  response: unknown,
  adapter?: { isHeadersSent(response: unknown): boolean },
): boolean {
  if (!response || typeof response !== "object") {
    return false;
  }
  const obj = response as {
    raw?: { headersSent?: boolean };
    headersSent?: boolean;
    isHeadersSent?: () => boolean;
  };
  if (typeof obj.isHeadersSent === "function" && obj.isHeadersSent()) {
    return true;
  }
  const raw = obj.raw ?? obj;
  if (raw?.headersSent === true) {
    return true;
  }
  return !!adapter?.isHeadersSent(response);
}
