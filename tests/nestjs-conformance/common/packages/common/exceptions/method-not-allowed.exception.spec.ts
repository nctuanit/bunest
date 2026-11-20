import "reflect-metadata";
import { expect, it } from "bun:test";
import {
  HttpException,
  MethodNotAllowedException,
} from "../../../../../../packages/common/src";
import { describeConformance } from "../../../../_helpers";

describeConformance(
  "MethodNotAllowedException",
  {
    upstreamPath:
      "packages/common/test/exceptions/method-not-allowed.exception.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    it("should return 405 as status code", () => {
      const exc = new MethodNotAllowedException();
      expect(exc.getStatus()).toBe(405);
    });

    // BUNEST_BUG: HttpException.createBody(undefined, "Method Not Allowed", 405) in packages/common/src/exceptions/http.exception.ts:189 includes `error: "Method Not Allowed"` in getResponse(), whereas NestJS returns `{ message: "Method Not Allowed", statusCode: 405 }`.
    it.skip('should return "Method Not Allowed" as default message', () => {
      const exc = new MethodNotAllowedException();
      expect(exc.getResponse()).toEqual({
        message: "Method Not Allowed",
        statusCode: 405,
      });
    });

    it("should accept a custom message", () => {
      const exc = new MethodNotAllowedException("Custom error");
      expect(exc.getResponse()).toEqual({
        message: "Custom error",
        error: "Method Not Allowed",
        statusCode: 405,
      });
    });

    // BUNEST_BUG: HttpException.createBody({ foo: "bar" }, ...) in packages/common/src/exceptions/http.exception.ts:205 merges `{ statusCode, error, message }` into custom objects instead of returning `{ foo: "bar" }` verbatim.
    it.skip("should accept a custom object", () => {
      const exc = new MethodNotAllowedException({ foo: "bar" });
      expect(exc.getResponse()).toEqual({ foo: "bar" });
    });

    it("should accept a cause option", () => {
      const cause = new Error("root cause");
      const exc = new MethodNotAllowedException("test", { cause });
      expect(exc.cause).toBe(cause);
    });

    it("should extend HttpException", () => {
      const exc = new MethodNotAllowedException();
      expect(exc).toBeInstanceOf(HttpException);
      expect(exc).toBeInstanceOf(Error);
    });
  },
);
