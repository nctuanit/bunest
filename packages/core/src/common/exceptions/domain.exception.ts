import { METADATA_KEYS } from "../constants/metadata-keys";
import { HttpStatus } from "../enums/scope.enum";
import { HttpException } from "./http.exception";
import type { ArgumentsHost, ExceptionFilter } from "../interfaces/pipeline.interface";
import type { Abstract, Type } from "../interfaces/type.interface";
import { MetadataRegistry } from "../metadata/metadata-registry";

const DOMAIN_HTTP_REASON: Readonly<Record<number, string>> = Object.freeze({
  [HttpStatus.BAD_REQUEST]: "Bad Request",
  [HttpStatus.UNAUTHORIZED]: "Unauthorized",
  [HttpStatus.FORBIDDEN]: "Forbidden",
  [HttpStatus.NOT_FOUND]: "Not Found",
  [HttpStatus.CONFLICT]: "Conflict",
  [HttpStatus.UNPROCESSABLE_ENTITY]: "Unprocessable Entity",
  [HttpStatus.TOO_MANY_REQUESTS]: "Too Many Requests",
  [HttpStatus.INTERNAL_SERVER_ERROR]: "Internal Server Error",
  [HttpStatus.SERVICE_UNAVAILABLE]: "Service Unavailable",
});

function getDomainHttpReason(status: number): string {
  return DOMAIN_HTTP_REASON[status] ?? "Error";
}

/**
 * Canonical transport-agnostic domain error categories that automatically map
 * to HTTP status codes in `DefaultExceptionFilter` without coupling domain services
 * to `@bunest/core/http` or `HttpException`.
 */
export type DomainErrorKind =
  | "validation"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "unprocessable"
  | "rate_limited"
  | "unavailable"
  | "internal";

export const DOMAIN_ERROR_HTTP_STATUS: Readonly<Record<DomainErrorKind, number>> =
  Object.freeze({
    validation: HttpStatus.BAD_REQUEST,
    unauthorized: HttpStatus.UNAUTHORIZED,
    forbidden: HttpStatus.FORBIDDEN,
    not_found: HttpStatus.NOT_FOUND,
    conflict: HttpStatus.CONFLICT,
    unprocessable: HttpStatus.UNPROCESSABLE_ENTITY,
    rate_limited: HttpStatus.TOO_MANY_REQUESTS,
    unavailable: HttpStatus.SERVICE_UNAVAILABLE,
    internal: HttpStatus.INTERNAL_SERVER_ERROR,
  });

export interface DomainExceptionOptions {
  /** Machine-readable application error code (e.g. `"INSUFFICIENT_BALANCE"`). */
  readonly code: string;
  /** Semantic error category mapped automatically to transport status codes. */
  readonly kind?: DomainErrorKind;
  /** Human-readable error message. */
  readonly message: string;
  /** Optional structured details exposed in the error payload (redacted for `"internal"` in prod). */
  readonly details?: unknown;
  /** Optional underlying cause. */
  readonly cause?: unknown;
}

/**
 * Transport-agnostic business/domain exception.
 *
 * Throw `DomainException` (or subclasses) from pure domain services without
 * importing HTTP exceptions — `DefaultExceptionFilter` maps `kind` automatically
 * to the canonical HTTP status and ADR-009 JSON envelope.
 */
export class DomainException extends Error {
  readonly code: string;
  readonly kind: DomainErrorKind;
  readonly details?: unknown;

  constructor(options: DomainExceptionOptions) {
    super(
      options.message,
      options.cause !== undefined ? { cause: options.cause } : undefined,
    );
    this.name = new.target.name;
    this.code = options.code;
    this.kind = options.kind ?? "unprocessable";
    this.details = options.details;
  }

  get httpStatus(): number {
    return DOMAIN_ERROR_HTTP_STATUS[this.kind] ?? HttpStatus.INTERNAL_SERVER_ERROR;
  }

  toJSON(): Record<string, unknown> {
    const status = this.httpStatus;
    const out: Record<string, unknown> = {
      statusCode: status,
      error: getDomainHttpReason(status),
      code: this.code,
      message: this.message,
    };
    if (this.details !== undefined) {
      out.details = this.details;
    }
    return out;
  }
}

export type DomainErrorMappingResult =
  | number
  | {
      readonly status: number;
      readonly code?: string;
      readonly message?: string;
      readonly details?: unknown;
    };

export type DomainErrorMapper<T extends Error = Error> =
  | DomainErrorMappingResult
  | ((error: T) => DomainErrorMappingResult);

export type DomainErrorMappingEntry<T extends Error = any> = readonly [
  Type<T> | Abstract<T>,
  DomainErrorMapper<T>,
];

/**
 * Creates a reusable `ExceptionFilter` that maps plain `Error` subclasses from a
 * pure domain layer into normalized `HttpException` responses without writing
 * repetitive `@Catch()` boilerplate.
 *
 * Unmatched errors are rethrown so subsequent filters / `DefaultExceptionFilter` handle them.
 */
class NeverMatchedDomainError extends Error {}

export function createDomainErrorFilter(
  mappings: readonly DomainErrorMappingEntry[],
): ExceptionFilter {
  const entries = [...mappings];
  const catchCtors = entries.map(([ErrorCtor]) => ErrorCtor);

  class DomainErrorFilter implements ExceptionFilter {
    catch(exception: unknown, _host: ArgumentsHost): never {
      for (let i = 0; i < entries.length; i++) {
        const [ErrorCtor, mapper] = entries[i]!;
        if (exception instanceof (ErrorCtor as Function)) {
          const resolved =
            typeof mapper === "function"
              ? mapper(exception as Error)
              : mapper;
          const status =
            typeof resolved === "number" ? resolved : resolved.status;
          const message =
            typeof resolved === "number"
              ? (exception as Error).message
              : (resolved.message ?? (exception as Error).message);
          const body: Record<string, unknown> = {
            statusCode: status,
            error: getDomainHttpReason(status),
            message,
          };
          if (typeof resolved !== "number") {
            if (resolved.code !== undefined) body.code = resolved.code;
            if (resolved.details !== undefined) body.details = resolved.details;
          }
          throw new HttpException(body, status, { cause: exception });
        }
      }
      throw exception;
    }
  }

  MetadataRegistry.define(
    METADATA_KEYS.CATCH_EXCEPTIONS,
    catchCtors.length > 0 ? catchCtors : [NeverMatchedDomainError],
    DomainErrorFilter,
  );

  return new DomainErrorFilter();
}
