import {
  TooManyRequestsException,
  type HttpExceptionOptions,
} from "@bunest/core";

export const throttlerMessage = "ThrottlerException: Too Many Requests";

export class ThrottlerException extends TooManyRequestsException {
  constructor(message?: string, options?: string | HttpExceptionOptions) {
    super(message ?? throttlerMessage, options);
  }
}
