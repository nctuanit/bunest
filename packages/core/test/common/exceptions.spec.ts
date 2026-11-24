import { describe, expect, it } from "bun:test";
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
} from "../../src/common";

describe("HTTP Exception Hierarchy", () => {
  it("formats base HttpException with string, object, cause, and toJSON()", () => {
    const rootCause = new Error("db timeout");
    const strErr = new HttpException("Custom failure", 418, {
      cause: rootCause,
      description: "Teapot",
    });

    expect(strErr).toBeInstanceOf(Error);
    expect(strErr).toBeInstanceOf(HttpException);
    expect(strErr.getStatus()).toBe(418);
    expect(strErr.getResponse()).toBe("Custom failure");
    expect(strErr.message).toBe("Custom failure");
    expect(strErr.cause).toBe(rootCause);
    expect(strErr.toJSON()).toEqual({
      statusCode: 418,
      message: "Custom failure",
      error: "Teapot",
    });

    const objErr = new HttpException(
      { message: ["a", "b"], code: "VALIDATION_ERR" },
      400,
    );
    expect(objErr.toJSON()).toEqual({
      statusCode: 400,
      message: ["a", "b"],
      error: "HttpException",
      code: "VALIDATION_ERR",
    });
  });

  it("provides all 16 built-in HTTP exceptions with exact status codes and consistent error shapes", () => {
    const cases = [
      [BadRequestException, HttpStatus.BAD_REQUEST, "Bad Request"],
      [UnauthorizedException, HttpStatus.UNAUTHORIZED, "Unauthorized"],
      [ForbiddenException, HttpStatus.FORBIDDEN, "Forbidden"],
      [NotFoundException, HttpStatus.NOT_FOUND, "Not Found"],
      [
        MethodNotAllowedException,
        HttpStatus.METHOD_NOT_ALLOWED,
        "Method Not Allowed",
      ],
      [ConflictException, HttpStatus.CONFLICT, "Conflict"],
      [GoneException, HttpStatus.GONE, "Gone"],
      [
        PayloadTooLargeException,
        HttpStatus.PAYLOAD_TOO_LARGE,
        "Payload Too Large",
      ],
      [
        UnsupportedMediaTypeException,
        HttpStatus.UNSUPPORTED_MEDIA_TYPE,
        "Unsupported Media Type",
      ],
      [
        UnprocessableEntityException,
        HttpStatus.UNPROCESSABLE_ENTITY,
        "Unprocessable Entity",
      ],
      [
        TooManyRequestsException,
        HttpStatus.TOO_MANY_REQUESTS,
        "Too Many Requests",
      ],
      [
        InternalServerErrorException,
        HttpStatus.INTERNAL_SERVER_ERROR,
        "Internal Server Error",
      ],
      [NotImplementedException, HttpStatus.NOT_IMPLEMENTED, "Not Implemented"],
      [BadGatewayException, HttpStatus.BAD_GATEWAY, "Bad Gateway"],
      [
        ServiceUnavailableException,
        HttpStatus.SERVICE_UNAVAILABLE,
        "Service Unavailable",
      ],
      [GatewayTimeoutException, HttpStatus.GATEWAY_TIMEOUT, "Gateway Timeout"],
    ] as const;

    for (const [ExceptionClass, expectedStatus, expectedError] of cases) {
      // Default constructor
      const def = new ExceptionClass();
      expect(def).toBeInstanceOf(Error);
      expect(def).toBeInstanceOf(HttpException);
      expect(def).toBeInstanceOf(ExceptionClass);
      expect(def.getStatus()).toBe(expectedStatus);
      expect(def.toJSON()).toEqual({
        statusCode: expectedStatus,
        message: expectedError,
        error: expectedError,
      });

      // Custom message string
      const withMsg = new ExceptionClass("Something went wrong");
      expect(withMsg.toJSON()).toEqual({
        statusCode: expectedStatus,
        message: "Something went wrong",
        error: expectedError,
      });

      // Custom array message + cause option
      const cause = new Error("inner");
      const withArr = new ExceptionClass(["err1", "err2"], {
        cause,
        description: "Custom Label",
      });
      expect(withArr.cause).toBe(cause);
      expect(withArr.toJSON()).toEqual({
        statusCode: expectedStatus,
        message: ["err1", "err2"],
        error: "Custom Label",
      });

      // Custom object payload preserving extra details
      const withObj = new ExceptionClass({
        message: "Structured error",
        details: [{ field: "email" }],
      });
      expect(withObj.toJSON()).toEqual({
        statusCode: expectedStatus,
        message: "Structured error",
        error: expectedError,
        details: [{ field: "email" }],
      });
    }
  });

  it("propagates optional response headers on HttpException via getHeaders() (e.g., 405 Allow)", () => {
    const err = new MethodNotAllowedException("Method DELETE not allowed", {
      headers: { Allow: "GET, POST" },
    });

    expect(err.getStatus()).toBe(405);
    const headers = err.getHeaders();
    expect(headers).toEqual({ Allow: "GET, POST" });

    // Mutating returned headers object MUST NOT mutate internal exception headers
    headers!.Allow = "MUTATED";
    expect(err.getHeaders()).toEqual({ Allow: "GET, POST" });

    // Default without headers returns undefined
    expect(new BadRequestException("oops").getHeaders()).toBeUndefined();
  });
});
