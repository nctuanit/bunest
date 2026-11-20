import { createRequire } from "node:module";
import { join } from "node:path";
import { HttpStatus } from "../enums/scope.enum";
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GatewayTimeoutException,
  GoneException,
  InternalServerErrorException,
  MethodNotAllowedException,
  NotFoundException,
  NotImplementedException,
  PayloadTooLargeException,
  ServiceUnavailableException,
  TooManyRequestsException,
  UnauthorizedException,
  UnprocessableEntityException,
  UnsupportedMediaTypeException,
  type HttpExceptionInput,
} from "../exceptions/built-in.exceptions";
import {
  HttpException,
  type HttpExceptionOptions,
  type ValidationErrorDetail,
  type ValidationErrorResponse,
} from "../exceptions/http.exception";
import type {
  TransformerPackage,
  ValidationError,
  ValidatorPackage,
} from "../interfaces/validation.interface";

type BuiltInHttpExceptionCtor = new (
  objectOrError?: HttpExceptionInput,
  descriptionOrOptions?: string | HttpExceptionOptions,
) => HttpException;

export const HTTP_STATUS_REASON_PHRASES: Readonly<Record<number, string>> = {
  [HttpStatus.BAD_REQUEST]: "Bad Request",
  [HttpStatus.UNAUTHORIZED]: "Unauthorized",
  [HttpStatus.PAYMENT_REQUIRED]: "Payment Required",
  [HttpStatus.FORBIDDEN]: "Forbidden",
  [HttpStatus.NOT_FOUND]: "Not Found",
  [HttpStatus.METHOD_NOT_ALLOWED]: "Method Not Allowed",
  [HttpStatus.NOT_ACCEPTABLE]: "Not Acceptable",
  [HttpStatus.REQUEST_TIMEOUT]: "Request Timeout",
  [HttpStatus.CONFLICT]: "Conflict",
  [HttpStatus.GONE]: "Gone",
  [HttpStatus.LENGTH_REQUIRED]: "Length Required",
  [HttpStatus.PRECONDITION_FAILED]: "Precondition Failed",
  [HttpStatus.PAYLOAD_TOO_LARGE]: "Payload Too Large",
  [HttpStatus.URI_TOO_LONG]: "URI Too Long",
  [HttpStatus.UNSUPPORTED_MEDIA_TYPE]: "Unsupported Media Type",
  [HttpStatus.I_AM_A_TEAPOT]: "I'm a Teapot",
  [HttpStatus.UNPROCESSABLE_ENTITY]: "Unprocessable Entity",
  [HttpStatus.FAILED_DEPENDENCY]: "Failed Dependency",
  [HttpStatus.PRECONDITION_REQUIRED]: "Precondition Required",
  [HttpStatus.TOO_MANY_REQUESTS]: "Too Many Requests",
  [HttpStatus.INTERNAL_SERVER_ERROR]: "Internal Server Error",
  [HttpStatus.NOT_IMPLEMENTED]: "Not Implemented",
  [HttpStatus.BAD_GATEWAY]: "Bad Gateway",
  [HttpStatus.SERVICE_UNAVAILABLE]: "Service Unavailable",
  [HttpStatus.GATEWAY_TIMEOUT]: "Gateway Timeout",
};

const HTTP_EXCEPTION_BY_STATUS: Readonly<
  Record<number, BuiltInHttpExceptionCtor>
> = {
  [HttpStatus.BAD_REQUEST]: BadRequestException,
  [HttpStatus.UNAUTHORIZED]: UnauthorizedException,
  [HttpStatus.FORBIDDEN]: ForbiddenException,
  [HttpStatus.NOT_FOUND]: NotFoundException,
  [HttpStatus.METHOD_NOT_ALLOWED]: MethodNotAllowedException,
  [HttpStatus.CONFLICT]: ConflictException,
  [HttpStatus.GONE]: GoneException,
  [HttpStatus.PAYLOAD_TOO_LARGE]: PayloadTooLargeException,
  [HttpStatus.UNSUPPORTED_MEDIA_TYPE]: UnsupportedMediaTypeException,
  [HttpStatus.UNPROCESSABLE_ENTITY]: UnprocessableEntityException,
  [HttpStatus.TOO_MANY_REQUESTS]: TooManyRequestsException,
  [HttpStatus.INTERNAL_SERVER_ERROR]: InternalServerErrorException,
  [HttpStatus.NOT_IMPLEMENTED]: NotImplementedException,
  [HttpStatus.BAD_GATEWAY]: BadGatewayException,
  [HttpStatus.SERVICE_UNAVAILABLE]: ServiceUnavailableException,
  [HttpStatus.GATEWAY_TIMEOUT]: GatewayTimeoutException,
};

