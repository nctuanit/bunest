import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GatewayTimeoutException,
  GoneException,
  HttpException,
  HttpStatus,
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
  type HttpExceptionOptions,
  type ValidationErrorDetail,
  type ValidationErrorResponse,
} from "@bunest/common";

type BuiltInHttpExceptionCtor = new (
  objectOrError?: HttpExceptionInput,
  descriptionOrOptions?: string | HttpExceptionOptions,
) => HttpException;

const HTTP_STATUS_REASON_PHRASES: Readonly<Record<number, string>> = {
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

/**
 * Returns the standard HTTP reason phrase for a status code.
 */
export function getHttpReasonPhrase(statusCode: number): string {
  return HTTP_STATUS_REASON_PHRASES[statusCode] ?? "Http Exception";
}

/**
 * Creates a normalized `HttpException` (using the specific subclass like
 * `BadRequestException` or `UnprocessableEntityException` when available)
 * conforming to ADR-009's `ValidationErrorResponse` envelope.
 */
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
