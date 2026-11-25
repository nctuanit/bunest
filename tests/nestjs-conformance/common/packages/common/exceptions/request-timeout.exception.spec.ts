import { expect, it } from "bun:test";
import {
  HttpException,
  RequestTimeoutException,
} from "../../../../../../packages/core/src/common";
import { describeConformance } from "../../../../_helpers";

describeConformance(
  "RequestTimeoutException",
  {
    upstreamPath:
      "packages/common/test/exceptions/request-timeout.exception.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    it("should return 408 as status code", () => {
      const exc = new RequestTimeoutException();
      expect(exc.getStatus()).toBe(408);
    });

    it('should return "Request Timeout" as default message', () => {
      const exc = new RequestTimeoutException();
      expect(exc.getResponse()).toEqual({
        message: "Request Timeout",
        statusCode: 408,
      });
    });

    it("should accept a custom message", () => {
      const exc = new RequestTimeoutException("Custom error");
      expect(exc.getResponse()).toEqual({
        message: "Custom error",
        error: "Request Timeout",
        statusCode: 408,
      });
    });

    it("should accept a custom object", () => {
      const exc = new RequestTimeoutException({ foo: "bar" });
      expect(exc.getResponse()).toEqual({ foo: "bar" });
    });

    it("should accept a cause option", () => {
      const cause = new Error("root cause");
      const exc = new RequestTimeoutException("test", { cause });
      expect(exc.cause).toBe(cause);
    });

    it("should extend HttpException", () => {
      const exc = new RequestTimeoutException();
      expect(exc).toBeInstanceOf(HttpException);
      expect(exc).toBeInstanceOf(Error);
    });
  },
);