export function getHttpReasonPhrase(statusCode: number): string {
  return HTTP_STATUS_REASON_PHRASES[statusCode] ?? "Http Exception";
}

export function createValidationHttpException(
  details: ValidationErrorDetail[],
  statusCode: number = HttpStatus.BAD_REQUEST,
  disableErrorMessages = false,
): HttpException {
  const error = getHttpReasonPhrase(statusCode);
  const ExceptionCtor = HTTP_EXCEPTION_BY_STATUS[statusCode];

  if (disableErrorMessages) {
    const body = {
      statusCode,
      error,
      message: error,
    };
    if (ExceptionCtor) {
      return new ExceptionCtor(body, error);
    }
    return new HttpException(body, statusCode, { description: error });
  }

  const body: ValidationErrorResponse = {
    statusCode,
    error,
    message: "Validation failed",
    details,
  };

  if (ExceptionCtor) {
    return new ExceptionCtor(
      body as unknown as Record<string, unknown>,
      error,
    );
  }

  return new HttpException(
    body as unknown as Record<string, unknown>,
    statusCode,
    { description: error },
  );
}

export function createStatusHttpException(
  body: Record<string, unknown>,
  statusCode: number = HttpStatus.BAD_REQUEST,
): HttpException {
  const error = getHttpReasonPhrase(statusCode);
  const ExceptionCtor = HTTP_EXCEPTION_BY_STATUS[statusCode];
  if (ExceptionCtor) {
    return new ExceptionCtor(body, error);
  }
  return new HttpException(body, statusCode, { description: error });
}

const ARRAY_INDEX_REGEX = /^\d+$/;

function buildFieldPath(
  parentPath: string,
  property: string | undefined,
  parentIsDefinitelyNonArray: boolean,
): string {
  const prop = typeof property === "string" ? property : "";
  if (prop.length === 0) {
    return parentPath;
  }
  if (parentPath.length === 0) {
    return prop;
  }
  if (!parentIsDefinitelyNonArray && ARRAY_INDEX_REGEX.test(prop)) {
    return `${parentPath}[${prop}]`;
  }
  return `${parentPath}.${prop}`;
}

export function flattenValidationErrorDetails(
  errors: readonly ValidationError[],
  parentPath = "",
  parentIsDefinitelyNonArray = false,
): ValidationErrorDetail[] {
  const details: ValidationErrorDetail[] = [];

  for (const error of errors) {
    const fieldPath = buildFieldPath(
      parentPath,
      error.property,
      parentIsDefinitelyNonArray,
    );

    if (error.constraints && Object.keys(error.constraints).length > 0) {
      const normalizedConstraints: Record<string, string> = {};
      for (const [constraintKey, message] of Object.entries(error.constraints)) {
        normalizedConstraints[constraintKey] =
          typeof message === "string" ? message : String(message ?? "");
      }
      details.push({
        field: fieldPath,
        constraints: normalizedConstraints,
        messages: Object.values(normalizedConstraints),
      });
    }

    if (error.children && error.children.length > 0) {
      const childParentNonArray =
        error.value !== undefined && !Array.isArray(error.value);
      details.push(
        ...flattenValidationErrorDetails(
          error.children,
          fieldPath,
          childParentNonArray,
        ),
      );
    }
  }

  return details;
}

export const DANGEROUS_PROTOTYPE_KEYS = Object.freeze([
  "__proto__",
  "constructor",
  "prototype",
] as const);

export type DangerousPrototypeKey = (typeof DANGEROUS_PROTOTYPE_KEYS)[number];

export interface DangerousKeyViolation {
  readonly path: string;
  readonly key: DangerousPrototypeKey;
  readonly segments: readonly (string | number)[];
}

