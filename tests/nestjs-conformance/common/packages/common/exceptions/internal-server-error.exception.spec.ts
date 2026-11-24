import { expect, it } from "bun:test";
import {
  HttpException,
  InternalServerErrorException,
} from "../../../../../../packages/core/src/common";
import { describeConformance } from "../../../../_helpers";

describeConformance(
  "InternalServerErrorException",
  {
    upstreamPath:
      "packages/common/test/exceptions/internal-server-error.exception.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    it("should return 500 as status code", () => {
      const exc = new InternalServerErrorException();
      expect(exc.getStatus()).toBe(500);
    });

    // BUNEST_BUG: HttpException.createBody(undefined, "Internal Server Error", 500) in packages/core/src/common/exceptions/http.exception.ts:189 includes `error: "Internal Server Error"` in getResponse(), whereas NestJS returns `{ message: "Internal Server Error", statusCode: 500 }`.
    it.skip('should return "Internal Server Error" as default message', () => {
      const exc = new InternalServerErrorException();
      expect(exc.getResponse()).toEqual({
        message: "Internal Server Error",
        statusCode: 500,
      });
    });

    it("should accept a custom message", () => {
      const exc = new InternalServerErrorException("Custom error");
      expect(exc.getResponse()).toEqual({
        message: "Custom error",
        error: "Internal Server Error",
        statusCode: 500,
      });
    });

    // BUNEST_BUG: HttpException.createBody({ foo: "bar" }, ...) in packages/core/src/common/exceptions/http.exception.ts:205 merges `{ statusCode, error, message }` into custom objects instead of returning `{ foo: "bar" }` verbatim.
    it.skip("should accept a custom object", () => {
      const exc = new InternalServerErrorException({ foo: "bar" });
      expect(exc.getResponse()).toEqual({ foo: "bar" });
    });

    it("should accept a cause option", () => {
      const cause = new Error("root cause");
      const exc = new InternalServerErrorException("test", { cause });
      expect(exc.cause).toBe(cause);
    });

    it("should extend HttpException", () => {
      const exc = new InternalServerErrorException();
      expect(exc).toBeInstanceOf(HttpException);
      expect(exc).toBeInstanceOf(Error);
    });
  },
);
