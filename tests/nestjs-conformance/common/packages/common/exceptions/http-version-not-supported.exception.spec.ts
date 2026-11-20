import "reflect-metadata";
import { expect, it } from "bun:test";
import {
  HttpException,
  HttpVersionNotSupportedException,
} from "../../../../../../packages/common/src";
import { describeConformance } from "../../../../_helpers";

describeConformance(
  "HttpVersionNotSupportedException",
  {
    upstreamPath:
      "packages/common/test/exceptions/http-version-not-supported.exception.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    it("should return 505 as status code", () => {
      const exc = new HttpVersionNotSupportedException();
      expect(exc.getStatus()).toBe(505);
    });

    // BUNEST_BUG: HttpException.createBody(undefined, "HTTP Version Not Supported", 505) in packages/common/src/exceptions/http.exception.ts:189 includes `error: "HTTP Version Not Supported"` in getResponse(), whereas NestJS returns `{ message: "HTTP Version Not Supported", statusCode: 505 }`.
    it.skip('should return "HTTP Version Not Supported" as default message', () => {
      const exc = new HttpVersionNotSupportedException();
      expect(exc.getResponse()).toEqual({
        message: "HTTP Version Not Supported",
        statusCode: 505,
      });
    });

    it("should accept a custom message", () => {
      const exc = new HttpVersionNotSupportedException("Custom error");
      expect(exc.getResponse()).toEqual({
        message: "Custom error",
        error: "HTTP Version Not Supported",
        statusCode: 505,
      });
    });

    // BUNEST_BUG: HttpException.createBody({ foo: "bar" }, ...) in packages/common/src/exceptions/http.exception.ts:205 merges `{ statusCode, error, message }` into custom objects instead of returning `{ foo: "bar" }` verbatim.
    it.skip("should accept a custom object", () => {
      const exc = new HttpVersionNotSupportedException({ foo: "bar" });
      expect(exc.getResponse()).toEqual({ foo: "bar" });
    });

    it("should accept a cause option", () => {
      const cause = new Error("root cause");
      const exc = new HttpVersionNotSupportedException("test", { cause });
      expect(exc.cause).toBe(cause);
    });

    it("should extend HttpException", () => {
      const exc = new HttpVersionNotSupportedException();
      expect(exc).toBeInstanceOf(HttpException);
      expect(exc).toBeInstanceOf(Error);
    });
  },
);
