import { HttpStatus } from "../enums/scope.enum";
import { HttpException, type HttpExceptionOptions } from "./http.exception";

export type HttpExceptionInput = string | string[] | Record<string, unknown>;

function buildExceptionArgs(
  objectOrError: HttpExceptionInput | undefined,
  descriptionOrOptions: string | HttpExceptionOptions | undefined,
  defaultDescription: string,
  statusCode: number,
) {
  const { description, options } = HttpException.extractDescriptionAndOptions(
    descriptionOrOptions,
    defaultDescription,
  );
  const body = HttpException.createBody(
    objectOrError,
    description,
    statusCode,
    options?.errorCode,
  );
  return { body, options };
}

export class BadRequestException extends HttpException {
  constructor(
    objectOrError?: HttpExceptionInput,
    descriptionOrOptions?: string | HttpExceptionOptions,
  ) {
    const { body, options } = buildExceptionArgs(
      objectOrError,
      descriptionOrOptions,
      "Bad Request",
      HttpStatus.BAD_REQUEST,
    );
    super(body, HttpStatus.BAD_REQUEST, options);
  }
}

export class UnauthorizedException extends HttpException {
  constructor(
    objectOrError?: HttpExceptionInput,
    descriptionOrOptions?: string | HttpExceptionOptions,
  ) {
    const { body, options } = buildExceptionArgs(
      objectOrError,
      descriptionOrOptions,
      "Unauthorized",
      HttpStatus.UNAUTHORIZED,
    );
    super(body, HttpStatus.UNAUTHORIZED, options);
  }
}

export class ForbiddenException extends HttpException {
  constructor(
    objectOrError?: HttpExceptionInput,
    descriptionOrOptions?: string | HttpExceptionOptions,
  ) {
    const { body, options } = buildExceptionArgs(
      objectOrError,
      descriptionOrOptions,
      "Forbidden",
      HttpStatus.FORBIDDEN,
    );
    super(body, HttpStatus.FORBIDDEN, options);
  }
}

export class NotFoundException extends HttpException {
  constructor(
    objectOrError?: HttpExceptionInput,
    descriptionOrOptions?: string | HttpExceptionOptions,
  ) {
    const { body, options } = buildExceptionArgs(
      objectOrError,
      descriptionOrOptions,
      "Not Found",
      HttpStatus.NOT_FOUND,
    );
    super(body, HttpStatus.NOT_FOUND, options);
  }
}

export class MethodNotAllowedException extends HttpException {
  constructor(
    objectOrError?: HttpExceptionInput,
    descriptionOrOptions?: string | HttpExceptionOptions,
  ) {
    const { body, options } = buildExceptionArgs(
      objectOrError,
      descriptionOrOptions,
      "Method Not Allowed",
      HttpStatus.METHOD_NOT_ALLOWED,
    );
    super(body, HttpStatus.METHOD_NOT_ALLOWED, options);
  }
}

export class ConflictException extends HttpException {
  constructor(
    objectOrError?: HttpExceptionInput,
    descriptionOrOptions?: string | HttpExceptionOptions,
  ) {
    const { body, options } = buildExceptionArgs(
      objectOrError,
      descriptionOrOptions,
      "Conflict",
      HttpStatus.CONFLICT,
    );
    super(body, HttpStatus.CONFLICT, options);
  }
}

export class GoneException extends HttpException {
  constructor(
    objectOrError?: HttpExceptionInput,
    descriptionOrOptions?: string | HttpExceptionOptions,
  ) {
    const { body, options } = buildExceptionArgs(
      objectOrError,
      descriptionOrOptions,
      "Gone",
      HttpStatus.GONE,
    );
    super(body, HttpStatus.GONE, options);
  }
}

export class PayloadTooLargeException extends HttpException {
  constructor(
    objectOrError?: HttpExceptionInput,
    descriptionOrOptions?: string | HttpExceptionOptions,
  ) {
    const { body, options } = buildExceptionArgs(
      objectOrError,
      descriptionOrOptions,
      "Payload Too Large",
      HttpStatus.PAYLOAD_TOO_LARGE,
    );
    super(body, HttpStatus.PAYLOAD_TOO_LARGE, options);
  }
}

export class UnsupportedMediaTypeException extends HttpException {
  constructor(
    objectOrError?: HttpExceptionInput,
    descriptionOrOptions?: string | HttpExceptionOptions,
  ) {
    const { body, options } = buildExceptionArgs(
      objectOrError,
      descriptionOrOptions,
      "Unsupported Media Type",
      HttpStatus.UNSUPPORTED_MEDIA_TYPE,
    );
    super(body, HttpStatus.UNSUPPORTED_MEDIA_TYPE, options);
  }
}

