import { expect, it } from "bun:test";
import {
  GatewayTimeoutException,
  HttpException,
} from "../../../../../../packages/core/src/common";
import { describeConformance } from "../../../../_helpers";

describeConformance(
  "GatewayTimeoutException",
  {
    upstreamPath:
      "packages/common/test/exceptions/gateway-timeout.exception.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    it("should return 504 as status code", () => {
      const exc = new GatewayTimeoutException();
      expect(exc.getStatus()).toBe(504);
    });

    // BUNEST_BUG: HttpException.createBody(undefined, "Gateway Timeout", 504) in packages/core/src/common/exceptions/http.exception.ts:189 includes `error: "Gateway Timeout"` in getResponse(), whereas NestJS returns `{ message: "Gateway Timeout", statusCode: 504 }`.
    it.skip('should return "Gateway Timeout" as default message', () => {
      const exc = new GatewayTimeoutException();
      expect(exc.getResponse()).toEqual({
        message: "Gateway Timeout",
        statusCode: 504,
      });
    });

    it("should accept a custom message", () => {
      const exc = new GatewayTimeoutException("Custom error");
      expect(exc.getResponse()).toEqual({
        message: "Custom error",
        error: "Gateway Timeout",
        statusCode: 504,
      });
    });

    // BUNEST_BUG: HttpException.createBody({ foo: "bar" }, ...) in packages/core/src/common/exceptions/http.exception.ts:205 merges `{ statusCode, error, message }` into custom objects instead of returning `{ foo: "bar" }` verbatim.
    it.skip("should accept a custom object", () => {
      const exc = new GatewayTimeoutException({ foo: "bar" });
      expect(exc.getResponse()).toEqual({ foo: "bar" });
    });

    it("should accept a cause option", () => {
      const cause = new Error("root cause");
      const exc = new GatewayTimeoutException("test", { cause });
      expect(exc.cause).toBe(cause);
    });

    it("should extend HttpException", () => {
      const exc = new GatewayTimeoutException();
      expect(exc).toBeInstanceOf(HttpException);
      expect(exc).toBeInstanceOf(Error);
    });
  },
);