function isNonTraversableObject(value: object): boolean {
  if (
    value instanceof Date ||
    value instanceof RegExp ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value) ||
    value instanceof Map ||
    value instanceof Set ||
    value instanceof WeakMap ||
    value instanceof WeakSet
  ) {
    return true;
  }

  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return true;
  }
  if (typeof URL !== "undefined" && value instanceof URL) {
    return true;
  }
  if (typeof ReadableStream !== "undefined" && value instanceof ReadableStream) {
    return true;
  }
  if (typeof Response !== "undefined" && value instanceof Response) {
    return true;
  }
  if (typeof Request !== "undefined" && value instanceof Request) {
    return true;
  }

  return false;
}

function appendSegment(parentPath: string, segment: string | number): string {
  if (typeof segment === "number") {
    return `${parentPath}[${segment}]`;
  }
  return parentPath.length > 0 ? `${parentPath}.${segment}` : segment;
}

export function findDangerousKeys(value: unknown): DangerousKeyViolation[] {
  const violations: DangerousKeyViolation[] = [];
  const activeAncestors = new Set<object>();

  const walk = (
    current: unknown,
    currentPath: string,
    segments: readonly (string | number)[],
  ): void => {
    if (typeof current !== "object" || current === null) {
      return;
    }

    if (activeAncestors.has(current)) {
      return;
    }

    activeAncestors.add(current);
    try {
      for (const dangerousKey of DANGEROUS_PROTOTYPE_KEYS) {
        if (Object.hasOwn(current, dangerousKey)) {
          violations.push({
            path: appendSegment(currentPath, dangerousKey),
            key: dangerousKey,
            segments: [...segments, dangerousKey],
          });
        }
      }

      if (isNonTraversableObject(current)) {
        return;
      }

      if (Array.isArray(current)) {
        for (let i = 0; i < current.length; i += 1) {
          walk(current[i], appendSegment(currentPath, i), [...segments, i]);
        }
        return;
      }

      const record = current as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        if (
          key === "__proto__" ||
          key === "constructor" ||
          key === "prototype"
        ) {
          continue;
        }
        walk(record[key], appendSegment(currentPath, key), [...segments, key]);
      }
    } finally {
      activeAncestors.delete(current);
    }
  };

  walk(value, "", []);
  return violations;
}

export function buildDangerousKeyValidationErrors(
  violations: readonly DangerousKeyViolation[],
): ValidationError[] {
  return violations.map((violation) => {
    const leaf: ValidationError = {
      property: violation.key,
      children: [],
      constraints: {
        forbiddenKey: `property ${violation.key} is not allowed`,
      },
    };

    let current: ValidationError = leaf;
    for (let i = violation.segments.length - 2; i >= 0; i -= 1) {
      current = {
        property: String(violation.segments[i]),
        children: [current],
      };
    }

    return current;
  });
}

let cachedValidatorPkg: ValidatorPackage | undefined;
let cachedTransformerPkg: TransformerPackage | undefined;

function tryLoadOptionalPackage<T>(segments: readonly string[]): T | undefined {
  const pkgName = segments.join("-");
  try {
    const req = createRequire(import.meta.url);
    return req(pkgName) as T;
  } catch {
    try {
      const cwdReq = createRequire(join(process.cwd(), "package.json"));
      return cwdReq(pkgName) as T;
    } catch {
      return undefined;
    }
  }
}

export function loadDefaultValidatorPackage(): ValidatorPackage {
  if (cachedValidatorPkg) {
    return cachedValidatorPkg;
  }
  const mod = tryLoadOptionalPackage<ValidatorPackage>(["class", "validator"]);
  if (!mod || typeof mod.validate !== "function") {
    throw new Error(
      'Missing required package "class-validator" for ValidationPipe. Install "class-validator" or pass a custom "validatorPackage".',
    );
  }
  cachedValidatorPkg = mod;
  return mod;
}

export function loadDefaultTransformerPackage(): TransformerPackage {
  if (cachedTransformerPkg) {
    return cachedTransformerPkg;
  }
  const mod = tryLoadOptionalPackage<TransformerPackage>([
    "class",
    "transformer",
  ]);
  if (!mod) {
    throw new Error(
      'Missing required package "class-transformer" for ValidationPipe / ClassSerializerInterceptor. Install "class-transformer" or pass a custom "transformerPackage".',
    );
  }
  cachedTransformerPkg = mod;
  return mod;
}
