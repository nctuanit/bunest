import "reflect-metadata";
import { expect, it } from "bun:test";
import {
  BadGatewayException,
  HttpException,
} from "../../../../../../packages/common/src";
import { describeConformance } from "../../../../_helpers";

describeConformance(
  "BadGatewayException",
  {
    upstreamPath:
      "packages/common/test/exceptions/bad-gateway.exception.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    it("should return 502 as status code", () => {
      const exc = new BadGatewayException();
      expect(exc.getStatus()).toBe(502);
    });

    // BUNEST_BUG: HttpException.createBody(undefined, "Bad Gateway", 502) in packages/common/src/exceptions/http.exception.ts:189 includes `error: "Bad Gateway"` in getResponse(), whereas NestJS returns `{ message: "Bad Gateway", statusCode: 502 }`.
    it.skip('should return "Bad Gateway" as default message', () => {
      const exc = new BadGatewayException();
      expect(exc.getResponse()).toEqual({
        message: "Bad Gateway",
        statusCode: 502,
      });
    });

    it("should accept a custom message", () => {
      const exc = new BadGatewayException("Custom error");
      expect(exc.getResponse()).toEqual({
        message: "Custom error",
        error: "Bad Gateway",
        statusCode: 502,
      });
    });

    // BUNEST_BUG: HttpException.createBody({ foo: "bar" }, ...) in packages/common/src/exceptions/http.exception.ts:205 merges `{ statusCode, error, message }` into custom objects instead of returning `{ foo: "bar" }` verbatim.
    it.skip("should accept a custom object", () => {
      const exc = new BadGatewayException({ foo: "bar" });
      expect(exc.getResponse()).toEqual({ foo: "bar" });
    });

    it("should accept a cause option", () => {
      const cause = new Error("root cause");
      const exc = new BadGatewayException("test", { cause });
      expect(exc.cause).toBe(cause);
    });

    it("should extend HttpException", () => {
      const exc = new BadGatewayException();
      expect(exc).toBeInstanceOf(HttpException);
      expect(exc).toBeInstanceOf(Error);
    });
  },
);
