import {
  Catch,
  HttpException,
  Optional,
  type ArgumentsHost,
  type HttpServer,
} from "@bunest/common";
import { BaseExceptionFilter } from "@bunest/core";
import { mapPrismaErrorToHttp } from "@bunest/sql";

/**
 * Structural shape compatible with Prisma's `PrismaClientKnownRequestError`
 * without requiring `@prisma/client` as a runtime dependency.
 */
export interface PrismaKnownRequestErrorLike extends Error {
  readonly code: string;
  readonly clientVersion?: string;
  readonly meta?: Record<string, unknown>;
}

/**
 * Optional override map converting Prisma error codes (e.g. `"P2002"`, `"P2025"`)
 * into HTTP status codes or `{ statusCode, errorMessage }` descriptors.
 */
export type PrismaErrorCodeStatusMap = Record<
  string,
  number | { readonly statusCode: number; readonly errorMessage?: string }
>;

const PRISMA_ERROR_CODE_PATTERN = /^P\d{4}$/;

/**
 * Runtime type guard identifying Prisma Client known request errors (`P1xxx`–`P6xxx`).
 */
export function isPrismaClientKnownRequestError(
  error: unknown,
): error is PrismaKnownRequestErrorLike {
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as { code?: unknown; message?: unknown };
  return (
    typeof candidate.code === "string" &&
    PRISMA_ERROR_CODE_PATTERN.test(candidate.code) &&
    typeof candidate.message === "string"
  );
}

function isHttpServerLike(value: unknown): value is HttpServer {
  return (
    typeof value === "object" &&
    value !== null &&
    (typeof (value as { reply?: unknown }).reply === "function" ||
      typeof (value as { getType?: unknown }).getType === "function")
  );
}

/**
 * Exception filter translating Prisma Client error codes (`P2002` -> 409,
 * `P2025`/`P2015` -> 404, `P2000`/`P2003` -> 400, `P2024`/`P1001` -> 503, etc.)
 * into clean Bunest `HttpException` responses via `BaseExceptionFilter`.
 */
@Catch()
export class PrismaClientExceptionFilter extends BaseExceptionFilter {
  private readonly errorCodesStatusMapping?: PrismaErrorCodeStatusMap;

  constructor(
    applicationRef?: HttpServer,
    errorCodesStatusMapping?: PrismaErrorCodeStatusMap,
  );
  constructor(errorCodesStatusMapping?: PrismaErrorCodeStatusMap);
  constructor(
    @Optional()
    applicationRefOrMapping?: HttpServer | PrismaErrorCodeStatusMap,
    @Optional()
    errorCodesStatusMapping?: PrismaErrorCodeStatusMap,
  ) {
    if (isHttpServerLike(applicationRefOrMapping)) {
      super(applicationRefOrMapping);
      this.errorCodesStatusMapping = errorCodesStatusMapping;
    } else {
      super(undefined);
      this.errorCodesStatusMapping =
        errorCodesStatusMapping ?? applicationRefOrMapping;
    }
  }

  override catch(exception: unknown, host: ArgumentsHost): Response | void {
    const code =
      exception &&
      typeof exception === "object" &&
      "code" in exception &&
      typeof (exception as { code?: unknown }).code === "string"
        ? (exception as { code: string }).code
        : undefined;

    if (code && this.errorCodesStatusMapping) {
      const customMapping = this.errorCodesStatusMapping[code];
      if (customMapping !== undefined) {
        const statusCode =
          typeof customMapping === "number"
            ? customMapping
            : customMapping.statusCode;
        const rawMessage =
          typeof customMapping === "object" && customMapping.errorMessage
            ? customMapping.errorMessage
            : exception instanceof Error
              ? exception.message.replace(/\s*\n\s*/g, " ").trim()
              : `Database error (${code})`;
        return super.catch(new HttpException(rawMessage, statusCode), host);
      }
    }

    const mapped = mapPrismaErrorToHttp(exception);
    if (mapped) {
      return super.catch(mapped, host);
    }

    return super.catch(exception, host);
  }
}