export class UnprocessableEntityException extends HttpException {
  constructor(
    objectOrError?: HttpExceptionInput,
    descriptionOrOptions?: string | HttpExceptionOptions,
  ) {
    const { body, options } = buildExceptionArgs(
      objectOrError,
      descriptionOrOptions,
      "Unprocessable Entity",
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
    super(body, HttpStatus.UNPROCESSABLE_ENTITY, options);
  }
}

export class TooManyRequestsException extends HttpException {
  constructor(
    objectOrError?: HttpExceptionInput,
    descriptionOrOptions?: string | HttpExceptionOptions,
  ) {
    const { body, options } = buildExceptionArgs(
      objectOrError,
      descriptionOrOptions,
      "Too Many Requests",
      HttpStatus.TOO_MANY_REQUESTS,
    );
    super(body, HttpStatus.TOO_MANY_REQUESTS, options);
  }
}

export class InternalServerErrorException extends HttpException {
  constructor(
    objectOrError?: HttpExceptionInput,
    descriptionOrOptions?: string | HttpExceptionOptions,
  ) {
    const { body, options } = buildExceptionArgs(
      objectOrError,
      descriptionOrOptions,
      "Internal Server Error",
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
    super(body, HttpStatus.INTERNAL_SERVER_ERROR, options);
  }
}

export class NotImplementedException extends HttpException {
  constructor(
    objectOrError?: HttpExceptionInput,
    descriptionOrOptions?: string | HttpExceptionOptions,
  ) {
    const { body, options } = buildExceptionArgs(
      objectOrError,
      descriptionOrOptions,
      "Not Implemented",
      HttpStatus.NOT_IMPLEMENTED,
    );
    super(body, HttpStatus.NOT_IMPLEMENTED, options);
  }
}

export class BadGatewayException extends HttpException {
  constructor(
    objectOrError?: HttpExceptionInput,
    descriptionOrOptions?: string | HttpExceptionOptions,
  ) {
    const { body, options } = buildExceptionArgs(
      objectOrError,
      descriptionOrOptions,
      "Bad Gateway",
      HttpStatus.BAD_GATEWAY,
    );
    super(body, HttpStatus.BAD_GATEWAY, options);
  }
}

export class ServiceUnavailableException extends HttpException {
  constructor(
    objectOrError?: HttpExceptionInput,
    descriptionOrOptions?: string | HttpExceptionOptions,
  ) {
    const { body, options } = buildExceptionArgs(
      objectOrError,
      descriptionOrOptions,
      "Service Unavailable",
      HttpStatus.SERVICE_UNAVAILABLE,
    );
    super(body, HttpStatus.SERVICE_UNAVAILABLE, options);
  }
}

export class GatewayTimeoutException extends HttpException {
  constructor(
    objectOrError?: HttpExceptionInput,
    descriptionOrOptions?: string | HttpExceptionOptions,
  ) {
    const { body, options } = buildExceptionArgs(
      objectOrError,
      descriptionOrOptions,
      "Gateway Timeout",
      HttpStatus.GATEWAY_TIMEOUT,
    );
    super(body, HttpStatus.GATEWAY_TIMEOUT, options);
  }
}

export class NotAcceptableException extends HttpException {
  constructor(
    objectOrError?: HttpExceptionInput,
    descriptionOrOptions?: string | HttpExceptionOptions,
  ) {
    const { body, options } = buildExceptionArgs(
      objectOrError,
      descriptionOrOptions,
      "Not Acceptable",
      HttpStatus.NOT_ACCEPTABLE,
    );
    super(body, HttpStatus.NOT_ACCEPTABLE, options);
  }
}

export class RequestTimeoutException extends HttpException {
  constructor(
    objectOrError?: HttpExceptionInput,
    descriptionOrOptions?: string | HttpExceptionOptions,
  ) {
    const { body, options } = buildExceptionArgs(
      objectOrError,
      descriptionOrOptions,
      "Request Timeout",
      HttpStatus.REQUEST_TIMEOUT,
    );
    super(body, HttpStatus.REQUEST_TIMEOUT, options);
  }
}

export class PreconditionFailedException extends HttpException {
  constructor(
    objectOrError?: HttpExceptionInput,
    descriptionOrOptions?: string | HttpExceptionOptions,
  ) {
    const { body, options } = buildExceptionArgs(
      objectOrError,
      descriptionOrOptions,
      "Precondition Failed",
      HttpStatus.PRECONDITION_FAILED,
    );
    super(body, HttpStatus.PRECONDITION_FAILED, options);
  }
}

export class ImATeapotException extends HttpException {
  constructor(
    objectOrError?: HttpExceptionInput,
    descriptionOrOptions?: string | HttpExceptionOptions,
  ) {
    const { body, options } = buildExceptionArgs(
      objectOrError,
      descriptionOrOptions,
      "I'm a teapot",
      HttpStatus.I_AM_A_TEAPOT,
    );
    super(body, HttpStatus.I_AM_A_TEAPOT, options);
  }
}

export class MisdirectedException extends HttpException {
  constructor(
    objectOrError?: HttpExceptionInput,
    descriptionOrOptions?: string | HttpExceptionOptions,
  ) {
    const { body, options } = buildExceptionArgs(
      objectOrError,
      descriptionOrOptions,
      "Misdirected",
      HttpStatus.MISDIRECTED,
    );
    super(body, HttpStatus.MISDIRECTED, options);
  }
}

export class HttpVersionNotSupportedException extends HttpException {
  constructor(
    objectOrError?: HttpExceptionInput,
    descriptionOrOptions?: string | HttpExceptionOptions,
  ) {
    const { body, options } = buildExceptionArgs(
      objectOrError,
      descriptionOrOptions,
      "HTTP Version Not Supported",
      HttpStatus.HTTP_VERSION_NOT_SUPPORTED,
    );
    super(body, HttpStatus.HTTP_VERSION_NOT_SUPPORTED, options);
  }
}
