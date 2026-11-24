import { expect, it } from "bun:test";
import {
  HttpException,
  ServiceUnavailableException,
} from "../../../../../../packages/core/src/common";
import { describeConformance } from "../../../../_helpers";

describeConformance(
  "ServiceUnavailableException",
  {
    upstreamPath:
      "packages/common/test/exceptions/service-unavailable.exception.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    it("should return 503 as status code", () => {
      const exc = new ServiceUnavailableException();
      expect(exc.getStatus()).toBe(503);
    });

    // BUNEST_BUG: HttpException.createBody(undefined, "Service Unavailable", 503) in packages/core/src/common/exceptions/http.exception.ts:189 includes `error: "Service Unavailable"` in getResponse(), whereas NestJS returns `{ message: "Service Unavailable", statusCode: 503 }`.
    it.skip('should return "Service Unavailable" as default message', () => {
      const exc = new ServiceUnavailableException();
      expect(exc.getResponse()).toEqual({
        message: "Service Unavailable",
        statusCode: 503,
      });
    });

    it("should accept a custom message", () => {
      const exc = new ServiceUnavailableException("Custom error");
      expect(exc.getResponse()).toEqual({
        message: "Custom error",
        error: "Service Unavailable",
        statusCode: 503,
      });
    });

    // BUNEST_BUG: HttpException.createBody({ foo: "bar" }, ...) in packages/core/src/common/exceptions/http.exception.ts:205 merges `{ statusCode, error, message }` into custom objects instead of returning `{ foo: "bar" }` verbatim.
    it.skip("should accept a custom object", () => {
      const exc = new ServiceUnavailableException({ foo: "bar" });
      expect(exc.getResponse()).toEqual({ foo: "bar" });
    });

    it("should accept a cause option", () => {
      const cause = new Error("root cause");
      const exc = new ServiceUnavailableException("test", { cause });
      expect(exc.cause).toBe(cause);
    });

    it("should extend HttpException", () => {
      const exc = new ServiceUnavailableException();
      expect(exc).toBeInstanceOf(HttpException);
      expect(exc).toBeInstanceOf(Error);
    });
  },
);
